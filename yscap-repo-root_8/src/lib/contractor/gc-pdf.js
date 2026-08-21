'use strict';
/**
 * "GENERAL CONTRACTOR INFORMATION" — the one-page sheet that carries the GC record into
 * the investor package and the team site (owner-directed 2026-08-21: "in the TPR export
 * and in the SharePoint sync, you need to take this information and lay it out on a PDF
 * GC contractor information nicely to include in the invested delivery TPR export
 * SharePoint").
 *
 * PURE: data in, PDF bytes out. No database, no storage, no network — so the whole
 * layout can be exercised by a test without any of that, and the route that stores it
 * stays the only thing that knows where it goes.
 *
 * IT HOLDS NO RULES. What a GC record IS lives in ./gc-record.js and is passed in;
 * this file decides only where the words sit on the page. That split is why the field
 * list can never say one thing on the screen and another on the paper.
 *
 * IT REFUSES TO DRAW AN EMPTY SHEET. A page whose every line is a dash is worse than no
 * page at all: it looks like a document, says nothing, and would ride into an investor
 * package implying a contractor record exists. `hasAnything` decides; the caller is
 * expected to ask first, and this throws if it did not.
 *
 * PILOT's palette + the shared `pdfSafe` from the e-sign application PDF, so this sheet
 * and every other document PILOT draws look like they came from the same company — and
 * so a character WinAnsi cannot render can never come out as garbage.
 */
const path = require('path');
const { pdfSafe } = require('../esign/application-pdf');
const GC = require('./gc-record');

let _jsPDF = null;
function getJsPDF() {
  if (_jsPDF) return _jsPDF;
  const mod = require(path.join(__dirname, '..', '..', '..', 'web', 'tools', 'vendor', 'jspdf.umd.min.js'));
  _jsPDF = (mod && typeof mod.jsPDF === 'function') ? mod.jsPDF : (global.jspdf && global.jspdf.jsPDF);
  if (typeof _jsPDF !== 'function') { const e = new Error('PDF engine not loaded'); e.retryable = false; throw e; }
  return _jsPDF;
}

