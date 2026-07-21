'use strict';
/**
 * Encompass (ICE Mortgage Technology / Ellie Mae) — the loan-origination system.
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
 * ClickUp (applications.encompass_status). This client is the future DIRECT connection; wiring the
 * loan read/write mapping is a follow-up that needs the instance's field spec.
 */
const cfg = require('../../config').encompass;

// Configured = the app credentials + instance are present. The user login is only required for the
// password grant; a client-credentials tenant needs just the three.
function configured() { return !!(cfg.clientId && cfg.clientSecret && cfg.instanceId); }
function ensure() { if (!configured()) throw new Error('Encompass not configured — add ENCOMPASS_CLIENT_ID / ENCOMPASS_CLIENT_SECRET / ENCOMPASS_INSTANCE_ID'); }

const withTimeout = (ms) => { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms); return { signal: ac.signal, done: () => clearTimeout(t) }; };

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
    const r = await fetch(`${cfg.baseUrl}/oauth2/v1/token`, {
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

// A minimal authenticated GET against the instance (e.g. '/encompass/v3/loans/{id}') — the stable
// hook the loan read/write mapping is built on once the instance's field spec is confirmed.
async function apiGet(path) {
  ensure();
  const token = await getToken();
  const g = withTimeout(15000);
  try {
    const r = await fetch(`${cfg.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: g.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Encompass ${r.status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } finally { g.done(); }
}

module.exports = { name: 'encompass', configured, ping, apiGet };
