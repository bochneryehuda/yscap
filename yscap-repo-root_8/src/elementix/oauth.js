'use strict';
/**
 * src/elementix/oauth.js — how PILOT gets, keeps and renews its Elementix
 * authorization. The ONLY module that mints or refreshes an Elementix token.
 *
 * WHY THIS EXISTS AT ALL. Elementix's MCP endpoint takes the plain
 * `{"url": "https://app.elementix.com/api/mcp"}` config with no API key, and the
 * vendor confirmed (2026-08-07) that it is "a standard OAuth flow for the MCP
 * endpoint — the AI client/harness will handle the work for you". That is the
 * whole reason this is possible without buying a data licence: PILOT signs in
 * on the seat the owner already pays for, exactly the way Cursor or Claude Code
 * would, and never needs a purchased key.
 *
 * WHAT THE VENDOR'S ANSWER DID NOT SETTLE, AND HOW THIS MODULE SETTLES IT.
 * "The AI client will handle it" assumes a person sitting in front of a browser.
 * PILOT is a server: a human can click Approve once, but nobody is there at 3am
 * to do it again. So the question that actually decides whether this can run
 * unattended is whether the authorization server issues a REFRESH TOKEN. Rather
 * than another email round-trip, `discover()` reads the server's own published
 * metadata and `unattendedVerdict()` reports the answer — and `exchangeCode()`
 * records the PROOF, because metadata is a promise and the token response is the
 * fact. See ELEMENTIX-CRM-PLAN.md §5, open question 1.
 *
 * DISCOVERY IS RUNTIME, NEVER HARD-CODED. Every endpoint, the registration
 * route, the grant types and the scopes are read from the server at connect
 * time. So this works whatever Elementix's exact configuration turns out to be,
 * and if they change it we follow rather than break.
 *
 * NO NEW DEPENDENCIES — global fetch and node:crypto only, per the hard
 * no-added-deps rule (this repo installs express + pg and nothing else).
 */

const crypto = require('crypto');
const cfg = require('../config');

/**
 * The database is required LAZILY, so the pure rules in this file — the cipher,
 * the PKCE derivation, the discovery-URL derivation and `unattendedVerdict` —
 * load and can be tested with no database in reach. Same shape as
 * src/lib/esign/term-sheet-stamp.js. `require` is cached, so this costs nothing
 * after the first call.
 */
function pool() { return require('../db').pool; }

const MCP_URL = () => String(cfg.elementix.url || '').replace(/\/+$/, '');

/** How long an in-flight approval may sit before the browser round trip is stale. */
const PENDING_TTL_SEC = 15 * 60;

/**
 * Refresh this long BEFORE the access token actually expires. A token that
 * expires mid-request would surface as a failed lookup to whoever is on the
 * screen, so we always renew early rather than on the 401.
 */
const REFRESH_SKEW_SEC = 120;

/** Discovery / token calls are bounded — a hung vendor must never hang a request. */
const HTTP_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// At-rest encryption for the tokens.
//
// An Elementix refresh token is a long-lived credential to the company's own
// data. Stored in the clear it would be readable by every admin query, every
// log of a query, and every database backup — so there is no plaintext path:
// `store()` refuses to write a token it cannot encrypt.
//
// Key material is ELEMENTIX_TOKEN_KEY, falling back to the SSN key that already
// protects at-rest secrets here. Changing the key does NOT lose anything
// dangerous — it invalidates the stored authorization, and somebody re-clicks
// Approve once. That is a deliberately cheap failure.
// ---------------------------------------------------------------------------

function keyMaterial() {
  return String(cfg.elementix.tokenKey || cfg.ssnKey || '');
}

function encKey() {
  return crypto.createHash('sha256').update(keyMaterial()).digest();
}

/** True when we hold a key we are willing to encrypt with. */
function canEncrypt() {
  return keyMaterial().length > 0;
}

