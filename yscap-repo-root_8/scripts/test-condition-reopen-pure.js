'use strict';
/**
 * R5.31 — pure tests for the condition-reopen decision. Guarantees: each of the
 * four triggers reopens with the right reason, an OPEN condition never churns,
 * and a fresh/unchanged cleared condition stays cleared.
 */
const assert = require('assert');
const { decide, windowFor } = require('../src/lib/underwriting/condition-reopen');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const cleared = { cleared: true, kind: 'assets', clearedAt: '2026-06-01', guidelineVersionId: 'v1' };

// 1) superseded source.
let d = decide(cleared, { supersededSourceIds: ['doc-1'] });
assert.strictEqual(d.reopen, true);
assert.strictEqual(d.trigger, 'source_superseded');
ok('a superseded source reopens the condition');

// 2) expired evidence (assets window = 60 days; cleared 2026-06-01, asOf 2026-09-01 ≈ 92d).
d = decide(cleared, { asOf: '2026-09-01' });
assert.strictEqual(d.reopen, true);
assert.strictEqual(d.trigger, 'evidence_expired');
assert.ok(/freshness window/.test(d.reason));
ok('evidence past its freshness window reopens the condition');

// …but within the window it stays cleared.
d = decide(cleared, { asOf: '2026-06-20' });
assert.strictEqual(d.reopen, false, 'within the window it stays cleared');
ok('fresh evidence within the window does not reopen');

// 3) a supporting fact changed.
d = decide(cleared, { changedFactKeys: ['loan_amount'] });
assert.strictEqual(d.reopen, true);
assert.strictEqual(d.trigger, 'fact_changed');
ok('a changed supporting fact reopens the condition');

// 4) guideline version changed.
d = decide(cleared, { guidelineChangedTo: 'v2' });
assert.strictEqual(d.reopen, true);
assert.strictEqual(d.trigger, 'guideline_changed');
ok('a changed guideline version reopens the condition');

// same guideline version → no reopen.
d = decide(cleared, { guidelineChangedTo: 'v1' });
assert.strictEqual(d.reopen, false);
ok('an unchanged guideline version does not reopen');

// an OPEN (not cleared) condition never churns.
d = decide({ cleared: false, kind: 'assets' }, { supersededSourceIds: ['x'], changedFactKeys: ['y'] });
assert.strictEqual(d.reopen, false, 'an open condition is never reopened');
ok('an already-open condition never churns');

// a condition with no window never expires on age alone.
d = decide({ cleared: true, kind: 'entity', clearedAt: '2020-01-01' }, { asOf: '2030-01-01' });
assert.strictEqual(d.reopen, false, 'no window → no age expiry');
assert.strictEqual(windowFor('entity'), null);
ok('a condition with no freshness window does not expire on age');

// no signals → no reopen (no churn).
assert.strictEqual(decide(cleared, {}).reopen, false);
ok('no trigger → no reopen');

console.log(`\nR5.31 condition-reopen pure — ${passed} checks passed`);
