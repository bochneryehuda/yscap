'use strict';
/**
 * LONG-TERM — THE VERIFICATION OF RENT, OVERLAID ON THE OWNER'S OWN BLANK.
 *
 * THIS MODULE DRAWS NO FORM. It opens `src/longterm/assets/blank-vor.pdf` — the
 * standard Request for Verification of Rent (form mark `GVOR_S 11/15`) the owner
 * sent us — and puts text into its blanks. Nothing here creates a page, a
 * letterhead, a heading or a paragraph.
 *
 * ── WHY THAT IS THE WHOLE POINT ─────────────────────────────────────────────
 *
 * An earlier version of this file called `PDFDocument.create()` and drew a
 * PILOT-branded lookalike from scratch. The owner reported it in those words:
 * *"You messed up by far. You're not using our blank VOR."* and *"the VOR needs to
 * be on the exact blank form that I sent you."* A landlord's compliance desk knows
 * this form; a document that merely resembles it gets filed as an unknown request
 * from an unknown lender, and the tenancy never gets verified. So the owner's bytes
 * are the document, and ours is the ink.
 *
 * ── A SWAPPED BLANK FAILS AT BOOT, NOT IN THE MAIL ──────────────────────────
 *
 * Every coordinate in `fields.js` was measured on THAT page at 612 x 792. Drop a
 * different blank in — a second page, a Legal-sized scan, a re-typeset revision —
 * and every one of them silently moves: our text lands across the form's printed
 * lines and a landlord is mailed a defaced document. So the file is checked when
 * this module LOADS (a synchronous structural read of the page tree, the only kind
 * possible at require-time) and again on the parsed document at every render, where
 * pdf-lib is the authority the boot-time scan approximates. Loud at boot beats
 * discovered in an inbox.
 *
 * ── THE PREVIEW IS BUILT FROM THE DATA, EVERY TIME ──────────────────────────
 *
 * KEPT DELIBERATELY from the version this replaces. The owner asked to "preview and
 * edit the PDF before sending". What is EDITED is the DATA; the overlay is redrawn
 * from it on every preview and again at the moment of sending. Editing PDF BYTES
 * would leave the anchors somewhere nobody can predict, so the tabs would stop
 * landing on their lines — and every reader downstream (the condition, the returned
 * answers, the reporting) reads the data anyway. Rendering from the data means the
 * preview is EXACTLY the document that goes out, by construction rather than by a
 * promise.
 *
 * ── THE ANCHORS ARE INVISIBLE, AND THEY ARE NOT DECORATION ──────────────────
 *
 * ALSO KEPT DELIBERATELY. Each landlord field's anchor is drawn in WHITE at 4pt in
 * its blank — invisible to a human, findable by DocuSign, which places the tab
 * relative to it. The anchor strings come from `fields.js` and are never spelled
 * here: the document and the tab list are two halves of one mechanism, and a second
 * spelling is how a tab ends up on the wrong line. They are the ONLY thing of ours
 * that goes below the "To Be Completed By Landlord" bar, and an anchor is not an
 * answer — it is where DocuSign hangs the empty box.
 *
 * SEPARATION: reads `./fields` (long-term), `pdf-lib` (npm) and one asset file on
 * disk. No database, no config, no other module.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const F = require('./fields');

/** The owner's blank. */
const BLANK_PATH = path.join(__dirname, '..', 'assets', 'blank-vor.pdf');

const INK = rgb(0.05, 0.05, 0.05);          // near-black, so it photocopies like the form
const WHITE = rgb(1, 1, 1);
const ANCHOR_SIZE = 4;                      // small enough that a human never sees it
const EPSILON = 1;                          // pt of slack on the page size — a re-save can round

/**
 * WinAnsi cannot draw a curly quote or an em dash; a PDF that throws mid-build is
 * worse than one with a straight apostrophe, so every string is folded first.
 * KEPT from the version this replaces, for exactly that reason.
 */
function pdfSafe(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[^\x20-\x7E\n]/g, '');
}

