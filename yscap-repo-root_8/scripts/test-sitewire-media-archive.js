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

console.log(`\n${fail === 0 ? 'ALL' : fail + ' FAILED,'} ${pass} media-archive assertions ${fail === 0 ? 'passed' : ''}`);
process.exit(fail === 0 ? 0 : 1);
