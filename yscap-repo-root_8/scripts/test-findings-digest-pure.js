'use strict';
/**
 * Whole-loan findings-digest — pure tests.
 * Proves it (1) groups the finding registry by category with per-group count /
 * worst-severity / blocking / severity breakdown, (2) rolls up file totals +
 * overall worst severity, (3) orders categories worst-severity-first, (4) writes
 * a plain-language headline, (5) collapses unknown categories to "other" and
 * drops raw example titles in borrowerSafe mode, and (6) never throws.
 */
const assert = require('assert');
const fd = require('../src/lib/underwriting/findings-digest');
const { decide } = require('../src/lib/underwriting/decision');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- group by category with worst-severity + blocking + breakdown ---
let d = decide({ engineStatus: 'ELIGIBLE', findings: [
  { code: 'lien', subject: 'title', category: 'title', severity: 'fatal', title: 'Open lien on title', blocks_ctc: true },
  { code: 'vesting', subject: 'title', category: 'title', severity: 'warning', title: 'Vesting mismatch' },
  { code: 'reserves', subject: 'reserves', category: 'liquidity', severity: 'warning', title: 'Prefers 6mo reserves' },
  { code: 'note', subject: 'misc', category: 'income', severity: 'info', title: 'FYI note' },
] });
let g = fd.digestFindings(d);
assert.strictEqual(g.totals.total, 4);
assert.strictEqual(g.totals.categories, 3, 'title / liquidity / income');
assert.strictEqual(g.totals.worstSeverity, 'fatal');
assert.strictEqual(g.totals.blocking, 1, 'the fatal title lien blocks');
assert.deepStrictEqual(g.totals.bySeverity, { fatal: 1, warning: 2, info: 1 });
const title = g.categories.find((c) => c.category === 'title');
assert.strictEqual(title.count, 2);
assert.strictEqual(title.worstSeverity, 'fatal');
assert.strictEqual(title.blocking, true);
assert.deepStrictEqual(title.bySeverity, { fatal: 1, warning: 1, info: 0 });
ok('digestFindings groups by category with count, worst severity, blocking, and a severity breakdown');

// --- categories are ordered worst-severity first ---
assert.strictEqual(g.categories[0].category, 'title', 'the fatal-bearing category sorts first');
assert.ok(fd._internals.sevRank(g.categories[0].worstSeverity) <= fd._internals.sevRank(g.categories[1].worstSeverity));
assert.ok(/Worst: Title/.test(g.headline), `headline names the worst category: ${g.headline}`);
assert.ok(/4 findings across 3 categories/.test(g.headline));
ok('categories sort worst-severity-first and the headline names the worst category');

// --- staff examples present; a per-category cap is honored ---
assert.ok(title.examples.length >= 1 && title.examples.length <= 2);
assert.ok(title.examples.includes('Open lien on title'));
const capped = fd.digestFindings(d, { maxExamples: 1 });
assert.strictEqual(capped.categories.find((c) => c.category === 'title').examples.length, 1, 'maxExamples caps per-category examples');
ok('staff examples appear per category and maxExamples caps them');

// --- an unknown/free-form category collapses to "other" ---
d = decide({ engineStatus: 'ELIGIBLE', findings: [
  { code: 'x', category: 'Summit Ridge Capital secret bucket', severity: 'warning', title: 'weird' },
] });
g = fd.digestFindings(d);
assert.strictEqual(g.categories.length, 1);
assert.strictEqual(g.categories[0].category, 'other', 'an unknown category label collapses to the generic other bucket');
assert.ok(!/summit ridge/i.test(JSON.stringify(g.categories.map((c) => ({ category: c.category, label: c.label })))), 'the free-form category label never appears as a key/label');
ok('an unknown/free-form category collapses to the generic "other" bucket');

// --- borrowerSafe surfaces NO raw finding text (arbitrary partner name can't leak) ---
d = decide({ engineStatus: 'INELIGIBLE', findings: [
  { code: 'nb', category: 'title', severity: 'fatal', title: 'Summit Ridge Capital will not buy this note', explanation: 'Summit Ridge needs 2mo reserves', sources: ['Summit Ridge Capital'], blocks_funding: true },
  { code: 'nb2', category: 'weird free-form Summit Ridge label', severity: 'warning', title: 'Summit Ridge flag' },
] });
const safe = fd.digestFindings(d, { borrowerSafe: true });
const blob = JSON.stringify(safe);
assert.ok(!/summit ridge/i.test(blob), `an arbitrary capital-partner name must not appear in a borrower-safe digest: ${blob}`);
assert.ok(safe.categories.every((c) => c.examples.length === 0), 'borrower-safe categories carry NO example titles');
// the controlled category key + severity counts still show
assert.strictEqual(safe.totals.worstSeverity, 'fatal');
assert.ok(safe.categories.some((c) => c.category === 'title'), 'the controlled title category key still shows');
assert.ok(safe.categories.some((c) => c.category === 'other'), 'the free-form category collapsed to other');
// a KNOWN name is gone too (belt-and-suspenders)
assert.ok(!/bluelake|blue lake/i.test(JSON.stringify(fd.digestFindings(decide({ engineStatus: 'INELIGIBLE', findings: [{ category: 'title', severity: 'fatal', title: 'BlueLake declines', blocks_funding: true }] }), { borrowerSafe: true }))));
ok('borrowerSafe surfaces NO raw finding text — an arbitrary (or known) partner name never appears');

// --- a finding with no category lands in "other" ---
d = decide({ engineStatus: 'ELIGIBLE', findings: [{ code: 'q', severity: 'info', title: 'uncategorized' }] });
g = fd.digestFindings(d);
assert.strictEqual(g.categories[0].category, 'other');
ok('a finding with no category lands in the other bucket');

// --- a decision with no findings → empty digest ---
g = fd.digestFindings(decide({ engineStatus: 'ELIGIBLE', findings: [] }));
assert.strictEqual(g.totals.total, 0);
assert.strictEqual(g.totals.worstSeverity, null);
assert.strictEqual(g.categories.length, 0);
assert.ok(/No findings/.test(g.headline));
ok('a decision with no findings yields an empty digest with a clean headline');

// --- empty / junk / hostile input is safe ---
assert.doesNotThrow(() => fd.digestFindings(null));
assert.strictEqual(fd.digestFindings(null).totals.total, 0);
assert.doesNotThrow(() => fd.digestFindings('x'));
assert.doesNotThrow(() => fd.digestFindings({ registry: 'notarray' }));
assert.doesNotThrow(() => fd.digestFindings({ registry: [null, 7, 'x', {}] }));
assert.doesNotThrow(() => fd.digestFindings({ get registry() { throw new Error('boom'); } }));
assert.doesNotThrow(() => fd.digestFindings({ registry: [{ get severity() { throw new Error('boom'); }, get category() { throw new Error('boom'); } }] }));
ok('empty / null / junk / throwing-getter input is safe (never throws)');

console.log(`\nfindings-digest pure — ${passed} checks passed`);
