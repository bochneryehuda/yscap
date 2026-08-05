/**
 * test-esign-noo-affidavit-pdf.js — unit tests for the NON-OWNER-OCCUPIED
 * CERTIFICATION (src/lib/esign/noo-affidavit-pdf.js), exercised through the docgen
 * generate() contract AND the orchestrate package spec / validateGenerated. No
 * database and no DocuSign: buildNooAffidavit is a pure renderer over the flat data
 * object orchestrate.loadDocGenData returns. jsPDF writes text uncompressed by
 * default, so the invisible DocuSign anchors + field values + the certification text
 * are greppable in the raw PDF bytes.
 *
 * Owner-directed 2026-08: "Certification (e-sign, no notary)". The certification
 * language is pinned VERBATIM so a future edit can't silently reword a legal document.
 *
 * Run: node scripts/test-esign-noo-affidavit-pdf.js
 */
const assert = require('assert');
const path = require('path');
const R = path.resolve(__dirname, '..');
const noo = require(R + '/src/lib/esign/noo-affidavit-pdf');
const docgen = require(R + '/src/lib/esign/docgen');
const orch = require(R + '/src/lib/esign/orchestrate');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); n++; };

const SAMPLE = {
  loanNumber: 'YSCAP-2026-0412', applicationDate: '2026-06-01', executionDate: '2026-07-19',
  propStreet: '392 Columbia Ave Unit 2B', propCity: 'Lakewood', propState: 'NJ', propZip: '08701',
  bFirst: 'Yaakov M', bLast: "O'Brien", hasCoBorrower: true, cbFirst: 'Rivka', cbLast: "O'Brien",
  cbEmail: 'rivka@example.com',
};

// ---- 1. docgen package wiring emits a PDF -------------------------------------
{
  const buf = docgen.generate('noo_affidavit', SAMPLE);
  ok(Buffer.isBuffer(buf), "generate('noo_affidavit') returns a Buffer");
  eq(buf.slice(0, 5).toString('latin1'), '%PDF-', 'certification is a real branded PDF');
  ok(typeof docgen.buildNooAffidavit === 'function', 'docgen exports buildNooAffidavit');
}

// ---- 2. WITH a co-borrower: both individuals sign ----------------------------
{
  const buf = noo.buildNooAffidavit(SAMPLE);
  eq(buf.slice(0, 5).toString('latin1'), '%PDF-', 'buffer starts with %PDF');
  const t = buf.toString('latin1');
  for (const a of ['/noo_b1_sig/', '/noo_b1_dt/', '/noo_b2_sig/', '/noo_b2_dt/'])
    ok(t.includes(a), `carries anchor ${a}`);
  // No admin counter-signer, no loan-officer, no notary on the certification.
  ok(!t.includes('/noo_admin_sig/') && !t.includes('/noo_lo_sig/'), 'no admin/LO anchor on the certification');
  for (const v of ['YSCAP-2026-0412', '392 Columbia Ave', 'Lakewood', 'NJ', '08701', 'Yaakov M', "O'Brien", 'Rivka'])
    ok(t.includes(v), `shows filled value "${v}"`);
  ok(t.includes('06/01/2026'), 'shows the application date (M/D/Y, no day-shift)');
  ok(t.includes('07/19/2026'), 'shows the execution date');
  // The prefix's suffix mapping MUST match orchestrate.tabsFor (borrower→b1, co→b2).
  const tabs = orch.tabsFor('borrower', orch.PACKAGES.noo_affidavit, { noo_affidavit: 1 });
  eq(tabs[1].sign[0], '/noo_b1_sig/', 'tabsFor borrower anchor matches the PDF (b1)');
  const cotabs = orch.tabsFor('co_borrower', orch.PACKAGES.noo_affidavit, { noo_affidavit: 1 });
  eq(cotabs[1].sign[0], '/noo_b2_sig/', 'tabsFor co-borrower anchor matches the PDF (b2)');
}

// ---- 3. WITHOUT a co-borrower: no b2 anchors ---------------------------------
{
  const buf = noo.buildNooAffidavit({ ...SAMPLE, hasCoBorrower: false, cbFirst: '', cbLast: '' });
  const t = buf.toString('latin1');
  ok(t.includes('/noo_b1_sig/') && t.includes('/noo_b1_dt/'), 'solo: borrower anchors present');
  ok(!t.includes('/noo_b2_sig/') && !t.includes('/noo_b2_dt/'), 'solo: NO co-borrower anchors');
  ok(t.includes('Yaakov M') && t.includes("O'Brien"), 'solo: borrower still present');
}

