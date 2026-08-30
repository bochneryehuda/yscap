'use strict';
/**
 * LONG-TERM — THE SPANS A FILE IS MEASURED IN, and who owned each one.
 *
 * Owner-directed 2026-08-30:
 *   *"I need to have a full reporting center where I can see for every file how
 *    long it took between which and which step and who the processor was in that
 *    file, and then reporting per processor."*
 *   *"…one thing we need to track with the processor is FROM the submittal status
 *    is done UNTIL the CTC is done. That's the processor's job. And the loan setup
 *    guy, we need to track from the assign processor — which means LO setup done,
 *    LO prep completed — till the submittal is done. Set up a full reporting
 *    database on this so I can start scoring how many files each processor has and
 *    her efficiency."*
 *
 * PURE. No database, no network, no RTL import — every function takes what it
 * needs. That is what lets the whole rule be unit-tested, and it is why the SQL
 * that reads these spans lives next door in `query.js` rather than in here.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWO SPANS ARE THE OWNER'S OWN, AND THE MILESTONE NAMES ARE ALREADY SETTLED.
 *
 * "LO setup done, LO prep completed" is the SAME event this codebase already
 * records under the owner's earlier rule (2026-08-24, `stages.js`): *"when LO Prep
 * is completed, it's ASSIGNED TO PROCESSOR."* So the loan-setup span opens where
 * the completed wording says the file was handed over, and closes when Submittal
 * completes ("Submitted"). The processing span opens there and closes at Clear To
 * Close. Nothing here re-derives that vocabulary — `stages.js` owns it, and this
 * module names the milestones the tenant's own ladder uses.
 *
 * THE NAMES ARE DEFAULTS, NOT CONSTANTS. The tenant may rename a milestone in
 * Encompass at any time (the owner's standing rule: *"It should be exactly as it
 * is in Encompass"*), so every span carries its milestone names as CONFIGURABLE
 * values, keyed the way `stages.milestoneKey` keys them — so "Clear To Close",
 * "Clear to Close" and "CLEAR-TO-CLOSE" are one milestone whichever way a tenant
 * spells it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A SPAN IS ONLY A NUMBER WHEN BOTH ENDS ARE REAL OBSERVATIONS.
 *
 * `lt_loan_milestones.observed_is_baseline` marks a step that was ALREADY done the
 * first time PILOT read the loan — so its stamp is "when we started watching",
 * never "when it moved". A span resting on a baseline at either end is reported as
 * UNKNOWN, with the reason, and NEVER as a duration. That is the same discipline
 * db/554 applied to the milestone clock, and it is the whole reason the processor
 * scorecard can be trusted: the alternative is every file in the book showing a
 * same-day hand-off on the day the sweep first ran, which would be confidently
 * wrong on exactly the files this exists to measure.
 */

const stages = require('../stages');

/** The tenant's own milestone names, as the ladder returns them. Configurable. */
const DEFAULT_MILESTONES = {
  loPrep: 'LO Prep',
  loanSetup: 'Loan Setup',
  submittal: 'Submittal',
  condApproval: 'Cond. Approval',
  clearToClose: 'Clear To Close',
  funding: 'Funding',
};

/**
 * THE SPANS.
 *
 * `owner` names WHOSE work the span measures, and it is not decoration: it decides
 * which milestone's assigned associate the scorecard attributes the span to. The
 * loan-setup span is owned by whoever held LO PREP (the person doing the setup),
 * and the processing span by whoever held SUBMITTAL — because the processor is
 * assigned to the file at submittal and carries it to the clear to close, which is
 * exactly the hand-off the owner described.
 */
const DEFAULT_SPANS = [
  {
    key: 'loan_setup',
    label: 'Loan setup',
    blurb: 'From the file being assigned to the processor (LO Prep completed) until it is submitted.',
    from: 'loPrep',
    to: 'submittal',
    // The setup person is the one on LO Prep — the step they are completing.
    ownerMilestone: 'loPrep',
    ownerLabel: 'Loan setup',
  },
  {
    key: 'processing',
    label: 'Processing',
    blurb: 'From the file being submitted until it is cleared to close. This is the processor’s job.',
    from: 'submittal',
    to: 'clearToClose',
    // The processor owns the file from submittal onward.
    ownerMilestone: 'submittal',
    ownerLabel: 'Processor',
  },
];

