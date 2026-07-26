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

let started = false;
function start() {
  if (started) return;
  if (process.env.INTEGRATIONS_MONITOR_ENABLED !== '1') {
    console.log('[integrations-monitor] disabled (set INTEGRATIONS_MONITOR_ENABLED=1 to turn on down-alerts)');
    return;
  }
  started = true;
  const mins = Math.max(5, parseInt(process.env.INTEGRATIONS_MONITOR_INTERVAL_MIN || '15', 10) || 15);
  // Boot pass shortly after startup, then every `mins` minutes (unref so it never holds the process open).
  setTimeout(() => runOnce().catch((e) => console.error('[integrations-monitor] boot', e && e.message)), 120000);
  setInterval(() => runOnce().catch((e) => console.error('[integrations-monitor] tick', e && e.message)), mins * 60 * 1000).unref();
  console.log(`[integrations-monitor] down-alerts started (every ${mins} min)`);
}

module.exports = { start, runOnce, evaluateTransitions, _internals: { isDownState, sendAlert } };
