'use strict';
/**
 * R5.13 / R5.14 — pure tests for the evidence-ledger validators (no DB). The
 * load-bearing guarantees: span/support/role vocabularies are constrained, and
 * confidence is always a clean [0,1] or null (never a NaN into the ledger).
 */
const assert = require('assert');
const ledger = require('../src/lib/underwriting/evidence-ledger');
const { normSpanType, normSupportType, normFindingRole, normRequirementRole, clampConfidence } = ledger._internals;

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// span type falls back to 'line' on anything unknown; accepts the real set.
assert.strictEqual(normSpanType('TABLE_CELL'), 'table_cell');
assert.strictEqual(normSpanType('signature'), 'signature');
assert.strictEqual(normSpanType('nonsense'), 'line');
assert.strictEqual(normSpanType(null), 'line');
ok('normSpanType constrains to the vocabulary, defaults to line');

// support type defaults to direct.
assert.strictEqual(normSupportType('CONTRADICTING'), 'contradicting');
assert.strictEqual(normSupportType('derived_input'), 'derived_input');
assert.strictEqual(normSupportType('x'), 'direct');
ok('normSupportType constrains + defaults to direct');

// finding role defaults to supports; requirement role to satisfies.
assert.strictEqual(normFindingRole('CONFLICTS'), 'conflicts');
assert.strictEqual(normFindingRole('x'), 'supports');
assert.strictEqual(normRequirementRole('FAILS'), 'fails');
assert.strictEqual(normRequirementRole('cannot_address'), 'cannot_address');
assert.strictEqual(normRequirementRole('x'), 'satisfies');
ok('finding/requirement roles constrain + default');

// confidence clamps to [0,1] or null.
assert.strictEqual(clampConfidence(0.87), 0.87);
assert.strictEqual(clampConfidence(1.5), 1);
assert.strictEqual(clampConfidence(-3), 0);
assert.strictEqual(clampConfidence('NaN'), null);
assert.strictEqual(clampConfidence(undefined), null);
assert.strictEqual(clampConfidence('0.5'), 0.5);
ok('clampConfidence yields a clean [0,1] or null');

// vocab sets are complete.
for (const t of ['line', 'word', 'table_cell', 'selection_mark', 'signature', 'image_region', 'api_response', 'guideline_citation']) {
  assert.ok(ledger.SPAN_TYPES.has(t), `span type ${t}`);
}
for (const s of ['active', 'superseded', 'invalid']) assert.ok(ledger.SPAN_STATES.has(s), `span state ${s}`);
ok('SPAN_TYPES + SPAN_STATES vocab complete');

// module surface.
for (const fn of ['recordSpan', 'linkFact', 'linkFinding', 'linkRequirement', 'assertSpanExists', 'supersedeSpansForDocument', 'spansForFact']) {
  assert.strictEqual(typeof ledger[fn], 'function', `exports ${fn}`);
}
ok('evidence-ledger exports the full surface');

console.log(`\nR5.13/R5.14 evidence-ledger pure — ${passed} checks passed`);
