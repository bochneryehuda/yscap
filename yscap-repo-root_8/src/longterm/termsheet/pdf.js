'use strict';
/**
 * LONG-TERM TERM SHEETS — THE RENDERER.
 *
 * `layout.js` decides WHAT is on the page; this decides how it is drawn. It
 * walks the block list, MEASURES every line against the real font metrics, and
 * FLOWS it — breaking a page the moment the next line would not fit.
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
 * PURE-ISH: pdf-lib and the LT audience module, no database, no network, no
 * filesystem. Returns the bytes; the caller decides what to do with them.
 */

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const audience = require('../audience');

// ── the paper ───────────────────────────────────────────────────────────────
const PAGE = { w: 612, h: 792 };                 // US Letter, portrait
const M = { left: 54, right: 54, top: 56, bottom: 74 };
const CONTENT_W = PAGE.w - M.left - M.right;     // 504
const TOP_Y = PAGE.h - M.top;                    // 736 — first baseline box top
const BOTTOM_Y = M.bottom;                       // 74 — NOTHING flows below this
const USABLE_H = TOP_Y - BOTTOM_Y;               // 662
const RIGHT_X = PAGE.w - M.right;
// Text stops a hair short of the rules. The measurement above is exact, so this
// is not slack for error — it is the optical gutter that keeps a right-aligned
// figure from touching the hairline it sits against.
const GUTTER = 2;
const TEXT_RIGHT = RIGHT_X - GUTTER;
const TEXT_W = CONTENT_W - GUTTER;

// ── the ink ─────────────────────────────────────────────────────────────────
// PILOT's palette, and every one of them is DARK on white. The V2 tokens named
// `--ink*` are LIGHT paper colours and would render white on white; these are
// the literal values, chosen so a printed page reads the same as the screen.
const INK = rgb(0x14 / 255, 0x1b / 255, 0x22 / 255);      // #141B22
const MUTED = rgb(0x4b / 255, 0x58 / 255, 0x5c / 255);    // #4B585C
const GOLD = rgb(0xae / 255, 0x87 / 255, 0x46 / 255);     // #AE8746
const HAIR = rgb(0.82, 0.80, 0.76);
const SOFT = rgb(0.96, 0.955, 0.94);

// ── the type ────────────────────────────────────────────────────────────────
const SZ = {
  title: 21, code: 12.5, company: 9.5,
  section: 12, label: 9.5, value: 10, big: 15, bigLabel: 9.5,
  para: 9.5, small: 8.3, table: 8.4, foot: 7.6,
};
const LEAD = 1.32;   // line height as a multiple of the size

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
  ' ': ' ', ' ': ' ', ' ': ' ', '​': '',
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

/**
 * ⛔ THE BOX IS ENFORCED HERE, NOT BY THE CALLER — and its DEFAULT is the page.
 *
 * A caller that forgets to say how wide its column is gets the widest box that
 * still fits on the sheet, so forgetting produces an ugly clip and never ink off
 * the paper. Every wrapped context passes its real width; a one-line context (a
 * heading, a figure, a code) CLIPS rather than wraps, because wrapping a value
 * that is meant to sit on one line silently changes the row's height and walks
 * the whole page off its own measurement.
 */
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

// ── compiling blocks into flowable items ────────────────────────────────────
// An item is one atomic thing to draw: `{h, draw(ctx, yTop), keepNext, head}`.
// `keepNext` binds it to the item after it (a heading must never sit alone at
// the foot of a page); `head` is a table's header row, redrawn when the table
// continues onto a new page.

const item = (h, draw, opts) => ({ h, draw, keepNext: !!(opts && opts.keepNext), head: (opts && opts.head) || null });

function compileHeader(b, ctx) {
  const F = ctx.fonts;
  const h = 76;
  return [item(h, (c, y) => {
    let yy = y;
    if (b.companyName) {
      const nmlsW = b.companyNmls
        ? putRight(c, `NMLS #${b.companyNmls}`, TEXT_RIGHT, yy, F.reg, SZ.company, MUTED) : 0;
      put(c, b.companyName, M.left, yy, F.bold, SZ.company, GOLD, TEXT_W - nmlsW - 14);
      yy -= SZ.company * LEAD + 6;
    }
    const codeW = b.code ? putRight(c, b.code, TEXT_RIGHT, yy, F.bold, SZ.code, GOLD) : 0;
    put(c, 'Term Sheet', M.left, yy, F.bold, SZ.title, INK, TEXT_W - codeW - 14);
    yy -= SZ.title * LEAD;
    const bits = [];
    if (b.preparedAt) bits.push(`Prepared ${b.preparedAt}`);
    if (b.expiresAt) bits.push(`Good through ${b.expiresAt}`);
    if (bits.length) {
      put(c, bits.join('  ·  '), M.left, yy, F.reg, SZ.small, MUTED);
      yy -= SZ.small * LEAD;
    }
    line(c, y - h + 12, M.left, RIGHT_X, GOLD, 1.1);
  })];
}

