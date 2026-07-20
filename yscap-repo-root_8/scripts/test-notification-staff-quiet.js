/**
 * Routine, low-signal STAFF events are IN-APP ONLY; action events still email
 * (src/lib/notify.js notifyStaff STAFF_INAPP_TYPES gate).
 *
 * Owner-directed 2026-07-20 evening ("stop bombarding with stuff that is not
 * important"): the whole team was emailed every time a borrower did an ordinary
 * workflow thing — answered a tool/checklist question (tool_submitted), uploaded
 * a document (doc_uploaded), added the appraisal card (condition_added). Those
 * now post the in-app row but send NO email. Genuinely actionable staff events
 * (assignment, sync_review, mention, disputes, …) still email.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-notification-staff-quiet (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';

const assert = require('assert');
const db = require('../src/db');
const email = require('../src/lib/email');
const notify = require('../src/lib/notify');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };
let sent = [];
email.sendMail = async (m) => { sent.push(m); return { ok: true }; };
const emailsTo = (addr) => sent.filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(addr)).length;

(async () => {
  const sfx = `${process.pid}-${Math.floor(Date.now() / 1000)}`;
  const staffEmail = `quiet-lo-${sfx}@yscapgroup.com`;
  let st, br, app;
  try {
    st = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Quiet Officer','loan_officer',true) RETURNING id`, [staffEmail])).rows[0].id;
    br = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Quiet','Borrower',$1) RETURNING id`, [`quiet-b-${sfx}@example.com`])).rows[0].id;
    app = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status) VALUES ($1,$2,'processing') RETURNING id`, [br, st])).rows[0].id;

    const inApp = async (type) => Number((await db.query(
      `SELECT count(*) c FROM notifications WHERE staff_id=$1 AND type=$2`, [st, type])).rows[0].c);

    // Routine borrower-activity events → in-app row written, NO email.
    for (const type of ['tool_submitted', 'doc_uploaded', 'condition_added']) {
      sent = [];
      await notify.notifyStaff(st, { type, title: `routine ${type}`, applicationId: app });
      assert.ok((await inApp(type)) >= 1, `${type}: the in-app row IS written`);
      assert.strictEqual(emailsTo(staffEmail), 0, `${type}: NO staff email is sent (no bombardment)`);
      ok(`a routine "${type}" event is in-app only — the team is not emailed`);
    }

    // Actionable staff events → in-app AND email.
    for (const type of ['assignment', 'sync_review', 'mention']) {
      sent = [];
      await notify.notifyStaff(st, { type, title: `action ${type}`, applicationId: app });
      assert.ok(emailsTo(staffEmail) >= 1, `${type}: an actionable staff event STILL emails`);
      ok(`an actionable "${type}" event still emails the team`);
    }

    // An explicit inAppOnly flag always wins over the type default.
    sent = [];
    await notify.notifyStaff(st, { type: 'tool_submitted', title: 'forced email', applicationId: app, inAppOnly: false });
    assert.ok(emailsTo(staffEmail) >= 1, 'an explicit inAppOnly:false forces the email even for a routine type');
    ok('an explicit inAppOnly:false overrides the routine-type default (caller wins)');

    sent = [];
    await notify.notifyStaff(st, { type: 'assignment', title: 'forced quiet', applicationId: app, inAppOnly: true });
    assert.strictEqual(emailsTo(staffEmail), 0, 'an explicit inAppOnly:true silences even an actionable type');
    ok('an explicit inAppOnly:true overrides an actionable type (caller wins)');

    console.log(`\nAll ${n} staff-quiet checks passed.`);
  } finally {
    if (app) { await db.query(`DELETE FROM notifications WHERE application_id=$1`, [app]).catch(() => {});
      await db.query(`DELETE FROM notifications WHERE staff_id=$1`, [st]).catch(() => {});
      await db.query(`DELETE FROM application_assignees WHERE application_id=$1`, [app]).catch(() => {});
      await db.query(`DELETE FROM applications WHERE id=$1`, [app]).catch(() => {}); }
    if (br) await db.query(`DELETE FROM borrowers WHERE id=$1`, [br]).catch(() => {});
    if (st) await db.query(`DELETE FROM staff_users WHERE id=$1`, [st]).catch(() => {});
    await db.pool.end();
  }
})().catch((e) => { console.error('FAIL:', e.message, e.stack); process.exit(1); });
