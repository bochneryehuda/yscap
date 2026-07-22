'use strict';
/**
 * R5.57 — pure tests for the packet-intelligence orchestrator.
 * Proves it folds page-quality + page-fingerprint + continuation-group +
 * page-range-enforcer into ONE advisory report: it (1) flags blank/rotated/
 * unreadable/password pages with the right severity, (2) flags duplicate pages,
 * (3) produces an auto-orient plan, (4) marks a BLOCKING issue (unreadable/locked/
 * overlap) as needsReview while advisory issues don't, (5) runs the boundary check
 * when a proposed split is given, and (6) never throws.
 */
const assert = require('assert');
const pi = require('../src/lib/underwriting/packet-intelligence');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };
const issueKinds = (r) => r.issues.map((i) => i.kind);

// --- a mixed packet: normal, blank, rotated, duplicate ---
let r = pi.analyzePacket([
  { page_number: 1, text: 'chase bank statement account 5555 beginning balance 40000 ending balance 41000 page one of two' },
  { page_number: 2, text: '' },                                        // blank separator
  { page_number: 3, text: 'appraisal report subject 12 oak street market value 450000 comps', rotation: 90 }, // rotated
  { page_number: 4, text: 'CHASE Bank Statement, account 5555 — beginning balance 40000 ending balance 41000 (page one of two)' }, // dup of 1
]);
assert.strictEqual(r.totalPages, 4);
assert.ok(issueKinds(r).includes('blank'), 'blank page flagged');
assert.ok(issueKinds(r).includes('rotated'), 'rotated page flagged');
assert.ok(issueKinds(r).includes('duplicate'), 'duplicate pages flagged');
assert.deepStrictEqual(r.orientPlan, [{ pageNumber: 3, from: 90, to: 0 }], 'the rotated page gets an auto-orient plan');
const dupIssue = r.issues.find((i) => i.kind === 'duplicate');
assert.ok(dupIssue.pages.includes(1) && dupIssue.pages.includes(4), 'pages 1 & 4 are the duplicate cluster');
assert.strictEqual(r.needsReview, false, 'blank/rotated/duplicate are advisory — no blocking issue');
ok('a mixed packet folds blank + rotated + duplicate into one report with an auto-orient plan (advisory only)');

// --- an UNREADABLE page is a BLOCKING issue → needsReview ---
r = pi.analyzePacket([
  { page_number: 1, text: 'good readable page with plenty of words here for the classifier to accept' },
  { page_number: 2, ocr_status: 'unreadable', text: '' },
]);
assert.ok(issueKinds(r).includes('unreadable'));
const u = r.issues.find((i) => i.kind === 'unreadable');
assert.strictEqual(u.severity, 'blocking');
assert.deepStrictEqual(u.pages, [2]);
assert.strictEqual(r.needsReview, true, 'an unreadable page needs review');
assert.ok(r.recommendations.some((x) => /re-scan/i.test(x)));
ok('an unreadable page is a BLOCKING issue that sets needsReview and recommends a re-scan');

// --- a PASSWORD-PROTECTED page is blocking ---
r = pi.analyzePacket([{ page_number: 1, passwordProtected: true, text: '' }]);
assert.ok(issueKinds(r).includes('password_protected'));
assert.strictEqual(r.needsReview, true);
assert.ok(r.recommendations.some((x) => /unlocked/i.test(x)));
ok('a password-protected page is blocking and recommends requesting an unlocked copy');

// --- an upside-down page orients from 180 ---
r = pi.analyzePacket([{ page_number: 1, text: 'some appraisal text here for the page to be non-blank', rotation: 180 }]);
assert.deepStrictEqual(r.orientPlan, [{ pageNumber: 1, from: 180, to: 0 }]);
assert.ok(issueKinds(r).includes('rotated'), 'upside-down rolls into the rotated issue');
ok('an upside-down page produces a 180→0 auto-orient plan');

// --- the boundary/coverage check runs when a proposed split is supplied ---
r = pi.analyzePacket(
  [ { page_number: 1, text: 'doc a page one lots of words' }, { page_number: 2, text: 'doc a page two more words here' },
    { page_number: 3, text: 'doc b page one different words entirely' }, { page_number: 4, text: 'doc b page two even more distinct words' } ],
  { documents: [{ id: 'a', pages: [1, 2] }, { id: 'b', pages: [3] }], totalPages: 4 }); // page 4 unassigned → gap
assert.ok(r.coverage, 'coverage is computed when documents are supplied');
assert.deepStrictEqual(r.coverage.gaps, [4], 'page 4 is an unassigned gap');
assert.ok(issueKinds(r).includes('gap'), 'the gap surfaces as an advisory issue');
ok('when a proposed split is supplied, the boundary/coverage check runs and surfaces gaps');

// --- an OVERLAP in the proposed split is blocking ---
r = pi.analyzePacket(
  [ { page_number: 1, text: 'page one words' }, { page_number: 2, text: 'page two words' } ],
  { documents: [{ id: 'a', pages: [1, 2] }, { id: 'b', pages: [2] }], totalPages: 2 }); // page 2 claimed twice
assert.ok(issueKinds(r).includes('overlap'));
assert.strictEqual(r.needsReview, true, 'an overlapping split needs review');
ok('an overlapping proposed split is a BLOCKING overlap issue that needs review');

// --- a clean packet has no issues and needs no review ---
r = pi.analyzePacket([
  { page_number: 1, text: 'promissory note principal 315000 interest rate 11.5 percent maturity 2027 monthly interest only' },
  { page_number: 2, text: 'title commitment schedule a effective date exceptions taxes easements of record' },
]);
assert.deepStrictEqual(r.issues, [], 'a clean packet has no issues');
assert.strictEqual(r.needsReview, false);
assert.deepStrictEqual(r.orientPlan, []);
ok('a clean packet reports no issues, no orient plan, and needs no review');

// --- empty / junk input is safe ---
assert.doesNotThrow(() => pi.analyzePacket(null));
assert.strictEqual(pi.analyzePacket(null).totalPages, 0);
assert.deepStrictEqual(pi.analyzePacket(null).issues, []);
assert.doesNotThrow(() => pi.analyzePacket([null, 'junk', {}, { text: 12345 }]));
assert.doesNotThrow(() => pi.analyzePacket([{ text: 'x' }], { documents: 'notarray' }));
assert.strictEqual(pi.analyzePacket([{ text: 'x' }], { documents: 'notarray' }).coverage, null, 'a non-array documents opt yields null coverage, not a crash');
ok('empty / null / junk input is safe (never throws)');

console.log(`\nR5.57 packet-intelligence pure — ${passed} checks passed`);
