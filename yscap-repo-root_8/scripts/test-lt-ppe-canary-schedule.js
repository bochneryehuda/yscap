#!/usr/bin/env node
'use strict';
/**
 * LT PPE §10.3a — WHEN the canary runs, and on WHAT. Pure, offline.
 *
 * The canary exists and an admin can fire one by hand; the CADENCE never has. So agreement is only
 * measured on the days somebody pressed the button, while the cutover gate reads a clean-day STREAK
 * and an agreement TREND off exactly that series — and an unfed streak does not read as "unmeasured",
 * it reads as a low score. An investor can therefore sit permanently short of promotion for want of a
 * cron rather than for want of agreement.
 *
 * TWO PROPERTIES CARRY THIS SUITE, and neither is about clocks:
 *
 *   • A SCHEDULE NEVER INVENTS A BATTERY. `coverage.js` already refuses to invent a pricing band;
 *     automation is where that discipline is easiest to break and hardest to notice, because a
 *     made-up battery still produces a number, and that number feeds the promotion gate. So an
 *     empty / absent / ambiguous battery must REFUSE, and the refusal must say why.
 *   • IT FAILS TOWARD NOT RUNNING. Every uncertainty — no clock, a junk interval, a last-run stamp
 *     from the future — resolves to "do not run". The asymmetry is the reason: a canary that does
 *     not fire is a gap visible on the scoreboard, while one that fires when it should not is N live
 *     vendor calls per tick, forever.
 *
 * PROVEN TO FAIL: default a missing battery to anything and BATTERY-* go red; drop the interval floor
 * and FLOOR-1 goes red; read a future stamp as due and FUTURE-1 goes red; sort the due list the other
 * way and STARVE-1 goes red.
 *
 * LT-only. No DB, no network, no RTL imports.
 */
const sched = require('../src/longterm/ppe/canary-schedule');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = 1755000000000;                        // a fixed instant; nothing here reads a real clock
const GOOD = { enabled: true, intervalMs: DAY, scenarios: [{ purpose: 'Purchase', value: 5e5, loan: 4e5 }] };

console.log('LT PPE — canary schedule (never invents a battery; fails toward not running)');

// ---- THE BATTERY RULE ------------------------------------------------------
{
  ok(sched.validateSchedule({ ...GOOD, scenarios: undefined }).reason === 'no_battery',
    'BATTERY-1 a schedule with NO battery is refused — never quietly given a default one');
  ok(sched.validateSchedule({ ...GOOD, scenarios: [] }).reason === 'no_battery',
    'BATTERY-2 …and so is an EMPTY one (an empty list is not a battery)');
  ok(sched.validateSchedule({ enabled: true, intervalMs: DAY, scenarios: [{}], matrix: { fico: [700] } }).reason === 'ambiguous_battery',
    'BATTERY-3 …and one carrying BOTH shapes, rather than guessing which the human meant');
  ok(/never invents one/i.test(sched.validateSchedule({ ...GOOD, scenarios: undefined }).message || ''),
    'BATTERY-4 …and the refusal SAYS why, because this rule is the one a future change is most likely to "simplify"');
  const big = { ...GOOD, scenarios: new Array(sched.MAX_BATTERY_SCENARIOS + 1).fill({}) };
  ok(sched.validateSchedule(big).reason === 'battery_too_large',
    'BATTERY-5 an oversized battery is REFUSED at save time, not silently shortened every tick forever');
  ok(sched.validateSchedule({ ...GOOD, scenarios: new Array(sched.MAX_BATTERY_SCENARIOS).fill({}) }).ok === true,
    'BATTERY-6 …with the cap itself allowed (an off-by-one here quietly narrows every battery)');
  const m = sched.validateSchedule({ enabled: true, intervalMs: DAY, matrix: { fico: [700, 760] } });
  ok(m.ok && m.battery.kind === 'matrix', 'BATTERY-7 a saved MATRIX is a valid battery, reported as its own kind');
  const s = sched.validateSchedule(GOOD);
  ok(s.ok && s.battery.kind === 'scenarios' && s.battery.scenarios.length === 1,
    'BATTERY-8 …as is a saved scenario LIST, carried through verbatim');
}

// ---- THE CADENCE BOUNDS ----------------------------------------------------
{
  ok(sched.validateSchedule({ ...GOOD, intervalMs: 60 * 1000 }).reason === 'interval_too_short',
    'FLOOR-1 "every minute" is refused — a canary prices a whole battery against the live vendor');
  ok(sched.validateSchedule({ ...GOOD, intervalMs: sched.MIN_INTERVAL_MS }).ok === true,
    'FLOOR-2 …with the floor itself allowed');
  ok(sched.validateSchedule({ ...GOOD, intervalMs: sched.MAX_INTERVAL_MS + 1 }).reason === 'interval_too_long',
    'CEIL-1 a cadence too long to feed a clean-DAY streak is refused rather than left looking configured');
  ok(sched.validateSchedule({ ...GOOD, intervalMs: 'soon' }).reason === 'bad_interval' &&
     sched.validateSchedule({ ...GOOD, intervalMs: -1 }).reason === 'bad_interval' &&
     sched.validateSchedule({ ...GOOD, intervalMs: 0 }).reason === 'bad_interval',
    'BAD-1 junk / negative / zero intervals are refused, never coerced into a cadence');
  const dflt = sched.validateSchedule({ enabled: true, scenarios: [{}] });
  ok(dflt.ok && dflt.intervalMs === sched.DEFAULT_INTERVAL_MS,
    'DEFAULT-1 an OMITTED interval takes the documented default — a cadence is a safe default, a battery is not');
  ok(sched.validateSchedule({ ...GOOD, intervalMs: undefined, intervalMinutes: 120 }).intervalMs === 2 * HOUR,
    'MINUTES-1 minutes are accepted as the human-facing unit and converted once, here');
  ok(sched.validateSchedule(null).reason === 'no_schedule' && sched.validateSchedule([]).reason === 'no_schedule',
    'NONE-1 no schedule at all is reported as such, not as a broken one');
}

