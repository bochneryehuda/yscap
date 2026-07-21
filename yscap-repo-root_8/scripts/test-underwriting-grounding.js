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

// ---- DATE FORMAT tolerance: an ISO date grounds against a US-formatted date in the OCR ----
{
  const usOcr = 'DRIVER LICENSE  DOB 05/15/1980  EXP 08-01-2028  Class C';
  const g = groundFields({ dateOfBirth: '1980-05-15', expirationDate: '2028-08-01', readable: true }, usOcr);
  assert.strictEqual(g.criticalAbsent.length, 0, 'an ISO date grounds against the OCR\'s 05/15/1980 form — no false flag');
}
// A date is NEVER escalated even if truly absent (formats too variable) — belt against false flags.
{
  const g = groundFields({ dateOfBirth: '1999-12-31', buyerName: 'Maple Grove Holdings LLC', readable: true }, OCR);
  assert.ok(!g.criticalAbsent.some((a) => /dateOfBirth/.test(a.field)), 'a date is never escalated as fabricated');
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

// ---- DERIVED / CLASSIFICATION fields (owner-reported 2026-07-21) are NEVER graded or escalated:
//      a member's inferred ownershipPct + type enum can't be found by text-match even when the OA
//      read perfectly, so they must not produce a false "could not be confirmed" finding — while a
//      TRANSCRIBED value (a fabricated member NAME) absent from the text still flags. ----
{
  const oaOcr = `
OPERATING AGREEMENT OF MAPLE GROVE HOLDINGS LLC
The sole member of the Company is John Q Borrower.
This agreement is executed as of January 3, 2026.
`;
  // A single-member OA: the AI INFERS ownershipPct=100 (never printed) and classifies type='individual'.
  const g = groundFields({
    entityLegalName: 'Maple Grove Holdings LLC',
    members: [{ name: 'John Q Borrower', ownershipPct: 100, type: 'individual', isManager: true }],
    readable: true,
  }, oaOcr);
  assert.ok(!g.criticalAbsent.some((a) => /ownershippct|members\[0\]\.type/i.test(a.field)),
    'an inferred ownershipPct / classified member type is NOT escalated as unconfirmed');
  assert.strictEqual(groundingFinding('operating_agreement', g), null,
    'a fully-readable OA raises NO "values could not be confirmed" finding for its derived fields');

  // But a TRANSCRIBED member name that is NOT in the document still flags (fabrication signal intact).
  const g2 = groundFields({
    entityLegalName: 'Maple Grove Holdings LLC',
    members: [{ name: 'Phantom Nonmember Person', ownershipPct: 50, type: 'individual' }],
    readable: true,
  }, oaOcr);
  assert.ok(g2.criticalAbsent.some((a) => /members\[0\]\.name/i.test(a.field)),
    'a member NAME absent from the document still flags — grounding of transcribed values is unchanged');
  // Classification keys anywhere (propertyType/accountType/etc.) are likewise never escalated.
  const g3 = groundFields({ propertyType: 'Single Family Residence', accountType: 'checking', readable: true },
    'Statement of account. Balance $10,000.');
  assert.strictEqual(g3.criticalAbsent.length, 0, 'propertyType/accountType classifications are never escalated');
}

console.log('✓ test-underwriting-grounding: OCR-grounding verification + derived-field discipline cases pass');
