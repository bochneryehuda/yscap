/**
 * Inbound ClickUp webhook. Mounted OUTSIDE the JSON body-parser (it needs the
 * RAW body to verify the HMAC), like /api/events. ClickUp signs the raw body
 * with HMAC-SHA256 using the webhook secret and sends it as `X-Signature`.
 *
 * Flow: verify signature → dedupe into clickup_webhook_inbox (by body hash, so
 * at-least-once redeliveries collapse) → return 200 fast. The sync worker drains
 * the inbox asynchronously; we never process inline (keeps the ack < ClickUp's
 * timeout and survives a slow DB).
 */
const express = require('express');
const crypto = require('crypto');
const router = require('../lib/safe-router')();
const db = require('../db');
const cfg = require('../config');
const clickup = require('../clickup/client');
const F = require('../clickup/fields');

// Custom-field ids whose values are PII and must never be stored in cleartext
// in the inbox jsonb (they arrive in taskUpdated history_items before/after).
const SENSITIVE_FIELD_IDS = new Set([F.SHARED.borrowerSSN, F.EXTRA.card]);
function redactClickupPayload(p) {
  try {
    if (p && Array.isArray(p.history_items)) {
      for (const h of p.history_items) {
        const fid = h && (h.field === 'custom_field' ? (h.custom_field && h.custom_field.id) : h.field_id);
        if (fid && SENSITIVE_FIELD_IDS.has(String(fid))) {
          if (h.before != null) h.before = '[redacted]';
          if (h.after != null) h.after = '[redacted]';
          if (h.data != null) h.data = '[redacted]';
        }
      }
    }
  } catch (_) { /* redaction best-effort; never block the ack */ }
  return p;
}

// Raw body just for this route (Buffer), so the signature covers exact bytes.
router.use(express.raw({ type: '*/*', limit: '3mb' }));

router.post('/', async (req, res) => {
  const secret = cfg.clickupWebhookSecret;
  const sig = req.get('X-Signature') || req.get('x-signature');
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');

  // Fail closed in production if the secret isn't configured yet.
  if (!secret) {
    if (cfg.env === 'production') return res.status(503).json({ error: 'webhook not configured' });
  } else if (!clickup.verifyWebhookSignature(raw, sig, secret)) {
    return res.status(401).json({ error: 'bad signature' });
  }

  let payload;
  try { payload = JSON.parse(raw.toString('utf8') || '{}'); } catch { return res.status(400).json({ error: 'bad json' }); }

  const eventId = crypto.createHash('sha256').update(raw).digest('hex'); // idempotency key for redeliveries
  const taskId = payload.task_id || (payload.history_items && payload.history_items[0] && payload.history_items[0].parent_id) || null;
  const stored = redactClickupPayload(payload);   // strip SSN/card values before persisting

  try {
    await db.query(
      `INSERT INTO clickup_webhook_inbox (event_id, event, task_id, payload)
       VALUES ($1,$2,$3,$4) ON CONFLICT (event_id) DO NOTHING`,
      [eventId, payload.event || null, taskId, JSON.stringify(stored)]);
  } catch (e) {
    console.error('[clickup-webhook] inbox insert failed:', db.describeError ? db.describeError(e) : e.message);
    // Still 200 — ClickUp retries are fine; we just didn't record this one.
  }
  res.status(200).json({ ok: true });
});

module.exports = router;
