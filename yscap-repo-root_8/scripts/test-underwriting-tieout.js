'use strict';
/**
 * Unit tests for the data-comparison / tie-out engine (facts.js + tieout.js). Pure — no DB.
 */
const assert = require('assert');
const { buildTieout } = require('../src/lib/underwriting/tieout');
const { claimsFor, factMatch } = require('../src/lib/underwriting/facts');

const ADDR = { line1: '76 Thompson St', city: 'Austin', state: 'TX', zip: '78701' };
const OTHER = { line1: '9 Oak Ave', city: 'Dallas', state: 'TX', zip: '75201' };
const ctx = {
  app: { property_address: ADDR, purchase_price: 412000, is_assignment: false, loan_amount: 300000, as_is_value: 400000, arv: 520000, rehab_budget: 80000 },
  borrower: { first_name: 'John', last_name: 'Smith', date_of_birth: '1980-05-15', current_address: { line1: '5 Elm St', city: 'Austin', state: 'TX', zip: '78704' } },
  vestingName: 'Maple Grove Holdings LLC', ein: '12-3456789', entityNames: ['Maple Grove Holdings LLC'],
};
const codes = (ds) => ds.map((d) => d.code).sort();

// ---- claimsFor maps document fields to canonical facts ----
assert.deepStrictEqual(
  claimsFor('government_id', { fullName: 'John Smith', dateOfBirth: '1980-05-15', address: ADDR }),
  { borrower_name: 'John Smith', borrower_dob: '1980-05-15', borrower_address: ADDR });
assert.strictEqual(claimsFor('bank_statement', { accountHolderName: 'Maple Grove Holdings LLC', holderIsBusiness: true }).entity_name, 'Maple Grove Holdings LLC');
assert.strictEqual(claimsFor('bank_statement', { accountHolderName: 'John Smith', holderIsBusiness: false }).borrower_name, 'John Smith');

// ===== 1. A fully consistent file raises NO discrepancies =====
{
  const r = buildTieout(ctx, [
    { id: 'c', docType: 'purchase_contract', fields: { propertyAddress: ADDR, purchasePrice: 412000, sellerNames: ['Jane Seller'], buyerName: 'Maple Grove Holdings LLC', readable: true } },
    { id: 't', docType: 'title', fields: { propertyAddress: ADDR, vestedOwners: ['Jane Seller'], buyerNames: ['Maple Grove Holdings, L.L.C.'], readable: true } },
    { id: 'a', docType: 'appraisal', fields: { propertyAddress: ADDR, contractPrice: 412000, sellerNames: ['Jane Seller'], asIsValue: 400000, arvValue: 520000 } },
    { id: 'id', docType: 'government_id', fields: { fullName: 'John Smith', dateOfBirth: '1980-05-15', address: { line1: '5 Elm St', city: 'Austin', state: 'TX', zip: '78704' } } },
  ]);
  assert.deepStrictEqual(codes(r.discrepancies), [], 'consistent file → no discrepancies');
  // The property_address row shows the file + all three docs agreeing.
  const addrRow = r.matrix.find((m) => m.key === 'property_address');
  assert.strictEqual(addrRow.status, 'ok');
  assert.ok(addrRow.cells.filter((c) => c.status === 'agree').length >= 3, 'contract/title/appraisal all agree on address');
  // Entity suffix variance (LLC vs L.L.C.) does NOT create a discrepancy.
  assert.ok(!r.discrepancies.some((d) => d.field === 'entity_name'));
}

