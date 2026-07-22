'use strict';
/**
 * P3 — pure tests for the golden-corpus scorer / offline replay comparator.
 * Proves it scores a candidate pipeline against a hand-labeled answer key:
 * boundary F1, classification accuracy, field-extraction accuracy, and the
 * critical finding recall / FALSE-CLEAR count; passes a case only when it meets
 * every threshold; and rolls a whole corpus into one report a release gate reads.
 */
const assert = require('assert');
const gs = require('../src/lib/underwriting/golden-scorer');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- a perfect candidate scores 1.0 across the board and passes ---
const golden = {
  fileId: 'F1',
  documents: [{ docType: 'bank_statement', pages: [1, 2] }, { docType: 'title', pages: [3] }],
  fields: { 'bank_statement.ending_balance': '42318.55', 'title.vesting': 'ABC LLC' },
  findings: ['liquidity_short'],
};
let r = gs.scoreCase(golden, JSON.parse(JSON.stringify(golden)));
assert.strictEqual(r.boundaries.f1, 1);
assert.strictEqual(r.classification.accuracy, 1);
assert.strictEqual(r.fields.accuracy, 1);
assert.strictEqual(r.findings.recall, 1);
assert.strictEqual(r.findings.falseClears.length, 0);
assert.strictEqual(r.pass, true);
ok('a perfect candidate scores 1.0 on every metric and passes');

// --- a wrong boundary (statement split into two docs) drops boundary F1 ---
r = gs.scoreCase(golden, {
  documents: [{ docType: 'bank_statement', pages: [1] }, { docType: 'bank_statement', pages: [2] }, { docType: 'title', pages: [3] }],
  fields: golden.fields, findings: golden.findings,
});
assert.ok(r.boundaries.f1 < 1, 'splitting one document into two lowers boundary F1');
assert.strictEqual(r.boundaries.matched, 1, 'only the title boundary matched');
ok('a wrong page boundary lowers the boundary F1 score');

// --- a misclassification is caught among boundary-matched docs ---
r = gs.scoreCase(golden, {
  documents: [{ docType: 'bank_statement', pages: [1, 2] }, { docType: 'settlement', pages: [3] }], // title read as settlement
  fields: golden.fields, findings: golden.findings,
});
assert.strictEqual(r.classification.total, 2);
assert.strictEqual(r.classification.correct, 1);
assert.ok(r.classification.wrong.some((w) => w.expected === 'title' && w.actual === 'settlement'));
ok('a misclassified document is caught (expected title, got settlement)');

// --- a field misread is caught (normalized comparison) ---
r = gs.scoreCase(golden, {
  documents: golden.documents,
  fields: { 'bank_statement.ending_balance': '42313.55', 'title.vesting': 'ABC  llc' }, // balance wrong; vesting matches after normalize
  findings: golden.findings,
});
assert.strictEqual(r.fields.correct, 1, 'vesting matches after normalization; balance does not');
assert.ok(r.fields.mismatches.some((m) => m.field === 'bank_statement.ending_balance'));
ok('a field misread is caught; a formatting-only difference is not counted as wrong');

// --- a FALSE CLEAR (expected finding did not fire) fails the case ---
r = gs.scoreCase(golden, { documents: golden.documents, fields: golden.fields, findings: [] });
assert.strictEqual(r.findings.recall, 0);
assert.deepStrictEqual(r.findings.falseClears, ['liquidity_short']);
assert.strictEqual(r.pass, false, 'a missed expected finding (false clear) fails the case');
ok('a false clear — an expected finding that did not fire — is surfaced and fails the case');

// --- an extra finding is a false positive (recall still 1) ---
r = gs.scoreCase(golden, { documents: golden.documents, fields: golden.fields, findings: ['liquidity_short', 'noise_code'] });
assert.strictEqual(r.findings.recall, 1);
assert.deepStrictEqual(r.findings.falsePositives, ['noise_code']);
ok('an unexpected finding is counted as a false positive (recall unaffected)');

// --- corpus rollup: pass rate + means + total false clears ---
const corpus = gs.scoreCorpus([
  { golden, actual: JSON.parse(JSON.stringify(golden)) },        // perfect → pass
  { golden, actual: { documents: golden.documents, fields: golden.fields, findings: [] } }, // false clear → fail
]);
assert.strictEqual(corpus.summary.total, 2);
assert.strictEqual(corpus.summary.passed, 1);
assert.strictEqual(corpus.summary.passRate, 0.5);
assert.strictEqual(corpus.summary.totalFalseClears, 1, 'the corpus reports the total false clears (the release-gate number)');
ok('scoreCorpus rolls up pass rate, means, and total false clears for a release gate');

// --- boundary matching is strictly one-to-one (a corrupt golden case can't inflate precision > 1) ---
r = gs.scoreCase(
  { documents: [{ docType: 'x', pages: [1, 2] }, { docType: 'y', pages: [1, 2] }] }, // two golden docs, same page set
  { documents: [{ docType: 'x', pages: [1, 2] }] }, // one actual doc
);
assert.strictEqual(r.boundaries.matched, 1, 'one actual doc can match at most one golden doc');
assert.ok(r.boundaries.precision <= 1, 'precision can never exceed 1.0');
ok('boundary matching is one-to-one — a duplicate golden page-set cannot inflate precision above 1.0');

// --- empty / junk input is safe ---
assert.doesNotThrow(() => gs.scoreCase(null, null));
assert.strictEqual(gs.scoreCorpus([]).summary.total, 0);
assert.strictEqual(gs.scoreCase({}, {}).pass, true, 'two empty cases trivially agree');
ok('empty / null input is safe (never throws)');

console.log(`\nP3 golden-scorer pure — ${passed} checks passed`);
