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

  // ---- C3+ THE FALLBACK NEVER LEAKS THE BORROWER'S MAGIC LINK, AND NEVER LIES (owner-reported
  // 2026-08-10, the Malky Katz delivery: the borrower-voiced findings email — carrying the
  // borrower's no-login /draw-accept/<reply_token> capability — was emailed to a staff assignee,
  // and nothing anywhere said the borrower had NOT received it).
  outbox.length = 0;
  const MAGIC = 'SECRETTOKEN' + rnd;
  const thread = await notify.notifyAppThread(app2, {
    type: 'draw_findings', title: 'Your inspection is complete — please confirm the amount',
    body: 'confirm to release your draw', applicationId: app2,
    link: `/draw-accept/${MAGIC}`, ctaLabel: 'Review & confirm',
    cta2Label: 'Push back on a line', cta2Link: `/draw-accept/${MAGIC}?tab=dispute`,
    staffTitle: 'Inspection results sent to the borrower — awaiting their confirmation',
    staffBody: 'the results went to the borrower to accept or dispute',
    staffLink: `/internal/app/${app2}`, staffCtaLabel: 'Open the file',
  });
  await sleep(900);
  ok('C3 the fallback still emails the team (an event never goes dark)', outbox.length >= 1);
  ok('C4 but NO email carries the borrower\'s magic accept link',
    outbox.every((m) => !String(m.html || '').includes(MAGIC) && !String(m.text || '').includes(MAGIC)));
  ok('C5 the fallback email is STAFF-voiced, not "please confirm the amount"',
    outbox.every((m) => !/please confirm the amount/i.test(String(m.subject || ''))));
  ok('C6 and it SAYS the borrower has not seen this',
    outbox.some((m) => /borrower could NOT be emailed|has not seen this/i.test(String(m.html || '') + String(m.text || ''))));
  const staffLinkRow = (await db.query(
    `SELECT link FROM notifications
      WHERE application_id=$1 AND recipient_kind='staff' AND type='draw_findings'
      ORDER BY created_at DESC LIMIT 1`, [app2])).rows[0];
  eq('C7 the staff in-app row links to the FILE, never the magic link', staffLinkRow && staffLinkRow.link, `/internal/app/${app2}`);
  ok('C8 the thread reports the borrower was NOT reached (so the route can warn the coordinator)',
    !!thread && thread.emailedTogether === false && thread.borrowerMailable === false);

  // ---- C9+ A borrower who MUTED draw emails is NOT "emailed" (audit 2026-08-10): notifyBorrower
  // still writes their in-app row, so counting rows alone reported a muted borrower as reached —
  // the team's copy was suppressed AND the caller was told it was delivered.
  const bor3Email = `muted${rnd}@example.com`;
  const bor3 = (await db.query(
    `INSERT INTO borrowers(first_name,last_name,email) VALUES('Muted','Borrower',$1) RETURNING id`, [bor3Email])).rows[0].id;
  const app3 = (await db.query(
    `INSERT INTO applications(borrower_id,status,ys_loan_number,property_address) VALUES($1,'funded',$2,'{"oneLine":"1 Muted Way"}') RETURNING id`,
    [bor3, 'MB' + rnd.slice(0, 6)])).rows[0].id;
  await db.query(`INSERT INTO application_assignees(application_id,staff_id,role) VALUES($1,$2,'processor') ON CONFLICT DO NOTHING`, [app3, coord]);
  await db.query(`INSERT INTO notification_prefs(borrower_id,category,in_app,email) VALUES($1,'draws',true,false)
                  ON CONFLICT (borrower_id,category) DO UPDATE SET email=false`, [bor3]);
  outbox.length = 0;
  const mutedThread = await notify.notifyAppThread(app3, {
    type: 'draw_findings', title: 'Your inspection is complete — please confirm the amount',
    body: 'x', applicationId: app3, staffTitle: 'Results ready', staffLink: `/internal/app/${app3}`,
  });
  await sleep(900);
  ok('C9 a muted-email borrower reads as NOT mailable', !!mutedThread && mutedThread.borrowerMailable === false && mutedThread.emailedTogether === false);
  ok('C10 so the team is emailed the fallback instead of the event going to nobody',
    outbox.length >= 1 && outbox.every((m) => ![].concat(m.to || []).map((x) => String(x).toLowerCase()).includes(bor3Email)));
  ok('C11 and their in-app row still exists (their choice was email-only)',
    (await db.query(`SELECT 1 FROM notifications WHERE application_id=$1 AND recipient_kind='borrower' AND type='draw_findings'`, [app3])).rows.length >= 1);

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

  // ================================================ E. the rest of the draw emails
  // Every remaining draw notification was converted to the same composer. These two prove the
  // parts a pure test cannot reach: the real COLUMNS behind each money source, both read inside
  // the same swallowing catch as everything else in `drawEmailBlocks`.
  {
    // A PORTAL request (§5B) — no Sitewire draw exists yet, so its own row is the money source.
    const pr = (await db.query(
      `INSERT INTO portal_draw_requests (application_id, source, platform, lines, total_requested_cents)
       VALUES ($1,'borrower','trinity',$2::jsonb,5000000) RETURNING *`,
      [app, JSON.stringify([{ sitewire_job_item_id: JI, name: 'Roof', requested_cents: 5000000 }])])).rows[0];
    const pb = await drawEmailBlocks(db, app, { portalRequest: pr, borrower: true });
    ok('E1 a portal draw request builds its own money block', !!(pb && pb.figures));
    eq('E2 leading with the REQUESTED amount, since nothing is inspected yet',
      pb.figures.primary.value, '$50,000');
    ok('E3 and it still carries the project budget facts', pb.facts && pb.facts.rows.some((r) => r.label === 'Rehab budget'));

    // The coordinator records the decision — the shape approveTrinityRequest writes.
    const decided = (await db.query(
      `UPDATE portal_draw_requests SET status='approved', approved_cents=3345000, lines=$2::jsonb
        WHERE id=$1 RETURNING *`,
      [pr.id, JSON.stringify([{ sitewire_job_item_id: JI, name: 'Roof', requested_cents: 5000000, approved_cents: 3345000 }])])).rows[0];
    const db2 = await drawEmailBlocks(db, app, { portalRequest: decided, borrower: true });
    eq('E4 once reviewed, the APPROVED amount is the headline', db2.figures.primary.value, '$33,450');
    ok('E5 and no wire amount is promised — this path has no resolved draw fee',
      !/wired to you|no draw fee/i.test(String(db2.figures.primary.sub || '')));
    await db.query(`DELETE FROM portal_draw_requests WHERE id=$1`, [pr.id]);
  }
  {
    // A RECORDED RELEASE — the release email's figures come from the ledger, via the rollup.
    await db.query(
      `INSERT INTO draw_disbursements (application_id, sitewire_draw_id, approved_cents, fee_cents, retainage_held_cents, net_release_cents, release_date, funded_status, kind)
       VALUES ($1,$2,3345000,29900,0,3315100,CURRENT_DATE,'released','draw')`, [app, DRAW]);
    const rb = await drawEmailBlocks(db, app, { sitewireDrawId: DRAW, borrower: true });
    ok('E6 a released draw leads with the RELEASE, read from the ledger',
      rb.figures && /Released/.test(rb.figures.primary.label) && rb.figures.primary.value === '$33,151');
    ok('E7 the release DATE was read (proves the disbursement date query runs)',
      rb.facts.rows.some((r) => r.label === 'Funds released on'));
    ok('E8 and the draw fee that was netted out is stated',
      rb.facts.rows.some((r) => /Draw processing fee/.test(r.label) && r.value === '$299'));
    await db.query(`DELETE FROM draw_disbursements WHERE application_id=$1`, [app]);
  }

  mailer.sendMail = realSend;

  // ================================================ cleanup
  await db.query(`DELETE FROM notifications WHERE application_id = ANY($1)`, [[app, app2, app3]]);
  await db.query(`DELETE FROM application_assignees WHERE application_id = ANY($1)`, [[app, app2, app3]]);
  await db.query(`DELETE FROM notification_prefs WHERE borrower_id=$1`, [bor3]);
  await db.query(`DELETE FROM draw_findings WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM sitewire_draw_requests WHERE sitewire_draw_id=$1`, [DRAW]);
  await db.query(`DELETE FROM sitewire_job_item_links WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM sitewire_draws WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM sitewire_property_links WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM applications WHERE id = ANY($1)`, [[app, app2, app3]]);
  await db.query(`DELETE FROM borrowers WHERE id = ANY($1)`, [[bor, bor2, bor3]]);
  await db.query(`DELETE FROM staff_users WHERE id = ANY($1)`, [[coord, lo]]);

  console.log(`test-draw-email-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
