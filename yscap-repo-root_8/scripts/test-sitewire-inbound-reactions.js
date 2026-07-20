'use strict';
/**
 * Bidirectional Phase 1 — PILOT reacts to inbound Sitewire changes. Drives reconcileOne against a
 * stubbed Sitewire client and asserts: the first reconcile BASELINES silently (no notification burst),
 * a genuinely new draw notifies the team, a real status transition notifies once + audits + advances
 * the watermark, and the same status never re-fires. DB-gated skip.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-sitewire-inbound-reactions (no DATABASE_URL)'); process.exit(0); }
process.env.SITEWIRE_ENABLED = process.env.SITEWIRE_ENABLED || '1';
const db = require('../src/db');
const client = require('../src/sitewire/client');
const reconcile = require('../src/sitewire/reconcile');
let P = 0, F = 0;
const R = Math.floor(Math.random() * 900000) + 100000;
const PROP = 4000000 + R, D1 = 5000000 + R, D2 = 6000000 + R;
function ok(c, m) { c ? (P++, console.log('  ok -', m)) : (F++, console.log('  FAIL -', m)); }

// mutable stub state
let DRAWS = [];
client.getProperty = async () => ({ id: PROP, budget: { id: 1, draws: DRAWS } });
client.getDraw = async (id) => { const d = DRAWS.find((x) => x.id === id) || {}; return { ...d, requests: [], draw_events: [] }; };

async function inboundCount(appId, field, reacted) {
  const r = await db.query(`SELECT count(*)::int c FROM sitewire_pull_field_change WHERE application_id=$1 AND field=$2 AND reacted=$3`, [appId, field, reacted]);
  return r.rows[0].c;
}
async function notifyCount(appId) {
  const r = await db.query(`SELECT count(*)::int c FROM notifications WHERE application_id=$1 AND type='draw_inbound'`, [appId]);
  return r.rows[0].c;
}

(async () => {
  const ids = []; let staffId;
  try {
    const st = (await db.query(`INSERT INTO staff_users (email,full_name,role,token_version,is_active) VALUES ($1,'Coord','draw_coordinator',0,true) RETURNING id`, [`co${R}@e.com`])).rows[0]; staffId = st.id;
    const b = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('In','Bound',$1) RETURNING id`, [`ib${R}@e.com`])).rows[0];
    const a = (await db.query(`INSERT INTO applications (borrower_id,status,loan_officer_id,property_address) VALUES ($1,'funded',$2,'{"oneLine":"5 Sync St"}') RETURNING id`, [b.id, staffId])).rows[0];
    ids.push(a.id);
    await db.query(`INSERT INTO sitewire_property_links (application_id,sitewire_property_id,matched_by,pushed_at) VALUES ($1,$2,'created',now())`, [a.id, PROP]);
    // ensure the coordinator is an assignee so notifyAppStaff has a recipient (trigger mirrors loan_officer_id, but assert)
    await db.query(`INSERT INTO application_assignees (application_id,staff_id,role) VALUES ($1,$2,'loan_officer') ON CONFLICT DO NOTHING`, [a.id, staffId]).catch(() => {});

    // --- A: FIRST reconcile baselines silently ---
    DRAWS = [{ id: D1, number: 1, status: 'pending_borrower', total_requested_cents: 100000, total_approved_cents: 0 }];
    await reconcile.reconcileOne(a.id);
    ok((await notifyCount(a.id)) === 0, 'first reconcile: NO notification (baseline)');
    ok((await inboundCount(a.id, 'baseline', false)) === 1, 'first reconcile: baseline audit recorded');
    let sync = (await db.query(`SELECT status_synced FROM sitewire_draws WHERE sitewire_draw_id=$1`, [D1])).rows[0];
    ok(sync && sync.status_synced === 'pending_borrower', 'watermark baselined to current status');

    // --- B: a genuinely NEW draw (after first reconcile) notifies ---
    DRAWS.push({ id: D2, number: 2, status: 'pending_borrower', total_requested_cents: 50000, total_approved_cents: 0 });
    await reconcile.reconcileOne(a.id);
    ok((await notifyCount(a.id)) === 1, 'new draw: 1 notification fired');
    ok((await inboundCount(a.id, 'new_draw', true)) === 1, 'new draw: new_draw audit (reacted)');

    // --- C: a status TRANSITION on draw 1 → approved notifies + advances watermark ---
    DRAWS[0].status = 'approved'; DRAWS[0].total_approved_cents = 90000;
    await reconcile.reconcileOne(a.id);
    ok((await notifyCount(a.id)) === 2, 'transition→approved: 1 more notification');
    ok((await inboundCount(a.id, 'status', true)) === 1, 'transition: status audit (reacted)');
    ok((await inboundCount(a.id, 'total_approved_cents', false)) === 1, 'transition: approved-amount change audited (not reacted)');
    sync = (await db.query(`SELECT status_synced FROM sitewire_draws WHERE sitewire_draw_id=$1`, [D1])).rows[0];
    ok(sync.status_synced === 'approved', 'watermark advanced to approved');

    // --- D: same status again → NO re-fire ---
    await reconcile.reconcileOne(a.id);
    ok((await notifyCount(a.id)) === 2, 'no transition: notification count unchanged (no re-fire)');

    console.log(`\n${P} passed, ${F} failed`);
  } catch (e) { console.error('THREW', e && e.message, e && e.stack); F++; }
  finally {
    try { for (const id of ids) { await db.query(`DELETE FROM sitewire_pull_field_change WHERE application_id=$1`, [id]); await db.query(`DELETE FROM sitewire_draws WHERE application_id=$1`, [id]); await db.query(`DELETE FROM sitewire_property_links WHERE application_id=$1`, [id]); await db.query(`DELETE FROM notifications WHERE application_id=$1`, [id]); const bb = (await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [id])).rows[0]; await db.query(`DELETE FROM applications WHERE id=$1`, [id]); if (bb) await db.query(`DELETE FROM borrowers WHERE id=$1`, [bb.borrower_id]); } if (staffId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]); } catch (_) {}
    try { await db.pool.end(); } catch (_) {}
    if (F) process.exit(1);
  }
})();
