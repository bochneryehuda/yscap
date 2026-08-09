'use strict';
/**
 * API Health monitor — the continuous down-alert layer on top of the health registry.
 *
 * On a schedule it probes every integration and emails the admins when one that WAS reachable goes
 * DOWN, and again when it RECOVERS. It alerts ONLY on a real transition (never every tick) and ONLY
 * on a genuine outage — a `state:'unreachable'` (configured but not reachable, e.g. the service is
 * down or a key went bad). Intentional states (not connected / switched off / awaiting keys / a
 * keyless service) NEVER alert. Last-known state lives in `integration_health_state` (db/214).
 *
 * OFF by default: set INTEGRATIONS_MONITOR_ENABLED=1 to turn it on (and it then probes every
 * INTEGRATIONS_MONITOR_INTERVAL_MIN minutes, default 15). Keeping it opt-in means we don't call
 * every external service on a timer unless the owner wants the alerts.
 */
const db = require('../../db');

// A genuine outage = configured but not reachable. Everything else is an intentional/benign state.
const isDownState = (state) => state === 'unreachable';

/**
 * PURE transition decision (unit-tested with no DB). Given the previous state map
 * ({key:{state,notified_down,down_since}}) and the current probe results ([{key,name,state,detail}]),
 * returns { alerts:[{key,name,kind:'down'|'recovered',detail}], next:{key:{state,detail,notifiedDown,downSince}} }.
 * - a NEW down (or a down we haven't alerted yet) → a 'down' alert
 * - a service that WAS alerted down and is now anything-but-down → a 'recovered' alert
 */
function evaluateTransitions(prev = {}, results = [], nowIso = null) {
  const alerts = [];
  const next = {};
  for (const r of results) {
    const p = prev[r.key] || null;
    if (isDownState(r.state)) {
      const alreadyAlerted = !!(p && isDownState(p.state) && p.notified_down);
      if (!alreadyAlerted) alerts.push({ key: r.key, name: r.name, kind: 'down', detail: r.detail || '' });
      next[r.key] = { state: r.state, detail: r.detail || '', notifiedDown: true, downSince: (p && p.down_since) || nowIso };
    } else {
      const wasAlertedDown = !!(p && isDownState(p.state) && p.notified_down);
      if (wasAlertedDown) alerts.push({ key: r.key, name: r.name, kind: 'recovered', detail: r.detail || '' });
      next[r.key] = { state: r.state, detail: r.detail || '', notifiedDown: false, downSince: null };
    }
  }
  return { alerts, next };
}

async function sendAlert(a, notify) {
  const link = '/portal/#/internal/api-health';
  if (a.kind === 'down') {
    await notify.notifyAdmins({
      type: 'integration_alert',
      title: `${a.name} looks down`,
      body: `PILOT’s automatic check could not reach ${a.name}.${a.detail ? ` (${a.detail})` : ''}\n\nOpen API Health to test it, and check the service or its key in the hosting settings (Render).`,
      link,
    });
  } else {
    await notify.notifyAdmins({
      type: 'integration_alert',
      title: `${a.name} is back up`,
      body: `${a.name} is reachable again.${a.detail ? ` (${a.detail})` : ''}`,
      link,
    });
  }
}

// One monitor pass: probe → diff against stored state → alert on transitions → persist. Best-effort;
// never throws out (logs + returns a summary). `deps` lets tests inject a probe + notify.
async function runOnce(deps = {}) {
  const health = deps.health || require('./health-registry');
  const notify = deps.notify || require('../notify');
  const results = await health.probeAll();
  const prevRows = (await db.query('SELECT key, state, detail, down_since, notified_down FROM integration_health_state')).rows;
  const prev = {};
  for (const r of prevRows) prev[r.key] = r;
  const { alerts, next } = evaluateTransitions(prev, results, new Date().toISOString());
  for (const a of alerts) {
    try { await sendAlert(a, notify); } catch (e) { console.warn('[integrations-monitor] alert failed:', e && e.message); }
  }
  for (const r of results) {
    const n = next[r.key];
    try {
      await db.query(
        `INSERT INTO integration_health_state (key, state, detail, down_since, notified_down, updated_at)
              VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (key) DO UPDATE SET state = $2, detail = $3, down_since = $4, notified_down = $5, updated_at = now()`,
        [r.key, n.state, n.detail, n.downSince, n.notifiedDown]);
    } catch (e) { console.warn('[integrations-monitor] persist failed for', r.key, e && e.message); }
  }
  return { checked: results.length, alerts };
}

