'use strict';
/**
 * R5.39 — pure tests for the guideline citation formatter.
 * Proves it (1) turns an evaluator unmet-leaf into a plain phrase per comparator,
 * (2) composes a source citation line naming guideline+version+section, (3) marks
 * met / unmet / advisory verdicts, (4) STRIPS investor/source names in borrowerSafe
 * mode (never exposes a capital-partner name to a borrower), (5) orders unmet
 * before met in citeAll, and (6) never throws — including feeding it a real
 * guideline-evaluator result.
 */
const assert = require('assert');
const gc = require('../src/lib/underwriting/guideline-citation');
const { evaluate } = require('../src/lib/underwriting/guideline-evaluator');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- per-comparator phrasing ---
assert.match(gc.phraseForUnmet({ field: 'ltv', cmp: 'lte', expected: 80, actual: 82 }), /LTV 82 exceeds the maximum 80/);
assert.match(gc.phraseForUnmet({ field: 'fico_min', cmp: 'gte', expected: 700, actual: 680 }), /FICO min 680 is below the minimum 700/);
assert.match(gc.phraseForUnmet({ field: 'property_type', cmp: 'in', expected: ['sfr', 'condo'], actual: 'coop' }), /is not one of the allowed values \(sfr, condo\)/);
assert.match(gc.phraseForUnmet({ field: 'occupancy', cmp: 'ne', expected: 'owner', actual: 'owner' }), /must not be owner/);
ok('each comparator renders a plain-language phrase with the field label humanized (LTV/FICO acronyms upper-cased)');

// --- a full unmet citation from a real evaluator result ---
const expr = { op: 'and', clauses: [
  { field: 'ltv', cmp: '<=', value: 80 },
  { field: 'fico', cmp: '>=', value: 700 },
] };
const ev = evaluate(expr, { ltv: 82, fico: 680 });
assert.strictEqual(ev.matched, false);
let c = gc.formatCitation({
  rule_id: 'ltv_fico_gate', source: 'investor_hard', investor: 'Acme Capital',
  guideline: 'RTL Matrix', version: '3', section: '4.2', materiality: 'fatal',
}, ev);
assert.strictEqual(c.verdict, 'unmet');
assert.strictEqual(c.reasons.length, 2, 'one reason per unmet leaf');
assert.ok(c.reasons.some((r) => /LTV/.test(r)) && c.reasons.some((r) => /FICO/.test(r)));
assert.strictEqual(c.sourceLabel, 'Investor guideline');
assert.match(c.citation, /Investor guideline — Acme Capital RTL Matrix — v3, §4\.2 \(rule ltv_fico_gate\)/);
assert.strictEqual(c.materiality, 'fatal');
ok('an unmet rule cites its source line (investor + guideline + version + section + rule id) with a reason per unmet leaf');

// --- a matched rule is "met" with no reasons ---
const evOk = evaluate(expr, { ltv: 75, fico: 720 });
c = gc.formatCitation({ rule_id: 'ltv_fico_gate', source: 'base_program' }, evOk);
assert.strictEqual(c.verdict, 'met');
assert.deepStrictEqual(c.reasons, [], 'a met rule lists no unmet reasons');
assert.strictEqual(c.sourceLabel, 'Program guideline');
ok('a matched rule is reported as met with no reasons');

// --- an advisory rule that did not match is "advisory", not "unmet" ---
c = gc.formatCitation({ rule_id: 'reserve_pref', source: 'internal_overlay', advisory: true }, evaluate({ field: 'reserves', cmp: '>=', value: 6 }, { reserves: 3 }));
assert.strictEqual(c.verdict, 'advisory', 'an advisory rule that fails is advisory, not a hard unmet');
assert.ok(c.reasons.length >= 1);
ok('an advisory rule that fails is classed advisory (not a blocking unmet)');

// --- borrowerSafe strips the investor / source names ---
c = gc.formatCitation({
  rule_id: 'ltv_fico_gate', source: 'investor_hard', investor: 'BlueLake', guideline: 'Note Buyer Matrix', version: '3', section: '4.2',
}, ev, { borrowerSafe: true });
assert.strictEqual(c.investor, null, 'no investor name in borrower-safe mode');
assert.strictEqual(c.sourceLabel, null, 'no source label in borrower-safe mode');
assert.strictEqual(c.guideline, null, 'no guideline name in borrower-safe mode');
assert.ok(!/BlueLake|Note Buyer/i.test(c.citation), 'the capital-partner name never appears in a borrower-safe citation');
assert.strictEqual(c.section, '4.2', 'a neutral section reference is still allowed');
assert.ok(c.reasons.length === 2, 'the requirement itself (LTV/FICO) still shows to the borrower');
ok('borrowerSafe mode strips every investor/note-buyer/source name but keeps the neutral requirement');

// --- citeAll orders unmet before advisory before met ---
const list = gc.citeAll([
  { rule: { rule_id: 'ok1', source: 'base_program' }, eval: evOk },
  { rule: { rule_id: 'bad1', source: 'investor_hard' }, eval: ev },
  { rule: { rule_id: 'adv1', source: 'internal_overlay', advisory: true }, eval: evaluate({ field: 'x', cmp: '>=', value: 1 }, { x: 0 }) },
]);
assert.deepStrictEqual(list.map((c) => c.verdict), ['unmet', 'advisory', 'met'], 'unmet first, then advisory, then met');
ok('citeAll orders the citations unmet → advisory → met for the reviewer');

// --- empty / junk / hostile input is safe ---
assert.doesNotThrow(() => gc.formatCitation(null, null));
assert.strictEqual(gc.formatCitation(null, null).verdict, 'unmet');
assert.doesNotThrow(() => gc.phraseForUnmet(null));
assert.doesNotThrow(() => gc.citeAll('notarray'));
assert.deepStrictEqual(gc.citeAll('notarray'), []);
assert.doesNotThrow(() => gc.formatCitation({ get source() { throw new Error('boom'); } }, { matched: false, unmet: [{ field: 'x', cmp: 'lte', expected: 1, actual: 2 }] }));
assert.doesNotThrow(() => gc.formatCitation({ rule_id: 'x' }, { get unmet() { throw new Error('boom'); } }));
ok('empty / null / junk / throwing-getter input is safe (never throws)');

console.log(`\nR5.39 guideline-citation pure — ${passed} checks passed`);
