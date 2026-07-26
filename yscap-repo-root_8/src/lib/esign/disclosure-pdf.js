/**
 * esign/disclosure-pdf.js — the BORROWER BUSINESS-PURPOSE DISCLOSURE & CERTIFICATION,
 * rendered on the PILOT letterhead as a real PDF.
 *
 * Owner-directed (2026-07-20): "The business purpose disclosure should also be on
 * our letterhead of the PILOT letterhead." Previously this document was produced by
 * filling a Word mail-merge template (docgen.buildDisclosure) that DocuSign then
 * converted to PDF — plain, unbranded, and (like the Heter Iska) prone to shifting
 * on mobile. This renders it directly to a branded PDF, matching the auto-generated
 * loan application (application-pdf.js) so the whole term-sheet package carries one
 * consistent PILOT look.
 *
 * The LEGAL TEXT is preserved VERBATIM from the original template (the six numbered
 * certifications, the consumer-protection-law citations with their U.S.C. sections,
 * and the closing) — only the merge blanks («Loan_Number», «Loan_Amount», the
 * subject-property parts, the application date, and the borrower/co-borrower names)
 * are filled from the loan file. Nothing in the certification language is reworded.
 *
 * Invisible DocuSign anchors (white, 4pt) mark the signature/date slots so the send
 * engine's anchor tabs land on the right line for the right recipient:
 *   borrower    → /bpd_b1_sig/ + /bpd_b1_dt/
 *   co-borrower → /bpd_b2_sig/ + /bpd_b2_dt/   (only when a co-borrower is present)
 * These EXACTLY match orchestrate.tabsFor (prefix 'bpd'; borrower→b1, co→b2; the
 * admin counter-signer does NOT sign the disclosure).
 *
 * jsPDF runs in Node dependency-free (the same UMD bundle the browser tools use).
 * `pdfSafe`/`fit` are shared with application-pdf.js (Latin-1 sanitising — the § and
 * the U.S.C. citations are all Latin-1, so the legal text renders intact; the en-dash
 * in a section range folds to a hyphen). Returns a PDF Buffer (jsPDF writes text
 * uncompressed by default, so the anchor strings + field values stay greppable).
 *
 * `data` is the FLAT object orchestrate.loadDocGenData() returns:
 *   { loanNumber, applicationDate, executionDate, loanAmount,
 *     propStreet, propCity, propState, propZip,
 *     bFirst, bLast, hasCoBorrower, cbFirst, cbLast }
 */
const path = require('path');
const { pdfSafe, fit } = require('./application-pdf');

// Lazy jsPDF loader (mirrors application-pdf.js — the same UMD bundle, parsed only
// when a disclosure is actually generated so server boot stays light).
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

// ---- value formatting (kept 1:1 with docgen.js so the rendered figures match the
//      old mail-merge output exactly — a legal document must read the same) --------
function fmtMoney(n) {
  if (n == null) return '';           // a missing amount is blank, never a real-looking $0.00
  const v = Number(n);
  if (!isFinite(v)) return '';
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return '';
  // A date-only 'YYYY-MM-DD' string must NEVER go through new Date() (UTC day-shift /
  // the repo date-only rule) — format its parts directly.
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  }
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  // An instant renders on the BUSINESS calendar (America/New_York), never UTC.
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(dt).reduce((o, x) => ((o[x.type] = x.value), o), {});
  return `${p.month}/${p.day}/${p.year}`;
}

// ---- the VERBATIM legal text (only the bracketed blanks are filled) -------------
// Exported so a test can assert the certification language is preserved word-for-word.
const TITLE = 'BORROWER BUSINESS PURPOSE DISCLOSURE AND CERTIFICATION';
const INTRO = (appDate) =>
  `This BORROWER CERTIFICATION OF BUSINESS PURPOSE LOAN Borrower certifies the following representations in connection with the loan application dated ${appDate || '____________'}. The undersigned borrower(s) and, if applicable, guarantor (collectively the "Borrower") certifies and represents to YS Capital Group ("Lender") all of the following:`;
const P1 = (amt) =>
  `1. Borrower has applied for a loan in the estimated amount of $${amt} ("Loan"), which, if approved and closed, will be evidenced by a Promissory Note and will be secured by a Mortgage, Deed of Trust, or Security Deed ("Security Instrument") that will encumber the real property commonly known as`;
