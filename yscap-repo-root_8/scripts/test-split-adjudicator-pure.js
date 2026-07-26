'use strict';
/**
 * R5.9 — pure tests for the splitter primary/challenger adjudicator.
 * Proves it (1) trusts a boundary both splitters propose, (2) confirms a
 * one-sided cut when a blank separator supports it, (3) rejects a one-sided cut
 * that a continuation group spans (a continuous document), (4) keeps an
 * otherwise-unresolved one-sided cut but flags it for human review, (5) never
 * silently trusts a single splitter, and (6) materializes the final documents
 * with page ranges + provenance + a type-conflict flag. Advisory: nothing here
 * splits a real packet — it produces a boundary plan a human confirms.
 */
const assert = require('assert');
const sa = require('../src/lib/underwriting/split-adjudicator');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- both splitters agree: trusted, high confidence, no review ---
let r = sa.adjudicateSplit(
  [{ pages: [1, 2], docType: 'bank_statement' }, { pages: [3, 4], docType: 'title' }],
  [{ pages: [1, 2], docType: 'bank_statement' }, { pages: [3, 4], docType: 'title' }],
  { pageCount: 4 },
);
assert.deepStrictEqual(r.boundaries, [1, 3]);
assert.strictEqual(r.agreement.agreementRate, 1);
assert.strictEqual(r.needsReview, false);
assert.strictEqual(r.documents[1].source, 'agreed');
assert.strictEqual(r.documents[1].confidence, 0.95);
assert.deepStrictEqual([r.documents[0].start, r.documents[0].end], [1, 2]);
assert.deepStrictEqual([r.documents[1].start, r.documents[1].end], [3, 4]);
ok('a boundary both splitters propose is trusted (agreed, no review)');

// --- one-sided cut SUPPORTED by a blank separator page ---
r = sa.adjudicateSplit(
  [{ pages: [1, 2] }, { pages: [4, 5] }],            // primary cuts at 4 (page 3 is blank)
  [{ pages: [1, 2, 3, 4, 5] }],                      // challenger missed the cut
  { pageCount: 5, separators: [3] },
);
assert.ok(r.boundaries.includes(4), 'the separator-backed cut survives');
const b4 = r.documents.find((d) => d.start === 4);
assert.strictEqual(b4.source, 'separator');
assert.strictEqual(b4.contested, false, 'a separator-supported cut is not contested');
ok('a one-sided cut is accepted when a blank separator page supports it');

// --- one-sided cut REJECTED by a continuation group spanning it ---
r = sa.adjudicateSplit(
  [{ pages: [1, 2] }, { pages: [3, 4] }],            // primary cuts at 3
  [{ pages: [1, 2, 3, 4] }],                         // challenger keeps them together
  { pageCount: 4, continuationGroups: [[2, 3]] },    // pages 2-3 are ONE continuous doc
);
assert.ok(!r.boundaries.includes(3), 'the cut is dropped — a continuation group spans it');
assert.ok(r.rejected.some((c) => c.page === 3 && /continuation/.test(c.reason)), 'the drop is recorded in rejected[], not contested[]');
assert.strictEqual(r.contested.length, 0, 'a confident signal-rejected cut is NOT a review item');
assert.strictEqual(r.needsReview, false, 'a confidently-resolved packet needs no review');
assert.deepStrictEqual(r.boundaries, [1], 'the packet stays one document');
ok('a one-sided cut is rejected when a continuation group spans it (recorded in rejected, no review)');

// --- one-sided cut with NO signal: kept but contested + flagged ---
r = sa.adjudicateSplit(
  [{ pages: [1, 2] }, { pages: [3, 4] }],            // primary cuts at 3
  [{ pages: [1, 2, 3, 4] }],                         // challenger disagrees, no separator, no continuation
  { pageCount: 4 },
);
assert.ok(r.boundaries.includes(3), 'the cut is KEPT (never lose a possible document)');
const b3 = r.documents.find((d) => d.start === 3);
assert.strictEqual(b3.contested, true);
assert.strictEqual(b3.source, 'primary');
assert.ok(b3.confidence < 0.5, 'a lone unconfirmed cut carries low confidence');
assert.strictEqual(r.needsReview, true, 'an unconfirmed cut forces human review');
assert.ok(r.contested.some((c) => c.page === 3 && c.proposedBy === 'primary'));
ok('a one-sided cut with no physical signal is kept but contested and flagged for review');

