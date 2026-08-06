/**
 * esign/term-sheet-pdf.js — the FINAL term sheet, BUILT ON OUR SERVER.
 *
 * THE REPORT (owner-directed 2026-08-02, re-reported 2026-08-06): the term sheet
 * that goes out from the DocuSign package "still says NOT FINAL / initial only …
 * that button, once everything is clear, should take information from the last
 * registration and GENERATE the final term sheet." The prior design left the
 * term sheet as the ONE package document that was NOT generated on the server —
 * it re-used the studio's stored PDF (stamped "initial") and refused to send if
 * it wasn't already stamped final, relying on a fragile browser re-capture. So a
 * ready file could still dead-end on "you only have the initial one," and
 * re-registering just produced another initial (the loop the owner hit).
 *
 * THE FIX: the term sheet joins the application + disclosure + Heter Iska as a
 * document the SENDER builds fresh at send time (docgen.generate → BUILDERS), so
 * pressing Send always produces the FINAL. Products & Pricing keeps producing the
 * stored INITIAL for preview/record; the FINAL is only ever made here, from the
 * LAST REGISTRATION — exactly the owner's rule.
 *
 * PARITY IS NON-NEGOTIABLE (the frozen-number rules). This module is a PURE
 * RENDERER: every figure is sourced + formatted in orchestrate.loadDocGenData()
 * from the registered quote (product_registrations.quote — the frozen engine
 * output), assembled into `data.termsheet`, and merely DRAWN here. No engine is
 * re-run and no number is recomputed, so the sheet can never disagree with the
 * registration. (Same contract as application-pdf.js, whose `data.application`
 * view is likewise pre-formatted.)
 *
 * Invisible DocuSign anchors (white, 4pt) mark the signature/date slots so the
 * send engine's anchor tabs (orchestrate.tabsFor, prefix 'ts') land on the right
 * line for the right recipient:
 *   borrower     → /ts_b1_sig/ + /ts_b1_dt/
 *   co-borrower  → /ts_b2_sig/ + /ts_b2_dt/   (only when a co-borrower signs)
 *   loan officer → /ts_lo_sig/ + /ts_lo_dt/   (only when an officer is assigned)
 *   admin/lender → /ts_admin_sig/ + /ts_admin_dt/ (the routingOrder-2 countersign)
 * loadDocGenData builds `data.termsheet.signers` with EXACTLY buildRoster's logic,
 * so the anchors drawn here match the recipients seeded on the envelope.
 *
 * jsPDF runs in Node dependency-free (the same UMD bundle the browser tools use),
 * loaded lazily. Returns a PDF Buffer (uncompressed text, so the anchors + values
 * are greppable in the raw bytes — the send/verify path relies on that).
 */
const path = require('path');

// The jsPDF UMD bundle used by the browser tools (see application-pdf.js — the
// same lazy loader, so the boot never parses ~360KB until a doc is generated).
let _jsPDF = null;
function getJsPDF() {
  if (_jsPDF) return _jsPDF;
  const abs = path.join(__dirname, '..', '..', '..', 'web', 'tools', 'vendor', 'jspdf.umd.min.js');
  const mod = require(abs);
  _jsPDF = (mod && typeof mod.jsPDF === 'function') ? mod.jsPDF : (global.jspdf && global.jspdf.jsPDF);
  if (typeof _jsPDF !== 'function') { const e = new Error('PDF engine not loaded'); e.retryable = false; throw e; }
  return _jsPDF;
}

const LENDER = { name: 'YS Capital Group', nmls: '2609746' };

// jsPDF's core font is Latin-1 only — strip anything it can't draw (matches the
// studio tool's pdfSafe + application-pdf.js, so a name renders identically).
function pdfSafe(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/•/g, '*').replace(/→/g, '->')
    .replace(/[^\x00-\xFF]/g, '');
}
function fit(s, max) { s = String(s == null ? '' : s); return s.length > max ? s.slice(0, max) + '...' : s; }

/**
 * Build the FINAL term sheet PDF. Returns a PDF Buffer.
 * `data`: orchestrate.loadDocGenData() output — the term-sheet view under
 * `data.termsheet` (money/percent/dates already formatted there — this file only
 * draws). A missing view throws (a legal document must never render blank).
 */
