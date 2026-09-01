'use strict';
/**
 * LONG-TERM TERM SHEETS — THE RENDERER, IN THE PILOT DESIGN.
 *
 * `layout.js` decides WHAT is on the page; this decides how it is drawn. It
 * walks the block list, MEASURES every line against the real font metrics, and
 * FLOWS it — breaking a page the moment the next line would not fit.
 *
 * ⛔ IT IS THE PILOT SHEET, NOT A PLAIN ONE. Owner-directed 2026-08-30, after
 * reading a rendered sample: *"Everything should be in our pilot branding the
 * same way our RTL term sheet is … Look at the design we have on the RTL. Try
 * to bring in that nice pilot design … Make sure to include our logos and our
 * designs."* The furniture — the full-bleed ink band with the lockup, the gold
 * rule under it, the teal section bands with their gold tabs, the ivory accent
 * rows, the three-line footer — is read off `brand.js`, which took it off the
 * RTL sheet. What crosses is the DESIGN; not a line of RTL logic.
 *
 * ⛔ THE BAND AND THE FOOTER ARE PAGE FURNITURE, NOT FLOWED BLOCKS, and that is
 * what makes "every page is branded" structural. They are drawn over the whole
 * page list AFTER the flow, so a page added by a break in the middle of a table
 * cannot come out bare, and neither can one added a year from now by a block
 * type nobody has written yet. Content lives strictly between them.
 *
 * ⛔ NO PAGE MAY DRAW PAST ITS OWN MARGIN. Every fit test is made before the
 * ink, a word too long for its column is HARD-BROKEN rather than allowed to run
 * off the sheet, and the footer band lives BELOW the bottom limit so flowing
 * content can never reach it. The RTL side learned this the expensive way — a
 * page that grew silently drew its rows through the footnote and off the paper,
 * on a document that had already gone out for signature.
 *
 * ⛔ pdf-lib, NEVER jsPDF. `scripts/test-one-term-sheet.js` flags any module in
 * `src/` that both drives jsPDF and carries a "Term Sheet" string, because the
 * RTL studio's six-pager is the ONE term sheet on that side and a second
 * renderer there is how a short version quietly replaced it. Long-Term is its
 * own product with its own document, and using pdf-lib keeps this module
 * outside that predicate by construction rather than by an exemption.
 *
 * ⛔ EVERY STRING GOES THROUGH ONE CHOKEPOINT, `text()`, AND IT DOES TWO THINGS
 * NOTHING ELSE CAN.
 *   (1) RULE 10, the second defence. `snapshot.js` is a WHITELIST, so an
 *       investor key cannot reach the document through a named field. What a
 *       whitelist cannot see is an investor's name a human TYPED into a label,
 *       a program name or an address — so every drawn string is run through
 *       `audience.scrubInvestorNames`, the ONE definition (never a second copy:
 *       two copies drift and the one that drifts is the one that leaks).
 *   (2) THE ENCODING. pdf-lib's StandardFonts are WinAnsi and `drawText`
 *       THROWS on a character they cannot encode — an accented name is fine,
 *       an em dash is fine, but a CJK character, an emoji or a "≥" pasted out
 *       of a spreadsheet raises and the WHOLE term sheet fails to render. A
 *       document that will not render is worse than one with a substituted
 *       glyph, so unencodable characters are mapped or dropped here, once.
 *
 * pdf-lib, the LT audience module and `brand.js` (whose ONE filesystem read is
 * the lockup, cached and never-throwing). No database, no network. Returns the
 * bytes; the caller decides what to do with them.
 */

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const audience = require('../audience');
const brand = require('./brand');

const col = (t) => rgb(t[0] / 255, t[1] / 255, t[2] / 255);

// ── the paper ───────────────────────────────────────────────────────────────
const PAGE = { w: 612, h: 792 };                 // US Letter, portrait
// MEASURED OFF THE SKETCH: every rule on it runs 45 → 567, so the content
// column is 522 wide and not 504. A margin is not a taste; it is the width every
// other measurement below was taken against.
const M = { left: 45, right: 45, bottom: 58 };
const CONTENT_W = PAGE.w - M.left - M.right;     // 504
// Content starts UNDER the brand band, on every page — `brand.BAND.contentTop`
// is the RTL sheet's own `y = 92`, measured down from the top of the paper.
const TOP_Y = PAGE.h - brand.BAND.contentTop;    // 700
const BOTTOM_Y = M.bottom;                       // 58 — NOTHING flows below this
const USABLE_H = TOP_Y - BOTTOM_Y;               // 642
const RIGHT_X = PAGE.w - M.right;
// Text stops a hair short of the rules. The measurement below is exact, so this
// is not slack for error — it is the optical gutter that keeps a right-aligned
// figure from touching the hairline it sits against.
const GUTTER = 2;
const TEXT_RIGHT = RIGHT_X - GUTTER;
const TEXT_W = CONTENT_W - GUTTER;

/**
 * ⛔ A BLOCK IS DRAWN INTO A BOX, AND THE FULL CONTENT COLUMN IS JUST THE
 * DEFAULT ONE.
 *
 * The approved design puts two groups SIDE BY SIDE on page one — the loan and
 * its monthly payment, then what the rate costs beside what lands at the table
 * — which is how the whole story is seen in one view instead of over three
 * sheets. Every compiler used to read `M.left` / `CONTENT_W` / `RIGHT_X`
 * straight out of module scope, so a narrower column was not expressible at all.
 *
 * ⛔ AND THE ANSWER IS A PARAMETER, NEVER A SECOND SET OF DRAWING CODE. A
 * column-shaped copy of `compileFigures` would be a second definition of what a
 * labelled row looks like, and the one that drifts is the one a reader is
 * looking at. So the geometry is passed in and the SAME compilers draw both.
 * Omit it and every call is byte-identical to what it was.
 */
function boxOf(box) {
  const x = box && Number.isFinite(box.x) ? box.x : M.left;
  const w = box && Number.isFinite(box.w) ? box.w : CONTENT_W;
  return { x, w, right: x + w, textRight: x + w - GUTTER, textW: w - GUTTER };
}

// ── the ink ─────────────────────────────────────────────────────────────────
// Every one of them is DARK on white, or LIGHT on the dark band. The V2 tokens
// named `--ink*` are LIGHT paper colours and would render white on white; these
// come from `brand.js`, which read them off the RTL sheet's own constants.
const INK = col(brand.RGB.INK);
const TEAL = col(brand.RGB.TEAL);
const GOLD = col(brand.RGB.GOLD);
const MUTED = col(brand.RGB.GRAY);
const HAIR = col(brand.RGB.LINE);
const IVORY = col(brand.RGB.IVORY);
const SOFT = col(brand.RGB.SOFT);
const ONBAND = col(brand.RGB.ONBAND);
const PAPER = col(brand.RGB.PAPER);
const FAINT = col(brand.RGB.FAINT);

// ── the type ────────────────────────────────────────────────────────────────
/**
 * ⛔ EVERY SIZE HERE IS READ OFF THE APPROVED DESIGN, NOT CHOSEN.
 *
 * The owner's report, holding a real export beside the sketch they had signed
 * off: *"The redesign is way far off from the sketch that you presented. Your
 * sketch was much nicer."* MEASURED rather than guessed at — the sketch is
 * `docs/longterm/design/quiet-ledger-v2.pdf`, an 8.5×11in HTML page printed at
 * the browser's 0.75 CSS-px→point scale, so each of its CSS sizes is 0.75× in
 * points. Against that, this sheet's body type was **30–50% larger**: its table
 * rows 8.4pt against 6.7, its labels 9.5 against 6.5, its headline figures 19
 * against 11.6. That is the whole of *"everything is way too big"*, and it is
 * arithmetic rather than taste.
 *
 * So every size below is `<the sketch's own point size> × 1.10`, rounded to a
 * tenth. **The 1.10 is a deliberate, stated departure**: the sketch's 6.4pt
 * body is at the small end of comfortable for a document a borrower reads on
 * paper and signs, so it is set a shade above rather than matched exactly. It
 * is one number and it is here — move it and the whole page moves together,
 * which is the point of deriving a scale instead of picking sizes one at a time.
 *
 * ⛔ AND THE PROPORTIONS ARE THE DESIGN, NOT THE ABSOLUTES. Quiet Ledger's
 * third rule is *"hierarchy is built from three weights and no more — one
 * figure per view may be large, two or three may be medium, everything else is
 * small"*. The headline band is the large one; a resolving total is medium
 * (`big`, at 1.29× the ordinary value, where it used to be 1.5×); everything
 * else sits at one small size. Enlarging any one of these is almost always the
 * wrong move — the design's own instruction is to quieten its neighbours.
 */
const SZ = {
  // the brand band: the document's name, its programme line, its identity line
  bandTitle: 15, bandSub: 6.45, bandId: 5.4,
  // a section's own label, and the label/value pair of an ordinary row
  section: 5.7, label: 6.38, value: 6.29, big: 7.8, bigLabel: 6.38,
  eyebrow: 5.18, name: 9.3,
  para: 6.38, small: 5.1, hero: 11.62,
  /* THE TABLE, read off the approved sketch's own drawing operators: a label in
     the sans at 6.52, its figures in the mono at 6.67, and a row that RESOLVES
     the arithmetic at 7.58 in the bold cut — 1.14×, not 1.5×, because the
     design's own rule is that a resolving total is medium and everything around
     it is small. A column is headed by a tracked 4.95 eyebrow over a 7.35 name. */
  tableLabel: 6.52, tableValue: 6.67, tableBig: 7.58, tableSub: 5.55,
  colEyebrow: 4.95, colTitle: 7.35, groupHead: 5.02,
  // the shared-facts grid: a tracked label over a monospaced figure
  gridLabel: 5.02, gridValue: 6.75, gridHead: 5.1, gridNote: 5.18,
  discHead: 5.7, discBody: 5.7,
  footContact: 5.4, footDisc: 5.1, footId: 5.1,
  // the party block under the band, which the sketch sets in its own three sizes
  partyName: 9.3, partySub: 5.77, address: 6.83, byName: 6.45, byLine: 5.93,
  // a stat card: its tracked label, its figure, its caption
  statLabel: 4.95, statFigure: 11.62, statCaption: 5.1,
};
const LEAD = 1.32;   // line height as a multiple of the size
/* MEASURED OFF THE SKETCH: "PREPARED FOR" draws 47.9 wide at 5.18, and the same
   string set solid in Helvetica-Bold is 38.4 — so 0.86 of tracking per gap.
   Guessing this is how an eyebrow ends up reading as spaced-out capitals
   ("C A S H  T O  C L O S E") rather than as small caps. */
