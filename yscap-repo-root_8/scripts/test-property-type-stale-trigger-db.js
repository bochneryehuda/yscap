'use strict';
/**
 * DB test — the semantic PROPERTY TYPE comparison in the reopen trigger and the
 * heal (db/322), the fix for the owner-reported 2026-07-26 re-register prompt
 * "Property type: FNM1025 → Multi 2–4; Term: 12 → 12 Months".
 *
 *   DATABASE_URL=postgres://… node scripts/test-property-type-stale-trigger-db.js
 *
 * Proves, against a real Postgres:
 *   1. The SQL twins agree with the JS module (src/lib/property-type.js) on every
 *      spelling — a drift between them re-arms the whole bug class.
 *   2. A cosmetic property-type re-spelling ("Multi 2-4" → "Multi 2–4" →
 *      "multi_2_4", from ANY door) NEVER flags the current registration stale,
 *      and neither does replacing a stored appraisal FORM number with the real
 *      type (that is a repair of bad data, not a re-price).
 *   3. A REAL property-type change still flags it stale, with the itemized reason.
 *   4. pilot_reason_is_cosmetic() clears the owner's exact COMBINED reason, which
 *      the narrower db/288 heal could not reach, while leaving a reason that
 *      names any real change alone.
 *   5. A file that already stored a form code is REPAIRED to the category the
 *      form is written for, audited — and the repair does not re-flag it stale.
 */
