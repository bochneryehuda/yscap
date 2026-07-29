/**
 * Shared HMAC "form token" for the PUBLIC marketing-site endpoints (#153 class).
 * GET /api/leads/token hands the page a signed timestamp; the page echoes it on
 * POST. A valid token proves the sender actually loaded the page (and, via the
 * min-age check, dwelled on it like a human) — a blind curl/bot replay never
 * fetched one. Extracted from routes/leads.js so BOTH public write surfaces
 * (/api/leads and /api/apply) verify the exact same token; the token endpoint
 * stays GET /api/leads/token and its tokens work on either.
 */
const crypto = require('crypto');
const cfg = require('../config');

const TOKEN_MIN_MS = Number(process.env.LEADS_TOKEN_MIN_MS || 3000);
const TOKEN_MAX_MS = Number(process.env.LEADS_TOKEN_MAX_MS || 2 * 60 * 60 * 1000);

function signFormToken(ts) {
  return ts + '.' + crypto.createHmac('sha256', String(cfg.jwtSecret || 'dev')).update('leadform|' + ts).digest('hex').slice(0, 32);
}

// Returns the token's age in ms, or null when it is missing/forged/malformed.
function formTokenAgeMs(token) {
  const m = /^(\d{10,16})\.([0-9a-f]{32})$/.exec(String(token || ''));
  if (!m) return null;
  if (signFormToken(m[1]) !== m[0]) return null;
  const age = Date.now() - Number(m[1]);
  return age >= 0 ? age : null;
}

// One-call human check: valid signature AND a plausible dwell window.
function formTokenOk(token) {
  const age = formTokenAgeMs(token);
  return age != null && age >= TOKEN_MIN_MS && age <= TOKEN_MAX_MS;
}

module.exports = { signFormToken, formTokenAgeMs, formTokenOk, TOKEN_MIN_MS, TOKEN_MAX_MS };
