'use strict';
/**
 * THE PUBLIC DOOR FOR A PILOT LINK (owner-directed 2026-08-14; db/551).
 *
 * Mounted at `/d/:token` with NO auth middleware — the 128-bit token IS the capability, exactly as
 * the borrower's draw `reply_token` is. Rate-limited at the mount so guessing is not free, though
 * guessing 128 bits is hopeless; the limit is there for the probe, not the guess.
 *
 * THREE THINGS THIS DOOR DOES THAT A LOGGED-IN DOWNLOAD DOES NOT NEED:
 *
 *  1. IT NEVER TAKES A DOCUMENT ID. The only input is the token, and the bytes come from the
 *     storage reference recorded ON THE LINK. So this can never become a "download any document by
 *     id" hole, and a superseded document cannot quietly change what a recipient receives.
 *  2. IT ANSWERS IN PLAIN ENGLISH, IN HTML. The person on the other end is a capital partner or a
 *     borrower who clicked a link in an email — a JSON error body is useless to them, and "404" is
 *     worse than useless. An expired link says it expired and tells them to ask us to resend; a
 *     revoked one says so. They are told apart deliberately, because only one of them has a remedy
 *     the reader can act on, and it leaks nothing: you cannot reach either answer without already
 *     holding the token.
 *  3. IT IS NEVER INDEXED AND NEVER CACHED BY A SHARED CACHE. `X-Robots-Tag: noindex` plus
 *     `Cache-Control: private, no-store` — a link that turns up in a search result, or is held by a
 *     corporate proxy after the expiry, defeats the expiry entirely.
 *
 * A PDF IS SERVED INLINE, everything else as a download. That is the owner's own ask — *"we can
 * give them a pilot link which will take them directly to the PDF"* — and it is safe for the one
 * type it applies to: a PDF cannot script our origin (the browser's viewer is isolated), we send
 * `nosniff` so a mislabelled file cannot be re-interpreted as HTML, and `X-Frame-Options: DENY`
 * keeps it out of somebody else's frame. Every OTHER type is forced to
 * `application/octet-stream` + `attachment`, which is the same rule `lib/media-headers.js` applies
 * and for the same reason: an arbitrary stored type served inline is a stored-XSS vector.
 */

const express = require('express');
const share = require('../lib/attachments/share-link');

const router = express.Router();

/** A branded, self-explanatory page. The reader is external; they get a sentence, not a status code. */
function page(res, status, title, body) {
  res.status(status).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title} — PILOT by YS Capital</title>
<style>
  body{margin:0;background:#F6F3EC;color:#141B22;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:520px;margin:12vh auto;padding:0 20px}
  .card{background:#fff;border-top:3px solid #AE8746;border-radius:6px;padding:28px 26px;box-shadow:0 1px 3px rgba(20,27,34,.08)}
  h1{font-size:20px;margin:0 0 10px;color:#141B22}
  p{margin:0 0 10px;color:#4B585C}
  .foot{margin-top:22px;font-size:13px;color:#4B585C}
</style></head>
<body><div class="wrap"><div class="card">
  <h1>${title}</h1>${body}
  <p class="foot">PILOT by YS Capital · NMLS #2609746</p>
</div></div></body></html>`);
}

const MESSAGES = {
  unknown: ['Link not found', '<p>This link is not one we recognise. It may have been mistyped, or your email program may have shortened it — try opening it straight from the original email.</p>'],
  expired: ['This link has expired', '<p>Documents shared from PILOT are available for a limited time. Reply to the email this link came from and we will send it across again.</p>'],
  revoked: ['This link has been turned off', '<p>Reply to the email this link came from and we will send the document across again.</p>'],
  unavailable: ['We could not open this just now', '<p>Something on our side is temporarily unavailable. Please try again in a few minutes.</p>'],
  gone: ['We could not find that document', '<p>The link is valid but the file could not be read. Please reply to the email this link came from and we will send it across.</p>'],
};

router.get('/:token', async (req, res) => {
  const found = await share.resolveShareToken(req.params.token);
  if (!found.ok) {
    const [title, body] = MESSAGES[found.code] || MESSAGES.unknown;
    // 410 for a link that WAS real and is now over — the honest status, and it keeps a crawler or a
    // monitor from treating an expiry as a broken page on our site.
    return page(res, found.code === 'expired' || found.code === 'revoked' ? 410
      : found.code === 'unavailable' ? 503 : 404, title, body);
  }

  const row = found.row;
  const buf = await share.readShareBytes(row);
  if (!buf) { const [t, b] = MESSAGES.gone; return page(res, 404, t, b); }

  const ct = String(row.content_type || '').toLowerCase().split(';')[0].trim();
  const inline = ct === 'application/pdf';
  // A filename goes into a header, so it is stripped of anything that could break or inject one.
  const safeName = String(row.filename || 'document').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'document';

  res.setHeader('Content-Type', inline ? 'application/pdf' : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`);
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // `no-store` so a shared/corporate cache cannot keep serving this past the expiry or the revoke.
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.end(buf);

  // AFTER the bytes are on the wire, deliberately: a counter that fails must never cost a recipient
  // their document.
  share.recordOpen(row.id, req.ip).catch(() => {});
});

module.exports = router;
