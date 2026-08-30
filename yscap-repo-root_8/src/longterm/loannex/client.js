'use strict';
/**
 * LONG-TERM — LoanNEX backend client. A pricing VIEWER.
 *
 * WHAT LOANNEX IS. A second multi-investor pricing aggregator alongside Lender
 * Price. Its web app is an Angular SPA talking to a plain JSON REST API at
 * `nexapi.loannex.com`; one POST prices every investor at once. Decoded in full
 * from three browser recordings (2026-08-30) — see `README.md` for the protocol
 * and `capture/` for the verbatim traffic those findings rest on.
 *
 * ── THE THREE-STAGE SESSION ────────────────────────────────────────────────
 *   1. PORTAL LOGIN  — a form session on the portal host (web.loannex.com, or an
 *      investor-specific portal such as acracorrespondent / nqmfcorr).
 *   2. TOKEN KEY     — `GET {portal}/iframe/loadiframe?_id=&page=nex-app` returns
 *      HTML whose iframe src carries `tokenKey={guid}`: a one-time hand-off ticket.
 *   3. BEARER        — `GET {api}/tokens/{tokenKey}` exchanges it for a JWT
 *      (1 h) plus a refresh token (4 h). NO Authorization header on this call:
 *      the ticket IS the credential, which is why it must never be logged.
 *
 * All three stages are decoded from real traffic. Stage 1 lives in its own
 * module (`portal-login.js`) because it is a form/cookie/HTML animal rather than
 * the read-only JSON this file speaks; it was decoded from the 2026-08-30
 * sign-in capture, which records the sequence six times across three portals.
 * `NEX_TOKEN_KEY` still short-circuits it with a ticket pasted from a live
 * browser session — the fastest way to run a one-off, and how everything
 * downstream was proven end-to-end before stage 1 existed.
 *
 * ── ONE PORTAL, ONE INVESTOR — OR ALL OF THEM ──────────────────────────────
 * The `web` portal is the AGGREGATOR: one call, nine investors. An
 * investor-specific portal (acracorrespondent, nqmfcorr) returns EXACTLY ONE
 * investor — measured: the nqmfcorr board carries `investors: [NQM Funding]`
 * and nothing else — and carries `?portal={name}` on the iframe hand-off. So an
 * investor portal is a SECOND, direct source for an investor the aggregator
 * already covers. Whether the two quote that investor the same is NOT known:
 * the recordings price different scenarios on each, so nothing here assumes it.
 *
 * ── READ-ONLY, ENFORCED IN CODE ────────────────────────────────────────────
 * LoanNEX's API can lock and register loans — a priced answer literally carries
 * `availableLockActions: [RequestLock, RegisterProduct, …]`. This client is a
 * VIEWER: `assertReadOnly` allows only the pricing and lookup paths below and
 * throws on anything else, so a future caller cannot reach a booking endpoint by
 * passing a path through. The guard is a positive allowlist, not a blocklist of
 * verbs, because a blocklist is only as good as the last endpoint someone knew about.
 *
 * SEPARATION: LT-only. Reads `process.env` directly, touches no database,
 * imports no RTL code.
 */

const registryOf = require('./field-registry');
const counties = require('./counties');
const scenario = require('./scenario');
const parseMod = require('./parse');
const portalLoginMod = require('./portal-login');

// ── Configuration ───────────────────────────────────────────────────────────
const API_BASE = () => process.env.NEX_API_BASE || 'https://nexapi.loannex.com';
const WEBAPP_ORIGIN = () => process.env.NEX_WEBAPP_ORIGIN || 'https://webapp.loannex.com';
const PORTAL_HOST = (portal) => {
  const p = String(portal || process.env.NEX_PORTAL || 'web').trim().toLowerCase();
  return { portal: p, host: p === 'web' ? 'https://web.loannex.com' : `https://${p}.loannex.com` };
};
const TIMEOUT_MS = () => Number(process.env.NEX_TIMEOUT_MS) || 30000;
// A JWT is good for an hour; renew a minute early rather than racing the clock.
const TOKEN_SKEW_MS = 60 * 1000;

