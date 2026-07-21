'use strict';
/**
 * Tests for the API Health down-alert monitor (src/lib/integrations/monitor.js).
 * The transition logic is pure (no DB); an end-to-end pass is DB-gated.
 */
const assert = require('assert');
const monitor = require('../src/lib/integrations/monitor');

// ---- PURE: evaluateTransitions only alerts on real DOWN/RECOVER transitions ----
{
  const NOW = '2026-07-21T12:00:00.000Z';
  const ev = (prev, results) => monitor.evaluateTransitions(prev, results, NOW);

  // A configured service that goes unreachable → a 'down' alert; it is marked notified.
  let r = ev({ clickup: { state: 'live', notified_down: false } }, [{ key: 'clickup', name: 'ClickUp', state: 'unreachable', detail: 'HTTP 401' }]);
  assert.deepStrictEqual(r.alerts.map((a) => [a.key, a.kind]), [['clickup', 'down']], 'live→unreachable alerts down');
  assert.strictEqual(r.next.clickup.notifiedDown, true);
  assert.strictEqual(r.next.clickup.downSince, NOW, 'down_since is stamped on the transition');

  // Still down + already notified → NO repeat alert; down_since is preserved.
  r = ev({ clickup: { state: 'unreachable', notified_down: true, down_since: '2026-07-21T11:00:00.000Z' } },
    [{ key: 'clickup', name: 'ClickUp', state: 'unreachable', detail: 'HTTP 401' }]);
  assert.strictEqual(r.alerts.length, 0, 'still-down does not re-alert');
  assert.strictEqual(r.next.clickup.downSince, '2026-07-21T11:00:00.000Z', 'down_since preserved while down');

  // Recovery: was alerted down, now reachable → a 'recovered' alert; state cleared.
  r = ev({ clickup: { state: 'unreachable', notified_down: true } }, [{ key: 'clickup', name: 'ClickUp', state: 'live', detail: 'Reached ClickUp.' }]);
  assert.deepStrictEqual(r.alerts.map((a) => [a.key, a.kind]), [['clickup', 'recovered']], 'unreachable→live alerts recovered');
  assert.strictEqual(r.next.clickup.notifiedDown, false);
  assert.strictEqual(r.next.clickup.downSince, null);

  // Intentional states NEVER alert: not_configured, disabled, framework, planned, configured, live.
  for (const st of ['not_configured', 'disabled', 'framework', 'planned', 'configured', 'live']) {
    const q = ev({ x: { state: 'configured', notified_down: false } }, [{ key: 'x', name: 'X', state: st }]);
    assert.strictEqual(q.alerts.length, 0, `${st} never alerts`);
  }
  // A down service we never saw before (no prev row) still alerts once (bad key / service down).
  r = ev({}, [{ key: 'resend', name: 'Resend', state: 'unreachable', detail: 'HTTP 403' }]);
  assert.deepStrictEqual(r.alerts.map((a) => a.kind), ['down'], 'first-seen unreachable alerts once');

  // A down service that FLAPS to disabled (someone turned its switch off) is a recovery, not a repeat down.
  r = ev({ sitewire: { state: 'unreachable', notified_down: true } }, [{ key: 'sitewire', name: 'Sitewire', state: 'disabled' }]);
  assert.deepStrictEqual(r.alerts.map((a) => a.kind), ['recovered'], 'down→disabled clears the alert (recovered)');
  console.log('  ok - pure transition logic (down / no-repeat / recover / intentional-states-quiet)');
}

// ---- DB end-to-end: runOnce persists state + fires exactly one alert on a down transition ----
(async () => {
  if (!process.env.DATABASE_URL) { console.log('SKIP test-integrations-monitor DB half (no DATABASE_URL)'); console.log('test-integrations-monitor: transition logic pass'); return; }
  const db = require('../src/db');
  await require('../src/migrate-boot').ensureSchema();
  await db.query("DELETE FROM integration_health_state WHERE key IN ('__t_svc')");

  const calls = [];
  const notify = { notifyAdmins: async (o) => { calls.push(o); return ['x']; } };
  let state = 'unreachable';
  const health = { probeAll: async () => [{ key: '__t_svc', name: 'Test Service', state, detail: 'd' }] };

  // First pass: down → one 'down' alert + a persisted row.
  let res = await monitor.runOnce({ health, notify });
  assert.ok(res.alerts.some((a) => a.key === '__t_svc' && a.kind === 'down'), 'first pass alerts down');
  const downAlerts = calls.filter((c) => c.type === 'integration_alert' && /looks down/.test(c.title)).length;
  assert.strictEqual(downAlerts, 1, 'exactly one down email');
  let row = (await db.query("SELECT state, notified_down FROM integration_health_state WHERE key='__t_svc'")).rows[0];
  assert.ok(row && row.state === 'unreachable' && row.notified_down === true, 'row persisted as down+notified');

  // Second pass: still down → NO new alert.
  const before = calls.length;
  await monitor.runOnce({ health, notify });
  assert.strictEqual(calls.length, before, 'still-down sends no repeat email');

  // Third pass: recovered.
  state = 'live';
  await monitor.runOnce({ health, notify });
  assert.ok(calls.some((c) => /back up/.test(c.title)), 'recovery email sent');
  row = (await db.query("SELECT state, notified_down FROM integration_health_state WHERE key='__t_svc'")).rows[0];
  assert.ok(row.state === 'live' && row.notified_down === false, 'row cleared after recovery');

  await db.query("DELETE FROM integration_health_state WHERE key='__t_svc'");
  console.log('test-integrations-monitor: transition logic + DB alert-once/recover pass');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
