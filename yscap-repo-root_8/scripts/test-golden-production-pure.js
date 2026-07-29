'use strict';
/**
 * #219 — pure tests for the senior-underwriter-APPROVED golden production set +
 * end-to-end replay. Proves:
 *   • isSeniorApproved gates on a senior role + an approver + a ground-truth verdict;
 *   • approvedSet filters to only release-grade cases;
 *   • coverage counts fatal (non-clear) + material-finding cases;
 *   • scoreCase flags a FALSE CLEAR (pipeline cleared, truth wasn't) and a
 *     MISSED MATERIAL (an approved material code the pipeline omitted);
 *   • replay folds a clean pipeline to GREEN (release passes) and a false-clearing
 *     pipeline to RED (release fails, with a blocker);
 *   • a runFn that throws is a SKIP, never a crash;
 *   • nothing ever throws on hostile input.
 */
const assert = require('assert');
const gp = require('../src/lib/underwriting/golden-production');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// a senior-approved case factory
const seniorCase = (over = {}) => Object.assign({
  id: 'c1',
  input: { appId: 'a1' },
  approval: { role: 'senior_underwriter', by: 'jane@yscap' },
  groundTruth: { verdict: 'decline', materialFindings: ['fraud_signal'] },
}, over);

async function main() {
  // 1. isSeniorApproved — needs a senior role AND an approver AND a truth verdict.
  {
    assert.strictEqual(gp.isSeniorApproved(seniorCase()), true, 'a fully-approved senior case is release-grade');
    assert.strictEqual(gp.isSeniorApproved(seniorCase({ approval: { role: 'processor', by: 'x@y' } })), false, 'a non-senior role is not release-grade');
    assert.strictEqual(gp.isSeniorApproved(seniorCase({ approval: { role: 'senior_underwriter', by: '' } })), false, 'a missing approver is not release-grade');
    assert.strictEqual(gp.isSeniorApproved(seniorCase({ groundTruth: { verdict: '' } })), false, 'a missing ground-truth verdict is not release-grade');
    assert.strictEqual(gp.isSeniorApproved(seniorCase({ approval: { role: 'super_admin', by: 'boss@y' } })), true, 'super_admin can approve');
    ok('isSeniorApproved gates on senior role + approver + ground-truth verdict');
  }

  // 2. approvedSet filters to only the release-grade cases.
  {
    const cases = [
      seniorCase({ id: 'a' }),
      seniorCase({ id: 'b', approval: { role: 'processor', by: 'x@y' } }),
      seniorCase({ id: 'c' }),
    ];
    const approved = gp.approvedSet(cases);
    assert.strictEqual(approved.length, 2, 'only the two senior-approved cases survive');
    assert.deepStrictEqual(approved.map((c) => c.id), ['a', 'c']);
    ok('approvedSet keeps only senior-approved cases');
  }

  // 3. coverage counts fatal (non-clear) + material-finding cases over the approved set.
  {
    const cases = [
      seniorCase({ id: 'x', groundTruth: { verdict: 'decline', materialFindings: ['fraud_signal'] } }),
      seniorCase({ id: 'y', groundTruth: { verdict: 'refer', materialFindings: [] } }),
      seniorCase({ id: 'z', groundTruth: { verdict: 'clear', materialFindings: [] } }),
      seniorCase({ id: 'p', approval: { role: 'loan_officer', by: 'x@y' } }), // pending — not approved
    ];
    const cov = gp.coverage(cases);
    assert.strictEqual(cov.total, 4);
    assert.strictEqual(cov.approved, 3);
    assert.strictEqual(cov.pending, 1);
    assert.strictEqual(cov.fatalCases, 2, 'decline + refer are the two non-clear (fatal-risk) cases');
    assert.strictEqual(cov.materialFindingCases, 1, 'only the decline carries a material finding');
    assert.strictEqual(cov.byVerdict.decline, 1);
    assert.strictEqual(cov.byVerdict.clear, 1);
    ok('coverage counts fatal + material-finding cases over the approved set');
  }

  // 4. scoreCase — a false clear and a missed material.
  {
    // pipeline CLEARED but the senior truth was a decline → false clear.
    const fc = gp.scoreCase({ verdict: 'clear', findings: [] }, { verdict: 'decline', materialFindings: ['fraud_signal'] });
    assert.strictEqual(fc.falseClear, true, 'cleared-but-declined is a false clear');
    assert.strictEqual(fc.missedMaterial, true, 'the approved fraud_signal code was not surfaced');

    // pipeline matched the verdict AND surfaced the material code → clean.
    const clean = gp.scoreCase({ verdict: 'decline', findings: ['fraud_signal'] }, { verdict: 'decline', materialFindings: ['fraud_signal'] });
    assert.strictEqual(clean.falseClear, false);
    assert.strictEqual(clean.missedMaterial, false);

    // pipeline cleared and truth was also clear → not a false clear.
    const bothClear = gp.scoreCase({ verdict: 'clear', findings: [] }, { verdict: 'clear', materialFindings: [] });
    assert.strictEqual(bothClear.falseClear, false, 'cleared-and-clear is correct, not a false clear');

    // truth UNKNOWN never counts against the pipeline.
    const unk = gp.scoreCase({ verdict: 'clear', findings: [] }, { verdict: 'unknown', materialFindings: [] });
    assert.strictEqual(unk.falseClear, false, 'an unknown truth is never a false clear');
    ok('scoreCase detects false clear + missed material, and never punishes a matched/unknown outcome');
  }

  // 5. replay — a CLEAN pipeline over a large approved set → green, release passes.
  {
    const cases = Array.from({ length: 25 }, (_, i) => seniorCase({
      id: `g${i}`, groundTruth: { verdict: 'clear', materialFindings: [] },
    }));
    const runFn = () => ({ verdict: 'clear', findings: [] });
    const clean = await gp.replay(cases, runFn);
    assert.strictEqual(clean.ran, 25, 'all 25 approved cases ran');
    assert.strictEqual(clean.skipped, 0);
    assert.strictEqual(clean.metrics.status, 'green', 'a clean pipeline over a large set is green');
    assert.strictEqual(clean.release.pass, true, 'release passes on green');
    ok('replay: a clean pipeline over a large approved set → green, release passes');
  }

  // 6. replay — a pipeline that FALSE-CLEARS a non-clear case → red, release fails.
  {
    const cases = Array.from({ length: 24 }, (_, i) => seniorCase({
      id: `c${i}`, groundTruth: { verdict: 'clear', materialFindings: [] },
    })).concat([seniorCase({ id: 'bad', groundTruth: { verdict: 'decline', materialFindings: ['fraud_signal'] } })]);
    // the pipeline clears EVERYTHING — including the decline case.
    const dirtyRun = () => ({ verdict: 'clear', findings: [] });
    const dirty = await gp.replay(cases, dirtyRun);
    assert.strictEqual(dirty.metrics.falseClears, 1, 'the decline case was false-cleared');
    assert.strictEqual(dirty.metrics.status, 'red', 'a single false clear fails the production bar');
    assert.strictEqual(dirty.release.pass, false, 'release fails on red');
    assert.ok(dirty.release.blockers.some((b) => /false clear/i.test(b)), 'a blocker names the false clear');
    assert.strictEqual(dirty.cases.find((c) => c.id === 'bad').falseClear, true);
    ok('replay: a false-clearing pipeline → red, release fails with a blocker');
  }

  // 7. a runFn that THROWS on a case is a skip, not a crash.
  {
    const cases = [
      seniorCase({ id: 'ok1', groundTruth: { verdict: 'clear', materialFindings: [] } }),
      seniorCase({ id: 'boom', input: null, inputs: null, groundTruth: { verdict: 'clear', materialFindings: [] } }),
    ];
    const throwyRun = (input) => { if (!input) throw new Error('no input'); return { verdict: 'clear', findings: [] }; };
    const r = await gp.replay(cases, throwyRun);
    assert.strictEqual(r.skipped, 1, 'the throwing case is skipped');
    assert.strictEqual(r.ran, 1, 'the good case still ran');
    assert.ok(r.cases.some((c) => c.id === 'boom' && c.skipped), 'the boom case is marked skipped');
    ok('replay: a runFn that throws is a skip, not a crash');
  }

  // 8. hostile input never throws.
  {
    for (const bad of [null, undefined, 42, 'x', {}, [null], [{}]]) {
      assert.doesNotThrow(() => gp.isSeniorApproved(bad));
      assert.doesNotThrow(() => gp.approvedSet(bad));
      assert.doesNotThrow(() => gp.coverage(bad));
      assert.doesNotThrow(() => gp.scoreCase(bad, bad));
    }
    const r = await gp.replay(null, null);
    assert.strictEqual(r.ran, 0);
    assert.strictEqual(r.release.pass, false, 'an empty replay is never a pass');
    // a null runFn on real cases → every case skips, never throws.
    const r2 = await gp.replay([seniorCase()], null);
    assert.strictEqual(r2.skipped, 1);
    ok('hostile input never throws; an empty/failed replay never passes');
  }

  console.log(`\ngolden-production pure — ${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
