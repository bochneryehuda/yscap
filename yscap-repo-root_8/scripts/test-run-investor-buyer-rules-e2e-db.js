'use strict';
/*
 * #263 — the BUYER-SPECIFIC investor-guideline rules must surface end-to-end, not just the
 * all-buyers ones. The #256/#258 integration test proves the all-buyers signals (flood / rural /
 * experience) persist; those fire regardless of note buyer, so they don't exercise the note-buyer
 * plumbing at all. This proves the OTHER half of the chain:
 *   applications.lender ('Blue Lake')  →  whole-loan-context note_buyer (from app.lender)
 *   →  gatherInvestorInputs (reads refinance_economic_type + verified_cash_out, and the current
 *      appraisal's condition_of_appraisal)  →  assembleRun (merges investorInputs)
 *   →  investor-guideline-review.review() with buyerMatches keying the note buyer via the SHARED
 *      normNoteBuyer (#262)  →  the Blue-Lake-audience rules fire  →  persistRun.
 *
 * A Blue Lake file with cash-out proceeds over $250k AND a SubjectToCompletion (mid-construction)
 * appraisal must produce BOTH isg_bl_cashout_over_250k and isg_bl_mid_construction on the run —
 * proof the note buyer actually carries from the lender label all the way to a persisted
 * buyer-specific finding. This is the end-to-end guard for the #259/#260/#261/#262 note-buyer work.
 *
 * Requires DATABASE_URL; SKIPs otherwise. persistRun commits real rows, so this cleans up by
 * deleting the application (underwriting_runs* + appraisals are ON DELETE CASCADE) + its
 * shadow_decisions + the borrower.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-run-investor-buyer-rules-e2e-db (no DATABASE_URL)'); process.exit(0); }
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
    const email = 'isgbuyer+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    bId = (await pool.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth)
         VALUES ('ISG','Buyer',$1,'1985-01-01') RETURNING id`, [email])).rows[0].id;

    // The note buyer is applications.lender — a free-text dropdown label; the whole-loan context
    // carries it into note_buyer, and buyerMatches keys it with the shared normNoteBuyer
    // ('Blue Lake' → 'bluelake'). refinance_economic_type='cash_out' + verified_cash_out=300000
    // (> $250k) drives the Blue Lake cash-out escalation via the economic classification.
    aId = (await pool.query(
      `INSERT INTO applications (borrower_id, lender, refinance_economic_type, verified_cash_out)
         VALUES ($1, 'Blue Lake', 'cash_out', 300000) RETURNING id`, [bId])).rows[0].id;

    // A current appraisal that is SubjectToCompletion → appraisal_mid_construction === true →
    // the Blue Lake mid-construction escalation.
    await pool.query(
      `INSERT INTO appraisals (application_id, superseded, imported_at, condition_of_appraisal)
         VALUES ($1, false, now(), 'SubjectToCompletion')`, [aId]);

    // The full run — gather → assembleRun → review (buyerMatches) → persistRun.
    const res = await runWholeLoan(aId, db, { trigger: 'e2e_isg_buyer' });
    assert.ok(res && res.runId, 'runWholeLoan persisted a run');
    ok('the whole-loan run executes and persists for a Blue Lake file');

    const codes = (await pool.query(
      `SELECT code FROM underwriting_run_findings WHERE run_id = $1`, [res.runId])).rows.map((r) => r.code);

    assert.ok(codes.includes('isg_bl_cashout_over_250k'),
      `expected isg_bl_cashout_over_250k (Blue Lake, cash-out > $250k) in the run findings, got: ${codes.join(', ') || '(none)'}`);
    ok('a Blue Lake cash-out over $250k surfaces isg_bl_cashout_over_250k (note buyer carried from lender, full chain)');

    assert.ok(codes.includes('isg_bl_mid_construction'),
      `expected isg_bl_mid_construction (Blue Lake, SubjectToCompletion) in the run findings, got: ${codes.join(', ') || '(none)'}`);
    ok('a SubjectToCompletion appraisal on a Blue Lake file surfaces isg_bl_mid_construction (full chain)');

    // Negative guard: the SAME data on a DIFFERENT note buyer must NOT surface the Blue Lake
    // escalations (no cross-buyer over-fire — the keying-contract holds end-to-end, not just in
    // the pure test). Re-label the file CorrFirst and re-run.
    await pool.query(`UPDATE applications SET lender = 'CorrFirst' WHERE id = $1`, [aId]);
    const res2 = await runWholeLoan(aId, db, { trigger: 'e2e_isg_buyer_neg' });
    const codes2 = (await pool.query(
      `SELECT code FROM underwriting_run_findings WHERE run_id = $1`, [res2.runId])).rows.map((r) => r.code);
    assert.ok(!codes2.includes('isg_bl_cashout_over_250k'),
      'a CorrFirst file does NOT surface the Blue Lake cash-out escalation (no cross-buyer over-fire)');
    assert.ok(!codes2.includes('isg_bl_mid_construction'),
      'a CorrFirst file does NOT surface the Blue Lake mid-construction escalation');
    ok('the same data on a different note buyer does NOT fire the Blue Lake escalations (keying holds end-to-end)');

    console.log(`\nISG buyer-specific rules end-to-end (#263) db — ${passed} checks passed`);
  } finally {
    if (aId) {
      await pool.query(`DELETE FROM shadow_decisions WHERE application_id=$1`, [aId]).catch(() => {});
      await pool.query(`DELETE FROM applications WHERE id=$1`, [aId]).catch(() => {}); // cascades underwriting_runs* + appraisals
    }
    if (bId) await pool.query(`DELETE FROM borrowers WHERE id=$1`, [bId]).catch(() => {});
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