function configured() {
  const hasTicket = !!process.env.NEX_TOKEN_KEY;
  const hasLogin = !!(process.env.NEX_USERNAME && process.env.NEX_PASSWORD);
  return {
    ok: hasTicket || hasLogin,
    tokenKey: hasTicket,
    login: hasLogin,
    // Stage 1 IS implemented now (see portal-login.js), decoded field-for-field
    // from the 2026-08-30 sign-in capture. It has not yet been exercised against
    // the live portal, and the difference matters to whoever reads /health: a
    // working configuration is one that has actually signed in once.
    loginImplemented: true,
    loginExercised: false,
    portal: PORTAL_HOST().portal,
    apiBase: API_BASE(),
  };
}

// ── The read-only allowlist ─────────────────────────────────────────────────
// Every path this client may ever request, as patterns. `{}` matches one segment.
const READ_ONLY_PATHS = [
  'GET /tokens/{}',
  'GET /users/profiles/current',
  'GET /users/{}/exception-buyers',
  'GET /loans/apps/{}/settings',
  'GET /lookups/countries',
  'GET /lookups/counties',
  'GET /settings/organizations/{}',
  'GET /questionnaires/{}/answers/{}',
  'GET /loans/rate-stacks/{}/{}/{}',
  'GET /loans/evidences/{}/{}/fails',
  // The two POSTs that are READS despite the verb: LoanNEX prices and explains a
  // price by POSTing the scenario (it is too big for a query string) and stores
  // nothing that a lock or a registration would. Neither appears in
  // `availableLockActions`; the booking paths are /loans/locks and
  // /loans/registrations and are deliberately absent from this list.
  'POST /loans/apps/{}/quick-prices',
  'POST /loans/evidences/{}/{}',
];

function pathMatches(pattern, method, pathname) {
  const [pm, pp] = pattern.split(' ');
  if (pm !== method) return false;
  const a = pp.split('/').filter(Boolean);
  const b = pathname.split('/').filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg === '{}' || seg === b[i]);
}

/** Throws unless (method, path) is on the pricing/lookup allowlist. */
function assertReadOnly(method, pathname) {
  const m = String(method || 'GET').toUpperCase();
  const p = String(pathname || '').split('?')[0];
  if (READ_ONLY_PATHS.some((pat) => pathMatches(pat, m, p))) return true;
  const err = new Error(`loannex_write_blocked: ${m} ${p} is not a permitted read-only pricing path. This client never locks, registers or books.`);
  err.code = 'loannex_write_blocked';
  throw err;
}

// ── Secret scrubbing ────────────────────────────────────────────────────────
// A ticket or a JWT in a log is a live credential. Everything that can reach a
// response body, an error message or a diagnostic goes through here first.
function scrub(text) {
  if (text == null) return text;
  return String(text)
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<jwt-redacted>')
    .replace(/("(?:authenticationToken|refreshToken)"\s*:\s*")[^"]+/g, '$1<redacted>')
    .replace(/(tokenKey=)[0-9a-fA-F-]{8,}/g, '$1<redacted>');
}

// ── HTTP ────────────────────────────────────────────────────────────────────
async function request(method, path, { body, token, base, headers, raw } = {}) {
  assertReadOnly(method, path);
  const url = (base || API_BASE()) + path;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS());
  const h = {
    Accept: 'application/json, text/plain, */*',
    Origin: WEBAPP_ORIGIN(),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(headers || {}),
  };
  let res;
  try {
    res = await fetch(url, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual', signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    const err = new Error(`loannex_network_error: ${scrub(e && e.message)}`);
    err.code = 'loannex_network_error';
    throw err;
  }
  clearTimeout(timer);
  const text = await res.text();
  if (raw) return { status: res.status, text };
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON surfaces below */ }
  if (res.status < 200 || res.status >= 300) {
    const err = new Error(`loannex_http_${res.status}: ${scrub(text).slice(0, 600)}`);
    err.code = `loannex_http_${res.status}`;
    err.status = res.status;
    throw err;
  }
  if (json && json.status && json.status !== 'Success') {
    const err = new Error(`loannex_api_error: ${scrub(JSON.stringify(json)).slice(0, 600)}`);
    err.code = 'loannex_api_error';
    err.body = json;
    throw err;
  }
  return json;
}

// ── Session ─────────────────────────────────────────────────────────────────
const sessions = new Map(); // portal -> { token, expiresAt, userGuid, profile, portalId }

