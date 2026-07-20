/* Borrower draw experience — closed dispute loop + the borrower's own branded report (Draw Management #80).
 *
 * Covers the three #80 additions:
 *   1. the 'draw_dispute_resolved' notify type is registered in all THREE notify maps (KICKER_OF /
 *      CATEGORY_OF / BORROWER_MAJOR_EMAIL) so the closing-the-loop email actually reaches the borrower;
 *   2. the borrower's OWN report is always borrower-safe — loadReportMeta(mode:'borrower') + buildDrawReport
 *      scrub the partner name, strip GPS, and drop fee/net; storeDrawReport files it visibility='borrower';
 *   3. resolving the last disputed line fires a borrower-safe 'draw_dispute_resolved' notification (per-line
 *      outcome, in-app row created) via notify.notifyAppBorrowers.
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-sitewire-borrower-draw.js
 */
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

// ---- 1. notify-map registration (pure — read the source, assert all three maps carry the new type) ----
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'notify.js'), 'utf8');
  const inBlock = (re, needle) => { const m = re.exec(src); return m && m[0].includes(needle); };
  ok('KICKER_OF has draw_dispute_resolved', inBlock(/const KICKER_OF = \{[\s\S]*?\};/, 'draw_dispute_resolved'));
  ok('CATEGORY_OF has draw_dispute_resolved', inBlock(/const CATEGORY_OF = \{[\s\S]*?\};/, 'draw_dispute_resolved'));
  ok('BORROWER_MAJOR_EMAIL has draw_dispute_resolved', inBlock(/const BORROWER_MAJOR_EMAIL = new Set\(\[[\s\S]*?\]\);/, 'draw_dispute_resolved'));
}

if (!process.env.DATABASE_URL) {
  console.log(`\n(part 1 only — no DATABASE_URL) ${pass} passed`);
  console.log('SKIP test-sitewire-borrower-draw DB parts (no DATABASE_URL)');
  process.exit(fail === 0 ? 0 : 1);
}

const db = require('../src/db');
const drawReport = require('../src/sitewire/draw-report');
const notify = require('../src/lib/notify');
const crypto = require('crypto');
const zlib = require('zlib');
function crc32(b) { let c = ~0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++)c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; }
function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const T = Buffer.from(t); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([T, d]))); return Buffer.concat([l, T, d, c]); }
function png() { const W = 6, H = 6; const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 6; const raw = Buffer.alloc((W * 4 + 1) * H); return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }

