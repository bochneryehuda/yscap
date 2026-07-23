'use strict';
/**
 * Whole-loan run-diff — pure tests.
 * Proves it (1) reports the status change between two runs, (2) reports each
 * gate's movement (gained/lost/same), (3) diffs findings by (code,subject) into
 * added / removed / changed with a severity direction, (4) rolls up counts + a
 * plain-language headline, (5) scrubs raw finding text in borrowerSafe mode, and
 * (6) never throws.
 */
const assert = require('assert');
const rd = require('../src/lib/underwriting/run-diff');
const { decide } = require('../src/lib/underwriting/decision');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- status + gate movement between two real decisions ---
// prev: ELIGIBLE, no fatal → term-sheet eligible. curr: a fatal title finding →
// status downgrades, term-sheet/ctc/funding gates close.
let prev = decide({ engineStatus: 'ELIGIBLE', findings: [
  { code: 'reserve_note', subject: 'reserves', severity: 'advisory', title: 'Prefers 6mo reserves' },
] });
let curr = decide({ engineStatus: 'ELIGIBLE', findings: [
  { code: 'reserve_note', subject: 'reserves', severity: 'advisory', title: 'Prefers 6mo reserves' },
  { code: 'title_defect', subject: 'title', severity: 'fatal', title: 'Open lien on title', blocks_ctc: true, blocks_funding: true, blocks_term_sheet: true },
] });
let d = rd.diffRuns(prev, curr);
assert.strictEqual(d.changed, true);
assert.strictEqual(d.counts.added, 1, 'the new fatal finding is added');
assert.strictEqual(d.findings.added[0].code, 'title_defect');
assert.strictEqual(d.gates.term_sheet.direction, 'lost', 'the fatal finding closes the term-sheet gate');
assert.ok(d.gatesLost.includes('term_sheet'));
assert.ok(/to review/.test(d.headline));
ok('diffRuns reports a new fatal finding, the closed gate, and a headline');

// --- a cleared finding shows as removed, and a re-opened gate as gained ---
d = rd.diffRuns(curr, prev); // reverse: the fatal finding is now gone
assert.strictEqual(d.counts.removed, 1, 'the fatal finding cleared');
assert.strictEqual(d.findings.removed[0].code, 'title_defect');
assert.strictEqual(d.gates.term_sheet.direction, 'gained', 'clearing the fatal re-opens the term-sheet gate');
assert.ok(d.gatesGained.includes('term_sheet'));
assert.ok(/cleared/.test(d.headline));
ok('a cleared finding is removed and its gate is regained');

// --- a severity change on the SAME (code,subject) is "changed", not add+remove ---
prev = decide({ engineStatus: 'ELIGIBLE', findings: [{ code: 'ltv', subject: 'ltv', severity: 'warning', title: 'LTV near cap' }] });
curr = decide({ engineStatus: 'ELIGIBLE', findings: [{ code: 'ltv', subject: 'ltv', severity: 'fatal', title: 'LTV over cap', blocks_funding: true }] });
d = rd.diffRuns(prev, curr);
assert.strictEqual(d.counts.added, 0);
assert.strictEqual(d.counts.removed, 0);
assert.strictEqual(d.counts.changed, 1, 'same code+subject with a new severity is a change, not an add+remove');
assert.strictEqual(d.findings.changed[0].severityFrom, 'warning');
assert.strictEqual(d.findings.changed[0].severityTo, 'fatal');
assert.strictEqual(d.findings.changed[0].direction, 'worse');
assert.strictEqual(d.findings.changed[0].blocksChanged, true, 'the blocks_funding flag flipped');
assert.strictEqual(d.counts.worsened, 1);
ok('a severity change on the same finding is reported as changed=worse with the blocks flag flip');

// --- an eased finding is direction "better" ---
d = rd.diffRuns(curr, prev);
assert.strictEqual(d.findings.changed[0].direction, 'better');
assert.strictEqual(d.counts.improved, 1);
ok('a de-escalated finding is direction=better and counts as improved');

