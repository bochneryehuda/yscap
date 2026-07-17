/**
 * #151 — the FILE INTAKE status: ClickUp 'starting' / 'Prospect / Pricing'
 * derive to file_intake (pre-processing, NOT an active file), the db/123
 * backfill moves previous files, intake is excluded from the active KPIs and
 * has its own pipeline filter, and the status remains settable/queryable.
 * Run: node scripts/test-file-intake-status.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://yscap:yscap@127.0.0.1:5432/yscap_test';
process.env.JWT_SECRET = 'test-secret-intake';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const statusMap = require(REPO + '/src/clickup/status.js');
const PORT = 5687;
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
  // (0) mapping unit checks — no server needed.
  ok(statusMap.externalFor('starting') === 'file_intake', "externalFor('starting') = file_intake");
  ok(statusMap.externalFor('Prospect / Pricing') === 'file_intake', "externalFor('Prospect / Pricing') = file_intake");
  ok(statusMap.externalFor('some new pricing stage') === 'file_intake', 'keyword fallback: an unknown pricing/prospect status buckets to file_intake');
  ok(statusMap.externalFor('structuring loan') === 'in_review', 'structuring stays in_review');
  ok(statusMap.externalFor('rolled back') === 'in_review', 'rolled back stays in_review');
  ok(statusMap.externalFor('closed (6-email funded)') === 'funded', 'funded mapping untouched');
  ok(statusMap.isTerminal('starting') === false, "isTerminal('starting') stays false");
  ok(statusMap.EXTERNAL.includes('file_intake'), 'EXTERNAL set includes file_intake');

  const app = require(REPO + '/src/server.js');
  const server = app.listen(PORT);
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const B = uuid(), A1 = uuid(), A2 = uuid(), ADMIN = uuid();
  try {
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES ($1,$2,'FI Admin','admin','x',true)`, [ADMIN, `fiadm_${ADMIN.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'FI','Borrower',$2)`, [B, `fib_${B.slice(0, 8)}@x.test`]);
    // A1 simulates a PREVIOUS file: ClickUp says 'starting' but it landed as the
    // old (active) 'new' bucket. A2 is a genuinely active processing file.
    await db.query(`INSERT INTO applications (id,borrower_id,status,internal_status,loan_amount,property_address)
      VALUES ($1,$2,'new','starting',111000,$3), ($4,$2,'processing','file being worked',222000,$5)`,
      [A1, B, JSON.stringify({ line1: '1 Intake Ln', city: 'Lakewood', state: 'NJ' }),
       A2, JSON.stringify({ line1: '2 Active Ave', city: 'Lakewood', state: 'NJ' })]);

    // (1) the db/123 backfill (applied on every boot) moves the previous file.
    await db.query(fs.readFileSync(REPO + '/db/123_file_intake_status.sql', 'utf8'));
    let row = (await db.query(`SELECT status FROM applications WHERE id=$1`, [A1])).rows[0];
    ok(row.status === 'file_intake', `backfill moved the 'starting' file to file_intake (got ${row.status})`);
    row = (await db.query(`SELECT status FROM applications WHERE id=$1`, [A2])).rows[0];
    ok(row.status === 'processing', 'an actively-worked file is untouched by the backfill');

    // (2) the CHECK constraint accepts the new status.
    let threw = false;
    try { await db.query(`UPDATE applications SET status='file_intake' WHERE id=$1`, [A1]); } catch (_) { threw = true; }
    ok(!threw, 'applications_status_check accepts file_intake');

    const admTok = C.signJwt({ sub: ADMIN, kind: 'staff', role: 'admin', tv: 0 });

    // (3) dashboard: intake counted separately, NEVER inside active/pipeline value.
    let r = await api('GET', '/api/staff/dashboard', null, admTok);
    ok(r.status === 200 && typeof r.body.intake === 'number' && r.body.intake >= 1, `dashboard exposes intake count (got ${r.body && r.body.intake})`);
    const activeIds = await api('GET', '/api/staff/applications?group=active&limit=1000', null, admTok);
    const activeSet = new Set((activeIds.body.applications || activeIds.body || []).map((x) => x.id));
    ok(!activeSet.has(A1), 'intake file is NOT in the active pipeline view');
    ok(activeSet.has(A2), 'the processing file IS in the active view');

    // (4) the new Intake filter returns exactly the intake files.
    r = await api('GET', '/api/staff/applications?group=intake&limit=1000', null, admTok);
    const intakeRows = r.body.applications || r.body || [];
    ok(intakeRows.some((x) => x.id === A1), 'group=intake returns the intake file');
    ok(!intakeRows.some((x) => x.id === A2), 'group=intake excludes active files');

    // (5) staff can set the status explicitly (APP_STATUS accepts it).
    r = await api('PATCH', `/api/staff/applications/${A2}`, { status: 'file_intake' }, admTok);
    ok(r.status === 200, `PATCH status=file_intake accepted (got ${r.status})`);
    row = (await db.query(`SELECT status FROM applications WHERE id=$1`, [A2])).rows[0];
    ok(row.status === 'file_intake', 'status persisted');
  } catch (e) { fail++; console.log('  ✗ EXCEPTION', e && e.stack ? e.stack : e); }
  finally {
    await db.query(`DELETE FROM application_status_history WHERE application_id IN ($1,$2)`, [A1, A2]).catch(() => {});
    await db.query(`DELETE FROM checklist_items WHERE application_id IN ($1,$2)`, [A1, A2]).catch(() => {});
    await db.query(`DELETE FROM audit_log WHERE entity_id IN ($1,$2)`, [A1, A2]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE id IN ($1,$2)`, [A1, A2]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [B]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id=$1`, [ADMIN]).catch(() => {});
  }
  server.close();
  console.log(`\nfile-intake-status: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
