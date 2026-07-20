/**
 * Missing-field internal conditions + loan-number uniqueness + entered-vs-verified
 * experience (owner-directed 2026-07-20).
 *
 *  (1) cond_note_buyer_missing  — internal (staff) condition attaches while the
 *      note buyer (applications.lender) is blank and retracts once it's set.
 *  (2) cond_loan_number_missing — internal (staff) condition attaches while
 *      applications.ys_loan_number is blank and retracts once it's set.
 *  (3) findLoanNumberCollision  — a loan number is unique across BOTH our own
 *      files AND any ClickUp task (incl. a data_only DSCR task not in our system).
 *  (4) the experience condition payload carries ENTERED + VERIFIED counts, and
 *      "met" is judged on VERIFIED, not merely entered, deals.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-missing-field-and-experience (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const engine = require('../src/lib/conditions/engine');
const loanNumber = require('../src/lib/loan-number');
const experience = require('../src/lib/experience');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const condRow = async (appId, code) => (await db.query(
  `SELECT ci.audience, ci.item_kind, ci.origin_kind, ci.status
     FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
    WHERE ci.application_id=$1 AND t.code=$2`, [appId, code])).rows[0] || null;
const condCount = async (appId, code) => (await db.query(
  `SELECT count(*)::int n FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
    WHERE ci.application_id=$1 AND t.code=$2`, [appId, code])).rows[0].n;

(async () => {
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let borrowerId; const taskIds = [];
  try {
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('MF','Test',$1) RETURNING id`,
      [`mf-${sfx}@test.local`])).rows[0].id;

    // ---- (1) note-buyer-missing internal condition ----
    const a1 = (await db.query(
      `INSERT INTO applications (borrower_id,status) VALUES ($1,'processing') RETURNING id`, [borrowerId])).rows[0].id;
    await engine.evaluateApplication(a1, { reason: 'test', notify: false });
    const nb = await condRow(a1, 'cond_note_buyer_missing');
    assert(!!nb, 'a file with no note buyer gets cond_note_buyer_missing');
    assert(nb && nb.audience === 'staff', 'note-buyer-missing condition is INTERNAL (staff audience)');
    assert(nb && nb.item_kind === 'condition', 'note-buyer-missing is a condition');
    assert(nb && nb.origin_kind === 'auto', 'note-buyer-missing is engine-owned (auto), so it retracts');
    await db.query(`UPDATE applications SET lender='Fidelis' WHERE id=$1`, [a1]);
    await engine.evaluateApplication(a1, { reason: 'test', notify: false });
    assert((await condCount(a1, 'cond_note_buyer_missing')) === 0, 'note-buyer-missing retracts once a note buyer is set');

    // ---- (2) loan-number-missing internal condition ----
    const a2 = (await db.query(
      `INSERT INTO applications (borrower_id,status,lender) VALUES ($1,'processing','Fidelis') RETURNING id`, [borrowerId])).rows[0].id;
    await engine.evaluateApplication(a2, { reason: 'test', notify: false });
    const ln = await condRow(a2, 'cond_loan_number_missing');
    assert(!!ln, 'a file with no loan number gets cond_loan_number_missing');
    assert(ln && ln.audience === 'staff' && ln.item_kind === 'condition', 'loan-number-missing is an INTERNAL condition');
    // no note-buyer-missing here (lender set)
    assert((await condCount(a2, 'cond_note_buyer_missing')) === 0, 'a file WITH a note buyer has no note-buyer-missing condition');
    await db.query(`UPDATE applications SET ys_loan_number='YSCAP${sfx.replace(/[^0-9]/g,'').slice(0,8)}A' WHERE id=$1`, [a2]);
    await engine.evaluateApplication(a2, { reason: 'test', notify: false });
    assert((await condCount(a2, 'cond_loan_number_missing')) === 0, 'loan-number-missing retracts once a loan number is set');

    // ---- (3) loan-number uniqueness across our files + ClickUp ----
    const ours = `YSCAP${sfx.replace(/[^0-9]/g,'').slice(0,8)}B`;
    const a3 = (await db.query(
      `INSERT INTO applications (borrower_id,status,ys_loan_number) VALUES ($1,'processing',$2) RETURNING id`, [borrowerId, ours])).rows[0].id;
    assert((await loanNumber.findLoanNumberCollision(ours, { excludeAppId: a3 })) === null,
      'a file does not collide with its OWN loan number');
    const c1 = await loanNumber.findLoanNumberCollision(ours.toLowerCase());
    assert(c1 && c1.where === 'our_file', 'a loan number already on another of our files is caught (case-insensitive)');

    // A ClickUp-only (data_only DSCR) task carrying a loan number we never filed.
    const cuNum = `YSCAP${sfx.replace(/[^0-9]/g,'').slice(0,8)}C`;
    const tid = `test-task-${sfx}`;
    taskIds.push(tid);
    await db.query(
      `INSERT INTO clickup_task_index (task_id, kind, snapshot, last_seen)
       VALUES ($1,'data_only',$2::jsonb, now())`,
      [tid, JSON.stringify({ app: { ys_loan_number: cuNum } })]);
    const c2 = await loanNumber.findLoanNumberCollision(cuNum);
    assert(c2 && c2.where === 'clickup_file', 'a loan number on a ClickUp-only (DSCR/data-only) file is caught');
    assert(typeof loanNumber.collisionMessage(c2, cuNum) === 'string' && /manual review/i.test(loanNumber.collisionMessage(c2, cuNum)),
      'a ClickUp-file collision message mentions manual review');
    assert((await loanNumber.findLoanNumberCollision(`YSCAP${sfx.replace(/[^0-9]/g,'').slice(0,8)}Z`)) === null,
      'a fresh, unused loan number has no collision');

    // ---- (4) entered vs verified experience ----
    const a4 = (await db.query(
      `INSERT INTO applications (borrower_id,status,requested_exp_flips) VALUES ($1,'processing',1) RETURNING id`, [borrowerId])).rows[0].id;
    // A completed flip with a recent (in-window) sale date, NOT yet verified.
    const trId = (await db.query(
      `INSERT INTO track_records (borrower_id, deal_type, sale_date, is_verified)
       VALUES ($1,'Fix & Flip', CURRENT_DATE - INTERVAL '2 months', false) RETURNING id`, [borrowerId])).rows[0].id;
    // The experience condition slot must exist for the sync to update it.
    const trTpl = (await db.query(`SELECT id,label,scope,audience,item_kind FROM checklist_templates WHERE tool_key='track_record' LIMIT 1`)).rows[0];
    if (trTpl) {
      await db.query(
        `INSERT INTO checklist_items (template_id,scope,application_id,label,status,item_kind,tool_key,audience,is_required)
         VALUES ($1,COALESCE($2,'application'),$3,$4,'outstanding',COALESCE($5,'task'),'track_record',COALESCE($6,'staff'),true)`,
        [trTpl.id, trTpl.scope, a4, trTpl.label, trTpl.item_kind, trTpl.audience]);
    }
    let r = await experience.syncExperienceChecklistForApplication(a4);
    let pay = (await db.query(`SELECT tool_payload FROM checklist_items WHERE application_id=$1 AND tool_key='track_record' LIMIT 1`, [a4])).rows[0].tool_payload;
    assert(pay && pay.counts && pay.counts.flips === 1, 'ENTERED count reflects the on-record flip');
    assert(pay && pay.verifiedCounts && pay.verifiedCounts.flips === 0, 'VERIFIED count is 0 before verification');
    assert(pay && pay.enteredMet === true && pay.verifiedMet === false, 'entered meets the claim but VERIFIED does not');
    assert(r && r.satisfied === false, 'the experience condition is NOT satisfied on entered-only experience');

    // Verify the line → verified count rises → condition becomes met.
    await db.query(`UPDATE track_records SET is_verified=true, verification_status='verified', verified_at=now() WHERE id=$1`, [trId]);
    r = await experience.syncExperienceChecklistForApplication(a4);
    pay = (await db.query(`SELECT tool_payload,status FROM checklist_items WHERE application_id=$1 AND tool_key='track_record' LIMIT 1`, [a4])).rows[0];
    assert(pay.tool_payload && pay.tool_payload.verifiedCounts.flips === 1, 'VERIFIED count rises after the line is verified');
    assert(pay.tool_payload && pay.tool_payload.verifiedMet === true, 'the condition reads met once the flip is VERIFIED');
    assert(pay.status === 'received', 'the condition flips to received (ready to sign off) only on VERIFIED experience');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL missing-field / uniqueness / experience assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try { for (const t of taskIds) await db.query(`DELETE FROM clickup_task_index WHERE task_id=$1`, [t]); } catch (_) {}
    try { if (borrowerId) await db.query(`DELETE FROM track_records WHERE borrower_id=$1`, [borrowerId]); } catch (_) {}
    try { if (borrowerId) await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [borrowerId]); } catch (_) {}
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
  }
  process.exit(failures ? 1 : 0);
})();