function encrypt(plain) {
  if (plain == null || plain === '') return null;
  if (!canEncrypt()) throw new Error('elementix: no token encryption key configured');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function decrypt(b64) {
  if (!b64) return null;
  try {
    const raw = Buffer.from(String(b64), 'base64');
    // 12-byte IV + 16-byte tag, so anything shorter cannot be one of ours.
    if (raw.length < 29) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch (_) {
    // A wrong key or a tampered value lands here. Returning null reads as "not
    // connected", which sends a human through Approve again — the safe outcome.
    return null;
  }
}

// ---------------------------------------------------------------------------
// PKCE + state
// ---------------------------------------------------------------------------

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function newPkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

function newState() {
  return b64url(crypto.randomBytes(24));
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function getJson(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: ac.signal });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Read the `resource_metadata` pointer out of a WWW-Authenticate header.
 * RFC 9728: the 401 tells us where the resource's own metadata lives, which is
 * more reliable than guessing a well-known path.
 */
function resourceMetadataUrlFrom(header) {
  const h = String(header || '');
  const m = /resource_metadata\s*=\s*"([^"]+)"/i.exec(h) || /resource_metadata\s*=\s*([^\s,]+)/i.exec(h);
  if (!m) return null;
  const u = m[1].trim();
  return /^https:\/\//i.test(u) ? u : null;
}

/** The well-known paths to try when the 401 gave us no pointer. */
function candidateResourceMetadataUrls(mcpUrl) {
  let u;
  try { u = new URL(mcpUrl); } catch (_) { return []; }
  const origin = u.origin;
  const path = u.pathname.replace(/\/+$/, '');
  return [
    // RFC 9728 form: the resource's path appended to the well-known root.
    `${origin}/.well-known/oauth-protected-resource${path}`,
    `${origin}/.well-known/oauth-protected-resource`,
  ];
}

function candidateAuthServerMetadataUrls(issuer) {
  const base = String(issuer || '').replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) return [];
  return [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
  ];
}

/**
 * Ask the endpoint what it supports. This is the call that answers the question
 * the vendor's reply left open, and it is deliberately read-only and
 * side-effect-free so it is safe to run from an admin "test the connection"
 * button as often as anybody likes.
 *
 * Never throws — returns `{ ok:false, reason }` so a route can render the reason.
 */
async function discover(mcpUrl = MCP_URL()) {
  if (!mcpUrl) return { ok: false, reason: 'no_url', detail: 'ELEMENTIX_URL is not set.' };

  // Step 1: an unauthenticated probe. A standard MCP server answers 401 with a
  // WWW-Authenticate pointing at its metadata.
  let unauthorized = false;
  let pointer = null;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
    let r;
    try {
      r = await fetch(mcpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
          protocolVersion: '2025-06-18', capabilities: {},
          clientInfo: { name: 'PILOT', version: '1' },
        } }),
        signal: ac.signal,
      });
    } finally { clearTimeout(t); }
    unauthorized = r.status === 401 || r.status === 403;
    pointer = resourceMetadataUrlFrom(r.headers.get('www-authenticate'));
  } catch (e) {
    return {
      ok: false, reason: 'unreachable',
      detail: `Could not reach ${mcpUrl} (${e && e.message ? e.message : 'network error'}).`,
    };
  }

  // Step 2: the resource's metadata, which names its authorization server.
  const resourceUrls = pointer ? [pointer, ...candidateResourceMetadataUrls(mcpUrl)] : candidateResourceMetadataUrls(mcpUrl);
  let resourceMeta = null;
  for (const u of resourceUrls) {
    resourceMeta = await getJson(u);
    if (resourceMeta) break;
  }

  const issuers = [];
  if (resourceMeta && Array.isArray(resourceMeta.authorization_servers)) {
    for (const s of resourceMeta.authorization_servers) if (s) issuers.push(String(s));
  }
  if (cfg.elementix.authServer) issuers.unshift(String(cfg.elementix.authServer));
  // Last resort: many servers are their own issuer.
  try { issuers.push(new URL(mcpUrl).origin); } catch (_) { /* ignore */ }

  // Step 3: the authorization server's metadata — the endpoints and, crucially,
  // the grant types, which is where the renewal answer lives.
  let asMeta = null;
  let issuer = null;
  for (const iss of issuers) {
    for (const u of candidateAuthServerMetadataUrls(iss)) {
      asMeta = await getJson(u);
      if (asMeta && (asMeta.authorization_endpoint || asMeta.token_endpoint)) { issuer = iss; break; }
      asMeta = null;
    }
    if (asMeta) break;
  }

  if (!asMeta) {
    return {
      ok: false,
      reason: 'no_metadata',
      unauthorized,
      detail: 'The endpoint did not publish OAuth metadata we could read. Ask Elementix for the '
            + 'authorization server URL and set ELEMENTIX_AUTH_SERVER, or for a client id.',
    };
  }

  const grants = Array.isArray(asMeta.grant_types_supported) ? asMeta.grant_types_supported.map(String) : [];
  const scopes = Array.isArray(asMeta.scopes_supported) ? asMeta.scopes_supported.map(String) : [];
  const methods = Array.isArray(asMeta.code_challenge_methods_supported)
    ? asMeta.code_challenge_methods_supported.map(String) : [];

  return {
    ok: true,
    unauthorized,
    resourceUrl: mcpUrl,
    issuer: String(asMeta.issuer || issuer || ''),
    authorizationEndpoint: asMeta.authorization_endpoint || null,
    tokenEndpoint: asMeta.token_endpoint || null,
    registrationEndpoint: asMeta.registration_endpoint || null,
    grantTypesSupported: grants,
    scopesSupported: scopes,
    codeChallengeMethodsSupported: methods,
    supportsDynamicRegistration: !!asMeta.registration_endpoint,
    supportsPkceS256: methods.length === 0 || methods.includes('S256'),
    raw: asMeta,
  };
}

