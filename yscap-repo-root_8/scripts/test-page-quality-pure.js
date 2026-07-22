'use strict';
/**
 * R5.8 — pure tests for the page-quality classifier. Proves each page-quality
 * problem the owner named — blank/separator, sideways, upside-down, low-res,
 * unreadable, password-locked — is detected, and a clean page reads 'ok'. It is
 * advisory only (verdict + issues), never a page mutation.
 */
const assert = require('assert');
const pq = require('../src/lib/underwriting/page-quality');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- a clean, readable letter page at 300 DPI ---
let r = pq.assessPage({ text: 'This is a normal page with plenty of readable content on it.', ocr_status: 'ok', rotation: 0, unit: 'inch', width: 8.5, height: 11, pixel_width: 2550, pixel_height: 3300, imageCoverage: 0.1 });
assert.strictEqual(r.verdict, 'ok');
assert.strictEqual(r.issues.length, 0);
assert.ok(r.dpi >= 290 && r.dpi <= 310, 'DPI ~300');
ok('a clean 300-DPI readable page → ok, no issues');

// --- a blank separator page ---
r = pq.assessPage({ text: '   ', ocr_status: 'ok', rotation: 0, imageCoverage: 0, unit: 'inch', width: 8.5, height: 11, pixel_width: 2550, pixel_height: 3300 });
assert.strictEqual(r.verdict, 'blank');
assert.ok(r.blankScore >= 0.9);
assert.ok(r.issues.some((i) => i.code === 'page_blank'));
ok('an empty page → blank (likely a separator), blankScore high');

// --- a sideways (90°) page ---
r = pq.assessPage({ text: 'sideways scan content here that is readable', ocr_status: 'ok', rotation: 90, unit: 'inch', width: 8.5, height: 11, pixel_width: 2550, pixel_height: 3300 });
assert.strictEqual(r.verdict, 'rotated');
assert.ok(r.issues.some((i) => i.code === 'page_rotated'));
assert.ok(r.qualityScore <= 0.6);
ok('a 90° page → rotated (needs auto-rotate)');

// --- an upside-down (180°) page ---
r = pq.assessPage({ text: 'upside down content that still has text', ocr_status: 'ok', rotation: 180, unit: 'inch', width: 8.5, height: 11, pixel_width: 2550, pixel_height: 3300 });
assert.strictEqual(r.verdict, 'upside_down');
assert.ok(r.issues.some((i) => i.code === 'page_upside_down'));
ok('a 180° page → upside_down (needs auto-orient)');

// --- a low-resolution scan (~100 DPI) ---
r = pq.assessPage({ text: 'low res but present text content on the page', ocr_status: 'ok', rotation: 0, unit: 'inch', width: 8.5, height: 11, pixel_width: 850, pixel_height: 1100 });
assert.strictEqual(r.verdict, 'low_res');
assert.ok(r.dpi < pq.MIN_DPI);
ok('a ~100-DPI scan → low_res (below the preferred resolution)');

// --- an unreadable page (OCR failed) ---
r = pq.assessPage({ text: '', ocr_status: 'unreadable', rotation: 0 });
assert.strictEqual(r.verdict, 'unreadable');
assert.ok(r.issues.some((i) => i.code === 'page_unreadable'));
ok('an OCR-failed page → unreadable');

// --- a very low DPI (~50) is unreadable, not just low_res ---
r = pq.assessPage({ text: 'x', ocr_status: 'ok', unit: 'inch', width: 8.5, height: 11, pixel_width: 425, pixel_height: 550 });
assert.strictEqual(r.verdict, 'unreadable');
ok('a ~50-DPI page → unreadable (below the usable floor)');

// --- a password-locked page beats everything ---
r = pq.assessPage({ passwordProtected: true, text: '', ocr_status: 'unreadable', rotation: 90 });
assert.strictEqual(r.verdict, 'password_protected');
ok('a password-locked page → password_protected (worst-wins)');

// --- packet roll-up ---
const packet = pq.assessPacket([
  { text: 'page one has real content that reads fine', ocr_status: 'ok', rotation: 0, unit: 'inch', width: 8.5, height: 11, pixel_width: 2550, pixel_height: 3300 },
  { text: '  ', ocr_status: 'ok', rotation: 0, imageCoverage: 0, unit: 'inch', width: 8.5, height: 11, pixel_width: 2550, pixel_height: 3300 },
  { text: 'this page is rotated ninety degrees but has readable content', ocr_status: 'ok', rotation: 270, unit: 'inch', width: 8.5, height: 11, pixel_width: 2550, pixel_height: 3300 },
]);
assert.strictEqual(packet.summary.total, 3);
assert.strictEqual(packet.summary.blank, 1);
assert.strictEqual(packet.summary.rotated, 1);
assert.strictEqual(packet.summary.needsAttention, 1, 'rotated needs attention; blank is a separator, not attention');
assert.strictEqual(packet.pages[0].pageNumber, 1);
ok('assessPacket rolls up per-page verdicts with counts + page numbers');

console.log(`\nR5.8 page-quality pure — ${passed} checks passed`);
