#!/usr/bin/env node
'use strict';
/**
 * LT PPE - "IS THE OWNER'S DAILY CHECK ACTUALLY RUNNING?" - the verdict, and the screen that shows it.
 *
 * OFFLINE: pure. `healthOf` takes the report it judges, so no database and no clock beyond the one
 * passed in.
 *
 * WHY THIS EXISTS. 2.64 proved the daily Lender Price check had never once run, and the reason nobody
 * noticed is that no surface answered the question. The check now runs six times a day and, until this,
 * still no surface answered it: `GET /ppe/canary/driver` reported everything needed and
 * `app-v2/src/longterm/api.js` had no method for it, so no screen could reach it.
 *
 * THE ASSERTIONS ARE ABOUT THE TWO WAYS THIS GOES WRONG AGAIN:
 *   - the verdict reading "fine" when it does not know (the exact reading that hid the original bug);
 *   - the THRESHOLD being restated somewhere other than the schedule it describes, so the two drift.
 */
const path = require('path');
const fs = require('fs');
const clock = require(path.join(__dirname, '..', 'src', 'longterm', 'ppe', 'canary-clock'));
const driver = require(path.join(__dirname, '..', 'src', 'longterm', 'ppe', 'canary-driver'));

let pass = 0;
const failures = [];
function ok(cond, what) { if (cond) { pass += 1; return; } failures.push(what); }
const eq = (a, b, what) => ok(a === b, `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const NOW = Date.parse('2026-08-18T12:00:00Z');
const H = 3600000;
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const report = (state, extra = {}) => ({ readable: true, state, ...extra });

// ---------------------------------------------------------------------------
// A - the threshold is DERIVED from the schedule, not typed beside it.
// ---------------------------------------------------------------------------
{
  const gap = clock.longestGapMs();
  ok(Number.isFinite(gap) && gap > 0, 'A1 the clock states its own longest quiet gap');

  // Computed independently here from the SAME exported hours, so this asserts the arithmetic rather
  // than restating an answer. On the owner's six hours the widest gap is 4pm -> 7am next day.
  const hrs = [...clock.EASTERN_HOURS].sort((a, b) => a - b);
  let widest = 0;
  for (let i = 0; i < hrs.length; i += 1) {
    const next = i + 1 < hrs.length ? hrs[i + 1] : hrs[0] + 24;
    widest = Math.max(widest, next - hrs[i]);
  }
  eq(gap, widest * H, 'A2 …and it is the widest gap between consecutive scheduled hours, wrapping midnight');
  eq(gap, 15 * H, 'A3 …which on the owner\'s 7/9/10/11/12/4 is 15 hours (4pm to 7am)');

  // THE POINT OF DERIVING IT: adding an hour must move the threshold with no other edit.
  const withExtra = (hours) => {
    const s = [...hours].sort((a, b) => a - b);
    let w = 0;
    for (let i = 0; i < s.length; i += 1) { const n = i + 1 < s.length ? s[i + 1] : s[0] + 24; w = Math.max(w, n - s[i]); }
    return w * H;
  };
  ok(withExtra([...clock.EASTERN_HOURS, 22]) < gap,
    'A4 …so adding a late hour shortens the allowed quiet period on its own — nothing to remember to update');
}

// ---------------------------------------------------------------------------
// B - the four states.
// ---------------------------------------------------------------------------
{
  eq(driver.healthOf(report(null), NOW).state, 'never',
    'B1 no state row at all is NEVER RUN - the alarm, not a neutral "no data yet"');
  eq(driver.healthOf({ readable: true, state: { lastAttemptAt: null } }, NOW).state, 'never',
    'B2 a row with no attempt timestamp reads the same way');
  eq(driver.healthOf(report({ lastAttemptAt: at(2 * H), lastDrivenBy: 'cron' }), NOW).state, 'ok',
    'B3 an attempt two hours ago is fine');
  eq(driver.healthOf(report({ lastAttemptAt: at(15 * H) }), NOW).state, 'ok',
    'B4 …and so is one at exactly the longest scheduled gap - the slack is what absorbs a late wake');
  eq(driver.healthOf(report({ lastAttemptAt: at(20 * H) }), NOW).state, 'stale',
    'B5 twenty hours of silence is STALE - something has stopped reaching it');
}

// ---------------------------------------------------------------------------
// C - THE ONE THAT MATTERS: not knowing is never reported as fine.
// ---------------------------------------------------------------------------
{
  eq(driver.healthOf({ readable: false, stateError: 'connection refused' }, NOW).state, 'unknown',
    'C1 a ledger that could not be read is UNKNOWN, never ok');
  eq(driver.healthOf(report({ lastAttemptAt: 'not-a-timestamp' }), NOW).state, 'unknown',
    'C2 an unreadable timestamp is UNKNOWN, never ok');
  eq(driver.healthOf(null, NOW).state, 'never', 'C3 a missing report is not ok either');

  // A verdict that can throw is a verdict that goes missing exactly when it matters.
  let threw = false;
  for (const junk of [undefined, 0, '', [], { state: 'nonsense' }, { readable: false }, { state: { lastAttemptAt: {} } }]) {
    try { const h = driver.healthOf(junk, NOW); ok(!!h && typeof h.state === 'string', 'C4 junk still yields a verdict'); }
    catch (_) { threw = true; }
  }
  ok(!threw, 'C5 no input makes the verdict throw');

  // And every state carries a sentence a person can act on.
  for (const s of [report(null), report({ lastAttemptAt: at(40 * H) }), report({ lastAttemptAt: at(H) }), { readable: false }]) {
    const h = driver.healthOf(s, NOW);
    ok(typeof h.says === 'string' && h.says.length > 20, `C6 the ${h.state} verdict says something usable`);
  }
}

// ---------------------------------------------------------------------------
// D - the verdict reports the facts it judged on, so a screen never re-reads them elsewhere.
// ---------------------------------------------------------------------------
{
  const h = driver.healthOf(report({ lastAttemptAt: at(H), lastDrivenBy: 'cron', lastOutcome: 'ran' }), NOW);
  eq(h.lastDrivenBy, 'cron', 'D1 what drove the last attempt rides on the verdict');
  eq(h.lastOutcome, 'ran', 'D2 …and its outcome');
  ok(typeof h.schedule === 'string' && /Eastern/.test(h.schedule),
    'D3 …and the schedule in words, so the screen states no hours of its own');
  eq(h.staleAfterMs, clock.longestGapMs() + H, 'D4 …and the threshold it used');
}

// ---------------------------------------------------------------------------
// E - describe() actually carries the verdict, and the route hands it over.
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'ppe', 'canary-driver.js'), 'utf8');
  ok(/out\.health = healthOf\(out, opts\.nowMs\)/.test(src),
    'E1 describe() attaches the verdict, so one read answers the question');
  ok(/healthOf,/.test(src.slice(src.indexOf('module.exports'))),
    'E2 …and healthOf is exported so it can be tested at all');

  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'routes', 'ppe.js'), 'utf8');
  ok(/canaryDriver\.describe\(readScope\(req\), \{ db \}\)/.test(routes),
    'E3 the route returns describe() whole - nothing between it and the screen re-decides anything');
}

// ---------------------------------------------------------------------------
// F - THE WIRING. The route and the verdict are worth nothing if no screen reaches them, which was
//     the entire finding: the endpoint existed and api.js had no method for it.
// ---------------------------------------------------------------------------
{
  const api = fs.readFileSync(path.join(__dirname, '..', 'app-v2', 'src', 'longterm', 'api.js'), 'utf8');
  ok(/ppeCanaryDriver:\s*\(\)\s*=>\s*ltGet\(lt\('\/ppe\/canary\/driver'\)\)/.test(api),
    'F1 the one client can reach the driver door');

  const screen = fs.readFileSync(path.join(__dirname, '..', 'app-v2', 'src', 'longterm', 'CanaryConsole.jsx'), 'utf8');
  ok(/ltApi\.ppeCanaryDriver\(\)/.test(screen), 'F2 the console calls it');
  ok(/<DriverHealthView/.test(screen) && /function DriverHealthView/.test(screen),
    'F3 …and renders it');

  // IT RENDERS THE VERDICT, IT DOES NOT REACH ONE. A screen computing staleness would hold a second
  // copy of the schedule; that copy is what drifts when an hour changes.
  const view = (screen.match(/function DriverHealthView[\s\S]*?\n}\n/) || [''])[0];
  ok(view.length > 200, 'F4 the view was found to inspect');
  ok(!/longestGap|staleAfter|3600000|15 \* 60|EASTERN_HOURS/.test(view),
    'F5 …and it computes NO threshold of its own - the server owns that rule');
  ok(/h\.says/.test(view), 'F6 …quoting the server\'s own sentence rather than paraphrasing it');

  // `unknown` must not be painted as healthy - the reading that hid the original defect.
  const tone = (view.match(/const TONE = \{[^}]*\}/) || [''])[0];
  ok(/unknown:\s*'warn'/.test(tone), 'F7 an unknown verdict is painted as a warning, never as good');
  ok(/never:\s*'bad'/.test(tone) && /stale:\s*'bad'/.test(tone),
    'F8 …and never-run and gone-quiet are both painted as bad');

  // A read failure must be SAID, not drawn as an empty card - the same discipline as the schedules.
  ok(/could not be read/.test(view), 'F9 a failed read says so rather than rendering blank');

  // The ledger row claiming nothing reaches this route must be gone, or the gate contradicts the code.
  const ledger = fs.readFileSync(path.join(__dirname, '..', 'docs', 'longterm', 'LT-ROUTES-UNREACHED.md'), 'utf8');
  ok(!/GET \/api\/lt\/ppe\/canary\/driver/.test(ledger),
    'F10 …and the "nothing reaches it" ledger row is struck, now that a screen does');
}

console.log(failures.length
  ? `FAIL - lt ppe canary health (${pass} passed, ${failures.length} failed)\n  ${failures.join('\n  ')}`
  : `ok - lt ppe canary health (${pass} assertions)`);
process.exit(failures.length ? 1 : 0);
