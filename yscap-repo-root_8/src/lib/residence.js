'use strict';

/**
 * Residence duration = an anchored MOVE-IN DATE, computed live (owner-directed
 * 2026-07-14). The borrower enters "2 years 3 months" once; we store the move-in
 * date and recompute the duration whenever it's read, so a file started months
 * later reflects the real elapsed time — without the borrower re-typing it and
 * without the frontend doing date math. db/098 holds the schema + backfill.
 */

const MONTH_MS = 365.2425 / 12 * 86400000;

/** count (years, months) at a reference instant → an anchored move-in Date. */
function moveInFrom(years, months, asOf = new Date()) {
  const y = Number(years) || 0;
  const m = parseInt(months, 10) || 0;
  const totalMonths = y * 12 + m;
  if (totalMonths <= 0) return null;
  const d = new Date(asOf.getTime());
  // Whole months back, then the fractional-year remainder in days.
  const wholeMonths = Math.floor(totalMonths);
  d.setMonth(d.getMonth() - wholeMonths);
  const fracDays = Math.round((totalMonths - wholeMonths) * (MONTH_MS / 86400000));
  if (fracDays) d.setDate(d.getDate() - fracDays);
  return d;
}

/** A move-in date → the LIVE {years, months, totalMonths} as of now.
 *  `since` is a `date` column, which now arrives as a raw 'YYYY-MM-DD' string
 *  (db.js OID-1082 parser). `new Date('YYYY-MM-DD')` parses as UTC midnight, so
 *  reading .getFullYear()/.getMonth()/.getDate() in a behind-UTC server TZ
 *  would shift the day back one — the very bug the parser fix removes. Parse the
 *  date-only string into LOCAL calendar components so the month math is exact. */
function durationSince(since, now = new Date()) {
  if (!since) return null;
  let from;
  const m = typeof since === 'string' && /^(\d{4})-(\d{2})-(\d{2})/.exec(since);
  if (m) from = new Date(+m[1], +m[2] - 1, +m[3]);          // local-midnight calendar date
  else from = since instanceof Date ? since : new Date(since);
  if (isNaN(from)) return null;
  let months = (now.getFullYear() - from.getFullYear()) * 12 + (now.getMonth() - from.getMonth());
  if (now.getDate() < from.getDate()) months -= 1;
  if (months < 0) months = 0;
  return { years: Math.floor(months / 12), months: months % 12, totalMonths: months };
}

/** Attach the live duration to a borrower/profile row (mutates + returns it).
 *  residence_since wins when present; otherwise the stored count is the source
 *  of truth (an old row not yet re-entered under the new model). */
function withLiveResidence(row, now = new Date()) {
  if (!row) return row;
  const live = durationSince(row.residence_since, now);
  if (live) {
    row.years_at_residence = live.years;      // whole years for the numeric input
    row.months_at_residence = live.months;
    row.residence_total_months = live.totalMonths;
  }
  return row;
}

module.exports = { moveInFrom, durationSince, withLiveResidence };
