'use strict';
/**
 * P5 — Outcome-based learning + causal postmortems (deterministic core, ADVISORY).
 *
 * The owner's Priority 5: today the system learns from underwriter CORRECTIONS
 * (feedback.js) and from a per-case postmortem (postmortem.js finds the earliest
 * failed COMPONENT from tagged causes). What's missing is the layer ABOVE a
 * single case — learning from what actually HAPPENED to a loan after we decided:
 * it funded and performed, an investor rejected it, a post-closing defect
 * surfaced, it defaulted early. This module turns a stream of those realized
 * OUTCOMES into a learning signal:
 *
 *   1. classifyOutcome(record)   — normalize a realized outcome into good / bad /
 *                                  neutral + a severity weight (a repurchase hurts
 *                                  more than an investor kickback).
 *   2. firstBadDecision(chain)   — walk a file's ORDERED decision chain and name
 *                                  the FIRST decision that was wrong — the first
 *                                  domino — plus every downstream decision it
 *                                  poisoned. Never guesses: an untagged chain
 *                                  returns null (request instrumentation).
 *   3. aggregateOutcomes(records)— portfolio rollup: defect rate, which COMPONENT
 *                                  is most often the first bad decision on a bad
 *                                  loan, investor-rejection reasons, defect types.
 *   4. learningSignals(agg, opts)— rank the recurring first-bad components into
 *                                  ADVISORY proposals ("review the <artifact>"),
 *                                  gated by a minimum sample so we never "learn"
 *                                  from one loan.
 *
 * Pure: no DB, no I/O, no AI. Advisory — it produces a hypothesis + a proposal a
 * human reviews (and an evaluation run gates, R5.42/R5.46). It NEVER changes a
 * decision, a rule, a threshold, a model, or a loan. It composes with
 * postmortem.build (per case) and error-taxonomy (component → artifact).
 */

const taxonomy = require('./error-taxonomy');
const { CAUSE_TO_ARTIFACT } = require('./postmortem');

// Realized loan outcomes and what each means for decision QUALITY.
//   quality 'good'    — reality confirmed our "yes" (a clean supervised positive)
//   quality 'bad'     — reality contradicted our decision (the learnable negative)
//   quality 'neutral' — no clean decision-quality signal (a decline we can't grade
//                       from the outcome alone; a borrower who walked away; a loan
//                       still too young to judge)
// `weight` scales a bad outcome by how costly it is (0 for non-bad).
const OUTCOMES = Object.freeze({
  funded_performing:   { quality: 'good',    weight: 0, label: 'Funded and performing' },
  paid_off:            { quality: 'good',    weight: 0, label: 'Paid off / performed to term' },
  funded:              { quality: 'neutral', weight: 0, label: 'Funded (performance unknown)' },
  declined:            { quality: 'neutral', weight: 0, label: 'Declined' },
  withdrawn:           { quality: 'neutral', weight: 0, label: 'Borrower withdrew' },
  expired:             { quality: 'neutral', weight: 0, label: 'Expired / lapsed' },
  investor_rejected:   { quality: 'bad',     weight: 2, label: 'Investor rejected the loan' },
  post_closing_defect: { quality: 'bad',     weight: 3, label: 'Post-closing defect found' },
  early_default:       { quality: 'bad',     weight: 4, label: 'Early payment default' },
  fraud_discovered:    { quality: 'bad',     weight: 5, label: 'Fraud discovered after the fact' },
  repurchase:          { quality: 'bad',     weight: 5, label: 'Forced repurchase / buyback' },
});

function normOutcomeKey(v) {
  return String(v == null ? '' : v).toLowerCase().trim().replace(/[\s-]+/g, '_');
}

/**
 * classifyOutcome(record | outcomeString) → { code, known, quality, bad, good,
 *   terminal, weight, label }.
 * An unknown outcome is `known:false`, quality 'neutral' — never guessed into a
 * defect (absence of a mapping is not a bad loan).
 */
function classifyOutcome(record) {
  const raw = record && typeof record === 'object' ? record.outcome : record;
  const code = normOutcomeKey(raw);
  const meta = OUTCOMES[code];
  if (!meta) {
    return { code: code || null, known: false, quality: 'neutral', bad: false, good: false, terminal: false, weight: 0, label: null };
  }
  return {
    code,
    known: true,
    quality: meta.quality,
    bad: meta.quality === 'bad',
    good: meta.quality === 'good',
    terminal: meta.quality !== 'neutral',
    weight: meta.weight,
    label: meta.label,
  };
}

/**
 * firstBadDecision(decisions) → { component, index, decision, label, artifact,
 *   poisonedDownstream:[...] } | null.
 *   decisions: ORDERED (earliest → latest) [{ component, decision?, correct }]
 *   `correct` is a boolean; the FIRST entry with correct === false is the first
 *   bad decision. Anything after it is "poisoned downstream" — the symptoms one
 *   upstream fix would likely clear. `correct` left null/undefined means "not
 *   graded" and is NOT treated as wrong (never guess a decision was bad).
 * Returns null when no decision is graded wrong (either all correct, or nothing
 * is tagged — the caller should request instrumentation, not invent a culprit).
 */
