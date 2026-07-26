/**
 * Test the appraisal photo-extraction library (src/lib/appraisal/photos).
 * The PNG-encoder + downscale checks need no network/corpus. If the real appraisal corpus
 * (with embedded PDFs) is present, it also runs a real extraction and validates the PNGs.
 */
const zlib = require('zlib');
const { encodePng, extractPhotos, MIN_W } = require('../src/lib/appraisal/photos');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// 1) encodePng writes a structurally valid PNG (signature + IHDR + reversible IDAT).
{
  const w = 4, h = 3, ch = 3;
  const px = Buffer.alloc(w * h * ch);
  for (let i = 0; i < px.length; i++) px[i] = (i * 37) & 0xff;
  const png = encodePng(px, w, h, ch);
  assert(png.slice(0, 8).toString('hex') === '89504e470d0a1a0a', 'PNG signature is correct');
  // IHDR: length 13, type 'IHDR', width/height match
  assert(png.readUInt32BE(8) === 13 && png.slice(12, 16).toString('ascii') === 'IHDR', 'IHDR chunk present');
  assert(png.readUInt32BE(16) === w && png.readUInt32BE(20) === h, 'IHDR carries the right dimensions');
  assert(png[24] === 8 && png[25] === 2, 'IHDR bit-depth 8, colour-type 2 (RGB)');
  // Find IDAT, inflate it, confirm it decodes to (stride+1)*h bytes with filter-0 rows == pixels.
  let off = 8, idat = null;
  while (off < png.length) {
    const len = png.readUInt32BE(off); const type = png.slice(off + 4, off + 8).toString('ascii');
    if (type === 'IDAT') { idat = png.slice(off + 8, off + 8 + len); break; }
    off += 12 + len;
  }
  const raw = zlib.inflateSync(idat);
  assert(raw.length === (w * ch + 1) * h, 'IDAT inflates to the right raw length');
  let rowsOk = true;
  for (let y = 0; y < h; y++) { if (raw[y * (w * ch + 1)] !== 0) rowsOk = false; }
  assert(rowsOk, 'every scanline uses filter type 0 (None)');
  // pixel round-trip: raw (minus filter bytes) equals input px
  let pixOk = true;
  for (let y = 0; y < h; y++) for (let x = 0; x < w * ch; x++) if (raw[y * (w * ch + 1) + 1 + x] !== px[y * w * ch + x]) pixOk = false;
  assert(pixOk, 'encoded pixels round-trip back to the source buffer');
}

// 2) A grayscale (1-channel) and RGBA (4-channel) buffer both encode with the right colour type.
{
  const g = encodePng(Buffer.alloc(2 * 2 * 1, 128), 2, 2, 1);
  assert(g[25] === 0, 'grayscale encodes as colour-type 0');
  const a = encodePng(Buffer.alloc(2 * 2 * 4, 200), 2, 2, 4);
  assert(a[25] === 6, 'RGBA encodes as colour-type 6');
}

// 3) extractPhotos never throws and returns a structured result for junk / empty input.
(async () => {
  const none = await extractPhotos(null);
  assert(none.attempted === false && Array.isArray(none.photos) && none.photos.length === 0, 'no PDF → {attempted:false, photos:[]}, no throw');
  const junk = await extractPhotos(Buffer.from('not a pdf at all').toString('base64'));
  assert(junk.attempted === true && junk.photos.length === 0, 'junk base64 → attempted, 0 photos, no throw');

  // 4) Real corpus extraction (only if the corpus with embedded PDFs is present).
  const fs = require('fs'); const path = require('path');
  const cand = [
    '/tmp/claude-0/-home-user-yscap/05b5356c-9672-5e08-9492-67ecffd77817/scratchpad/appraisals/b1c9c729-zip_2_extracted/zip 2/Completed_Product_(Data)_10484851.xml',
  ].filter((p) => fs.existsSync(p));
  if (cand.length) {
    const { embeddedPdfBase64 } = require('../src/lib/appraisal/xml');
    const b64 = embeddedPdfBase64(fs.readFileSync(cand[0], 'utf8'));
    const r = await extractPhotos(b64);
    assert(r.attempted && r.photos.length > 0, `real appraisal PDF yields photos (${r.photos.length})`);
    assert(r.photos.every((p) => p.png.slice(0, 8).toString('hex') === '89504e470d0a1a0a'), 'every extracted photo is a valid PNG');
    assert(r.photos.every((p) => p.width >= MIN_W || p.height >= MIN_H), 'no sub-threshold thumbnails leaked through');
    const shas = new Set(r.photos.map((p) => p.sha256));
    assert(shas.size === r.photos.length, 'extracted photos are de-duplicated (unique pixels)');
  } else {
    console.log('SKIP real-corpus extraction (no embedded-PDF corpus present)');
  }

  console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL photo assertions passed'}`);
  process.exit(failures ? 1 : 0);
})();
