#!/usr/bin/env node
'use strict';
/**
 * LT PPE — OUR OWN GRID CELL REPORTED AS A REASON NOBODY COULD READ (§2.114).
 *
 * ⛔ WHAT WAS BROKEN, and it was the LAST thing holding the live battery back. After §2.111 the run of
 * 2026-08-19 came back 6 of 8 comparable, and the two that remained were `decline_reasons_unreadable` —
 * a name that says the crosswalk failed to parse a sentence. It had not. Both were OUR OWN declines:
 *
 *   "Not eligible: FICO 640–660 × CLTV 75.5%–80.5% × DSCR any"
 *   "Not eligible: T1 FICO 640–679, purchase/rate-term, DSCR < 1.00"
 *
 * A rate-sheet N/A cell and a tier cut — refusals about SEVERAL facts at once. The reconciler pairs one
 * axis per decline, so a rule with no single axis lands in `unknown` under `why: 'no_dimension'`, and
 * the runner renders that as "unreadable". **A grid cell doing exactly what a grid cell does was being
 * reported as a parsing failure**, sending a reader hunting a bug that does not exist.
 *
 * ⛔ THE NULL DIMENSION IS CORRECT AND IS NOT TOUCHED. `ratesheet.ineligibilityToRule` deliberately
 * nulls the placeholder group names (`fico_cltv_dscr`, `eligibility`, `other`, `grid`): none of them
 * names a FACT, no Lender Price reason can crosswalk to one, and carrying one would score a real
 * both-decline as a DISAGREEMENT — strictly worse than an unknown. Section C pins that decision as
 * unchanged. What was missing was not a dimension; it was the truth about why there isn't one.
 *
 * THE FIX is `agreement-dimensions.axesOfRule` — the facts the rule's COMPILED PREDICATE tests, read
 * from structure and never from prose or from a name. A placeholder→axes lookup table was built first
 * and then REMOVED: every placeholder this sheet emits sits on a predicate that already names those
 * exact facts, so the table could not bite on a single rule and would have been a second definition
 * waiting to drift — and it could never have reached the tier rules, which declare no placeholder at
 * all. Section B pins that it returns null for a single-axis rule, so the 182 rules that DO have a
 * dimension are untouched.
 *
 * ⛔ NO VERDICT MOVES, ON PURPOSE. `unknown` already makes a layer INDETERMINATE and `multi_axis` still
 * does; the scenario is still incomparable and still not an agreement. This is the §2.107 rule applied
 * to our own side: two different pieces of news must not be merged into one name. Pairing a multi-axis
 * refusal against a Lender Price reason on one of its axes is a further step with its own false-
 * agreement risk, and it is deliberately NOT taken here.
 *
 * PURE: no DB, no network. LT-only. No RTL imports.
 */
const { rateSheetToProgram, ineligibilityToRule } = require('../src/longterm/ppe/ratesheet');
const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
const { buildDeephavenGrid } = require('../src/longterm/ppe/deephaven-dscr-sheet');
const { axesOfRule, dimensionOfRule } = require('../src/longterm/ppe/agreement-dimensions');
const { reconcileDisqualifiers } = require('../src/longterm/ppe/disqualifier-reconciler');
const { runOne } = require('../src/longterm/ppe/ratesheet-agreement');

