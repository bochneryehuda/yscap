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

    // closing_workflow row + closing conditions.
    await client.query(`INSERT INTO closing_workflow (application_id, stage) VALUES ($1,'estimated')`, [appId]);
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