/** Wrap to a width, measured in the font that will actually draw it. */
function wrap(text, font, size, width) {
  const words = pdfSafe(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
    if (line) lines.push(line);
    line = w;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The same, but a NEWLINE the caller wrote is honoured as a line break.
 *
 * Items 1, 2 and 8 are name-and-address blocks, and an address whose line breaks
 * are re-flowed away — "Acme Realty LLC 88 Clifton Avenue Lakewood, NJ 08701" on
 * one run — is what a landlord's mailroom reads as a mangled form. The breaks the
 * prefill puts in are meaning, not whitespace.
 */
function wrapBlock(text, font, size, width) {
  const out = [];
  for (const seg of String(text == null ? '' : text).split(/\r?\n/)) {
    if (!seg.trim()) continue;
    for (const line of wrap(seg, font, size, width)) out.push(line);
  }
  return out;
}

/**
 * A value we hold, printed the way the form expects it. A date column comes back as
 * 'YYYY-MM-DD' and never goes through `new Date()` — that is a UTC day-shift waiting
 * to happen, and this one prints as item 5, the date of the request.
 */
function fmtValue(field, v) {
  const s = v == null ? '' : String(v).trim();
  if (!s) return '';
  if (field && field.type === 'date') {
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[2]}/${m[3]}/${m[1]}` : s;
  }
  return s;
}

/**
 * Is this the owner's page? Asked of the PARSED document, where pdf-lib is the
 * authority. A wrong answer here is a landlord receiving a form with our text
 * written across its printed lines, so it throws rather than returning false.
 */
function assertOwnersPage(doc, where) {
  const n = doc.getPageCount();
  if (n !== 1) {
    throw new Error(`vor/pdf: the blank VOR must be exactly one page, ${where} has ${n} — every coordinate in fields.js is measured on page 1 of the owner's form`);
  }
  const page = doc.getPage(0);
  const w = page.getWidth();
  const h = page.getHeight();
  if (Math.abs(w - F.PAGE.w) > EPSILON || Math.abs(h - F.PAGE.h) > EPSILON) {
    throw new Error(`vor/pdf: the blank VOR must be ${F.PAGE.w}x${F.PAGE.h}pt, ${where} is ${w}x${h} — a different page size moves every prefill coordinate onto the form's own lines`);
  }
}

/**
 * Every Flate-compressed stream in a PDF, inflated. Anything that will not inflate
 * (an image, an already-plain stream, a truncated one) is skipped rather than
 * reported: this is a READ of a file we are checking, and a broken stream inside it
 * is not itself the question being asked.
 */
function inflatedStreams(raw) {
  const out = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    try { out.push(zlib.inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1')); }
    catch (_) { /* not a Flate stream, or not one we need — the scan reads on */ }
  }
  return out;
}

/**
 * The same question, asked synchronously of the RAW BYTES so it can be asked at
 * require-time.
 *
 * pdf-lib's parser is async, and a module cannot await at load in CommonJS — so a
 * swapped blank would otherwise only be caught by whoever happened to render next,
 * which on a bad day is a landlord. This reads the page tree out of the file
 * directly and FAILS CLOSED: a blank whose structure we cannot read at all is a
 * blank we refuse to ship, because "could not check" and "checked and fine" must
 * never look the same.
 */
function assertOwnersBytes(bytes, where) {
  const raw = bytes.toString('latin1');
  if (!raw.startsWith('%PDF-')) throw new Error(`vor/pdf: ${where} is not a PDF`);

  /* A PDF 1.5 or later writer (Acrobat, and pdf-lib's own save) packs the page tree
     into COMPRESSED OBJECT STREAMS, where `/Count` and `/MediaBox` are not visible in
     the file's bytes at all. Inflating every Flate stream first is what lets this
     check read a modern blank as well as the 1.4 one we hold today — without it a
     perfectly good replacement form would be refused at boot for the wrong reason. */
  const src = raw + '\n' + inflatedStreams(raw).join('\n');

  const counts = src.match(/\/Count\s+(\d+)/g) || [];
  const pages = counts.length ? Math.max(...counts.map((c) => Number(c.replace(/\D+/g, '')))) : null;
  if (pages !== 1) {
    throw new Error(`vor/pdf: ${where} declares ${pages == null ? 'no readable' : pages} page(s); the blank VOR is exactly one page and every coordinate in fields.js is measured on it`);
  }

  const boxes = src.match(/\/MediaBox\s*\[([^\]]*)\]/g) || [];
  if (!boxes.length) throw new Error(`vor/pdf: ${where} declares no MediaBox, so its page size cannot be checked`);
  for (const box of boxes) {
    const n = box.replace(/[^\d.\-\s]/g, '').trim().split(/\s+/).map(Number);
    if (n.length !== 4 || !n.every(Number.isFinite)) throw new Error(`vor/pdf: ${where} has an unreadable MediaBox`);
    const w = Math.abs(n[2] - n[0]);
    const h = Math.abs(n[3] - n[1]);
    if (Math.abs(w - F.PAGE.w) > EPSILON || Math.abs(h - F.PAGE.h) > EPSILON) {
      throw new Error(`vor/pdf: ${where} is ${w}x${h}pt; the blank VOR is ${F.PAGE.w}x${F.PAGE.h} and a different page size moves every prefill coordinate onto the form's own lines`);
    }
  }
}

/* READ ONCE, CHECKED ONCE, AT LOAD. Re-reading the file on every preview would put
   a disk read on a screen refresh and — worse — would let somebody swap the blank
   under a running process without anything noticing. */
const BLANK_BYTES = fs.readFileSync(BLANK_PATH);
assertOwnersBytes(BLANK_BYTES, BLANK_PATH);

/**
 * A fresh copy of the owner's document.
 *
 * pdf-lib MUTATES a loaded document as you draw on it, so a document cached across
 * renders would accumulate every previous loan's prefill — the second landlord would
 * receive the first one's tenant. The BYTES are what we cache; the document is
 * parsed again per render, from a copy of the buffer so the cache itself can never
 * be written through.
 */
async function loadBlank() {
  const doc = await PDFDocument.load(new Uint8Array(BLANK_BYTES));
  assertOwnersPage(doc, BLANK_PATH);
  return doc;
}

/**
 * Build the PDF: the owner's page, with our answers to items 1 through 9 written
 * into its blanks and one invisible anchor in each of the landlord's.
 *
 * @param {object} data   the form's own data — OUR half filled in, the landlord's absent
 * @returns {Promise<Buffer>}
 */
async function buildVorPdf(data = {}) {
  const doc = await loadBlank();
  const page = doc.getPage(0);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  // ── items 1 to 9: our half, above the bar ────────────────────────────────
  for (const f of F.ourFields()) {
    const value = fmtValue(f, data[f.key]);
    /* A VALUE WE DO NOT HOLD PRINTS NOTHING. The version this replaces printed an
       em dash as a stand-in; on a government-style form a dash sitting in a ruled
       blank reads as an ANSWER — "no landlord", "no rent" — rather than as an
       omission. The owner's blank is left visibly blank instead, which is the one
       thing every reader of this form already knows how to interpret. */
    if (!value) continue;

    const size = f.size || 9;
    const width = f.width || 200;
    const maxLines = f.lines || 1;
    const lineHeight = f.lineHeight || size + 2;
    /* Stop at the band. The form's next printed label sits just past it, and text
       running into it is the "across its lines" defect the map warns about. */
    const lines = wrapBlock(value, font, size, width).slice(0, maxLines);
    lines.forEach((line, i) => {
      page.drawText(line, { x: f.x, y: f.y - (i * lineHeight), size, font, color: INK });
    });
  }

  // ── Parts II and III: nothing of ours but the anchors ────────────────────
  /* Drawn WHITE at 4pt: a human sees an empty ruled blank, DocuSign finds the
     string and hangs its REQUIRED box there. The strings come from fields.js and
     are never spelled in this file. */
  for (const p of F.anchorPlacements()) {
    page.drawText(p.anchor, { x: p.x, y: p.y, size: ANCHOR_SIZE, font, color: WHITE });
  }

  doc.setTitle('Request for Verification of Rent');
  doc.setProducer('PILOT by YS Capital');

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

module.exports = {
  buildVorPdf,
  BLANK_PATH,
  _internals: {
    pdfSafe, wrap, wrapBlock, fmtValue, inflatedStreams,
    assertOwnersBytes, assertOwnersPage, loadBlank, PAGE: F.PAGE,
  },
};