/**
 * The verdict on the owner's actual question: can this run unattended, or will
 * somebody have to keep clicking Approve?
 *
 * PURE — takes a discovery result, returns plain words. Metadata is a promise
 * rather than proof, which is why `verdict` is `likely`/`unlikely` and the
 * certain answer only arrives with the first token response.
 */
function unattendedVerdict(d) {
  if (!d || !d.ok) return { verdict: 'unknown', canSelfRenew: null, detail: 'Discovery did not complete.' };
  const grants = (d.grantTypesSupported || []).map((g) => String(g).toLowerCase());
  const scopes = (d.scopesSupported || []).map((s) => String(s).toLowerCase());
  const hasRefreshGrant = grants.includes('refresh_token');
  const hasOffline = scopes.includes('offline_access');

  if (hasRefreshGrant) {
    return {
      verdict: 'likely',
      canSelfRenew: true,
      detail: 'The authorization server lists the refresh_token grant, so PILOT should be able to '
            + 'renew access on its own after one approval'
            + (hasOffline ? ' (offline_access is offered, which we request).' : '.'),
    };
  }
  if (grants.length === 0) {
    return {
      verdict: 'unknown',
      canSelfRenew: null,
      detail: 'The server did not publish its grant types, so renewal cannot be confirmed until the '
            + 'first approval — we will know for certain then, because the token response either '
            + 'carries a refresh token or it does not.',
    };
  }
  return {
    verdict: 'unlikely',
    canSelfRenew: false,
    detail: 'The authorization server does not list the refresh_token grant. Access will probably '
          + 'expire and need re-approving by a person. Worth asking Elementix for a longer-lived '
          + 'credential before relying on this for background work.',
  };
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

async function registerClient(d, redirectUri) {
  if (cfg.elementix.clientId) {
    return { clientId: cfg.elementix.clientId, clientSecret: cfg.elementix.clientSecret || null, source: 'configured' };
  }
  if (!d.registrationEndpoint) {
    return { error: 'no_registration',
      detail: 'This server does not offer self-registration and no ELEMENTIX_CLIENT_ID is set. '
            + 'Ask Elementix for a client id and the redirect URI to register.' };
  }
  const body = {
    client_name: 'PILOT by YS Capital',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none', // public client + PKCE; upgraded below if a secret comes back
    application_type: 'web',
  };
  if ((d.scopesSupported || []).length) body.scope = d.scopesSupported.join(' ');

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
  try {
    const r = await fetch(d.registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.client_id) {
      return { error: 'registration_failed',
        detail: `Elementix refused to register PILOT as a client (HTTP ${r.status}).`
              + (j && j.error_description ? ` ${j.error_description}` : '') };
    }
    return { clientId: String(j.client_id), clientSecret: j.client_secret ? String(j.client_secret) : null, source: 'dynamic' };
  } catch (e) {
    return { error: 'registration_unreachable', detail: e && e.message ? e.message : 'network error' };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// The connect flow
// ---------------------------------------------------------------------------

function redirectUri() {
  const base = String(cfg.appUrl || '').replace(/\/+$/, '');
  return `${base}/api/admin/elementix/callback`;
}

/**
 * Start an approval. Returns the URL to send the person's browser to.
 * `staffId` null = the company-wide connection; a staff id = that officer's own.
 */
async function beginConnect({ staffId = null, actorId = null } = {}) {
  const d = await discover();
  if (!d.ok) return { ok: false, ...d };
  if (!d.authorizationEndpoint || !d.tokenEndpoint) {
    return { ok: false, reason: 'incomplete_metadata',
      detail: 'The server did not publish both an authorization and a token endpoint.' };
  }

  const uri = redirectUri();
  if (!/^https:\/\//i.test(uri)) {
    return { ok: false, reason: 'bad_app_url',
      detail: `APP_URL must be an https address for OAuth to return here — it is currently "${cfg.appUrl || ''}".` };
  }

  const reg = await registerClient(d, uri);
  if (reg.error) return { ok: false, reason: reg.error, detail: reg.detail };

  const pkce = newPkce();
  const state = newState();
  // Ask for offline_access when offered — that is the scope that buys us a
  // refresh token, and therefore unattended operation.
  const scopes = (d.scopesSupported || []).slice();
  if (!scopes.includes('offline_access')) scopes.push('offline_access');
  const scope = scopes.join(' ');

  await pool().query(
    `INSERT INTO elementix_oauth_pending
       (state, code_verifier, staff_id, resource_url, auth_server, token_endpoint,
        client_id, client_secret_enc, discovery, redirect_uri, scope, started_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12, now() + ($13 || ' seconds')::interval)`,
    [state, pkce.verifier, staffId, d.resourceUrl, d.issuer, d.tokenEndpoint,
     reg.clientId, reg.clientSecret ? encrypt(reg.clientSecret) : null,
     JSON.stringify({ ...d, raw: undefined }), uri, scope, actorId, String(PENDING_TTL_SEC)]
  );

  const auth = new URL(d.authorizationEndpoint);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('client_id', reg.clientId);
  auth.searchParams.set('redirect_uri', uri);
  auth.searchParams.set('state', state);
  auth.searchParams.set('code_challenge', pkce.challenge);
  auth.searchParams.set('code_challenge_method', pkce.method);
  if (scope) auth.searchParams.set('scope', scope);
  // RFC 8707 — bind the token to this resource so it cannot be replayed elsewhere.
  auth.searchParams.set('resource', d.resourceUrl);

  return { ok: true, authorizeUrl: auth.toString(), state, unattended: unattendedVerdict(d) };
}

/** Finish an approval: swap the code for tokens and store them. */
async function completeConnect({ code, state }) {
  if (!code || !state) return { ok: false, reason: 'missing_code' };

  const { rows } = await pool().query(
    `DELETE FROM elementix_oauth_pending
      WHERE state = $1 AND expires_at > now()
      RETURNING *`, [String(state)]
  );
  const p = rows[0];
  if (!p) {
    return { ok: false, reason: 'stale_state',
      detail: 'That approval link had already been used or had expired. Start the connection again.' };
  }

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: String(code),
    redirect_uri: p.redirect_uri,
    client_id: p.client_id || '',
    code_verifier: p.code_verifier,
    resource: p.resource_url,
  });
  const secret = decrypt(p.client_secret_enc);
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (secret) headers.authorization = 'Basic ' + Buffer.from(`${p.client_id}:${secret}`).toString('base64');

  const tok = await postToken(p.token_endpoint, form, headers);
  if (!tok.ok) return { ok: false, reason: 'token_exchange_failed', detail: tok.detail };

  await store({
    staffId: p.staff_id, resourceUrl: p.resource_url, authServer: p.auth_server,
    tokenEndpoint: p.token_endpoint, clientId: p.client_id, clientSecretEnc: p.client_secret_enc,
    discovery: p.discovery, token: tok.token, connectedBy: p.started_by,
  });

  // THE DEFINITIVE ANSWER to "does it renew itself?" — not what the metadata
  // promised, but what actually came back.
  const selfRenewing = !!tok.token.refresh_token;
  return {
    ok: true,
    selfRenewing,
    detail: selfRenewing
      ? 'Connected, and Elementix issued a refresh token — PILOT can renew access on its own from now on.'
      : 'Connected, but Elementix did NOT issue a refresh token, so this access will expire and a '
      + 'person will have to approve again. Ask them for a longer-lived credential before relying '
      + 'on it for background work.',
  };
}

async function postToken(tokenEndpoint, form, headers) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
  try {
    const r = await fetch(tokenEndpoint, { method: 'POST', headers, body: form.toString(), signal: ac.signal });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.access_token) {
      const why = j && (j.error_description || j.error) ? ` ${j.error_description || j.error}` : '';
      return { ok: false, detail: `Token request failed (HTTP ${r.status}).${why}` };
    }
    return { ok: true, token: j };
  } catch (e) {
    return { ok: false, detail: e && e.message ? e.message : 'network error' };
  } finally {
    clearTimeout(t);
  }
}

