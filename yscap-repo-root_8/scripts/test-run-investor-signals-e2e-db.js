'use strict';
/*
 * #256 — the wired investor-guideline signals must not just be GATHERED, they must
 * actually SURFACE as findings in a persisted whole-loan run. The per-signal tests
 * prove gatherInvestorInputs returns the right values; this proves the WHOLE chain:
 *   gatherInvestorInputs (reads the appraisal)  →  assembleRun (merges investorInputs)
 *   →  investor-guideline-review.review() (the rules fire)  →  assembled.findings
 *   →  persistRun (INSERT into underwriting_run_findings).
 *
 * A file whose CURRENT appraisal is in a FEMA Special Flood Hazard Area AND a Rural
 * neighborhood must produce BOTH the isg_flood_zone_needs_insurance and the
 * isg_rural_property findings on the run (both are all-buyers rules, so they fire
 * regardless of note buyer — no buyer plumbing needed for a robust assertion;
 * buyer-specific rules are covered by the pure tests).
 *
 * Requires DATABASE_URL; SKIPs otherwise. persistRun commits real rows, so this
 * cleans up by deleting the application (underwriting_runs* + appraisals are
 * ON DELETE CASCADE) + its shadow_decisions + the borrower.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-run-investor-signals-e2e-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const { runWholeLoan } = require('../src/lib/underwriting/run');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = { query: (t, p) => pool.query(t, p), pool };
  let bId = null, aId = null;
  try {
    const email = 'isge2e+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    bId = (await pool.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth)
         VALUES ('ISG','E2E',$1,'1985-01-01') RETURNING id`, [email])).rows[0].id;
    // Claim 2 flips of experience but leave NONE verified (no track_records) → claimed_exp(2) >
    // verified_exp(0), which fires the all-buyers isg_experience_claimed_over_verified. This
    // covers a DIFFERENT gather path than the appraisal columns — the experience.js reuse (#258).
    aId = (await pool.query(
      `INSERT INTO applications (borrower_id, requested_exp_flips) VALUES ($1, 2) RETURNING id`, [bId])).rows[0].id;

    // A current appraisal that is BOTH in a Special Flood Hazard Area AND Rural.
    await pool.query(
      `INSERT INTO appraisals (application_id, superseded, imported_at, fema_flood_sfha, nbhd_location_type)
         VALUES ($1, false, now(), true, 'Rural')`, [aId]);

    // The full run — gather → assembleRun → review → persistRun.
    const res = await runWholeLoan(aId, db, { trigger: 'e2e_isg' });
    assert.ok(res && res.runId, 'runWholeLoan persisted a run');
    ok('the whole-loan run executes and persists with the investor signals present');

    const codes = (await pool.query(
      `SELECT code FROM underwriting_run_findings WHERE run_id = $1`, [res.runId])).rows.map((r) => r.code);

    assert.ok(codes.includes('isg_flood_zone_needs_insurance'),
      `expected isg_flood_zone_needs_insurance in the run findings, got: ${codes.join(', ') || '(none)'}`);
    ok('the flood-zone appraisal surfaces isg_flood_zone_needs_insurance in the persisted run (full chain)');

    assert.ok(codes.includes('isg_rural_property'),
      `expected isg_rural_property in the run findings, got: ${codes.join(', ') || '(none)'}`);
    ok('the rural appraisal surfaces isg_rural_property in the persisted run (full chain)');

    // #258 — the experience.js reuse path (claimed 2, verified 0) also reaches the registry.
    assert.ok(codes.includes('isg_experience_claimed_over_verified'),
      `expected isg_experience_claimed_over_verified in the run findings, got: ${codes.join(', ') || '(none)'}`);
    ok('claimed-over-verified experience surfaces isg_experience_claimed_over_verified (experience.js path, full chain)');

    console.log(`\nISG signals end-to-end (#256/#258) db — ${passed} checks passed`);
  } finally {
    if (aId) {
      await pool.query(`DELETE FROM shadow_decisions WHERE application_id=$1`, [aId]).catch(() => {});
      await pool.query(`DELETE FROM applications WHERE id=$1`, [aId]).catch(() => {}); // cascades underwriting_runs* + appraisals
    }
    if (bId) await pool.query(`DELETE FROM borrowers WHERE id=$1`, [bId]).catch(() => {});
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
