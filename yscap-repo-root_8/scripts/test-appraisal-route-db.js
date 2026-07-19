/**
 * DB-level test of the appraisal ROUTE's new SQL (src/routes/appraisal.js):
 * materialize the review condition, and resolve a finding with "replace" -> writes the
 * value back to applications (which trips the reprice trigger) and marks the finding resolved.
 * The route's auth/routing is standard express; this exercises the risky new SQL directly.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-appraisal-route-db (no DATABASE_URL)'); process.exit(0); }
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { importAppraisal } = require('../src/lib/appraisal/import');

const DIR = process.env.APPRAISAL_DIR
  || '/tmp/claude-0/-home-user-yscap/05b5356c-9672-5e08-9492-67ecffd77817/scratchpad/appraisals/stripped';
const FILE = 'Completed_Product_(Data)_08108509.xml';
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const bid = (await pool.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Route','Test',$1) RETURNING id`, [`route-${process.pid}@example.test`])).rows[0].id;
    const appId = (await pool.query(
      `INSERT INTO applications (borrower_id, property_address, property_type, units, arv, as_is_value)
       VALUES ($1,$2,'Multi 2-4',3,560000,430000) RETURNING id`,
      [bid, JSON.stringify({ line: '148 Plymouth St, New Haven, CT' })])).rows[0].id;

    const xml = fs.readFileSync(path.join(DIR, FILE), 'utf8');
    await importAppraisal({ query: (t, p) => pool.query(t, p) }, { applicationId: appId, xml, today: '2026-07-19' });

    // --- ensureCondition SQL (mirrors the route's /import helper: template_id + vesting pattern) ---
    const ENSURE = `INSERT INTO checklist_items
       (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
        phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
        clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id)
     SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
            COALESCE(t.role_scope,'any'), t.phase, t.hint, t.borrower_hint,
            COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
            COALESCE(t.sort_order,455), t.tool_key, t.clickup_field_id,
            COALESCE(t.tpr_exclude,false), 'system', COALESCE(t.is_required,true), $1
       FROM checklist_templates t
      WHERE t.code=$2 AND t.is_active=true
        AND NOT EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.application_id=$1 AND ci.template_id=t.id)`;
    const condSql = `SELECT ci.status FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
                     WHERE ci.application_id=$1 AND t.code='appraisal_review_cleared'`;
    await pool.query(ENSURE, [appId, 'appraisal_review_cleared']);
    const cond = (await pool.query(condSql, [appId])).rows;
    assert(cond.length === 1 && cond[0].status === 'outstanding', 'review-cleared condition materialized as outstanding');
    await pool.query(ENSURE, [appId, 'appraisal_review_cleared']); // idempotent
    const cond2 = (await pool.query(`SELECT count(*)::int n FROM (${condSql}) x`, [appId])).rows[0].n;
    assert(cond2 === 1, 'materialize is idempotent (no duplicate condition)');

    // --- OCR advisory note-write SQL (route's /import As-Is branch) ---
    // Materialize the verify-As-Is condition, then write an advisory note onto it exactly
    // as the route does (UPDATE checklist_items FROM checklist_templates by code). The OCR
    // network call is best-effort and not exercised here; the note-write SQL is the risk.
    const { buildOcrNote } = require('../src/lib/appraisal/ocr');
    await pool.query(ENSURE, [appId, 'appraisal_as_is_verify']);
    const advNote = buildOcrNote({ attempted: true, candidate: 431000, confidence: 'single-match', snippet: "'as is' value $431,000" });
    // The [auto]-guarded UPDATE (route uses the same CASE WHEN): only writes a null/[auto] note.
    const ADV_SQL = `UPDATE checklist_items ci
        SET notes = CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%' THEN $2 ELSE ci.notes END
        FROM checklist_templates t
       WHERE ci.template_id=t.id AND t.code='appraisal_as_is_verify' AND ci.application_id=$1`;
    const readNote = async () => (await pool.query(
      `SELECT ci.notes FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code='appraisal_as_is_verify'`, [appId])).rows[0];
    await pool.query(ADV_SQL, [appId, advNote]);
    let noteRow = await readNote();
    assert(noteRow && /OCR/.test(noteRow.notes) && /431,000/.test(noteRow.notes), 'OCR advisory note written onto the verify-As-Is condition');
    assert(noteRow && /NOT been applied|never filled/i.test(noteRow.notes), 'advisory note states the value was not applied to the file');
    assert(noteRow && /^\[auto\]/.test(noteRow.notes), 'advisory note is [auto]-prefixed');
    // A human types their own note; a re-import must NOT clobber it.
    await pool.query(
      `UPDATE checklist_items ci SET notes='Officer: confirmed As-Is $428,000 from page 3.'
         FROM checklist_templates t WHERE ci.template_id=t.id AND t.code='appraisal_as_is_verify' AND ci.application_id=$1`, [appId]);
    await pool.query(ADV_SQL, [appId, buildOcrNote({ attempted: true, candidate: 999999, confidence: 'single-match' })]);
    noteRow = await readNote();
    assert(noteRow && /Officer: confirmed/.test(noteRow.notes) && !/999,999/.test(noteRow.notes), 'a human-typed note is preserved on re-import (not clobbered)');

    // --- resolve the arv_mismatch with "replace" (route's /findings/:fid/resolve) ---
    const fnd = (await pool.query(`SELECT * FROM appraisal_findings WHERE application_id=$1 AND code='arv_mismatch' AND status='open'`, [appId])).rows[0];
    assert(!!fnd, 'arv_mismatch finding is open before resolve');
    const openBefore = (await pool.query(`SELECT count(*)::int n FROM appraisal_findings WHERE application_id=$1 AND status='open' AND severity='fatal' AND blocks_ctc=true`, [appId])).rows[0].n;

    const newVal = Number(String(fnd.appraisal_value).replace(/[,$]/g, '')); // 575000
    await pool.query(`UPDATE applications SET arv=$2, updated_at=now() WHERE id=$1`, [appId, newVal]);
    await pool.query(
      `UPDATE appraisal_findings SET status='resolved', resolution='replace', resolution_value=$3, resolved_at=now()
       WHERE id=$1 AND application_id=$2`, [fnd.id, appId, String(newVal)]);

    const arv = (await pool.query(`SELECT arv FROM applications WHERE id=$1`, [appId])).rows[0].arv;
    assert(Number(arv) === 575000, 'replace wrote the appraisal ARV back to the file (575000)');
    const fnow = (await pool.query(`SELECT status FROM appraisal_findings WHERE id=$1`, [fnd.id])).rows[0].status;
    assert(fnow === 'resolved', 'finding marked resolved');
    const openAfter = (await pool.query(`SELECT count(*)::int n FROM appraisal_findings WHERE application_id=$1 AND status='open' AND severity='fatal' AND blocks_ctc=true`, [appId])).rows[0].n;
    assert(openAfter === openBefore - 1, `open fatal count dropped by 1 (${openBefore} -> ${openAfter})`);

    // reprice trigger: writing arv reopens the product_pricing condition if one exists.
    // (No registered pricing on this seed, so we only assert the write + no crash.)

    await pool.query(`DELETE FROM applications WHERE borrower_id=$1`, [bid]);
    await pool.query(`DELETE FROM borrowers WHERE id=$1`, [bid]);
  } catch (e) { console.log('FAIL threw:', e.message); failures++; }
  finally { await pool.end(); }
  console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL route-DB assertions passed'}`);
  process.exit(failures ? 1 : 0);
})();
