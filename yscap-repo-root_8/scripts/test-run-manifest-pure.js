'use strict';
/**
 * #214 — pure tests for the per-run REVIEW MANIFEST (orchestration proof). Proves:
 * a complete run reports every required component present + complete:true + NO
 * advisory; a run missing a required component reports it absent + complete:false
 * + ONE advisory that blocks NOTHING (an incomplete run is an advisory, never a
 * gate, never a block); an assignment component is not_applicable off-assignment;
 * verification defaults to attested; and nothing ever throws.
 */
const assert = require('assert');
const m = require('../src/lib/underwriting/run-manifest');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const completeSignals = {
  contextReady: true, programDecision: true, hasLoanBasis: true,
  verificationAttested: true, isAssignment: false, assignmentRan: false,
};

// 1. A complete run: all required present, complete:true, no advisory.
{
  const man = m.buildManifest(completeSignals);
  assert.strictEqual(man.complete, true);
  assert.deepStrictEqual(man.missingRequired, []);
  const req = man.components.filter((c) => c.required);
  assert.ok(req.every((c) => c.status === 'present'), 'every required component is present');
  assert.deepStrictEqual(m.manifestFindings(man), [], 'a complete run raises no advisory');
  ok('a complete run: every required component present, complete, no advisory');
}

// 2. Missing a required component → absent + complete:false + ONE advisory that blocks nothing.
{
  const man = m.buildManifest(Object.assign({}, completeSignals, { programDecision: false }));
  assert.strictEqual(man.complete, false);
  assert.deepStrictEqual(man.missingRequired, ['program_pricing']);
  const findings = m.manifestFindings(man);
  assert.strictEqual(findings.length, 1, 'ONE consolidated advisory');
  const f = findings[0];
  assert.strictEqual(f.code, 'run_incomplete');
  assert.strictEqual(f.severity, 'warning');
  assert.strictEqual(f.blocks_term_sheet, false);
  assert.strictEqual(f.blocks_ctc, false);
  assert.strictEqual(f.blocks_funding, false);
  assert.ok(/program pricing/i.test(f.explanation), 'the advisory names the missing component');
  ok('a missing required component → advisory that blocks NOTHING (never a gate)');
}

// 3. Multiple missing → one advisory listing all of them.
{
  const man = m.buildManifest({ contextReady: false, programDecision: false, hasLoanBasis: false, verificationAttested: true });
  assert.deepStrictEqual(man.missingRequired.sort(), ['context_ready', 'program_pricing', 'structure_ledger']);
  const findings = m.manifestFindings(man);
  assert.strictEqual(findings.length, 1);
  assert.ok(/complete/i.test(findings[0].explanation) && findings[0].explanation.split(';').length >= 3, 'all missing components listed');
  ok('multiple missing required components → one consolidated advisory listing all');
}

// 4. Assignment component: not_applicable off-assignment; present/absent on-assignment.
{
  const off = m.buildManifest(completeSignals);
  const asgOff = off.components.find((c) => c.key === 'assignment_analysis');
  assert.strictEqual(asgOff.status, 'not_applicable', 'no assignment → n/a');
  assert.strictEqual(off.complete, true, 'an n/a optional component never blocks completeness');

  const on = m.buildManifest(Object.assign({}, completeSignals, { isAssignment: true, assignmentRan: true }));
  assert.strictEqual(on.components.find((c) => c.key === 'assignment_analysis').status, 'present');
  const onMissing = m.buildManifest(Object.assign({}, completeSignals, { isAssignment: true, assignmentRan: false }));
  assert.strictEqual(onMissing.components.find((c) => c.key === 'assignment_analysis').status, 'absent');
  assert.strictEqual(onMissing.complete, true, 'an OPTIONAL component absent does not make the run incomplete');
  ok('assignment component is n/a off-assignment; optional-absent never breaks completeness');
}

// 5. signalsFromRun derives the booleans from an assembleRun-shaped input.
{
  const s = m.signalsFromRun({
    context: { ready: true, values: { loan_amount: 500000, is_assignment: true } },
    programDecision: {},
    verificationAttested: true,
  }, [{ metric: 'ltc' }]);
  assert.strictEqual(s.contextReady, true);
  assert.strictEqual(s.programDecision, true);
  assert.strictEqual(s.hasLoanBasis, true);
  assert.strictEqual(s.isAssignment, true);
  assert.strictEqual(s.assignmentRan, true);
  // no loan basis → hasLoanBasis false
  const s2 = m.signalsFromRun({ context: { ready: false, values: {} } }, []);
  assert.strictEqual(s2.hasLoanBasis, false);
  assert.strictEqual(s2.programDecision, false);
  // verification defaults attested unless explicitly false
  assert.strictEqual(m.signalsFromRun({ context: {} }, []).verificationAttested, true);
  assert.strictEqual(m.signalsFromRun({ context: {}, verificationAttested: false }, []).verificationAttested, false);
  ok('signalsFromRun derives the manifest booleans from an assembleRun input');
}

// 6. Hostile input never throws.
{
  for (const bad of [null, undefined, 42, 'x', []]) {
    assert.doesNotThrow(() => m.buildManifest(bad));
    assert.doesNotThrow(() => m.manifestFindings(bad));
    assert.doesNotThrow(() => m.signalsFromRun(bad, bad));
  }
  ok('buildManifest / manifestFindings / signalsFromRun never throw on hostile input');
}

console.log(`\nrun-manifest pure — ${passed} checks passed`);
