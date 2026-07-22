'use strict';
/**
 * R5.20/R5.24 — pure tests for the deterministic root-cause clusterer.
 */
const assert = require('assert');
const { analyzeRootCauses, _internals } = require('../src/lib/underwriting/root-cause');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// The owner's example: 4 name/vesting/OA symptoms → ONE root cause (entity name).
{
  const items = [
    { id: 'a', code: 'chain_seller_vs_title_grantor', severity: 'fatal', title: 'Title vesting mismatch' },
    { id: 'b', code: 'chain_title_vs_appraisal_owner', severity: 'warning', title: 'Insurance name mismatch' },
    { id: 'c', code: 'oa_signer_not_borrower', severity: 'warning', title: 'OA signer mismatch' },
    { id: 'd', code: 'oa_no_borrowing_authority', severity: 'fatal', title: 'Signing authority unclear' },
    { id: 'e', code: 'title_tax_lien', severity: 'fatal', title: 'Unrelated tax lien' },   // NOT clustered
  ];
  const { rootCauses, clusteredIds } = analyzeRootCauses(items);
  assert.strictEqual(rootCauses.length, 1, 'one root cause');
  assert.strictEqual(rootCauses[0].type, 'entity_name');
  assert.strictEqual(rootCauses[0].symptomCount, 4, 'clusters all 4 entity-name symptoms');
  assert.strictEqual(rootCauses[0].severity, 'fatal', 'worst severity in the cluster');
  assert.ok(/operating agreement/i.test(rootCauses[0].fix), 'names the single likely fix');
  assert.deepStrictEqual(clusteredIds.sort(), ['a', 'b', 'c', 'd']);
  assert.ok(!clusteredIds.includes('e'), 'the unrelated tax lien is NOT clustered');
}
ok("entity-name: 4 symptoms → 1 root cause + 1 fix; unrelated finding left alone");

// A single finding in a category is NOT a root cause (min cluster = 2).
{
  const { rootCauses } = analyzeRootCauses([{ id: 'x', code: 'contract_address_mismatch', severity: 'warning' }]);
  assert.strictEqual(rootCauses.length, 0, 'one symptom is just a finding, not a root cause');
}
ok('a lone symptom is not called a root cause');

// Multiple independent root causes are ranked by symptom count.
{
  const items = [
    { id: '1', code: 'contract_address_mismatch', severity: 'warning' },
    { id: '2', code: 'title_address_mismatch', severity: 'warning' },
    { id: '3', code: 'cross_address_mismatch', severity: 'warning' },
    { id: '4', code: 'identity_ssn_mismatch', severity: 'fatal' },
    { id: '5', code: 'identity_dob_mismatch', severity: 'warning' },
  ];
  const { rootCauses } = analyzeRootCauses(items);
  assert.strictEqual(rootCauses.length, 2, 'address + identity');
  assert.strictEqual(rootCauses[0].type, 'address', 'the 3-symptom cause ranks first');
  assert.strictEqual(rootCauses[1].type, 'identity');
}
ok('multiple root causes rank by symptom count');

// Unknown codes never cluster; empty/degenerate inputs never throw.
{
  assert.deepStrictEqual(analyzeRootCauses([]).rootCauses, []);
  assert.deepStrictEqual(analyzeRootCauses(null).rootCauses, []);
  assert.deepStrictEqual(analyzeRootCauses([{ id: 'z', code: 'totally_unknown_code' }]).rootCauses, []);
}
ok('unknown codes + empty inputs → no root causes, no throw');

// minCluster override lets a caller surface single-symptom causes if desired.
{
  const { rootCauses } = analyzeRootCauses([{ id: 'q', code: 'amendment_supersedes_file', severity: 'warning' }], { minCluster: 1 });
  assert.strictEqual(rootCauses.length, 1, 'minCluster:1 surfaces a single symptom');
  assert.strictEqual(rootCauses[0].type, 'amendment');
}
ok('minCluster override works');

// Every mapped code has type metadata (no dangling type).
for (const type of new Set(Object.values(_internals.CODE_RULES))) {
  assert.ok(_internals.TYPE_META[type] && _internals.TYPE_META[type].label && _internals.TYPE_META[type].fix,
    `type ${type} has label + fix`);
}
ok('every clustered type has a label + fix');

console.log(`\nR5.20/R5.24 root-cause pure: ${passed} checks passed`);