function firstBadDecision(decisions) {
  const list = Array.isArray(decisions) ? decisions : [];
  const idx = list.findIndex((d) => d && d.correct === false);
  if (idx === -1) return null;
  const d = list[idx];
  const component = d.component || null;
  // Map to the artifact a fix would target, when the component is a known
  // error-taxonomy cause; otherwise leave null (don't fabricate a target).
  const artifact = component && taxonomy.isValidCause(component) ? (CAUSE_TO_ARTIFACT[component] || null) : null;
  return {
    component,
    index: idx,
    decision: d.decision != null ? d.decision : null,
    label: component && taxonomy.isValidCause(component) ? taxonomy.labelOf(component) : (component || null),
    artifact,
    // Every decision after the first bad one — one fix upstream likely clears these.
    poisonedDownstream: list.slice(idx + 1).map((x, k) => ({
      component: (x && x.component) || null,
      index: idx + 1 + k,
      decision: (x && x.decision != null) ? x.decision : null,
    })),
  };
}

function inc(obj, key) { if (key == null) return; obj[key] = (obj[key] || 0) + 1; }
function rate(n, d) { return d > 0 ? +(n / d).toFixed(4) : 0; }

/**
 * aggregateOutcomes(records) → {
 *   total, byOutcome, good, bad, neutral, graded, unknownOutcomes,
 *   defectRate,              // bad / (good + bad) — among loans with a quality signal
 *   weightedDefectScore,     // Σ weight of bad outcomes / graded (severity-aware)
 *   firstBadByComponent,     // { [component]: count } across BAD loans
 *   isolatedBad, unisolatedBad, // bad loans we could / could not name a first-bad-decision for
 *   investorRejectReasons,   // { [reason]: count }
 *   defectTypes,             // { [defectType]: count }
 * }
 *   records: [{ fileId?, outcome, decisions?, investorRejectReason?, defectType? }]
 */
function aggregateOutcomes(records) {
  const list = Array.isArray(records) ? records : [];
  const byOutcome = {};
  const firstBadByComponent = {};
  const investorRejectReasons = {};
  const defectTypes = {};
  let good = 0, bad = 0, neutral = 0, unknownOutcomes = 0, weightSum = 0;
  let isolatedBad = 0, unisolatedBad = 0;

  for (const rec of list) {
    if (!rec) continue;
    const c = classifyOutcome(rec);
    inc(byOutcome, c.code || 'unknown');
    if (!c.known) unknownOutcomes++;
    if (c.good) good++;
    else if (c.bad) {
      bad++;
      weightSum += c.weight;
      const fb = firstBadDecision(rec.decisions);
      if (fb && fb.component) { inc(firstBadByComponent, fb.component); isolatedBad++; }
      else unisolatedBad++;
      if (rec.investorRejectReason != null) inc(investorRejectReasons, normOutcomeKey(rec.investorRejectReason));
      if (rec.defectType != null) inc(defectTypes, normOutcomeKey(rec.defectType));
    } else neutral++;
  }

  const graded = good + bad;
  return {
    total: list.length,
    byOutcome,
    good, bad, neutral, unknownOutcomes,
    graded,
    defectRate: rate(bad, graded),
    weightedDefectScore: rate(weightSum, graded),
    firstBadByComponent,
    isolatedBad, unisolatedBad,
    investorRejectReasons,
    defectTypes,
  };
}

/**
 * learningSignals(aggregate, { minSample }) → [{ component, label, artifact,
 *   count, share, severity, recommendation }] ranked most-recurring first.
 * A component that is the first bad decision on >= minSample bad loans becomes an
 * ADVISORY proposal to review its artifact. Below minSample it is NOT surfaced
 * (we never "learn" from one or two loans). Advisory only — a human reviews and
 * an evaluation run gates any real change.
 */
function learningSignals(aggregate, opts = {}) {
  const minSample = opts.minSample != null ? opts.minSample : 3;
  const agg = aggregate || {};
  const byComp = agg.firstBadByComponent || {};
  const isolated = agg.isolatedBad || 0;
  const out = [];
  for (const component of Object.keys(byComp)) {
    const count = byComp[component];
    if (count < minSample) continue;
    const isCause = taxonomy.isValidCause(component);
    const artifact = isCause ? (CAUSE_TO_ARTIFACT[component] || null) : null;
    const share = rate(count, isolated);
    out.push({
      component,
      label: isCause ? taxonomy.labelOf(component) : component,
      artifact,
      count,
      share, // share of the ISOLATED bad loans whose first bad decision was here
      severity: share >= 0.5 ? 'high' : share >= 0.25 ? 'medium' : 'low',
      recommendation: artifact
        ? `${component} is the first bad decision on ${count} bad loan(s) (${(share * 100).toFixed(0)}% of isolated defects) — propose a review of the ${artifact} artifact, gated by an evaluation run. Advisory only.`
        : `${component} is the first bad decision on ${count} bad loan(s) — investigate this component; add instrumentation to map it to a fixable artifact. Advisory only.`,
    });
  }
  out.sort((a, b) => (b.count - a.count) || (b.share - a.share) || (a.component < b.component ? -1 : a.component > b.component ? 1 : 0));
  return out;
}

module.exports = {
  classifyOutcome,
  firstBadDecision,
  aggregateOutcomes,
  learningSignals,
  OUTCOMES,
  _internals: { normOutcomeKey },
};
