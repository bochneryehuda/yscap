/**
 * Admin ClickUp Control Center API. Gated by requireAuth + platform_setup (same
 * capability that guards /integrations). Lets an admin validate + operate the
 * sync without a developer:
 *   GET  /health            — connection, switch state, per-state file counts
 *   POST /backfill {mode}   — dryrun (read-only validation) | data | full
 *   GET  /activity          — recent ClickUp sync activity (from audit_log)
 *   POST /file/:appId/repush / repull — force a single file both ways
 * The frontend Control Center screen renders on top of these.
 */
const router = require('../lib/safe-router')();
const db = require('../db');
const cfg = require('../config');
const { requireAuth, requirePermission } = require('../auth');
const sync = require('../sync/clickup-sync');
const orchestrator = require('../clickup/orchestrator');

router.use(requireAuth, requirePermission('platform_setup'));

router.get('/health', async (req, res) => {
  const out = {
    enabled: cfg.clickupSyncEnabled, tokenSet: !!cfg.clickupToken, webhookSecretSet: !!cfg.clickupWebhookSecret,
    teamId: cfg.clickupTeamId, pipelineSpace: cfg.clickupPipelineSpace, pollSec: cfg.clickupPollSec,
    counts: {}, inbox: {}, queue: {},
  };
  try {
    const a = await db.query(`SELECT sync_state, count(*)::int n FROM applications GROUP BY sync_state`);
    for (const r of a.rows) out.counts[r.sync_state] = r.n;
    const i = await db.query(`SELECT status, count(*)::int n FROM clickup_webhook_inbox GROUP BY status`);
    for (const r of i.rows) out.inbox[r.status] = r.n;
    const q = await db.query(`SELECT status, count(*)::int n FROM sync_queue WHERE target='clickup' GROUP BY status`);
    for (const r of q.rows) out.queue[r.status] = r.n;
    const bc = await db.query(`SELECT count(*)::int n FROM borrowers WHERE origin='clickup_backfill'`);
    out.backfilledBorrowers = bc.rows[0] ? bc.rows[0].n : 0;
    const ti = await db.query(`SELECT count(*)::int n FROM clickup_task_index`).catch(() => ({ rows: [{ n: 0 }] }));
    out.tasksIndexed = ti.rows[0] ? ti.rows[0].n : 0;
  } catch (e) { out.error = String(e.message); }
  res.json(out);
});

router.post('/backfill', async (req, res) => {
  const mode = (req.body && req.body.mode) || 'dryrun';
  if (!cfg.clickupToken) return res.status(400).json({ error: 'CLICKUP_API_TOKEN not set' });
  if (mode === 'dryrun') {
    try { return res.json({ mode, stats: await sync.dryRunBackfill({ samplePerFolder: Number(req.body?.sample) || 8 }) }); }
    catch (e) { return res.status(502).json({ error: String(e.message) }); }
  }
  // data = build the identity graph (no loan files); full = also materialize RTL files
  const createFiles = mode === 'full';
  sync.runBackfill({ createFiles }).then((n) => console.log('[backfill] ingested', n)).catch((e) => console.error('[backfill]', e.message));
  res.json({ mode, started: true, note: 'running in background; watch /activity + /health' });
});

// Materialize/refresh a specific pipeline folder (or all when folderId omitted),
// assigning loan officers. createFiles defaults true. Runs in the background.
router.post('/sync-folder', async (req, res) => {
  if (!cfg.clickupToken) return res.status(400).json({ error: 'CLICKUP_API_TOKEN not set' });
  const folderId = req.body && req.body.folderId ? String(req.body.folderId) : null;
  const createFiles = !(req.body && req.body.createFiles === false);
  sync.runBackfill({ createFiles, folders: folderId ? [folderId] : null })
    .then((n) => console.log('[sync-folder]', folderId || 'ALL', 'ingested', n))
    .catch((e) => console.error('[sync-folder]', e.message));
  res.json({ started: true, folderId: folderId || 'all', createFiles });
});

// Data-coverage / assignment / completeness audit (portal vs ClickUp).
router.get('/audit', async (req, res) => {
  try { res.json(await sync.auditData()); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});
// Deeper field-by-field diff (re-reads ClickUp; heavier).
router.get('/audit-diff', async (req, res) => {
  try { res.json(await sync.auditFieldDiff({ limit: Number(req.query.limit) || 120 })); }
  catch (e) { res.status(500).json({ error: String(e.message) }); }
});

router.get('/activity', async (req, res) => {
  const r = await db.query(
    `SELECT action, entity_type, entity_id, detail, created_at FROM audit_log
      WHERE entity_type='clickup' OR action LIKE 'clickup_%' ORDER BY id DESC LIMIT 200`);
  res.json({ rows: r.rows });
});

router.post('/file/:appId/repush', async (req, res) => {
  try { res.json(await orchestrator.pushApplication(req.params.appId, { force: true })); }
  catch (e) { res.status(502).json({ error: String(e.message) }); }
});

router.post('/file/:appId/repull', async (req, res) => {
  const r = await db.query(`SELECT clickup_pipeline_task_id t FROM applications WHERE id=$1`, [req.params.appId]);
  const taskId = r.rows[0] && r.rows[0].t;
  if (!taskId) return res.status(404).json({ error: 'no linked ClickUp task' });
  try { res.json(await sync.ingestOne(taskId)); }
  catch (e) { res.status(502).json({ error: String(e.message) }); }
});

module.exports = router;
