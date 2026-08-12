/**
 * LOAN-OFFICER VIEW-ONLY DRAW ACCESS (owner-directed 2026-08-12).
 *
 * A loan officer holds `view_draws` (not `manage_draws`), so on THEIR OWN files they
 * can READ the draw section and APPROVE / DISPUTE a finding on the borrower's behalf,
 * but can run NONE of the draw desk. This drives the real /api/sitewire routes:
 *   - GET rollup: LO-on-file 200, LO-off-file 403 (file scope), admin 200.
 *   - GET /draws (their dashboard) lists their file.
 *   - a draw-desk WRITE (reconcile): LO → 403, admin → not 403.
 *   - accept-on-behalf (mark-accepted): LO-on-file 200 (accepted_via='staff'), off-file 403.
 *   - dispute-on-behalf: LO-on-file 200 (disputed_via='staff').
 * Plus a SOURCE-SCAN guard: every route relaxed to `requireDrawView` is a GET or one
 * of the two borrower-behalf POSTs — never a draw-desk write.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-lo-draw-view-db (no DATABASE_URL)'); process.exit(0); }
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-lo-draw';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const uuid = () => crypto.randomUUID();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

function api(server, method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? (() => { try { return JSON.parse(b); } catch { return b; } })() : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

async function main() {
  // ---- SOURCE-SCAN guard (no DB needed): what a loan officer can reach ----
  const src = fs.readFileSync(REPO + '/src/routes/sitewire.js', 'utf8');
  const relaxed = [...src.matchAll(/^router\.(get|post|put|patch|delete)\('([^']+)',\s*requireDrawView/gm)].map(m => ({ method: m[1], path: m[2] }));
  const badWrites = relaxed.filter(r => r.method !== 'get'
    && !/\/findings\/:findingId\/(mark-accepted|dispute)$/.test(r.path));
  ok(relaxed.length >= 20, `many read routes are LO-viewable (${relaxed.length} on requireDrawView)`);
  ok(badWrites.length === 0, `NO draw-desk write is on requireDrawView (offenders: ${JSON.stringify(badWrites)})`);
  ok(relaxed.some(r => r.method === 'post' && /mark-accepted$/.test(r.path))
    && relaxed.some(r => r.method === 'post' && /\/dispute$/.test(r.path)),
    'exactly the accept + dispute POSTs are the LO writes');

  const app = require(REPO + '/src/server.js');
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));

  const B = uuid(), APP = uuid(), LO_ON = uuid(), LO_OFF = uuid(), ADM = uuid();
  const drawId = Math.floor(2e9 + Math.random() * 1e8);   // unique bigint sitewire_draw_id
  let findingId;
  try {
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES
      ($1,$2,'LO On','loan_officer','x',true), ($3,$4,'LO Off','loan_officer','x',true), ($5,$6,'Adm','admin','x',true)`,
      [LO_ON, `loon_${LO_ON.slice(0,8)}@x.test`, LO_OFF, `looff_${LO_OFF.slice(0,8)}@x.test`, ADM, `adm_${ADM.slice(0,8)}@x.test`]);
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'Draw','Borrower',$2)`, [B, `dv_${B.slice(0,8)}@x.test`]);
    // LO_ON is the file's loan officer → an assignee (canSeeFile true). LO_OFF is on no file.
    await db.query(`INSERT INTO applications (id,borrower_id,loan_officer_id,status,property_address) VALUES ($1,$2,$3,'funded',$4)`,
      [APP, B, LO_ON, JSON.stringify({ line1: '9 Draw Rd', city: 'Lakewood', state: 'NJ', zip: '08701' })]);
    await db.query(`INSERT INTO sitewire_property_links (application_id, matched_by) VALUES ($1,'created')`, [APP]);
    await db.query(`INSERT INTO sitewire_draws (sitewire_draw_id, application_id, number, status) VALUES ($1,$2,1,'approved')`, [drawId, APP]);
    findingId = (await db.query(`INSERT INTO draw_findings (application_id, sitewire_draw_id, status) VALUES ($1,$2,'delivered') RETURNING id`, [APP, drawId])).rows[0].id;
    await db.query(`INSERT INTO draw_finding_lines (finding_id, requested_cents, approved_cents) VALUES ($1,100000,100000)`, [findingId]);

    const tok = (id, role) => C.signJwt({ sub: id, kind: 'staff', role, tv: 0 });
    const loOn = tok(LO_ON, 'loan_officer'), loOff = tok(LO_OFF, 'loan_officer'), adm = tok(ADM, 'admin');

    // ---- READ: rollup ----
    let r = await api(server, 'GET', `/api/sitewire/files/${APP}/rollup`, null, loOn);
    ok(r.status === 200, `LO on the file READS the draw rollup (200) — got ${r.status}`);
    r = await api(server, 'GET', `/api/sitewire/files/${APP}/rollup`, null, loOff);
    ok(r.status === 403, `a loan officer NOT on the file is refused (403 file scope) — got ${r.status}`);
    r = await api(server, 'GET', `/api/sitewire/files/${APP}/rollup`, null, adm);
    ok(r.status === 200, `an admin still reads the rollup (200) — got ${r.status}`);

    // ---- READ: the LO's own draws dashboard lists their file ----
    r = await api(server, 'GET', `/api/sitewire/draws`, null, loOn);
    ok(r.status === 200 && Array.isArray(r.body && r.body.draws) && r.body.draws.some(d => d.application_id === APP),
      `GET /draws (LO dashboard) lists the LO's own file — got ${r.status}`);

    // ---- WRITE (draw desk): a loan officer is refused; an admin is not ----
    r = await api(server, 'POST', `/api/sitewire/files/${APP}/reconcile`, {}, loOn);
    ok(r.status === 403, `a loan officer CANNOT run a draw-desk write (reconcile → 403) — got ${r.status}`);
    r = await api(server, 'POST', `/api/sitewire/files/${APP}/reconcile`, {}, adm);
    ok(r.status !== 403, `an admin passes the draw-desk write gate (reconcile not 403) — got ${r.status}`);

    // ---- ACCEPT on the borrower's behalf ----
    r = await api(server, 'POST', `/api/sitewire/files/${APP}/findings/${findingId}/mark-accepted`, { note: 'borrower approved by phone 8/12' }, loOn);
    ok(r.status === 200, `LO approves a finding on the borrower's behalf (200) — got ${r.status}: ${JSON.stringify(r.body).slice(0,120)}`);
    const acc = (await db.query(`SELECT status, accepted_via, accepted_by_staff_id FROM draw_findings WHERE id=$1`, [findingId])).rows[0];
    ok(acc.status === 'accepted' && acc.accepted_via === 'staff' && acc.accepted_by_staff_id === LO_ON,
      `the acceptance is recorded as staff, attributed to the LO (via=${acc.accepted_via})`);
    // an off-file LO cannot act
    r = await api(server, 'POST', `/api/sitewire/files/${APP}/findings/${findingId}/mark-accepted`, { note: 'should be refused' }, loOff);
    ok(r.status === 403, `an off-file loan officer cannot accept on this file (403) — got ${r.status}`);

    // ---- DISPUTE on the borrower's behalf (reset the finding to delivered first) ----
    await db.query(`UPDATE draw_findings SET status='delivered', accepted_via=NULL, accepted_at=NULL, accepted_by_staff_id=NULL, wire_due_at=NULL WHERE id=$1`, [findingId]);
    const lineId = (await db.query(`SELECT id FROM draw_finding_lines WHERE finding_id=$1 LIMIT 1`, [findingId])).rows[0].id;
    r = await api(server, 'POST', `/api/sitewire/files/${APP}/findings/${findingId}/dispute`,
      { note: 'borrower disputes the roof line 8/12', lines: [{ line_id: Number(lineId), desired_cents: 50000, note: 'too high' }] }, loOn);
    ok(r.status === 200 && r.body && r.body.disputed_lines === 1, `LO files a dispute on the borrower's behalf (200, 1 line) — got ${r.status}: ${JSON.stringify(r.body).slice(0,120)}`);
    const dis = (await db.query(`SELECT status, disputed_via, disputed_by_staff_id FROM draw_findings WHERE id=$1`, [findingId])).rows[0];
    ok(dis.status === 'disputed' && dis.disputed_via === 'staff' && dis.disputed_by_staff_id === LO_ON,
      `the dispute is recorded as staff, attributed to the LO (via=${dis.disputed_via})`);
  } catch (e) { fail++; console.log('  ✗ EXCEPTION', e && e.stack ? e.stack : e); }
  finally {
    await db.query(`DELETE FROM draw_finding_lines WHERE finding_id=$1`, [findingId]).catch(() => {});
    await db.query(`DELETE FROM draw_findings WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM sitewire_draws WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM sitewire_property_links WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [B]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id=ANY($1::uuid[])`, [[LO_ON, LO_OFF, ADM]]).catch(() => {});
  }
  server.close();
  console.log(`\nlo-draw-view-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
