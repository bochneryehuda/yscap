/**
 * Assignment of contract is a PURCHASE concept — it must never apply to a
 * refinance (proactive follow-up to the assignment-condition work).
 *
 * Two layers:
 *  1) assignmentFields() (src/lib/fields.js, pure): a refi loan type forces
 *     isAssignment off and computes the stored purchase price normally, instead
 *     of the (bogus) underlying + fee.
 *  2) db/173 trigger: the borrower-facing rtl_p5_assign condition exists iff the
 *     file is flagged as an assignment AND is a purchase; a purchase⇄refinance
 *     switch adds/removes it immediately.
 *
 * The DB layer requires DATABASE_URL (skips cleanly); the pure layer always runs.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const { assignmentFields } = require('../src/lib/fields');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// ---- 1) assignmentFields (pure) ----
const purchase = assignmentFields({ isAssignment: true, loanType: 'Purchase', underlyingContractPrice: 380000, assignmentFee: 20000, purchasePrice: 400000 });
assert(purchase.isAssignment === true, 'purchase assignment stays an assignment');
assert(Number(purchase.purchasePrice) === 400000, 'purchase assignment stores underlying + fee as purchase price (380k+20k)');
assert(Number(purchase.underlying) === 380000, 'purchase assignment keeps the underlying price');

const refi = assignmentFields({ isAssignment: true, loanType: 'Cash-Out Refinance', underlyingContractPrice: 380000, assignmentFee: 20000, purchasePrice: 500000 });
assert(refi.isAssignment === false, 'refinance forces isAssignment OFF even when ticked');
assert(refi.underlying === null, 'refinance hard-nulls the underlying price');
assert(refi.assignFee === null, 'refinance hard-nulls the assignment fee');
assert(Number(refi.purchasePrice) === 500000, 'refinance stores the real purchase price, NOT underlying + fee');

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('SKIP db-trigger portion (no DATABASE_URL)');
    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL assignment-purchase-only (pure) assertions passed');
    process.exit(failures ? 1 : 0);
  }
  const db = require('../src/db');
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let borrowerId;
  const hasAssign = async (appId) => (await db.query(
    `SELECT 1 FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
      WHERE ci.application_id=$1 AND t.code='rtl_p5_assign' LIMIT 1`, [appId])).rows.length > 0;
  try {
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Asg','Test',$1) RETURNING id`,
      [`asg-bo-${sfx}@test.local`])).rows[0].id;
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, status, loan_type, is_assignment) VALUES ($1,'processing','Purchase',false) RETURNING id`,
      [borrowerId])).rows[0].id;

    // Materialize a checklist so the trigger acts on the file.
    const anyTpl = (await db.query(`SELECT id, label, item_kind FROM checklist_templates WHERE code='rtl_p1_id'`)).rows[0];
    await db.query(
      `INSERT INTO checklist_items (template_id, scope, application_id, label, status, item_kind, is_required)
       VALUES ($1,'application',$2,$3,'outstanding',$4,true)`, [anyTpl.id, appId, anyTpl.label, anyTpl.item_kind]);

    assert(!(await hasAssign(appId)), 'purchase, not-yet-assignment file has no assignment condition');

    await db.query(`UPDATE applications SET is_assignment=true, underlying_contract_price=380000, assignment_fee=20000 WHERE id=$1`, [appId]);
    assert(await hasAssign(appId), 'flagging an assignment on a purchase adds the assignment condition');

    await db.query(`UPDATE applications SET loan_type='Cash-Out Refinance' WHERE id=$1`, [appId]);
    assert(!(await hasAssign(appId)), 'switching the purchase to a refinance removes the assignment condition');

    await db.query(`UPDATE applications SET loan_type='Purchase' WHERE id=$1`, [appId]);
    assert(await hasAssign(appId), 'switching back to a purchase re-adds the assignment condition (still flagged)');

    // A refinance that is flagged as an assignment must NEVER carry the condition.
    const refiApp = (await db.query(
      `INSERT INTO applications (borrower_id, status, loan_type, is_assignment) VALUES ($1,'processing','Refinance',true) RETURNING id`,
      [borrowerId])).rows[0].id;
    await db.query(
      `INSERT INTO checklist_items (template_id, scope, application_id, label, status, item_kind, is_required)
       VALUES ($1,'application',$2,$3,'outstanding',$4,true)`, [anyTpl.id, refiApp, anyTpl.label, anyTpl.item_kind]);
    await db.query(`UPDATE applications SET assignment_fee=1 WHERE id=$1`, [refiApp]); // fire the trigger
    assert(!(await hasAssign(refiApp)), 'a refinance flagged as assignment never carries the condition');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL assignment-purchase-only assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
  }
  process.exit(failures ? 1 : 0);
})();
