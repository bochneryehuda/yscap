/* Durable inspector media — the PURE archive-planning logic (Draw Management phase 2a, 2026-07-20).
 *
 * planArchive decides what to pull into durable PILOT storage from a draw's finding lines + the draw PDF:
 * dedup vs what's already archived AND within the plan, classify image/video/draw_pdf, carry the per-item
 * metadata, and cap the run. No DB, no network. Run: node scripts/test-sitewire-media-archive.js */
const ma = require('../src/sitewire/media-archive');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => { const g = JSON.stringify(got), e = JSON.stringify(exp); if (g === e) pass++; else { fail++; console.log(`FAIL ${name}: got ${g} expected ${e}`); } };

const lines = [
  { sitewire_request_id: 10, sow_line_key: 'cat:0', inspector_comments: 'looks good',
    media: [
      { src: 'https://sw.example/photo1.jpg', thumbnail: 'https://sw.example/t1.jpg', type: 'image', lat: 41.3, lng: -72.9, captured_at: '2026-07-18T12:00:00Z', note: 'front' },
      { src: 'https://sw.example/vid1.mp4', type: 'video' },
      { src: null, type: 'image' },                       // no src → skipped
    ] },
  { sitewire_request_id: 11, sow_line_key: 'cat:1',
    media: [{ src: 'https://sw.example/photo1.jpg', type: 'image' }] }, // DUP src across lines → once
];

// ---- 1. plan: dedup within, classify, carry metadata, add the pdf ----
{
  const plan = ma.planArchive({ lines, pdfSrc: 'https://sw.example/draw.pdf', archivedKeys: new Set() });
  eq('plan length (photo1 + vid1 + pdf, dup dropped)', plan.length, 3);
  const byUrl = Object.fromEntries(plan.map((p) => [p.source_url, p]));
  ok('photo classified image', byUrl['https://sw.example/photo1.jpg'].kind === 'image');
  ok('video classified video', byUrl['https://sw.example/vid1.mp4'].kind === 'video');
  ok('pdf classified draw_pdf', byUrl['https://sw.example/draw.pdf'].kind === 'draw_pdf');
  ok('photo1 carries the FIRST line’s metadata (request 10, geo, note)',
    byUrl['https://sw.example/photo1.jpg'].sitewire_request_id === 10
    && byUrl['https://sw.example/photo1.jpg'].lat === 41.3
    && byUrl['https://sw.example/photo1.jpg'].note === 'front');
  ok('video falls back to the line inspector note', byUrl['https://sw.example/vid1.mp4'].note === undefined || byUrl['https://sw.example/vid1.mp4'].note === null ? false : true);
  ok('every item has a source_key (sha256)', plan.every((p) => typeof p.source_key === 'string' && p.source_key.length === 64));
  ok('null-src media is skipped', !plan.some((p) => p.source_url == null));
}

// ---- 2. dedup vs already-archived ----
{
  const already = new Set([ma.sha256('https://sw.example/photo1.jpg')]);
  const plan = ma.planArchive({ lines, pdfSrc: 'https://sw.example/draw.pdf', archivedKeys: already });
  ok('already-archived photo1 is NOT re-planned', !plan.some((p) => p.source_url === 'https://sw.example/photo1.jpg'));
  eq('plan is vid1 + pdf only', plan.length, 2);
}

// ---- 3. empty / missing inputs are safe ----
eq('no lines, no pdf → empty', ma.planArchive({ lines: [], pdfSrc: null, archivedKeys: new Set() }), []);
eq('undefined args → empty', ma.planArchive({}), []);

// ---- 4. cap at MAX_ITEMS ----
{
  const many = [{ sitewire_request_id: 1, media: Array.from({ length: ma.MAX_ITEMS + 25 }, (_, i) => ({ src: `https://sw.example/p${i}.jpg`, type: 'image' })) }];
  const plan = ma.planArchive({ lines: many, pdfSrc: null, archivedKeys: new Set() });
  eq('capped at MAX_ITEMS', plan.length, ma.MAX_ITEMS);
}