// ===== 2. File-vs-document mismatch on a doc WITHOUT a dedicated per-doc check → tie-out owns it =====
{
  const r = buildTieout(ctx, [
    { id: 's', docType: 'settlement', fields: { propertyAddress: ADDR, contractSalesPrice: 430000, loanAmount: 300000 } },
  ]);
  const d = r.discrepancies.find((x) => x.field === 'purchase_price');
  assert.ok(d && d.severity === 'fatal' && d.blocksCtc, 'settlement price mismatch vs file is fatal + blocks CTC');
  assert.ok(/412,000/.test(d.fileValue) && /430,000/.test(d.docValue));
}
// ===== 2b. A doc WITH a dedicated per-doc check → tie-out does NOT duplicate the file-vs-doc finding =====
{
  const r = buildTieout(ctx, [
    { id: 'c', docType: 'purchase_contract', fields: { propertyAddress: ADDR, purchasePrice: 430000, buyerName: 'Maple Grove Holdings LLC' } },
  ]);
  assert.ok(!r.discrepancies.some((x) => x.field === 'purchase_price'), 'contract price mismatch is owned by the per-doc check, not duplicated by the tie-out');
  // …but the matrix cell still shows the disagreement.
  const cell = r.matrix.find((m) => m.key === 'purchase_price').cells.find((c) => c.label === 'Purchase contract');
  assert.strictEqual(cell.status, 'disagree', 'the matrix still shows the contract price disagreeing');
}
// ===== 2c. Appraisal VALUE ties out against the file (M1 fix) =====
{
  const r = buildTieout(ctx, [
    { id: 'a', docType: 'appraisal', fields: { propertyAddress: ADDR, contractPrice: 412000, asIsValue: 360000, arvValue: 520000 } },
  ]);
  const d = r.discrepancies.find((x) => x.field === 'as_is_value');
  assert.ok(d && d.severity === 'warning', 'appraisal as-is value below the file value ties out (warning)');
  assert.ok(!r.discrepancies.some((x) => x.field === 'arv'), 'matching ARV raises nothing');
}

// ===== 2d. Assignment-fee suppression is CONDITIONAL on the file being an assignment =====
{
  // NON-assignment file with a stale assignment_fee + a contract carrying a different one:
  // the contract check skips it (guarded by is_assignment), so the tie-out MUST still catch it.
  const nonAsg = { app: { property_address: ADDR, is_assignment: false, assignment_fee: 5000 } };
  const r1 = buildTieout(nonAsg, [{ id: 'c', docType: 'purchase_contract', fields: { assignmentFee: 20000 } }]);
  assert.ok(r1.discrepancies.some((d) => d.field === 'assignment_fee'), 'on a non-assignment file the tie-out catches an assignment-fee mismatch the contract check skips');
  // ASSIGNMENT file: the contract check owns it → the tie-out does NOT duplicate.
  const asg = { app: { property_address: ADDR, is_assignment: true, assignment_fee: 5000 } };
  const r2 = buildTieout(asg, [{ id: 'c', docType: 'purchase_contract', fields: { assignmentFee: 20000 } }]);
  assert.ok(!r2.discrepancies.some((d) => d.field === 'assignment_fee'), 'on an assignment file the contract check owns the assignment-fee mismatch (no duplicate)');
}

// ===== 3. Seller (no file value) — documents disagree → fatal doc-vs-doc =====
{
  const r = buildTieout(ctx, [
    { id: 'c', docType: 'purchase_contract', fields: { propertyAddress: ADDR, sellerNames: ['Jane Seller'] } },
    { id: 't', docType: 'title', fields: { propertyAddress: ADDR, vestedOwners: ['Robert Jones'] } },
  ]);
  const d = r.discrepancies.find((x) => x.field === 'seller_name');
  assert.ok(d && d.severity === 'fatal', 'seller disagreement across contract/title is fatal');
  assert.strictEqual(d.fileValue, null, 'seller has no file value (doc-vs-doc)');
}
// Seller AGREES across docs → nothing.
{
  const r = buildTieout(ctx, [
    { id: 'c', docType: 'purchase_contract', fields: { sellerNames: ['Jane Seller'] } },
    { id: 't', docType: 'title', fields: { vestedOwners: ['Jane Seller'] } },
  ]);
  assert.ok(!r.discrepancies.some((d) => d.field === 'seller_name'));
}

