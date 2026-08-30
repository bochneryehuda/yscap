'use strict';
/**
 * LONG-TERM — THE PER-PERSON SCORECARD.
 *
 * Owner-directed 2026-08-30: *"Set up a full reporting database on this so I can
 * start scoring how many files each processor has and her efficiency."*
 *
 * WHAT "EFFICIENCY" IS HERE, stated plainly because a score is only worth anything
 * if everybody reads it the same way: for each person, the SPANS THEY OWNED that
 * PILOT could actually measure — how many, how long on average, the median, the
 * best and the worst — plus how many of their files could NOT be measured and WHY.
 * It is a stopwatch, not a judgement: a long span may be a hard file, a slow
 * appraiser or a borrower who went quiet, and nothing here claims otherwise.
 *
 * THREE THINGS IT REFUSES TO DO, each of which would make it wrong:
 *
 *   1. IT NEVER COUNTS A BASELINE AS A DURATION. A file PILOT was already past
 *      when it started watching has no measurable span, and folding those in as
 *      zeros or as "today minus the stamp" would score every person on the day the
 *      sweep first ran. They are counted as UNKNOWN and shown as such.
 *   2. IT NEVER ATTRIBUTES A SPAN TO WHOEVER IS ON THE STEP NOW. The owner is
 *      right that a person's number must not move because somebody was reassigned
 *      last week, so the attribution is the SNAPSHOT taken when the step completed
 *      (db/642), falling back to the mirror only for a completion that predates
 *      that column — and the answer says which.
 *   3. IT NEVER PRINTS AN AVERAGE WITHOUT ITS SAMPLE. `measured` rides beside
 *      `avgDays` everywhere, so "11 days" on two of forty files can never read as
 *      the desk's performance.
 *
 * SEPARATION: reads `lt_loans` + `lt_loan_milestones` only.
 */

const spans = require('./spans');
const fields = require('./fields');
const stages = require('../stages');

/**
 * Every person who owned a scorecard span, with their figures.
 *
 * `opts.from` / `opts.to` narrow to spans that ENDED in a window — the right
 * question for "how did the desk do last month", because a span is only a fact
 * once it closes. `opts.spanKey` narrows to one span.
 */
async function scorecard(db, opts = {}) {
  const milestones = spans.milestoneNames(opts.milestones);
  const wanted = spans.scorecardSpans(opts.milestones)
    .filter((s) => !opts.spanKey || s.key === opts.spanKey);

  const out = [];
  for (const s of wanted) {
    out.push(await oneSpan(db, s, milestones, opts));
  }
  return {
    spans: out,
    window: { from: opts.from || null, to: opts.to || null },
    // Said out loud on every response, because a scorecard read without it is a
    // scorecard somebody will over-trust.
    caveat: 'A span is only measured when PILOT witnessed BOTH ends. A file that was already past a step the first time PILOT read it is counted as unknown, never as a duration.',
  };
}

async function oneSpan(db, span, milestones, opts) {
  const params = [];
  const bind = (v) => { params.push(v); return `$${params.length}`; };
  const from = fields.fromSql(pick(milestones, [span.from, span.to, span.ownerMilestone]), bind);

  const a = span.from;
  const b = span.to;
  const o = span.ownerMilestone;

  const measurable = `${a}.done AND ${b}.done
       AND ${a}.observed_done_at IS NOT NULL AND ${b}.observed_done_at IS NOT NULL
       AND NOT ${a}.observed_is_baseline AND NOT ${b}.observed_is_baseline
       AND ${b}.observed_done_at >= ${a}.observed_done_at`;

  const where = [fields.BASE_SCOPE];
  // The person is named by the SNAPSHOT first — the whole point of db/642.
  where.push(`COALESCE(${o}.done_associate_name, ${o}.associate_name) IS NOT NULL`);
  if (opts.from) where.push(`${b}.observed_done_at >= ${bind(opts.from)}::timestamptz`);
  if (opts.to) where.push(`${b}.observed_done_at < (${bind(opts.to)}::timestamptz + interval '1 day')`);

  const sql = `
    SELECT COALESCE(${o}.done_associate_id, ${o}.associate_id)                       AS who_id,
           COALESCE(${o}.done_associate_name, ${o}.associate_name)                   AS who,
           bool_or(${o}.done_associate_name IS NULL AND ${o}.associate_name IS NOT NULL) AS any_from_current,
           count(*)::int                                                             AS files,
           count(*) FILTER (WHERE ${measurable})::int                                AS measured,
           round(avg(EXTRACT(EPOCH FROM (${b}.observed_done_at - ${a}.observed_done_at)) / 86400.0)
                 FILTER (WHERE ${measurable})::numeric, 2)                           AS avg_days,
           round((percentile_cont(0.5) WITHIN GROUP (
                   ORDER BY EXTRACT(EPOCH FROM (${b}.observed_done_at - ${a}.observed_done_at)) / 86400.0)
                 FILTER (WHERE ${measurable}))::numeric, 2)                          AS median_days,
           round(min(EXTRACT(EPOCH FROM (${b}.observed_done_at - ${a}.observed_done_at)) / 86400.0)
                 FILTER (WHERE ${measurable})::numeric, 2)                           AS min_days,
           round(max(EXTRACT(EPOCH FROM (${b}.observed_done_at - ${a}.observed_done_at)) / 86400.0)
                 FILTER (WHERE ${measurable})::numeric, 2)                           AS max_days,
           count(*) FILTER (WHERE ${a}.observed_is_baseline OR ${b}.observed_is_baseline)::int AS baseline,
           count(*) FILTER (WHERE NOT (${a}.done AND ${b}.done))::int                AS in_flight
    ${from}
     WHERE ${where.join('\n       AND ')}
     GROUP BY 1, 2
     ORDER BY measured DESC, files DESC, who ASC`;

  let rows = [];
  let degraded = null;
  try {
    ({ rows } = await db.query(sql, params));
  } catch (e) {
    // A scorecard that cannot be read says so. Answering an empty list would read
    // as "nobody did any work", which is the confident wrong answer.
    degraded = String((e && e.message) || e).slice(0, 300);
  }

  const people = rows.map((r) => ({
    id: r.who_id || null,
    name: r.who,
    files: Number(r.files) || 0,
    measured: Number(r.measured) || 0,
    unknown: (Number(r.files) || 0) - (Number(r.measured) || 0),
    baselineFiles: Number(r.baseline) || 0,
    inFlightFiles: Number(r.in_flight) || 0,
    avgDays: numOrNull(r.avg_days),
    medianDays: numOrNull(r.median_days),
    minDays: numOrNull(r.min_days),
    maxDays: numOrNull(r.max_days),
    // TRUE when at least one of this person's files was attributed from the
    // CURRENT assignment rather than a completion snapshot — surfaced so nobody
    // reads a pre-db/642 file as proof of who did the work.
    someAttributionIsCurrent: r.any_from_current === true,
  }));

  return {
    key: span.key,
    label: span.label,
    blurb: span.blurb,
    ownerLabel: span.ownerLabel,
    from: span.fromMilestone,
    to: span.toMilestone,
    people,
    totals: rollUp(people),
    degraded,
  };
}

