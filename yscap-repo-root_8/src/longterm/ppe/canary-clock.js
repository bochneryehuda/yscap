/**
 * LT PPE — WHEN THE DAILY LENDER PRICE CHECK RUNS.
 *
 * OWNER-DIRECTED 2026-08-18, in the owner's own words:
 *
 *   "This should be a scheduled run: Every day at 9:00 a.m. Eastern, 10:00 a.m. Eastern,
 *    11:00 a.m. Eastern, 12:00 p.m. Eastern, 4:00 p.m. Eastern, and 7:00 a.m. Eastern."
 *
 * That answers the driver question recorded as §2.49 — the choice was between a scheduled job at the
 * hosting provider, the sync worker, and a timer inside the application, and the owner picked a
 * SCHEDULE. This module is the ONE place those six hours are written down. The cron entry that wakes
 * the process, the tick that decides whether this is one of them, and the screen that tells an
 * operator when the next one is all read it from here, so the schedule cannot be stated twice and
 * drift.
 *
 * ⛔ WHY THE HOURS ARE NOT SIMPLY A CRON EXPRESSION. Render's scheduler is UTC and the owner named
 * EASTERN hours, which are UTC-5 for part of the year and UTC-4 for the rest. A UTC cron pinned to
 * one of those is an hour wrong for roughly half the year, every year, silently — and each firing
 * costs a live vendor call, so "an hour early twice a year" is not a cosmetic drift. So the cron wakes
 * the process every hour and THIS decides, against the actual New York clock, whether the hour it
 * woke in is one of the six. Twice a year it simply does not fire on the hour that is not there.
 *
 * ⛔ AND WHY `Intl`, NOT AN OFFSET TABLE. `Intl.DateTimeFormat` with `timeZone: 'America/New_York'`
 * asks the platform's own zone database, which is updated with the platform. A hand-written "March to
 * November" rule is a copy of that database that stops being true the year a legislature moves the
 * dates — and the United States has had that bill in front of it more than once.
 *
 * Long-Term only: no RTL import, no database, no clock of its own (the caller passes the instant), so
 * this is a pure function of a moment in time and is unit-testable without waiting for one.
 */
'use strict';

// THE OWNER'S SIX HOURS, in New York local time, in the order they occur.
const EASTERN_HOURS = Object.freeze([7, 9, 10, 11, 12, 16]);
const ZONE = 'America/New_York';

// The New York wall-clock parts of an instant. Returns null rather than guessing if the platform
// cannot resolve the zone — a scheduler that cannot read the clock must not fire on a guess.
function easternParts(atMs) {
  const t = Number(atMs);
  if (!Number.isFinite(t)) return null;
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: ZONE, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const p = {};
    for (const { type, value } of f.formatToParts(new Date(t))) p[type] = value;
    const hour = Number(p.hour) % 24; // some platforms render midnight as 24
    const out = { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour, minute: Number(p.minute) };
    if (!Object.values(out).every(Number.isFinite)) return null;
    out.day_key = `${p.year}-${p.month}-${p.day}`;
    return out;
  } catch (_) {
    return null;
  }
}

// Is this instant inside one of the six Eastern hours?
//
// FAILS CLOSED: an unreadable clock is NOT due. A daily comparison that is skipped is a gap somebody
// can see on the scoreboard; one that fires at an hour nobody chose spends the owner's money at the
// vendor and cannot be taken back.
function isDue(atMs) {
  const p = easternParts(atMs);
  if (!p) return { due: false, reason: 'clock_unreadable', detail: `The New York time zone could not be read on this machine, so no scheduled check was fired. The schedule is ${describeSchedule()}.` };
  if (!EASTERN_HOURS.includes(p.hour)) {
    return {
      due: false,
      reason: 'not_a_scheduled_hour',
      easternHour: p.hour,
      detail: `It is ${p.hour}:${String(p.minute).padStart(2, '0')} in New York, which is not one of the scheduled hours (${EASTERN_HOURS.join(', ')}).`,
    };
  }
  return {
    due: true,
    reason: 'scheduled_hour',
    easternHour: p.hour,
    // The slot key is what makes "once per scheduled hour" expressible: two wakings inside one
    // Eastern hour carry the same key, and a driver that has already run this key can decline the
    // second without a second vendor call.
    slotKey: `${p.day_key}T${String(p.hour).padStart(2, '0')}`,
    detail: `It is ${p.hour}:${String(p.minute).padStart(2, '0')} in New York — a scheduled hour.`,
  };
}

// The next scheduled instant strictly after `atMs`, as an epoch. Walks forward hour by hour and asks
// `isDue`, so it inherits the zone database rather than doing arithmetic on an offset — including
// across the two days a year that have 23 or 25 hours in them. Bounded: a schedule with no hours at
// all would otherwise loop, and the bound is generous enough to cross any real gap.
function nextRun(atMs) {
  const t = Number(atMs);
  if (!Number.isFinite(t) || !EASTERN_HOURS.length) return null;
  const HOUR = 3600000;
  // start at the top of the next hour so "now, during a scheduled hour" answers the NEXT one
  let probe = Math.floor(t / HOUR) * HOUR + HOUR;
  for (let i = 0; i < 24 * 3; i += 1) {
    if (isDue(probe).due) return probe;
    probe += HOUR;
  }
  return null;
}

function describeSchedule() {
  const label = (h) => (h === 12 ? '12pm' : h > 12 ? `${h - 12}pm` : `${h}am`);
  return `every day at ${EASTERN_HOURS.map(label).join(', ')} Eastern`;
}

module.exports = {
  EASTERN_HOURS, ZONE,
  isDue, nextRun, describeSchedule,
  _internals: { easternParts },
};
