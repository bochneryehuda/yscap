'use strict';
/**
 * SharePoint mirror — claim-based work queue (Phase 2, 2026-07-21).
 *
 * The scheduling half of the explicit state machine. This module owns the
 * ATOMIC CLAIM (FOR UPDATE SKIP LOCKED + lease), the crash-recovery LEASE REAPER,
 * OUTCOME PERSISTENCE (via the pure decisions in sp-mirror-state.js), the
 * dual-write STATUS RECONCILE (keeps sharepoint_mirror_status tracking the legacy
 * columns during rollout), and the SHADOW COMPARE (proves the FSM claim set
 * matches the legacy pendingBatch set before any cutover). The actual byte upload
 * is NOT reimplemented here — at cutover the claimed row is handed to the existing
 * mirrorRow() logic, so all owner-directed upload behavior (Version-N folders,
 * dedup/adopt, integrity, one-way/no-delete) is preserved verbatim.
 *
 * ROLLOUT SAFETY — everything here is gated by SHAREPOINT_MIRROR_FSM:
 *   off    (default) — inert. Nothing in this module runs in the live pass.
 *   shadow — dual-write status + log claim-set divergence; the LEGACY worker
 *            still performs every upload. Read-only w.r.t. mirroring.
 *   on     — the FSM claims + uploads (Phase 4 cutover); legacy path stands down.
 *
 * See docs/SHAREPOINT-MIRROR-QUEUE-DESIGN.md.
 */

const db = require('../db');
const state = require('./sp-mirror-state');
// Shared selector fragments come from the legacy module so the never-mirror /
// regen-skip SQL has exactly ONE definition (the divergence this project kills).
// Accessed at call time (not module-load) to stay clear of any require cycle.
const backup = require('./sharepoint-backup');

const LEASE_MINUTES = (() => {
  const v = parseInt(process.env.SHAREPOINT_MIRROR_LEASE_MIN || '10', 10);
  return Number.isFinite(v) && v >= 1 ? v : 10;
})();
const _holderId = `${process.pid}-fsm`;

/** off | shadow | on — default off keeps the machine inert. */
function fsmMode() {
  const m = String(process.env.SHAREPOINT_MIRROR_FSM || 'off').toLowerCase().trim();
  return (m === 'shadow' || m === 'on') ? m : 'off';
}

// The claimable predicate = the legacy pendingBatch gating (settle window, local
// bytes, storage_ref, attempts<MAX, not-superseded-regen) AND an FSM-claimable
// status, OR an IN_PROGRESS row whose lease expired (crash reclaim). Reusing the
// shared NEVER_MIRROR_SQL / REGEN_KIND_SQL fragments means the historically
// divergence-prone bits are identical to the legacy drain by construction.
function claimableWhere() {
  return `
       COALESCE(d.sharepoint_next_attempt_at, d.created_at) <= now()
       AND (
             d.sharepoint_mirror_status IN ('PENDING','FAILED')
          OR (d.sharepoint_mirror_status = 'IN_PROGRESS' AND d.sharepoint_lease_expires_at < now())
       )
       -- Belt-and-suspenders against a stale status column: never claim a row the
       -- legacy path already mirrored (backed_up_at) or settled (skipped_reason),
       -- even if sharepoint_mirror_status hasn't been reconciled yet. Consistent in
       -- 'on' mode too, where persistOutcome writes status + these together.
       AND d.sharepoint_backed_up_at IS NULL
       AND d.sharepoint_skipped_reason IS NULL
       AND ${backup.NEVER_MIRROR_SQL}
       AND d.storage_ref IS NOT NULL
       AND COALESCE(d.storage_provider, 'local') = 'local'
       AND d.sharepoint_backup_attempts < $MAXA
       AND d.created_at < now() - (CASE WHEN ${backup.REGEN_KIND_SQL}
             THEN make_interval(secs => $SETTLE) ELSE interval '3 seconds' END)
       AND NOT (${backup.REGEN_KIND_SQL} AND COALESCE(d.is_current, true) = false)`;
}

/**
 * Atomically claim up to `limit` documents: transition each to IN_PROGRESS,
 * increment attempts, and stamp a fresh lease — all in ONE statement, BEFORE any
 * external call. FOR UPDATE SKIP LOCKED means N concurrent claimers never collide
 * and never head-of-line-block. Returns the claimed rows (id + legacy columns).
 */
