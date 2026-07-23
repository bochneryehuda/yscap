'use strict';
/**
 * #200 — pure tests for the shadow-decision live feed. Proves: a whole-loan run
 * maps to a calibration candidate with the correct canonical verdict + gates from
 * either snake or camel gate names; terminal human statuses map to clear/decline
 * and non-terminal statuses map to null (leave the shadow open); and the pure
 * helpers never throw on hostile input.
 */
const assert = require('assert');
const sc = require('../src/lib/underwriting/shadow-capture');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// 1. Run → candidate: ELIGIBLE maps to a 'clear' verdict; gates carried (camel).
{
  const c = sc.runToShadowCandidate({ status: 'ELIGIBLE', termSheetEligible: true, ctcEligible: false, fundingEligible: false, runId: 'r1' });
  assert.strictEqual(c.component, 'whole_loan');
  assert.strictEqual(c.verdict, 'clear', 'ELIGIBLE → clear');
  assert.strictEqual(c.rawVerdict, 'ELIGIBLE');
  assert.deepStrictEqual(c.gates, { termSheet: true, ctc: false, funding: false });
  assert.strictEqual(c.runId, 'r1');
  ok('an eligible run maps to a clear candidate with gates (camel names)');
}

// 2. Snake-cased persisted row gate names are read the same way.
{
  const c = sc.runToShadowCandidate({ status: 'INELIGIBLE', term_sheet_eligible: false, ctc_eligible: false, funding_eligible: false, id: 'r2' });
  assert.strictEqual(c.verdict, 'decline', 'INELIGIBLE → decline');
  assert.strictEqual(c.gates.termSheet, false);
  assert.strictEqual(c.runId, 'r2', 'falls back to id when runId absent');
  ok('an ineligible persisted run maps to a decline candidate (snake names)');
}

// 3. MANUAL_PENDING → refer; NOT_READY → unknown.
{
  assert.strictEqual(sc.runToShadowCandidate({ status: 'MANUAL_PENDING' }).verdict, 'refer');
  assert.strictEqual(sc.runToShadowCandidate({ status: 'NOT_READY' }).verdict, 'unknown');
  ok('manual → refer; not-ready → unknown');
}

// 4. outcomeFromStatus: terminal human statuses map; in-process is null.
{
  assert.strictEqual(sc.outcomeFromStatus('funded'), 'clear');
  assert.strictEqual(sc.outcomeFromStatus('Funded'), 'clear', 'case-insensitive');
  assert.strictEqual(sc.outcomeFromStatus('declined'), 'decline');
  assert.strictEqual(sc.outcomeFromStatus('withdrawn'), 'decline');
  assert.strictEqual(sc.outcomeFromStatus('clear-to-close'), null, 'CTC is not a terminal outcome');
  assert.strictEqual(sc.outcomeFromStatus('in_review'), null);
  assert.strictEqual(sc.outcomeFromStatus(''), null);
  assert.strictEqual(sc.outcomeFromStatus(null), null);
  ok('terminal statuses map to clear/decline; in-process → null (shadow stays open)');
}

// 5. Hostile input never throws.
{
  for (const bad of [null, undefined, 42, 'x', {}, []]) {
    assert.doesNotThrow(() => sc.runToShadowCandidate(bad));
    assert.doesNotThrow(() => sc.outcomeFromStatus(bad));
  }
  const c = sc.runToShadowCandidate(null);
  assert.strictEqual(c.verdict, 'unknown');
  ok('hostile input degrades safely (never throws)');
}

console.log(`\nshadow-capture pure — ${passed} checks passed`);
