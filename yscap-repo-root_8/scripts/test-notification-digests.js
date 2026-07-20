/**
 * Scheduled notification digests (src/lib/notification-digests.js).
 *
 * Owner-directed 2026-07-20: four recurring emails (borrower "what's still
 * needed", per-officer daily pipeline, stale-file alerts, weekly admin summary),
 * each self-gated via an audit_log stamp so it sends at most once per period.
 * Verifies content, file-tagged subjects, borrower-safety, and idempotency.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-notification-digests (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';
process.env.CHAT_REPLY_DOMAIN = process.env.CHAT_REPLY_DOMAIN || 'reply.yscapgroup.com';

const assert = require('assert');
const db = require('../src/db');
const email = require('../src/lib/email');
const D = require('../src/lib/notification-digests');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };
const sent = [];
email.sendMail = async (m) => { sent.push(m); return { ok: true }; };
const reset = () => { sent.length = 0; };
const to = (e) => sent.find((x) => (Array.isArray(x.to) ? x.to : [x.to]).includes(e));

(async () => {
  // The admin summary uses a GLOBAL (non-file) once-per-6-days gate; clear any
  // prior stamp so this test is deterministic regardless of earlier runs.
  await db.query(`DELETE FROM audit_log WHERE action='admin_weekly_summary' AND entity_id IS NULL`).catch(() => {});
  const suffix = Date.now();
  const bemail = `dz-borrower-${suffix}@example.com`;
  const semail = `dz-officer-${suffix}@example.com`;
  const loan = `DZ-${suffix}`;

  const br = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Digest','Tester',$1) RETURNING id`, [bemail])).rows[0];
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, ys_loan_number, property_address, program, loan_type, status, status_changed_at)
     VALUES ($1,$2,$3,'gold','purchase','processing', now()-interval '30 days') RETURNING id`,
    [br.id, loan, JSON.stringify({ street: '5 Test Ave', line1: '5 Test Ave', city: 'Brooklyn', state: 'NY', oneLine: '5 Test Ave, Brooklyn, NY' })])).rows[0];
  const st = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Officer Digest','loan_officer',true) RETURNING id`, [semail])).rows[0];
  await db.query(`INSERT INTO application_assignees (application_id, staff_id, role, is_primary, added_by) VALUES ($1,$2,'loan_officer',true,$2)`, [app.id, st.id]);
  await db.query(`UPDATE applications SET loan_officer_id=$2 WHERE id=$1`, [app.id, st.id]);
  await db.query(
    `INSERT INTO checklist_items (scope,application_id,label,borrower_label,audience,item_kind,status,created_by_kind)
     VALUES ('application',$1,'Bank statements','Bank statements','borrower','task','outstanding','staff')`, [app.id]);

  /* 1) Borrower "what's still needed" — file-tagged, lists item, borrower-safe, idempotent. */
  reset(); const c1 = await D.weeklyBorrowerOutstandingOnce();
  let m = to(bemail);
  assert.ok(c1 >= 1 && m, 'borrower digest sent');
  assert.ok(m.subject.includes(loan) && m.subject.includes('5 Test Ave'), 'borrower digest subject is file-tagged');
  assert.ok(/Bank statements/.test(m.html), 'lists the open item');
  ['BlueLake', 'Fidelis', 'Churchill', 'RCN', 'Temple View', 'CorrFirst'].forEach((nm) =>
    assert.ok(!m.html.includes(nm), 'no capital-partner name'));
  reset(); await D.weeklyBorrowerOutstandingOnce();
  assert.ok(!to(bemail), 'borrower digest is gated on the 2nd run (once per 6 days)');
  ok('borrower outstanding digest: file-tagged, borrower-safe, once-per-period');

  /* 2) Daily pipeline digest — per officer, days-at-stage, idempotent. */
  reset(); await D.dailyPipelineDigestOnce();
  m = to(semail);
  assert.ok(m, 'pipeline digest sent to the officer');
  assert.ok(/pipeline today/i.test(m.subject), 'pipeline subject');
  assert.ok(m.html.includes(loan) && /30d at this stage/.test(m.html), 'lists the file + days at stage');
  reset(); await D.dailyPipelineDigestOnce();
  assert.ok(!to(semail), 'pipeline digest gated on 2nd run (once per day)');
  ok('daily pipeline digest: per-officer snapshot, once-per-day');

  /* 3) Stale-file alert — file-tagged, idempotent. */
  reset(); await D.staleFileAlertsOnce();
  m = to(semail);
  assert.ok(m, 'stale alert sent to the team');
  assert.ok(/stalled: 30 days/i.test(m.subject) && m.subject.includes(loan), 'stale subject names days + file');
  reset(); await D.staleFileAlertsOnce();
  assert.ok(!to(semail), 'stale alert gated on 2nd run (once per 3 days)');
  ok('stale-file alert: file-tagged, once-per-3-days');

  /* 4) Weekly admin summary — aggregate meta, idempotent. */
  await db.query(`UPDATE staff_users SET role='admin' WHERE id=$1`, [st.id]);
  reset(); await D.weeklyAdminSummaryOnce();
  m = to(semail);
  assert.ok(m, 'admin summary sent');
  assert.ok(/Weekly pipeline summary/.test(m.subject), 'admin subject');
  assert.ok(/Active files|Needing assignment|New files/.test(m.html), 'admin aggregate meta present');
  reset(); await D.weeklyAdminSummaryOnce();
  assert.ok(!to(semail), 'admin summary gated on 2nd run (once per 6 days)');
  ok('weekly admin summary: aggregate stats, once-per-6-days');

  /* 5) Draw result awaiting the borrower — nudge, borrower-safe, idempotent. */
  const DRAW = 900000 + (suffix % 90000);
  await db.query(
    `INSERT INTO draw_findings (application_id, sitewire_draw_id, status, total_requested_cents, total_approved_cents, delivered_at)
     VALUES ($1,$2,'delivered',2000000,1800000, now()-interval '5 days')`, [app.id, DRAW]);
  reset(); const c5 = await D.drawFindingsAwaitingBorrowerOnce();
  m = to(bemail);
  assert.ok(c5 >= 1 && m, 'draw-awaiting reminder sent to the borrower');
  assert.ok(/waiting for you/i.test(m.subject), 'awaiting-draw subject');
  assert.ok(/release clock|accept/i.test(m.html), 'explains the release-on-accept reason');
  ['BlueLake', 'Fidelis', 'Churchill', 'RCN', 'Temple View', 'CorrFirst'].forEach((nm) =>
    assert.ok(!m.html.includes(nm), 'no capital-partner name on the borrower nudge'));
  reset(); await D.drawFindingsAwaitingBorrowerOnce();
  assert.ok(!to(bemail), 'draw-awaiting reminder gated on the 2nd run (once / 2 days)');
  ok('draw result awaiting borrower: nudged, borrower-safe, once-per-period');

  /* 6) Draw release overdue — the accepted-but-unreleased draw nudges the assigned team, idempotent. */
  await db.query(
    `UPDATE draw_findings SET status='accepted', accepted_at=now()-interval '3 days', wire_due_at=now()-interval '1 day'
      WHERE application_id=$1 AND sitewire_draw_id=$2`, [app.id, DRAW]);
  reset(); const c6 = await D.drawReleaseOverdueOnce();
  m = to(semail);
  assert.ok(c6 >= 1 && m, 'release-overdue alert sent to the team');
  assert.ok(/overdue/i.test(m.subject), 'overdue subject');
  assert.ok(m.subject.includes(loan), 'overdue alert is file-tagged');
  reset(); await D.drawReleaseOverdueOnce();
  assert.ok(!to(semail), 'release-overdue alert gated on the 2nd run (once / 2 days)');
  ok('draw release overdue: team alerted, once-per-period');
  await db.query(`DELETE FROM draw_findings WHERE application_id=$1`, [app.id]).catch(() => {});

  /* nyParts sanity */
  const p = D.nyParts();
  assert.ok(p.hour >= 0 && p.hour <= 23 && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.test(p.weekday), 'nyParts returns a valid NY hour + weekday');
  ok('nyParts: valid NY hour + weekday');

  // cleanup (best-effort)
  await db.query(`DELETE FROM checklist_items WHERE application_id=$1`, [app.id]).catch(() => {});
  await db.query(`DELETE FROM audit_log WHERE entity_id=$1`, [app.id]).catch(() => {});
  await db.query(`DELETE FROM application_assignees WHERE application_id=$1`, [app.id]).catch(() => {});
  await db.query(`DELETE FROM applications WHERE id=$1`, [app.id]).catch(() => {});
  await db.query(`DELETE FROM staff_users WHERE id=$1`, [st.id]).catch(() => {});
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [br.id]).catch(() => {});

  console.log(`\nAll ${n} notification-digest checks passed.`);
  await db.pool.end();
})().catch((e) => { console.error('FAIL:', e.message, e.stack); process.exit(1); });
