'use strict';
/**
 * Condition-aging portfolio rollup — pure tests.
 * Proves it (1) rolls many per-file ageConditions() summaries into book totals
 * (open/overdue/closed + oldest + summed bucket histogram), (2) counts files with
 * open / overdue work, (3) ranks a "worst files" list (most-overdue, then oldest),
 * (4) tolerates the ageConditions()-result / bare-summary shapes, (5) writes a
 * plain-language headline, and (6) never throws.
 */
const assert = require('assert');
const cap = require('../src/lib/underwriting/condition-aging-portfolio');
const ca = require('../src/lib/underwriting/condition-aging');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };
const DAY = 86400000;
const NOW = 1_700_000_000_000;
const daysAgo = (d) => NOW - d * DAY;

// Build three real per-file agings.
const fileA = ca.ageConditions([
  { id: '1', status: 'open', opened_at: daysAgo(2) },   // 0-3, not overdue
  { id: '2', status: 'open', opened_at: daysAgo(20) },  // 15+, overdue, oldest=20
], { now: NOW });
const fileB = ca.ageConditions([
  { id: '3', status: 'open', opened_at: daysAgo(9) },   // 8-14, overdue
  { id: '4', status: 'satisfied', opened_at: daysAgo(30), satisfied_at: daysAgo(28) }, // closed
], { now: NOW });
const fileC = ca.ageConditions([], { now: NOW }); // no conditions

// --- roll up the three files (entries carry id/label + the whole ageConditions result) ---
let r = cap.rollupAging([
  { id: 'A', label: '392 Columbia Ave', summary: fileA.summary },
  { id: 'B', label: '12 Oak St', summary: fileB.summary },
  { id: 'C', label: 'empty file', summary: fileC.summary },
]);
assert.strictEqual(r.files.total, 3);
assert.strictEqual(r.files.withOpen, 2, 'A and B have open conditions; C has none');
assert.strictEqual(r.files.withOverdue, 2, 'A and B each have an overdue');
assert.strictEqual(r.conditions.open, 3, '2 open on A + 1 open on B');
assert.strictEqual(r.conditions.overdue, 2);
assert.strictEqual(r.conditions.closed, 1, 'the satisfied one on B');
assert.strictEqual(r.conditions.oldestDaysOpen, 20, 'oldest OPEN across the book is the 20-day on file A');
assert.strictEqual(r.buckets['0-3'], 1);
assert.strictEqual(r.buckets['8-14'], 1);
assert.strictEqual(r.buckets['15+'], 1);
ok('rollupAging sums open/overdue/closed, the oldest, and the bucket histogram across files');

// --- worst-files ranking: most-overdue first, then oldest ---
assert.strictEqual(r.worstFiles.length, 2, 'only files with open/overdue work surface');
assert.strictEqual(r.worstFiles[0].id, 'A', 'A ranks first (same overdue count, but older: 20 > 9)');
assert.strictEqual(r.worstFiles[0].label, '392 Columbia Ave');
assert.strictEqual(r.worstFiles[0].oldestDaysOpen, 20);
assert.strictEqual(r.worstFiles[1].id, 'B');
ok('worstFiles ranks by overdue then oldest and excludes files with no open work');

// --- headline is plain-language and reflects the totals ---
assert.ok(/3 open conditions across 2 files/.test(r.headline), r.headline);
assert.ok(/2 overdue/.test(r.headline));
assert.ok(/oldest 20 days open/.test(r.headline));
ok('the headline summarizes open/overdue/oldest in plain language');

// --- accepts the WHOLE ageConditions result (has .summary) and a bare summary ---
let r2 = cap.rollupAging([
  { id: 'A', label: 'via full result', aging: fileA },       // .aging.summary
  fileB,                                                       // bare ageConditions result (has .summary)
  fileB.summary,                                              // a bare summary object
]);
assert.strictEqual(r2.conditions.open, 2 + 1 + 1, 'all three shapes contribute their open counts');
ok('rollup tolerates the ageConditions-result, the .aging wrapper, and a bare summary shape');

// --- limit caps the worstFiles list ---
const many = [];
for (let i = 0; i < 15; i++) many.push({ id: `f${i}`, summary: ca.ageConditions([{ status: 'open', opened_at: daysAgo(20 + i) }], { now: NOW }).summary });
assert.strictEqual(cap.rollupAging(many).worstFiles.length, 10, 'default cap is 10');
assert.strictEqual(cap.rollupAging(many, { limit: 3 }).worstFiles.length, 3, 'explicit limit honored');
ok('the worstFiles list is capped (default 10, explicit limit honored)');

// --- an all-empty/clean portfolio has a clean headline ---
r = cap.rollupAging([fileC.summary, ca.ageConditions([], { now: NOW }).summary]);
assert.strictEqual(r.conditions.open, 0);
assert.strictEqual(r.worstFiles.length, 0);
assert.ok(/No open conditions/.test(r.headline));
ok('an empty/clean portfolio reports no open conditions');

// --- empty / junk / hostile input is safe ---
assert.doesNotThrow(() => cap.rollupAging(null));
assert.strictEqual(cap.rollupAging(null).files.total, 0);
assert.doesNotThrow(() => cap.rollupAging('notarray'));
assert.doesNotThrow(() => cap.rollupAging([null, 42, 'x', {}]));
assert.doesNotThrow(() => cap.rollupAging([{ summary: { open: 'NaN', overdue: -3, buckets: 'bad' } }]));
assert.doesNotThrow(() => cap.rollupAging([{ get summary() { throw new Error('boom'); } }]));
assert.strictEqual(cap.rollupAging([{ summary: { open: 'NaN', overdue: -3 } }]).conditions.open, 0, 'junk numeric fields floor to 0');
ok('empty / null / junk / throwing-getter input is safe (never throws)');

console.log(`\ncondition-aging-portfolio pure — ${passed} checks passed`);
