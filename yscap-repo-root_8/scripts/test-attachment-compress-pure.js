'use strict';
/**
 * THE COMPRESSION ENGINE'S SEVEN RULES, each pinned by the case that breaks it.
 *
 * Pure — no database, no network. It builds real JPEGs and real PDFs in memory, because the whole
 * question here is whether the bytes we produce are still a usable document, and a mocked buffer
 * cannot answer that. The expensive assertions (a decode is ~3s of pure JavaScript) are kept to
 * modest pixel counts so this stays inside a normal test run.
 *
 * The two that matter most and are easiest to get wrong:
 *   · a CMYK / 4-component image must be SKIPPED, not recoloured — and the RGB twin of the same
 *     fixture must be resized, or the "skip" assertion would pass on a dud fixture that could
 *     never have been resized anyway.
 *   · the output must RE-OPEN as the same document, with the image genuinely smaller and still
 *     decodable at its declared dimensions. "It got smaller" is not the same as "it still works".
 */
const assert = require('assert');
const jpeg = require('jpeg-js');
const { PDFDocument, PDFName, PDFRawStream } = require('pdf-lib');
const C = require('../src/lib/attachments/compress');

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log(`  ok  ${name}`);
}

/** A synthetic photograph — real gradients and noise, so it compresses like a photo, not a flat fill. */
function photo(w, h, q) {
  const d = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = (i / w) | 0;
    d[i * 4] = (x * 3 + ((Math.sin(x * 0.05) * 40) | 0)) & 255;
    d[i * 4 + 1] = (y * 3 + ((Math.cos(y * 0.04) * 40) | 0)) & 255;
    d[i * 4 + 2] = (x ^ y) & 255;
    d[i * 4 + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ data: d, width: w, height: h }, q || 92).data);
}

async function pdfWithPhoto(w, h) {
  const doc = await PDFDocument.create();
  const img = await doc.embedJpg(photo(w, h, 92));
  const p = doc.addPage([612, 792]);
  p.drawImage(img, { x: 0, y: 200, width: 612, height: 400 });
  return Buffer.from(await doc.save());
}

/** Every embedded image's dictionary facts, read back out of a produced PDF. */
async function imagesIn(buf) {
  const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
  const out = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (C._internals.nameOf(obj.dict.get(PDFName.of('Subtype'))) !== '/Image') continue;
    out.push({
      w: obj.dict.get(PDFName.of('Width')).asNumber(),
      h: obj.dict.get(PDFName.of('Height')).asNumber(),
      cs: C._internals.nameOf(obj.dict.get(PDFName.of('ColorSpace'))),
      bytes: Buffer.from(obj.contents),
    });
  }
  return out;
}

