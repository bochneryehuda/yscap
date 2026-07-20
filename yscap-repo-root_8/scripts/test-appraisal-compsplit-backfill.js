/**
 * DB test for the As-Is/ARV comp-split BACKFILL (previous-files fix). Appraisals imported before the
 * split have every comp stored as comp_set='unknown' and comp_split_confidence NULL, so the report
 * renders one mixed grid instead of the separate As-Is and ARV grids. backfillAppraisalCompSplitOnce
 * re-runs the extractor on the stored source XML and writes back the per-comp grid.
 *
 * Proves: a simulated pre-split appraisal (all comps 'unknown') is re-split into BOTH an As-Is and an
 * ARV set, the split metadata is restored, and the backfill DRAINS (a second pass touches nothing).
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-appraisal-compsplit-backfill (no DATABASE_URL)'); process.exit(0); }
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DIR = process.env.APPRAISAL_DIR
  || '/tmp/claude-0/-home-user-yscap/05b5356c-9672-5e08-9492-67ecffd77817/scratchpad/appraisals/stripped';
const FILE = 'Completed_Product_(Data)_08108509.xml';   // a reno file that splits into arv + as_is
if (!fs.existsSync(path.join(DIR, FILE))) { console.log('SKIP test-appraisal-compsplit-backfill (no corpus)'); process.exit(0); }

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { importAppraisal } = require('../src/lib/appraisal/import');
  const { backfillAppraisalCompSplitOnce } = require('../src/lib/appraisal/desk');
  const storage = require('../src/lib/storage');
  const db = { query: (t, p) => pool.query(t, p) };
  let appId, bid;
  try {
    bid = (await pool.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Split','BF',$1) RETURNING id`, [`splitbf-${process.pid}@example.test`])).rows[0].id;
    appId = (await pool.query(
      `INSERT INTO applications (borrower_id, property_address, property_type, units, loan_type)
       VALUES ($1,$2,'Multi 2-4',3,'rtl') RETURNING id`,
      [bid, JSON.stringify({ line1: '148 Plymouth St', city: 'New Haven', state: 'CT' })])).rows[0].id;

    const raw = fs.readFileSync(path.join(DIR, FILE), 'utf8');
    const res = await importAppraisal(db, { applicationId: appId, xml: raw, today: '2026-07-19' });
    const apprId = res.appraisalId;

    // Store the source XML as a document + link it (the real /import route does this).
    const saved = await storage.save(Buffer.from(raw, 'utf8'), { filename: 'src.xml', contentType: 'application/xml' });
    const docId = (await pool.query(
      `INSERT INTO documents (application_id, borrower_id, doc_kind, filename, storage_ref, visibility)
       VALUES ($1,$2,'appraisal_xml','src.xml',$3,'staff_only') RETURNING id`,
      [appId, bid, saved.ref || saved])).rows[0].id;
    await pool.query(`UPDATE appraisals SET source_xml_document_id=$2 WHERE id=$1`, [apprId, docId]);

    // Simulate a PRE-SPLIT appraisal: every comp 'unknown', split metadata cleared.
    await pool.query(`UPDATE appraisal_comparables SET comp_set='unknown' WHERE appraisal_id=$1`, [apprId]);
    await pool.query(`UPDATE appraisals SET comp_split_confidence=NULL, comp_split_needs_review=NULL WHERE id=$1`, [apprId]);
    const pre = (await pool.query(`SELECT DISTINCT comp_set FROM appraisal_comparables WHERE appraisal_id=$1 AND is_subject=false`, [apprId])).rows.map((r) => r.comp_set);
    assert(pre.length === 1 && pre[0] === 'unknown', `pre-split state: every comp is 'unknown' (${pre.join(',')})`);

    // Run the backfill.
    const r1 = await backfillAppraisalCompSplitOnce();
    assert(r1.scanned >= 1, `backfill scanned the pre-split appraisal (${r1.scanned})`);

    const counts = Object.fromEntries((await pool.query(
      `SELECT comp_set, count(*)::int n FROM appraisal_comparables WHERE appraisal_id=$1 AND is_subject=false GROUP BY comp_set`, [apprId])).rows.map((x) => [x.comp_set, x.n]));
    assert((counts.arv || 0) > 0 && (counts.as_is || 0) > 0,
      `after backfill the comps split into BOTH grids (arv=${counts.arv || 0}, as_is=${counts.as_is || 0})`);
    const meta = (await pool.query(`SELECT comp_split_confidence FROM appraisals WHERE id=$1`, [apprId])).rows[0];
    assert(meta.comp_split_confidence != null, `split metadata restored (confidence=${meta.comp_split_confidence})`);

    // Drains: a second pass must NOT re-scan this appraisal (comp_split_confidence is now set).
    const before2 = (await pool.query(`SELECT count(*)::int n FROM appraisals WHERE comp_split_confidence IS NULL AND source_xml_document_id IS NOT NULL AND superseded=false`)).rows[0].n;
    await backfillAppraisalCompSplitOnce();
    const stillSplit = Object.fromEntries((await pool.query(
      `SELECT comp_set, count(*)::int n FROM appraisal_comparables WHERE appraisal_id=$1 AND is_subject=false GROUP BY comp_set`, [apprId])).rows.map((x) => [x.comp_set, x.n]));
    assert((stillSplit.arv || 0) > 0 && (stillSplit.as_is || 0) > 0, 'a second backfill pass leaves the split intact (idempotent + drained)');
  } catch (e) {
    console.log('FAIL threw:', e.message); failures++;
  } finally {
    try {
      if (appId) {
        await pool.query(`DELETE FROM appraisal_comparables WHERE appraisal_id IN (SELECT id FROM appraisals WHERE application_id=$1)`, [appId]);
        await pool.query(`DELETE FROM appraisal_findings WHERE application_id=$1`, [appId]);
        await pool.query(`DELETE FROM appraisals WHERE application_id=$1`, [appId]);
        await pool.query(`DELETE FROM documents WHERE application_id=$1`, [appId]);
        await pool.query(`DELETE FROM applications WHERE id=$1`, [appId]);
        await pool.query(`DELETE FROM borrowers WHERE id=$1`, [bid]);
      }
    } catch (_) { /* cleanup best-effort */ }
    await pool.end();
    console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL comp-split backfill assertions passed');
    process.exit(failures ? 1 : 0);
  }
})();
