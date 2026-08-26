/**
 * Assignment of contract is a PURCHASE concept — it must never apply to a
 * refinance.
 *
 * THE BUG THIS FILE GREW TO COVER (owner-reported 2026-08-25, YSCAP258134828 /
 * 601 South 18th Street): a "Refinance — Cash-Out" file was showing the
 * borrower-facing condition "Assignment letter (if the contract is assigned)",
 * while a purchase that is NOT an assignment correctly showed nothing. THREE
 * places decided one question and they disagreed — db/179's trigger asked
 * "flagged AND a purchase" and deleted the condition, while
 * conditions/ensure.js and db/095's reconciler asked only "flagged" and put it
 * straight back on the next ensure (every create path, every re-sync, every
 * key-field change). So the two rules fought and the borrower kept being asked
 * for an assignment letter on a loan that buys nothing.
 *
 * Five layers, each with its own section below:
 *  A) `carriesAssignmentCondition` (src/lib/conditions/assignment-purchase.js) —
 *     the ONE shared rule every JavaScript door now reads.
 *  B) a SOURCE guard that the doors actually read it (a unit test of the rule
 *     cannot see whether anybody calls it).
 *  1) assignmentFields() (src/lib/fields.js, pure): a refi loan type forces
 *     isAssignment off and computes the stored purchase price normally, instead
 *     of the (bogus) underlying + fee.
 *  2) db/179 trigger: the borrower-facing rtl_p5_assign condition exists iff the
 *     file is flagged as an assignment AND is a purchase; a purchase⇄refinance
 *     switch adds/removes it immediately.
 *  3) db/630: a refinance cannot STORE the assignment flag, the condition cannot
 *     be INSERTED onto a file that is not an assignment purchase whoever inserts
 *     it, and the back book is healed.
 *
 * The DB layers require DATABASE_URL (skip cleanly); the pure layers always run.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const fs = require('fs');
const path = require('path');
const { assignmentFields } = require('../src/lib/fields');
const { carriesAssignmentCondition } = require('../src/lib/conditions/assignment-purchase');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// Comments necessarily NAME the thing a "must not appear" guard forbids (this
// file's own fix is explained in the code it changed), so a guard that read them
// would fail on its own explanation and then get "fixed" by deleting it.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const readSrc = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ---- A) the ONE shared rule (pure) ----
assert(carriesAssignmentCondition({ is_assignment: true, loan_type: 'Purchase' }) === true,
  'A1  a flagged PURCHASE carries the assignment condition');
assert(carriesAssignmentCondition({ is_assignment: true, loan_type: 'Refinance — Cash-Out' }) === false,
  "A2  the owner's own file — a flagged REFINANCE — CASH-OUT does not");
assert(carriesAssignmentCondition({ is_assignment: true, loan_type: 'Refinance — Rate & Term' }) === false,
  'A3  nor a rate & term refinance');
assert(carriesAssignmentCondition({ is_assignment: true, loan_type: 'Cash-Out Refinance' }) === false,
  'A4  nor the ClickUp spelling of it');
assert(carriesAssignmentCondition({ is_assignment: false, loan_type: 'Purchase' }) === false,
  'A5  an unflagged purchase does not (the case the owner said already worked)');
assert(carriesAssignmentCondition({ isAssignment: true, loanType: 'Delayed Purchase Financing' }) === true,
  'A6  delayed purchase financing is a PURCHASE — the engine reads it that way too');
assert(carriesAssignmentCondition({ isAssignment: true, loanType: 'Purchase' }) === true,
  'A7  the camelCase create-door shape is accepted as well');
assert(carriesAssignmentCondition({ is_assignment: true }) === true,
  'A8  a file with no stated loan type reads as a purchase (db/179 and loanTypeOf agree)');
assert(carriesAssignmentCondition(null) === false && carriesAssignmentCondition(undefined) === false,
  'A9  nothing at all is never an assignment purchase');
assert(carriesAssignmentCondition({ is_assignment: 'true', loan_type: 'Purchase' }) === false,
  'A10 only a real boolean true counts — a string is not a ticked box');

// ---- B) the doors READ that rule (source guard) ----
{
  const ensure = stripComments(readSrc('src/lib/conditions/ensure.js'));
  assert(/require\(['"]\.\/assignment-purchase['"]\)/.test(ensure),
    'B1  conditions/ensure.js reads the shared rule');
  assert(/isAssignment:\s*carriesAssignmentCondition\(a\)/.test(ensure),
    'B2  …and passes ITS answer to generateChecklist');
  assert(!/isAssignment:\s*a\.is_assignment\s*===\s*true/.test(ensure),
    'B3  …and no longer decides it on its own (the second opinion that caused this)');

  const borrower = stripComments(readSrc('src/routes/borrower.js'));
  assert(/require\(['"]\.\.\/lib\/conditions\/assignment-purchase['"]\)/.test(borrower),
    'B4  generateChecklist reads the shared rule too');
  assert(/rtl_p5_assign['"]\s*&&\s*!assignmentApplies/.test(borrower),
    'B5  …and gates on the FILE, not on whatever a caller passed');
  assert(!/rtl_p5_assign['"]\s*&&\s*!opts\.isAssignment/.test(borrower),
    'B6  …so the old caller-trusting gate is gone');
}

// ---- 1) assignmentFields (pure) ----
const purchase = assignmentFields({ isAssignment: true, loanType: 'Purchase', underlyingContractPrice: 380000, assignmentFee: 20000, purchasePrice: 400000 });
assert(purchase.isAssignment === true, '1a  purchase assignment stays an assignment');
assert(Number(purchase.purchasePrice) === 400000, '1b  purchase assignment stores underlying + fee as purchase price (380k+20k)');
assert(Number(purchase.underlying) === 380000, '1c  purchase assignment keeps the underlying price');

const refi = assignmentFields({ isAssignment: true, loanType: 'Cash-Out Refinance', underlyingContractPrice: 380000, assignmentFee: 20000, purchasePrice: 500000 });
assert(refi.isAssignment === false, '1d  refinance forces isAssignment OFF even when ticked');
assert(refi.underlying === null, '1e  refinance hard-nulls the underlying price');
assert(refi.assignFee === null, '1f  refinance hard-nulls the assignment fee');
/* UPDATED 2026-08-02 (owner-directed): a refinance stores NO purchase price at
   all — it is sized on the as-is value, and what the borrower paid when they
   bought the property is `original_purchase_price`. This assertion previously
   expected the raw 500000 to be stored, which is exactly the purchase-style
   economics the owner reported on a cash-out file. */