// The one key this monitor is gated on. Declared in src/lib/integrations/switches.js as the
// single PLATFORM-level switch (integration: null), so an admin can turn the alerts off and
// on from the API Health page without a redeploy.
const SWITCH_KEY = 'INTEGRATIONS_MONITOR_ENABLED';

/**
 * WHAT THIS MONITOR IS DOING RIGHT NOW — for the API Health page, which has to be able
 * to say whether anything is WATCHING these services between visits. "Every service is
 * green" means something quite different when nobody is checking except the person who
 * happens to open the page, so the screen states it rather than implying coverage it
 * does not have.
 *
 * The verdict comes from the SWITCH, not the raw env var: `switches.on()` resolves the
 * admin's runtime override first and falls back to the env default, so the page can never
 * describe a schedule the monitor is not actually running — including in the seconds after
 * somebody flips it. `start()` and every tick ask this same function, so there is one
 * answer to "is this on?" in the whole system.
 */
function describe() {
  return { enabled: enabledNow(), intervalMin: intervalMinutes(), switchKey: SWITCH_KEY };
}
// Required lazily: switches.js pulls in config, and monitor.js is loaded by the health route
// on a hot path. `require` is cached, so this costs nothing after the first call.
function enabledNow() {
  try { return require('./switches').on(SWITCH_KEY); }
  // A switch layer that cannot answer must not silently stop the alerts — fall back to the
  // env default, which is the value the process booted with.
  catch (_) { return process.env.INTEGRATIONS_MONITOR_ENABLED !== '0'; }
}
function intervalMinutes() {
  return Math.max(5, parseInt(process.env.INTEGRATIONS_MONITOR_INTERVAL_MIN || '15', 10) || 15);
}

/**
 * "Since when?" for the API Health page — the stored `down_since` from THIS monitor's own
 * row, but ONLY while the CURRENT probe still agrees the service is unreachable.
 *
 * This monitor sweeps on a timer, so its row lags reality by up to an interval: a
 * service that came back five minutes ago still has yesterday's `down_since`
 * sitting in the table. Reading the column on its own would print "down for 3 days" beside
 * a green light — a page that contradicts itself, which is worse than one that says
 * nothing. The live probe is the authority on WHETHER; the row is only consulted for
 * HOW LONG. Returns null rather than a guess.
 */
function downSinceFor(currentState, row) {
  if (!isDownState(currentState)) return null;
  return (row && row.down_since) || null;
}

/**
 * THE TIMER IS ALWAYS ARMED; THE SWITCH DECIDES WHETHER A TICK DOES ANYTHING.
 *
 * `start()` used to read the env var once and return early when it was off, which meant the
 * only way to begin alerting was a redeploy — and an admin turning the switch on from the API
 * Health page would have watched it sit there doing nothing. Arming unconditionally and asking
 * `enabledNow()` per tick costs one no-op check every few minutes and makes the switch real.
 * The same reason `resume: false` is the honest flag on this switch.
 */
let started = false;
function start() {
  if (started) return;
  started = true;
  const mins = intervalMinutes();
  const tick = (when) => {
    if (!enabledNow()) return Promise.resolve(null); // switched off — nothing probed, nothing emailed
    return runOnce().catch((e) => console.error(`[integrations-monitor] ${when}`, e && e.message));
  };
  // Boot pass shortly after startup, then every `mins` minutes (unref so it never holds the process open).
  setTimeout(() => tick('boot'), 120000);
  setInterval(() => tick('tick'), mins * 60 * 1000).unref();
  console.log(`[integrations-monitor] armed every ${mins} min — down-alerts currently `
    + `${enabledNow() ? 'ON' : 'OFF'} (switch ${SWITCH_KEY}, flip it on the API Health page)`);
}

module.exports = {
  start, runOnce, evaluateTransitions, describe, downSinceFor, SWITCH_KEY,
  _internals: { isDownState, sendAlert, intervalMinutes, enabledNow },
};
