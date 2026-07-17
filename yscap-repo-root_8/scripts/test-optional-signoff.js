/**
 * #131/#134 — optional document conditions sign off with NO upload (the
 * Investor Structure Printout bug), required ones stay gated, and the LO's
 * Done (reviewed) is never blocked by the sign-off gate.
 * Run: node scripts/test-optional-signoff.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://yscap:yscap@127.0.0.1:5432/yscap_test';
process.env.JWT_SECRET = 'test-secret-optsign';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const http = require('http');
const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const PORT = 5633;
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
  const B = uuid(), APP = uuid(), ADMIN = uuid(), LO = uuid();
  const OPT = uuid(), REQ = uuid();
  try {
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES
      ($1,$2,'Opt Admin','admin','x',true), ($3,$4,'Opt LO','loan_officer','x',true)`,
      [ADMIN, `optadm_${ADMIN.slice(0, 8)}@x.test`, LO, `optlo_${LO.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'Opt','Sign',$2)`, [B, `opts_${B.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO applications (id,borrower_id,loan_officer_id) VALUES ($1,$2,$3)`, [APP, B, LO]);
    await db.query(`INSERT INTO checklist_items (id,application_id,label,item_kind,audience,status,scope,is_required) VALUES
      ($1,$2,'Investor Structure Printout','document','staff','outstanding','application',false),
      ($3,$2,'Required Doc','document','staff','outstanding','application',true)`, [OPT, APP, REQ]);
    const admTok = C.signJwt({ sub: ADMIN, kind: 'staff', role: 'admin', tv: 0 });
    const loTok = C.signJwt({ sub: LO, kind: 'staff', role: 'loan_officer', tv: 0 });

    // 1) OPTIONAL document condition signs off with NOTHING uploaded
    let r = await api('PATCH', `/api/staff/checklist/${OPT}`, { signedOff: true }, admTok);
    ok(r.status === 200, `optional doc condition signs off with no upload (got ${r.status}: ${JSON.stringify(r.body).slice(0, 120)})`);
    const o = (await db.query(`SELECT status, signed_off_at FROM checklist_items WHERE id=$1`, [OPT])).rows[0];
    ok(o && o.status === 'satisfied' && o.signed_off_at, 'optional item lands satisfied + signed_off_at');

    // 2) REQUIRED document condition with no docs stays blocked
    r = await api('PATCH', `/api/staff/checklist/${REQ}`, { signedOff: true }, admTok);
    ok(r.status === 422, `required doc condition with no docs still blocks sign-off (got ${r.status})`);

    // 3) The LO's Done is never blocked — records reviewed_at, does NOT complete
    r = await api('PATCH', `/api/staff/checklist/${REQ}`, { reviewed: true }, loTok);
    ok(r.status === 200, `LO Done always works (got ${r.status}: ${JSON.stringify(r.body).slice(0, 120)})`);
    const q = (await db.query(`SELECT reviewed_at, signed_off_at, status FROM checklist_items WHERE id=$1`, [REQ])).rows[0];
    ok(q && q.reviewed_at && !q.signed_off_at && q.status !== 'satisfied', 'Done sets reviewed_at only — condition stays open for the processor');

    // 4) The LO still cannot SIGN OFF (role gate intact) — and the error points at Done
    r = await api('PATCH', `/api/staff/checklist/${REQ}`, { signedOff: true }, loTok);
    ok(r.status === 403 && /click Done/i.test(r.body && r.body.error || ''), `LO sign-off still 403 with Done guidance (got ${r.status})`);
  } catch (e) { fail++; console.log('  ✗ EXCEPTION', e && e.stack ? e.stack : e); }
  finally {
    await db.query(`DELETE FROM checklist_items WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [B]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id=ANY($1::uuid[])`, [[ADMIN, LO]]).catch(() => {});
  }
  server.close();
  console.log(`\noptional-signoff: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