async function claimBatch(limit = backup.DEFAULT_BATCH, { holder = _holderId, leaseMin = LEASE_MINUTES } = {}) {
  const sql = `
    WITH claimable AS (
      SELECT d.id FROM documents d
      WHERE ${claimableWhere()}
      ORDER BY d.sharepoint_backup_attempts ASC, d.created_at ASC
      LIMIT $LIM
      FOR UPDATE SKIP LOCKED
    )
    UPDATE documents d
    SET sharepoint_mirror_status    = 'IN_PROGRESS',
        sharepoint_backup_attempts  = d.sharepoint_backup_attempts + 1,
        sharepoint_lease_expires_at = now() + make_interval(mins => $LEASE),
        sharepoint_locked_by        = $HOLDER,
        sharepoint_backup_attempted_at = now()
    FROM claimable c WHERE d.id = c.id
    RETURNING d.id, d.sharepoint_backup_attempts AS attempts, d.sharepoint_permanent_strikes AS strikes`
    .replace('$LIM', '$1').replace('$LEASE', '$2').replace('$HOLDER', '$3')
    .replace(/\$MAXA/g, '$4').replace(/\$SETTLE/g, '$5');
  const { rows } = await db.query(sql, [limit, leaseMin, holder, backup.MAX_ATTEMPTS, backup.snapshotSettleSec()]);
  return rows;
}

/**
 * Read-only twin of the claim: the id-set the FSM WOULD claim right now, with no
 * state change. Used by shadowCompare to prove parity with the legacy selector.
 */
async function wouldClaimIds(limit = 10000) {
  const sql = `
    SELECT d.id FROM documents d
    WHERE ${claimableWhere()}
    ORDER BY d.sharepoint_backup_attempts ASC, d.created_at ASC
    LIMIT $1`
    .replace(/\$MAXA/g, '$2').replace(/\$SETTLE/g, '$3');
  const { rows } = await db.query(sql, [limit, backup.MAX_ATTEMPTS, backup.snapshotSettleSec()]);
  return rows.map((r) => String(r.id));
}

/**
 * Lease reaper: reclaim IN_PROGRESS rows whose worker died (lease expired). Below
 * the attempt cap → back to PENDING (retryable); at/above → DEAD(lease_exhausted).
 * Pure decision from decideOnLeaseExpiry(), applied in bulk.
 */
async function reapExpiredLeases({ maxAttempts = backup.MAX_ATTEMPTS } = {}) {
  const { rows } = await db.query(
    `UPDATE documents
        SET sharepoint_mirror_status = CASE WHEN sharepoint_backup_attempts >= $1 THEN 'DEAD' ELSE 'PENDING' END,
            sharepoint_dead_reason   = CASE WHEN sharepoint_backup_attempts >= $1 THEN 'lease_exhausted' END,
            sharepoint_next_attempt_at = now(),
            sharepoint_lease_expires_at = NULL,
            sharepoint_locked_by = NULL
      WHERE sharepoint_mirror_status = 'IN_PROGRESS'
        AND sharepoint_lease_expires_at < now()
      RETURNING id, sharepoint_mirror_status AS status`,
    [maxAttempts]);
  return rows;
}

/**
 * Persist the outcome of one claimed attempt. `decision` is what
 * decideAfterAttempt()/an adopt-resolution returns. Fenced on locked_by +
 * IN_PROGRESS so a row reclaimed out from under a slow worker is never clobbered.
 * Returns true if this worker still owned the row (the write landed).
 */
async function persistOutcome(id, holder, decision) {
  const d = decision || {};
  if (d.status === 'DONE') {
    const { rowCount } = await db.query(
      `UPDATE documents
          SET sharepoint_mirror_status='DONE', sharepoint_backed_up_at = COALESCE(sharepoint_backed_up_at, now()),
              sharepoint_lease_expires_at=NULL, sharepoint_locked_by=NULL,
              sharepoint_next_attempt_at=NULL, sharepoint_backup_error=NULL,
              sharepoint_permanent_strikes=0
        WHERE id=$1 AND sharepoint_locked_by=$2 AND sharepoint_mirror_status='IN_PROGRESS'`,
      [id, holder]);
    return rowCount > 0;
  }
  if (d.status === 'IN_PROGRESS') {
    // 409 awaiting provenance — keep the lease, just record the strike counter.
    const { rowCount } = await db.query(
      `UPDATE documents SET sharepoint_permanent_strikes=$3
        WHERE id=$1 AND sharepoint_locked_by=$2 AND sharepoint_mirror_status='IN_PROGRESS'`,
      [id, holder, d.permanentStrikes || 0]);
    return rowCount > 0;
  }
  const delayMs = Math.max(0, d.delayMs || 0);
  const { rowCount } = await db.query(
    `UPDATE documents
        SET sharepoint_mirror_status = $3,
            sharepoint_dead_reason   = $4,
            sharepoint_next_attempt_at = now() + make_interval(secs => $5),
            sharepoint_permanent_strikes = $6,
            sharepoint_lease_expires_at = NULL,
            sharepoint_locked_by = NULL,
            sharepoint_backup_error = COALESCE($7, sharepoint_backup_error)
      WHERE id=$1 AND sharepoint_locked_by=$2 AND sharepoint_mirror_status='IN_PROGRESS'`,
    [id, holder, d.status, d.deadReason || null, delayMs / 1000, d.permanentStrikes || 0, d.error || null]);
  return rowCount > 0;
}