function rollUp(people) {
  const files = people.reduce((n, p) => n + p.files, 0);
  const measured = people.reduce((n, p) => n + p.measured, 0);
  // The desk's average is weighted by MEASURED spans, never the mean of the
  // people's averages — one person with two files would otherwise count as much
  // as one with forty.
  const weighted = people.reduce((n, p) => n + (p.avgDays == null ? 0 : p.avgDays * p.measured), 0);
  return {
    people: people.length,
    files,
    measured,
    unknown: files - measured,
    avgDays: measured ? Math.round((weighted / measured) * 100) / 100 : null,
  };
}

function pick(milestones, keys) {
  const out = {};
  for (const k of keys) if (k && milestones[k]) out[k] = milestones[k];
  return out;
}

function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * ONE FILE'S OWN TIMELINE — every span it has, measured, plus the ladder history
 * PILOT witnessed. This is the "how long did THIS file take between which and
 * which step, and who had it" half of the owner's ask.
 */
async function fileTimeline(db, loanId, opts = {}) {
  let ladder = [];
  let events = [];
  let degraded = null;
  try {
    ({ rows: ladder } = await db.query(
      `SELECT milestone_name, position, done, start_date,
              observed_done_at, observed_is_baseline,
              associate_id, associate_name, associate_role,
              done_associate_id, done_associate_name
         FROM lt_loan_milestones WHERE loan_id = $1::uuid ORDER BY position`,
      [String(loanId)],
    ));
    ({ rows: events } = await db.query(
      `SELECT milestone_name, event_type, position, encompass_date,
              from_associate_name, to_associate_name, to_associate_role, observed_at
         FROM lt_ladder_events WHERE loan_id = $1::uuid
         ORDER BY observed_at DESC LIMIT 200`,
      [String(loanId)],
    ));
  } catch (e) {
    degraded = String((e && e.message) || e).slice(0, 300);
  }

  return {
    spans: spans.spansForLoan(ladder, opts.milestones),
    ladder: ladder.map((r) => ({
      milestone: r.milestone_name,
      // The normalised key beside the tenant's own spelling, so a screen can match
      // a row against a configured milestone name without re-implementing
      // `stages.milestoneKey` in the browser and drifting from it.
      key: stages.milestoneKey(r.milestone_name),
      position: r.position,
      done: r.done,
      // Encompass's own date for the step, and OUR observation of it, side by
      // side — they answer different questions and must never be merged.
      encompassDate: r.start_date,
      observedDoneAt: r.observed_is_baseline ? null : r.observed_done_at,
      wasAlreadyDone: !!r.observed_is_baseline,
      assignedTo: r.associate_name || null,
      assignedRole: r.associate_role || null,
      completedBy: r.done_associate_name || null,
    })),
    history: events.map((e) => ({
      milestone: e.milestone_name,
      what: e.event_type,
      at: e.observed_at,
      encompassDate: e.encompass_date,
      from: e.from_associate_name || null,
      to: e.to_associate_name || null,
      role: e.to_associate_role || null,
      // A baseline is the one event that must never be read as a completion.
      isBaseline: e.event_type === 'observed_baseline',
    })),
    degraded,
  };
}

module.exports = { scorecard, fileTimeline, _internals: { rollUp, pick } };
