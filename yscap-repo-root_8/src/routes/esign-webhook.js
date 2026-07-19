/**
 * Inbound DocuSign Connect webhook. Mounted OUTSIDE the JSON body-parser (it
 * needs the RAW body to verify the base64 HMAC), exactly like the ClickUp
 * webhook. DocuSign signs the raw body with each configured Connect HMAC key and
 * sends the signatures as X-DocuSign-Signature-1..N.
 *
 * Flow (mirrors clickup-webhook + docs/DOCUSIGN-ERROR-HANDLING-AND-HARDENING §3):
 *   verify HMAC (fail-closed, multi-key) → dedupe into docusign_event_inbox by
 *   sha256(raw body) → 200 fast. The event is only a TRIGGER: the async drainer
 *   (src/lib/esign/webhook.js) re-fetches the truth from DocuSign — the payload
 *   is never trusted as state. A duplicate/replayed/out-of-order delivery is a
 *   no-op (ON CONFLICT DO NOTHING on the body hash).
 *
 * We ack 200 even when the inbox insert fails: DocuSign retries on non-200
 * (requireAcknowledgment=true), and a failed record just means we didn't log
 * that one delivery — the next Envelopes:get reconciles the truth regardless.
 */
const express = require('express');
const crypto = require('crypto');
const router = require('../lib/safe-router')();
const db = require('../db');
const cfg = require('../config');
const docusign = require('../lib/integrations/docusign');

// Best-effort extraction of the envelopeId + event type from a Connect payload.
// Connect's REST-2.1 JSON shape is { event, data: { envelopeId, envelopeSummary,
// recipientId, ... } }; older/aggregate shapes nest under envelopeStatus. We try
// the documented spots and fall back to null — the drainer re-fetches truth, so a
// missing correlation only means a broader reconcile, never a lost event.
function parseCorrelation(payload) {
  const p = payload || {};
  const data = p.data || {};
  const envelopeId =
    data.envelopeId ||
    (data.envelopeSummary && data.envelopeSummary.envelopeId) ||
    (p.envelopeStatus && p.envelopeStatus.envelopeId) ||
    p.envelopeId || null;
  const eventType = p.event || p.eventType || (p.envelopeStatus && p.envelopeStatus.status) || null;
  return { envelopeId: envelopeId ? String(envelopeId) : null, eventType: eventType ? String(eventType) : null };
}

// Raw body just for this route (Buffer) so the signature covers the exact bytes.
router.use(express.raw({ type: '*/*', limit: '5mb' }));

router.post('/', async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  const sigs = docusign.connectSignatureHeaders(req);

  // Fail closed: no HMAC key configured → reject in production (never process an
  // unauthenticated event). In non-production we also reject once keys exist; if
  // none are configured at all we 503 so the misconfiguration is loud.
  if (!(cfg.docusign.connectHmacKeys || []).length) {
    return res.status(503).json({ error: 'webhook not configured' });
  }
  if (!docusign.verifyConnectHmac(raw, sigs)) {
    // Diagnostic only — does NOT change the fail-closed decision. Tells the operator
    // WHY real-time notifications are rejected: 0 signatures = account HMAC not
    // enabled; N signatures = key mismatch. (Meanwhile the poller reconcile covers it.)
    console.warn(`[esign-webhook] rejected (401): ${(sigs || []).length === 0
      ? 'no X-DocuSign-Signature headers — enable "Include HMAC Signature" in DocuSign Connect and add a key equal to DOCUSIGN_CONNECT_HMAC_SECRET'
      : `${sigs.length} signature(s) present, none matched — DOCUSIGN_CONNECT_HMAC_SECRET does not match the account HMAC key`}`);
    return res.status(401).json({ error: 'bad signature' });
  }

  let payload;
  try { payload = JSON.parse(raw.toString('utf8') || '{}'); }
  catch { return res.status(400).json({ error: 'bad json' }); }

  const bodySha = crypto.createHash('sha256').update(raw).digest('hex');
  const { envelopeId, eventType } = parseCorrelation(payload);

  // Store ONLY correlation + status — never document bytes or PII. includeData is
  // recipients+custom_fields (name/email/status), so keep the raw payload out of
  // the inbox; we persist a trimmed correlation object instead.
  const trimmed = { event: eventType, envelopeId, receivedShape: payload && payload.data ? 'restv21' : 'other' };

  try {
    await db.query(
      `INSERT INTO docusign_event_inbox (body_sha256, envelope_id, event_type, raw)
       VALUES ($1,$2,$3,$4) ON CONFLICT (body_sha256) DO NOTHING`,
      [bodySha, envelopeId, eventType, JSON.stringify(trimmed)]);
  } catch (e) {
    console.error('[esign-webhook] inbox insert failed:', db.describeError ? db.describeError(e) : e.message);
    // Still 200 — DocuSign retries are fine; the next Envelopes:get reconciles.
  }

  res.status(200).json({ ok: true });
});

module.exports = router;
