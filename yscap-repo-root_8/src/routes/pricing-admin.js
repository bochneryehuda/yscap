'use strict';
/**
 * Pricing-admin unlock — the SERVER side of the Term Sheet Studio's "Admin mode"
 * gate (owner-directed 2026-08-03).
 *
 * WHY THIS EXISTS. The unlock used to be decided in the browser: every shipped
 * copy of the tool carried `ADMIN_HASH` plus the plaintext password in a comment
 * (`web/tools/termsheet.js`, `web/v2/tools/termsheet.js`, both
 * `loan-application.html`s, and — inside the portal bundle every borrower
 * downloads — `ProductStudioPanel.jsx`). Anyone who opened the file read the
 * password, and anyone who didn't bother could just call the unlock function
 * from the console: a check that runs on the visitor's machine is advisory, not
 * a gate. The password now lives ONLY here; the browser sends what the user
 * typed and is told yes or no.
 *
 * WHAT DELIBERATELY DID NOT CHANGE (owner-directed):
 *   • The password itself. Same one as before.
 *   • Password-only unlock, with NO portal login. Staff working from a shared
 *     term-sheet link must still be able to open the pricing controls, so this
 *     route is intentionally unauthenticated — the password IS the credential.
 *     That is why it is rate limited (src/server.js) and why the response is a
 *     bare yes/no.
 *
 * WHAT THIS ROUTE DOES NOT DO. It hands back no pricing data. Unlocking only
 * reveals controls the page already has: markup and origination reach the tool
 * through /api/pricing-defaults exactly as before, unlock or no unlock, so
 * pricing math is untouched either way. And it grants no server-side power —
 * a borrower session still cannot send staff pricing overrides (that path was
 * removed in audit S1-04; see src/routes/borrower.js). This gate decides one
 * thing: whether the panel is on screen.
 *
 * ROTATING IT. Set PRICING_ADMIN_PASSWORD and restart. With it unset the
 * historical password keeps working (stored below as a SHA-256 digest, never
 * plaintext, and never shipped to a browser) so this deploy changes nothing for
 * anyone already using the tool.
 */
const express = require('express');
const crypto = require('crypto');

const router = express.Router();

// SHA-256 of the password the tool has always used. Kept as a digest so the
// plaintext is not in the repository, and server-side so it is not in any
// browser. PRICING_ADMIN_PASSWORD overrides it — prefer that, and rotate.
const LEGACY_SHA256 = '4e40702abfb8aa72c06261c4aa7ca059af5bd1f261ae0077e010b33d4db38d0c';

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

function expectedDigest() {
  const env = String(process.env.PRICING_ADMIN_PASSWORD || '').trim();
  return env ? sha256(env) : LEGACY_SHA256;
}

// Constant-time compare so a wrong password can't be narrowed down by timing.
// Both sides are fixed-length hex digests, so lengths always match here.
function digestsMatch(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * POST /api/pricing-admin/unlock  { password }  ->  { ok: true } | 401 { ok: false }
 *
 * Never says WHY it failed and never echoes the attempt back.
 */
router.post('/unlock', (req, res) => {
  const password = String((req.body && req.body.password) || '');
  // No-store: an unlock verdict must never sit in a browser or proxy cache.
  res.set('Cache-Control', 'no-store');
  if (!password || !digestsMatch(sha256(password), expectedDigest())) {
    return res.status(401).json({ ok: false });
  }
  return res.json({ ok: true });
});

module.exports = router;
