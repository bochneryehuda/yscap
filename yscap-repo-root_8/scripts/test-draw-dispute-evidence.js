'use strict';
/**
 * Borrower dispute photo-evidence loop: borrower uploads photos when pushing back on a draw line →
 * PILOT stores DURABLE copies (GPS-stripped) → the staff finding-detail exposes safe descriptors
 * (never the raw storage_ref) → the guarded staff serving route streams the bytes. DB-gated skip.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-draw-dispute-evidence (no DATABASE_URL)'); process.exit(0); }
process.env.SITEWIRE_ENABLED = process.env.SITEWIRE_ENABLED || '1';
const db = require('../src/db');
const app = require('../src/server');
const C = require('../src/lib/crypto');
let server, base, P = 0, F = 0;
const R = Math.floor(Math.random() * 900000) + 100000, DR = 900000 + R;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64').toString('base64');
function ok(c, m) { c ? (P++, console.log('  ok -', m)) : (F++, console.log('  FAIL -', m)); }
async function jf(method, path, tok, body) { const r = await fetch(base + path, { method, headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); let d = null; try { d = await r.json(); } catch (_) {} return { status: r.status, body: d }; }
(async () => {
  const ids = []; const staffEmails = [];
  try {
    const b = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Ev','Test',$1) RETURNING id`, [`ev${R}@e.com`])).rows[0];
    await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0)`, [b.id]);
    const a = (await db.query(`INSERT INTO applications (borrower_id,status,property_address) VALUES ($1,'funded','{"oneLine":"1 Ev St"}') RETURNING id`, [b.id])).rows[0]; ids.push(a.id);
    const f = (await db.query(`INSERT INTO draw_findings (application_id,sitewire_draw_id,status,total_requested_cents,total_approved_cents,delivered_at,updated_at) VALUES ($1,$2,'delivered',100000,60000,now(),now()) RETURNING id`, [a.id, DR])).rows[0];
    const l = (await db.query(`INSERT INTO draw_finding_lines (finding_id,sitewire_request_id,name,requested_cents,approved_cents,not_approved_cents) VALUES ($1,9001,'Roof',100000,60000,40000) RETURNING id`, [f.id])).rows[0];
    const semail = `st${R}@e.com`; staffEmails.push(semail);
    const staff = (await db.query(`INSERT INTO staff_users (email,full_name,role,token_version,is_active) VALUES ($1,'Draw Admin','super_admin',0,true) RETURNING id`, [semail])).rows[0];
    const bt = C.signJwt({ sub: b.id, kind: 'borrower', role: 'borrower', tv: 0 });
    const st = C.signJwt({ sub: staff.id, kind: 'staff', role: 'super_admin', tv: 0 });
    server = app.listen(0); await new Promise((r) => server.once('listening', r)); base = 'http://127.0.0.1:' + server.address().port;

    let r = await jf('POST', `/api/borrower/findings/${f.id}/dispute`, bt, { lines: [{ line_id: l.id, desired_cents: 90000, note: 'done', media: [{ filename: 'roof.png', contentType: 'image/png', dataBase64: PNG }] }] });
    ok(r.status === 200 && r.body.disputed_lines === 1, 'borrower dispute w/ photo → 200');
    const dm = (await db.query(`SELECT dispute_media,dispute_status FROM draw_finding_lines WHERE id=$1`, [l.id])).rows[0];
    ok(dm.dispute_status === 'open', 'line marked disputed');
    ok(Array.isArray(dm.dispute_media) && dm.dispute_media[0] && dm.dispute_media[0].storage_ref, 'evidence stored with durable storage_ref');
    ok(dm.dispute_media[0].kind === 'image', 'evidence kind=image');
    r = await jf('GET', `/api/sitewire/findings/${f.id}`, st);
    ok(r.status === 200, 'staff finding-detail 200');
    const line = (r.body.lines || []).find((x) => x.id === l.id);
    ok(line && Array.isArray(line.dispute_evidence) && line.dispute_evidence.length === 1, 'staff sees 1 evidence descriptor');
    ok(line && !('dispute_media' in line), 'raw dispute_media NOT leaked to staff client');
    ok(line && line.dispute_evidence[0].storage_ref === undefined, 'storage_ref not in descriptor');
    r = await fetch(base + `/api/sitewire/findings/lines/${l.id}/dispute-media/0`, { headers: { Authorization: 'Bearer ' + st } });
    ok(r.status === 200, 'staff evidence serve → 200');
    ok(/image\/png/.test(r.headers.get('content-type') || ''), 'served content-type image/png');
    const buf = Buffer.from(await r.arrayBuffer());
    ok(buf.length > 0 && buf[0] === 0x89 && buf[1] === 0x50, 'served real PNG bytes');
    r = await fetch(base + `/api/sitewire/findings/lines/${l.id}/dispute-media/9`, { headers: { Authorization: 'Bearer ' + st } });
    ok(r.status === 404, 'evidence idx out of range → 404');
    r = await fetch(base + `/api/sitewire/findings/lines/${l.id}/dispute-media/0`);
    ok(r.status === 401 || r.status === 403, 'evidence unauth blocked');
    console.log(`\n${P} passed, ${F} failed`);
  } catch (e) { console.error('THREW', e && e.message); F++; }
  finally {
    try { for (const id of ids) { await db.query(`DELETE FROM draw_findings WHERE application_id=$1`, [id]); const bb = (await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [id])).rows[0]; await db.query(`DELETE FROM applications WHERE id=$1`, [id]); if (bb) { await db.query(`DELETE FROM borrower_auth WHERE borrower_id=$1`, [bb.borrower_id]); await db.query(`DELETE FROM borrowers WHERE id=$1`, [bb.borrower_id]); } } for (const em of staffEmails) await db.query(`DELETE FROM staff_users WHERE email=$1`, [em]); } catch (_) {}
    if (server) server.close(); try { await db.pool.end(); } catch (_) {}
    if (F) process.exit(1);
  }
})();