const EYEBROW_TRACK = 0.86;
/**
 * THE RHYTHM, and it is the design's signature: *"wide, tight, tight, tight,
 * wide"*. Rows inside a group sit close, ruled by a hairline so fine it reads
 * as a change of tone; groups are set apart by real air. Both halves are here
 * so the two can never be tuned against each other by accident.
 */
const RHYTHM = {
  /* MEASURED OFF THE SKETCH. Its row hairlines land at 274.5, 289.5, 304.5,
     319.5, 334.5, 349.5 — a pitch of exactly 15.0 — and a row's own type is
     6.38 at LEAD 1.32, which is 8.42. So an ordinary row's padding is 6.58, and
     that is the number below rather than a round one somebody liked. The
     resolving row is 20.3 tall on a 7.8 figure (10.3 of type), so 10.0. */
  rowPad: 6.58,     // inside an ordinary row
  rowPadTight: 4,   // inside a row in a tight list
  rowPadBig: 10,    // under a resolving total
  sectionAbove: 20, // the air BEFORE a section header — the "wide"
  sectionBelow: 7,  // and the little that follows it, so it binds to its rows
};
/**
 * THE TABLE'S GEOMETRY, MEASURED OFF THE APPROVED SKETCH rather than chosen.
 *
 * Every figure here was read off the sketch's own drawing operators (its rules,
 * its fills and the bounding box of every span), not estimated from a picture:
 * its label column is 123.75 of a 522-wide content column, its three data
 * columns 132.75 each, its ordinary row 21.0 tall, its resolving row 23.25 with
 * an ivory band the full width of the content column, and its values inset 8
 * from their own column's left edge.
 *
 * ⛔ THE LABEL COLUMN HAS A FLOOR AND A CAP, AND THE FLOOR IS THE SKETCH'S OWN
 * PROPORTION. Sized purely to the widest label it would collapse to nothing on
 * a table of short ones and the columns would drift off the sketch's rhythm;
 * sized purely by proportion a long label wraps to two lines for no reason. So
 * it takes whichever is larger and is capped at a third of the page, past which
 * a label that grows has made the table worse rather than better.
 */
const TBL = {
  labelShare: 0.237,   // 123.75 ÷ 522
  labelCap: 0.34,
  padX: 8,             // a figure's inset inside its own column
  accentInset: 3.75,   // a resolving row's label, off the ivory band's edge
  contentTop: 6.1,     // a row's top edge → the top of its type
  rowPad: 12.4,        // an ordinary row, around its type
  accentPad: 13.2,     // a resolving row
  headTop: 1.2,        // the section rule → the column eyebrow
  headEyebrowStep: 8.17,
  headTitleStep: 9.0,
  headBottom: 5.0,
  tagGap: 5,           // the eyebrow → its "THE ANCHOR" tag
  groupTop: 10.5,      // the air above a group heading
  groupBottom: 2.4,
  tickW: 1.5, tickH: 5.25, tickGap: 5.6,
  rule: 0.75,          // the ink rule that opens and closes the table
  hair: 0.75,          // between two rows of one group
};

/**
 * THE SHARED-FACTS GRID, measured the same way. The sketch draws it as a
 * bordered ivory box with a gold tick down its left edge, a tracked heading over
 * a hairline, then four cells across per band — each a tracked label over a
 * monospaced figure — and a note in italics inside the box at the foot.
 */
const GRID = {
  cols: 4,
  tickW: 1.5,
  padX: 9,             // a cell's own inset
  // A CELL THAT EXPLAINS ITSELF. A note under a value is optional and costs the
  // band nothing on the cells that carry none; where one IS carried the band
  // grows by what it needs, because there is no spare room under the value.
  cellNoteTop: 11,     // value baseline down to the note's first baseline
  cellNotePad: 2.2,    // and the breathing room under the last note line
  noteMin: 4.15,       // how small a note may shrink before it is allowed to wrap
  headH: 21,           // the heading band, down to its hairline
  headTop: 8.55,
  bandH: 26.4,         // one band of cells
  labelTop: 4.3,
  valueTop: 12.58,
  noteTop: 6.23,       // the last band → the footnote
  noteBottom: 14,
  rule: 0.75,
  /* THE AIR ABOVE IT is deliberately less than a section heading's. The box is
     its own frame — it does not need the "wide" of the rhythm to be seen as
     separate, and at the full `sectionAbove` it left a measured 67pt hole under
     the headline band that read as a page that had lost something. */
  above: 10,
};

/**
 * WinAnsi cannot carry these, and each one has an honest plain-text reading.
 * Mapped rather than dropped, because dropping a "≥" changes what a sentence
 * says.
 */
const GLYPH_MAP = new Map(Object.entries({
  '≥': '>=', '≤': '<=', '≠': '!=', '≈': '~',
  '→': '->', '←': '<-', '⇒': '=>',
  '✓': 'v', '✔': 'v', '✗': 'x', '✘': 'x',
  '•': '·', '●': '·', '○': 'o', '▪': '·',
  ' ': ' ', ' ': ' ', ' ': ' ', '​': '',
  '‑': '-', '‒': '-', '―': '—',
  '²': '2', '³': '3', '½': '1/2', '¼': '1/4',
  '€': 'EUR', '″': '"', '′': "'",
}));

/**
 * Is this character drawable by the standard font?
 *
 * PROBED, NOT ASSERTED — the encodable set is a property of pdf-lib's own
 * embedder, so it is asked rather than restated from a table that would rot
 * the day the library changes. Cached per font, so a document pays for each
 * distinct character once.
 */
function encodable(font, cache, ch) {
  if (cache.has(ch)) return cache.get(ch);
  let ok = true;
  try { font.widthOfTextAtSize(ch, 10); } catch { ok = false; }
  cache.set(ch, ok);
  return ok;
}

/**
 * THE ONE CHOKEPOINT. Scrub, then map, then drop what is left.
 *
 * NEVER THROWS. A term sheet that fails to render is a term sheet that did not
 * go out, and the caller has already told an officer it was issued.
 */
function makeText(font, caches) {
  const scrubbed = caches.scrub;
  const enc = caches.enc;
  return function text(raw) {
    if (raw === null || raw === undefined) return '';
    const s0 = String(raw);
    let s = scrubbed.get(s0);
    if (s === undefined) {
      s = audience.scrubInvestorNames(s0, audience.AUDIENCES.BORROWER);
      scrubbed.set(s0, s);
    }
    let out = '';
    for (const ch of s) {
      const mapped = GLYPH_MAP.has(ch) ? GLYPH_MAP.get(ch) : ch;
      for (const c of mapped) {
        if (c === '\n' || c === '\t') { out += ' '; continue; }
        if (encodable(font, enc, c)) out += c;
      }
    }
    return out.replace(/\s+/g, ' ').trim();
  };
}

/**
 * ⛔ MEASURE THE WAY THE PAGE IS ACTUALLY DRAWN — pdf-lib's own
 * `widthOfTextAtSize` DOES NOT, and the difference is what runs text off a page.
 *
 * MEASURED, not suspected: for `"218 Forest Avenue, Lakewood, NJ 08701"` at 10pt,
 * Adobe's published Helvetica AFM advances sum to **183.990**, pdf.js reports
 * **183.990**, and pdf-lib answers **182.290**. The 1.7pt gap is KERNING —
 * pdf-lib's measurement applies the font's kern pairs ("Av" −40, "o," −40, "ew"
 * −20 units) while its `drawText` emits a plain show-text operator carrying no
 * kern adjustments at all, so a viewer advances by the raw glyph widths. The
 * measurement is therefore ~1% NARROWER than the ink, which is the dangerous
 * direction: every wrap decision comes out optimistic and the last word of a
 * long line lands past the margin. It shipped three overshoots into the first
 * render of this file and was invisible until the geometry was read back.
 *
 * So width is the SUM OF PER-CHARACTER ADVANCES — a single character has no
 * pair to kern, so each one is measured un-kerned and the total is exactly what
 * the viewer will advance. Cached per character, which also makes it cheaper
 * than measuring whole strings repeatedly.
 *
 * NEVER call `font.widthOfTextAtSize` on a multi-character string in this file.
 */
function charW(font, cache, ch) {
  let w = cache.get(ch);
  if (w === undefined) {
    try { w = font.widthOfTextAtSize(ch, 1000); } catch { w = 500; }
    cache.set(ch, w);
  }
  return w;
}

/** The advance a viewer will actually use, in points. */
function advance(ctx, s, font, size) {
  const cache = ctx.widths.get(font) || (ctx.widths.set(font, new Map()), ctx.widths.get(font));
  let u = 0;
  for (const ch of String(s || '')) u += charW(font, cache, ch);
  return (u * size) / 1000;
}

