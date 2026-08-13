'use strict';
/**
 * FIT A PHOTO TO WHAT THE PAGE CAN SHOW (owner-directed 2026-08-13) — pure, no DB.
 *
 * THE REPORT: an inspection with ~100 photos reached the investor with the PILOT draw report
 * missing entirely ("too large to attach to one email"), and inside the report itself only about
 * fifteen photos had ever been embedded — because jsPDF copies JPEG bytes in verbatim and a phone
 * photo is ~3.5 MB against a 60 MB embed budget. The fix is to embed a copy sized to the 118pt
 * cell the page actually draws into.
 *
 * WHAT THIS FILE GUARDS is the property that makes that safe to do to a loan file's EVIDENCE:
 * `fitJpeg` may only ever return a SMALLER, VALID JPEG or THE ORIGINAL BYTES — never a corrupted
 * buffer, never a bigger one, never a re-encode of something that was already the right size, and
 * never an exception. A draw photo is the proof the money moved against; losing one to save a few
 * hundred kilobytes is a far worse outcome than a large PDF.
 */
const assert = require('assert');
const jpeg = require('jpeg-js');

const imageFit = require('../src/lib/image-fit');
const photos = require('../src/lib/appraisal/photos');

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); checks += 1; };

// A photographic-ish test image: smooth gradient + block edges + fine noise, so JPEG behaves the
// way it does on a real photo rather than compressing a flat field to nothing.
function makeJpeg(w, h, quality, flat) {
  const d = Buffer.alloc(w * h * 4);
  let s = 987654321;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const base = flat ? 128 : 90 + 70 * Math.sin(x / 37) + 50 * Math.cos(y / 23);
      const edge = flat ? 0 : (((x >> 5) + (y >> 5)) % 2 ? 18 : -18);
      const n = flat ? 0 : (rnd() - 0.5) * 26;
      const v = Math.max(0, Math.min(255, base + edge + n));
      d[i] = v; d[i + 1] = Math.max(0, Math.min(255, v * 0.92)); d[i + 2] = Math.max(0, Math.min(255, v * 0.8)); d[i + 3] = 255;
    }
  }
  return Buffer.from(jpeg.encode({ data: d, width: w, height: h }, quality).data);
}

