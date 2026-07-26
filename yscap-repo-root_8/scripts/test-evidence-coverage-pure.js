'use strict';
/**
 * R5.18 — pure tests for evidence coverage + citation validation. Guarantees:
 * coverage counts only DIRECT support toward a material fact, an uncited
 * material fact is "unable_to_determine" (never verifiable), and a hallucinated
 * citation is rejected.
 */
const assert = require('assert');
const { coverage, validateCitations, verifiability } = require('../src/lib/underwriting/evidence-coverage');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const facts = [
  { key: 'purchase_price', material: true },
  { key: 'seller_name', material: true },
  { key: 'buyer_entity', material: true },
  { key: 'listing_agent', material: false },   // not material
];
const links = [
  { factKey: 'purchase_price', supportType: 'direct' },
  { factKey: 'seller_name', supportType: 'corroborating' },   // NOT direct → not cited
  // buyer_entity has NO link → uncited
];

const cov = coverage(facts, links);
assert.strictEqual(cov.materialCount, 3, 'three material facts');
assert.strictEqual(cov.citedCount, 1, 'only purchase_price has direct evidence');
assert.deepStrictEqual(cov.uncitedMaterial.sort(), ['buyer_entity', 'seller_name']);
assert.strictEqual(cov.coveragePct, 33.3, 'coverage is over material facts only');
ok('coverage counts only DIRECT support toward material facts');

// a corroborating-only link does not verify a material fact.
assert.ok(cov.uncitedMaterial.includes('seller_name'), 'corroborating alone is not cited');
ok('corroborating-only evidence does not verify a material fact');

// api_response + guideline_citation count as direct/authoritative.
const cov2 = coverage([{ key: 'balance', material: true }], [{ factKey: 'balance', supportType: 'api_response' }]);
assert.strictEqual(cov2.citedCount, 1, 'an API observation is authoritative');
ok('api_response / guideline_citation count as authoritative support');

// verifiability: uncited material → unable_to_determine.
const ver = verifiability(facts, links);
assert.strictEqual(ver.purchase_price, 'verifiable');
assert.strictEqual(ver.seller_name, 'unable_to_determine');
assert.strictEqual(ver.buyer_entity, 'unable_to_determine');
assert.strictEqual(ver.listing_agent, 'not_material');
ok('an uncited material fact is unable_to_determine (never verifiable)');

// full coverage → 100%.
assert.strictEqual(coverage([{ key: 'a', material: true }], [{ factKey: 'a', supportType: 'direct' }]).coveragePct, 100);
assert.strictEqual(coverage([], []).coveragePct, 100, 'no material facts → 100% vacuously');
ok('full / empty coverage compute correctly');

// citation validation rejects a hallucinated span id.
let r = validateCitations(['s1', 's2', 'ghost'], new Set(['s1', 's2', 's3']));
assert.strictEqual(r.ok, false);
assert.deepStrictEqual(r.unknown, ['ghost']);
ok('a hallucinated citation is rejected');

r = validateCitations(['s1'], ['s1', 's2']);
assert.strictEqual(r.ok, true);
assert.strictEqual(validateCitations([], []).ok, true);
ok('valid / empty citation sets pass');

console.log(`\nR5.18 evidence-coverage pure — ${passed} checks passed`);
