'use strict';
/**
 * Bidirectional Phase 2 — drift detection + two-sided review. (1) release drift (G-FIND-MATCH): a
 * Sitewire-side change to an already-RELEASED draw's approved amount parks a two-sided alert; a
 * change on a NON-released draw does not. (2) budget drift: the managed budget diverging from what
 * PILOT pushed parks a two-sided restorable review; a matching budget does not. DB-gated skip.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-sitewire-drift (no DATABASE_URL)'); process.exit(0); }
process.env.SITEWIRE_ENABLED = process.env.SITEWIRE_ENABLED || '1';
const db = require('../src/db');
const client = require('../src/sitewire/client');
const reconcile = require('../src/sitewire/reconcile');
const { sitewireAllowedActions } = require('../src/sitewire/review-actions');
let P = 0, F = 0;
const R = Math.floor(Math.random() * 900000) + 100000;
const PROP = 4200000 + R, BUD = 7700000 + R, D1 = 5200000 + R, D2 = 5300000 + R;
function ok(c, m) { c ? (P++, console.log('  ok -', m)) : (F++, console.log('  FAIL -', m)); }

let DRAWS = [], BUDGET = null;
client.getProperty = async () => ({ id: PROP, budget: { id: BUD, draws: DRAWS } });
client.getDraw = async (id) => { const d = DRAWS.find((x) => x.id === id) || {}; return { ...d, requests: [], draw_events: [] }; };
client.getBudget = async () => BUDGET;

async function drift(appId, cls) {
  return (await db.query(`SELECT id, portal_value, clickup_value FROM sync_review_queue WHERE application_id=$1 AND field_key='sitewire' AND status='open' AND split_part(reason,':',1)=$2`, [appId, cls])).rows[0] || null;
}

(async () => {
  const ids = [];
  try {
    // pure unit: the resolution rules
    ok(JSON.stringify(sitewireAllowedActions('sitewire_budget_drift')) === JSON.stringify(['restore', 'accept', 'dismiss']), 'budget_drift → restore/accept/dismiss');
    ok(JSON.stringify(sitewireAllowedActions('sitewire_release_drift')) === JSON.stringify(['acknowledge', 'dismiss']), 'release_drift → acknowledge/dismiss');

    const b = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Dr','Ift',$1) RETURNING id`, [`dr${R}@e.com`])).rows[0];
    const a = (await db.query(`INSERT INTO applications (borrower_id,status,property_address) VALUES ($1,'funded','{"oneLine":"7 Drift Ln"}') RETURNING id`, [b.id])).rows[0]; ids.push(a.id);
    // not-first reconcile: set last_reconciled_at so reactions run (and last_budget_verified_at recent so the poll doesn't auto-run budget verify — we call it directly)
    await db.query(`INSERT INTO sitewire_property_links (application_id,sitewire_property_id,sitewire_budget_id,matched_by,pushed_at,last_reconciled_at,last_budget_verified_at) VALUES ($1,$2,$3,'created',now(),now(),now())`, [a.id, PROP, BUD]);
    // a RELEASED draw at $900 approved, and its ledger row
    await db.query(`INSERT INTO sitewire_draws (application_id,sitewire_draw_id,sitewire_property_id,number,status,status_synced,total_requested_cents,total_approved_cents) VALUES ($1,$2,$3,1,'approved','approved',100000,90000)`, [a.id, D1, PROP]);
    await db.query(`INSERT INTO draw_disbursements (application_id,sitewire_draw_id,kind,approved_cents,net_release_cents,funded_status) VALUES ($1,$2,'draw',90000,89000,'released')`, [a.id, D1]);
    // a NON-released draw at $500 approved
    await db.query(`INSERT INTO sitewire_draws (application_id,sitewire_draw_id,sitewire_property_id,number,status,status_synced,total_requested_cents,total_approved_cents) VALUES ($1,$2,$3,2,'pending','pending',50000,50000)`, [a.id, D2, PROP]);

    // --- release drift: Sitewire now shows the released draw approved at $950 (changed), the other at $600 ---
    DRAWS = [
      { id: D1, number: 1, status: 'approved', total_requested_cents: 100000, total_approved_cents: 95000 },
      { id: D2, number: 2, status: 'pending', total_requested_cents: 50000, total_approved_cents: 60000 },
    ];
    await reconcile.reconcileOne(a.id);
    const rd = await drift(a.id, 'sitewire_release_drift');
    ok(!!rd, 'released-draw approved change → release_drift parked');
    ok(rd && rd.portal_value === '90000' && rd.clickup_value === '95000', 'release_drift two-sided values (PILOT 90000 / Sitewire 95000)');
    // the non-released draw's change did NOT park a release_drift (only one release_drift row)
    const rdCount = (await db.query(`SELECT count(*)::int c FROM sync_review_queue WHERE application_id=$1 AND split_part(reason,':',1)='sitewire_release_drift' AND status='open'`, [a.id])).rows[0].c;
    ok(rdCount === 1, 'non-released draw change did NOT park a release drift');
    // both approved changes were audited
    ok((await db.query(`SELECT count(*)::int c FROM sitewire_pull_field_change WHERE application_id=$1 AND field IN ('release_drift','total_approved_cents')`, [a.id])).rows[0].c === 2, 'both approved changes audited');

    // --- budget drift: LIVE crosswalk expects 60000+40000=100000; Sitewire budget shows 110000 ---
    await db.query(`INSERT INTO sitewire_job_item_links (application_id,sitewire_budget_id,sitewire_job_item_id,sow_line_key,budgeted_cents,name,section_token,state) VALUES ($1,$2,801,'k1',60000,'Kitchen','s1','live'),($1,$2,802,'k2',40000,'Roof','s2','live')`, [a.id, BUD]);
    BUDGET = { id: BUD, total_budgeted_cents: 110000, job_items: [{ id: 801, budgeted_cents: 60000 }, { id: 802, budgeted_cents: 50000 }] };
    await reconcile.verifyBudgetDrift(a.id, BUD);
    const bd = await drift(a.id, 'sitewire_budget_drift');
    ok(!!bd, 'budget mismatch → budget_drift parked');
    ok(bd && bd.portal_value === '100000' && bd.clickup_value === '110000', 'budget_drift two-sided values (PILOT 100000 / Sitewire 110000)');

    // matching budget → no NEW park (dedup on the open row; still exactly one)
    BUDGET = { id: BUD, total_budgeted_cents: 100000, job_items: [{ id: 801, budgeted_cents: 60000 }, { id: 802, budgeted_cents: 40000 }] };
    await reconcile.verifyBudgetDrift(a.id, BUD);
    const bdCount = (await db.query(`SELECT count(*)::int c FROM sync_review_queue WHERE application_id=$1 AND split_part(reason,':',1)='sitewire_budget_drift' AND status='open'`, [a.id])).rows[0].c;
    ok(bdCount === 1, 'a matching re-check does not pile up duplicate budget-drift rows');

    // HIGH-1 regression: a DELETED SOW line keeps its old cents on the crosswalk but is gone from
    // Sitewire — it must be EXCLUDED from the expected total, so it never raises a FALSE drift.
    await db.query(`UPDATE sync_review_queue SET status='resolved' WHERE application_id=$1 AND split_part(reason,':',1)='sitewire_budget_drift'`, [a.id]);
    await db.query(`INSERT INTO sitewire_job_item_links (application_id,sitewire_budget_id,sitewire_job_item_id,sow_line_key,budgeted_cents,name,section_token,state) VALUES ($1,$2,803,'k3',50000,'Removed','s3','deleted')`, [a.id, BUD]);
    BUDGET = { id: BUD, total_budgeted_cents: 100000, job_items: [{ id: 801, budgeted_cents: 60000 }, { id: 802, budgeted_cents: 40000 }] }; // Sitewire holds the live lines only
    await reconcile.verifyBudgetDrift(a.id, BUD);
    const falseDrift = (await db.query(`SELECT count(*)::int c FROM sync_review_queue WHERE application_id=$1 AND split_part(reason,':',1)='sitewire_budget_drift' AND status='open'`, [a.id])).rows[0].c;
    ok(falseDrift === 0, 'a DELETED budget line does not raise a false drift (excluded from expected total)');

    console.log(`\n${P} passed, ${F} failed`);
  } catch (e) { console.error('THREW', e && e.message, e && e.stack); F++; }
  finally {
    try { for (const id of ids) { for (const t of ['sync_review_queue', 'sitewire_pull_field_change', 'draw_disbursements', 'sitewire_job_item_links', 'sitewire_draws', 'sitewire_property_links', 'notifications']) await db.query(`DELETE FROM ${t} WHERE application_id=$1`, [id]); const bb = (await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [id])).rows[0]; await db.query(`DELETE FROM applications WHERE id=$1`, [id]); if (bb) await db.query(`DELETE FROM borrowers WHERE id=$1`, [bb.borrower_id]); } } catch (_) {}
    try { await db.pool.end(); } catch (_) {}
    if (F) process.exit(1);
  }
})();
