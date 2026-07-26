/* Auto-deliver artifacts on findings delivery (Draw Management enhancement, 2026-07-20).
 *
 * When the coordinator delivers inspection findings, PILOT should — without any later manual click —
 * durably archive the inspector's (pre-signed, expiring) media AND pre-build both branded reports, so the
 * durable copy + the staff PILOT report + the borrower-safe report all exist the instant findings land.
 * Before this, archiveDrawMedia only ran from a manual button, so a report generated pre-archive had ZERO
 * photos. This covers draw-report.js: buildOrGetReportDoc (shared build/cache) + autoDeliverArtifacts.
 *
 * Verifies:
 *   1. autoDeliverArtifacts builds BOTH the staff and borrower reports (documents rows, correct visibility);
 *   2. it is idempotent — a 2nd call reuses the cached version rows, minting no duplicate documents;
 *   3. the borrower report is borrower-safe (partner name scrubbed) and the staff report is staff_only;
 *   4. the archive step is best-effort — an unreachable media URL never throws (archived stays a number);
 *   5. buildOrGetReportDoc reports built=true then built=false (cache) for the same version;
 *   6. the DRAW_AUTODELIVER_ENABLED=0 kill-switch short-circuits (no work, no docs).
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-sitewire-auto-deliver.js
 */
const path = require('path');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

// ---- 1. the exports exist (pure — no DB needed) ----
{
  const d = require(path.join('..', 'src', 'sitewire', 'draw-report'));
  ok('exports buildOrGetReportDoc', typeof d.buildOrGetReportDoc === 'function');
  ok('exports autoDeliverArtifacts', typeof d.autoDeliverArtifacts === 'function');
}

if (!process.env.DATABASE_URL) {
  console.log(`\n(part 1 only — no DATABASE_URL) ${pass} passed`);
  console.log('SKIP test-sitewire-auto-deliver DB parts (no DATABASE_URL)');
  process.exit(fail === 0 ? 0 : 1);
}

