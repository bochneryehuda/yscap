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

// Strip the quoted reply/signature so ONLY what the person typed posts to the
// chat. A reply email is [fresh reply] followed by the quoted original below it,
// so we cut at the EARLIEST quote boundary and keep everything before it:
//   • our own "Reply above this line" delimiter (#146) — printed at the TOP of
//     every chat notification email, so in the quote it sits just below the fresh
//     reply; the stable token both sides key on.
//   • the client's own quote attribution ("On <date> … wrote:", Outlook "From:"),
//   • a "--" signature rule, or a leading-">" quote block.
// Whichever appears first wins — Gmail/Outlook add an attribution line ABOVE our
// marker, so taking the minimum index keeps the reply clean even then.
// The delimiter phrase is imported from chat.js (single source of truth) so the
// outbound copy and this inbound cut can never drift apart. Escaped for regex use.
const MARKER_RE = new RegExp(chat.CHAT_REPLY_MARKER_PHRASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

function topReply(text) {
  const s = String(text || '').replace(/\r\n/g, '\n');
  const patterns = [
    MARKER_RE,                         // our delimiter (#146) — imported from chat.js
    /\n\s*On .+ wrote:/,               // Gmail / Apple Mail attribution
    /\n\s*-{2,}\s*\n/,                 // "--" signature separator
    /\n>{1,}/,                          // quoted block
    /\n\s*From:\s.+/i,                 // Outlook "From:" header block
    /\n\s*_{5,}\s*\n/,                 // Outlook horizontal rule
  ];
  let cut = -1;
  for (const p of patterns) {
    const idx = s.search(p);
    if (idx > 0 && (cut === -1 || idx < cut)) cut = idx;
  }
  const out = cut > 0 ? s.slice(0, cut) : s;
  // Trim trailing decorative dashes / quote glyphs the cut may leave behind.
  return out.replace(/[—\-\s>]+$/, '').trim();
}

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