let pass = 0; const fails = [];
function ok(cond, msg) { if (cond) pass += 1; else fails.push(msg); }
const done = () => {
  console.log(`${fails.length ? 'FAIL' : 'PASS'} — multi-axis decline guard: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log('  ✗', f);
  process.exit(fails.length ? 1 : 0);
};

const program = rateSheetToProgram(gridToRateSheet(buildDeephavenGrid()));
const rules = program.rules || [];
const naRules = rules.filter((r) => /^Not eligible:/.test(String(r.declineReason || '')));

// ---- A. THE REAL SHEET — EVERY MULTI-AXIS REFUSAL NAMES ITS AXES ---------------------------------
ok(naRules.length === 10, `A1 the Deephaven sheet carries its 10 "Not eligible" rules — got ${naRules.length}`);
const withAxes = naRules.filter((r) => axesOfRule(r));
ok(withAxes.length === naRules.length,
  `A2 every one of them names the facts it refuses on — got ${withAxes.length} of ${naRules.length}`);
const gridCell = naRules.find((r) => /CLTV .*× DSCR/.test(String(r.declineReason)));
// ⛔ THE AXES ARE THE PREDICATE'S, NOT THE SENTENCE'S — and this assertion was written the other way
// round first. The cell's prose reads "… × DSCR any", which LOOKS like three axes; "any" means there
// is no DSCR band, so the compiled predicate constrains fico and ltv only. Asserting three would have
// been asserting the prose over the structure, which is the whole thing this module refuses to do.
ok(gridCell && JSON.stringify(axesOfRule(gridCell)) === JSON.stringify(['fico', 'ltv']),
  `A3 a grid N/A cell refuses on the facts its predicate tests — "DSCR any" constrains no DSCR — got ${JSON.stringify(gridCell && axesOfRule(gridCell))}`);
const tier = naRules.find((r) => /^Not eligible: T1 /.test(String(r.declineReason)));
ok(tier && (axesOfRule(tier) || []).length >= 3,
  `A4 a tier cut — which declares NO placeholder at all — names its axes too, because they are read from the predicate — got ${JSON.stringify(tier && axesOfRule(tier))}`);

// ---- B. THE CONTRACT: NEVER A SECOND ANSWER FOR A RULE THAT ALREADY HAS ONE ----------------------
const singleAxis = rules.filter((r) => dimensionOfRule(r) != null);
ok(singleAxis.length > 100, `B1 the sheet is mostly single-axis rules — got ${singleAxis.length}`);
ok(singleAxis.filter((r) => axesOfRule(r)).length === 0,
  `B2 …and NOT ONE of them is given an axis list — a rule with a dimension must have exactly one answer, or two consumers drift — got ${singleAxis.filter((r) => axesOfRule(r)).length}`);
ok(axesOfRule(null) === null && axesOfRule('x') === null, 'B3 a non-rule answers null rather than throwing');
ok(axesOfRule({ when: { fact: 'fico', op: 'lt', value: 640 } }) === null,
  'B4 a single-leaf predicate is never reported as multi-axis');

// ---- C. THE NULLED PLACEHOLDER IS UNCHANGED (the §2.101 decision stands) -------------------------
const compiled = ineligibilityToRule({
  code: 'X', dimension: 'fico_cltv_dscr', declineReason: 'Not eligible: test',
  fico_min: 640, fico_max: 660, ltv_min: 75500, ltv_max: 80500, dscr_min: null, dscr_max: null,
});
ok(compiled.dimension === null,
  `C1 a placeholder group name is still nulled — carrying it would score a real both-decline as a DISAGREEMENT — got ${JSON.stringify(compiled.dimension)}`);
ok(compiled.dimensions === undefined,
  `C2 …and no redundant axis list is written onto the rule; the predicate is the one source — got ${JSON.stringify(compiled.dimensions)}`);
ok(JSON.stringify(axesOfRule(compiled)) === JSON.stringify(['fico', 'ltv']),
  `C3 …while the axes are still readable from what it compiled to — got ${JSON.stringify(axesOfRule(compiled))}`);

// ---- D. THE RECONCILER SAYS WHICH KIND OF "CANNOT TELL" IT IS ------------------------------------
const lpDecline = (rule, adjType) => ({ ready: true, declined: [{ reasons: [{ rule, adjType }] }] });
const ourDecline = (code, reason) => ({ eligible: false, declines: [{ code, reason }] });
const multi = reconcileDisqualifiers(
  ourDecline(gridCell.code, gridCell.declineReason),
  lpDecline('Minimum DSCR .75%', 'DscrRateAdjustment'),
  { program },
);
const u = (multi.unknown || []).find((x) => x.side === 'ours') || {};
ok(u.why === 'multi_axis', `D1 our grid cell is reported as multi-axis, not unreadable — got ${u.why}`);
ok(JSON.stringify(u.axes) === JSON.stringify(['fico', 'ltv']),
  `D2 …carrying the axes it is about — got ${JSON.stringify(u.axes)}`);
// ⛔ THE INVARIANT IS "THE VERDICT DID NOT MOVE", AND IT IS PROVEN BY COMPARISON, NOT BY NAMING A
// VALUE. The first cut asserted `indeterminate` and the real answer here is `disagree` — Lender Price's
// row has no counterpart on our side once ours goes to `unknown`, so it stands alone. Naming a value
// would have pinned an unrelated part of the reconciler and said nothing about this change. Reconciled
// twice against the SAME inputs, once with a rule whose axes are readable and once with a reason that
// has no rule behind it at all: both land in `unknown`, so both must reach the same verdict.
const sameShapeUnreadable = reconcileDisqualifiers(
  { eligible: false, declines: [{ code: 'not_a_rule_on_this_sheet', reason: 'no rule behind this' }] },
  lpDecline('Minimum DSCR .75%', 'DscrRateAdjustment'),
  { program },
);
ok(multi.verdict === sameShapeUnreadable.verdict,
  `D3 the verdict does NOT move — labelling a decline multi-axis changes what it is CALLED, never what it decides — got ${multi.verdict} vs ${sameShapeUnreadable.verdict}`);

// ⛔ A GENUINELY UNREADABLE REASON MUST KEEP ITS OWN NAME, or this fix merely renames the problem.
const unreadable = reconcileDisqualifiers(
  { eligible: false, declines: [{ code: 'not_a_rule_on_this_sheet', reason: 'something with no rule behind it' }] },
  lpDecline('Minimum DSCR .75%', 'DscrRateAdjustment'),
  { program },
);
const u2 = (unreadable.unknown || []).find((x) => x.side === 'ours') || {};
ok(u2.why === 'no_dimension', `D4 a reason with no rule behind it still says no_dimension — got ${u2.why}`);
ok(u2.axes == null, 'D5 …and names no axes, because there are none to name');

// ---- E. THE SCENARIO NAMES ITS OWN CAUSE, AND STILL DOES NOT AGREE -------------------------------
const SC = { _label: 'm', fico: 640, ltv: 80000, dscr: 1000, loan_amount: 400000 };
const OPTS = { filter: { investor: 'Deephaven Mortgage' }, settings: {}, coarseIgnore: ['final_price', 'llpa_total', 'margin'], program };
const lpLeg = (rule, adjType) => async () => ({
  full: { programs: [{ lender: 'Deephaven Mortgage', investor: 'Deephaven Mortgage', program: 'DSCR 1.00-1.24',
    options: [{ priceBuild: { noteRate: 6.125, price: 99.25, basePoints: 0.75, adjustmentPoints: 0 }, adjustments: [] }] }] },
  disqualified: { ready: true, lenders: [{ lender: 'Deephaven Mortgage', investor: 'Deephaven Mortgage', items: [{ program: 'DSCR 1.00-1.24', reasons: [{ rule, adjType }] }] }] },
});
const oursLeg = (code, reason) => async () => ({ eligible: false, ladder: [], declines: [{ code, reason, source: 'base' }] });

(async () => {
  const r = await runOne(SC, oursLeg(gridCell.code, gridCell.declineReason), lpLeg('Minimum DSCR .75%', 'DscrRateAdjustment'), OPTS);
  ok(r.incomparableReason === 'decline_reasons_multi_axis',
    `E1 the scenario names the real cause — got ${r.incomparableReason}`);
  ok(r.incomparable === true && r.agree === false,
    `E2 …and the verdict is UNCHANGED: still incomparable, still not an agreement — got ${r.incomparable}/${r.agree}`);

  // ⛔ THE PAIRING GAP STILL WINS WHEN BOTH APPLY. `unpaired` is the one with a fix behind it (§2.101),
  // so a scenario carrying both is more usefully described by it — merging the two the other way would
  // bury the actionable news under the descriptive one.
  const both = await runOne(
    SC,
    async () => ({ eligible: false, ladder: [], declines: [
      { code: gridCell.code, reason: gridCell.declineReason, source: 'base' },
      { code: 'dhvn_min_loan_ge1', reason: 'Minimum Loan Amount $75,000 (DSCR >= 1.00x)', source: 'base' },
    ] }),
    lpLeg('Minimum DSCR .75%', 'DscrRateAdjustment'), OPTS,
  );
  // ⛔ WRITTEN BACKWARDS FIRST, AND THE CODE WAS RIGHT. `relatedOnly` means "the ONLY thing wrong is the
  // vocabulary gap" — it is false while anything is still in `unknown`. So a scenario carrying BOTH a
  // pairing gap and a multi-axis refusal is not a pure pairing gap, and `multi_axis` is the more
  // complete description of it. Reporting it as `unpaired` would claim a fix exists that would not
  // finish the job.
  ok(both.incomparableReason === 'decline_reasons_multi_axis',
    `E3 a scenario carrying BOTH is not a pure pairing gap, so it is not named as one — got ${both.incomparableReason}`);
  ok(both.declineReconcile && both.declineReconcile.relatedOnly === false,
    'E3b …which is exactly what relatedOnly=false says: something is still unreadable beneath the gap');

  const plain = await runOne(SC, oursLeg('not_a_rule_on_this_sheet', 'no rule behind this'), lpLeg('Minimum DSCR .75%', 'DscrRateAdjustment'), OPTS);
  ok(plain.incomparableReason === 'decline_reasons_unreadable',
    `E4 …while a genuinely unreadable reason still says unreadable — got ${plain.incomparableReason}`);

  done();
})().catch((e) => { console.log('FAIL — multi-axis decline guard: threw', e && e.stack ? e.stack : e); process.exit(1); });
