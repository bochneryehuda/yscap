/**
 * Resend webhook signature verification (#68 inbound file-email).
 *
 * Resend signs webhooks with the Svix scheme. The endpoint's signing secret
 * (`whsec_<base64>`, from the Resend webhook page → Render env RESEND_WEBHOOK_SECRET)
 * is the base64-encoded HMAC key. For each delivery Resend sends three headers:
 *   svix-id         — unique message id
 *   svix-timestamp  — unix seconds when it was sent
 *   svix-signature  — space-delimited list of `v<n>,<base64sig>` entries
 *
 * The signature covers the EXACT raw request bytes: HMAC-SHA256 over
 * `${svix-id}.${svix-timestamp}.${rawBody}`, base64-encoded. We must verify over
 * the RAW body (parsing + re-stringifying JSON would change the bytes and break
 * the signature) — hence this route is mounted before the global JSON parser and
 * applies its own express.raw().
 *
 * Refs: Resend "Verify Webhooks Requests" + Svix "Verifying payloads (manual)".
 * Implemented on Node's built-in crypto only (no svix dependency — this repo
 * intentionally ships without native/extra deps).
 */
const crypto = require('crypto');

// Reject deliveries whose timestamp is too far from now (replay defense). Svix's
// own default tolerance is 5 minutes; match it.
const TOLERANCE_SECONDS = 5 * 60;

/** Decode a `whsec_<base64>` (or bare base64) signing secret to the HMAC key bytes. */
function secretKeyBytes(secret) {
  const raw = String(secret || '');
  const b64 = raw.startsWith('whsec_') ? raw.slice('whsec_'.length) : raw;
  return Buffer.from(b64, 'base64');
}

function constantTimeEquals(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (_) { return false; }
}

/**
 * Verify a Resend/Svix webhook.
 * @param {Buffer|string} rawBody  exact bytes of the request body
 * @param {object} headers         request headers (svix-id / svix-timestamp / svix-signature)
 * @param {string} secret          RESEND_WEBHOOK_SECRET (whsec_…)
 * @param {number} [nowSeconds]    override for tests
 * @returns {{ok:boolean, reason?:string}}
 */
function verify(rawBody, headers, secret, nowSeconds) {
  if (!secret) return { ok: false, reason: 'no secret configured' };
  const h = headers || {};
  const get = (k) => h[k] || h[k.toLowerCase()] || h[k.toUpperCase()] || '';
  const id = get('svix-id');
  const ts = get('svix-timestamp');
  const sigHeader = get('svix-signature');
  if (!id || !ts || !sigHeader) return { ok: false, reason: 'missing svix headers' };

  // Replay window.
  const now = Number.isFinite(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000);
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp outside tolerance' };
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const signedContent = `${id}.${ts}.${body}`;
  const key = secretKeyBytes(secret);
  if (!key.length) return { ok: false, reason: 'unusable secret' };
  const expected = crypto.createHmac('sha256', key).update(signedContent).digest('base64');

  // The header is a space-delimited list of `<version>,<signature>` — any match wins.
  const candidates = sigHeader.split(' ').map((part) => {
    const comma = part.indexOf(',');
    return comma === -1 ? part : part.slice(comma + 1);
  });
  for (const cand of candidates) {
    if (cand && constantTimeEquals(cand, expected)) return { ok: true };
  }
  return { ok: false, reason: 'signature mismatch' };
}

module.exports = { verify, TOLERANCE_SECONDS };
