'use strict';
/**
 * R6.18 — pure tests for the single issuance gate. Proves every export/CTC/
 * funding action is permitted ONLY when the whole-loan decision allows it, that
 * it fails CLOSED (no decision / unknown action → denied), and that it reads both
 * the decision shape and the stored-run row shape.
 */
const assert = require('assert');
const gate = require('../src/lib/underwriting/issuance-gate');
const dec = require('../src/lib/underwriting/decision');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- ELIGIBLE decision → every action allowed ---
let d = dec.decide({ engineStatus: 'ELIGIBLE', findings: [] });
for (const a of ['term_sheet', 'ctc', 'funding']) {
  assert.strictEqual(gate.gateFor(d, a).allowed, true, `${a} allowed when ELIGIBLE`);
}
ok('an ELIGIBLE decision permits term sheet + CTC + funding');

// --- MANUAL_PENDING → every action denied with a reason ---
d = dec.decide({ engineStatus: 'MANUAL', manualApproved: false, findings: [] });
for (const a of ['term_sheet', 'ctc', 'funding']) {
  const g = gate.gateFor(d, a);
  assert.strictEqual(g.allowed, false, `${a} denied when MANUAL_PENDING`);
  assert.ok(g.reason, 'a reason is given');
}
ok('MANUAL_PENDING denies every issuance action (the critical stop)');

// --- fatal finding under ELIGIBLE → every issuance action denied ---
// (fix 2026-07-23: summarize now blocks the term sheet on any fatal, matching
// blockersFor which already listed a fatal as a term-sheet blocker.)
d = dec.decide({ engineStatus: 'ELIGIBLE', findings: [{ code: 'x', severity: 'fatal', source: 'appraisal' }] });
assert.strictEqual(gate.gateFor(d, 'ctc').allowed, false, 'a fatal finding blocks CTC');
assert.strictEqual(gate.gateFor(d, 'funding').allowed, false, 'a fatal finding blocks funding');
assert.strictEqual(gate.gateFor(d, 'term_sheet').allowed, false, 'a fatal finding blocks the term sheet too');
assert.ok(gate.gateFor(d, 'ctc').blockers.length >= 1, 'the blocking finding is surfaced');
ok('a fatal finding blocks term sheet + CTC + funding (with the blocker surfaced)');

// --- DATA_CONFLICT → CTC + funding denied ---
d = dec.decide({ engineStatus: 'ELIGIBLE', discrepancies: [{ field: 'loan_amount' }], findings: [] });
assert.strictEqual(gate.gateFor(d, 'ctc').allowed, false);
assert.strictEqual(gate.gateFor(d, 'funding').allowed, false);
ok('a DATA_CONFLICT decision blocks CTC + funding');

// --- fail closed: no decision, unknown action ---
assert.strictEqual(gate.gateFor(null, 'ctc').allowed, false, 'no decision → denied');
assert.strictEqual(gate.gateFor(dec.decide({ engineStatus: 'ELIGIBLE', findings: [] }), 'wire_money').allowed, false, 'unknown action → denied');
ok('the gate fails CLOSED on a missing decision or an unknown action');

// --- reads the STORED-RUN row shape (snake_case) too ---
const runRow = { status: 'ELIGIBLE', term_sheet_eligible: true, ctc_eligible: false, funding_eligible: false };
assert.strictEqual(gate.gateFor(runRow, 'term_sheet').allowed, true);
assert.strictEqual(gate.gateFor(runRow, 'ctc').allowed, false, 'stored run ctc_eligible=false denies CTC');
assert.strictEqual(gate.gateFor(runRow, 'funding').allowed, false);
ok('the gate reads a stored underwriting-run row (snake_case flags) as well as a live decision');

console.log(`\nR6.18 issuance-gate pure — ${passed} checks passed`);