// ---- PAUSED IS NOT BROKEN --------------------------------------------------
{
  const v = sched.validateSchedule({ ...GOOD, enabled: false });
  ok(v.ok === true, 'PAUSE-1 a paused schedule is VALID — conflating the two would report it as broken');
  const d = sched.decide({ ...GOOD, enabled: false }, { nowMs: T0, lastRunMs: T0 - 10 * DAY });
  ok(d.run === false && d.reason === 'disabled', 'PAUSE-2 …and simply does not run, however overdue it is');
  ok(sched.decide({ ...GOOD, enabled: 'true' }, { nowMs: T0 }).reason === 'disabled',
    'PAUSE-3 enabled must be a real boolean — a truthy string never turns a live vendor loop on');
}

// ---- DUE-NESS --------------------------------------------------------------
{
  ok(sched.decide(GOOD, { nowMs: T0 }).run === true && sched.decide(GOOD, { nowMs: T0 }).reason === 'never_run',
    'DUE-1 a schedule that has NEVER run is due immediately — the first measurement should not wait a whole cadence');
  ok(sched.decide(GOOD, { nowMs: T0, lastRunMs: T0 - DAY - 1 }).run === true,
    'DUE-2 past the cadence → due');
  const nd = sched.decide(GOOD, { nowMs: T0, lastRunMs: T0 - HOUR });
  ok(nd.run === false && nd.reason === 'not_due' && nd.dueAt === T0 - HOUR + DAY,
    'DUE-3 inside the cadence → not due, and it SAYS when it next is');
  ok(sched.decide(GOOD, { nowMs: T0, lastRunMs: T0 - DAY }).run === true,
    'DUE-4 exactly at the boundary counts as due (a strict > would drift the cadence by one tick, forever)');
  const f = sched.decide(GOOD, { nowMs: T0, lastRunMs: T0 + DAY });
  ok(f.run === false && f.reason === 'future_last_run',
    'FUTURE-1 a last-run stamp in the FUTURE (clock skew, a restored backup) reads as recently measured, never as due');
  ok(sched.decide(GOOD, {}).run === false && sched.decide(GOOD, {}).reason === 'no_clock',
    'CLOCK-1 no clock → nothing runs (this module never reads a clock of its own)');
  ok(sched.decide({ ...GOOD, scenarios: [] }, { nowMs: T0 }).run === false,
    'INVALID-1 an invalid schedule never runs, whatever the clock says');
}

// ---- PICKING THE TICK'S WORK ----------------------------------------------
{
  const entries = [
    { id: 'a', schedule: GOOD, lastRunMs: T0 - 2 * DAY },
    { id: 'b', schedule: GOOD, lastRunMs: T0 - 9 * DAY },   // waited longest
    { id: 'c', schedule: GOOD, lastRunMs: T0 - HOUR },      // not due
    { id: 'd', schedule: { ...GOOD, scenarios: [] }, lastRunMs: T0 - 9 * DAY }, // invalid
  ];
  const one = sched.selectDue(entries, { nowMs: T0, maxPerTick: 1 });
  ok(one.run.length === 1 && one.run[0].id === 'b',
    'STARVE-1 the LONGEST-waiting schedule goes first, so a frequent one can never starve a rare one');
  ok(one.skipped === 1,
    'CAP-1 …and the overflow is COUNTED, never silently dropped — a cap that is too small must show as a standing number');
  ok(one.held.some((h) => h.id === 'c' && h.decision.reason === 'not_due') &&
     one.held.some((h) => h.id === 'd' && h.decision.reason === 'no_battery'),
    'HELD-1 everything not run is reported WITH its reason, so "why has this never run?" is answerable');
  const two = sched.selectDue(entries, { nowMs: T0, maxPerTick: 5 });
  ok(two.run.length === 2 && two.run.map((r) => r.id).join(',') === 'b,a' && two.skipped === 0,
    'CAP-2 a bigger cap runs both due schedules, still oldest-first');
  const never = sched.selectDue([{ id: 'n', schedule: GOOD }, { id: 'a', schedule: GOOD, lastRunMs: T0 - 2 * DAY }],
    { nowMs: T0, maxPerTick: 1 });
  ok(never.run[0].id === 'n', 'STARVE-2 a NEVER-run schedule is the most overdue thing there is, so it leads');
  ok(sched.selectDue([], { nowMs: T0 }).run.length === 0 && sched.selectDue(null, { nowMs: T0 }).run.length === 0 &&
     sched.selectDue([null, 'x'], { nowMs: T0 }).run.length === 0,
    'EMPTY-1 nothing to do, junk entries and a junk list all mean "run nothing" rather than a throw');
  ok(sched.selectDue(entries, { nowMs: T0, maxPerTick: 0 }).run.length === 1,
    'CAP-3 a zero/absent cap falls back to one per tick, never to unlimited');
}

// ---- it is a DECISION, not a runner ---------------------------------------
{
  const src = require('fs').readFileSync(require.resolve('../src/longterm/ppe/canary-schedule.js'), 'utf8');
  ok(!/require\((['"])\.\.\/db/.test(src) && !/fetch\(/.test(src) && !/Date\.now\(\)/.test(src),
    'PURE-1 no DB, no network and no clock of its own — every instant is injected, so the rule is testable');
  ok(!/\.\.\/\.\.\/(lib|routes|sync)\//.test(src), 'PURE-2 no RTL import (product separation)');
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