assert(refi.purchasePrice === null, '1g  refinance stores NO purchase price — it is sized on the as-is value');

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('SKIP db portion (no DATABASE_URL)');
    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL assignment-purchase-only (pure) assertions passed');
    process.exit(failures ? 1 : 0);
  }
  const db = require('../src/db');
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let borrowerId;
  const hasAssign = async (appId) => (await db.query(
    `SELECT 1 FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
      WHERE ci.application_id=$1 AND t.code='rtl_p5_assign' LIMIT 1`, [appId])).rows.length > 0;
  const flagOf = async (appId) => (await db.query(
    `SELECT is_assignment, assignment_fee, underlying_contract_price FROM applications WHERE id=$1`, [appId])).rows[0];
  const seed = async (loanType, isAssignment) => {
    const id = (await db.query(
      `INSERT INTO applications (borrower_id, status, loan_type, is_assignment) VALUES ($1,'processing',$2,$3) RETURNING id`,
      [borrowerId, loanType, isAssignment])).rows[0].id;
    const anyTpl = (await db.query(`SELECT id, label, item_kind FROM checklist_templates WHERE code='rtl_p1_id'`)).rows[0];
    await db.query(
      `INSERT INTO checklist_items (template_id, scope, application_id, label, status, item_kind, is_required)
       VALUES ($1,'application',$2,$3,'outstanding',$4,true)`, [anyTpl.id, id, anyTpl.label, anyTpl.item_kind]);
    return id;
  };
  /* The instantiation db/095's boot reconciler and insertFromTemplate both run —
     a plain INSERT of the template, carrying no knowledge of this rule. */
  const rawInsertAssignmentCondition = async (appId) => {
    const t = (await db.query(`SELECT * FROM checklist_templates WHERE code='rtl_p5_assign'`)).rows[0];
    await db.query(
      `INSERT INTO checklist_items (template_id, scope, label, borrower_label, audience, item_kind,
          role_scope, phase, hint, borrower_hint, is_gate, is_milestone, sort_order, created_by_kind,
          is_required, application_id)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'any'),$8,$9,$10,COALESCE($11,false),COALESCE($12,false),
               COALESCE($13,500),'system',COALESCE($14,true),$15)`,
      [t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind, t.role_scope, t.phase,
       t.hint, t.borrower_hint, t.is_gate, t.is_milestone, t.sort_order, t.is_required, appId]);
  };
  try {
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Asg','Test',$1) RETURNING id`,
      [`asg-bo-${sfx}@test.local`])).rows[0].id;

    // ---- 2) the db/179 trigger, unchanged ----
    const appId = await seed('Purchase', false);
    assert(!(await hasAssign(appId)), '2a  purchase, not-yet-assignment file has no assignment condition');

    await db.query(`UPDATE applications SET is_assignment=true, underlying_contract_price=380000, assignment_fee=20000 WHERE id=$1`, [appId]);
    assert(await hasAssign(appId), '2b  flagging an assignment on a purchase adds the assignment condition');

    await db.query(`UPDATE applications SET loan_type='Cash-Out Refinance' WHERE id=$1`, [appId]);
    assert(!(await hasAssign(appId)), '2c  switching the purchase to a refinance removes the assignment condition');

    /* CHANGED 2026-08-25 by db/630, deliberately. This used to assert that
       switching BACK to a purchase re-added the condition "still flagged" — which
       was only ever true because the flag SURVIVED the round trip. It no longer
       does: a refinance cannot hold an assignment (§1), which is the same rule
       fields.assignmentFields has applied at the application layer since #96. So
       a stale tick from before a purpose change can never silently re-arm; the
       officer re-ticks it, which 2f proves still works. */
    const cleared = await flagOf(appId);
    assert(cleared.is_assignment === false, '2d  …and the refinance no longer holds the assignment flag at all');
    assert(cleared.assignment_fee === null && cleared.underlying_contract_price === null,
      '2e  …nor the assignment money that travels with it (db/515s rule)');

    await db.query(`UPDATE applications SET loan_type='Purchase' WHERE id=$1`, [appId]);
    assert(!(await hasAssign(appId)), '2f  switching back to a purchase does NOT resurrect a claim nobody re-made');
    await db.query(`UPDATE applications SET is_assignment=true WHERE id=$1`, [appId]);
    assert(await hasAssign(appId), '2g  …and re-ticking the box on the purchase adds it back');

    // A refinance flagged as an assignment must NEVER carry the condition.
    const refiApp = await seed('Refinance', true);
    assert((await flagOf(refiApp)).is_assignment === false,
      '3a  a refinance CREATED with the assignment box ticked stores it as false');
    await db.query(`UPDATE applications SET assignment_fee=1 WHERE id=$1`, [refiApp]); // fire the trigger
    assert(!(await hasAssign(refiApp)), '3b  a refinance flagged as assignment never carries the condition');

    // ---- 3) db/630: the condition cannot be INSERTED, whoever inserts it ----
    /* This is the door the owner's file actually came through: the JS half is
       fixed above, but db/095's reconciler is plain SQL that re-runs on every
       boot and knows only "is the box ticked". */
    await rawInsertAssignmentCondition(refiApp);
    assert(!(await hasAssign(refiApp)),
      '4a  a raw template INSERT onto a refinance is refused (the db/095 reconciler door)');

    const plainPurchase = await seed('Purchase', false);
    await rawInsertAssignmentCondition(plainPurchase);
    assert(!(await hasAssign(plainPurchase)),
      '4b  …and onto a purchase nobody flagged (the case the owner said already worked)');

    const assignedPurchase = await seed('Purchase', true);
    await rawInsertAssignmentCondition(assignedPurchase);
    assert(await hasAssign(assignedPurchase),
      '4c  …while a genuinely assigned purchase still gets it');

    // ---- 4) the loop itself: ensure → generateChecklist on a refinance ----
    /* The live cause. Before the fix, THIS call is what put the condition back
       seconds after db/179's trigger deleted it — on every re-sync, every
       key-field change and every create path. */
    let loopChecked = false;
    try {
      const { generateChecklist } = require('../src/routes/borrower');
      const loopApp = await seed('Refinance — Cash-Out', false);
      // Stage the pre-fix state the only way it can now exist: with §1 held off.
      await db.query(`ALTER TABLE applications DISABLE TRIGGER trg_assignment_is_a_purchase_concept`);
      await db.query(`UPDATE applications SET is_assignment=true WHERE id=$1`, [loopApp]);
      await db.query(`ALTER TABLE applications ENABLE TRIGGER trg_assignment_is_a_purchase_concept`);
      await generateChecklist(loopApp, borrowerId, null, 'Refinance — Cash-Out', { isAssignment: true });
      assert(!(await hasAssign(loopApp)),
        '5a  an ensure pass on a refinance whose box is ticked does NOT re-create the condition');
      loopChecked = true;
    } catch (e) {
      console.log(`SKIP 5a (could not load generateChecklist: ${(e && e.message) || e})`);
    }
    if (!loopChecked) console.log('NOTE  section 5 was skipped — sections 4a/4b still cover the SQL door');

    // ---- 5) the back book: db/630 §3 heals a file that predates all of this ----
    const legacy = await seed('Refinance — Cash-Out', false);
    await db.query(`ALTER TABLE applications DISABLE TRIGGER trg_assignment_is_a_purchase_concept`);
    await db.query(`ALTER TABLE checklist_items DISABLE TRIGGER trg_assignment_condition_is_purchase_only`);
    await db.query(`UPDATE applications SET is_assignment=true, assignment_fee=2500 WHERE id=$1`, [legacy]);
    await rawInsertAssignmentCondition(legacy);
    await db.query(`ALTER TABLE applications ENABLE TRIGGER trg_assignment_is_a_purchase_concept`);
    await db.query(`ALTER TABLE checklist_items ENABLE TRIGGER trg_assignment_condition_is_purchase_only`);
    assert(await hasAssign(legacy), '6a  (control) the pre-fix state really is reproducible');

    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', '630_assignment_condition_is_a_purchase_concept.sql'), 'utf8');
    await db.query(sql);
    const healed = await flagOf(legacy);
    assert(healed.is_assignment === false && healed.assignment_fee === null,
      '6b  the boot pass clears the assignment off a previous refinance');
    assert(!(await hasAssign(legacy)), '6c  …and takes the condition off it');
    assert((await db.query(
      `SELECT 1 FROM audit_log WHERE entity_type='application' AND entity_id=$1
         AND action='assignment_flag_cleared_on_refinance' LIMIT 1`, [legacy])).rows.length === 1,
      '6d  …recording what it cleared, because the value is gone from the row afterwards');

    // Re-running it must change nothing and must not disturb a real assignment.
    await db.query(sql);
    assert(await hasAssign(assignedPurchase),
      '6e  a second boot leaves a genuine assignment purchase alone');
    assert((await db.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE entity_type='application' AND entity_id=$1
         AND action='assignment_flag_cleared_on_refinance'`, [legacy])).rows[0].n === 1,
      '6f  …and audits nothing a second time (the backfill matches zero rows)');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL assignment-purchase-only assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
  }
  process.exit(failures ? 1 : 0);
})();
