'use strict';
/**
 * LT PPE — THE DOUBLE-CHARGE GUARD. Two PRICING rules that both cover one loan both ACCUMULATE onto
 * its price (rules.js §6.1: "pricing (LLPA) → these never decline, they ACCUMULATE"), so a sheet with
 * two overlapping DSCR blocks, or the same adjustment row pasted twice, charges the borrower twice for
 * one thing — and nothing anywhere said so. Measured on a two-block DSCR sheet: 2.000 points charged
 * where the sheet's own least-costly single reading is 0.750, i.e. $1,500 of extra points on a
 * $120,000 loan, with `problems[]` coming back EMPTY.
 *
 * ⛔ THERE IS EXACTLY ONE DEFINITION OF "THESE TWO RULES OVERLAP", AND IT IS NOT HERE.
 * `rule-coverage.analyzeRuleSet` already reduces a predicate to a region, intersects two regions under
 * the house's half-open [min,max) convention, groups by DIMENSION (never dimension+fact, or a
 * whole-column rule and the cell inside it would be filed apart), refuses what it cannot prove, and
 * writes the finding in plain words. This module CALLS it. It never re-implements a band, an
 * intersection, or the sentence — a second copy is how the checker and the pricer come to disagree
 * about the same sheet.
 *
 * ⛔ WHY WE PRICE ONCE AND REPORT, RATHER THAN REFUSING TO PRICE. Both answers stop the double charge;
 * they fail in opposite directions and only one of them is recoverable by the person who reads it.
 *   · REFUSING turns a pricing defect into an OUTAGE: the scenario comes back with no quote at all, on
 *     a sheet that may be legitimately layered (rule-coverage's own header records that a whole-column
 *     rule plus a cell rule inside it is how sheets in this engine layer), and the loan officer in
 *     front of it can do nothing about an investor's sheet. It also HIDES the money question behind an
 *     ineligibility, which reads as "this borrower does not qualify" — a different, wrong, statement.
 *   · PRICING ONCE keeps a quote available, guarantees the borrower is never charged twice, and puts
 *     the actual question — *should these two bands stack?* — in front of the owner in words.
 * So: charge once, say so loudly, and record the question. Nothing here is ever silent.
 *
 * ⛔ WHICH OF THE TWO WE APPLY IS A SAFE DIRECTION, NOT A GUESS AT A PRICING RULE. Whether an
 * overlapping pair is meant to stack, or which band governs, is a BUSINESS question about that
 * investor's sheet and this code does not know the answer — so it never invents one. What it can do
 * without knowing is refuse to overcharge: it applies the LEAST COSTLY of the colliding adjustments
 * (in the engine's cost-positive convention, via `pricing.normalizeAdjustment` — never a second copy
 * of the sign rule) and suppresses the rest. Whatever the true reading turns out to be, the borrower
 * was charged no more than the sheet's own smallest single answer for that dimension. A tie is broken
 * by sheet order, so the result is deterministic. ⚠️ THE OPEN QUESTION FOR THE OWNER is recorded in
 * every problem this module emits and in docs/longterm/PPE-OVERLAPPING-BANDS-QUESTION.md.
 *
 * ⛔ A COLLISION IT CANNOT READ IS REPORTED, NEVER COLLAPSED. `analyzeRuleSet` refuses an any/not/none
 * tree or a neq/nin complement (the real Deephaven sheet has four such condo rules). Two matched rules
 * on one dimension where one of them cannot be read is still a possible double charge, so it is
 * REPORTED — and the price is left exactly as the rules produced it, because suppressing an adjustment
 * we cannot prove collides would be inventing a discount. "We could not judge this" and "there is no
 * problem" are different answers and must never look the same.
 *
 * ⛔ THE EVALUATOR IS NOT CHANGED, AND THAT IS DELIBERATE. `rules.evaluateRules` stays the faithful
 * record of WHAT FIRED — the trace and the itemized adjustment list are the audit of the sheet as
 * written. The money is decided ONCE, at the façade (`quote.quoteProgram`), which is the only place
 * that turns fired rules into a price.
 *
 * PURE: no DB, no network, no clock. LT-only. No RTL imports.
 */

const { analyzeRuleSet } = require('./rule-coverage');
const { normalizeAdjustment } = require('./pricing');
const { adjustmentToRule } = require('./ratesheet');

// The one sentence that says what we did about a collision, and the question it leaves open. Kept
// beside the checker's own sentence rather than replacing it — the checker states the FACT, this
// states the RESOLUTION, and a reader needs both.
const OPEN_QUESTION = 'Whether these two bands are meant to stack is a question about this investor\'s'
  + ' sheet that PILOT cannot answer, so it took the safe direction and never charged twice.';

