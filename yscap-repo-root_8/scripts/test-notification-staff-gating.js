/**
 * Staff notification email gating (src/lib/notify.js notifyStaff opts.inAppOnly).
 *
 * Owner-directed 2026-07-20 (Moshe Spitzer / 109 Chapel St bombardment report):
 * the team must NOT be emailed on every routine status move. A routine working
 * move (Processing/In review/Underwriting) writes the in-app row but sends NO
 * email; a DECISION milestone (Funded/Approved/…) still emails.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-notification-staff-gating (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';

const assert = require('assert');
const db = require('../src/db');
const email = require('../src/lib/email');
const notify = require('../src/lib/notify');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };
const sent = [];
email.sendMail = async (m) => { sent.push(m); return { ok: true }; };
const emailsTo = (addr) => sent.filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(addr)).length;

(async () => {
  const suffix = Date.now();
  const staffEmail = `gate-lo-${suffix}@yscapgroup.com`;
  const st = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Gate Officer','loan_officer',true) RETURNING id`, [staffEmail])).rows[0];
  const br = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Gate','Borrower',$1) RETURNING id`, [`gate-b-${suffix}@example.com`])).rows[0];
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, loan_officer_id, ys_loan_number, property_address, status)
     VALUES ($1,$2,$3,$4,'processing') RETURNING id`,
    [br.id, st.id, 'GATE-' + suffix, JSON.stringify({ oneLine: '1 Gate St, NY', street: '1 Gate St' })])).rows[0];
  // The db/103 trigger (trg_sync_primary_assignee) already mirrors loan_officer_id
  // into a primary application_assignees row, so no explicit insert is needed.

  // Routine move → inAppOnly: in-app row written, NO email.
  const before = Number((await db.query(`SELECT count(*) c FROM notifications WHERE application_id=$1 AND recipient_kind='staff'`, [app.id])).rows[0].c);
  await notify.notifyAppStaff(app.id, { type: 'status_change', title: 'File moved to Processing', body: 'x', applicationId: app.id, inAppOnly: true });
  const after = Number((await db.query(`SELECT count(*) c FROM notifications WHERE application_id=$1 AND recipient_kind='staff'`, [app.id])).rows[0].c);
  assert.ok(after > before, 'routine status: the in-app staff row IS still written');
  assert.strictEqual(emailsTo(staffEmail), 0, 'routine status (Processing): NO staff email is sent');
  ok('routine status move is in-app only for staff (no email bombardment)');

  // Decision milestone → emails.
  await notify.notifyAppStaff(app.id, { type: 'status_change', title: 'File moved to Funded', body: 'x', applicationId: app.id, inAppOnly: false });
  assert.ok(emailsTo(staffEmail) >= 1, 'decision status (Funded): staff email IS sent');
  ok('decision status milestone still emails the team');

  // The assigned loan officer is silently BCC-ed on the BORROWER's email so they
  // see what the borrower received (owner-directed 2026-07-20). Not a visible To;
  // not present on the staff email.
  await notify.notifyAppBorrowers(app.id, { type: 'status_change', title: 'Your loan status is now: Funded', body: 'x', applicationId: app.id, major: true });
  const bmail = sent.find((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(`gate-b-${suffix}@example.com`));
  assert.ok(bmail, 'borrower email sent');
  assert.ok(Array.isArray(bmail.bcc) && bmail.bcc.includes(staffEmail), 'the assigned loan officer is BCC-ed on the borrower email');
  assert.ok(!(Array.isArray(bmail.to) ? bmail.to : [bmail.to]).includes(staffEmail), 'the officer is NOT a visible To on the borrower email');
  ok('the loan officer is silently looped in (BCC) on the borrower email');

  // A DEACTIVATED staffer must NEVER get an email (owner audit 2026-07-20 — a
  // fired employee kept receiving borrower documents), but the in-app row is kept.
  await db.query(`UPDATE staff_users SET is_active=false WHERE id=$1`, [st.id]);
  const beforeInactive = emailsTo(staffEmail);
  await notify.notifyStaff(st.id, { type: 'assignment', title: 'You were added to a file', applicationId: app.id });
  assert.strictEqual(emailsTo(staffEmail), beforeInactive, 'a deactivated staffer receives NO further email');
  assert.ok(Number((await db.query(`SELECT count(*) c FROM notifications WHERE staff_id=$1`, [st.id])).rows[0].c) > 0, 'the in-app row is still written for the deactivated staffer');
  ok('a deactivated staffer gets no email (but keeps the in-app row)');
  await db.query(`UPDATE staff_users SET is_active=true WHERE id=$1`, [st.id]);

  await db.query(`DELETE FROM notifications WHERE application_id=$1`, [app.id]).catch(() => {});
  await db.query(`DELETE FROM application_assignees WHERE application_id=$1`, [app.id]).catch(() => {});
  await db.query(`DELETE FROM applications WHERE id=$1`, [app.id]).catch(() => {});
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [br.id]).catch(() => {});
  await db.query(`DELETE FROM staff_users WHERE id=$1`, [st.id]).catch(() => {});

  console.log(`\nAll ${n} staff-gating checks passed.`);
  await db.pool.end();
})().catch((e) => { console.error('FAIL:', e.message, e.stack); process.exit(1); });
