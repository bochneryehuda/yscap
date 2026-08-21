'use strict';
/**
 * THE NON-OWNER-OCCUPIED CERTIFICATION CAN ACTUALLY BE SENT (db/603).
 *
 * `noo_affidavit` is a live e-sign package — orchestrate.PACKAGES entry, PDF builder,
 * its own condition (db/417), a send-time guard — and the staff send route accepts any
 * purpose present in PACKAGES, so it is reachable. But `chk_esign_purpose` (last defined
 * by db/206) admitted only term_sheet_package / heter_iska / test / draw_request, so the
 * INSERT that creates the envelope was refused with 23514 and the route answered a 500
 * "server error". The package had never once been sendable.
 *
 * THE REPLAY IS THE REAL TEST. db/138, db/153 and db/206 each re-add this constraint under
 * the SAME name on EVERY boot, and they run BEFORE db/603. Widening under a new name would
 * let them re-narrow it; this proves the widened constraint is what SURVIVES a second boot,
 * not merely what a single fresh apply produces.
 *
 * Run: DATABASE_URL=... node scripts/test-esign-noo-purpose-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-esign-noo-purpose-db (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const orchestrate = require('../src/lib/esign/orchestrate');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; return; }
  fail++; console.error('  FAIL:', name, extra == null ? '' : `\n        ${extra}`);
};

/**
 * Can a row with this purpose be stored? Asks the DATABASE, never the constraint's text.
 *
 * It builds a REAL borrower + application first: `chk_esign_test_appless` allows an
 * envelope with no application only when is_test is set, so an app-less probe is refused
 * by THAT constraint whatever the purpose says — which would have made every case here
 * look identical and the whole test vacuous. Everything runs inside one transaction that
 * is always rolled back, so nothing is left behind.
 *
 * The purpose check is isolated by asserting on the CONSTRAINT NAME: any other refusal is
 * re-thrown rather than quietly reported as "not admitted".
 */
async function admits(purpose) {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    const b = (await c.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Noo','Probe',$1) RETURNING id`,
      [`noo.probe.${Date.now().toString(36)}.${Math.floor(process.hrtime()[1] / 1000)}@example.com`])).rows[0].id;
    const a = (await c.query(
      `INSERT INTO applications (borrower_id, property_address, loan_amount)
       VALUES ($1,'{"oneLine":"1 Probe St, Town, NY"}',100000) RETURNING id`, [b])).rows[0].id;
    await c.query(`INSERT INTO esign_envelopes (application_id, purpose, status) VALUES ($1,$2,'not_sent')`, [a, purpose]);
    return true;
  } catch (e) {
    if (e.code === '23514' && /chk_esign_purpose/.test(String(e.message))) return false;
    throw e;
  } finally {
    try { await c.query('ROLLBACK'); } catch (_) { /* the connection is going back anyway */ }
    c.release();
  }
}

(async () => {
  await require('../src/migrate-boot').ensureSchema();

  // The fix only matters because the package is REACHABLE: the send route admits any
  // purpose in PACKAGES. If NOO ever leaves that map this test should be revisited, not
  // silently kept passing.
  ok('noo_affidavit is a real package the send route would accept', !!orchestrate.PACKAGES.noo_affidavit);

  ok('the database stores a noo_affidavit envelope', await admits('noo_affidavit'));

  // The four that already worked must still work — a widening may never drop a value.
  for (const p of ['term_sheet_package', 'heter_iska', 'test', 'draw_request']) {
    ok(`…and still stores a ${p} envelope`, await admits(p));
  }

  // The constraint is still a constraint: this is what would fail if somebody "fixed" the
  // replay hazard by dropping the check instead of widening it.
  ok('a purpose that is not a package is still refused', (await admits('not_a_package')) === false);

  // THE REPLAY. db/138/153/206 re-add this constraint under the same name on every boot.
  await require('../src/migrate-boot').ensureSchema();
  ok('a SECOND boot leaves noo_affidavit storable (db/206 does not re-narrow it)', await admits('noo_affidavit'));
  ok('…and the refusal survives that replay too', (await admits('not_a_package')) === false);

  console.log(`test-esign-noo-purpose-db: ${pass} passed, ${fail} failed`);
  await db.pool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
