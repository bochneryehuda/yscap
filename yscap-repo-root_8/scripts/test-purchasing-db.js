'use strict';
/*
 * DB-gated test for THE PURCHASING WORKFLOW (owner-directed 2026-07-26).
 *
 * Proves the investor-delivery FORK end to end against a real schema:
 *   - NOT table funded + investor delivery signed off → enters purchasing
 *     ('outstanding'), and the closer's Workflow hand-off clears.
 *   - TABLE FUNDED + investor delivery signed off → sold at closing, NEVER enters
 *     purchasing, and the closer's hand-off still clears ("either way").
 *   - reconciled alone does NOT clear the hand-off (the closer still owes the
 *     investor-delivery sign-off).
 *   - notes + tasks per file; task done/undone; purchasing complete.
 *   - un-signing investor delivery withdraws an OUTSTANDING file from purchasing.
 *
 * Requires DATABASE_URL with migrations applied; SKIPs cleanly otherwise. Runs in
 * a transaction and ROLLS BACK — leaves no rows behind.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-purchasing-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const purchasing = require('../src/lib/purchasing');
const workflow = require('../src/lib/workflow');

let passed = 0;
const ok = (c, n) => { assert.ok(c, n); console.log(`  ok  ${n}`); passed++; };
const uniq = (p) => p + Buffer.from(String(process.pid)).toString('hex') + Math.random().toString(36).slice(2, 7) + '@example.com';

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  // Build a funded file whose closing is reconciled, with a LIVE closer hand-off.
  async function makeFile() {
    const b = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Pur','Test',$1) RETURNING id`, [uniq('purb+')])).rows[0];
    const lo = (await client.query(
      `INSERT INTO staff_users (email,full_name,role,is_active) VALUES ($1,'LO','loan_officer',true) RETURNING id`, [uniq('purlo+')])).rows[0];
    const closer = (await client.query(
      `INSERT INTO staff_users (email,full_name,role,is_active) VALUES ($1,'Closer','closer',true) RETURNING id`, [uniq('purcl+')])).rows[0];
    const app = (await client.query(
      `INSERT INTO applications (borrower_id, status, closer_id) VALUES ($1,'funded',$2) RETURNING id`, [b.id, closer.id])).rows[0];
    const item = await workflow.submitItem(client, {
      appId: app.id, submissionType: 'closing', fromStaffId: lo.id, toStaffId: closer.id,
      toRole: 'closer', note: 'to closing', priority: 2, estClosingDate: '2026-08-15',
    });
    // Reconciled, investor delivery NOT yet signed off.
    await client.query(
      `INSERT INTO closing_workflow (application_id, stage, fully_reconciled_at)
       VALUES ($1,'fully_reconciled', now())`, [app.id]);
    return { appId: app.id, closerId: closer.id, itemId: item.id };
  }
  const inQueue = async (closerId, appId) => {
    const live = await workflow.listQueue(closerId, { tab: 'next' }, client);
    return live.some((r) => String(r.application_id) === String(appId));
  };
  // Mirrors the sign-off route's fork, on the same client.
  async function signOffInvestorDelivery(appId, actorId, on = true) {
    // $2 is always referenced (updated_by) so the un-sign path still binds it —
    // mirrors the route, which likewise always writes updated_by=$2.
    await client.query(
      `UPDATE closing_workflow SET investor_delivery_signed_off_at=${on ? 'now()' : 'NULL'},
              investor_delivery_signed_off_by=${on ? '$2::uuid' : 'NULL'},
              updated_by=$2::uuid, updated_at=now()
        WHERE application_id=$1`, [appId, actorId]);
    const cw = (await client.query(`SELECT table_funded FROM closing_workflow WHERE application_id=$1`, [appId])).rows[0];
    if (on && !(cw && cw.table_funded)) await purchasing.enterPurchasing(client, appId, actorId);
    if (!on) await purchasing.withdrawFromPurchasing(client, appId);
    await workflow.maybeFinishClosing(client, appId, actorId);
  }

  // Mirrors the closer-only `tableFunded` block of PATCH /applications/:id/closing.
  async function setTableFunded(appId, actorId, on) {
    const row = (await client.query(
      `UPDATE closing_workflow
          SET table_funded=$2,
              table_funded_at = CASE WHEN $2 THEN COALESCE(table_funded_at, now()) ELSE NULL END,
              table_funded_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END,
              updated_by=$3::uuid, updated_at=now()
        WHERE application_id=$1
    RETURNING investor_delivery_signed_off_at`, [appId, on, actorId])).rows[0];
    if (on) await purchasing.withdrawFromPurchasing(client, appId);
    else if (row && row.investor_delivery_signed_off_at) await purchasing.enterPurchasing(client, appId, actorId);
  }

  try {
    await client.query('BEGIN');

    // ---- Fork A: NOT table funded → goes to purchasing ----
    const A = await makeFile();
    ok(await inQueue(A.closerId, A.appId), 'reconciled-only file is STILL on the closer\'s Workflow (delivery not signed off yet)');
    ok(!(await purchasing.getPurchasing(A.appId, client)), 'a file is not in purchasing before investor delivery');

    await signOffInvestorDelivery(A.appId, A.closerId, true);
    const pA = await purchasing.getPurchasing(A.appId, client);
    ok(pA && pA.status === 'outstanding', 'investor delivery (not table funded) puts the file in purchasing as OUTSTANDING');
    ok(!(await inQueue(A.closerId, A.appId)), 'and the file drops off the closer\'s Workflow');

    // ---- Fork B: TABLE FUNDED → sold at closing, never enters purchasing ----
    const B = await makeFile();
    await client.query(
      `UPDATE closing_workflow SET table_funded=true, table_funded_at=now() WHERE application_id=$1`, [B.appId]);
    await signOffInvestorDelivery(B.appId, B.closerId, true);
    ok(!(await purchasing.getPurchasing(B.appId, client)), 'a TABLE FUNDED file is sold at closing — it never enters purchasing');
    ok(!(await inQueue(B.closerId, B.appId)), 'a table-funded file still leaves the closing workflow ("either way")');

    // ---- Notes + tasks on the purchasing file ----
    await purchasing.addNote(client, A.appId, 'Still missing the final title policy.', A.closerId);
    const notes = await purchasing.readNotes(A.appId, client);
    ok(notes.length === 1 && /final title policy/.test(notes[0].body), 'a purchasing note records what is still missing');

    const t1 = await purchasing.addTask(client, A.appId, 'Chase the recorded mortgage', A.closerId);
    await purchasing.addTask(client, A.appId, 'Send the collateral file', A.closerId);
    let tasks = await purchasing.readTasks(A.appId, client);
    ok(tasks.length === 2, 'purchasing tasks can be added per file');

    await purchasing.setTaskDone(client, t1.id, true, A.closerId);
    tasks = await purchasing.readTasks(A.appId, client);
    const done = tasks.find((t) => String(t.id) === String(t1.id));
    ok(done.done === true && String(done.done_by) === String(A.closerId), 'a purchasing task checks off and records who (no uuid/text error)');
    await purchasing.setTaskDone(client, t1.id, false, A.closerId);
    const undone = (await purchasing.readTasks(A.appId, client)).find((t) => String(t.id) === String(t1.id));
    ok(undone.done === false && undone.done_by === null, 'un-checking a purchasing task clears who');

    // ---- Workspace payload ----
    const ws = await purchasing.getPurchasingWorkspace(A.appId, client);
    ok(ws.inPurchasing === true && ws.notes.length === 1 && ws.tasks.length === 2 && ws.openTasks === 2,
      'the purchasing workspace returns status + notes + tasks + the open-task count');

    // ---- Complete, then the un-sign withdrawal rule ----
    const doneRow = await purchasing.setPurchasingStatus(client, A.appId, 'complete', A.closerId);
    ok(doneRow.status === 'complete' && doneRow.completed_at, 'purchasing can be marked complete');
    await signOffInvestorDelivery(A.appId, A.closerId, false);
    const stillThere = await purchasing.getPurchasing(A.appId, client);
    ok(stillThere && stillThere.status === 'complete', 'un-signing delivery does NOT delete a COMPLETED purchasing record (history)');

    // A file still OUTSTANDING is withdrawn when delivery is un-signed.
    const C = await makeFile();
    await signOffInvestorDelivery(C.appId, C.closerId, true);
    ok(!!(await purchasing.getPurchasing(C.appId, client)), 'file C entered purchasing');
    await signOffInvestorDelivery(C.appId, C.closerId, false);
    ok(!(await purchasing.getPurchasing(C.appId, client)), 'un-signing delivery withdraws an OUTSTANDING file from purchasing');

    // ---- Correcting the table-funding tick AFTER the sign-off ----
    // The closer ticked table funded, signed off delivery, then realises the loan
    // was NOT sold at closing. Un-ticking must hand it to purchasing.
    const E = await makeFile();
    await setTableFunded(E.appId, E.closerId, true);
    await signOffInvestorDelivery(E.appId, E.closerId, true);
    ok(!(await purchasing.getPurchasing(E.appId, client)), 'file E was table funded, so it skipped purchasing');
    await setTableFunded(E.appId, E.closerId, false);
    const pE = await purchasing.getPurchasing(E.appId, client);
    ok(pE && pE.status === 'outstanding', 'un-ticking table funded AFTER the sign-off hands the file to purchasing');
    // And the other way: ticking it pulls an outstanding file back out.
    await setTableFunded(E.appId, E.closerId, true);
    ok(!(await purchasing.getPurchasing(E.appId, client)), 're-ticking table funded pulls it back off the purchasing desk');
    ok(!(await inQueue(E.closerId, E.appId)), 'file E stays off the closer\'s Workflow throughout');

    // ---- Idempotency ----
    const D = await makeFile();
    await signOffInvestorDelivery(D.appId, D.closerId, true);
    const again = await purchasing.enterPurchasing(client, D.appId, D.closerId);
    ok(again === null, 'entering purchasing twice is a no-op (idempotent)');

    await client.query('ROLLBACK');
    console.log(`test-purchasing-db: ${passed} checks passed`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('test-purchasing-db FAILED:', e && e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
