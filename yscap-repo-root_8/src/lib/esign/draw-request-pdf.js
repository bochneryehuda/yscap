/**
 * esign/draw-request-pdf.js — the auto-generated DRAW REQUEST & WIRE INSTRUCTIONS
 * form (the `draw_request` e-sign package document).
 *
 * BUILT on our server (no stored source) from the loan file's own data, restructured
 * into PILOT branding from the owner's "DRAW REQUEST & WIRE INSTRUCTIONS FORM". Most
 * of the form auto-fills (property, loan number, borrowing entity, guarantor, contact)
 * — the borrower only fills the WIRE INSTRUCTIONS, which are FILLABLE DocuSign text
 * boxes (the anchors below match src/lib/esign/wire-tabs.js exactly) plus their
 * signature + date. On completion PILOT reads those typed values back
 * (orchestrate/webhook → draw-wire.js) and files the signed PDF to the draw condition.
 *
 * Invisible DocuSign anchors (white, tiny, machine-readable only):
 *   borrower signature/date → /dr_b1_sig/ + /dr_b1_dt/  (matches orchestrate.tabsFor 'dr'/b1)
 *   wire text boxes         → /dr_wire_.../               (from wire-tabs.WIRE_FIELDS)
 *
 * jsPDF runs in Node dependency-free (same UMD bundle the browser tools use), loaded
 * lazily. Returns a PDF Buffer (text uncompressed → anchors greppable in raw bytes).
 *
 * `data` is orchestrate.loadDocGenData() output; the draw-request view is derived from
 * `data.application` (already-formatted) + loan number/date. A bare application object
 * is also accepted (tests).
 */
const path = require('path');
const { WIRE_FIELDS } = require('./wire-tabs');

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
const DRAWS_EMAIL = 'draws@yscapgroup.com';
const DRAWS_PHONE = '(718) 635-0277';

// jsPDF's core font is Latin-1 only — strip anything it can't draw.
function pdfSafe(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/•/g, '*')
    .replace(/[^\x00-\xFF]/g, '');
}
function fit(s, max) { s = String(s == null ? '' : s); return s.length > max ? s.slice(0, max) + '...' : s; }

// The six borrower warranties, verbatim in spirit from the source form.
const CERTIFICATIONS = [
  'All contractors, subcontractors, and material suppliers for the work covered by this request have been (or upon receipt of this disbursement will be) paid in full for work completed to date, and the borrower will provide lien waivers upon request.',
  'The borrower is not in default under the loan or any loan document, and no event has occurred that with notice or the passage of time would become a default.',
  'All information provided in and with this draw request — including the wire instructions below — is true, complete, and correct.',
  'The person signing is duly authorized to request this disbursement and to provide the wire instructions on behalf of the borrower / borrowing entity.',
  'All conditions precedent to this disbursement under the loan documents have been satisfied.',
  'The borrower has no offsets, defenses, or counterclaims against the lender under the loan or any loan document.',
];

/**
 * Build the Draw Request & Wire Instructions PDF. Returns a PDF Buffer.
 * `data`: orchestrate.loadDocGenData() output (application view under `data.application`).
 */
