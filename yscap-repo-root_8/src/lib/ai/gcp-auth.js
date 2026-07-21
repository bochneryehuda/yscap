'use strict';
/**
 * Google Cloud service-account OAuth2 authentication — pure fetch + Node crypto,
 * no @google-cloud SDK (matches the repo's "only express + pg" no-native-deps
 * rule; the SDK pulls in a large tree).
 *
 * Flow:
 *   1. Read the service-account JSON from cfg.docai.keyJson (a full JSON blob
 *      the owner pasted into the Render env — never in source).
 *   2. Mint a JWT with the required claims (iss, scope, aud, exp, iat), signed
 *      RS256 with the private key using Node's built-in crypto.createSign.
 *   3. POST the JWT to Google's OAuth2 token endpoint (grant_type=jwt-bearer)
 *      and receive an access token good for 1 hour.
 *   4. Cache the token in-process with a 5-minute safety margin so subsequent
 *      calls reuse it and don't hit the token endpoint on every request.
 *
 * Best-effort: an unconfigured / malformed key / token-endpoint failure returns
 * { ok:false, reason } without throwing. Never crashes the request.
 */
const crypto = require('crypto');
const cfg = require('../../config');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SAFETY_MARGIN_SEC = 300;   // renew 5 min before expiry — a clock skew guard

let cachedToken = null;   // { token, expiresAtMs, scope }

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// True when the four env vars are set well enough to attempt an auth. Surfaced on /api/health.
function configured() {
  const c = cfg.docai || {};
  return !!(c.keyJson && c.projectId && c.location && c.processorId);
}

// Parse the JSON key blob. Never logs the private_key. On malformed input returns null.
function parseKey() {
  const raw = cfg.docai && cfg.docai.keyJson;
  if (!raw || typeof raw !== 'string') return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj.client_email || !obj.private_key || obj.type !== 'service_account') return null;
    return obj;
  } catch (_) { return null; }
}

/**
 * Get a cached or fresh access token for the given scope.
 * @param {string} scope OAuth2 scope (default: cloud-platform read-only for Document AI processing)
 * @returns {Promise<{ok:boolean, token?:string, reason?:string}>}
 */
async function getAccessToken(scope = 'https://www.googleapis.com/auth/cloud-platform') {
  if (!configured()) return { ok: false, reason: 'Google Document AI is not configured (add GOOGLE_DOCAI_KEY_JSON + project/location/processor to Render env).' };
  const now = Date.now();
  if (cachedToken && cachedToken.scope === scope && cachedToken.expiresAtMs > now + SAFETY_MARGIN_SEC * 1000) {
    return { ok: true, token: cachedToken.token };
  }
  const key = parseKey();
  if (!key) return { ok: false, reason: 'GOOGLE_DOCAI_KEY_JSON is missing or malformed (must be the full service-account JSON blob).' };

  // Mint an RS256 JWT — Google's expected shape for the assertion grant.
  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;   // maximum 1 hour per Google
  const header = { alg: 'RS256', typ: 'JWT', kid: key.private_key_id || undefined };
  const payload = { iss: key.client_email, scope, aud: TOKEN_URL, iat, exp };
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  let sig;
  try {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    sig = base64url(signer.sign(key.private_key));
  } catch (e) {
    return { ok: false, reason: `could not sign the token JWT (${e && e.message ? e.message : 'crypto error'})` };
  }
  const jwt = `${signingInput}.${sig}`;

  // Exchange the JWT for an access token.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  let r;
  try {
    r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, reason: e && e.name === 'AbortError' ? 'the Google token endpoint timed out' : (e && e.message) || 'network error contacting the Google token endpoint' };
  } finally { clearTimeout(timer); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const err = (j && (j.error_description || j.error)) || `HTTP ${r.status}`;
    return { ok: false, reason: `Google token endpoint rejected the assertion (${err})` };
  }
  const expiresInSec = Number(j.expires_in) || 3600;
  cachedToken = { token: j.access_token, expiresAtMs: now + expiresInSec * 1000, scope };
  return { ok: true, token: j.access_token };
}

// For tests + health probes — clears the cache so the next call re-mints.
function _resetTokenCache() { cachedToken = null; }

module.exports = { getAccessToken, configured, _resetTokenCache };
