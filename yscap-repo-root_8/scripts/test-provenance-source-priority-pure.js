'use strict';
/**
 * R6.2 — pure tests for provenance + source-priority. Guarantees: a missing
 * value never coerces to 0/false, the highest-authority source governs, and a
 * lower-authority disagreement ALWAYS emits a discrepancy (never silently
 * dropped).
 */
const assert = require('assert');
const prov = require('../src/lib/underwriting/provenance');
const sp = require('../src/lib/underwriting/source-priority');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// provenance: a present value.
let f = prov.fact({ value: 650000, source: 'appraisal', sourceId: 'appr-1', sourceVersion: '2026-07-22', confidence: 'definite', governing: true });
assert.strictEqual(f.value, 650000);
assert.strictEqual(f.source, 'appraisal');
assert.strictEqual(f.confidence, 'definite');
assert.strictEqual(f.governing, true);
ok('a present fact carries value + source + version + confidence');

// a missing value stays null with confidence unknown — NEVER 0/false.
f = prov.fact({ value: undefined, source: 'application' });
assert.strictEqual(f.value, null, 'missing value is null, not 0');
assert.strictEqual(f.confidence, 'unknown');
assert.strictEqual(prov.isPresent(f), false);
assert.strictEqual(prov.valueOf(f, 'fallback'), 'fallback');
f = prov.fact({ value: null, source: 'x' });
assert.strictEqual(f.value, null);
ok('a missing/null value never coerces to 0 or false');

// isWrapped + valueOf.
assert.ok(prov.isWrapped(prov.fact({ value: 1, source: 's' })));
assert.ok(!prov.isWrapped({ value: 1 }));
assert.strictEqual(prov.valueOf(prov.fact({ value: 5, source: 's' })), 5);
ok('isWrapped + valueOf behave');

// source-priority: registration (rank 0) beats clickup (rank 6).
let r = sp.resolve('loan_amount', [
  prov.fact({ value: 500000, source: 'clickup' }),
  prov.fact({ value: 525000, source: 'registration' }),
]);
assert.strictEqual(r.value, 525000, 'registration governs over clickup');
assert.strictEqual(r.governingSource, 'registration');
assert.ok(r.discrepancy, 'the disagreement emits a discrepancy');
assert.strictEqual(r.discrepancy.conflicts[0].source, 'clickup');
ok('the highest-authority source governs + a disagreement emits a discrepancy');

// agreeing sources → no discrepancy (within a cent).
r = sp.resolve('loan_amount', [
  prov.fact({ value: 525000, source: 'registration' }),
  prov.fact({ value: 525000.004, source: 'application' }),
]);
assert.strictEqual(r.discrepancy, null, 'values within a cent agree');
ok('agreeing sources produce no discrepancy');

// absent candidates are ignored; a single present value governs with no conflict.
r = sp.resolve('arv', [prov.missing('appraisal'), prov.fact({ value: 700000, source: 'application' })]);
assert.strictEqual(r.value, 700000);
assert.strictEqual(r.discrepancy, null);
ok('absent candidates are ignored');

// no present candidate → null value, no governing source.
r = sp.resolve('arv', [prov.missing('appraisal'), prov.missing('application')]);
assert.strictEqual(r.value, null);
assert.strictEqual(r.governingSource, null);
ok('all-absent → null with no governing source');

// resolveAll collects discrepancies across fields.
const all = sp.resolveAll({
  loan_amount: [prov.fact({ value: 500000, source: 'clickup' }), prov.fact({ value: 525000, source: 'registration' })],
  arv: [prov.fact({ value: 700000, source: 'appraisal' })],
});
assert.strictEqual(all.discrepancies.length, 1, 'one discrepancy (loan_amount)');
assert.strictEqual(all.values.arv.value, 700000);
ok('resolveAll collects discrepancies across a field map');

// string values compared case/space-insensitively.
r = sp.resolve('program', [prov.fact({ value: 'Gold', source: 'registration' }), prov.fact({ value: 'gold', source: 'clickup' })]);
assert.strictEqual(r.discrepancy, null, '"Gold" and "gold" agree');
ok('string comparison is case/space-insensitive');

console.log(`\nR6.2 provenance + source-priority pure — ${passed} checks passed`);
