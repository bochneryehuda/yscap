/**
 * #148 — LO re-register root fix: the register path is guarded by an
 * optimistic-concurrency fingerprint of the file's pricing basis (econVersion),
 * every refusal is audited, and an LO is never stuck on a file whose current
 * registration carries an admin manual-pricing basis (the fixed studio simply
 * doesn't echo the admin knobs, and the server keeps refusing them loudly).
 * Run: node scripts/test-register-econversion.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://yscap:yscap@127.0.0.1:5432/yscap_test';
process.env.JWT_SECRET = 'test-secret-econv';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const http = require('http');
const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const PORT = 5681;
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
  // Both CI jobs run the one chain and `test` has no database, so this must skip
  // rather than dial one. BEFORE ensureSchema deliberately: ensureSchema does not
  // throw when the database is unreachable — it retries ~75s and then RESOLVES —
  // so a guard placed after it catches nothing and the suite dies 75s later on its
  // first real query, with a stack pointing at the query rather than the cause.
  await require(__dirname + '/lib/db-gate').skipUnlessDb('register-econversion');
  const app = require(REPO + '/src/server.js');
  const server = app.listen(PORT);
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const B = uuid(), APP = uuid(), ADMIN = uuid(), LO = uuid();
  try {
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES
      ($1,$2,'EV Admin','admin','x',true), ($3,$4,'EV LO','loan_officer','x',true)`,
      [ADMIN, `evadm_${ADMIN.slice(0, 8)}@x.test`, LO, `evlo_${LO.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'EV','Borrower',$2)`, [B, `ev_${B.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version,email_verified) VALUES ($1,'x',0,true)`, [B]);
    await db.query(`INSERT INTO applications (id,borrower_id,loan_officer_id,property_address,purchase_price,as_is_value,arv,rehab_budget,term,requested_exp_flips)
      VALUES ($1,$2,$3,$4,300000,300000,450000,50000,'12',2)`,
      [APP, B, LO, JSON.stringify({ line1: '9 Version Way', city: 'Lakewood', state: 'NJ', zip: '08701' })]);
    const admTok = C.signJwt({ sub: ADMIN, kind: 'staff', role: 'admin', tv: 0 });
    const loTok = C.signJwt({ sub: LO, kind: 'staff', role: 'loan_officer', tv: 0 });
    const bTok = C.signJwt({ sub: B, kind: 'borrower', tv: 0 });

    const vanilla = { program: 'standard', overrides: {
      strategy: 'Fix & Flip', state: 'NJ', propertyType: 'SFR (1 unit)', loanType: 'Purchase',
      purchasePrice: 300000, asIsValue: 300000, arv: 450000, rehabBudget: 50000, term: 12,
      expFlips: 2, expHolds: 0, expGround: 0, manualPricing: false,
    } };

    // (1) GET /pricing hands the studio the file-basis fingerprint.
    let r = await api('GET', `/api/staff/applications/${APP}/pricing`, null, loTok);
    ok(r.status === 200 && /^[0-9a-f]{16}$/.test(r.body.econVersion || ''), `staff GET pricing returns econVersion (got ${r.body && r.body.econVersion})`);
    const v1 = r.body.econVersion;

    // (2) register WITH the current version succeeds and updates the file.
    r = await api('POST', `/api/staff/applications/${APP}/pricing/register`, { ...vanilla, econVersion: v1 }, loTok);
    ok(r.status === 201, `LO register with fresh econVersion succeeds (got ${r.status}: ${JSON.stringify(r.body).slice(0, 120)})`);
    let row = (await db.query(`SELECT loan_amount FROM applications WHERE id=$1`, [APP])).rows[0];
    ok(Number(row.loan_amount) > 0, `register UPDATED the file (loan_amount=${row.loan_amount})`);

    // (3) the file's economics change (form edit / ClickUp inbound). Note
    // register itself rewrote term/exp etc., so grab the CURRENT version first.
    r = await api('GET', `/api/staff/applications/${APP}/pricing`, null, loTok);
    const v2 = r.body.econVersion;
    await db.query(`UPDATE applications SET purchase_price=320000, as_is_value=320000 WHERE id=$1`, [APP]);

    // (4) a stale studio session (old fingerprint) is refused — never a silent
    // stale re-register that writes old economics back onto the file.
    r = await api('POST', `/api/staff/applications/${APP}/pricing/register`, { ...vanilla, econVersion: v2 }, loTok);
    ok(r.status === 409 && r.body && r.body.code === 'econ_version_conflict', `STALE econVersion is refused 409/econ_version_conflict (got ${r.status} ${r.body && r.body.code})`);

    // (5) a fresh reopen picks up the new fingerprint and registers cleanly.
    r = await api('GET', `/api/staff/applications/${APP}/pricing`, null, loTok);
    const v3 = r.body.econVersion;
    ok(v3 !== v2, 'econVersion CHANGED after the file edit');
    r = await api('POST', `/api/staff/applications/${APP}/pricing/register`,
      { ...vanilla, overrides: { ...vanilla.overrides, purchasePrice: 320000, asIsValue: 320000 }, econVersion: v3 }, loTok);
    ok(r.status === 201, `register after refresh succeeds (got ${r.status})`);

    // (6) an admin registers with MANUAL pricing (the scenario that used to
    // poison every later LO re-register through the studio's blind restore).
    r = await api('POST', `/api/staff/applications/${APP}/pricing/register`,
      { ...vanilla, overrides: { ...vanilla.overrides, purchasePrice: 320000, asIsValue: 320000, manualPricing: true, ovrRatePct: 9.875 } }, admTok);
    ok(r.status === 201, `admin manual-pricing register succeeds (got ${r.status})`);
    row = (await db.query(`SELECT inputs FROM product_registrations WHERE application_id=$1 AND is_current`, [APP])).rows[0];
    const curInp = typeof row.inputs === 'string' ? JSON.parse(row.inputs) : row.inputs;
    ok(curInp.manualPricing === true, 'current registration inputs carry manualPricing (the poison scenario is set up)');

    // (7) the FIXED studio does not echo the admin knobs for an LO — a vanilla
    // LO re-register on the manual-priced file now goes through.
    r = await api('GET', `/api/staff/applications/${APP}/pricing`, null, loTok);
    r = await api('POST', `/api/staff/applications/${APP}/pricing/register`,
      { ...vanilla, overrides: { ...vanilla.overrides, purchasePrice: 320000, asIsValue: 320000 }, econVersion: r.body.econVersion }, loTok);
    ok(r.status === 201, `LO re-register AFTER an admin manual registration succeeds (got ${r.status}) — the #148 dead-end is gone`);

    // (8) AN LO WHO SENDS MANUAL KEYS IS NO LONGER REFUSED — THEY ARE ESCALATED.
    // Owner-directed 2026-07-27: the pricing admin zone is open to every staff
    // role and "nothing is stripped and no role is refused"; the control moved
    // from a 403 to an ADMIN APPROVAL keyed on deviation from the company
    // default. The protection did not disappear, it changed shape, so this
    // asserts the shape it changed INTO rather than the door that was removed:
    // the register succeeds, the registration is flagged as needing approval,
    // and an escalation is opened for an admin to decide. The borrower's terms
    // email is withheld until then (esign/gate reads needs_approval, db/343).
    r = await api('POST', `/api/staff/applications/${APP}/pricing/register`,
      { ...vanilla, overrides: { ...vanilla.overrides, manualPricing: true, ovrRatePct: 9.875 } }, loTok);
    ok(r.status === 201, `LO sending engaged manual keys now REGISTERS (got ${r.status})`);
    const escReg = (await db.query(
      `SELECT needs_approval FROM product_registrations WHERE application_id=$1 AND is_current`, [APP])).rows[0];
    ok(escReg && escReg.needs_approval === true, '…and the registration is flagged as needing approval');
    const escRows = await db.query(
      `SELECT status, summary FROM manual_program_escalations WHERE application_id=$1 ORDER BY created_at DESC`, [APP]);
    ok(escRows.rows.length > 0, '…and an escalation was opened for an admin to decide');
    const escKinds = new Set(escRows.rows.map((x) => {
      const s = typeof x.summary === 'string' ? JSON.parse(x.summary) : (x.summary || {});
      return s.kind;
    }));
    ok(escKinds.has('pricing_override') || escKinds.has('manual_product'),
      '…and the escalation names WHY (a pricing override / manual product), not a bare refusal');

    // (9) every refusal left an audit trail (#149: diagnosable from logs alone).
    const audits = await db.query(
      `SELECT detail->>'reason' AS reason FROM audit_log
        WHERE action='register_product_refused' AND entity_id=$1`, [APP]);
    const reasons = new Set(audits.rows.map((x) => x.reason));
    ok(reasons.has('econ_version_conflict'), 'refusal AUDITED: econ_version_conflict');
    // `admin_override_stripped` was the audit row for the refusal removed above,
    // so it can no longer occur — nothing is stripped. The auditable event is now
    // the ESCALATION, which is what a reviewer would go looking for.
    const escAudit = await db.query(
      `SELECT detail FROM audit_log WHERE action='manual_program_escalated' AND entity_id=$1`, [APP]);
    ok(escAudit.rows.length > 0, 'the escalation is AUDITED: manual_program_escalated');

    // (10) borrower surface has the same guard.
    r = await api('GET', `/api/borrower/applications/${APP}/pricing`, null, bTok);
    ok(r.status === 200 && /^[0-9a-f]{16}$/.test(r.body.econVersion || ''), `borrower GET pricing returns econVersion`);
    const bv = r.body.econVersion;
    await db.query(`UPDATE applications SET rehab_budget=60000 WHERE id=$1`, [APP]);
    r = await api('POST', `/api/borrower/applications/${APP}/pricing/register`, { program: 'standard', overrides: {}, econVersion: bv }, bTok);
    ok(r.status === 409 && r.body && r.body.code === 'econ_version_conflict', `borrower stale econVersion refused 409 (got ${r.status})`);
  } catch (e) { fail++; console.log('  ✗ EXCEPTION', e && e.stack ? e.stack : e); }
  finally {
    await db.query(`DELETE FROM audit_log WHERE entity_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM product_registrations WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM checklist_items WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM conditions WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM notifications WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM borrower_auth WHERE borrower_id=$1`, [B]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [B]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id IN ($1,$2)`, [ADMIN, LO]).catch(() => {});
  }
  server.close();
  console.log(`\nregister-econversion: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
