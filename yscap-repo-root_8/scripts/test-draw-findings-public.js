'use strict';
/**
 * Public (token) draw-findings flow — accept, push-back (dispute), durable media serving, and
 * report availability, all with NO login (the reply_token is the capability). DB-gated: skips
 * cleanly when DATABASE_URL is unset (mirrors the other DB tests in npm test).
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-draw-findings-public (no DATABASE_URL)'); process.exit(0); }
process.env.SITEWIRE_ENABLED = process.env.SITEWIRE_ENABLED || '1';
const db = require('../src/db');
const app = require('../src/server');
const crypto = require('crypto');
let server, base, PASS = 0, FAIL = 0;
const R = Math.floor(Math.random() * 900000) + 100000;
const D1 = 700000 + R, D2 = 800000 + R;
function ok(c, m) { if (c) { PASS++; console.log('  ok -', m); } else { FAIL++; console.log('  FAIL -', m); } }
async function j(method, path, body) {
  const r = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, body: d };
}
(async () => {
  const appIds = [];
  try {
    const b = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Test','Borrower',$1) RETURNING id`, [`tbpub${R}@example.com`])).rows[0];
    const a = (await db.query(`INSERT INTO applications (borrower_id,status,property_address) VALUES ($1,'funded','{"oneLine":"9 Test St"}') RETURNING id`, [b.id])).rows[0];
    appIds.push(a.id);
    const token = crypto.randomBytes(24).toString('hex');
    const f = (await db.query(`INSERT INTO draw_findings (application_id,sitewire_draw_id,status,total_requested_cents,total_approved_cents,reply_token,delivered_at,updated_at) VALUES ($1,$2,'delivered',600000,500000,$3,now(),now()) RETURNING id`, [a.id, D1, token])).rows[0];
    const l1 = (await db.query(`INSERT INTO draw_finding_lines (finding_id,sitewire_request_id,name,requested_cents,approved_cents,not_approved_cents,inspector_comments,photo_count,video_count) VALUES ($1,7001,'Kitchen — BlueLake note',300000,300000,0,'Looks complete',2,0) RETURNING id`, [f.id])).rows[0];
    const l2 = (await db.query(`INSERT INTO draw_finding_lines (finding_id,sitewire_request_id,name,requested_cents,approved_cents,not_approved_cents,inspector_comments,photo_count,video_count) VALUES ($1,7002,'Roof',300000,200000,100000,'Partial',1,0) RETURNING id`, [f.id])).rows[0];
    const md = (await db.query(`INSERT INTO draw_media (application_id,sitewire_draw_id,sitewire_request_id,kind,source_url,source_key,storage_ref,content_type,bytes) VALUES ($1,$2,7001,'image','https://x/p.jpg','k${R}','ref-missing','image/jpeg',10) RETURNING id`, [a.id, D1])).rows[0];

    server = app.listen(0); await new Promise((r) => server.once('listening', r));
    base = 'http://127.0.0.1:' + server.address().port;

    let r = await j('GET', `/api/public/draw-findings/${token}`);
    ok(r.status === 200, 'GET summary 200');
    ok(r.body && r.body.lines && r.body.lines.length === 2, 'returns 2 lines');
    ok(r.body.lines.every((l) => !/BlueLake/i.test(l.name || '')), 'capital-partner name scrubbed');
    ok(r.body.lines[0].media && r.body.lines[0].media[0] && /\/media\//.test(r.body.lines[0].media[0].url), 'line has token-scoped media url');
    ok(r.body.report_ready === true, 'report_ready true');
    ok(Number(r.body.wire_turnaround_hours) > 0, 'wire hours present');

    r = await j('POST', `/api/public/draw-findings/${token}/dispute`, { lines: [{ line_id: l2.id, desired_cents: 280000, note: 'work done' }] });
    ok(r.status === 200 && r.body.disputed_lines === 1, 'public dispute accepted 1 line');
    let st = (await db.query(`SELECT status,disputed_via FROM draw_findings WHERE id=$1`, [f.id])).rows[0];
    ok(st.status === 'disputed' && st.disputed_via === 'email', 'finding disputed via email');
    r = await j('POST', `/api/public/draw-findings/${token}/accept`, {});
    ok(r.status === 409, 'accept after dispute → 409');

    const token2 = crypto.randomBytes(24).toString('hex');
    const f2 = (await db.query(`INSERT INTO draw_findings (application_id,sitewire_draw_id,status,total_requested_cents,total_approved_cents,reply_token,delivered_at,updated_at) VALUES ($1,$2,'delivered',100000,100000,$3,now(),now()) RETURNING id`, [a.id, D2, token2])).rows[0];
    await db.query(`INSERT INTO draw_finding_lines (finding_id,sitewire_request_id,name,requested_cents,approved_cents,not_approved_cents) VALUES ($1,7003,'Paint',100000,100000,0)`, [f2.id]);
    r = await j('POST', `/api/public/draw-findings/${token2}/accept`, {});
    ok(r.status === 200 && r.body.wire_due_at, 'public accept → 200 with wire_due_at');
    st = (await db.query(`SELECT status,accepted_via FROM draw_findings WHERE id=$1`, [f2.id])).rows[0];
    ok(st.status === 'accepted' && st.accepted_via === 'email', 'finding accepted via email');

    r = await fetch(base + `/api/public/draw-findings/${token}/media/${md.id}`);
    ok(r.status === 404, 'media with missing bytes → 404 (no crash)');
    r = await j('GET', `/api/public/draw-findings/zzzz`);
    ok(r.status === 404, 'malformed token → 404');
    r = await j('POST', `/api/public/draw-findings/${token2}/dispute`, { lines: [{ line_id: l1.id, desired_cents: 1, note: 'x' }] });
    ok(r.status === 409 || r.status === 400, 'dispute after accept blocked (' + r.status + ')');

    console.log(`\n${PASS} passed, ${FAIL} failed`);
  } catch (e) { console.error('THREW', e && e.message); FAIL++; }
  finally {
    try { for (const id of appIds) { await db.query(`DELETE FROM draw_media WHERE application_id=$1`, [id]); await db.query(`DELETE FROM draw_findings WHERE application_id=$1`, [id]); const bb = (await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [id])).rows[0]; await db.query(`DELETE FROM applications WHERE id=$1`, [id]); if (bb) await db.query(`DELETE FROM borrowers WHERE id=$1`, [bb.borrower_id]); } } catch (_) {}
    if (server) server.close(); try { await db.pool.end(); } catch (_) {}
    if (FAIL) process.exit(1);
  }
})();
