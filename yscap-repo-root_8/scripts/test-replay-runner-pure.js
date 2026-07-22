'use strict';
/**
 * R5.45 — pure tests for the offline replay runner (baseline vs candidate).
 * Proves it diffs two scored corpora into a report a release gate reads: mean
 * metric deltas, pass→fail regressions and fail→pass improvements, the NEW false
 * clears a candidate introduced (the release-blocking signal), per-slice deltas
 * so a localized regression isn't hidden by the average, and a toGateMetrics()
 * bridge that assembles the R5.46 release-gate input. Advisory: it measures; a
 * human / the gate decides.
 */
const assert = require('assert');
const rr = require('../src/lib/underwriting/replay-runner');
const gate = require('../src/lib/underwriting/release-gate');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// helper to build a scoreCase-shaped result
const sc = (fileId, o = {}) => ({
  fileId,
  boundaries: { f1: o.f1 != null ? o.f1 : 1 },
  classification: { accuracy: o.ca != null ? o.ca : 1 },
  fields: { accuracy: o.fa != null ? o.fa : 1 },
  findings: { recall: o.recall != null ? o.recall : 1, falseClears: o.fc || [], falsePositives: o.fp || [] },
  pass: o.pass != null ? o.pass : true,
});

// --- an identical candidate has zero deltas and no regressions ---
let base = [sc('F1'), sc('F2')];
let r = rr.compareRuns(base, JSON.parse(JSON.stringify(base)));
assert.strictEqual(r.matched, 2);
assert.strictEqual(r.summary.meanDeltas.findingRecall, 0);
assert.strictEqual(r.summary.totalNewFalseClears, 0);
assert.deepStrictEqual(r.summary.regressedCases, []);
assert.strictEqual(r.sliceRegressions.length, 0);
ok('an identical candidate shows zero metric deltas and no regressions');

// --- a NEW false clear (a finding baseline caught, candidate misses) is surfaced + fails the case ---
base = [sc('F1', { recall: 1, fc: [], pass: true })];
let cand = [sc('F1', { recall: 0, fc: ['liquidity_short'], pass: false })]; // now misses the finding
r = rr.compareRuns(base, cand);
assert.strictEqual(r.summary.totalNewFalseClears, 1, 'the newly-missed finding is a new false clear');
assert.deepStrictEqual(r.cases[0].newFalseClears, ['liquidity_short']);
assert.strictEqual(r.cases[0].transition, 'regressed', 'the case went pass → fail');
assert.deepStrictEqual(r.summary.regressedCases, ['F1']);
assert.strictEqual(r.summary.meanDeltas.findingRecall, -1, 'recall dropped 1 → 0');
ok('a candidate that introduces a false clear is surfaced, marked regressed, and drops recall');

// --- a FIXED false clear + a fail→pass improvement ---
base = [sc('F1', { recall: 0, fc: ['appraisal_low'], pass: false })];
cand = [sc('F1', { recall: 1, fc: [], pass: true })];
r = rr.compareRuns(base, cand);
assert.strictEqual(r.summary.totalFixedFalseClears, 1);
assert.deepStrictEqual(r.cases[0].fixedFalseClears, ['appraisal_low']);
assert.strictEqual(r.cases[0].transition, 'improved');
assert.deepStrictEqual(r.summary.improvedCases, ['F1']);
assert.strictEqual(r.summary.passRateDelta, 1, 'pass rate 0 → 1');
ok('a candidate that fixes a false clear is marked improved and raises the pass rate');

// --- SLICES: a change that helps overall but regresses one slice is not hidden ---
base = [sc('A1', { fa: 0.5 }), sc('A2', { fa: 0.5 }), sc('B1', { fa: 0.9 })];
cand = [sc('A1', { fa: 1.0 }), sc('A2', { fa: 1.0 }), sc('B1', { fa: 0.7 })]; // A improves +0.5 each, B regresses -0.2 → mean positive
r = rr.compareRuns(base, cand, { tags: { A1: 'purchase', A2: 'purchase', B1: 'refi' } });
assert.ok(r.summary.meanDeltas.fieldAccuracy > 0, 'the overall field-accuracy delta is positive');
assert.ok(r.slices.refi.meanDeltas.fieldAccuracy < 0, 'the refi slice regressed');
assert.ok(r.sliceRegressions.some((s) => s.slice === 'refi' && s.metric === 'fieldAccuracy' && s.delta < 0),
  'the refi field-accuracy regression is reported even though the average improved');
assert.strictEqual(r.slices.purchase.count, 2);
ok('per-slice deltas expose a localized regression the overall average hides');