/**
 * Two further spans the owner did not name but that fall out of the same ladder,
 * offered as REPORTS and never as a scorecard: nobody has told us whose work they
 * are, and attributing a duration to a person nobody named is the confident wrong
 * answer this file exists to avoid.
 */
const CONTEXT_SPANS = [
  {
    key: 'underwriting',
    label: 'Underwriting',
    blurb: 'From submitted to conditionally approved.',
    from: 'submittal',
    to: 'condApproval',
    ownerMilestone: null,
    ownerLabel: null,
  },
  {
    key: 'ctc_to_funding',
    label: 'Clear to close → funded',
    blurb: 'From the clear to close until the loan funds.',
    from: 'clearToClose',
    to: 'funding',
    ownerMilestone: null,
    ownerLabel: null,
  },
];

/** Every span, scorecard and context alike, in reading order. */
function allSpans(overrides) {
  const names = milestoneNames(overrides);
  return [...DEFAULT_SPANS, ...CONTEXT_SPANS].map((s) => ({
    ...s,
    fromMilestone: names[s.from],
    toMilestone: names[s.to],
    ownerMilestoneName: s.ownerMilestone ? names[s.ownerMilestone] : null,
    scorecard: !!s.ownerMilestone,
  }));
}

/** The spans a PERSON is scored on — the owner's two, and only those. */
function scorecardSpans(overrides) {
  return allSpans(overrides).filter((s) => s.scorecard);
}

/** One span by key, or null. */
function spanByKey(key, overrides) {
  return allSpans(overrides).find((s) => s.key === String(key || '')) || null;
}

/**
 * The tenant's milestone names, with any configured overrides laid over ours.
 * An override that is blank or not a string is IGNORED rather than allowed to
 * blank out a milestone name — a span pointing at `''` would silently match no
 * ladder row and report every file as unknown, which reads as "the report is
 * broken" rather than "somebody cleared a setting".
 */
function milestoneNames(overrides) {
  const out = { ...DEFAULT_MILESTONES };
  if (overrides && typeof overrides === 'object') {
    for (const k of Object.keys(DEFAULT_MILESTONES)) {
      const v = overrides[k];
      if (typeof v === 'string' && v.trim()) out[k] = v.trim();
    }
  }
  return out;
}

/**
 * WHY A SPAN COULD NOT BE MEASURED — the reader's own sentence, in one place.
 *
 * Every one of these is a DIFFERENT piece of work for a different person, which is
 * why they are not collapsed into one "no data": "the file has not got there yet"
 * is the pipeline working, "we were already past it when we started watching" is a
 * gap nothing can close, and "the ladder has no such step" means somebody renamed
 * a milestone and the setting has not followed.
 */
const REASON = {
  not_reached: 'The file has not reached this step yet.',
  baseline_start: 'This file was already past the start of this span the first time PILOT read it, so how long it took is not known.',
  baseline_end: 'This file was already past the end of this span the first time PILOT read it, so how long it took is not known.',
  no_step: 'This loan’s workflow has no such step.',
  backwards: 'The two steps completed out of order — the file moved backwards and forwards again, so a single duration would be misleading.',
};

/**
 * Measure ONE span from two ladder rows.
 *
 * `from` / `to` are `lt_loan_milestones` rows (or null when the loan has no such
 * step). Answers `{ ok, hours, days, reason, why, startedAt, endedAt }`:
 *   ok:true  — a real, measured duration between two witnessed completions.
 *   ok:false — `reason` names WHICH of the five states it is in and `why` is the
 *              sentence a person reads. NEVER a zero, never a guess.
 *
 * PURE and total: any unusable input answers a reason rather than throwing.
 */
function measureSpan(from, to) {
  if (!from || !to) return refuse('no_step');
  if (!from.done || !from.observed_done_at) return refuse('not_reached');
  if (!to.done || !to.observed_done_at) return refuse('not_reached');
  if (from.observed_is_baseline) return refuse('baseline_start');
  if (to.observed_is_baseline) return refuse('baseline_end');

  const a = new Date(from.observed_done_at).getTime();
  const b = new Date(to.observed_done_at).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return refuse('no_step');
  // A NEGATIVE span is a real state (a milestone was rolled back and re-completed),
  // and reporting it as a duration would put a negative day count in an average.
  if (b < a) return refuse('backwards');

  const hours = (b - a) / 3600000;
  return {
    ok: true,
    hours: round2(hours),
    days: round2(hours / 24),
    reason: null,
    why: null,
    startedAt: new Date(a).toISOString(),
    endedAt: new Date(b).toISOString(),
  };
}