async function store({ staffId, resourceUrl, authServer, tokenEndpoint, clientId, clientSecretEnc, discovery, token, connectedBy }) {
  if (!canEncrypt()) throw new Error('elementix: refusing to store a token with no encryption key configured');
  const expiresAt = Number.isFinite(Number(token.expires_in))
    ? new Date(Date.now() + Number(token.expires_in) * 1000) : null;

  // A refresh that returns no new refresh token means KEEP THE OLD ONE — many
  // servers rotate only the access token, and overwriting with NULL here would
  // silently end the unattended operation this whole module exists for.
  await pool().query(
    `INSERT INTO elementix_oauth
       (staff_id, resource_url, auth_server, token_endpoint, client_id, client_secret_enc,
        discovery, access_token_enc, refresh_token_enc, token_type, scope, expires_at,
        connected_by, connected_at, last_refresh_at, last_error, last_error_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13, now(), now(), NULL, NULL, now())
     ON CONFLICT (resource_url) WHERE staff_id IS NULL DO UPDATE SET
       auth_server = EXCLUDED.auth_server,
       token_endpoint = EXCLUDED.token_endpoint,
       client_id = COALESCE(EXCLUDED.client_id, elementix_oauth.client_id),
       client_secret_enc = COALESCE(EXCLUDED.client_secret_enc, elementix_oauth.client_secret_enc),
       discovery = EXCLUDED.discovery,
       access_token_enc = EXCLUDED.access_token_enc,
       refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, elementix_oauth.refresh_token_enc),
       token_type = EXCLUDED.token_type,
       scope = COALESCE(EXCLUDED.scope, elementix_oauth.scope),
       expires_at = EXCLUDED.expires_at,
       connected_by = COALESCE(EXCLUDED.connected_by, elementix_oauth.connected_by),
       connected_at = COALESCE(elementix_oauth.connected_at, EXCLUDED.connected_at),
       last_refresh_at = now(), last_error = NULL, last_error_at = NULL, updated_at = now()`,
    [staffId, resourceUrl, authServer, tokenEndpoint, clientId, clientSecretEnc,
     JSON.stringify(discovery || {}), encrypt(token.access_token),
     token.refresh_token ? encrypt(token.refresh_token) : null,
     token.token_type || 'Bearer', token.scope || null, expiresAt, connectedBy]
  );
}

