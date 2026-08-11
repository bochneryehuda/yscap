/**
 * The shared dispute-evidence normalizer (src/sitewire/dispute-media.js) — the ONE definition used
 * by BOTH the borrower draw routes and the TPO/broker surface. This is the security-critical
 * sniff / strip / cap layer, so a drift between an authenticated borrower and an external broker
 * would open a hole. Pure: no DB. It DOES touch local storage (storage.save), so point STORAGE_DIR
 * at a scratch dir first.
 *
 * Proves:
 *   • sniffImageMime derives the type from the BYTES, accepting only real images and REJECTING the
 *     XSS vectors (svg / html) plus pdf / zip / unknown / a video ftyp box (never mislabeled HEIC);
 *   • normalizeDisputeMedia only ever accepts a real upload (dataBase64) — a client-supplied
 *     storage_ref is NEVER honored (it would point at someone else's file);
 *   • a non-image upload is dropped, and the per-line count is capped at EVIDENCE_MAX_PER_LINE.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

// a scratch STORAGE_DIR so storage.save writes somewhere disposable (no DB, no network)
process.env.STORAGE_DIR = process.env.STORAGE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'dm-'));

const R = path.resolve(__dirname, '..');
const dm = require(R + '/src/sitewire/dispute-media');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// ---- byte fixtures ----
const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000' +
  '01f15c4890000000d49444154789c6360000002000100ffff0300000600055773d6d40000000049454e44ae426082', 'hex');
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const gif = Buffer.from('GIF89a' + '\x01\x00\x01\x00\x00\x00\x00', 'latin1');
const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBP', 'latin1'), Buffer.alloc(4)]);
const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(8)]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42', 'latin1'), Buffer.alloc(8)]); // a VIDEO ftyp brand
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8');
const html = Buffer.from('<!DOCTYPE html><html><body>x</body></html>', 'utf8');
const pdf = Buffer.from('%PDF-1.4\n%âãÏÓ', 'latin1');
const zip = Buffer.from('PK\x03\x04', 'latin1');

(async () => {
  // ---- sniffImageMime: only real images pass; every XSS/doc vector is rejected ----
  ok(dm.sniffImageMime(png) === 'image/png', 'PNG magic → image/png');
  ok(dm.sniffImageMime(jpg) === 'image/jpeg', 'JPEG magic → image/jpeg');
  ok(dm.sniffImageMime(gif) === 'image/gif', 'GIF magic → image/gif');
  ok(dm.sniffImageMime(webp) === 'image/webp', 'RIFF/WEBP → image/webp');
  ok(dm.sniffImageMime(heic) === 'image/heic', 'HEIC still-image ftyp brand → image/heic');
  ok(dm.sniffImageMime(mp4) === null, 'a VIDEO ftyp box is NOT mislabeled a HEIC image → null');
  ok(dm.sniffImageMime(svg) === null, 'SVG is REJECTED (stored-XSS vector) → null');
  ok(dm.sniffImageMime(html) === null, 'HTML is REJECTED (stored-XSS vector) → null');
  ok(dm.sniffImageMime(pdf) === null, 'PDF is not an inline-servable image → null');
  ok(dm.sniffImageMime(zip) === null, 'ZIP → null');
  ok(dm.sniffImageMime(Buffer.alloc(0)) === null, 'empty buffer → null');
  ok(dm.sniffImageMime(Buffer.from('garbage-bytes-here')) === null, 'unknown bytes → null');

  const b64 = (b) => b.toString('base64');

  // ---- normalizeDisputeMedia: only real uploads, never a client-supplied ref ----
  ok((await dm.normalizeDisputeMedia(null)).length === 0, 'non-array → []');
  ok((await dm.normalizeDisputeMedia([])).length === 0, 'empty → []');

  // a client-supplied storage_ref with NO dataBase64 is ignored (never honored)
  const refOnly = await dm.normalizeDisputeMedia([{ storage_ref: 'someone/elses/file.png', filename: 'evil.png' }]);
  ok(refOnly.length === 0, 'a client-supplied storage_ref (no dataBase64) is NEVER honored → dropped');

  // an SVG "image" is dropped by the byte sniff even though it decodes fine
  const svgUp = await dm.normalizeDisputeMedia([{ dataBase64: b64(svg), filename: 'x.svg' }]);
  ok(svgUp.length === 0, 'an SVG upload is dropped (byte sniff), never stored');

  // a real PNG upload is stored durably under a NEW ref (not any client value), typed from the bytes
  const good = await dm.normalizeDisputeMedia([{ dataBase64: b64(png), filename: 'roof.png', storage_ref: 'attacker/ref' }]);
  ok(good.length === 1, 'a real PNG upload is accepted (1 entry)');
  ok(good[0] && good[0].storage_ref && good[0].storage_ref !== 'attacker/ref', 'the stored ref is a NEW durable ref, never the client-supplied one');
  ok(good[0] && good[0].content_type === 'image/png' && good[0].kind === 'image', 'the type is derived from the bytes (image/png, kind image)');
  ok(good[0] && !('lat' in good[0]) && !('lng' in good[0]), 'no GPS on the stored entry');

  // count cap: 10 uploads → at most EVIDENCE_MAX_PER_LINE stored
  const many = Array.from({ length: 10 }, () => ({ dataBase64: b64(png), filename: 'p.png' }));
  const capped = await dm.normalizeDisputeMedia(many);
  ok(capped.length <= dm.EVIDENCE_MAX_PER_LINE, `the per-line count is capped at ${dm.EVIDENCE_MAX_PER_LINE} (got ${capped.length})`);

  console.log(`\ntest-dispute-media-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
