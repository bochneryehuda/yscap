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
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const purchasing = require('../src/lib/purchasing');
const workflow = require('../src/lib/workflow');
const closing = require('../src/lib/closing');

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
    // Calls the SHIPPED helper, not a copy of it. A mirror of these steps is what
    // let the previous version of this test stay green while the route silently
    // lost one — there is deliberately nothing to mirror any more.
    if (!on) await purchasing.unwindInvestorDelivery(client, appId, actorId);
    await workflow.maybeFinishClosing(client, appId, actorId);
  }

  /* Mirrors the closer-only `warehouse` block of PATCH /applications/:id/closing.
     THE WAREHOUSE is what decides table funding — there is no separate switch. */
  async function setWarehouse(appId, actorId, warehouse) {
    assert.ok(warehouse === null || closing.WAREHOUSES.includes(warehouse), 'warehouse must be a real one');
    const tf = warehouse === closing.TABLE_FUNDING;
    const row = (await client.query(
      `UPDATE closing_workflow
          SET warehouse=$2, table_funded=$4,
              table_funded_at = CASE WHEN $4 THEN COALESCE(table_funded_at, now()) ELSE NULL END,
              table_funded_by = CASE WHEN $4 THEN COALESCE(table_funded_by, $3::uuid) ELSE NULL END,
              updated_by=$3::uuid, updated_at=now()
        WHERE application_id=$1
    RETURNING investor_delivery_signed_off_at`, [appId, warehouse, actorId, tf])).rows[0];
    if (tf) await purchasing.withdrawFromPurchasing(client, appId);
    else if (row && row.investor_delivery_signed_off_at) await purchasing.enterPurchasing(client, appId, actorId);
  }
  const setTableFunded = (appId, actorId, on) =>
    setWarehouse(appId, actorId, on ? closing.TABLE_FUNDING : 'Stride Bank');

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

    // ---- The db/348 §5 backfill enrols PREVIOUS files by the RUNTIME rule ----
    // It used to key on stage='in_purchasing', which nothing sets automatically —
    // so every file already delivered before this shipped was invisible on the
    // desk forever, and a deliberately WITHDRAWN file was resurrected each boot.
    const backfill = fs.readFileSync(path.join(__dirname, '..', 'db', '348_purchasing_workflow.sql'), 'utf8')
      .split('INSERT INTO purchasing_workflow').slice(-1)[0];
    const runBackfill = () => client.query('INSERT INTO purchasing_workflow' + backfill);

    const P = await makeFile();                        // delivered, never "sent to purchasing"
    await client.query(
      `UPDATE closing_workflow SET investor_delivery_signed_off_at=now() WHERE application_id=$1`, [P.appId]);
    await client.query(`DELETE FROM purchasing_workflow WHERE application_id=$1`, [P.appId]);
    await runBackfill();
    ok(!!(await purchasing.getPurchasing(P.appId, client)),
      'the backfill enrols a PREVIOUS file that was delivered but never sent to purchasing');

    const Q = await makeFile();                        // table funded → sold at closing
    await client.query(
      `UPDATE closing_workflow SET investor_delivery_signed_off_at=now(), table_funded=true,
              stage='in_purchasing', purchasing_at=now() WHERE application_id=$1`, [Q.appId]);
    await runBackfill();
    ok(!(await purchasing.getPurchasing(Q.appId, client)),
      'and never enrols a TABLE FUNDED file, even one stuck at stage=in_purchasing');

    const R = await makeFile();                        // withdrawn on purpose (delivery un-signed)
    await client.query(
      `UPDATE closing_workflow SET investor_delivery_signed_off_at=NULL, stage='in_purchasing',
              purchasing_at=now() WHERE application_id=$1`, [R.appId]);
    await runBackfill();
    ok(!(await purchasing.getPurchasing(R.appId, client)),
      'a deliberately WITHDRAWN file is not resurrected by the next boot');

    const beforeStatus = (await purchasing.getPurchasing(P.appId, client)).status;
    await purchasing.setPurchasingStatus(client, P.appId, 'complete', P.closerId);
    await runBackfill();
    ok((await purchasing.getPurchasing(P.appId, client)).status === 'complete' && beforeStatus === 'outstanding',
      'and a COMPLETED purchasing record is never reopened by a re-run');

    // ---- THE WAREHOUSE decides table funding (owner-directed 2026-07-26) ----
    ok(closing.WAREHOUSES.includes(closing.TABLE_FUNDING),
      '"Table Funding" is one of the warehouse lines the closer can pick');
    const W = await makeFile();
    await setWarehouse(W.appId, W.closerId, closing.TABLE_FUNDING);
    let cwW = (await client.query(
      `SELECT warehouse, table_funded, table_funded_at FROM closing_workflow WHERE application_id=$1`, [W.appId])).rows[0];
    ok(cwW.table_funded === true && !!cwW.table_funded_at,
      'picking the Table Funding warehouse marks the file table funded');
    await signOffInvestorDelivery(W.appId, W.closerId, true);
    ok(!(await purchasing.getPurchasing(W.appId, client)),
      'so investor delivery does NOT send it to purchasing — it was sold at closing');

    // Moving it to a real warehouse afterwards means it DOES need to be sold.
    await setWarehouse(W.appId, W.closerId, 'Northpointe');
    cwW = (await client.query(
      `SELECT warehouse, table_funded, table_funded_at FROM closing_workflow WHERE application_id=$1`, [W.appId])).rows[0];
    ok(cwW.table_funded === false && cwW.table_funded_at === null,
      'moving off the Table Funding warehouse clears the table-funded mark');
    ok(!!(await purchasing.getPurchasing(W.appId, client)),
      'and the already-delivered file is handed to the purchasing desk');

    // ---- A file enters purchasing at DELIVERY, before reconciliation ----
    // "even if it's not removed yet from the closing workload because it's
    // waiting for reconciliation".
    const N = await makeFile();
    await client.query(
      `UPDATE closing_workflow SET fully_reconciled_at=NULL, stage='wire_sent' WHERE application_id=$1`, [N.appId]);
    await signOffInvestorDelivery(N.appId, N.closerId, true);
    ok(!!(await purchasing.getPurchasing(N.appId, client)),
      'an UNRECONCILED file still enters purchasing the moment investor delivery is signed off');
    ok(await inQueue(N.closerId, N.appId),
      'and it stays on the closer\'s Workflow until it is reconciled — on both desks at once');

    // ---- Purchasing CONDITIONS ----
    const c1 = await purchasing.addCondition(client, N.appId, 'Recorded mortgage from the county', 'Ordered 07/20', N.closerId);
    await purchasing.addCondition(client, N.appId, 'Final title policy', null, N.closerId);
    let conds = await purchasing.readConditions(N.appId, client);
    ok(conds.length === 2 && conds.every((x) => x.status === 'open'), 'purchasing conditions can be added per file');
    const cleared = await purchasing.setConditionStatus(client, c1.id, 'cleared', N.closerId, 'Came back recorded');
    ok(cleared.status === 'cleared' && String(cleared.resolved_by) === String(N.closerId) && cleared.resolution_note === 'Came back recorded',
      'a condition clears and records who + why (no uuid/text error)');
    const reopened = await purchasing.setConditionStatus(client, c1.id, 'open', N.closerId);
    ok(reopened.status === 'open' && reopened.resolved_by === null && reopened.resolution_note === null,
      're-opening a condition clears the stale signature');
    await purchasing.setConditionStatus(client, c1.id, 'waived', N.closerId, 'Buyer waived');
    ok((await purchasing.readConditions(N.appId, client)).find((x) => String(x.id) === String(c1.id)).status === 'waived',
      'a condition that will never be met can be waived');
    await purchasing.deleteCondition(client, c1.id);
    ok((await purchasing.readConditions(N.appId, client)).length === 1, 'a condition can be removed');

    // ---- PURCHASE ADVICE (date + document, re-issued post closing/post purchase) ----
    const advDoc = (await client.query(
      `INSERT INTO documents (application_id, filename, content_type, doc_kind)
       VALUES ($1,'purchase-advice.pdf','application/pdf','purchase_advice') RETURNING id`, [N.appId])).rows[0];
    await purchasing.setPurchaseAdvice(client, N.appId, { date: '2026-08-20' }, N.closerId);
    let pa = await purchasing.readAdvice(N.appId, client);
    ok(String(pa.advice_date).slice(0, 10) === '2026-08-20' && !!pa.updated_at,
      'a purchase advice date can be recorded');
    await purchasing.setPurchaseAdvice(client, N.appId, { documentId: advDoc.id }, N.closerId);
    pa = await purchasing.readAdvice(N.appId, client);
    ok(String(pa.document_id) === String(advDoc.id) && pa.document_filename === 'purchase-advice.pdf',
      'the advice document is pointed at, and its filename rides along for the desk');
    ok(String(pa.advice_date).slice(0, 10) === '2026-08-20',
      'and setting the document did NOT clear the date (only keys present are touched)');

    const advDoc2 = (await client.query(
      `INSERT INTO documents (application_id, filename, content_type, doc_kind)
       VALUES ($1,'purchase-advice-final.pdf','application/pdf','purchase_advice') RETURNING id`, [N.appId])).rows[0];
    await purchasing.setPurchaseAdvice(client, N.appId, { documentId: advDoc2.id }, N.closerId);
    ok((await purchasing.readAdvice(N.appId, client)).document_filename === 'purchase-advice-final.pdf',
      'the advice document can be UPDATED post purchase — it is not write-once');

    // THE ADVICE SURVIVES A WITHDRAWAL. withdrawFromPurchasing DELETEs the
    // purchasing_workflow row, and it runs on two ordinary closer actions
    // (warehouse -> Table Funding, and un-signing investor delivery). While the
    // advice lived on that row it was silently destroyed, with no warning, while
    // the notes/tasks/conditions beside it survived — so nothing looked wrong.
    await purchasing.withdrawFromPurchasing(client, N.appId);
    ok(!(await purchasing.getPurchasing(N.appId, client)), 'the file is withdrawn from the purchasing desk');
    const paAfter = await purchasing.readAdvice(N.appId, client);
    ok(paAfter && String(paAfter.advice_date).slice(0, 10) === '2026-08-20'
       && paAfter.document_filename === 'purchase-advice-final.pdf',
      'and the purchase advice date + document SURVIVE the withdrawal');
    ok((await purchasing.readConditions(N.appId, client)).length === 1
       && (await purchasing.readNotes(N.appId, client)).length >= 0,
      'as do the conditions beside it (they always did — the advice now matches)');
    await purchasing.enterPurchasing(client, N.appId, N.closerId);

    const wsN = await purchasing.getPurchasingWorkspace(N.appId, client);
    ok(wsN.openConditions === 1 && wsN.documents.some((d) => String(d.id) === String(advDoc2.id)),
      'the workspace carries the open-condition count and the file documents to pick the advice from');

    // A superseded advice document must STILL be listed while it is the one being
    // pointed at, or the picker would read "none selected" while the line beneath
    // it named the old file.
    await client.query(`UPDATE documents SET is_current=false WHERE id=$1`, [advDoc2.id]);
    const wsSup = await purchasing.getPurchasingWorkspace(N.appId, client);
    ok(wsSup.documents.some((d) => String(d.id) === String(advDoc2.id)),
      'the pointed-at advice document stays listed even once it is superseded');
    ok(wsSup.advice.document_filename === 'purchase-advice-final.pdf',
      'and the desk still names it');

    // ---- A FINISHED closing leaves the desk + the nav badge, EITHER WAY ----
    // The desk retired a file only at stage='in_purchasing'. A TABLE FUNDED loan
    // is structurally barred from that stage (the route 422s it, the button is
    // hidden), so every table-funded file sat on the desk and kept the badge
    // incremented forever with no action available to clear it — half of the
    // owner's "once reconciled it should go off the closing workflow either way".
    const deskRetired = async (appId) => (await client.query(
      `SELECT ${closing.CLOSING_RETIRED_SQL('cw')} AS retired
         FROM closing_workflow cw WHERE cw.application_id=$1`, [appId])).rows[0].retired;

    const TF = await makeFile();
    await setWarehouse(TF.appId, TF.closerId, closing.TABLE_FUNDING);
    ok((await deskRetired(TF.appId)) === false, 'a table-funded file is still ON the closing desk before it is finished');
    await signOffInvestorDelivery(TF.appId, TF.closerId, true);
    const tfRow = (await client.query(
      `SELECT stage, table_funded FROM closing_workflow WHERE application_id=$1`, [TF.appId])).rows[0];
    ok(tfRow.table_funded === true && tfRow.stage !== 'in_purchasing',
      'it is finished WITHOUT ever reaching stage=in_purchasing (it was sold at closing)');
    ok((await deskRetired(TF.appId)) === true,
      'and it STILL leaves the closing desk and its badge — retirement is "finished", not the stage');

    const PU = await makeFile();
    await signOffInvestorDelivery(PU.appId, PU.closerId, true);
    ok((await deskRetired(PU.appId)) === true, 'a purchasing-bound file leaves the desk too');
    const OPEN = await makeFile();
    ok((await deskRetired(OPEN.appId)) === false, 'a file still working through closing stays on the desk');

    // ---- UN-SIGNING a file that already went to purchasing returns it ----
    // `stage` is sticky, so the desk's legacy stage test still read such a file
    // as finished after an un-sign: off the closing desk AND off the purchasing
    // desk — on NEITHER, the exact hazard the reopen exists to prevent, reached
    // through the desk instead of the Workflow queue.
    const UN = await makeFile();
    await signOffInvestorDelivery(UN.appId, UN.closerId, true);
    await client.query(
      `UPDATE closing_workflow SET stage='in_purchasing', purchasing_at=now() WHERE application_id=$1`, [UN.appId]);
    ok((await deskRetired(UN.appId)) === true, 'a file handed to purchasing is off the closing desk');
    await signOffInvestorDelivery(UN.appId, UN.closerId, false);
    ok(!(await purchasing.getPurchasing(UN.appId, client)), 'un-signing pulls it off the purchasing desk');
    ok((await deskRetired(UN.appId)) === false,
      'and it comes BACK onto the closing desk — never on neither');
    ok(await inQueue(UN.closerId, UN.appId), 'and back onto the closer\'s Workflow too');

    // ---- A PURCHASE ADVICE IS NEVER BORROWER-VISIBLE ----
    // It names the note buyer and the price the loan sold for. The upload
    // endpoint derives visibility from the TARGET CONDITION's audience, and the
    // purchasing screen has no upload slot of its own — so an advice filed
    // against any ordinary borrower-facing condition landed visibility='borrower',
    // straight into the borrower's Documents list with the bytes intact.
    const leaky = (await client.query(
      `INSERT INTO documents (application_id, borrower_id, filename, content_type, doc_kind, visibility)
       SELECT $1, a.borrower_id, 'purchase-advice-leak.pdf', 'application/pdf', 'purchase_advice', 'borrower'
         FROM applications a WHERE a.id=$1 RETURNING id, visibility`, [N.appId])).rows[0];
    ok(leaky.visibility === 'borrower', 'a purchase advice can be uploaded borrower-visible (the door that existed)');

    // Designating it calls the SHIPPED library, which owns the forcing — no
    // mirrored UPDATE here, or deleting the real one would leave this green.
    await purchasing.setPurchaseAdvice(client, N.appId, { documentId: leaky.id }, N.closerId);
    const shut = (await client.query(`SELECT visibility FROM documents WHERE id=$1`, [leaky.id])).rows[0];
    ok(shut.visibility === 'staff_only', 'designating it as the purchase advice forces it staff-only');

    // Both borrower doors gate on visibility='borrower', so both are now closed.
    const inBorrowerList = (await client.query(
      `SELECT count(*)::int n FROM documents
        WHERE id=$1 AND visibility='borrower' AND source_type <> 'chat_attachment'`, [leaky.id])).rows[0].n;
    ok(inBorrowerList === 0, 'so it is out of the borrower documents list AND the mentionables list');

    ok((await client.query(`SELECT doc_kind FROM documents WHERE id=$1`, [leaky.id])).rows[0].doc_kind === 'purchase_advice',
      'and it is tagged as the advice, so nothing can hand it back by accident');

    // THE SUPERSEDE CASE — the documented normal workflow: the advice is
    // re-issued post closing and again post purchase. An earlier version of this
    // RESTORED the outgoing document's visibility on the reasoning that a
    // mis-pick must be undoable — which handed the PREVIOUS ADVICE, a real one
    // naming the note buyer and the sale price, straight back to the borrower.
    // Once hidden, it stays hidden.
    const v2 = (await client.query(
      `INSERT INTO documents (application_id, filename, content_type, visibility)
       VALUES ($1,'purchase-advice-v2.pdf','application/pdf','borrower') RETURNING id`, [N.appId])).rows[0];
    await purchasing.setPurchaseAdvice(client, N.appId, { documentId: v2.id }, N.closerId);
    ok((await client.query(`SELECT visibility FROM documents WHERE id=$1`, [leaky.id])).rows[0].visibility === 'staff_only',
      'superseding the advice does NOT hand the previous one back to the borrower');
    ok((await client.query(`SELECT visibility FROM documents WHERE id=$1`, [v2.id])).rows[0].visibility === 'staff_only',
      'and the re-issued advice is hidden too');

    // A repeat designation must not destroy the recorded undo.
    await purchasing.setPurchaseAdvice(client, N.appId, { documentId: v2.id }, N.closerId);
    ok((await purchasing.readAdvice(N.appId, client)).document_prior_visibility === 'borrower',
      're-designating the same document keeps the recorded prior visibility (the undo survives)');
    await purchasing.setPurchaseAdvice(client, N.appId, { documentId: leaky.id }, N.closerId);

    // db/359 does the same for files that already had one (previous AND future).
    await client.query(`UPDATE documents SET visibility='borrower' WHERE id=$1`, [leaky.id]);
    await client.query(fs.readFileSync(path.join(__dirname, '..', 'db', '359_purchase_advice_staff_only.sql'), 'utf8'));
    ok((await client.query(`SELECT visibility FROM documents WHERE id=$1`, [leaky.id])).rows[0].visibility === 'staff_only',
      'db/359 shuts the same door on a file that already had a borrower-visible advice');

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
