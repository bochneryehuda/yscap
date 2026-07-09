'use strict';
/**
 * Single authority for a file's VESTING ENTITY (the subject LLC).
 *
 * One code path used by BOTH ClickUp ingest and the staff/borrower "link LLC" HTTP
 * routes, so the follow-through can never drift between them. Historically ingest
 * set only `applications.llc_id` — and only "fill-only" (WHERE llc_id IS NULL) —
 * and ran NONE of the wiring the HTTP routes run. Result: a ClickUp-set entity
 * landed in the borrower's LLC library but the file's vesting entity was never
 * updated and its document slots/conditions were never built, so "LLPA LLC" never
 * appeared on the file. This helper is the fix and the single source of truth.
 *
 *   setVestingLlc(appId, llcId, opts) -> { changed, reason?, previous?, rewired? }
 *     opts.source      'clickup' | 'staff' | 'borrower'   (default 'staff')
 *     opts.allowChange (default true)  replace an EXISTING different entity;
 *                      false = fill-only (only when currently NULL)
 *     opts.push        (default true)  enqueue the outbound ClickUp push of the
 *                      vesting fields — forced OFF for source='clickup' (no echo)
 *     opts.force       (default false) force the heavy condition re-eval even when
 *                      the LLC doc checklist already existed (HTTP routes / repair)
 *
 * Guards:
 *   • Never changes a Clear-to-Close / funded / declined / withdrawn file (the
 *     vesting entity is frozen at CTC, mirroring the HTTP routes).
 *   • A 'clickup' (automated) source never overwrites a VERIFIED entity, or one a
 *     human linked (llcs.origin <> 'clickup_backfill') — human/verified intent wins.
 */
const db = require('../db');

const LOCKED = ['clear_to_close', 'funded', 'declined', 'withdrawn'];

async function setVestingLlc(appId, llcId, opts = {}) {
  const { allowChange = true, source = 'staff', push = true, actor = null } = opts;
  if (!appId || !llcId) return { changed: false, reason: 'missing_args' };
  const app = (await db.query(
    `SELECT id, llc_id, status FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId])).rows[0];
  if (!app) return { changed: false, reason: 'not_found' };

  // Already the vesting entity: still ensure the wiring exists (idempotent repair
  // for files whose llc_id was set but whose checklist/conditions were never built).
  if (String(app.llc_id || '') === String(llcId)) {
    await runWiring(appId, llcId, source, push, { force: !!opts.force, actor });
    return { changed: false, reason: 'already_linked', rewired: true };
  }
  if (LOCKED.includes(app.status)) return { changed: false, reason: 'locked' };
  if (app.llc_id) {
    if (!allowChange) return { changed: false, reason: 'fill_only_occupied' };
    if (source === 'clickup') {
      const cur = (await db.query(`SELECT is_verified, origin FROM llcs WHERE id=$1`, [app.llc_id])).rows[0];
      if (cur && (cur.is_verified || cur.origin !== 'clickup_backfill'))
        return { changed: false, reason: 'human_or_verified_protected' };
    }
  }
  await db.query(`UPDATE applications SET llc_id=$2, updated_at=now() WHERE id=$1`, [appId, llcId]);
  await runWiring(appId, llcId, source, push, { force: true, actor });
  return { changed: true, previous: app.llc_id || null };
}

// The full follow-through — identical to what the HTTP link routes have always run,
// now shared. Kept cheap in steady state: the heavy condition re-eval only fires
// when the entity actually changed (force) or the LLC doc checklist was just built.
async function runWiring(appId, llcId, source, push, { force = false, actor = null } = {}) {
  try { await require('./llc-borrowers').syncVestingLlcBorrowers(appId); } catch (_) { /* best-effort */ }
  let created = false;
  try {
    const before = (await db.query(`SELECT count(*)::int n FROM checklist_items WHERE llc_id=$1`, [llcId])).rows[0].n;
    await require('../routes/borrower').generateLlcChecklist(llcId);
    const after = (await db.query(`SELECT count(*)::int n FROM checklist_items WHERE llc_id=$1`, [llcId])).rows[0].n;
    created = after > before;
  } catch (_) { /* best-effort */ }
  if (force || created) {
    // Always recompute the LLC condition itself (cheap, pull-safe — no outbound).
    try { await require('./llc').syncLlcConditions(llcId, { appId, reopen: true }); } catch (_) { /* best-effort */ }
    // The full rule-engine re-eval runs for HUMAN link actions only. On an automated
    // ClickUp pull we skip it: it is heavy (×155 on a boot backfill) and can enqueue
    // outbound checklist pushes — an unwanted pull→push echo. New ClickUp files still
    // get their initial eval via generateChecklist during ingest; the LLC condition
    // above is what makes the entity render correctly.
    if (source !== 'clickup') {
      try { await require('./conditions/engine').evaluateApplication(appId, { actor, reason: 'llc_linked' }); } catch (_) { /* best-effort */ }
    }
  }
  // Outbound push of the vesting fields (llc_id -> *Vesting / *LLC Name / EIN). Never
  // echo a change we just pulled FROM ClickUp back to it.
  if (push && source !== 'clickup') {
    try { await require('../clickup/enqueue').enqueueClickupPush(appId, ['llc_id']); } catch (_) { /* best-effort */ }
  }
}

module.exports = { setVestingLlc };
