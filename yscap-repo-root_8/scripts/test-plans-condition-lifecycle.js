/**
 * Ground-up "Plans & permits" condition (rtl_p1_plans) lifecycle — db/172 trigger.
 *
 * Proactive follow-up to the assignment-condition lifecycle fix (db/161): the same
 * class, borrower-facing. rtl_p1_plans must appear on a file exactly while it is a
 * ground-up build and be removed the moment it stops being one — on any change to
 * program / loan_type / rehab_type (the three attributes that derive "ground-up").
 *
 * Drives the trigger directly via SQL against a real DB. Requires DATABASE_URL
 * with migrations applied (incl. db/172); skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-plans-condition-lifecycle (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

async function hasPlans(appId) {
  const r = await db.query(
    `SELECT 1 FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
      WHERE ci.application_id=$1 AND t.code='rtl_p1_plans' LIMIT 1`, [appId]);
  return r.rows.length > 0;
}

(async () => {
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let borrowerId;
  try {
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Plans','Test',$1) RETURNING id`,
      [`plans-bo-${sfx}@test.local`])).rows[0].id;
    // Start as a NON-ground-up file (Fix & Flip).
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, status, program) VALUES ($1,'processing','Fix & Flip') RETURNING id`,
      [borrowerId])).rows[0].id;

    // The trigger only acts on files with a materialized checklist. Give the file
    // one unrelated item so the guard passes (and prove we don't add plans yet).
    const anyTpl = (await db.query(`SELECT id, label, item_kind FROM checklist_templates WHERE code='rtl_p1_id'`)).rows[0];
    await db.query(
      `INSERT INTO checklist_items (template_id, scope, application_id, label, status, item_kind, is_required)
       VALUES ($1,'application',$2,$3,'outstanding',$4,true)`, [anyTpl.id, appId, anyTpl.label, anyTpl.item_kind]);

    assert(!(await hasPlans(appId)), 'non-ground-up file does not carry the plans condition');

    // Flip the PROGRAM to ground-up → plans appears immediately (no boot needed).
    await db.query(`UPDATE applications SET program='Ground-Up Construction' WHERE id=$1`, [appId]);
    assert(await hasPlans(appId), 'flipping program to Ground-Up adds the plans condition immediately');

    // Flip back off ground-up → plans removed.
    await db.query(`UPDATE applications SET program='Fix & Flip' WHERE id=$1`, [appId]);
    assert(!(await hasPlans(appId)), 'flipping program off ground-up removes the plans condition');

    // The rehab_type attribute also derives ground-up.
    await db.query(`UPDATE applications SET rehab_type='Ground-up construction' WHERE id=$1`, [appId]);
    assert(await hasPlans(appId), 'ground-up via rehab_type adds the plans condition');
    await db.query(`UPDATE applications SET rehab_type='Cosmetic' WHERE id=$1`, [appId]);
    assert(!(await hasPlans(appId)), 'clearing rehab_type off ground-up removes the plans condition');

    // Idempotent: re-asserting ground-up doesn't create a duplicate.
    await db.query(`UPDATE applications SET program='Ground-Up Construction' WHERE id=$1`, [appId]);
    await db.query(`UPDATE applications SET loan_type='ground-up' WHERE id=$1`, [appId]);
    const cnt = (await db.query(
      `SELECT count(*)::int n FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code='rtl_p1_plans'`, [appId])).rows[0].n;
    assert(cnt === 1, 'a ground-up file carries exactly one plans condition (no duplicates)');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL plans-condition lifecycle assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
  }
  process.exit(failures ? 1 : 0);
})();
