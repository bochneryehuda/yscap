'use strict';
/**
 * Unit tests for the title + bank-statement checks and the cross-document reconciliation.
 * Pure — no DB/network/keys.
 */
const assert = require('assert');
const { computeTitleFindings } = require('../src/lib/underwriting/title-checks');
const { computeBankFindings } = require('../src/lib/underwriting/bank-statement-checks');
const { computeCrossDocumentFindings } = require('../src/lib/underwriting/cross-document');
const codes = (fs) => fs.map((f) => f.code).sort();

// ===== TITLE =====
const titleFile = { property_address: { line1: '76 Thompson St', city: 'Austin', state: 'TX', zip: '78701' } };
assert.deepStrictEqual(codes(computeTitleFindings({
  propertyAddress: titleFile.property_address, vestedOwners: ['Jane Seller'], buyerNames: [], legalDescription: 'Lot 4', liens: [], effectiveDate: '2026-07-01', readable: true, notes: null,
}, titleFile)), [], 'clean title raises nothing');
assert.deepStrictEqual(codes(computeTitleFindings({
  propertyAddress: { line1: '9 Oak Ave', city: 'Dallas', state: 'TX', zip: '75201' }, vestedOwners: ['Jane Seller'], buyerNames: [], legalDescription: null, liens: [], effectiveDate: null, readable: true, notes: null,
}, titleFile)), ['title_address_mismatch']);
assert.deepStrictEqual(codes(computeTitleFindings({
  propertyAddress: titleFile.property_address, vestedOwners: [], buyerNames: [], legalDescription: null, liens: [], effectiveDate: null, readable: true, notes: null,
}, titleFile)), ['title_seller_unreadable']);

// ===== TITLE seasoning / flip detection =====
const seasoningFile = { ...titleFile, purchase_price: 400000 };
const baseTitle = { propertyAddress: titleFile.property_address, vestedOwners: ['Jane Seller'], buyerNames: [], legalDescription: 'Lot 4', liens: [], effectiveDate: '2026-07-01', readable: true, notes: null };
// Owner acquired 30 days ago → short seasoning flagged.
{
  const f = computeTitleFindings({ ...baseTitle, ownerAcquisitionDate: '2026-06-20' }, seasoningFile, { today: '2026-07-20' });
  assert.deepStrictEqual(codes(f), ['title_short_seasoning'], 'a 30-day hold is short seasoning');
  assert.strictEqual(f[0].severity, 'warning');
}
// Short seasoning AND a >=100% markup → the message calls out the flip/markup.
{
  const f = computeTitleFindings({ ...baseTitle, ownerAcquisitionDate: '2026-06-20', ownerAcquisitionPrice: 180000 }, seasoningFile, { today: '2026-07-20' });
  assert.strictEqual(f[0].code, 'title_short_seasoning');
  assert.match(f[0].title, /flip|inflation/i, 'a 100%+ markup is called out as a flip signal');
}
// Long-held property (2 years) → no seasoning flag.
{
  const f = computeTitleFindings({ ...baseTitle, ownerAcquisitionDate: '2024-07-01' }, seasoningFile, { today: '2026-07-20' });
  assert.deepStrictEqual(codes(f), [], 'a well-seasoned property is clean');
}
// No acquisition date / no today → no seasoning flag (never guesses).
assert.deepStrictEqual(codes(computeTitleFindings({ ...baseTitle }, seasoningFile, { today: '2026-07-20' })), [], 'no acquisition date → no flag');
// Boundary: exactly 89 days owned → flagged; exactly 90 days → NOT flagged (< 90 is the line).
assert.deepStrictEqual(codes(computeTitleFindings({ ...baseTitle, ownerAcquisitionDate: '2026-01-02' }, seasoningFile, { today: '2026-04-01' })), ['title_short_seasoning'], '89 days is short seasoning');
assert.deepStrictEqual(codes(computeTitleFindings({ ...baseTitle, ownerAcquisitionDate: '2026-01-01' }, seasoningFile, { today: '2026-04-01' })), [], '90 days is at the seasoning line, not under it');