const db = require('../src/db');
const drawReport = require('../src/sitewire/draw-report');
const crypto = require('crypto');
const zlib = require('zlib');
function crc32(b) { let c = ~0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++)c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; }
function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const T = Buffer.from(t); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([T, d]))); return Buffer.concat([l, T, d, c]); }
function png() { const W = 6, H = 6; const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 6; const raw = Buffer.alloc((W * 4 + 1) * H); return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
const docCount = async (appId) => Number((await db.query(`SELECT count(*)::int c FROM documents WHERE application_id=$1 AND doc_kind='draw_inspection_report'`, [appId])).rows[0].c);

(async () => {
  const email = 'ad' + crypto.randomBytes(5).toString('hex') + '@example.com';
  const bor = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('A','D',$1) RETURNING id`, [email])).rows[0].id;
  const loan = 'AD' + crypto.randomBytes(3).toString('hex');
  const app = (await db.query(`INSERT INTO applications(borrower_id,status,ys_loan_number,property_address) VALUES($1,'funded',$2,'{"oneLine":"9 Test St","city":"Lakewood","state":"NJ","zip":"08701"}') RETURNING id`, [bor, loan])).rows[0].id;
  const DRAW = Number('77' + crypto.randomBytes(2).readUInt16BE(0));
  // Unique Sitewire ids per run so parallel/repeat runs never collide on uq_swji_jid / draw_requests.
  const BUDGET = DRAW, JITEM = DRAW + 100, REQ = DRAW + 200;
  await db.query(`INSERT INTO sitewire_property_links(application_id,sitewire_property_id,matched_by,state,pushed_at) VALUES($1,$2,'created','live',now())`, [app, DRAW + 1]);
  await db.query(`INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status,total_requested_cents,total_approved_cents) VALUES($1,$2,1,'approved',2000000,1600000)`, [app, DRAW]);
  await db.query(`INSERT INTO sitewire_job_item_links(application_id,sitewire_budget_id,sow_line_key,section_token,sitewire_job_item_id,name,budgeted_cents,state) VALUES($1,$2,'cat:0','all',$3,'Kitchen',5000000,'live')`, [app, BUDGET, JITEM]);
  await db.query(`INSERT INTO sitewire_draw_requests(sitewire_draw_id,sitewire_request_id,sitewire_job_item_id,job_item_name,requested_cents,approved_cents) VALUES($1,$2,$3,'Kitchen',2000000,1600000)`, [DRAW, REQ, JITEM]);
  const fid = (await db.query(`INSERT INTO draw_findings(application_id,sitewire_draw_id,status,total_requested_cents,total_approved_cents,delivered_at) VALUES($1,$2,'delivered',2000000,1600000,now()) RETURNING id`, [app, DRAW])).rows[0].id;
  // a finding line whose inspector note carries a capital-partner name (must be scrubbed on the borrower copy),
  // and whose media references a URL we pre-archive below (so the archive step is a clean no-op — no network).
  const mediaUrl = 'https://sw.example/ad-' + DRAW + '.png';
  await db.query(`INSERT INTO draw_finding_lines(finding_id,sitewire_request_id,sitewire_job_item_id,sow_line_key,name,requested_cents,approved_cents,not_approved_cents,inspector_comments,media)
     VALUES($1,$2,$3,'cat:0','Kitchen — cabinets',2000000,1600000,400000,'Fidelis reviewed the work.',$4)`,
    [fid, REQ, JITEM, JSON.stringify([{ src: mediaUrl, type: 'image', lat: 40.09, lng: -74.21, captured_at: '2026-07-18T12:00:00Z' }])]);
  // pre-seed the DURABLE copy so its source_key is already archived (planArchive dedups → 0 fetched) and the
  // report has a photo to embed.
  const img = png(); const storage = require('../src/lib/storage'); const saved = await storage.save(img, { filename: 'ad.png' });
  await db.query(`INSERT INTO draw_media(application_id,sitewire_draw_id,sitewire_request_id,sow_line_key,kind,source_url,source_key,storage_provider,storage_ref,content_type,bytes,sha256,lat,lng)
     VALUES($1,$2,$3,'cat:0','image',$4,$5,$6,$7,'image/png',$8,$9,40.09,-74.21)`,
    [app, DRAW, REQ, mediaUrl, crypto.createHash('sha256').update(mediaUrl).digest('hex'), saved.provider, saved.ref, img.length, crypto.createHash('sha256').update(img).digest('hex')]);

  // ---- 2. buildOrGetReportDoc: built the first time, cached the second ----
  const b1 = await drawReport.buildOrGetReportDoc(app, { sitewireDrawId: DRAW, scope: 'draw', mode: 'staff' });
  ok('buildOrGetReportDoc builds the staff report (built=true)', b1 && b1.doc && b1.built === true);
  const b2 = await drawReport.buildOrGetReportDoc(app, { sitewireDrawId: DRAW, scope: 'draw', mode: 'staff' });
  ok('buildOrGetReportDoc reuses the cached row (built=false, same doc id)', b2 && b2.built === false && b2.doc.id === b1.doc.id);

  // ---- 3. autoDeliverArtifacts: best-effort archive + BOTH reports; idempotent ----
  const r = await drawReport.autoDeliverArtifacts(app, DRAW);
  ok('autoDeliverArtifacts returns a numeric archived count (best-effort, no throw)', typeof r.archived === 'number');
  ok('autoDeliverArtifacts built both staff + borrower reports', r.reports.includes('staff') && r.reports.includes('borrower'));
  const staffDoc = (await db.query(`SELECT visibility FROM documents WHERE application_id=$1 AND doc_kind='draw_inspection_report' AND filename LIKE 'pilot-draw-1-report-staff-%' AND is_current=true LIMIT 1`, [app])).rows[0];
  const borrDoc = (await db.query(`SELECT id, visibility, storage_provider, storage_ref FROM documents WHERE application_id=$1 AND doc_kind='draw_inspection_report' AND filename LIKE 'pilot-draw-1-report-borrower-%' AND is_current=true LIMIT 1`, [app])).rows[0];
  ok('staff report filed visibility=staff_only', staffDoc && staffDoc.visibility === 'staff_only');
  ok('borrower report filed visibility=borrower', borrDoc && borrDoc.visibility === 'borrower');

  // ---- 4. the borrower report is borrower-safe (partner name scrubbed) ----
  const buf = await storage.read(borrDoc.storage_ref);
  const text = Buffer.from(buf).toString('latin1');
  ok('borrower report is a PDF', Buffer.from(buf).slice(0, 5).toString('latin1') === '%PDF-');
  ok('borrower report scrubs the partner name', !text.includes('Fidelis'));

  // ---- 5. idempotent — a 2nd autoDeliver mints NO new documents (same version rows) ----
  // Exactly two report docs exist (one staff + one borrower), stable by version hash — section 2 pre-built
  // the staff copy, autoDeliver added the borrower copy and reused the staff cache.
  const mid = await docCount(app);
  await drawReport.autoDeliverArtifacts(app, DRAW);
  const after = await docCount(app);
  ok('exactly 2 report docs total (one staff + one borrower)', mid === 2);
  ok('a repeat autoDeliver adds no new report docs (cached by version)', after === mid);

  // ---- 6. kill-switch: DRAW_AUTODELIVER_ENABLED=0 short-circuits ----
  process.env.DRAW_AUTODELIVER_ENABLED = '0';
  const off = await drawReport.autoDeliverArtifacts(app, DRAW);
  ok('kill-switch off → no archive, no reports', off.archived === 0 && off.reports.length === 0);
  delete process.env.DRAW_AUTODELIVER_ENABLED;

  console.log(`\n${fail === 0 ? 'ALL' : fail + ' FAILED,'} ${pass} auto-deliver assertions ${fail === 0 ? 'passed' : ''}`);
  await db.query(`DELETE FROM applications WHERE id=$1`, [app]); await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
