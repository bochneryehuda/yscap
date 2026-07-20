/**
 * esign/application-pdf.js — the auto-generated LOAN APPLICATION document.
 *
 * This is the `application_export` document in the term-sheet e-sign package. It
 * is BUILT on our server (no stored source PDF) from the loan file's own data —
 * the owner-approved layout in web/tools/loan-application-export.html, ported
 * verbatim in spirit to Node. It renders a branded "Business-Purpose Loan
 * Application" (PILOT / by YS Capital) showing every field the borrower/staff
 * entered — including the sensitive fields (SSN, DOB, entity, loan structure):
 * this is an INTERNAL signed application, not a borrower-anonymized surface.
 *
 * Invisible DocuSign anchors (white, 4pt) mark the signature/date slots so the
 * send engine's anchor tabs land on the right line for the right recipient:
 *   borrower    → /app_b1_sig/ + /app_b1_dt/
 *   co-borrower → /app_b2_sig/ + /app_b2_dt/   (only when a co-borrower is present)
 * These EXACTLY match orchestrate.tabsFor (prefix 'app'; borrower→b1, co→b2;
 * the admin counter-signer does NOT sign the application).
 *
 * jsPDF runs in Node dependency-free (the same UMD bundle the browser tools use).
 * Loaded lazily so the server boot doesn't parse ~360KB until an application is
 * actually generated. Returns a PDF Buffer (jsPDF writes text uncompressed by
 * default, so the anchor strings + field values are greppable in the raw bytes).
 *
 * `data` is the object orchestrate.loadDocGenData() returns; the application view
 * lives under `data.application` (money/percent/dates already formatted there —
 * this module is a pure renderer, mirroring the HTML's gather()→build() split).
 */
const path = require('path');

// The jsPDF UMD bundle used by the browser tools. Node require of the UMD file
// returns the module object with `.jsPDF`; if a future bundle only registers on
// the global instead, fall back to global.jspdf.jsPDF (per the build spec).
let _jsPDF = null;
function getJsPDF() {
  if (_jsPDF) return _jsPDF;
  const abs = path.join(__dirname, '..', '..', '..', 'web', 'tools', 'vendor', 'jspdf.umd.min.js');
  const mod = require(abs);
  _jsPDF = (mod && typeof mod.jsPDF === 'function') ? mod.jsPDF
    : (global.jspdf && global.jspdf.jsPDF);
  if (typeof _jsPDF !== 'function') { const e = new Error('PDF engine not loaded'); e.retryable = false; throw e; }
  return _jsPDF;
}

const LENDER = { name: 'YS Capital Group', nmls: '2609746', addr: '5 New Montrose Avenue, Brooklyn, NY 11211', phone: '(718) 635-0277' };

// jsPDF's core font is Latin-1 only — strip anything it can't draw (a fully
// non-Latin legal name strips to empty and its row is omitted rather than drawn
// blank; the Hebrew Heter Iska is handled by the docx path, not here).
function pdfSafe(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/•/g, '*')
    .replace(/[^\x00-\xFF]/g, '');
}
// Single-line truncation so long officer/vesting/address values can't overflow.
function fit(s, max) { s = String(s == null ? '' : s); return s.length > max ? s.slice(0, max) + '...' : s; }

/**
 * Build the Business-Purpose Loan Application PDF. Returns a PDF Buffer.
 * `data`: orchestrate.loadDocGenData() output (application view under
 * `data.application`); a bare application object is also accepted.
 */
