'use strict';
/**
 * LT PPE — DAILY Lender-Price DRIFT detection + classification (LT plan item #52 / D19).
 *
 * This is the DAILY upstream-drift layer, and it is a DIFFERENT concern from `parity.js`/`finding.js`
 * (which ask "does OUR engine agree with LP today?"). This asks: "did LP ITSELF change between the
 * snapshot we captured yesterday and the one we captured today, and if so, is that change something we
 * may auto-apply, or something a human must review?"
 *
 * THE OWNER'S POLICY SPLIT IS THE WHOLE POINT, AND IT IS NOT NEGOTIABLE HERE:
 *   • BASE RATES change  -> auto-applyable (a numeric price refresh).
 *   • RULE / LLPA / eligibility / PPP change -> HUMAN REVIEW, ALWAYS. Never auto-applied.
 * These two are NEVER MIXED, and the separation is STRUCTURAL, not a heuristic: a snapshot has TWO
 * channels, and a diff in one channel can never be classified into the other.
 *   1. `baseRates`   — a flat map { rule_key -> number } of the base-price ladder cells. A diff here is
 *                      a BASE_RATE change.
 *   2. `fingerprint` — the scenario-battery RESULT fingerprint (a flat map { fingerprint_key -> value }
 *                      produced by pricing a FIXED battery of scenarios and recording ONLY the
 *                      rule-layer outputs: the adjustments applied, the eligibility verdicts, the PPP
 *                      options — NOT the final dollar price. This is the agreement-harness idea: run a
 *                      fixed battery and fingerprint it, and any move means a RULE/LLPA/eligibility/PPP
 *                      change even when base rates were untouched. Because the fingerprint deliberately
 *                      EXCLUDES base-rate-driven price, a base-rate refresh cannot move it — which is
 *                      what keeps the two channels genuinely independent.)
 *
 * ESCALATE, NEVER DROP. The base-rate auto-apply path is not "apply the numbers": it is "apply the ones
 * we can CONFIDENTLY apply, and escalate everything else to a human — never silently discard a cell."
 * A base-rate cell that was added, removed, went non-numeric, moved beyond a guardrail, or arrived in a
 * suspiciously large batch (a likely bad fetch) is ESCALATED to review, not applied and not dropped.
 * The coverage invariant (`applied + escalated === every touched base-rate cell`) is enforced
 * structurally, so a future edit that forgot a branch cannot make a cell vanish.
 *
 * PURE. No DB, no network, no clock. Reuses `ratesheet-diff.js` for the keyed set-difference and the
 * numeric guardrail so there is ONE definition of each. LT-only; no RTL imports.
 */

const RS = require('./ratesheet-diff');

// The rule dimensions. A fingerprint change is ALWAYS a rule change requiring review; the dimension is
// carried only so the review item can say WHICH kind of rule moved (a label for the human, never a
// gate — an LLPA and an eligibility flip both go to the same queue).
const DIMENSION = Object.freeze({
  BASE_RATE: 'base_rate',
  LLPA: 'llpa',
  ELIGIBILITY: 'eligibility',
  PPP: 'ppp',
  RULE: 'rule', // the fail-closed default: a fingerprint key we don't recognise is STILL a rule change.
});

// The finding `kind` each dimension produces (so the existing review-queue ranker treats them as the
// unknown -> `high` severity it already assigns; see review-queue.SEVERITY_BY_KIND). A base-rate cell
// that could not be auto-applied is `base_rate_escalated` — surfaced, never silently low.
const KIND = Object.freeze({
  llpa: 'llpa_change',
  eligibility: 'eligibility_change',
  ppp: 'ppp_change',
  rule: 'rule_change',
  base_rate: 'base_rate_escalated',
});

// Map a fingerprint cell key to a rule dimension. Keyed on the FIRST path segment (the upstream
// convention already used across the PPE fixtures: `llpa/...`, `elig/...`, `ppp/...`). ANYTHING we do
// not recognise falls to RULE — a change we can't name is the one that most needs a human, so it is
// never auto-anything and never dropped.
function ruleDimensionOf(key) {
  const head = String(key == null ? '' : key).split('/')[0].toLowerCase();
  if (head === 'llpa' || head === 'adj' || head === 'adjustment') return DIMENSION.LLPA;
  if (head === 'elig' || head === 'eligibility') return DIMENSION.ELIGIBILITY;
  if (head === 'ppp' || head === 'prepay' || head === 'prepayment') return DIMENSION.PPP;
  return DIMENSION.RULE;
}

