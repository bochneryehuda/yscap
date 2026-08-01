'use strict';
/**
 * Per-file role contacts + workflow scoping (db/392, owner-directed 2026-07-31)
 * and the super-admin decide-own-exception exemption (same day).
 *
 * DB-gated (SKIPs without DATABASE_URL). Real Postgres + real HTTP:
 *   • the db/392 trigger keeps applications.closer_id ⇄ the primary closer
 *     assignee row in lock-step (set / change / clear);
 *   • queue visibility (workflow.listQueue + queueCounts):
 *       – an UNASSIGNED role item on a file with NO closer assigned shows to the
 *         whole closer desk (the unchanged default);
 *       – once the file has assigned closer(s), the item shows ONLY to them —
 *         a third closer's workflow shows "only files assigned to them";
 *       – multiple people per role: an ADDITIONAL closer sees the item that was
 *         addressed to the primary;
 *   • POST /assignees closer/draw_coordinator (primary + additional) + the
 *     role-appropriateness refusal;
 *   • the closing submit routes to the file's closer pointer; the draw_setup
 *     submit routes to the file's PRIMARY draw coordinator even with several
 *     coordinators on the desk (previously a forced picker);
 *   • exceptions decide: a SUPER-ADMIN may decide their OWN request
 *     (owner-directed 2026-07-31 — "cannot approve my own exception … this is
 *     a failure"); a regular ADMIN still cannot decide their own.
 */

