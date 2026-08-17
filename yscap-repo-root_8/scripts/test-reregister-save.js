/**
 * #130 (Pinchus Wieder) — re-register saves the new terms, and a vanilla
 * non-admin register is NEVER wrongly refused.
 *   - a non-admin who MEANINGFULLY engages a manual-pricing knob → registers,
 *     but NEVER SILENTLY: flagged for approval + escalated to an admin
 *     (owner-directed 2026-07-27 replaced the old 403 with that approval; the
 *     concern this case has always guarded — "not silently registered with
 *     different terms" — is what the escalation now answers)
 *   - a non-admin's NORMAL register (manualPricing:false, experience present) → OK
 *   - an admin's manual-pricing register → OK
 * Run: node scripts/test-reregister-save.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://yscap:yscap@127.0.0.1:5432/yscap_test';
process.env.JWT_SECRET = 'test-secret-rereg';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const http = require('http');
const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const PORT = 5637;
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
  await require(__dirname + '/lib/db-gate').skipUnlessDb('reregister-save');
  const app = require(REPO + '/src/server.js');
  const server = app.listen(PORT);
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const B = uuid(), APP = uuid(), ADMIN = uuid(), LO = uuid();
  try {
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES
      ($1,$2,'RR Admin','admin','x',true), ($3,$4,'RR LO','loan_officer','x',true)`,
      [ADMIN, `rradm_${ADMIN.slice(0, 8)}@x.test`, LO, `rrlo_${LO.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'RR','Borrower',$2)`, [B, `rr_${B.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO applications (id,borrower_id,loan_officer_id,property_address,purchase_price,as_is_value,arv,rehab_budget,term,requested_exp_flips)
      VALUES ($1,$2,$3,$4,300000,300000,450000,50000,'12',2)`,
      [APP, B, LO, JSON.stringify({ line1: '5 Reg Rd', city: 'Lakewood', state: 'NJ', zip: '08701' })]);
    const admTok = C.signJwt({ sub: ADMIN, kind: 'staff', role: 'admin', tv: 0 });
    const loTok = C.signJwt({ sub: LO, kind: 'staff', role: 'loan_officer', tv: 0 });

    // A vanilla studio payload: economics + experience + manualPricing:false (the
    // studio ALWAYS sends this flag) — a non-admin must NOT be refused for it.
    const vanilla = { program: 'standard', overrides: {
      strategy: 'Fix & Flip', state: 'NJ', propertyType: 'SFR (1 unit)', loanType: 'Purchase',
      purchasePrice: 300000, asIsValue: 300000, arv: 450000, rehabBudget: 50000, term: 12,
      expFlips: 2, expHolds: 0, expGround: 0, manualPricing: false,
    } };

    let r = await api('POST', `/api/staff/applications/${APP}/pricing/register`, vanilla, loTok);
    ok(r.status === 201, `vanilla NON-ADMIN register succeeds (manualPricing:false + experience present) — got ${r.status}: ${JSON.stringify(r.body).slice(0, 140)}`);

    // Re-register with a changed budget a non-admin IS allowed to set (lowering
    // the rehab budget; raising ARV would hit the separate S3-06 gate) saves it.
    r = await api('POST', `/api/staff/applications/${APP}/pricing/register`, { ...vanilla, overrides: { ...vanilla.overrides, rehabBudget: 40000, term: 18 } }, loTok);
    ok(r.status === 201, `non-admin RE-register with changed terms succeeds — got ${r.status}: ${JSON.stringify(r.body).slice(0, 120)}`);
    const reg = (await db.query(`SELECT inputs FROM product_registrations WHERE application_id=$1 AND is_current`, [APP])).rows[0];
    const inp = typeof reg.inputs === 'string' ? JSON.parse(reg.inputs) : reg.inputs;
    ok(Number(inp.rehabBudget) === 40000 && Number(inp.term) === 18, `re-register PERSISTED the new terms (budget=${inp && inp.rehabBudget}, term=${inp && inp.term})`);

    // A non-admin who MEANINGFULLY engages manual pricing REGISTERS — and is
    // escalated. This used to expect a 403; owner-directed 2026-07-27 opened the
    // pricing admin zone to every staff role ("nothing is stripped and no role is
    // refused") and replaced the refusal with an ADMIN APPROVAL. The thing this
    // case exists to prevent — a SILENT register on different terms — is still
    // prevented, so it is asserted directly rather than through the old door:
    // the registration is flagged for approval and an escalation is raised, and
    // the borrower's terms email is withheld until an admin decides.
    r = await api('POST', `/api/staff/applications/${APP}/pricing/register`, { ...vanilla, overrides: { ...vanilla.overrides, manualPricing: true, ovrRatePct: 9.875 } }, loTok);
    ok(r.status === 201, `non-admin with manual pricing ENGAGED now registers — got ${r.status}`);
    const eng = (await db.query(
      `SELECT needs_approval FROM product_registrations WHERE application_id=$1 AND is_current`, [APP])).rows[0];
    ok(eng && eng.needs_approval === true, '…and it is NEVER SILENT: flagged as needing approval');
    const engEsc = (await db.query(
      `SELECT count(*)::int AS n FROM manual_program_escalations WHERE application_id=$1`, [APP])).rows[0];
    ok(engEsc.n > 0, '…and an admin escalation was raised to decide it');

    // An admin CAN use manual pricing.
    r = await api('POST', `/api/staff/applications/${APP}/pricing/register`, { ...vanilla, overrides: { ...vanilla.overrides, manualPricing: true, ovrRatePct: 9.875 } }, admTok);
    ok(r.status === 201, `admin manual-pricing register succeeds — got ${r.status}: ${JSON.stringify(r.body).slice(0, 120)}`);
  } catch (e) { fail++; console.log('  ✗ EXCEPTION', e && e.stack ? e.stack : e); }
  finally {
    await db.query(`DELETE FROM product_registrations WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM checklist_items WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [B]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id=ANY($1::uuid[])`, [[ADMIN, LO]]).catch(() => {});
  }
  server.close();
  console.log(`\nreregister-save: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
