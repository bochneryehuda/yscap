'use strict';
/*
 * #250 (+ #232) — gatherInvestorInputs against a REAL Postgres. The pure test mocks
 * db.query, so it CANNOT catch a wrong-column bug (the same class as the b.full_name
 * phantom that left the whole-loan run dark in #248). This runs the real queries against
 * the real schema: credit_reports.middle_score/status/pulled_at, appraisals.superseded/
 * imported_at, and the flood columns db/150 adds (fema_flood_sfha / fema_flood_zone /
 * flood_zone). If any of those column names drift, THIS test fails — the mock never would.
 *
 * Requires DATABASE_URL; SKIPs otherwise. Cleans up by deleting the application
 * (appraisals + credit_reports are ON DELETE CASCADE) + the borrower.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-gather-investor-inputs-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const { gatherInvestorInputs } = require('../src/lib/underwriting/run');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = { query: (t, p) => pool.query(t, p) };
  let bId = null, aId = null;
  try {
    const email = 'isgin+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    bId = (await pool.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth)
         VALUES ('ISG','Inputs',$1,'1985-01-01') RETURNING id`, [email])).rows[0].id;
    aId = (await pool.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [bId])).rows[0].id;

    // 0. Empty file: no credit report, no appraisal → every signal omitted, never invented.
    {
      const out = await gatherInvestorInputs(aId, db);
      assert.ok(!('fico_credit' in out), 'no credit report → fico_credit omitted');
      assert.ok(!('appraisal_present' in out), 'no appraisal → appraisal_present omitted');
      assert.ok(!('in_flood_zone' in out), 'no appraisal → in_flood_zone omitted');
      ok('an empty file omits every investor signal (never fabricated)');
    }

    // 1. A completed credit pull with a middle score → fico_credit reads the real column.
    await pool.query(
      `INSERT INTO credit_reports (application_id, status, middle_score, pulled_at)
         VALUES ($1,'completed',712, now())`, [aId]);
    {
      const out = await gatherInvestorInputs(aId, db);
      assert.strictEqual(out.fico_credit, 712, 'fico_credit reads credit_reports.middle_score');
      ok('a completed credit report populates fico_credit from the real schema');
    }

    // 2. A current appraisal in a FEMA Special Flood Hazard Area → appraisal_present true
    //    AND in_flood_zone true (proven), reading the real db/150 flood columns.
    const apprInsert = (extra) => pool.query(
      `INSERT INTO appraisals (application_id, superseded, imported_at, fema_flood_sfha, fema_flood_zone, flood_zone)
         VALUES ($1, false, now(), $2, $3, $4) RETURNING id`,
      [aId, extra.sfha, extra.femaZone, extra.statedZone]);

    let apprId = (await apprInsert({ sfha: true, femaZone: 'AE', statedZone: 'AE' })).rows[0].id;
    {
      const out = await gatherInvestorInputs(aId, db);
      assert.strictEqual(out.appraisal_present, true, 'a current appraisal sets appraisal_present');
      assert.strictEqual(out.in_flood_zone, true, 'a Special Flood Hazard Area appraisal sets in_flood_zone true');
      ok('a current SFHA appraisal sets appraisal_present + in_flood_zone true (real flood columns)');
    }

    // 3. Supersede that appraisal, add a current NON-flood one (stated zone X, SFHA false) →
    //    in_flood_zone is a real false (checked, not in a zone), NOT true and NOT omitted.
    await pool.query(`UPDATE appraisals SET superseded = true WHERE id = $1`, [apprId]);
    apprId = (await apprInsert({ sfha: false, femaZone: 'X', statedZone: 'X' })).rows[0].id;
    {
      const out = await gatherInvestorInputs(aId, db);
      assert.strictEqual(out.in_flood_zone, false, 'a checked non-SFHA appraisal sets in_flood_zone false');
      ok('the newest (non-flood) appraisal wins → in_flood_zone false, not stale true');
    }

    // 4. Supersede again, add a current appraisal with NO flood determination (all NULL) →
    //    in_flood_zone OMITTED (not checked → never guessed either way).
    await pool.query(`UPDATE appraisals SET superseded = true WHERE id = $1`, [apprId]);
    await apprInsert({ sfha: null, femaZone: null, statedZone: null });
    {
      const out = await gatherInvestorInputs(aId, db);
      assert.strictEqual(out.appraisal_present, true, 'appraisal still present');
      assert.ok(!('in_flood_zone' in out), 'a not-checked appraisal omits in_flood_zone (never fabricated)');
      ok('a not-checked appraisal keeps appraisal_present but omits in_flood_zone');
    }

    // 5. CLAIMED vs VERIFIED EXPERIENCE (#251) — reuses experience.js against the REAL
    //    track_records schema + the frozen 3-year exit window. No claim yet → both omitted.
    {
      const out = await gatherInvestorInputs(aId, db);
      assert.ok(!('claimed_exp' in out), 'no experience claimed → claimed_exp omitted');
      assert.ok(!('verified_exp' in out), 'no experience claimed → verified_exp omitted');
      ok('a file with no claimed experience omits claimed/verified (never a fabricated 0)');
    }

    // Claim 3 deals on the file (2 flips + 1 hold).
    await pool.query(
      `UPDATE applications SET requested_exp_flips=2, requested_exp_holds=1, requested_exp_ground=0 WHERE id=$1`, [aId]);

    // Track record for the borrower: 1 VERIFIED recent flip, 1 UNVERIFIED recent flip,
    // 1 VERIFIED but OLD flip (exited >3y ago → outside the frozen window). Only the first counts.
    const tr = (dealType, verified, saleOffset) => pool.query(
      `INSERT INTO track_records (borrower_id, deal_type, purchase_price, sale_price, sale_date, is_verified)
         VALUES ($1,$2,200000,260000, (CURRENT_DATE - ($3 || ' months')::interval), $4)`,
      [bId, dealType, String(saleOffset), verified]);
    await tr('flip', true, 6);     // verified, exited 6 months ago → counts
    await tr('flip', false, 6);    // unverified, recent → does NOT count (verifiedOnly)
    await tr('flip', true, 60);    // verified but 5 years ago → outside the 3-year window → does NOT count
    {
      const out = await gatherInvestorInputs(aId, db);
      assert.strictEqual(out.claimed_exp, 3, 'claimed_exp = requested_exp sum (3)');
      assert.strictEqual(out.verified_exp, 1, 'verified_exp counts only the verified, recent-exit deal (1)');
      ok('claimed 3 vs verified 1 — only verified + in-window deals count (frozen 3yr window reused)');
    }

    console.log(`\ngatherInvestorInputs (#250 flood + #251 experience + #232) db — ${passed} checks passed`);
  } finally {
    if (aId) await pool.query(`DELETE FROM applications WHERE id=$1`, [aId]).catch(() => {}); // cascades appraisals + credit_reports
    if (bId) await pool.query(`DELETE FROM borrowers WHERE id=$1`, [bId]).catch(() => {});
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
