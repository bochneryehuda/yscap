'use strict';
/**
 * test-trinity-desk-route-db — the DRAW DESK's own door, over real HTTP.
 *
 * WHY THIS EXISTS SEPARATELY FROM test-trinity-order-db. That suite proves the ADAPTER:
 * what we send Trinity, that a lost response cannot create two orders, that nothing
 * reaches a borrower without a human. It calls the modules directly, so it cannot see
 * the thing that actually stops a coordinator working — a route that answers 403, or a
 * desk payload missing the one field the screen keys on. Those are exactly the failures
 * a module test is blind to, and the manual "order it on our end" button (owner-directed
 * 2026-08-16) is entirely made of them.
 *
 * The Trinity API is stubbed. What is real here is Express, the auth middleware, the
 * file-scope gate, the capability gate and Postgres.
 *
 * Skips cleanly when DATABASE_URL is unset.
 */

if (!process.env.DATABASE_URL) { console.log('test-trinity-desk-route-db: SKIPPED (no DATABASE_URL)'); process.exit(0); }

process.env.TRINITY_ENABLED = '1';
process.env.TRINITY_OUTBOUND_ENABLED = '1';
process.env.TRINITY_DRYRUN = '0';
process.env.TRINITY_COMPANY_ID = '39400';
process.env.TRINITY_USERNAME = process.env.TRINITY_USERNAME || 'test-user';
process.env.TRINITY_PASSWORD = process.env.TRINITY_PASSWORD || 'test-pass';

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const REPO = path.join(__dirname, '..');

// ---- stub the Trinity client BEFORE the server requires the route ----------------
const client = require(REPO + '/src/trinity/client');
const calls = { created: 0, documents: [] };
client.available = () => true;
client.enabled = () => true;
client.outboundEnabled = () => true;
client.dryrun = () => false;
client.companyId = async () => 39400;
client.formId = () => 19;
client.createOrder = async (payload) => {
  calls.created++; calls.lastCreate = payload;
  return { id: 970000 + calls.created, order: { id: 870000 + calls.created, total: {} } };
};
client.findOrderByCustomerKey = async () => null;
client.getBudget = async () => null;
client.addDocument = async (id, d) => { calls.documents.push(d); return { id: 1 }; };
client.addComment = async () => ({ id: 1, createdAt: new Date().toISOString() });

const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const uuid = () => crypto.randomUUID();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✘ ' + m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);

