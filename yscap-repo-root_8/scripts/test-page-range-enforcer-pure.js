'use strict';
/**
 * R5.10 — pure tests for storage-boundary page-range enforcement.
 * Proves it validates each logical document's page range against the packet's
 * true page count, REFUSES an out-of-bounds range (never slices past the last
 * page), flags an OVERLAP (a page owned by two documents) as ok:false, reports
 * GAPS (a page owned by none), collapses pages into the contiguous runs a slicer
 * cuts, and resolves each document's physical/virtual slice mode. Advisory: it
 * plans; pdf-slice does the cutting.
 */
const assert = require('assert');
const pe = require('../src/lib/underwriting/page-range-enforcer');
const { MODES } = pe;

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };
const plan = (r, id) => r.plans.find((p) => p.id === id);

// --- a clean, complete, non-overlapping split validates ---
let r = pe.planSlices([
  { id: 'bank', pages: [1, 2] },
  { id: 'title', start: 3, end: 4 },
], { totalPages: 4 });
assert.strictEqual(r.ok, true, 'a clean split is ok');
assert.strictEqual(plan(r, 'bank').valid, true);
assert.deepStrictEqual(plan(r, 'bank').runs, [{ start: 1, end: 2 }], 'contiguous pages collapse to one run');
assert.strictEqual(plan(r, 'title').start, 3);
assert.strictEqual(plan(r, 'title').end, 4);
assert.deepStrictEqual(r.coverage.gaps, [], 'every page is assigned');
assert.deepStrictEqual(r.coverage.overlaps, []);
ok('a clean, complete, non-overlapping split validates with full coverage');

// --- an OUT-OF-BOUNDS range is invalid and never sliced ---
r = pe.planSlices([{ id: 'x', start: 3, end: 7 }], { totalPages: 4 }); // page 5,6,7 don't exist
assert.strictEqual(r.ok, false, 'a range past the last page fails');
assert.strictEqual(plan(r, 'x').valid, false);
assert.ok(/out of bounds/.test(plan(r, 'x').reason));
assert.ok(r.coverage.outOfBounds.some((o) => o.id === 'x' && o.pages.includes(7)));
assert.deepStrictEqual(plan(r, 'x').runs, [{ start: 3, end: 4 }], 'only the in-bounds pages are sliceable');
ok('an out-of-bounds page range is invalid and only its in-bounds pages are sliceable');

// --- an OVERLAP (two docs claim the same page) is a hard failure ---
r = pe.planSlices([
  { id: 'a', pages: [1, 2, 3] },
  { id: 'b', pages: [3, 4] }, // page 3 claimed by both
], { totalPages: 4 });
assert.strictEqual(r.ok, false, 'a shared page fails the plan');
assert.ok(r.coverage.overlaps.some((o) => o.page === 3 && o.docs.includes('a') && o.docs.includes('b')));
ok('two documents claiming the same page is flagged as an overlap and fails the plan');

// --- a GAP (a page owned by nobody) is reported (advisory, not a hard fail) ---
r = pe.planSlices([
  { id: 'a', pages: [1, 2] },
  { id: 'b', pages: [4] }, // page 3 belongs to nobody
], { totalPages: 4 });
assert.deepStrictEqual(r.coverage.gaps, [3], 'the unassigned page is reported as a gap');
assert.strictEqual(r.ok, true, 'a gap alone (no overlap, all valid) does not fail the plan — a human places the page');
ok('an unassigned page is reported as a gap (advisory) without failing an otherwise-valid plan');

// --- a NON-CONTIGUOUS document explodes into multiple physical runs ---
r = pe.planSlices([{ id: 'multi', pages: [1, 2, 5, 6], needsPhysical: true }], { totalPages: 6 });
assert.strictEqual(plan(r, 'multi').contiguous, false, 'pages 1,2,5,6 are non-contiguous');
assert.deepStrictEqual(plan(r, 'multi').runs, [{ start: 1, end: 2 }, { start: 5, end: 6 }], 'it cuts as two runs');
assert.strictEqual(plan(r, 'multi').mode, MODES.PHYSICAL, 'needsPhysical → physical slice');
ok('a non-contiguous document is planned as multiple physical runs');

// --- slice mode: explicit > needsPhysical > default (virtual) ---
r = pe.planSlices([
  { id: 'v' },
  { id: 'p', pages: [1], needsPhysical: true },
  { id: 'e', pages: [2], mode: 'virtual' }, // explicit overrides needsPhysical
], { totalPages: 2 });
assert.strictEqual(plan(r, 'v') && plan(r, 'v').mode, MODES.VIRTUAL, 'default is virtual (reference the original, no byte duplication)');
assert.strictEqual(plan(r, 'p').mode, MODES.PHYSICAL);
assert.strictEqual(plan(r, 'e').mode, MODES.VIRTUAL, 'an explicit mode wins over needsPhysical');
ok('slice mode resolves explicit > needsPhysical > default(virtual)');