/** Break a token that is wider than its column, so it can never run off. */
function hardBreak(ctx, word, font, size, maxW) {
  const out = [];
  let cur = '';
  for (const ch of word) {
    const t = cur + ch;
    if (cur && advance(ctx, t, font, size) > maxW) { out.push(cur); cur = ch; } else { cur = t; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

/** Wrap to a measured width. Always returns at least one line. */
function wrap(ctx, s, font, size, maxW) {
  const words = String(s || '').split(' ').filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (!cur || advance(ctx, t, font, size) <= maxW) { cur = t; continue; }
    lines.push(cur);
    cur = w;
  }
  if (cur) lines.push(cur);
  const out = [];
  for (const l of lines) {
    if (advance(ctx, l, font, size) <= maxW) out.push(l);
    else out.push(...hardBreak(ctx, l, font, size, maxW));
  }
  return out;
}

/**
 * Wrap where the FIRST line is narrower than the rest — a paragraph that starts
 * beside a bold opening clause. Shares `wrap`'s hard-break guarantee, so a word
 * too long for either width still cannot run off the column.
 */
function wrapAfter(ctx, s, font, size, firstW, restW) {
  const words = String(s || '').split(' ').filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let cur = '';
  const widthFor = () => (lines.length === 0 ? firstW : restW);
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (!cur && advance(ctx, w, font, size) > widthFor()) {
      // Nothing fits on this line at all — start the next one rather than
      // hard-breaking a word into a two-character stub beside the title.
      if (lines.length === 0 && firstW < restW) { lines.push(''); cur = w; continue; }
    }
    if (!cur || advance(ctx, t, font, size) <= widthFor()) { cur = t; continue; }
    lines.push(cur);
    cur = w;
  }
  if (cur) lines.push(cur);
  const out = [];
  lines.forEach((l, i) => {
    const w = i === 0 ? firstW : restW;
    if (advance(ctx, l, font, size) <= w || !(w > 0)) out.push(l);
    else out.push(...hardBreak(ctx, l, font, size, restW));
  });
  return out;
}

/** One line, clipped rather than wrapped — for a cell that must stay one line. */
function clip(ctx, s, font, size, maxW) {
  const str = String(s || '');
  if (!str) return '';
  if (!(maxW > 0)) return '';
  if (advance(ctx, str, font, size) <= maxW) return str;
  const ell = '…';
  let cur = '';
  for (const ch of str) {
    if (advance(ctx, cur + ch + ell, font, size) > maxW) break;
    cur += ch;
  }
  // A bare ellipsis is noise, not a shortened label — it tells the reader
  // nothing and looks like a rendering fault. Nothing fits, so nothing is drawn.
  return cur ? cur + ell : '';
}

// ── drawing primitives ──────────────────────────────────────────────────────
// `y` is always the TOP of the line box; text sits on a baseline inset from it.

function line(ctx, y, x1, x2, color, thickness) {
  ctx.page.drawLine({
    start: { x: x1, y }, end: { x: x2, y },
    thickness: thickness || 0.6, color: color || HAIR,
  });
}

/** A vertical hairline — the divider between the headline band's cells. */
function vline(ctx, x, yTop, h, color) {
  if (!(h > 0)) return;
  ctx.page.drawLine({
    start: { x, y: yTop }, end: { x, y: yTop - h },
    thickness: 0.5, color: color || HAIR,
  });
}

function rect(ctx, x, yTop, w, h, color) {
  if (!(w > 0) || !(h > 0)) return;
  ctx.page.drawRectangle({ x, y: yTop - h, width: w, height: h, color });
}

function put(ctx, s, x, yTop, font, size, color, maxW) {
  const t = clip(ctx, ctx.text(s), font, size, maxW == null ? TEXT_RIGHT - x : maxW);
  if (!t) return 0;
  ctx.page.drawText(t, { x, y: yTop - size, size, font, color: color || INK });
  return advance(ctx, t, font, size);
}

function putRight(ctx, s, xRight, yTop, font, size, color, maxW) {
  const t = clip(ctx, ctx.text(s), font, size, maxW == null ? xRight - M.left : maxW);
  if (!t) return 0;
  const w = advance(ctx, t, font, size);
  ctx.page.drawText(t, { x: xRight - w, y: yTop - size, size, font, color: color || INK });
  return w;
}

/**
 * One line with LETTER-SPACING, the way the RTL band titles are set.
 *
 * pdf-lib has no `charSpace`, so each character is placed at its own measured
 * advance. That is also the only way to get it right: a single `drawText` with
 * a tracked string would need the viewer to apply the tracking, which it will
 * not, so the box would be measured wider than the ink and the title would sit
 * off-centre in its band.
 */
/** How wide a tracked line will draw. Measured the same way `putTracked` places
 *  it, character by character, so a right-aligned tracked eyebrow lands exactly
 *  on the margin rather than near it. */
function trackedWidth(ctx, s, font, size, tracking) {
  const t = ctx.text(s);
  if (!t) return 0;
  let w = 0;
  for (const ch of t) w += advance(ctx, ch, font, size) + tracking;
  return Math.max(0, w - tracking);
}

function putTracked(ctx, s, x, yTop, font, size, color, tracking, maxW) {
  const t = ctx.text(s);
  if (!t) return 0;
  let w = 0;
  for (const ch of t) w += advance(ctx, ch, font, size) + tracking;
  w = Math.max(0, w - tracking);
  if (maxW != null && w > maxW) return put(ctx, t, x, yTop, font, size, color, maxW);
  let cx = x;
  for (const ch of t) {
    ctx.page.drawText(ch, { x: cx, y: yTop - size, size, font, color: color || INK });
    cx += advance(ctx, ch, font, size) + tracking;
  }
  return w;
}

// ── compiling blocks into flowable items ────────────────────────────────────
// An item is one atomic thing to draw: `{h, draw(ctx, yTop), keepNext, head}`.
// `keepNext` binds it to the item after it (a heading must never sit alone at
// the foot of a page); `head` is a table's header row, redrawn when the table
// continues onto a new page.

const item = (h, draw, opts) => ({ h, draw, keepNext: !!(opts && opts.keepNext), head: (opts && opts.head) || null });

/**
 * THE RECIPIENT BLOCK — who this is for and what it is on, on page one.
 *
 * Two columns: the borrower and the property on the left, the officer on the
 * right. The eyebrows are the RTL sheet's small tracked capitals.
 */
function compileRecipient(b, ctx) {
  const F = ctx.fonts;
  const leftW = Math.round(CONTENT_W * 0.58) - 10;
  const rightW = Math.round(CONTENT_W * 0.40);

  // ⛔ `preparedFor` — the ONE reading of the two name fields (layout.js), so the
  //    "prepared for" line and the signature lines can never name different
  //    parties. `partyRole` splits the SAME reading onto its own line, because
  //    that is how the approved sketch sets it: the entity in 9.3 bold, and
  //    "Miriam Rosenberg, guarantor" in 5.77 muted under it. One line carrying
  //    "Entity · Person" is a smaller claim badly made — it says nothing about
  //    which of the two is which, on the document they both sign.
  const name = ctx.text(b.preparedFor || b.borrowerName || '');
  const role = ctx.text(b.preparedForRole || '');
  const addr = ctx.text(b.propertyAddress || '');
  const nameLines = name ? wrap(ctx, name, F.bold, SZ.partyName, leftW) : [];
  const roleLines = role ? wrap(ctx, role, F.reg, SZ.partySub, leftW) : [];
  const addrLines = addr ? wrap(ctx, addr, F.reg, SZ.address, leftW) : [];
  // The property's own facts, under the address they are about — the sketch's
  // own home for them, and now the only one (see `layout.termSheetBody`).
  const facts = ctx.text(b.propertyFacts || '');
  const factLines = facts ? wrap(ctx, facts, F.reg, SZ.partySub, leftW) : [];

  /* ⛔ THE OFFICER BLOCK IS RIGHT-ALIGNED, hard against the same 567 every rule
     and every figure on the page ends at. Set left it reads as a second column
     of body text starting nowhere in particular; set right it closes the line
     the "PREPARED FOR" eyebrow opens, which is what makes the two read as one
     header rather than two lists. */
  const officer = (b.officer || []).map((l) => ctx.text(l)).filter(Boolean);
  const officerLines = [];
  officer.forEach((l, i) => {
    const size = i === 0 ? SZ.byName : SZ.byLine;
    for (const w of wrap(ctx, l, i === 0 ? F.bold : F.reg, size, rightW)) officerLines.push({ t: w, i });
  });

  const leftH = (name ? SZ.eyebrow * LEAD + nameLines.length * SZ.partyName * LEAD
      + roleLines.length * SZ.partySub * LEAD + 4 : 0)
    + (addr ? SZ.eyebrow * LEAD + 3 + addrLines.length * SZ.address * LEAD : 0)
    + (factLines.length ? factLines.length * SZ.partySub * LEAD + 1 : 0);
  const rightH = officerLines.length
    ? SZ.eyebrow * LEAD + officerLines.reduce((n, l) => n + (l.i === 0 ? SZ.byName : SZ.byLine) * LEAD, 0)
    : 0;
  /* ⛔ NO TRAILING AIR OF ITS OWN. MEASURED: the sketch leaves 18.6 between the
     last party line and the top of the stat box, and the stat box already
     declares that as `brand.STATS.above`. Adding a pad here as well put the
     headline figures 13.5pt lower than the design and cost the page the room the
     acceptance needed. Air belongs to ONE of two neighbours, never to both. */
  const h = Math.max(leftH, rightH);

  return [item(h, (c, y) => {
    let ly = y;
    if (name) {
      putTracked(c, 'PREPARED FOR', M.left, ly, F.bold, SZ.eyebrow, GOLD, EYEBROW_TRACK, leftW);
      ly -= SZ.eyebrow * LEAD;
      for (const l of nameLines) { put(c, l, M.left, ly, F.bold, SZ.partyName, INK, leftW); ly -= SZ.partyName * LEAD; }
      for (const l of roleLines) { put(c, l, M.left, ly, F.reg, SZ.partySub, MUTED, leftW); ly -= SZ.partySub * LEAD; }
      ly -= 4;
    }
    if (addr) {
      putTracked(c, 'PROPERTY', M.left, ly, F.bold, SZ.eyebrow, GOLD, EYEBROW_TRACK, leftW);
      ly -= SZ.eyebrow * LEAD;
      for (const l of addrLines) { put(c, l, M.left, ly, F.reg, SZ.address, INK, leftW); ly -= SZ.address * LEAD; }
      ly -= 1;
      for (const l of factLines) { put(c, l, M.left, ly, F.reg, SZ.partySub, MUTED, leftW); ly -= SZ.partySub * LEAD; }
    }
    if (officerLines.length) {
      let ry = y;
      putTracked(c, 'PREPARED BY', TEXT_RIGHT - trackedWidth(ctx, 'PREPARED BY', F.bold, SZ.eyebrow, EYEBROW_TRACK),
        ry, F.bold, SZ.eyebrow, GOLD, EYEBROW_TRACK, rightW);
      ry -= SZ.eyebrow * LEAD;
      officerLines.forEach((l, idx) => {
        const size = l.i === 0 ? SZ.byName : SZ.byLine;
        // The LAST line is the officer's own NMLS, which the sketch sets a shade
        // fainter than the rest: it is a registration number, not a way to reach
        // anybody, so it should not compete with the telephone above it.
        const last = idx === officerLines.length - 1;
        const colour = l.i === 0 ? INK : (last ? FAINT : MUTED);
        putRight(c, l.t, TEXT_RIGHT, ry, l.i === 0 ? F.bold : F.reg, size, colour, rightW);
        ry -= size * LEAD;
      });
    }
  })];
}

/**
 * A SECTION HEADING — a teal tick, tracked ink capitals, an ink rule under both.
 *
 * See `brand.SECTION` for why this is no longer a filled teal bar. The two
 * numbers that matter to the page's rhythm are here rather than inline: the
 * WIDE gap above (this is the "wide" in wide-tight-tight-tight-wide) and the
 * small one below, which is what binds a heading to the rows it names instead
 * of letting it float between two groups.
 *
 * `keepNext` still holds: a heading may never be the last thing on a page.
 */
function compileBand(b, ctx, box) {
  const F = ctx.fonts;
  const S = brand.SECTION;
  const B = boxOf(box);
  const above = RHYTHM.sectionAbove;
  const h = above + SZ.section * LEAD + S.rulePad + RHYTHM.sectionBelow;
  return [item(h, (c, y) => {
    const top = y - above;
    const base = top - SZ.section;         // where the capitals sit
    rect(c, B.x, top - (SZ.section - S.tickH) / 2 - 0.5, S.tickW, S.tickH, TEAL);
    const w = putTracked(c, String(b.title || '').toUpperCase(), B.x + S.tickW + S.gap,
      top, F.bold, SZ.section, INK, S.tracking,
      B.w - S.tickW - S.gap);
    /* THE SKETCH SETS A NOTE IN ITALICS AT THE RIGHT-HAND END OF THE SAME LINE
       — "every figure below is compared against option A". It rides the heading
       rather than taking a paragraph of its own, which is what keeps the heading
       and the table it introduces adjacent. It is DROPPED rather than wrapped
       when the title leaves it too little room: a note that pushes the heading
       onto two lines has cost more than it is worth. */
    if (b.note) {
      const room = B.right - (B.x + S.tickW + S.gap + w + 14);
      if (room > 60) putRight(c, b.note, B.textRight, top + 0.4, F.italic, SZ.small, FAINT, room);
    }
    line(c, base - S.rulePad, B.x, B.right, INK, S.rule);
  }, { keepNext: true })];
}

function compileRule(b, ctx, box) {
  const B = boxOf(box);
  return [item(14, (c, y) => line(c, y - 8, B.x, B.right, HAIR, 0.7))];
}

/**
 * A SUB-HEADING inside a figures list — small tracked gold capitals over a
 * hairline, so a run of fee lines reads as a group rather than as a list that
 * happens to be adjacent. This is what lets "Application fee / Commitment fee"
 * be visibly THE LENDER'S OWN FEES, which is the pair the waive switch turns
 * off and the pair the owner asked to be able to see the difference on.
 */
function compileSubhead(b, ctx, box) {
  const F = ctx.fonts;
  const B = boxOf(box);
  const gap = 10;
  const h = gap + SZ.eyebrow * LEAD + 5;
  return [item(h, (c, y) => {
    const top = y - gap;
    putTracked(c, String(b.text || '').toUpperCase(), B.x, top, F.bold, SZ.eyebrow, GOLD, 0.7, B.textW);
    line(c, top - SZ.eyebrow - 3, B.x, B.right, HAIR, 0.5);
  }, { keepNext: true })];
}

/**
 * A label on the left, its figure right-aligned on the same line.
 *
 * ⛔ THE LABEL IS WHAT MAKES THE FIGURE MEAN ANYTHING, so it is never the one
 * that gives way. A value too long for the room left beside its label — a
 * two-line property address, a program name an officer typed out in full — is
 * WRAPPED underneath instead of squeezed, because clipping the figure hides
 * money and clipping the label leaves "The property …", which reads as a
 * rendering fault rather than as an address.
 *
 * `accent` paints the RTL sheet's ivory band behind the row; every row but the
 * last carries the 0.4pt hairline under it that makes a figures list read as a
 * list rather than as a paragraph of numbers.
 */
function compileFigures(b, ctx, box) {
  const F = ctx.fonts;
  const B = boxOf(box);
  const tight = !!b.tight;
  const rows = (b.rows || []).filter(Boolean);
  const out = [];
  rows.forEach((row, ri) => {
    const label = ctx.text(row[0]);
    const value = ctx.text(row[1]);
    const o = row[2] || {};
    const big = !!o.big;
    const size = big ? SZ.big : SZ.value;
    const lsize = big ? SZ.bigLabel : SZ.label;
    const pad = tight ? RHYTHM.rowPadTight : (big ? RHYTHM.rowPadBig : RHYTHM.rowPad);
    // The FIGURE is monospaced, always — see the font block. A strong figure
    // takes the bold cut of the same face, never a different family.
    const vf = o.strong || big || o.total ? F.monoBold : F.mono;
    const vc = o.credit ? GOLD : INK;
    const last = ri === rows.length - 1;
    const divider = !tight && !o.noDivider && !last;

    // ⛔ THE LABEL'S SHARE IS OF ITS OWN BOX, NEVER OF THE PAGE. In a column
    // half the width, a fraction of the full page would let a label run into
    // the neighbouring column and a figure be measured against room it does
    // not have.
    const labelMax = Math.round(B.textW * 0.55);
    /* ⛔ A LABEL WRAPS; IT IS NEVER CLIPPED. This file's own rule two paragraphs
       up is that the label is what makes the figure mean anything and is never
       the one that gives way — and it was being CLIPPED to one line all the
       same, which nothing noticed while every label fitted the full content
       column. MEASURED the moment a column was half as wide: "Total monthly
       payment (principal, interest, taxes & insurance)" drew as "Total monthly
       payment (principal, inter…", which reads as a rendering fault on the one
       row that resolves the arithmetic. */
    const lfont = o.strong || big ? F.bold : F.reg;
    const labelLines = label ? wrap(ctx, label, lfont, lsize, labelMax) : [];
    // The figure sits beside the label's FIRST line, so that is the line the
    // room beside it is measured against — not the widest one.
    const firstLabelW = labelLines.length ? advance(ctx, labelLines[0], lfont, lsize) : 0;
    const roomBeside = B.textW - firstLabelW - 14;
    const valueW = advance(ctx, value, vf, size);
    const inline = !label || valueW <= roomBeside;
    const valueLines = inline ? null : wrap(ctx, value, vf, size, B.textW);

    const noteLines = o.note ? wrap(ctx, ctx.text(o.note), F.italic, SZ.small, labelMax) : [];
    const labelH = Math.max(1, labelLines.length) * lsize * LEAD;
    const h = Math.max(size * LEAD, labelH)
      + (inline ? 0 : valueLines.length * size * LEAD)
      + pad + noteLines.length * SZ.small * LEAD;

    out.push(item(h, (c, y) => {
      // The ivory band is drawn FIRST, behind everything, and it is inset by
      // nothing — it runs the full width of its own box exactly as the RTL row
      // runs the full content column.
      if (o.accent) rect(c, B.x, y + brand.ROW.accentPad, B.w, h, IVORY);
      if (o.total) line(c, y + 2, B.x, B.right, HAIR, 0.7);
      const baseTop = y - (big ? 1 : 0);
      const lcolor = o.strong || big ? INK : MUTED;
      // A label that carries weight takes the BOLD SANS, as the sketch sets it —
      // the emphasis is on the words, and the figure beside it is already bold.
      const lf = o.strong || big ? F.bold : F.reg;
      const drawLabel = (top) => {
        let ly = top;
        for (const ll of labelLines) { put(c, ll, B.x, ly, lf, lsize, lcolor, labelMax); ly -= lsize * LEAD; }
        return ly;
      };
      let ny = baseTop - Math.max(size * LEAD, labelH);
      if (!label) {
        // A continuation line: no label, so the value reads on the left.
        put(c, value, B.x, baseTop, F.mono, lsize, MUTED, B.textW);
      } else if (inline) {
        putRight(c, value, B.textRight, baseTop, vf, size, vc, roomBeside);
        drawLabel(baseTop - (big ? size - lsize : 0));
      } else {
        ny = drawLabel(baseTop);
        for (const vl of valueLines) {
          put(c, vl, B.x, ny, vf, size, vc, B.textW);
          ny -= size * LEAD;
        }
      }
      for (const nl of noteLines) {
        put(c, nl, B.x, ny, F.italic, SZ.small, MUTED, labelMax);
        ny -= SZ.small * LEAD;
      }
      if (divider) line(c, y - h + 3, B.x, B.right, HAIR, brand.ROW.hair);
    }));
  });
  return out;
}

function compilePara(b, ctx, box) {
  const F = ctx.fonts;
  const B = boxOf(box);
  const size = b.small ? SZ.small : SZ.para;
  const font = b.small ? F.italic : F.reg;
  const color = b.small ? MUTED : INK;
  const lines = wrap(ctx, ctx.text(b.text), font, size, B.textW);
  const out = [];
  lines.forEach((l, i) => {
    const gap = i === 0 ? 9 : 0;
    out.push(item(size * LEAD + gap, (c, y) => put(c, l, B.x, y - gap, font, size, color, B.textW),
      { keepNext: i < lines.length - 1 && i === 0 }));
  });
  return out;
}

/**
 * A CALLOUT — an ivory panel with a gold left edge, for the one or two things a
 * reader must not skim past. The expiry lives here.
 *
 * It is an ATOMIC item on purpose: a callout split across a page break would put
 * "This term sheet expires" at the foot of one page and "in 24 hours" at the
 * head of the next.
 */
/**
 * THE HEADLINE BAND — two to four figures, large, across the top.
 *
 * Owner-reported 2026-08-31: all three documents read as *"very ugly and very
 * abrupt"*, and part of that is that every one of them opened with the parties
 * and then a two-column table of nine-point type — the loan amount, the rate and
 * the payment, which are the whole point, were four inches down and the same
 * size as the property type.
 *
 * ⛔ IT DRAWS WHAT IT IS GIVEN AND WORKS NOTHING OUT. `layout.heroCells` reads
 * every figure straight off the member the tables below are built from, so the
 * headline cannot state a number the body contradicts.
 *
 * ⛔ IT NEVER SPLITS ACROSS A PAGE. The band is one item — a headline broken in
 * half across a page boundary is worse than no headline — and its value type is
 * sized DOWN to fit its own column rather than being allowed to run into the
 * cell beside it, because a $1,234,567.89 loan amount is a perfectly ordinary
 * figure on this book.
 */
function compileHero(b, ctx) {
  const F = ctx.fonts;
  const cells = (b.cells || []).filter((c) => c && c.value);
  if (cells.length < 2) return [];
  const n = cells.length;
  const H = brand.STATS;
  const colW = CONTENT_W / n;
  const innerW = colW - H.padX * 2;

  // The value's own size, per cell, so a long figure shrinks rather than
  // colliding with its neighbour. Never below `SZ.value`, or the "headline" is
  // smaller than the table it is summarising.
  const sizeFor = (txt) => {
    let size = SZ.statFigure;
    while (size > SZ.value && advance(ctx, txt, F.monoBold, size) > innerW) size -= 0.5;
    return size;
  };
  const drawn = cells.map((c) => {
    const value = ctx.text(c.value);
    return {
      label: ctx.text(c.label || ''),
      value,
      size: sizeFor(value),
      note: c.note ? wrap(ctx, ctx.text(c.note), F.italic || F.reg, SZ.statCaption, innerW) : [],
    };
  });
  const noteLines = Math.max(...drawn.map((d) => d.note.length));
  // MEASURED: the sketch's box runs 175.5 → 225.0, so 49.5 tall on one line of
  // caption. A second caption line adds its own leading rather than being
  // allowed to run out of the box.
  const boxH = H.h + Math.max(0, noteLines - 1) * SZ.statCaption * LEAD;
  const h = boxH + H.above + H.below;
  return [item(h, (c, y) => {
    const top = y - H.above;
    rect(c, M.left, top, CONTENT_W, boxH, IVORY);
    /* ⛔ IT IS A BOX, NOT A BAND — and that is the sketch's own drawing, read out
       of its geometry rather than remembered: a GOLD rule across the top, a
       hairline across the bottom, and a hairline between every pair of cells
       running the full inner height. The band shipped with only the bottom rule,
       which is why four figures that are meant to read as one statement in four
       parts read instead as text floating on a tint. */
    line(c, top, M.left, RIGHT_X, GOLD, H.rule);
    line(c, top - boxH, M.left, RIGHT_X, HAIR, H.rule);
    drawn.forEach((d, i) => {
      const x = M.left + i * colW + H.padX;
      putTracked(c, d.label.toUpperCase(), x, top - H.labelTop, F.bold, SZ.statLabel, MUTED, H.tracking, innerW);
      // The figure is monospaced, like every other figure on the document.
      put(c, d.value, x, top - H.figureTop - (SZ.statFigure - d.size), F.monoBold, d.size, INK, innerW);
      let ty = top - H.captionTop;
      for (const l of d.note) {
        put(c, l, x, ty, F.italic || F.reg, SZ.statCaption, MUTED, innerW);
        ty -= SZ.statCaption * LEAD;
      }
      if (i > 0) vline(c, M.left + i * colW, top - H.rule, boxH - H.rule * 2, HAIR);
    });
  })];
}

/**
 * A CALLOUT — one ruled statement, led by a gold dot, NOT a filled box.
 *
 * ⛔ THE EXPIRY IS A SENTENCE, NOT A PANEL. It was an ivory box with a gold bar
 * down its side, set near the top of the sheet, which made the shortest-lived
 * fact on the page the second-loudest thing on it — competing with the headline
 * figures for the eye it is not the answer to. The approved design states it as
 * one line between two hairlines with a small gold dot: read on the first pass,
 * never mistaken for the point of the document.
 *
 * ⛔ AND THE TITLE RUNS INTO ITS OWN SENTENCE. "This term sheet expires in 24
 * hours." set as a heading over a paragraph reads as two facts; set as a bold
 * opening clause it reads as one, which is what it is. So the first line is
 * wrapped to the room left BESIDE the title and the rest to the full column —
 * the only reason this needs its own wrap rather than the shared one.
 */
function compileCallout(b, ctx) {
  const F = ctx.fonts;
  const dot = 2.4;
  const indent = dot + 6;
  const innerW = TEXT_W - indent;
  const title = ctx.text(b.title || '');
  const body = b.text ? ctx.text(b.text) : '';
  const size = SZ.small;
  const titleW = title ? advance(ctx, title, F.bold, size) : 0;
  // A title that has eaten its own line leaves no room beside it; the body then
  // simply starts underneath, which is the honest fallback rather than a first
  // line squeezed to two words.
  const firstW = Math.max(0, innerW - titleW - advance(ctx, ' ', F.reg, size));
  const lines = body ? wrapAfter(ctx, body, F.reg, size, firstW, innerW) : [];
  const rows = Math.max(lines.length, title ? 1 : 0);
  const padY = 6;
  const h = padY * 2 + rows * size * LEAD + 12;
  return [item(h, (c, y) => {
    const top = y - 5;
    line(c, top, M.left, RIGHT_X, HAIR, 0.6);
    let ty = top - padY;
    // The dot sits on the first line's optical centre, never on its baseline.
    rect(c, M.left, ty - size * 0.34, dot, dot, GOLD);
    let x = M.left + indent;
    if (title) {
      put(c, title, x, ty, F.bold, size, INK, innerW);
      x += titleW + advance(ctx, ' ', F.reg, size);
    }
    lines.forEach((l, i) => {
      const first = i === 0;
      /* ⛔ THE LINE ADVANCES EVEN WHEN IT DREW NOTHING. `wrapAfter` answers with
         an EMPTY first line when the title has eaten the whole of it — the body
         then starts underneath, which is the honest fallback. Skipping the
         advance with the draw would put that body line on the title's own
         baseline, at the title's own x, one word on top of another. It cannot
         happen at today's wording and would the first time a title grew. */
      if (!(first && title && !l)) {
        put(c, l, first ? x : M.left + indent, ty, F.reg, size,
          col(brand.RGB.FOOTNOTE), first ? Math.max(firstW, 1) : innerW);
      }
      ty -= size * LEAD;
    });
    if (!lines.length) ty -= size * LEAD;
    line(c, ty - padY + size * 0.3, M.left, RIGHT_X, HAIR, 0.6);
  })];
}

/**
 * THE DISCLOSURES — a teal heading and a short body, per item, in the RTL
 * sheet's own shape. The heading is bound to its first body line, so a heading
 * can never end a page alone.
 */
function compileDisclosures(b, ctx) {
  const F = ctx.fonts;
  const out = [];
  for (const [heading, body] of b.items || []) {
    const lines = wrap(ctx, ctx.text(body), F.reg, SZ.discBody, TEXT_W);
    out.push(item(SZ.discHead * LEAD + 6, (c, y) => {
      put(c, heading, M.left + 3, y - 4, F.bold, SZ.discHead, TEAL, TEXT_W);
    }, { keepNext: true }));
    lines.forEach((l, i) => {
      const lastLine = i === lines.length - 1;
      out.push(item(SZ.discBody * LEAD + (lastLine ? 6 : 0),
        (c, y) => put(c, l, M.left + 3, y, F.reg, SZ.discBody, col(brand.RGB.FOOTNOTE), TEXT_W),
        { keepNext: !lastLine }));
    });
  }
  return out;
}

/**
 * THE ACCEPTANCE BLOCK — signature rules, on the TERM SHEET only.
 *
 * It is what makes the document a term sheet rather than a quote, and it is the
 * one place the sheet asks for something back. Never on a comparison: a reader
 * must never be able to sign a page that offers three options.
 */
function compileSignature(b, ctx) {
  const F = ctx.fonts;
  const lines = (b.lines || []).filter(Boolean);
  if (!lines.length) return [];
  /* ⛔ THREE SIGNATURE LINES ACROSS, NOT TWO — the approved design's own row.
     Two-up left half the width empty and split an entity's signer, its guarantor
     and the date over two rows, which reads as two separate acts rather than one
     signing.

     ⛔ AND NOTHING SITS ABOVE THE RULE. The sketch draws a bare line with one
     line of text UNDER it — "Oak Street Holdings LLC — authorised signer" — and
     that is not only shorter: a name printed above a signature line reads as a
     signature already given, on the one part of the document where the whole
     point is that nobody has signed yet. Every party and every date this sheet
     has always carried is still here; only where the words sit has moved. */
  const per = Math.min(3, lines.length);
  const gap = 20;
  const colW = (CONTENT_W - gap * (per - 1)) / per;
  const rowH = 30;
  const out = [];
  for (let i = 0; i < lines.length; i += per) {
    const group = lines.slice(i, i + per);
    out.push(item(rowH, (c, y) => {
      group.forEach((l, j) => {
        const x = M.left + j * (colW + gap);
        line(c, y - 14, x, x + colW, HAIR, 0.8);
        const label = l.name ? `${ctx.text(l.name)} — ${ctx.text(l.role || '')}` : ctx.text(l.role || '');
        put(c, label, x, y - 18, F.reg, SZ.partySub, MUTED, colW);
      });
    }, { keepNext: i + per < lines.length }));
  }
  return out;
}

/**
 * THE COMPARISON TABLE, IN THE APPROVED SKETCH'S OWN DESIGN.
 *
 * ⛔ IT IS A LEDGER, NOT A SPREADSHEET, and that is the whole of what changed.
 * What shipped drew a grey header band, zebra-striped every other row and set
 * every figure in the same sans as its label — which is what the owner read as
 * *"the design doesn't come close to the sketch"*. The sketch:
 *   · heads each column with a small tracked GOLD eyebrow ("OPTION B"), a grey
 *     tag on the one the others are measured against ("THE ANCHOR"), then the
 *     option's own name in bold over as many lines as it needs;
 *   · opens and closes the table with an INK rule and separates ordinary rows
 *     with a hairline so fine it reads as a change of tone — never a stripe;
 *   · sets every FIGURE in the monospace, so a column of money aligns on its
 *     own digits rather than on the accident of Helvetica's widths;
 *   · bands EXACTLY the rows that resolve the arithmetic in ivory — the full
 *     monthly payment and the cash to close — and sets those in the bold cut,
 *     one size up. Striping every other row instead gives the two answers no
 *     more weight than the rent, which is the reader's whole problem.
 *
 * ⛔ A GROUP CLOSES WITH AN INK RULE. The scenario sheet's table is divided
 * into what the officer moved, what that produced, and what the extra borrowing
 * costs; the sketch marks each division with a tick and tracked capitals, and
 * ends the group before it on the same ink rule the table itself opens with. So
 * the rule under a row is INK when that row is the last of its group and a
 * hairline otherwise — one test, no second list of which rows are special.
 *
 * Columns are MEASURED: the label column takes whichever is larger of what its
 * longest label needs and the sketch's own proportion, capped at a third of the
 * page; the data columns share what is left equally, because equal columns are
 * what let the eye compare like with like.
 */
function compileTable(b, ctx) {
  const F = ctx.fonts;
  const head = b.head || [];
  const rows = (b.rows || []).filter(Boolean);
  const cols = head.length;
  if (cols < 2) return [];

  /* A head cell is `{eyebrow, tag, title}`; a plain string is still accepted and
     draws as a title alone, so a caller that has not been updated is never
     rendered as `[object Object]`. */
  const headCell = (i) => {
    const h = head[i];
    if (h && typeof h === 'object') return h;
    return { eyebrow: null, tag: null, title: String(h == null ? '' : h) };
  };
  const isGroup = (r) => !Array.isArray(r) && !!r && typeof r === 'object' && !!r.group;
  /* A data row is `[label, ...values]` with an OPTIONAL trailing options object.
     Detected by its type rather than by its position, because a table with two
     columns and a trailing option would otherwise read its options as a value. */
  const hasOpts = (r) => { const l = r[r.length - 1]; return !!l && typeof l === 'object'; };
  const rowOpts = (r) => (hasOpts(r) ? r[r.length - 1] : {});
  const rowCells = (r) => (hasOpts(r) ? r.slice(0, -1) : r.slice());

  const dataRows = rows.filter((r) => Array.isArray(r));
  if (!dataRows.length) return [];

  const labelNeed = Math.max(
    0,
    ...dataRows.map((r) => advance(ctx, ctx.text(r[0]), F.bold, SZ.tableLabel)),
  ) + TBL.padX;
  const labelW = Math.min(
    Math.max(labelNeed, Math.round(CONTENT_W * TBL.labelShare)),
    Math.round(CONTENT_W * TBL.labelCap),
  );
  const colW = (CONTENT_W - labelW) / (cols - 1);
  const xOf = (i) => (i === 0 ? M.left : M.left + labelW + (i - 1) * colW);
  // The label runs from the margin; a figure is inset from its own column and
  // stops short of the next one, so two columns can never touch.
  const cellW = (i) => (i === 0 ? labelW - TBL.padX : colW - TBL.padX * 2);

  // ── the column heads ──────────────────────────────────────────────────────
  const titles = [];
  let anyEyebrow = false;
  for (let i = 1; i < cols; i++) {
    const hc = headCell(i);
    if (hc.eyebrow) anyEyebrow = true;
    const t = wrap(ctx, ctx.text(hc.title || ''), F.bold, SZ.colTitle, cellW(i));
    if (hc.sub) t.push(...wrap(ctx, ctx.text(hc.sub), F.bold, SZ.colTitle, cellW(i)));
    titles.push(t);
  }
  const titleLines = Math.max(1, ...titles.map((t) => t.length));
  const headH = TBL.headTop + (anyEyebrow ? TBL.headEyebrowStep : 0)
    + (titleLines - 1) * TBL.headTitleStep + SZ.colTitle + TBL.headBottom;
  const headItem = item(headH, (c, y) => {
    for (let i = 1; i < cols; i++) {
      const hc = headCell(i);
      const x = xOf(i) + TBL.padX;
      let ty = y - TBL.headTop;
      if (anyEyebrow) {
        if (hc.eyebrow) {
          const w = putTracked(c, String(hc.eyebrow).toUpperCase(), x, ty,
            F.bold, SZ.colEyebrow, GOLD, EYEBROW_TRACK, cellW(i));
          if (hc.tag) {
            putTracked(c, String(hc.tag).toUpperCase(), x + w + TBL.tagGap, ty,
              F.bold, SZ.colEyebrow, MUTED, EYEBROW_TRACK, Math.max(0, cellW(i) - w - TBL.tagGap));
          }
        }
        ty -= TBL.headEyebrowStep;
      }
      for (const l of titles[i - 1]) {
        put(c, l, x, ty, F.bold, SZ.colTitle, INK, cellW(i));
        ty -= TBL.headTitleStep;
      }
    }
    line(c, y - headH + TBL.rule / 2, M.left, RIGHT_X, INK, TBL.rule);
  }, { keepNext: true });

  // ── the rows ──────────────────────────────────────────────────────────────
  const out = [headItem];
  // A row closes on the INK rule when nothing but a group heading follows it —
  // computed once here so the drawing code carries no second reading of it.
  const lastOfGroup = rows.map((r, i) => {
    if (isGroup(r)) return false;
    for (let j = i + 1; j < rows.length; j += 1) {
      if (isGroup(rows[j])) return true;
      return false;
    }
    return true;    // the last row of the table
  });

  rows.forEach((r, ri) => {
    if (isGroup(r)) {
      const tone = r.tone === 'gold' ? GOLD : TEAL;
      const h = TBL.groupTop + SZ.groupHead * LEAD + TBL.groupBottom;
      out.push(item(h, (c, y) => {
        const top = y - TBL.groupTop;
        rect(c, M.left, top - (SZ.groupHead - TBL.tickH) / 2 - 0.4, TBL.tickW, TBL.tickH, tone);
        putTracked(c, String(r.group).toUpperCase(), M.left + TBL.tickW + TBL.tickGap, top,
          F.bold, SZ.groupHead, tone, EYEBROW_TRACK, TEXT_W - TBL.tickW - TBL.tickGap);
      }, { keepNext: true, head: headItem }));
      return;
    }
    const o = rowOpts(r);
    const cells = rowCells(r);
    const accent = !!o.accent;
    const lsize = SZ.tableLabel;
    const vsize = accent ? SZ.tableBig : SZ.tableValue;
    const lfont = accent ? F.bold : F.reg;
    const vfont = accent ? F.monoBold : F.mono;
    const labelLines = wrap(ctx, ctx.text(cells[0]), lfont, lsize, cellW(0));
    const subLines = o.sub ? wrap(ctx, ctx.text(o.sub), F.reg, SZ.tableSub, cellW(0)) : [];
    const valLines = [];
    for (let i = 1; i < cols; i += 1) valLines.push(wrap(ctx, ctx.text(cells[i]), vfont, vsize, cellW(i)));
    /* ⛔ A NOTE BELONGS TO ITS OWN COLUMN, not to the row's label (owner-directed
       2026-09-01): *"it should basically be in the scenario line, not in the line
       of the base of lender fees."* One line under the label describes the row,
       which is right for what a row IS and wrong for what each option DID — the
       charged column's breakdown and the waived column's saving are different
       sentences about different columns, and neither is a fact about the label. */
    const cellSubs = [];
    for (let i = 1; i < cols; i += 1) {
      const t = o.cellSubs && o.cellSubs[i - 1];
      cellSubs.push(t ? wrap(ctx, ctx.text(String(t)), F.reg, SZ.tableSub, cellW(i)) : []);
    }
    const labelH = labelLines.length * lsize * LEAD + subLines.length * SZ.tableSub * LEAD;
    const valH = Math.max(1, ...valLines.map((v) => v.length)) * vsize * LEAD
      + Math.max(0, ...cellSubs.map((v) => v.length)) * SZ.tableSub * LEAD;
    const h = Math.max(labelH, valH) + (accent ? TBL.accentPad : TBL.rowPad);
    const closing = lastOfGroup[ri];

    out.push(item(h, (c, y) => {
      // The band is drawn first, behind everything, and runs the full content
      // column exactly as the RTL sheet's accent row does.
      if (accent) rect(c, M.left, y, CONTENT_W, h, IVORY);
      const top = y - TBL.contentTop;
      let ly = top;
      const lx = M.left + (accent ? TBL.accentInset : 0);
      for (const l of labelLines) {
        put(c, l, lx, ly, lfont, lsize, accent ? INK : MUTED, cellW(0));
        ly -= lsize * LEAD;
      }
      for (const l of subLines) {
        put(c, l, lx, ly, F.reg, SZ.tableSub, MUTED, cellW(0));
        ly -= SZ.tableSub * LEAD;
      }
      for (let i = 1; i < cols; i += 1) {
        // A column with nothing to say prints its em dash in the grey the
        // sketch gives it — a figure and "there is no figure" must not read
        // with the same weight.
        const c0 = cells[i] == null ? '' : String(cells[i]);
        const colr = c0 === '—' ? FAINT : INK;
        let vy = top;
        for (const l of valLines[i - 1]) {
          put(c, l, xOf(i) + TBL.padX, vy, vfont, vsize, colr, cellW(i));
          vy -= vsize * LEAD;
        }
        // and this column's own small line, under its own figure
        for (const l of cellSubs[i - 1]) {
          put(c, l, xOf(i) + TBL.padX, vy, F.reg, SZ.tableSub, MUTED, cellW(i));
          vy -= SZ.tableSub * LEAD;
        }
      }
      line(c, y - h, M.left, RIGHT_X, closing ? INK : HAIR, closing ? TBL.rule : TBL.hair);
    }, { head: headItem }));
  });
  out.push(item(8, () => {}));
  return out;
}

/**
 * THE SHARED-FACTS GRID — what every option agrees about, stated once.
 *
 * ⛔ THE SHAPE IS WHAT MAKES IT BELONG AT THE TOP. As a list of labelled rows
 * these same fifteen facts cost ~260pt and pushed the table's answer onto a
 * second page, which is why they had been moved below it. The approved sketch
 * draws them four across inside a bordered ivory box — ~150pt for the same
 * facts — so the reason for moving them does not apply to what the sketch
 * actually draws, and the reader gets the sketch's own order: what these
 * options agree about, then what they differ on.
 *
 * ⛔ A CELL IS NEVER CLIPPED INTO A LIE. A figure too wide for its cell steps
 * DOWN in size until it fits, exactly as the headline band does — a money
 * amount with its last digits cut off is worse than a small one.
 */
function compileFactGrid(b, ctx) {
  const F = ctx.fonts;
  const cells = (b.cells || []).filter((c) => Array.isArray(c) && c[0] != null);
  if (!cells.length) return [];
  const inner = { x: M.left + GRID.tickW, right: RIGHT_X - GRID.rule };
  const colW = (inner.right - inner.x) / GRID.cols;
  const bands = Math.ceil(cells.length / GRID.cols);
  const cellTextW = colW - GRID.padX * 2;
  /* ⛔ THE NOTE SHRINKS TO ONE LINE BEFORE IT IS ALLOWED TO WRAP, exactly as the
     value above it does. A four-across cell is about 112 wide and the breakdown
     is a long string; wrapping it would grow the band for every cell beside it,
     which measurably spilled the sentences under the comparison onto a second
     page. Shrinking is the cheaper trade on a line that is already secondary —
     and it is bounded, so a note that genuinely cannot fit still wraps rather
     than dwindling to nothing. */
  const cellNotes = cells.map((c) => {
    if (!c[2]) return { lines: [], size: SZ.gridNote };
    const txt = ctx.text(String(c[2]));
    let size = SZ.gridNote;
    while (size > GRID.noteMin && advance(ctx, txt, F.reg, size) > cellTextW) size -= 0.1;
    return { lines: wrap(ctx, txt, F.reg, size, cellTextW), size };
  });
  const bandLines = [];
  for (let i = 0; i < cells.length; i += 1) {
    const r = Math.floor(i / GRID.cols);
    bandLines[r] = Math.max(bandLines[r] || 0, cellNotes[i].lines.length);
  }
  /* ⛔ EVERY NOTE LINE IS PAID FOR, and the version of this that said the first
     one was free was WRONG — owner-reported: *"it's a little overlapping, it's
     pushed in."* That claim reasoned from BASELINES ("the value's baseline is
     12.58 down, the band is 26.4, so ~13.8 is free") and a baseline is not a
     box. MEASURED off a real render instead: at this size the value's own box
     runs from 12.9 to 22.4 below the band top, so what is actually free under it
     is 4.0 — less than one 5.18 line needs. The note was drawn into the value,
     and the render passed because overlapping text is still inside its margins.
     Measure the BOX, never the baseline. */
  const bandH = (r) => GRID.bandH
    + (bandLines[r] ? bandLines[r] * SZ.gridNote * LEAD + GRID.cellNotePad : 0);
  const bandTopOffset = (r) => {
    let off = 0;
    for (let k = 0; k < r; k += 1) off += bandH(k);
    return off;
  };
  const bandsH = bandTopOffset(bands);
  const note = b.footnote ? wrap(ctx, ctx.text(b.footnote), F.italic, SZ.gridNote, inner.right - inner.x - GRID.padX * 2) : [];
  const noteH = note.length ? GRID.noteTop + note.length * SZ.gridNote * LEAD + GRID.noteBottom - SZ.gridNote : 0;
  const h = GRID.headH + bandsH + noteH;

  return [item(h + GRID.above, (c, y) => {
    const top = y - GRID.above;
    const bottom = top - h;
    rect(c, M.left, top, CONTENT_W, h, SOFT);
    // The gold tick down the left edge, and hairlines on the other three sides.
    rect(c, M.left, top, GRID.tickW, h, GOLD);
    line(c, top - GRID.rule / 2, M.left, RIGHT_X, HAIR, GRID.rule);
    line(c, bottom + GRID.rule / 2, M.left, RIGHT_X, HAIR, GRID.rule);
    vline(c, RIGHT_X - GRID.rule / 2, top, h, HAIR);

    // the heading, its right-hand note, and the hairline under both
    const headBase = top - GRID.headTop;
    const title = String(b.title || '').toUpperCase();
    const titleW = putTracked(c, title, inner.x + GRID.padX, headBase,
      F.bold, SZ.gridHead, MUTED, EYEBROW_TRACK, inner.right - inner.x - GRID.padX * 2);
    if (b.note) {
      const room = inner.right - GRID.padX - (inner.x + GRID.padX + titleW + 12);
      if (room > 40) {
        putRight(c, b.note, inner.right - GRID.padX, headBase, F.italic, SZ.gridHead, FAINT, room);
      }
    }
    line(c, top - GRID.headH + GRID.rule / 2, inner.x, inner.right, HAIR, GRID.rule);

    cells.forEach(([label, value], i) => {
      const r = Math.floor(i / GRID.cols);
      const cIdx = i % GRID.cols;
      const x = inner.x + cIdx * colW;
      const bandTop = top - GRID.headH - bandTopOffset(r);
      putTracked(c, String(label).toUpperCase(), x + GRID.padX, bandTop - GRID.labelTop,
        F.reg, SZ.gridLabel, MUTED, 0.35, cellTextW);
      let size = SZ.gridValue;
      const txt = ctx.text(value == null ? '—' : String(value));
      while (size > SZ.small && advance(ctx, txt, F.monoBold, size) > cellTextW) size -= 0.25;
      // A value that shrank to fit is drawn LOWER, so the note hangs off where the
      // value actually landed — never off the nominal baseline, or a long value
      // and its own breakdown would close on each other.
      const valueBase = bandTop - GRID.valueTop - (SZ.gridValue - size);
      put(c, txt, x + GRID.padX, valueBase, F.monoBold, size, INK, cellTextW);
      // The note that breaks the value down, if this cell carries one.
      let ny = valueBase - GRID.cellNoteTop;
      for (const l of cellNotes[i].lines) {
        put(c, l, x + GRID.padX, ny, F.reg, cellNotes[i].size, MUTED, cellTextW);
        ny -= cellNotes[i].size * LEAD;
      }
      // The cell's own rules: a hairline under it, and one down its right edge,
      // so the grid reads as cells rather than as four columns of loose text.
      const isLastBand = r === bands - 1;
      if (!isLastBand) line(c, bandTop - bandH(r) + GRID.rule / 2, x, x + colW, HAIR, GRID.rule);
      if (cIdx < GRID.cols - 1) vline(c, x + colW - GRID.rule / 2, bandTop, bandH(r), HAIR);
    });

    if (note.length) {
      let ny = bottom + noteH - GRID.noteTop + SZ.gridNote;
      for (const l of note) {
        put(c, l, inner.x + GRID.padX, ny, F.italic, SZ.gridNote, FAINT, inner.right - inner.x - GRID.padX * 2);
        ny -= SZ.gridNote * LEAD;
      }
    }
  })];
}

const PAGEBREAK = Symbol('pagebreak');

/**
 * A CONDITIONAL break — start a new page only if less than `room` is left.
 *
 * ⛔ A HARD BREAK BUYS A CLEAN START AND PAYS FOR IT IN WHITE PAPER, and on a
 * document whose length depends on the deal that trade goes the wrong way often
 * enough to matter: the first sheet rendered with a hard break before the
 * disclosures produced a page carrying five rows and ten inches of nothing.
 * A section that would begin in the last inch of a page is worth moving; one
 * that has half a page to work with is not, and the flow is the only thing that
 * knows which it is — so the layout says how much room the section deserves and
 * the renderer decides.
 *
 * `{t:'pagebreak'}` with no `ifLessThan` stays HARD, because "one option per
 * page" on a comparison is a statement about the document, not about the room.
 */
const isSoftBreak = (x) => !!x && typeof x === 'object' && x.soft === true;

/**
 * TWO GROUPS, SIDE BY SIDE — the approved design's page one.
 *
 * ⛔ IT IS ONE ATOMIC ITEM, AND THAT IS THE WHOLE SAFETY PROPERTY. A pair of
 * columns that could break across a page would put a label on one sheet and its
 * figure on the next, in two different columns, with nothing saying which
 * belongs to which. So both sides are compiled, the taller decides the height,
 * and `flow` places or moves the pair as one thing.
 *
 * ⛔ AND IT FALLS BACK RATHER THAN OVERFLOWING. Two cases give up and emit the
 * two sides one after another down the full column, which is exactly the page
 * this file drew before columns existed: a pair taller than a whole page (the
 * flow can move it but has nowhere to move it TO), and a side carrying a block
 * type that has no box — a hero, a table, a signature, all of which are
 * page-wide by nature. Neither is a defect to be worked around; a document that
 * reads down one column is worse-looking and still correct, and a document that
 * draws off the paper is neither.
 *
 * `COLUMN_TYPES` is therefore the honest statement of what may go in a column,
 * and adding to it means giving that compiler a box first.
 */
const COLUMN_TYPES = new Set(['band', 'section', 'rule', 'subhead', 'figures', 'para']);
const COLUMN_GAP = 22;

function compileSide(blocks, ctx, box) {
  const items = [];
  for (const b of blocks || []) {
    if (!b || typeof b !== 'object') continue;
    switch (b.t) {
      case 'band': case 'section': items.push(...compileBand(b, ctx, box)); break;
      case 'rule': items.push(...compileRule(b, ctx, box)); break;
      case 'subhead': items.push(...compileSubhead(b, ctx, box)); break;
      case 'figures': items.push(...compileFigures(b, ctx, box)); break;
      case 'para': items.push(...compilePara(b, ctx, box)); break;
      default: break;
    }
  }
  return items;
}

function compileColumns(b, ctx) {
  const left = (b.left || []).filter((x) => x && typeof x === 'object');
  const right = (b.right || []).filter((x) => x && typeof x === 'object');
  const sequential = () => compile([...left, ...right], ctx);
  if (!left.length || !right.length) return sequential();
  if (![...left, ...right].every((x) => COLUMN_TYPES.has(x.t))) return sequential();

  const w = (CONTENT_W - COLUMN_GAP) / 2;
  const boxes = [{ x: M.left, w }, { x: M.left + w + COLUMN_GAP, w }];
  const sides = [compileSide(left, ctx, boxes[0]), compileSide(right, ctx, boxes[1])];
  const heights = sides.map((items) => items.reduce((a, it) => a + it.h, 0));
  const h = Math.max(...heights);
  if (!(h > 0) || h > USABLE_H) return sequential();

  return [item(h, (c, y) => {
    for (const items of sides) {
      let yy = y;
      for (const it of items) { it.draw(c, yy); yy -= it.h; }
    }
  })];
}

function compile(blocks, ctx) {
  const items = [];
  for (const b of blocks || []) {
    if (!b || typeof b !== 'object') continue;
    switch (b.t) {
      // The band and the footer are PAGE FURNITURE: the block only carries the
      // facts they state, and they are drawn over every page after the flow.
      case 'meta': ctx.meta = { ...ctx.meta, ...b }; break;
      case 'recipient': items.push(...compileRecipient(b, ctx)); break;
      case 'band': items.push(...compileBand(b, ctx)); break;
      case 'section': items.push(...compileBand(b, ctx)); break;
      case 'rule': items.push(...compileRule(b, ctx)); break;
      case 'subhead': items.push(...compileSubhead(b, ctx)); break;
      case 'figures': items.push(...compileFigures(b, ctx)); break;
      case 'para': items.push(...compilePara(b, ctx)); break;
      case 'hero': items.push(...compileHero(b, ctx)); break;
      case 'callout': items.push(...compileCallout(b, ctx)); break;
      case 'disclosures': items.push(...compileDisclosures(b, ctx)); break;
      case 'signature': items.push(...compileSignature(b, ctx)); break;
      case 'table': items.push(...compileTable(b, ctx)); break;
      case 'factgrid': items.push(...compileFactGrid(b, ctx)); break;
      case 'columns': items.push(...compileColumns(b, ctx)); break;
      case 'pagebreak':
        items.push(Number.isFinite(b.ifLessThan) ? { soft: true, room: b.ifLessThan } : PAGEBREAK);
        break;
      default: break;
    }
  }
  return items;
}

// ── the flow ────────────────────────────────────────────────────────────────

/**
 * Walk the items, breaking a page whenever the next atomic RUN would not fit.
 *
 * A run is an item plus everything bound to it by `keepNext`. A run taller than
 * a whole page would be unplaceable, so the bond is DROPPED for that run and it
 * flows line by line — every individual item is a single measured line and
 * therefore always fits. Refusing to draw would be worse: the page would be
 * blank and nobody would know why.
 */
function flow(items, ctx) {
  let y = TOP_Y;
  let pendingHead = null;

  const newPage = () => {
    ctx.page = ctx.doc.addPage([PAGE.w, PAGE.h]);
    ctx.pages.push(ctx.page);
    y = TOP_Y;
  };
  newPage();

  const runAt = (i) => {
    const run = [items[i]];
    let j = i;
    const flows = (x) => !!x && x !== PAGEBREAK && !isSoftBreak(x);
    while (flows(items[j]) && items[j].keepNext && flows(items[j + 1])) {
      run.push(items[j + 1]);
      j += 1;
    }
    return run;
  };

  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (it === PAGEBREAK) {
      if (y !== TOP_Y) newPage();
      pendingHead = null;
      i += 1;
      continue;
    }
    if (isSoftBreak(it)) {
      if (y !== TOP_Y && y - BOTTOM_Y < it.room) newPage();
      pendingHead = null;
      i += 1;
      continue;
    }
    let run = runAt(i);
    let runH = run.reduce((a, x) => a + x.h, 0);
    // A run taller than a whole page can never be placed as one, so the bond is
    // dropped and it flows line by line. Every item is a single measured line,
    // so each one always fits — refusing to draw would leave a blank page and
    // no way to tell why.
    if (runH > USABLE_H) { run = [it]; runH = it.h; }

    if (y - runH < BOTTOM_Y) {
      newPage();
      // The table is continuing, so its header comes with it — otherwise a
      // reader on page two is looking at three unlabelled columns of money.
      // Skipped only if the header plus the run could not fit even here.
      if (it.head && pendingHead === it.head && it.head.h + runH <= USABLE_H) {
        it.head.draw(ctx, y);
        y -= it.head.h;
      }
    }
    for (const x of run) {
      x.draw(ctx, y);
      y -= x.h;
    }
    pendingHead = run[run.length - 1].head || null;
    i += run.length;
  }
}