/** The JWT's own claims — the userGuid every pricing URL needs comes from here. */
function claimsOf(jwt) {
  try {
    const pl = String(jwt).split('.')[1];
    const json = JSON.parse(Buffer.from(pl.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    let claim = {};
    try { claim = JSON.parse(json['LoanNEX.ClaimData'] || '{}'); } catch (_) { /* shape drift is not fatal */ }
    return {
      userGuid: claim.UserGuid || null,
      organizationId: (claim.UserCredentials && claim.UserCredentials.OrganizationId) || null,
      portalId: (claim.OriginAttributes && claim.OriginAttributes.PortalId) != null ? claim.OriginAttributes.PortalId : null,
      expiresAt: json.exp ? json.exp * 1000 : null,
    };
  } catch (_) { return { userGuid: null, organizationId: null, portalId: null, expiresAt: null }; }
}

/**
 * Stage 2 — pull the one-time ticket out of the portal's iframe HTML.
 * Exported so the shape is testable without a network.
 */
function tokenKeyFromIframeHtml(html) {
  const m = String(html || '').match(/nex-app\?(?:[^"']*&(?:amp;)?)?tokenKey=([0-9a-fA-F-]{16,})/);
  return m ? m[1] : null;
}

/**
 * Stage 1 — sign in to the portal and come back with the one-time ticket.
 * Delegates to `portal-login.js`, which owns the cookie jar, the antiforgery
 * pair and the HTML scrape; this stays the JSON-only pricing client.
 */
async function portalLogin(portal, opts = {}) {
  const { portal: p, host } = PORTAL_HOST(portal);
  return portalLoginMod.login(host, p, {
    username: opts.username || process.env.NEX_USERNAME,
    password: opts.password || process.env.NEX_PASSWORD,
    timeoutMs: TIMEOUT_MS(),
  });
}

/** A live bearer session for a portal, minted or reused. */
async function getSession(portal, opts = {}) {
  const { portal: p } = PORTAL_HOST(portal);
  const now = Date.now();
  const hit = sessions.get(p);
  if (!opts.force && hit && hit.expiresAt - TOKEN_SKEW_MS > now) return hit;

  // A pasted ticket short-circuits the sign-in (that is how the pipeline was
  // proven end-to-end before stage 1 existed, and it stays the fastest way to
  // run a one-off). Otherwise sign in properly.
  let ticket = opts.tokenKey || process.env.NEX_TOKEN_KEY;
  if (!ticket) ticket = (await portalLogin(p, opts)).tokenKey;

  const body = await request('GET', `/tokens/${encodeURIComponent(ticket)}`, {});
  const d = (body && body.data) || {};
  if (!d.authenticationToken) {
    const err = new Error('loannex_token_exchange_failed: the ticket did not yield an authentication token (a tokenKey is single-use and short-lived).');
    err.code = 'loannex_token_exchange_failed';
    throw err;
  }
  const claims = claimsOf(d.authenticationToken);
  const session = {
    portal: p,
    token: d.authenticationToken,
    refreshToken: d.refreshToken || null,
    expiresAt: claims.expiresAt || (now + 55 * 60 * 1000),
    userGuid: claims.userGuid,
    organizationId: claims.organizationId,
    portalId: claims.portalId,
  };
  sessions.set(p, session);
  return session;
}

/** Who the session belongs to — the safe login check. Never returns a token. */
async function loginCheck(portal, opts = {}) {
  const s = await getSession(portal, opts);
  const prof = await request('GET', '/users/profiles/current', { token: s.token });
  const d = (prof && prof.data) || {};
  return {
    ok: true, portal: s.portal, portalId: s.portalId,
    userGuid: s.userGuid, organizationId: s.organizationId,
    organization: (d.organizationProfile && d.organizationProfile.dbaName) || null,
    tokenExpiresAt: new Date(s.expiresAt).toISOString(),
  };
}

// ── The pricing calls ───────────────────────────────────────────────────────
function newTransactionId() {
  const { randomUUID } = require('crypto');
  return randomUUID();
}

/** The live field registry for a portal, cached; falls back to the capture. */
async function fieldRegistry(portal, opts = {}) {
  const s = await getSession(portal, opts);
  return registryOf.registryFor(s.portal, async () => {
    const r = await request('GET', `/loans/apps/${s.userGuid}/settings`, { token: s.token });
    return (r && r.data) || null;
  }, opts);
}

/** LoanNEX's own countyKey for a scenario's location. Looked up, never computed. */
async function resolveCounty(portal, sc, opts = {}) {
  const s = await getSession(portal, opts);
  return counties.resolveCountyKey(
    { portal: s.portal, state: sc && sc.state, county: sc && (sc.county || sc.countyName), zip: sc && sc.zip },
    async (st) => {
      const r = await request('GET', `/lookups/counties?stateValue=${encodeURIComponent(st)}`, { token: s.token });
      return (r && r.data && r.data.counties) || [];
    }, opts);
}

/**
 * PRICE a scenario. One call, every investor.
 *
 * Returns `{ board, raw, request, county, registry, transactionId }` — the
 * normalised board plus everything a reader needs to audit how it was asked,
 * including whether the county resolved and which registry answered.
 */
async function price(sc, opts = {}) {
  const s = await getSession(opts.portal, opts);
  const registry = await fieldRegistry(opts.portal, opts);
  const county = await resolveCounty(opts.portal, sc, opts);
  const transactionId = opts.transactionId || newTransactionId();
  const body = scenario.buildQuickPriceBody(sc, registry, { countyKey: county.countyKey, transactionId });
  const raw = await request('POST', `/loans/apps/${s.userGuid}/quick-prices`, { token: s.token, body });
  return {
    board: parseMod.parse(raw),
    request: body,
    county,
    registry: registryOf.provenance(registry),
    transactionId,
    portal: s.portal,
    portalId: s.portalId,
    raw: opts.raw ? raw : undefined,
  };
}

/**
 * WHY each investor said no. A plain GET — no polling, no async kickoff. (The
 * Lender Price equivalent needs a two-phase asynchronous poll that can take
 * minutes; this returns with the price call.)
 */
async function fails(transactionId, opts = {}) {
  const s = await getSession(opts.portal, opts);
  const raw = await request('GET', `/loans/evidences/${s.userGuid}/${encodeURIComponent(transactionId)}/fails`, { token: s.token });
  return { disqualified: parseMod.parseFails(raw), raw: opts.raw ? raw : undefined };
}

/** The LLPA breakdown behind one quote, and the sheet date the merge elects on. */
async function evidence(sc, quote, opts = {}) {
  const s = await getSession(opts.portal, opts);
  const registry = await fieldRegistry(opts.portal, opts);
  const county = await resolveCounty(opts.portal, sc, opts);
  const transactionId = opts.transactionId || newTransactionId();
  const body = {
    data: {
      productId: quote.productId, investorId: quote.lenderId,
      selectedPriceData: {
        price: quote.price, rate: quote.rate, priceHashKey: quote.priceHashKey,
        lockDays: quote.lockDays, includeAdminFee: false,
      },
      nexApp: scenario.buildNexApp(sc, registry, { countyKey: county.countyKey }),
      isPreliminary: true, isException: false, scenarioTestId: transactionId,
    },
  };
  const raw = await request('POST', `/loans/evidences/${s.userGuid}/${encodeURIComponent(transactionId)}`, { token: s.token, body });
  return { evidence: parseMod.parseEvidence(raw), raw: opts.raw ? raw : undefined };
}

/** The full rate ladder behind one quote. */
async function rateStack(transactionId, priceHashKey, opts = {}) {
  const s = await getSession(opts.portal, opts);
  const raw = await request('GET',
    `/loans/rate-stacks/${s.userGuid}/${encodeURIComponent(transactionId)}/${encodeURIComponent(priceHashKey)}`, { token: s.token });
  const d = (raw && raw.data) || {};
  return {
    investor: d.investorName || null, program: d.programName || null,
    product: d.mortgageProductDescription || null, lastUpdated: d.lastUpdated || null,
    rows: (d.rows || []).map((r) => ({ lockDays: Number(r.lockDay), price: Number(r.price), rate: Number(r.rate) })),
  };
}

function invalidateSession(portal) {
  if (portal == null) sessions.clear();
  else sessions.delete(PORTAL_HOST(portal).portal);
}

module.exports = {
  configured, getSession, loginCheck, price, fails, evidence, rateStack,
  fieldRegistry, resolveCounty, invalidateSession, newTransactionId,
  _internals: {
    request, assertReadOnly, pathMatches, READ_ONLY_PATHS, scrub, claimsOf,
    tokenKeyFromIframeHtml, portalLogin, PORTAL_HOST, sessions, TOKEN_SKEW_MS, portalLoginMod,
  },
};