// --- totalPages defaults to the max page referenced when not given ---
r = pe.planSlices([{ id: 'a', pages: [1, 2, 3] }]); // no totalPages
assert.strictEqual(r.coverage.totalPages, 3, 'total inferred from the highest referenced page');
assert.strictEqual(r.ok, true);
ok('totalPages is inferred from the highest referenced page when not supplied');

// --- an absurd totalPages never causes a pathological gap scan; the tail is summarized ---
let t0 = Date.now();
r = pe.planSlices([{ id: 'a', pages: [1, 2] }], { totalPages: 1e9 }); // 1 billion pages, only 2 assigned
assert.ok(Date.now() - t0 < 500, 'the gap scan is bounded (no O(totalPages) hang on absurd input)');
assert.deepStrictEqual(r.coverage.gaps, [], 'no interior gaps up to the last referenced page');
assert.ok(r.coverage.trailingUnassigned, 'the huge unassigned tail is summarized, not enumerated');
assert.strictEqual(r.coverage.trailingUnassigned.from, 3);
assert.strictEqual(r.coverage.trailingUnassigned.count, 1e9 - 2);
ok('an absurd totalPages summarizes the trailing tail instead of enumerating a billion gap pages');

// a normal trailing gap (a few unassigned pages at the end) is still summarized cleanly
r = pe.planSlices([{ id: 'a', pages: [1, 2] }], { totalPages: 5 });
assert.deepStrictEqual(r.coverage.trailingUnassigned, { from: 3, to: 5, count: 3 }, 'pages 3-5 are the unassigned tail');
ok('a small trailing tail of unassigned pages is summarized (from/to/count)');

// --- a document that REFERENCES a huge page never explodes/throws (bounded by page magnitude cap) ---
t0 = Date.now();
assert.doesNotThrow(() => pe.planSlices([{ id: 'a', pages: [1000000000] }]), 'a hallucinated billion page number must not throw RangeError');
r = pe.planSlices([{ id: 'a', pages: [1000000000] }]);
assert.ok(Date.now() - t0 < 500, 'no billion-iteration loop from a huge referenced page');
assert.strictEqual(plan(r, 'a').valid, false, 'an out-of-range page leaves the doc with no valid pages → invalid');
// an oversized start/end range likewise never builds a giant array
t0 = Date.now();
assert.doesNotThrow(() => pe.planSlices([{ id: 'b', start: 1, end: 1000000000 }], { totalPages: 5 }), 'an oversized start/end range must not throw');
assert.ok(Date.now() - t0 < 500, 'an oversized start/end range returns instantly (never enumerated)');
assert.strictEqual(pe.planSlices([{ id: 'b', start: 1, end: 1000000000 }]).plans[0].valid, false, 'an oversized span is invalid');
ok('a document referencing a huge page or an oversized start/end range is invalid, never a RangeError/hang');

// --- an over-cap page in a { pages } LIST is SURFACED as out-of-bounds, not silently dropped ---
// (parity with the start/end path: a scrubbed hallucinated page reference must leave a signal)
r = pe.planSlices([{ id: 'mix', pages: [5, 100001] }]); // 100001 exceeds the magnitude cap
assert.strictEqual(plan(r, 'mix').valid, false, 'a doc referencing an over-cap page is invalid');
assert.ok(r.coverage.outOfBounds.some((o) => o.id === 'mix' && o.pages.includes(100001)), 'the over-cap page is reported in outOfBounds, not silently scrubbed');
assert.deepStrictEqual(plan(r, 'mix').runs, [{ start: 5, end: 5 }], 'the in-bounds page stays sliceable');
assert.strictEqual(r.ok, false, 'an over-cap reference fails the plan like any out-of-bounds page');
ok('an over-cap page in a { pages } list is surfaced as out-of-bounds (consistent with the start/end path)');

// --- an inverted explicit range (end < start) is invalid, not silently collapsed to one page ---
r = pe.planSlices([{ id: 'inv', start: 5, end: 2 }], { totalPages: 10 });
assert.strictEqual(plan(r, 'inv').valid, false, 'end < start is flagged invalid, not reduced to page 5');
assert.strictEqual(plan(r, 'inv').pageCount, 0);
ok('an inverted explicit range (end < start) is flagged invalid rather than silently collapsed');

// --- empty / junk input is safe ---
assert.doesNotThrow(() => pe.planSlices(null));
assert.strictEqual(pe.planSlices(null).ok, true, 'nothing to slice is trivially ok');
assert.deepStrictEqual(pe.planSlices([]).plans, []);
assert.doesNotThrow(() => pe.planSlices([{ id: 'a', pages: ['x', null, 0, -1] }], { totalPages: 3 }));
assert.strictEqual(pe.planSlices([{ id: 'a', pages: ['x', null, 0, -1] }], { totalPages: 3 }).plans[0].valid, false, 'a doc with no valid pages is invalid, not a crash');
ok('empty / null / junk input is safe (never throws)');

console.log(`\nR5.10 page-range-enforcer pure — ${passed} checks passed`);
