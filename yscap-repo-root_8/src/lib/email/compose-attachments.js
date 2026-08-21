'use strict';

/**
 * ATTACHING A DOCUMENT TO A REPLY YOU TYPE (owner-directed 2026-08-21: *"on any reply to any
 * Gmail section that we currently have — the insurance order, the title order, the draw
 * section, the general email inbox — we need to be able to attach documents over there
 * manually and also drag and drop into the box of the email."*)
 *
 * The email layer has carried attachments for a long time — the investor delivery, the closing
 * package and the order emails all send them, `email_messages.attachments` records them, and
 * both providers accept them. What did not exist was a way for a HUMAN to put one on a message
 * they are writing. This is that: it turns what a browser hands us into what a provider takes,
 * under every guard the rest of this codebase already learned the hard way.
 *
 * WHAT IT REFUSES, AND WHY EACH ONE IS HERE:
 *
 *  · **Bytes that are not really base64.** Everything goes through `upload-bytes.decodeUploadBase64`,
 *    the ONE decoding chokepoint — never a bare `Buffer.from(x,'base64')`, whose silent
 *    character-skipping is what once mirrored garbage into SharePoint as "a corrupted document".
 *
 *  · **A type derived from what the SENDER SAID rather than from the bytes.** The content type is
 *    sniffed from the magic bytes (`upload-bytes.sniffContentType`) and the claimed one is only
 *    accepted when nothing recognisable is there. A file claiming to be a PDF and containing HTML
 *    is stored XSS aimed at whoever opens it — the same rule `dispute-media` applies to a
 *    borrower's evidence, for the same reason.
 *
 *  · **HTML and SVG outright.** They are scripts wearing a document's clothes, and an attachment
 *    this door produces is opened by an outside company (a title agent, an attorney) whose mail
 *    client we do not control. Nothing legitimate needs to be attached as either.
 *
 *  · **A filename that is not a filename.** Sanitized through `closing-prep.attachName` — the same
 *    one the closing package uses, so an attachment reads the same however it got onto a message —
 *    which strips paths, control characters and a NUL (which Postgres refuses in text at all).
 *
 *  · **More, or bigger, than the provider will take.** The budget is `closing-prep.attachBudget()`,
 *    which is the LIVE provider's real ceiling in BOTH dimensions: raw bytes, and the encoded size
 *    on the wire, which is the number a receiving mail server actually measures (attachments travel
 *    base64 — a 33% expansion, which is how a package that "fit" got rejected after we had said it
 *    was sent). Reusing it means the typed reply and the automated package can never disagree about
 *    what one message can hold.
 *
 * NOTHING IS EVER SILENTLY DROPPED. Anything that does not ride comes back in `skipped` WITH a
 * plain-language reason, and the caller is expected to say so — this repo's standing rule, and the
 * reason the investor delivery once went out two documents short with nothing anywhere saying so.
 */

const uploadBytes = require('../upload-bytes');

// Lazily required: closing-prep pulls in the whole closing desk, and this module is loaded by a
// hot HTTP route.
const prep = () => require('../closing-prep');

/** How many documents one typed message may carry. A person attaching more than this to a
 *  single email is doing something a package export does better. */
const MAX_FILES = Math.max(1, Number(process.env.EMAIL_COMPOSE_MAX_FILES) || 10);

/** What a sniffed kind actually IS on the wire. Anything the sniffer cannot place falls back
 *  to the claimed type, and then to the safe generic. */
const MIME_OF = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif',
  tiff: 'image/tiff', heic: 'image/heic', zip: 'application/zip',
};

/** Never attachable, whatever it is called or claims to be. */
const REFUSED_TYPES = new Set(['text/html', 'image/svg+xml', 'application/xhtml+xml']);

