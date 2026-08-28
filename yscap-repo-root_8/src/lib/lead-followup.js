'use strict';
/**
 * THE LEAD FOLLOW-UP REVIEW — one definition of "when is this lead due, and which
 * pile does it belong in?" (owner-directed 2026-08-28: "on the lead side need a
 * system to review leads per follow up date").
 *
 * The Lead CRM has carried a `next_follow_up` date since db/100 and has shown it in
 * two places — a column in the list and a "● due" flag on a board card. Neither of
 * those is a way to WORK the day: an officer with two hundred leads could not ask
 * "what is on me today, and what did I let slip?" without reading every row. This
 * module is the answer to that question, and it is deliberately ONE definition,
 * because the same buckets are counted on the server, coloured in the browser and
 * used to pick which leads a request returns. Three copies of "what counts as
 * overdue" is three different answers to the only question this screen exists for.
 *
 * ── THE PILES, and why these ones ──────────────────────────────────────────────
 *   overdue    the date has PASSED. The pile that matters: a lead you promised to
 *              call on Tuesday and it is Thursday.
 *   today      due today. The day's work.
 *   tomorrow   due tomorrow — separated from "this week" so an officer can see what
 *              is about to land before it lands.
 *   week       due within the next 7 days (tomorrow excluded — it has its own pile).
 *   later      dated, but further out than a week. Visible, not urgent.
 *   none       NO follow-up date at all. This is the pile nobody builds and everybody
 *              needs: a lead with no next step is not "not due", it is FORGOTTEN.
 *              Leaving it out of the review would make the review a way to lose leads.
 *
 * ── WHAT IS NOT IN THE REVIEW ─────────────────────────────────────────────────
 * A lead that is CLOSED — converted, lost or archived — has no follow-up owed on it,
 * whatever date is still sitting on the row. `isOpen` is the same open-stage set the
 * board's own scope filter uses (`OPEN_STAGES` in app-v2/src/lib/leadCrm.js), and the
 * mirror test fails the moment the two disagree.
 *
 * ── DATES ARE CALENDAR STRINGS, NEVER Date ARITHMETIC ─────────────────────────
 * `next_follow_up` is a Postgres `date` — a day, not an instant. Every comparison
 * here is a string comparison of 'YYYY-MM-DD' values, and "today" comes from the ONE
 * definition of the team's day (`order-sla.nyDay`, America/New_York). Reading the
 * server's own clock would tell an officer in New York at 8pm that tomorrow's work is
 * already overdue, because Render runs in UTC — the exact bug `nyDay` exists for.
 *
 * PURE: no database, no config, no requires beyond the shared day helper. Never throws.
 */

const { nyDay } = require('./order-sla');

/** The pipeline stages a lead is still WORKED in. Mirrors `OPEN_STAGES` in
    app-v2/src/lib/leadCrm.js — pinned by scripts/test-lead-followup-pure.js, which
    reads that file and fails if the two lists ever drift. */
const OPEN_STAGES = Object.freeze(['new', 'contacted', 'qualified', 'quoted', 'working', 'nurturing']);

/** The piles, in the order an officer works them: what slipped, then today, then
    what is coming, then the leads with no next step at all. */
const BUCKETS = Object.freeze([
  { key: 'overdue',  label: 'Overdue',        blurb: 'The date has passed — these slipped.' },
  { key: 'today',    label: 'Due today',      blurb: 'Today’s calls.' },
  { key: 'tomorrow', label: 'Tomorrow',       blurb: 'Landing next.' },
  { key: 'week',     label: 'Next 7 days',    blurb: 'Coming up this week.' },
  { key: 'later',    label: 'Later',          blurb: 'Dated further out.' },
  { key: 'none',     label: 'No date set',    blurb: 'No next step — a lead with no date is a lead being forgotten.' },
]);
const BUCKET_KEYS = Object.freeze(BUCKETS.map((b) => b.key));
const BUCKET_SET = new Set(BUCKET_KEYS);

/** The piles that are WORK RIGHT NOW — what the desk's headline number counts, and
    what a "needs attention" badge anywhere else must mean. Overdue + today, never
    "everything with a date": a lead due next Thursday is not an unanswered task. */
const DUE_NOW_BUCKETS = Object.freeze(['overdue', 'today']);

/** A calendar day string ('YYYY-MM-DD') from anything the database or a caller can
    hand us — a `date` (pg gives a string), a timestamp, a Date, null. Returns null
    for anything that is not a real day, so an unreadable value lands in 'none'
    (no next step recorded) rather than being guessed into a pile. */
