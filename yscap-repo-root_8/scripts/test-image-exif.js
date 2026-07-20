'use strict';
/* EXIF GPS scrubber (audit F-3). NO DB. Run: node scripts/test-image-exif.js */
const assert = require('assert');
const { stripLocationExif } = require('../src/lib/image-exif');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

// ---- build a synthetic little-endian JPEG carrying EXIF Orientation + a GPS IFD (GPSLatitude) ----
function buildJpegWithGps() {
  // TIFF (little-endian), offsets relative to tiffStart=0
  const tiff = Buffer.alloc(80);
  tiff.write('II', 0, 'ascii'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4); // header → IFD0 @ 8
  // IFD0 @ 8: 2 entries
  tiff.writeUInt16LE(2, 8);
  // entry0: Orientation (0x0112) SHORT x1 = 6
  tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(6, 18);
  // entry1: GPS IFD pointer (0x8825) LONG x1 = 38
  tiff.writeUInt16LE(0x8825, 22); tiff.writeUInt16LE(4, 24); tiff.writeUInt32LE(1, 26); tiff.writeUInt32LE(38, 30);
  tiff.writeUInt32LE(0, 34); // IFD0 next = 0
  // GPS IFD @ 38: count(2)@38, entry(12)@40 [tag@40,type@42,count@44,valueoffset@48], next-IFD(4)@52
  tiff.writeUInt16LE(1, 38);
  tiff.writeUInt16LE(0x0002, 40); tiff.writeUInt16LE(5, 42); tiff.writeUInt32LE(3, 44); tiff.writeUInt32LE(56, 48);
  tiff.writeUInt32LE(0, 52); // GPS IFD next = 0
  // GPS latitude data @ 56: 3 rationals (40/1, 26/1, 4620/100)
  tiff.writeUInt32LE(40, 56); tiff.writeUInt32LE(1, 60);
  tiff.writeUInt32LE(26, 64); tiff.writeUInt32LE(1, 68);
  tiff.writeUInt32LE(4620, 72); tiff.writeUInt32LE(100, 76);
  // APP1 = "Exif\0\0" + TIFF
  const exifHdr = Buffer.from('Exif\0\0', 'binary');
  const app1Payload = Buffer.concat([exifHdr, tiff]);
  const app1Len = app1Payload.length + 2; // + the 2 length bytes
  const app1 = Buffer.concat([Buffer.from([0xFF, 0xE1]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(app1Len, 0); return b; })(), app1Payload]);
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), app1, Buffer.from([0xFF, 0xD9])]);
}

const jpg = buildJpegWithGps();
const out = stripLocationExif(jpg);
// absolute offsets: tiffStart = 2(SOI)+2(marker)+2(len)+6(Exif\0\0) = 12
const TIFF = 12;
assert.strictEqual(out.length, jpg.length, 'JPEG length is unchanged (surgical, in place)');
assert.notStrictEqual(out, jpg, 'a copy is returned (original untouched) when EXIF is present');
// GPS IFD count (@ tiff+38) is now 0
assert.strictEqual(out.readUInt16LE(TIFF + 38), 0, 'GPS IFD is emptied (entry count = 0)');
// the GPS latitude value bytes (@ tiff+56 .. +80) are zeroed
for (let i = TIFF + 56; i < TIFF + 80; i++) assert.strictEqual(out[i], 0, 'GPS latitude bytes zeroed @ ' + i);
// Orientation is preserved (value 6 @ tiff+18)
assert.strictEqual(out.readUInt16LE(TIFF + 18), 6, 'EXIF Orientation is preserved');
// original still has its GPS (we did not mutate it)
assert.strictEqual(jpg.readUInt16LE(TIFF + 38), 1, 'original buffer still carries its GPS IFD');
ok('JPEG: GPS IFD + latitude bytes scrubbed, orientation + length preserved, original untouched');

// A JPEG with no EXIF is returned as-is (same object).
const plainJpg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x04, 0x00, 0x00]), Buffer.from([0xFF, 0xD9])]);
assert.strictEqual(stripLocationExif(plainJpg), plainJpg, 'a JPEG with no EXIF is returned unchanged (same object)');
ok('JPEG: no-EXIF image is a no-op');

// ---- PNG: an eXIf chunk is dropped; other chunks are copied verbatim ----
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); // CRC value is irrelevant to the scrubber (it copies/removes whole chunks)
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, crc]);
}
const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const ihdr = pngChunk('IHDR', Buffer.alloc(13));
const exif = pngChunk('eXIf', Buffer.from('II*\0\0\0\0\0GPSHERE', 'binary'));
const idat = pngChunk('IDAT', Buffer.from([1, 2, 3, 4]));
const iend = pngChunk('IEND', Buffer.alloc(0));
const png = Buffer.concat([sig, ihdr, exif, idat, iend]);
const pngOut = stripLocationExif(png);
assert.ok(pngOut.length < png.length, 'PNG shrinks by the eXIf chunk');
assert.strictEqual(pngOut.indexOf(Buffer.from('eXIf', 'ascii')), -1, 'eXIf chunk removed');
assert.ok(pngOut.indexOf(Buffer.from('IHDR', 'ascii')) > 0 && pngOut.indexOf(Buffer.from('IDAT', 'ascii')) > 0 && pngOut.indexOf(Buffer.from('IEND', 'ascii')) > 0, 'IHDR/IDAT/IEND kept');
ok('PNG: eXIf chunk dropped, other chunks preserved');

const pngNoExif = Buffer.concat([sig, ihdr, idat, iend]);
assert.strictEqual(stripLocationExif(pngNoExif), pngNoExif, 'a PNG with no eXIf is returned unchanged');
ok('PNG: no-eXIf image is a no-op');

// ---- non-image / garbage passthrough, never throws ----
const rando = Buffer.from('not an image at all, just text bytes here');
assert.strictEqual(stripLocationExif(rando), rando, 'non-image buffer returned unchanged');
assert.doesNotThrow(() => stripLocationExif(null), 'null is safe');
assert.doesNotThrow(() => stripLocationExif(Buffer.alloc(3)), 'tiny buffer is safe');
assert.doesNotThrow(() => stripLocationExif(Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0xFF])), 'truncated APP1 is safe');
ok('non-image + malformed inputs pass through without throwing');

console.log(`\nAll ${n} EXIF-scrub checks passed.`);
