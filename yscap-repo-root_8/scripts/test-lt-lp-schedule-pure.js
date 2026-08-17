'use strict';
/**
 * Pure offline test for the LT PPE per-investor DAILY schedule + tick
 * (src/longterm/ppe/lp-daily-schedule.js).
 *   node scripts/test-lt-lp-schedule-pure.js
 *
 * Proves: the tick decides WHICH investor is due given an injected America/New_York clock (no real
 * timer), the owner's stated 10/11/12 AM ET run times are the only ones accepted, once-per-ET-day is
 * enforced, and the ET reading is DST-correct. Mutation-proven — see the report.
 */

const assert = require('assert');
const S = require('../src/longterm/ppe/lp-daily-schedule');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };

// Helpers to build a real epoch for a UTC instant.
const utc = (y, mo, d, h, mi) => Date.UTC(y, mo, d, h, mi);

// ---- DST correctness: 10:30 AM ET is a DIFFERENT epoch in July (EDT) vs January (EST) --------------
(() => {
  const summer = S.etParts(utc(2025, 6, 15, 14, 30)); // 14:30 UTC = 10:30 EDT (UTC-4)
  eq(summer.hour, 10, 'July 14:30 UTC reads as 10 AM ET (EDT)');
  eq(summer.etDay, '2025-07-15', 'ET day in summer');
  const winter = S.etParts(utc(2025, 0, 15, 15, 30)); // 15:30 UTC = 10:30 EST (UTC-5)
  eq(winter.hour, 10, 'January 15:30 UTC reads as 10 AM ET (EST) — DST handled, not a fixed offset');
  eq(winter.etDay, '2025-01-15', 'ET day in winter');
})();

// ---- no clock -> nothing is due -------------------------------------------------------------------
(() => {
  eq(S.etParts(undefined), null, 'no clock -> no ET parts');
  const d = S.decideInvestor({ investor: 'AcmeCap', hourEt: 10 }, {});
  eq(d.due, false, 'no clock -> not due');
  eq(d.reason, 'no_clock', 'reason names it');
})();

// ---- the ONLY accepted hours are 10 / 11 / 12 (owner-stated); nothing else -------------------------
(() => {
  assert.deepStrictEqual([...S.ALLOWED_HOURS], [10, 11, 12], 'the stated run times'); n += 1;
  eq(S.validateEntry({ investor: 'X', hourEt: 9 }).ok, false, 'hour 9 refused');
  eq(S.validateEntry({ investor: 'X', hourEt: 13 }).ok, false, 'hour 13 refused');
  eq(S.validateEntry({ investor: 'X', hourEt: 9 }).reason, 'bad_hour', 'bad_hour reason');
  eq(S.validateEntry({ investor: '', hourEt: 10 }).reason, 'no_investor', 'a slot must name its investor');
  eq(S.validateEntry({ investor: 'X', hourEt: 11 }).ok, true, 'hour 11 accepted');
})();

// ---- a duplicate investor is refused (one slot per investor) ---------------------------------------
(() => {
  const v = S.validateSchedule([{ investor: 'AcmeCap', hourEt: 10 }, { investor: 'acmecap', hourEt: 11 }]);
  eq(v.ok, false, 'duplicate investor refused');
  eq(v.entries.length, 1, 'only the first slot accepted');
  eq(v.errors[0].reason, 'duplicate_investor', 'names the duplicate');
})();

// ---- the TICK at 11:30 AM ET: hour-10 and hour-11 investors due; hour-12 not yet --------------------
(() => {
  const now = utc(2025, 6, 15, 15, 30); // 15:30 UTC = 11:30 EDT
  const entries = [
    { investor: 'TenCap', hourEt: 10 },
    { investor: 'ElevenCap', hourEt: 11 },
    { investor: 'NoonCap', hourEt: 12 },
  ];
  const t = S.tick(entries, { nowMs: now, lastRunByInvestor: {} });
  const dueNames = t.due.map((d) => d.investor);
  assert.deepStrictEqual(dueNames, ['TenCap', 'ElevenCap'], 'the two past-hour investors are due, earliest first'); n += 1;
  eq(t.held.length, 1, 'the noon investor is held');
  eq(t.held[0].investor, 'NoonCap', 'held one is NoonCap');
  eq(t.held[0].reason, 'before_hour', 'not due because it is before 12 ET');
})();

// ---- once per ET day: an investor that already ran today is NOT due again ---------------------------
(() => {
  const now = utc(2025, 6, 15, 15, 30); // 11:30 EDT, ET day 2025-07-15
  const entries = [{ investor: 'TenCap', hourEt: 10 }];
  const t = S.tick(entries, { nowMs: now, lastRunByInvestor: { tencap: '2025-07-15' } });
  eq(t.due.length, 0, 'already ran today -> not due');
  eq(t.held[0].reason, 'ran_today', 'reason names it');
  // a DIFFERENT day stamp does not block today
  const t2 = S.tick(entries, { nowMs: now, lastRunByInvestor: { tencap: '2025-07-14' } });
  eq(t2.due.length, 1, 'yesterday\'s run does not block today');
})();

// ---- before its hour: a hour-12 investor at 11:30 ET is held, not run ------------------------------
(() => {
  const now = utc(2025, 6, 15, 15, 30); // 11:30 EDT
  const d = S.decideInvestor({ investor: 'NoonCap', hourEt: 12 }, { nowMs: now, lastRunDay: null });
  eq(d.due, false, 'before its hour -> not due');
  eq(d.reason, 'before_hour', 'before_hour');
  eq(d.etDay, '2025-07-15', 'still reports the ET day');
})();

// ---- exactly at the hour boundary: due at 12:00 ET, not at 11:59 ------------------------------------
(() => {
  const noon = S.decideInvestor({ investor: 'NoonCap', hourEt: 12 }, { nowMs: utc(2025, 6, 15, 16, 0), lastRunDay: null });
  eq(noon.due, true, 'due at exactly 12:00 ET');
  const justBefore = S.decideInvestor({ investor: 'NoonCap', hourEt: 12 }, { nowMs: utc(2025, 6, 15, 15, 59), lastRunDay: null });
  eq(justBefore.due, false, 'not due at 11:59 ET');
})();

// ---- invalid entries are surfaced, never silently dropped from the tick ----------------------------
(() => {
  const t = S.tick([{ investor: 'Good', hourEt: 10 }, { investor: 'Bad', hourEt: 8 }], { nowMs: utc(2025, 6, 15, 15, 0), lastRunByInvestor: {} });
  eq(t.invalid.length, 1, 'the bad-hour entry is reported');
  eq(t.invalid[0].reason, 'bad_hour', 'names why');
  ok(t.due.concat(t.held).every((d) => d.investor === 'Good'), 'only the valid investor is scheduled');
})();

console.log(`ok - lt lp daily schedule (${n} assertions)`);
