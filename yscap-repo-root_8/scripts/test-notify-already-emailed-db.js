'use strict';
/*
 * ONE EVENT, ONE COPY at the notify chokepoints (owner-directed 2026-08-09).
 *
 * `opts.alreadyEmailed` names who an inbound email already reached; notifyStaff /
 * notifyBorrower / notifyAppStaff must then:
 *   · still WRITE the in-app row (the portal record is never thinned), and
 *   · NOT email that person (their inbox already holds the message), while
 *   · everyone else is emailed exactly as before, and
 *   · a call WITHOUT the option stays byte-identical to today.
 *
 * This is what the order-return "documents came back" notice and the file-reply
 * forward rely on, so it is pinned at the chokepoint rather than per caller.
 *
 * Requires DATABASE_URL with migrations applied; skips otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-notify-already-emailed-db (no DATABASE_URL)'); process.exit(0); }
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';

const assert = require('assert');
const db = require('../src/db');
const email = require('../src/lib/email');
const notify = require('../src/lib/notify');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };
let sent = [];
email.sendMail = async (m) => { sent.push(m); return { ok: true }; };
const mailedTo = (addr) => sent.filter((m) => [].concat(m.to || []).map((x) => String(x).toLowerCase()).includes(addr)).length;

(async () => {
  let failed = false;
  const sfx = `${process.pid}-${Math.floor(Date.now() / 1000)}`;
  const loEmail = `oe-lo-${sfx}@staff.test`;
  const procEmail = `oe-proc-${sfx}@staff.test`;
  const bEmail = `oe-bo-${sfx}@example.com`;
  let loId, procId, borrowerId, appId;
  try {
    loId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'OnEmail LO','loan_officer',true) RETURNING id`, [loEmail])).rows[0].id;
    procId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'OnEmail Proc','processor',true) RETURNING id`, [procEmail])).rows[0].id;
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('OnEmail','Test',$1) RETURNING id`, [bEmail])).rows[0].id;
    appId = (await db.query(
      `INSERT INTO applications (borrower_id, status) VALUES ($1,'processing') RETURNING id`, [borrowerId])).rows[0].id;
    for (const [sid, role] of [[loId, 'loan_officer'], [procId, 'processor']]) {
      await db.query(`INSERT INTO application_assignees (application_id, staff_id, role, is_primary) VALUES ($1,$2,$3,true)`, [appId, sid, role]);
    }

    // 1) Team fan-out with one member already on the email: the other is emailed,
    //    the on-email member is not — and BOTH have in-app rows.
    sent = [];
    await notify.notifyAppStaff(appId, {
      type: 'order_docs_in',
      title: 'Insurance documents came back',
      body: 'the vendor replied-all with the binder',
      // Display-name form on purpose — normalization is part of the contract.
      alreadyEmailed: [`"OnEmail Proc" <${procEmail.toUpperCase()}>`],
    });
    await notify.drainEmails();
    assert.equal(mailedTo(loEmail), 1, 'the assignee NOT on the email is emailed');
    assert.equal(mailedTo(procEmail), 0, 'the assignee ON the email is not re-emailed');
    const rows = await db.query(
      `SELECT staff_id, email_status FROM notifications WHERE application_id=$1 AND type='order_docs_in'`, [appId]);
    assert.equal(rows.rows.length, 2, 'both assignees got the in-app row');
    const procRow = rows.rows.find((r) => String(r.staff_id) === String(procId));
    assert.equal(procRow.email_status, 'skipped', 'the suppressed copy is recorded as in-app only (skipped)');
    ok('notifyAppStaff: on-email member keeps the row, loses only the duplicate email');

    // 2) WITHOUT the option: byte-identical to today — everyone is emailed.
    sent = [];
    await notify.notifyAppStaff(appId, {
      type: 'order_docs_in', title: 'Title documents came back', body: 'plain reply — nobody looped in',
    });
    await notify.drainEmails();
    assert.equal(mailedTo(loEmail), 1, 'baseline: LO emailed');
    assert.equal(mailedTo(procEmail), 1, 'baseline: processor emailed');
    ok('no alreadyEmailed → behavior unchanged (both emailed)');

    // 3) notifyStaff honors it through an explicit emailTo override too.
    sent = [];
    await notify.notifyStaff(loId, {
      type: 'order_docs_in', title: 't', body: 'b', applicationId: appId,
      emailTo: [loEmail], alreadyEmailed: [loEmail],
    });
    await notify.drainEmails();
    assert.equal(mailedTo(loEmail), 0, 'explicit emailTo is still filtered');
    ok('notifyStaff: explicit emailTo respects the one-copy rule');

    // 4) The borrower chokepoint: a borrower on the email keeps the in-app row,
    //    gets no duplicate ('message' is a major type — it WOULD have emailed).
    sent = [];
    const nid = await notify.notifyBorrower(borrowerId, {
      type: 'message', title: 'New message', body: 'hello', applicationId: appId,
      alreadyEmailed: [bEmail],
    });
    await notify.drainEmails();
    assert.ok(nid, 'borrower in-app row written');
    assert.equal(mailedTo(bEmail), 0, 'borrower on the email is not re-emailed');
    sent = [];
    await notify.notifyBorrower(borrowerId, {
      type: 'message', title: 'New message', body: 'hello again', applicationId: appId,
    });
    await notify.drainEmails();
    assert.equal(mailedTo(bEmail), 1, 'borrower NOT on the email is emailed exactly as before');
    ok('notifyBorrower: same rule, same fail-toward-sending default');

  } catch (e) {
    failed = true;
    console.error('  ✗ FAIL', e && e.stack ? e.stack : e);
  } finally {
    try {
      if (appId) {
        await db.query(`DELETE FROM sent_emails WHERE application_id=$1`, [appId]);
        await db.query(`DELETE FROM email_messages WHERE application_id=$1`, [appId]);
        await db.query(`DELETE FROM notifications WHERE application_id=$1`, [appId]);
        await db.query(`DELETE FROM application_assignees WHERE application_id=$1`, [appId]);
        await db.query(`DELETE FROM applications WHERE id=$1`, [appId]);
      }
      if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]);
      for (const sid of [loId, procId]) if (sid) await db.query(`DELETE FROM staff_users WHERE id=$1`, [sid]);
    } catch (e2) { console.log('  (cleanup warn)', e2.message); }
  }
  console.log(`\ntest-notify-already-emailed-db: ${n} checks passed${failed ? ' (WITH FAILURES)' : ''}`);
  process.exit(failed ? 1 : 0);
})();
