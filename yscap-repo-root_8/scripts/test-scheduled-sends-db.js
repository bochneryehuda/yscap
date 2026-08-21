'use strict';
/**
 * SCHEDULE AN ORDER EMAIL FOR LATER (owner-directed 2026-08-20).
 *
 * The owner: "If somebody wants to work in the middle of the night but he wants
 * it to go out in the morning, we need to add a scheduling option by the order …
 * just add an additional option with the small icon, like a time to schedule the
 * email instead of ordering it immediately. Make it very enhanced. Watch what
 * you're doing."
 *
 * WHAT THIS SUITE IS REALLY FOR. The whole feature rests on ONE claim: a
 * scheduled send is not a parked email, it is a parked INTENT, and at the due
 * moment the ORDINARY send route runs from the top with every gate re-checked.
 * That claim is only worth anything if it is exercised against the real router,
 * the real auth, and a real Postgres — a fixture that calls a handler directly
 * would prove nothing about the part that matters (that `requireAuth`, the
 * path-scoped file scope, the blockers and the exactly-once claim all still
 * apply). So every assertion below runs the actual dispatcher.
 *
 * Real HTTP for the doors + real route re-entry for the dispatch.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-scheduled-sends-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';

const http = require('http');
const crypto = require('crypto');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const sched = require('../src/lib/scheduled-sends');
const mailer = require('../src/lib/email');
const app = require('../src/server');

/* THE PROVIDER IS STUBBED, AND THAT IS THE ONLY WAY THIS SUITE CAN PROVE ITS
   CENTRAL CLAIM. With EMAIL_PROVIDER=none the order route correctly REFUSES
   ("email sending is turned off … the order was not sent and has not been
   recorded") and unwinds its claim — so without a stub, "the due moment really
   places the order" is untestable and the suite would silently be asserting the
   refusal path four times over. The stub records the wire payload; nothing
   leaves the machine. */
const outbox = [];
const realSend = mailer.sendMail;
mailer.sendMail = async (m) => { outbox.push(m); return { ok: true, id: `test-${outbox.length}` }; };

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }); } catch (_) { resolve({ status: res.statusCode, body: null }); } }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

/* Move a queued send into the past so the dispatcher picks it up now. The
   dispatcher's own `send_at <= now()` is what we are exercising, so the row is
   aged rather than the clock being faked. */
const makeDue = (id, minsAgo = 1) =>
  db.query(`UPDATE scheduled_sends SET send_at = now() - ($2 || ' minutes')::interval WHERE id=$1`, [id, String(minsAgo)]);