// ── page furniture ──────────────────────────────────────────────────────────

/**
 * THE BRAND BAND, ON EVERY PAGE — the RTL sheet's `header()`.
 *
 * A full-bleed ink rectangle, a gold rule under it, a hairline under that, our
 * lockup on the left and the document's own identity on the right. It is drawn
 * over the whole page list AFTER the flow, so a page the flow added mid-table
 * gets it too, and so does one added by a block type written next year.
 *
 * ⛔ THE LOCKUP IS OPTIONAL AND THE BAND IS NOT. With no readable image the
 * wordmark is SET IN TYPE rather than left blank — a branded band with a hole in
 * it reads as a broken document, and a term sheet must never fail to render over
 * a decoration.
 */
function drawBands(ctx) {
  const F = ctx.fonts;
  const B = brand.BAND;
  const meta = ctx.meta || {};
  const top = PAGE.h;
  for (const page of ctx.pages) {
    const c = { ...ctx, page };
    rect(c, 0, top, PAGE.w, B.h, INK);
    rect(c, 0, top - B.h, PAGE.w, B.rule, GOLD);
    line(c, top - B.h - B.rule - 1.2, 0, PAGE.w, HAIR, 0.5);

    if (ctx.logo) {
      const w = B.logoH * brand.LOGO_ASPECT;
      page.drawImage(ctx.logo, { x: M.left, y: top - B.logoTop - B.logoH, width: w, height: B.logoH });
    } else {
      putTracked(c, 'YS CAPITAL', M.left, top - B.logoTop - 2, F.bold, 15, PAPER, 1.2, 240);
      put(c, 'the answer is yes', M.left, top - B.logoTop - 20, F.italic, 7.5, ONBAND, 240);
    }

    // The right-hand identity. Each line is CLIPPED to the room left beside the
    // lockup, so a long program name can never run back across it.
    const roomX = M.left + B.logoH * brand.LOGO_ASPECT + 24;
    const roomW = TEXT_RIGHT - roomX;
    if (meta.title) putRight(c, meta.title, TEXT_RIGHT, top - B.titleBase + SZ.bandTitle, F.serifBold, SZ.bandTitle, PAPER, roomW);
    if (meta.subtitle) putRight(c, meta.subtitle, TEXT_RIGHT, top - B.subBase + SZ.bandSub, F.serifItalic, SZ.bandSub, GOLD, roomW);
    if (meta.identity) putRight(c, meta.identity, TEXT_RIGHT, top - B.idBase + SZ.bandId, F.reg, SZ.bandId, ONBAND, roomW);
  }
}

