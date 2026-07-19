/**
 * End-to-end test for the appraisal import service (src/lib/appraisal/import).
 * Requires a Postgres (DATABASE_URL) with the migrations applied. Seeds a borrower +
 * application with deliberate mismatches, imports a real appraisal XML, and asserts the
 * appraisal / comparables / findings rows landed and the file was filled with the shield.
 *
 *   DATABASE_URL=... APPRAISAL_DIR=... node scripts/test-appraisal-import.js
 *
 * Skips cleanly (exit 0) when no DATABASE_URL — matches the other DB-optional tests.
 */
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) { console.log('SKIP test-appraisal-import (no DATABASE_URL)'); process.exit(0); }

const { Pool } = require('pg');
const { importAppraisal } = require('../src/lib/appraisal/import');

const DIR = process.env.APPRAISAL_DIR
  || '/tmp/claude-0/-home-user-yscap/05b5356c-9672-5e08-9492-67ecffd77817/scratchpad/appraisals/stripped';
const FILE = process.env.APPRAISAL_FILE || 'Completed_Product_(Data)_08108509.xml';

let failures = 0;
function assert(cond, msg) { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; }

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = { query: (t, p) => pool.query(t, p) };
  try {
    const suffix = String(process.pid);
    const b = await pool.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Test','Importer',$1) RETURNING id`,
      [`appr-import-${suffix}@example.test`]);
    const borrowerId = b.rows[0].id;
    // File with deliberate mismatches: units 2 (appraisal 3), arv 560k (appraisal 575k),
    // as_is_value NULL (so the shield fills it), purchase 415k (matches).
    const a = await pool.query(
      `INSERT INTO applications (borrower_id, property_address, property_type, units, purchase_price, arv, as_is_value)
       VALUES ($1, $2, 'Multi 2-4', 2, 415000, 560000, NULL) RETURNING id`,
      [borrowerId, JSON.stringify({ line: '148 Plymouth St, New Haven, CT' })]);
    const appId = a.rows[0].id;

    const xml = fs.readFileSync(path.join(DIR, FILE), 'utf8');
    const res = await importAppraisal(db, { applicationId: appId, xml, today: '2026-07-19' });

    assert(res.ok, 'import returned ok');
    assert(res.appraisalId, 'got an appraisal id');

    const ap = await pool.query(`SELECT * FROM appraisals WHERE id=$1`, [res.appraisalId]);
    assert(ap.rows[0].form_type === 'FNM1025', 'stored form_type FNM1025');
    assert(Number(ap.rows[0].arv_value) === 575000, 'stored ARV 575000');
    assert(Number(ap.rows[0].as_is_value) === 430000, 'stored As-Is 430000 (definite)');
    assert(ap.rows[0].baths_full === 3, 'stored baths_full=3');

    const comps = await pool.query(`SELECT count(*)::int n FROM appraisal_comparables WHERE appraisal_id=$1`, [res.appraisalId]);
    assert(comps.rows[0].n >= 5, `stored comparables (${comps.rows[0].n})`);

    const units = await pool.query(`SELECT count(*)::int n FROM appraisal_units WHERE appraisal_id=$1`, [res.appraisalId]);
    assert(units.rows[0].n === 3, `stored 3 per-unit rents (${units.rows[0].n})`);

    const fnd = await pool.query(`SELECT code, severity, blocks_ctc FROM appraisal_findings WHERE appraisal_id=$1`, [res.appraisalId]);
    const codes = fnd.rows.map((r) => r.code);
    assert(codes.includes('units_mismatch'), 'raised units_mismatch finding');
    assert(codes.includes('arv_mismatch'), 'raised arv_mismatch finding');
    assert(res.summary.fatal >= 2, `summary fatal >= 2 (${res.summary.fatal})`);
    assert(res.summary.blocksCtc === true, 'summary blocksCtc = true');

    // overwrite-shield: As-Is was NULL -> filled from definite; ARV differed -> NOT overwritten.
    const fileRow = await pool.query(`SELECT arv, as_is_value FROM applications WHERE id=$1`, [appId]);
    assert(Number(fileRow.rows[0].as_is_value) === 430000, 'file As-Is filled from definite (was null)');
    assert(Number(fileRow.rows[0].arv) === 560000, 'file ARV NOT overwritten (shield held the human 560000)');

    // supersede on re-import
    const res2 = await importAppraisal(db, { applicationId: appId, xml, today: '2026-07-19' });
    const cur = await pool.query(`SELECT count(*)::int n FROM appraisals WHERE application_id=$1 AND superseded=false`, [appId]);
    assert(res2.ok && cur.rows[0].n === 1, 'a re-import supersedes the prior (one current row)');

    // cleanup — delete the application first (cascades appraisals/comps/units/findings),
    // then the borrower (applications FK is ON DELETE RESTRICT).
    await pool.query(`DELETE FROM applications WHERE borrower_id=$1`, [borrowerId]);
    await pool.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]);
  } catch (e) {
    console.log('FAIL threw:', e.message); failures++;
  } finally {
    await pool.end();
  }
  console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL import assertions passed'}`);
  process.exit(failures ? 1 : 0);
})();