function buildDrawRequest(data = {}) {
  const jsPDF = getJsPDF();
  const A = (data && data.application) ? data.application : (data || {});
  const b = A.b || {};
  const e = A.e || {};
  const p = A.p || {};
  const o = A.o || {};
  const loanNo = A.loanNo || (data && data.loanNumber) || '';
  const issued = (A.issued instanceof Date) ? A.issued : (A.issued ? new Date(A.issued) : new Date());

  // "Borrower (LLC/Corp)": the vesting entity when there is one, else the individual.
  const guarantorName = b.name || '';
  const borrowerEntity = e.name || guarantorName || '';

  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 40;
  const INK = [11, 16, 20], TEAL = [31, 58, 64], GOLD = [150, 123, 68], GRAY = [91, 103, 112], DARK = [19, 32, 28], LINE = [228, 224, 214];
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
    doc.setTextColor(243, 239, 230); doc.setFont('times', 'bold'); doc.setFontSize(16); doc.text('Draw Request & Wire Instructions', W - M, 34, { align: 'right' });
    doc.setFont('times', 'italic'); doc.setFontSize(9.5); doc.setTextColor(201, 168, 106); doc.text('Construction / rehab loan disbursement request', W - M, 50, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(170, 178, 182);
    doc.text(pdfSafe(LENDER.name + ' · NMLS ' + LENDER.nmls + (loanNo ? ' · Loan #' + loanNo : '') + ' · ' + fmtD(issued)), W - M, 65, { align: 'right' });
  }
  function footer() {
    doc.setFontSize(7.6); doc.setFont('helvetica', 'bold'); doc.setTextColor(60, 66, 72);
    doc.text(pdfSafe('Draw requests: ' + DRAWS_EMAIL + '  ·  ' + DRAWS_PHONE), M, H - 52);
    doc.setFontSize(7); doc.setTextColor(150, 158, 162); doc.setFont('helvetica', 'normal');
    doc.text(pdfSafe(LENDER.name + ' · NMLS ' + LENDER.nmls + ' · ' + LENDER.addr + ' · ' + LENDER.phone), M, H - 40, { maxWidth: W - 2 * M });
    doc.text(pdfSafe('Business-purpose loan disbursement request. The lender is not responsible for a wire misdirected due to incorrect account details supplied by the borrower; verify all wire information before signing.'), M, H - 26, { maxWidth: W - 2 * M });
  }
  function brk(need) { if (y + need > H - 58) { footer(); doc.addPage(); header(); y = 92; } }
  function band(t) {
    brk(30); doc.setFillColor.apply(doc, TEAL); doc.roundedRect(M, y, W - 2 * M, 17, 2.5, 2.5, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.2); doc.setTextColor(255, 255, 255);
    doc.text(pdfSafe(t.toUpperCase()), M + 7, y + 11.5); y += 23;
  }
  function rowFull(k, val, opts) {
    opts = opts || {}; const sv = pdfSafe(fit(String(val == null ? '' : val), 64));
    if (val == null || val === '' || !/\S/.test(sv)) return;
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
  function numbered(items) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.8); doc.setTextColor(70, 78, 82);
    items.forEach((t, i) => {
      const label = `(${['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii'][i] || (i + 1)})`;
      const ls = doc.splitTextToSize(pdfSafe(t), W - 2 * M - 30); brk(ls.length * 10 + 4);
      doc.setFont('helvetica', 'bold'); doc.setTextColor.apply(doc, TEAL); doc.text(label, M + 3, y + 8);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(70, 78, 82); doc.text(ls, M + 26, y + 8);
      y += ls.length * 10 + 6;
    });
  }
  // Invisible DocuSign anchor: white, tiny, machine-readable only.
  function anchor(tag, x, yy) { const ps = doc.getFontSize(); doc.setTextColor(255, 255, 255); doc.setFontSize(4); doc.text(tag, x, yy); doc.setFontSize(ps); doc.setTextColor.apply(doc, DARK); }
  // A borrower-FILLABLE wire row: label on the left, an empty ruled box on the right
  // with an invisible text anchor DocuSign turns into a typing box. `required` marks it.
  function wireRow(field) {
    brk(26);
    const labelW = 168;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.4); doc.setTextColor.apply(doc, DARK);
    doc.text(pdfSafe(field.label + (field.required ? ' *' : '')), M + 3, y + 12);
    // The box the borrower types into (a light rule under a clear band).
    const boxX = M + labelW, boxW = W - M - boxX - 3;
    doc.setDrawColor.apply(doc, GRAY); doc.setLineWidth(0.5); doc.line(boxX, y + 15, boxX + boxW, y + 15);
    anchor(field.anchor, boxX + 2, y + 12);
    y += 24;
  }
  function sigBlock(x, who, role, prefix) {
    const w = (W - 2 * M - 24) / 2;
    doc.setDrawColor.apply(doc, GRAY); doc.setLineWidth(0.6);
    doc.line(x, y + 34, x + w, y + 34);
    anchor('/' + prefix + '_sig/', x + 2, y + 30);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.6); doc.setTextColor.apply(doc, GRAY);
    doc.text(pdfSafe(role), x, y + 44);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.6); doc.setTextColor.apply(doc, DARK);
    const nm = pdfSafe(fit(who, 42)); if (/\S/.test(nm)) doc.text(nm, x, y + 57);
    doc.setDrawColor.apply(doc, GRAY); doc.line(x, y + 78, x + w, y + 78);
    anchor('/' + prefix + '_dt/', x + 2, y + 74);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.6); doc.setTextColor.apply(doc, GRAY);
    doc.text('Date', x, y + 88);
  }

  header();
  y = 92;
  // Intro line under the header.
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.2); doc.setTextColor.apply(doc, GRAY);
  doc.text(pdfSafe('Please review the pre-filled details below, complete your wire instructions, and sign. Draw requests: ' + DRAWS_EMAIL + '  ·  ' + DRAWS_PHONE), M, y, { maxWidth: W - 2 * M });
  y += 20;

  band('Property Information');
  rowFull('Property address', p.addr, { accent: true });
  rowFull('City / State / ZIP', p.csz);
  rowFull('Loan number', loanNo, { accent: true });

  band('Borrower Information');
  rowFull('Borrower (LLC / Corp)', borrowerEntity, { accent: true });
  rowFull('Guarantor name', guarantorName);

  band('Contact Information');
  rowFull('Primary contact name', guarantorName);
  rowFull('Best phone', b.phone);
  rowFull('Email', b.email);

  band('Submission Requirements');
  para('Retain and, upon request, provide copies of all paid invoices, receipts, and dated progress photos for the work covered by this draw. Lien waivers from contractors and material suppliers may be required before the disbursement is released. Funds are disbursed for completed work in accordance with the approved scope of work and budget.', 8);

  brk(30);
  band('Borrower Certification and Representations');
  para('By signing below, the borrower certifies and represents that:', 8);
  numbered(CERTIFICATIONS);

  brk(30 + WIRE_FIELDS.length * 24 + 40);
  band('Wire Instructions — to be completed by the borrower');
  para('Enter the bank account to receive this disbursement. This is the most important part — funds are sent exactly as entered here. Fields marked * are required.', 8);
  WIRE_FIELDS.forEach(wireRow);
  y += 4;
  doc.setFont('helvetica', 'italic'); doc.setFontSize(7.4); doc.setTextColor.apply(doc, GRAY);
  const noteLines = doc.splitTextToSize(pdfSafe('NOTE: The borrower is solely responsible for the accuracy of these wire instructions. The lender is not liable for funds misdirected because of incorrect account details supplied above. If the account name is a company other than the borrower or the property’s owning entity, additional documentation (e.g. that company’s operating agreement) will be required before funds are released.'), W - 2 * M - 6);
  brk(noteLines.length * 9 + 4);
  doc.text(noteLines, M + 3, y + 8); y += noteLines.length * 9 + 10;

  brk(140);
  band('Borrower Signature');
  sigBlock(M, guarantorName, 'Borrower / Guarantor signature', 'dr_b1');
  y += 100;

  footer();
  return Buffer.from(doc.output('arraybuffer'));
}

module.exports = { buildDrawRequest, pdfSafe, fit, CERTIFICATIONS };