// ---------------------------------------------------------------------------
// Using it
// ---------------------------------------------------------------------------

async function rowFor(staffId = null) {
  const url = MCP_URL();
  const { rows } = staffId
    ? await pool().query(`SELECT * FROM elementix_oauth WHERE resource_url=$1 AND staff_id=$2`, [url, staffId])
    : await pool().query(`SELECT * FROM elementix_oauth WHERE resource_url=$1 AND staff_id IS NULL`, [url]);
  return rows[0] || null;
}

/**
 * A usable access token, renewed if it is close to expiry.
 * Returns `{ ok:false, reason }` rather than throwing so callers degrade to
 * "not connected" instead of 500-ing a page.
 *
 * `staffId` falls back to the company-wide connection when that officer has
 * none of their own — one seat today, per-officer seats later, no code change.
 */
async function accessToken(staffId = null) {
  let row;
  try {
    row = await rowFor(staffId);
    if (!row && staffId) row = await rowFor(null);
  } catch (e) {
    // The stored authorization could not be READ. That is NOT the same as "not
    // connected", and must never be reported as it — telling somebody to
    // re-approve when the real problem is the database would send them to click
    // Approve on a connection that is already fine. Shaped, never thrown: the
    // caller's contract is that a lookup failure shows a message, not a 500.
    return { ok: false, reason: 'store_unreadable',
      detail: `Could not read the stored Elementix authorization: ${e && e.message}` };
  }
  if (!row) return { ok: false, reason: 'not_connected', detail: 'Elementix has not been connected yet.' };

  const tok = decrypt(row.access_token_enc);
  const expSoon = row.expires_at && (new Date(row.expires_at).getTime() - Date.now()) < REFRESH_SKEW_SEC * 1000;

  if (tok && !expSoon) return { ok: true, token: tok, tokenType: row.token_type || 'Bearer', row };
  const refreshed = await refresh(row);
  if (refreshed.ok) return refreshed;
  if (tok && !row.expires_at) {
    // No expiry was published and the refresh failed — the token we hold may
    // still be perfectly good, so try it rather than declaring failure.
    return { ok: true, token: tok, tokenType: row.token_type || 'Bearer', row };
  }
  return refreshed;
}