const nn = (v) => (v == null ? '' : String(v).trim());
/** MM/DD/YYYY from a calendar string — the format every other document here prints. */
function day(v) {
  const s = nn(v).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : '';
}
/** A date that has already passed, so the sheet can SAY SO rather than leave a reader to do the arithmetic. */
function isExpired(v, today) {
  const s = nn(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return s < (today || new Date().toISOString().slice(0, 10));
}

/**
 * @param {object} rec   the GC record (gc-record.loadForApplication shape)
 * @param {object} app   { loanNo, address, borrowerName }
 * @param {object} opts  { today } — injected so the expiry wording is testable
 * @returns {Buffer} PDF bytes
 */
function buildGcPdf(rec, app = {}, opts = {}) {
  if (!GC.hasAnything(rec)) {
    const e = new Error('There is nothing recorded about this contractor yet, so there is no sheet to make.');
    e.retryable = false;
    throw e;
  }
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const jsPDF = getJsPDF();
  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
  const W = doc.internal.pageSize.getWidth(), M = 44;
  const INK = [11, 16, 20], GOLD = [150, 123, 68], GRAY = [91, 103, 112], LINE = [228, 224, 214], BAD = [176, 74, 63];
  let y = 0;

  // ---- header, the same lockup every PILOT document carries ----
  doc.setFillColor.apply(doc, INK); doc.rect(0, 0, W, 74, 'F');
  doc.setTextColor(243, 239, 230); doc.setFont('times', 'bold'); doc.setFontSize(20);
  doc.text('PILOT', M, 40);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(201, 168, 106);
  doc.text('by YS Capital', M + 62, 40);
  doc.setTextColor(243, 239, 230); doc.setFont('times', 'bold'); doc.setFontSize(15);
  doc.text(pdfSafe('General Contractor Information'), W - M, 34, { align: 'right' });
  doc.setFont('times', 'italic'); doc.setFontSize(9); doc.setTextColor(201, 168, 106);
  doc.text(pdfSafe('Recorded on the loan file'), W - M, 50, { align: 'right' });
  y = 96;

  // ---- which loan this belongs to ----
  const idParts = [nn(app.loanNo) && `Loan #${nn(app.loanNo)}`, nn(app.address), nn(app.borrowerName)].filter(Boolean);
  if (idParts.length) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor.apply(doc, GRAY);
    doc.text(pdfSafe(idParts.join('   ·   ')), M, y);
    y += 18;
  }

  const rule = () => { doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.7); doc.line(M, y, W - M, y); y += 16; };
  const heading = (t) => {
    y += 6;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor.apply(doc, GOLD);
    doc.text(pdfSafe(String(t).toUpperCase()), M, y);
    y += 6; rule();
  };
  // A row prints ONLY when there is a value. An empty record is refused above, and a
  // blank field is simply absent — a page of dashes reads as a document that says
  // nothing, which is the one outcome worse than no page.
  const row = (label, value, flag) => {
    const v = nn(value);
    if (!v) return;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor.apply(doc, GRAY);
    doc.text(pdfSafe(label), M, y);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
    doc.setTextColor.apply(doc, flag ? BAD : INK);
    const lines = doc.splitTextToSize(pdfSafe(v + (flag ? '   (expired)' : '')), W - M - (M + 168));
    doc.text(lines, M + 168, y);
    y += Math.max(16, lines.length * 13);
  };

  heading('Contractor');
  row('Business name', rec.company_name);
  row('Contact', rec.contact_name);
  row('Phone', rec.phone || (Array.isArray(rec.phones) && rec.phones[0]) || '');
  row('Email', rec.email || (Array.isArray(rec.emails) && rec.emails[0]) || '');
  row('Address', rec.address);
  row('Website', rec.website);

  const lic = nn(rec.license_number) || nn(rec.license_state) || nn(rec.license_expires_on);
  if (lic) {
    heading('License');
    row('License number', rec.license_number);
    row('State', rec.license_state);
    row('Expires', day(rec.license_expires_on), isExpired(rec.license_expires_on, today));
  }

  const gl = nn(rec.gl_carrier) || nn(rec.gl_policy_number) || nn(rec.gl_expires_on);
  const wc = nn(rec.wc_carrier) || nn(rec.wc_policy_number) || nn(rec.wc_expires_on);
  if (gl || wc) {
    heading('Insurance');
    if (gl) {
      row('General liability', rec.gl_carrier);
      row('Policy #', rec.gl_policy_number);
      row('Expires', day(rec.gl_expires_on), isExpired(rec.gl_expires_on, today));
    }
    if (wc) {
      row("Workers' compensation", rec.wc_carrier);
      row('Policy #', rec.wc_policy_number);
      row('Expires', day(rec.wc_expires_on), isExpired(rec.wc_expires_on, today));
    }
  }

  if (nn(rec.ein)) { heading('Tax'); row('EIN (from the W-9)', rec.ein); }

  const notes = nn(rec.notes) || nn(rec.contact_notes);
  if (notes) {
    heading('Notes');
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor.apply(doc, INK);
    const lines = doc.splitTextToSize(pdfSafe(notes), W - M * 2);
    doc.text(lines, M, y); y += lines.length * 12 + 6;
  }

  // ---- footer: WHEN this was true, and that blanks are blanks ----
  y += 10; rule();
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.6); doc.setTextColor.apply(doc, GRAY);
  const asOf = day(today) || today;
  doc.text(pdfSafe(`Recorded in PILOT as of ${asOf}. A field that is blank was not recorded — it is not a statement that none exists.`), M, y);
  y += 11;
  doc.text(pdfSafe('PILOT by YS Capital  ·  NMLS #2609746'), M, y);

  return Buffer.from(doc.output('arraybuffer'));
}

module.exports = { buildGcPdf, _internals: { day, isExpired } };