// ---- 4. certification text preserved VERBATIM --------------------------------
{
  eq(noo.TITLE, 'NON-OWNER-OCCUPIED CERTIFICATION', 'title verbatim');
  ok(noo.INTRO('06/01/2026').includes('connection with the loan application dated 06/01/2026'), 'intro references the application date');
  ok(noo.INTRO('x').includes('certifies and represents to YS Capital Group ("Lender")'), 'intro names the Lender verbatim');
  ok(noo.P1.includes('solely for business, commercial, or investment purposes and not for any personal, family, or household purposes'), 'point 1: business-purpose verbatim');
  ok(noo.P2.includes('will not at any time during the term of the Loan occupy, the Property as a primary residence'), 'point 2: no-occupancy verbatim');
  ok(noo.P3.includes('direct or indirect ownership interest in the Borrower') && noo.P3.includes('immediate family'), 'point 3: related-party verbatim');
  ok(noo.P4.includes('held solely for investment purposes') && noo.P4.includes('not, and will not be, the homestead'), 'point 4: investment/homestead verbatim');
  ok(noo.P5.includes('will not enter into, any agreement, oral or written'), 'point 5: no-side-agreement verbatim');
  ok(noo.P6.includes('material inducement to making the Loan') && noo.P6.includes('mortgage fraud'), 'point 6: reliance/fraud verbatim');
  eq(noo.CLOSING, 'The Borrower hereby certifies the above representations as of the date below.', 'closing verbatim');
  // No notary language anywhere (owner: e-sign, NO notary).
  const all = [noo.TITLE, noo.INTRO('x'), noo.P1, noo.P2, noo.P3, noo.P4, noo.P5, noo.P6, noo.CLOSING].join(' ').toLowerCase();
  ok(!/notary|sworn|jurat|acknowledged before me|state of .* county of/.test(all), 'certification carries NO notary/jurat language');
}

// ---- 5. rendered PDF contains distinctive certification words -----------------
{
  const t = noo.buildNooAffidavit(SAMPLE).toString('latin1');
  for (const w of ['occupancy', 'investment', 'homestead', 'residence', 'certification'])
    ok(t.toLowerCase().includes(w), `rendered PDF contains certification word "${w}"`);
}

// ---- 6. date formatter (no day-shift; ET for instants) -----------------------
{
  process.env.TZ = 'America/New_York';
  eq(noo.fmtDate('2026-06-01'), '06/01/2026', 'date-only string: no day-shift');
  eq(noo.fmtDate(new Date('2026-06-01T02:00:00Z')), '05/31/2026', 'evening-ET instant → ET day, not UTC tomorrow');
  eq(noo.fmtDate(null), '', 'date: null → empty');
}

// ---- 7. empty payload never throws (valid PDF, borrower slot drawn) -----------
{
  const buf = noo.buildNooAffidavit({});
  eq(buf.slice(0, 5).toString('latin1'), '%PDF-', 'empty payload: still a valid PDF (no throw)');
  ok(buf.toString('latin1').includes('/noo_b1_sig/'), 'empty payload: borrower signature slot still drawn');
}

// ---- 8. package spec shape ---------------------------------------------------
{
  const spec = orch.PACKAGES.noo_affidavit;
  ok(spec, 'noo_affidavit package exists');
  eq(spec.countersignRequired, false, 'no counter-signature');
  ok(!spec.soloBorrower, 'NOT soloBorrower — a co-borrower also certifies');
  eq(spec.skipAppraisalGate, true, 'skips the term-sheet origination gate (signable early)');
  eq(spec.docs.length, 1, 'one document');
  const d = spec.docs[0];
  eq(d.kind, 'noo_affidavit', 'doc kind');
  eq(d.prefix, 'noo', 'anchor prefix');
  eq(d.signedKind, 'noo_affidavit_signed', 'signed doc_kind');
  eq(d.condition, 'cond_noo_affidavit_individual', 'clears the individual-vesting affidavit condition');
  eq(d.generate, true, 'server-generated');
}

// ---- 9. validateGenerated: property REQUIRED, loan number NOT ----------------
{
  const spec = orch.PACKAGES.noo_affidavit;
  // A complete file passes.
  orch.validateGenerated(spec, SAMPLE);
  ok(true, 'complete file passes validateGenerated');
  // Missing loan number is allowed (signable early).
  orch.validateGenerated(spec, { ...SAMPLE, loanNumber: '' });
  ok(true, 'missing loan number does NOT block (signable before assignment)');
  // Blank property blocks.
  assert.throws(() => orch.validateGenerated(spec, { ...SAMPLE, propStreet: '', propCity: '', propState: '', propZip: '' }),
    /property address/, 'blank property blocks the send');
  n++;
  // Missing borrower name blocks.
  assert.throws(() => orch.validateGenerated(spec, { ...SAMPLE, bFirst: '', bLast: '' }),
    /borrower name/, 'missing borrower name blocks the send');
  n++;
  // A co-borrower on file with no email blocks (they must sign).
  assert.throws(() => orch.validateGenerated(spec, { ...SAMPLE, cbEmail: '' }),
    /co-borrower email/, 'co-borrower without an email blocks (they sign the certification)');
  n++;
}

console.log(`\n✓ esign NOO certification PDF: ${n} assertions passed`);