/**
 * THE FOOTER, ON EVERY PAGE — the RTL sheet's `footer()`, three lines: who to
 * call, what this document is not, and which document it is.
 *
 * It sits BELOW `BOTTOM_Y`, inside the bottom margin, which is what makes it
 * structurally impossible for flowing content to run through it.
 */
function drawFooters(ctx) {
  const F = ctx.fonts;
  const meta = ctx.meta || {};
  const n = ctx.pages.length;
  const FOOT = col(brand.RGB.FOOTNOTE);
  ctx.pages.forEach((page, idx) => {
    const c = { ...ctx, page };
    // ⛔ THE THREE LINES ARE PLACED SO THEY CANNOT TOUCH. Measured, not eyeballed:
    // the contact box is [41.4, 49], the two disclaimer lines [31, 38] and
    // [21.76, 28.76], the identity line [8, 14] — every gap positive, and the
    // whole band sits under the 52pt hairline, which is itself under the content
    // floor. `slice(0, 2)` is a real cap and is why the disclaimer's own length
    // can never push the identity line off the paper.
    line(c, 52, M.left, RIGHT_X, HAIR, 0.6);
    if (meta.contact) put(c, meta.contact, M.left, 49, F.bold, SZ.footContact, FOOT, TEXT_W);
    const disc = wrap(ctx, ctx.text(meta.disclaimer || ''), F.reg, SZ.footDisc, TEXT_W);
    let dy = 38;
    for (const l of disc.slice(0, 2)) { put(c, l, M.left, dy, F.reg, SZ.footDisc, FAINT, TEXT_W); dy -= SZ.footDisc * LEAD; }
    /* ⛔ THE IDENTITY LINE IS MONOSPACED AND SET IN CAPITALS, the way the approved
       sketch sets it: "TERM SHEET · TS-4KQ7WM · PAGE 1 OF 2". It is the one line
       on the page nobody reads as prose — it is a reference somebody types into
       the lookup screen or reads down a phone — so it is set as a reference, in
       the same face every figure on the document uses. The DATE stays out of the
       capitals it would be shouted in and rides in the same line's tail. */
    const idBits = [meta.docLabel, meta.code, `Page ${idx + 1} of ${n}`, meta.stamp].filter(Boolean);
    putRight(c, idBits.join(' · ').toUpperCase(), TEXT_RIGHT, 14, F.mono, SZ.footId, MUTED, TEXT_W);
  });
}

