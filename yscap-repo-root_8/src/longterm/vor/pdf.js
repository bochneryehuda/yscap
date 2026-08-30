'use strict';
/**
 * LONG-TERM — THE VERIFICATION OF RENT, RENDERED.
 *
 * Builds the form as a real PDF from the form's DATA, on `pdf-lib` — an ordinary npm
 * dependency this repository already carries, so there is no vendored engine to
 * lazily require (Long-Term may not use a dynamic require at all: the separation
 * gate cannot see where one points, and it refuses them).
 *
 * ── THE PREVIEW IS BUILT FROM THE DATA, EVERY TIME ──────────────────────────
 *
 * The owner asked to "preview and edit the PDF before sending". What is EDITED is
 * the DATA; the PDF is re-rendered from it on every preview and again at the moment
 * of sending. That is deliberate and it is the safer half of an easy-looking choice:
 * editing PDF BYTES leaves the anchors somewhere nobody can predict, so the tabs
 * stop landing on their lines — and every reader downstream (the condition, the
 * returned answers, the reporting) reads the data anyway. Rendering from the data
 * means the preview is EXACTLY the document that goes out, by construction rather
 * than by a promise.
 *
 * ── THE ANCHORS ARE INVISIBLE, AND THEY ARE NOT DECORATION ──────────────────
 *
 * Each landlord field prints a ruled blank with its anchor drawn in WHITE at 4pt
 * underneath — invisible to a human, findable by DocuSign, which places the tab
 * relative to it. The anchor strings come from `fields.js` and are never spelled
 * here: the document and the tab list are two halves of one mechanism and a second
 * spelling is how a tab ends up on the wrong line.
 *
 * SEPARATION: reads `./fields` (long-term) and `pdf-lib` (npm). No database, no
 * config, no other module.
 */
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const F = require('./fields');

const PAGE = { w: 612, h: 792 };            // US Letter, points
const M = { left: 54, right: 54, top: 54, bottom: 54 };
const INK = rgb(0.078, 0.106, 0.133);       // #141B22 — the PILOT ink
const MUTED = rgb(0.294, 0.345, 0.365);     // #4B585C
const GOLD = rgb(0.682, 0.529, 0.275);      // #AE8746
const RULE = rgb(0.80, 0.80, 0.78);
const WHITE = rgb(1, 1, 1);

const LENDER_FALLBACK = {
  name: 'YS Capital Group',
  address: '5 New Montrose Avenue, Brooklyn, NY 11211',
  nmls: '2609746',
};

/** WinAnsi cannot draw a curly quote or an em dash; a PDF that throws mid-build is
    worse than one with a straight apostrophe, so every string is folded first. */
function pdfSafe(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
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
  return lines.length ? lines : [''];
}

/** A tiny drawing cursor. It OWNS pagination — a section that runs past the bottom
    margin starts a new page rather than printing over the footer, which is the
    defect the fee-audit render pass found on the term sheet. */
function makeCanvas(doc, fonts) {
  const state = { page: null, y: 0, pages: [] };
  function newPage() {
    state.page = doc.addPage([PAGE.w, PAGE.h]);
    state.pages.push(state.page);
    state.y = PAGE.h - M.top;
    return state.page;
  }
  newPage();
  function room(h) { if (state.y - h < M.bottom) newPage(); }
  function text(s, { x = M.left, size = 10, font = fonts.reg, color = INK, lead = 0 } = {}) {
    room(size + 2);
    state.y -= size;
    state.page.drawText(pdfSafe(s), { x, y: state.y, size, font, color });
    state.y -= (2 + lead);
  }
  function para(s, { size = 9, font = fonts.reg, color = MUTED, width = PAGE.w - M.left - M.right } = {}) {
    for (const ln of wrap(s, font, size, width)) text(ln, { size, font, color });
  }
  function gap(h) { state.y -= h; }
  function line({ color = RULE, thickness = 0.6, x = M.left, w = PAGE.w - M.left - M.right } = {}) {
    room(6);
    state.y -= 4;
    state.page.drawLine({ start: { x, y: state.y }, end: { x: x + w, y: state.y }, thickness, color });
    state.y -= 2;
  }
  /* An anchor is drawn WHITE at 4pt: a human sees nothing, DocuSign finds the
     string. It is drawn at the CURRENT cursor so the tab lands on the blank
     immediately above it. */
  function anchor(a) {
    if (!a) return;
    state.page.drawText(a, { x: M.left, y: state.y + 1, size: 4, font: fonts.reg, color: WHITE });
  }
  return { ...state, newPage, room, text, para, gap, line, anchor,
    get page() { return state.page; }, get y() { return state.y; },
    get pageCount() { return state.pages.length; } };
}

