'use strict';
/**
 * DB test — the property type is NEVER blank; it is derived from the unit count
 * (db/382, owner-directed 2026-07-31: "when PILOT says 1 unit the ClickUp
 * property type dropdown should say SFR, and same with 2-4").
 *
 *   DATABASE_URL=postgres://… node scripts/test-property-type-default-db.js
 *
 * Proves, against a real Postgres:
 *   1. pilot_property_type_from_units(): 1/unknown → SFR, 2-4 → Multi 2-4, 5+ → Multi 5+.
 *   2. A file inserted with a BLANK property type is auto-filled from its unit
 *      count at insert, on EVERY write path (the BEFORE trigger).
 *   3. An explicit property type is left untouched (never overwritten).
 *   4. A unit count arriving later fills a still-blank type (BEFORE UPDATE OF units).
 *   5. The boot backfill fills every pre-existing blank row (previous-and-future).
 *   6. The SFR / Multi 2-4 fill is reprice-neutral; a Multi 5+ fill (an eligibility
 *      change) still reopens Products & Pricing.
 */
const R = require('path').resolve(__dirname, '..');

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP property-type default DB test (no DATABASE_URL)'); return; }
  const db = require(R + '/src/db');
  const fs = require('fs');
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
  const rnd = () => 'ptypedef' + Math.random() + '@e.com';

  // db/322 (re-applied by a sibling test in the shared suite) reverts the reopen
  // fn; restore the newest chain so this test always runs the production trigger.
  await db.query(fs.readFileSync(R + '/db/382_default_deal_program.sql', 'utf8'));
  await db.query(fs.readFileSync(R + '/db/383_default_property_type.sql', 'utf8'));

  const mkApp = async (propertyType, units) => {
    const b = await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('P','D',$1) RETURNING id`, [rnd()]);
    const a = await db.query(
      `INSERT INTO applications(borrower_id,property_type,units) VALUES($1,$2,$3) RETURNING id`,
      [b.rows[0].id, propertyType, units]);
    return a.rows[0].id;
  };
  const mkReg = async (appId) => (await db.query(
    `INSERT INTO product_registrations(application_id,program,status,total_loan,inputs,quote,is_current)
     VALUES ($1,'standard','ELIGIBLE',500000,'{}','{}',true) RETURNING id`, [appId])).rows[0].id;
  const ptOf = async (id) => (await db.query(`SELECT property_type FROM applications WHERE id=$1`, [id])).rows[0].property_type;
  const staleOf = async (id) => (await db.query(`SELECT stale FROM product_registrations WHERE id=$1`, [id])).rows[0].stale;

  // ---- 1. the pure helper ---------------------------------------------------
  const fromUnits = async (u) => (await db.query(`SELECT pilot_property_type_from_units($1) AS v`, [u])).rows[0].v;
  ok(await fromUnits(1) === 'SFR (1 unit)', '1 unit → SFR (1 unit)');
  ok(await fromUnits(2) === 'Multi 2–4', '2 units → Multi 2–4');
  ok(await fromUnits(4) === 'Multi 2–4', '4 units → Multi 2–4');
  ok(await fromUnits(5) === 'Multi 5+', '5 units → Multi 5+');
  ok(await fromUnits(12) === 'Multi 5+', '12 units → Multi 5+');
  ok(await fromUnits(0) === 'SFR (1 unit)', '0 units → SFR (the never-blank default)');
  ok(await fromUnits(null) === 'SFR (1 unit)', 'unknown units → SFR (the never-blank default)');

  // ---- 2. insert auto-fills a blank type from the unit count ----------------
  ok(await ptOf(await mkApp(null, 1)) === 'SFR (1 unit)', 'insert blank + 1 unit → SFR (1 unit)');
  ok(await ptOf(await mkApp('', 3)) === 'Multi 2–4', 'insert blank + 3 units → Multi 2–4');
  ok(await ptOf(await mkApp('   ', 6)) === 'Multi 5+', 'insert whitespace + 6 units → Multi 5+');
  ok(await ptOf(await mkApp(null, null)) === 'SFR (1 unit)', 'insert with neither → SFR (never blank)');

  // ---- 3. an explicit type is never overwritten -----------------------------
  ok(await ptOf(await mkApp('Condo', 1)) === 'Condo', 'an explicit Condo is left untouched');
  ok(await ptOf(await mkApp('Multi 2–4', 1)) === 'Multi 2–4', 'an explicit type wins over the unit-count default');

  // ---- 4. a unit count arriving later fills a still-blank type ---------------
  // Simulate a legacy blank row (bypass the fill trigger), then set units.
  const legacy = await mkApp('SFR (1 unit)', 1);
  await db.query(`ALTER TABLE applications DISABLE TRIGGER trg_default_property_type`);
  await db.query(`UPDATE applications SET property_type=NULL, units=3 WHERE id=$1`, [legacy]);
  await db.query(`ALTER TABLE applications ENABLE TRIGGER trg_default_property_type`);
  await db.query(`UPDATE applications SET units=3 WHERE id=$1`, [legacy]);   // BEFORE UPDATE OF units fills the blank
  ok(await ptOf(legacy) === 'Multi 2–4', 'a unit count set on a blank-type row fills the type');

  // ---- 5. the boot backfill fills pre-existing blank rows --------------------
  const back = await mkApp('SFR (1 unit)', 4);
  await db.query(`ALTER TABLE applications DISABLE TRIGGER trg_default_property_type`);
  await db.query(`UPDATE applications SET property_type=NULL WHERE id=$1`, [back]);
  await db.query(`ALTER TABLE applications ENABLE TRIGGER trg_default_property_type`);
  await db.query(fs.readFileSync(R + '/db/383_default_property_type.sql', 'utf8'));   // re-run the backfill
  ok(await ptOf(back) === 'Multi 2–4', 'the boot backfill fills a pre-existing blank row from its unit count');

  // ---- 6. reprice-neutral SFR/2-4 fill; Multi 5+ fill reopens P&P ------------
  const neutral = await mkApp('SFR (1 unit)', 1);
  const rNeutral = await mkReg(neutral);
  await db.query(`ALTER TABLE applications DISABLE TRIGGER trg_default_property_type`);
  await db.query(`UPDATE applications SET property_type=NULL WHERE id=$1`, [neutral]);
  await db.query(`ALTER TABLE applications ENABLE TRIGGER trg_default_property_type`);
  await db.query(`UPDATE product_registrations SET stale=false WHERE id=$1`, [rNeutral]);
  await db.query(`UPDATE applications SET property_type='SFR (1 unit)' WHERE id=$1`, [neutral]);
  ok(await staleOf(rNeutral) === false, 'a blank → SFR (1 unit) fill is reprice-neutral');

  const five = await mkApp('SFR (1 unit)', 6);   // insert auto-fills Multi 5+, but set explicit for clarity
  await db.query(`UPDATE applications SET property_type='SFR (1 unit)' WHERE id=$1`, [five]);
  const rFive = await mkReg(five);
  await db.query(`ALTER TABLE applications DISABLE TRIGGER trg_default_property_type`);
  await db.query(`UPDATE applications SET property_type=NULL WHERE id=$1`, [five]);
  await db.query(`ALTER TABLE applications ENABLE TRIGGER trg_default_property_type`);
  await db.query(`UPDATE product_registrations SET stale=false WHERE id=$1`, [rFive]);
  await db.query(`UPDATE applications SET property_type='Multi 5+' WHERE id=$1`, [five]);
  ok(await staleOf(rFive) === true, 'a blank → Multi 5+ fill (an eligibility change) still reopens Products & Pricing');

  console.log(`  property-type default DB: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