/**
 * A UNIQUE, HUMAN-READABLE label per rule, because a CODE IS NOT AN IDENTITY HERE. The duplicate case
 * this guard exists for — the same adjustment row pasted twice — produces two rules carrying the SAME
 * code, and `analyzeRuleSet` reports its findings by code; keyed on code alone the two would be
 * indistinguishable and impossible to map back to. So a code that repeats within the set (or is
 * missing) gains a positional marker, which is itself the clearest possible statement of the defect:
 * "acme_loan_amount #1 and acme_loan_amount #2 both charge…".
 */
function labelRules(rules) {
  const counts = new Map();
  for (const r of rules) {
    const c = (r && r.code) || null;
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  const byLabel = new Map();
  const labels = rules.map((r, i) => {
    const c = (r && r.code) || null;
    const label = (c && counts.get(c) === 1) ? c : `${c || 'unnamed rule'} #${i + 1}`;
    byLabel.set(label, i);
    return label;
  });
  return { labels, byLabel };
}

// The engine's cost-positive effect of one adjustment, in milli-points. Delegated to
// pricing.normalizeAdjustment so the sign/unit convention has ONE definition. An adjustment the
// pipeline itself would refuse returns null — we then decline to judge rather than rank on a guess.
function costOf(adjustment, index) {
  try { return normalizeAdjustment(adjustment, index).costMilli; } catch (_) { return null; }
}

/**
 * Ask `rule-coverage` which of these pricing rules collide, and map its answer back onto the rules'
 * own positions. Returns:
 *   { pairs: [{ a, b, dimension, band, rules:[labelA,labelB], detail }],
 *     unreadable: [{ dimension, indexes, labels, why }] }
 * `a`/`b` are indexes into `rules`. PURE; never throws.
 */
function collisionsIn(rules) {
  const list = Array.isArray(rules) ? rules.filter((r) => r && r.kind === 'pricing' && r.adjustment) : [];
  if (list.length < 2) return { pairs: [], unreadable: [] };
  const { labels, byLabel } = labelRules(list);
  const labelled = list.map((r, i) => ({ ...r, code: labels[i] }));

  let report;
  try {
    report = analyzeRuleSet(labelled, { note: 'the pricing rules that fired on this scenario' });
  } catch (_) {
    return { pairs: [], unreadable: [] };
  }

  const pairs = [];
  for (const o of (report.overlaps || [])) {
    const a = byLabel.get(o.rules && o.rules[0]);
    const b = byLabel.get(o.rules && o.rules[1]);
    if (a == null || b == null || a === b) continue;
    pairs.push({ a, b, dimension: o.dimension, band: o.band, rules: [o.rules[0], o.rules[1]], detail: o.detail });
  }

  // A dimension carrying two or more matched rules where at least one could not be read is a
  // POSSIBLE double charge the checker was unable to judge. Reported, never collapsed.
  const unreadableLabels = new Set((report.unanalyzable || []).map((u) => u.code));
  const byDim = new Map();
  labelled.forEach((r, i) => {
    const dim = (r.adjustment && (r.adjustment.dimension || r.adjustment.category)) || 'other';
    if (!byDim.has(dim)) byDim.set(dim, []);
    byDim.get(dim).push(i);
  });
  const unreadable = [];
  for (const [dimension, indexes] of byDim) {
    if (indexes.length < 2) continue;
    const blind = indexes.filter((i) => unreadableLabels.has(labels[i]));
    if (!blind.length) continue;
    unreadable.push({
      dimension,
      indexes: indexes.slice(),
      labels: indexes.map((i) => labels[i]),
      why: (report.unanalyzable.find((u) => u.code === labels[blind[0]]) || {}).why || 'the predicate cannot be read as a region',
    });
  }

  return { pairs, unreadable, labels };
}

/**
 * COMPILE TIME — the overlaps in a STORED sheet's adjustment rows, as `problems[]` entries. Nothing is
 * rewritten: an investor's sheet is theirs, so a compiler reports and a human decides. Each problem
 * carries the checker's own sentence verbatim so the compile-time report and the price-time report say
 * the same thing about the same two rules.
 *
 * `storedAdjustments` are `ratesheet.adjustmentToRule` input rows (what gridToRateSheet emits).
 */
function sheetOverlapProblems(storedAdjustments, opts = {}) {
  const where = opts.where || 'adjustments';
  const rows = Array.isArray(storedAdjustments) ? storedAdjustments : [];
  let rules;
  try {
    rules = rows.map(adjustmentToRule);
  } catch (_) {
    return []; // a malformed row is already the caller's own problem to report
  }
  // ⛔ THE "COULD NOT READ IT" REPORT IS PRICE-TIME ONLY, AND LEAVING IT OUT HERE IS THE WHOLE POINT.
  // At price time, two rules on one dimension MATCHED the same loan, so a collision the checker cannot
  // read is a real possible double charge. At compile time these are ALL the sheet's rules, and a
  // banded table is one rule PER BAND — so "several rules on one dimension" is the ordinary shape of
  // every rate sheet ever written. Reported here it fires on the real Deephaven sheet (four condo
  // rules that are mutually exclusive by LTV and can never both apply), which is exactly the crying
  // wolf that teaches people to ignore a checker. `rule-coverage` already reports an unreadable rule
  // in its own `unanalyzable` list, where it belongs.
  const { pairs } = collisionsIn(rules);
  return pairs.map((p) => ({
    where,
    kind: 'double_charge',
    dimension: p.dimension,
    band: p.band,
    rules: p.rules,
    reason: `${p.detail} ${OPEN_QUESTION}`,
  }));
}

/**
 * PRICE TIME — collapse the adjustments that FIRED on one scenario so a loan is charged once per
 * colliding group, and say what happened. Takes the matched pricing RULES and the adjustment objects
 * the evaluator produced from them, IN THE SAME ORDER (rules.evaluateRules emits both in one pass).
 *
 * Returns { adjustments, problems, suppressed } — `adjustments` in the evaluator's own order with the
 * suppressed entries removed, `problems` never silent, `suppressed` the audit of what was dropped.
 */
function resolveDoubleCharges(matchedRules, adjustments) {
  const rules = Array.isArray(matchedRules) ? matchedRules : [];
  const adj = Array.isArray(adjustments) ? adjustments : [];
  if (rules.length !== adj.length || adj.length < 2) return { adjustments: adj, problems: [], suppressed: [] };

  const { pairs, unreadable, labels } = collisionsIn(rules);
  if (!pairs.length && !unreadable.length) return { adjustments: adj, problems: [], suppressed: [] };

  // union-find over the colliding pairs: three rules covering one loan is ONE charge, not three, and
  // pairing them two at a time would otherwise leave two of the three standing.
  const parent = adj.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (i, j) => { const a = find(i); const b = find(j); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
  for (const p of pairs) union(p.a, p.b);

  const groups = new Map();
  adj.forEach((_, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  });

  const suppressedIdx = new Set();
  const suppressed = [];
  const keptFor = new Map();      // group root → the index we applied
  const undecided = new Set();    // groups we refused to collapse
  for (const [root, members] of groups) {
    if (members.length < 2) continue;
    const costs = members.map((i) => costOf(adj[i], i));
    if (costs.some((c) => c == null)) { undecided.add(root); continue; } // never rank on a guess
    let keep = members[0];
    let keepCost = costs[0];
    members.forEach((i, k) => { if (costs[k] < keepCost) { keep = i; keepCost = costs[k]; } });
    keptFor.set(root, keep);
    for (const i of members) {
      if (i === keep) continue;
      suppressedIdx.add(i);
      suppressed.push({ index: i, code: labels[i], costMilli: costs[members.indexOf(i)], appliedInstead: labels[keep], appliedCostMilli: keepCost });
    }
  }

  const problems = [];
  for (const p of pairs) {
    const root = find(p.a);
    const keep = keptFor.get(root);
    const resolution = keep == null
      ? 'PILOT could not rank these adjustments, so BOTH were applied — this loan may be double-charged. Check by hand.'
      : `PILOT applied ${labels[keep]} once (${costOf(adj[keep], keep)} milli-points of cost) and suppressed the other, so the borrower is not charged twice.`;
    problems.push({
      where: 'pricing',
      kind: 'double_charge',
      dimension: p.dimension,
      band: p.band,
      rules: p.rules,
      applied: keep == null ? null : labels[keep],
      reason: `${p.detail} ${resolution} ${OPEN_QUESTION}`,
    });
  }
  for (const u of unreadable) {
    problems.push({
      where: 'pricing',
      kind: 'double_charge_unverified',
      dimension: u.dimension,
      rules: u.labels,
      applied: null,
      reason: `${u.labels.length} pricing rules charged on the ${u.dimension} dimension for this loan and at least one`
        + ` of them could not be read (${u.why}), so PILOT cannot prove it is not a double charge. Every one of them was`
        + ' applied — suppressing an adjustment we cannot prove collides would be inventing a discount. Check by hand.',
    });
  }

  return {
    adjustments: adj.filter((_, i) => !suppressedIdx.has(i)),
    problems,
    suppressed,
  };
}

module.exports = {
  // OPEN_QUESTION is deliberately NOT exported. It is used only inside this module, and
  // `check-lt-export-reachability.js` caught it on its first run as an exported name nothing
  // anywhere references — which is the whole class this workstream keeps tripping over, in
  // miniature. An export nothing outside uses is not an export.
  collisionsIn,
  sheetOverlapProblems,
  resolveDoubleCharges,
  _internals: { labelRules, costOf },
};
