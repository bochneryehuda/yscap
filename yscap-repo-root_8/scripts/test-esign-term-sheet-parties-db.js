'use strict';
/**
 * test-esign-term-sheet-parties-db.js — the Term Sheet Studio draws its signature
 * lines from the SERVER'S read of the file's parties, and the officer it draws is
 * the officer the SEND will ask to sign (owner-directed 2026-09-02, closing the
 * loan-officer half of the stale-parties gap).
 *
 * Over REAL HTTP against a REAL Postgres:
 *   A. GET /api/staff/applications/:id/pricing returns `parties.loanOfficer` with
 *      the assigned officer's name, email and NMLS — the NMLS the screen never had;
 *   B. the officer named there is exactly `orchestrate.loanOfficerSigner` over the
 *      send's own `loadApplication` row (ONE definition, two readers);
 *   C. reassigning the officer AFTER "the page loaded" (a direct UPDATE, as another
 *      tab or an admin would) is reflected on the very next read — the reported
 *      dead end, where the studio kept redrawing the old officer until a refresh;
 *   D. a file whose officer is only a TYPED NAME (no staff record) reports no
 *      signing officer — the send puts nobody on the package, so the studio must
 *      draw no line; and an officer on the roster of a bare file is the same
 *      person the pricing read names (both borrowers, the officer, the lender).
 *
 * Skips cleanly with no DATABASE_URL, like every other -db suite in the chain.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || '';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';
if (!process.env.DATABASE_URL) { console.log('SKIP test-esign-term-sheet-parties-db (no DATABASE_URL)'); process.exit(0); }

const http = require('http');
const assert = require('assert');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto');

let checks = 0;
const ok = (name) => { checks += 1; console.log(`  ok - ${name}`); };

function call(server, method, p, token) {
  return new Promise((resolve, reject) => {
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); r.end();
  });
}

(async () => {
  await db.query('SELECT 1');
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const app = require(REPO + '/src/server');
  const orchestrate = require(REPO + '/src/lib/esign/orchestrate');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const ids = { staff: [], borrowers: [], apps: [] };
  try {
    const mkStaff = async (name, nmls) => {
      const id = (await db.query(
        `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version, nmls)
         VALUES ($1,$2,'loan_officer',true,false,'x',0,$3) RETURNING id`,
        [`tsp-${name.toLowerCase().replace(/\W+/g, '')}-${sfx}@test.local`, name, nmls])).rows[0].id;
      ids.staff.push(id); return id;
    };
    const adminId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Owner Admin','super_admin',true,false,'x',0) RETURNING id`, [`tsp-admin-${sfx}@test.local`])).rows[0].id;
    ids.staff.push(adminId);
    const tok = C.signJwt({ sub: adminId, kind: 'staff', role: 'super_admin', tv: 0 });
    const loA = await mkStaff('First Officer', 'NMLS-111');
    const loB = await mkStaff('Second Officer', 'NMLS-222');

    const mkB = async (first, last) => {
      const id = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ($1,$2,$3) RETURNING id`,
        [first, last, `tsp-${first.toLowerCase()}-${sfx}@test.local`])).rows[0].id;
      ids.borrowers.push(id); return id;
    };
    const b1 = await mkB('Pat', 'Borrower'), b2 = await mkB('Chris', 'Coborrower');
    const appId = (await db.query(
      `INSERT INTO applications (ys_loan_number, borrower_id, co_borrower_id, loan_officer_id, status, loan_type, property_address, loan_amount)
       VALUES ($1,$2,$3,$4,'file_intake','Purchase','{"oneLine":"1 Main St, Town, NY"}',400000) RETURNING id`,
      [`YSCAP-TSP-${sfx}`, b1, b2, loA])).rows[0].id;
    ids.apps.push(appId);

    const pricing = () => call(server, 'GET', `/api/staff/applications/${appId}/pricing`, tok);

    // ── A. the fresh read names the officer, with the NMLS the screen never had ──
    let r = await pricing();
    assert.strictEqual(r.status, 200, `pricing GET answered ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    const p = r.body.parties;
    assert.ok(p && p.loanOfficer, 'parties.loanOfficer is present on an assigned file');
    assert.strictEqual(p.loanOfficer.name, 'First Officer');
    assert.ok(/^tsp-firstofficer-/.test(p.loanOfficer.email), 'the officer email is the staff record\'s');
    assert.strictEqual(p.loanOfficer.nmls, 'NMLS-111', 'the NMLS rides along — the screen never carried it');
    assert.strictEqual(p.coBorrowerName, 'Chris Coborrower', 'the co-borrower half still answers');
    ok('the pricing read names the assigned officer with email and NMLS');

    // ── B. ONE definition: the send's own row through the same function agrees ──
    const row = await orchestrate.loadApplication(db, appId);
    const fromSend = orchestrate.loanOfficerSigner(row);
    assert.deepStrictEqual({ name: fromSend.name, email: fromSend.email },
      { name: p.loanOfficer.name, email: p.loanOfficer.email },
      'the officer the send would put on the package is the officer the studio draws');
    ok('the studio and the send name the same officer through one function');

    // ── C. reassigned AFTER the page loaded — the next read already has it ──────
    await db.query(`UPDATE applications SET loan_officer_id = $2 WHERE id = $1`, [appId, loB]);
    r = await pricing();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.parties.loanOfficer.name, 'Second Officer', 'the reassignment is on the next read, no page refresh');
    assert.strictEqual(r.body.parties.loanOfficer.nmls, 'NMLS-222');
    const row2 = await orchestrate.loadApplication(db, appId);
    assert.strictEqual(orchestrate.loanOfficerSigner(row2).email, r.body.parties.loanOfficer.email, 'and the send agrees about the new officer too');
    ok('an officer assigned after the screen loaded is drawn on the next sheet');

    // ── D. a typed officer name with no staff record signs nothing ──────────────
    await db.query(`UPDATE applications SET loan_officer_id = NULL, loan_officer_name = 'Typed Only' WHERE id = $1`, [appId]);
    r = await pricing();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.parties.loanOfficer, null, 'no staff record → no signing officer → no line on the sheet');
    const row3 = await orchestrate.loadApplication(db, appId);
    assert.strictEqual(orchestrate.loanOfficerSigner(row3), null, 'and the send puts nobody on the package either');
    ok('a typed-only officer name is not a signer on either side');

    // The roster itself, on the package the studio serves: the officer it seats is
    // the pricing read's officer — asserted on the ROSTER, not the helper, so a
    // roster that stops calling the helper is caught.
    await db.query(`UPDATE applications SET loan_officer_id = $2 WHERE id = $1`, [appId, loA]);
    const row4 = await orchestrate.loadApplication(db, appId);
    const spec = orchestrate.packageSpec('term_sheet_package');
    const roster = orchestrate.buildRoster(row4, spec, null);
    const lo = roster.find((x) => x.role === 'loan_officer');
    const fresh = (await pricing()).body.parties.loanOfficer;
    assert.ok(lo, 'the term-sheet package seats the officer');
    assert.strictEqual(lo.email, fresh.email);
    assert.strictEqual(lo.name, fresh.name);
    ok('the package roster seats exactly the officer the studio draws');

    console.log(`\ntest-esign-term-sheet-parties-db: ${checks} checks passed\n`);
  } finally {
    try {
      for (const a of ids.apps) await db.query(`DELETE FROM applications WHERE id = $1`, [a]);
      for (const b of ids.borrowers) await db.query(`DELETE FROM borrowers WHERE id = $1`, [b]);
      for (const s of ids.staff) await db.query(`DELETE FROM staff_users WHERE id = $1`, [s]);
    } catch (_) { /* best-effort cleanup */ }
    server.close();
  }
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.message); console.error(e && e.stack); process.exit(1); });
