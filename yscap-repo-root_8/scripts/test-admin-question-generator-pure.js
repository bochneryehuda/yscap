'use strict';
/**
 * R5.41 — pure tests for the admin-question generator + dedupe.
 * Proves it (1) builds a validated, narrow, evidence-grounded question from a
 * blocked-decision context, (2) recommends the confident option but recommends
 * NOTHING on a true tie, (3) degrades gracefully (ok:false) instead of throwing
 * when a safe question can't be made, (4) produces a STABLE dedupe key per fork,
 * and (5) suppresses a question already open for the super-admin or duplicated
 * within a batch — so the same person is never asked the same thing twice.
 */
const assert = require('assert');
const gen = require('../src/lib/underwriting/admin-question-generator');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const baseCtx = () => ({
  blockedComponent: 'vesting_owner',
  subject: '12 Oak St',
  readings: [
    { key: 'llc', label: 'Title vests in the borrowing LLC', effect: 'clear vesting condition', confidence: 0.8 },
    { key: 'individual', label: 'Title vests in the individual', effect: 'request corrected title', confidence: 0.55 },
  ],
  evidenceSpanIds: ['span-1', 'span-2'],
});

// --- a well-formed context generates a validated question ---
let g = gen.generate(baseCtx());
assert.strictEqual(g.ok, true, 'a complete context makes a valid question');
assert.strictEqual(g.question.blocked_component, 'vesting_owner');
assert.strictEqual(g.question.option_schema.length, 2, 'both readings become options');
assert.strictEqual(g.question.recommended_option, 'llc', 'the higher-confidence reading is recommended');
assert.deepStrictEqual(g.question.evidence_span_ids, ['span-1', 'span-2'], 'evidence is carried through');
assert.strictEqual(g.question.answer_scope, 'case_only', 'default scope is this case only');
assert.ok(g.dedupeKey && g.dedupeKey.includes('vestingowner'), 'a dedupe key is produced');
ok('a well-formed blocked-decision context generates a validated, case-scoped question');

// --- a TIE recommends nothing (forces a human choice) ---
let ctx = baseCtx();
ctx.readings[0].confidence = 0.7; ctx.readings[1].confidence = 0.7;
delete ctx.readings[0].recommended; delete ctx.readings[1].recommended;
g = gen.generate(ctx);
assert.strictEqual(g.question.recommended_option, null, 'a confidence tie recommends nothing');
ok('a true confidence tie recommends no option (a human must choose)');

// --- an explicit recommended flag wins over confidence ---
ctx = baseCtx();
ctx.readings[1].recommended = true; // lower confidence but explicitly flagged
g = gen.generate(ctx);
assert.strictEqual(g.question.recommended_option, 'individual', 'an explicit recommended flag wins');
ok('an explicitly-flagged option is recommended over the higher-confidence one');

// --- graceful failure: fewer than 2 readings / no evidence → ok:false, no throw ---
assert.doesNotThrow(() => gen.generate({ blockedComponent: 'x', readings: [{ key: 'a', label: 'A' }], evidenceSpanIds: ['s'] }));
g = gen.generate({ blockedComponent: 'x', readings: [{ key: 'a', label: 'A' }], evidenceSpanIds: ['s'] });
assert.strictEqual(g.ok, false, 'one option is not a real question');
assert.ok(g.errors.some((e) => /2/.test(e)));
g = gen.generate({ blockedComponent: 'x', readings: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], evidenceSpanIds: [] });
assert.strictEqual(g.ok, false, 'a question with no evidence is refused');
assert.ok(g.errors.some((e) => /evidence/i.test(e)));
ok('an unsafe context (too few options / no evidence) returns ok:false instead of throwing');

// --- a label-less (non-option) reading never wins the recommendation and sinks the question ---
ctx = {
  blockedComponent: 'vesting_owner', subject: '12 Oak St', evidenceSpanIds: ['span-1'],
  readings: [
    { key: 'a', label: 'Reading A', confidence: 0.5 },
    { key: 'b', label: 'Reading B', confidence: 0.6 },
    { key: 'c', confidence: 0.9 }, // most confident but has NO label → not an option
  ],
};
g = gen.generate(ctx);
assert.strictEqual(g.ok, true, 'the a-vs-b question still generates despite a label-less higher-confidence reading');
assert.strictEqual(g.question.option_schema.length, 2, 'only the two labelled readings become options');
assert.strictEqual(g.question.recommended_option, 'b', 'the label-less reading is ignored; the best OPTION is recommended');
ok('a label-less (non-option) reading never wins the recommendation and never sinks the question');

// --- dedupe key is STABLE across wording + independent of reading order ---
const k1 = gen.dedupeKeyFor(baseCtx());
ctx = baseCtx(); ctx.questionText = 'totally different wording here';
ctx.readings.reverse();
const k2 = gen.dedupeKeyFor(ctx);
assert.strictEqual(k1, k2, 'the dedupe key ignores wording and reading order — same fork, same key');
const k3 = gen.dedupeKeyFor(Object.assign(baseCtx(), { subject: '99 Other Rd' }));
assert.notStrictEqual(k1, k3, 'a different subject is a different fork');
ok('the dedupe key is stable across wording/order and distinguishes different forks');

// --- dedupe suppresses an already-open question and in-batch duplicates ---
const a = gen.generate(baseCtx());                                   // key K
const b = gen.generate(baseCtx());                                   // same key K (duplicate)
const cCtx = Object.assign(baseCtx(), { blockedComponent: 'liquidity_source', subject: 'acct 5' });
const c = gen.generate(cCtx);                                        // different key
const bad = gen.generate({ blockedComponent: 'z', readings: [], evidenceSpanIds: [] }); // invalid
const res = gen.dedupe([a, b, c, bad], { openKeys: [c.dedupeKey] }); // c already open for this admin
assert.strictEqual(res.fresh.length, 1, 'only the first unique, not-open, valid question survives');
assert.strictEqual(res.fresh[0].dedupeKey, a.dedupeKey);
assert.ok(res.suppressed.some((s) => s.reason === 'already_open' && s.dedupeKey === c.dedupeKey));
assert.ok(res.suppressed.some((s) => s.reason === 'duplicate_in_batch'));
assert.ok(res.suppressed.some((s) => s.reason === 'invalid'));
ok('dedupe suppresses already-open, in-batch-duplicate, and invalid questions; keeps the fresh one');

// --- promptFor emits a constrained Prompt F ---
const p = gen.promptFor(baseCtx());
assert.ok(/ONE (blocked )?decision|exactly ONE/.test(p.system) && /permanent|global/.test(p.system), 'the system prompt states the narrow + no-permanent-rule rules');
assert.ok(JSON.parse(p.user).candidate_readings.length === 2, 'the user payload carries the candidate readings');
ok('promptFor emits a constrained Prompt F (narrow, evidence-grounded, no permanent rule)');

// --- empty / junk input is safe ---
assert.doesNotThrow(() => gen.generate(null));
assert.strictEqual(gen.generate(null).ok, false);
assert.doesNotThrow(() => gen.dedupe(null));
assert.deepStrictEqual(gen.dedupe(null).fresh, []);
assert.ok(typeof gen.dedupeKeyFor(null) === 'string');
ok('empty / null input is safe (never throws)');

console.log(`\nR5.41 admin-question-generator pure — ${passed} checks passed`);
