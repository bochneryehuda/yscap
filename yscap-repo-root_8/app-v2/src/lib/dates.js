/**
 * Date-only formatting for the portal.
 *
 * A Postgres `date` column (date of birth, LLC formation date, expected/actual
 * closing, track-record dates, …) is a CALENDAR date — no time, no timezone. The
 * backend now serializes it as a bare 'YYYY-MM-DD' string (src/db.js OID-1082
 * parser). `new Date('2000-01-15')` parses that string as UTC midnight, and
 * `.toLocaleDateString()` renders it in the BROWSER's timezone — so a viewer
 * behind UTC (all of the US) sees the day BEFORE. That single misuse is the
 * root of "every date field is off by a day."
 *
 * parseDay() builds a Date from the calendar parts (LOCAL midnight) for a pure
 * date-only string, so the day never shifts. A value that carries a time
 * component (a real `timestamptz` instant such as created_at) has no all-day
 * ambiguity and is passed straight to `new Date()`, so those keep their correct
 * local-instant display. One helper is therefore safe for both kinds of column.
 */

/** Parse a date-only 'YYYY-MM-DD' (shift-free) or a full timestamp into a Date. */
export function parseDay(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);   // pure date-only, no time part
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s);
  return isNaN(d) ? null : d;
}

/** Localized calendar-date string, timezone-shift-free for date-only values.
 *  opts/locale mirror Date.prototype.toLocaleDateString(locale, opts). */
export function fmtDay(v, opts, locale) {
  const d = parseDay(v);
  return d ? d.toLocaleDateString(locale, opts) : '';
}

/** 'YYYY-MM-DD' string for binding an <input type="date"> value. */
export function dayInputValue(v) {
  if (v == null || v === '') return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  return m ? m[0] : '';
}