const P2 = '2. represents to Lender that the purpose of the Loan is solely for business or commercial purposes and not for any personal, family, or household purposes.';
const P3 = '3. Borrower acknowledges that all proceeds from the Loan are intended to be used solely for business or commercial purposes and not for any personal, family, or household purposes.';
const P4 = '4. The Property is not intended to be used as the principal or secondary residence of (i) the Borrower (including, for avoidance of doubt, any guarantors), or (ii) if the Borrower is not a natural person, any person who has a direct or indirect ownership interest in the Borrower.';
const P5 = '5. Certain consumer protection laws, including the Truth in Lending Act (15 U.S.C. § 1601 et seq.), Real Estate Settlement Procedures Act (12 U.S.C. § 2601 et seq.), Gramm-Leach Bliley Act (15 U.S.C. §§ 6802–6809), Secure and Fair Enforcement Mortgage Licensing Act (12 U.S.C. § 5601 et seq.) and Homeowners Protection Act (12 U.S.C. § 4901 et seq.), may not apply to this Loan if it is originated as a business-purpose loan.';
const P6 = '6. The Borrower acknowledges receipt of and understanding of this Borrower Disclosure and Certification of Business Purpose.';
const CLOSING = 'The Borrower hereby acknowledges and certifies the above representations as of the date below.';

/**
 * Build the Business-Purpose Disclosure & Certification PDF. Returns a PDF Buffer.
 * `data`: the flat orchestrate.loadDocGenData() output.
 */
