'use strict';
/**
 * Sitewire WRITE-BACK (phase 3 — blueprint §5A): mirror a TrustPoint approval into the
 * LIVE Sitewire intake draw, so Sitewire's per-line ledger and budget rollups stay the
 * portfolio's source of continuity. Per-line approved amounts + lender comments via the
 * guarded Sitewire client (read-after-write, journaled, park-on-transient), then the
 * approve transition. NEVER-GUESS gates, every one parked/skipped rather than forced:
 *   · the TrustPoint draw must be APPROVED with a tied Sitewire intake draw;
 *   · per-line amounts must exist (derived or manual) and Σ == approved to the cent;
 *   · every line must map onto a request row of THAT Sitewire draw;
 *   · a line above its requested amount is refused (that's a human super-admin override
 *     flow in Sitewire — a robot never exercises it);
 *   · an already-approved Sitewire draw is left alone (idempotent).
 */

const db = require('../db');
const swClient = require('../sitewire/client');
const orchestrator = require('../sitewire/orchestrator');
const switches = require('../lib/integrations/switches');
const cfg = require('../config');
const usd = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });

async function setNote(tpDrawId, note) {
  await db.query(`UPDATE trustpoint_draws SET writeback_note=$2, updated_at=now() WHERE tp_draw_id=$1`, [tpDrawId, String(note || '').slice(0, 500)]).catch(() => {});
}

/**
 * @returns {ok:true, pushed:{lines,approved}} | {skipped:reason} | {parked:reason}
 * Never throws (the callers are best-effort reactions + routes that shape errors).
 */
