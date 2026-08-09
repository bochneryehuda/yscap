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
const monitor = require('../lib/integrations/monitor');
const switches = require('../lib/integrations/switches');
const flags = require('../lib/flags');

router.use(requireAuth, requirePermission('platform_setup'));

// Best-effort audit of a switch change (who flipped what, from/to, ip).
async function auditSwitch(req, key, before, after, cleared) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, ip_address, user_agent, detail)
            VALUES ('staff', $1, 'integration_switch', 'integration', NULL, $2, $3, $4)`,
      [req.actor.id, req.ip, req.get('user-agent') || null,
        JSON.stringify({ key, before, after, cleared: !!cleared })]);
  } catch (_) { /* audit is best-effort */ }
}

const fail = (res, code, e, msg) => {
  console.warn('[admin-integrations] handler error:', db.describeError ? db.describeError(e) : (e && e.message));
  return res.status(code).json({ error: msg });
};

/**
 * THE DOWN-ALERT MONITOR'S OWN MEMORY, on the page that reports health.
 *
 * `integration_health_state` (db/214) already records HOW LONG each service has been
 * unreachable and when the monitor last swept — the two facts a person actually needs
 * when something is red ("since when?" and "is anything watching this between visits?")
 * — and until now they lived only in that table and in an email. A probe on page load
 * can only ever say "not reachable right now"; the elapsed time is what separates a
 * blip from an outage nobody has noticed for three days.
 *
 * A stored `down_since` is attached only through `monitor.downSinceFor`, which drops a
 * stale row from before a recovery — the monitor sweeps on a timer and may not have run
 * since a service came back, and "down for 3 days" beside a green light is worse than
 * saying nothing.
 *
 * Best-effort in every direction: a missing table or a failed read leaves the page exactly
 * as it was before this existed.
 */
async function monitorBlock(integrations) {
  const out = { ...monitor.describe(), lastSweepAt: null };
  try {
    const rows = (await db.query('SELECT key, down_since, updated_at FROM integration_health_state')).rows;
    const byKey = new Map(rows.map((r) => [r.key, r]));
    for (const i of integrations) i.downSince = monitor.downSinceFor(i.state, byKey.get(i.key));
    for (const r of rows) if (r.updated_at && (!out.lastSweepAt || r.updated_at > out.lastSweepAt)) out.lastSweepAt = r.updated_at;
  } catch (_) { /* the page renders fine without it */ }
  return out;
}

// Every integration's live status. Each probe is independently time-boxed + non-throwing, so this
// never hangs and a single down service can't fail the whole page.
router.get('/health', async (req, res) => {
  try {
    await flags.refresh(); // so the on/off switches show their live override state, not a stale cache
    const integrations = await health.probeAll();
    /* THE OUTBOUND RATE BUDGETS (lib/api-rate-limit.js, db/482). `waits` is the number
       worth watching: a climbing count means real traffic wants more than the cap allows,
       which is the signal to raise a limit BEFORE a provider phones the way ClickUp did
       (owner-directed 2026-08-07). Best-effort — an empty list never fails the page. */
    const rateLimits = await require('../lib/api-rate-limit').status();
    // Stamps `downSince` onto each integration and reports whether anything is watching
    // between visits. Never throws — see monitorBlock.
    const monitorState = await monitorBlock(integrations);
    res.json({ checkedAt: new Date().toISOString(), integrations, rateLimits, monitor: monitorState });
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

// The runtime on/off switches + their effective state (override ?? env default).
router.get('/switches', async (req, res) => {
  try { await flags.refresh(); res.json({ switches: switches.list() }); }
  catch (e) { return fail(res, 500, e, 'could not read switches'); }
});

// Flip a switch. Body: { enabled: bool, confirm?: bool }. A DANGEROUS switch (a write/creation
// switch) requires confirm:true (the UI shows a typed confirmation first). Audited.
router.post('/switches/:key', async (req, res) => {
  try {
    const meta = switches.BY_KEY[req.params.key];
    if (!meta) return res.status(404).json({ error: 'unknown switch' });
    if (typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled (true/false) is required' });
    if (meta.dangerous && req.body.confirm !== true) return res.status(400).json({ error: 'this switch changes live behavior — confirmation required' });
    const before = switches.effective(meta.key).on;
    await flags.setFlag(meta.key, req.body.enabled, req.actor.id, req.body.note || null);
    const after = switches.effective(meta.key);
    await auditSwitch(req, meta.key, before, after.on, false);
    res.json({ switch: after });
  } catch (e) { return fail(res, 500, e, 'could not change that switch'); }
});

// Reset a switch to its env/hosting default (remove the runtime override).
router.post('/switches/:key/reset', async (req, res) => {
  try {
    const meta = switches.BY_KEY[req.params.key];
    if (!meta) return res.status(404).json({ error: 'unknown switch' });
    const before = switches.effective(meta.key).on;
    await flags.clearFlag(meta.key);
    const after = switches.effective(meta.key);
    await auditSwitch(req, meta.key, before, after.on, true);
    res.json({ switch: after });
  } catch (e) { return fail(res, 500, e, 'could not reset that switch'); }
});

module.exports = router;
