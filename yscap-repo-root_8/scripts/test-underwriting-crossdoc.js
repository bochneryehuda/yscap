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

// ===== BANK STATEMENT =====
const assets = { borrower_name: 'John Smith', entity_names: ['Maple Grove Holdings LLC'] };
const goodStmt = { accountHolderName: 'John Smith', holderIsBusiness: false, bankName: 'Chase', accountNumber: '1234567890', statementPeriod: 'Jun 2026', openingBalance: 10000, closingBalance: 15000, totalDeposits: 8000, totalWithdrawals: 3000, readable: true, notes: null };
assert.deepStrictEqual(codes(computeBankFindings(goodStmt, assets)), [], 'borrower personal account, math adds up → clean');
// Account under a known borrower entity → clean.
assert.deepStrictEqual(codes(computeBankFindings({ ...goodStmt, accountHolderName: 'Maple Grove Holdings, L.L.C.', holderIsBusiness: true }, assets)), [], 'known entity account → clean (suffix/punct tolerant)');
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