function compileSection(b, ctx) {
  const F = ctx.fonts;
  const gap = 16;
  const h = gap + SZ.section * LEAD + 8;
  return [item(h, (c, y) => {
    const top = y - gap;
    put(c, b.title, M.left, top, F.bold, SZ.section, INK);
    line(c, top - SZ.section - 5, M.left, RIGHT_X, HAIR, 0.7);
  }, { keepNext: true })];
}

function compileRule() {
  return [item(14, (c, y) => line(c, y - 8, M.left, RIGHT_X, HAIR, 0.7))];
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
 */
function compileFigures(b, ctx) {
  const F = ctx.fonts;
  const tight = !!b.tight;
  const out = [];
  for (const row of b.rows || []) {
    const label = ctx.text(row[0]);
    const value = ctx.text(row[1]);
    const o = row[2] || {};
    const big = !!o.big;
    const size = big ? SZ.big : SZ.value;
    const lsize = big ? SZ.bigLabel : SZ.label;
    const pad = tight ? 3 : (big ? 7 : 5);
    const vf = o.strong || big || o.total ? F.bold : F.reg;
    const vc = o.credit ? GOLD : INK;

    const labelMax = Math.round(TEXT_W * 0.55);
    const labelW = label ? Math.min(advance(ctx, label, F.reg, lsize), labelMax) : 0;
    const roomBeside = TEXT_W - labelW - 14;
    const valueW = advance(ctx, value, vf, size);
    const inline = !label || valueW <= roomBeside;
    const valueLines = inline ? null : wrap(ctx, value, vf, size, TEXT_W);

    const noteLines = o.note ? wrap(ctx, ctx.text(o.note), F.italic, SZ.small, labelMax) : [];
    const h = Math.max(size, lsize) * LEAD
      + (inline ? 0 : valueLines.length * size * LEAD)
      + pad + noteLines.length * SZ.small * LEAD;

    out.push(item(h, (c, y) => {
      if (o.total) line(c, y + 2, M.left, RIGHT_X, HAIR, 0.7);
      const baseTop = y - (big ? 1 : 0);
      let ny = baseTop - Math.max(size, lsize) * LEAD;
      if (!label) {
        // A continuation line: no label, so the value reads on the left.
        put(c, value, M.left, baseTop, F.reg, lsize, MUTED, TEXT_W);
      } else if (inline) {
        putRight(c, value, TEXT_RIGHT, baseTop, vf, size, vc, roomBeside);
        put(c, label, M.left, baseTop - (big ? size - lsize : 0), F.reg, lsize,
          o.strong || big ? INK : MUTED, labelMax);
      } else {
        put(c, label, M.left, baseTop, F.reg, lsize, o.strong || big ? INK : MUTED, labelMax);
        for (const vl of valueLines) {
          put(c, vl, M.left, ny, vf, size, vc, TEXT_W);
          ny -= size * LEAD;
        }
      }
      for (const nl of noteLines) {
        put(c, nl, M.left, ny, F.italic, SZ.small, MUTED, labelMax);
        ny -= SZ.small * LEAD;
      }
    }));
  }
  return out;
}

function compilePara(b, ctx) {
  const F = ctx.fonts;
  const size = b.small ? SZ.small : SZ.para;
  const font = b.small ? F.italic : F.reg;
  const color = b.small ? MUTED : INK;
  const lines = wrap(ctx, ctx.text(b.text), font, size, TEXT_W);
  const out = [];
  lines.forEach((l, i) => {
    const gap = i === 0 ? 9 : 0;
    out.push(item(size * LEAD + gap, (c, y) => put(c, l, M.left, y - gap, font, size, color),
      { keepNext: i < lines.length - 1 && i === 0 }));
  });
  return out;
}

/**
 * A comparison table.
 *
 * Columns are MEASURED, not guessed: the label column takes what its longest
 * label needs (capped, so three options still get room) and the option columns
 * share what is left equally — equal so the eye compares like with like.
 */
function compileTable(b, ctx) {
  const F = ctx.fonts;
  const head = b.head || [];
  const rows = b.rows || [];
  const cols = head.length;
  if (cols < 2) return [];

  const labelNeed = Math.max(
    ...rows.map((r) => advance(ctx, ctx.text(r[0]), F.reg, SZ.table)),
    advance(ctx, ctx.text(head[0] || ''), F.bold, SZ.table),
    0,
  ) + 8;
  const labelW = Math.min(Math.max(labelNeed, 92), Math.round(CONTENT_W * 0.34));
  const colW = (CONTENT_W - labelW) / (cols - 1);
  const xOf = (i) => (i === 0 ? M.left : M.left + labelW + (i - 1) * colW);
  const cellW = (i) => (i === 0 ? labelW : colW) - 12;

  const wrapRow = (cells, font) => cells.map((cell, i) => wrap(ctx, ctx.text(cell), font, SZ.table, cellW(i)));
  const rowHeight = (wrapped) => Math.max(...wrapped.map((w) => w.length)) * SZ.table * LEAD + 7;

  const headWrapped = wrapRow(head, F.bold);
  const headH = rowHeight(headWrapped) + 4;
  const drawHead = (c, y) => {
    c.page.drawRectangle({
      x: M.left, y: y - headH + 4, width: CONTENT_W, height: headH - 4, color: SOFT,
    });
    headWrapped.forEach((lines, i) => {
      let yy = y - 4;
      for (const l of lines) {
        put(c, l, xOf(i) + 5, yy, F.bold, SZ.table, INK, cellW(i));
        yy -= SZ.table * LEAD;
      }
    });
    line(c, y - headH + 4, M.left, RIGHT_X, GOLD, 0.9);
  };
  const headItem = item(headH, drawHead, { keepNext: true });

  const out = [headItem];
  rows.forEach((r, ri) => {
    const w = wrapRow(r, F.reg);
    const h = rowHeight(w);
    out.push(item(h, (c, y) => {
      w.forEach((lines, i) => {
        let yy = y - 2;
        const f = i === 0 ? F.reg : (i === 1 ? F.bold : F.reg);
        const col = i === 0 ? MUTED : INK;
        for (const l of lines) {
          put(c, l, xOf(i) + 5, yy, f, SZ.table, col, cellW(i));
          yy -= SZ.table * LEAD;
        }
      });
      if (ri < rows.length - 1) line(c, y - h + 3, M.left, RIGHT_X, HAIR, 0.4);
    }, { head: headItem }));
  });
  out.push(item(8, () => {}));
  return out;
}

const PAGEBREAK = Symbol('pagebreak');

function compile(blocks, ctx) {
  const items = [];
  for (const b of blocks || []) {
    if (!b || typeof b !== 'object') continue;
    switch (b.t) {
      case 'header': items.push(...compileHeader(b, ctx)); break;
      case 'section': items.push(...compileSection(b, ctx)); break;
      case 'rule': items.push(...compileRule()); break;
      case 'figures': items.push(...compileFigures(b, ctx)); break;
      case 'para': items.push(...compilePara(b, ctx)); break;
      case 'table': items.push(...compileTable(b, ctx)); break;
      case 'pagebreak': items.push(PAGEBREAK); break;
      case 'footer': break;   // drawn on every page once the count is known
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
    while (items[j] && items[j] !== PAGEBREAK && items[j].keepNext
           && items[j + 1] && items[j + 1] !== PAGEBREAK) {
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

/**
 * The footer band, on EVERY page, drawn last so it can state the page count.
 *
 * It sits BELOW `BOTTOM_Y`, inside the bottom margin, which is what makes it
 * structurally impossible for flowing content to run through it.
 */
function drawFooters(ctx, code) {
  const F = ctx.fonts;
  const n = ctx.pages.length;
  ctx.pages.forEach((page, idx) => {
    const c = { ...ctx, page };
    line(c, 56, M.left, RIGHT_X, HAIR, 0.6);
    const left = code ? `Term sheet ${code}` : 'Term sheet';
    const pw = putRight(c, `Page ${idx + 1} of ${n}`, TEXT_RIGHT, 48, F.reg, SZ.foot, MUTED);
    put(c, left, M.left, 48, F.reg, SZ.foot, MUTED, TEXT_W - pw - 14);
    put(c, 'This is an estimate, not a commitment to lend.', M.left, 38, F.italic, SZ.foot, MUTED);
  });
}

/**
 * Render a layout (`layout.buildLayout`) to PDF bytes.
 *
 * @param {{blocks:Array, code:?string}} layout
 * @param {{title?:string, author?:string}} [opts]
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
  };
  const ctx = {
    doc,
    fonts,
    pages: [],
    page: null,
    widths: new Map(),
    // The chokepoint is bound to the REGULAR font: the standard faces share one
    // encoding, so what one can draw they all can.
    text: makeText(fonts.reg, { scrub: new Map(), enc: new Map() }),
  };

  flow(compile(blocks, ctx), ctx);
  drawFooters(ctx, code);

  doc.setTitle(ctx.text(opts.title || (code ? `Term Sheet ${code}` : 'Term Sheet')));
  doc.setProducer('PILOT');
  doc.setCreator('PILOT');
  return doc.save();
}

module.exports = {
  renderTermSheet,
  PAGE, M, CONTENT_W, TOP_Y, BOTTOM_Y, USABLE_H,
  _internals: { advance, charW, wrap, hardBreak, clip, makeText, compile, GLYPH_MAP },
};
