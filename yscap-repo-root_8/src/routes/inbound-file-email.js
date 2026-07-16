/**
 * Inbound email webhook (#68 + #75). Resend POSTs an `email.received` event here
 * when mail arrives on the inbound domain. We verify the Svix/Resend signature
 * over the RAW body, then hand the parsed event to lib/file-inbox, which
 * retrieves the full message and dispatches by address family:
 *   file+<applicationId>@<CHAT_REPLY_DOMAIN> → branded forward to every active
 *     assignee on that file;
 *   chat+<reply_key>@<CHAT_REPLY_DOMAIN>     → posted into the conversation as
 *     the external guest (#75 — the webhook has no body, so the retrieval must
 *     happen HERE; the legacy /api/inbound/chat route reads text off the webhook
 *     itself and only works for body-carrying providers).
 * This is the ONE webhook endpoint to configure in Resend — see
 * docs/EMAIL-REPLY-INBOX-SETUP.md.
 *
 * Mounted BEFORE the global JSON parser (like the ClickUp webhook) so we can
 * verify the signature against the exact request bytes.
 *
 * Status contract (owner spec, revised by the round-2 audit):
 *  - 400 when the signature is invalid OR no webhook secret is configured — the
 *    endpoint never processes unauthenticated input.
 *  - 503 for RETRYABLE processing failures (Resend retrieval down, forward/SMTP
 *    failure, transient DB error) — Resend's bounded retry schedule redelivers
 *    and the idempotency reclaim in lib/file-inbox finishes the job. A transient
 *    failure must never silently drop a reply.
 *  - 200 for every TERMINAL outcome (forwarded, unknown file, archived file,
 *    no assignees, auto-generated mail, duplicate) so Resend never retries one.
 */
const express = require('express');
const router = express.Router();
const cfg = require('../config');
const webhook = require('../lib/resend-webhook');
const fileInbox = require('../lib/file-inbox');

// Raw body for THIS route only (Buffer), so the signature covers exact bytes.
router.use(express.raw({ type: '*/*', limit: '5mb' }));

router.post('/', async (req, res) => {
  try {
    // express.raw leaves req.body as {} (not a Buffer) when the request has no
    // body/Content-Length — Buffer.from({}) throws, and an async throw before a
    // response hangs the connection forever. Coerce defensively.
    const raw = Buffer.isBuffer(req.body) ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : '');

    // Signature verification — fail CLOSED. A missing secret can't authenticate
    // anyone, so an unconfigured endpoint refuses everything (the feature is
    // dormant until RESEND_WEBHOOK_SECRET + CHAT_REPLY_DOMAIN are set).
    if (!cfg.resendWebhookSecret) return res.status(400).json({ error: 'webhook not configured' });
    const v = webhook.verify(raw, req.headers, cfg.resendWebhookSecret);
    if (!v.ok) return res.status(400).json({ error: 'invalid signature' });

    let event;
    try { event = JSON.parse(raw.toString('utf8') || '{}'); }
    catch (_) { return res.status(200).json({ ok: true, skipped: 'bad json' }); }

    // Only inbound-received events are actionable; ack anything else.
    const type = event && (event.type || event.event);
    if (type && type !== 'email.received') return res.json({ ok: true, skipped: 'ignored type' });

    const result = await fileInbox.processReceivedEvent(event);
    if (result && result.retryable) {
      return res.status(503).json({ ok: false, retry: true, result: result.status });
    }
    return res.json({ ok: true, result: result && result.status });
  } catch (e) {
    // Unknown failure: the idempotency claim (if one was written) is reclaimable
    // after its stuck window, so asking Resend to redeliver is safe and may heal.
    console.error('[inbound-file-email] unhandled:', (e && e.message ? String(e.message) : String(e)).slice(0, 200));
    return res.status(503).json({ ok: false, retry: true });
  }
});

module.exports = router;