// ── A. THE RESAMPLER HAS ONE HOME ───────────────────────────────────────────────
{
  /* image-fit must REUSE the appraisal pipeline's box filter. A second copy would drift, and two
     surfaces would then disagree about what a shrunk photo looks like. */
  eq(typeof photos.downscale, 'function', 'A1 the appraisal box filter is exported for reuse');
  const src = require('fs').readFileSync(require.resolve('../src/lib/image-fit.js'), 'utf8');
  ok(/require\(['"]\.\/appraisal\/photos['"]\)/.test(src), 'A2 image-fit requires that module…');
  ok(/photos\.downscale\(/.test(src), 'A3 …and calls its resampler rather than re-implementing one');
  /* jpeg-js must be required LAZILY (inside the function): this module is pulled in by the report
     path, and a top-level require would load a decoder on every boot that never resizes anything. */
  ok(!/^const .*require\(['"]jpeg-js['"]\)/m.test(src), 'A4 the JPEG codec is required lazily, not at module load');
}

// ── B. IT ACTUALLY SHRINKS, AND THE RESULT IS A REAL JPEG ───────────────────────
{
  const src = makeJpeg(1200, 900, 92);
  const r = imageFit.fitJpeg(src, { maxSide: 300 });
  eq(r.reason, 'resized', 'B1 an oversized photo is resized');
  eq(r.changed, true, 'B2 …and reports that it changed');
  eq(r.to.w, 300, 'B3 the long side lands exactly on the target');
  eq(r.to.h, 225, 'B4 …and the aspect ratio is preserved');
  ok(imageFit.isJpeg(r.buf), 'B5 the result is a valid JPEG (magic bytes re-read, not assumed)');
  ok(r.buf.length < src.length, 'B6 …and it is smaller than the original');
  // It must be genuinely decodable — a buffer that only LOOKS like a JPEG would put a broken
  // picture in front of a capital partner.
  const dec = jpeg.decode(r.buf, { useTArray: true });
  eq(dec.width, 300, 'B7 the result decodes back at the resized width');
  eq(dec.height, 225, 'B8 …and height');
  eq(r.bytesBefore, src.length, 'B9 the before size is reported');
  eq(r.bytesAfter, r.buf.length, 'B10 …and the after size');
}

// ── C. NEVER UPSCALE, NEVER RE-ENCODE WHAT IS ALREADY RIGHT ─────────────────────
{
  const small = makeJpeg(240, 180, 85);
  const r = imageFit.fitJpeg(small, { maxSide: 1600 });
  eq(r.reason, 'already_small', 'C1 a photo under the target is left alone');
  eq(r.changed, false, 'C2 …and reports no change');
  /* THE SAME BUFFER, not an equal one. Re-encoding an already-correct JPEG adds a second
     generation of loss for zero saving — the identity check is what proves it did not happen. */
  ok(r.buf === small, 'C3 …and the ORIGINAL bytes come back, not a re-encode');

  // Idempotence: fitting a result again must be a no-op, or repeated passes would grind a photo
  // down a little further every time.
  const big = makeJpeg(900, 600, 92);
  const once = imageFit.fitJpeg(big, { maxSide: 400 });
  const twice = imageFit.fitJpeg(once.buf, { maxSide: 400 });
  eq(twice.reason, 'already_small', 'C4 fitting twice is a no-op…');
  ok(twice.buf === once.buf, 'C5 …returning the same bytes, so quality can never erode by repetition');

  // Exactly on the boundary is "already small" — a photo the size of the target must not be
  // re-encoded for nothing.
  const exact = imageFit.fitJpeg(makeJpeg(400, 300, 85), { maxSide: 400 });
  eq(exact.reason, 'already_small', 'C6 a photo exactly at the target is left alone');
}

// ── D. NEVER RETURN A BIGGER BUFFER ─────────────────────────────────────────────
{
  /* A source that was already crushed can GROW when re-encoded at a higher quality: the decode
     hands back the blocky, quantized pixels and a high-quality encode then spends real bytes
     preserving those artifacts faithfully. Shipping that would make the very problem this exists
     to solve worse. Reproduced deterministically with heavy noise (expensive at high quality,
     cheap at low), a brutally-quantized source, and a barely-smaller target. */
  const noisy = (w, h, q) => {
    const d = Buffer.alloc(w * h * 4);
    let s = 7; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let i = 0; i < w * h; i++) {
      d[i * 4] = 128 + (rnd() - 0.5) * 200;
      d[i * 4 + 1] = 128 + (rnd() - 0.5) * 200;
      d[i * 4 + 2] = 128 + (rnd() - 0.5) * 200;
      d[i * 4 + 3] = 255;
    }
    return Buffer.from(jpeg.encode({ data: d, width: w, height: h }, q).data);
  };
  const crushed = noisy(400, 300, 2);
  const r = imageFit.fitJpeg(crushed, { maxSide: 399, quality: 95 });
  eq(r.reason, 'no_saving', 'D1 a re-encode that would GROW the file is rejected');
  ok(r.buf === crushed, 'D2 …and the ORIGINAL bytes are what come back');
  eq(r.changed, false, 'D3 …reported as no change');
  eq(r.bytesAfter, r.bytesBefore, 'D4 …with the size unmoved');

  // The invariant, asserted across a spread of shapes rather than one lucky fixture.
  for (const [w, h, q, side] of [[400, 300, 2, 399], [600, 400, 2, 599], [300, 200, 3, 299], [500, 500, 1, 480]]) {
    const x = imageFit.fitJpeg(noisy(w, h, q), { maxSide: side, quality: 95 });
    ok(x.bytesAfter <= x.bytesBefore, `D5:${w}x${h} the result is NEVER larger than the input`);
  }
}

// ── E. EVERY FAILURE HANDS BACK THE PHOTO, AND NOTHING THROWS ───────────────────
{
  const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
  const garbage = Buffer.from('this is definitely not an image, it is a sentence');
  const cases = [
    ['empty buffer', Buffer.alloc(0), 'empty'],
    ['null', null, 'empty'],
    ['a PNG (no decoder in this repo)', png, 'not_jpeg'],
    ['plain garbage', garbage, 'not_jpeg'],
  ];
  for (const [name, buf, reason] of cases) {
    const r = imageFit.fitJpeg(buf, { maxSide: 100 });
    eq(r.reason, reason, `E:${name} → ${reason}`);
    eq(r.changed, false, `E:${name} reports no change`);
    ok(r.buf === buf, `E:${name} hands the original back untouched`);
  }

  // A TRUNCATED JPEG is the realistic corruption — a half-written blob. It must be carried
  // through, not dropped: the report's own renderer will show a placeholder for one bad photo,
  // whereas losing the bytes here would lose it everywhere.
  const trunc = makeJpeg(900, 600, 90).slice(0, 400);
  const rt = imageFit.fitJpeg(trunc, { maxSide: 300 });
  eq(rt.changed, false, 'E:truncated reports no change');
  ok(rt.buf === trunc, 'E:truncated hands the original bytes back');

  // Fuzz: nothing in the input space may produce a throw.
  let threw = false;
  for (let i = 0; i < 200; i++) {
    const b = Buffer.alloc(i * 3);
    for (let k = 0; k < b.length; k++) b[k] = (i * 31 + k * 17) & 0xff;
    try { imageFit.fitJpeg(b, { maxSide: 64 }); } catch (_) { threw = true; }
    try { imageFit.fitJpeg(Buffer.concat([Buffer.from('ffd8ff', 'hex'), b]), { maxSide: 64 }); } catch (_) { threw = true; }
  }
  eq(threw, false, 'E:fuzz 400 malformed inputs, not one exception');
  // Undefined options must not break the defaults.
  ok(imageFit.fitJpeg(makeJpeg(50, 50, 80)).buf.length > 0, 'E:no options uses the defaults');
}

// ── F. THE SOURCE IS BOUNDED BEFORE THE DECODE ──────────────────────────────────
{
  /* A decode allocates width*height*4 bytes and an OOM kill is NOT catchable, so an absurd
     declared size must be refused from the HEADER — before any allocation. Forge one by patching
     a real JPEG's SOF dimensions to 30000x30000 (900 megapixels). */
  const real = makeJpeg(200, 150, 85);
  const forged = Buffer.from(real);
  let patched = false;
  for (let i = 2; i + 9 < forged.length; i++) {
    const m = forged[i + 1];
    if (forged[i] === 0xFF && m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      forged.writeUInt16BE(30000, i + 5); forged.writeUInt16BE(30000, i + 7); patched = true; break;
    }
  }
  ok(patched, 'F0 (fixture) found the SOF marker to patch');
  const size = imageFit.jpegSize(forged);
  eq(size.w, 30000, 'F1 the dimensions are read from the header without decoding');
  const r = imageFit.fitJpeg(forged, { maxSide: 100 });
  eq(r.reason, 'source_too_large', 'F2 an absurd source is refused BEFORE the decode');
  ok(r.buf === forged, 'F3 …and the bytes are still handed back');

  eq(imageFit.jpegSize(Buffer.from('not a jpeg')), null, 'F4 the header reader declines a non-JPEG');
  eq(imageFit.jpegSize(Buffer.alloc(0)), null, 'F5 …and an empty buffer');
  const hdr = imageFit.jpegSize(real);
  eq(hdr.w, 200, 'F6 a real header reads its width…');
  eq(hdr.h, 150, 'F7 …and its height');
}

// ── G. THE DEFAULTS ARE SIZED FOR THE PAGE THAT DRAWS THEM ──────────────────────
{
  /* The report's photo grid cell is 118pt wide (1.64in) and the biggest cell in the document is
     160pt (2.22in). At professional-print 300 DPI those need 492px and 667px. The default must
     comfortably exceed the LARGER of the two, or the change would trade a real quality loss for
     the size saving — which is exactly what the owner said not to do. */
  const BIGGEST_CELL_PT = 160;
  const need300 = Math.ceil((BIGGEST_CELL_PT / 72) * 300);
  ok(imageFit.DISPLAY_MAX_SIDE >= need300 * 2,
    `G1 the default long side (${imageFit.DISPLAY_MAX_SIDE}px) leaves at least 2x headroom over the `
    + `${need300}px that 300 DPI needs in the largest cell — so zooming into the PDF still has detail`);
  ok(imageFit.DISPLAY_QUALITY >= 75 && imageFit.DISPLAY_QUALITY <= 95,
    'G2 the JPEG quality sits in the visually-transparent band');
  ok(imageFit.MAX_SRC_MEGAPIXELS >= 40, 'G3 the source ceiling is above any real camera…');
  ok(imageFit.MAX_SRC_MEGAPIXELS <= 100, 'G4 …and still bounds the allocation');
}

console.log(`test-image-fit-pure: ${checks} checks passed`);
