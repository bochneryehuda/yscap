'use strict';
/*
 * DB-gated test for TWO fixes found by the pre-merge audit of the closing
 * auto-clear (owner-directed 2026-07-26).
 *
 * (A) LOCK ORDER. Resolving the closing hand-off inside the completion
 *     transaction made the completion paths take their locks
 *     closing_workflow -> workflow_items, while the submit-to-closing route takes
 *     them workflow_items -> closing_workflow (and cannot be reordered, because
 *     openClosing needs the id submitItem returns). A loan officer re-submitting a
 *     file at the same moment the closer completed THAT SAME file deadlocked, and
 *     Postgres aborted one side — failing a money-grade action.
 *     workflow.lockClosingItems takes the hand-off lock FIRST so all paths agree.
 *     This test proves the race is clean WITH the pre-lock, and — the part that
 *     makes it a real guard — that the SAME race still deadlocks WITHOUT it.
 *
 * (B) db/349. db/347's backfill keyed on stage='in_purchasing', but the runtime
 *     rule is reconciled + investor-delivered. A legacy file that was never
 *     advanced to purchasing, and every TABLE FUNDED file (which by design never
 *     reaches that stage at all), kept a stuck hand-off forever.
 *
 * Needs COMMITTED rows on two connections, so unlike its siblings this test can't
 * run inside one rolled-back transaction — it cleans up after itself explicitly.
 * Requires DATABASE_URL with migrations applied; SKIPs cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-closing-lock-order-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const workflow = require('../src/lib/workflow');

let passed = 0;
const ok = (c, n) => { assert.ok(c, n); console.log(`  ok  ${n}`); passed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = (p) => p + process.pid.toString(36) + Math.random().toString(36).slice(2, 8) + '@example.com';

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  const made = { apps: [], staff: [], borrowers: [] };

  // A funded file with a LIVE closing hand-off, reconciled + investor-delivered.
  async function makeFile(c, { tableFunded = false, purchasing = false } = {}) {
    const b = (await c.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Lock','Order',$1) RETURNING id`, [uniq('lob+')])).rows[0];
    const lo = (await c.query(
      `INSERT INTO staff_users (email,full_name,role,is_active) VALUES ($1,'LO','loan_officer',true) RETURNING id`, [uniq('lolo+')])).rows[0];
    const closer = (await c.query(
      `INSERT INTO staff_users (email,full_name,role,is_active) VALUES ($1,'Closer','closer',true) RETURNING id`, [uniq('locl+')])).rows[0];
    const app = (await c.query(
      `INSERT INTO applications (borrower_id, status, closer_id) VALUES ($1,'funded',$2) RETURNING id`, [b.id, closer.id])).rows[0];
    made.borrowers.push(b.id); made.staff.push(lo.id, closer.id); made.apps.push(app.id);
    const item = await workflow.submitItem(c, {
      appId: app.id, submissionType: 'closing', fromStaffId: lo.id, toStaffId: closer.id,
      toRole: 'closer', note: 'to closing', priority: 2, estClosingDate: '2026-08-15',
    });
    await workflow.openClosing(c, { appId: app.id, workflowItemId: item.id, estClosingDate: '2026-08-15', actorId: lo.id });
    await c.query(
      `UPDATE closing_workflow
          SET stage=$2, fully_reconciled_at=now(), investor_delivery_signed_off_at=now(),
              table_funded=$3, table_funded_at = CASE WHEN $3 THEN now() END,
              purchasing_at = CASE WHEN $2='in_purchasing' THEN now() END
        WHERE application_id=$1`,
      [app.id, purchasing ? 'in_purchasing' : 'fully_reconciled', tableFunded]);
    return { appId: app.id, loId: lo.id, closerId: closer.id, itemId: item.id };
  }
  const liveItems = async (c, appId) => (await c.query(
    `SELECT id, status, outcome_label FROM workflow_items
      WHERE application_id=$1 AND submission_type='closing' AND status IN ('open','in_progress')`, [appId])).rows;

  /* The race, run either WITH the shipped pre-lock or WITHOUT it (the old order).
     A = the closer completing the file. B = the LO re-submitting to closing.
     Returns the SQLSTATE of whichever side was aborted, or null. */
  async function race({ preLock }) {
    const setup = await pool.connect();
    let F;
    try { F = await makeFile(setup); } finally { setup.release(); }

    const A = await pool.connect();
    const B = await pool.connect();
    const errs = [];
    try {
      await A.query('BEGIN'); await B.query('BEGIN');
      // A (completion) — with the fix it takes the hand-off lock BEFORE closing_workflow.
      if (preLock) await workflow.lockClosingItems(A, F.appId);
      await A.query(`UPDATE closing_workflow SET stage='in_purchasing', purchasing_at=now() WHERE application_id=$1`, [F.appId]);
      // B (re-submit) — submitItem's supersede takes workflow_items first. Always.
      const bSupersede = B.query(
        `UPDATE workflow_items SET status='cancelled', updated_at=now()
          WHERE application_id=$1 AND submission_type='closing' AND status IN ('open','in_progress')`, [F.appId])
        .catch((e) => { errs.push(['B', e.code]); });
      await sleep(150);
      // Each side now reaches for what the other holds.
      const aFinish = workflow.maybeFinishClosing(A, F.appId, F.closerId).catch((e) => { errs.push(['A', e.code]); });
      await sleep(150);
      const bOpen = bSupersede.then(() => workflow.openClosing(B, {
        appId: F.appId, workflowItemId: null, estClosingDate: '2026-09-01', actorId: F.loId,
      })).catch((e) => { if (!errs.some((x) => x[0] === 'B')) errs.push(['B', e.code]); });
      await Promise.race([Promise.all([aFinish, bOpen]), sleep(15000)]);
    } finally {
      await A.query('ROLLBACK').catch(() => {});
      await B.query('ROLLBACK').catch(() => {});
      A.release(); B.release();
    }
    const dl = errs.find((e) => e[1] === '40P01');
    return dl ? dl[0] : null;
  }

  try {
    // ---- (A) LOCK ORDER ----
    ok(await race({ preLock: true }) === null,
      'the completion and a concurrent re-submit BOTH finish — no deadlock with the pre-lock');
    // The negative: the same race on the OLD lock order really does deadlock, so the
    // check above is guarding the fix rather than passing for an unrelated reason.
    ok(await race({ preLock: false }) !== null,
      'and the SAME race WITHOUT the pre-lock still deadlocks (the guard is real)');

    // ---- (B) db/349 widened backfill ----
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', '349_closing_autoclear_predicate_widen.sql'), 'utf8');
    const c = await pool.connect();
    try {
      // Reconciled + delivered but NEVER advanced to purchasing — db/347 misses it.
      const legacy = await makeFile(c);
      // Table funded: sold at closing, so it never reaches 'in_purchasing' at all.
      const tf = await makeFile(c, { tableFunded: true });
      // A file completed and then legitimately RE-SUBMITTED — its NEW hand-off must survive.
      const resub = await makeFile(c, { purchasing: true });
      await c.query(`UPDATE closing_workflow SET purchasing_at = now() - interval '2 days' WHERE application_id=$1`, [resub.appId]);
      await c.query(`UPDATE workflow_items SET received_at = now() WHERE application_id=$1 AND submission_type='closing'`, [resub.appId]);

      ok((await liveItems(c, legacy.appId)).length === 1, 'the legacy reconciled+delivered file starts with a stuck hand-off');

      await c.query(sql);

      ok((await liveItems(c, legacy.appId)).length === 0,
        'db/349 clears a file that was reconciled + delivered but never advanced to purchasing');
      ok((await liveItems(c, tf.appId)).length === 0,
        'db/349 clears a TABLE FUNDED file, which never reaches stage=in_purchasing');
      const tfEvent = (await c.query(
        `SELECT outcome_label FROM workflow_events
          WHERE application_id=$1 AND event_type='returned' ORDER BY created_at DESC LIMIT 1`, [tf.appId])).rows[0];
      ok(tfEvent && /table funded/i.test(tfEvent.outcome_label),
        'and it is recorded as table funded (sold at closing), not "sent to purchasing"');
      ok((await liveItems(c, resub.appId)).length === 1,
        'a RE-SUBMITTED file keeps its new hand-off — the backfill never wipes live work');

      // Idempotent: a second boot changes nothing and duplicates no history.
      const before = (await c.query(
        `SELECT count(*)::int n FROM workflow_events WHERE application_id = ANY($1::uuid[]) AND event_type='returned'`,
        [[legacy.appId, tf.appId, resub.appId]])).rows[0].n;
      await c.query(sql);
      const after = (await c.query(
        `SELECT count(*)::int n FROM workflow_events WHERE application_id = ANY($1::uuid[]) AND event_type='returned'`,
        [[legacy.appId, tf.appId, resub.appId]])).rows[0].n;
      ok(before === after && (await liveItems(c, resub.appId)).length === 1,
        'running it a second time (the next deploy) changes nothing');
    } finally { c.release(); }

    // ---- (C) the RUNTIME re-submit guard (the audit's worst finding) ----
    // fully_reconciled_at is sticky and investor_delivery_signed_off_at only
    // clears on an investor-delivery un-sign, so on a file completed once
    // closingIsFinished stays true FOREVER. Without a received_at guard at
    // runtime, a legitimately re-submitted hand-off was silently returned the
    // moment the closer touched anything — a TPR tick, any stage move.
    const c2 = await pool.connect();
    try {
      const F = await makeFile(c2);
      ok((await workflow.maybeFinishClosing(c2, F.appId, F.closerId)).length === 1,
        'the ORIGINAL hand-off is cleared when the closing finishes');

      // The LO re-submits the file to closing after it was completed.
      const again = await workflow.submitItem(c2, {
        appId: F.appId, submissionType: 'closing', fromStaffId: F.loId, toStaffId: F.closerId,
        toRole: 'closer', note: 're-submitted', priority: 2, estClosingDate: '2026-09-30',
      });
      ok((await liveItems(c2, F.appId)).length === 1, 'the re-submitted hand-off is live on the closer\'s Workflow');

      // The closer now ticks something unrelated — this fires maybeFinishClosing.
      const swept = await workflow.maybeFinishClosing(c2, F.appId, F.closerId);
      ok(swept.length === 0 && (await liveItems(c2, F.appId)).length === 1,
        'a later completion sweep does NOT touch the re-submitted hand-off');
      ok(String((await liveItems(c2, F.appId))[0].id) === String(again.id),
        'and it is still the SAME new hand-off, untouched');

      // Re-completing it (a fresh delivery sign-off) legitimately clears it again.
      await c2.query(
        `UPDATE closing_workflow SET investor_delivery_signed_off_at=now() WHERE application_id=$1`, [F.appId]);
      ok((await workflow.maybeFinishClosing(c2, F.appId, F.closerId)).length === 1,
        'genuinely re-completing the file clears the new hand-off too');

      // ---- (C2) …and a file that ALREADY WENT TO PURCHASING can re-complete ----
      // `purchasing_at` is STICKY, so an anchor of COALESCE(purchasing_at, …)
      // freezes at the first "Send to purchasing" and a re-submitted file could
      // never clear again — permanently stuck on the closer's Workflow, the exact
      // bug this mechanism exists to fix. This case fails on that anchor and
      // passes on GREATEST-of-all-three.
      const G = await makeFile(c2, { purchasing: true });
      // Round 1 happened days ago: the hand-off arrived BEFORE the completion,
      // exactly as it does in life.
      await c2.query(
        `UPDATE closing_workflow
            SET purchasing_at = now() - interval '3 days',
                fully_reconciled_at = now() - interval '3 days',
                investor_delivery_signed_off_at = now() - interval '3 days'
          WHERE application_id=$1`, [G.appId]);
      await c2.query(
        `UPDATE workflow_items SET received_at = now() - interval '4 days'
          WHERE application_id=$1 AND submission_type='closing'`, [G.appId]);
      ok((await workflow.maybeFinishClosing(c2, G.appId, G.closerId)).length === 1,
        'a file that went to purchasing clears its original hand-off');
      await workflow.submitItem(c2, {
        appId: G.appId, submissionType: 'closing', fromStaffId: G.loId, toStaffId: G.closerId,
        toRole: 'closer', note: 're-submitted after purchasing', priority: 2, estClosingDate: '2026-10-31',
      });
      ok((await workflow.maybeFinishClosing(c2, G.appId, G.closerId)).length === 0,
        'its re-submitted hand-off survives while the closing is not re-completed');
      // The closer genuinely re-completes it (a fresh investor-delivery sign-off).
      await c2.query(
        `UPDATE closing_workflow SET investor_delivery_signed_off_at=now() WHERE application_id=$1`, [G.appId]);
      ok((await workflow.maybeFinishClosing(c2, G.appId, G.closerId)).length === 1,
        'and re-completing it DOES clear — a sticky purchasing_at never strands the file');
      ok((await liveItems(c2, G.appId)).length === 0,
        'so it really does leave the closer\'s Workflow the second time too');

      // ---- (D) un-signing investor delivery reopens the hand-off ----
      // Otherwise the file is on NEITHER queue: withdrawn from purchasing and
      // already returned off the closer's Workflow.
      await c2.query(
        `UPDATE closing_workflow SET investor_delivery_signed_off_at=NULL WHERE application_id=$1`, [F.appId]);
      ok((await workflow.reopenClosingItem(c2, F.appId, F.closerId)).length === 1,
        'un-signing investor delivery reopens the auto-cleared hand-off');
      ok((await liveItems(c2, F.appId)).length === 1,
        'so the file is back on the closer\'s Workflow, not lost between the two desks');
      ok((await workflow.reopenClosingItem(c2, F.appId, F.closerId)).length === 0,
        'reopening again is a no-op — it never creates a second live hand-off');
    } finally { c2.release(); }

    console.log(`test-closing-lock-order-db: ${passed} checks passed`);
  } catch (e) {
    console.error('test-closing-lock-order-db FAILED:', e && e.message);
    process.exitCode = 1;
  } finally {
    const c = await pool.connect().catch(() => null);
    if (c) {
      for (const t of ['workflow_events', 'workflow_items', 'purchasing_tasks', 'purchasing_notes',
        'purchasing_workflow', 'closing_workflow'])
        await c.query(`DELETE FROM ${t} WHERE application_id = ANY($1::uuid[])`, [made.apps]).catch(() => {});
      await c.query(`DELETE FROM applications WHERE id = ANY($1::uuid[])`, [made.apps]).catch(() => {});
      await c.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [made.staff]).catch(() => {});
      await c.query(`DELETE FROM borrowers WHERE id = ANY($1::uuid[])`, [made.borrowers]).catch(() => {});
      c.release();
    }
    await pool.end();
  }
})();
