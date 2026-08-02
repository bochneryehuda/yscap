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
// ===== 2c. The APPRAISAL has its own desk — the tie-out does NOT duplicate it =====
// (owner-reported 2026-08-02: "some of the appraisal findings is going over to the document
// findings section"). Same rule as the purchase contract in 2b: lib/appraisal/findings.js compares
// address / price / as-is / ARV / units / property type appraisal-vs-file and raises a REAL,
// resolvable finding on the Appraisal tab, so a second tie-out card for the same disagreement was
// pure duplication — and resolving one left the other standing. The MATRIX still shows every cell.
{
  const r = buildTieout(ctx, [
    { id: 'a', docType: 'appraisal', fields: { propertyAddress: ADDR, contractPrice: 412000, asIsValue: 360000, arvValue: 520000 } },
  ]);
  assert.ok(!r.discrepancies.some((x) => x.field === 'as_is_value'),
    'the appraisal as-is mismatch is owned by the appraisal desk, not duplicated by the tie-out');
  const cell = r.matrix.find((m) => m.key === 'as_is_value').cells.find((c) => c.label === 'Appraisal');
  assert.strictEqual(cell.status, 'disagree', 'the matrix still shows the appraisal as-is disagreeing');
  assert.ok(!r.discrepancies.some((x) => x.field === 'arv'), 'matching ARV raises nothing');
}
// ===== 2c-bis. …but an appraisal fact the appraisal desk does NOT compare still surfaces =====
// The suppression is a fixed list of the facts that desk owns, never "ignore the appraisal".
{
  const occCtx = { app: { property_address: ADDR, occupancy: 'Vacant' } };
  const r = buildTieout(occCtx, [{ id: 'a', docType: 'appraisal', fields: { propertyAddress: ADDR, occupancy: 'TenantOccupied' } }]);
  assert.ok(r.discrepancies.some((x) => x.field === 'occupancy'),
    'an appraisal fact outside the appraisal desk’s own checks is still raised by the tie-out');
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

  // A REAL unit-count / property-type disagreement IS still SEEN — it is just not raised twice.
  // Since 2026-08-02 the tie-out defers units + property type to the appraisal desk, which raises
  // its own resolvable `units_mismatch` / `property_type_mismatch` on the Appraisal tab; the matrix
  // still marks the cells as disagreeing, exactly as it does for the purchase contract's facts.
  const bad = buildTieout(cx, [{ id: 'a', docType: 'appraisal', fields: {
    propertyAddress: ADDR, units: 4, propertyType: 'Condominium', occupancy: 'Owner Occupied' } }]);
  assert.ok(!bad.discrepancies.some((d) => d.field === 'units'), 'file 2 units vs appraisal 4 units → the appraisal desk owns it, no tie-out duplicate');
  assert.ok(!bad.discrepancies.some((d) => d.field === 'property_type'), 'SFR vs Condo → the appraisal desk owns it, no tie-out duplicate');
  const unitCell = bad.matrix.find((m) => m.key === 'units').cells.find((c) => c.label === 'Appraisal');
  assert.strictEqual(unitCell.status, 'disagree', 'the matrix still shows the unit count disagreeing');
  const typeCell = bad.matrix.find((m) => m.key === 'property_type').cells.find((c) => c.label === 'Appraisal');
  assert.strictEqual(typeCell.status, 'disagree', 'the matrix still shows the property type disagreeing');
  // Occupancy owner-vs-tenant IS a real disagreement (info severity — a business-purpose flag), and
  // no appraisal-desk check compares it, so the tie-out still raises it.
  assert.ok(bad.discrepancies.some((d) => d.field === 'occupancy'), 'Investment (file) vs Owner Occupied (appraisal) → discrepancy');

  // THE OWNER'S 2026-07-27 CASE: the appraisal's property_type is a bare ATTACHMENT STYLE
  // ("Detached") — that is NOT a unit category, so on a Multi 2–4 file with agreeing unit counts it
  // must NOT fire "property type doesn't match". (canonPropertyType('Detached') is uncomparable.)
  const cxMulti = { ...ctx, app: { ...ctx.app, units: 3, property_type: 'Multi 2-4' } };
  const styleOnly = buildTieout(cxMulti, [{ id: 'a', docType: 'appraisal', fields: {
    propertyAddress: ADDR, units: 3, propertyType: 'Detached' } }]);
  assert.ok(!styleOnly.discrepancies.some((d) => d.field === 'property_type'),
    'a bare "Detached" style on a Multi 2–4 file with matching units → NO false property-type mismatch');
  assert.ok(!styleOnly.discrepancies.some((d) => d.field === 'units'),
    '3 units on file and appraisal → no unit discrepancy');
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

// ===== Assignment: a doc reporting the SELLER's underlying price is NOT a mismatch (owner 2026-07-24) =====
{
  // File total is the fee-inclusive price (474k); seller's underlying price is 438k, fee 36k.
  const asgCtx = { ...ctx, app: { ...ctx.app, purchase_price: 474000, is_assignment: true, underlying_contract_price: 438000, assignment_fee: 36000 } };
  // The appraisal/settlement legitimately report the SELLER's price (438k) — this used to fire a
  // false tieout_purchase_price fatal. With the assignment tolerance it AGREES.
  const rSeller = buildTieout(asgCtx, [
    { id: 'a', docType: 'appraisal', fields: { propertyAddress: ADDR, contractPrice: 438000 } },
    { id: 's', docType: 'settlement', fields: { propertyAddress: ADDR, contractSalesPrice: 438000, loanAmount: 300000 } },
  ]);
  assert.ok(!rSeller.discrepancies.some((d) => d.code === 'tieout_purchase_price'),
    "a doc reporting the seller's underlying price on an assignment is not a mismatch");
  // The three cases below are about the ASSIGNMENT price TOLERANCE (priceAwareMatch), not about
  // any one document, so they use the SETTLEMENT statement — a document with no per-doc price check
  // of its own, so the tie-out owns its price the way it always did. (The appraisal's own price
  // disagreement moved to the Appraisal desk on 2026-08-02, which would make it the wrong probe.)
  // A doc reporting the fee-inclusive TOTAL (474k) also agrees.
  const rTotal = buildTieout(asgCtx, [{ id: 's', docType: 'settlement', fields: { propertyAddress: ADDR, contractSalesPrice: 474000 } }]);
  assert.ok(!rTotal.discrepancies.some((d) => d.code === 'tieout_purchase_price'), 'the fee-inclusive total also agrees on an assignment');
  // A doc reporting a price matching NEITHER (500k) still fires the discrepancy.
  const rWrong = buildTieout(asgCtx, [{ id: 's', docType: 'settlement', fields: { propertyAddress: ADDR, contractSalesPrice: 500000 } }]);
  assert.ok(rWrong.discrepancies.some((d) => d.code === 'tieout_purchase_price'), 'a price matching neither still fires on an assignment');
  // On a STRAIGHT purchase the tolerance does NOT apply — a doc at 438k vs file 412k still fires.
  const rStraight = buildTieout(ctx, [{ id: 's', docType: 'settlement', fields: { propertyAddress: ADDR, contractSalesPrice: 438000 } }]);
  assert.ok(rStraight.discrepancies.some((d) => d.code === 'tieout_purchase_price'), 'a straight purchase is unchanged (still fires)');

  // The ASSIGNMENT DOCUMENT states its OWN total-to-assignee (final price = seller price + fee).
  // NEW-C: that total now ties out against the file's final purchase price.
  const asgDoc = (total) => ({ id: 'asg', docType: 'assignment',
    fields: { propertyAddress: ADDR, assigneeName: 'Maple Grove Holdings LLC', originalPurchasePrice: 438000, assignmentFee: 36000, totalPriceToAssignee: total } });
  // Correct total (474k) → agrees; the seller's underlying (438k) also agrees (assignment-aware).
  assert.ok(!buildTieout(asgCtx, [asgDoc(474000)]).discrepancies.some((d) => d.code === 'tieout_purchase_price'),
    "the assignment document's total-to-assignee ties out against the file's final price");
  assert.ok(!buildTieout(asgCtx, [asgDoc(438000)]).discrepancies.some((d) => d.code === 'tieout_purchase_price'),
    "an assignment doc stating the seller's underlying total also agrees on an assignment");
  // A genuinely wrong assignment total (matches neither underlying nor final) → flags.
  assert.ok(buildTieout(asgCtx, [asgDoc(500000)]).discrepancies.some((d) => d.code === 'tieout_purchase_price'),
    'a wrong total on the assignment document flags a purchase-price discrepancy');
  // The assignment doc's purchase_price is a CARRIED fact now (shows in the matrix row).
  const mRow = buildTieout(asgCtx, [asgDoc(474000)]).matrix.find((m) => m.key === 'purchase_price');
  assert.ok(mRow.cells.some((c) => c.value === '$474,000'), "the assignment doc's total surfaces in the purchase_price matrix row");
}

// ===== Assignment fee MISLABELED as the whole price → NOT a false tie-out fatal (owner 2026-07-27) =====
{
  // File has a REAL assignment fee (36k) on a 325k total (289k seller + 36k fee).
  const asgFeeCtx = { app: { property_address: ADDR, is_assignment: true, purchase_price: 325000, underlying_contract_price: 289000, assignment_fee: 36000 }, vestingName: 'Maple Grove Holdings LLC' };
  // (a) facts.js quarantine — the assignment DOC states the total, and its "fee" equals that total → dropped.
  const rDocTotal = buildTieout(asgFeeCtx, [{ id: 'asg', docType: 'assignment',
    fields: { propertyAddress: ADDR, assigneeName: 'Maple Grove Holdings LLC', originalPurchasePrice: 289000, assignmentFee: 325000, totalPriceToAssignee: 325000 } }]);
  assert.ok(!rDocTotal.discrepancies.some((d) => d.code === 'tieout_assignment_fee'),
    'a "fee" equal to the assignment total is quarantined — no false assignment-fee fatal');
  // (b) tie-out belt-and-suspenders — the doc gives ONLY a fee (no total field) but it equals the FILE's total.
  const rFileTotal = buildTieout(asgFeeCtx, [{ id: 'asg', docType: 'assignment',
    fields: { propertyAddress: ADDR, assigneeName: 'Maple Grove Holdings LLC', assignmentFee: 325000 } }]);
  assert.ok(!rFileTotal.discrepancies.some((d) => d.code === 'tieout_assignment_fee'),
    "a doc fee equal to the file's total price is not a mismatch");
  // (c) a genuinely different assignment fee (a real fraction, disagreeing with the file) STILL fires.
  const rReal = buildTieout(asgFeeCtx, [{ id: 'asg', docType: 'assignment',
    fields: { propertyAddress: ADDR, assigneeName: 'Maple Grove Holdings LLC', assignmentFee: 50000 } }]);
  assert.ok(rReal.discrepancies.some((d) => d.code === 'tieout_assignment_fee'),
    'a real fee (50k) that disagrees with the file fee (36k) still fires — nothing over-tolerated');
}

// ===== Layer A: never compare a current-owner / wholesaler name to the vesting entity (2026-07-27) =====
{
  // A TITLE document (or a tax certificate / deed misfiled as one) names the CURRENT owner — the
  // seller pre-close. It must NOT be compared to the vesting LLC as a fatal "entity mismatch": the
  // owner-reported tax-cert-owner-vs-buyer-LLC bug. title no longer carries entity_name at all.
  const titleWithOwner = { id: 'title', docType: 'title',
    fields: { propertyAddress: ADDR, vestedOwners: ['Shraga Leifer'], buyerNames: ['Shraga Leifer'] } };
  const rt = buildTieout(ctx, [titleWithOwner]);
  assert.ok(!rt.discrepancies.some((d) => d.field === 'entity_name'),
    "a title/tax-cert's current owner is never compared to the vesting entity (no fatal entity mismatch)");
  // The seller-side owner still ties out as seller_name (chain-of-title/seller-chain rely on it).
  assert.ok(claimsFor('title', { vestedOwners: ['Shraga Leifer'] }).seller_name,
    'title still carries the owner of record as seller_name');
  assert.strictEqual(claimsFor('title', { buyerNames: ['Shraga Leifer'] }).entity_name, undefined,
    'title no longer maps a buyer field to the vesting entity_name fact');

  // On an ASSIGNMENT, the purchase CONTRACT names the wholesaler as buyer — not our vesting entity.
  const asgFile = { app: { property_address: ADDR, is_assignment: true }, vestingName: 'Maple Grove Holdings LLC' };
  const contractWholesaler = { id: 'pc', docType: 'purchase_contract',
    fields: { propertyAddress: ADDR, buyerName: 'ABC Wholesale LLC' } };
  const ra = buildTieout(asgFile, [contractWholesaler]);
  assert.ok(!ra.discrepancies.some((d) => d.field === 'entity_name'),
    'on an assignment the contract buyer (wholesaler) is not compared to the vesting entity');
  // The buyer-side vesting comparison STILL works for the documents that legitimately name the
  // vesting entity: an operating agreement whose legal name disagrees with the file's vesting entity
  // still fires the tie-out entity mismatch (we only stopped comparing CURRENT-OWNER / wholesaler
  // names, never the real vesting-entity documents).
  const rOa = buildTieout(ctx, [{ id: 'oa', docType: 'operating_agreement', fields: { entityLegalName: 'Totally Different LLC' } }]);
  assert.ok(rOa.discrepancies.some((d) => d.field === 'entity_name'),
    'an operating agreement naming the wrong entity still ties out against the vesting entity');
}

// --- THE REASONING-DRIVEN COMPARISON GATE (Layer B, owner-directed 2026-07-27) ---
// A document whose per-document REASONING says its only named party is the CURRENT owner (seller
// side) must have its buyer-side entity_name claim SUPPRESSED before the matrix runs — even when the
// document is NOT a purchase_contract and NOT an assignment (the general case the hardcoded delete
// can't reach). This directly exercises the gate through buildTieout.
{
  const vestCtx = { app: { property_address: ADDR }, vestingName: 'New Vesting LLC' };
  // A source that (wrongly, via slot-mapping) carries the current owner in its entity_name field.
  // Use an operating_agreement source (which the tie-out owns for entity_name) so we KNOW it would
  // otherwise raise the fatal — then prove the reasoning gate suppresses it.
  const misread = {
    id: 'src', docType: 'operating_agreement',
    fields: { entityLegalName: 'Old Owner LLC' },
    reasoning: { docNature: 'tax_certificate', confidence: 0.95, parties: [{ name: 'Old Owner LLC', role: 'current_owner' }] },
  };
  const gated = buildTieout(vestCtx, [misread]);
  assert.ok(!gated.discrepancies.some((d) => d.field === 'entity_name'),
    'reasoning that names only the current owner (seller side) suppresses the buyer-side entity_name comparison');

  // WITHOUT the reasoning, the SAME source DOES raise the entity_name mismatch — proving the gate is
  // what changed the outcome (not the data), and that a real disagreement is still caught.
  const ungated = buildTieout(vestCtx, [{ id: 'src', docType: 'operating_agreement', fields: { entityLegalName: 'Old Owner LLC' } }]);
  assert.ok(ungated.discrepancies.some((d) => d.field === 'entity_name'),
    'the same source with no reasoning still fires — the gate, not the data, suppressed it');

  // Reasoning that DOES name the buyer side (a real title commitment's proposed insured) does NOT
  // suppress — a genuine wrong vesting entity is still caught.
  const realCommit = {
    id: 'src2', docType: 'operating_agreement',
    fields: { entityLegalName: 'Wrong Vesting LLC' },
    reasoning: { docNature: 'title_commitment', confidence: 0.9, parties: [{ name: 'Wrong Vesting LLC', role: 'proposed_insured' }] },
  };
  assert.ok(buildTieout(vestCtx, [realCommit]).discrepancies.some((d) => d.field === 'entity_name'),
    'reasoning that names the buyer side keeps the buyer-side comparison (a wrong vesting entity still fires)');
}

console.log('✓ test-underwriting-tieout: fact registry + data-comparison matrix + discrepancies pass');