function fmtValue(field, v) {
  const s = v == null ? '' : String(v).trim();
  if (!s) return '';
  if (field.type === 'money') {
    const n = Number(String(s).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : s;
  }
  if (field.type === 'date') {
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);      // a date-only value never goes through new Date()
    return m ? `${m[2]}/${m[3]}/${m[1]}` : s;
  }
  if (field.type === 'months') {
    const n = Number(s);
    return Number.isFinite(n) ? `${n} month${n === 1 ? '' : 's'}` : s;
  }
  return s;
}

/**
 * Build the PDF.
 *
 * @param {object} data   the form's own data — OUR half filled in, the landlord's absent
 * @returns {Promise<Buffer>}
 */
async function buildVorPdf(data = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle('Verification of Rent');
  doc.setProducer('PILOT by YS Capital');
  const fonts = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const c = makeCanvas(doc, fonts);
  const full = PAGE.w - M.left - M.right;

  // ── letterhead ────────────────────────────────────────────────────────────
  c.text(data.lender_name || LENDER_FALLBACK.name, { size: 15, font: fonts.bold });
  c.text(data.lender_address || LENDER_FALLBACK.address, { size: 8.5, color: MUTED });
  c.text(`NMLS #${data.lender_nmls || LENDER_FALLBACK.nmls}`, { size: 8.5, color: MUTED });
  c.gap(8);
  c.line({ color: GOLD, thickness: 1.2 });
  c.gap(10);
  c.text('VERIFICATION OF RENT', { size: 13, font: fonts.bold });
  c.gap(4);
  c.para('We are considering an application for a mortgage loan from the applicant named below, who has told '
    + 'us they rent the address shown. Their signed application authorises us to verify it. Please complete '
    + 'Part III and return this form. Nothing you tell us is shared with the applicant beyond what a lending '
    + 'decision requires.');
  c.gap(8);

  // ── the three parts ───────────────────────────────────────────────────────
  for (const part of F.PARTS) {
    const fields = F.FIELDS.filter((f) => f.part === part.key);
    if (!fields.length) continue;
    c.gap(6);
    c.text(`PART ${part.number} — ${part.title.toUpperCase()}`, { size: 10, font: fonts.bold, color: GOLD });
    c.para(part.blurb, { size: 8 });
    c.gap(4);

    for (const f of fields) {
      const value = data[f.key];
      if (f.who === 'us') {
        // A field we did not fill still PRINTS, with an em-dash stand-in, so the
        // landlord can see what we do not know rather than wondering what is hidden.
        if (f.optional && (value == null || String(value).trim() === '')) continue;
        c.room(14);
        c.y; // keep the cursor honest for the room() check above
        const label = `${f.label}:`;
        const lw = fonts.bold.widthOfTextAtSize(pdfSafe(label), 9);
        const startY = c.y;
        c.text(label, { size: 9, font: fonts.bold });
        c.page.drawText(pdfSafe(fmtValue(f, value) || '-'), {
          x: M.left + lw + 6, y: startY - 9, size: 9, font: fonts.reg, color: INK,
        });
        continue;
      }
      // The landlord's half: a label, a ruled blank, and the anchor under it.
      c.room(f.type === 'multiline' ? 46 : 26);
      c.text(`${f.label}${f.optional ? ' (optional)' : ''}`, { size: 9, font: fonts.bold });
      if (f.type === 'multiline') c.gap(24);
      else c.gap(10);
      c.anchor(F.anchorString(f));
      c.line({ color: RULE, w: f.type === 'multiline' ? full : Math.min(full, 300) });
      c.gap(4);
    }
  }

  // ── the closing paragraph ────────────────────────────────────────────────
  c.gap(10);
  c.line();
  c.gap(4);
  c.para('By signing above you confirm the information in Part III is true to the best of your knowledge. '
    + 'This form is used only to verify a rental history in connection with a mortgage application. '
    + `Questions: ${data.officer_name || 'our loan team'}`
    + (data.officer_email ? `, ${data.officer_email}` : '')
    + (data.officer_phone ? `, ${data.officer_phone}` : '') + '.', { size: 8 });

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

module.exports = { buildVorPdf, _internals: { pdfSafe, wrap, fmtValue, PAGE, M } };
