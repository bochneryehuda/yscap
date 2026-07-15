/**
 * Inbound email → per-file forward (#68). Resend POSTs an `email.received`
 * webhook here when someone replies to file+<applicationId>@<CHAT_REPLY_DOMAIN>.
 * We verify the Svix/Resend signature over the RAW body, then hand the parsed
 * event to lib/file-inbox, which retrieves the full message and forwards it to
 * every active assignee on that file.
 *
 * Mounted BEFORE the global JSON parser (like the ClickUp webhook) so we can
 * verify the signature against the exact request bytes. This route is SEPARATE
 * from /api/inbound/chat (which is unchanged) — a single Resend account can point
 * different receiving addresses at different webhook URLs.
 *
 * Status contract (owner spec):
 *  - 400 ONLY when the signature is invalid (or missing when a secret is set).
 *  - 200 for everything else — including unknown file, no assignees, retrieval or
 *    forward failure — so Resend never retries a normal processing outcome and we
 *    never return a 500 for one.
 */
const express = require('express');
const router = express.Router();
const cfg = require('../config');
const webhook = require('../lib/resend-webhook');
const fileInbox = require('../lib/file-inbox');

// Raw body for THIS route only (Buffer), so the signature covers exact bytes.
router.use(express.raw({ type: '*/*', limit: '5mb' }));

router.post('/', async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');

  // Signature verification. Fail CLOSED in production when the secret isn't set
  // yet (a missing secret can't authenticate anyone) — but stay open in dev/test
  // so local calls without a secret don't 400.
  if (!cfg.resendWebhookSecret) {
    if (cfg.env === 'production') return res.status(400).json({ error: 'webhook not configured' });
  } else {
    const v = webhook.verify(raw, req.headers, cfg.resendWebhookSecret);
    if (!v.ok) return res.status(400).json({ error: 'invalid signature' });
  }

  let event;
  try { event = JSON.parse(raw.toString('utf8') || '{}'); }
  catch (_) { return res.status(200).json({ ok: true, skipped: 'bad json' }); }

  // Only inbound-received events are actionable; ack anything else.
  const type = event && (event.type || event.event);
  if (type && type !== 'email.received') return res.json({ ok: true, skipped: 'ignored type' });

  try {
    const result = await fileInbox.processReceivedEvent(event);
    return res.json({ ok: true, result: result && result.status });
  } catch (e) {
    // Never 500 to Resend for a processing failure (it would retry forever).
    console.error('[inbound-file-email] unhandled:', (e && e.message ? String(e.message) : String(e)).slice(0, 200));
    return res.json({ ok: true, error: 'handled' });
  }
});

module.exports = router;
