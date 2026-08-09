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

/* ---- PURE: what the API Health page is told about the monitor itself ----
   The page renders "down for 3 days" and "nothing is watching between visits" from
   these two, so both are pinned here rather than left to the screen to re-derive. */
{
  const env = { ...process.env };
  const set = (on, mins) => {
    if (on == null) delete process.env.INTEGRATIONS_MONITOR_ENABLED; else process.env.INTEGRATIONS_MONITOR_ENABLED = on;
    if (mins == null) delete process.env.INTEGRATIONS_MONITOR_INTERVAL_MIN; else process.env.INTEGRATIONS_MONITOR_INTERVAL_MIN = mins;
  };
  try {
    // ON BY DEFAULT (owner-directed 2026-08-09, "turn on the down alerts"). An unset env var
    // means the alerts run; only an explicit '0' turns them off.
    set(null, null);
    assert.deepStrictEqual(monitor.describe(),
      { enabled: true, intervalMin: 15, switchKey: 'INTEGRATIONS_MONITOR_ENABLED' }, 'unset = ON, 15 min');
    set('0', '15');
    assert.strictEqual(monitor.describe().enabled, false, 'an explicit 0 turns the alerts off');
    set('1', '30');
    assert.deepStrictEqual(monitor.describe().enabled, true, 'an explicit 1 is still honoured');
    assert.strictEqual(monitor.describe().intervalMin, 30, 'the interval env value is honoured');
    // Anything under the 5-minute floor is clamped, and junk falls back — the page must
    // never print "checking every 0 minutes".
    set('1', '1');
    assert.strictEqual(monitor.describe().intervalMin, 5, 'interval is clamped to the 5-minute floor');
    set('1', 'nonsense');
    assert.strictEqual(monitor.describe().intervalMin, 15, 'unparseable interval falls back to 15');
    // Everything that is not the literal '0' leaves the alerts on — a typo must never
    // silently stop the only thing watching these services.
    for (const v of ['', 'true', 'yes', 'off']) { set(v, '15'); assert.strictEqual(monitor.describe().enabled, true, `"${v}" does not switch it off`); }
  } finally { process.env = env; }

  /* THE SWITCH, not the env var, is the authority — that is what makes the toggle on the
     API Health page work without a redeploy. The flag cache is a synchronous in-memory map,
     so an override can be set here with no database. */
  {
    const env2 = { ...process.env };
    const flags = require('../src/lib/flags');
    const switches = require('../src/lib/integrations/switches');
    try {
      delete process.env.INTEGRATIONS_MONITOR_ENABLED;           // env default = ON
      flags._internals.setOverrideForTest('INTEGRATIONS_MONITOR_ENABLED', false);
      assert.strictEqual(monitor.describe().enabled, false, 'an admin override to OFF beats the env default');
      assert.strictEqual(switches.effective('INTEGRATIONS_MONITOR_ENABLED').overridden, true, 'the page is told it is overridden');
      process.env.INTEGRATIONS_MONITOR_ENABLED = '0';            // env default = OFF
      flags._internals.setOverrideForTest('INTEGRATIONS_MONITOR_ENABLED', true);
      assert.strictEqual(monitor.describe().enabled, true, 'an admin override to ON beats an env default of off');
      flags._internals.clearOverrideForTest('INTEGRATIONS_MONITOR_ENABLED');
      assert.strictEqual(monitor.describe().enabled, false, 'clearing the override falls back to the env default');
    } finally { flags._internals.clearOverrideForTest('INTEGRATIONS_MONITOR_ENABLED'); process.env = env2; }
  }

  // It is the ONE platform-level switch: no card owns it, so the health registry's
  // per-integration filter must never attach it to one.
  {
    const switches = require('../src/lib/integrations/switches');
    const m = switches.BY_KEY.INTEGRATIONS_MONITOR_ENABLED;
    assert.ok(m, 'the monitor switch is in the allowlist, so the toggle/reset endpoints accept it');
    assert.strictEqual(m.integration, null, 'it belongs to no integration card');
    assert.strictEqual(!!m.dangerous, false, 'it sends nothing outward but our own admin email — no typed confirm');
    assert.strictEqual(!!m.resume, false, 'the timer re-reads it every tick, so it needs no restart to resume');
    const owned = switches.list().filter((s) => s.integration === null).map((s) => s.key);
    assert.deepStrictEqual(owned, ['INTEGRATIONS_MONITOR_ENABLED'], 'it is the only card-less switch');
  }

  // downSinceFor: the row supplies HOW LONG, the live probe decides WHETHER.
  const ROW = { down_since: '2026-07-18T09:00:00.000Z' };
  assert.strictEqual(monitor.downSinceFor('unreachable', ROW), ROW.down_since, 'still down → the stored since-when shows');
  // THE POINT OF THE FUNCTION: the monitor sweeps on a timer, so a service that recovered
  // five minutes ago still has yesterday's down_since in the table. Printing it beside a
  // green light is a page contradicting itself.
  for (const st of ['live', 'configured', 'disabled', 'not_configured', 'framework', 'planned']) {
    assert.strictEqual(monitor.downSinceFor(st, ROW), null, `a stale row is dropped once the probe says ${st}`);
  }
  assert.strictEqual(monitor.downSinceFor('unreachable', undefined), null, 'no row (monitor never ran) → null, never a guess');
  assert.strictEqual(monitor.downSinceFor('unreachable', { down_since: null }), null, 'a row with no timestamp → null');
  console.log('  ok - describe() + downSinceFor() (the two facts the API Health page renders)');
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
