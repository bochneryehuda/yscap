'use strict';
/**
 * Pure tests for the bank-entity duplicate collapse (src/lib/underwriting/bank-entity-dedup.js).
 * No DB / AI. Proves: N per-statement findings under the SAME holder collapse to ONE (the smallest
 * document_id survives — stable across re-reads); different holders stay separate; a re-spacing of
 * the same entity groups; an INCOMPATIBLE segmentation does NOT; non-bank / holder-less / id-less
 * findings are untouched; never throws.
 */
const assert = require('assert');
const { collapseBankEntityDuplicates } = require('../src/lib/underwriting/bank-entity-dedup');

const bf = (id, docId, holder, code = 'bank_business_entity_unverified') =>
  ({ id, document_id: docId, code, severity: 'warning', field: 'account_holder', doc_value: holder });

// 1. FOUR statements under the SAME entity → collapse to ONE. The smallest document_id survives;
//    the other three ids are returned for resolve+splice.
{
  const findings = [
    bf('f1', 'doc-4', 'Coretex Solutions LLC'),
    bf('f2', 'doc-1', 'Coretex Solutions LLC'),
    bf('f3', 'doc-3', 'Coretex Solutions LLC'),
    bf('f4', 'doc-2', 'Coretex Solutions LLC'),
  ];
  const { resolvedIds } = collapseBankEntityDuplicates(findings);
  assert.strictEqual(resolvedIds.length, 3, 'three of four fold away');
  // survivor = smallest document_id ('doc-1' = f2) → NOT resolved; the rest ARE.
  assert.ok(!resolvedIds.includes('f2'), 'the smallest-document_id finding survives');
  assert.deepStrictEqual(resolvedIds.slice().sort(), ['f1', 'f3', 'f4'], 'the other three are folded');
}

// 2. The survivor is DETERMINISTIC across re-reads — a re-created set (new finding ids, SAME
//    document_ids) folds onto the same physical document, so a dismiss on the survivor stays put.
{
  const round1 = collapseBankEntityDuplicates([bf('a1', 'doc-9', 'X LLC'), bf('a2', 'doc-5', 'X LLC')]);
  const round2 = collapseBankEntityDuplicates([bf('b1', 'doc-9', 'X LLC'), bf('b2', 'doc-5', 'X LLC')]);
  // round1 survivor is doc-5 (a2) → a1 resolved; round2 survivor is doc-5 (b2) → b1 resolved.
  assert.deepStrictEqual(round1.resolvedIds, ['a1']);
  assert.deepStrictEqual(round2.resolvedIds, ['b1'], 'same physical document survives after a re-read');
}

// 3. DIFFERENT holders stay separate — nothing folds.
{
  const { resolvedIds } = collapseBankEntityDuplicates([
    bf('f1', 'doc-1', 'Coretex Solutions LLC'),
    bf('f2', 'doc-2', 'Blue Harbor Capital LLC'),
  ]);
  assert.strictEqual(resolvedIds.length, 0, 'two different entities → both stay');
}

// 4. A RE-SPACING of the same entity groups (uses the shared entityMatch).
{
  const { resolvedIds } = collapseBankEntityDuplicates([
    bf('f1', 'doc-1', 'Core Tex Solutions LLC'),
    bf('f2', 'doc-2', 'Coretex Solutions LLC'),
  ]);
  assert.strictEqual(resolvedIds.length, 1, '"Core Tex" and "Coretex" are the same entity → collapse');
  assert.deepStrictEqual(resolvedIds, ['f2'], 'doc-1 survives, doc-2 folds');
}

// 5. An INCOMPATIBLE segmentation of the same letters is NOT the same entity → stays separate.
{
  const { resolvedIds } = collapseBankEntityDuplicates([
    bf('f1', 'doc-1', 'Ace Homes LLC'),
    bf('f2', 'doc-2', 'Aceh Omes LLC'),
  ]);
  assert.strictEqual(resolvedIds.length, 0, '"Ace Homes" vs "Aceh Omes" are different entities → both stay');
}

// 6. The other bank-entity code collapses too, and mixes with the first by holder.
{
  const { resolvedIds } = collapseBankEntityDuplicates([
    bf('f1', 'doc-1', 'Coretex Solutions LLC', 'bank_account_other_entity'),
    bf('f2', 'doc-2', 'Coretex Solutions LLC', 'bank_account_other_entity'),
  ]);
  assert.strictEqual(resolvedIds.length, 1, 'bank_account_other_entity duplicates also collapse');
}

// 7. Non-bank findings, fatal personal-account findings, holder-less and id-less rows are UNTOUCHED.
{
  const { resolvedIds } = collapseBankEntityDuplicates([
    { id: 'x1', code: 'id_name_mismatch', document_id: 'd1', doc_value: 'whatever' },
    { id: 'x2', code: 'bank_account_not_borrower', document_id: 'd2', doc_value: 'Some Person' },
    { id: 'x3', code: 'bank_account_not_borrower', document_id: 'd3', doc_value: 'Some Person' },
    { id: 'x4', code: 'bank_business_entity_unverified', document_id: 'd4', doc_value: '' }, // no holder
    bf(null, 'd5', 'Coretex Solutions LLC'), // no stored id → cannot be resolved, never folded
    bf(null, 'd6', 'Coretex Solutions LLC'),
  ]);
  // The fatal personal-account code is NOT in the entity set → not collapsed.
  // The holder-less row is skipped. The two id-less findings CAN group, but with no id neither can be
  // added to resolvedIds (we never resolve a row we can't identify) — so nothing is returned.
  assert.strictEqual(resolvedIds.length, 0, 'non-entity / holder-less / id-less findings are untouched');
}

// 8. Never throws on hostile input.
assert.deepStrictEqual(collapseBankEntityDuplicates(null).resolvedIds, []);
assert.deepStrictEqual(collapseBankEntityDuplicates(undefined).resolvedIds, []);
assert.deepStrictEqual(collapseBankEntityDuplicates([null, undefined, {}]).resolvedIds, []);

console.log('✓ test-bank-entity-dedup-pure: same-holder collapse + deterministic survivor + separation + safety pass');