// Normalize a snapshot channel to a flat object map; a missing/garbled channel reads as {} (an empty
// map diffs cleanly — a bad capture surfaces as "everything removed", which escalates, never as a
// crash).
function asMap(v) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }

/**
 * Detect drift between two daily snapshots, in TWO independent channels that are never mixed.
 *   prev / next: { baseRates: {key->num}, fingerprint: {key->value} }
 *   opts: passed through to ratesheet-diff.diffRulesets (roundTo, volatileKeys, canonicalizer version).
 * Returns { baseRate: <diff>, ruleChange: <diff> } — each is a ratesheet-diff result
 * (`added/removed/changed/unchanged/rebaselined`). A canonicalizer bump on EITHER channel rebaselines
 * THAT channel only.
 */
function detectDrift(prev = {}, next = {}, opts = {}) {
  const baseOpts = { roundTo: 1, ...opts };
  const baseRate = RS.diffRulesets(asMap(prev.baseRates), asMap(next.baseRates), baseOpts);
  const ruleChange = RS.diffRulesets(asMap(prev.fingerprint), asMap(next.fingerprint), opts);
  return { baseRate, ruleChange };
}

/**
 * Auto-apply the BASE-RATE channel — escalate, never drop.
 *   baseRateDiff: a ratesheet-diff result over the base-rate channel.
 *   opts: { maxDeltaMilli, maxPct, maxCellsChanged } -> the numeric guardrail (ratesheet-diff.classifyDiff).
 * Returns { applied: [...], escalated: [...], rebaselined, coverage }.
 *   `applied`   — base-rate cells whose numeric refresh is within every guardrail (safe to auto-apply).
 *   `escalated` — every OTHER touched base-rate cell (added, removed, non-numeric, over a guardrail,
 *                 or a bulk-escalated batch): it goes to a human, it is NEVER dropped.
 * The coverage invariant is enforced HERE: `applied + escalated` must equal every touched base-rate
 * cell. Anything the classifier somehow failed to place is force-escalated (fail closed), and
 * `coverage.ok` reports whether the accounting balanced — a caller/test can assert it.
 */
function autoApplyBaseRates(baseRateDiff = {}, opts = {}) {
  if (baseRateDiff.rebaselined) {
    // A canonicalizer bump is not a data change; there is nothing to apply and nothing to review.
    return { applied: [], escalated: [], rebaselined: true, coverage: { ok: true, touched: 0, applied: 0, escalated: 0 } };
  }
  const cls = RS.classifyDiff(baseRateDiff, opts);
  const applied = cls.autoApply.map((c) => ({ key: c.key, before: c.before, after: c.after, delta: c.delta }));

  // Escalate = the classifier's review set, PLUS any touched cell not accounted for by applied+review
  // (belt-and-suspenders: a future classifier bug cannot make a base-rate cell disappear silently).
  const escalated = cls.review.map((r) => ({ key: r.key, before: r.before, after: r.after, kind: r.kind, reason: r.reason }));
  const placed = new Set([...applied.map((a) => a.key), ...escalated.map((e) => e.key)]);

  const changed = baseRateDiff.changed || [];
  const added = baseRateDiff.added || [];
  const removed = baseRateDiff.removed || [];
  const everyTouched = [
    ...changed.map((c) => ({ key: c.key, before: c.before, after: c.after })),
    ...added.map((k) => ({ key: k, before: undefined, after: undefined })),
    ...removed.map((k) => ({ key: k, before: undefined, after: undefined })),
  ];
  for (const t of everyTouched) {
    if (!placed.has(t.key)) {
      escalated.push({ key: t.key, before: t.before, after: t.after, kind: 'unclassified',
        reason: 'base-rate cell could not be confidently classified — escalated to review rather than dropped' });
      placed.add(t.key);
    }
  }

  const touched = everyTouched.length;
  const coverage = { ok: (applied.length + escalated.length) === touched, touched, applied: applied.length, escalated: escalated.length };
  return { applied, escalated, rebaselined: false, coverage };
}

// Stable identity for a drift review item so the same drift on the next day merges onto one row
// (recurrence++) through the existing finding ledger rather than piling up duplicates.
function driftKey(investor, dimension, cellKey, changeType) {
  return ['lpdrift', String(investor == null ? '' : investor).trim().toLowerCase(),
    dimension, String(cellKey), changeType].join('|');
}

function changeTypeOf(cell) {
  if (cell.before === undefined && cell.after !== undefined) return 'added';
  if (cell.before !== undefined && cell.after === undefined) return 'removed';
  return 'changed';
}