// ===== 4. Entity chain — a document under a different entity → fatal =====
{
  const r = buildTieout(ctx, [
    { id: 'oa', docType: 'operating_agreement', fields: { entityLegalName: 'BRRRR Capital LLC', managingMember: 'John Smith' } },
    { id: 'ein', docType: 'ein_letter', fields: { entityLegalName: 'Maple Grove Holdings LLC', ein: '12-3456789' } },
  ]);
  const d = r.discrepancies.find((x) => x.field === 'entity_name');
  assert.ok(d && d.severity === 'fatal', 'operating agreement under a different entity than the file is fatal');
  // EIN ties out (matches file) → no EIN discrepancy.
  assert.ok(!r.discrepancies.some((x) => x.field === 'ein'));
}

// ===== 5. Occupancy: borrower ID address == subject property → warning =====
{
  const r = buildTieout(ctx, [
    { id: 'id', docType: 'government_id', fields: { fullName: 'John Smith', dateOfBirth: '1980-05-15', address: ADDR } },
  ]);
  const d = r.discrepancies.find((x) => x.code === 'occupancy_owner_occupied_flag');
  assert.ok(d && d.severity === 'warning', 'ID address = subject property raises an owner-occupancy flag');
}

// ===== 6. Matrix shape: columns include the file + each source; cells cover every column =====
{
  const r = buildTieout(ctx, [
    { id: 'c', docType: 'purchase_contract', fields: { propertyAddress: ADDR, purchasePrice: 412000 } },
    { id: 'ins', docType: 'insurance', fields: { namedInsured: 'Maple Grove Holdings LLC', propertyAddress: ADDR } },
  ]);
  assert.strictEqual(r.columns.length, 3, 'file + 2 documents = 3 columns');
  for (const row of r.matrix) assert.strictEqual(row.cells.length, 3, 'every fact row has a cell per column');
  // insurance carries entity + address but not price → its price cell is n/a.
  const priceRow = r.matrix.find((m) => m.key === 'purchase_price');
  const insPriceCell = priceRow.cells.find((c) => c.label === 'Insurance');
  assert.strictEqual(insPriceCell.status, 'na', 'insurance is silent on purchase price → n/a');
  // insurance IS expected to carry entity → agrees with the file.
  const entRow = r.matrix.find((m) => m.key === 'entity_name');
  const insEntCell = entRow.cells.find((c) => c.label === 'Insurance');
  assert.strictEqual(insEntCell.status, 'agree', 'insurance named-insured ties to the vesting entity');
}

// ===== 6b. Binder <-> INVOICE tie-out: the paid invoice must reference the SAME policy =====
{
  // Matching policy numbers (formatting-insensitive) agree; the loan file doesn't carry a policy
  // number, so its cell is n/a — this is a doc-vs-doc tie-out between the two insurance documents.
  const ok = buildTieout(ctx, [
    { id: 'ins', docType: 'insurance', fields: { namedInsured: 'Maple Grove Holdings LLC', propertyAddress: ADDR, policyNumber: 'POL-123-A' } },
    { id: 'inv', docType: 'insurance_invoice', fields: { namedInsured: 'Maple Grove Holdings LLC', propertyAddress: ADDR, policyNumber: 'pol123a', paidInFull: true } },
  ]);
  const polRow = ok.matrix.find((m) => m.key === 'policy_number');
  assert.ok(polRow, 'the policy-number fact appears when the insurance documents carry it');
  assert.strictEqual(polRow.status, 'ok', 'binder + invoice on the same policy tie out');
  const invPol = polRow.cells.find((c) => c.label === 'Insurance invoice' || /invoice/i.test(c.label));
  assert.ok(invPol && invPol.status === 'agree', 'the invoice policy number agrees with the binder (formatting-insensitive)');
  // A DIFFERENT policy on the invoice than the binder → a discrepancy the desk surfaces.
  const bad = buildTieout(ctx, [
    { id: 'ins', docType: 'insurance', fields: { namedInsured: 'Maple Grove Holdings LLC', propertyAddress: ADDR, policyNumber: 'POL-123' } },
    { id: 'inv', docType: 'insurance_invoice', fields: { namedInsured: 'Maple Grove Holdings LLC', propertyAddress: ADDR, policyNumber: 'POL-999' } },
  ]);
  const badRow = bad.matrix.find((m) => m.key === 'policy_number');
  assert.strictEqual(badRow.status, 'mismatch', 'a binder/invoice policy mismatch is flagged');
  assert.ok(bad.discrepancies.some((d) => d.field === 'policy_number'), 'the policy mismatch is a discrepancy');
  // The policy number is NOT PII → shown in full (never masked like an EIN).
  assert.ok(badRow.cells.some((c) => c.value === 'POL-999'), 'the policy number is shown in full, not masked');
}

