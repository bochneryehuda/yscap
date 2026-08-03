/* THE DRAW EMAIL'S WIRING, AGAINST A REAL DATABASE (owner-directed 2026-08-03).
 *
 * The pure suite proves what a draw email SAYS. This proves the two things it cannot reach:
 *
 *   1. THE RECIPIENT STRUCTURE. The owner's report was "the system is just sending out like three
 *      separate emails of the same thing … everybody should be looped in ONE email so we can then
 *      keep responding." That is a claim about what reaches the mail provider, so it is asserted
 *      on the WIRE PAYLOAD — the provider stub — and never on a return value. The `none` provider
 *      accepts anything, so a passing send proves nothing on its own (the lesson the investor
 *      delivery's render-object bug taught: every unit test passed while the body was garbage).
 *
 *   2. THE COLUMNS. `drawEmailBlocks` reads dates across three tables inside a swallowing catch,
 *      which is the repo's documented #248 class — a phantom column would silently empty the
 *      facts box rather than fail. `wire_due_at` in particular lives on `draw_findings`, NOT on
 *      the disbursement ledger where it reads like it belongs, and the first cut had it wrong.
 *      These assertions only pass if the queries actually run against the real schema.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => { if (JSON.stringify(got) === JSON.stringify(exp)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); } };

if (!process.env.DATABASE_URL) { console.log('SKIP test-draw-email-db (no DATABASE_URL)'); process.exit(0); }

const crypto = require('crypto');
const db = require('../src/db');
const notify = require('../src/lib/notify');
const { drawEmailBlocks } = require('../src/sitewire/draw-email-blocks');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---------------------------------------------------------------- fixture
  const rnd = crypto.randomBytes(5).toString('hex');
  const bEmail = `dov${rnd}@example.com`;
  const bor = (await db.query(
    `INSERT INTO borrowers(first_name,last_name,email) VALUES('Dov','Steiner',$1) RETURNING id`, [bEmail])).rows[0].id;
  const app = (await db.query(
    `INSERT INTO applications(borrower_id,status,ys_loan_number,property_address,rehab_budget)
     VALUES($1,'funded',$2,'{"oneLine":"825 Bishop St","city":"Union","state":"NJ","zip":"07083"}',104250) RETURNING id`,
    [bor, 'DE' + rnd.slice(0, 6)])).rows[0].id;

  // Two staffers on the file: a coordinator (who started the draw) and a loan officer. Both must
  // end up on the ONE email rather than each receiving their own.
  const coordEmail = `coord${rnd}@yscapgroup.com`, loEmail = `lo${rnd}@yscapgroup.com`;
  const coord = (await db.query(
    `INSERT INTO staff_users(full_name,email,role,is_active) VALUES('Lisa Katz',$1,'draw_coordinator',true) RETURNING id`, [coordEmail])).rows[0].id;
  const lo = (await db.query(
    `INSERT INTO staff_users(full_name,email,role,is_active) VALUES('Loan Officer',$1,'loan_officer',true) RETURNING id`, [loEmail])).rows[0].id;
  await db.query(`UPDATE applications SET loan_officer_id=$2 WHERE id=$1`, [app, lo]);
  await db.query(`INSERT INTO application_assignees(application_id,staff_id,role) VALUES($1,$2,'loan_officer') ON CONFLICT DO NOTHING`, [app, lo]);
  await db.query(`INSERT INTO application_assignees(application_id,staff_id,role) VALUES($1,$2,'processor') ON CONFLICT DO NOTHING`, [app, coord]);

  const BASE = 970000 + crypto.randomBytes(2).readUInt16BE(0) * 10;
  const DRAW = BASE, BUDGET = BASE + 1, PROP = BASE + 2, JI = BASE + 10, REQ = BASE + 20;
  await db.query(`INSERT INTO sitewire_property_links(application_id,sitewire_property_id,matched_by,state,pushed_at,inspection_method,draw_setup_started_by)
                  VALUES($1,$2,'created','live',now(),'mobile',$3)`, [app, PROP, coord]);
  // The owner's own draw: $50,000 requested, $33,450 approved by the inspector.
  await db.query(`INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status,total_requested_cents,total_approved_cents,submitted_at,approved_at)
                  VALUES($1,$2,2,'pending',5000000,0,now(),now())`, [app, DRAW]);
  await db.query(`INSERT INTO sitewire_job_item_links(application_id,sitewire_budget_id,sow_line_key,section_token,unit_index,sitewire_job_item_id,name,budgeted_cents,state)
                  VALUES($1,$2,'cat:roof','u1',1,$3,'Roof',10425000,'live')`, [app, BUDGET, JI]);
  await db.query(`INSERT INTO sitewire_draw_requests(sitewire_draw_id,sitewire_request_id,sitewire_job_item_id,job_item_name,requested_cents,approved_cents,inspection_count)
                  VALUES($1,$2,$3,'Roof',5000000,3345000,4)`, [DRAW, REQ, JI]);
  await db.query(`INSERT INTO draw_findings(application_id,sitewire_draw_id,status,total_requested_cents,total_approved_cents,delivered_at,wire_due_at)
                  VALUES($1,$2,'delivered',5000000,3345000,now(),now() + interval '3 days')`, [app, DRAW]);

  // ================================================ A. the blocks (and the columns behind them)
  const blocks = await drawEmailBlocks(db, app, { sitewireDrawId: DRAW, borrower: true });
  ok('A1 blocks are built for a real draw', !!blocks);
  ok('A2 the figures carry the inspector-approved headline', blocks.figures && blocks.figures.primary.value === '$33,450');
  eq('A3 and the supporting figures are the owner\'s four numbers',
    blocks.figures.secondary.map((s) => s.value), ['$50,000', '$16,550']);
  ok('A4 the facts box is populated', blocks.facts && blocks.facts.rows.length > 0);
  const labels = blocks.facts.rows.map((r) => r.label);
  ok('A5 the draw number is stated', labels.includes('Draw'));
  ok('A6 the rehab budget is stated', labels.includes('Rehab budget'));
  ok('A7 what is LEFT of the budget is stated', labels.some((l) => /Still available/.test(l)));
  // THE PHANTOM-COLUMN GUARD. `inspected_at` comes from draw_findings.delivered_at and
  // `wire_due_at` from draw_findings.wire_due_at — a table the first cut read it from wrongly.
  // Both queries live inside a catch, so only a real row proves they ran.
  ok('A8 the inspection date was READ (proves the draw_findings date query runs)',
    labels.includes('Inspection completed'));
  ok('A9 the expected-release date was READ (proves wire_due_at is on the right table)',
    labels.some((l) => /Expected release|Funds released on/.test(l)));
  ok('A10 a budget meter rides along', !!blocks.facts.progress);
  ok('A11 an unknown draw yields no figures rather than another draw\'s money',
    !(await drawEmailBlocks(db, app, { sitewireDrawId: DRAW + 99999, borrower: true })).figures);

  // ================================================ B. ONE email, everybody visibly on it
  const mailer = require('../src/lib/email');
  const realSend = mailer.sendMail;
  const outbox = [];
  mailer.sendMail = async (m) => { outbox.push(m); return { ok: true, id: 'test' }; };

  await notify.notifyAppThread(app, {
    type: 'draw_findings', title: 'Your inspection is complete — please confirm the amount',
    body: 'test body', figures: blocks.figures, facts: blocks.facts,
    applicationId: app, link: `/app/${app}`,
  });
  await sleep(900);   // the email path is fire-and-forget

  eq('B1 ONE email was sent for the whole event, not one per person', outbox.length, 1);
  const msg = outbox[0] || {};
  const to = [].concat(msg.to || []).map((x) => String(x).toLowerCase());
  const cc = [].concat(msg.cc || []).map((x) => String(x).toLowerCase());
  const bcc = [].concat(msg.bcc || []).map((x) => String(x).toLowerCase());
  ok('B2 the borrower is the addressee', to.includes(bEmail));
  ok('B3 the draw coordinator is VISIBLY copied', cc.includes(coordEmail));
  ok('B4 the loan officer is VISIBLY copied', cc.includes(loEmail));
  ok('B5 the draws desk is VISIBLY copied', cc.some((e) => /draws@/.test(e)));
  // A Bcc is invisible, so a reply reaches nobody else and the thread splits — which is why the
  // team had to be emailed separately in the first place.
  ok('B6 nobody is hidden on a Bcc', bcc.length === 0);
  ok('B7 the body is a real HTML string', typeof msg.html === 'string' && msg.html.indexOf('[object Object]') === -1);
  ok('B8 the ranked figures are in the sent body', msg.html.includes('$33,450') && msg.html.includes('$50,000') && msg.html.includes('$16,550'));
  // The pixel is keyed on the BORROWER's notification: any Cc'd staffer's mail client loading it
  // would forge "the borrower opened this". A reading nobody can trust is worse than none.
  ok('B9 no open-tracking pixel rides an email with a visible Cc', !/\/t\/open|open\.gif|pixel/i.test(msg.html));

  // The team still gets their in-app rows — they simply are not emailed twice.
  const inapp = (await db.query(
    `SELECT staff_id FROM notifications WHERE application_id=$1 AND recipient_kind='staff' AND type='draw_findings'`, [app])).rows;
  ok('B10 every staffer on the file still gets an in-app row', inapp.length >= 2);
  const staffEmailed = (await db.query(
    `SELECT count(*)::int AS n FROM notifications
      WHERE application_id=$1 AND recipient_kind='staff' AND type='draw_findings' AND email_status='sent'`, [app])).rows[0].n;
  eq('B11 and NOT a second email each', staffEmailed, 0);

  // ONE EMAIL, TWO VOICES. The email is a single message and keeps the borrower's subject — but
  // the desk's in-app feed should not read "YOUR construction draw" about the desk's own file.
  outbox.length = 0;
  await notify.notifyAppThread(app, {
    type: 'draw', title: 'Your construction draw has been released', body: 'on its way to you',
    staffTitle: 'Draw funds released', staffBody: 'net was released by the administrator',
    applicationId: app,
  });
  await sleep(900);
  const staffRow = (await db.query(
    `SELECT title, body FROM notifications
      WHERE application_id=$1 AND recipient_kind='staff' AND type='draw' ORDER BY created_at DESC LIMIT 1`, [app])).rows[0];
  const borrRow = (await db.query(
    `SELECT title FROM notifications
      WHERE application_id=$1 AND recipient_kind='borrower' AND type='draw' ORDER BY created_at DESC LIMIT 1`, [app])).rows[0];
  eq('B12 the desk\'s in-app row is written in the desk\'s voice', staffRow && staffRow.title, 'Draw funds released');
  ok('B13 while the borrower keeps theirs', borrRow && /Your construction draw/.test(borrRow.title));
  eq('B14 and it is still ONE email', outbox.length, 1);
  ok('B15 whose subject is the borrower\'s', /Your construction draw/.test(String(outbox[0] && outbox[0].subject)));

  // ================================================ C. the fallback — an event never goes dark
  outbox.length = 0;
  // A borrower with NO email address on file — the realistic "nobody to address" case (the column
  // is NOT NULL, so a file always has a borrower; what it may not have is a way to reach them).
  // notifyBorrower still returns an in-app row id here, so this is exactly the case where trusting
  // that return value would silence the team's copy and send the event to nobody.
  const bor2 = (await db.query(
    `INSERT INTO borrowers(first_name,last_name,email,shares_email) VALUES('No','Email','',true) RETURNING id`)).rows[0].id;
  const app2 = (await db.query(
    `INSERT INTO applications(borrower_id,status,ys_loan_number,property_address) VALUES($1,'funded',$2,'{"oneLine":"No Borrower Rd"}') RETURNING id`,
    [bor2, 'NB' + rnd.slice(0, 6)])).rows[0].id;
  await db.query(`INSERT INTO application_assignees(application_id,staff_id,role) VALUES($1,$2,'processor') ON CONFLICT DO NOTHING`, [app2, coord]);
  await notify.notifyAppThread(app2, { type: 'draw', title: 'Draw event with no borrower', body: 'x', applicationId: app2 });
  await sleep(900);
  ok('C1 with no borrower to address, the team is emailed directly rather than nobody', outbox.length >= 1);
  ok('C2 and the coordinator is on it', outbox.some((m) => [].concat(m.to || []).map(String).some((e) => e.toLowerCase() === coordEmail)));

  // ================================================ D. a NON-draw email is untouched
  outbox.length = 0;
  // `doc_rejected` is a borrower ACTION item, so it genuinely emails (unlike status_change, which
  // is in-app only for borrowers by design — picking that proved nothing).
  await notify.notifyAppBorrowers(app, { type: 'doc_rejected', title: 'Unrelated', body: 'x', applicationId: app });
  await sleep(900);
  const nonDraw = outbox[0];
  ok('D1 a non-draw borrower email still sends', !!nonDraw);
  ok('D2 and carries NO visible Cc — this change is scoped to the draw process',
    !nonDraw || ![].concat(nonDraw.cc || []).length);

  mailer.sendMail = realSend;

  // ================================================ cleanup
  await db.query(`DELETE FROM notifications WHERE application_id = ANY($1)`, [[app, app2]]);
  await db.query(`DELETE FROM application_assignees WHERE application_id = ANY($1)`, [[app, app2]]);
  await db.query(`DELETE FROM draw_findings WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM sitewire_draw_requests WHERE sitewire_draw_id=$1`, [DRAW]);
  await db.query(`DELETE FROM sitewire_job_item_links WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM sitewire_draws WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM sitewire_property_links WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM applications WHERE id = ANY($1)`, [[app, app2]]);
  await db.query(`DELETE FROM borrowers WHERE id = ANY($1)`, [[bor, bor2]]);
  await db.query(`DELETE FROM staff_users WHERE id = ANY($1)`, [[coord, lo]]);

  console.log(`test-draw-email-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