function dayString(v) {
  if (v == null || v === '') return null;
  let s;
  if (typeof v === 'string') s = v.slice(0, 10);
  else if (v instanceof Date) {
    if (!Number.isFinite(v.getTime())) return null;
    // A `date` column arrives as a string; a Date here is a timestamp, and its
    // UTC day is the one the row was stored with.
    s = v.toISOString().slice(0, 10);
  } else return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** N days after a calendar day, by CALENDAR arithmetic (UTC epoch days), never by
    local Date maths — a local `new Date('2026-03-08')` shifts across a DST boundary
    and answers the wrong day twice a year. */
function addDays(day, n) {
  const s = dayString(day);
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Whether a lead is still being worked (and therefore still owes a follow-up). */
function isOpen(lead) {
  return OPEN_STAGES.includes(String((lead && lead.status) || ''));
}

/**
 * Which pile a lead belongs in, or null when it belongs in no pile at all (a closed
 * lead). `today` is passed in so a whole page is bucketed against ONE day — bucketing
 * row by row against `new Date()` can split a list across midnight.
 */
function bucketOf(lead, today) {
  if (!isOpen(lead)) return null;
  const t = dayString(today) || nyDay();
  const due = dayString(lead && (lead.next_follow_up != null ? lead.next_follow_up : lead.nextFollowUp));
  if (!due) return 'none';
  if (due < t) return 'overdue';
  if (due === t) return 'today';
  if (due === addDays(t, 1)) return 'tomorrow';
  if (due <= addDays(t, 7)) return 'week';
  return 'later';
}

/** How many days late (0 when not overdue, null when there is no date). Whole
    calendar days, so "yesterday" is 1 however the clocks moved. */
function daysOverdue(lead, today) {
  const t = dayString(today) || nyDay();
  const due = dayString(lead && (lead.next_follow_up != null ? lead.next_follow_up : lead.nextFollowUp));
  if (!due) return null;
  const [ty, tm, td] = t.split('-').map(Number);
  const [dy, dm, dd] = due.split('-').map(Number);
  const diff = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(dy, dm - 1, dd)) / 86400000);
  return diff > 0 ? diff : 0;
}

/** A valid bucket key, or null. Used to validate a request's `?bucket=`. */
function normalizeBucket(v) {
  const s = String(v == null ? '' : v).trim();
  return BUCKET_SET.has(s) ? s : null;
}

/**
 * The SQL fragment that selects one bucket, given the alias of the leads table and
 * the placeholder holding today's date. The SERVER filters by bucket rather than the
 * browser, because this desk exists on books of hundreds of leads and a page-local
 * filter would answer "you have 3 overdue" on a desk holding 300.
 *
 * IT IS DERIVED FROM THE SAME PILE DEFINITION `bucketOf` applies, and
 * scripts/test-lead-followup-db.js runs every row of a real table through BOTH and
 * fails if one row lands differently — which is the only way two implementations of
 * one rule can be allowed to exist at all.
 *
 * `todayParam` must be a placeholder ($1, $2 …) holding a 'YYYY-MM-DD' string; no
 * value is ever interpolated into the SQL here.
 */
function bucketSql(alias, bucket, todayParam) {
  const f = `${alias}.next_follow_up`;
  const t = `${todayParam}::date`;
  switch (bucket) {
    case 'overdue':  return `(${f} IS NOT NULL AND ${f} < ${t})`;
    case 'today':    return `(${f} = ${t})`;
    case 'tomorrow': return `(${f} = ${t} + 1)`;
    case 'week':     return `(${f} > ${t} + 1 AND ${f} <= ${t} + 7)`;
    case 'later':    return `(${f} > ${t} + 7)`;
    case 'none':     return `(${f} IS NULL)`;
    default:         return null;
  }
}

/** The CASE expression that names every row's bucket in one grouped read — how the
    counts behind the tabs are taken. Built from `bucketSql` so the counts and the
    filtered rows can never be two different definitions. */
function bucketCaseSql(alias, todayParam) {
  const arms = BUCKET_KEYS
    .filter((k) => k !== 'none')
    .map((k) => `WHEN ${bucketSql(alias, k, todayParam)} THEN '${k}'`);
  return `CASE ${arms.join(' ')} ELSE 'none' END`;
}

/** The open-stage list as a SQL array literal placeholder companion — callers bind
    OPEN_STAGES itself; this is just the shared list so no route re-types it. */
module.exports = {
  OPEN_STAGES, BUCKETS, BUCKET_KEYS, DUE_NOW_BUCKETS,
  dayString, addDays, isOpen, bucketOf, daysOverdue, normalizeBucket,
  bucketSql, bucketCaseSql,
};
