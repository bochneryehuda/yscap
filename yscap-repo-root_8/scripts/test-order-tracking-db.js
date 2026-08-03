/**
 * AN ORDER IS A TRACKED THING — real Postgres, real HTTP. Skips with no DATABASE_URL.
 *
 * Before this, `file_orders` recorded who an order went to and when, and nothing
 * else. PILOT could not answer the three questions the desk exists for: which
 * orders are late, who is chasing this one, and what has happened to it. So a
 * title order sent three weeks ago and one sent this morning looked identical,
 * `completed` was unreachable for title and insurance (every deal we have ever
 * closed sat on the desk looking outstanding), and nothing ever nudged anybody.
 *
 * This pins the parts a pure test cannot: the real columns, the real routes, the
 * retire sweep against a real signed-off condition, and the aging sweep's throttle.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-order-tracking-db (no DATABASE_URL)'); process.exit(0); }
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';
process.env.CHAT_REPLY_DOMAIN = process.env.CHAT_REPLY_DOMAIN || 'reply.yscapgroup.com';

const db = require('../src/db');
const tracking = require('../src/lib/order-tracking');
const orderSla = require('../src/lib/order-sla');
const { signJwt } = require('../src/lib/crypto');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `otr-${process.pid}-${Date.now()}`;

(async () => {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const mkStaff = async (role, name, email) => (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,$2,$3,true) RETURNING id`,
    [email, name, role])).rows[0].id;
  const officer = await mkStaff('loan_officer', 'Ophelia Officer', `${uniq}-lo@example.test`);
  const processor = await mkStaff('processor', 'Percy Processor', `${uniq}-proc@example.test`);
  const other = await mkStaff('underwriter', 'Uma Underwriter', `${uniq}-uw@example.test`);
  const gone = await mkStaff('processor', 'Gone Person', `${uniq}-gone@example.test`);
  await db.query(`UPDATE staff_users SET is_active=false WHERE id=$1`, [gone]);
  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Bo','Rrower',$1) RETURNING id`,
    [`${uniq}-bo@example.test`])).rows[0].id;

  const mkApp = async ({ withProcessor = true, status = 'underwriting' } = {}) => {
    const id = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, processor_id, ys_loan_number, property_address, status, loan_type, usps_imported_at)
       VALUES ($1,$2,$3,$4,$5,$6,'Purchase', now()) RETURNING id`,
      [borrower, officer, withProcessor ? processor : null,
       `YS${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 90 + 10)}`,
       JSON.stringify({ oneLine: '3 Clock Ct, Brooklyn, NY 11211', street: '3 Clock Ct', city: 'Brooklyn', state: 'NY', zip: '11211' }),
       status])).rows[0].id;
    await db.query(`INSERT INTO application_assignees (application_id, staff_id, role) VALUES ($1,$2,'loan_officer')
                    ON CONFLICT DO NOTHING`, [id, officer]);
    return id;
  };
  const addVendor = async (appId, type, email) => {
    const c = (await db.query(
      `INSERT INTO service_contacts (borrower_id, contact_type, company_name, contact_name, email)
       VALUES ($1,$2,$3,'A Person',$4) RETURNING id`, [borrower, type, `${type} co`, email])).rows[0].id;
    await db.query(
      `INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [appId, c, type]);
    return c;
  };
  const jwtLo = signJwt({ sub: officer, kind: 'staff', role: 'loan_officer', tv: 0, sid: 'test' });
  const call = async (method, p, body, jwt = jwtLo) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null; try { j = await r.json(); } catch (_) { /* not json */ }
    return { status: r.status, body: j };
  };
  // Place an order for real, with the provider stubbed to succeed.
  const placeOrder = async (appId, kind) => {
    const email = require('../src/lib/email');
    const real = email.sendMail;
    email.sendMail = async () => ({ ok: true, id: 'test' });
    try { return await call('POST', `/api/staff/applications/${appId}/orders/${kind}/place`, {}); }
    finally { email.sendMail = real; }
  };
  const orderRow = async (appId, kind) => (await db.query(
    `SELECT * FROM file_orders WHERE application_id=$1 AND order_type=$2`, [appId, kind])).rows[0];
  // The file itself saying the documents arrived AND were accepted — the ONE
  // finish line the retire sweep recognises.
  const signOffCondition = async (appId, code) => (await db.query(
    `INSERT INTO checklist_items (template_id, scope, application_id, label, audience, item_kind, status, signed_off_at)
     SELECT t.id, 'application', $1, t.label, 'staff', 'document', 'satisfied', now()
       FROM checklist_templates t WHERE t.code=$2 RETURNING id`, [appId, code])).rows[0];

  /* ── A. placing an order gives it an owner and a first line of history ────── */
  console.log('\nA. an order arrives with an owner and a history');
  let appA;
  {
    appA = await mkApp();
    await addVendor(appA, 'title_company', `${uniq}-t1@vendor.test`);
    const r = await placeOrder(appA, 'title');
    assert(r.status === 200, `the order sends (got ${r.status} ${r.body && r.body.error})`);
    const row = await orderRow(appA, 'title');
    assert(row.assigned_to === processor,
      'the file PROCESSOR is chasing it by default — an order nobody owns is the order nobody chases');
    assert(!!row.assigned_at, 'and the assignment is stamped');
    const ev = await tracking.listEvents(appA, 'title');
    assert(ev.length >= 1 && ev[ev.length - 1].kind === 'placed', 'the history opens with "placed"');
    assert(ev[ev.length - 1].actor_id === officer, 'and it names who placed it');
  }

  /* ── B. the due date is DERIVED, so nothing had to be back-filled ─────────── */
  console.log('\nB. the clock');
  {
    const row = await orderRow(appA, 'title');
    const st = orderSla.orderState(row, new Date());
    assert(st.dueOn && !st.dueOnIsOverride, 'a freshly placed order already has a due date, with nothing stored');
    assert(st.slaDays === 3, 'title waits three business days');
    assert(st.overdue === false, 'and it is not late on the day it was placed');

    // A human pins a date the derivation cannot know ("they said the 20th").
    const set = await call('POST', `/api/staff/applications/${appA}/orders/title/due`, { dueOn: '2027-03-15' });
    assert(set.status === 200 && set.body.state.dueOn === '2027-03-15', 'a typed date is honoured');
    assert(set.body.state.dueOnIsOverride === true, 'and is marked as set by hand');
    const back = await call('POST', `/api/staff/applications/${appA}/orders/title/due`, { dueOn: null });
    assert(back.status === 200 && back.body.state.dueOnIsOverride === false,
      'clearing it drops back to the derived date');
    const bad = await call('POST', `/api/staff/applications/${appA}/orders/title/due`, { dueOn: 'next tuesday' });
    assert(bad.status === 400, 'an unreadable date is refused, never stored as junk');
    const slow = await call('POST', `/api/staff/applications/${appA}/orders/title/due`, { slaDays: 10 });
    assert(slow.status === 200 && slow.body.state.slaDays === 10, 'the whole clock can be moved for one order');
    const silly = await call('POST', `/api/staff/applications/${appA}/orders/title/due`, { slaDays: 9999 });
    assert(silly.status === 400, 'an absurd SLA is refused');
    await db.query(`UPDATE file_orders SET sla_days=NULL WHERE application_id=$1 AND order_type='title'`, [appA]);
    const evs = await tracking.listEvents(appA, 'title');
    assert(evs.some((e) => e.kind === 'due_changed'), 'every change to the clock is on the record');
  }

  /* ── C. any staff member can be assigned; a departed one cannot ───────────── */
  console.log('\nC. who is chasing it');
  {
    const toUw = await call('POST', `/api/staff/applications/${appA}/orders/title/assign`, { staffId: other });
    assert(toUw.status === 200, 'ANY active staff member can take it (owner-directed: "and also any staff members")');
    assert((await orderRow(appA, 'title')).assigned_to === other, 'and the row says so');
    const toGone = await call('POST', `/api/staff/applications/${appA}/orders/title/assign`, { staffId: gone });
    assert(toGone.status === 400,
      'a DEACTIVATED person is refused — that is indistinguishable from nobody, except it LOOKS covered');
    const junk = await call('POST', `/api/staff/applications/${appA}/orders/title/assign`, { staffId: 'not-a-uuid' });
    assert(junk.status === 400, 'junk is refused');
    const off = await call('POST', `/api/staff/applications/${appA}/orders/title/assign`, { staffId: null });
    assert(off.status === 200 && (await orderRow(appA, 'title')).assigned_to === null,
      'and it can go back to the team — a real action, not a mistake');
    // Re-placing must NOT steal it back from whoever took it on.
    await call('POST', `/api/staff/applications/${appA}/orders/title/assign`, { staffId: other });
    await tracking.ensureAssignee(appA, 'title');
    assert((await orderRow(appA, 'title')).assigned_to === other,
      'the default owner is FILL-ONLY — it never moves an assignment a human made');
  }

  /* ── D. a note lives on the order ────────────────────────────────────────── */
  console.log('\nD. what is known about it');
  {
    const n = await call('POST', `/api/staff/applications/${appA}/orders/title/note`, { note: 'They said Thursday.' });
    assert(n.status === 200 && (await orderRow(appA, 'title')).notes === 'They said Thursday.', 'a note is kept on the order');
    // A NUL byte is refused by every text column in Postgres — the shared
    // `textColumn` chokepoint strips it before it can 500 the request.
    const nul = await call('POST', `/api/staff/applications/${appA}/orders/title/note`, { note: 'ok\u0000bad' });
    const nulNote = String((await orderRow(appA, 'title')).notes);
    assert(nul.status === 200 && !nulNote.includes(String.fromCharCode(0)) && nulNote === 'okbad',
      'and a NUL byte is stripped rather than raising a database error');
  }

  /* ── E. the vendor's reply stops the clock on them ────────────────────────── */
  console.log('\nE. the vendor answers');
  {
    const first = await tracking.noteFirstResponse(appA, 'title');
    assert(first === true, 'the first reply is stamped');
    const row1 = await orderRow(appA, 'title');
    assert(!!row1.first_response_at, 'so the desk knows how responsive they were');
    const again = await tracking.noteFirstResponse(appA, 'title');
    assert(again === false, 'a LATER reply does not overwrite it — the first one is the fact a scorecard wants');
    assert((await orderRow(appA, 'title')).first_response_at.getTime() === row1.first_response_at.getTime(),
      'and the stamp is unchanged');
  }

  /* ── F. an order that is DONE leaves the desk ─────────────────────────────── */
  console.log('\nF. finishing');
  {
    const appB = await mkApp();
    await addVendor(appB, 'title_company', `${uniq}-t2@vendor.test`);
    await placeOrder(appB, 'title');

    // Not finished yet — the condition is still open.
    let n = await tracking.retireSatisfiedOrdersOnce();
    assert((await orderRow(appB, 'title')).status === 'ordered',
      'an order whose condition is still open stays on the desk');

    // Sign the title condition off, the way the file itself says the documents
    // arrived and were accepted.
    const cond = (await db.query(
      `INSERT INTO checklist_items (template_id, scope, application_id, label, audience, item_kind, status, signed_off_at)
       SELECT t.id, 'application', $1, t.label, 'staff', 'document', 'satisfied', now()
         FROM checklist_templates t WHERE t.code='rtl_cond_title' RETURNING id`, [appB])).rows[0];
    assert(!!cond, 'the title condition exists to sign off');
    n = await tracking.retireSatisfiedOrdersOnce();
    const done = await orderRow(appB, 'title');
    assert(done.status === 'completed',
      'once the condition is signed off the order is COMPLETED — nothing ever wrote that for title or insurance, so every closed deal sat here looking outstanding');
    assert(!!done.completed_at, 'with the date it finished');
    // NEVER 'cancelled': that is an explicit human stand-down which closes the
    // follow-up and reply doors, so finishing an order with it would shut the team
    // out of writing to a vendor about a loan that is merely done.
    assert(done.status !== 'cancelled', 'and never CANCELLED, which means something else entirely');
    const ev = await tracking.listEvents(appB, 'title');
    assert(ev.some((e) => e.kind === 'completed'), 'the history records it finishing');
    // Idempotent.
    const again = await tracking.retireSatisfiedOrdersOnce();
    const evAfter = await tracking.listEvents(appB, 'title');
    assert(evAfter.filter((e) => e.kind === 'completed').length === 1,
      're-running the sweep does not record it twice');

    // FUNDING DOES NOT RETIRE AN ORDER AT ALL — there is ONE finish line.
    //
    // This assertion has been rewritten twice, and the history is the point. It
    // first demanded "a funded loan finishes its orders, condition or not", which
    // hid the final policy and the recorded mortgage behind a completed badge. The
    // second version narrowed funding to "the vendor answered" — and an audit was
    // right that `first_response_at` is stamped when the FIRST document lands, so
    // an insurance agent who sends the binder and never the invoice still had the
    // order swept away with half the condition outstanding.
    const appC = await mkApp();
    await addVendor(appC, 'insurance_agent', `${uniq}-i2@vendor.test`);
    await placeOrder(appC, 'insurance');
    await db.query(`UPDATE applications SET status='funded' WHERE id=$1`, [appC]);
    await tracking.retireSatisfiedOrdersOnce();
    assert((await orderRow(appC, 'insurance')).status !== 'completed',
      'funding alone does NOT finish an order — the final policy and the recorded mortgage arrive afterwards');
    // The binder arriving is NOT the finish line either — that is the exact
    // half-done state `first_response_at` could not tell apart.
    await tracking.noteFirstResponse(appC, 'insurance');
    await tracking.retireSatisfiedOrdersOnce();
    assert((await orderRow(appC, 'insurance')).status !== 'completed',
      'nor does the vendor merely having SENT something — a binder without its invoice is not a finished order');
    // Signing off the condition is. That is the file saying the documents arrived
    // AND were accepted.
    await signOffCondition(appC, 'rtl_cond_insurance');
    await tracking.retireSatisfiedOrdersOnce();
    const cRow = await orderRow(appC, 'insurance');
    assert(cRow.status === 'completed', 'signing off the condition finishes it');
    const cEv = await tracking.listEvents(appC, 'insurance');
    assert(cEv.some((e) => e.kind === 'completed' && e.detail && /signed off/.test(String(e.detail.reason || ''))),
      'and the history names the condition, which is what actually finished it');

    // STARVATION. The qualifying test lives in the WHERE, not after the LIMIT — so
    // an order that can never qualify cannot re-occupy a slot every tick and keep
    // a genuinely finished one out of the window forever.
    const appE = await mkApp();
    await addVendor(appE, 'title_company', `${uniq}-t9@vendor.test`);
    await placeOrder(appE, 'title');
    await signOffCondition(appE, 'rtl_cond_title');
    // An older order that can NEVER qualify sits ahead of it.
    const appF = await mkApp();
    await addVendor(appF, 'title_company', `${uniq}-t10@vendor.test`);
    await placeOrder(appF, 'title');
    await db.query(`UPDATE file_orders SET ordered_at = now() - interval '900 days'
                     WHERE application_id=$1 AND order_type='title'`, [appF]);
    await tracking.retireSatisfiedOrdersOnce({ limit: 1 });
    assert((await orderRow(appE, 'title')).status === 'completed',
      'a qualifying order is retired even when an older order that can NEVER qualify sits ahead of it');
    assert((await orderRow(appF, 'title')).status !== 'completed',
      'and the one that cannot qualify is left alone');
  }

  /* ── G. a late order is chased, once, and the right person is told ────────── */
  console.log('\nG. the aging nudge');
  {
    const digests = require('../src/lib/notification-digests');
    const appD = await mkApp();
    await addVendor(appD, 'title_company', `${uniq}-t3@vendor.test`);
    await placeOrder(appD, 'title');
    // Push it three weeks into the past.
    await db.query(
      `UPDATE file_orders SET ordered_at = now() - interval '21 days' WHERE application_id=$1 AND order_type='title'`, [appD]);
    const st = orderSla.orderState(await orderRow(appD, 'title'), new Date());
    assert(st.overdue && st.daysLate > 5, `three weeks out is very late (${st.daysLate} business days)`);
    assert(st.chase === 'admins', 'and it has escalated past the assignee to the administrators');

    const before = (await db.query(
      `SELECT count(*)::int AS c FROM notifications WHERE application_id=$1 AND type='order_overdue'`, [appD])).rows[0].c;
    await digests.orderOverdueOnce();
    const after = (await db.query(
      `SELECT count(*)::int AS c FROM notifications WHERE application_id=$1 AND type='order_overdue'`, [appD])).rows[0].c;
    // The sweep only runs inside business hours in New York — outside them it
    // correctly sends nothing, so this asserts the behaviour either way rather
    // than failing at 3am.
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date()));
    const inWindow = hour >= 8 && hour <= 18;
    if (inWindow) {
      assert(after > before, 'a very late order nudges the team');
      // …ONCE. The throttle has to appear in the WHERE as well as the gate, or an
      // already-nudged file keeps taking a slot from one that has not been.
      await digests.orderOverdueOnce();
      const third = (await db.query(
        `SELECT count(*)::int AS c FROM notifications WHERE application_id=$1 AND type='order_overdue'`, [appD])).rows[0].c;
      assert(third === after, 'and running the sweep again does NOT nudge again');
    } else {
      assert(after === before, `outside business hours the sweep sends nothing (it is ${hour}:00 in New York)`);
    }

    // AN ORDER ON A DEAD FILE IS NEVER CHASED.
    const appE = await mkApp({ status: 'withdrawn' });
    await addVendor(appE, 'title_company', `${uniq}-t4@vendor.test`);
    await db.query(
      `INSERT INTO file_orders (application_id, order_type, status, ordered_at) VALUES ($1,'title','ordered', now() - interval '30 days')`, [appE]);
    await digests.orderOverdueOnce();
    const dead = (await db.query(
      `SELECT count(*)::int AS c FROM notifications WHERE application_id=$1 AND type='order_overdue'`, [appE])).rows[0].c;
    assert(dead === 0, 'a withdrawn file is never nudged about its orders');
  }

  /* ── H. cancelling and reopening are on the record ────────────────────────── */
  console.log('\nH. standing down, and picking it back up');
  {
    const appF = await mkApp();
    await addVendor(appF, 'insurance_agent', `${uniq}-i3@vendor.test`);
    await placeOrder(appF, 'insurance');
    await call('POST', `/api/staff/applications/${appF}/orders/insurance/cancel`, {});
    assert((await orderRow(appF, 'insurance')).status === 'cancelled', 'it can be stood down');
    const st = orderSla.orderState(await orderRow(appF, 'insurance'), new Date());
    assert(st.overdue === false && st.open === false,
      'and a cancelled order never ages — condition-aging alone would have gone on ageing it');
    await call('POST', `/api/staff/applications/${appF}/orders/insurance/cancel`, { reopen: true });
    assert((await orderRow(appF, 'insurance')).status === 'ordered', 'and picked back up');
    const ev = await tracking.listEvents(appF, 'insurance');
    assert(ev.some((e) => e.kind === 'cancelled') && ev.some((e) => e.kind === 'reopened'),
      'both are on the record, with who did them');
  }

  /* ── I. the file's own payload carries the whole picture ──────────────────── */
  console.log('\nI. one call powers the panel');
  {
    const r = await call('GET', `/api/staff/applications/${appA}/orders`);
    assert(r.status === 200, 'the orders payload loads');
    const t = r.body.orders.title.tracking;
    assert(t && typeof t.overdue === 'boolean' && typeof t.daysOut === 'number',
      'and it carries the clock, computed on the SERVER so the card, the desk and the sweep cannot disagree');
    assert('assignedName' in t && 'notes' in t, 'plus who has it and what is known about it');
    assert(r.body.orders.insurance.tracking === null, 'an order that was never placed has no clock');
  }

  await new Promise((r) => server.close(r));
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll order-tracking checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
