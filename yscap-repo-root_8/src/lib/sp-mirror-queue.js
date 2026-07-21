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
  // A budget-NEUTRAL outcome (throttle 429, benign 412/416) must NOT consume the
  // retry budget: claimBatch already incremented attempts at claim, so roll that
  // one back here. Otherwise a sustained throttling episode (exactly when many
  // docs are queued) would drive good documents to attempts>=MAX and dead-letter
  // them — the opposite of "honor Retry-After indefinitely". GREATEST(0,…) guards
  // against ever going negative.
  const undoAttempt = (d.countsAttempt === false) ? 1 : 0;
  const { rowCount } = await db.query(
    `UPDATE documents
        SET sharepoint_mirror_status = $3,
            sharepoint_dead_reason   = $4,
            sharepoint_next_attempt_at = now() + make_interval(secs => $5),
            sharepoint_permanent_strikes = $6,
            sharepoint_lease_expires_at = NULL,
            sharepoint_locked_by = NULL,
            sharepoint_backup_attempts = GREATEST(0, sharepoint_backup_attempts - $8),
            sharepoint_backup_error = COALESCE($7, sharepoint_backup_error)
      WHERE id=$1 AND sharepoint_locked_by=$2 AND sharepoint_mirror_status='IN_PROGRESS'`,
    [id, holder, d.status, d.deadReason || null, delayMs / 1000, d.permanentStrikes || 0, d.error || null, undoAttempt]);
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
              THEN COALESCE(d.sharepoint_dead_reason,'transient_exhausted')
              ELSE NULL END   -- non-DEAD derived status carries no dead_reason (clears a healed row's stale one)
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

// ---------------------------------------------------------- cutover drain (P4)
const MIRROR_TIMEOUT_MS = 600000;   // 10 min — matches the legacy per-attempt cap
const PACING_MS = 300;              // polite gap between Graph uploads
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 'on'-mode drain (Phase 4 cutover): claim a batch and, for each claimed row,
 * perform the ACTUAL upload via the existing mirrorRow() — so every owner-directed
 * upload behavior (Version-N folders, dedup/adopt, integrity, one-way/no-delete)
 * is preserved verbatim — then persist the outcome from the pure decision.
 * claim-before-work already stamped IN_PROGRESS + attempts++ + lease, so a crash
 * anywhere here leaves an expired lease the reaper reclaims — never a silent NULL.
 * Never throws for one document. Returns { claimed, mirrored, failed }.
 */
async function drainClaimed(limit = backup.DEFAULT_BATCH, { holder = _holderId } = {}) {
  const claimed = await claimBatch(limit, { holder });
  let mirrored = 0, failed = 0;
  for (const c of claimed) {
    let row, enrichThrew = false;
    try { row = await backup.enrichedRowById(c.id); } catch (_) { enrichThrew = true; row = null; }
    if (enrichThrew) {
      // A THROWN error on the pre-mirror SELECT is a transient DB blip, NOT a
      // deleted document — treat it as a retryable transient (FAILED+backoff, DEAD
      // only at the cap), never a permanent document_gone. Distinct from the
      // genuine 0-row case below.
      const decision = state.decideAfterAttempt(503, {}, Number(c.attempts || 0), Number(c.strikes || 0));
      decision.error = 'transient: could not load document row for mirroring (will retry)';
      await persistOutcome(c.id, holder, decision).catch(() => {});
      failed++;
      continue;
    }
    if (!row) {
      // Genuine 0-row result: the document row really is gone — terminal.
      await persistOutcome(c.id, holder, { status: 'DEAD', deadReason: 'document_gone', error: 'document row no longer exists' }).catch(() => {});
      continue;
    }
    try {
      await backup.withTimeout(backup.mirrorRow(row), MIRROR_TIMEOUT_MS,
        'mirror attempt timed out (a Graph or database call stalled)');
      await persistOutcome(c.id, holder, { status: 'DONE' });
      mirrored++;
    } catch (e) {
      failed++;
      // Map the legacy error classification onto the pure state decision. A
      // representative HTTP status carries the class into decideAfterAttempt when
      // the thrown error has no real e.status (mirrorRow's own 409/adopt handling
      // means a genuine conflict rarely propagates here).
      const v = backup.classifyMirrorError(String((e && e.message) || e));
      const status = (e && e.status) || ({ throttle: 429, permanent: 400, transient: 503 })[v.class] || null;
      const attempts = Number(c.attempts || 0);
      const strikes = Number(c.strikes || 0);
      const decision = state.decideAfterAttempt(status, (e && e.headers) || {}, attempts, strikes);
      decision.error = `[${v.class}] ${v.cause || ''} · ${String((e && e.message) || e)}`.slice(0, 500);
      await persistOutcome(c.id, holder, decision).catch(() => {});
    }
    await sleep(PACING_MS);
  }
  if (claimed.length) console.log(`[sp-fsm] on-drain: claimed ${claimed.length}, mirrored ${mirrored}, failed ${failed}`);
  return { claimed: claimed.length, mirrored, failed };
}

// ---------------------------------------------------------- observability (P3)

/**
 * One-query health snapshot for the admin dashboard + alerting. Counts per
 * state, the dead-letter and orphaned-lease counts (the things to alert on),
 * oldest CLAIMABLE age (a secondary drain-rate signal — NOT oldest-overall,
 * which would wrongly include in-progress/dead rows), attempt distribution, and
 * a 5-minute DONE throughput. This is the correct-alerting query from the design:
 * page on DEAD/orphaned-lease (won't self-heal), warn on age.
 */
async function healthSnapshot() {
  const { rows } = await db.query(
    `SELECT
       count(*) FILTER (WHERE sharepoint_mirror_status='PENDING')::int      AS pending,
       count(*) FILTER (WHERE sharepoint_mirror_status='IN_PROGRESS')::int  AS in_progress,
       count(*) FILTER (WHERE sharepoint_mirror_status='FAILED')::int       AS failed,
       count(*) FILTER (WHERE sharepoint_mirror_status='DONE')::int         AS done,
       count(*) FILTER (WHERE sharepoint_mirror_status='DEAD')::int         AS dead,
       count(*) FILTER (WHERE sharepoint_mirror_status='SKIPPED')::int      AS skipped,
       count(*) FILTER (WHERE sharepoint_mirror_status IS NULL)::int        AS unreconciled,
       count(*) FILTER (WHERE sharepoint_mirror_status='IN_PROGRESS'
                          AND sharepoint_lease_expires_at < now())::int     AS orphaned_leases,
       COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at)
         FILTER (WHERE sharepoint_mirror_status IN ('PENDING','FAILED'))))::int, 0) AS oldest_claimable_secs,
       COALESCE(max(sharepoint_backup_attempts)
         FILTER (WHERE sharepoint_mirror_status IN ('PENDING','FAILED','IN_PROGRESS')), 0)::int AS max_attempts,
       count(*) FILTER (WHERE sharepoint_mirror_status='DONE'
                          AND sharepoint_backed_up_at > now() - interval '5 minutes')::int AS done_last_5m
     FROM documents`);
  return rows[0];
}

/** Dead-letter contents for the runbook / dashboard — what died and why. */
async function deadLetterList(limit = 100) {
  const { rows } = await db.query(
    `SELECT id, filename, doc_kind, sharepoint_dead_reason AS dead_reason,
            sharepoint_backup_attempts AS attempts, sharepoint_backup_error AS error,
            round(EXTRACT(EPOCH FROM (now() - created_at)) / 3600.0, 1) AS age_hours
       FROM documents WHERE sharepoint_mirror_status='DEAD'
      ORDER BY created_at ASC LIMIT $1`, [limit]);
  return rows;
}

/** Leases that leaked (a worker died mid-flight) — the other page-worthy signal. */
async function expiredLeaseList(limit = 100) {
  const { rows } = await db.query(
    `SELECT id, filename, sharepoint_locked_by AS locked_by, sharepoint_backup_attempts AS attempts,
            EXTRACT(EPOCH FROM (now() - sharepoint_lease_expires_at))::int AS overdue_secs
       FROM documents WHERE sharepoint_mirror_status='IN_PROGRESS' AND sharepoint_lease_expires_at < now()
      ORDER BY sharepoint_lease_expires_at ASC LIMIT $1`, [limit]);
  return rows;
}

/**
 * Admin requeue of a dead-letter document: DEAD → PENDING and re-arm the LEGACY
 * columns too (attempts=0, error cleared), so both the FSM claim and the legacy
 * drain re-attempt it. The Sync-review card auto-closes when it mirrors. Only a
 * DEAD row can be requeued (a deliberate admin action out of the terminal state —
 * reconcile never does this automatically). Returns the row or null.
 */
async function requeueDead(id) {
  const { rows } = await db.query(
    `UPDATE documents SET
        sharepoint_mirror_status='PENDING', sharepoint_dead_reason=NULL,
        sharepoint_next_attempt_at=now(), sharepoint_permanent_strikes=0,
        sharepoint_lease_expires_at=NULL, sharepoint_locked_by=NULL,
        sharepoint_backup_attempts=0, sharepoint_backup_error=NULL
      WHERE id=$1 AND sharepoint_mirror_status='DEAD'
      RETURNING id, filename`, [id]);
  return rows[0] || null;
}

/**
 * OWNER REQUIREMENT — the manual-review safety net must survive the state
 * machine: every DEAD document (the dead-letter) gets a Sync-review card so a
 * human reviews anything that has gone wrong, exactly like the legacy
 * recordFailure/escalateStuckDocs path. Feeds the SAME sync_review_queue surface
 * (field_key 'sharepoint_doc', task_id 'spdoc:<id>', reason
 * 'sharepoint_mirror_failed'); queueReview dedups per doc so this is idempotent
 * and never double-cards. This is the belt to the legacy suspenders in shadow,
 * and becomes the PRIMARY carder at cutover (when the FSM, not recordFailure,
 * decides DEAD). Returns how many new cards were opened.
 */
async function cardDeadLetter(limit = 200) {
  const { rows } = await db.query(
    `SELECT d.id, d.filename, d.doc_kind, ci.label AS item_label, d.slot_label,
            d.sharepoint_dead_reason AS dead_reason, d.sharepoint_backup_attempts AS attempts,
            d.sharepoint_backup_error AS error,
            COALESCE(d.application_id, ci.application_id)                         AS app_id,
            COALESCE(d.borrower_id, ci.borrower_id, l.borrower_id, a.borrower_id) AS borrower_id
       FROM documents d
       LEFT JOIN checklist_items ci ON ci.id = d.checklist_item_id
       LEFT JOIN llcs l             ON l.id = COALESCE(d.llc_id, ci.llc_id)
       LEFT JOIN applications a     ON a.id = COALESCE(d.application_id, ci.application_id)
      WHERE d.sharepoint_mirror_status='DEAD'
        -- A DEAD row that actually has backed_up_at set is a RACED SUCCESS (the
        -- upload landed but the lease had expired so the fenced DONE write no-oped);
        -- it is not a real dead-letter — the next reconcile flips it to DONE. Never
        -- card it (would be a spurious manual-review card + false alarm).
        AND d.sharepoint_backed_up_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM sync_review_queue q
                         WHERE q.task_id = 'spdoc:' || d.id::text
                           AND q.field_key='sharepoint_doc' AND q.status='open')
      LIMIT $1`, [limit]);
  let carded = 0;
  for (const d of rows) {
    try {
      await require('./sync-review').queueReview({
        applicationId: d.app_id || null, borrowerId: d.borrower_id || null,
        taskId: `spdoc:${d.id}`, direction: 'outbound', fieldKey: 'sharepoint_doc',
        reason: 'sharepoint_mirror_failed', suppressIfRejected: true, clickupValue: null,
        portalValue: `${d.filename || 'document'} — ${d.item_label || d.slot_label || d.doc_kind || 'file'}`.slice(0, 300),
        rawValue: JSON.stringify({ docId: d.id, attempts: d.attempts, deadReason: d.dead_reason,
          error: String(d.error || d.dead_reason || 'permanently failed').slice(0, 280), deadLetter: true }).slice(0, 500),
      });
      carded++;
    } catch (_) { /* visibility is best-effort — never breaks a pass */ }
  }
  if (carded) console.log(`[sp-fsm] carded ${carded} dead-letter document(s) for manual Sync review`);
  return carded;
}

/**
 * Correct alerting: the dead-letter and orphaned leases are what never self-heal,
 * so those are the page-worthy signals (not backlog age). Deduped per distinct
 * episode via the shared restart-proof alert lock (sp-fsm-dead-alert), so a
 * redeploy while the dead-letter is non-empty does NOT re-email. To avoid
 * doubling the legacy backlog-age SLO email during shadow rollout, an email is
 * only sent in 'on' mode; in shadow it logs + relies on the Sync-review cards
 * (cardDeadLetter) for visibility. Returns the snapshot + whether it alerted.
 */
async function checkDeadLetterAlert() {
  const snap = await healthSnapshot();
  const dead = snap.dead || 0, orphaned = snap.orphaned_leases || 0;
  if (dead === 0 && orphaned === 0) {
    try { await backup.clearAlert('sp-fsm-dead-alert'); } catch (_) {}
    return { alerted: false, ...snap };
  }
  // ONE alert per episode: a STABLE signature while the dead-letter is non-empty
  // (which kind is present, not the exact count) so a fluctuating count does NOT
  // re-fire every pass — the owner's hard "no repeat emails" rule. clearAlert()
  // above resets the lock the moment it empties, so a genuinely NEW later episode
  // re-alerts. Exact counts live in the admin dashboard + the log line.
  const signature = `dead:${dead > 0}|orphaned:${orphaned > 0}`;
  let firstThisEpisode = true;
  try { firstThisEpisode = await backup.claimAlert('sp-fsm-dead-alert', signature, 60); } catch (_) {}
  if (firstThisEpisode) {
    // In shadow, cardDeadLetter already surfaces each doc in Sync review and the
    // legacy backlog-age SLO still emails — so we log here (no duplicate email).
    // The dedicated dead-letter email channel is turned on at Phase-4 cutover,
    // when it replaces the legacy backlog-age alert.
    console.warn(`[sp-fsm] DEAD-LETTER alert (${fsmMode()}): ${dead} dead, ${orphaned} orphaned lease(s) — admin → SharePoint → dead-letter`);
  }
  return { alerted: firstThisEpisode, ...snap };
}

/**
 * The per-pass FSM hook, called from the legacy runOnce when the flag is set.
 * shadow → reap + reconcile/compare (read-only mirroring; legacy still uploads)
 *          + card every dead-letter doc for manual review + dead-letter alert.
 * on     → (Phase 4) reap + claim + upload; carding/alerting; not wired until cutover.
 * off    → never called.
 */
async function fsmPass() {
  const mode = fsmMode();
  if (mode === 'off') return { mode };
  // Crash-recovery lane runs in every active mode.
  let reaped = [];
  try { reaped = await reapExpiredLeases(); } catch (e) { console.warn('[sp-fsm] reaper error:', e.message); }
  let cmp = null, drain = null;
  if (mode === 'shadow') {
    cmp = await shadowCompare().catch((e) => { console.warn('[sp-fsm] shadow error:', e.message); return null; });
  } else if (mode === 'on') {
    // Cutover: the FSM does the actual uploads (runOnce skips its legacy loop
    // when on). Reconcile first so status tracks any legacy settle stamps.
    try { await reconcileStatus(); } catch (e) { console.warn('[sp-fsm] reconcile error:', e.message); }
    drain = await drainClaimed().catch((e) => { console.warn('[sp-fsm] on-drain error:', e.message); return null; });
    // Heal any raced success (backed_up_at set by the unfenced upload write while
    // the reaper had reclaimed the row → transiently DEAD) to DONE BEFORE carding/
    // alerting below, so a successfully-mirrored doc is never spuriously carded.
    try { await reconcileStatus(); } catch (e) { console.warn('[sp-fsm] post-drain reconcile error:', e.message); }
  }
  // OWNER REQUIREMENT: every dead-letter doc gets a manual-review card. Best-effort.
  let carded = 0;
  try { carded = await cardDeadLetter(); } catch (e) { console.warn('[sp-fsm] dead-letter card error:', e.message); }
  let alert = null;
  try { alert = await checkDeadLetterAlert(); } catch (e) { console.warn('[sp-fsm] dead-letter alert error:', e.message); }
  return { mode, reaped: reaped.length, shadow: cmp, drain, carded, dead: alert && alert.dead };
}

module.exports = {
  fsmMode, claimBatch, wouldClaimIds, reapExpiredLeases, persistOutcome,
  reconcileStatus, shadowCompare, fsmPass, deriveStatusSql, drainClaimed,
  healthSnapshot, deadLetterList, expiredLeaseList, requeueDead,
  cardDeadLetter, checkDeadLetterAlert,
  LEASE_MINUTES, _holderId,
};
