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
const crypto = require('crypto');
const path = require('path');
const zlib = require('zlib');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const F = require('./fields');

/** The owner's blank. */
const BLANK_PATH = path.join(__dirname, '..', 'assets', 'blank-vor.pdf');

/* ── THE SIGNATURE FACE ─────────────────────────────────────────────────────
   Owner-directed 2026-09-02: *"the place for the signature of the lender,
   you're typing the name of the user. We need it to be in a more scribbled
   font so it should look like the signature of the user."*

   Great Vibes (SIL Open Font License 1.1 — the licence text is vendored beside
   it as GreatVibes-OFL.txt, which the OFL requires of any copy). pdf-lib on its
   own can embed only the fourteen PDF standard faces, none of them a script,
   so the file is embedded through @pdf-lib/fontkit.

   WHOLE, NOT SUBSET — MEASURED, NOT PREFERRED. The first cut asked pdf-lib to
   subset the face to the glyphs drawn. Text EXTRACTION of that form still
   found "Chaya Gruber" (the ToUnicode map was fine), so every text-based test
   passed — and a real render in Chromium's pdf.js drew NOTHING in the
   signature box. The typed fields beside it were there; the signature was
   blank. With the full file embedded the same render shows the signature.
   The cost is the whole face on every form (about 170 KB more per PDF; the
   form goes to DocuSign as base64 and that is well inside its limits), and
   the test below proves the WHOLE file is in the PDF, byte for byte, because
   that is the difference between a signature and an empty box.

   PINNED BY DIGEST, exactly like the blank: the font decides where every
   flourish lands, and `fields.js` reasons about that geometry in numbers
   measured off THIS file. A different file would silently move the ink, so a
   replacement has to be a deliberate act — edit the digest in the same commit.
   The font's own vertical extents are read from the file at load
   (`SIGNATURE_METRICS`) rather than typed here, so the test that proves the
   signature clears the printed labels measures the real face. */
