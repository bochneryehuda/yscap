'use strict';
/**
 * Trinity ordering + ingestion — REAL Postgres, with the Trinity API stubbed.
 *
 * A pure test cannot prove a column exists, and every query below runs inside a
 * best-effort catch somewhere in production, so a phantom column would report a
 * confident "nothing to do" forever. These assertions therefore run against the real
 * schema.
 *
 * The API is stubbed rather than called: the LIVE contract is proven separately against
 * the sandbox (see docs/TRINITY-INSPECTION-API-RESEARCH.md §10), and what needs proving
 * HERE is our own behaviour — that a lost response cannot create two orders, that the
 * historical draws are computed from the real ledger, that a refusal is recorded rather
 * than guessed, and above all that NOTHING reaches a borrower without a human.
 *
 * Skips cleanly when DATABASE_URL is unset.
 */

if (!process.env.DATABASE_URL) { console.log('test-trinity-order-db: SKIPPED (no DATABASE_URL)'); process.exit(0); }

process.env.TRINITY_ENABLED = '1';
process.env.TRINITY_OUTBOUND_ENABLED = '1';
process.env.TRINITY_DRYRUN = '0';
process.env.TRINITY_COMPANY_ID = '39400';
process.env.TRINITY_USERNAME = process.env.TRINITY_USERNAME || 'test-user';
process.env.TRINITY_PASSWORD = process.env.TRINITY_PASSWORD || 'test-pass';

const assert = require('assert');
const db = require('../src/db');

// ---- stub the client BEFORE anything requires it -------------------------------
const clientPath = require.resolve('../src/trinity/client');
const client = require(clientPath);
const calls = { created: 0, documents: [], comments: [], cancels: 0 };
let nextCreateThrows = null;
let remoteStatus = { id: 7, name: 'Searching for Inspector' };
let remoteBudget = null;

client.available = () => true;
client.enabled = () => true;
client.outboundEnabled = () => true;
client.dryrun = () => false;
client.companyId = async () => 39400;
client.formId = () => 19;
client.createOrder = async (payload) => {
  calls.created++;
  calls.lastCreate = payload;          // what we actually put on the wire, for §N
  if (nextCreateThrows) { const e = nextCreateThrows; nextCreateThrows = null; throw e; }
  return { id: 900000 + calls.created, order: { id: 800000 + calls.created, total: {} }, _sent: payload };
};
client.findOrderByCustomerKey = async () => ({ id: 850001, projectId: 950001 });
client.getOrder = async () => ({ id: 800001, status: remoteStatus, subStatus: null, completedAt: null });
client.getBudget = async () => remoteBudget;
client.getPhotos = async () => [];
client.getReport = async () => { const e = new Error('not ready'); e.status = 404; throw e; };
client.getComments = async () => [];
client.addDocument = async (id, d) => { calls.documents.push(d); return { id: 1, fileName: d.fileName, group: { id: d.groupId } }; };
client.addComment = async (id, c) => { calls.comments.push(c); return { id: 5000 + calls.comments.length, createdAt: new Date().toISOString() }; };
client.requestCancel = async () => { calls.cancels++; return null; };

const order = require('../src/trinity/order');
const ingest = require('../src/trinity/ingest');
const intake = require('../src/trinity/intake');
const mapper = require('../src/trinity/mapper');

let n = 0, failed = 0;
const ok = (cond, label) => { n++; if (cond) return; failed++; console.error('  ✘ ' + label); };
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);