async function refresh(row) {
  const rt = decrypt(row.refresh_token_enc);
  if (!rt) {
    await noteError(row.id, 'Access expired and there is no refresh token — somebody has to approve again.');
    return { ok: false, reason: 'reapproval_needed',
      detail: 'Elementix access has expired and no refresh token was issued. Reconnect from the API Health page.' };
  }
  const form = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: rt,
    client_id: row.client_id || '', resource: row.resource_url,
  });
  const secret = decrypt(row.client_secret_enc);
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (secret) headers.authorization = 'Basic ' + Buffer.from(`${row.client_id}:${secret}`).toString('base64');

  const tok = await postToken(row.token_endpoint, form, headers);
  if (!tok.ok) {
    await noteError(row.id, tok.detail);
    return { ok: false, reason: 'refresh_failed', detail: tok.detail };
  }
  await store({
    staffId: row.staff_id, resourceUrl: row.resource_url, authServer: row.auth_server,
    tokenEndpoint: row.token_endpoint, clientId: row.client_id, clientSecretEnc: row.client_secret_enc,
    discovery: row.discovery, token: tok.token, connectedBy: row.connected_by,
  });
  return { ok: true, token: tok.token.access_token, tokenType: tok.token.token_type || 'Bearer', row };
}

async function noteError(id, detail) {
  try {
    await pool().query(
      `UPDATE elementix_oauth SET last_error=$2, last_error_at=now(), updated_at=now() WHERE id=$1`,
      [id, String(detail || '').slice(0, 500)]
    );
  } catch (_) { /* best effort — never mask the real failure */ }
}

/** What the API Health page shows. Never throws; never returns a token. */
async function status(staffId = null) {
  if (!MCP_URL()) return { configured: false, connected: false, detail: 'ELEMENTIX_URL is not set.' };
  let row = null;
  try { row = await rowFor(staffId); if (!row && staffId) row = await rowFor(null); } catch (_) { /* table may not exist yet */ }
  if (!row) return { configured: true, connected: false, url: MCP_URL(), detail: 'Not connected yet.' };
  const expiresAt = row.expires_at ? new Date(row.expires_at).toISOString() : null;
  return {
    configured: true,
    connected: !!row.access_token_enc,
    url: row.resource_url,
    scopedTo: row.staff_id ? 'officer' : 'company',
    selfRenewing: !!row.refresh_token_enc,
    clientId: row.client_id || null,
    authServer: row.auth_server || null,
    expiresAt,
    connectedAt: row.connected_at ? new Date(row.connected_at).toISOString() : null,
    lastRefreshAt: row.last_refresh_at ? new Date(row.last_refresh_at).toISOString() : null,
    lastError: row.last_error || null,
  };
}

async function disconnect(staffId = null) {
  const url = MCP_URL();
  const q = staffId
    ? pool().query(`DELETE FROM elementix_oauth WHERE resource_url=$1 AND staff_id=$2`, [url, staffId])
    : pool().query(`DELETE FROM elementix_oauth WHERE resource_url=$1 AND staff_id IS NULL`, [url]);
  const r = await q;
  return { ok: true, removed: r.rowCount };
}

/** Housekeeping for abandoned approvals. Best effort. */
async function sweepPending() {
  try {
    const r = await pool().query(`DELETE FROM elementix_oauth_pending WHERE expires_at < now()`);
    return r.rowCount;
  } catch (_) { return 0; }
}

module.exports = {
  discover, unattendedVerdict,
  beginConnect, completeConnect,
  accessToken, status, disconnect, sweepPending,
  redirectUri,
  _internals: {
    encrypt, decrypt, canEncrypt, newPkce, newState,
    resourceMetadataUrlFrom, candidateResourceMetadataUrls, candidateAuthServerMetadataUrls,
    REFRESH_SKEW_SEC, PENDING_TTL_SEC,
  },
};
