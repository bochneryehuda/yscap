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

  // ---- I. the Sitewire-submitted door is trinity-only + claims once --------------
  eq((await intake.maybeOrderFromSitewire(a.id, { drawId: base + 99, status: 'pending', platform: 'trustpoint' })).skipped,
    'not_trinity', 'I1 a TrustPoint file is never touched by the Trinity door');
  eq((await intake.maybeOrderFromSitewire(a.id, { drawId: base + 99, status: 'pending', platform: 'sitewire' })).skipped,
    'not_trinity', 'I2 a Sitewire virtual file is never touched either');
  eq((await intake.maybeOrderFromSitewire(a.id, { drawId: base + 99, status: 'drafting', platform: 'trinity' })).skipped,
    'not_submitted', 'I3 an unsubmitted draw is not ordered');
  const first = await intake.maybeOrderFromSitewire(a.id, { drawId: base + 99, status: 'pending', platform: 'trinity' });
  ok(first.created, 'I4 a submitted draw on a trinity file mints the order record');
  const second = await intake.maybeOrderFromSitewire(a.id, { drawId: base + 99, status: 'pending', platform: 'trinity' });
  ok(!second.created, 'I5 a second pass never mints a second record (the unique key IS the claim)');
  const swRows = (await db.query(
    `SELECT count(*)::int AS c FROM trinity_inspection_orders WHERE customer_key=$1`, [`swd-${base + 99}`])).rows[0];
  eq(swRows.c, 1, 'I6 exactly one order record for that draw');

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
