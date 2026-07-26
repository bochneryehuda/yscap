'use strict';
/**
 * P2 — pure tests for the packet analyzer. Proves it composes page-quality +
 * continuation-group + the classifier into one analysis: a combined PDF is split
 * into the right logical documents with classifications, a multi-page statement
 * stays ONE document, a blank page is a separator, an upside-down page lands in
 * the orient plan, and a duplicate re-upload is flagged. Deterministic + advisory.
 */
const assert = require('assert');
const pa = require('../src/lib/underwriting/packet-analyze');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const clean = { ocr_status: 'ok', rotation: 0, unit: 'inch', width: 8.5, height: 11, pixel_width: 2550, pixel_height: 3300 };

// --- a real combined packet: 2-page bank statement, blank separator, a title commitment ---
let r = pa.analyzePacket([
  { page_number: 1, text: 'Wells Fargo bank statement — beginning balance and ending balance for the statement period. Page 1 of 2 account ****1234', ...clean },
  { page_number: 2, text: 'transactions continued deposits withdrawals account summary Page 2 of 2 account ****1234', ...clean },
  { page_number: 3, text: '   ', ...clean, imageCoverage: 0 }, // blank separator
  { page_number: 4, text: 'Commitment for title insurance — Schedule A, Schedule B exceptions, proposed insured, vested, legal description, title company', ...clean },
]);
assert.strictEqual(r.summary.totalPages, 4);
assert.strictEqual(r.summary.isCombined, true, '2 distinct doc types → combined PDF');
// bank statement pages 1-2 are ONE logical document
const bank = r.logicalDocuments.find((d) => d.docType === 'bank_statement');
assert.ok(bank && bank.pages.length === 2 && bank.pages[0] === 1 && bank.pages[1] === 2, 'the 2-page statement is one logical document');
// title is its own document on page 4
const title = r.logicalDocuments.find((d) => d.docType === 'title');
assert.ok(title && title.pages.includes(4));
// page 3 is a separator
assert.ok(r.separators.includes(3), 'the blank page is a separator');
ok('a combined PDF → correct logical documents (2-page statement stays one) + blank separator');

// --- the split plan lists each typed segment with page ranges ---
assert.ok(r.segments.some((s) => s.docType === 'bank_statement' && s.pages.length === 2));
assert.ok(r.segments.some((s) => s.docType === 'title'));
assert.ok(!r.segments.some((s) => s.pages.includes(3)), 'the blank page is not in any split segment');
ok('the split plan lists each typed segment with its page range, excluding the separator');

// --- an upside-down page lands in the orient plan ---
r = pa.analyzePacket([
  { page_number: 1, text: 'a normal readable government id driver license department of motor vehicles date of birth', ...clean },
  { page_number: 2, text: 'an upside down scan that still has some readable content on it', ...clean, rotation: 180, verdict: undefined },
]);
assert.ok(r.orientPlan.some((o) => o.pageNumber === 2 && o.from === 180 && o.to === 0), 'the 180° page is queued to auto-orient');
ok('an upside-down page is queued in the orient plan');

// --- a duplicate re-upload of the SAME document is flagged ---
const idText = 'driver license identification card department of motor vehicles date of birth class endorsements sex height eyes expires state of new york';
r = pa.analyzePacket([
  { page_number: 1, text: idText, ...clean },
  { page_number: 2, text: 'Commitment for title insurance Schedule A Schedule B exceptions proposed insured vested legal description title company', ...clean },
  { page_number: 3, text: idText, ...clean }, // a duplicate scan of the same ID
]);
assert.ok(r.duplicates.length >= 1, 'the duplicate ID scan is flagged');
assert.ok(r.duplicates[0].similarity >= 0.85);
ok('a duplicate re-upload of the same document is flagged');

// --- a single clean document is NOT flagged as combined ---
r = pa.analyzePacket([
  { page_number: 1, text: 'Uniform Residential Appraisal Report sales comparison approach opinion of value gross living area comparable appraiser', ...clean },
  { page_number: 2, text: 'appraisal continued comparable sales grid after repair value 1004', ...clean },
]);
assert.strictEqual(r.summary.isCombined, false, 'one document type → not a combined PDF');
assert.strictEqual(r.summary.distinctTypes, 1);
ok('a single-document upload is not flagged as a combined PDF');

// --- deterministic: same input → same analysis ---
const input = [{ page_number: 1, text: 'bank statement beginning balance ending balance statement period account summary', ...clean }];
assert.deepStrictEqual(pa.analyzePacket(input), pa.analyzePacket(input));
ok('the analysis is deterministic (same input → same output)');

// --- empty / junk input never throws ---
assert.doesNotThrow(() => pa.analyzePacket([]));
assert.doesNotThrow(() => pa.analyzePacket(null));
assert.strictEqual(pa.analyzePacket([]).summary.totalPages, 0);
ok('empty / null input returns a safe empty analysis (never throws)');

console.log(`\nP2 packet-analyze pure — ${passed} checks passed`);