const SIGNATURE_FONT_PATH = path.join(__dirname, '..', 'assets', 'GreatVibes-Regular.ttf');
const SIGNATURE_FONT_SHA256 = '9d76b8c67f5289c310114c935c5c3831fc3c25bc2bb888a28210c1659d701b9e';
const SIGNATURE_FONT_BYTES = (() => {
  const bytes = fs.readFileSync(SIGNATURE_FONT_PATH);
  const got = crypto.createHash('sha256').update(bytes).digest('hex');
  if (got !== SIGNATURE_FONT_SHA256) {
    throw new Error(`vor/pdf: the signature font at ${SIGNATURE_FONT_PATH} is not the pinned file `
      + `(sha256 ${got.slice(0, 12)}…, expected ${SIGNATURE_FONT_SHA256.slice(0, 12)}…). `
      + 'Replacing it moves every signature; update the digest in the same commit if that is intended.');
  }
  return bytes;
})();
/** ascent / descent as a fraction of the em, read from the face itself. */
const SIGNATURE_METRICS = (() => {
  const face = fontkit.create(SIGNATURE_FONT_BYTES);
  return Object.freeze({
    family: face.familyName,
    ascent: face.ascent / face.unitsPerEm,
    descent: Math.abs(face.descent) / face.unitsPerEm,
  });
})();

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
 * THE SIGNATURE'S SIZE — one line, shrunk to its box, never wrapped.
 *
 * Starts at the field's own size and comes down, a half-point at a time, until
 * the name fits the field's width; stops at `minSize`. A name that does not fit
 * even there is drawn at the floor anyway (a clipped signature is still that
 * person's signature) and REPORTED — `fits:false` is what `measureOverflow`
 * turns into the preview's warning. Measured in the face that will draw it.
 */
function fitSignature(field, value, font) {
  const text = pdfSafe(value).replace(/\s+/g, ' ').trim();
  const width = field.width || 200;
  const max = field.size || F.DEFAULT_SIZE;
  const min = field.minSize || max;
  let size = max;
  while (size > min && font.widthOfTextAtSize(text, size) > width) size = Math.round((size - 0.5) * 2) / 2;
  const drawn = font.widthOfTextAtSize(text, size);
  return { text, size, width: drawn, fits: drawn <= width };
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
/* THE DIGEST OF THE OWNER'S OWN FILE, pinned.
   sha256 of src/longterm/assets/blank-vor.pdf as the owner supplied it. Structure
   checks alone are not enough and the proof is sitting in the same directory:
   `vor-field-ids-reference.pdf` — the sheet with Encompass field ids printed IN THE
   BLANKS — is also one page at 612x792 and passes every structural test. Rendered
   through this module it puts "RentedFrom | RentedTo | AmountOfRent | Period |
   PaymentsPastDue30 | AdditionalInformation" into Part II and mails it to a
   landlord: literally "pre-filled on the field ID call", the one thing the owner
   said to leave empty. An empty page, a PILOT-branded lookalike and a page rotated
   90 degrees passed too.
   A digest answers "is this THAT form", which is the question actually being asked.
   Replacing the blank is then a deliberate two-line edit — file and digest together
   — rather than a drop-in nobody notices. */
const BLANK_SHA256 = '7ad11bbea4af56e7aae8e965f12424b3fbafcc72b71b6a2f4a70d77522c3fd85';

function assertOwnersDigest(bytes, where) {
  const got = crypto.createHash('sha256').update(bytes).digest('hex');
  if (got !== BLANK_SHA256) {
    throw new Error(`vor/pdf: ${where} is not the owner's blank VOR (sha256 ${got}, expected ${BLANK_SHA256}). `
      + 'Structure alone cannot tell this form from the field-id reference sheet beside it, which would print '
      + "Encompass ids into Part II. If the blank was replaced on purpose, update BLANK_SHA256 in the same commit.");
  }
}

const BLANK_BYTES = fs.readFileSync(BLANK_PATH);
assertOwnersDigest(BLANK_BYTES, BLANK_PATH);
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
async function buildVorPdf(data = {}, opts = {}) {
  const doc = await loadBlank();
  const page = doc.getPage(0);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // The script face is embedded LAZILY — only when a field asks for it — so a
  // form with no signatory (a preview before anybody is on the file) carries no
  // subset of a font it never drew.
  let scriptFont = null;
  const signatureFont = async () => {
    if (!scriptFont) {
      doc.registerFontkit(fontkit);
      // WHOLE FILE — see the header: a subset of this face extracts as text
      // and renders as nothing.
      scriptFont = await doc.embedFont(SIGNATURE_FONT_BYTES, { subset: false });
    }
    return scriptFont;
  };

  // ── items 1 to 9: our half, above the bar ────────────────────────────────
  /* THE LANDLORD'S OWN FIELDS, WHERE WE ALREADY HOLD THE ANSWER.
     Today that is the phone number and only the phone number (owner-directed
     2026-08-31: *"The phone number should automatically populate the bottom,
     also where it asks for the Landlord phone number."*). It is drawn exactly
     like our own text so the paper copy and the DocuSign copy read the same —
     a landlord who gets both must not see two different forms — and it is a
     SUGGESTION: they cross it out and write another number if ours is wrong,
     which on paper is what everybody already does.

     Nothing else in Part II or Part III is ever drawn here. `landlordDefaults`
     is a small explicit map, not the landlord's half of the form, so a future
     key can only appear because somebody put it there. */
  const llDefaults = (opts && opts.landlordDefaults) || {};
  for (const f of F.landlordFields()) {
    const value = fmtValue(f, llDefaults[f.key]);
    if (!value) continue;
    const size = f.size || F.DEFAULT_SIZE;
    page.drawText(value.slice(0, 60), {
      x: f.x, y: f.y, size, font, color: rgb(0, 0, 0),
    });
  }

  for (const f of F.ourFields()) {
    const value = fmtValue(f, data[f.key]);
    /* A VALUE WE DO NOT HOLD PRINTS NOTHING. The version this replaces printed an
       em dash as a stand-in; on a government-style form a dash sitting in a ruled
       blank reads as an ANSWER — "no landlord", "no rent" — rather than as an
       omission. The owner's blank is left visibly blank instead, which is the one
       thing every reader of this form already knows how to interpret. */
    if (!value) continue;

    /* THE SIGNATURE: one line, in the script face, shrunk to fit its box
       rather than wrapped — a signature that breaks onto a second line is not
       a signature. `fitSignature` is the ONE place the size is decided, read
       here and by `measureOverflow`, so the preview's warning and the drawn
       form can never disagree about whether a name fits. */
    if (f.font === 'signature') {
      const sf = await signatureFont();
      const fit = fitSignature(f, value, sf);
      page.drawText(fit.text, { x: f.x, y: f.y, size: fit.size, font: sf, color: INK });
      continue;
    }

    const size = f.size || F.DEFAULT_SIZE;
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

/**
 * WHAT WOULD NOT FIT ON THE PAPER.
 *
 * Each block on the owner's blank is a box of a fixed height — `lines: 4` on item
 * 1 is the box, not a preference — so the draw loop above stops at it. That cut
 * is SILENT on the page: the landlord receives a form whose last line is simply
 * absent, and the likeliest line to lose is the one at the bottom of a landlord
 * block, which is their email and phone.
 *
 * A silent cap is the one thing this codebase refuses, so the desk asks this
 * BEFORE anybody confirms and says which block is over and by how much. It
 * measures with the SAME wrap and the SAME font the render uses, so the answer is
 * about the real document rather than a guess from a character count.
 *
 * NEVER THROWS: a measurement that fails costs the warning, never the screen.
 */
async function measureOverflow(data) {
  try {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    let scriptFont = null;
    const out = [];
    for (const f of F.ourFields()) {
      const value = fmtValue(f, (data || {})[f.key]);
      if (!value) continue;
      if (f.font === 'signature') {
        // The same decision the renderer makes, in the same face.
        if (!scriptFont) {
          doc.registerFontkit(fontkit);
          scriptFont = await doc.embedFont(SIGNATURE_FONT_BYTES, { subset: false });
        }
        const fit = fitSignature(f, value, scriptFont);
        if (!fit.fits) {
          out.push({ key: f.key, label: f.label, printed: 1, total: 2,
            why: `too long for the signature line even at its smallest size (${fit.size}pt) — it will run past the box` });
        }
        continue;
      }
      const maxLines = f.lines || 1;
      const total = wrapBlock(value, font, f.size || F.DEFAULT_SIZE, f.width || 200).length;
      if (total > maxLines) out.push({ key: f.key, label: f.label, printed: maxLines, total });
    }
    return out;
  } catch (_) {
    return [];
  }
}

module.exports = {
  buildVorPdf,
  measureOverflow,
  BLANK_PATH,
  SIGNATURE_METRICS,
  _internals: {
    pdfSafe, wrap, wrapBlock, fmtValue, inflatedStreams, fitSignature,
    assertOwnersBytes, assertOwnersPage, assertOwnersDigest, BLANK_SHA256, loadBlank, PAGE: F.PAGE,
    SIGNATURE_FONT_PATH, SIGNATURE_FONT_SHA256,
  },
};