function buildDisclosure(data = {}) {
  const jsPDF = getJsPDF();
  const co = !!data.hasCoBorrower;
  const loanNo = data.loanNumber || '';
  const amt = fmtMoney(data.loanAmount);
  const appDate = fmtDate(data.applicationDate);
  const execDate = fmtDate(data.executionDate || new Date());
  const bName = `${data.bFirst || ''} ${data.bLast || ''}`.trim();
  const cName = `${data.cbFirst || ''} ${data.cbLast || ''}`.trim();
  const propStreet = data.propStreet || '';
  const propCsz = [data.propCity, [data.propState, data.propZip].filter(Boolean).join(' ').trim()]
    .filter(Boolean).join(', ');

  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 46;
  const INK = [11, 16, 20], TEAL = [31, 58, 64], GOLD = [150, 123, 68], GRAY = [91, 103, 112],
    DARK = [19, 32, 28], BODY = [42, 50, 55], LINE = [228, 224, 214];
  const issued = (data.executionDate instanceof Date) ? data.executionDate
    : (data.executionDate ? new Date(data.executionDate) : new Date());
  const fmtLong = function (dt) {
    try { return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); }
    catch (_) { return ''; }
  };
  let y = 92;

  function header() {
    doc.setFillColor.apply(doc, INK); doc.rect(0, 0, W, 76, 'F');
    doc.setFillColor.apply(doc, GOLD); doc.rect(0, 76, W, 2.2, 'F');
    doc.setTextColor(243, 239, 230); doc.setFont('times', 'bold'); doc.setFontSize(20); doc.text('PILOT', M, 40);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(201, 168, 106); doc.text('by YS Capital', M + 62, 40);
    doc.setTextColor(243, 239, 230); doc.setFont('times', 'bold'); doc.setFontSize(15); doc.text('Business-Purpose Disclosure', W - M, 34, { align: 'right' });
    doc.setFont('times', 'italic'); doc.setFontSize(9.5); doc.setTextColor(201, 168, 106); doc.text('Borrower certification of business purpose', W - M, 50, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(170, 178, 182);
    doc.text(pdfSafe(LENDER.name + ' · NMLS ' + LENDER.nmls + (loanNo ? ' · Loan #' + loanNo : '') + ' · ' + fmtLong(issued)), W - M, 65, { align: 'right' });
  }
  function footer() {
    doc.setFontSize(7); doc.setTextColor(150, 158, 162); doc.setFont('helvetica', 'normal');
    doc.text(pdfSafe(LENDER.name + ' · NMLS ' + LENDER.nmls + ' · ' + LENDER.addr + ' · ' + LENDER.phone), M, H - 40, { maxWidth: W - 2 * M });
    doc.text(pdfSafe('This loan is applied for solely for business, commercial, or investment purposes and not for personal, family, or household use. This certification is a condition of the loan and is relied upon by the Lender.'), M, H - 26, { maxWidth: W - 2 * M });
  }
  function brk(need) { if (y + need > H - 56) { footer(); doc.addPage(); header(); y = 92; } }
  // A centered heading (the formal document title).
  function heading(t) {
    brk(30); doc.setFont('times', 'bold'); doc.setFontSize(13); doc.setTextColor.apply(doc, INK);
    const ls = doc.splitTextToSize(pdfSafe(t), W - 2 * M);
    for (const line of ls) { doc.text(line, W / 2, y + 10, { align: 'center' }); y += 16; }
    y += 4;
    doc.setDrawColor.apply(doc, GOLD); doc.setLineWidth(1.1); doc.line(W / 2 - 70, y, W / 2 + 70, y); y += 14;
  }
  // A justified-left body paragraph.
  function para(t, opts) {
    opts = opts || {};
    const size = opts.size || 9;
    const ls = doc.splitTextToSize(pdfSafe(t), W - 2 * M - (opts.indent || 0));
    const lh = size + 3.2;
    brk(ls.length * lh + 4);
    doc.setFont('helvetica', opts.bold ? 'bold' : 'normal'); doc.setFontSize(size);
    doc.setTextColor.apply(doc, opts.color || BODY);
    doc.text(ls, M + (opts.indent || 0), y + 8, opts.align === 'center' ? { align: 'center', maxWidth: W - 2 * M } : undefined);
    y += ls.length * lh + (opts.gap == null ? 7 : opts.gap);
  }
  // A key: value line (LOAN #).
  function kv(k, v) {
    brk(16); doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor.apply(doc, TEAL);
    doc.text(pdfSafe(k), M, y + 8);
    doc.setFont('helvetica', 'bold'); doc.setTextColor.apply(doc, DARK);
    doc.text(pdfSafe(fit(String(v == null ? '' : v), 48)), M + doc.getTextWidth(pdfSafe(k)) + 6, y + 8);
    y += 16;
  }
  // Invisible DocuSign anchor: white, tiny, machine-readable only.
  function anchor(tag, x, yy) { const ps = doc.getFontSize(); doc.setTextColor(255, 255, 255); doc.setFontSize(4); doc.text(tag, x, yy); doc.setFontSize(ps); doc.setTextColor.apply(doc, DARK); }
  // A full-width signature block: signature line (+ /prefix_sig/) with printed name,
  // then a date line (+ /prefix_dt/) the signer dates at signing.
  function sigBlock(roleLabel, who, prefix) {
    brk(96);
    const sigW = (W - 2 * M) * 0.56, gap = 24, dtX = M + sigW + gap, dtW = (W - 2 * M) - sigW - gap;
    doc.setDrawColor.apply(doc, GRAY); doc.setLineWidth(0.6);
    doc.line(M, y + 30, M + sigW, y + 30);
    anchor('/' + prefix + '_sig/', M + 2, y + 26);
    doc.line(dtX, y + 30, dtX + dtW, y + 30);
    anchor('/' + prefix + '_dt/', dtX + 2, y + 26);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.8); doc.setTextColor.apply(doc, GRAY);
    doc.text(pdfSafe(roleLabel + ' signature'), M, y + 41);
    doc.text('Date', dtX, y + 41);
    const nm = pdfSafe(fit(who, 48));
    if (/\S/.test(nm)) { doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor.apply(doc, DARK); doc.text(nm, M, y + 55); }
    y += 74;
  }

  header();
  y = 104;
  heading(TITLE);
  kv('LOAN #:', loanNo);
  y += 2;
  para(INTRO(appDate));
  y += 2;
  para(P1(amt), { gap: 4 });
  // The subject property, set off (bold, indented) between point 1 and its "(Property)" close.
  if (propStreet) para(propStreet, { bold: true, indent: 16, gap: 1, color: DARK, size: 9 });
  para(`${propCsz}${propCsz ? ' ' : ''}("Property").`, { bold: true, indent: 16, color: DARK, size: 9 });
  para(P2);
  para(P3);
  para(P4);
  para(P5);
  para(P6);
  y += 2;
  para(CLOSING);
  y += 6;
  para(`Dated: ${execDate}`, { bold: true, color: DARK, gap: 12 });

  sigBlock('Borrower', bName, 'bpd_b1');
  if (co) sigBlock('Co-Borrower / Guarantor', cName, 'bpd_b2');

  footer();
  return Buffer.from(doc.output('arraybuffer'));
}

module.exports = {
  buildDisclosure,
  // exported for tests / faithfulness assertions
  TITLE, INTRO, P1, P2, P3, P4, P5, P6, CLOSING, fmtMoney, fmtDate,
};