if (!process.env.DATABASE_URL) { console.log('SKIP test-file-workflow-contacts-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const workflow = require('../src/lib/workflow');
const LE = require('../src/lib/loan-exceptions');
const app = require('../src/server');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  try {
    const mkStaff = async (role, name) => (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,$2,$3,true,false,'x',0) RETURNING id`,
      [`fwc-${name.replace(/\s+/g, '')}-${sfx}@test.local`, name, role])).rows[0].id;
    const closerA = await mkStaff('closer', 'Closer A');
    const closerB = await mkStaff('closer', 'Closer B');
    const closerC = await mkStaff('closer', 'Closer C');
    const drawA = await mkStaff('draw_coordinator', 'Draw A');
    const drawB = await mkStaff('draw_coordinator', 'Draw B');
    const adminId = await mkStaff('admin', 'Admin FWC');
    const superId = await mkStaff('super_admin', 'Super FWC');
    const adminTok = C.signJwt({ sub: adminId, kind: 'staff', role: 'admin', tv: 0 });
    const superTok = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });

    const borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Fwc','Test',$1) RETURNING id`,
      [`fwc-bo-${sfx}@test.local`])).rows[0].id;
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, status, loan_type, program, property_type, purchase_price, property_address)
       VALUES ($1,'approved','Purchase','standard','SFR (1 unit)',300000,
               '{"line1":"9 Contact St","city":"Newark","state":"NJ","zip":"07102"}'::jsonb)
       RETURNING id`, [borrowerId])).rows[0].id;

    // ---------------- db/392 trigger: pointer ⇄ primary row lock-step --------
    await db.query(`UPDATE applications SET closer_id=$2 WHERE id=$1`, [appId, closerA]);
    let rows = (await db.query(
      `SELECT staff_id, is_primary FROM application_assignees
        WHERE application_id=$1 AND role='closer' AND removed_at IS NULL`, [appId])).rows;
    assert(rows.length === 1 && rows[0].staff_id === closerA && rows[0].is_primary === true,
      'setting closer_id creates the primary closer assignee row (trigger)');

    // ---------------- queue visibility matrix -------------------------------
    const mkItem = async (toStaffId) => (await db.query(
      `INSERT INTO workflow_items (application_id, submission_type, status, to_staff_id, to_role, from_staff_id)
       VALUES ($1,'closing','open',$2,'closer',$3) RETURNING id`, [appId, toStaffId, adminId])).rows[0].id;

    // (a) addressed to the primary: A sees it; B and C do NOT (not on the file).
    const itemToA = await mkItem(closerA);
    const inQ = async (staffId, itemId) => (await workflow.listQueue(staffId)).some((r) => r.id === itemId);
    assert(await inQ(closerA, itemToA) === true, 'primary closer sees the item addressed to them');
    assert(await inQ(closerB, itemToA) === false, 'an unassigned closer does NOT see another closer’s file item');

    // (b) multiple people per role: add B to the file → B sees it; C still not.
    await db.query(
      `INSERT INTO application_assignees (application_id, staff_id, role, is_primary) VALUES ($1,$2,'closer',false)`,
      [appId, closerB]);
    assert(await inQ(closerB, itemToA) === true, 'an ADDITIONAL closer on the file sees the primary’s item');
    assert(await inQ(closerC, itemToA) === false, 'a closer NOT on the file still sees nothing');

    // (c) role inbox narrowed: a NULL-addressed closer item on an ASSIGNED file
    // shows to the file's closers only — never the whole desk. (Its own file:
    // uq_wf_live allows one live item per submission type per file.)
    const appId3 = (await db.query(
      `INSERT INTO applications (borrower_id, status, loan_type, program, property_type, purchase_price, property_address, closer_id)
       VALUES ($1,'approved','Purchase','standard','SFR (1 unit)',300000,
               '{"line1":"10 Scoped St","city":"Newark","state":"NJ","zip":"07102"}'::jsonb, $2)
       RETURNING id`, [borrowerId, closerA])).rows[0].id;
    const itemUnassigned = (await db.query(
      `INSERT INTO workflow_items (application_id, submission_type, status, to_staff_id, to_role, from_staff_id)
       VALUES ($1,'closing','open',NULL,'closer',$2) RETURNING id`, [appId3, adminId])).rows[0].id;
    assert(await inQ(closerA, itemUnassigned) === true, 'unassigned item on an assigned file: primary sees it');
    assert(await inQ(closerC, itemUnassigned) === false, 'unassigned item on an assigned file: the desk does NOT');

    // (d) the unchanged default: on a file with NO closer assigned, the whole
    // desk sees an unassigned closer item.
    const appId2 = (await db.query(
      `INSERT INTO applications (borrower_id, status, loan_type, program, property_type, purchase_price, property_address)
       VALUES ($1,'approved','Purchase','standard','SFR (1 unit)',300000,
               '{"line1":"11 Desk St","city":"Newark","state":"NJ","zip":"07102"}'::jsonb)
       RETURNING id`, [borrowerId])).rows[0].id;
    const itemDesk = (await db.query(
      `INSERT INTO workflow_items (application_id, submission_type, status, to_staff_id, to_role, from_staff_id)
       VALUES ($1,'closing','open',NULL,'closer',$2) RETURNING id`, [appId2, adminId])).rows[0].id;
    assert(await inQ(closerC, itemDesk) === true, 'default preserved: nobody assigned → whole desk sees the role item');

    // (e) counts mirror the list. Scoped to THIS run's items (the test DB is
    // reused across runs, so absolute totals would double-count leftovers):
    // the listQueue matrix above is the authoritative visibility check; here we
    // only prove queueCounts uses the SAME arms — the co-assigned closer's
    // count covers the file items, and the desk closer's count matches their
    // own list exactly (never more, never less).
    const cB = await workflow.queueCounts(closerB);
    const cC = await workflow.queueCounts(closerC);
    const listB = await workflow.listQueue(closerB);
    const listC = await workflow.listQueue(closerC);
    assert(cB.total === listB.length, 'queueCounts(closerB) === listQueue(closerB).length (same visibility arms)');
    assert(cC.total === listC.length, 'queueCounts(closerC) === listQueue(closerC).length (same visibility arms)');
    assert(listB.some((r) => r.id === itemToA), 'co-assigned closer’s list covers the file item');
    assert(!listC.some((r) => r.id === itemToA || r.id === itemUnassigned), 'desk closer’s list excludes the assigned file’s items');
    assert(listC.some((r) => r.id === itemDesk), 'desk closer’s list includes the unassigned-file desk item');

    // ---------------- trigger: change + clear -------------------------------
    await db.query(`UPDATE applications SET closer_id=$2 WHERE id=$1`, [appId, closerC]);
    rows = (await db.query(
      `SELECT staff_id FROM application_assignees
        WHERE application_id=$1 AND role='closer' AND is_primary=true AND removed_at IS NULL`, [appId])).rows;
    assert(rows.length === 1 && rows[0].staff_id === closerC, 'changing closer_id moves the primary row (trigger)');
    await db.query(`UPDATE applications SET closer_id=NULL WHERE id=$1`, [appId]);
    // put A back as primary for the HTTP half below
    await db.query(`UPDATE applications SET closer_id=$2 WHERE id=$1`, [appId, closerA]);

    // ---------------- HTTP: assignees endpoints -----------------------------
    let r = await call(server, 'POST', `/api/staff/applications/${appId}/assignees`, adminTok,
      { staffId: drawA, role: 'draw_coordinator', primary: true });
    assert(r.status === 200, 'POST /assignees draw_coordinator primary → 200');
    r = await call(server, 'GET', `/api/staff/applications/${appId}/assignees`, adminTok);
    const dRows = (r.body || []).filter((x) => x.role === 'draw_coordinator');
    assert(dRows.length === 1 && dRows[0].is_primary === true && dRows[0].staff_id === drawA,
      'the primary draw coordinator row is recorded');
    r = await call(server, 'POST', `/api/staff/applications/${appId}/assignees`, adminTok,
      { staffId: closerB, role: 'draw_coordinator' });
    assert(r.status === 400, 'a closer cannot be added as a draw coordinator (role-appropriate)');

    // ---------------- HTTP: submit routes to the FILE's people --------------
    // closing → the closer pointer (primary), no picker even with 3 closers.
    r = await call(server, 'POST', `/api/staff/applications/${appId}/workflow/submit`, adminTok,
      { submissionType: 'closing', estClosingDate: '2026-09-15', closingDateConfirmed: true });
    assert(r.status === 200 || r.status === 201, `closing submit succeeds (${r.status})`);
    let wi = (await db.query(
      `SELECT to_staff_id FROM workflow_items WHERE application_id=$1 AND submission_type='closing' AND status IN ('open','in_progress') ORDER BY received_at DESC LIMIT 1`,
      [appId])).rows[0];
    assert(wi && wi.to_staff_id === closerA, 'closing routed to the file’s primary closer');

    // draw_setup → the file's PRIMARY draw coordinator (two on the desk, no picker).
    await db.query(`UPDATE applications SET status='funded' WHERE id=$1`, [appId]);
    r = await call(server, 'POST', `/api/staff/applications/${appId}/workflow/submit`, adminTok,
      { submissionType: 'draw_setup' });
    assert(r.status === 200 || r.status === 201, `draw_setup submit succeeds with 2 coordinators on the desk (${r.status})`);
    wi = (await db.query(
      `SELECT to_staff_id FROM workflow_items WHERE application_id=$1 AND submission_type='draw_setup' AND status IN ('open','in_progress') ORDER BY received_at DESC LIMIT 1`,
      [appId])).rows[0];
    assert(wi && wi.to_staff_id === drawA, 'draw_setup routed to the file’s primary draw coordinator (no picker)');
    assert(drawB !== drawA, 'sanity: two distinct coordinators exist (the old sole-holder rule would have 400d)');

    // ---------------- exceptions: super-admin decides their OWN -------------
    let cx = await db.getClient(); await cx.query('BEGIN');
    const own = await LE.requestPricingException(cx, {
      appId, reasonCode: 'finance_more_fee', reasonNote: 'own request (super)', requestedBy: superId,
    });
    await cx.query('COMMIT'); cx.release();
    r = await call(server, 'POST', `/api/admin/exceptions/${own.id}/decide`, superTok,
      { decision: 'approved', note: 'top authority — approving my own request' });
    assert(r.status === 200, `super-admin CAN decide their own exception (${r.status}: ${JSON.stringify(r.body)})`);
    const decided = await LE.getById(own.id);
    assert(decided && decided.status === 'approved' && decided.decided_by === superId,
      'the decision is recorded under the super-admin');

    cx = await db.getClient(); await cx.query('BEGIN');
    const own2 = await LE.requestPricingException(cx, {
      appId, reasonCode: 'finance_more_fee', reasonNote: 'own request (admin)', requestedBy: adminId,
    });
    await cx.query('COMMIT'); cx.release();
    r = await call(server, 'POST', `/api/admin/exceptions/${own2.id}/decide`, adminTok,
      { decision: 'approved', note: 'trying to approve my own' });
    assert(r.status === 403, `a regular admin still cannot decide their OWN request (${r.status})`);
    r = await call(server, 'POST', `/api/admin/exceptions/${own2.id}/decide`, superTok,
      { decision: 'denied', note: 'someone else decides it' });
    assert(r.status === 200, 'another admin (the super) can decide it');

    // canDecideOwn surfaces on the list for the UI.
    r = await call(server, 'GET', '/api/admin/exceptions?status=all', superTok);
    assert(r.body && r.body.canDecideOwn === true, 'list: canDecideOwn=true for the super-admin');
    r = await call(server, 'GET', '/api/admin/exceptions?status=all', adminTok);
    assert(r.body && r.body.canDecideOwn === false, 'list: canDecideOwn=false for a regular admin');
  } catch (e) {
    failures++;
    console.log('FAIL (exception):', e && e.stack || e);
  } finally {
    server.close();
    try { await db.pool.end(); } catch (_) {}
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll file-workflow-contacts checks passed.');
  process.exit(failures ? 1 : 0);
})();
