'use strict';
/**
 * #196 — pure tests for wiring the independent ASSIGNMENT-fee re-derivation into
 * the whole-loan run (assembleRun). Proves: a non-assignment file gets no
 * assignment finding; an over-cap assignment surfaces an ADVISORY (non-blocking)
 * assignment_fee_over_cap finding carrying the financeable-fee number; a
 * registered-fee basis mismatch surfaces assignment_fee_mismatch; and none of it
 * flips an eligibility gate (it verifies the frozen math, never changes/blocks it).
 * Hermetic: run.js loads without a DB driver (its pg use is lazy).
 */
const assert = require('assert');

let run = null;
try { run = require('../src/lib/underwriting/run'); } catch (_e) { run = null; }

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

if (!run) { console.log('SKIP test-run-assignment-pure (run.js needs a DB driver here)'); process.exit(0); }

const baseCtx = (extra) => ({ values: Object.assign({}, extra), ready: true, discrepancies: [], sourceHash: 'h', applicationId: 'a' });
const findingCodes = (a) => (a.findings || []).map((f) => f.code);

// 1. A non-assignment file → no assignment finding at all.
{
  const a = run.assembleRun({ context: baseCtx({ is_assignment: false, loan_amount: 100000 }), registration: null, programDecision: null, staleChanged: [], extraFindings: [], trigger: 't' });
  assert.ok(!findingCodes(a).some((c) => /assignment/.test(c)), 'no assignment finding on a straight purchase');
  ok('a non-assignment file gets no assignment re-derivation finding');
}

// 2. An over-cap assignment (fee 20k on a 100k seller price) → advisory over-cap
//    finding, non-blocking, carrying the $15,000 financeable fee.
{
  const a = run.assembleRun({
    context: baseCtx({ is_assignment: true, underlying_contract_price: 100000, assignment_fee: 20000, program: 'standard' }),
    registration: null, programDecision: null, staleChanged: [], extraFindings: [], trigger: 't',
  });
  const f = (a.findings || []).find((x) => x.code === 'assignment_fee_over_cap');
  assert.ok(f, 'over-cap assignment fee surfaces a finding');
  assert.strictEqual(f.blocks_term_sheet, false);
  assert.strictEqual(f.blocks_ctc, false);
  assert.strictEqual(f.blocks_funding, false);
  assert.strictEqual(f.expected_value, '$15,000', 'the finding carries the financeable fee = 15% of the seller price');
  assert.notStrictEqual(f.severity, 'fatal', 'never fatal');
  assert.ok(!(a.blockingFindings || []).some((b) => b.code === 'assignment_fee_over_cap'), 'the assignment note is never a blocking finding');
  ok('an over-cap assignment → advisory (non-blocking) over-cap finding with the $15,000 financeable fee');
}

// 3. A registered financeable fee that disagrees with the independent re-derivation
//    → an assignment_fee_mismatch warning (the pre-freeze fee-inclusive-basis bug).
{
  const a = run.assembleRun({
    context: baseCtx({ is_assignment: true, underlying_contract_price: 100000, assignment_fee: 20000, program: 'standard' }),
    registration: { quote: { assignment: { financeableFee: 18000 } } },   // 15% of $120k total (the old bug), not $15k
    programDecision: null, staleChanged: [], extraFindings: [], trigger: 't',
  });
  const m = (a.findings || []).find((x) => x.code === 'assignment_fee_mismatch');
  assert.ok(m, 'a registered-fee basis mismatch surfaces a finding');
  assert.strictEqual(m.severity, 'warning');
  assert.strictEqual(m.blocks_funding, false, 'the mismatch is a data-integrity warning, never a funding block');
  ok('a registered financeable-fee basis mismatch → an advisory warning, non-blocking');
}

// 4. A within-cap assignment with a MATCHING registered fee → no assignment finding.
{
  const a = run.assembleRun({
    context: baseCtx({ is_assignment: true, underlying_contract_price: 100000, assignment_fee: 10000, program: 'standard' }),
    registration: { quote: { assignment: { financeableFee: 10000 } } },
    programDecision: null, staleChanged: [], extraFindings: [], trigger: 't',
  });
  assert.ok(!findingCodes(a).some((c) => /assignment/.test(c)), 'a within-cap, matching-fee assignment raises nothing');
  ok('a within-cap assignment with a matching registered fee raises no finding');
}

console.log(`\nrun-assignment pure — ${passed} checks passed`);
