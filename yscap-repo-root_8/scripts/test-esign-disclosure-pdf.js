/**
 * test-esign-disclosure-pdf.js — unit tests for the BUSINESS-PURPOSE DISCLOSURE &
 * CERTIFICATION document, now rendered on the PILOT letterhead as a real PDF
 * (src/lib/esign/disclosure-pdf.js), exercised through the docgen generate()
 * contract. No database and no DocuSign: buildDisclosure is a pure renderer over the
 * flat data object orchestrate.loadDocGenData returns. jsPDF writes text uncompressed
 * by default, so the invisible DocuSign anchors + field values + the legal text are
 * greppable in the raw PDF bytes.
 *
 * The legal certification language must be preserved VERBATIM from the prior Word
 * template — these tests pin every numbered certification + the U.S.C. citations so a
 * future edit can't silently reword the disclosure.
 *
 * Run: node scripts/test-esign-disclosure-pdf.js
 */
const assert = require('assert');
const path = require('path');
const R = path.resolve(__dirname, '..');
const dg = require(R + '/src/lib/esign/disclosure-pdf');
const docgen = require(R + '/src/lib/esign/docgen');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); n++; };

const SAMPLE = {
  loanNumber: 'YSCAP-2026-0412', applicationDate: '2026-06-01', executionDate: '2026-07-19',
  loanAmount: 1287500.5, propStreet: '392 Columbia Ave Unit 2B', propCity: 'Lakewood',
  propState: 'NJ', propZip: '08701', bFirst: 'Yaakov M', bLast: "O'Brien",
  hasCoBorrower: true, cbFirst: 'Rivka', cbLast: "O'Brien",
};

// ---- 1. the docgen package wiring now emits a PDF (not a docx) ----------------
{
  const buf = docgen.generate('bp_disclosure', SAMPLE);
  ok(Buffer.isBuffer(buf), "generate('bp_disclosure') returns a Buffer");
  eq(buf.slice(0, 5).toString('latin1'), '%PDF-', 'disclosure is now a real PDF (branded), not a .docx');
}

// ---- 2. WITH a co-borrower: anchors, fields, filled blanks --------------------
{
  const buf = dg.buildDisclosure(SAMPLE);
  eq(buf.slice(0, 5).toString('latin1'), '%PDF-', 'buffer starts with %PDF');
  const t = buf.toString('latin1');
  for (const a of ['/bpd_b1_sig/', '/bpd_b1_dt/', '/bpd_b2_sig/', '/bpd_b2_dt/'])
    ok(t.includes(a), `carries anchor ${a}`);
  // Admin does NOT sign the disclosure.
  ok(!t.includes('/bpd_admin_sig/'), 'no admin anchor on the disclosure');
  for (const v of ['YSCAP-2026-0412', '1,287,500.50', '392 Columbia Ave', 'Lakewood', 'NJ', '08701', 'Yaakov M', "O'Brien", 'Rivka'])
    ok(t.includes(v), `shows filled value "${v}"`);
  ok(t.includes('06/01/2026'), 'shows the application date (M/D/Y, no day-shift)');
  ok(t.includes('07/19/2026'), 'shows the execution date');
}

// ---- 3. WITHOUT a co-borrower: no b2 anchors, borrower intact -----------------
{
  const buf = dg.buildDisclosure({ ...SAMPLE, hasCoBorrower: false, cbFirst: '', cbLast: '' });
  eq(buf.slice(0, 5).toString('latin1'), '%PDF-', 'solo: still a PDF');
  const t = buf.toString('latin1');
  ok(t.includes('/bpd_b1_sig/') && t.includes('/bpd_b1_dt/'), 'solo: borrower anchors present');
  ok(!t.includes('/bpd_b2_sig/') && !t.includes('/bpd_b2_dt/'), 'solo: NO co-borrower anchors');
  ok(t.includes('Yaakov M') && t.includes("O'Brien"), 'solo: borrower still present');
}

