'use strict';
/**
 * Pure tests for the tie-out comparison-gate (src/lib/underwriting/comparison-gate.js). No DB /
 * network / keys. Proves the gate SUPPRESSES a cross-side party comparison (the tax-cert case) and
 * NEVER suppresses a legitimate one, a side-neutral fact, or anything when reasoning is absent/weak.
 */
const assert = require('assert');
const { claimComparable, gateClaims, documentSides } = require('../src/lib/underwriting/comparison-gate');

// --- documentSides derives buyer/seller presence from party roles ---
assert.deepStrictEqual(documentSides({ parties: [{ name: 'A LLC', role: 'current_owner' }] }), { buyer: false, seller: true });
assert.deepStrictEqual(documentSides({ parties: [{ name: 'B LLC', role: 'vesting_entity' }] }), { buyer: true, seller: false });
assert.deepStrictEqual(documentSides({ parties: [{ name: 'X', role: 'seller' }, { name: 'Y', role: 'buyer' }] }), { buyer: true, seller: true });
assert.deepStrictEqual(documentSides({ parties: [{ name: 'T', role: 'title_company' }] }), { buyer: false, seller: false }, 'a neutral role names neither side');
assert.deepStrictEqual(documentSides({}), { buyer: false, seller: false }, 'no parties → neither side');
assert.deepStrictEqual(documentSides(null), { buyer: false, seller: false }, 'null reasoning → neither side');

// --- THE TAX-CERT CASE: a document whose only named party is the current owner (seller side).
// A buyer-side fact (entity_name / vesting entity) must be SUPPRESSED — comparing the current owner
// to the vesting LLC is guaranteed nonsense.
const taxCert = { docNature: 'tax_certificate', confidence: 0.95, parties: [{ name: 'Old Owner LLC', role: 'current_owner' }] };
assert.strictEqual(claimComparable('entity_name', taxCert), 'suppress', 'vesting-entity vs a tax-cert current owner is suppressed');
assert.strictEqual(claimComparable('borrower_name', taxCert), 'suppress', 'any buyer-side party fact is suppressed against a seller-only doc');
// A seller-side fact IS comparable against the current owner (they are the same side).
assert.strictEqual(claimComparable('seller_name', taxCert), 'ok', 'seller_name is comparable against the current owner');
// A side-neutral fact (address / price) is ALWAYS comparable.
assert.strictEqual(claimComparable('property_address', taxCert), 'ok', 'a neutral fact is never gated');
assert.strictEqual(claimComparable('purchase_price', taxCert), 'ok');

// --- A REAL title commitment names the proposed insured (buyer side) → the buyer-side fact stands.
const titleCommit = { docNature: 'title_commitment', confidence: 0.9, parties: [{ name: 'New Vesting LLC', role: 'proposed_insured' }, { name: 'Seller Co', role: 'seller' }] };
assert.strictEqual(claimComparable('entity_name', titleCommit), 'ok', 'a doc that names the buyer side keeps the buyer-side comparison');
assert.strictEqual(claimComparable('seller_name', titleCommit), 'ok', 'a doc that names both sides keeps both');

// --- Conservative defaults: never suppress when unsure ---
assert.strictEqual(claimComparable('entity_name', null), 'ok', 'no reasoning → compare (byte-identical to ungated)');
assert.strictEqual(claimComparable('entity_name', {}), 'ok', 'empty reasoning → compare');
assert.strictEqual(claimComparable('entity_name', { confidence: 0.3, parties: [{ name: 'Z', role: 'current_owner' }] }), 'ok',
  'low-confidence reasoning never suppresses');
assert.strictEqual(claimComparable('entity_name', { confidence: 0.95, parties: [{ name: 'Z', role: 'other' }] }), 'ok',
  'an unrecognized/other role names no side → nothing to suppress against');

// --- gateClaims filters the claim map, reporting what it removed ---
{
  const claims = { entity_name: 'New Vesting LLC', seller_name: 'Old Owner LLC', property_address: { line1: '1 Main' } };
  const out = gateClaims(claims, taxCert);
  assert.deepStrictEqual(out.suppressed, ['entity_name'], 'only the cross-side buyer fact is removed');
  assert.strictEqual('entity_name' in out.claims, false);
  assert.strictEqual(out.claims.seller_name, 'Old Owner LLC', 'the seller fact survives');
  assert.strictEqual(out.claims.property_address.line1, '1 Main', 'the neutral fact survives');
}
{
  // No reasoning → claims returned untouched.
  const claims = { entity_name: 'X', seller_name: 'Y' };
  const out = gateClaims(claims, null);
  assert.deepStrictEqual(out.suppressed, []);
  assert.strictEqual(out.claims, claims);
}

// --- Never throws on garbage input ---
assert.strictEqual(claimComparable('entity_name', { parties: 'not-an-array', confidence: 'x' }), 'ok');
assert.strictEqual(claimComparable(undefined, taxCert), 'ok');

console.log('✓ test-comparison-gate-pure: cross-side suppression + conservative defaults pass');
