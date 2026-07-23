'use strict';

/**
 * Pure test for src/lib/underwriting/cure-signoff-advisory.js (no DB).
 * Proves a negative cure proof at sign-off maps to the right advisory, a
 * satisfied/absent proof raises nothing, and the mapper never throws.
 */

const assert = require('assert');
const a = require('../src/lib/underwriting/cure-signoff-advisory');

let n = 0;
function check(name, fn) { fn(); n++; console.log('  ok -', name); }

console.log('cure-signoff-advisory pure tests');

// 1 — satisfied / absent / unknown → no warning.
check('satisfied or absent proof raises nothing', () => {
  assert.strictEqual(a.proofToWarning(null, 'i1'), null);
  assert.strictEqual(a.proofToWarning({ result: 'satisfied' }, 'i1'), null);
  assert.strictEqual(a.proofToWarning({ result: '' }, 'i1'), null);
  assert.strictEqual(a.proofToWarning({ result: 'not_satisfied' }, null), null, 'no itemId → null');
});

// 2 — not_satisfied → important warning finding with a reopen action.
check('not_satisfied → important warning + reopen action', () => {
  const w = a.proofToWarning({ result: 'not_satisfied', reviewer_summary: 'The binder names a different insured.' }, 'i7');
  assert.strictEqual(w.source, 'cure_signoff');
  assert.strictEqual(w.kind, 'finding');
  assert.strictEqual(w.severity, 'warning');
  assert.strictEqual(w.important, true);
  assert.match(w.title, /does NOT satisfy/);
  assert.match(w.body, /different insured/);
  assert.strictEqual(w.proposedAction.type, 'reopen_condition');
  assert.strictEqual(w.proposedAction.checklistItemId, 'i7');
  assert.strictEqual(w.evidence.proofResult, 'not_satisfied');
  assert.strictEqual(w.dedupeKey, 'cure-signoff:i7');
});

// 3 — partially_satisfied / unable_to_determine → warning, NOT important.
check('partial / unable → warning, not important', () => {
  const p = a.proofToWarning({ result: 'partially_satisfied' }, 'i8');
  assert.strictEqual(p.severity, 'warning');
  assert.strictEqual(p.important, false);
  assert.match(p.title, /only PARTIALLY satisfies/);
  const u = a.proofToWarning({ result: 'unable_to_determine' }, 'i9');
  assert.strictEqual(u.important, false);
  assert.match(u.title, /could not be confirmed/);
  assert.strictEqual(u.dedupeKey, 'cure-signoff:i9');
});

// 4 — result matching is case-insensitive and NEGATIVE set is exactly the three.
check('NEGATIVE set is the three non-satisfied outcomes', () => {
  assert.deepStrictEqual([...a.NEGATIVE].sort(), ['not_satisfied', 'partially_satisfied', 'unable_to_determine']);
  const upper = a.proofToWarning({ result: 'NOT_SATISFIED' }, 'i1');
  assert.ok(upper && upper.severity === 'warning', 'case-insensitive result match');
});

console.log(`\ncure-signoff-advisory: ${n} checks passed`);
