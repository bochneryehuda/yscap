/**
 * ClickUp-INBOUND status-change notification is GO-FORWARD ONLY
 * (src/lib/status-notify.js notifyInboundStatusChange + db/187 watermark).
 *
 * Owner-directed 2026-07-20: the team changes a file's status directly in ClickUp
 * as well as in the portal; a ClickUp-originated change was giving the borrower
 * no "your loan is now …" email. The inbound sync now notifies the borrower — but
 * NEVER blasts old files: the first time a file is seen it SILENTLY BASELINES
 * (writes the watermark, sends nothing); only a genuine SUBSEQUENT change fires;
 * a ClickUp ECHO of a portal change (watermark already set by the portal door)
 * is a no-op; a soft-deleted file is skipped.
 *
 * Requires DATABASE_URL with migrations applied (incl. db/187); skips otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-notification-inbound-status (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';

const assert = require('assert');
const db = require('../src/db');
const email = require('../src/lib/email');
const statusNotify = require('../src/lib/status-notify');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };
let sent = [];
email.sendMail = async (m) => { sent.push(m); return { ok: true }; };
const mailedTo = (addr) => sent.filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(addr)).length;

const countBorrowerStatus = async (appId) => Number((await db.query(
  `SELECT count(*) c FROM notifications WHERE application_id=$1 AND recipient_kind='borrower' AND type='status_change'`, [appId])).rows[0].c);
const watermark = async (appId) => (await db.query(`SELECT status_notified_external w FROM applications WHERE id=$1`, [appId])).rows[0].w;

(async () => {
  const sfx = `${process.pid}-${Math.floor(Date.now() / 1000)}`;
  const bEmail = `inb-bo-${sfx}@example.com`;
  let loId, borrowerId, appA, appB;
  try {
    loId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Inbound LO','loan_officer',true) RETURNING id`, [`inb-lo-${sfx}@yscapgroup.com`])).rows[0].id;
    borrowerId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Inbound','Test',$1) RETURNING id`, [bEmail])).rows[0].id;
    appA = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status) VALUES ($1,$2,'processing') RETURNING id`, [borrowerId, loId])).rows[0].id;

    // 1) SILENT BASELINE — a file the sync has never seen (watermark NULL) is
    //    baselined, NOT announced. This is what makes the rollout go-forward-only.
    sent = [];
    await statusNotify.notifyInboundStatusChange(appA, 'processing');
    assert.strictEqual(await countBorrowerStatus(appA), 0, 'first inbound sight sends NO borrower notification (silent baseline)');
    assert.strictEqual(await watermark(appA), 'processing', 'the watermark is baselined to the current status');
    assert.strictEqual(mailedTo(bEmail), 0, 'no email on the baseline');
    ok('a never-before-seen file is silently baselined — previously-drifted files are never blasted');

    // 2) GO-FORWARD change → notify, and a DECISION status emails.
    sent = [];
    await statusNotify.notifyInboundStatusChange(appA, 'funded');
    assert.strictEqual(await countBorrowerStatus(appA), 1, 'a genuine subsequent ClickUp change notifies the borrower');
    assert.strictEqual(await watermark(appA), 'funded', 'the watermark advances to the new status');
    assert.ok(mailedTo(bEmail) >= 1, 'a DECISION status (funded) emails the borrower');
    const fundedMail = sent.find((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(bEmail));
    assert.ok(Array.isArray(fundedMail.bcc) && fundedMail.bcc.includes(`inb-lo-${sfx}@yscapgroup.com`), 'the loan officer is BCC-ed (looped in) on the inbound status email');
    ok('a real ClickUp-driven change notifies the borrower and loops the loan officer in (BCC)');

    // 3) ECHO — the same status pulled again does nothing (no duplicate).
    sent = [];
    await statusNotify.notifyInboundStatusChange(appA, 'funded');
    assert.strictEqual(await countBorrowerStatus(appA), 1, 're-pulling the SAME status sends nothing (no duplicate)');
    assert.strictEqual(mailedTo(bEmail), 0, 'no duplicate email on an unchanged re-pull');
    ok('an echo / unchanged re-pull is a no-op (no duplicate notification)');

    // 4) A non-DECISION change still posts in-app but does NOT email.
    sent = [];
    await statusNotify.notifyInboundStatusChange(appA, 'in_review');
    assert.strictEqual(await countBorrowerStatus(appA), 2, 'a working-status change still posts an in-app notification');
    assert.strictEqual(mailedTo(bEmail), 0, 'a non-decision status does NOT email (in-app only) — no inbox bombardment');
    ok('a routine working-status ClickUp move is in-app only (no email)');

    // 5) SOFT-DELETED file is skipped entirely.
    sent = [];
    await db.query(`UPDATE applications SET deleted_at=now() WHERE id=$1`, [appA]);
    await statusNotify.notifyInboundStatusChange(appA, 'declined');
    assert.strictEqual(await countBorrowerStatus(appA), 2, 'a soft-deleted file gets no status notification');
    assert.strictEqual(await watermark(appA), 'in_review', 'a soft-deleted file\'s watermark is not touched');
    ok('a soft-deleted file is skipped (no wrong-time send)');

    // 6) PORTAL-then-ECHO — the portal door advances the watermark in lock-step,
    //    so a ClickUp echo of a portal change never re-notifies.
    appB = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, status_notified_external) VALUES ($1,$2,'funded','funded') RETURNING id`, [borrowerId, loId])).rows[0].id;
    sent = [];
    await statusNotify.notifyInboundStatusChange(appB, 'funded');
    assert.strictEqual(await countBorrowerStatus(appB), 0, 'a ClickUp echo of a portal change does NOT re-notify the borrower');
    ok('a portal change echoed back from ClickUp never double-notifies (watermark set in lock-step)');

    console.log(`\nAll ${n} inbound-status checks passed.`);
  } finally {
    for (const id of [appA, appB]) if (id) { await db.query(`DELETE FROM notifications WHERE application_id=$1`, [id]).catch(() => {});
      await db.query(`DELETE FROM application_assignees WHERE application_id=$1`, [id]).catch(() => {});
      await db.query(`DELETE FROM applications WHERE id=$1`, [id]).catch(() => {}); }
    if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]).catch(() => {});
    if (loId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [loId]).catch(() => {});
    await db.pool.end();
  }
})().catch((e) => { console.error('FAIL:', e.message, e.stack); process.exit(1); });
