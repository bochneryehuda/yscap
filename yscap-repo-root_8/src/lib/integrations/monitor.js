'use strict';
/**
 * API Health monitor — the continuous down-alert layer on top of the health registry.
 *
 * On a schedule it probes every integration and emails when one that WAS reachable goes DOWN, and
 * again when it RECOVERS. It alerts ONLY on a genuine outage — a `state:'unreachable'` (configured
 * but not reachable, e.g. the service is down or a key went bad). Intentional states (not connected
 * / switched off / awaiting keys / a keyless service) NEVER alert. Last-known state lives in
 * `integration_health_state` (db/214).
 *
 * THREE RULES KEEP IT QUIET (owner-directed 2026-08-09, "the admins are getting bombarded"):
 *   1. NOTHING is said until a service has been unreachable for ALERT_AFTER_MS (30 min) — a blip
 *      that heals inside the window sends no "down" AND therefore no "back up" either.
 *   2. ONE email per sweep covering every service, never one email per service.
 *   3. Only SUPER ADMINS are mailed (every admin still sees the in-app row), and the NOTIFY_ADMINS
 *      shared inbox is skipped — see sendSweepAlert.
 *
 * The timer is ALWAYS armed and each tick asks the switch (INTEGRATIONS_MONITOR_ENABLED, flippable
 * on the API Health page) whether to do anything — so turning the alerts on never needs a redeploy.
 * Interval: INTEGRATIONS_MONITOR_INTERVAL_MIN minutes, default 15, floor 5.
 */
const db = require('../../db');

// A genuine outage = configured but not reachable. Everything else is an intentional/benign state.
const isDownState = (state) => state === 'unreachable';

/* HOW LONG A SERVICE MUST BE DOWN BEFORE ANYBODY IS EMAILED (owner-directed 2026-08-09:
   "anything that is down should not get the alert as long as it's not out for 30 minutes").

   This is the standard shape for alerting — Prometheus spells it `for: 30m` — and it exists
   because the interesting question is never "did one check fail?" but "has this been broken
   long enough to matter?". A service that blips and recovers inside the window emails
   NOTHING AT ALL: no "down", and therefore no "back up" either, because a recovery notice
   for an outage nobody was told about is pure noise.

   It is not a substitute for the root fix (probes no longer queue behind our own rate
   limiter — see api-rate-limit.runAsHealthProbe); it is the belt to that braces, and it
   also covers the genuine 60-second vendor wobble nobody needs to hear about. */
const ALERT_AFTER_MS = Math.max(0, parseInt(process.env.INTEGRATIONS_MONITOR_ALERT_AFTER_MIN || '30', 10) || 30) * 60000;

/**
 * PURE transition decision (unit-tested with no DB). Given the previous state map
 * ({key:{state,notified_down,down_since}}) and the current probe results ([{key,name,state,detail}]),
 * returns { alerts:[{key,name,kind:'down'|'recovered',detail,downSince,downMs}], next:{...} }.
 *
 * - a service that goes down starts its clock and is SILENT
 * - once it has been down for ALERT_AFTER_MS and has not been announced → a 'down' alert
 * - a service we ANNOUNCED and that is now anything-but-down → a 'recovered' alert
 * - a service that recovers before it was ever announced → no alert, clock cleared
 */
function evaluateTransitions(prev = {}, results = [], nowIso = null, opts = {}) {
  const alertAfterMs = Number.isFinite(opts.alertAfterMs) ? opts.alertAfterMs : ALERT_AFTER_MS;
  const now = nowIso ? Date.parse(nowIso) : Date.now();
  /* The clock has to be STAMPED, not just measured: a caller that omits `nowIso` would
     otherwise persist down_since = null, and a null start is re-read next tick as "the
     outage began just now" — so the 30 minutes would never elapse and a permanently down
     service would stay silent forever. */
  const stamp = nowIso || new Date(now).toISOString();
  const alerts = [];
  const next = {};
  for (const r of results) {
    const p = prev[r.key] || null;
    if (isDownState(r.state)) {
      // The clock starts at the FIRST failed observation and is never restarted by a later
      // one — otherwise a service flapping around the window would reset itself forever and
      // a real outage would never be reported.
      const downSince = (p && isDownState(p.state) && p.down_since) || stamp;
      const startedMs = Date.parse(downSince);
      const downMs = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : 0;
      const alreadyAlerted = !!(p && isDownState(p.state) && p.notified_down);
      const longEnough = downMs >= alertAfterMs;
      if (!alreadyAlerted && longEnough) {
        alerts.push({ key: r.key, name: r.name, kind: 'down', detail: r.detail || '', downSince, downMs });
      }
      next[r.key] = {
        state: r.state, detail: r.detail || '',
        // Only a service we ACTUALLY announced is marked notified — otherwise the recovery
        // arm below would send "back up" for an outage nobody ever heard about.
        notifiedDown: alreadyAlerted || longEnough,
        downSince,
      };
    } else {
      const wasAlertedDown = !!(p && isDownState(p.state) && p.notified_down);
      if (wasAlertedDown) {
        const startedMs = p && p.down_since ? Date.parse(p.down_since) : NaN;
        alerts.push({
          key: r.key, name: r.name, kind: 'recovered', detail: r.detail || '',
          downSince: (p && p.down_since) || null,
          downMs: Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : null,
        });
      }
      next[r.key] = { state: r.state, detail: r.detail || '', notifiedDown: false, downSince: null };
    }
  }
  return { alerts, next };
}

/** "3 days" / "2 hours" / "35 minutes" — how long, in words, for the alert body. */
function forHuman(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  return `${Math.round(h / 24)} days`;
}

