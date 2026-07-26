#!/usr/bin/env node
'use strict';
/**
 * Pure unit tests for the document-authenticity scorer.
 * Feeds hand-crafted PDF-like byte blobs and asserts the signals + score.
 */
const assert = require('assert');
const { analyzePdf, _internals } = require('../src/lib/underwriting/authenticity');
const { parsePdfDate, countOccurrences } = _internals;

// ---- helpers to hand-craft byte blobs that look enough like a PDF ----
function makePdfBuffer({ producer = 'Adobe PDF Library', creator = 'Microsoft Word', creationDate = 'D:20260101120000', modDate = null, revisions = 1, pages = 3, extra = '', size = 200 * 1024 } = {}) {
  const meta = [
    `<< /Producer(${producer}) /Creator(${creator}) /CreationDate(${creationDate})`,
    modDate ? `/ModDate(${modDate})` : '',
    ` >>`,
  ].join(' ');
  const pageBlocks = Array.from({ length: pages }, () => '/Type/Page /MediaBox [0 0 612 792]').join('\n');
  const xrefs = Array.from({ length: revisions }, () => 'startxref\n1234\n%%EOF').join('\n');
  const body = `%PDF-1.7\n${meta}\n${pageBlocks}\n${extra}\n${xrefs}\n`;
  const buf = Buffer.alloc(size);
  Buffer.from(body, 'latin1').copy(buf, 0);
  return buf;
}

// ---- parsePdfDate ----
assert.deepStrictEqual(parsePdfDate('D:20260101120000')?.toISOString(), '2026-01-01T12:00:00.000Z');
assert.strictEqual(parsePdfDate('junk'), null);
assert.strictEqual(parsePdfDate(''), null);

// ---- countOccurrences ----
assert.strictEqual(countOccurrences('abcabc', 'a'), 2);
assert.strictEqual(countOccurrences('', 'a'), 0);

// ---- not a PDF ----
{
  const r = analyzePdf(Buffer.from('this is not a pdf but is long enough to pass the tiny-buffer guard xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'));
  assert.strictEqual(r.level, 'unreadable');
  assert.ok(r.signals.some((s) => s.name === 'not_a_pdf' && s.present));
}

// ---- empty buffer ----
{
  const r = analyzePdf(Buffer.alloc(0));
  assert.strictEqual(r.level, 'unreadable');
  assert.strictEqual(r.score, 0);
}

// ---- clean, native PDF (Adobe PDF Library + Microsoft Word producer) ----
{
  const buf = makePdfBuffer({ producer: 'Adobe PDF Library 15.0', creator: 'Microsoft Word 2019' });
  const r = analyzePdf(buf);
  assert.strictEqual(r.level, 'high', `clean pdf should be high, got ${r.level} (${r.score})`);
  assert.ok(r.score >= 0.75);
  assert.ok(r.signals.find((s) => s.name === 'legitimate_producer').present);
  assert.ok(!r.signals.find((s) => s.name === 'image_editor_marker').present);
}

// ---- photoshopped bank statement ----
{
  const buf = makePdfBuffer({ producer: 'Adobe Photoshop CC 2023', creator: 'Photoshop', creationDate: 'D:20260601000000', modDate: 'D:20260601020000' });
  const r = analyzePdf(buf);
  assert.ok(r.score < 0.75, `photoshopped pdf should have a real penalty, got ${r.score}`);
  assert.ok(r.signals.find((s) => s.name === 'image_editor_marker').present);
  assert.ok(r.signals.find((s) => s.name === 'mod_after_creation_10min').present);
}

// ---- multiple revisions ----
{
  const buf = makePdfBuffer({ producer: 'Adobe PDF Library', revisions: 3 });
  const r = analyzePdf(buf);
  assert.ok(r.signals.find((s) => s.name === 'multiple_revisions').present);
  assert.ok(r.score < 1);
}

// ---- future dates ----
{
  const buf = makePdfBuffer({ producer: 'Adobe PDF Library', creationDate: 'D:20991231000000' });
  const r = analyzePdf(buf);
  assert.ok(r.signals.find((s) => s.name === 'future_dates').present);
}

// ---- embedded JavaScript ----
{
  const buf = makePdfBuffer({ producer: 'Adobe PDF Library', extra: '<< /JS(app.alert("hi")) >>' });
  const r = analyzePdf(buf);
  assert.ok(r.signals.find((s) => s.name === 'embedded_javascript').present);
}

// ---- Launch action ----
{
  const buf = makePdfBuffer({ producer: 'Adobe PDF Library', extra: '<< /S /Launch /F(evil.exe) >>' });
  const r = analyzePdf(buf);
  assert.ok(r.signals.find((s) => s.name === 'launch_action').present);
}

// ---- tiny bytes/page ----
{
  const buf = makePdfBuffer({ producer: 'Adobe PDF Library', pages: 10, size: 20 * 1024 });
  const r = analyzePdf(buf);
  assert.ok(r.signals.find((s) => s.name === 'tiny_bytes_per_page').present);
}

// ---- many distinct fonts (re-authored) ----
{
  const fonts = Array.from({ length: 15 }, (_, i) => `/BaseFont /F${i}`).join(' ');
  const buf = makePdfBuffer({ producer: 'Adobe PDF Library', extra: fonts });
  const r = analyzePdf(buf);
  assert.ok(r.signals.find((s) => s.name === 'many_distinct_fonts').present);
}

// ---- realistic HEAVILY-tampered PDF → low ----
{
  const buf = makePdfBuffer({
    producer: 'Adobe Photoshop 2024', creator: 'Photoshop',
    creationDate: 'D:20260101000000', modDate: 'D:20260601000000',
    revisions: 3,
    extra: '<< /JS(x) >> ' + Array.from({ length: 18 }, (_, i) => `/BaseFont /Font${i}`).join(' '),
  });
  const r = analyzePdf(buf);
  assert.strictEqual(r.level, 'low', `heavily-tampered pdf should be low, got ${r.level} (${r.score})`);
}

console.log('test-authenticity-pure: PDF signal extraction + scoring passes');
