/**
 * The one media door (src/lib/media-headers.js) — the fix for the owner-reported
 * *"the video format is not readable in our system … those videos are blacked
 * out."*  PURE: no database, no network, no storage.
 *
 * Proves:
 *   • the type is derived from the BYTES when the stored label was lost on the
 *     way in (a pre-signed CDN routinely archives a good .mov as
 *     `application/octet-stream`, which the allowlist then refused to serve
 *     inline — the video downloaded instead of playing);
 *   • a QuickTime .mov and an MP4 are told apart by their ftyp BRAND, and a HEIC
 *     still image is never mistaken for either (they share the same box);
 *   • the sniff CANNOT widen the allowlist: svg / html / pdf / zip / unknown all
 *     stay `application/octet-stream` + `attachment`, which is the stored-XSS
 *     guard (audit H1) and must survive this change intact;
 *   • a stored type that IS safe still wins over the sniff (it is more specific);
 *   • Range parsing is correct for every form a <video> actually sends —
 *     open-ended, closed, suffix, past-the-end, and unsatisfiable — because a
 *     wrong byte range is a corrupt stream, not a slow one;
 *   • serveMedia answers 206 with a correct Content-Range and the right slice,
 *     416 for an unsatisfiable range, and 200 with Accept-Ranges otherwise.
 */
const path = require('path');
const R = path.resolve(__dirname, '..');
const mh = require(R + '/src/lib/media-headers');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// ---- byte fixtures ---------------------------------------------------------
const ftyp = (brand) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp' + brand, 'latin1'), Buffer.alloc(8)]);
const png = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(8)]);
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12)]);
const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(12)]);
const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBP', 'latin1'), Buffer.alloc(8)]);
const mov = ftyp('qt  ');
const mp4 = ftyp('mp42');
const isom = ftyp('isom');
const heic = ftyp('heic');
const movBare = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('moov', 'latin1'), Buffer.alloc(12)]);
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(12)]);
const ogg = Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(12)]);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8');
const html = Buffer.from('<!DOCTYPE html><html><body>x</body></html>', 'utf8');
const pdf = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3 padding', 'latin1');
const zip = Buffer.from('PK\x03\x04 padding here', 'latin1');

// ---- the sniff -------------------------------------------------------------
ok(mh.sniffMediaMime(png) === 'image/png', 'PNG magic → image/png');
ok(mh.sniffMediaMime(jpg) === 'image/jpeg', 'JPEG magic → image/jpeg');
ok(mh.sniffMediaMime(gif) === 'image/gif', 'GIF magic → image/gif');
ok(mh.sniffMediaMime(webp) === 'image/webp', 'RIFF/WEBP → image/webp');
ok(mh.sniffMediaMime(mov) === 'video/quicktime', 'ftyp brand "qt  " → video/quicktime (an iPhone .mov)');
ok(mh.sniffMediaMime(mp4) === 'video/mp4', 'ftyp brand "mp42" → video/mp4');
ok(mh.sniffMediaMime(isom) === 'video/mp4', 'ftyp brand "isom" → video/mp4');
ok(mh.sniffMediaMime(heic) === 'image/heic', 'ftyp brand "heic" is a STILL IMAGE, never a video');
ok(mh.sniffMediaMime(movBare) === 'video/quicktime', 'a bare moov atom → video/quicktime');
ok(mh.sniffMediaMime(webm) === 'video/webm', 'EBML magic → video/webm');
ok(mh.sniffMediaMime(ogg) === 'video/ogg', 'OggS → video/ogg');

// THE GUARD THAT MUST SURVIVE: the sniff can never invent a servable type.
ok(mh.sniffMediaMime(svg) === null, 'SVG sniffs to null (stored-XSS vector, audit H1)');
ok(mh.sniffMediaMime(html) === null, 'HTML sniffs to null (stored-XSS vector)');
ok(mh.sniffMediaMime(pdf) === null, 'PDF is not inline-servable media → null');
ok(mh.sniffMediaMime(zip) === null, 'ZIP → null');
ok(mh.sniffMediaMime(Buffer.alloc(0)) === null, 'empty buffer → null, no throw');
ok(mh.sniffMediaMime(Buffer.from('garbage')) === null, 'unknown short bytes → null, no throw');
ok(mh.sniffMediaMime(null) === null, 'null → null, no throw');

// ---- resolveMediaType ------------------------------------------------------
// THE DEFECT, EXACTLY: a good video archived under the CDN's generic label.
let r = mh.resolveMediaType('application/octet-stream', mov);
ok(r.type === 'video/quicktime' && r.inline === true,
  'a .mov stored as application/octet-stream is served inline as video/quicktime');
