'use strict';
/**
 * P1 — pure tests for weak-page re-read + splice. Proves ONLY the weak pages are
 * re-read (not the whole document), the better text is spliced onto exactly those
 * pages, good pages are left untouched, and any failure (slice fails, re-read
 * empty, no bytes) safely returns the original without throwing. The PDF-slice
 * and OCR steps are injected so no pdf-lib / OCR keys are needed.
 */
const assert = require('assert');
const wr = require('../src/lib/ai/weak-page-reread');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

(async () => {
// --- spliceReread replaces only the weak page's text ---
const original = [
  { pageNumber: 1, text: 'page one good', confidence: 0.98 },
  { pageNumber: 2, text: 'pg 2 garbled ###', confidence: 0.42 },
  { pageNumber: 3, text: 'page three good', confidence: 0.95 },
];
let s = wr.spliceReread(original, { 2: { text: 'page two clean re-read', confidence: 0.99, engine: 'mistral-ocr' } });
assert.deepStrictEqual(s.replaced, [2]);
assert.strictEqual(s.pages[0].text, 'page one good', 'page 1 untouched');
assert.strictEqual(s.pages[1].text, 'page two clean re-read', 'page 2 spliced');
assert.strictEqual(s.pages[1].wasReread, true);
assert.strictEqual(s.pages[2].text, 'page three good', 'page 3 untouched');
assert.ok(s.text.includes('page two clean re-read') && s.text.includes('page one good'));
ok('spliceReread replaces only the weak page and rejoins the whole-document text');

// --- an EMPTY re-read is ignored (keep the original weak text) ---
s = wr.spliceReread(original, { 2: { text: '   ' } });
assert.deepStrictEqual(s.replaced, [], 'empty re-read text is not spliced');
assert.strictEqual(s.pages[1].text, 'pg 2 garbled ###', 'original weak text kept');
ok('an empty re-read is ignored — the original text is kept');

// --- orchestrator: re-reads ONLY the weak pages, maps sub-pages back, splices ---
let slicedFor = null;
const slice = async (buf, pages) => { slicedFor = pages; return { ok: true, buf: Buffer.from('subpdf'), pages }; };
// the injected reader returns per-page text for the sub-PDF (2 pages → weak 2 and 4)
const read = async (engine, a) => ({ ok: true, engine: 'mistral-ocr', pages: [{ text: 'reread of pg2', confidence: 0.97 }, { text: 'reread of pg4', confidence: 0.9 }] });
let r = await wr.rereadWeakPages({
  buffer: Buffer.from('%PDF-1.4 whole'),
  originalPages: [
    { pageNumber: 1, text: 'ok1' }, { pageNumber: 2, text: 'bad2' },
    { pageNumber: 3, text: 'ok3' }, { pageNumber: 4, text: 'bad4' },
  ],
  weakPages: [4, 2], // out of order on purpose
  engine: 'mistral',
  slice, read,
});
assert.strictEqual(r.ok, true);
assert.deepStrictEqual(slicedFor, [2, 4], 'only the weak pages are sliced, sorted ascending');
assert.deepStrictEqual(r.replaced.sort((a, b) => a - b), [2, 4]);
assert.strictEqual(r.pages[1].text, 'reread of pg2', 'page 2 got its re-read');
assert.strictEqual(r.pages[3].text, 'reread of pg4', 'page 4 got its re-read');
assert.strictEqual(r.pages[0].text, 'ok1', 'page 1 untouched');
assert.strictEqual(r.pages[2].text, 'ok3', 'page 3 untouched');
ok('rereadWeakPages re-reads only the weak pages and splices each back to its own page');

// --- a slice failure is safe (no throw, ok:false, no replacements) ---
r = await wr.rereadWeakPages({ buffer: Buffer.from('x'), originalPages: original, weakPages: [2], engine: 'mistral', slice: async () => ({ ok: false, reason: 'slice failed' }), read });
assert.strictEqual(r.ok, false);
assert.deepStrictEqual(r.replaced, []);
ok('a slice failure returns ok:false and no replacements (never throws)');

// --- a re-read failure is safe ---
r = await wr.rereadWeakPages({ buffer: Buffer.from('x'), originalPages: original, weakPages: [2], engine: 'mistral', slice, read: async () => ({ ok: false, reason: 'engine down' }) });
assert.strictEqual(r.ok, false);
ok('a re-read failure returns ok:false (never throws)');

// --- no weak pages / no bytes → not attempted ---
r = await wr.rereadWeakPages({ buffer: Buffer.from('x'), originalPages: original, weakPages: [], engine: 'mistral', slice, read });
assert.strictEqual(r.attempted, false);
r = await wr.rereadWeakPages({ originalPages: original, weakPages: [2], engine: 'mistral', slice, read });
assert.strictEqual(r.attempted, false, 'no source bytes → not attempted');
ok('no weak pages or no source bytes → not attempted, safe');

// --- single weak page whose engine returns only whole-doc text ---
r = await wr.rereadWeakPages({
  buffer: Buffer.from('%PDF'), originalPages: [{ pageNumber: 1, text: 'ok' }, { pageNumber: 2, text: 'bad' }],
  weakPages: [2], engine: 'mistral',
  slice: async (b, p) => ({ ok: true, buf: Buffer.from('s'), pages: p }),
  read: async () => ({ ok: true, engine: 'google-docai', text: 'clean whole-doc reread', pages: [] }),
});
assert.strictEqual(r.ok, true);
assert.strictEqual(r.pages[1].text, 'clean whole-doc reread', 'single-page whole-doc text splices onto the one weak page');
ok('a single-weak-page re-read with only whole-doc text splices onto that page');

// --- internals: sortWeak sorts + dedupes + drops junk ---
assert.deepStrictEqual(wr._internals.sortWeak([4, 2, 2, 0, -1, 'x', 3]), [2, 3, 4]);
ok('sortWeak sorts, dedupes, and drops invalid page numbers');

console.log(`\nP1 weak-page-reread pure — ${passed} checks passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
