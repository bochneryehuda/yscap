/**
 * LEAD → LOAN FILE CONVERT must not 500 (owner-reported: "at the lead screen
 * with a lot of information, click Convert to loan file → server error").
 *
 * ROOT CAUSE: the convert route (POST /api/staff/leads/:id/convert) bound the
 * three experience columns as `parseInt(pv.expFlips,10) || null`. But
 * requested_exp_flips / _holds / _ground are `integer NOT NULL DEFAULT 0`
 * (db/schema.sql, db/028, db/029). An explicit NULL does NOT fall back to the
 * DEFAULT — it violates the NOT-NULL constraint — so ANY lead missing an
 * experience count (a plain contact lead has none; a loan-application lead that
 * filled flips but not holds/ground) threw, and the bare `catch { 500 }` hid it.
 *
 * Every OTHER create path (staff.js:1206, borrower.js, intake.js, mismo) already
 * coalesces these to 0 via intField()/`|| 0`. The fix aligns convert with them.
 *
 * This test proves the reported flow now succeeds AND that the columns really are
 * NOT NULL (so the invariant that made 0-not-null mandatory can never silently
 * regress). DB-gated: skipped when no DATABASE_URL, like every *-db.js here.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

let failures = 0, passes = 0;
const assert = (c, m) => { if (c) { passes++; } else { failures++; console.log(`FAIL ${m}`); } };

if (!process.env.DATABASE_URL) { console.log('  (SKIP DB — no DATABASE_URL)'); process.exit(0); }

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const madeApps = [], madeBorrowers = [], madeLeads = [], madeStaff = [];
  try {
    // The invariant the fix depends on: these columns reject an explicit NULL.
    // If a future migration made them nullable this whole class changes, so pin it.
    const nn = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='applications'
          AND column_name IN ('requested_exp_flips','requested_exp_holds','requested_exp_ground')
          AND is_nullable='NO'`);
    assert(nn.rows.length === 3, 'requested_exp_flips/_holds/_ground are NOT NULL (0-not-null is mandatory)');

    const adminId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Convert Admin','super_admin',true,false,'x',0) RETURNING id`, [`lc-adm-${sfx}@test.local`])).rows[0].id;
    madeStaff.push(adminId);
    const tok = C.signJwt({ sub: adminId, kind: 'staff', role: 'super_admin', tv: 0 });

    const seedLead = async (cols) => {
      const keys = Object.keys(cols), vals = keys.map((_, i) => `$${i + 1}`);
      const r = await db.query(
        `INSERT INTO leads (${keys.join(',')}) VALUES (${vals.join(',')}) RETURNING id`,
        keys.map((k) => cols[k]));
      madeLeads.push(r.rows[0].id);
      return r.rows[0].id;
    };
    const trackConvert = (out) => { if (out.body && out.body.applicationId) madeApps.push(out.body.applicationId); if (out.body && out.body.borrowerId) madeBorrowers.push(out.body.borrowerId); };

    // ---- CASE A: a bare lead with NO experience data at all (the common case
    //      that 500'd on every convert before the fix). ----------------------
    const bareLead = await seedLead({ tool: 'contact', status: 'new' });
    const rA = await call(server, 'POST', `/api/staff/leads/${bareLead}/convert`, tok, {
      firstName: 'Bare', lastName: 'Lead', email: `lc-a-${sfx}@test.local`,
      propertyAddress: { oneLine: '10 Bare St, Lakewood, NJ 08701' },
    });
    trackConvert(rA);
    assert(rA.status === 201, `bare lead (no experience) converts — got ${rA.status} ${JSON.stringify(rA.body)}`);
    assert(rA.body && rA.body.applicationId, 'bare convert returns an applicationId');
    if (rA.body && rA.body.applicationId) {
      const a = (await db.query(
        `SELECT requested_exp_flips f, requested_exp_holds h, requested_exp_ground g FROM applications WHERE id=$1`,
        [rA.body.applicationId])).rows[0];
      assert(a && a.f === 0 && a.h === 0 && a.g === 0, `experience defaults to 0/0/0 (got ${a && [a.f, a.h, a.g]})`);
    }

    // ---- CASE B: a rich loan-application lead — economics + only ONE of the
    //      three experience counts filled (flips=3). holds/ground must land 0,
    //      not NULL, and the economics must carry onto the created file. -------
    const richLead = await seedLead({
      tool: 'loan_application', status: 'new',
      payload: JSON.stringify({
        v: { price: '300000', asIs: '250000', arv: '400000', rehab: '80000', termMonths: '12', fico: '720', expFlips: '3', propType: 'SFR' },
        c: {}, rad: { purpose: 'purchase' },
      }),
    });
    const rB = await call(server, 'POST', `/api/staff/leads/${richLead}/convert`, tok, {
      firstName: 'Rich', lastName: 'Applicant', email: `lc-b-${sfx}@test.local`,
      propertyAddress: { oneLine: '20 Rich Ave, Lakewood, NJ 08701' },
    });
    trackConvert(rB);
    assert(rB.status === 201, `rich lead (partial experience) converts — got ${rB.status} ${JSON.stringify(rB.body)}`);
    if (rB.body && rB.body.applicationId) {
      const a = (await db.query(
        `SELECT requested_exp_flips f, requested_exp_holds h, requested_exp_ground g,
                purchase_price::float8 pp, arv::float8 arv, rehab_budget::float8 rb, term FROM applications WHERE id=$1`,
        [rB.body.applicationId])).rows[0];
      assert(a && a.f === 3 && a.h === 0 && a.g === 0, `flips carried (3) and holds/ground default 0 (got ${a && [a.f, a.h, a.g]})`);
      assert(a && a.pp === 300000 && a.arv === 400000 && a.rb === 80000 && a.term === '12',
        `economics carried onto the file (got ${a && [a.pp, a.arv, a.rb, a.term]})`);
    }

    // ---- Idempotency: a second convert of the same lead is a clean 409, never a 500.
    const rDup = await call(server, 'POST', `/api/staff/leads/${richLead}/convert`, tok, {
      firstName: 'Rich', email: `lc-b-${sfx}@test.local`, propertyAddress: { oneLine: '20 Rich Ave' } });
    assert(rDup.status === 409, `already-converted lead → 409 (got ${rDup.status})`);
  } catch (e) {
    failures++; console.log('FAIL threw', e && e.message);
  } finally {
    try { await db.query(`DELETE FROM leads WHERE id = ANY($1::uuid[])`, [madeLeads]); } catch (_) {}
    try { await db.query(`DELETE FROM applications WHERE id = ANY($1::uuid[])`, [madeApps]); } catch (_) {}
    try { await db.query(`DELETE FROM borrowers WHERE id = ANY($1::uuid[])`, [madeBorrowers]); } catch (_) {}
    try { await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [madeStaff]); } catch (_) {}
    server.close();
  }
  console.log(`test-lead-convert-db: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
