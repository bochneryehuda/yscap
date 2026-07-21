'use strict';
/**
 * Admin "API Health" API — the read-only status of every external API / integration the platform
 * uses, for the API Health admin page. Gated by requireAuth + platform_setup (the same capability
 * that guards the ClickUp / SharePoint control centers). Backed entirely by the health registry
 * (src/lib/integrations/health-registry.js), so a new integration added there appears here with no
 * route change.
 *
 *   GET  /health          — probe every integration (config presence + a live reach where cheap/safe)
 *   POST /:key/test       — re-probe ONE integration (the "Test now" button)
 *
 * SECURITY: reports config PRESENCE + reachability only. It never returns, accepts, or logs a secret
 * value; keys are set/rotated in the hosting dashboard (Render env), never through this API.
 */
const router = require('../lib/safe-router')();
const db = require('../db');
const { requireAuth, requirePermission } = require('../auth');
const health = require('../lib/integrations/health-registry');

router.use(requireAuth, requirePermission('platform_setup'));

const fail = (res, code, e, msg) => {
  console.warn('[admin-integrations] handler error:', db.describeError ? db.describeError(e) : (e && e.message));
  return res.status(code).json({ error: msg });
};

// Every integration's live status. Each probe is independently time-boxed + non-throwing, so this
// never hangs and a single down service can't fail the whole page.
router.get('/health', async (req, res) => {
  try {
    const integrations = await health.probeAll();
    res.json({ checkedAt: new Date().toISOString(), integrations });
  } catch (e) { return fail(res, 500, e, 'could not read integration health'); }
});

// Re-test a single integration (the per-card "Test now" button).
router.post('/:key/test', async (req, res) => {
  try {
    const one = await health.probeOne(req.params.key);
    if (!one) return res.status(404).json({ error: 'unknown integration' });
    res.json({ checkedAt: new Date().toISOString(), integration: one });
  } catch (e) { return fail(res, 500, e, 'could not test that integration'); }
});

// Sitewire TEST-environment capability explorer (READ-ONLY field discovery). super_admin only —
// it reaches a live external system to enumerate every field/button Sitewire exposes so new
// integrations can be built on CONFIRMED field names (never-guess). It cannot write (the underlying
// module is GET-only) and uses a SEPARATE test credential set (SITEWIRE_TEST_*), never the prod
// creds. Values are redacted; only field names, types, and non-PII enum values are returned.
router.post('/sitewire/explore', async (req, res) => {
  if (req.actor.role !== 'super_admin') return res.status(403).json({ error: 'super_admin only' });
  try {
    const explorer = require('../sitewire/test-explorer');
    if (!explorer.testConfigured()) {
      return res.status(400).json({
        error: 'test_creds_missing',
        message: 'Set SITEWIRE_TEST_ACCESS_TOKEN, SITEWIRE_TEST_CLIENT, SITEWIRE_TEST_UID (and SITEWIRE_TEST_BASE_URL ' +
          'if the test system uses a different address) in Render, then run again. Never paste the key here.',
      });
    }
    const sampleProperties = Math.min(20, Math.max(1, parseInt(req.body && req.body.sampleProperties, 10) || 5));
    const sampleDraws = Math.min(20, Math.max(1, parseInt(req.body && req.body.sampleDraws, 10) || 5));
    const report = await explorer.explore({ sampleProperties, sampleDraws });
    res.json({ checkedAt: new Date().toISOString(), ...report });
  } catch (e) { return fail(res, 502, e, 'could not reach the Sitewire test environment'); }
});

module.exports = router;
