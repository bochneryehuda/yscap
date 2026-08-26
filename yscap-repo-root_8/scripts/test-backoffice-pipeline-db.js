/**
 * THE BACK OFFICE SEES THE WHOLE PIPELINE (owner-directed 2026-08-26: "anyone
 * with the back office persona should technically have access to the entire
 * pipeline, not only the files that they are assigned … all the files and all
 * the borrower profiles … the same way admins have").
 *
 * The mechanism is ONE role-default entry — 'see_all_files' on
 * ROLE_DEFAULTS.processor — because every backend gate already keys on the
 * capability, never on a role list. Proven over real HTTP:
 *   (a) a processor assigned to NOTHING lists a file they are not on in the
 *       pipeline, and can OPEN it;
 *   (b) …and can open a borrower profile they have no file with;
 *   (c) the assigned-files WORKFLOW is untouched: the ?mine=1 pipeline lens
 *       still narrows to their own files;
 *   (d) a loan officer's scope did NOT widen (the change is the processor
 *       role, not the visibility rule);
 *   (e) the capability stays per-person revocable: a processor whose
 *       see_all_files is explicitly revoked is scoped again.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-backoffice-pipeline-db (no DATABASE_URL)'); process.exit(0); }
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-backoffice';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const http = require('http');
const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const perms = require(REPO + '/src/lib/permissions');
const uuid = () => crypto.randomUUID();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

function api(server, method, path, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? (() => { try { return JSON.parse(b); } catch { return b; } })() : null })); });
    req.on('error', reject); req.end();
  });
}

async function main() {
  // The role-default itself, before any HTTP: the one-line mechanism.
  ok(perms.defaultsFor('processor').has('see_all_files'),
    "ROLE_DEFAULTS.processor carries see_all_files — the back office persona's whole-pipeline grant");
  ok(!perms.defaultsFor('loan_officer').has('see_all_files'),
    'loan officers did NOT widen');

  const app = require(REPO + '/src/server.js');
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));

  const B = uuid(), APP = uuid(), LO = uuid(), PROC = uuid(), PROC2 = uuid(), MINEAPP = uuid(), B2 = uuid();
  const tok = (id, role) => C.signJwt({ sub: id, kind: 'staff', role, tv: 0 });
  try {
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES
      ($1,$2,'BO Officer','loan_officer','x',true),
      ($3,$4,'BO Processor','processor','x',true),
      ($5,$6,'BO Revoked','processor','x',true)`,
      [LO, `bolo_${LO.slice(0, 8)}@x.test`, PROC, `bopr_${PROC.slice(0, 8)}@x.test`, PROC2, `bopr2_${PROC2.slice(0, 8)}@x.test`]);
    // The revoked processor: see_all_files explicitly off per-person.
    await db.query(`UPDATE staff_users SET permissions = $2::jsonb WHERE id=$1`,
      [PROC2, JSON.stringify({ see_all_files: false })]);
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'BO','Borrower',$2), ($3,'BO','Second',$4)`,
      [B, `bob_${B.slice(0, 8)}@x.test`, B2, `bob2_${B2.slice(0, 8)}@x.test`]);
    // A file the processor is NOT on, and one they ARE on (for the mine lens).
    await db.query(`INSERT INTO applications (id,borrower_id,loan_officer_id,status,property_address) VALUES
      ($1,$2,$3,'underwriting',$4), ($5,$6,$3,'underwriting',$7)`,
      [APP, B, LO, JSON.stringify({ line1: '9 Pipeline Pl', city: 'Lakewood', state: 'NJ', zip: '08701' }),
        MINEAPP, B2, JSON.stringify({ line1: '11 Pipeline Pl', city: 'Lakewood', state: 'NJ', zip: '08701' })]);
    await db.query(`UPDATE applications SET processor_id=$2 WHERE id=$1`, [MINEAPP, PROC]);

    const pTok = tok(PROC, 'processor');

    // ---- (a) whole pipeline: list + open a file they are not on ----
    let r = await api(server, 'GET', '/api/staff/applications?limit=500', pTok);
    const rows = (r.body && (r.body.rows || r.body)) || [];
    const ids = new Set((Array.isArray(rows) ? rows : []).map(x => String(x.id)));
    ok(r.status === 200 && ids.has(APP), `(a) an unassigned processor lists the whole pipeline (status ${r.status}, sees the file: ${ids.has(APP)})`);
    r = await api(server, 'GET', `/api/staff/applications/${APP}`, pTok);
    ok(r.status === 200, `(a) …and OPENS a file they are not on — got ${r.status}`);

    // ---- (b) any borrower profile ----
    r = await api(server, 'GET', `/api/staff/borrowers/${B}`, pTok);
    ok(r.status === 200, `(b) …and opens a borrower profile they have no file with — got ${r.status}`);

    // ---- (c) the mine lens still narrows ----
    r = await api(server, 'GET', '/api/staff/applications?limit=500&mine=1', pTok);
    const mrowsRaw = (r.body && (r.body.rows || r.body)) || [];
    const mrows = Array.isArray(mrowsRaw) ? mrowsRaw : [];
    const mine = new Set(mrows.map(x => String(x.id)));
    ok(r.status === 200 && mine.has(MINEAPP) && !mine.has(APP),
      `(c) ?mine=1 still narrows to THEIR files (has own: ${mine.has(MINEAPP)}, excludes other: ${!mine.has(APP)})`);

    // ---- (d) a loan officer stays scoped ----
    r = await api(server, 'GET', `/api/staff/applications/${APP}`, tok(LO, 'loan_officer'));
    ok(r.status === 200, '(d-control) the assigned officer opens their own file');
    const LO2 = uuid();
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES ($1,$2,'BO Other LO','loan_officer','x',true)`,
      [LO2, `bolo2_${LO2.slice(0, 8)}@x.test`]);
    r = await api(server, 'GET', `/api/staff/applications/${APP}`, tok(LO2, 'loan_officer'));
    ok(r.status === 403 || r.status === 404, `(d) an unrelated loan officer is still refused — got ${r.status}`);
    await db.query(`DELETE FROM staff_users WHERE id=$1`, [LO2]);

    // ---- (e) per-person revocation still works ----
    r = await api(server, 'GET', `/api/staff/applications/${APP}`, tok(PROC2, 'processor'));
    ok(r.status === 403 || r.status === 404,
      `(e) a processor whose see_all_files was revoked per-person is scoped again — got ${r.status}`);
  } finally {
    try {
      await db.query(`DELETE FROM applications WHERE id = ANY($1::uuid[])`, [[APP, MINEAPP]]);
      await db.query(`DELETE FROM borrowers WHERE id = ANY($1::uuid[])`, [[B, B2]]);
      await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[LO, PROC, PROC2]]);
    } catch (_) { /* best-effort cleanup */ }
    server.close();
    await db.pool.end().catch(() => {});
  }

  console.log(`\n${fail ? 'FAIL' : 'OK'} — ${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