// The derive CASE — the SQL twin of state.deriveStatus() and db/220's backfill.
// A DB-gated parity test asserts all three agree, so this duplication cannot rot.
// Built call-time (not at module load) so backup.MAX_ATTEMPTS is always resolved
// regardless of require order — no dependency on load sequencing.
function deriveStatusSql() {
  return `CASE
      WHEN sharepoint_backed_up_at   IS NOT NULL THEN 'DONE'
      WHEN sharepoint_skipped_reason IS NOT NULL THEN 'SKIPPED'
      WHEN COALESCE(sharepoint_backup_attempts, 0) >= ${backup.MAX_ATTEMPTS} THEN 'DEAD'
      WHEN COALESCE(sharepoint_backup_attempts, 0) > 0  THEN 'FAILED'
      ELSE 'PENDING' END`;
}

// How many stale rows one reconcile pass corrects. Bounds the UPDATE's lock
// footprint so the FIRST shadow pass on a large table can't hold row locks for
// long; fsmPass runs every drain cycle, so any backlog drains over a few passes.
const RECONCILE_BATCH = (() => {
  const v = parseInt(process.env.SHAREPOINT_MIRROR_RECONCILE_BATCH || '5000', 10);
  return Number.isFinite(v) && v > 0 ? v : 5000;
})();

/**
 * Dual-write reconcile: re-derive sharepoint_mirror_status from the legacy
 * columns for any row where the two disagree — so the status column tracks the
 * live worker's outcomes during shadow/rollout. Returns the number of rows
 * corrected. Invariants:
 *  • never touches an IN_PROGRESS row (an active FSM lease is authoritative);
 *  • NEVER resurrects a terminal DEAD: the legacy columns cannot represent a
 *    permanent/auth/path-collision DEAD set BELOW the attempt cap (they'd derive
 *    it back to a claimable FAILED and drop it from the dead-letter), so a DEAD
 *    row is only ever moved FORWARD to DONE/SKIPPED (legacy later mirrored or
 *    settled it) — never back to FAILED/PENDING. Requeue out of DEAD is a
 *    deliberate admin action, not an automatic re-derive;
 *  • bounded to RECONCILE_BATCH rows per call.
 */
async function reconcileStatus() {
  const derive = deriveStatusSql();
  const { rowCount } = await db.query(
    `UPDATE documents d
        SET sharepoint_mirror_status = (${derive}),
            sharepoint_dead_reason = CASE
              WHEN d.sharepoint_backed_up_at IS NULL AND d.sharepoint_skipped_reason IS NULL
               AND COALESCE(d.sharepoint_backup_attempts,0) >= ${backup.MAX_ATTEMPTS}
              THEN COALESCE(d.sharepoint_dead_reason,'transient_exhausted') ELSE d.sharepoint_dead_reason END
      WHERE d.id IN (
        SELECT id FROM documents
         WHERE sharepoint_mirror_status IS DISTINCT FROM (${derive})
           AND sharepoint_mirror_status IS DISTINCT FROM 'IN_PROGRESS'
           -- terminal DEAD never reverts to a claimable state (see invariant above).
           -- NULL-safe COALESCE: a bare status='DEAD' test is NULL for a not-yet-
           -- reconciled row (status NULL), making NOT(...) NULL and dropping that
           -- fresh row from reconcile entirely (the exact 3-valued-logic trap this
           -- project fixes). COALESCE(...,'') keeps it strictly TRUE/FALSE.
           AND NOT (COALESCE(sharepoint_mirror_status,'') = 'DEAD' AND (${derive}) IN ('FAILED','PENDING'))
         LIMIT ${RECONCILE_BATCH}
      )`);
  return rowCount;
}