function refuse(reason) {
  return { ok: false, hours: null, days: null, reason, why: REASON[reason] || null, startedAt: null, endedAt: null };
}

/**
 * WHO OWNED A SPAN on one file — the SNAPSHOT taken when the owning milestone
 * completed, falling back to whoever is on that step now.
 *
 * The snapshot is the point: `lt_loan_milestones.associate_*` is the MIRROR and
 * follows Encompass, so reading it would re-attribute every past duration the day
 * somebody is reassigned. `done_associate_*` does not move once written (db/642).
 * The mirror is the fallback ONLY for a step whose completion predates that
 * column, and the answer says which it used so nothing reads a fallback as a fact.
 */
function spanOwner(ownerRow) {
  if (!ownerRow) return { id: null, name: null, source: null };
  if (ownerRow.done_associate_id || ownerRow.done_associate_name) {
    return {
      id: ownerRow.done_associate_id || null,
      name: ownerRow.done_associate_name || null,
      source: 'snapshot',
    };
  }
  if (ownerRow.associate_id || ownerRow.associate_name) {
    return {
      id: ownerRow.associate_id || null,
      name: ownerRow.associate_name || null,
      source: 'current',
    };
  }
  return { id: null, name: null, source: null };
}

/**
 * Every span for ONE loan, from its whole ladder.
 *
 * `ladder` is the loan's `lt_loan_milestones` rows. Rows are keyed the way
 * `stages.milestoneKey` keys them, so a tenant's spelling of a milestone never
 * decides whether a span can be measured.
 */
function spansForLoan(ladder, overrides) {
  const byKey = new Map();
  for (const r of ladder || []) byKey.set(stages.milestoneKey(r.milestone_name), r);
  const pick = (name) => byKey.get(stages.milestoneKey(name)) || null;

  return allSpans(overrides).map((s) => {
    const measured = measureSpan(pick(s.fromMilestone), pick(s.toMilestone));
    return {
      key: s.key,
      label: s.label,
      blurb: s.blurb,
      from: s.fromMilestone,
      to: s.toMilestone,
      scorecard: s.scorecard,
      ownerLabel: s.ownerLabel,
      owner: s.ownerMilestoneName ? spanOwner(pick(s.ownerMilestoneName)) : { id: null, name: null, source: null },
      ...measured,
    };
  });
}

/**
 * Summarize a set of measured spans into the figures a scorecard shows.
 *
 * NOTHING IS INVENTED AND NOTHING IS HIDDEN: `measured` counts the spans that
 * produced a real duration, `unknown` counts the ones that did not, and the two
 * always add up to `files`. A screen that printed only the average would let a
 * scorecard built on two of forty files read as authoritative.
 *
 * The MEDIAN is reported beside the mean deliberately — one file stuck for four
 * months drags a mean far more than it drags a median, and on a book this size
 * that is the difference between a fair score and a misleading one.
 */
function summarizeSpans(list) {
  const rows = (list || []).filter(Boolean);
  const good = rows.filter((r) => r && r.ok && Number.isFinite(r.days));
  const days = good.map((r) => r.days).sort((a, b) => a - b);
  return {
    files: rows.length,
    measured: good.length,
    unknown: rows.length - good.length,
    avgDays: days.length ? round2(days.reduce((a, b) => a + b, 0) / days.length) : null,
    medianDays: days.length ? round2(median(days)) : null,
    minDays: days.length ? days[0] : null,
    maxDays: days.length ? days[days.length - 1] : null,
  };
}

function median(sorted) {
  const n = sorted.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

module.exports = {
  DEFAULT_MILESTONES,
  DEFAULT_SPANS,
  CONTEXT_SPANS,
  REASON,
  milestoneNames,
  allSpans,
  scorecardSpans,
  spanByKey,
  measureSpan,
  spanOwner,
  spansForLoan,
  summarizeSpans,
};
