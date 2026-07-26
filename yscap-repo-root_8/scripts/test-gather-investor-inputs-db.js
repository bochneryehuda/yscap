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

    // 1. A completed credit pull TIED TO THE BORROWER → fico_credit reads the real column.
    //    (#260 — the gather ties the report to each borrower via borrower_id and takes the
    //    higher-of-two once all borrowers are pulled; a report with the wrong/no borrower_id
    //    must not drive the priced-FICO comparison.)
    await pool.query(
      `INSERT INTO credit_reports (application_id, borrower_id, status, middle_score, pulled_at)
         VALUES ($1,$2,'completed',712, now())`, [aId, bId]);
    {
      const out = await gatherInvestorInputs(aId, db);
      assert.strictEqual(out.fico_credit, 712, 'single-borrower file → fico_credit is that borrower’s middle score');
      ok('a completed, borrower-tied credit report populates fico_credit from the real schema');
    }

    // 1b. #260 — co-borrower higher-of-two + never-false-fire on incomplete credit. Add a
    //     co-borrower with a LOWER score → fico_credit stays the HIGHER (712), never the latest pull.
    const coId = (await pool.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth)
         VALUES ('Co','Borrower',$1,'1986-02-02') RETURNING id`,
      ['isgco+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com'])).rows[0].id;
    await pool.query(`UPDATE applications SET co_borrower_id=$2 WHERE id=$1`, [aId, coId]);
    {
      // Co-borrower not pulled yet → higher-of-two isn't final → fico_credit OMITTED (no false fire).
      const out = await gatherInvestorInputs(aId, db);
      assert.ok(!('fico_credit' in out), 'co-borrower unpulled → fico_credit omitted (never judge on incomplete credit)');
      ok('a co-borrower file with the co-borrower not yet pulled omits fico_credit (no false fire)');
    }
    // Pull the co-borrower LATER (more recent) with a LOWER score → fico_credit is the HIGHER (712),
    // NOT the latest pull (680) — the bug that false-fired the FATAL mismatch is fixed.
    await pool.query(
      `INSERT INTO credit_reports (application_id, borrower_id, status, middle_score, pulled_at)
         VALUES ($1,$2,'completed',680, now() + interval '1 minute')`, [aId, coId]);
    {
      const out = await gatherInvestorInputs(aId, db);
      assert.strictEqual(out.fico_credit, 712, 'both pulled → fico_credit is the higher-of-two (712), not the latest pull (680)');
      ok('co-borrower both pulled → fico_credit is the higher-of-two, immune to which pull is newest');
    }
    // Restore the single-borrower shape for the rest of the suite (experience/cash-out sections
    // assume the primary borrower only); the co-borrower row is cleaned up with the app cascade.
    await pool.query(`UPDATE applications SET co_borrower_id=NULL WHERE id=$1`, [aId]);
    await pool.query(`DELETE FROM credit_reports WHERE borrower_id=$1`, [coId]);
    await pool.query(`DELETE FROM borrowers WHERE id=$1`, [coId]);

    // 2. A current appraisal in a FEMA Special Flood Hazard Area → appraisal_present true
    //    AND in_flood_zone true (proven), reading the real db/150 flood columns.
    const apprInsert = (extra) => pool.query(
      `INSERT INTO appraisals (application_id, superseded, imported_at, fema_flood_sfha, fema_flood_zone, flood_zone, nbhd_location_type, condition_of_appraisal)
         VALUES ($1, false, now(), $2, $3, $4, $5, $6) RETURNING id`,
      [aId, extra.sfha, extra.femaZone, extra.statedZone, extra.loc == null ? null : extra.loc, extra.cond == null ? null : extra.cond]);

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

    // 4b. APPRAISAL_RURAL (#254) — from the current appraisal's UAD neighborhood location type.
    await pool.query(`UPDATE appraisals SET superseded = true WHERE application_id = $1 AND superseded = false`, [aId]);
    await apprInsert({ sfha: null, femaZone: null, statedZone: null, loc: 'Rural' });
    {
      const out = await gatherInvestorInputs(aId, db);
      assert.strictEqual(out.appraisal_rural, true, 'a Rural neighborhood → appraisal_rural true');
      ok('a Rural appraisal sets appraisal_rural true (real nbhd_location_type column)');
    }
    await pool.query(`UPDATE appraisals SET superseded = true WHERE application_id = $1 AND superseded = false`, [aId]);
    await apprInsert({ sfha: null, femaZone: null, statedZone: null, loc: 'Suburban' });
    {
      const out = await gatherInvestorInputs(aId, db);
      assert.strictEqual(out.appraisal_rural, false, 'a Suburban neighborhood → appraisal_rural false');
      ok('a Suburban appraisal sets appraisal_rural false (escalation stays silent)');
    }

    // 4c. APPRAISAL_MID_CONSTRUCTION (#255) — SubjectToCompletion → true; SubjectToRepairs → false.
    await pool.query(`UPDATE appraisals SET superseded = true WHERE application_id = $1 AND superseded = false`, [aId]);
    await apprInsert({ sfha: null, femaZone: null, statedZone: null, cond: 'SubjectToCompletion' });
    {
      const out = await gatherInvestorInputs(aId, db);
      assert.strictEqual(out.appraisal_mid_construction, true, 'SubjectToCompletion → appraisal_mid_construction true');
      ok('a SubjectToCompletion appraisal sets appraisal_mid_construction true (real condition_of_appraisal column)');
    }
    await pool.query(`UPDATE appraisals SET superseded = true WHERE application_id = $1 AND superseded = false`, [aId]);
    await apprInsert({ sfha: null, femaZone: null, statedZone: null, cond: 'SubjectToRepairs' });
    {
      const out = await gatherInvestorInputs(aId, db);
      assert.strictEqual(out.appraisal_mid_construction, false, 'SubjectToRepairs → appraisal_mid_construction false');
      ok('a SubjectToRepairs appraisal → appraisal_mid_construction false (a rehab, not construction)');
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
      // The 5-year-old flip is a KNOWN exit older than 36 months → has_stale_exit true (#252).
      assert.strictEqual(out.has_stale_exit, true, 'the 5-year-old exit → has_stale_exit true');
      ok('a claimed exit older than 3 years surfaces has_stale_exit true (reuses EXIT_DATE_SQL)');
    }

    // Remove every stale (>36 months) exit → has_stale_exit becomes a real false (checked, none stale).
    await pool.query(
      `DELETE FROM track_records WHERE borrower_id=$1 AND sale_date < (CURRENT_DATE - INTERVAL '36 months')`, [bId]);
    {
      const out = await gatherInvestorInputs(aId, db);
      assert.strictEqual(out.has_stale_exit, false, 'with no stale exits → has_stale_exit false (not omitted, not true)');
      ok('once the old exit is gone, has_stale_exit is a real false');
    }

    // 6. CASH-OUT (#253) — is_cash_out from the ECONOMIC classification (refinance_economic_type),
    //    cash_out_proceeds from verified/estimated (real db/267 columns).
    await pool.query(
      `UPDATE applications SET refinance_economic_type='cash_out', verified_cash_out=300000, estimated_cash_out=999999 WHERE id=$1`, [aId]);
    {
      const out = await gatherInvestorInputs(aId, db);
      assert.strictEqual(out.is_cash_out, true, 'economic cash_out → is_cash_out true');
      assert.strictEqual(out.cash_out_proceeds, 300000, 'cash_out_proceeds reads the verified number');
      ok('an economic cash-out surfaces is_cash_out + verified cash_out_proceeds (real db/267 columns)');
    }
    await pool.query(`UPDATE applications SET refinance_economic_type='rate_term' WHERE id=$1`, [aId]);
    {
      const out = await gatherInvestorInputs(aId, db);
      assert.strictEqual(out.is_cash_out, false, 'rate_term → is_cash_out false');
      assert.ok(!('cash_out_proceeds' in out), 'rate_term → cash_out_proceeds omitted');
      ok('a rate-and-term refi → is_cash_out false, proceeds omitted (escalation stays silent)');
    }

    // 7. EMCAP rental signals (2026-07-26) — is_fix_hold from the real strategy columns,
    //    loan_estimated_rent from applications.estimated_rental_income (db/311),
    //    appraisal_is_1025 from appraisals.form_type, appraisal_market_rent from
    //    est_market_monthly_rent (else the summed appraisal_units.market_rent). Real columns.
    await pool.query(`UPDATE applications SET program='Fix & Hold', loan_type='Purchase', rehab_type='moderate', estimated_rental_income=2500 WHERE id=$1`, [aId]);
    await pool.query(`UPDATE appraisals SET superseded=true WHERE application_id=$1 AND superseded=false`, [aId]);
    await pool.query(
      `INSERT INTO appraisals (application_id, superseded, imported_at, form_type, est_market_monthly_rent)
         VALUES ($1, false, now(), 'FNM1004', 2500)`, [aId]);
    {
      const out = await gatherInvestorInputs(aId, db);
      assert.strictEqual(out.is_fix_hold, true, 'Fix & Hold program → is_fix_hold true');
      assert.strictEqual(out.loan_estimated_rent, 2500, 'loan_estimated_rent reads applications.estimated_rental_income (db/311)');
      assert.strictEqual(out.appraisal_is_1025, false, 'FNM1004 → appraisal_is_1025 false');
      assert.strictEqual(out.appraisal_market_rent, 2500, 'appraisal_market_rent reads est_market_monthly_rent');
      ok('EMCAP: is_fix_hold + loan_estimated_rent + appraisal 1025/market-rent from real columns');
    }
    // A 1025 with a blank subject rent → appraisal_is_1025 true, and the summed per-unit
    // market rents drive appraisal_market_rent (the 1025 rent schedule).
    await pool.query(`UPDATE appraisals SET superseded=true WHERE application_id=$1 AND superseded=false`, [aId]);
    const em1025 = (await pool.query(
      `INSERT INTO appraisals (application_id, superseded, imported_at, form_type, est_market_monthly_rent)
         VALUES ($1, false, now(), 'FNM1025', NULL) RETURNING id`, [aId])).rows[0].id;
    await pool.query(`INSERT INTO appraisal_units (appraisal_id, unit_seq, market_rent) VALUES ($1,'1',1200),($1,'2',1300)`, [em1025]);
    {
      const out = await gatherInvestorInputs(aId, db);
      assert.strictEqual(out.appraisal_is_1025, true, 'FNM1025 → appraisal_is_1025 true');
      assert.strictEqual(out.appraisal_market_rent, 2500, 'summed per-unit market rents (1200+1300) drive appraisal_market_rent when the subject figure is blank');
      ok('EMCAP: a 1025 sets appraisal_is_1025 + sums per-unit market rents for the rent match');
    }
    // A non-fix-hold strategy → is_fix_hold false (the 1007 rule is inert).
    await pool.query(`UPDATE applications SET program='Fix & Flip', rehab_type='heavy' WHERE id=$1`, [aId]);
    {
      const out = await gatherInvestorInputs(aId, db);
      assert.strictEqual(out.is_fix_hold, false, 'Fix & Flip → is_fix_hold false');
      ok('a non-fix-hold strategy sets is_fix_hold false');
    }

    console.log(`\ngatherInvestorInputs (#250 flood + #251 exp + #252 stale + #253 cash-out + EMCAP + #232) db — ${passed} checks passed`);
  } finally {
    if (aId) await pool.query(`DELETE FROM applications WHERE id=$1`, [aId]).catch(() => {}); // cascades appraisals + credit_reports
    if (bId) await pool.query(`DELETE FROM borrowers WHERE id=$1`, [bId]).catch(() => {});
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