// --- two identical runs → no change ---
d = rd.diffRuns(prev, prev);
assert.strictEqual(d.changed, false);
assert.strictEqual(d.counts.added, 0);
assert.strictEqual(d.counts.removed, 0);
assert.strictEqual(d.counts.changed, 0);
assert.strictEqual(d.gates.funding.direction, 'same');
assert.ok(/No change/.test(d.headline));
ok('two identical runs report no change');

// --- status change alone is reported ---
prev = decide({ engineStatus: 'ELIGIBLE', findings: [] });
curr = decide({ engineStatus: 'INELIGIBLE', findings: [] });
d = rd.diffRuns(prev, curr);
assert.strictEqual(d.statusChanged, true);
assert.strictEqual(d.status.from, prev.status);
assert.strictEqual(d.status.to, curr.status);
assert.strictEqual(d.status.from !== d.status.to, true);
assert.ok(/Status moved/.test(d.headline));
ok('a status change with no finding change is still reported in the headline');

// --- borrowerSafe surfaces NO raw finding text (arbitrary partner name can't leak) ---
prev = decide({ engineStatus: 'ELIGIBLE', findings: [] });
curr = decide({ engineStatus: 'INELIGIBLE', findings: [
  { code: 'nb', subject: 'note buyer', severity: 'fatal', title: 'Summit Ridge Capital will not buy this note', explanation: 'Summit Ridge needs 2mo reserves', sources: ['Summit Ridge Capital'], blocks_funding: true },
] });
d = rd.diffRuns(prev, curr, { borrowerSafe: true });
const blob = JSON.stringify(d);
assert.ok(!/summit ridge/i.test(blob), `an arbitrary capital-partner name must not appear in a borrower-safe diff: ${blob}`);
assert.strictEqual(d.findings.added.length, 1);
assert.strictEqual(d.findings.added[0].title, 'An item', 'borrower-safe added finding carries a generic title');
assert.strictEqual(d.findings.added[0].code, null);
assert.strictEqual(d.findings.added[0].subject, null);
assert.strictEqual(d.findings.added[0].severity, 'fatal', 'the neutral severity still shows');
// a known name is scrubbed too (belt-and-suspenders)
const d2 = rd.diffRuns(prev, decide({ engineStatus: 'INELIGIBLE', findings: [{ code: 'x', severity: 'fatal', title: 'BlueLake declines', blocks_funding: true }] }), { borrowerSafe: true });
assert.ok(!/bluelake|blue lake/i.test(JSON.stringify(d2)));
ok('borrowerSafe surfaces NO raw finding text — an arbitrary (or known) partner name never appears');

// --- findings without a code fall back to a title+subject key (still line up) ---
prev = decide({ engineStatus: 'ELIGIBLE', findings: [{ subject: 'flood', severity: 'warning', title: 'Flood zone A' }] });
curr = decide({ engineStatus: 'ELIGIBLE', findings: [{ subject: 'flood', severity: 'warning', title: 'Flood zone A' }] });
d = rd.diffRuns(prev, curr);
assert.strictEqual(d.counts.added, 0, 'a codeless finding present in both runs lines up (no phantom add)');
assert.strictEqual(d.counts.removed, 0);
ok('codeless findings line up across runs via a title+subject key');

// --- empty / junk / hostile input is safe ---
assert.doesNotThrow(() => rd.diffRuns(null, null));
assert.strictEqual(rd.diffRuns(null, null).changed, false);
assert.doesNotThrow(() => rd.diffRuns('x', 42));
assert.doesNotThrow(() => rd.diffRuns({ registry: 'notarray' }, { registry: [null, 7, 'x', {}] }));
assert.doesNotThrow(() => rd.diffRuns({ get status() { throw new Error('boom'); } }, {}));
assert.doesNotThrow(() => rd.diffRuns({ registry: [{ get severity() { throw new Error('boom'); }, code: 'z' }] }, {}));
ok('empty / null / junk / throwing-getter input is safe (never throws)');

console.log(`\nrun-diff pure — ${passed} checks passed`);