// --- a custom sliceBy function is honored ---
r = rr.compareRuns(base, cand, { sliceBy: (c) => (c.fileId[0] === 'A' ? 'groupA' : 'groupB') });
assert.ok(r.slices.groupA && r.slices.groupB, 'sliceBy groups by the returned key');
ok('a custom sliceBy function groups cases as returned');

// --- unmatched files on each side are reported, not silently dropped ---
r = rr.compareRuns([sc('F1'), sc('F2')], [sc('F2'), sc('F3')]);
assert.strictEqual(r.matched, 1);
assert.deepStrictEqual(r.onlyBaseline, ['F1']);
assert.deepStrictEqual(r.onlyCandidate, ['F3']);
ok('files present on only one side are reported (onlyBaseline / onlyCandidate), never silently dropped');

// --- a missing metric is "not measured" (null), excluded from the mean, never a 0 ---
base = [{ fileId: 'F1', findings: { recall: 1, falseClears: [] }, pass: true }]; // no boundaries/classification/fields
cand = [{ fileId: 'F1', findings: { recall: 1, falseClears: [] }, pass: true }];
r = rr.compareRuns(base, cand);
assert.strictEqual(r.cases[0].deltas.boundaryF1, null, 'an absent metric is null, not a fabricated 0 delta');
assert.strictEqual(r.summary.meanDeltas.boundaryF1, null, 'the mean excludes the unmeasured metric');
ok('a missing metric is null (not a fabricated 0) and is excluded from the mean');

// --- an EXPLICIT null metric (e.g. a SQL NULL) stays "not measured", never a fabricated 0 ---
base = [{ fileId: 'F1', boundaries: { f1: null }, findings: { recall: 1, falseClears: [] }, pass: true }];
cand = [{ fileId: 'F1', boundaries: { f1: 0.5 }, findings: { recall: 1, falseClears: [] }, pass: true }];
r = rr.compareRuns(base, cand);
assert.strictEqual(r.cases[0].deltas.boundaryF1, null, 'a null baseline metric yields a null delta, not a fabricated regression');
assert.strictEqual(r.summary.meanDeltas.boundaryF1, null, 'the mean excludes the unmeasured (null) metric');
// but a real 0 is a measured value, not "missing"
r = rr.compareRuns([sc('F1', { f1: 0 })], [sc('F1', { f1: 0.5 })]);
assert.strictEqual(r.cases[0].deltas.boundaryF1, 0.5, 'a real 0 baseline is measured — the delta is computed');
ok('an explicit null metric is not measured (null delta); a real 0 is measured');

// --- a duplicate fileId within a corpus is surfaced, not silently collapsed ---
r = rr.compareRuns([sc('F1'), sc('F1'), sc('F2')], [sc('F1'), sc('F2')]);
assert.deepStrictEqual(r.duplicateIds.baseline, ['F1'], 'the repeated baseline fileId is reported');
assert.deepStrictEqual(r.duplicateIds.candidate, [], 'no duplicates on the candidate side');
ok('a duplicate fileId within a corpus is surfaced in duplicateIds (not silently collapsed)');

// --- toGateMetrics bridges straight into the R5.46 release gate ---
base = [sc('F1', { recall: 1, fc: [], pass: true })];
cand = [sc('F1', { recall: 0, fc: ['x'], pass: false })];
const cmp = rr.compareRuns(base, cand);
const metrics = rr.toGateMetrics(cmp, {
  fatalRecall: { candidate: 0.9, baseline: 0.9 },
  boundaryF1ByFamily: { bank_statement: 0.95 },
  conditionClearPrecision: { candidate: 1, baseline: 1 },
});
assert.strictEqual(metrics.dangerousFalseClears, 1, 'the new false clear becomes the gate-1 input');
const verdict = gate.evaluate(metrics);
assert.strictEqual(verdict.pass, false, 'the release gate BLOCKS a candidate that introduced a false clear');
assert.ok(verdict.blockers.some((b) => /gate1/.test(b)));
ok('toGateMetrics feeds the release gate, which blocks a candidate that introduced a false clear');

// --- empty / junk input is safe ---
assert.doesNotThrow(() => rr.compareRuns(null, null));
assert.strictEqual(rr.compareRuns(null, null).matched, 0);
assert.strictEqual(rr.compareRuns([], []).summary.passRateDelta, 0);
assert.doesNotThrow(() => rr.toGateMetrics(null));
ok('empty / null input is safe (never throws)');

console.log(`\nR5.45 replay-runner pure — ${passed} checks passed`);
