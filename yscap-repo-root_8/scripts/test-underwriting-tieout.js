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

console.log('✓ test-underwriting-tieout: fact registry + data-comparison matrix + discrepancies pass');
