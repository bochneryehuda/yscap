/**
 * test-esign-application-pdf.js — unit tests for the auto-generated LOAN
 * APPLICATION document (src/lib/esign/application-pdf.js), exercised through the
 * docgen generate() contract. No database and no DocuSign: buildApplication is a
 * pure renderer over a passed-in data object (the shape orchestrate.loadDocGenData
 * returns). jsPDF writes text uncompressed by default, so the invisible DocuSign
 * anchors + the field values are greppable in the raw PDF bytes.
 *
 * Run: node scripts/test-esign-application-pdf.js
 */
const assert = require('assert');
const path = require('path');
const R = path.resolve(__dirname, '..');
const dg = require(R + '/src/lib/esign/docgen');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); n++; };

// A realistic loadDocGenData-shaped payload (the application view is pre-formatted).
function sampleData(withCo) {
  return {
    application: {
      loanNo: 'YS-2026-0412',
      issued: new Date('2026-07-19T12:00:00Z'),
      hasCo: !!withCo,
      b: {
        name: "Yaakov M O'Brien", dob: '03/12/1985', ssn: '123-45-6789',
        phone: '7185550147', email: 'yaakov@example.com', addr: '88 Maple Ave, Brooklyn, NY 11211',
      },
      c: withCo ? { name: "Rivka O'Brien", dob: '07/22/1987', ssn: '987-65-4321', email: 'rivka@example.com' } : null,
      e: { name: 'Maple Ridge Holdings LLC', type: 'Limited Liability Company', state: 'NJ', ein: '88-1234567', vesting: 'Maple Ridge Holdings LLC, a NJ LLC' },
      p: { addr: '742 Evergreen Terrace', csz: 'Lakewood, NJ 08701', type: '2-4 Unit Residential', units: '3', occ: 'Investment' },
      l: { prog: 'Gold Standard Program', type: 'Fix & Flip', amt: '$487,500', term: '12 months', rate: '10.99%',
           price: '$600,000', asis: '$600,000', arv: '$850,000', rehab: '$120,000', ltc: '85%', ltv: '57%', ir: '$12,000' },
      o: { name: 'David Klein', title: 'Senior Loan Officer', phone: '7186350277', email: 'dklein@yscapgroup.com', nmls: '1234567' },
    },
  };
}

// ---- 1. WITH a co-borrower ---------------------------------------------------
{
  const buf = dg.generate('application_export', sampleData(true));
  ok(Buffer.isBuffer(buf), 'generate(application_export) returns a Buffer');
  eq(buf.slice(0, 5).toString('latin1'), '%PDF-', 'buffer starts with %PDF');
  const text = buf.toString('latin1');
  ok(text.includes('/app_b1_sig/'), 'carries the borrower signature anchor /app_b1_sig/');
  ok(text.includes('/app_b1_dt/'), 'carries the borrower date anchor /app_b1_dt/');
  ok(text.includes('/app_b2_sig/'), 'carries the co-borrower signature anchor /app_b2_sig/');
  ok(text.includes('/app_b2_dt/'), 'carries the co-borrower date anchor /app_b2_dt/');
  ok(text.includes('YS-2026-0412'), 'shows the loan number');
  ok(text.includes("O'Brien"), 'shows the borrower name');
  ok(text.includes('742 Evergreen Terrace') || text.includes('Lakewood'), 'shows a subject-property token');
  ok(text.includes('487,500'), 'shows a loan-amount token');
  ok(text.includes('123-45-6789'), 'shows the borrower SSN (internal signed application)');
  ok(text.includes('Maple Ridge Holdings LLC'), 'shows the borrowing entity');
  ok(text.includes('Gold Standard Program'), 'shows the registered program');
  // Admin does NOT sign the application — no admin anchor is ever emitted here.
  ok(!text.includes('/app_admin_sig/'), 'no admin anchor on the application (admin does not sign it)');
}

// ---- 2. WITHOUT a co-borrower ------------------------------------------------
{
  const buf = dg.generate('application_export', sampleData(false));
  eq(buf.slice(0, 5).toString('latin1'), '%PDF-', 'solo: buffer starts with %PDF');
  const text = buf.toString('latin1');
  ok(text.includes('/app_b1_sig/'), 'solo: still carries the borrower anchor');
  ok(!text.includes('/app_b2_sig/'), 'solo: NO co-borrower signature anchor');
  ok(!text.includes('/app_b2_dt/'), 'solo: NO co-borrower date anchor');
  ok(text.includes("O'Brien"), 'solo: borrower still present');
}

// ---- 3. a bare application object (no `application` wrapper) is accepted ------
{
  const buf = dg.generate('application_export', sampleData(true).application);
  eq(buf.slice(0, 5).toString('latin1'), '%PDF-', 'bare application object: still a PDF');
  ok(buf.toString('latin1').includes('/app_b1_sig/'), 'bare application object: borrower anchor present');
}

// ---- 4. an EMPTY payload never throws (renders a blank-but-valid PDF) --------
{
  const buf = dg.generate('application_export', {});
  eq(buf.slice(0, 5).toString('latin1'), '%PDF-', 'empty payload: still a valid PDF (no throw)');
  ok(buf.toString('latin1').includes('/app_b1_sig/'), 'empty payload: borrower signature slot still drawn');
}

console.log(`\n✓ esign application PDF: ${n} assertions passed`);
