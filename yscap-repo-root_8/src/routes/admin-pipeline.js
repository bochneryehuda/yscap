'use strict';
/**
 * Admin "Pipeline V2 health" API (owner-directed 2026-07-26; Phase 1e).
 *
 * A LIVE reachability check for every document/AI vendor the new evidence-first pipeline
 * reaches through the Layer-2 DocumentProvider adapter contract — so the owner can PROVE each
 * vendor key actually works the moment it's entered in Render (the difference between "a key is
 * typed in" and "the key really connects"). This complements the config-only AI stack tile.
 *
 *   GET /health — probe every real adapter's healthCheck() concurrently; returns per-vendor
 *                 { provider, service, name, role, configured, model, ok, latencyMs, detail }
 *                 plus the current pipeline feature-flag snapshot.
 *
 * SECURITY: reports config PRESENCE (booleans), model/deployment NAMES, and reachability only.
 * It never returns, accepts, or logs a secret value; keys are set/rotated in Render, never here.
 * Every probe is independently time-boxed + non-throwing (the adapter contract guarantees it).
 */
const router = require('../lib/safe-router')();
const cfg = require('../config');
const { requireAuth, requireStaff, requirePermission } = require('../auth');
const adapters = require('../pipeline/provider-adapters');

router.use(requireAuth, requireStaff);

// Read-only snapshot of the Pipeline V2 switches (all booleans/strings, never a secret) so the
// health page shows which loans (if any) the new pipeline is running for. Everyone is on V1 by
// default; these stay off until the owner promotes a document family.
function flagSnapshot() {
  const p = cfg.pipeline || {};
  return {
    v2Enabled: !!p.v2Enabled,
    v2Shadow: !!p.v2Shadow,
    v2Families: Array.isArray(p.v2Families) ? p.v2Families : [],
    workerEnabled: !!p.workerEnabled,
    workerConcurrency: p.workerConcurrency,
    jobMaxAttempts: p.jobMaxAttempts,
    jobLeaseSeconds: p.jobLeaseSeconds,
  };
}

// GET /health — live per-vendor reachability. Never throws (the adapter contract times + catches
// every probe); a total failure still returns a shaped, empty-ish report rather than a 500.
router.get('/health', async (_req, res) => {
  try {
    const report = await adapters.healthReport(() => new Date().toISOString());
    return res.json({ flags: flagSnapshot(), ...report });
  } catch (e) {
    console.warn('[admin-pipeline] health error:', (e && e.message) || e);
    return res.json({ flags: flagSnapshot(), checkedAt: new Date().toISOString(), providers: [], healthy: 0, total: 0, configured: 0 });
  }
});

// ── Un-funded re-read sweep (owner decision 2026-07-27) ─────────────────────────────────
// The re-read of every alive, not-yet-funded file so the findings-cleanup reader fixes reach
// files that were already analysed. GET is a read-only progress view; POST kicks one slice NOW
// (the dispatcher already runs it every tick, this just runs it on demand). The POST spends real
// vendor money, so it is gated tighter — platform_setup, like the other paid ops triggers.
router.get('/reread-sweep', async (_req, res) => {
  try { return res.json(await require('../lib/underwriting/reread-sweep').status()); }
  catch (e) { console.warn('[admin-pipeline] reread-sweep status:', (e && e.message) || e); return res.status(500).json({ error: 'server error' }); }
});
router.post('/reread-sweep', requirePermission('platform_setup'), async (req, res) => {
  const sweep = require('../lib/underwriting/reread-sweep');
  // Fire-and-report: run one bounded slice in the background so the request returns immediately
  // (a slice can make several paid reads). Safe against a double click / an overlap with the
  // dispatcher tick: the sweep holds an in-process guard and no-ops ('already_running') if a slice
  // is already underway, and the per-file generation stamp keeps a completed file from being
  // re-billed. `batchFiles` is optional; the module clamps it to a sane floor.
  const batchFiles = Number(req.body && req.body.batchFiles) || undefined;
  sweep.sweepOnce({ batchFiles })
    .then((r) => console.log('[reread-sweep] admin kick', JSON.stringify(r)))
    .catch((e) => console.error('[reread-sweep] admin kick', e && e.message));
  try { return res.json({ started: true, ...(await sweep.status()) }); }
  catch (_) { return res.json({ started: true }); }
});

// ── Shadow comparison (Phase 2, owner-directed 2026-07-26) ──────────────────────────────
// A read-only view of what the new (V2) pipeline did to each document it processed in SHADOW,
// so an admin can compare V2 vs the current V1 read BEFORE promoting a document family. Reads
// ONLY the additive V2 tables; exposes no V2 underwriting DECISION and no borrower PII. Never 500s.
const shadowReport = require('../pipeline/shadow-report');
const db = require('../db');

// GET /shadow — most recent shadow jobs (optionally ?loanId=...&limit=...), each with its stage
// manifest progress + the routing decision that was recorded.
router.get('/shadow', async (req, res) => {
  try {
    const report = await shadowReport.listShadowJobs(db, { limit: req.query.limit, loanId: req.query.loanId || null });
    const summary = await shadowReport.shadowSummary(db);
    return res.json({ flags: flagSnapshot(), summary, ...report });
  } catch (e) {
    console.warn('[admin-pipeline] shadow list error:', (e && e.message) || e);
    return res.json({ flags: flagSnapshot(), summary: { total: 0, byFamily: [], byStatus: [] }, jobs: [] });
  }
});

// GET /shadow/:jobId — full detail for one shadow job: the stage manifest + every routing decision.
router.get('/shadow/:jobId', async (req, res) => {
  try {
    const detail = await shadowReport.shadowJobDetail(db, req.params.jobId);
    if (!detail) return res.status(404).json({ error: 'not found' });
    return res.json(detail);
  } catch (e) {
    console.warn('[admin-pipeline] shadow detail error:', (e && e.message) || e);
    return res.status(404).json({ error: 'not found' });
  }
});

module.exports = router;
