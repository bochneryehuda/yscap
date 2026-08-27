/**
 * PROCESSOR REASSIGNMENT IS OPEN TO EVERYONE ON THE FILE (owner-directed
 * 2026-08-26: "Right now, only the super admin can reassign processors and
 * remove processors from files and reassign the primary processor. Please make
 * it so that everybody should be able to, when something is assigned to a
 * processor, change the processor.")
 *
 * Drives the REAL routes against a real Postgres and proves:
 *   (a) a plain (non-admin) loan officer ON the file changes the processor → 200,
 *       the pointer moves, the db/103 trigger keeps the primary assignee row in
 *       lock-step, and the change is audited;
 *   (b) the file's own (non-admin) processor can hand the file to another
 *       processor;
 *   (c) the widening is INSIDE the file scope only — a staffer who cannot open
 *       the file still cannot touch its processor (the /applications/:id path
 *       middleware refusal is unchanged);
 *   (d) the person picked must genuinely BE an active processor (a loan officer
 *       id is refused), so "open to everyone" cannot mis-file the pointer;
 *   (e) the LOAN OFFICER half did not move: a non-admin still cannot reassign
 *       an assigned officer;
 *   (f) a non-admin REMOVES the primary processor through the assignee route —
 *       the pointer clears, the trigger retires the row;
 *   (g) the loan-officer PRIMARY still cannot be removed there.
 */
// Skip cleanly when there is no database (the no-DB `test` CI job).
if (!process.env.DATABASE_URL) { console.log('SKIP test-processor-reassign-db (no DATABASE_URL)'); process.exit(0); }
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-proc-reassign';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const http = require('http');
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
  const app = require(REPO + '/src/server.js');
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));

  const B = uuid(), APP = uuid();
  const LO = uuid(), P1 = uuid(), P2 = uuid(), STRANGER = uuid();
  const tok = (id, role) => C.signJwt({ sub: id, kind: 'staff', role, tv: 0 });

  const pointer = async () => (await db.query(`SELECT processor_id, loan_officer_id FROM applications WHERE id=$1`, [APP])).rows[0];
  const primaryRow = async (role) => (await db.query(
    `SELECT staff_id FROM application_assignees WHERE application_id=$1 AND role=$2 AND is_primary=true AND removed_at IS NULL`,
    [APP, role])).rows[0] || null;

  try {
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES
      ($1,$2,'PR Officer','loan_officer','x',true),
      ($3,$4,'PR Proc One','processor','x',true),
      ($5,$6,'PR Proc Two','processor','x',true),
      ($7,$8,'PR Stranger','loan_officer','x',true)`,
      [LO, `prlo_${LO.slice(0, 8)}@x.test`, P1, `prp1_${P1.slice(0, 8)}@x.test`,
        P2, `prp2_${P2.slice(0, 8)}@x.test`, STRANGER, `prst_${STRANGER.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'PR','Borrower',$2)`, [B, `prb_${B.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO applications (id,borrower_id,loan_officer_id,processor_id,property_address)
      VALUES ($1,$2,$3,$4,$5)`,
      [APP, B, LO, P1, JSON.stringify({ line1: '7 Reassign Way', city: 'Lakewood', state: 'NJ', zip: '08701' })]);

    // ---- (a) the non-admin LOAN OFFICER on the file changes the processor ----
    let r = await api(server, 'POST', `/api/staff/applications/${APP}/assign`, { processorId: P2 }, tok(LO, 'loan_officer'));
    ok(r.status === 200, `(a) a plain loan officer on the file reassigns the processor — got ${r.status}: ${JSON.stringify(r.body).slice(0, 120)}`);
    let p = await pointer();
    ok(String(p.processor_id) === P2, '(a) the processor pointer moved to the new person');
    const prim = await primaryRow('processor');
    ok(prim && String(prim.staff_id) === P2, '(a) the db/103 trigger kept the primary assignee row in lock-step');
    const audited = await db.query(
      `SELECT 1 FROM audit_log WHERE entity_id=$1 AND action='assign_processor' AND actor_id=$2`, [APP, LO]);
    ok(audited.rows.length >= 1, '(a) the change is audited with who made it');

    // ---- (b) the file's own processor (non-admin) hands it to another processor ----
    r = await api(server, 'POST', `/api/staff/applications/${APP}/assign`, { processorId: P1 }, tok(P2, 'processor'));
    ok(r.status === 200, `(b) the file's processor hands the file to another processor — got ${r.status}`);
    p = await pointer();
    ok(String(p.processor_id) === P1, '(b) and the pointer moved back');

    // ---- (c) the widening stays INSIDE the file scope ----
    r = await api(server, 'POST', `/api/staff/applications/${APP}/assign`, { processorId: P2 }, tok(STRANGER, 'loan_officer'));
    ok(r.status === 403 || r.status === 404, `(c) a staffer who cannot open the file is still refused — got ${r.status}`);
    p = await pointer();
    ok(String(p.processor_id) === P1, '(c) and the pointer did not move');

    // ---- (d) the pick must be a real active processor ----
    r = await api(server, 'POST', `/api/staff/applications/${APP}/assign`, { processorId: STRANGER }, tok(LO, 'loan_officer'));
    ok(r.status === 404, `(d) a non-processor id is refused (${r.status}) — the role validation is what keeps the open door safe`);

    // ---- (e) the LOAN OFFICER gate did not move ----
    r = await api(server, 'POST', `/api/staff/applications/${APP}/assign`, { loanOfficerId: P1 }, tok(LO, 'loan_officer'));
    ok(r.status === 403, `(e) a non-admin still cannot reassign an assigned loan officer — got ${r.status}`);

    // ---- (f) a non-admin REMOVES the primary processor ----
    r = await api(server, 'DELETE', `/api/staff/applications/${APP}/assignees/${P1}?role=processor`, null, tok(LO, 'loan_officer'));
    ok(r.status === 200, `(f) a plain loan officer removes the primary processor — got ${r.status}: ${JSON.stringify(r.body).slice(0, 120)}`);
    p = await pointer();
    ok(p.processor_id == null, '(f) the processor pointer cleared');
    ok((await primaryRow('processor')) == null, '(f) and the trigger retired the primary assignee row');

    // ---- (g) the loan-officer primary still cannot be removed there ----
    r = await api(server, 'DELETE', `/api/staff/applications/${APP}/assignees/${LO}?role=loan_officer`, null, tok(LO, 'loan_officer'));
    ok(r.status === 400, `(g) the loan-officer primary is still locked to Assign — got ${r.status}`);
    p = await pointer();
    ok(String(p.loan_officer_id) === LO, '(g) and the officer pointer is untouched');
  } finally {
    try {
      await db.query(`DELETE FROM applications WHERE id=$1`, [APP]);
      await db.query(`DELETE FROM borrowers WHERE id=$1`, [B]);
      await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[LO, P1, P2, STRANGER]]);
    } catch (_) { /* best-effort cleanup */ }
    server.close();
    await db.pool.end().catch(() => {});
  }

  console.log(`\n${fail ? 'FAIL' : 'OK'} — ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
