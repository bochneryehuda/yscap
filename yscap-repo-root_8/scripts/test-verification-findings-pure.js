'use strict';
/**
 * #193 — pure tests for wiring independent VERIFICATION into the whole-loan run.
 * Proves the AVM-consensus report → run-finding mapping is ADVISORY (never a
 * block), only fires on a MATERIAL disagreement, and — when run.js loads — that
 * feeding it as an extra finding changes the run registry WITHOUT changing any
 * eligibility (advisory, a human decides). Hermetic: run.js is required only if
 * it loads without a DB driver.
 */
const assert = require('assert');
const vf = require('../src/lib/underwriting/verification-findings');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// 1. No material disagreement / not enough data → no finding.
{
  assert.strictEqual(vf.avmFindingFromReport(null), null);
  assert.strictEqual(vf.avmFindingFromReport({}), null, 'no comparison → null');
  assert.strictEqual(vf.avmFindingFromReport({ comparison: { disagrees: false } }), null, 'agreement → null');
  ok('no material AVM disagreement → no finding');
}

// 2. A material disagreement → an ADVISORY, non-blocking finding with the numbers.
{
  const f = vf.avmFindingFromReport({
    comparison: { disagrees: true, message: 'AVM consensus (median $700,000) is 16.7% HIGHER than the appraisal ($600,000)' },
    consensus: { median: 700000 }, appraisal: { value: 600000 }, thresholdPct: 0.10,
  });
  assert.ok(f, 'a finding is produced');
  assert.strictEqual(f.code, 'avm_consensus_disagreement');
  assert.strictEqual(f.severity, 'warning');
  assert.strictEqual(f.category, 'verification');
  assert.strictEqual(f.source, 'avm_consensus');
  // The advisory guarantee: it NEVER blocks any gate.
  assert.strictEqual(f.blocks_term_sheet, false);
  assert.strictEqual(f.blocks_ctc, false);
  assert.strictEqual(f.blocks_funding, false);
  assert.strictEqual(f.expected_value, '$600,000', 'expected = appraisal ARV');
  assert.strictEqual(f.actual_value, '$700,000', 'actual = AVM median');
  assert.ok(/16\.7% HIGHER/.test(f.explanation), 'the explanation carries the disagreement message');
  ok('a material AVM disagreement → an advisory (non-blocking) verification finding with both numbers');
}

// 3. Hostile input never throws.
{
  const hostile = { get comparison() { throw new Error('boom'); } };
  assert.strictEqual(vf.avmFindingFromReport(hostile), null, 'a throwing report degrades to null');
  ok('hostile report input degrades to null, never throws');
}

// 4. Integration (only when run.js loads without a DB driver): the finding lands
//    in the run registry but changes NO eligibility flag — advisory to the core.
{
  let run = null;
  try { run = require('../src/lib/underwriting/run'); } catch (_e) { run = null; }
  if (!run) {
    console.log('  ~~  SKIP assembleRun integration (run.js needs a DB driver here)');
  } else {
    const finding = vf.avmFindingFromReport({
      comparison: { disagrees: true, message: 'AVM higher' }, consensus: { median: 700000 }, appraisal: { value: 600000 }, thresholdPct: 0.1 });
    const ctx = { values: {}, ready: true, discrepancies: [], sourceHash: 'h', applicationId: 'a' };
    const base = run.assembleRun({ context: ctx, registration: null, programDecision: null, staleChanged: [], extraFindings: [], trigger: 't' });
    const withAvm = run.assembleRun({ context: ctx, registration: null, programDecision: null, staleChanged: [], extraFindings: [finding], trigger: 't' });
    assert.strictEqual(withAvm.termSheetEligible, base.termSheetEligible, 'term-sheet eligibility unchanged');
    assert.strictEqual(withAvm.ctcEligible, base.ctcEligible, 'CTC eligibility unchanged');
    assert.strictEqual(withAvm.fundingEligible, base.fundingEligible, 'funding eligibility unchanged');
    const reg = (withAvm.findings || []).find((x) => x.code === 'avm_consensus_disagreement');
    assert.ok(reg, 'the finding appears in the deduped registry');
    assert.strictEqual(reg.expected_value, '$600,000', 'the appraisal ARV survives consolidation (not NULLed)');
    assert.strictEqual(reg.actual_value, '$700,000', 'the AVM median survives consolidation (not NULLed)');
    ok('assembleRun: the AVM finding enters the registry (numbers intact) but changes no eligibility (advisory)');
  }
}

console.log(`\nverification-findings pure — ${passed} checks passed`);
