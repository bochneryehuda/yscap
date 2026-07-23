'use strict';
/**
 * #206 — pure tests for the sign-off cure-proof + required-condition manifest.
 * Proves the condition-logic gaps are closed:
 *   • a condition marked satisfied but with NO cure proof attached is a GAP
 *     (no_proof), never a pass — the silent hole this closes;
 *   • a required condition entirely ABSENT from the file is a gap (not_created);
 *   • unmet / stale / wrong-party contract evaluations each get their own reason;
 *   • ready only when EVERY required condition is satisfied WITH proof;
 *   • the explicit requiredCodes manifest overrides per-condition flags;
 *   • non-required conditions are informational and never gate;
 *   • it never hard-blocks (overridable always true, #217) and never throws.
 */
const assert = require('assert');
const sm = require('../src/lib/underwriting/signoff-manifest');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const met = (over = {}) => Object.assign({ satisfied: true, met: ['r1'], missing: [], stale: [], wrongParty: [] }, over);
const unmet = (over = {}) => Object.assign({ satisfied: false, met: [], missing: ['r1'], stale: [], wrongParty: [] }, over);

// 1. satisfied contract but NO proof → no_proof gap (the silent hole).
{
  const r = sm.signoffReadiness([
    { code: 'title', required: true, evaluation: met(), proofs: [] }, // cleared, no proof
    { code: 'insurance', required: true, evaluation: met(), proofs: [{ id: 'd1' }] }, // cleared + proof
  ]);
  assert.strictEqual(r.ready, false, 'a required condition cleared without proof blocks readiness');
  assert.ok(r.gaps.some((g) => g.code === 'title' && g.gap === sm.GAP.NO_PROOF), 'no-proof condition is a gap');
  assert.deepStrictEqual(r.manifest.satisfied, ['insurance']);
  assert.strictEqual(r.requiredSatisfied, 1);
  assert.strictEqual(r.requiredUnsatisfied, 1);
  ok('a satisfied condition with no cure proof is a gap, not a pass');
}

// 2. a required condition absent from the file → not_created gap.
{
  const r = sm.signoffReadiness(
    [{ code: 'title', required: true, evaluation: met(), proofs: [{ id: 'd1' }] }],
    { requiredCodes: ['title', 'appraisal'] }, // appraisal never created
  );
  assert.ok(r.manifest.missing.includes('appraisal'));
  assert.ok(r.gaps.some((g) => g.code === 'appraisal' && g.gap === sm.GAP.NOT_CREATED));
  assert.strictEqual(r.ready, false);
  ok('a required condition never created on the file is a not_created gap');
}

// 3. unmet / stale / wrong-party each map to their own reason.
{
  const r = sm.signoffReadiness([
    { code: 'a', required: true, evaluation: unmet(), proofs: [{ id: 1 }] },
    { code: 'b', required: true, evaluation: unmet({ stale: ['r1'] }), proofs: [{ id: 1 }] },
    { code: 'c', required: true, evaluation: unmet({ wrongParty: ['r1'] }), proofs: [{ id: 1 }] },
  ]);
  const g = Object.fromEntries(r.gaps.map((x) => [x.code, x.gap]));
  assert.strictEqual(g.a, sm.GAP.UNMET);
  assert.strictEqual(g.b, sm.GAP.STALE);
  assert.strictEqual(g.c, sm.GAP.WRONG_PARTY);
  assert.ok(r.gaps.every((x) => typeof x.reason === 'string' && x.reason.length));
  ok('unmet / stale / wrong-party evaluations each get their own reason');
}

// 4. ready only when every required condition is satisfied WITH proof.
{
  const allGood = sm.signoffReadiness([
    { code: 'title', required: true, evaluation: met(), proofs: [{ id: 1 }] },
    { code: 'insurance', required: true, evaluation: met(), proofs: [{ id: 2 }] },
  ]);
  assert.strictEqual(allGood.ready, true);
  assert.strictEqual(allGood.status, 'ready');
  assert.deepStrictEqual(allGood.gaps, []);
  ok('ready + status ready only when every required condition is satisfied with proof');
}

// 5. explicit requiredCodes manifest overrides per-condition flags.
{
  // title is NOT flagged required on the condition, but the manifest requires it.
  const r = sm.signoffReadiness(
    [{ code: 'title', required: false, evaluation: met(), proofs: [] }],
    { requiredCodes: ['title'] },
  );
  assert.strictEqual(r.requiredTotal, 1, 'the explicit manifest sets the required set');
  assert.ok(r.gaps.some((g) => g.code === 'title' && g.gap === sm.GAP.NO_PROOF));
  ok('an explicit requiredCodes manifest overrides per-condition required flags');
}

// 6. non-required conditions are informational and never gate.
{
  const r = sm.signoffReadiness([
    { code: 'req', required: true, evaluation: met(), proofs: [{ id: 1 }] },
    { code: 'optional', required: false, evaluation: unmet(), proofs: [] }, // unsatisfied but not required
  ]);
  assert.strictEqual(r.ready, true, 'an unsatisfied NON-required condition never blocks readiness');
  assert.ok(r.byCondition.some((c) => c.code === 'optional' && c.required === false && !c.satisfied));
  assert.ok(!r.gaps.some((g) => g.code === 'optional'), 'a non-required condition is never a manifest gap');
  ok('non-required conditions are informational and never gate readiness');
}

// 7. proofCount tolerates the several proof shapes.
{
  assert.strictEqual(sm.proofCount({ proofCount: 3 }), 3);
  assert.strictEqual(sm.proofCount({ cureProofs: [1, 2] }), 2);
  assert.strictEqual(sm.proofCount({ evidence: [1] }), 1);
  assert.strictEqual(sm.proofCount({ evidenceSet: { items: [1, 2, 3] } }), 3);
  assert.strictEqual(sm.proofCount({}), 0);
  ok('proofCount reads cureProofs / proofs / evidence / evidenceSet.items / proofCount');
}

// 8. never hard-blocks (overridable always true) and never throws.
{
  const r = sm.signoffReadiness([{ code: 'x', required: true, evaluation: unmet(), proofs: [] }]);
  assert.strictEqual(r.overridable, true, 'a super-admin can always sign off over gaps — never a hard block');
  assert.ok(!('block' in r) && !('blocks' in r));
  for (const bad of [null, undefined, 42, 'x', {}, [null], [{ code: null }], { requiredCodes: 7 }]) {
    assert.doesNotThrow(() => sm.signoffReadiness(bad));
    assert.doesNotThrow(() => sm.signoffReadiness(bad, bad));
  }
  const empty = sm.signoffReadiness([]);
  assert.strictEqual(empty.ready, true, 'nothing required → trivially ready');
  assert.strictEqual(empty.overridable, true);
  ok('never hard-blocks (overridable always true); hostile input never throws');
}

console.log(`\nsignoff-manifest pure — ${passed} checks passed`);
