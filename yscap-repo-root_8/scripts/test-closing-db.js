'use strict';
/*
 * DB-gated test for the closing workspace — exercises the REAL queries against a
 * real schema (a pure/mock test can't catch a wrong-column bug). Covers:
 *   - ensureClosingConditions attaches the 3 closing document conditions (idempotent)
 *   - the Encompass funded-date read (field 1401 via closingDocument.fundingDate)
 *   - reconcileClosingDates across match / missing / mismatch / Encompass-N/A
 *   - getClosingWorkspace returns a coherent payload
 *   - the closer checklist create + read flow
 * Requires DATABASE_URL with migrations applied; SKIPs cleanly otherwise. Runs in a
 * transaction and ROLLS BACK — leaves no rows behind.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-closing-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const closing = require('../src/lib/closing');
const workflow = require('../src/lib/workflow');

let passed = 0;
const ok = (c, n) => { assert.ok(c, n); console.log(`  ok  ${n}`); passed++; };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const email = 'closingdbt+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    const b = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth)
         VALUES ('Close','Test',$1,'1985-03-10') RETURNING id`, [email])).rows[0];
    // encompass_extra carries the funded date at the standard 1401 loanPath. A real
    // Encompass loan always has a customFields[] array (that's what triggers the
    // field-map's flattenLoan → standard loanPath resolution).
    const loan = { customFields: [], closingDocument: { fundingDate: '2026-07-10' } };
    const app = (await client.query(
      `INSERT INTO applications
         (borrower_id, ys_loan_number, property_address, program, loan_type, status,
          funded_date, actual_closing, encompass_loan_guid, encompass_extra)
       VALUES ($1,'YSCAP-CLOSE','{"state":"NY"}'::jsonb,'Fix & Flip','Purchase','funded',
               '2026-07-10','2026-07-10','guid-123',$2::jsonb)
       RETURNING id`, [b.id, JSON.stringify(loan)])).rows[0];
    const appId = app.id;

    // A staffer to attribute the closing submit to (openClosing stamps _by fields).
    const actor = (await client.query(
      `INSERT INTO staff_users (email,full_name,role,is_active)
         VALUES ($1,'Closing Actor','closer',true) RETURNING id`,
      ['closeactor+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com'])).rows[0];

    // Open the closing row through the REAL submit helper (a bare INSERT would not
    // exercise the parameterized query — the $4::uuid used both directly and inside
    // CASE WHEN ... THEN $4 END regressed a "server error" on every closing submit).
    await workflow.openClosing(client, {
      appId, workflowItemId: null, estClosingDate: '2026-08-15', actorId: actor.id,
      investorCtc: true, closingDateConfirmed: true,
    });
    const cw = (await client.query(
      `SELECT stage, investor_ctc, investor_ctc_by, closing_date_confirmed, closing_date_confirmed_by
         FROM closing_workflow WHERE application_id=$1`, [appId])).rows[0];
    ok(cw && cw.stage === 'estimated', 'openClosing creates the closing row at "estimated" (no $4 type error)');
    ok(cw.investor_ctc === true && cw.investor_ctc_by === actor.id, 'openClosing stamps investor CTC + the actor id');
    ok(cw.closing_date_confirmed === true && cw.closing_date_confirmed_by === actor.id, 'openClosing stamps confirmed-with-parties + the actor id');
    // Idempotent ON CONFLICT path (a re-submit) must also not throw on $4.
    await workflow.openClosing(client, {
      appId, workflowItemId: null, estClosingDate: '2026-08-16', actorId: actor.id,
      investorCtc: false, closingDateConfirmed: false,
    });

    await closing.ensureClosingConditions(client, appId);
    await closing.ensureClosingConditions(client, appId); // idempotent
    const conds = (await client.query(
      `SELECT t.code FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code LIKE 'closing_%' ORDER BY t.code`, [appId])).rows.map((r) => r.code);
    ok(conds.length === 3, 'ensureClosingConditions attaches exactly 3 (idempotent)');
    ok(conds.includes('closing_hud_final') && conds.includes('closing_pkg_signed') && conds.includes('closing_tracking_label'), 'the 3 closing conditions are present');

    // Encompass funded date reads from encompass_extra via the read-only field map.
    const encRow = (await client.query(`SELECT encompass_extra FROM applications WHERE id=$1`, [appId])).rows[0];
    ok(closing.readEncompassFundedDate(encRow) === '2026-07-10', 'Encompass funded date reads field 1401 (closingDocument.fundingDate)');

    // Reconciliation: all three match → ok.
    let rec = await closing.reconcileClosingDates(appId, client);
    ok(rec.ok && rec.encStatus === 'match', 'reconciles when PILOT/ClickUp/Encompass all match');

    // ClickUp date missing → blocked.
    await client.query(`UPDATE applications SET actual_closing=NULL WHERE id=$1`, [appId]);
    rec = await closing.reconcileClosingDates(appId, client);
    ok(!rec.ok && /ClickUp/.test(rec.reason), 'blocked when ClickUp funding date missing');

    // Mismatch → blocked.
    await client.query(`UPDATE applications SET actual_closing='2026-07-11' WHERE id=$1`, [appId]);
    rec = await closing.reconcileClosingDates(appId, client);
    ok(!rec.ok, 'blocked when PILOT and ClickUp disagree');

    // Encompass N/A (not linked) → PILOT + ClickUp are enough.
    await client.query(`UPDATE applications SET actual_closing='2026-07-10', encompass_loan_guid=NULL, encompass_extra=NULL WHERE id=$1`, [appId]);
    rec = await closing.reconcileClosingDates(appId, client);
    ok(rec.ok && rec.encStatus === 'na', 'Encompass N/A when file not linked');

    // Workspace payload is coherent.
    const ws = await closing.getClosingWorkspace(appId, client);
    ok(ws && ws.warehouses && ws.warehouses.length === 6, 'workspace returns the 6 warehouses');
    ok(ws.conditions.length === 3, 'workspace returns the 3 closing conditions');
    ok(ws.reconciliation && ws.reconciliation.ok === true, 'workspace reconciliation reflects current state');
    ok(ws.money && ws.money.ok === false, 'workspace money gate not ok before an actual cash-to-close is entered');

    // Closer checklist create + read.
    const cl = (await client.query(
      `INSERT INTO closing_checklists (application_id, provider, title, created_by) VALUES ($1,'Blue Lake','BL closing',NULL) RETURNING id`, [appId])).rows[0];
    await client.query(`INSERT INTO closing_checklist_items (checklist_id,label,sort_order) VALUES ($1,'Verify EMD',10),($1,'Confirm wire',20)`, [cl.id]);
    const lists = await closing.readChecklists(appId, client);
    ok(lists.length === 1 && lists[0].items.length === 2, 'closer checklist create + read works');
    ok(lists[0].provider === 'Blue Lake', 'per-capital-provider checklist label preserved');

    // Check off a checklist item — the SAME UPDATE the toggle route runs. The
    // actor id ($3) is a bare parameter inside CASE WHEN…THEN, so without a ::uuid
    // cast Postgres pins it to text and the uuid column write throws a 500.
    // Call the SHIPPED helper the route uses — not a re-typed copy of the SQL —
    // so dropping the ::uuid cast in closing.js actually fails this test.
    const item0 = lists[0].items[0].id;
    await closing.setChecklistItemChecked(client, item0, true, actor.id);
    const checkedRow = (await client.query(
      `SELECT checked, checked_by FROM closing_checklist_items WHERE id=$1`, [item0])).rows[0];
    ok(checkedRow.checked === true && checkedRow.checked_by === actor.id, 'checklist item check-off stamps the actor (no uuid/text type error)');
    // Un-check must also not throw (the ELSE NULL branch).
    await closing.setChecklistItemChecked(client, item0, false, actor.id);
    const uncheckedRow = (await client.query(
      `SELECT checked, checked_by FROM closing_checklist_items WHERE id=$1`, [item0])).rows[0];
    ok(uncheckedRow.checked === false && uncheckedRow.checked_by === null, 'checklist item un-check clears the actor');

    // Term-sheet quick-link: the executed (signed) sheet + the draft both surface,
    // executed FIRST (the closer needs a direct link to the signed final sheet).
    // Executed copy is OLDER than the draft, so plain created_at-DESC ordering
    // would surface the DRAFT first — the assertion below therefore genuinely
    // proves the executed-first SORT (not an accidental tie-break).
    await client.query(
      `INSERT INTO documents (application_id, filename, doc_kind, is_current, created_at) VALUES
         ($1,'term-sheet-EXECUTED.pdf','term_sheet_signed',true, now() - interval '1 hour'),
         ($1,'term-sheet-draft.pdf','term_sheet',true, now())`, [appId]);
    const ql = await closing.readQuickLinks(appId, null, client);
    ok(Array.isArray(ql.term_sheet) && ql.term_sheet.length === 2, 'term-sheet quick-link groups the executed sheet + the draft');
    ok(ql.term_sheet[0].doc_kind === 'term_sheet_signed', 'the executed (signed) term sheet is listed first');

    // ---- COMPLETED closings drop off the closer's Workflow automatically ----
    // (owner-directed 2026-07-26). Submit the file to closing so the closer has a
    // LIVE hand-off, then complete it and confirm the hand-off resolves itself.
    const closerB = (await client.query(
      `INSERT INTO staff_users (email,full_name,role,is_active)
         VALUES ($1,'Queue Closer','closer',true) RETURNING id`,
      ['queuecloser+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com'])).rows[0];
    const item = await workflow.submitItem(client, {
      appId, submissionType: 'closing', fromStaffId: actor.id, toStaffId: closerB.id,
      toRole: 'closer', note: 'to closing', priority: 2, estClosingDate: '2026-08-15',
    });
    let live = await workflow.listQueue(closerB.id, { tab: 'next' }, client);
    ok(live.some((r) => String(r.application_id) === String(appId)), 'the file sits in the closer\'s Workflow while closing is open');

    const resolved = await workflow.resolveClosingItem(client, appId, actor.id);
    ok(resolved.length === 1 && String(resolved[0].id) === String(item.id), 'completing the closing resolves the closer hand-off');
    live = await workflow.listQueue(closerB.id, { tab: 'next' }, client);
    ok(!live.some((r) => String(r.application_id) === String(appId)), 'the completed file DISAPPEARS from the closer\'s Workflow');
    const hist = (await client.query(
      `SELECT event_type FROM workflow_events WHERE workflow_item_id=$1 AND event_type='returned'`, [item.id])).rows;
    ok(hist.length === 1, 'the auto-clear is recorded in Workflow history (one returned event)');
    // Idempotent — a second completion (or the backfill re-running) is a no-op.
    const again = await workflow.resolveClosingItem(client, appId, actor.id);
    ok(again.length === 0, 'resolving an already-completed closing is a no-op (idempotent)');

    await client.query('ROLLBACK');
    console.log(`test-closing-db: ${passed} checks passed`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('test-closing-db FAILED:', e && e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