function apiCall(server, method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, method, path: p,
      headers: {
        'Content-Type': 'application/json', Authorization: 'Bearer ' + token,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        body: b ? (() => { try { return JSON.parse(b); } catch (_) { return b; } })() : null,
      }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const app = require(REPO + '/src/server.js');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const B = uuid(), APP = uuid(), COORD = uuid(), LO = uuid(), OUTSIDER = uuid(), ADMIN = uuid();
  const base = 3000000 + Math.floor(Math.random() * 500000);
  const prop = base, drawId = base + 1, jid = base + 11;

  try {
    await db.query(
      `INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES
        ($1,$2,'Draw Coordinator','draw_coordinator','x',true),
        ($3,$4,'File Officer','loan_officer','x',true),
        ($5,$6,'Somebody Else','loan_officer','x',true),
        ($7,$8,'Platform Admin','admin','x',true)`,
      [COORD, `tdc_${COORD.slice(0, 8)}@x.test`, LO, `tlo_${LO.slice(0, 8)}@x.test`, OUTSIDER, `tou_${OUTSIDER.slice(0, 8)}@x.test`, ADMIN, `tad_${ADMIN.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email,cell_phone) VALUES ($1,'Grace','Hopper',$2,'7325550188')`,
      [B, `tgh_${B.slice(0, 8)}@x.test`]);
    await db.query(
      `INSERT INTO applications (id,borrower_id,loan_officer_id,status,ys_loan_number,property_address,property_type,units,loan_amount,loan_type,rehab_budget)
       VALUES ($1,$2,$3,'funded',$4,$5::jsonb,'SFR',1,400000,'Purchase',100000)`,
      [APP, B, LO, `YSCAP-D-${Date.now().toString(36)}`,
       JSON.stringify({ street: '9 Draw Rd', city: 'Lakewood', state: 'NJ', zip: '08701', oneLine: '9 Draw Rd, Lakewood, NJ' })]);

    // The contractor Trinity requires, and a physical-inspection file.
    const sc = (await db.query(
      `INSERT INTO service_contacts (contact_type, company_name, contact_name, email, phone)
       VALUES ('contractor','Hopper Build LLC','Sam Builder','sam@hopperbuild.test','7325550199') RETURNING id`)).rows[0];
    await db.query(`INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type) VALUES ($1,$2,'contractor')`, [APP, sc.id]);
    await db.query(
      `INSERT INTO sitewire_property_links (application_id, sitewire_property_id, matched_by, inspection_method)
       VALUES ($1,$2,'created','traditional')`, [APP, prop]);
    await db.query(
      `INSERT INTO sitewire_job_item_links (application_id, sitewire_budget_id, sitewire_job_item_id, sow_line_key, section_token, name, budgeted_cents, is_media_item)
       VALUES ($1,$2,$3,'roof','roof','Roof',5000000,false)`, [APP, prop, jid]);
    await db.query(
      `INSERT INTO sitewire_draws (application_id, sitewire_draw_id, sitewire_property_id, number, status)
       VALUES ($1,$2,$3,1,'pending')`, [APP, drawId, prop]);
    await db.query(
      `INSERT INTO sitewire_draw_requests (sitewire_draw_id, sitewire_request_id, sitewire_job_item_id, requested_cents)
       VALUES ($1,$2,$3,1500000)`, [drawId, base + 21, jid]);

    const tok = (id, role) => C.signJwt({ sub: id, kind: 'staff', role, tv: 0 });
    const coord = tok(COORD, 'draw_coordinator');
    const lo = tok(LO, 'loan_officer');
    const outsider = tok(OUTSIDER, 'loan_officer');

    // ---- A. the desk payload the button is built from --------------------------
    let r = await apiCall(server, 'GET', `/api/trinity/files/${APP}`, null, coord);
    eq(r.status, 200, 'A1 the draw desk answers');
    ok(r.body && r.body.orderable, 'A2 and carries the orderable block — without it the screen has nothing to offer');
    eq(r.body.orderable.eligible, true, 'A3 a physical, non-Blue-Lake file may be ordered on');
    const cand = (r.body.orderable.draws || []).find((d) => d.sitewire_draw_id === drawId);
    ok(cand, 'A4 the file’s own submitted draw is offered');
    eq(cand && cand.ordered, false, 'A5 …as not yet ordered');
    eq(cand && cand.total_requested_cents, 1500000, 'A6 …with what the borrower asked for, so the picker can name it');
    eq(r.body.autopilot, false, 'A7 the desk still says out loud that nothing goes out on its own');

    // ---- A2. THE FORM CHECK — the thing that would have stopped go-live ----------
    //
    // Found live on 2026-08-16: the sandbox company has form 19 and the PRODUCTION company
    // does not — it has 1079, the same product under a different id. Left unnoticed, every
    // production order is refused, on a live file, after a coordinator pressed the button.
    // The admin status page now reads the account's own form list and says so in words.
    client.forms = async () => [
      { product: 'Draw Inspection', forms: [{ id: 1079, name: 'General Purpose Line Item Draw PCR' }] },
      { product: 'Feasibility', forms: [{ id: 102, name: 'Feasibility' }] },
    ];
    client.subscriptions = async () => [];
    const adm = tok(ADMIN, 'admin');
    r = await apiCall(server, 'GET', '/api/trinity/status', null, adm);
    eq(r.status, 200, 'A2a an admin can read the connection status');
    ok(r.body && r.body.formCheck, 'A2b …and it carries the form check');
    eq(r.body.formCheck.enabled, false,
      'A2c the form we are configured for is correctly reported as NOT on this account');
    ok(/NOT enabled/i.test(r.body.formCheck.message || ''),
      'A2d …in words a human can act on, before anything is ordered');
    ok((r.body.formCheck.available || []).includes(1079),
      'A2e …and it names what the account DOES offer, so the fix is obvious');
    // …and the happy case: configured for the form the account really has.
    const realFormId = client.formId;
    client.formId = () => 1079;
    r = await apiCall(server, 'GET', '/api/trinity/status', null, adm);
    eq(r.body.formCheck.enabled, true, 'A2f a correctly-configured form reports enabled');
    client.formId = realFormId;
    r = await apiCall(server, 'GET', '/api/trinity/status', null, coord);
    eq(r.status, 403, 'A2g the status page stays admins-only');

    // ---- B. who may reach it ----------------------------------------------------
    r = await apiCall(server, 'GET', `/api/trinity/files/${APP}`, null, outsider);
    eq(r.status, 403, 'B1 a staffer who is not on the file cannot see the inspection');
    r = await apiCall(server, 'POST', `/api/trinity/files/${APP}/orders`, { sitewireDrawId: drawId }, outsider);
    eq(r.status, 403, 'B2 …and certainly cannot order one');
    r = await apiCall(server, 'POST', `/api/trinity/files/${APP}/orders`, { sitewireDrawId: drawId }, lo);
    eq(r.status, 403, 'B3 a loan officer on the file may look, but ordering needs manage_draws');
    eq(calls.created, 0, 'B4 nothing was sent to Trinity by any of the refusals');

    // ---- C. the refusals a coordinator could actually hit ----------------------
    r = await apiCall(server, 'POST', `/api/trinity/files/${APP}/orders`, {}, coord);
    eq(r.status, 422, 'C1 an order with no draw picked is refused');
    ok(/pick the draw/i.test((r.body && r.body.message) || ''), 'C2 …in words the coordinator can act on');
    r = await apiCall(server, 'POST', `/api/trinity/files/${APP}/orders`, { sitewireDrawId: drawId + 7777 }, coord);
    eq(r.status, 422, 'C3 a draw that is not on this file is refused');
    eq(calls.created, 0, 'C4 and still nothing reached Trinity');

    // ---- D. ordering it ---------------------------------------------------------
    r = await apiCall(server, 'POST', `/api/trinity/files/${APP}/orders`, { sitewireDrawId: drawId }, coord);
    eq(r.status, 200, 'D1 the coordinator orders the inspection');
    ok(r.body && r.body.ok && r.body.trinityOrderId > 0, 'D2 and gets Trinity’s own order id back');
    eq(calls.created, 1, 'D3 exactly one order was placed');
    ok(calls.lastCreate && calls.lastCreate.order.lineItems.length === 1,
      'D4 the construction budget travelled with it');
    ok(calls.documents.some((d) => /construction-budget-and-draws\.xlsx$/.test(d.fileName || '')),
      'D5 …and so did the readable budget + historical-draw spreadsheet');

    // ---- E. the desk reflects it, and a second click cannot double-order --------
    r = await apiCall(server, 'GET', `/api/trinity/files/${APP}`, null, coord);
    eq((r.body.orderable.draws || []).find((d) => d.sitewire_draw_id === drawId).ordered, true,
      'E1 the draw now reads as ordered, so the picker stops offering it');
    eq((r.body.orders || []).length, 1, 'E2 the inspection shows on the desk');
    ok(r.body.orders[0].delivery && r.body.orders[0].delivery.here,
      'E3 …and says up front that its findings can be delivered from here');
    r = await apiCall(server, 'POST', `/api/trinity/files/${APP}/orders`, { sitewireDrawId: drawId }, coord);
    eq(r.status, 200, 'E4 a second click is not an error');
    eq(r.body.already, true, 'E5 …it adopts the order that already exists');
    eq(calls.created, 1, 'E6 and places nothing new — two inspectors on one draw is the thing that must never happen');

    // ---- F. a SKIP is not a success --------------------------------------------
    // `placeOrder` stands down with `{skipped:'off'}` and no error when the connection is
    // switched off. That is right for a poller and wrong for a person: answering 200 would
    // put "Ordered from Trinity" on the screen for an order that was never sent.
    const realEnabled = client.enabled;
    client.enabled = () => false;
    const skipDraw = drawId + 909;
    await db.query(
      `INSERT INTO sitewire_draws (application_id, sitewire_draw_id, sitewire_property_id, number, status)
       VALUES ($1,$2,$3,2,'pending')`, [APP, skipDraw, prop]);
    r = await apiCall(server, 'POST', `/api/trinity/files/${APP}/orders`, { sitewireDrawId: skipDraw }, coord);
    client.enabled = realEnabled;
    eq(r.status, 409, 'F1 an order that stood down is refused, never reported as placed');
    ok(/switched off/i.test((r.body && r.body.error) || ''), 'F2 …and says why in words');
    await db.query(`DELETE FROM trinity_inspection_orders WHERE customer_key=$1`, [`swd-${skipDraw}`]);
    await db.query(`DELETE FROM sitewire_draws WHERE sitewire_draw_id=$1`, [skipDraw]);

    // ---- G. delivering is still a HUMAN step, and it refuses until the report is in
    const orderRowId = (await db.query(
      `SELECT id FROM trinity_inspection_orders WHERE application_id=$1`, [APP])).rows[0].id;
    r = await apiCall(server, 'POST', `/api/trinity/files/${APP}/orders/${orderRowId}/deliver`, {}, coord);
    eq(r.status, 422, 'G1 nothing can be delivered before Trinity’s figures are read back');
    eq((await db.query(
      `SELECT count(*)::int AS c FROM notifications WHERE application_id=$1 AND borrower_id IS NOT NULL`, [APP])).rows[0].c,
      0, 'G2 and the borrower has been told nothing at any point in this test');
  } finally {
    await db.query(`DELETE FROM applications WHERE id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [B]).catch(() => {});
    await db.query(`DELETE FROM sitewire_draw_requests WHERE sitewire_draw_id=$1`, [drawId]).catch(() => {});
    await db.query(`DELETE FROM sitewire_draws WHERE sitewire_draw_id=$1`, [drawId]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[COORD, LO, OUTSIDER, ADMIN]]).catch(() => {});
    server.close();
  }

  if (fail) { console.error(`test-trinity-desk-route-db: ${fail} FAILED of ${pass + fail}`); process.exit(1); }
  console.log(`test-trinity-desk-route-db: ${pass} passed, 0 failed`);
  process.exit(0);
})().catch((e) => { console.error('test-trinity-desk-route-db CRASHED:', e); process.exit(1); });
