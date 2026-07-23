'use strict';
/**
 * Whole-loan next-actions worklist — pure tests.
 * Proves it (1) turns blocking findings + open conditions into ONE ordered
 * worklist, (2) tiers them (blocking finding → overdue condition → open condition
 * → warning finding), (3) ages raw conditions internally to flag overdue, (4)
 * dedupes and rolls up a summary + headline, (5) drops info findings and closed
 * conditions, and (6) never throws.
 */
const assert = require('assert');
const na = require('../src/lib/underwriting/next-actions');
const { decide } = require('../src/lib/underwriting/decision');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };
const DAY = 86400000;
const NOW = 1_700_000_000_000;
const daysAgo = (d) => NOW - d * DAY;

// --- blocking finding + overdue + open conditions → one ordered worklist ---
const decision = decide({ engineStatus: 'INELIGIBLE', findings: [
  { code: 'title_defect', subject: 'title', severity: 'fatal', title: 'Open lien on title', blocks_ctc: true, blocks_funding: true },
  { code: 'reserve_note', subject: 'reserves', severity: 'warning', title: 'Prefers 6mo reserves' },
  { code: 'fyi', subject: 'misc', severity: 'info', title: 'just an FYI' },
] });
const conditions = [
  { id: 'bank', status: 'open', opened_at: daysAgo(12) },      // overdue (sla 7)
  { id: 'insurance', status: 'open', opened_at: daysAgo(2) },  // open, not overdue
  { id: 'appraisal', status: 'satisfied', opened_at: daysAgo(20), satisfied_at: daysAgo(18) }, // closed → not work
];
let r = na.buildNextActions({ decision, conditions, now: NOW });
// tiers: 1 fatal finding, 2 overdue condition, 3 open condition, 4 warning finding
assert.strictEqual(r.actions[0].kind, 'finding');
assert.strictEqual(r.actions[0].blocking, true);
assert.strictEqual(r.actions[0].priority, na.TIER.BLOCKING_FINDING, 'the fatal blocking finding is first');
assert.ok(/Blocks clear-to-close, funding/.test(r.actions[0].why));
assert.strictEqual(r.actions[1].kind, 'condition');
assert.strictEqual(r.actions[1].overdue, true, 'the overdue condition comes before the on-time one');
assert.strictEqual(r.actions[1].priority, na.TIER.OVERDUE_CONDITION);
assert.strictEqual(r.actions[2].priority, na.TIER.OPEN_CONDITION, 'the on-time open condition is tier 3');
assert.strictEqual(r.actions[3].priority, na.TIER.WARNING_FINDING, 'the warning finding is last');
assert.ok(!r.actions.some((a) => /FYI/i.test(a.title)), 'the info finding is dropped');
assert.ok(!r.actions.some((a) => a.ref === 'appraisal'), 'the closed condition is not work');
ok('blocking finding, overdue condition, open condition, and warning finding are tiered in order');

// --- summary + headline reflect the worklist ---
assert.strictEqual(r.summary.total, 4);
assert.strictEqual(r.summary.blocking, 1);
assert.strictEqual(r.summary.overdue, 1);
assert.strictEqual(r.summary.findings, 2);
assert.strictEqual(r.summary.conditions, 2);
assert.ok(/1 blocking item to clear/.test(r.headline), r.headline);
assert.ok(/1 overdue condition/.test(r.headline));
ok('the summary + headline reflect the worklist counts');

// --- two fatal findings sort fatal-first within the blocking tier ---
const dec2 = decide({ engineStatus: 'INELIGIBLE', findings: [
  { code: 'warn', subject: 'a', severity: 'warning', title: 'a warning', blocks_ctc: true }, // blocking (flag) but not fatal
  { code: 'fatal1', subject: 'b', severity: 'fatal', title: 'a fatal' },
] });
r = na.buildNextActions({ decision: dec2, conditions: [], now: NOW });
assert.strictEqual(r.actions[0].severity, 'fatal', 'fatal sorts before a non-fatal blocking finding in the same tier');
assert.strictEqual(r.actions[0].priority, na.TIER.BLOCKING_FINDING);
assert.strictEqual(r.actions[1].priority, na.TIER.BLOCKING_FINDING, 'a blocks_ctc warning is still tier-1 blocking');
ok('within the blocking tier, fatal findings sort first');

// --- overdue conditions sort oldest-first ---
r = na.buildNextActions({ decision: decide({ engineStatus: 'ELIGIBLE', findings: [] }), conditions: [
  { id: 'c1', status: 'open', opened_at: daysAgo(9) },
  { id: 'c2', status: 'open', opened_at: daysAgo(30) }, // oldest
  { id: 'c3', status: 'open', opened_at: daysAgo(15) },
], now: NOW });
assert.strictEqual(r.actions[0].ref, 'c2', 'the 30-day overdue condition is first');
assert.strictEqual(r.actions[1].ref, 'c3');
assert.strictEqual(r.actions[2].ref, 'c1');
ok('overdue conditions sort oldest-first');

// --- accepts a pre-aged ageConditions() result directly ---
const ca = require('../src/lib/underwriting/condition-aging');
const aged = ca.ageConditions([{ id: 'x', status: 'open', opened_at: daysAgo(12) }], { now: NOW });
r = na.buildNextActions({ decision: decide({ engineStatus: 'ELIGIBLE', findings: [] }), agedConditions: aged });
assert.strictEqual(r.actions.length, 1);
assert.strictEqual(r.actions[0].kind, 'condition');
assert.strictEqual(r.actions[0].overdue, true);
ok('a pre-aged ageConditions() result is accepted directly');

// --- includeWarnings:false and limit ---
r = na.buildNextActions({ decision, conditions, now: NOW }, { includeWarnings: false });
assert.ok(!r.actions.some((a) => a.kind === 'finding' && !a.blocking), 'includeWarnings:false drops non-blocking findings');
assert.strictEqual(na.buildNextActions({ decision, conditions, now: NOW }, { limit: 2 }).actions.length, 2, 'limit caps the list');
ok('includeWarnings:false drops warnings and limit caps the list');

// --- a clean file has an empty worklist ---
r = na.buildNextActions({ decision: decide({ engineStatus: 'ELIGIBLE', findings: [] }), conditions: [], now: NOW });
assert.strictEqual(r.summary.total, 0);
assert.ok(/Nothing to do/.test(r.headline));
ok('a clean file yields an empty worklist with a clean headline');

// --- empty / junk / hostile input is safe ---
assert.doesNotThrow(() => na.buildNextActions(null));
assert.strictEqual(na.buildNextActions(null).summary.total, 0);
assert.doesNotThrow(() => na.buildNextActions('x'));
assert.doesNotThrow(() => na.buildNextActions({ decision: { registry: 'bad' }, conditions: 'bad' }));
assert.doesNotThrow(() => na.buildNextActions({ decision: { blockingFindings: [null, 7, {}] }, conditions: [null, 'x', 9] }));
assert.doesNotThrow(() => na.buildNextActions({ decision: { get blockingFindings() { throw new Error('boom'); } } }));
assert.doesNotThrow(() => na.buildNextActions({ conditions: [{ get status() { throw new Error('boom'); }, opened_at: daysAgo(3) }], now: NOW }));
ok('empty / null / junk / throwing-getter input is safe (never throws)');

console.log(`\nnext-actions pure — ${passed} checks passed`);
