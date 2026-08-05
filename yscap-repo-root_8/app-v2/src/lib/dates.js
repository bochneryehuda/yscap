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
 *  opts/locale mirror Date.prototype.toLocaleDateString(locale, opts).
 *
 *  DEFAULT is the industry-standard US format MM/DD/YYYY (owner-directed
 *  2026-07-29). A caller that wants a different shape passes its own opts
 *  (e.g. { month:'short', day:'numeric', year:'numeric' } → "Jul 27, 2026"). */
const MDY = { month: '2-digit', day: '2-digit', year: 'numeric' };
export function fmtDay(v, opts, locale) {
  const d = parseDay(v);
  if (!d) return '';
  return opts ? d.toLocaleDateString(locale, opts) : d.toLocaleDateString('en-US', MDY);
}

/** Explicit MM/DD/YYYY (industry standard) — shift-free for date-only values.
 *  Returns the given placeholder (default '—') for an empty/unparseable value,
 *  so it can drop straight into the many `String(v).slice(0,10)` wrappers. */
export function fmtDate(v, placeholder = '—') {
  const d = parseDay(v);
  return d ? d.toLocaleDateString('en-US', MDY) : placeholder;
}

/** Localized DATE + TIME for a real timestamp (signed_off_at, reviewed_at, …) —
 *  used by the condition/document audit trail, which must show the exact date AND
 *  time. Returns the placeholder for an empty/unparseable value. A timestamptz
 *  carries a real instant, so it is passed straight to new Date() (no shift-free
 *  handling needed, unlike a date-only column). */
export function fmtDateTime(v, placeholder = '') {
  if (v == null || v === '') return placeholder;
  const d = new Date(String(v));
  if (isNaN(d)) return placeholder;
  return d.toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** 'YYYY-MM-DD' string for binding an <input type="date"> value. */
export function dayInputValue(v) {
  if (v == null || v === '') return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  return m ? m[0] : '';
}