// ---- 5. extFor: content-type → safe extension (falls back to the URL) ----
eq('jpeg → jpg', ma.extFor('image/jpeg', 'x'), 'jpg');
eq('png → png', ma.extFor('image/png', 'x'), 'png');
eq('mp4 → mp4', ma.extFor('video/mp4', 'x'), 'mp4');
eq('pdf → pdf', ma.extFor('application/pdf', 'x'), 'pdf');
eq('unknown ct falls back to URL ext', ma.extFor('', 'https://x/y/photo.JPG?sig=1'), 'jpg');
eq('no ct, no ext → bin', ma.extFor('', 'https://x/y/noext'), 'bin');

// ---- 6. SSRF guard: private/loopback/link-local/metadata IPs are rejected; public pass ----
for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1']) {
  ok(`private IP blocked: ${ip}`, ma.isPrivateIp(ip) === true);
}
for (const ip of ['8.8.8.8', '1.1.1.1', '52.10.20.30', '172.15.0.1', '172.32.0.1', '192.167.0.1', '2600::1']) {
  ok(`public IP allowed: ${ip}`, ma.isPrivateIp(ip) === false);
}
// IPv4-mapped IPv6 must not bypass the private-IP guard (SSRF hardening) — both the
// dotted (::ffff:a.b.c.d) and hex (::ffff:hhhh:hhhh) forms.
for (const ip of ['::ffff:192.168.1.1', '::ffff:172.16.0.1', '::ffff:10.1.2.3', '::ffff:169.254.169.254', '::ffff:c0a8:0101' /* =192.168.1.1 */, '::ffff:ac10:0001' /* =172.16.0.1 */]) {
  ok(`mapped-private IPv6 blocked: ${ip}`, ma.isPrivateIp(ip) === true);
}
for (const ip of ['::ffff:8.8.8.8', '::ffff:0808:0808' /* =8.8.8.8 */]) {
  ok(`mapped-public IPv6 allowed: ${ip}`, ma.isPrivateIp(ip) === false);
}

// ---- 6b. sha256 hashes a Buffer by RAW bytes (the content-hash fix) ----
{
  const crypto = require('crypto');
  const badBuf = Buffer.from([0xff, 0xfe, 0x00, 0x41]);   // invalid UTF-8
  eq('sha256(Buffer) = raw-byte hash', ma.sha256(badBuf), crypto.createHash('sha256').update(badBuf).digest('hex'));
  ok('sha256(Buffer) != sha256(String(Buffer)) for non-utf8 bytes',
    ma.sha256(badBuf) !== crypto.createHash('sha256').update(String(badBuf)).digest('hex'));
  eq('sha256(string) still hashes as text', ma.sha256('hello'), crypto.createHash('sha256').update('hello').digest('hex'));
}

// ---- 6c. parseTermMonths handles YEAR units (the false past-maturity fix) ----
{
  const mon = require('../src/sitewire/monitor');
  eq('term "12 months" → 12', mon.parseTermMonths('12 months'), 12);
  eq('term "18 mo" → 18', mon.parseTermMonths('18 mo'), 18);
  eq('term "12" (bare → months) → 12', mon.parseTermMonths('12'), 12);
  eq('term "1 year" → 12 (was misread as 1)', mon.parseTermMonths('1 year'), 12);
  eq('term "2 yr" → 24', mon.parseTermMonths('2 yr'), 24);
  eq('term "1.5 years" → 18', mon.parseTermMonths('1.5 years'), 18);
  eq('term null → null', mon.parseTermMonths(null), null);
  eq('term "0 months" → null', mon.parseTermMonths('0 months'), null);
}

// assertPublicHttps is async; run those + the summary inside an async main.
(async () => {
  const rejects = async (name, url) => { let threw = false; try { await ma.assertPublicHttps(url); } catch (_) { threw = true; } ok(name, threw); };
  await rejects('assertPublicHttps rejects http://', 'http://example.com/x.jpg');
  await rejects('assertPublicHttps rejects https:// to a metadata IP literal', 'https://169.254.169.254/latest/meta-data/');
  await rejects('assertPublicHttps rejects a private IP literal', 'https://10.0.0.5/photo.jpg');
  await rejects('assertPublicHttps rejects a non-http(s) scheme', 'ftp://example.com/x');
  await rejects('assertPublicHttps rejects a malformed url', 'not-a-url');

  console.log(`\n${fail === 0 ? 'ALL' : fail + ' FAILED,'} ${pass} media-archive assertions ${fail === 0 ? 'passed' : ''}`);
  process.exit(fail === 0 ? 0 : 1);
})();