async function pushApprovalToSitewire(appId, tpDrawId, { actorId = null } = {}) {
  try {
    if (!switches.on('SITEWIRE_ENABLED') || (!switches.on('SITEWIRE_OUTBOUND_ENABLED') && !cfg.sitewireDryrun)) {
      await setNote(tpDrawId, 'waiting: Sitewire writes are off');
      return { skipped: 'sitewire_writes_off' };
    }
    const tp = (await db.query(`SELECT * FROM trustpoint_draws WHERE tp_draw_id=$1 AND application_id=$2`, [tpDrawId, appId])).rows[0];
    if (!tp) return { skipped: 'not_found' };
    if (tp.writeback_at) return { skipped: 'already_pushed' };
    if (tp.status !== 'APPROVED' && tp.status !== 'COMPLETED') { await setNote(tpDrawId, 'waiting: not approved yet'); return { skipped: 'not_approved' }; }
    if (tp.portal_draw_request_id && !tp.sitewire_draw_id) {
      // Portal-originated draw — its Sitewire record is the phase-4 HISTORICAL close-out,
      // not a live write-back (there is no live Sitewire draw to write into).
      return { skipped: 'portal_closeout_path' };
    }
    if (!tp.sitewire_draw_id) { await setNote(tpDrawId, 'waiting: no Sitewire draw tied to this TrustPoint draw'); return { skipped: 'no_sitewire_draw' }; }
    const sw = (await db.query(`SELECT * FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [tp.sitewire_draw_id, appId])).rows[0];
    if (!sw) { await setNote(tpDrawId, 'waiting: tied Sitewire draw not found on this file'); return { skipped: 'sitewire_draw_missing' }; }
    if (sw.status === 'approved') {
      await db.query(`UPDATE trustpoint_draws SET writeback_at=now(), writeback_note='Sitewire draw was already approved', updated_at=now() WHERE tp_draw_id=$1`, [tpDrawId]);
      return { skipped: 'sitewire_already_approved' };
    }
    const lines = (await db.query(`SELECT * FROM trustpoint_draw_lines WHERE tp_draw_id=$1 ORDER BY id`, [tpDrawId])).rows;
    if (!lines.length) { await setNote(tpDrawId, 'waiting: no per-line amounts yet (derive or enter them)'); return { skipped: 'no_lines' }; }
    const sum = lines.reduce((s, l) => s + Number(l.approved_cents), 0);
    if (tp.approved_cents == null || sum !== Number(tp.approved_cents)) {
      await setNote(tpDrawId, `waiting: line total ${usd(sum)} ≠ approved ${usd(tp.approved_cents)}`);
      return { skipped: 'sum_mismatch' };
    }
    const reqs = (await db.query(
      `SELECT sitewire_request_id, sitewire_job_item_id, requested_cents, approved_cents FROM sitewire_draw_requests WHERE sitewire_draw_id=$1`, [tp.sitewire_draw_id])).rows;
    const reqBy = new Map(reqs.map((r) => [Number(r.sitewire_job_item_id), r]));
    const plan = [];
    for (const l of lines) {
      const r = reqBy.get(Number(l.sitewire_job_item_id));
      if (!r) {
        await orchestrator.park({ appId, dedupe: `tpwb-map:${tpDrawId}`, reason: `sitewire_approve_failed: TrustPoint approved money on "${l.name || l.sitewire_job_item_id}" but the Sitewire draw has no matching line — reconcile the draws by hand, never auto-applied.` }).catch(() => {});
        await setNote(tpDrawId, `parked: no Sitewire line for ${l.name || l.sitewire_job_item_id}`);
        return { parked: 'line_unmapped' };
      }
      if (Number(l.approved_cents) > Number(r.requested_cents)) {
        await orchestrator.park({ appId, dedupe: `tpwb-over:${tpDrawId}`, reason: `sitewire_approve_failed: TrustPoint approved ${usd(l.approved_cents)} on "${l.name || ''}" but only ${usd(r.requested_cents)} was requested in Sitewire — approving over the request is a super-admin action; do it by hand on the draw desk.` }).catch(() => {});
        await setNote(tpDrawId, 'parked: a line exceeds its Sitewire requested amount');
        return { parked: 'line_over_requested' };
      }
      plan.push({ requestId: r.sitewire_request_id, cents: Number(l.approved_cents), name: l.name });
    }
    // Zero-fill the Sitewire lines TrustPoint approved nothing on, so the draw's approved
    // total equals TrustPoint's exactly (a stale pending amount would otherwise linger).
    for (const r of reqs) {
      if (Number(r.requested_cents) > 0 && !lines.some((l) => Number(l.sitewire_job_item_id) === Number(r.sitewire_job_item_id))) {
        plan.push({ requestId: r.sitewire_request_id, cents: 0, name: null });
      }
    }

    await orchestrator.circuitCheck(plan.length + 1);
    const comment = 'Approved via the administered draw process.';
    for (const p of plan) {
      const resp = await swClient.updateRequest(p.requestId, { approved_cents: p.cents, lender_comments: comment });
      if (!(resp && resp.__dryrun)) {
        let saved = p.cents;
        try { const fresh = await swClient.getRequest(p.requestId); if (fresh && fresh.approved_cents != null) saved = fresh.approved_cents; } catch (_) {}
        if (Number(saved) !== p.cents) {
          await orchestrator.park({ appId, dedupe: `tpwb-verify:${tpDrawId}`, reason: `sitewire_approve_failed: Sitewire saved ${usd(saved)} instead of ${usd(p.cents)} on line ${p.requestId} — verify by hand.` }).catch(() => {});
          await setNote(tpDrawId, 'parked: read-after-write mismatch');
          return { parked: 'verify_mismatch' };
        }
        await db.query(`UPDATE sitewire_draw_requests SET approved_cents=$2, lender_comments=$3, updated_at=now() WHERE sitewire_request_id=$1`, [p.requestId, p.cents, comment]);
        await orchestrator.journal({ appId, entity: 'request', entityId: Number(p.requestId), field: 'approved_cents', newValue: p.cents, source: 'trustpoint_writeback' }).catch(() => {});
      }
    }
    const tr = await swClient.drawTransition(tp.sitewire_draw_id, 'approve');
    if (tr && tr.__dryrun) {
      // Dry-run VALIDATES only — nothing was sent, so the write-back stays pending
      // (marking it done would block the real push when writes turn on).
      await setNote(tpDrawId, 'validated in dry-run — nothing sent');
      return { ok: true, pushed: { lines: plan.length, approved: Number(tp.approved_cents), dryrun: true } };
    }
    await orchestrator.journal({ appId, entity: 'draw', entityId: Number(tp.sitewire_draw_id), field: 'approve', newValue: { source: 'trustpoint_writeback', actor: actorId }, source: 'trustpoint_writeback' }).catch(() => {});
    // status_synced moves WITH the status (echo suppression): the next Sitewire reconcile
    // must see this approve as already-announced — the team was told when TRUSTPOINT
    // approved; the mirror write into Sitewire is plumbing, not a second event.
    await db.query(`UPDATE sitewire_draws SET status='approved', status_synced='approved', total_approved_cents=$2, updated_at=now() WHERE sitewire_draw_id=$1`, [tp.sitewire_draw_id, Number(tp.approved_cents)]);
    await db.query(`UPDATE trustpoint_draws SET writeback_at=now(), writeback_note=NULL, updated_at=now() WHERE tp_draw_id=$1`, [tpDrawId]);
    return { ok: true, pushed: { lines: plan.length, approved: Number(tp.approved_cents), dryrun: false } };
  } catch (e) {
    const transient = e && (e.retryable || e.code === 'SITEWIRE_CIRCUIT_OPEN' || (e.status >= 500 && e.status <= 599));
    try {
      await orchestrator.park({
        appId, dedupe: `tpwb:${tpDrawId}`,
        reason: `sitewire_approve_failed: could not mirror the TrustPoint approval into Sitewire (${String(e && e.message).slice(0, 160)})${transient ? ' — Sitewire was briefly unavailable; retry.' : ' — review by hand.'}`,
      });
    } catch (_) {}
    await setNote(tpDrawId, `parked: ${String(e && e.message).slice(0, 200)}`);
    return { parked: transient ? 'transient' : 'error' };
  }
}

/** The best-effort reaction chain on a TrustPoint approval: derive → write back. */
async function onTrustpointApproval(appId, tpDrawId) {
  try {
    const lines = require('./lines');
    const existing = await lines.linesFor(tpDrawId);
    if (!existing.length) await lines.deriveLines(appId, tpDrawId).catch(() => {});
    return await pushApprovalToSitewire(appId, tpDrawId, {});
  } catch (e) { return { skipped: 'error' }; }
}

/**
 * Retry sweep (audit-3 #3): the approval reaction fires ONCE (the watermark claim), so a
 * crash mid-chain, a transient Sitewire outage, writes being off, or an IN_REVIEW→COMPLETED
 * jump that skipped the APPROVED sighting would otherwise leave the mirror un-pushed
 * forever. Re-drives every approved-but-unpushed draw; every path is idempotent and
 * self-gating (skips/parks, never double-sends), so re-running is free.
 */
async function sweepPending() {
  const out = { tried: 0 };
  try {
    const rows = (await db.query(
      `SELECT application_id, tp_draw_id, portal_draw_request_id, sitewire_draw_id FROM trustpoint_draws
        WHERE status IN ('APPROVED','COMPLETED') AND writeback_at IS NULL
          AND (sitewire_draw_id IS NOT NULL OR portal_draw_request_id IS NOT NULL)
        ORDER BY updated_at LIMIT 25`)).rows;
    for (const r of rows) {
      out.tried++;
      try {
        if (r.portal_draw_request_id && !r.sitewire_draw_id) {
          // Portal-originated: its Sitewire record is the historical close-out.
          await require('../lib/portal-draws').historicalCloseOut(r.application_id, Number(r.portal_draw_request_id));
        } else {
          await onTrustpointApproval(r.application_id, r.tp_draw_id);
        }
      } catch (_) {}
    }
  } catch (_) {}
  return out;
}

module.exports = { pushApprovalToSitewire, onTrustpointApproval, sweepPending };
