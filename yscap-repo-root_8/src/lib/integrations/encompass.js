'use strict';
/**
 * Encompass (ICE Mortgage Technology / Ellie Mae) — the loan-origination system.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HARD RULE — READ-ONLY, FROZEN (owner-directed 2026-07-22).
 * PILOT ↔ Encompass is a ONE-WAY, READ-ONLY connection. PILOT NEVER writes to
 * Encompass, NEVER replaces anything in Encompass, NEVER PATCHes a loan, NEVER
 * advances a milestone, NEVER updates a field, NEVER uploads to eFolder, NEVER
 * creates a loan, NEVER deletes anything. The ONLY POST allowed in this file is
 * the OAuth token exchange (`POST /oauth2/v1/token`). Every other HTTP verb
 * against `${baseUrl}/encompass/*` is refused STRUCTURALLY by `_fetchGuarded` +
 * `assertReadOnlyPath`. Do NOT add `apiPost`/`apiPut`/`apiPatch`/`apiDelete`
 * to this module. Do NOT relax `assertReadOnlyPath`. The rule is layered:
 * (1) only GET helpers are exported (`configured`, `ping`, `apiGet`, `READ_ONLY`);
 * (2) `assertReadOnlyPath` blocks any path in the OAuth namespace from being
 * called via the read helper (safety belt); (3) `_fetchGuarded` refuses any
 * `fetch()`-style request built here whose method is not GET, unless the URL
 * is the OAuth token endpoint (belt AND suspenders).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Framework client: Encompass access is per-INSTANCE via Developer Connect (OAuth2), so the
 * loan-level FIELD MAPPING is finalized against YOUR Encompass instance once credentials exist.
 * This module centralizes auth behind a stable interface + a `ping()` for the API Health page.
 *
 * To activate (env): ENCOMPASS_CLIENT_ID, ENCOMPASS_CLIENT_SECRET, ENCOMPASS_INSTANCE_ID
 * (your instance / smart-client id), and — for the resource-owner grant most Encompass tenants
 * use — ENCOMPASS_USERNAME + ENCOMPASS_PASSWORD. Optional ENCOMPASS_API_BASE (default
 * https://api.elliemae.com).
 *
 * NOTE: today "Encompass" also appears in PILOT only as a read-only status field pulled from
 * ClickUp (applications.encompass_status). This client is the DIRECT read-only connection; the
 * loan field-mapping (docs/ENCOMPASS-DATA-MAPPING.md) is pull-only by rule.
 */
const cfg = require('../../config').encompass;

// The one and only endpoint on the base URL that is allowed to see a non-GET request.
const TOKEN_PATH = '/oauth2/v1/token';

// Configured = the app credentials + instance are present. The user login is only required for the
// password grant; a client-credentials tenant needs just the three.
function configured() { return !!(cfg.clientId && cfg.clientSecret && cfg.instanceId); }
function ensure() { if (!configured()) throw new Error('Encompass not configured — add ENCOMPASS_CLIENT_ID / ENCOMPASS_CLIENT_SECRET / ENCOMPASS_INSTANCE_ID'); }

const withTimeout = (ms) => { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms); return { signal: ac.signal, done: () => clearTimeout(t) }; };

// HARD READ-ONLY GATE. Every fetch built INSIDE this module is funneled through
// _fetchGuarded, which refuses any method other than GET unless the URL is the
// OAuth token endpoint. This is the belt-AND-suspenders backstop behind the
// "only GET helpers are exported" contract at the bottom of the file.
async function _fetchGuarded(url, init) {
  const method = String((init && init.method) || 'GET').toUpperCase();
  const isTokenExchange = url.startsWith(cfg.baseUrl + TOKEN_PATH);
  if (method !== 'GET' && !isTokenExchange) {
    // eslint-disable-next-line no-console
    console.error('[encompass] refused non-GET request:', method, url);
    throw new Error(`Encompass integration is READ-ONLY (owner-directed freeze). Refused ${method} ${url.slice(0, 200)}`);
  }
  if (isTokenExchange && method !== 'POST') {
    throw new Error(`Encompass token exchange must be POST (got ${method}).`);
  }
  return fetch(url, init);
}

// A GET path against /encompass/* must not reach into the OAuth namespace and
// must not carry any body/method override the caller sneaks through. Any path
// that looks like the token endpoint (or /oauth2/) is refused — the token
// exchange has its own dedicated caller (getToken).
function assertReadOnlyPath(path) {
  const p = String(path || '');
  if (!p) throw new Error('Encompass GET path is required.');
  const norm = p.startsWith('/') ? p : `/${p}`;
  if (norm.startsWith('/oauth2/') || norm.startsWith(TOKEN_PATH)) {
    throw new Error('Encompass GET may not call the OAuth namespace.');
  }
  return norm;
}

let tokenCache = { token: null, exp: 0 };
async function getToken() {
  if (tokenCache.token && tokenCache.exp > Date.now() + 30000) return tokenCache.token;
  ensure();
  // Developer Connect: resource-owner password grant when a user login is provided (the common
  // tenant setup), otherwise client-credentials. The instance id rides as `client_id@instance`.
  const params = { client_id: cfg.clientId, client_secret: cfg.clientSecret };
  if (cfg.username && cfg.password) {
    params.grant_type = 'password';
    params.username = `${cfg.username}@encompass:${cfg.instanceId}`;
    params.password = cfg.password;
    params.scope = 'lp';
  } else {
    params.grant_type = 'client_credentials';
    params.scope = `lp instance:${cfg.instanceId}`;
  }
  const g = withTimeout(12000);
  try {
    const r = await _fetchGuarded(`${cfg.baseUrl}${TOKEN_PATH}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params), signal: g.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Encompass token ${r.status}: ${text.slice(0, 160)}`);
    const j = JSON.parse(text);
    tokenCache = { token: j.access_token, exp: Date.now() + Math.max(0, (j.expires_in || 1800) - 60) * 1000 };
    return j.access_token;
  } finally { g.done(); }
}

// Cheap reachability check for the API Health page: authenticate only.
async function ping() {
  if (!configured()) return { ok: false, reason: 'ENCOMPASS_CLIENT_ID / _SECRET / _INSTANCE_ID not set' };
  try { await getToken(); return { ok: true }; }
  catch (e) { return { ok: false, reason: e.message }; }
}

// A minimal authenticated READ against the instance (e.g. '/encompass/v3/loans/{id}').
// This is the ONLY way to talk to Encompass from PILOT — deliberately GET-only.
async function apiGet(path) {
  ensure();
  const norm = assertReadOnlyPath(path);
  const token = await getToken();
  const g = withTimeout(15000);
  try {
    const r = await _fetchGuarded(`${cfg.baseUrl}${norm}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: g.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Encompass ${r.status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } finally { g.done(); }
}

// READ-ONLY sentinel — anything that imports this module can check
// `encompass.READ_ONLY === true` before wiring up code that assumes it can write.
const READ_ONLY = true;

module.exports = { name: 'encompass', configured, ping, apiGet, READ_ONLY };
