/**
 * #142 — complete a task inline from the task list (no dive into the file).
 * Verifies GET /api/staff/my-tasks now carries the completion state the inline
 * Done / Sign off / Waive buttons need, and that those buttons' PATCH bodies
 * (the SAME endpoint the file's condition list uses) round-trip correctly.
 *
 * Run: node scripts/test-tasklist-inline.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://yscap:yscap@127.0.0.1:5432/yscap_test';
process.env.JWT_SECRET = 'test-secret-tasklist';
process.env.SSN_ENCRYPTION_KEY = 'test-ssn-key-for-verification-only-32bytes!!';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const http = require('http');
const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const PORT = 5677;
const uuid = () => crypto.randomUUID();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };
function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? (() => { try { return JSON.parse(b); } catch { return b; } })() : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

async function main() {
  const app = require(REPO + '/src/server.js');
  const server = app.listen(PORT);
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const LO = uuid(), ADMIN = uuid(), B = uuid(), APP = uuid();
  let reqItem, optItem;
  try {
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES ($1,$2,'TL Officer','loan_officer','x',true)`, [LO, `tl_${LO.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES ($1,$2,'TL Admin','admin','x',true)`, [ADMIN, `tla_${ADMIN.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'TL','Borrower',$2)`, [B, `tlb_${B.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO applications (id,borrower_id,loan_officer_id,status,source) VALUES ($1,$2,$3,'processing','portal')`, [APP, B, LO]);
    // A REQUIRED internal condition role-routed to the LO, and an OPTIONAL one.
    const mk = async (isReq) => {
      const id = uuid();
      await db.query(
        `INSERT INTO checklist_items (id,application_id,scope,label,audience,status,role_scope,item_kind,is_required)
         VALUES ($1,$2,'application',$3,'staff','outstanding','loan_officer','task',$4)`,
        [id, APP, isReq ? 'Required task' : 'Optional task', isReq]);
      return id;
    };
    reqItem = await mk(true); optItem = await mk(false);
    const tok = C.signJwt({ sub: LO, kind: 'staff', role: 'loan_officer', tv: 0 });
    const adminTok = C.signJwt({ sub: ADMIN, kind: 'staff', role: 'admin', tv: 0 });

    // (1) my-tasks carries the completion state the inline actions need.
    let r = await api('GET', '/api/staff/my-tasks', null, tok);
    const mine = () => (r.body || []).filter(x => x.application_id === APP);
    const findIt = (id) => mine().find(x => x.id === id);
    ok(r.status === 200 && Array.isArray(r.body), `my-tasks 200 (got ${r.status})`);
    const it0 = findIt(reqItem);
    ok(it0 && 'reviewed_at' in it0 && 'signed_off_at' in it0 && 'waived_at' in it0 && 'is_required' in it0,
      'my-tasks item carries reviewed_at/signed_off_at/waived_at/is_required');
    ok(it0 && it0.reviewed_at == null && it0.signed_off_at == null, 'fresh task is not yet done/signed');
    ok(findIt(optItem) && findIt(optItem).is_required === false, 'optional task reports is_required=false');

    // (2) Done (reviewed:true) — the LO step — stays on the list, marked done.
    r = await api('PATCH', `/api/staff/checklist/${reqItem}`, { reviewed: true }, tok);
    ok(r.status === 200, `mark Done (reviewed) → 200 (got ${r.status})`);
    r = await api('GET', '/api/staff/my-tasks', null, tok);
    const done = findIt(reqItem);
    ok(done && done.reviewed_at != null, 'task now shows reviewed_at (Done)');
    ok(done && done.reviewed_by_name, `Done attributes the reviewer (${done && done.reviewed_by_name})`);

    // (3) Undo done.
    r = await api('PATCH', `/api/staff/checklist/${reqItem}`, { reviewed: false }, tok);
    ok(r.status === 200, `Undo done → 200 (got ${r.status})`);
    r = await api('GET', '/api/staff/my-tasks', null, tok);
    ok(findIt(reqItem) && findIt(reqItem).reviewed_at == null, 'Undo cleared reviewed_at');

    // (4) Sign off is the PROCESSOR/back-office step (#134) — an LO is correctly
    //     BLOCKED and guided to "Done" instead. The inline button still shows (the
    //     file does too); the backend gate is the source of truth.
    r = await api('PATCH', `/api/staff/checklist/${optItem}`, { signedOff: true }, tok);
    ok(r.status === 403, `LO sign-off is blocked by the gate (got ${r.status})`);

    // (5) An ADMIN can sign off the OPTIONAL task (optional signs off without a
    //     doc) → it drops off the list for everyone (satisfied).
    r = await api('PATCH', `/api/staff/checklist/${optItem}`, { signedOff: true }, adminTok);
    ok(r.status === 200, `admin sign off optional task → 200 (got ${r.status})`);
    r = await api('GET', '/api/staff/my-tasks', null, tok);
    ok(!findIt(optItem), 'signed-off task removed from the task list');

    // (6) Waive round-trip on a fresh optional task (admin).
    const optItem2 = await mk(false);
    r = await api('PATCH', `/api/staff/checklist/${optItem2}`, { waived: true }, adminTok);
    ok(r.status === 200, `admin waive optional task → 200 (got ${r.status})`);
    r = await api('GET', '/api/staff/my-tasks', null, tok);
    ok(!findIt(optItem2), 'waived task removed from the task list');
  } catch (e) { fail++; console.log('  ✗ EXCEPTION', e && e.stack ? e.stack : e); }
  finally {
    await db.query(`DELETE FROM checklist_items WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [B]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id=$1`, [LO]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id=$1`, [ADMIN]).catch(() => {});
  }
  server.close();
  console.log(`\ntasklist-inline: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