const human = (n) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * Turn what the browser sent into provider-ready attachments.
 *
 * @param {Array} uploads  [{ filename, contentType, dataBase64 }]
 * @param {object} [opts]  { budget } — defaults to the live provider's real ceiling
 * @returns {{ attachments: Array, skipped: Array, totalBytes: number, count: number }}
 *          `attachments` are `{ filename, content(base64), contentType }` — the shape BOTH
 *          providers already take. `skipped` is `[{ filename, code, why }]`.
 */
function readComposeAttachments(uploads, opts = {}) {
  const out = { attachments: [], skipped: [], totalBytes: 0, count: 0 };
  const list = Array.isArray(uploads) ? uploads.filter(Boolean) : [];
  if (!list.length) return out;

  const P = prep();
  const budget = opts.budget || P.attachBudget();
  const encodedLen = P.encodedLen;
  let rawUsed = 0;
  let encodedUsed = 0;

  // A Set, so two files called `scan.pdf` are told apart on the message rather than
  // arriving as one name twice — the same qualifier the closing package uses.
  const usedNames = new Set();
  for (const u of list) {
    // `attachName` takes the DOC, not a string — it reads `doc.filename` — and it strips
    // path separators, quotes and newlines. The NUL strip is belt-and-suspenders: the
    // request-boundary middleware already removes it from every parsed body, but this
    // name also reaches a mail header.
    const named = P.attachName({ filename: String((u && u.filename) || 'attachment').replace(/\0/g, '') }, usedNames);
    if (out.attachments.length >= MAX_FILES) {
      out.skipped.push({ filename: named, code: 'too_many', why: `only ${MAX_FILES} files can ride on one email` });
      continue;
    }
    let buf;
    try {
      ({ buf } = uploadBytes.decodeUploadBase64(u && u.dataBase64));
    } catch (e) {
      out.skipped.push({ filename: named, code: 'unreadable', why: 'the file could not be read' });
      continue;
    }
    if (!buf || !buf.length) {
      out.skipped.push({ filename: named, code: 'empty', why: 'the file is empty' });
      continue;
    }
    // THE BYTES DECIDE THE TYPE, not the sender. A claimed type is a fallback, never an
    // override — see the header. `sniffKind` is the SAME reader the corruption audit uses,
    // so "what is this file" has one answer in this codebase.
    const kind = uploadBytes.sniffKind(buf);
    const claimed = String((u && u.contentType) || '').trim().toLowerCase().split(';')[0] || '';
    // SVG carries NO magic bytes — it is XML text — so the sniffer cannot see it and the
    // claimed type is the only signal. Both are checked; either one is enough to refuse.
    const head = buf.subarray(0, 256).toString('latin1').trimStart().toLowerCase();
    const looksSvg = head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
    if (kind === 'html' || looksSvg || REFUSED_TYPES.has(claimed)) {
      out.skipped.push({ filename: named, code: 'unsafe_type', why: 'a web page cannot be attached — save it as a PDF first' });
      continue;
    }
    const type = (kind && MIME_OF[kind]) || (claimed && !REFUSED_TYPES.has(claimed) ? claimed : '') || 'application/octet-stream';
    const enc = encodedLen(buf.length);
    if (rawUsed + buf.length > budget.raw || encodedUsed + enc > budget.encoded) {
      const cap = Number.isFinite(budget.raw) ? budget.raw : budget.encoded;
      out.skipped.push({ filename: named, code: 'too_big',
        why: `it does not fit — one email can carry about ${human(cap)} in total` });
      continue;
    }
    rawUsed += buf.length;
    encodedUsed += enc;
    out.attachments.push({ filename: named, content: buf.toString('base64'), contentType: type });
  }
  out.totalBytes = rawUsed;
  out.count = out.attachments.length;
  return out;
}

/** One plain-language sentence naming what could not be attached, or null. */
function skippedNote(skipped) {
  const s = Array.isArray(skipped) ? skipped.filter(Boolean) : [];
  if (!s.length) return null;
  return `Not attached: ${s.map((x) => `${x.filename} (${x.why})`).join('; ')}.`;
}

module.exports = { readComposeAttachments, skippedNote, MAX_FILES, REFUSED_TYPES };