// ---- 4. the LEGAL certification text is preserved VERBATIM --------------------
// Pin the exact language (constants the renderer draws from) so no future edit can
// silently reword a legal certification.
{
  eq(dg.TITLE, 'BORROWER BUSINESS PURPOSE DISCLOSURE AND CERTIFICATION', 'title verbatim');
  ok(dg.INTRO('06/01/2026').includes('in connection with the loan application dated 06/01/2026'), 'intro references the application date');
  ok(dg.INTRO('x').includes('collectively the "Borrower") certifies and represents to YS Capital Group ("Lender")'), 'intro names the Lender verbatim');
  ok(dg.P1('487,500.00').includes('applied for a loan in the estimated amount of $487,500.00 ("Loan")'), 'point 1: loan-amount clause verbatim');
  ok(dg.P1('x').includes('Promissory Note') && dg.P1('x').includes('Deed of Trust, or Security Deed ("Security Instrument")'), 'point 1: instrument language verbatim');
  ok(dg.P2.startsWith('2. represents to Lender that the purpose of the Loan is solely for business or commercial purposes'), 'point 2 verbatim (incl. the source wording)');
  ok(dg.P3.includes('all proceeds from the Loan are intended to be used solely for business or commercial purposes'), 'point 3 verbatim');
  ok(dg.P4.includes('not intended to be used as the principal or secondary residence') && dg.P4.includes('direct or indirect ownership interest in the Borrower'), 'point 4 verbatim');
  // The consumer-protection citations, each with its U.S.C. section, must be exact.
  ok(dg.P5.includes('Truth in Lending Act (15 U.S.C. § 1601 et seq.)'), 'point 5: TILA citation verbatim');
  ok(dg.P5.includes('Real Estate Settlement Procedures Act (12 U.S.C. § 2601 et seq.)'), 'point 5: RESPA citation verbatim');
  ok(dg.P5.includes('Gramm-Leach Bliley Act (15 U.S.C. §§ 6802–6809)'), 'point 5: GLBA citation verbatim');
  ok(dg.P5.includes('Secure and Fair Enforcement Mortgage Licensing Act (12 U.S.C. § 5601 et seq.)'), 'point 5: SAFE Act citation verbatim');
  ok(dg.P5.includes('Homeowners Protection Act (12 U.S.C. § 4901 et seq.)'), 'point 5: HPA citation verbatim');
  ok(dg.P5.includes('may not apply to this Loan if it is originated as a business-purpose loan'), 'point 5: closing clause verbatim');
  ok(dg.P6.includes('acknowledges receipt of and understanding of this Borrower Disclosure and Certification of Business Purpose'), 'point 6 verbatim');
  ok(dg.CLOSING === 'The Borrower hereby acknowledges and certifies the above representations as of the date below.', 'closing verbatim');
}

// ---- 5. rendered PDF actually contains the distinctive legal words ------------
{
  const t = dg.buildDisclosure(SAMPLE).toString('latin1');
  for (const w of ['Promissory', 'residence', 'Homeowners', 'Certification', 'business-purpose'])
    ok(t.includes(w), `rendered PDF contains legal word "${w}"`);
  ok(t.includes('§'), 'rendered PDF contains the U.S.C. section symbol (§ is Latin-1)');
}

// ---- 6. money/date formatters match docgen (figures read identically) --------
{
  eq(dg.fmtMoney(1287500.5), '1,287,500.50', 'money: commas + 2 decimals (matches docgen)');
  eq(dg.fmtMoney(null), '', 'money: null → empty (never a real-looking $0.00 on a legal doc)');
  process.env.TZ = 'America/New_York';
  eq(dg.fmtDate('2026-06-01'), '06/01/2026', 'date-only string: no day-shift');
  eq(dg.fmtDate(new Date('2026-06-01T02:00:00Z')), '05/31/2026', 'evening-ET instant → ET day, not UTC tomorrow');
  eq(dg.fmtDate(null), '', 'date: null → empty');
}

// ---- 7. an EMPTY / minimal payload never throws (valid PDF, slots drawn) ------
{
  const buf = dg.buildDisclosure({});
  eq(buf.slice(0, 5).toString('latin1'), '%PDF-', 'empty payload: still a valid PDF (no throw)');
  ok(buf.toString('latin1').includes('/bpd_b1_sig/'), 'empty payload: borrower signature slot still drawn');
}

console.log(`\n✓ esign disclosure PDF: ${n} assertions passed`);
