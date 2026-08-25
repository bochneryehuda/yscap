'use strict';
/**
 * LONG-TERM — a ZONELESS Encompass wall-clock reading turned into a real instant.
 *
 * WHY THIS EXISTS (owner-reported 2026-08-25: three Sherman Ave files that never
 * filled in, a loan stuck on "File started" after LO Prep completed, and "Pull
 * everything from Encompass" appearing to do nothing — ONE cause behind all three).
 *
 * Encompass's pipeline reports a loan's last-changed time as a bare wall clock in
 * the INSTANCE'S OWN timezone, with no offset on it: `"8/14/2026 10:48:18 AM"`.
 * `discover.parsePipelineDate` fed those numbers to `Date.UTC(...)`, which reads the
 * same digits as LONDON time — so every stamp landed FOUR HOURS EARLY (five in
 * winter), and that error went straight into the engine that decides whether a loan
 * is worth re-reading:
 *
 *     needsRead: encompass_last_modified > encompass_synced_at
 *
 * `encompass_synced_at` is a true instant (`now()`). `encompass_last_modified` was
 * four hours behind reality. So a loan edited at 10:48 New York, less than two hours
 * after PILOT last read it at 09:00, compared as 10:48Z against 13:00Z and answered
 * NOT DUE. MEASURED, not reasoned about — the reproduction is section 1 of
 * `scripts/test-lt-tenant-time-pure.js`.
 *
 * THE CONSEQUENCE IS THE WHOLE BUG. A loan is read once, when discovery first finds
 * it, and every change made in the following four hours is invisible for ever — the
 * stamp can never overtake a `synced_at` that was set later than the edit. A file
 * discovered while it was still empty (a brand-new file: the Sherman Ave three) stays
 * empty; a file whose milestone completes inside the window keeps the milestone it
 * had; and the full-pull button correctly finds nothing to do and looks broken.
 *
 * THE FIX IS NOT ONLY THIS MODULE. A stamp is a fragile thing to hang a mirror on —
 * a timezone, a clock skew, a field the tenant stops returning — so `loans.needsRead`
 * also re-reads every loan on a ROTA regardless of what the stamps say. This module
 * makes the stamp right; the rota makes a wrong stamp survivable. Keep both.
 *
 * PURE. `Intl` only — no requires, no database, no network, no dependency.
 */

/** The tenant's own timezone. Same shape and default as the ClickUp side's
 *  `CLICKUP_DATE_TZ`, which has been reading this tenant's dates correctly since it
 *  shipped — this module is that lesson applied to the Encompass side. */
const DEFAULT_TZ = 'America/New_York';

const tzName = () => String(process.env.LT_ENCOMPASS_TZ || DEFAULT_TZ).trim() || DEFAULT_TZ;

/**
 * What a given instant reads as on a wall clock in `tz`.
 * Returns null for a zone `Intl` does not know — the caller then degrades rather
 * than throwing, because a mis-set environment variable may not stop the sync.
 */
function wallClockOf(ms, tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      // h23 rather than hour12:false — some runtimes render midnight as "24"
      // under the latter, which would put the correction a day out.
      hourCycle: 'h23',
    }).formatToParts(new Date(ms));
  } catch (e) {
    return null;
  }
  const get = (t) => {
    const p = parts.find((x) => x.type === t);
    return p ? Number(p.value) : NaN;
  };
  const out = { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
  for (const k of Object.keys(out)) if (!Number.isFinite(out[k])) return null;
  return out;
}

/**
 * A wall-clock reading in `tz` → the UTC instant (ms) it names.
 *
 * TWO PASSES, AND THE SECOND IS NOT DECORATION: the first correction uses the zone's
 * offset at the WRONG instant, and across a daylight-saving change that offset
 * differs from the one at the right instant — so a single pass lands an hour out on
 * exactly the two days a year somebody would least expect it. The loop stops as soon
 * as it stops moving.
 *
 * AN AMBIGUOUS HOUR (the repeated hour when the clocks go back) names two real
 * instants and this returns one of them. That is one hour of stamps, once a year, an
 * hour out — which the re-read rota absorbs. It is recorded rather than hidden.
 *
 * Falls back to reading the numbers as UTC — the historic behaviour — when the zone
 * is unusable, so a bad `LT_ENCOMPASS_TZ` degrades to what shipped before rather
 * than breaking every read.
 */
function wallClockToUtcMs(y, mo, d, h, mi, s, tz = tzName()) {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  if (!Number.isFinite(asUtc)) return null;
  let guess = asUtc;
  for (let i = 0; i < 2; i += 1) {
    const seen = wallClockOf(guess, tz);
    if (!seen) return asUtc; // unknown zone → the old reading, never a throw
    const seenAsUtc = Date.UTC(seen.y, seen.mo - 1, seen.d, seen.h, seen.mi, seen.s);
    const offset = seenAsUtc - guess;
    const next = asUtc - offset;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/** True when `Intl` can actually work in this zone — surfaced so a screen can say
 *  the timezone setting is wrong instead of quietly reading dates as UTC. */
function zoneUsable(tz = tzName()) {
  return wallClockOf(Date.UTC(2026, 0, 15, 12, 0, 0), tz) !== null;
}

module.exports = { wallClockToUtcMs, wallClockOf, zoneUsable, tzName, DEFAULT_TZ };
