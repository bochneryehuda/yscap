'use strict';
/**
 * Sitewire worker — drains the outbound OUTBOX (sync_queue target='sitewire') and runs
 * the reconcile poll. Self-gating: no-ops unless SITEWIRE_ENABLED=1; outbound writes are
 * gated SEPARATELY by SITEWIRE_OUTBOUND_ENABLED so reads/reconcile can run before writes.
 *
 * Retry contract mirrors the ClickUp worker: an OUTAGE class (circuit open / retryable /
 * network) retries patiently (600s, dead at 40 ≈ 7h); a bad-value failure backs off and
 * dead-letters at 8 attempts, then parks a visible review row (never silently dropped).
 */
const db = require('../db');
const cfg = require('../config');
const orchestrator = require('../sitewire/orchestrator');
const reconcile = require('../sitewire/reconcile');
const { enqueueSitewirePush } = require('../sitewire/enqueue');

let started = false;
let lastDirectorySync = 0;

/**
 * Backfill stranded births (audit E-GATE-BIRTH-WHILE-OFF): a borrower who clicked "Request a
 * draw" while SITEWIRE_ENABLED was off consumed the one-time claim, but the enqueue no-op'd, so
 * the file has no Sitewire footprint and nothing ever re-fires. On worker start (Sitewire now
 * on) we enqueue every funded + draw-requested file that has no link row yet, so turning the
 * switch on catches up the backlog instead of silently stranding those files.
 */
async function backfillStrandedBirthsOnce() {
  try {
    const rows = (await db.query(
      `SELECT a.id FROM applications a
        WHERE a.status='funded' AND a.draw_setup_requested_at IS NOT NULL AND a.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM sitewire_property_links l WHERE l.application_id=a.id AND l.sitewire_property_id IS NOT NULL)
        LIMIT 500`)).rows;
    for (const r of rows) await enqueueSitewirePush(r.id, 'push_file').catch(() => {});
    if (rows.length) console.log(`[sitewire] backfilled ${rows.length} funded+draw-requested file(s) with no Sitewire footprint`);
  } catch (e) { console.warn('[sitewire] birth backfill skipped:', e.message); }
}

async function pushOutboxOnce() {
  const claim = await db.query(
    `UPDATE sync_queue SET status='processing', updated_at=now()
      WHERE id = (
        SELECT id FROM sync_queue
         WHERE target='sitewire' AND direction='push'
           AND (status='queued' AND run_after<=now()
                OR status='processing' AND updated_at < now() - interval '5 minutes')
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, entity_id, op, payload, attempts`);
  if (!claim.rowCount) return false;
  const job = claim.rows[0];
  try {
    let res;
    if (job.op === 'push_file') res = await orchestrator.pushFile(job.entity_id, { force: false });
    else res = { skipped: `unknown op ${job.op}` };
    await db.query(`UPDATE sync_queue SET status='done', updated_at=now() WHERE id=$1`, [job.id]);
    return true;
  } catch (e) {
    const outage = e.code === 'SITEWIRE_CIRCUIT_OPEN' || e.retryable === true;
    const attempts = (job.attempts || 0) + 1;
    const deadAt = outage ? 40 : 8;
    const msg = String(e.message || e).slice(0, 500);
    if (attempts >= deadAt) {
      await db.query(`UPDATE sync_queue SET status='dead', attempts=$2, last_error=$3, updated_at=now() WHERE id=$1`, [job.id, attempts, msg]);
      try { await orchestrator.park({ appId: job.entity_id, reason: `sitewire_push_dead_lettered: push failed after ${attempts} attempts — ${msg}` }); } catch (_) {}
    } else {
      const delaySec = outage ? 600 : Math.min(3600, 30 * 2 ** attempts);
      await db.query(`UPDATE sync_queue SET status='queued', attempts=$2, last_error=$3, run_after=now() + ($4 || ' seconds')::interval, updated_at=now() WHERE id=$1`, [job.id, attempts, msg, String(delaySec)]);
    }
    return true;
  }
}

async function reconcileOnce() {
  try {
    // refresh the capital-partner directory + staff map at most hourly
    if (Date.now() - lastDirectorySync > 3600000) {
      lastDirectorySync = Date.now();
      await reconcile.syncCapitalPartners().catch(() => {});
      await reconcile.syncStaffUsers().catch(() => {});
    }
    await reconcile.reconcileAll();
  } catch (e) { console.warn('[sitewire] reconcile error:', e.message); }
}

function start() {
  if (started) return;
  if (!cfg.sitewireEnabled) { console.log('[sitewire] disabled (set SITEWIRE_ENABLED=1 to turn on)'); return; }
  started = true;
  console.log('[sitewire] worker starting — outbound=%s dryrun=%s poll=%ss', cfg.sitewireOutboundEnabled, cfg.sitewireDryrun, cfg.sitewirePollSec);
  // one-shot warm of the directory + staff map, then catch up any stranded births
  reconcile.syncCapitalPartners().catch((e) => console.warn('[sitewire] partner sync:', e.message));
  reconcile.syncStaffUsers().catch(() => {});
  setTimeout(() => backfillStrandedBirthsOnce(), 3000);
  const drain = async (fn, name) => { try { let guard = 0; while (await fn() && guard++ < 500) {} } catch (e) { console.warn('[sitewire]', name, 'error:', e.message); } };
  if (cfg.sitewireOutboundEnabled) setInterval(() => drain(pushOutboxOnce, 'push'), 4000);
  setInterval(reconcileOnce, Math.max(60, cfg.sitewirePollSec) * 1000);
  setTimeout(reconcileOnce, 8000);
}

module.exports = { start, pushOutboxOnce, reconcileOnce };