/**
 * Shadow compare: prove the FSM claim set equals the legacy pendingBatch set.
 * Runs a reconcile first (so status is current), then diffs the id-sets and logs
 * any divergence. Returns { fsm, legacy, onlyFsm, onlyLegacy, agree }.
 */
async function shadowCompare({ log = true } = {}) {
  await reconcileStatus();
  const [fsmIds, legacyRows] = await Promise.all([
    wouldClaimIds(10000),
    backup.pendingBatch(10000),
  ]);
  const legacyIds = legacyRows.map((r) => String(r.id));
  const fsmSet = new Set(fsmIds), legacySet = new Set(legacyIds);
  // fsm-only is ALWAYS real divergence: the FSM must never invent work the legacy
  // drain wouldn't do. legacy-only is EXPECTED when the FSM legitimately holds the
  // row back: it's mid-flight (IN_PROGRESS lease), waiting out a backoff
  // (PENDING/FAILED with next_attempt_at in the future), or FSM-terminal
  // (DEAD/DONE/SKIPPED) — e.g. a below-cap DEAD the legacy drain would wrongly keep
  // retrying, which the FSM correctly refuses. A real FSM gating bug instead leaves
  // the row claimable-now (PENDING/FAILED, next_attempt_at <= now), which is NOT in
  // the expected set and still surfaces as unexpected divergence.
  const onlyFsm = fsmIds.filter((id) => !legacySet.has(id));
  const legacyOnly = legacyIds.filter((id) => !fsmSet.has(id));
  let expectedLegacyOnly = [];
  let unexpectedLegacyOnly = legacyOnly;
  if (legacyOnly.length) {
    const { rows } = await db.query(
      `SELECT id FROM documents
        WHERE id = ANY($1::uuid[])
          AND (sharepoint_mirror_status IN ('IN_PROGRESS','DEAD','DONE','SKIPPED')
               OR (sharepoint_mirror_status IN ('PENDING','FAILED') AND sharepoint_next_attempt_at > now()))`,
      [legacyOnly]);
    const expected = new Set(rows.map((r) => String(r.id)));
    expectedLegacyOnly = legacyOnly.filter((id) => expected.has(id));
    unexpectedLegacyOnly = legacyOnly.filter((id) => !expected.has(id));
  }
  const agree = onlyFsm.length === 0 && unexpectedLegacyOnly.length === 0;
  if (log && !agree) {
    console.warn(`[sp-fsm shadow] claim-set DIVERGENCE — fsm-only(invented): [${onlyFsm.slice(0, 20).join(',')}] legacy-only(unexpected): [${unexpectedLegacyOnly.slice(0, 20).join(',')}]`);
  } else if (log) {
    console.log(`[sp-fsm shadow] claim-set parity OK (${fsmIds.length} fsm-claimable; ${expectedLegacyOnly.length} legacy rows held for backoff/in-flight)`);
  }
  return { fsm: fsmIds.length, legacy: legacyIds.length, onlyFsm, expectedLegacyOnly, unexpectedLegacyOnly, agree };
}

/**
 * The per-pass FSM hook, called from the legacy runOnce when the flag is set.
 * shadow → reconcile + compare (read-only, legacy still uploads).
 * on     → (Phase 4) reap + claim + upload; not activated until cutover.
 * off    → never called.
 */
async function fsmPass() {
  const mode = fsmMode();
  if (mode === 'off') return { mode };
  // Crash-recovery lane runs in every active mode.
  let reaped = [];
  try { reaped = await reapExpiredLeases(); } catch (e) { console.warn('[sp-fsm] reaper error:', e.message); }
  if (mode === 'shadow') {
    const cmp = await shadowCompare().catch((e) => { console.warn('[sp-fsm] shadow error:', e.message); return null; });
    return { mode, reaped: reaped.length, shadow: cmp };
  }
  // mode === 'on' — reserved for Phase 4 cutover (claim + mirrorRow + persist).
  return { mode, reaped: reaped.length };
}

module.exports = {
  fsmMode, claimBatch, wouldClaimIds, reapExpiredLeases, persistOutcome,
  reconcileStatus, shadowCompare, fsmPass, deriveStatusSql,
  LEASE_MINUTES, _holderId,
};
