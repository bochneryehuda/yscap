'use strict';

/**
 * THE HARD RULE, end to end (owner-directed 2026-08-11): a value the team changes in PILOT
 * must NEVER be silently reverted by the ClickUp inbound pull because ClickUp still holds
 * the old value — "even if it's not updating in ClickUp, it should still stay updated in
 * our system." The queue-aware portal-edit guard keeps any field with an UNDELIVERED
 * outbound push, applies the real COALESCE UPDATE the inbound pull uses, and proves the
 * value survives. A genuine two-sided disagreement parks a review instead of overwriting.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-clickup-bounce-back-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const guard = require('../src/lib/inbound-portal-edit-guard');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const num = (v) => (v == null ? null : Number(v));

// Apply the EXACT inbound COALESCE UPDATE the ingest uses (ingest.js:2071-2072), so the
// test exercises the real write path a stale pull would take, not a stand-in.
async function applyInboundCoalesce(appId, cols) {
  const keys = Object.keys(cols);
  if (!keys.length) return;
  const set = keys.map((k, i) => `${k}=COALESCE($${i + 2}, ${k})`).join(', ');
  await db.query(`UPDATE applications SET ${set} WHERE id=$1`, [appId, ...keys.map((k) => cols[k])]);
}

async function enqueuePendingPush(appId, only, status = 'queued') {
  await db.query(
    `INSERT INTO sync_queue (target, direction, op, entity_type, entity_id, status, payload, run_after, created_at, updated_at)
     VALUES ('clickup','push','update','application',$1,$2,$3,now(),now(),now())`,
    [appId, status, JSON.stringify({ only })]);
}

(async () => {
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let borrowerId;
  try {
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('BB','Test',$1) RETURNING id`,
      [`bb-${sfx}@test.local`])).rows[0].id;
    const mkApp = async (task, extra = {}) => {
      const cols = Object.assign({ borrower_id: borrowerId, status: 'processing', clickup_pipeline_task_id: task }, extra);
      const keys = Object.keys(cols);
      const r = await db.query(
        `INSERT INTO applications (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
        keys.map((k) => cols[k]));
      return r.rows[0].id;
    };

    // ── CASE 1 — the reported bug: a portal edit with an in-flight push, no snapshot ──
    // The team changed the purchase price to 450,000 in PILOT; the outbound push is still
    // queued; ClickUp still holds the old 400,000. The inbound pull carries 400,000.
    const app1 = await mkApp(`bbtask1-${sfx}`, { purchase_price: 450000 });
    await enqueuePendingPush(app1, ['purchase_price']);       // the undelivered edit
    const cols1 = { purchase_price: 400000 };                 // ClickUp's stale value
    await guard.applyInboundPortalEditGuard({ appId: app1, cols: cols1, taskId: `bbtask1-${sfx}`, borrowerId });
    assert(cols1.purchase_price === null, 'case1: the guard NULLed the stale value out of the pull (COALESCE keeps ours)');
    await applyInboundCoalesce(app1, cols1);
    const after1 = num((await db.query(`SELECT purchase_price FROM applications WHERE id=$1`, [app1])).rows[0].purchase_price);
    assert(after1 === 450000, 'case1: the PILOT value (450,000) SURVIVES the inbound pull — no bounce-back');

    // ── CASE 1b — baseline: WITHOUT a pending push and with no snapshot, the same pull reverts ──
    const app1b = await mkApp(`bbtask1b-${sfx}`, { purchase_price: 450000 });
    const cols1b = { purchase_price: 400000 };
    await guard.applyInboundPortalEditGuard({ appId: app1b, cols: cols1b, taskId: `bbtask1b-${sfx}`, borrowerId });
    await applyInboundCoalesce(app1b, cols1b);
    const after1b = num((await db.query(`SELECT purchase_price FROM applications WHERE id=$1`, [app1b])).rows[0].purchase_price);
    assert(after1b === 400000, 'case1b: baseline — with no pending push and no snapshot the stale value DOES overwrite (proves the guard is what protects case 1)');

    // ── CASE 2 — a DEAD-lettered push still protects (an edit ClickUp couldn't accept) ──
    const app2 = await mkApp(`bbtask2-${sfx}`, { arv: 700000 });
    await enqueuePendingPush(app2, ['arv'], 'dead');          // dead-lettered, still undelivered
    const cols2 = { arv: 650000 };
    await guard.applyInboundPortalEditGuard({ appId: app2, cols: cols2, taskId: `bbtask2-${sfx}`, borrowerId });
    await applyInboundCoalesce(app2, cols2);
    const after2 = num((await db.query(`SELECT arv FROM applications WHERE id=$1`, [app2])).rows[0].arv);
    assert(after2 === 700000, 'case2: a DEAD-lettered outbound push still keeps the PILOT value (never reverts on an error)');

    // ── CASE 3 — a genuine two-sided disagreement parks a review AND keeps ours ──
    // File = 450,000 (our edit), last-seen snapshot = 400,000, ClickUp NOW = 430,000 (moved
    // independently) + our push still pending → keep ours + a portal_edit_conflict review.
    const task3 = `bbtask3-${sfx}`;
    const app3 = await mkApp(task3, { purchase_price: 450000 });
    await db.query(
      `INSERT INTO clickup_task_index (task_id, application_id, snapshot, snapshot_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (task_id) DO UPDATE SET snapshot=$3, snapshot_at=now()`,
      [task3, app3, JSON.stringify({ app: { purchase_price: 400000 } })]);
    await enqueuePendingPush(app3, ['purchase_price']);
    const cols3 = { purchase_price: 430000 };
    await guard.applyInboundPortalEditGuard({ appId: app3, cols: cols3, taskId: task3, borrowerId });
    await applyInboundCoalesce(app3, cols3);
    const after3 = num((await db.query(`SELECT purchase_price FROM applications WHERE id=$1`, [app3])).rows[0].purchase_price);
    assert(after3 === 450000, 'case3: a two-sided disagreement KEEPS the PILOT value (our system is the source of truth)');
    const rev3 = (await db.query(
      `SELECT count(*)::int n FROM sync_review_queue WHERE application_id=$1 AND field_key='portal_edit_conflict' AND status='open'`, [app3])).rows[0].n;
    assert(rev3 === 1, 'case3: the disagreement parked exactly one portal_edit_conflict review (never a silent overwrite)');

    // ── CASE 4 — field-AGNOSTIC keep for a column NOT in the listed set ──
    // occupancy is not in PROTECTED_KEYS; a pending push for it still protects it, proving
    // the queue-aware layer is not tied to any curated list.
    const app4 = await mkApp(`bbtask4-${sfx}`, { occupancy: 'Owner Occupied' });
    await enqueuePendingPush(app4, ['occupancy']);
    const cols4 = { occupancy: 'Investor' };
    await guard.applyInboundPortalEditGuard({ appId: app4, cols: cols4, taskId: `bbtask4-${sfx}`, borrowerId });
    assert(cols4.occupancy === null, 'case4: an unlisted column with a pending push is kept too (field-agnostic)');
    await applyInboundCoalesce(app4, cols4);
    const after4 = (await db.query(`SELECT occupancy FROM applications WHERE id=$1`, [app4])).rows[0].occupancy;
    assert(after4 === 'Owner Occupied', 'case4: the unlisted value SURVIVES — the hard rule covers every field, not a list');

    // ── CASE 5 — no in-flight edit at all: an ordinary ClickUp change flows in normally ──
    const app5 = await mkApp(`bbtask5-${sfx}`, { arv: 500000 });
    const cols5 = { arv: 525000 };
    await guard.applyInboundPortalEditGuard({ appId: app5, cols: cols5, taskId: `bbtask5-${sfx}`, borrowerId });
    await applyInboundCoalesce(app5, cols5);
    const after5 = num((await db.query(`SELECT arv FROM applications WHERE id=$1`, [app5])).rows[0].arv);
    assert(after5 === 525000, 'case5: with no in-flight edit and no snapshot, a genuine ClickUp change still applies (bidirectional preserved)');

  } catch (e) {
    console.error('FAIL unexpected error', e);
    failures++;
  } finally {
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
    await db.pool.end().catch(() => {});
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