// ===== 7. A document that SHOULD carry a fact but is missing it → 'missing' cell =====
{
  const r = buildTieout(ctx, [
    { id: 'c', docType: 'purchase_contract', fields: { purchasePrice: 412000 } }, // no address
  ]);
  const addrRow = r.matrix.find((m) => m.key === 'property_address');
  const cCell = addrRow.cells.find((c) => c.label === 'Purchase contract');
  assert.strictEqual(cCell.status, 'missing', 'contract carries address but did not state one → missing');
}

// ===== SCOPE OF WORK: rehab_budget owned by the per-doc check; wrong address caught by tie-out =====
{
  // A differing rehab budget must NOT be a tie-out discrepancy (the SOW per-doc check owns it).
  const r = buildTieout(ctx, [{ id: 'sow', docType: 'scope_of_work', fields: { propertyAddress: ADDR, totalBudget: 120000 } }]);
  assert.ok(!r.discrepancies.some((d) => d.field === 'rehab_budget'), 'rehab_budget mismatch is owned by the SOW per-doc check, not duplicated by the tie-out');
  // But a scope of work for the WRONG property IS caught by the tie-out (no per-doc address check).
  const r2 = buildTieout(ctx, [{ id: 'sow', docType: 'scope_of_work', fields: { propertyAddress: { line1: '9 Oak Ave', city: 'Dallas', state: 'TX', zip: '75201' }, totalBudget: 80000 } }]);
  assert.ok(r2.discrepancies.some((d) => d.field === 'property_address'), 'a SOW for the wrong property is caught by the tie-out');
}