const rowOf = async (id) => (await db.query(`SELECT * FROM scheduled_sends WHERE id=$1`, [id])).rows[0];

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = crypto.randomBytes(4).toString('hex');
  const clean = [];

  try {
    /* ── seed ─────────────────────────────────────────────────────────────── */
    const officer = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Otto Officer','loan_officer',true) RETURNING id`,
      [`ss-lo-${sfx}@t.local`])).rows[0].id;
    const stranger = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'No Access','loan_officer',true) RETURNING id`,
      [`ss-out-${sfx}@t.local`])).rows[0].id;
    const borrower = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Bo','Rrower',$1) RETURNING id`,
      [`ss-bo-${sfx}@t.local`])).rows[0].id;
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, ys_loan_number, property_address, status, loan_type, usps_imported_at)
       VALUES ($1,$2,$3,$4,'underwriting','Purchase', now()) RETURNING id`,
      [borrower, officer, `YS${String(Date.now()).slice(-8)}01`,
       JSON.stringify({ oneLine: '9 Sched Ave, Brooklyn, NY 11211', street: '9 Sched Ave', city: 'Brooklyn', state: 'NY', zip: '11211' })])).rows[0].id;
    await db.query(`INSERT INTO application_assignees (application_id, staff_id, role) VALUES ($1,$2,'loan_officer') ON CONFLICT DO NOTHING`, [appId, officer]);
    clean.push(async () => {
      await db.query(`DELETE FROM scheduled_sends WHERE application_id=$1`, [appId]);
      await db.query(`DELETE FROM applications WHERE id=$1`, [appId]);
      await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrower]);
      await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[officer, stranger]]);
    });
    let tok = C.signJwt({ sub: officer, kind: 'staff', role: 'loan_officer', tv: 0, sid: 'test' });
    const outTok = C.signJwt({ sub: stranger, kind: 'staff', role: 'loan_officer', tv: 0, sid: 'test' });

    const addTitleVendor = async () => {
      const c = (await db.query(
        `INSERT INTO service_contacts (borrower_id, contact_type, company_name, contact_name, email)
         VALUES ($1,'title_company','Sched Title Co','A Person',$2) RETURNING id`,
        [borrower, `ss-title-${sfx}@t.local`])).rows[0].id;
      await db.query(`INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type)
                      VALUES ($1,$2,'title_company') ON CONFLICT DO NOTHING`, [appId, c]);
      return c;
    };

    /* ── A. the clock the owner is talking about ──────────────────────────── */
    console.log('\nA. "in the morning" means the morning IN NEW YORK');
    // The server runs in UTC. Reading a typed 8am in the server's zone would send
    // a staffer's order at 4am — before anybody is awake, which is the exact
    // failure the feature exists to prevent.
    for (const [day, label] of [['2026-08-20', 'summer (EDT)'], ['2026-01-15', 'winter (EST)'],
                                ['2026-03-08', 'the spring-forward day'], ['2026-11-01', 'the fall-back day']]) {
      const at = sched.parseNyLocal(day, '08:00');
      const back = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(at);
      ok(back === '8:00 AM', `8am typed on ${label} is 8am in New York, not the server's zone`);
    }
    ok(/ET$/.test(sched.describeWhen(sched.parseNyLocal('2026-08-20', '08:00'))), 'and it is shown back with its zone named, so nobody has to guess');
    ok(sched.parseNyLocal('nonsense', '08:00') === null && sched.parseNyLocal('2026-08-20', '8:00') === null,
      'a half-typed date or time is refused rather than guessed at');
    ok(sched.whenProblem(new Date(Date.now() - 3600e3)).code === 'past', 'a time that has passed is refused');
    ok(sched.whenProblem(new Date(Date.now() + 400 * 24 * 3600e3)).code === 'too_far', 'and a mistyped year is refused rather than sitting in the queue for a decade');
    ok(sched.whenProblem(new Date(Date.now() - 20 * 1000)) === null, 'a few seconds of round-trip slack is not "in the past"');

    /* ── B. the door ──────────────────────────────────────────────────────── */
    console.log('\nB. scheduling it');
    const soon = new Date(Date.now() + 3600e3);
    const dayOf = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    const timeOf = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

    const noVendor = await call(server, 'POST', `/api/staff/applications/${appId}/orders/title/schedule`, tok,
      { day: dayOf(soon), time: timeOf(soon) });
    ok(noVendor.status === 200, 'a missing title contact does NOT refuse the scheduling — somebody scheduling tonight for 8am may be about to add it');
    ok(Array.isArray(noVendor.body.warnings) && noVendor.body.warnings.some((w) => /title company contact/i.test(w)),
      '…but it is NAMED, so the screen can say what still has to happen');
    const firstId = noVendor.body.scheduled.id;
    ok(/ET$/.test(noVendor.body.scheduled.sendAtText), 'the queued row says when, in New York time');

    const listed = await call(server, 'GET', `/api/staff/applications/${appId}/scheduled-sends`, tok);
    ok(listed.status === 200 && listed.body.length === 1 && listed.body[0].id === firstId, 'and it is on the file for anyone working it to see');

    // Re-scheduling REPLACES. Two armed sends of one order means the vendor gets
    // it twice, hours apart, where the order's own exactly-once claim cannot help.
    const again = await call(server, 'POST', `/api/staff/applications/${appId}/orders/title/schedule`, tok,
      { day: dayOf(new Date(Date.now() + 7200e3)), time: timeOf(new Date(Date.now() + 7200e3)) });
    ok(again.status === 200 && again.body.scheduled.id !== firstId, 'changing your mind about the time schedules a new one');
    ok((await rowOf(firstId)).status === 'cancelled', '…and DISARMS the first — two armed sends of one order would reach the vendor twice');
    const pending = (await db.query(
      `SELECT count(*)::int AS n FROM scheduled_sends WHERE application_id=$1 AND kind='title_order' AND status IN ('scheduled','sending')`, [appId])).rows[0].n;
    ok(pending === 1, 'exactly one is ever armed');

    ok((await call(server, 'POST', `/api/staff/applications/${appId}/orders/title/schedule`, outTok,
      { day: dayOf(soon), time: timeOf(soon) })).status === 403,
      'a staffer with no relationship to the file cannot queue a send on it');
    ok((await call(server, 'GET', `/api/staff/applications/${appId}/scheduled-sends`, outTok)).status === 403,
      '…nor read what is queued on it');
    ok((await call(server, 'POST', `/api/staff/applications/${appId}/orders/title/schedule`, tok,
      { day: dayOf(soon), time: '25:00' })).status === 400, 'and a nonsense time is refused at the door');

    /* ── C. the send itself — the whole point ─────────────────────────────── */
    console.log('\nC. the due moment re-runs the REAL order route');
    await addTitleVendor();
    const armed = again.body.scheduled.id;
    await makeDue(armed);
    outbox.length = 0;
    const ran = await sched.dispatchDue();
    ok(ran.length === 1 && ran[0].status === 'sent', 'the dispatcher sends it');
    ok(outbox.length === 1, 'exactly ONE email left the building — not none, and not one per retry');
    ok(String(outbox[0].to || outbox[0].To || '').includes(`ss-title-${sfx}@t.local`)
       || JSON.stringify(outbox[0]).includes(`ss-title-${sfx}@t.local`),
      '…and it went to the title company');
    const order = (await db.query(`SELECT * FROM file_orders WHERE application_id=$1 AND order_type='title'`, [appId])).rows[0];
    ok(!!order && order.status === 'ordered', 'and the ORDER is really placed — this is the ordinary route, not a copy of it');
    ok(order.vendor_email === `ss-title-${sfx}@t.local`,
      '…addressed to the vendor as the file stands AT THE DUE MOMENT (the contact did not exist when this was scheduled)');
    ok(order.ordered_by === officer, 'and recorded against the person who scheduled it, not against PILOT');
    ok((await rowOf(armed)).status === 'sent', 'the queue row is settled');
    ok((await sched.dispatchDue()).length === 0, 'and it does not go out a second time');

    /* ── D. a blocker at the due moment REFUSES, and says so ──────────────── */
    console.log('\nD. what happens when it should NOT go out');
    const app2 = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, ys_loan_number, property_address, status, loan_type, usps_imported_at)
       VALUES ($1,$2,$3,$4,'underwriting','Purchase', now()) RETURNING id`,
      [borrower, officer, `YS${String(Date.now()).slice(-8)}02`,
       JSON.stringify({ oneLine: '11 Sched Ave, Brooklyn, NY 11211', street: '11 Sched Ave', city: 'Brooklyn', state: 'NY', zip: '11211' })])).rows[0].id;
    await db.query(`INSERT INTO application_assignees (application_id, staff_id, role) VALUES ($1,$2,'loan_officer') ON CONFLICT DO NOTHING`, [app2, officer]);
    clean.unshift(async () => {
      await db.query(`DELETE FROM scheduled_sends WHERE application_id=$1`, [app2]);
      await db.query(`DELETE FROM applications WHERE id=$1`, [app2]);
    });
    const s2 = (await call(server, 'POST', `/api/staff/applications/${app2}/orders/title/schedule`, tok,
      { day: dayOf(soon), time: timeOf(soon) })).body.scheduled.id;
    await makeDue(s2);
    const r2 = await sched.dispatchDue();
    ok(r2.length === 1 && r2[0].status === 'failed', 'a file with no title contact does NOT send an order into the void');
    const row2 = await rowOf(s2);
    ok(/title company contact/i.test(row2.last_error || ''),
      '…and the reason recorded is the send route’s OWN wording, because it is the send route that refused');
    const told = (await db.query(
      `SELECT count(*)::int AS n FROM notifications WHERE staff_id=$1 AND title ILIKE '%did NOT go out%'`, [officer])).rows[0].n;
    ok(told >= 1, 'and the person who scheduled it is TOLD — a silent failure means nobody is chasing an order they think went hours ago');

    /* ── E. a dead file, decided at the due moment, not at scheduling time ── */
    console.log('\nE. the file can change between the scheduling and the send');
    const app3 = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, ys_loan_number, property_address, status, loan_type, usps_imported_at)
       VALUES ($1,$2,$3,$4,'underwriting','Purchase', now()) RETURNING id`,
      [borrower, officer, `YS${String(Date.now()).slice(-8)}03`,
       JSON.stringify({ oneLine: '13 Sched Ave, Brooklyn, NY 11211', street: '13 Sched Ave', city: 'Brooklyn', state: 'NY', zip: '11211' })])).rows[0].id;
    await db.query(`INSERT INTO application_assignees (application_id, staff_id, role) VALUES ($1,$2,'loan_officer') ON CONFLICT DO NOTHING`, [app3, officer]);
    const c3 = (await db.query(
      `INSERT INTO service_contacts (borrower_id, contact_type, company_name, contact_name, email)
       VALUES ($1,'title_company','Sched Title Co','A Person',$2) RETURNING id`, [borrower, `ss-t3-${sfx}@t.local`])).rows[0].id;
    await db.query(`INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type)
                    VALUES ($1,$2,'title_company') ON CONFLICT DO NOTHING`, [app3, c3]);
    clean.unshift(async () => {
      await db.query(`DELETE FROM scheduled_sends WHERE application_id=$1`, [app3]);
      await db.query(`DELETE FROM applications WHERE id=$1`, [app3]);
      await db.query(`DELETE FROM service_contacts WHERE id=$1`, [c3]);
    });
    const s3 = (await call(server, 'POST', `/api/staff/applications/${app3}/orders/title/schedule`, tok,
      { day: dayOf(soon), time: timeOf(soon) })).body.scheduled.id;
    ok((await call(server, 'GET', `/api/staff/applications/${app3}/scheduled-sends`, tok)).body[0].status === 'scheduled',
      'it is armed while the file is live');
    // The deal is withdrawn overnight. Nothing goes to an outside vendor about it.
    await db.query(`UPDATE applications SET status='withdrawn' WHERE id=$1`, [app3]);
    await makeDue(s3);
    const r3 = await sched.dispatchDue();
    ok(r3.length === 1 && r3[0].status === 'failed', 'a deal that died overnight does NOT mail an order to an outside vendor in the morning');
    ok(!(await db.query(`SELECT 1 FROM file_orders WHERE application_id=$1 AND order_type='title' AND status='ordered'`, [app3])).rowCount,
      '…and no order is recorded either');

    /* ── F. the authority is re-resolved, never remembered ────────────────── */
    console.log('\nF. a send inherits the scheduler’s access as it is THEN');
    const app4 = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, ys_loan_number, property_address, status, loan_type, usps_imported_at)
       VALUES ($1,$2,$3,$4,'underwriting','Purchase', now()) RETURNING id`,
      [borrower, officer, `YS${String(Date.now()).slice(-8)}04`,
       JSON.stringify({ oneLine: '15 Sched Ave, Brooklyn, NY 11211', street: '15 Sched Ave', city: 'Brooklyn', state: 'NY', zip: '11211' })])).rows[0].id;
    await db.query(`INSERT INTO application_assignees (application_id, staff_id, role) VALUES ($1,$2,'loan_officer') ON CONFLICT DO NOTHING`, [app4, officer]);
    const c4 = (await db.query(
      `INSERT INTO service_contacts (borrower_id, contact_type, company_name, contact_name, email)
       VALUES ($1,'title_company','Sched Title Co','A Person',$2) RETURNING id`, [borrower, `ss-t4-${sfx}@t.local`])).rows[0].id;
    await db.query(`INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type)
                    VALUES ($1,$2,'title_company') ON CONFLICT DO NOTHING`, [app4, c4]);
    clean.unshift(async () => {
      await db.query(`DELETE FROM scheduled_sends WHERE application_id=$1`, [app4]);
      await db.query(`DELETE FROM applications WHERE id=$1`, [app4]);
      await db.query(`DELETE FROM service_contacts WHERE id=$1`, [c4]);
    });
    const s4 = (await call(server, 'POST', `/api/staff/applications/${app4}/orders/title/schedule`, tok,
      { day: dayOf(soon), time: timeOf(soon) })).body.scheduled.id;
    // They leave the company between the scheduling and the send.
    await db.query(`UPDATE staff_users SET is_active=false WHERE id=$1`, [officer]);
    /* TWO layers refuse this and either alone is enough — `credentialFor`'s own
       is_active test, and `requireAuth`, which refuses a deactivated account with
       a 401 that `runOne` reports in the same words. Proven by mutation: removing
       the check below still leaves the send refused. That is defence in depth,
       and the fast check is what makes the message say "no longer has access"
       rather than "the send answered 401" — do not delete it because the
       end-to-end assertion survives without it. */
    ok((await sched.credentialFor(officer)) === null, 'a deactivated staffer has no credential to send with');
    await makeDue(s4);
    const r4 = await sched.dispatchDue();
    ok(r4.length === 1 && r4[0].status === 'failed', '…so the send is refused rather than going out in their name');
    ok(/no longer has access/i.test((await rowOf(s4)).last_error || ''), 'and it says exactly that');
    ok(!(await db.query(`SELECT 1 FROM file_orders WHERE application_id=$1 AND order_type='title' AND status='ordered'`, [app4])).rowCount,
      'nothing was ordered');
    await db.query(`UPDATE staff_users SET is_active=true WHERE id=$1`, [officer]);
    // The same is true of a sign-out-everywhere: the minted credential carries the
    // token_version, so a bumped one is refused by the ordinary auth path.
    await db.query(`UPDATE staff_users SET token_version = token_version + 1 WHERE id=$1`, [officer]);
    const cred = await sched.credentialFor(officer);
    const stale = C.signJwt({ sub: officer, kind: 'staff', role: 'loan_officer', tv: 0 }, 60);
    const staffRouter = require('../src/routes/staff');
    const withStale = await sched.callRoute(staffRouter, 'POST', `/applications/${app4}/orders/title/place`, { token: stale, body: {} });
    ok(withStale.status === 401, 'a credential from before a sign-out-everywhere is refused by the ordinary auth path');
    const withFresh = await sched.callRoute(staffRouter, 'POST', `/applications/${app4}/orders/title/place`, { token: cred.token, body: {} });
    ok(withFresh.status !== 401, '…while the one minted at the due moment is not — the version is re-read, never remembered');
    await db.query(`UPDATE file_orders SET status='not_ordered' WHERE application_id=$1`, [app4]).catch(() => {});
    // The bump above invalidated this suite's OWN token as well — which is the
    // rule working. Re-mint it so the sections below test what they are about.
    tok = C.signJwt({ sub: officer, kind: 'staff', role: 'loan_officer',
      tv: (await db.query(`SELECT token_version FROM staff_users WHERE id=$1`, [officer])).rows[0].token_version, sid: 'test' });

    /* ── G. never too late to be useful ───────────────────────────────────── */
    console.log('\nG. an overdue queue is not quietly flushed');
    const app5 = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, ys_loan_number, property_address, status, loan_type, usps_imported_at)
       VALUES ($1,$2,$3,$4,'underwriting','Purchase', now()) RETURNING id`,
      [borrower, officer, `YS${String(Date.now()).slice(-8)}05`,
       JSON.stringify({ oneLine: '17 Sched Ave, Brooklyn, NY 11211', street: '17 Sched Ave', city: 'Brooklyn', state: 'NY', zip: '11211' })])).rows[0].id;
    await db.query(`INSERT INTO application_assignees (application_id, staff_id, role) VALUES ($1,$2,'loan_officer') ON CONFLICT DO NOTHING`, [app5, officer]);
    const c5 = (await db.query(
      `INSERT INTO service_contacts (borrower_id, contact_type, company_name, contact_name, email)
       VALUES ($1,'title_company','Sched Title Co','A Person',$2) RETURNING id`, [borrower, `ss-t5-${sfx}@t.local`])).rows[0].id;
    await db.query(`INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type)
                    VALUES ($1,$2,'title_company') ON CONFLICT DO NOTHING`, [app5, c5]);
    clean.unshift(async () => {
      await db.query(`DELETE FROM scheduled_sends WHERE application_id=$1`, [app5]);
      await db.query(`DELETE FROM applications WHERE id=$1`, [app5]);
      await db.query(`DELETE FROM service_contacts WHERE id=$1`, [c5]);
    });
    const s5 = (await call(server, 'POST', `/api/staff/applications/${app5}/orders/title/schedule`, tok,
      { day: dayOf(soon), time: timeOf(soon) })).body.scheduled.id;
    // PILOT was down all day and comes back to a queue of things due this morning.
    await makeDue(s5, sched.STALE_AFTER_MIN + 30);
    const r5 = await sched.dispatchDue();
    ok(r5.length === 1 && r5[0].status === 'failed' && r5[0].code === 'stale',
      'a send PILOT only reached hours late is NOT posted as though nothing happened');
    ok(!(await db.query(`SELECT 1 FROM file_orders WHERE application_id=$1 AND order_type='title' AND status='ordered'`, [app5])).rowCount,
      '…nothing went to the vendor');
    ok(/was NOT sent/i.test((await rowOf(s5)).last_error || ''), 'and it says plainly that it did not go, so somebody can decide whether it still should');

    /* ── H. cancelling ───────────────────────────────────────────────────── */
    console.log('\nH. taking one back out');
    const s6 = (await call(server, 'POST', `/api/staff/applications/${app5}/orders/insurance/schedule`, tok,
      { day: dayOf(soon), time: timeOf(soon) })).body.scheduled.id;
    ok((await call(server, 'POST', `/api/staff/applications/${app5}/scheduled-sends/${s6}/cancel`, outTok)).status === 403,
      'a stranger cannot cancel a send on somebody else’s file');
    ok((await call(server, 'POST', `/api/staff/applications/${app5}/scheduled-sends/${s6}/cancel`, tok)).status === 200,
      'anyone who could have sent it can cancel it');
    await makeDue(s6);
    ok((await sched.dispatchDue()).length === 0, 'and a cancelled send never fires');
    ok((await call(server, 'POST', `/api/staff/applications/${app5}/scheduled-sends/${s6}/cancel`, tok)).status === 409,
      'cancelling it twice says so rather than pretending');
    /* A send already IN FLIGHT cannot be stopped, and saying otherwise is the worst
       answer available: the email may already be with the vendor while the person
       is told it was cancelled. */
    const sF = (await call(server, 'POST', `/api/staff/applications/${app5}/orders/insurance/schedule`, tok,
      { day: dayOf(soon), time: timeOf(soon) })).body.scheduled.id;
    await db.query(`UPDATE scheduled_sends SET status='sending', claimed_at=now() WHERE id=$1`, [sF]);
    const inFlight = await call(server, 'POST', `/api/staff/applications/${app5}/scheduled-sends/${sF}/cancel`, tok);
    ok(inFlight.status === 409 && inFlight.body.code === 'in_flight',
      'one that is going out right now is NOT reported as cancelled');
    ok(/Email Center/i.test(inFlight.body.error || ''), '…and it points at where to check whether it reached the vendor');
    ok((await rowOf(sF)).status === 'sending', 'and the row is left exactly as it was');
    await db.query(`UPDATE scheduled_sends SET status='cancelled' WHERE id=$1`, [sF]);

    /* ── I. a crash mid-send is surfaced, never silently re-run ───────────── */
    console.log('\nI. a restart in the middle of a send');
    const s7 = (await call(server, 'POST', `/api/staff/applications/${app5}/orders/insurance/schedule`, tok,
      { day: dayOf(soon), time: timeOf(soon) })).body.scheduled.id;
    await db.query(`UPDATE scheduled_sends SET status='sending', claimed_at = now() - interval '1 hour' WHERE id=$1`, [s7]);
    ok((await sched.reapStuck()) >= 1, 'a row abandoned mid-send is picked up');
    const row7 = await rowOf(s7);
    ok(row7.status === 'failed' && row7.last_error_code === 'interrupted',
      '…and is FAILED, never re-run — an order email is not safe to send again on a guess');
    ok(/Email Center/i.test(row7.last_error || ''), 'and it points at where to check whether it went out');

    /* ── J. the registry and the doors agree ─────────────────────────────── */
    console.log('\nJ. what can be scheduled');
    // ASK THE DATABASE WHAT IT ALLOWS — never a migration FILE.
    //
    // This used to read db/599, the file that first defined this constraint, and a
    // CHECK in this repo is deliberately WIDENED IN PLACE under its own name by a
    // later migration (the db/527 pattern; db/602 added `tape_to_investor`). So the
    // file that defines a constraint stops being the file that DESCRIBES it the first
    // time anybody widens it, and this section failed on a constraint that was
    // perfectly correct — a hand-maintained pointer at a fact the database can state
    // itself. `pg_get_constraintdef` is that fact, so the next widening needs no edit
    // here and a genuine drift still fails.
    const conDef = (await db.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid='scheduled_sends'::regclass AND conname='scheduled_sends_kind_chk'`)).rows[0];
    ok(!!conDef, 'the kind CHECK is on the real table — without it the queue would accept a kind nothing can run');
    const def = (conDef && conDef.def) || '';
    const inSql = (def.match(/'([a-z_]+)'::text/g) || []).map((x) => x.replace(/'|::text/g, ''));
    for (const k of Object.keys(sched.KINDS)) {
      ok(inSql.includes(k), `the database allows the kind the registry offers: ${k}`);
    }
    ok(inSql.length === Object.keys(sched.KINDS).length,
      `and allows nothing the registry does not — a kind the dispatcher cannot run must never sit in the queue (db: ${inSql.join(', ')})`);
    ok(Object.keys(sched.KINDS).every((k) => typeof sched.KINDS[k].path === 'function' && sched.KINDS[k].router),
      'every kind names the real route it re-enters');
    /* AND THAT ROUTE REALLY EXISTS. A typo in a registry path would otherwise sit
       there answering "not found" for ever and read as an ordinary missing file —
       which is why the router fall-through has its own `no_route` code. Each kind
       is dialled with a real credential against a real file id; what it answers
       does not matter, only that SOMETHING matched. */
    const credJ = await sched.credentialFor(officer);
    for (const k of Object.keys(sched.KINDS)) {
      const meta = sched.KINDS[k];
      const r = await sched.callRoute((meta.router === 'sitewire' ? require('../src/routes/sitewire') : require('../src/routes/staff')),
        'POST', meta.path({ application_id: app5, target_key: '1' }), { token: credJ.token, body: {} });
      ok(!(r.body && r.body.code === 'no_route'), `…and the route for ${k} is really mounted`);
    }
    // The four the owner named, by name.
    for (const k of ['title_order', 'insurance_order', 'closing_prep', 'investor_delivery']) {
      ok(sched.isKind(k), `the owner asked for it and it is here: ${k}`);
    }
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'lib', 'scheduled-sends.js'), 'utf8');
    ok(!/sendMail|buildOrderEmail|attachments|recipientsFor/.test(src),
      'the scheduler contains NO email code — it re-enters the send route rather than owning a second copy of it');

    /* ── K. the closing-prep and investor-delivery doors ─────────────────── */
    console.log('\nK. the other two the owner named');
    const cp = await call(server, 'POST', `/api/staff/applications/${app5}/closing-prep/schedule`, tok,
      { day: dayOf(soon), time: timeOf(soon), note: 'please prep' });
    ok(cp.status === 200 && cp.body.scheduled.kind === 'closing_prep', 'the closing-prep request can be scheduled');
    ok(Array.isArray(cp.body.warnings), '…and says what would still stop it');
    const cpRow = await rowOf(cp.body.scheduled.id);
    ok(cpRow.payload && cpRow.payload.note === 'please prep', 'the person’s own note travels with the intent');
    ok(!JSON.stringify(cpRow.payload).includes('attach'), '…but the DOCUMENTS do not — they are gathered fresh at the due moment');
    ok((await call(server, 'POST', `/api/staff/applications/${app5}/closing-prep/schedule`, outTok,
      { day: dayOf(soon), time: timeOf(soon) })).status === 403, 'and a stranger cannot queue one');
    ok((await call(server, 'POST', `/api/sitewire/files/${app5}/draws/1/investor-delivery/schedule`, tok,
      { day: dayOf(soon), time: timeOf(soon), confirm_note_buyer: 'Whoever' })).status === 403,
      'the investor-delivery scheduler needs the draw permission, exactly like the delivery itself');

    /* ── L2. two dispatchers, one order ──────────────────────────────────── */
    console.log('\nL2. two instances running at the same minute');
    // PILOT runs on more than one web instance and every one of them ticks. An
    // order email is the last thing that may go out twice, so the claim uses
    // FOR UPDATE SKIP LOCKED — this proves it rather than trusting it.
    const sC = (await call(server, 'POST', `/api/staff/applications/${app5}/orders/title/schedule`, tok,
      { day: dayOf(soon), time: timeOf(soon), force: true })).body.scheduled.id;
    await makeDue(sC);
    const seen = [];
    const both = await Promise.all([
      sched.dispatchDue(db, { routerFor: () => (req, res) => { seen.push(1); res.status(200).json({ ok: true }); }, retryAfterSec: 0 }),
      sched.dispatchDue(db, { routerFor: () => (req, res) => { seen.push(1); res.status(200).json({ ok: true }); }, retryAfterSec: 0 }),
    ]);
    ok(seen.length === 1, 'two dispatchers racing on one due send run it EXACTLY once');
    ok(both.flat().filter((r) => r.status === 'sent').length === 1, '…and only one of them reports having sent it');
    ok((await rowOf(sC)).status === 'sent', 'the row is settled once');

    /* ── L. transient vs decided ─────────────────────────────────────────── */
    console.log('\nL. trying again, and knowing when not to');
    // The retry policy is exercised through the router seam rather than by
    // making a real send fail, because what is under test is the DISPATCHER's
    // judgement — "is this worth trying again?" — not any particular route's.
    const fakeRouter = (code, hits) => (req, res) => { hits.push(req.url); res.status(code).json({ error: 'nope', code: 'x' }); };
    const s8 = (await call(server, 'POST', `/api/staff/applications/${app5}/orders/insurance/schedule`, tok,
      { day: dayOf(soon), time: timeOf(soon) })).body.scheduled.id;
    await makeDue(s8);
    let hits = [];
    // ONE tick. A 503 is "something on our side broke" — worth another go.
    const t1 = await sched.dispatchDue(db, { routerFor: () => fakeRouter(503, hits) });
    ok(t1.length === 1 && t1[0].status === 'retry', 'a 5xx is put back for another go rather than being called a decision');
    ok(hits.length === 1,
      'and ONE tick makes ONE attempt — without a backoff the loop re-claims it instantly and burns every attempt in the same minute, against a provider that has had no time to recover');
    ok((await rowOf(s8)).status === 'scheduled' && (await rowOf(s8)).attempts === 1, 'the row is armed again, with the attempt counted');
    // Later ticks. The backoff is stood down so the test does not sleep.
    hits = [];
    await sched.dispatchDue(db, { routerFor: () => fakeRouter(503, hits), retryAfterSec: 0 });
    await sched.dispatchDue(db, { routerFor: () => fakeRouter(503, hits), retryAfterSec: 0 });
    const row8 = await rowOf(s8);
    ok(row8.status === 'failed' && row8.attempts === sched.MAX_ATTEMPTS,
      'it gives up after a few goes rather than retrying an order email for ever');

    const s9 = (await call(server, 'POST', `/api/staff/applications/${app5}/orders/title/schedule`, tok,
      { day: dayOf(soon), time: timeOf(soon), force: true })).body.scheduled.id;
    await makeDue(s9);
    hits = [];
    const t9 = await sched.dispatchDue(db, { routerFor: () => fakeRouter(422, hits), retryAfterSec: 0 });
    ok(t9.length === 1 && t9[0].status === 'failed', 'a 4xx is a DECISION — the file said no, and running it again changes nothing');
    ok(hits.length === 1, '…so it is attempted exactly once');
    ok(sched.isTransient(503) && !sched.isTransient(422) && !sched.isTransient(409),
      'and that is the rule: our side broke = try again, the file said no = do not');

  } finally {
    mailer.sendMail = realSend;
    for (const fn of clean) { try { await fn(); } catch (_) { /* best effort */ } }
    server.close();
    await db.pool.end().catch(() => {});
  }

  if (fail) { console.error(`\n${fail} FAILURE(S)`); process.exit(1); }
  console.log('\nOK  scheduled sends: the intent is queued, the real send route runs at the due moment');
})().catch((e) => { console.error(e); process.exit(1); });