/**
 * ONE EMAIL PER SWEEP, not one per service (owner-directed 2026-08-09: a restart or a
 * network wobble hits several at once, and six separate emails about one event is the
 * "bombarded" complaint). PURE, so the exact wording is unit-tested with no DB.
 * Returns null when there is nothing worth sending.
 */
function composeAlert(alerts = [], opts = {}) {
  const down = alerts.filter((a) => a.kind === 'down');
  const back = alerts.filter((a) => a.kind === 'recovered');
  if (!down.length && !back.length) return null;
  const mins = Math.round((Number.isFinite(opts.alertAfterMs) ? opts.alertAfterMs : ALERT_AFTER_MS) / 60000);

  const title = down.length
    ? (down.length === 1 ? `${down[0].name} has been down for ${forHuman(down[0].downMs)}`
      : `${down.length} services have been down for over ${mins} minutes`)
    : (back.length === 1 ? `${back[0].name} is back up` : `${back.length} services are back up`);

  const lines = [];
  if (down.length) {
    lines.push(down.length === 1
      ? 'PILOT has not been able to reach this service:'
      : 'PILOT has not been able to reach these services:');
    for (const a of down) {
      const dur = forHuman(a.downMs);
      lines.push(`  • ${a.name} — down ${dur ? `for ${dur}` : 'now'}${a.detail ? `. ${a.detail}` : ''}`);
    }
    lines.push('');
    // The reassurance that makes this email worth opening: it is never a blip.
    lines.push(`You are only told once a service has been unreachable for more than ${mins} minutes, `
      + 'so this is not a momentary wobble. Open API Health to test it now, and check the service '
      + 'or its key in the hosting settings (Render).');
  }
  if (back.length) {
    if (down.length) lines.push('');
    lines.push(back.length === 1 ? 'Back up again:' : 'Back up again:');
    for (const a of back) {
      const dur = forHuman(a.downMs);
      lines.push(`  • ${a.name}${dur ? ` — was down for ${dur}` : ''}`);
    }
  }
  return { title, body: lines.join('\n') };
}

/**
 * WHO IS EMAILED, AND WHY IT IS NOT SIMPLY "THE ADMINS" (owner-directed 2026-08-09:
 * "no loan officers should not receive it").
 *
 * `notifyAdmins` fans out to `staff_users WHERE role IN ('admin','super_admin')`, so a
 * loan officer could never be reached that way. The one list that COULD carry one is
 * NOTIFY_ADMINS — a hand-typed set of ADDRESSES in the hosting settings with no role
 * attached and nothing stopping a person's own inbox being added to it — which is why
 * this alert skips it outright rather than trusting whatever is in there today.
 *
 * `emailRoles` then narrows the MAIL to super admins (the owner's choice). Every admin
 * still gets the in-app row, so nobody loses sight of an outage; they simply stop being
 * mailed about it. Widening this back to all admins is one word — and is the owner's
 * call, not a tidy-up.
 */
const ALERT_LINK = '/portal/#/internal/api-health';
const ALERT_EMAIL_ROLES = ['super_admin'];

/**
 * ONE email per sweep — never one per service. Composition (what it says, and
 * whether there is anything worth saying at all) is the pure `composeAlert`;
 * this function only addresses the envelope. Returns null when nothing was sent.
 */
async function sendSweepAlert(alerts, notify, opts = {}) {
  const msg = composeAlert(alerts, opts);
  if (!msg) return null;
  await notify.notifyAdmins({
    type: 'integration_alert',
    title: msg.title,
    body: msg.body,
    link: ALERT_LINK,
    emailRoles: ALERT_EMAIL_ROLES,
    skipSharedInbox: true,
  });
  return msg;
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
  // ONE email for the whole sweep. A restart or a network wobble takes several
  // services down at the same instant, and six separate emails about one event is
  // exactly the "bombarded" complaint.
  let sent = true;
  try { sent = !!(await sendSweepAlert(alerts, notify)); }
  catch (e) { sent = false; console.warn('[integrations-monitor] alert failed:', e && e.message); }
  /* A FAILED SEND IS NOT AN ANNOUNCEMENT. `next` was computed assuming this sweep's
     alerts go out, so persisting it after a failure would stamp these services
     "already announced" and the outage would never be reported again — one
     two-second email blip and a real outage stays silent forever. Roll the flag back
     for exactly the services this sweep tried to announce; their clock (`downSince`)
     is untouched, so the next tick is still past the 30-minute threshold and re-sends
     immediately with the correct duration.
     A failed RECOVERY notice is deliberately not retried: the service is back, nobody
     is waiting on it, and reviving the row's stale down-state to force a retry would
     make the table claim a healthy service is down for a whole interval. */
  if (!sent) {
    for (const a of alerts) {
      if (a.kind === 'down' && next[a.key]) next[a.key].notifiedDown = false;
    }
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
  // `emailed` is the honest answer to "did anyone hear about this sweep?" — alerts were
  // decided is not the same as an email went out, and after a send failure the two differ.
  return { checked: results.length, alerts, emailed: !!(alerts.length && sent) };
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
  return {
    enabled: enabledNow(),
    intervalMin: intervalMinutes(),
    switchKey: SWITCH_KEY,
    // The two facts that decide whether an email ever arrives, so the page can state the
    // policy rather than an admin having to guess why the alerts went quiet.
    alertAfterMin: Math.round(ALERT_AFTER_MS / 60000),
    emailRoles: ALERT_EMAIL_ROLES.slice(),
  };
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
  start, runOnce, evaluateTransitions, composeAlert, describe, downSinceFor, SWITCH_KEY,
  _internals: {
    isDownState, sendSweepAlert, intervalMinutes, enabledNow, forHuman,
    ALERT_AFTER_MS, ALERT_EMAIL_ROLES, ALERT_LINK,
  },
};
