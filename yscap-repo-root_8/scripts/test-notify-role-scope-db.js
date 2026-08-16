#!/usr/bin/env node
'use strict';
/**
 * ROLE-SCOPED FILE NOTIFICATIONS (owner-directed 2026-08-10: "the closer, the draw
 * coordinator … are getting notifications not related to their part … The draw coordinator
 * is related to the draws. The closer is related to closing. Only the loan officers on top
 * of the entire file should receive all the notifications.")
 *
 * THE CLASS: db/392 made the closer a permanent application_assignee (the closer_id
 * pointer-sync trigger), and the whole-team fan-outs selected assignees with NO role
 * filter — so a closer received every countered exception, product registration and draw
 * event on the file (the Malky Katz report). One predicate (notify.staffRolesSee, keyed on
 * the assignee ROLE × the notification CATEGORY) now filters BOTH whole-team chokepoints.
 *
 * Real Postgres + the REAL notify module with the mailer stubbed — recipients are asserted
 * on the WIRE PAYLOAD and the notifications rows, never on return values.
 * Skips without DATABASE_URL.
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

if (!process.env.DATABASE_URL) { console.log('SKIP test-notify-role-scope-db (no DATABASE_URL)'); process.exit(0); }

const crypto = require('crypto');
const db = require('../src/db');
const notify = require('../src/lib/notify');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---------------------------------------------------------------- the pure map contract
  // Every role the assignees door accepts has an EXPLICIT entry — the runtime fails OPEN on
  // an unknown role, so this parity check is what forces the visibility decision for a role
  // added next year (at build time, not at 2am).
  const staffSrc = require('fs').readFileSync(require('path').join(__dirname, '../src/routes/staff.js'), 'utf8');
  const m = staffSrc.match(/const ASSIGNEE_ROLES = \[([^\]]+)\]/);
  const doorRoles = m ? m[1].split(',').map((s) => s.replace(/['"\s]/g, '')).filter(Boolean) : [];
  ok('P1 the assignees door roles were read', doorRoles.length >= 4);
  for (const r of doorRoles) {
    ok(`P2 role "${r}" has an explicit visibility entry`, Object.prototype.hasOwnProperty.call(notify.STAFF_ROLE_CATEGORIES, r));
  }
  ok('P3 the loan officer sees everything', notify.roleSeesCategory('loan_officer', 'draws') && notify.roleSeesCategory('loan_officer', 'pricing'));
  ok('P4 the closer sees ONLY closing', notify.roleSeesCategory('closer', 'closing')
    && !notify.roleSeesCategory('closer', 'draws') && !notify.roleSeesCategory('closer', 'pricing') && !notify.roleSeesCategory('closer', 'conditions'));
  ok('P5 the draw coordinator sees ONLY draws', notify.roleSeesCategory('draw_coordinator', 'draws')
    && !notify.roleSeesCategory('draw_coordinator', 'pricing') && !notify.roleSeesCategory('draw_coordinator', 'closing'));
  ok('P6 an unknown role fails OPEN (whole-file), never dark', notify.roleSeesCategory('purchaser_to_be', 'anything'));
  ok('P7 a FORCED type reaches everyone whatever their role', notify.staffRolesSee(['closer'], { type: 'security' }));

  // ---------------------------------------------------------------- fixture
  const rnd = crypto.randomBytes(5).toString('hex');
  const mk = async (name, role, email) => (await db.query(
    `INSERT INTO staff_users(full_name,email,role,is_active) VALUES($1,$2,$3,true) RETURNING id`, [name, email, role])).rows[0].id;
  const loEmail = `lo${rnd}@yscapgroup.com`, procEmail = `proc${rnd}@yscapgroup.com`,
    closerEmail = `closer${rnd}@yscapgroup.com`, coordEmail = `coord${rnd}@yscapgroup.com`;
  const lo = await mk('Role LO', 'loan_officer', loEmail);
  const proc = await mk('Role Proc', 'processor', procEmail);
  const closer = await mk('Malky Closer', 'closer', closerEmail);
  const coord = await mk('Lisa Coord', 'draw_coordinator', coordEmail);

  // A borrower with NO email — the fallback case (section E) needs an unmailable borrower.
  const borId = (await db.query(
    `INSERT INTO borrowers(first_name,last_name,email,shares_email) VALUES('No','Email','',true) RETURNING id`)).rows[0].id;
  const app = (await db.query(
    `INSERT INTO applications(borrower_id,status,ys_loan_number,property_address) VALUES($1,'funded',$2,'{"oneLine":"7 Scope St"}') RETURNING id`,
    [borId, 'RS' + rnd.slice(0, 6)])).rows[0].id;
  for (const [sid, role] of [[lo, 'loan_officer'], [proc, 'processor'], [closer, 'closer'], [coord, 'draw_coordinator']]) {
    await db.query(`INSERT INTO application_assignees(application_id,staff_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [app, sid, role]);
  }

  const mailer = require('../src/lib/email');
  const realSend = mailer.sendMail;
  const outbox = [];
  mailer.sendMail = async (msg) => { outbox.push(msg); return { ok: true, id: 'test' }; };
  const allRecipients = () => outbox.flatMap((msgRow) => [].concat(msgRow.to || [], msgRow.cc || [], msgRow.bcc || [])).map((e) => String(e).toLowerCase());
  const staffRows = (type) => db.query(
    `SELECT staff_id FROM notifications WHERE application_id=$1 AND recipient_kind='staff' AND type=$2`, [app, type])
    .then((r) => r.rows.map((x) => String(x.staff_id)));

  // ---------------------------------------------------------------- A. a PRICING event (the owner's example)
  await notify.notifyAppStaff(app, { type: 'product_registered', title: 'Product registered', body: 'x', applicationId: app });
  await sleep(900);
  let ids = await staffRows('product_registered');
  ok('A1 the LO gets the pricing event', ids.includes(String(lo)));
  ok('A2 the processor gets it too', ids.includes(String(proc)));
  ok('A3 the CLOSER does NOT (owner: "why is she getting product registered?")', !ids.includes(String(closer)));
  ok('A4 the draw coordinator does NOT', !ids.includes(String(coord)));
  ok('A5 no email reached the closer either', !allRecipients().includes(closerEmail));

  // The countered-exception email from the owner's report — same rule, different type.
  outbox.length = 0;
  await notify.notifyAppStaff(app, { type: 'manual_escalation_countered', title: 'Countered', body: 'x', applicationId: app });
  await sleep(900);
  ids = await staffRows('manual_escalation_countered');
  ok('A6 a countered exception never reaches the closer', !ids.includes(String(closer)) && !allRecipients().includes(closerEmail));
  ok('A7 …but does reach the LO', ids.includes(String(lo)));

  // ---------------------------------------------------------------- B. a DRAWS event
  outbox.length = 0;
  await notify.notifyAppStaff(app, { type: 'draw_started', title: 'Draw process started', body: 'x', applicationId: app });
  await sleep(900);
  ids = await staffRows('draw_started');
  ok('B1 the draw coordinator gets the draw event', ids.includes(String(coord)));
  ok('B2 the LO gets it (on top of the whole file)', ids.includes(String(lo)));
  ok('B3 the closer does NOT get draw events', !ids.includes(String(closer)));

  // The internal one-thread draw email ("A draw was inspected") — the closer's address must
  // not be a visible To recipient (the owner's second pasted email).
  outbox.length = 0;
  await notify.notifyAppStaffThread(app, { type: 'draw_inbound', title: 'A draw was inspected — ready for your review', body: 'x', applicationId: app });
  await sleep(900);
  const threadMsg = outbox[0] || {};
  const to = [].concat(threadMsg.to || []).map((e) => String(e).toLowerCase());
  ok('B4 the one-thread draw email went', outbox.length >= 1);
  ok('B5 the coordinator is on it', to.includes(coordEmail));
  ok('B6 the LO is on it', to.includes(loEmail));
  ok('B7 the CLOSER is NOT on it', !to.includes(closerEmail));

  // ---------------------------------------------------------------- C. a CLOSING event
  outbox.length = 0;
  await db.query(`DELETE FROM notifications WHERE application_id=$1`, [app]);
  await notify.notifyAppStaff(app, { type: 'closing_docs_in', title: 'Closing documents arrived', body: 'x', applicationId: app });
  await sleep(900);
  ids = await staffRows('closing_docs_in');
  ok('C1 the closer DOES get closing events', ids.includes(String(closer)));
  ok('C2 the LO does too', ids.includes(String(lo)));
  ok('C3 the draw coordinator does NOT', !ids.includes(String(coord)));

  // ---------------------------------------------------------------- D. a FORCED type reaches everyone
  await db.query(`DELETE FROM notifications WHERE application_id=$1`, [app]);
  await notify.notifyAppStaff(app, { type: 'security', title: 'Security event', body: 'x', applicationId: app, inAppOnly: true });
  await sleep(400);
  ids = await staffRows('security');
  ok('D1 a forced (security) event reaches every assignee, closer included', ids.includes(String(closer)) && ids.includes(String(coord)) && ids.includes(String(lo)));

  // ---------------------------------------------------------------- E. the Malky regression, end to end
  // A findings delivery on a file whose borrower cannot be emailed: the fallback emails the
  // team — and the closer must not be in it (she was, on 2026-08-10).
  outbox.length = 0;
  const thread = await notify.notifyAppThread(app, {
    type: 'draw_findings', title: 'Your inspection is complete — please confirm the amount',
    body: 'x', applicationId: app,
    link: `/draw-accept/TOKEN${rnd}`,
    staffTitle: 'Inspection results ready for the borrower', staffLink: `/internal/app/${app}`,
  });
  await sleep(900);
  ok('E1 the fallback fired (no mailable borrower)', !!thread && thread.emailedTogether === false);
  const everyAddr = allRecipients();
  ok('E2 the team fallback emailed the coordinator and/or LO', everyAddr.includes(coordEmail) || everyAddr.includes(loEmail));
  ok('E3 the CLOSER received nothing — the Malky report can no longer happen', !everyAddr.includes(closerEmail));
  ok('E4 and no email anywhere carried the magic accept link', outbox.every((msgRow) => !String(msgRow.html || '').includes(`TOKEN${rnd}`)));

  mailer.sendMail = realSend;

  // ---------------------------------------------------------------- cleanup
  await db.query(`DELETE FROM notifications WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM application_assignees WHERE application_id=$1`, [app]);
  // DRAIN BEFORE TEARING DOWN. The email fan-out is fire-and-forget (a web request must
  // never wait on an email), so a sent_emails INSERT can still be in flight here — and it
  // points at a notifications row this teardown deletes. The two lock each other and
  // Postgres kills one: deadlock detected (40P01), which fails a suite whose assertions
  // all passed. A no-op when nothing is in flight.
  await notify.drainEmails();
  await db.query(`DELETE FROM applications WHERE id=$1`, [app]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [borId]);
  await db.query(`DELETE FROM staff_users WHERE id = ANY($1)`, [[lo, proc, closer, coord]]);

  console.log(`test-notify-role-scope-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