/**
 * Render a layout (`layout.buildLayout`) to PDF bytes.
 *
 * @param {{blocks:Array, code:?string}} layout
 * @param {{title?:string}} [opts]
 * @returns {Promise<Uint8Array>}
 */
async function renderTermSheet(layout, opts = {}) {
  const blocks = (layout && layout.blocks) || [];
  const code = (layout && layout.code) || null;

  const doc = await PDFDocument.create();
  const fonts = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    // The band's title is SET IN A SERIF, exactly as the RTL sheet sets it —
    // it is the one place the document speaks in the brand's display voice.
    serifBold: await doc.embedFont(StandardFonts.TimesRomanBold),
    serifItalic: await doc.embedFont(StandardFonts.TimesRomanItalic),
    /* ⛔ EVERY FIGURE ON THIS DOCUMENT IS SET IN A MONOSPACED FACE, because that
       is what the approved sketch does and it is most of why the sketch reads
       the way it does: a column of money in a typewriter face is a LEDGER, and
       the same column in Helvetica is a form.
       I previously told the owner that no font file was needed because
       Helvetica's digits are already tabular. That was true and it answered the
       wrong question — it is about ALIGNMENT, and the sketch's monospace is
       about TEXTURE. Courier is one of the PDF base-14 faces, so this is still
       no new dependency and no embedded file: pdf-lib has it built in, and its
       advance (600/1000) is within a hair of the sketch's IBM Plex Mono, so a
       column measured against one fits the other. */
    mono: await doc.embedFont(StandardFonts.Courier),
    monoBold: await doc.embedFont(StandardFonts.CourierBold),
  };
  const ctx = {
    doc,
    fonts,
    pages: [],
    page: null,
    logo: null,
    meta: { code },
    widths: new Map(),
    // The chokepoint is bound to the REGULAR font: the standard faces share one
    // encoding, so what one can draw they all can.
    text: makeText(fonts.reg, { scrub: new Map(), enc: new Map() }),
  };

  // ⛔ THE LOGO CAN NEVER TAKE THE DOCUMENT DOWN. `brand.logoBytes()` already
  // refuses anything that is not a PNG; this catches the embedder itself, so a
  // valid-header-but-corrupt file degrades to the type lockup rather than
  // throwing out of a render the officer was already told had succeeded.
  const bytes = brand.logoBytes();
  if (bytes) {
    try { ctx.logo = await doc.embedPng(bytes); } catch { ctx.logo = null; }
  }

  flow(compile(blocks, ctx), ctx);
  drawBands(ctx);
  drawFooters(ctx);

  doc.setTitle(ctx.text(opts.title || (code ? `Term Sheet ${code}` : 'Term Sheet')));
  doc.setProducer('PILOT');
  doc.setCreator('PILOT');
  return doc.save();
}

/**
 * THE THREE ZONES A STRING MAY OCCUPY, exported so a geometry test asserts
 * against the real furniture rather than against numbers retyped into it — a
 * test carrying its own copy of the layout passes the day the layout moves.
 */
const ZONES = {
  band: { bottom: PAGE.h - brand.BAND.h, top: PAGE.h },
  content: { bottom: BOTTOM_Y, top: TOP_Y },
  footer: { bottom: 6, top: 52 },
};

module.exports = {
  renderTermSheet,
  PAGE, M, CONTENT_W, TOP_Y, BOTTOM_Y, USABLE_H, ZONES,
  _internals: {
    advance, charW, wrap, wrapAfter, hardBreak, clip, makeText, compile,
    GLYPH_MAP, SZ, RHYTHM, COLUMN_TYPES, COLUMN_GAP, compileColumns, boxOf,
  },
};
