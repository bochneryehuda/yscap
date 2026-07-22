'use strict';
/**
 * R6.19 — pure tests for the master AI underwriter EXPLAINER prompt. Proves the
 * prompt is built from the deterministic run (never asks the AI to re-decide or
 * recompute), and that the result validator REJECTS any attempt by the model to
 * return a decision/status/number — the deterministic decision always governs,
 * and the agent only advises.
 */
const assert = require('assert');
const up = require('../src/lib/underwriting/underwriter-prompt');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- the system prompt forbids inventing numbers / overriding the decision ---
assert.ok(/NEVER invent or change/i.test(up.SYSTEM_PROMPT), 'the system prompt forbids inventing numbers');
assert.ok(/NEVER override/i.test(up.SYSTEM_PROMPT), 'the system prompt forbids overriding the decision');
assert.ok(/SUGGESTION/i.test(up.SYSTEM_PROMPT), 'everything is a suggestion for a human');
ok('the system prompt forbids inventing numbers and overriding the deterministic decision');

// --- promptFor builds the user payload from a run result (no recompute ask) ---
const run = {
  status: 'MANUAL_PENDING',
  termSheetEligible: false, ctcEligible: false, fundingEligible: false,
  reasons: ['This loan needs a super-admin exception approval before terms can issue.'],
  findings: [{ code: 'program_manual_reason', severity: 'warning', title: 'Program manual-review reason', explanation: 'Assignment fee over cap', blocks_term_sheet: true }],
  governingValues: { loan_amount: 450000, program: 'gold' },
};
const p = up.promptFor({ run });
assert.strictEqual(p.system, up.SYSTEM_PROMPT);
const user = JSON.parse(p.user);
assert.strictEqual(user.status, 'MANUAL_PENDING', 'the deterministic status is handed to the model as fact');
assert.strictEqual(user.gates.termSheetEligible, false);
assert.strictEqual(user.findings.length, 1);
assert.ok(/Do NOT change any number/i.test(user.instruction), 'the instruction forbids changing numbers');
ok('promptFor builds the user payload from the deterministic run (status/gates/findings as fact)');

// --- validateResult accepts a clean explanation-only response ---
let v = up.validateResult({
  summary: 'The loan needs a super-admin review before terms can issue.',
  explanations: [{ topic: 'status', plain: 'A manual review reason is open.', findingCode: 'program_manual_reason' }],
  suggestedConditions: [{ title: 'Obtain super-admin exception approval', why: 'A manual-review reason is open.' }],
  missingEvidence: [{ item: 'Super-admin approval', why: 'Required before issuing terms.' }],
});
assert.strictEqual(v.ok, true);
assert.strictEqual(v.value.suggestedConditions.length, 1);
ok('validateResult accepts a clean suggestions-only response');

// --- validateResult REJECTS an attempt to re-decide / return a number ---
for (const bad of [
  { status: 'ELIGIBLE', summary: 'x' },
  { termSheetEligible: true },
  { noteRate: 0.09 },
  { loanAmount: 500000 },
  { approved: true },
  { decision: {} },
]) {
  const r = up.validateResult(bad);
  assert.strictEqual(r.ok, false, `must reject a response containing ${Object.keys(bad)[0]}`);
}
ok('validateResult REJECTS any response that tries to re-decide or return a number/rate/loan amount');

// --- a non-object result is rejected ---
assert.strictEqual(up.validateResult(null).ok, false);
assert.strictEqual(up.validateResult('nope').ok, false);
ok('a non-object model response is rejected');

console.log(`\nR6.19 underwriter-prompt pure — ${passed} checks passed`);