(async () => {
  // A crashed earlier run can leave order rows holding the stub's ids; clear this
  // suite's own tables so each run starts from a known state.
  await db.query(`DELETE FROM trinity_inspection_orders WHERE customer_key LIKE 'pdr-%' OR customer_key LIKE 'swd-%'`);

  // ---- fixture -----------------------------------------------------------------
  const email = `trin-${Date.now()}@example.com`;
  const b = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,cell_phone) VALUES ('Ada','Lovelace',$1,'7325550134') RETURNING id`, [email])).rows[0];
  const a = (await db.query(
    `INSERT INTO applications (borrower_id, status, ys_loan_number, property_address, property_type, units, loan_amount, loan_type, rehab_budget)
     VALUES ($1,'funded',$2,$3::jsonb,'SFR',1,350000,'Purchase',140000) RETURNING id`,
    [b.id, `YSCAP-T-${Date.now().toString(36)}`,
     JSON.stringify({ street: '128 Maple Ave', city: 'Lakewood', state: 'NJ', zip: '08701', oneLine: '128 Maple Ave, Lakewood, NJ' })])).rows[0];

  // A staff member on the file, so the desk cue below actually has a recipient.
  const stf = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Draw Coordinator','processor',true)
     ON CONFLICT (email) DO UPDATE SET is_active=true RETURNING id`, [`coord-${Date.now()}@example.com`])).rows[0];
  await db.query(`UPDATE applications SET loan_officer_id=$2 WHERE id=$1`, [a.id, stf.id]);

  // the contractor Trinity requires
  const sc = (await db.query(
    `INSERT INTO service_contacts (contact_type, company_name, contact_name, email, phone)
     VALUES ('contractor','Builder Co LLC','Sam Builder','sam@builderco.example.com','7325550199') RETURNING id`)).rows[0];
  await db.query(`INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type) VALUES ($1,$2,'contractor')`, [a.id, sc.id]);

  // The budget ledger + a historical draw already taken against it. Ids are unique per
  // run so a crashed earlier run can never collide with this one.
  const base = 500000 + Math.floor(Math.random() * 400000);
  const prop = base;
  const drawId = base + 1;
  const items = [
    { jid: base + 11, name: 'Roof', budget: 4000000 },
    { jid: base + 12, name: 'Kitchen', budget: 6000000 },
    { jid: base + 13, name: 'Windows', budget: 2500000 },
  ];
  for (const it of items) {
    await db.query(
      `INSERT INTO sitewire_job_item_links (application_id, sitewire_budget_id, sitewire_job_item_id, sow_line_key, section_token, name, budgeted_cents, is_media_item)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false)`,
      [a.id, prop, it.jid, it.name.toLowerCase(), it.name.toLowerCase(), it.name, it.budget]);
  }
  await db.query(
    `INSERT INTO sitewire_draws (application_id, sitewire_draw_id, sitewire_property_id, number, status)
     VALUES ($1,$2,$3,1,'approved')`, [a.id, drawId, prop]);
  // $20,000 already drawn on the roof — the historical draw the inspector must see.
  await db.query(
    `INSERT INTO sitewire_draw_requests (sitewire_draw_id, sitewire_request_id, sitewire_job_item_id, requested_cents, approved_cents)
     VALUES ($1,$2,$3,$4,$5)`, [drawId, base + 21, items[0].jid, 2000000, 2000000]);

  // ---- A. the budget + historical draws we would send ---------------------------
  const lines = await order.budgetLines(a.id);
  eq(lines.length, 3, 'A1 every budget line is read');
  const roof = lines.find((l) => l.sitewire_job_item_id === items[0].jid);
  eq(roof.previous_drawn_cents, 2000000, 'A2 the historical draw comes from the real ledger');
  eq(roof.budgeted_cents, 4000000, 'A3 the budget comes from the real ledger');
  const kitchen = lines.find((l) => l.sitewire_job_item_id === items[1].jid);
  eq(kitchen.previous_drawn_cents, 0, 'A4 an undrawn line reads as nothing drawn, never as unknown');

  const ctx = await order.fileContext(a.id);
  eq(ctx.contractor.email, 'sam@builderco.example.com', 'A5 the contractor is read off the file');
  eq(ctx.address.city, 'Lakewood', 'A6 the property address is read off the file');

  // ---- B. the order record + placing it -----------------------------------------
  const pr = (await db.query(
    `INSERT INTO portal_draw_requests (application_id, source, platform, lines, total_requested_cents)
     VALUES ($1,'staff','trinity',$2::jsonb,$3) RETURNING id`,
    [a.id, JSON.stringify([
      { sitewire_job_item_id: items[0].jid, sow_line_key: 'roof', name: 'Roof', requested_cents: 1000000 },
      { sitewire_job_item_id: items[1].jid, sow_line_key: 'kitchen', name: 'Kitchen', requested_cents: 1500000 },
    ]), 2500000])).rows[0];
  const rec = (await db.query(
    `INSERT INTO trinity_inspection_orders (application_id, portal_draw_request_id, customer_key, note)
     VALUES ($1,$2,$3,'test') RETURNING id`, [a.id, pr.id, `pdr-${pr.id}`])).rows[0];

  const placed = await order.placeOrder(a.id, rec.id);
  ok(placed.ok, 'B1 the order is placed');
  eq(calls.created, 1, 'B2 exactly one create call');
  const after = (await db.query(`SELECT * FROM trinity_inspection_orders WHERE id=$1`, [rec.id])).rows[0];
  eq(after.status, 'ordered', 'B3 the record moves to ordered');
  ok(after.trinity_order_id, 'B4 Trinity’s order id is recorded');
  ok(after.ordered_at, 'B5 the ordered timestamp is stamped');

  // the crosswalk — what the inspector was shown
  const sent = (await db.query(
    `SELECT * FROM trinity_order_lines WHERE trinity_inspection_order_id=$1 ORDER BY id`, [rec.id])).rows;
  eq(sent.length, 3, 'B6 every budget line is recorded as sent (not only the requested ones)');
  const sentRoof = sent.find((l) => Number(l.sitewire_job_item_id) === items[0].jid);
  eq(Number(sentRoof.previous_drawn_cents), 2000000, 'B7 the historical draw is recorded against the line');
  eq(Number(sentRoof.previous_pct), 50, 'B8 and travelled as 50%');
  eq(Number(sentRoof.requested_cents), 1000000, 'B9 this draw’s request is recorded');

  // the documents + the opening message
  ok(calls.documents.some((d) => d.groupId === order.DOC_GROUP.COST_BREAKDOWN), 'B10 the budget spreadsheet is sent');
  ok(calls.documents.every((d) => !/\.csv$/i.test(d.fileName)), 'B11 nothing is sent with an extension the group refuses');
  ok(calls.comments.length >= 1, 'B12 an opening message goes to the Trinity team');
  ok(/budget/i.test(calls.comments[0].content), 'B13 and it states the budget picture');

  // ---- C. it can never place two orders -----------------------------------------
  const again = await order.placeOrder(a.id, rec.id);
  ok(again.already, 'C1 a second attempt is a no-op, not a second order');
  eq(calls.created, 1, 'C2 still exactly one create call');

  // A LOST RESPONSE: Trinity says the key already exists. We resolve, never re-post.
  const rec2 = (await db.query(
    `INSERT INTO trinity_inspection_orders (application_id, portal_draw_request_id, customer_key)
     VALUES ($1,$2,$3) RETURNING id`, [a.id, pr.id, `pdr-lost-${pr.id}`])).rows[0];
  const conflict = new Error('conflict'); conflict.conflict = true; conflict.status = 409;
  nextCreateThrows = conflict;
  const resumed = await order.placeOrder(a.id, rec2.id);
  ok(resumed.ok, 'C3 a 409 is RESOLVED into the existing order');
  eq(resumed.trinityOrderId, 850001, 'C4 and adopts the id Trinity already has');

  // ---- D. it refuses rather than invents ----------------------------------------
  await db.query(`DELETE FROM application_service_contacts WHERE application_id=$1`, [a.id]);
  const rec3 = (await db.query(
    `INSERT INTO trinity_inspection_orders (application_id, portal_draw_request_id, customer_key)
     VALUES ($1,$2,$3) RETURNING id`, [a.id, pr.id, `pdr-nocontractor-${pr.id}`])).rows[0];
  const blocked = await order.placeOrder(a.id, rec3.id);
  ok(blocked.blocked, 'D1 a file missing the contractor is refused, not sent with a fake one');
  ok(/contractor/i.test(blocked.message), 'D2 and says what is missing, in plain words');
  const blockedRow = (await db.query(`SELECT blocked_reason, trinity_order_id FROM trinity_inspection_orders WHERE id=$1`, [rec3.id])).rows[0];
  ok(blockedRow.blocked_reason, 'D3 the reason is recorded for the desk');
  eq(blockedRow.trinity_order_id, null, 'D4 and nothing was ordered');
  await db.query(`INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type) VALUES ($1,$2,'contractor')`, [a.id, sc.id]);

  // ---- E. following the order ----------------------------------------------------
  remoteStatus = { id: 8, name: 'Accepted by Inspector' };
  await ingest.syncOrder(a.id, rec.id);
  let row = (await db.query(`SELECT * FROM trinity_inspection_orders WHERE id=$1`, [rec.id])).rows[0];
  eq(row.status, 'scheduled', 'E1 "Accepted by Inspector" becomes scheduled');
  eq(row.trinity_status, 'Accepted by Inspector', 'E2 Trinity’s own wording is kept for the desk');
  ok(row.scheduled_at, 'E3 the scheduled timestamp is stamped');

  // A status that says nothing about progress must move nothing.
  remoteStatus = { id: 67, name: 'Change Date to Inspect' };
  await ingest.syncOrder(a.id, rec.id);
  row = (await db.query(`SELECT status FROM trinity_inspection_orders WHERE id=$1`, [rec.id])).rows[0];
  eq(row.status, 'scheduled', 'E4 a schedule-only status never moves the state');

  // ---- F. reading the result -----------------------------------------------------
  remoteStatus = { id: 12, name: 'Report Completed' };
  remoteBudget = {
    lineItems: [
      { itemCost: 40000, amountRequested: 10000, previousPercentCompleted: 50, percentCompleted: 70, customerKey: `ji-${items[0].jid}`, description: 'Roof', remarks: 'Flashing still open', id: 1 },
      { itemCost: 60000, amountRequested: 15000, previousPercentCompleted: 0, percentCompleted: 15, customerKey: `ji-${items[1].jid}`, description: 'Kitchen', remarks: 'Counters not installed', id: 2 },
      { itemCost: 25000, amountRequested: 0, previousPercentCompleted: 0, percentCompleted: 0, customerKey: `ji-${items[2].jid}`, description: 'Windows', remarks: null, id: 3 },
    ],
    total: { previousCostCompleted: 20000, costCompleted: 37000, totalCost: 125000, percentCompleted: 29.6 },
  };
  await ingest.syncOrder(a.id, rec.id);
  row = (await db.query(`SELECT * FROM trinity_inspection_orders WHERE id=$1`, [rec.id])).rows[0];
  eq(row.status, 'report_received', 'F1 a completed report moves the state');
  eq(Number(row.approved_cents), 1700000, 'F2 the approved total is read as $17,000');
  ok(row.results_read_at, 'F3 the read is stamped');
  eq(row.blocked_reason, null, 'F4 nothing is blocking');

  const resLines = (await db.query(
    `SELECT * FROM trinity_order_lines WHERE trinity_inspection_order_id=$1 ORDER BY id`, [rec.id])).rows;
  const rRoof = resLines.find((l) => l.customer_key === `ji-${items[0].jid}`);
  eq(Number(rRoof.approved_cents), 800000, 'F5 Roof approved $8,000 (20% of $40,000)');
  eq(rRoof.inspector_remarks, 'Flashing still open', 'F6 the inspector’s note is stored');
  const rKit = resLines.find((l) => l.customer_key === `ji-${items[1].jid}`);
  eq(Number(rKit.approved_cents), 900000, 'F7 Kitchen approved $9,000');
  eq(Number(resLines.reduce((s, l) => s + Number(l.approved_cents || 0), 0)), Number(row.approved_cents),
    'F8 the lines sum to the recorded total, to the cent');

  // ---- G. THE AUTOPILOT IS OFF ---------------------------------------------------
  // This is the assertion the whole feature turns on. A completed Trinity report must
  // leave the draw request UNDELIVERED — the borrower hears nothing until a human acts.
  const prAfter = (await db.query(`SELECT status, approved_cents FROM portal_draw_requests WHERE id=$1`, [pr.id])).rows[0];
  eq(prAfter.status, 'submitted', 'G1 the draw request is NOT approved automatically');
  eq(prAfter.approved_cents, null, 'G2 no approved amount is written to the borrower-facing request');
  const borrowerNotes = (await db.query(
    `SELECT count(*)::int AS c FROM notifications WHERE application_id=$1 AND recipient_kind='borrower'`, [a.id])).rows[0];
  eq(borrowerNotes.c, 0, 'G3 the borrower has been sent NOTHING');
  // The desk, on the other hand, IS told.
  const staffNotes = (await db.query(
    `SELECT count(*)::int AS c FROM notifications WHERE application_id=$1 AND recipient_kind='staff'`, [a.id])).rows[0];
  ok(staffNotes.c >= 1, 'G4 the desk is told the report is in');
  ok(row.notified_ready_at, 'G5 the cue is claimed once');
  // Re-syncing must not tell them again.
  await ingest.syncOrder(a.id, rec.id);
  const staffNotes2 = (await db.query(
    `SELECT count(*)::int AS c FROM notifications WHERE application_id=$1 AND recipient_kind='staff'`, [a.id])).rows[0];
  eq(staffNotes2.c, staffNotes.c, 'G6 and never told twice');

  // ---- H. a result that cannot be trusted is REFUSED, not guessed ----------------
  const rec4 = (await db.query(
    `INSERT INTO trinity_inspection_orders (application_id, portal_draw_request_id, customer_key, trinity_order_id, status)
     VALUES ($1,$2,$3,800999,'inspected') RETURNING id`, [a.id, pr.id, `pdr-bad-${pr.id}`])).rows[0];
  remoteBudget = {
    lineItems: [{ itemCost: 40000, previousPercentCompleted: 50, percentCompleted: 20, customerKey: `ji-${items[0].jid}`, description: 'Roof', id: 1 }],
    total: { previousCostCompleted: 20000, costCompleted: 8000 },
  };
  const bad = (await db.query(`SELECT * FROM trinity_inspection_orders WHERE id=$1`, [rec4.id])).rows[0];
  const badRes = await ingest.readResults(bad);
  eq(badRes.ok, false, 'H1 a line going backwards is refused');
  const badRow = (await db.query(`SELECT blocked_reason, approved_cents FROM trinity_inspection_orders WHERE id=$1`, [rec4.id])).rows[0];
  ok(badRow.blocked_reason, 'H2 the refusal is recorded in plain words for the desk');
  eq(badRow.approved_cents, null, 'H3 and NO number is written');

  // ---- I. the Sitewire-submitted door -------------------------------------------
  //
  // THIS DOOR WAS DEAD UNTIL 2026-08-16, and this block used to encode the very bug it
  // was meant to guard. It asserted that `platform: 'trinity'` places an order — but
  // 'trinity' is not a value `routing.platformOf` can ever produce (`routing.PLATFORMS`
  // is exactly ['sitewire','trustpoint','external']). The caller in
  // src/sitewire/reconcile.js passes what routing actually returns, so the real
  // production call always fell through 'not_trinity' and a physical non-Blue-Lake draw
  // submitted in Sitewire ordered NOTHING. The test passed because it invented an input
  // production could not produce.
  //
  // So the contract is now the REAL routing shape — {platform, method, resolved}, as
  // `routing.resolveFilePlatform` returns it — and the decision belongs to one shared
  // rule, src/trinity/eligibility.js.
  const PHYS = { platform: 'sitewire', method: 'traditional', resolved: true };

  eq((await intake.maybeOrderFromSitewire(a.id, { drawId: base + 99, status: 'pending', ...PHYS, platform: 'trustpoint' })).skipped,
    'not_trinity', 'I1 a Blue Lake / TrustPoint file is never touched by the Trinity door');
  eq((await intake.maybeOrderFromSitewire(a.id, { drawId: base + 99, status: 'pending', platform: 'sitewire', method: 'mobile', resolved: true })).skipped,
    'not_trinity', 'I2 a Sitewire VIRTUAL file is never touched either — the autopilot stays Sitewire’s');
  eq((await intake.maybeOrderFromSitewire(a.id, { drawId: base + 99, status: 'pending', ...PHYS, platform: 'external' })).skipped,
    'not_trinity', 'I2b a partner-run (external) file is never touched');
  // Ordering dispatches a real person and spends real money: an unresolved file must
  // answer NO rather than fall through to the safe-default 'sitewire'.
  eq((await intake.maybeOrderFromSitewire(a.id, { drawId: base + 99, status: 'pending', ...PHYS, resolved: false })).skipped,
    'not_trinity', 'I2c a file whose routing could not be resolved is never ordered');

  eq((await intake.maybeOrderFromSitewire(a.id, { drawId: base + 99, status: 'drafting', ...PHYS })).skipped,
    'not_submitted', 'I3 an unsubmitted draw is not ordered');
  const first = await intake.maybeOrderFromSitewire(a.id, { drawId: base + 99, status: 'pending', ...PHYS });
  ok(first.created, 'I4 a submitted PHYSICAL non-Blue-Lake draw mints the order record');
  const second = await intake.maybeOrderFromSitewire(a.id, { drawId: base + 99, status: 'pending', ...PHYS });
  ok(!second.created, 'I5 a second pass never mints a second record (the unique key IS the claim)');
  const swRows = (await db.query(
    `SELECT count(*)::int AS c FROM trinity_inspection_orders WHERE customer_key=$1`, [`swd-${base + 99}`])).rows[0];
  eq(swRows.c, 1, 'I6 exactly one order record for that draw');
  // A refusal always says WHY, so a coordinator asking "where is my inspection order?"
  // gets an answer instead of a silent skip.
  ok((await intake.maybeOrderFromSitewire(a.id, { drawId: base + 99, status: 'pending', platform: 'trustpoint', method: 'traditional', resolved: true })).reason,
    'I7 a refusal carries a plain-language reason');

  // ---- J. the PILOT report renders from Trinity's own numbers --------------------
  // A Trinity draw must produce the SAME branded document a virtual draw does — that is
  // the whole reason the report reuses the existing pure builder rather than growing a
  // second one. Both copies are built: the borrower copy exists so the manual delivery
  // has something to hand over.
  const report = require('../src/trinity/report');
  const staffPdf = await report.buildBytes(a.id, rec.id, { mode: 'staff' });
  ok(staffPdf && staffPdf.length > 1000, 'J1 the staff PILOT report renders');
  ok(staffPdf && staffPdf.slice(0, 4).toString() === '%PDF', 'J2 and is a real PDF');
  const borrowerPdf = await report.buildBytes(a.id, rec.id, { mode: 'borrower' });
  ok(borrowerPdf && borrowerPdf.slice(0, 4).toString() === '%PDF', 'J3 the borrower copy renders too');
  // An order with nothing to say produces nothing, rather than an empty document.
  const emptyRec = (await db.query(
    `INSERT INTO trinity_inspection_orders (application_id, customer_key, status)
     VALUES ($1,$2,'requested') RETURNING id`, [a.id, `pdr-empty-${base}`])).rows[0];
  eq(await report.buildBytes(a.id, emptyRec.id, { mode: 'staff' }), null,
    'J4 an inspection with no result produces no report, never a blank one');

  // ---- K. THE PROGRESS TIMELINE — Trinity has no history endpoint ----------------
  //
  // VERIFIED against the live API 2026-08-16: GET /orders/{id}/history, /events,
  // /statuses and /status ALL answer 404. The order carries only its CURRENT status. So
  // the sequence the desk shows — ordered, scheduled, inspected, report back — exists
  // ONLY because we write each transition down as we see it, and before this table the
  // previous status was simply overwritten.
  const tl = async (id) => (await db.query(
    `SELECT * FROM trinity_order_events WHERE trinity_inspection_order_id=$1 ORDER BY id`, [id])).rows;

  // Placing the order and every sync above ALREADY wrote to this timeline — that is the
  // wiring working, and it is why the assertions below measure the CHANGE rather than an
  // absolute count.
  let events = await tl(rec.id);
  ok(events.length > 0, 'K0 placing the order and following it already built a timeline');
  ok(events.some((e) => e.kind === 'ordered'), 'K0b including the moment it was ordered');
  const before = events.length;

  await order.recordEvent(a.id, rec.id, { kind: 'status', state: 'scheduled', statusId: 44, status: 'Assigned Order', source: 'poller' });
  events = await tl(rec.id);
  eq(events.length, before + 1, 'K1 a new status is added to the timeline');
  eq(events[events.length - 1].trinity_status, 'Assigned Order', 'K2 in Trinity’s own words, so the desk shows what they show');
  ok(events[0].occurred_at <= events[events.length - 1].occurred_at, 'K3 and in the order it happened');

  // The poller re-reads the same order every few minutes. Without the once-only rule the
  // timeline would gain an identical row on every tick and become unreadable.
  await order.recordEvent(a.id, rec.id, { kind: 'status', state: 'scheduled', statusId: 44, status: 'Assigned Order', source: 'poller' });
  await order.recordEvent(a.id, rec.id, { kind: 'status', state: 'scheduled', statusId: 44, status: 'Assigned Order', source: 'poller' });
  eq((await tl(rec.id)).length, before + 1, 'K4 re-reading the same status does NOT repeat it on the timeline');
  // A genuinely different status still lands.
  await order.recordEvent(a.id, rec.id, { kind: 'status', state: 'inspected', statusId: 53, status: 'In Review - Pending', source: 'poller' });
  eq((await tl(rec.id)).length, before + 2, 'K5 but a real move forward is always recorded');
  // A substatus change is a real change to a coordinator, even at the same status.
  await order.recordEvent(a.id, rec.id, { kind: 'status', state: 'inspected', statusId: 53, status: 'In Review - Pending', substatus: 'Waiting on the appraiser', source: 'poller' });
  eq((await tl(rec.id)).length, before + 3, 'K6 and a new substatus at the same status is recorded too');
  // The human step, which is the whole point of this program having no autopilot.
  await order.recordEvent(a.id, rec.id, { kind: 'delivered', state: 'entered', source: 'staff', staffId: stf.id, detail: 'Delivered the findings to the borrower.' });
  events = await tl(rec.id);
  eq(events[events.length - 1].kind, 'delivered', 'K7 the manual delivery is on the record');
  eq(events[events.length - 1].staff_id, stf.id, 'K8 naming WHO sent it — there is no autopilot, so this is the only record');
  // A timeline is a record of what happened; it must never be the reason something fails.
  const orphanEvent = await order.recordEvent(a.id, 99999999, { kind: 'status', status: 'x' });
  eq(orphanEvent.ok, false, 'K9 a timeline write against a missing order fails quietly, never throws');

  // ---- L. THE BUDGET PROOF — did their system really take our budget? -------------
  //
  // Sending a budget and having the order accepted is NOT the same as knowing it
  // arrived. This runs on every order.
  const sentForProof = mapper.toLineItems([
    { sitewire_job_item_id: 8801, name: 'Framing', budgeted_cents: 5000000, previous_drawn_cents: 3750000, requested_cents: 1250000 },
  ]);
  await db.query(
    `INSERT INTO trinity_order_lines (trinity_inspection_order_id, application_id, sitewire_job_item_id, name, customer_key, budgeted_cents)
     VALUES ($1,$2,8801,'Framing','ji-8801',5000000)
     ON CONFLICT (trinity_inspection_order_id, customer_key) WHERE customer_key IS NOT NULL DO NOTHING`, [rec.id, a.id]);

  const goodRemote = {
    lineItems: [{ customerKey: 'ji-8801', description: 'Framing', itemCost: 50000, amountRequested: 12500, previousPercentCompleted: 75, percentCompleted: 75, id: 424242 }],
    total: { totalCost: 50000, previousCostCompleted: 37500, costCompleted: 37500 },
  };
  const realGetBudget = client.getBudget;
  client.getBudget = async () => goodRemote;
  const proofOk = await order.verifyBudget(a.id, rec.id, 991001, sentForProof);
  eq(proofOk.ok, true, 'L1 a budget Trinity stored correctly is proven clean');
  let proofRow = (await db.query(`SELECT * FROM trinity_inspection_orders WHERE id=$1`, [rec.id])).rows[0];
  ok(proofRow.budget_verified_at, 'L2 and the file records that we actually asked');
  eq(proofRow.budget_mismatch, null, 'L3 with nothing to report');
  eq(Number(proofRow.remote_budget_cents), 5000000, 'L4 their budget total is stored in cents');
  eq(Number(proofRow.remote_drawn_cents), 3750000, 'L5 and their already-drawn total too');
  // Trinity's own line id lands on our crosswalk, so a support call can name their line.
  const xw = (await db.query(
    `SELECT trinity_line_id FROM trinity_order_lines WHERE trinity_inspection_order_id=$1 AND customer_key='ji-8801'`, [rec.id])).rows[0];
  eq(Number(xw.trinity_line_id), 424242, 'L6 Trinity’s own line id is recorded against OUR budget line');

  // A disagreement is reported in plain words — and must NOT undo the order.
  client.getBudget = async () => ({
    lineItems: [{ customerKey: 'ji-8801', description: 'Framing', itemCost: 50000, amountRequested: 12500, previousPercentCompleted: 50, percentCompleted: 50, id: 424242 }],
    total: { totalCost: 50000, previousCostCompleted: 25000, costCompleted: 25000 },
  });
  const proofBad = await order.verifyBudget(a.id, rec.id, 991001, sentForProof);
  eq(proofBad.ok, false, 'L7 a budget that does NOT match is caught');
  proofRow = (await db.query(`SELECT * FROM trinity_inspection_orders WHERE id=$1`, [rec.id])).rows[0];
  ok(/already drawn/i.test(proofRow.budget_mismatch || ''), 'L8 and recorded in plain words for the desk');
  ok(proofRow.trinity_order_id != null || proofRow.status !== 'cancelled', 'L9 the inspection is NOT undone over a reconciliation');
  // An unreadable budget is not a mismatch — we simply could not ask.
  client.getBudget = async () => { throw new Error('network'); };
  const proofErr = await order.verifyBudget(a.id, rec.id, 991001, sentForProof);
  eq(proofErr.skipped, 'unreadable', 'L10 an unreachable budget is reported as unasked, never as agreement');
  client.getBudget = realGetBudget;

  // ---- M. TWO-WAY MESSAGING — a reply reaches the people who must answer -----------
  //
  // Owner-asked 2026-08-16, on who should hear a Trinity reply: *"the draw coordinator
  // and the loan officer"*. Two things are proven here, and the second is the subtle
  // one: OUR OWN MESSAGE COMING BACK IS NOT A REPLY. `order.postComment` records what we
  // send with the id Trinity answered with, so the ordinary echo is excluded by id — but
  // a timeout AFTER Trinity stored the comment leaves us with no id to record, and that
  // echo arrives looking exactly like an inbound message. Without the author test the
  // desk would be emailed "Trinity replied" about its own words.
  client.getComments = async () => ([
    { id: 611001, content: 'The inspector could not reach the site — the gate was locked. Please confirm access.',
      important: true, visibleToVendor: true, createdAt: new Date().toISOString(),
      commenter: { isExternalPerson: true, firstName: 'Dana', lastName: 'Field', emailAddress: 'dana@trinityonline.com' } },
    // OUR OWN opening message coming back with no id recorded on our side.
    { id: 611002, content: 'Budget attached — please inspect the roof and kitchen lines.',
      important: false, visibleToVendor: true, createdAt: new Date().toISOString(),
      commenter: { isExternalPerson: false, firstName: 'Draw', lastName: 'Coordinator', emailAddress: 'draws@yscapgroup.com' } },
  ]);
  const pulled = await ingest.pullComments((await db.query(
    `SELECT * FROM trinity_inspection_orders WHERE id=$1`, [rec.id])).rows[0]);
  eq(pulled.added, 2, 'M1 both messages are mirrored into our thread');
  eq(pulled.inbound, 1, 'M2 but only ONE of them is a message FROM Trinity');
  const theirs = (await db.query(
    `SELECT direction, author_name FROM trinity_order_comments WHERE trinity_comment_id=611001`)).rows[0];
  eq(theirs.direction, 'in', 'M3 their message is filed as inbound');
  const ours = (await db.query(
    `SELECT direction FROM trinity_order_comments WHERE trinity_comment_id=611002`)).rows[0];
  eq(ours.direction, 'out', 'M4 our own message coming back is filed as OUTBOUND, never as a reply');
  const afterNotes = (await db.query(
    `SELECT title, body FROM notifications WHERE application_id=$1 AND title ILIKE '%Trinity sent%'`, [a.id])).rows;
  ok(afterNotes.length >= 1, 'M5 a Trinity reply notifies the team');
  ok(/gate was locked/i.test(afterNotes[0].body || ''), 'M6 and quotes what they actually wrote');
  ok(/nothing has been sent to the borrower/i.test(afterNotes[0].body || ''),
    'M7 while saying plainly that the borrower has not been told anything');
  ok(afterNotes.every((x) => !/Budget attached/i.test(x.body || '')),
    'M8 our own echoed message never raises a "Trinity replied" notice');
  // A re-poll must not re-file or re-notify: the desk would be told twice about one message.
  const repeat = await ingest.pullComments((await db.query(
    `SELECT * FROM trinity_inspection_orders WHERE id=$1`, [rec.id])).rows[0]);
  eq(repeat.added, 0, 'M9 a re-poll files nothing again');
  eq(repeat.inbound, 0, 'M10 and raises no second notification');
  eq((await db.query(
    `SELECT count(*)::int AS c FROM notifications WHERE application_id=$1 AND title ILIKE '%Trinity sent%'`, [a.id])).rows[0].c,
    afterNotes.length, 'M11 the team is told once per message, not once per poll');
  // AND STILL NOTHING REACHES THE BORROWER — a vendor conversation is staff-only.
  eq((await db.query(
    `SELECT count(*)::int AS c FROM notifications WHERE application_id=$1 AND borrower_id IS NOT NULL`, [a.id])).rows[0].c,
    0, 'M12 the borrower is never notified about a Trinity message');
  client.getComments = async () => [];

  // ---- N. ORDERING IT OURSELVES — the draw centre's own button --------------------
  //
  // Owner-directed 2026-08-16: *"We should also have the option to order it on our end in
  // the draw center. When we are ordering manually, it should also send over all the
  // information that we set up."* The whole point of the design is that the n_manual door
  // resolves the SAME record the automatic one would and hands it to the SAME placeOrder,
  // so these assertions are about the two things that could actually go wrong: ordering
  // on a file that is not Trinity's, and ordering the same draw twice.

  const n_createdBeforeN = calls.created;

  // N0. Before anything says this file is on physical inspections, the door is shut.
  // `resolveInspection` defaults to 'mobile' with no link and no rule — a VIRTUAL file,
  // which is Sitewire's and must never gain a second inspector.
  const n_beforePhysical = await intake.orderOptions(a.id);
  eq(n_beforePhysical.eligible, false, 'N0 a file with no physical-inspection setup cannot be ordered on');
  ok(/virtual/i.test(n_beforePhysical.reason || ''), 'N0b and the desk is told why, in plain words');
  const n_refusedVirtual = await intake.orderManually(a.id, { sitewireDrawId: drawId });
  eq(n_refusedVirtual.blocked, true, 'N0c and the order itself is refused, not just hidden');
  eq(calls.created, n_createdBeforeN, 'N0d nothing was sent to Trinity');

  // Put the file on PHYSICAL inspections the way the coordinator's Start-draw screen
  // does — the per-file method on the property link.
  await db.query(
    `INSERT INTO sitewire_property_links (application_id, sitewire_property_id, matched_by, inspection_method)
     VALUES ($1,$2,'created','traditional')`, [a.id, prop]);

  const n_opts1 = await intake.orderOptions(a.id);
  eq(n_opts1.eligible, true, 'N1 a physical, non-Blue-Lake file may be ordered on');
  const n_cand = (n_opts1.draws || []).find((d) => d.sitewire_draw_id === drawId);
  ok(n_cand, 'N2 the file’s own submitted draw is offered as something to order against');
  eq(n_cand && n_cand.ordered, false, 'N3 …and is correctly shown as not yet ordered');

  // N4. The two refusals a human could actually hit, each said in words they can act on.
  const n_noPick = await intake.orderManually(a.id, {});
  eq(n_noPick.blocked, true, 'N4 an order with no draw picked is refused');
  ok(/pick the draw/i.test(n_noPick.message || ''), 'N4b …and says what to do about it');
  const n_otherFile = await intake.orderManually(a.id, { sitewireDrawId: drawId + 4242 });
  eq(n_otherFile.blocked, true, 'N5 a draw that is not on this file is refused');
  eq(calls.created, n_createdBeforeN, 'N5b and still nothing was sent to Trinity');

  // N6. The real thing.
  const n_manual = await intake.orderManually(a.id, { sitewireDrawId: drawId, staffId: stf.id });
  eq(n_manual.ok, true, 'N6 a hand-placed order goes through');
  ok(n_manual.trinityOrderId > 0, 'N6b and comes back with Trinity’s own order id');
  const n_manRow = (await db.query(
    `SELECT * FROM trinity_inspection_orders WHERE customer_key=$1`, [`swd-${drawId}`])).rows[0];
  ok(n_manRow, 'N7 the record is keyed EXACTLY as the automatic door would key it');
  eq(Number(n_manRow.sitewire_draw_id), drawId, 'N7b and is tied to the draw it was ordered for');
  eq(n_manRow.status, 'ordered', 'N7c and moves to ordered');
  eq(String(n_manRow.ordered_by), String(stf.id), 'N7d recording WHO ordered it — there is no autopilot here');

  // N8. IT SENDS EVERYTHING THE AUTOMATIC ORDER SENDS. This is the owner's ask, and it
  // is provable on the n_wire rather than by reading the code: the whole construction
  // budget travels (not only the requested lines), each line carries what has already
  // been drawn as its previousPercentCompleted, and the readable budget-and-draws
  // spreadsheet is attached.
  const n_wire = calls.lastCreate;
  eq(n_wire.order.lineItems.length, 3, 'N8 the WHOLE construction budget goes, not just this draw’s lines');
  const n_wireRoof = n_wire.order.lineItems.find((l) => /Roof/i.test(l.description));
  eq(Number(n_wireRoof.itemCost), 40000, 'N8b every line carries its budget');
  eq(Number(n_wireRoof.amountRequested), 20000, 'N8d …and what this draw is asking for');
  // THE DRAW BEING INSPECTED IS NOT ITS OWN HISTORY. This draw's own $20,000 is on the
  // ledger, so an unfiltered historical sum would tell the inspector the roof is already
  // 50% paid AND ask him to release the same $20,000 again — the same dollars twice.
  eq(Number(n_wireRoof.previousPercentCompleted), 0,
    'N8g the draw being inspected is excluded from its own historical draws');
  eq((await order.budgetLines(a.id)).find((l) => l.sitewire_job_item_id === items[0].jid).previous_drawn_cents,
    2000000, 'N8h …while every OTHER reader still sees it as money released');
  ok(calls.documents.some((d) => /construction-budget-and-draws\.xlsx$/.test(d.fileName || '')),
    'N8e the readable budget + historical-draw spreadsheet is attached');
  ok(calls.documents.some((d) => /budget/.test(String(d.customerKey || ''))),
    'N8f …under its own exactly-once key, so a retry can never attach it twice');

  // N9. THE ONE THING THAT MUST NEVER HAPPEN: two inspectors on one draw. A second click,
  // or a later automatic pass, must ADOPT the order rather than place another.
  const n_createdAfterManual = calls.created;
  const n_again = await intake.orderManually(a.id, { sitewireDrawId: drawId, staffId: stf.id });
  eq(n_again.already, true, 'N9 a second click adopts the order that already exists');
  eq(calls.created, n_createdAfterManual, 'N9b and places nothing new with Trinity');
  const n_auto = await intake.maybeOrderFromSitewire(a.id, {
    drawId, status: 'pending', platform: 'sitewire', method: 'traditional', resolved: true,
  });
  eq(n_auto.skipped, 'already', 'N9c and a later automatic pass on the same draw stands down');
  eq((await db.query(
    `SELECT count(*)::int AS c FROM trinity_inspection_orders WHERE sitewire_draw_id=$1`, [drawId])).rows[0].c,
    1, 'N9d exactly ONE inspection order exists for that draw');

  // N10. And the desk now shows it as ordered, so the button stops offering it.
  const n_opts2 = await intake.orderOptions(a.id);
  eq((n_opts2.draws || []).find((d) => d.sitewire_draw_id === drawId).ordered, true,
    'N10 the draw is reported as already ordered');

  // N11. Switching the file back to virtual shuts the door n_again — the rule is read
  // LIVE, never remembered from when the record was made.
  await db.query(`UPDATE sitewire_property_links SET inspection_method='mobile' WHERE application_id=$1`, [a.id]);
  eq((await intake.orderOptions(a.id)).eligible, false, 'N11 a file moved back to virtual can no longer be ordered on');
  await db.query(`DELETE FROM sitewire_property_links WHERE application_id=$1`, [a.id]);

  // ---- O. AN ORDER THAT NEVER REACHED TRINITY IS RE-DRIVEN -----------------------
  //
  // The two automatic doors call `placeOrder` ONCE, fire and forget. Anything that made
  // that one call fail — writes off during setup, Trinity unreachable for ten minutes,
  // a lease lost mid-deploy — used to leave a record with no Trinity order behind it and
  // nothing that ever tried again, so the inspection simply never happened and the first
  // anybody knew was a draw sitting for a week.
  const poller = require('../src/trinity/poller');
  const strandedDraw = drawId + 5150;
  await db.query(
    `INSERT INTO sitewire_draws (application_id, sitewire_draw_id, sitewire_property_id, number, status)
     VALUES ($1,$2,$3,9,'pending')`, [a.id, strandedDraw, prop]);
  await db.query(
    `INSERT INTO sitewire_draw_requests (sitewire_draw_id, sitewire_request_id, sitewire_job_item_id, requested_cents)
     VALUES ($1,$2,$3,500000)`, [strandedDraw, base + 61, items[1].jid]);
  const stranded = (await db.query(
    `INSERT INTO trinity_inspection_orders (application_id, sitewire_draw_id, customer_key, note)
     VALUES ($1,$2,$3,'stranded by an outage') RETURNING id`,
    [a.id, strandedDraw, `swd-${strandedDraw}`])).rows[0];

  const createdBeforeO = calls.created;
  let swept = await poller.placePendingOnce(5);
  ok(swept.placed >= 1, 'O1 the sweep places an order that was minted but never sent');
  ok(calls.created > createdBeforeO, 'O2 …by actually calling Trinity');
  ok((await db.query(
    `SELECT trinity_order_id FROM trinity_inspection_orders WHERE id=$1`, [stranded.id])).rows[0].trinity_order_id > 0,
    'O3 …and the record now holds Trinity’s order id');

  // O4. A record whose FILE is missing something is NOT re-asked every ten minutes —
  // re-driving cannot fix a missing contractor email, and only a human can.
  const blockedDraw = drawId + 5151;
  await db.query(
    `INSERT INTO sitewire_draws (application_id, sitewire_draw_id, sitewire_property_id, number, status)
     VALUES ($1,$2,$3,10,'pending')`, [a.id, blockedDraw, prop]);
  await db.query(
    `INSERT INTO trinity_inspection_orders (application_id, sitewire_draw_id, customer_key, blocked_reason)
     VALUES ($1,$2,$3,'Trinity needs a few things first: the contractor''s email address is missing.')`,
    [a.id, blockedDraw, `swd-${blockedDraw}`]);
  // The assertion is on what the sweep CONSIDERS, not on whether Trinity was called:
  // `placeOrder` refuses a blocked record on its own (the payload is still incomplete), so
  // counting calls cannot tell "the sweep left it alone" from "the sweep re-asked and was
  // refused again" — and the second one re-stamps blocked_reason and burns the lease on
  // every tick forever. Proven by mutation: with the guard removed this reads 3, not 0.
  swept = await poller.placePendingOnce(5);
  eq(swept.considered, 0, 'O4 a record blocked on the FILE is not even looked at by the sweep');
  eq((await db.query(
    `SELECT trinity_order_id FROM trinity_inspection_orders WHERE customer_key=$1`, [`swd-${blockedDraw}`])).rows[0].trinity_order_id,
    null, 'O4b …and is left exactly as the human found it');

  // O5. And with writes switched off the sweep does nothing at all — it must never be
  // the thing that places an order somebody deliberately switched off.
  await db.query(
    `INSERT INTO trinity_inspection_orders (application_id, sitewire_draw_id, customer_key)
     VALUES ($1,$2,$3)`, [a.id, drawId + 5152, `swd-${drawId + 5152}`]);
  const realOutbound = client.outboundEnabled, realDryrun = client.dryrun;
  client.outboundEnabled = () => false; client.dryrun = () => false;
  const off = await poller.placePendingOnce(5);
  eq(off.skipped, 'writes_off', 'O5 the sweep stands down when Trinity writing is switched off');
  client.outboundEnabled = realOutbound; client.dryrun = realDryrun;
  await db.query(`DELETE FROM trinity_inspection_orders WHERE customer_key = ANY($1::text[])`,
    [[`swd-${blockedDraw}`, `swd-${drawId + 5152}`]]);
  await db.query(`DELETE FROM sitewire_draw_requests WHERE sitewire_draw_id=$1`, [strandedDraw]);
  await db.query(`DELETE FROM sitewire_draws WHERE sitewire_draw_id = ANY($1::bigint[])`, [[strandedDraw, blockedDraw]]);

  // ---- cleanup -------------------------------------------------------------------
  await db.query(`DELETE FROM applications WHERE id=$1`, [a.id]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [b.id]);
  await db.query(`DELETE FROM service_contacts WHERE id=$1`, [sc.id]);
  await db.query(`DELETE FROM staff_users WHERE id=$1`, [stf.id]).catch(() => {});
  await db.query(`DELETE FROM sitewire_draw_requests WHERE sitewire_draw_id=$1`, [drawId]);
  await db.query(`DELETE FROM sitewire_draws WHERE sitewire_draw_id=$1`, [drawId]);

  if (failed) { console.error(`test-trinity-order-db: ${failed} FAILED of ${n}`); process.exit(1); }
  console.log(`test-trinity-order-db: ${n} passed, 0 failed`);
  process.exit(0);
})().catch((e) => { console.error('test-trinity-order-db CRASHED:', e); process.exit(1); });