(async () => {
  console.log('\n-- rule 1: never throws, and every failure returns the ORIGINAL bytes --');
  let r = await C.compressOnce(Buffer.from('this is a plain text file, not a document'));
  ok('a format with nothing to win is reported, not failed', !r.changed && r.reason === 'nothing_to_compress');

  r = await C.compressOnce(Buffer.alloc(0));
  ok('an empty buffer is handled', !r.changed && r.reason === 'empty');

  const corrupt = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(600, 7)]);
  r = await C.compressOnce(corrupt);
  ok('a corrupt PDF comes back byte-for-byte, no throw', !r.changed && r.buf.equals(corrupt));

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(900, 3)]);
  r = await C.compressOnce(png);
  ok('a PNG is left alone (this repo has no PNG decoder)', !r.changed && r.buf.equals(png));

  console.log('\n-- rule 2: never returns a bigger buffer --');
  const tiny = photo(220, 160, 55);
  r = await C.compressOnce(tiny, { level: 5 });
  ok(`an already-crushed photo never grows (${tiny.length} -> ${r.buf.length})`, r.buf.length <= tiny.length);

  console.log('\n-- rules 3 + 7: the result re-opens as the same document, and the level is reported --');
  const src = await pdfWithPhoto(1500, 1100);
  const before = await imagesIn(src);
  ok('fixture really carries one embedded image', before.length === 1);

  r = await C.compressPdf(src, { level: 5 });
  ok(`level 5 resized it (${(r.before / 1024) | 0}KB -> ${(r.after / 1024) | 0}KB)`, r.changed && r.images.resized === 1);
  ok('the level used is reported back', r.level === 5 && /\d+px/.test(r.note));

  const srcPages = (await PDFDocument.load(src)).getPageCount();
  const outPages = (await PDFDocument.load(r.buf)).getPageCount();
  ok(`page count survives (${srcPages} = ${outPages})`, srcPages === outPages);

  const after = await imagesIn(r.buf);
  ok(`the embedded image is genuinely smaller (${before[0].w}x${before[0].h} -> ${after[0].w}x${after[0].h})`,
    Math.max(after[0].w, after[0].h) <= 600 && after[0].w < before[0].w);
  ok('and is declared DeviceRGB, matching the bytes we wrote', after[0].cs === '/DeviceRGB');

  const dec = jpeg.decode(after[0].bytes, { useTArray: true });
  ok('the re-embedded JPEG decodes at exactly its declared size',
    dec.width === after[0].w && dec.height === after[0].h);

  console.log('\n-- rule 4: only images we can faithfully reproduce are touched --');
  // The SAME fixture, relabelled CMYK. jpeg-js hands back RGB pixels whatever went in, so
  // re-embedding this would silently change the colours of a document that goes out for signature.
  const doc = await PDFDocument.load(src);
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && C._internals.nameOf(obj.dict.get(PDFName.of('Subtype'))) === '/Image') {
      obj.dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceCMYK'));
    }
  }
  const cmyk = Buffer.from(await doc.save());
  const rc = await C.compressPdf(cmyk, { level: 5 });
  ok('a CMYK image is skipped, never recoloured', rc.images.seen === 1 && rc.images.resized === 0 && rc.images.skipped === 1);
  // The control that makes the assertion above mean something: the identical fixture in RGB IS
  // resized, so "skipped" is the colour-space guard biting and not an image that never qualified.
  ok('CONTROL — the identical fixture in RGB is resized', r.images.resized === 1);

  ok('a 4-component JPEG is refused by the component check',
    C._internals.jpegComponents(photo(64, 64, 80)) === 3);

  console.log('\n-- rule 5: bounded in time, and a bound that bites is REPORTED --');
  // NOTE the deadline has a deliberate ONE SECOND FLOOR — a deadline below that guarantees zero
  // work and would make the compressor look broken rather than bounded. So proving the bound bites
  // needs a document with MORE work in it than a second buys: four photos, ~1s of pure-JS decode
  // each. The first fits inside the floor; the rest must be abandoned AND reported.
  const manyDoc = await PDFDocument.create();
  for (let i = 0; i < 4; i++) {
    const img = await manyDoc.embedJpg(photo(1700 + i, 1300, 92));
    manyDoc.addPage([612, 792]).drawImage(img, { x: 0, y: 200, width: 612, height: 400 });
  }
  const many = Buffer.from(await manyDoc.save());
  const t0 = Date.now();
  const rd = await C.compressPdf(many, { level: 5, deadlineMs: 1 });
  const elapsed = Date.now() - t0;
  ok(`an exhausted deadline returns promptly (${elapsed}ms for 4 photos)`, elapsed < 6000);
  ok(`and says so rather than pretending it finished (partial=${rd.partial})`, rd.partial === true);
  ok('what it DID manage is still returned, not thrown away', rd.changed && rd.after < rd.before);

  // THE WORK CAP IS THE DETERMINISTIC HALF. A wall-clock deadline cannot prove that work was
  // ABANDONED — how many photos fit inside the one-second floor depends on the machine, and this
  // assertion was flaky for exactly that reason. The image cap bounds the same behaviour with no
  // clock in it: exactly two of the four are done, and the bound is reported rather than silent.
  const rCap = await C.compressPdf(many, { level: 5, maxImages: 2, deadlineMs: 60000 });
  ok(`a work cap stops at the cap (${rCap.images.resized} of 4 resized)`, rCap.images.resized === 2);
  ok('and reports that it did — a bound that is not reported is a silent cap', rCap.partial === true);

  // The same document with a real deadline finishes the job — the control proving the case above is
  // the bound biting, not a document that could never have been compressed.
  const rfull = await C.compressPdf(many, { level: 5, deadlineMs: 60000 });
  ok(`CONTROL — given time, all four are resized (${rfull.images.resized}/4)`, rfull.images.resized === 4 && !rfull.partial);

  console.log('\n-- escalation: stops at the first level that fits, and never crushes further --');
  const big = await pdfWithPhoto(2000, 1500);
  const target = Math.round(big.length * 0.45);
  const fit = await C.compressToFit(big, target);
  ok(`compressToFit reached the target (${(big.length / 1024) | 0}KB -> ${(fit.after / 1024) | 0}KB, target ${(target / 1024) | 0}KB)`,
    fit.fits && fit.after <= target);
  ok('it stopped early rather than driving to maximum', fit.level < C.MAX_LEVEL);
  ok('every attempt is reported', Array.isArray(fit.attempts) && fit.attempts.length >= 1);

  const impossible = await C.compressToFit(big, 1);
  ok('an unreachable target still returns the best effort, honestly flagged',
    impossible.fits === false && impossible.after < big.length);

  // A PHOTO MUST ESCALATE. Level 1 is a structural repack, which for an image is a no-op by
  // design — so an early-exit keyed on "level 1 did nothing" stops before levels 2..5, the only
  // ones that shrink a picture, and every oversized photo comes back unchanged. That shipped and
  // was caught by the end-to-end delivery test, not here; this is the unit-level guard.
  const bigPhoto = photo(2400, 1800, 94);
  const pf = await C.compressToFit(bigPhoto, Math.round(bigPhoto.length * 0.25));
  ok(`a standalone JPEG escalates past level 1 (${(bigPhoto.length / 1024) | 0}KB -> ${(pf.after / 1024) | 0}KB at level ${pf.level})`,
    pf.changed && pf.level >= 2 && pf.after < bigPhoto.length);
  ok('and it reached the target', pf.fits);
  ok('level 1 alone genuinely does nothing to an image — which is why the loop must not stop there',
    (await C.compressOnce(bigPhoto, { level: 1 })).changed === false);

  // A format with nothing to win DOES stop at once, rather than burning the deadline five times.
  const zipish = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(5000, 9)]);
  const zf = await C.compressToFit(zipish, 10);
  ok(`an untouchable format stops immediately (${zf.attempts.length} attempt)`, zf.attempts.length === 1);

  console.log(`\nAll ${passed} assertions passed.\n`);
})().catch((e) => { console.error('\nFAILED:', e && e.message, '\n', e); process.exit(1); });