// --- challenger-only cut is treated symmetrically ---
r = sa.adjudicateSplit(
  [{ pages: [1, 2, 3, 4] }],
  [{ pages: [1, 2] }, { pages: [3, 4] }],            // challenger proposes the cut
  { pageCount: 4 },
);
const c3 = r.documents.find((d) => d.start === 3);
assert.strictEqual(c3.source, 'challenger');
assert.strictEqual(c3.contested, true);
assert.strictEqual(r.agreement.challengerOnly, 1);
assert.strictEqual(r.agreement.primaryOnly, 0);
ok('a challenger-only cut is adjudicated symmetrically to a primary-only cut');

// --- agreed boundary but DIFFERENT docType → type conflict flagged ---
r = sa.adjudicateSplit(
  [{ pages: [1, 2], docType: 'bank_statement' }, { pages: [3, 4], docType: 'title' }],
  [{ pages: [1, 2], docType: 'bank_statement' }, { pages: [3, 4], docType: 'settlement' }], // page-3 type disagrees
  { pageCount: 4 },
);
const d3 = r.documents.find((d) => d.start === 3);
assert.ok(d3.typeConflict, 'a docType disagreement at an agreed boundary is surfaced');
assert.deepStrictEqual(d3.typeConflict, { primary: 'title', challenger: 'settlement' });
assert.strictEqual(d3.contested, true, 'a type conflict makes the boundary need review');
assert.strictEqual(r.needsReview, true);
assert.ok(r.contested.some((c) => c.page === 3 && /type disagrees/.test(c.reason)), 'the type conflict is also listed in contested[] so it and needsReview agree');
ok('an agreed boundary with disagreeing document types is flagged as a type conflict');

// --- pageCount is never allowed below the highest proposed page (no inverted range) ---
r = sa.adjudicateSplit(
  [{ pages: [1, 2] }, { pages: [5, 6] }],
  [{ pages: [1, 2] }, { pages: [5, 6] }],
  { pageCount: 3 }, // bogus: smaller than the last document's start (5)
);
const last = r.documents[r.documents.length - 1];
assert.strictEqual(last.start, 5);
assert.ok(last.end >= last.start, 'the last document never has end < start even with a too-small pageCount');
assert.strictEqual(last.end, 6, 'pageCount is clamped up to the highest proposed page');
ok('a pageCount below the highest proposed page never produces an inverted document range');

// --- agreementRate reflects partial overlap ---
r = sa.adjudicateSplit(
  [{ pages: [1, 2] }, { pages: [3, 4] }, { pages: [5, 6] }], // cuts at 3,5
  [{ pages: [1, 2] }, { pages: [3, 4, 5, 6] }],              // cut at 3 only
  { pageCount: 6 },
);
// internal cuts = {3,5}; agreed = {3}; rate = 1/2
assert.strictEqual(r.agreement.agreedCuts, 1);
assert.strictEqual(r.agreement.agreementRate, 0.5);
ok('agreementRate reports the share of internal boundaries the splitters agreed on');

// --- separators/blank groups in a proposal are ignored as documents ---
r = sa.adjudicateSplit(
  [{ pages: [1, 2] }, { pages: [3], blank: true, reason: 'separator' }, { pages: [4, 5] }],
  [{ pages: [1, 2] }, { pages: [4, 5] }],
  { pageCount: 5, separators: [3] },
);
assert.ok(r.boundaries.includes(4), 'the real cut at 4 is found');
assert.ok(!r.boundaries.includes(3), 'the blank separator group is not itself a document boundary');
ok('a blank/separator group in a proposal is not treated as a document');

// --- empty / junk input is safe ---
assert.doesNotThrow(() => sa.adjudicateSplit(null, null));
let e = sa.adjudicateSplit(null, null);
assert.strictEqual(e.needsReview, false);
assert.strictEqual(e.agreement.agreementRate, 1, 'nothing to split → trivial agreement');
assert.doesNotThrow(() => sa.adjudicateSplit([{ pages: [1] }], undefined, undefined));
ok('empty / null input is safe (never throws)');

console.log(`\nR5.9 split-adjudicator pure — ${passed} checks passed`);
