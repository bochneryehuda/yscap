/**
 * Admin SharePoint Sync Control API (owner-directed 2026-07-15, the
 * corruption/versions incident). Gated like the ClickUp Control Center
 * (requireAuth + platform_setup). Lets an admin run the corrupted-mirror
 * audit + re-sync and see the mirror's health without a developer:
 *   GET  /health          — config probe, backlog, integrity buckets, last passes
 *   POST /verify          — start the full integrity audit + re-sync (background)
 *   POST /mirror          — kick a mirror drain (uploads anything pending)
 *   POST /doc/:id/remirror — force ONE document to re-mirror a fresh copy
 * Nothing here (or anywhere) deletes from SharePoint — corrupt copies are
 * replaced by newly-uploaded good copies and reported for manual cleanup.
 */
const router = require('../lib/safe-router')();
const db = require('../db');
const { requireAuth, requirePermission } = require('../auth');
const sp = require('../lib/sharepoint');
const backup = require('../lib/sharepoint-backup');

router.use(requireAuth, requirePermission('platform_setup'));

async function audit(req, action, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,ip_address,user_agent,detail)
       VALUES ('staff',$1,$2,'sharepoint_sync',NULL,$3,$4,$5::jsonb)`,
      [req.actor.id, action, req.ip, req.get('user-agent') || null, JSON.stringify(detail || {})]);
  } catch (_) { /* audit best-effort */ }
}

router.get('/health', async (req, res) => {
  try {
    const [probe, counts, integrity] = await Promise.all([
      sp.probe(),
      db.query(`SELECT
          count(*) FILTER (WHERE sharepoint_backup_ref IS NOT NULL)                                        ::int AS mirrored,
          count(*) FILTER (WHERE sharepoint_backed_up_at IS NULL AND storage_ref IS NOT NULL)              ::int AS pending,
          count(*) FILTER (WHERE sharepoint_backed_up_at IS NULL AND sharepoint_backup_attempts >= ${backup.MAX_ATTEMPTS}) ::int AS exhausted,
          count(*) FILTER (WHERE sharepoint_skipped_reason IS NOT NULL)                                    ::int AS skipped,
          count(*) FILTER (WHERE sharepoint_backup_ref IS NOT NULL AND sharepoint_verified_at IS NULL)     ::int AS unverified
        FROM documents`),
      db.query(`SELECT COALESCE(sharepoint_integrity,'(never audited)') AS verdict, count(*)::int AS n
                  FROM documents WHERE sharepoint_backup_ref IS NOT NULL
                 GROUP BY 1 ORDER BY n DESC`),
    ]);
    res.json({ ok: true, probe, sync: backup.health(), backlog: counts.rows[0], integrity: integrity.rows });
  } catch (e) {
    console.warn('[admin-sharepoint] handler error:', db.describeError(e));
    res.status(500).json({ error: 'server error' });
  }
});

// R3 — chain-of-custody reconciliation: the single, auditable proof that the
// mirror is whole (every document classified, oldest-pending age, SLO verdict).
router.get('/reconciliation', async (req, res) => {
  try {
    const recon = await backup.reconciliation();
    // Name the actual stuck documents (identity + real reason) so the report is
    // interpretable — the SLO alert points here.
    const stuck = await backup.stuckDocuments(50).catch(() => []);
    await audit(req, 'sharepoint_reconciliation_viewed', { healthy: recon.healthy, stuck: stuck.length });
    res.json({ ok: true, ...recon, stuck });
  } catch (e) {
    console.warn('[admin-sharepoint] handler error:', db.describeError(e));
    res.status(500).json({ error: 'server error' });
  }
});

// Force the stuck-document escalation now (settle phantoms, card the rest) —
// the same pass the SLO watchdog runs, on demand from the admin screen.
router.post('/escalate-stuck', async (req, res) => {
  try {
    if (!backup.enabled()) return res.status(409).json({ error: 'SharePoint sync is not enabled on this server' });
    // Fire-and-forget (like /verify and /mirror): escalation can force-attempt up
    // to 50 docs (~90s each) — never hold the HTTP request open for minutes, and
    // never race a concurrent drain synchronously from a blocking handler
    // (A-Z audit C1). Progress shows on GET /reconciliation.
    backup.escalateStuckDocs()
      .then((result) => audit(req, 'sharepoint_escalate_stuck', result))
      .catch((e) => console.warn('[sp-sync] escalate-stuck (admin) error:', e.message));
    res.json({ ok: true, started: true });
  } catch (e) {
    console.warn('[admin-sharepoint] handler error:', db.describeError(e));
    res.status(500).json({ error: 'server error' });
  }
});

// Start the full corrupted-mirror audit (+ automatic re-sync of anything that
// fails it). Runs in the background; progress shows on GET /health.
router.post('/verify', async (req, res) => {
  try {
    if (!backup.enabled()) return res.status(409).json({ error: 'SharePoint sync is not enabled on this server' });
    const pending = (await db.query(
      `SELECT count(*)::int AS n FROM documents
        WHERE sharepoint_backup_ref IS NOT NULL
          AND (sharepoint_verified_at IS NULL
               OR sharepoint_verified_at < now() - make_interval(days => ${backup.VERIFY_RECHECK_DAYS}))`)).rows[0].n;
    backup.drainVerify().catch(() => {});
    await audit(req, 'sharepoint_verify_started', { pending });
    res.json({ ok: true, started: true, toVerify: pending });
  } catch (e) {
    console.warn('[admin-sharepoint] handler error:', db.describeError(e));
    res.status(500).json({ error: 'server error' });
  }
});

// Kick a mirror drain (uploads anything pending — including good copies queued
// by the audit to replace corrupt mirrors).
router.post('/mirror', async (req, res) => {
  try {
    if (!backup.enabled()) return res.status(409).json({ error: 'SharePoint sync is not enabled on this server' });
    backup.drain().catch(() => {});
    await audit(req, 'sharepoint_mirror_kicked', {});
    res.json({ ok: true, started: true });
  } catch (e) {
    console.warn('[admin-sharepoint] handler error:', db.describeError(e));
    res.status(500).json({ error: 'server error' });
  }
});

// Bulk: re-arm EVERY exhausted pending document and kick a drain — one click
// to re-drive the whole "failed after every retry" review queue after the
// underlying cause is fixed (e.g. a deploy shipping a sync fix). Documents
// re-run through every normal rule; successes auto-close their review rows.
router.post('/retry-exhausted', async (req, res) => {
  try {
    if (!backup.enabled()) return res.status(409).json({ error: 'SharePoint sync is not enabled on this server' });
    const r = await db.query(
      `UPDATE documents SET sharepoint_backup_attempts = 0, sharepoint_backup_error = NULL
        WHERE sharepoint_backed_up_at IS NULL AND storage_ref IS NOT NULL
          AND sharepoint_backup_attempts >= ${backup.MAX_ATTEMPTS}
        RETURNING id`);
    backup.kick();
    await audit(req, 'sharepoint_retry_exhausted', { requeued: r.rowCount });
    res.json({ ok: true, requeued: r.rowCount });
  } catch (e) {
    console.warn('[admin-sharepoint] handler error:', db.describeError(e));
    res.status(500).json({ error: 'server error' });
  }
});

// ---- State-machine (FSM) observability + dead-letter (Phase 3) --------------
// Reads the explicit per-document mirror_status. Safe regardless of the
// SHAREPOINT_MIRROR_FSM flag: the columns exist and are backfilled since Phase 1,
// so the dashboard shows real state even before the FSM worker is enabled.
const queue = require('../lib/sp-mirror-queue');

// The correct-alerting dashboard: per-state counts, the dead-letter and
// orphaned-lease counts (page-worthy), the dead-letter list (what the owner
// manually reviews) and the leaked-lease list.
router.get('/fsm', async (req, res) => {
  try {
    const [snapshot, deadLetter, expiredLeases] = await Promise.all([
      queue.healthSnapshot(),
      queue.deadLetterList(100),
      queue.expiredLeaseList(100),
    ]);
    res.json({ ok: true, mode: queue.fsmMode(), snapshot, deadLetter, expiredLeases });
  } catch (e) {
    console.warn('[admin-sharepoint] handler error:', db.describeError(e));
    res.status(500).json({ error: 'server error' });
  }
});

// One-click requeue a dead-letter document (DEAD → PENDING, re-arms legacy too).
// The Sync-review card auto-closes when it mirrors. Kicks a drain so it retries now.
router.post('/fsm/doc/:id/requeue', async (req, res) => {
  try {
    if (!UUID_RE.test(String(req.params.id || ''))) return res.status(400).json({ error: 'invalid document id' });
    const row = await queue.requeueDead(req.params.id);
    if (!row) return res.status(404).json({ error: 'no dead-letter document with that id' });
    try { backup.kick(); } catch (_) {}
    await audit(req, 'sharepoint_fsm_requeue', { documentId: row.id, filename: row.filename });
    res.json({ ok: true, documentId: row.id });
  } catch (e) {
    console.warn('[admin-sharepoint] handler error:', db.describeError(e));
    res.status(500).json({ error: 'server error' });
  }
});

// Force ONE document to re-mirror (fresh copy uploaded, ref re-pointed).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.post('/doc/:id/remirror', async (req, res) => {
  try {
    if (!backup.enabled()) return res.status(409).json({ error: 'SharePoint sync is not enabled on this server' });
    // Validate the id shape so a malformed :id returns a clean 400 instead of a
    // 500 leaking the raw Postgres "invalid input syntax for uuid" (A-Z audit C2).
    if (!UUID_RE.test(String(req.params.id || ''))) return res.status(400).json({ error: 'invalid document id' });
    const r = await db.query(
      `UPDATE documents SET
          sharepoint_backed_up_at = NULL,
          sharepoint_backup_attempts = 0,
          sharepoint_backup_error = 'admin: manual re-mirror requested',
          sharepoint_skipped_reason = NULL
        WHERE id = $1 AND storage_ref IS NOT NULL
        RETURNING id, filename`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'document not found (or it has no stored bytes)' });
    backup.kick();
    await audit(req, 'sharepoint_doc_remirror', { documentId: req.params.id, filename: r.rows[0].filename });
    res.json({ ok: true, documentId: r.rows[0].id });
  } catch (e) {
    console.warn('[admin-sharepoint] handler error:', db.describeError(e));
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