// ===== COLLATERAL PHYSICALS (owner-directed 2026-07-21): the appraisal's units / type / occupancy /
// year built / living area / market rent are pulled into the comparison and tie out vs the file =====
{
  const cx = { ...ctx, app: { ...ctx.app, units: 2, property_type: 'SFR', occupancy: 'Investment' } };
  // Appraisal AGREES with the file on units/type/occupancy (wording differs but canonical matches),
  // and contributes year built / living area / market rent that only it carries.
  const ok = buildTieout(cx, [{ id: 'a', docType: 'appraisal', fields: {
    propertyAddress: ADDR, unitCount: undefined, units: 2, propertyType: 'Single Family Detached',
    occupancy: 'Tenant', yearBuilt: 1998, gla: 1850, marketRent: 2400 } }]);
  assert.ok(!ok.discrepancies.some((d) => d.field === 'units'), '2 units on file and appraisal → no unit discrepancy');
  assert.ok(!ok.discrepancies.some((d) => d.field === 'property_type'), 'SFR vs "Single Family Detached" canonicalize equal → no type discrepancy');
  assert.ok(!ok.discrepancies.some((d) => d.field === 'occupancy'), 'Investment vs Tenant canonicalize to tenant → no occupancy discrepancy');
  // The appraisal-only physicals appear in the matrix (single-source) so the desk shows every fact.
  const yb = ok.matrix.find((m) => m.key === 'year_built');
  assert.ok(yb && yb.cells.some((c) => c.value === '1998'), 'year built surfaced from the appraisal');
  const la = ok.matrix.find((m) => m.key === 'living_area');
  assert.ok(la && la.cells.some((c) => String(c.value).indexOf('1,850') !== -1), 'living area shown with sq ft formatting');
  const mr = ok.matrix.find((m) => m.key === 'market_rent');
  assert.ok(mr && mr.cells.some((c) => c.value === '$2,400'), 'market rent shown as money');

  // A REAL unit-count / property-type disagreement IS flagged (appraisal says a different property).
  const bad = buildTieout(cx, [{ id: 'a', docType: 'appraisal', fields: {
    propertyAddress: ADDR, units: 4, propertyType: 'Condominium', occupancy: 'Owner Occupied' } }]);
  assert.ok(bad.discrepancies.some((d) => d.field === 'units'), 'file 2 units vs appraisal 4 units → discrepancy');
  assert.ok(bad.discrepancies.some((d) => d.field === 'property_type'), 'SFR vs Condo → discrepancy');
  // Occupancy owner-vs-tenant IS a real disagreement (info severity — a business-purpose flag).
  assert.ok(bad.discrepancies.some((d) => d.field === 'occupancy'), 'Investment (file) vs Owner Occupied (appraisal) → discrepancy');
}

// An UNRECOGNIZED property-type string is uncomparable, never a false mismatch.
assert.strictEqual(factMatch('propertyType', 'Zorptown Special', 'SFR'), null, 'unknown property type → uncomparable, no false mismatch');
assert.strictEqual(factMatch('count', 2, '2'), true, 'count matches across string/number');
assert.strictEqual(factMatch('measure', 1850, 1870), true, 'GLA within 3% tolerance ties out');
assert.strictEqual(factMatch('measure', 1850, 2400), false, 'GLA far apart is a mismatch');

// ===== CLOSING ECONOMICS (owner-directed 2026-07-21): the term sheet's loan amount ties out vs the
// file + settlement, and the settlement's earnest money / cash-to-close surface in the comparison =====
{
  // Term sheet loan amount AGREES with the file (300000) → no discrepancy; a wrong one flags.
  const okTs = buildTieout(ctx, [{ id: 'ts', docType: 'signed_term_sheet', fields: { propertyAddress: ADDR, loanAmount: 300000 } }]);
  assert.ok(!okTs.discrepancies.some((d) => d.field === 'loan_amount'), 'term sheet loan amount matching the file → no discrepancy');
  const badTs = buildTieout(ctx, [{ id: 'ts', docType: 'signed_term_sheet', fields: { propertyAddress: ADDR, loanAmount: 275000 } }]);
  assert.ok(badTs.discrepancies.some((d) => d.field === 'loan_amount'), 'term sheet loan amount differing from the file → discrepancy');

  // Settlement earnest money + cash to close surface in the matrix (doc-carried, single-source).
  const st = buildTieout(ctx, [{ id: 's', docType: 'settlement', fields: { propertyAddress: ADDR, contractSalesPrice: 412000, loanAmount: 300000, earnestMoney: 10000, cashToClose: 25000 } }]);
  assert.ok(st.matrix.find((m) => m.key === 'earnest_money').cells.some((c) => c.value === '$10,000'), 'earnest money surfaced from settlement');
  assert.ok(st.matrix.find((m) => m.key === 'cash_to_close').cells.some((c) => c.value === '$25,000'), 'cash to close surfaced from settlement');
  // The settlement's loan amount also ties out to the file (300000) with no discrepancy.
  assert.ok(!st.discrepancies.some((d) => d.field === 'loan_amount'), 'settlement loan amount matches the file');
}

console.log('✓ test-underwriting-tieout: fact registry + data-comparison matrix + discrepancies pass');
