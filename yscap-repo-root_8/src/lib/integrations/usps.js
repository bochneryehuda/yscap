'use strict';
/**
 * USPS Addresses API v3 — official address standardization + ZIP+4.
 *
 * A real, working client (not a stub): USPS's modern API (apis.usps.com) uses OAuth2
 * client-credentials. Add USPS_CLIENT_ID + USPS_CLIENT_SECRET (free from a USPS developer
 * account at developer.usps.com) and it activates. `verifyAddress()` returns the standardized
 * address; `ping()` proves the credentials authenticate (for the API Health page).
 *
 * This does NOT replace the existing address autocomplete (Google/Smarty/OSM) — it's the
 * authoritative USPS standardizer, available to call once keys are set.
 */
const cfg = require('../../config').usps;

function configured() { return !!(cfg.clientId && cfg.clientSecret); }
function ensure() { if (!configured()) throw new Error('USPS not configured — add USPS_CLIENT_ID / USPS_CLIENT_SECRET'); }

const withTimeout = (ms) => { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms); return { signal: ac.signal, done: () => clearTimeout(t) }; };

// Cache the OAuth token in-process until shortly before it expires.
let tokenCache = { token: null, exp: 0 };
async function getToken() {
  if (tokenCache.token && tokenCache.exp > Date.now() + 30000) return tokenCache.token;
  ensure();
  const g = withTimeout(10000);
  try {
    const form = { grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret };
    // OPTIONAL scope lever. USPS gates each API by an "API product" attached to the
    // app on the developer portal, NOT primarily by the token's scope string — so a
    // 403 on /addresses is almost always a missing Addresses API license, and adding
    // a scope here will NOT fix that. It is exposed only for the rarer case where the
    // app IS licensed but the token must name the scope explicitly. Inert unless set,
    // so the default request is byte-identical to before.
    if (cfg.oauthScope) form.scope = cfg.oauthScope;
    const r = await fetch(`${cfg.baseUrl}/oauth2/v3/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
      signal: g.signal,
    });
    const text = await r.text();
    // Keep the WHOLE USPS message — a 160-char slice cut the reason off mid-sentence
    // ("…message": "The …"), which is exactly what left the owner unable to see why.
    if (!r.ok) throw new Error(`USPS token ${r.status}: ${text.slice(0, 400)}`);
    const j = JSON.parse(text);
    tokenCache = { token: j.access_token, exp: Date.now() + Math.max(0, (j.expires_in || 3600) - 60) * 1000 };
    return j.access_token;
  } finally { g.done(); }
}

/**
 * Standardize an address. `address` = { street, secondary?, city, state, zip? }.
 * Returns { standardized: {...}, raw } or throws on a hard failure.
 */
async function verifyAddress(address = {}) {
  ensure();
  const token = await getToken();
  const q = new URLSearchParams();
  if (address.street) q.set('streetAddress', address.street);
  if (address.secondary) q.set('secondaryAddress', address.secondary);
  if (address.city) q.set('city', address.city);
  if (address.state) q.set('state', address.state);
  if (address.zip) q.set('ZIPCode', String(address.zip).slice(0, 5));
  const g = withTimeout(10000);
  try {
    const r = await fetch(`${cfg.baseUrl}/addresses/v3/address?${q.toString()}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: g.signal,
    });
    const text = await r.text();
    // Keep the WHOLE USPS message (see getToken) — the reason lives at the end of it.
    if (!r.ok) throw new Error(`USPS ${r.status}: ${text.slice(0, 400)}`);
    const j = JSON.parse(text);
    const a = j.address || {};
    return {
      standardized: {
        street: a.streetAddress || null, secondary: a.secondaryAddress || null,
        city: a.city || null, state: a.state || null,
        zip5: a.ZIPCode || null, zipPlus4: a.ZIPPlus4 || null,
        zip: a.ZIPCode ? `${a.ZIPCode}${a.ZIPPlus4 ? `-${a.ZIPPlus4}` : ''}` : null,
      },
      // Deliverability + delivery-point detail the Addresses API returns alongside
      // the standardized address — the difference between "this is spelled the USPS
      // way" and "USPS confirms mail is actually delivered here" (DPVConfirmation).
      additionalInfo: j.additionalInfo || null,
      corrections: j.corrections || null,
      matches: j.matches || null,
      warnings: j.warnings || null,
      raw: j,
    };
  } finally { g.done(); }
}

// Cheap reachability check for the API Health page: authenticate only (no address lookup).
async function ping() {
  if (!configured()) return { ok: false, reason: 'USPS_CLIENT_ID / USPS_CLIENT_SECRET not set' };
  try { await getToken(); return { ok: true }; }
  catch (e) { return { ok: false, reason: e.message }; }
}

module.exports = { name: 'usps', configured, ping, verifyAddress };