// ===== TITLE liens + Schedule B exceptions (clear-at-funding conditions) =====
// A tax lien and an involuntary lien each flag as clear-at-funding; a seller mortgage is info-only.
{
  const f = computeTitleFindings({ ...baseTitle, liens: [
    { type: 'property tax', holder: 'County', amount: 4200 },
    { type: 'federal tax lien', holder: 'IRS', amount: 15000 },
    { type: 'judgment', holder: 'ABC', amount: 3000 },
    { type: 'mortgage', holder: 'Wells Fargo', amount: 180000 },
  ] }, seasoningFile, { today: '2026-07-20' });
  assert.deepStrictEqual(codes(f), ['title_existing_mortgage', 'title_involuntary_lien', 'title_tax_lien']);
  const tax = f.find((x) => x.code === 'title_tax_lien');
  assert.strictEqual(tax.severity, 'warning');
  assert.strictEqual(tax.blocksCtc, false, 'a title lien is a clear-at-funding condition, not a hard CTC block');
  assert.ok(/IRS/.test(tax.docValue) && /County/.test(tax.docValue), 'both the property and federal tax liens are listed');
  assert.strictEqual(f.find((x) => x.code === 'title_existing_mortgage').severity, 'info', 'a seller mortgage is a payoff reminder, not a red flag');
}
// A clean title with no liens raises nothing new.
assert.deepStrictEqual(codes(computeTitleFindings({ ...baseTitle, liens: [], exceptions: [] }, seasoningFile, { today: '2026-07-20' })), [], 'no liens/exceptions → clean');
// A monetary lien of an UNRECOGNIZED type is surfaced (never silently dropped) — audit B-2.
{
  const f = computeTitleFindings({ ...baseTitle, liens: [{ type: 'UCC-1 fixture filing', holder: 'Equip Co', amount: 5000 }] }, seasoningFile, { today: '2026-07-20' });
  assert.deepStrictEqual(codes(f), ['title_other_lien']);
  assert.ok(/Equip Co/.test(f[0].docValue));
}
// Only ABNORMAL Schedule B exceptions surface — boilerplate (taxes not yet due, standard easement,
// the standard survey ENCROACHMENT exception, the standard MECHANIC'S-lien exception) is ignored (audit B-1).
{
  const f = computeTitleFindings({ ...baseTitle, exceptions: [
    'Taxes for 2026 not yet due and payable', 'Standard utility easement of record',
    'Any shortage in area, encroachments, overlaps disclosed by an accurate survey',
    "Liens for labor or material (mechanic's liens) not shown by the public records",
    'Lis pendens recorded in Book 123', 'Notice of default recorded 2025',
  ] }, seasoningFile, { today: '2026-07-20' });
  assert.deepStrictEqual(codes(f), ['title_abnormal_exception']);
  const ex = f.find((x) => x.code === 'title_abnormal_exception');
  assert.ok(/Lis pendens/.test(ex.docValue) && /Notice of default/.test(ex.docValue), 'the real defects are surfaced');
  assert.ok(!/utility easement/i.test(ex.docValue), 'boilerplate easement is NOT surfaced');
  assert.ok(!/shortage in area/i.test(ex.docValue), 'the standard survey encroachment exception is NOT surfaced');
  assert.ok(!/labor or material/i.test(ex.docValue), 'the standard mechanic-lien exception is NOT surfaced');
}

// ===== BANK STATEMENT =====
const assets = { borrower_name: 'John Smith', entity_names: ['Maple Grove Holdings LLC'] };
const goodStmt = { accountHolderName: 'John Smith', holderIsBusiness: false, bankName: 'Chase', accountNumber: '1234567890', statementPeriod: 'Jun 2026', openingBalance: 10000, closingBalance: 15000, totalDeposits: 8000, totalWithdrawals: 3000, readable: true, notes: null };
assert.deepStrictEqual(codes(computeBankFindings(goodStmt, assets)), [], 'borrower personal account, math adds up → clean');
// Account under a known borrower entity → clean.
assert.deepStrictEqual(codes(computeBankFindings({ ...goodStmt, accountHolderName: 'Maple Grove Holdings, L.L.C.', holderIsBusiness: true }, assets)), [], 'known entity account → clean (suffix/punct tolerant)');
// Large-deposit sourcing: one deposit is >50% of total deposits AND material → warning.
// (Balance math kept consistent: opening + deposits − withdrawals = closing.)
const depStmt = { ...goodStmt, openingBalance: 5000, totalDeposits: 20000, totalWithdrawals: 3000, closingBalance: 22000 };
{
  const f = computeBankFindings({ ...depStmt, largestDeposit: 15000 }, assets);
  assert.deepStrictEqual(codes(f), ['bank_large_deposit'], 'a dominant single deposit needs sourcing');
  assert.strictEqual(f[0].severity, 'warning');
}
// A largest deposit that's a small share, or immaterial, is NOT flagged.
assert.deepStrictEqual(codes(computeBankFindings({ ...depStmt, largestDeposit: 4000 }, assets)), [], 'a small-share deposit is fine');
assert.deepStrictEqual(codes(computeBankFindings({ ...goodStmt, largestDeposit: 4500 }, assets)), [], 'a sub-$5k deposit is immaterial even if >50% of a small total');
assert.deepStrictEqual(codes(computeBankFindings({ ...depStmt, largestDeposit: null }, assets)), [], 'no largest-deposit detail → no flag (never guesses)');
// A material deposit (>$5k) that is only a MINORITY share (<=50%) is NOT flagged — isolates the share gate from the floor.
assert.deepStrictEqual(codes(computeBankFindings({ ...depStmt, largestDeposit: 9000 }, assets)), [], 'a >$5k deposit that is <=50% of deposits is fine');