function buildApplication(data = {}) {
  const jsPDF = getJsPDF();
  const A = (data && data.application) ? data.application : (data || {});
  const b = A.b || {};
  const c = A.hasCo && A.c ? A.c : null;
  const e = A.e || {};
  const p = A.p || {};
  const l = A.l || {};
  const o = A.o || {};

  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 40;
  const INK = [11, 16, 20], TEAL = [31, 58, 64], GOLD = [150, 123, 68], GRAY = [91, 103, 112], DARK = [19, 32, 28], LINE = [228, 224, 214];
  const loanNo = A.loanNo || '';
  const issued = (A.issued instanceof Date) ? A.issued : (A.issued ? new Date(A.issued) : new Date());
  const fmtD = function (dt) {
    try { return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); }
    catch (_) { return ''; }
  };
  let y = 92;

  function header() {
    doc.setFillColor.apply(doc, INK); doc.rect(0, 0, W, 76, 'F');
    doc.setFillColor.apply(doc, GOLD); doc.rect(0, 76, W, 2.2, 'F');
    doc.setTextColor(243, 239, 230); doc.setFont('times', 'bold'); doc.setFontSize(20); doc.text('PILOT', M, 40);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(201, 168, 106); doc.text('by YS Capital', M + 62, 40);
    doc.setTextColor(243, 239, 230); doc.setFont('times', 'bold'); doc.setFontSize(16); doc.text('Business-Purpose Loan Application', W - M, 34, { align: 'right' });
    doc.setFont('times', 'italic'); doc.setFontSize(9.5); doc.setTextColor(201, 168, 106); doc.text('Investment / business-purpose mortgage loan', W - M, 50, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(170, 178, 182);
    doc.text(pdfSafe(LENDER.name + ' · NMLS ' + LENDER.nmls + (loanNo ? ' · Loan #' + loanNo : '') + ' · ' + fmtD(issued)), W - M, 65, { align: 'right' });
  }
  function footer() {
    if (o && (o.name || o.phone || o.email)) {
      doc.setFontSize(7.6); doc.setFont('helvetica', 'bold'); doc.setTextColor(60, 66, 72);
      doc.text(pdfSafe(fit('Your loan officer: ' + o.name + (o.title ? ', ' + o.title : '') + (o.phone ? '  ·  ' + o.phone : '') + (o.email ? '  ·  ' + o.email : '') + (o.nmls ? '  ·  NMLS ' + o.nmls : ''), 118)), M, H - 52);
    }
    doc.setFontSize(7); doc.setTextColor(150, 158, 162); doc.setFont('helvetica', 'normal');
    doc.text(pdfSafe(LENDER.name + ' · NMLS ' + LENDER.nmls + ' · ' + LENDER.addr + ' · ' + LENDER.phone), M, H - 40, { maxWidth: W - 2 * M });
    doc.text(pdfSafe('This loan is applied for solely for business, commercial, or investment purposes and not for personal, family, or household use. Indicative application only — not a commitment to lend. Subject to underwriting, appraisal, title and final credit approval.'), M, H - 26, { maxWidth: W - 2 * M });
  }
  function brk(need) { if (y + need > H - 56) { footer(); doc.addPage(); header(); y = 92; } }
  function band(t) {
    brk(30); doc.setFillColor.apply(doc, TEAL); doc.roundedRect(M, y, W - 2 * M, 17, 2.5, 2.5, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.2); doc.setTextColor(255, 255, 255);
    doc.text(pdfSafe(t.toUpperCase()), M + 7, y + 11.5); y += 23;
  }
  function rowFull(k, val, opts) {
    opts = opts || {}; const sv = pdfSafe(fit(String(val == null ? '' : val), 64));
    if (val == null || val === '' || !/\S/.test(sv)) return;   // omit truly-empty rows
    brk(16); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.4); doc.setTextColor.apply(doc, GRAY);
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
  // Invisible DocuSign anchor: white, tiny, machine-readable only.
  function anchor(tag, x, yy) { const ps = doc.getFontSize(); doc.setTextColor(255, 255, 255); doc.setFontSize(4); doc.text(tag, x, yy); doc.setFontSize(ps); doc.setTextColor.apply(doc, DARK); }
  function sigBlock(x, who, role, prefix) {
    const w = (W - 2 * M - 24) / 2;
    doc.setDrawColor.apply(doc, GRAY); doc.setLineWidth(0.6);
    doc.line(x, y + 34, x + w, y + 34);
    anchor('/' + prefix + '_sig/', x + 2, y + 30);                 // signature slot
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.6); doc.setTextColor.apply(doc, GRAY);
    doc.text(pdfSafe(role), x, y + 44);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.6); doc.setTextColor.apply(doc, DARK);
    const nm = pdfSafe(fit(who, 42)); if (/\S/.test(nm)) doc.text(nm, x, y + 57);
    doc.setDrawColor.apply(doc, GRAY); doc.line(x, y + 78, x + w, y + 78);
    anchor('/' + prefix + '_dt/', x + 2, y + 74);                  // date slot
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.6); doc.setTextColor.apply(doc, GRAY);
    doc.text('Date', x, y + 88);
  }

  header();
  // "Prepared by <officer>" ribbon (only when we know the officer).
  (function () {
    if (!(o && (o.name || o.phone))) return;
    doc.setFillColor(246, 243, 236); doc.rect(0, 78.2, W, 19, 'F');
    doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.5); doc.line(0, 97.2, W, 97.2);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor.apply(doc, TEAL);
    doc.text(pdfSafe(fit('Prepared by ' + (o.name || '') + (o.title ? ', ' + o.title : ''), 52)), M, 91);
    doc.setFont('helvetica', 'normal'); doc.setTextColor.apply(doc, GRAY);
    doc.text(pdfSafe(fit((o.phone || '') + (o.email ? '   ·   ' + o.email : '') + (o.nmls ? '   ·   NMLS ' + o.nmls : ''), 50)), W - M, 91, { align: 'right' });
  })();
  y = 108;

  band('Borrower');
  rowFull('Full legal name', b.name);
  rowFull('Date of birth', b.dob);
  rowFull('Social Security number', b.ssn);
  rowFull('Phone', b.phone);
  rowFull('Email', b.email);
  rowFull('Primary / mailing address', b.addr);

  if (c) {
    band('Co-Borrower / Guarantor');
    rowFull('Full legal name', c.name);
    rowFull('Date of birth', c.dob);
    rowFull('Social Security number', c.ssn);
    rowFull('Email', c.email);
  }

  band('Borrowing Entity');
  rowFull('Entity (LLC) name', e.name, { accent: true });
  rowFull('Entity type', e.type);
  rowFull('State of formation', e.state);
  rowFull('EIN', e.ein);
  rowFull('Vesting', e.vesting);

  band('Subject Property');
  rowFull('Address', p.addr);
  rowFull('City / State / ZIP', p.csz);
  rowFull('Property type', p.type);
  rowFull('Units', p.units);
  rowFull('Occupancy', p.occ);

  band('Loan Request & Structure');
  rowFull('Program', l.prog, { accent: true });
  rowFull('Loan purpose / type', l.type);
  rowFull('Loan amount applied for', l.amt, { accent: true });
  rowFull('Term', l.term);
  rowFull('Note rate', l.rate);
  rowFull('Purchase price', l.price);
  rowFull('As-is value', l.asis);
  rowFull('After-repair value (ARV)', l.arv);
  rowFull('Rehab budget', l.rehab);
  rowFull('Loan-to-cost (LTC)', l.ltc);
  rowFull('Loan-to-ARV', l.ltv);
  rowFull('Financed interest reserve', l.ir);

  brk(84);
  band('Business-Purpose Acknowledgment');
  para('The undersigned applies for the above loan solely for business, commercial, or investment purposes and not for personal, family, or household use. The subject property is and will remain non-owner-occupied. The undersigned certifies that the information provided in this application is true, complete, and correct.', 8);

  brk(140);   // reserve band + both signature blocks so the header can't orphan
  band('Signatures');
  sigBlock(M, b.name, 'Borrower signature', 'app_b1');
  if (c) sigBlock(M + (W - 2 * M - 24) / 2 + 24, c.name, 'Co-Borrower / Guarantor signature', 'app_b2');
  y += 100;

  footer();   // the signature page must carry the NMLS + business-purpose disclosure
  return Buffer.from(doc.output('arraybuffer'));
}

module.exports = { buildApplication, pdfSafe, fit };