/**
 * Build review-queue items for everything a human must look at: every RULE-CHANNEL change AND every
 * escalated base-rate cell. The records are produced in the EXISTING LT finding-record shape
 * (`key/investor/kind/diff/status/recurrence/firstSeenMs/lastSeenMs`) so they flow straight through
 * `review-queue.buildQueue` (which ranks an unknown kind at `high` — surfaced, never silently low) and
 * `finding-store.persistRun` if the caller chooses to persist them. NO SECOND QUEUE IS BUILT.
 *
 *   ctx: { investor, program, nowMs }
 */
function reviewItemsFor(ruleChangeDiff = {}, escalatedBaseRate = [], ctx = {}) {
  const now = typeof ctx.nowMs === 'number' && Number.isFinite(ctx.nowMs) ? ctx.nowMs : null;
  const investor = ctx.investor == null ? null : ctx.investor;
  const items = [];

  const pushRule = (cell) => {
    const dim = ruleDimensionOf(cell.key);
    const changeType = changeTypeOf(cell);
    items.push({
      key: driftKey(investor, dim, cell.key, changeType),
      investor,
      program: ctx.program || null,
      dimension: dim,
      channel: 'rule',
      kind: KIND[dim] || KIND.rule,
      scenario: cell.key,
      diff: { cellKey: cell.key, before: cell.before, after: cell.after, changeType },
      status: 'open',
      recurrence: 1,
      regressed: false,
      firstSeenMs: now,
      lastSeenMs: now,
    });
  };

  if (!ruleChangeDiff.rebaselined) {
    for (const c of (ruleChangeDiff.changed || [])) pushRule({ key: c.key, before: c.before, after: c.after });
    for (const k of (ruleChangeDiff.added || [])) pushRule({ key: k, before: undefined, after: 'present' });
    for (const k of (ruleChangeDiff.removed || [])) pushRule({ key: k, before: 'present', after: undefined });
  }

  for (const e of escalatedBaseRate) {
    const changeType = changeTypeOf(e);
    items.push({
      key: driftKey(investor, DIMENSION.BASE_RATE, e.key, changeType),
      investor,
      program: ctx.program || null,
      dimension: DIMENSION.BASE_RATE,
      channel: 'base_rate',
      kind: KIND.base_rate,
      scenario: e.key,
      diff: { cellKey: e.key, before: e.before, after: e.after, changeType, reason: e.reason },
      status: 'open',
      recurrence: 1,
      regressed: false,
      firstSeenMs: now,
      lastSeenMs: now,
    });
  }

  return items;
}

/**
 * Top-level: detect drift, split by the owner's policy, auto-apply the safe base-rate refreshes, and
 * produce the review queue for everything else. ONE call, PURE.
 *   prev / next: daily snapshots { baseRates, fingerprint }.
 *   ctx: { investor, program, nowMs } — carried onto the review items.
 *   opts: { maxDeltaMilli, maxPct, maxCellsChanged, roundTo, ... } (ratesheet-diff guardrail + canon).
 * Returns { applied, review, summary } where:
 *   applied — base-rate cells safe to auto-apply (numeric, within guardrails).
 *   review  — review-queue records (rule/LLPA/eligibility/PPP changes + escalated base-rate cells).
 *   summary — counts for a scoreboard.
 */
function detectAndClassify(prev = {}, next = {}, ctx = {}, opts = {}) {
  const drift = detectDrift(prev, next, opts);
  const auto = autoApplyBaseRates(drift.baseRate, opts);
  const review = reviewItemsFor(drift.ruleChange, auto.escalated, ctx);

  const byDimension = {};
  for (const r of review) byDimension[r.dimension] = (byDimension[r.dimension] || 0) + 1;

  const summary = {
    autoApplied: auto.applied.length,
    escalatedBaseRate: auto.escalated.length,
    ruleChanges: review.filter((r) => r.channel === 'rule').length,
    reviewTotal: review.length,
    byDimension,
    baseRateRebaselined: !!auto.rebaselined,
    ruleRebaselined: !!drift.ruleChange.rebaselined,
    coverageOk: auto.coverage.ok,
  };

  return { applied: auto.applied, review, summary, _drift: drift, _coverage: auto.coverage };
}

module.exports = {
  DIMENSION, KIND,
  ruleDimensionOf, detectDrift, autoApplyBaseRates, reviewItemsFor, detectAndClassify,
  _internals: { driftKey, changeTypeOf, asMap },
};