const R = require('path').resolve(__dirname, '..');

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP property-type stale trigger DB test (no DATABASE_URL)'); return; }
  const db = require(R + '/src/db');
  const PT = require(R + '/src/lib/property-type');
  const fs = require('fs');
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
  const rnd = () => 'ptypetrig' + Math.random() + '@e.com';
  // Section 5 re-applies db/322, whose CREATE OR REPLACE of the reopen trigger is
  // the db/322-era body — reverting db/381 (program default) and db/382 (property
  // units-fill) in this shared test DB. applyLatest() restores the newest chain so
  // the function under test is the real production one (382 wins on every boot).
  const applyLatest = async () => {
    await db.query(fs.readFileSync(R + '/db/382_default_deal_program.sql', 'utf8'));
    await db.query(fs.readFileSync(R + '/db/383_default_property_type.sql', 'utf8'));
  };

  async function mkApp(propertyType, term) {
    const b = await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('P','T',$1) RETURNING id`, [rnd()]);
    const a = await db.query(
      `INSERT INTO applications(borrower_id,property_type,term,units,expected_closing)
       VALUES($1,$2,$3,2,'2026-09-01') RETURNING id`, [b.rows[0].id, propertyType, term]);
    return a.rows[0].id;
  }
  async function mkReg(appId) {
    const r = await db.query(
      `INSERT INTO product_registrations(application_id, program, status, total_loan, inputs, quote, is_current)
       VALUES ($1,'standard','ELIGIBLE',500000,'{"term":12}','{}',true) RETURNING id`, [appId]);
    return r.rows[0].id;
  }
  const regState = async (id) => (await db.query(`SELECT stale, stale_reason FROM product_registrations WHERE id=$1`, [id])).rows[0];
  const ptOf = async (id) => (await db.query(`SELECT property_type FROM applications WHERE id=$1`, [id])).rows[0].property_type;

  // ---- 1. the SQL twins must agree with the JS module ----------------------
  // A drift here is the whole bug class coming back: the trigger and the app
  // layer would disagree about what "the same property type" means.
  // 1004D IS IN THIS LIST ON PURPOSE. The SQL and the JS drifted for a whole
  // release precisely because no sample carried that spelling: db/432 taught the
  // JS that the Appraisal UPDATE form proves nothing, and db/322's SQL twin went
  // on answering "sfr" — so every boot rewrote a 1400-1402-Stratford two-family
  // to "SFR (1 unit)" and audited it as a repair. This assertion is the guard.
  const SAMPLES = ['FNM1025', 'FNM 1025', 'fnm-1025', '1025', 'FNM1004', 'FNM1073', 'URAR', '2055',
    'FNM1004D', 'fnm 1004d', '1004D', '1004-d', 'FNM1004C', '1004c',
    'Multi 2–4', 'Multi 2-4', 'multi_2_4', '2-4 Family', 'Duplex', 'Triplex',
    'SFR (1 unit)', 'sfr', 'Single Family', 'Detached', 'Multi 5+', 'multi_5_plus',
    'Condo', 'Co-Op', 'Townhouse', 'PUD', 'Mixed use', 'New Construction', '', null];
  for (const v of SAMPLES) {
    const r = (await db.query(
      `SELECT pilot_is_appraisal_form_code($1) AS form,
              pilot_property_type_norm($1) AS norm,
              pilot_appraisal_form_property_key($1) AS formkey`, [v])).rows[0];
    ok(r.form === PT.isAppraisalFormCode(v), `SQL/JS agree that ${JSON.stringify(v)} is${r.form ? '' : ' not'} a form code`);
    ok(r.norm === PT.propertyTypeCompareKey(v), `SQL/JS agree on the compare key for ${JSON.stringify(v)} (sql=${r.norm} js=${PT.propertyTypeCompareKey(v)})`);
    ok(r.formkey === PT.guessFromFormCode(v), `SQL/JS agree on the form→category map for ${JSON.stringify(v)}`);
  }

  // ---- 2. the trigger: a re-spelling is NOT a change -----------------------
  let app = await mkApp('Multi 2-4', '12');            // the ClickUp spelling
  let reg = await mkReg(app);
  await db.query(`UPDATE applications SET property_type='Multi 2–4' WHERE id=$1`, [app]);   // portal echo (en dash)
  let st = await regState(reg);
  ok(st.stale === false, 'hyphen → en-dash re-spelling does NOT stale the registration (the reported bug)');
  await db.query(`UPDATE applications SET property_type='multi_2_4' WHERE id=$1`, [app]);   // Condition Center key
  st = await regState(reg);
  ok(st.stale === false, 'the rule KEY vs the portal LABEL does not stale');
  await db.query(`UPDATE applications SET property_type='MULTI 2-4' WHERE id=$1`, [app]);   // case-only
  st = await regState(reg);
  ok(st.stale === false, 'case-only re-spelling does not stale');

  // …and a REAL change still does, itemized.
  await db.query(`UPDATE applications SET property_type='Condo' WHERE id=$1`, [app]);
  st = await regState(reg);
  ok(st.stale === true, 'a REAL property-type change still stales the registration');
  ok(/Property type: MULTI 2-4 → Condo/.test(st.stale_reason || ''), 'the reason itemizes the real old → new type');

  // ---- 3. replacing a stored FORM CODE is a repair, not a re-price ---------
  app = await mkApp('FNM1025', '12 Months');
  reg = await mkReg(app);
  await db.query(`UPDATE applications SET property_type='Multi 2–4' WHERE id=$1`, [app]);
  st = await regState(reg);
  ok(st.stale === false, 'correcting a stored appraisal form number does NOT demand a re-register');

  // The property type is NEVER blank now (db/382): a file inserted with a NULL
  // type is auto-filled from the unit count at insert (units=2 → 'Multi 2–4'), so
  // a genuinely-blank type can no longer exist on a live row.
  await applyLatest();   // guarantee the newest reopen fn regardless of prior test-DB state
  app = await mkApp(null, '12');   // mkApp inserts units=2
  reg = await mkReg(app);
  ok((await ptOf(app)) === 'Multi 2–4', 'a NULL property type is auto-filled from the unit count at insert (never blank)');

  // A BACKFILL-style fill of a legacy blank row to its units-CONSISTENT default
  // (SFR for 1 unit / Multi 2-4 for 2-4 units) is reprice-neutral (db/382) — a
  // blank and an eligible SFR/2-4 price identically, so it must NOT stale the
  // registration. Simulate the legacy blank by bypassing the fill trigger.
  await db.query(`ALTER TABLE applications DISABLE TRIGGER trg_default_property_type`);
  await db.query(`UPDATE applications SET property_type=NULL WHERE id=$1`, [app]);
  await db.query(`ALTER TABLE applications ENABLE TRIGGER trg_default_property_type`);
  await db.query(`UPDATE product_registrations SET stale=false, stale_reason=NULL WHERE id=$1`, [reg]);
  await db.query(`UPDATE applications SET property_type='Multi 2–4' WHERE id=$1`, [app]);   // the db/382 backfill value (units=2)
  st = await regState(reg);
  ok(st.stale === false, 'a units-consistent blank→Multi 2-4 fill is reprice-neutral (db/382 backfill)');

  // But a units-INCONSISTENT blank fill (units=2 filled with something other than
  // Multi 2-4) is a real change and still stales — the suppression is narrow.
  await db.query(`ALTER TABLE applications DISABLE TRIGGER trg_default_property_type`);
  await db.query(`UPDATE applications SET property_type=NULL WHERE id=$1`, [app]);
  await db.query(`ALTER TABLE applications ENABLE TRIGGER trg_default_property_type`);
  await db.query(`UPDATE product_registrations SET stale=false, stale_reason=NULL WHERE id=$1`, [reg]);
  await db.query(`UPDATE applications SET property_type='Condo' WHERE id=$1`, [app]);
  st = await regState(reg);
  ok(st.stale === true, 'a units-inconsistent blank fill (units=2 → Condo) is still a real change');

  // ---- 4. pilot_reason_is_cosmetic on the owner's EXACT reported string ----
  const cos = async (d) => (await db.query(`SELECT pilot_reason_is_cosmetic($1) AS c`, [d])).rows[0].c;
  ok(await cos('Property type: FNM1025 → Multi 2–4; Term: 12 → 12 Months') === true,
    'the owner\'s exact combined reason is recognized as entirely cosmetic');
  ok(await cos('Term: 12 → 12 Months') === true, 'a term-only echo is cosmetic');
  ok(await cos('Property type: Multi 2-4 → Multi 2–4') === true, 'a property-type-only re-spelling is cosmetic');
  ok(await cos('Property type: FNM1025 → Multi 2–4; Loan amount: $500,000 → $520,000') === false,
    'a reason naming a REAL money change is NOT cosmetic');
  ok(await cos('Property type: SFR (1 unit) → Multi 2–4; Term: 12 → 12 Months') === false,
    'a reason naming a REAL type change is NOT cosmetic');
  ok(await cos('Term: 12 → 18 Months') === false, 'a REAL term change is NOT cosmetic');
  ok(await cos('Units: 2 → 3') === false, 'an item shape the heal does not understand is NOT cosmetic');
  ok(await cos('') === false && await cos(null) === false, 'an empty reason is never cosmetic');

  // ---- 5. the heal clears a registration stuck on the combined reason ------
  // Seed the exact broken state the owner is looking at, then re-run the
  // migration (every boot replays it) and assert it healed.
  app = await mkApp('Multi 2–4', '12 Months');
  reg = await mkReg(app);
  await db.query(
    `UPDATE product_registrations SET stale=true,
       stale_reason='Pricing inputs changed — Property type: FNM1025 → Multi 2–4; Term: 12 → 12 Months. Re-register the product and issue a new term sheet.'
     WHERE id=$1`, [reg]);
  // …and one that names a REAL change, which must survive untouched.
  const appReal = await mkApp('Condo', '12');
  const regReal = await mkReg(appReal);
  const realReason = 'Pricing inputs changed — Property type: SFR (1 unit) → Condo; Loan amount: $500,000 → $520,000. Re-register the product and issue a new term sheet.';
  await db.query(`UPDATE product_registrations SET stale=true, stale_reason=$2 WHERE id=$1`, [regReal, realReason]);

  // A file that still stores a form code, to prove the repair step.
  const appForm = await mkApp('FNM1025', '12 Months');
  const regForm = await mkReg(appForm);

  await db.query(fs.readFileSync(R + '/db/322_property_type_semantic_compare.sql', 'utf8'));
  await applyLatest();   // db/322 reverted the reopen fn; restore 381+382 for the rest of the suite

  st = await regState(reg);
  ok(st.stale === false && st.stale_reason === null,
    'the heal clears the registration stuck on the combined cosmetic reason (db/288 could not reach it)');
  st = await regState(regReal);
  ok(st.stale === true && st.stale_reason === realReason,
    'a registration whose reason names a REAL change is left alone');

  // The repair rewrote the form code to the category the 1025 form is for…
  ok(await ptOf(appForm) === 'Multi 2–4', 'a stored FNM1025 is repaired to "Multi 2–4" (the 2–4 unit form)');
  // …without demanding a re-register…
  st = await regState(regForm);
  ok(st.stale === false, 'the form-code repair does not flag the registration stale');
  // …and it is on the record.
  const aud = (await db.query(
    `SELECT detail FROM audit_log WHERE action='property_type_form_code_repaired' AND entity_id=$1`, [appForm])).rows[0];
  ok(!!aud && aud.detail.from === 'FNM1025' && aud.detail.to === 'Multi 2–4', 'the repair is audited from → to');

  // Idempotent: a second boot finds nothing left to repair.
  await db.query(fs.readFileSync(R + '/db/322_property_type_semantic_compare.sql', 'utf8'));
  const audCount = (await db.query(
    `SELECT count(*)::int n FROM audit_log WHERE action='property_type_form_code_repaired' AND entity_id=$1`, [appForm])).rows[0].n;
  ok(audCount === 1, 'replaying the migration does not re-repair or double-audit');

  console.log(`  property-type stale trigger DB: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
  await db.pool.end().catch(() => {});
})().catch((e) => { console.error(e); process.exit(1); });
