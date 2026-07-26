'use strict';
/**
 * R5.28 — pure tests for the clearance-outcome aggregator. Guarantees: only
 * 'cleared' clears; a document-level blocker (wrong doc / unreadable) is never
 * masked by satisfied requirements; and unable_to_determine never silently
 * becomes a partial clear.
 */
const assert = require('assert');
const { aggregate, CLEARS } = require('../src/lib/underwriting/clearance-outcome');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const R = (id, status) => ({ id, status });

// all satisfied → cleared (and only cleared clears).
let r = aggregate([R('a', 'satisfied'), R('b', 'satisfied')], {});
assert.strictEqual(r.outcome, 'cleared');
assert.strictEqual(r.clears, true);
ok('all requirements satisfied → cleared (clears)');

// a document-level blocker beats satisfied requirements.
r = aggregate([R('a', 'satisfied'), R('b', 'satisfied')], { wrongDocument: true });
assert.strictEqual(r.outcome, 'wrong_document');
assert.strictEqual(r.clears, false, 'wrong document never clears even with satisfied reqs');
r = aggregate([R('a', 'satisfied')], { unreadable: true });
assert.strictEqual(r.outcome, 'document_unreadable');
ok('a document-level blocker is never masked by satisfied requirements');

// evidence quality precedence.
assert.strictEqual(aggregate([R('a', 'satisfied')], { conflicting: true }).outcome, 'conflicting_evidence');
assert.strictEqual(aggregate([R('a', 'satisfied')], { stale: true }).outcome, 'stale_evidence');
assert.strictEqual(aggregate([R('a', 'satisfied')], { newMaterialFinding: true }).outcome, 'new_material_finding');
ok('conflicting / stale / new-finding take precedence over satisfied reqs');

// ambiguity → admin_question_required.
assert.strictEqual(aggregate([R('a', 'unable_to_determine')], { ambiguous: true }).outcome, 'admin_question_required');
ok('an explicit ambiguity → admin_question_required');

// none satisfied, all failed → not_cleared.
r = aggregate([R('a', 'not_satisfied'), R('b', 'not_satisfied')], {});
assert.strictEqual(r.outcome, 'not_cleared');
assert.deepStrictEqual(r.unmet.sort(), ['a', 'b']);
ok('no requirement satisfied → not_cleared (with unmet ids)');

// mix of satisfied + failed → partially_cleared.
r = aggregate([R('a', 'satisfied'), R('b', 'not_satisfied')], {});
assert.strictEqual(r.outcome, 'partially_cleared');
assert.deepStrictEqual(r.unmet, ['b']);
ok('a satisfied+failed mix → partially_cleared');

// satisfied + unable_to_determine (no hard fail) → unable_to_determine, NEVER a
// silent partial clear.
r = aggregate([R('a', 'satisfied'), R('b', 'unable_to_determine')], {});
assert.strictEqual(r.outcome, 'unable_to_determine', 'undetermined never silently partial-clears');
assert.strictEqual(r.clears, false);
ok('satisfied + undetermined → unable_to_determine (never a silent partial clear)');

// no requirements → unable_to_determine.
assert.strictEqual(aggregate([], {}).outcome, 'unable_to_determine');
ok('no requirements → unable_to_determine');

// only 'cleared' is in CLEARS.
assert.ok(CLEARS.has('cleared') && CLEARS.size === 1);
ok('only cleared clears the condition');

console.log(`\nR5.28 clearance-outcome pure — ${passed} checks passed`);
