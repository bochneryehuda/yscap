'use strict';
/**
 * LT PPE — the PER-INVESTOR DAILY schedule for the Lender-Price drift check (LT plan item #52 / D19).
 *
 * WHAT THE OWNER STATED, verbatim, and the ONLY numbers this module is allowed to know: the daily run
 * times are 10 / 11 / 12 AM ET, one per investor. So `ALLOWED_HOURS` is exactly [10, 11, 12], and a
 * schedule entry asking for any other hour is REFUSED — never silently accepted, because an invented
 * run time is an invented business rule. WHICH investor gets which of those three slots is a business
 * assignment the caller supplies; this module never invents an investor name and never invents a slot.
 *
 * PURE. No DB, no network, and — the point of the whole thing — no real timers. The clock is injected
 * as an epoch-ms `nowMs`, and "what wall-clock hour is it in ET right now?" is answered with the
 * built-in `Intl.DateTimeFormat` in `America/New_York` (ICU, no dependency), which is DST-correct: the
 * same investor at 11 AM ET is a different epoch in July than in January, and this reads the real ET
 * wall clock rather than a fixed UTC offset. A test passes any epoch it likes and no timer ever fires.
 *
 * "WHICH INVESTOR IS DUE" is decided against the ET CALENDAR DAY, not a rolling interval: an investor
 * runs at most ONCE per ET day, at or after its assigned hour, and a run is remembered by the ET day it
 * ran (`lastRunDay`, injected from the store). This is the correct model for "10 AM every day" — an
 * interval of 24h would drift earlier or later across DST and could fire twice or skip a day.
 *
 * FAILS TOWARD NOT RUNNING. No clock, an unknown hour, a malformed entry, or an already-ran-today
 * stamp all resolve to "not due" with a reportable reason — because a drift check that does not fire is
 * a visible gap on the scoreboard, while one that fires when it should not is a live vendor capture
 * nobody asked for.
 *
 * LT-only. No RTL imports.
 */

// The owner's stated run times. NOT tunable by env — these are a stated business rule, not a knob.
const ALLOWED_HOURS = Object.freeze([10, 11, 12]);
const ZONE = 'America/New_York';

// Reusable formatter (constructing one per call is the slow part of Intl). h23 so midnight reads as 0,
// never 24 — a '24' hour would compare wrong against an assigned hour of 10/11/12.
const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

/**
 * The ET wall-clock parts for an epoch. Returns { year, month, day, hour, minute, etDay:'YYYY-MM-DD' }
 * or null when nowMs is not a finite number (no clock -> nothing is due).
 */
function etParts(nowMs) {
  if (!Number.isFinite(Number(nowMs))) return null;
  const parts = {};
  for (const p of ET_FMT.formatToParts(new Date(Number(nowMs)))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0; // some ICU builds emit '24' for midnight under h23
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    etDay: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function normInvestor(v) { return v == null ? '' : String(v).trim(); }

/**
 * PURE — is this a schedule entry that could ever run?
 * Returns { ok, reason, message, investor, hourEt }.
 * An entry is { investor, hourEt } (hourEt in ALLOWED_HOURS). A blank investor or an hour outside the
 * owner's stated 10/11/12 is refused — the refusal is reportable so a mis-typed schedule is heard once,
 * in front of the person who saved it, not silently skipped every morning.
 */
function validateEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, reason: 'no_entry', message: 'A schedule entry must be an object { investor, hourEt }.' };
  }
  const investor = normInvestor(entry.investor);
  if (!investor) {
    return { ok: false, reason: 'no_investor', message: 'A schedule entry must name the investor it runs for — PILOT never invents one.' };
  }
  const hourEt = Number(entry.hourEt);
  if (!ALLOWED_HOURS.includes(hourEt)) {
    return { ok: false, reason: 'bad_hour',
      message: `The daily run times are ${ALLOWED_HOURS.join(' / ')} AM ET; this entry asks for hour ${entry.hourEt}, which is not one of them.` };
  }
  return { ok: true, reason: null, message: null, investor, hourEt };
}

