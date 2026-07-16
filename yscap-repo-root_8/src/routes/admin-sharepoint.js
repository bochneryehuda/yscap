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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
  }
});

// Force ONE document to re-mirror (fresh copy uploaded, ref re-pointed).
router.post('/doc/:id/remirror', async (req, res) => {
  try {
    if (!backup.enabled()) return res.status(409).json({ error: 'SharePoint sync is not enabled on this server' });
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
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
