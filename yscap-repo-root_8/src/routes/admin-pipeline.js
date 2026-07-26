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
const { requireAuth, requireStaff } = require('../auth');
const adapters = require('../pipeline/provider-adapters');

router.use(requireAuth, requireStaff);

// Read-only snapshot of the Pipeline V2 switches (all booleans/strings, never a secret) so the
// health page shows which loans (if any) the new pipeline is running for. Everyone is on V1 by
// default; these stay off until the owner promotes a document family.
function flagSnapshot() {
  const p = cfg.pipeline || {};
  return {
    version: p.version || 'v1',
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

module.exports = router;