/**
 * PURE — validate a whole schedule (a list of entries). Refuses a duplicate investor (two slots for one
 * investor is ambiguous — which one ran today?). Returns { ok, entries, errors } where `entries` is the
 * accepted, normalized set and `errors` names every rejected one (nothing is silently dropped).
 */
function validateSchedule(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const seen = new Set();
  const accepted = [];
  const errors = [];
  for (const e of list) {
    const v = validateEntry(e);
    if (!v.ok) { errors.push({ entry: e, reason: v.reason, message: v.message }); continue; }
    if (seen.has(v.investor.toLowerCase())) {
      errors.push({ entry: e, reason: 'duplicate_investor', message: `Investor "${v.investor}" already has a daily slot; one investor runs once per day.` });
      continue;
    }
    seen.add(v.investor.toLowerCase());
    accepted.push({ investor: v.investor, hourEt: v.hourEt });
  }
  return { ok: errors.length === 0, entries: accepted, errors };
}

/**
 * PURE — is ONE investor due to run RIGHT NOW?
 *   entry: { investor, hourEt }
 *   opts:  { nowMs, lastRunDay } — lastRunDay is the ET 'YYYY-MM-DD' it last ran (from the store), or
 *          null/'' if it has never run.
 * Returns { due, reason, message, investor, hourEt, etDay }.
 * DUE when: we have a clock, the entry is valid, the current ET hour is at or past the assigned hour,
 * and it has not already run on TODAY's ET day. Everything else is a reportable "not due".
 */
function decideInvestor(entry, opts = {}) {
  const v = validateEntry(entry);
  if (!v.ok) return { due: false, reason: v.reason, message: v.message, investor: normInvestor(entry && entry.investor) || null, hourEt: null, etDay: null };

  const parts = etParts(opts.nowMs);
  if (!parts) {
    return { due: false, reason: 'no_clock', message: 'No clock was supplied, so nothing is scheduled.', investor: v.investor, hourEt: v.hourEt, etDay: null };
  }
  const lastRunDay = opts.lastRunDay == null || opts.lastRunDay === '' ? null : String(opts.lastRunDay);
  if (lastRunDay === parts.etDay) {
    return { due: false, reason: 'ran_today', message: `${v.investor} already ran on ${parts.etDay}.`, investor: v.investor, hourEt: v.hourEt, etDay: parts.etDay };
  }
  if (parts.hour < v.hourEt) {
    return { due: false, reason: 'before_hour', message: `${v.investor} runs at ${v.hourEt}:00 ET; it is ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')} ET.`, investor: v.investor, hourEt: v.hourEt, etDay: parts.etDay };
  }
  return { due: true, reason: 'due', message: null, investor: v.investor, hourEt: v.hourEt, etDay: parts.etDay };
}

/**
 * PURE — the tick. Given the schedule and the clock, decide WHICH investors are due this minute.
 *   entries: [{ investor, hourEt }]
 *   opts: { nowMs, lastRunByInvestor } — lastRunByInvestor: { investorKey -> 'YYYY-MM-DD' } from the
 *          store (keyed by the trimmed, lower-cased investor name).
 * Returns { due: [decision...], held: [decision...], invalid: [error...] }.
 * `due` is what the caller should run now; `held` explains every investor that is NOT running and why
 * (nothing is silently skipped); `invalid` names malformed entries.
 */
function tick(entries, opts = {}) {
  const v = validateSchedule(entries);
  const lastRun = (opts.lastRunByInvestor && typeof opts.lastRunByInvestor === 'object') ? opts.lastRunByInvestor : {};
  const due = [];
  const held = [];
  for (const e of v.entries) {
    const key = e.investor.trim().toLowerCase();
    const d = decideInvestor(e, { nowMs: opts.nowMs, lastRunDay: lastRun[key] });
    if (d.due) due.push(d); else held.push(d);
  }
  // Earliest assigned hour first, so a 10 AM investor is offered before an 11 AM one on a tick that
  // finds several due at once (e.g. the first tick after a midday restart).
  due.sort((a, b) => a.hourEt - b.hourEt || a.investor.localeCompare(b.investor));
  return { due, held, invalid: v.errors };
}

module.exports = {
  ALLOWED_HOURS, ZONE,
  etParts, validateEntry, validateSchedule, decideInvestor, tick,
};
