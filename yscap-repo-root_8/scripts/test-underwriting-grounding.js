'use strict';
/**
 * Unit tests for grounding (grounding.js) — the "real reasoning, not guessing" guarantee: every
 * extracted value is verified against the OCR text; a critical value ABSENT from the document is
 * flagged. Legitimate values (present, or present with OCR noise) must NOT be flagged. Pure — no AI.
 */
const assert = require('assert');
const { groundFields, groundingFinding } = require('../src/lib/underwriting/grounding');

const OCR = `
UNIFORM RESIDENTIAL PURCHASE AGREEMENT
Property: 76 Thompson St, Austin, TX 78701
Seller: Jane Seller     Buyer: Maple Grove Holdings LLC
Purchase Price: $412,000.00
Closing Date: 2026-08-15
`;

// ---- All extracted values are present in the OCR → confirmed, nothing flagged ----
{
  const g = groundFields({
    propertyAddress: { line1: '76 Thompson St', city: 'Austin', state: 'TX', zip: '78701' },
    purchasePrice: 412000, sellerNames: ['Jane Seller'], buyerName: 'Maple Grove Holdings LLC',
    closingDate: '2026-08-15', readable: true, notes: 'looks fine',
  }, OCR);
  assert.strictEqual(g.criticalAbsent.length, 0, 'grounded values → nothing absent');
  assert.strictEqual(groundingFinding('purchase_contract', g), null, 'no advisory when everything grounds');
  assert.ok(g.score >= 90, `score should be high, got ${g.score}`);
}

// ---- A HALLUCINATED critical value (not in the document at all) → flagged ----
{
  const g = groundFields({
    propertyAddress: { line1: '76 Thompson St', city: 'Austin', state: 'TX', zip: '78701' },
    purchasePrice: 999999,                 // not in the document
    buyerName: 'Nonexistent Phantom Corp', // not in the document
    readable: true, notes: null,
  }, OCR);
  const absentFields = g.criticalAbsent.map((a) => a.field).sort();
  assert.ok(absentFields.includes('purchasePrice'), 'a price not in the document is flagged absent');
  assert.ok(absentFields.includes('buyerName'), 'a buyer name not in the document is flagged absent');
  const f = groundingFinding('purchase_contract', g);
  assert.ok(f && f.code === 'values_unconfirmed_in_document' && f.severity === 'warning' && f.blocksCtc === false);
  assert.ok(/purchasePrice|buyerName/.test(f.docValue));
}

// ---- OCR NOISE tolerance: a value present but with a mis-read word is NOT flagged absent ----
{
  // "Jane Seller" partially present ("Jane" is there) → partial coverage, NOT flagged as fabricated.
  const g = groundFields({ sellerNames: ['Jane Xeller'], readable: true }, OCR); // OCR-ish typo
  assert.strictEqual(g.criticalAbsent.length, 0, 'a partial/typo match is treated as OCR noise, not fabrication');
}

// ---- Money formatting tolerance: $412,000.00 in OCR grounds the number 412000 ----
{
  const g = groundFields({ purchasePrice: 412000, readable: true }, OCR);
  assert.strictEqual(g.criticalAbsent.length, 0, 'money grounds regardless of $/comma formatting');
}

// ---- No OCR text (reader off) → grounding abstains, never flags ----
{
  const g = groundFields({ buyerName: 'Anything At All' }, '');
  assert.strictEqual(g.score, null);
  assert.strictEqual(groundingFinding('x', g), null, 'no OCR to verify against → no advisory (never a false flag)');
}

// ---- Booleans / notes / readable are not graded ----
{
  const g = groundFields({ readable: false, notes: 'some analyst note not on the page', holderIsBusiness: true }, OCR);
  assert.strictEqual(g.criticalAbsent.length, 0);
}

console.log('✓ test-underwriting-grounding: OCR-grounding verification (real reasoning) cases pass');