function buildTermSheet(data = {}) {
  const jsPDF = getJsPDF();
  const T = data && data.termsheet;
  if (!T || typeof T !== 'object') { const e = new Error('No term-sheet data to render'); e.retryable = false; throw e; }
  const A = (data && data.application) || {};

  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 40;
  // The studio's warm ink/gold/teal system (web/v2/tools/termsheet.js) — matched so
  // the sent sheet reads like the one the owner previews.
  const INK = [20, 27, 34], TEAL = [47, 127, 134], GOLD = [174, 135, 70], GRAY = [75, 88, 92], DARK = [20, 27, 34], LINE = [223, 216, 203];
  const final = T.final !== false;   // default FINAL (the sender only runs once the send is authorized)
  const issued = new Date();
  const fmtD = (dt) => { try { return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); } catch (_) { return ''; } };
  let y = 92;

  function header() {
    doc.setFillColor.apply(doc, INK); doc.rect(0, 0, W, 76, 'F');
    doc.setFillColor.apply(doc, GOLD); doc.rect(0, 76, W, 2.2, 'F');
    doc.setTextColor(244, 240, 231); doc.setFont('times', 'bold'); doc.setFontSize(20); doc.text('PILOT', M, 40);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(201, 168, 106); doc.text('by YS Capital', M + 62, 40);
    doc.setTextColor(244, 240, 231); doc.setFont('times', 'bold'); doc.setFontSize(18);
    doc.text(final ? 'Final Term Sheet' : 'Preliminary Term Sheet', W - M, 35, { align: 'right' });
    doc.setFont('times', 'italic'); doc.setFontSize(9.5); doc.setTextColor(174, 135, 70);
    doc.text(pdfSafe((T.programName || 'Loan') + ' - business-purpose bridge financing'), W - M, 51, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(176, 184, 186);
    doc.text(pdfSafe(LENDER.name + ' - NMLS ' + LENDER.nmls + (A.loanNo ? ' - Loan #' + A.loanNo : '') + ' - Issued ' + fmtD(issued)), W - M, 65, { align: 'right' });
  }
  function footer() {
    doc.setFontSize(7); doc.setTextColor(150, 158, 162); doc.setFont('helvetica', 'normal');
    doc.text(pdfSafe('Indicative only - not a commitment or approval to lend. Subject to underwriting, appraisal, title and final credit approval. Not valid until countersigned by ' + LENDER.name + '.'), M, H - 26, { maxWidth: W - 2 * M });
    doc.setFontSize(6); doc.setTextColor.apply(doc, GRAY);
    doc.text(pdfSafe((final ? 'Final' : 'Initial') + ' term sheet - prepared ' + fmtD(issued)), W - M, H - 14, { align: 'right' });
  }
  function brk(need) { if (y + need > H - 54) { footer(); doc.addPage(); header(); y = 92; } }
  function band(t) {
    brk(30); doc.setFillColor.apply(doc, TEAL); doc.roundedRect(M, y, W - 2 * M, 17, 2.5, 2.5, 'F');
    doc.setFillColor.apply(doc, GOLD); doc.rect(M + 4, y + 4, 2.2, 9, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(255, 255, 255);
    doc.text(pdfSafe(String(t).toUpperCase()), M + 11, y + 11.5); y += 23;
  }
  // A key/value row — value right-aligned, empty values OMITTED (a legal doc never
  // shows a blank line). `accent` gives the headline totals the ivory band + gold value.
  function row(k, v, opts) {
    opts = opts || {}; const sv = pdfSafe(fit(String(v == null ? '' : v), 72));
    if (v == null || v === '' || !/\S/.test(sv)) return;
    brk(16);
    if (opts.accent) { doc.setFillColor(248, 245, 238); doc.rect(M + 1, y - 1.5, W - 2 * M - 2, 15, 'F'); }
    doc.setFont('helvetica', opts.bold ? 'bold' : 'normal'); doc.setFontSize(8.4); doc.setTextColor.apply(doc, GRAY);
    doc.text(pdfSafe(k), M + 3, y + 8);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.6); doc.setTextColor.apply(doc, opts.accent ? GOLD : DARK);
    doc.text(sv, W - M - 3, y + 8, { align: 'right' });
    y += 15; doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.4); doc.line(M + 3, y - 3.5, W - M - 3, y - 3.5);
  }
  function para(t, size) {
    const ls = doc.splitTextToSize(pdfSafe(t), W - 2 * M - 6); brk(ls.length * 10.5 + 4);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(size || 8); doc.setTextColor(70, 78, 82);
    doc.text(ls, M + 3, y + 8); y += ls.length * 10.5 + 8;
  }
  // Invisible DocuSign anchor: white, tiny, machine-readable only (matches application-pdf.js).
  function anchor(tag, x, yy) { const ps = doc.getFontSize(); doc.setTextColor(255, 255, 255); doc.setFontSize(4); doc.text(tag, x, yy); doc.setFontSize(ps); doc.setTextColor.apply(doc, DARK); }
  function sigBlock(x, w, who, role, prefix) {
    doc.setDrawColor.apply(doc, GRAY); doc.setLineWidth(0.6); doc.line(x, y + 34, x + w, y + 34);
    anchor('/' + prefix + '_sig/', x + 2, y + 30);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.6); doc.setTextColor.apply(doc, GRAY); doc.text(pdfSafe(role), x, y + 44);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.6); doc.setTextColor.apply(doc, DARK);
    const nm = pdfSafe(fit(who, 42)); if (/\S/.test(nm)) doc.text(nm, x, y + 57);
    doc.setDrawColor.apply(doc, GRAY); doc.line(x, y + 78, x + w, y + 78);
    anchor('/' + prefix + '_dt/', x + 2, y + 74);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.6); doc.setTextColor.apply(doc, GRAY); doc.text('Date', x, y + 88);
  }

  header();
  y = 92;

  // ---- Provenance FINAL stamp (right-aligned rounded rect under the header) ----
  (function () {
    const ac = final ? TEAL : GOLD;
    const bw = 168, bx = W - M - bw, by = 86, bh = final ? 30 : 40;
    doc.setFillColor(final ? 244 : 252, final ? 249 : 249, final ? 249 : 243);
    doc.setDrawColor.apply(doc, ac); doc.setLineWidth(1); doc.roundedRect(bx, by, bw, bh, 3, 3, 'FD');
    doc.setFillColor.apply(doc, ac); doc.rect(bx + 5, by + 5.5, 2.2, 8.4, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor.apply(doc, ac);
    doc.text(final ? 'FINAL TERM SHEET' : 'INITIAL TERM SHEET', bx + 11, by + 12.5);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor.apply(doc, GRAY);
    doc.text(pdfSafe(final ? 'Issued for signature from the loan file' : 'Draft - not for signature'), bx + 11, by + 21);
    if (!final) { doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.setTextColor.apply(doc, GOLD); doc.text('NOT FINAL', bx + 11, by + 31); }
    y = by + bh + 12;
  })();

  // ---- Recipient / parties block ----
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor.apply(doc, DARK);
  doc.text(pdfSafe(T.primaryName || 'Prospective Borrower'), M, y);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8.3); doc.setTextColor.apply(doc, GOLD);
  doc.text(pdfSafe(T.programName || ''), W - M, y, { align: 'right' }); y += 12.5;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor.apply(doc, GRAY);
  if (T.partiesSub) { doc.text(pdfSafe(fit(T.partiesSub, 120)), M, y); }
  if (T.purposeLine) { doc.text(pdfSafe(T.purposeLine), W - M, y, { align: 'right' }); }
  y += 12.5;
  if (T.propertyLine || T.validThrough) {
    doc.text(pdfSafe([T.propertyLine, T.validThrough].filter(Boolean).join('   -   ')), M, y); y += 6;
  }
  y += 8; doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.5); doc.line(M, y - 4, W - M, y - 4);

  // ---- HERO: loan amount + rate ----
  const heroH = 60;
  doc.setFillColor.apply(doc, DARK); doc.roundedRect(M, y, W - 2 * M, heroH, 4, 4, 'F');
  doc.setFillColor.apply(doc, GOLD); doc.rect(M, y + 4, 3.5, heroH - 8, 'F');
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.4); doc.setTextColor(176, 184, 186);
  doc.text('ESTIMATED TOTAL LOAN AMOUNT', M + 16, y + 17);
  doc.setFont('times', 'bold'); doc.setFontSize(25); doc.setTextColor(244, 240, 231);
  doc.text(pdfSafe(T.loanAmount || '-'), M + 16, y + 43);
  const rx = W - M - 16;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.2); doc.setTextColor(176, 184, 186);
  doc.text('NOTE RATE (INTEREST-ONLY)', rx, y + 17, { align: 'right' });
  doc.setFont('times', 'bold'); doc.setFontSize(17); doc.setTextColor(244, 240, 231);
  doc.text(pdfSafe(T.noteRate || '-'), rx, y + 40, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(176, 184, 186);
  doc.text(pdfSafe(T.termLine || ''), rx, y + 54, { align: 'right' });
  y += heroH + 16;

  // ---- Loan structure ----
  band('Loan structure');
  for (const r of (T.structureRows || [])) row(r.k, r.v, r.opts);

  // ---- Terms ----
  if ((T.termRows || []).length) { band('Terms'); for (const r of T.termRows) row(r.k, r.v, r.opts); }

  // ---- Disclosures page ----
  if ((T.disclosures || []).length) {
    footer(); doc.addPage(); header(); y = 92;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor.apply(doc, DARK); doc.text('Disclosures & conditions', M, y);
    doc.setDrawColor.apply(doc, GOLD); doc.setLineWidth(1.3); doc.line(M, y + 5.5, M + 42, y + 5.5); y += 18;
    para('The following supplements the terms above and forms part of this term sheet.', 8); y += 2;
    for (const it of T.disclosures) {
      if (!it || !it.body) continue;
      brk(38); doc.setFont('helvetica', 'bold'); doc.setFontSize(8.7); doc.setTextColor.apply(doc, TEAL);
      doc.text(pdfSafe(it.h || ''), M + 3, y + 8); y += 15; para(it.body, 8); y += 3;
    }
  }

  // ---- Signatures ----
  const signers = Array.isArray(T.signers) ? T.signers : [];
  brk(120); band('Signatures');
  const half = (W - 2 * M - 24) / 2;
  for (let i = 0; i < signers.length; i++) {
    const s = signers[i] || {};
    const col = i % 2;                         // two per row
    if (col === 0 && i > 0) y += 100;          // advance a row after every pair
    brk(100);
    const x = col === 0 ? M : (M + half + 24);
    sigBlock(x, half, s.name || '', s.role || 'Signature', s.prefix || 'ts_b1');
  }
  y += 100;

  footer();
  return Buffer.from(doc.output('arraybuffer'));
}

module.exports = { buildTermSheet, pdfSafe, fit };