r = mh.resolveMediaType('', mp4);
ok(r.type === 'video/mp4' && r.inline === true, 'a missing stored type falls through to the bytes');
r = mh.resolveMediaType(null, jpg);
ok(r.type === 'image/jpeg' && r.inline === true, 'the same rescue applies to photos (the 2026-08-10 defect)');
// A safe stored type is more specific than a sniff, so it wins.
r = mh.resolveMediaType('video/webm', webm);
ok(r.type === 'video/webm' && r.inline === true, 'a stored type already on the allowlist is kept');
r = mh.resolveMediaType('image/png; charset=binary', png);
ok(r.type === 'image/png', 'a stored type with parameters is normalized, not rejected');
// And the dangerous ones stay attachments no matter what is claimed.
r = mh.resolveMediaType('image/svg+xml', svg);
ok(r.type === 'application/octet-stream' && r.inline === false,
  'a claimed image/svg+xml is STILL forced to an attachment');
r = mh.resolveMediaType('text/html', html);
ok(r.type === 'application/octet-stream' && r.inline === false, 'a claimed text/html is STILL forced to an attachment');
r = mh.resolveMediaType('video/mp4', svg);
ok(r.type === 'video/mp4' && r.inline === true,
  'a stored allowlisted type is trusted (it is set by us at intake, not by the client)');

// ---- Range parsing ---------------------------------------------------------
ok(mh.parseRange(undefined, 1000) === null, 'no Range header → null (serve the whole body)');
ok(mh.parseRange('', 1000) === null, 'an empty Range → null');
ok(mh.parseRange('bytes=0-', 1000) && mh.parseRange('bytes=0-', 1000).start === 0
  && mh.parseRange('bytes=0-', 1000).end === 999, 'bytes=0- → the whole file as a 206 (what <video> opens with)');
let rr = mh.parseRange('bytes=100-199', 1000);
ok(rr.start === 100 && rr.end === 199, 'a closed range is honoured exactly');
rr = mh.parseRange('bytes=-200', 1000);
ok(rr.start === 800 && rr.end === 999, 'a suffix range (bytes=-200) is the LAST 200 bytes');
rr = mh.parseRange('bytes=900-5000', 1000);
ok(rr.start === 900 && rr.end === 999, 'an end past the file is clamped, not refused');
ok(mh.parseRange('bytes=2000-', 1000) === 'unsatisfiable', 'a start past the file is unsatisfiable (416, never a silent 200)');
ok(mh.parseRange('bytes=-0', 1000) === 'unsatisfiable', 'a zero-length suffix is unsatisfiable');
ok(mh.parseRange('bytes=0-10,20-30', 1000) === null, 'a multi-range request falls back to the full body (legal)');
ok(mh.parseRange('nonsense', 1000) === null, 'an unparseable Range is ignored, not fatal');

// ---- serveMedia ------------------------------------------------------------
function fakeRes() {
  const h = {};
  return {
    headers: h, statusCode: 200, body: null,
    setHeader(k, v) { h[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    end(b) { this.body = b; return this; },
  };
}
const body = Buffer.alloc(1000);
for (let i = 0; i < 1000; i++) body[i] = i % 251;
const vid = Buffer.concat([mp4, body]).subarray(0, 1000);

let res = fakeRes();
mh.serveMedia({ headers: {} }, res, vid, 'application/octet-stream');
ok(res.statusCode === 200, 'no Range → 200');
ok(res.headers['content-type'] === 'video/mp4', 'the rescued type is on the response');
ok(res.headers['accept-ranges'] === 'bytes', 'Accept-Ranges is advertised — without it a <video> cannot seek');
ok(res.headers['content-length'] === '1000', 'Content-Length is the whole body');
ok(res.headers['content-disposition'] === 'inline', 'a real video is served inline, not downloaded');
ok(/sandbox/.test(res.headers['content-security-policy'] || ''), 'the sandbox CSP is still applied');
ok(res.headers['x-content-type-options'] === 'nosniff', 'nosniff is still applied');

res = fakeRes();
mh.serveMedia({ headers: { range: 'bytes=100-199' } }, res, vid, 'video/mp4');
ok(res.statusCode === 206, 'a Range request is answered 206 Partial Content');
ok(res.headers['content-range'] === 'bytes 100-199/1000', 'Content-Range names the exact slice and the total');
ok(res.headers['content-length'] === '100', 'Content-Length is the SLICE length, not the file length');
ok(res.body.length === 100 && res.body[0] === vid[100] && res.body[99] === vid[199],
  'the bytes returned are exactly the requested slice');

res = fakeRes();
mh.serveMedia({ headers: { range: 'bytes=5000-' } }, res, vid, 'video/mp4');
ok(res.statusCode === 416, 'an unsatisfiable range is 416, never a silent full body');
ok(res.headers['content-range'] === 'bytes */1000', '416 states the real size so the client can recover');

res = fakeRes();
mh.serveMedia({ headers: {} }, res, svg, 'image/svg+xml');
ok(res.headers['content-disposition'] === 'attachment' && res.headers['content-type'] === 'application/octet-stream',
  'range support did NOT weaken the attachment rule for a dangerous type');

console.log(`\ntest-media-serve-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
