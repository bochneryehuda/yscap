/**
 * Inbound email → chat (#75, #144). When ANY chat member replies to their unique
 * reply-to address (chat+<reply_key>@<CHAT_REPLY_DOMAIN>), the email provider's
 * inbound webhook POSTs the parsed message here, and we post it back into the
 * conversation as that member — an external guest (#75) OR an internal/borrower
 * member (#144), resolved by chat.postInboundReply against both families.
 *
 * The reply_key IS the secret — 122+ bits of unguessable entropy — so an unknown
 * or removed key is a silent no-op (200, so the provider doesn't retry). This
 * endpoint stays dormant until an inbound-email domain is configured in Resend
 * (CHAT_REPLY_DOMAIN + an inbound route/webhook); no key ever matches before then.
 *
 * Tolerant to the common inbound-webhook shapes (Resend `email.received`, a bare
 * parsed-email object, SendGrid-style form fields) — it only needs the recipient
 * address(es) and the plain-text body.
 */
const express = require('express');
const chat = require('../lib/chat');

const router = express.Router();

// Pull chat+<key> out of any of the recipient addresses.
function replyKeyFromRecipients(list) {
  for (const raw of list) {
    const m = String(raw || '').match(/chat\+([A-Za-z0-9_-]+)@/i);
    if (m) return m[1];
  }
  return null;
}

// Strip the quoted reply/signature so ONLY what the person typed posts to the chat.
//
// The rule itself now lives in `lib/email/quote.js` (2026-08-07). It was written
// HERE, inside a route module, which is exactly why it only ever applied to the
// `chat+` family: the file thread, the vendor order returns and the closing chain
// all arrive through `lib/file-inbox.js` and were never stripped at all, so the
// "New reply on a loan file" email and the Email Center carried a fresh copy of the
// whole conversation every round. One definition in the library, four families
// reading it — a pattern added for one now fixes all of them.
const { stripQuoted } = require('../lib/email/quote');
function topReply(text) { return stripQuoted(text); }

function collectRecipients(body) {
  const out = [];
  const push = (v) => {
    if (!v) return;
    if (Array.isArray(v)) v.forEach(push);
    else if (typeof v === 'object') push(v.address || v.email || v.value);
    else out.push(String(v));
  };
  const d = (body && body.data) || body || {};
  push(d.to); push(d.To); push(d.recipient); push(d.envelope && d.envelope.to);
  return out;
}

router.post('/', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const d = (body.data && typeof body.data === 'object') ? body.data : body;
    const key = replyKeyFromRecipients(collectRecipients(body));
    if (!key) return res.json({ ok: true, skipped: 'no reply key' });
    const text = topReply(d.text || d.plain || d['stripped-text'] || d.body || '');
    if (!text) return res.json({ ok: true, skipped: 'empty body' });
    // #144 — an external guest OR an internal/borrower member: resolve against both.
    const msg = await chat.postInboundReply(key, text);
    return res.json({ ok: true, posted: !!msg });
  } catch (e) {
    // Never 500 back to a provider (it would retry forever); log + accept.
    console.error('[inbound-chat]', e.message);
    return res.json({ ok: true, error: 'handled' });
  }
});

module.exports = router;
