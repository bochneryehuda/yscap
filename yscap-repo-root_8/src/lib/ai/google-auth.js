'use strict';
/**
 * Google service-account → OAuth2 access token, using ONLY Node's built-in crypto
 * (no googleapis SDK, no native deps — same "fetch + crypto" pattern as the rest of
 * this repo's integrations). Mints a short-lived access token from a service-account
 * JSON key by signing a JWT (RS256) and exchanging it at Google's token endpoint.
 *
 * This is what lets `docai.js` (Google Document AI) authenticate. Credentials come
 * from Render env (never source): GOOGLE_DOCAI_CREDENTIALS (the raw service-account
 * JSON string) or GOOGLE_DOCAI_CREDENTIALS_B64 (base64 of it, easier to paste into a
 * dashboard field without newline mangling — mirrors MS_CLIENT_CERT_PEM_B64).
 *
 * Best-effort + cached: the token is reused until ~60s before expiry. Any failure
 * (missing/parsing creds, network, non-200) returns null with a reason via throw the
 * caller catches — this module never crashes the server.
 *
 * NOTE on time: unlike the pure findings/date logic (which forbids `Date.now()` for
 * determinism), an OAuth assertion genuinely needs real wall-clock iat/exp — exactly
 * like the DocuSign JWT client. `Date.now()` is correct and required here.
 */
const crypto = require('crypto');
const cfg = require('../../config');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

let _cache = null; // { token, expEpochMs }

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Parse the service-account JSON from env. Accepts the raw JSON or a base64 of it.
 * Returns { client_email, private_key, token_uri } or null when unconfigured/invalid.
 */
function loadServiceAccount() {
  let raw = cfg.docai.credentialsJson;
  if (!raw && cfg.docai.credentialsB64) {
    try { raw = Buffer.from(cfg.docai.credentialsB64, 'base64').toString('utf8'); }
    catch { return null; }
  }
  if (!raw) return null;
  let sa;
  try { sa = JSON.parse(raw); } catch { return null; }
  // Some dashboards turn real newlines in the PEM into literal "\n" — normalize, as
  // crypto.sign() needs real newlines (same fix the DocuSign private key uses).
  if (sa.private_key) sa.private_key = String(sa.private_key).replace(/\\n/g, '\n');
  if (!sa.client_email || !sa.private_key) return null;
  return sa;
}

/** True when a usable service-account is configured (surfaced on /api/health). */
function configured() {
  return !!loadServiceAccount();
}

/**
 * Get a valid access token, minting a fresh one when the cache is empty/near-expiry.
 * Throws a descriptive Error on failure (caller catches and degrades gracefully).
 * @returns {Promise<string>}
 */
async function getAccessToken() {
  const now = Date.now();
  if (_cache && _cache.expEpochMs - 60000 > now) return _cache.token;

  const sa = loadServiceAccount();
  if (!sa) throw new Error('Google Document AI credentials are not configured');

  const iat = Math.floor(now / 1000);
  const exp = iat + 3600; // Google caps assertion life at 1h
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: sa.token_uri || TOKEN_URL,
    iat,
    exp,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  let signature;
  try {
    signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(sa.private_key);
  } catch (e) {
    throw new Error(`Google credentials could not sign the token (${e.message})`);
  }
  const assertion = `${signingInput}.${b64url(signature)}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  let r;
  try {
    r = await fetch(sa.token_uri || TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      signal: ac.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError'
      ? 'Google token endpoint timed out'
      : `Google token endpoint unreachable (${e.message})`);
  } finally {
    clearTimeout(timer);
  }

  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const msg = j.error_description || j.error || `HTTP ${r.status}`;
    throw new Error(`Google token exchange failed (${msg})`);
  }
  _cache = { token: j.access_token, expEpochMs: now + (j.expires_in || 3600) * 1000 };
  return _cache.token;
}

// Test seam: let tests clear the token cache between runs.
function _resetCache() { _cache = null; }

module.exports = { getAccessToken, configured, loadServiceAccount, _resetCache };
