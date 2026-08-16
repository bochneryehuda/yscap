/* THE INTERNAL "A NEW DRAW REQUEST CAME IN" EMAIL GOES OUT AS ONE VISIBLE CHAIN (owner-directed
 * 2026-08-03: "everybody that received this email should be in the same email chain … now I can't
 * see who received it. I need this for all three purposes as well").
 *
 * The borrower draw redesign (#1013) fixed this for the BORROWER emails; this covers the internal
 * staff notice, which still fanned out one email per assignee. The claim is about what reaches the
 * mail provider, so it is asserted on the WIRE PAYLOAD via a provider stub — never a return value
 * (the `none` provider accepts anything, so a passing send proves nothing on its own).
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => { if (JSON.stringify(got) === JSON.stringify(exp)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); } };

const notify = require('../src/lib/notify');

// ------------------------------------------------ pure: the recipient merge (no DB needed)
{
  const r = notify._staffThreadRecipients({
    assignees: ['LO@YSCAPGROUP.com', ' proc@yscapgroup.com '],
    loopIn: ['lo@yscapgroup.com', 'coord@yscapgroup.com', 'draws@yscapgroup.com', ''],
    explicit: [null],
  });
  ok('P1 the list is lowercased, trimmed and de-duplicated (LO appears once)',
    r.length === 4 && r.includes('lo@yscapgroup.com') && r.includes('proc@yscapgroup.com')
    && r.includes('coord@yscapgroup.com') && r.includes('draws@yscapgroup.com'));
  ok('P2 blanks and nulls are dropped', !r.includes('') && !r.includes(null));
  eq('P3 an empty call yields an empty list', notify._staffThreadRecipients(), []);
}

if (!process.env.DATABASE_URL) { console.log(`SKIP test-draw-inbound-thread-db (no DATABASE_URL) — ${pass} pure passed`); process.exit(fail ? 1 : 0); }

const crypto = require('crypto');
const db = require('../src/db');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---------------------------------------------------------------- fixture
  const rnd = crypto.randomBytes(5).toString('hex');
  const bor = (await db.query(
    `INSERT INTO borrowers(first_name,last_name,email) VALUES('Dov','Steiner',$1) RETURNING id`, [`dov${rnd}@example.com`])).rows[0].id;
  const app = (await db.query(
    `INSERT INTO applications(borrower_id,status,ys_loan_number,property_address,rehab_budget)
     VALUES($1,'funded',$2,'{"oneLine":"825 Bishop St","city":"Union","state":"NJ","zip":"07083"}',104250) RETURNING id`,
    [bor, 'DI' + rnd.slice(0, 6)])).rows[0].id;

  // A draw coordinator (who pressed "Start the draw process") + a loan officer, both on the file.
  const coordEmail = `coord${rnd}@yscapgroup.com`, loEmail = `lo${rnd}@yscapgroup.com`;
  const coord = (await db.query(
    `INSERT INTO staff_users(full_name,email,role,is_active) VALUES('Lisa Katz',$1,'draw_coordinator',true) RETURNING id`, [coordEmail])).rows[0].id;
  const lo = (await db.query(
    `INSERT INTO staff_users(full_name,email,role,is_active) VALUES('Loan Officer',$1,'loan_officer',true) RETURNING id`, [loEmail])).rows[0].id;
  await db.query(`UPDATE applications SET loan_officer_id=$2 WHERE id=$1`, [app, lo]);
  await db.query(`INSERT INTO application_assignees(application_id,staff_id,role) VALUES($1,$2,'loan_officer') ON CONFLICT DO NOTHING`, [app, lo]);
  await db.query(`INSERT INTO application_assignees(application_id,staff_id,role) VALUES($1,$2,'processor') ON CONFLICT DO NOTHING`, [app, coord]);
  const PROP = 980000 + crypto.randomBytes(2).readUInt16BE(0);
  await db.query(`INSERT INTO sitewire_property_links(application_id,sitewire_property_id,matched_by,state,pushed_at,inspection_method,draw_setup_started_by)
                  VALUES($1,$2,'created','live',now(),'mobile',$3)`, [app, PROP, coord]);

  const mailer = require('../src/lib/email');
  const realSend = mailer.sendMail;
  const outbox = [];
  mailer.sendMail = async (m) => { outbox.push(m); return { ok: true, id: 'test' }; };

  // ================================================ A. ONE internal email, the whole team visible
  await notify.notifyAppStaffThread(app, {
    type: 'draw_inbound', title: 'A new draw request came in',
    body: 'A new draw request (Draw #1) came in for 825 Bishop St through Sitewire.',
    badge: { text: 'Action needed', tone: 'action' },
    applicationId: app, link: `/internal/app/${app}/draws`,
  });
  await sleep(900);   // the email path is fire-and-forget

  eq('A1 ONE internal email was sent for the whole team, not one per assignee', outbox.length, 1);
  const msg = outbox[0] || {};
  const to = [].concat(msg.to || []).map((x) => String(x).toLowerCase());
  const bcc = [].concat(msg.bcc || []).map((x) => String(x).toLowerCase());
  ok('A2 the draw coordinator is a VISIBLE recipient', to.includes(coordEmail));
  ok('A3 the loan officer is a VISIBLE recipient', to.includes(loEmail));
  ok('A4 the draws desk is a VISIBLE recipient', to.some((e) => /draws@/.test(e)));
  ok('A5 nobody is hidden on a Bcc (a reply-all must reach everyone)', bcc.length === 0);
  ok('A6 the body is a real HTML string', typeof msg.html === 'string' && msg.html.indexOf('[object Object]') === -1);
  // The reply-to is the file's shared address so a reply-all keeps the thread on one chain.
  ok('A7 the reply-to is the file thread (or a real monitored address)', !!msg.replyTo);

  // The team still gets their in-app rows — they are simply not emailed a second time.
  const inapp = (await db.query(
    `SELECT staff_id, email_status FROM notifications
      WHERE application_id=$1 AND recipient_kind='staff' AND type='draw_inbound'`, [app])).rows;
  ok('A8 every staffer on the file still gets an in-app row', inapp.length >= 2);
  eq('A9 and NOT a second per-person email', inapp.filter((r) => r.email_status === 'sent').length, 0);

  // ================================================ B. the money block rides the ONE email
  const { drawEmailBlocks } = require('../src/sitewire/draw-email-blocks');
  const DRAW = PROP + 1000;
  await db.query(`INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status,total_requested_cents,total_approved_cents,submitted_at)
                  VALUES($1,$2,1,'pending',2500000,0,now())`, [app, DRAW]);
  const blocks = await drawEmailBlocks(db, app, { sitewireDrawId: DRAW });
  outbox.length = 0;
  await notify.notifyAppStaffThread(app, {
    type: 'draw_inbound', title: 'A new draw request came in',
    body: 'A new draw request came in.',
    figures: blocks && blocks.figures ? blocks.figures : undefined,
    facts: blocks && blocks.facts ? blocks.facts : undefined,
    applicationId: app, link: `/internal/app/${app}/draws`,
  });
  await sleep(900);
  eq('B1 still exactly one email', outbox.length, 1);
  ok('B2 the requested dollar amount is in the sent body', String(outbox[0] && outbox[0].html).includes('$25,000'));

  mailer.sendMail = realSend;

  // ================================================ cleanup
  await db.query(`DELETE FROM notifications WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM sitewire_draws WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM sitewire_property_links WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM application_assignees WHERE application_id=$1`, [app]);
  // Wait for the fire-and-forget email fan-out before tearing down: its
  // sent_emails INSERT is still in flight when the fan-out resolves, and it
  // deadlocks with the DELETEs below (notify.js documents this and exports
  // drainEmails for exactly this).
  await require('../src/lib/notify').drainEmails().catch(() => {});
  await db.query(`DELETE FROM applications WHERE id=$1`, [app]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]);
  await db.query(`DELETE FROM staff_users WHERE id = ANY($1)`, [[coord, lo]]);

  console.log(`test-draw-inbound-thread-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
