/**
 * Integration test: the appraisal module <-> the MISMO 3.4 loan module.
 *
 * Proves the two-way flow the owner asked for:
 *   A) appraisal import FILLS the file (as_is/arv/appraiser) -> the MISMO 3.4 export
 *      (src/lib/mismo) then CARRIES those values out.  ("import your info over there")
 *   B) when the file already holds a DIFFERENT value, the appraisal import does NOT
 *      overwrite it and instead opens an underwriter review (a fatal finding).
 *      ("if anything is not matching you open it up as an underwriter review")
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
const fs = require('fs');
const path = require('path');
if (!process.env.DATABASE_URL) { console.log('SKIP test-appraisal-mismo-integration (no DATABASE_URL)'); process.exit(0); }

const { Pool } = require('pg');
const { importAppraisal } = require('../src/lib/appraisal/import');
const mismo = require('../src/lib/mismo');

const DIR = process.env.APPRAISAL_DIR
  || '/tmp/claude-0/-home-user-yscap/05b5356c-9672-5e08-9492-67ecffd77817/scratchpad/appraisals/stripped';
const FILE = 'Completed_Product_(Data)_08108509.xml'; // 1025: As-Is 430k, ARV 575k, appraiser Louis J Mihalakos

let failures = 0;
function assert(c, m) { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; }

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = { query: (t, p) => pool.query(t, p) };
  const xml = fs.readFileSync(path.join(DIR, FILE), 'utf8');
  try {
    // ---- Scenario A: blank file, appraisal fills it, MISMO export carries it out ----
    const b1 = (await pool.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Flow','A',$1) RETURNING id`,
      [`flow-a-${process.pid}@example.test`])).rows[0].id;
    const app1 = (await pool.query(
      `INSERT INTO applications (borrower_id, property_address, property_type, program, loan_type, loan_amount)
       VALUES ($1,$2,'Multi 2-4','Fix & Flip','Purchase',400000) RETURNING id`,
      [b1, JSON.stringify({ line: '148 Plymouth St, New Haven, CT' })])).rows[0].id;

    const rA = await importAppraisal(db, { applicationId: app1, xml, today: '2026-07-19' });
    assert(rA.ok, 'A: appraisal import ok');

    const fileA = (await pool.query(`SELECT as_is_value, arv, appraiser_name FROM applications WHERE id=$1`, [app1])).rows[0];
    assert(Number(fileA.as_is_value) === 430000, 'A: file As-Is filled from appraisal (430000)');
    assert(Number(fileA.arv) === 575000, 'A: file ARV filled from appraisal (575000)');
    assert(/Mihalakos/.test(fileA.appraiser_name || ''), 'A: file appraiser_name filled from appraisal');

    // the MISMO 3.4 export must now CARRY those values out
    const outXml = await mismo.exportApplicationXml(app1);
    assert(typeof outXml === 'string' && outXml.length > 0, 'A: MISMO export produced XML');
    assert(outXml.includes('430000'), 'A: MISMO export carries the As-Is (430000)');
    assert(outXml.includes('575000'), 'A: MISMO export carries the ARV (575000)');
    assert(/Mihalakos/.test(outXml), 'A: MISMO export carries the appraiser name');

    // ---- Scenario B: file already holds a DIFFERENT arv -> not overwritten + review opened ----
    const b2 = (await pool.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Flow','B',$1) RETURNING id`,
      [`flow-b-${process.pid}@example.test`])).rows[0].id;
    const app2 = (await pool.query(
      `INSERT INTO applications (borrower_id, property_address, property_type, units, arv, as_is_value)
       VALUES ($1,$2,'Multi 2-4',3,560000,430000) RETURNING id`,
      [b2, JSON.stringify({ line: '148 Plymouth St, New Haven, CT' })])).rows[0].id;

    const rB = await importAppraisal(db, { applicationId: app2, xml, today: '2026-07-19' });
    const fileB = (await pool.query(`SELECT arv FROM applications WHERE id=$1`, [app2])).rows[0];
    assert(Number(fileB.arv) === 560000, 'B: differing file ARV NOT overwritten (kept 560000)');
    const rev = (await pool.query(
      `SELECT count(*)::int n FROM appraisal_findings WHERE application_id=$1 AND code='arv_mismatch' AND severity='fatal' AND blocks_ctc=true`, [app2])).rows[0].n;
    assert(rev === 1, 'B: a fatal arv_mismatch underwriter review was opened');
    assert(rB.summary.blocksCtc === true, 'B: findings block clear-to-close');

    // cleanup (applications first — FK RESTRICT to borrowers)
    await pool.query(`DELETE FROM applications WHERE borrower_id = ANY($1)`, [[b1, b2]]);
    await pool.query(`DELETE FROM borrowers WHERE id = ANY($1)`, [[b1, b2]]);
  } catch (e) {
    console.log('FAIL threw:', e.message); failures++;
  } finally {
    await pool.end();
  }
  console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL integration assertions passed'}`);
  process.exit(failures ? 1 : 0);
})();