(async () => {
  const email = 'bd' + crypto.randomBytes(5).toString('hex') + '@example.com';
  const bor = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('B','D',$1) RETURNING id`, [email])).rows[0].id;
  const loan = 'BD' + crypto.randomBytes(3).toString('hex');
  const app = (await db.query(`INSERT INTO applications(borrower_id,status,ys_loan_number,property_address) VALUES($1,'funded',$2,'{"oneLine":"7 Test St","city":"Lakewood","state":"NJ","zip":"08701"}') RETURNING id`, [bor, loan])).rows[0].id;
  const DRAW = Number('66' + crypto.randomBytes(2).readUInt16BE(0));
  await db.query(`INSERT INTO sitewire_property_links(application_id,sitewire_property_id,matched_by,state,pushed_at) VALUES($1,$2,'created','live',now())`, [app, DRAW + 1]);
  await db.query(`INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status,total_requested_cents,total_approved_cents) VALUES($1,$2,1,'approved',2000000,1600000)`, [app, DRAW]);
  await db.query(`INSERT INTO sitewire_job_item_links(application_id,sitewire_budget_id,sow_line_key,section_token,sitewire_job_item_id,name,budgeted_cents,state) VALUES($1,1,'cat:0','all',7001,'Kitchen',5000000,'live')`, [app]);
  await db.query(`INSERT INTO sitewire_draw_requests(sitewire_draw_id,sitewire_request_id,sitewire_job_item_id,job_item_name,requested_cents,approved_cents) VALUES($1,8001,7001,'Kitchen',2000000,1600000)`, [DRAW]);
  const fid = (await db.query(`INSERT INTO draw_findings(application_id,sitewire_draw_id,status,total_requested_cents,total_approved_cents) VALUES($1,$2,'disputed',2000000,1600000) RETURNING id`, [app, DRAW])).rows[0].id;
  // a line whose dispute was DECIDED (approved) + a capital-partner name planted in the inspector note
  await db.query(`INSERT INTO draw_finding_lines(finding_id,sitewire_request_id,sitewire_job_item_id,sow_line_key,name,requested_cents,approved_cents,not_approved_cents,inspector_comments,dispute_status,dispute_desired_cents)
     VALUES($1,8001,7001,'cat:0','Kitchen — cabinets',2000000,1900000,100000,'Fidelis approved on review.','approved',1900000)`, [fid]);
  // durable image with GPS
  const img = png(); const storage = require('../src/lib/storage'); const saved = await storage.save(img, { filename: 'p.png' });
  const url = 'https://sw.example/bd-' + DRAW + '.png';
  await db.query(`INSERT INTO draw_media(application_id,sitewire_draw_id,sitewire_request_id,sow_line_key,kind,source_url,source_key,storage_provider,storage_ref,content_type,bytes,sha256,lat,lng)
     VALUES($1,$2,8001,'cat:0','image',$3,$4,$5,$6,'image/png',$7,$8,40.09,-74.21)`,
    [app, DRAW, url, crypto.createHash('sha256').update(url).digest('hex'), saved.provider, saved.ref, img.length, crypto.createHash('sha256').update(img).digest('hex')]);

  // ---- 2. borrower report is borrower-safe ----
  const meta = await drawReport.loadReportMeta(app, { sitewireDrawId: DRAW, mode: 'borrower' });
  ok('borrower report meta loads', !!meta && meta.hasScope);
  ok('borrower caption strips GPS', !/40\.09/.test((meta.sections[0].lines[0].photos[0] || {}).caption || ''));
  await drawReport.attachPhotoBytes(meta.sections);
  const bytes = drawReport.buildDrawReport({ app: meta.app, rollup: meta.rollup, sections: meta.sections, scope: 'draw', mode: 'borrower' });
  const text = bytes.toString('latin1');
  ok('borrower report is a PDF', bytes.slice(0, 5).toString('latin1') === '%PDF-');
  ok('borrower report scrubs the partner name', !text.includes('Fidelis'));
  ok('borrower report has NO fee/net labels', !text.includes('Net release') && !text.includes('Draw fee'));
  const fn = drawReport.reportFilename({ scope: 'draw', mode: 'borrower', drawNumber: 1, version: meta.version, loanNo: loan });
  const docId = await drawReport.storeDrawReport({ appId: app, borrowerId: bor, filename: fn, bytes, mode: 'borrower' });
  const doc = (await db.query(`SELECT visibility, doc_kind FROM documents WHERE id=$1`, [docId])).rows[0];
  ok('stored borrower report visibility=borrower', doc.visibility === 'borrower' && doc.doc_kind === 'draw_inspection_report');

  // ---- 3. closed-loop notification: the decide-route meta query + notifyAppBorrowers ----
  // (mirror the route: resolve the finding, build the borrower-safe per-line meta, notify)
  await db.query(`UPDATE draw_findings SET status='resolved', resolved_at=now() WHERE id=$1`, [fid]);
  const decided = (await db.query(`SELECT name, dispute_status, approved_cents FROM draw_finding_lines WHERE finding_id=$1 AND dispute_status IN ('approved','rejected') ORDER BY id`, [fid])).rows;
  ok('closed-loop query finds the decided line', decided.length === 1 && decided[0].dispute_status === 'approved');
  const usd = (c) => '$' + (Math.round(Number(c) || 0) / 100).toLocaleString('en-US');
  const meta2 = decided.map((l) => ({ label: l.name, value: `Approved — now ${usd(l.approved_cents)}` }));
  ok('borrower-safe outcome meta built', meta2[0].value === 'Approved — now $19,000' && !/Fidelis/.test(JSON.stringify(meta2)));
  const before = Number((await db.query(`SELECT count(*)::int c FROM notifications WHERE borrower_id=$1 AND type='draw_dispute_resolved'`, [bor])).rows[0].c);
  await notify.notifyAppBorrowers(app, { type: 'draw_dispute_resolved', title: 'We reviewed your draw dispute', badge: { text: 'Reviewed', tone: 'positive' }, body: 'We reviewed the item(s) you flagged.', meta: meta2, applicationId: app, link: `/app/${app}` });
  const after = Number((await db.query(`SELECT count(*)::int c FROM notifications WHERE borrower_id=$1 AND type='draw_dispute_resolved'`, [bor])).rows[0].c);
  ok('draw_dispute_resolved notification row created for the borrower', after === before + 1);

  console.log(`\n${fail === 0 ? 'ALL' : fail + ' FAILED,'} ${pass} borrower-draw assertions ${fail === 0 ? 'passed' : ''}`);
  await db.query(`DELETE FROM applications WHERE id=$1`, [app]); await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