// Account under a DIFFERENT LLC → FATAL, requires operating agreement.
{
  const f = computeBankFindings({ ...goodStmt, accountHolderName: 'BRRRR Capital LLC', holderIsBusiness: true }, assets);
  assert.deepStrictEqual(codes(f), ['bank_account_other_entity']);
  assert.strictEqual(f[0].severity, 'fatal');
  assert.strictEqual(f[0].requiresDocument, 'operating_agreement');
}
// Personal account in a different name → FATAL.
assert.deepStrictEqual(codes(computeBankFindings({ ...goodStmt, accountHolderName: 'Robert Jones' }, assets)), ['bank_account_not_borrower']);
// Balances don't reconcile → WARNING (tampering signal).
assert.deepStrictEqual(codes(computeBankFindings({ ...goodStmt, closingBalance: 99999 }, assets)), ['bank_math_inconsistent']);
// Unreadable → single verify finding.
assert.deepStrictEqual(codes(computeBankFindings({ ...goodStmt, readable: false, accountHolderName: null }, assets)), ['bank_unreadable']);

// ===== CROSS-DOCUMENT =====
// All agree → nothing.
assert.deepStrictEqual(codes(computeCrossDocumentFindings({
  purchase_contract: { sellerNames: ['Jane Seller'], price: 412000, address: titleFile.property_address },
  title:             { sellerNames: ['Jane Seller'], address: titleFile.property_address },
  appraisal:         { sellerNames: ['Jane Seller'], price: 412000, address: titleFile.property_address },
})), [], 'consistent documents raise nothing');

// Seller differs between contract and title → FATAL.
{
  const f = computeCrossDocumentFindings({
    purchase_contract: { sellerNames: ['Jane Seller'], price: 412000, address: titleFile.property_address },
    title:             { sellerNames: ['Robert Jones'], address: titleFile.property_address },
  });
  assert.deepStrictEqual(codes(f), ['cross_seller_mismatch']);
  assert.strictEqual(f[0].blocksCtc, true);
}
// Entity-seller suffix variance does NOT false-mismatch.
assert.deepStrictEqual(codes(computeCrossDocumentFindings({
  purchase_contract: { sellerNames: ['Maple Grove Holdings LLC'] },
  title:             { sellerNames: ['Maple Grove Holdings, L.L.C.'] },
})), [], 'entity seller suffix/punct variance must not mismatch');

// Price differs between contract and appraisal → FATAL.
assert.deepStrictEqual(codes(computeCrossDocumentFindings({
  purchase_contract: { price: 412000 }, appraisal: { price: 430000 },
})), ['cross_price_mismatch']);

// Address differs → FATAL.
assert.deepStrictEqual(codes(computeCrossDocumentFindings({
  purchase_contract: { address: titleFile.property_address },
  title:             { address: { line1: '9 Oak Ave', city: 'Dallas', state: 'TX', zip: '75201' } },
})), ['cross_address_mismatch']);

// Multiple disagreements compound.
{
  const f = computeCrossDocumentFindings({
    purchase_contract: { sellerNames: ['Jane Seller'], price: 412000 },
    title:             { sellerNames: ['Robert Jones'] },
    appraisal:         { price: 430000 },
  });
  assert.deepStrictEqual(codes(f), ['cross_price_mismatch', 'cross_seller_mismatch']);
}

console.log('✓ test-underwriting-crossdoc: title + bank-statement + cross-document cases pass');
