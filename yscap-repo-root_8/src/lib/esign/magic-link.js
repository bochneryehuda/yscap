/**
 * esign/magic-link.js — the tokens behind PILOT's own "documents ready to sign"
 * email (owner-directed 2026-07-20).
 *
 * The owner wants PILOT to send its OWN branded signing invitation whose link takes
 * the borrower STRAIGHT to the DocuSign envelope (no portal stop, no "Sign now"
 * click) and then, after signing, lands them back INSIDE their loan file already
 * logged in. DocuSign's own email stays on as a fallback ("both").
 *
 * Two short signed tokens make that safe (HMAC-SHA256 via the shared crypto/JWT
 * helper — no new secret, no DB row for the link itself):
 *
 *   1. SIGNING token (in the PILOT email link, `/api/esign/sign?t=…`)
 *      Authorizes minting an embedded DocuSign signing view for ONE recipient of
 *      ONE envelope. Valid for the whole signing window (default 30 days). It is a
 *      BEARER for signing that one envelope — exactly what DocuSign's own email link
 *      already grants — never a portal session. Re-usable: each click re-mints a
 *      fresh single-use DocuSign view, so an email security-scanner that "clicks"
 *      the link consumes nothing (the human's later click still works).
 *
 *   2. RETURN-AUTH token (threaded into the DocuSign returnUrl, `&ra=…`)
 *      Proves the /api/esign/return bounce may mint a ONE-TIME login code for THIS
 *      borrower after they finish signing. Short-lived (1h — covers signing time).
 *      Not a session either; the actual session is handed to the SPA only via a
 *      single-use `email_tokens('login')` code it exchanges once (esign-public).
 *
 * SECURITY: `sub` is set to the ENVELOPE row id (never a borrower id), and the kinds
 * are 'esign_magic' / 'esign_return' (never 'staff'/'borrower'). So even if one of
 * these tokens were ever presented as a Bearer access token, auth.authenticate both
 * (a) rejects any kind outside {staff,borrower} and (b) would look up token_version
 * for a non-existent borrower and 401 — it can never become a portal session.
 */
const crypto = require('crypto');
const C = require('../crypto');
const cfg = require('../../config');

// The signing link is valid for the whole signing window; the DocuSign envelope
// itself also expires (notificationSettings expireAfterDays), and /api/esign/sign
// re-checks the envelope is still open, so this is an upper bound, not the gate.
const SIGNING_TTL_SEC = 30 * 24 * 3600;   // 30 days
// Short — it only has to survive DocuSign's hosted signing session (minutes). Kept
// tight so a captured returnUrl is stale fast; the handoff is ALSO one-shot per `jti`
// (esign-public /return records the jti), so a replay within the window mints nothing.
const RETURN_TTL_SEC = 15 * 60;           // 15 minutes

/**
 * Mint the signing magic token for one recipient of one envelope.
 * @param {{envelopeRowId:string, borrowerId:string, recipientIdDs:string}} b
 */
function mintSigningToken({ envelopeRowId, borrowerId, recipientIdDs }, ttlSec = SIGNING_TTL_SEC) {
  return C.signJwt({
    kind: 'esign_magic',
    sub: String(envelopeRowId),          // NOT a borrower id — can never be a session
    er: String(envelopeRowId),
    bid: String(borrowerId),
    rid: String(recipientIdDs),
  }, ttlSec);
}

/** Verify a signing magic token → { envelopeRowId, borrowerId, recipientIdDs } or null. */
function verifySigningToken(token) {
  const c = C.verifyJwt(token);
  if (!c || c.kind !== 'esign_magic' || !c.er || !c.bid || !c.rid) return null;
  return { envelopeRowId: String(c.er), borrowerId: String(c.bid), recipientIdDs: String(c.rid) };
}

/**
 * Mint the return-authorization token threaded into the DocuSign returnUrl.
 * @param {{borrowerId:string, applicationId:string}} b
 */
function mintReturnAuth({ borrowerId, applicationId }, ttlSec = RETURN_TTL_SEC) {
  return C.signJwt({
    kind: 'esign_return',
    sub: String(applicationId || 'esign'),   // NOT a borrower id
    bid: String(borrowerId),
    app: applicationId ? String(applicationId) : null,
    jti: crypto.randomBytes(12).toString('hex'),   // one-shot handle — /return records it so a replay mints nothing
  }, ttlSec);
}

/** Verify a return-auth token → { borrowerId, applicationId, jti } or null. */
function verifyReturnAuth(token) {
  const c = C.verifyJwt(token);
  if (!c || c.kind !== 'esign_return' || !c.bid) return null;
  return { borrowerId: String(c.bid), applicationId: c.app ? String(c.app) : null, jti: c.jti ? String(c.jti) : null };
}

/** The absolute PILOT signing URL for a token (a plain path+query — survives email
 *  click-tracking, which only drops URL #fragments, not query strings). */
function signingUrl(token) {
  return `${(cfg.appUrl || '').replace(/\/+$/, '')}/api/esign/sign?t=${encodeURIComponent(token)}`;
}

module.exports = {
  mintSigningToken, verifySigningToken,
  mintReturnAuth, verifyReturnAuth,
  signingUrl,
  SIGNING_TTL_SEC, RETURN_TTL_SEC,
};
