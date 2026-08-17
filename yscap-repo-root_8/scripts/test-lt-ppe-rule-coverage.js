#!/usr/bin/env node
'use strict';
/**
 * LT PPE — RULE-SET COVERAGE: overlapping price bands (a double charge) and holes between them.
 *
 * WHY IT MATTERS NOW. Accepting a suggested rule (P7/P8) writes a real rule into the set from a Lender
 * Price decline, so rules will arrive one at a time, from different people, months apart. That is
 * exactly how a second FICO band lands on top of an existing one and quietly charges a borrower twice.
 *
 * ⛔ A REGION IS NOT AN INTERVAL, AND SECTION F IS WHY THIS SUITE EXISTS IN ITS PRESENT SHAPE. The first
 * version of this analyzer read a predicate as a single band on ONE fact. Run against the real Deephaven
 * sheet it could read exactly 1 of its 133 pricing rules — every other one is a GRID CELL constraining
 * two facts at once (`fico >= 780 AND ltv < 50.5%`) — and reported a clean bill of health over the 1.
 * A checker that cannot read the rules is decoration, and a clean report from one is worse than no
 * report at all. So section F runs the analyzer over the REAL sheet and fails if it stops reading them.
 *
 * WHAT THIS SUITE PINS, and every case is a way the check could cry wolf or go quiet:
 *   A. HALF-OPEN IS RESPECTED — [640,660) and [660,680) share an edge and do NOT overlap. If this were
 *      wrong the checker would flag every correctly-banded sheet in the system, which is the fastest way
 *      to train people to ignore it.
 *   B. ONLY PRICING RULES ARE CHECKED — two matching ELIGIBILITY rules are the designed behaviour
 *      (declines accumulate so a borrower hears both reasons) and two matching BOUNDS tighten. Flagging
 *      either would be wrong, not merely noisy.
 *   C. A GAP IS ONLY REPORTED BETWEEN THE RULES' OWN EDGES — the analyzer is never told where an axis
 *      really starts, so inventing a domain would manufacture a gap under every sheet's floor.
 *   D. A RULE IT CANNOT READ IS REPORTED, NOT SKIPPED — an any/not tree or a neq/nin complement comes
 *      back named, so a clean report can never be read as "everything was checked".
 *   E. IT NEVER THROWS — a crash would take down whatever screen or publish step asked the question.
 *   F. IT CAN READ THE REAL SHEET.
 *
 * OFFLINE + PURE: no DB, no network. Runs in `npm test` via the `test-lt-ppe-*` glob.
 */
let pass = 0; const fails = [];
const ok = (c, m) => { if (c) { pass += 1; } else { fails.push(m); console.log(`  ✗ ${m}`); } };

const { analyzeRuleSet, _internals } = require('../src/longterm/ppe/rule-coverage');
const { evalPredicate } = require('../src/longterm/ppe/rules');

console.log('LT PPE — rule-set coverage (overlapping bands, and holes between them)\n');

const band = (code, fact, lo, hi, dimension = 'fico_cltv_dscr') => ({
  code, kind: 'pricing', when: { fact, op: 'between', value: [lo, hi] },
  adjustment: { dimension, adjMilli: 250, unit: 'points' },
});
// A real grid CELL — two facts at once, which is the shape 132 of the sheet's 133 pricing rules take.
const cell = (code, ficoMin, ltvMax, dimension = 'fico_cltv_dscr') => ({
  code, kind: 'pricing',
  when: { all: [{ fact: 'fico', op: 'gte', value: ficoMin }, { fact: 'ltv', op: 'lt', value: ltvMax }] },
  adjustment: { dimension, adjMilli: 250, unit: 'points' },
});

// ── A. HALF-OPEN BANDS THAT TOUCH DO NOT OVERLAP ──────────────────────────────────────────────────
{
  const r = analyzeRuleSet([band('fico_640', 'fico', 640, 660), band('fico_660', 'fico', 660, 680)]);
  ok(r.overlaps.length === 0, 'adjacent half-open bands [640,660) and [660,680) do NOT overlap');
  ok(r.gaps.length === 0, '…and leave no gap between them');
  // Proven against the REAL evaluator rather than asserted: 660 must match exactly one of them, which is
  // the property the whole half-open convention exists to guarantee.
  const hits = [band('fico_640', 'fico', 640, 660), band('fico_660', 'fico', 660, 680)]
    .filter((x) => evalPredicate(x.when, { fico: 660 }).value);
  ok(hits.length === 1 && hits[0].code === 'fico_660',
    '…and the engine itself puts 660 in exactly one band — the boundary bug this convention prevents');
}

// ── the real thing it is for: two bands that genuinely overlap ────────────────────────────────────
{
  const r = analyzeRuleSet([band('fico_640', 'fico', 640, 680), band('fico_660', 'fico', 660, 700)]);
  // Read through a defaulted local, never `r.overlaps[0].band` directly: a mutation that reports NO
  // overlap would then CRASH the suite, and a crash exits non-zero and looks exactly like proof that
  // the test bit. It has to fail as an ASSERTION, naming what went wrong.
  const o = r.overlaps[0] || {};
  ok(r.overlaps.length === 1, 'two bands that genuinely overlap are reported once');
  ok(o.band === 'fico [660, 680)', '…naming the exact region a loan would be charged twice in');
  ok(/adjusted twice/.test(o.detail || ''), '…and saying plainly what goes wrong');
  ok((o.rules || []).includes('fico_640') && (o.rules || []).includes('fico_660'),
    '…and naming BOTH rules, since fixing it means choosing between them');
  // A loan at 670 really is charged by both — the finding is about the engine's actual behaviour.
  const both = [band('fico_640', 'fico', 640, 680), band('fico_660', 'fico', 660, 700)]
    .filter((x) => evalPredicate(x.when, { fico: 670 }).value);
  ok(both.length === 2, '…and the evaluator confirms a 670 loan matches both rules');
}

// Three overlapping bands are THREE defects, not one — reporting only the first would hide two.
{
  const r = analyzeRuleSet([band('a', 'fico', 600, 700), band('b', 'fico', 650, 750), band('c', 'fico', 680, 800)]);
  ok(r.overlaps.length === 3, 'every overlapping PAIR is reported (3 rules overlapping = 3 findings)');
}

// ── A2. REGIONS: the shapes a one-fact analyzer could not express ─────────────────────────────────
{
  // Two grid CELLS in the same FICO column, on adjacent CLTV bands. They do not overlap — and a checker
  // that read only the first fact would see two identical `fico >= 780` rules and cry wolf on the whole
  // grid, which is the failure mode that makes people switch a checker off.
  const r = analyzeRuleSet([
    { code: 'c1', kind: 'pricing', when: { all: [{ fact: 'fico', op: 'gte', value: 780 }, { fact: 'ltv', op: 'between', value: [0, 50500] }] }, adjustment: { dimension: 'g' } },
    { code: 'c2', kind: 'pricing', when: { all: [{ fact: 'fico', op: 'gte', value: 780 }, { fact: 'ltv', op: 'between', value: [50500, 60500] }] }, adjustment: { dimension: 'g' } },
  ]);
  ok(r.overlaps.length === 0, 'two grid CELLS sharing a FICO column but on adjacent CLTV bands do NOT overlap');
  ok(r.analyzed.banded === 2, '…and BOTH were read — a one-fact analyzer could not have read either');
}
{
  // A whole-column rule DOES overlap every cell in its column: the cell constrains CLTV, the column
  // rule does not, and a fact absent from a region is unconstrained there.
  // BOTH ORDERINGS, deliberately. The intersection carries an unshared constraint from whichever side
  // holds it, and those are two separate lines of code — a fixture that only ever puts the cell first
  // leaves the other carry completely untested, which is exactly what a mutation run proved.
  const EXPECT = 'fico [780, 900) × ltv (-∞, 50500)';
  const r = analyzeRuleSet([cell('cellA', 780, 50500, 'g'), band('col', 'fico', 780, 900, 'g')]);
  const rev = analyzeRuleSet([band('col', 'fico', 780, 900, 'g'), cell('cellA', 780, 50500, 'g')]);
  ok(r.overlaps.length === 1, 'a whole-column rule overlaps a cell inside that column');
  ok((r.overlaps[0] || {}).band === EXPECT,
    '…and the reported region carries the CELL\'s own CLTV limit, not just the fact both rules name');
  ok(rev.overlaps.length === 1 && (rev.overlaps[0] || {}).band === EXPECT,
    '…and the same region is reported when the two rules are listed the other way round');
  const facts = { fico: 800, ltv: 40000 };
  const firing = [cell('cellA', 780, 50500, 'g'), band('col', 'fico', 780, 900, 'g')]
    .filter((x) => evalPredicate(x.when, facts).value);
  ok(firing.length === 2, '…and the evaluator confirms a loan inside that region really is charged by both');
}
{
  // An ENUM leaf is a constraint, not noise. Cash-out and purchase can never both fire, and dropping
  // enum leaves would report them as overlapping — a false alarm on two perfectly ordinary rules.
  const co = { code: 'co', kind: 'pricing', when: { all: [{ fact: 'purpose', op: 'eq', value: 'cashout' }, { fact: 'ltv', op: 'lt', value: 70500 }] }, adjustment: { dimension: 'p' } };
  const pu = { code: 'pu', kind: 'pricing', when: { all: [{ fact: 'purpose', op: 'eq', value: 'purchase' }, { fact: 'ltv', op: 'lt', value: 70500 }] }, adjustment: { dimension: 'p' } };
  const r = analyzeRuleSet([co, pu]);
  ok(r.overlaps.length === 0, 'two rules on DIFFERENT enum values of one fact never overlap');
  ok(r.analyzed.banded === 2, '…and both were read, so the silence is a finding rather than a skip');
  ok(!evalPredicate(co.when, { purpose: 'purchase', ltv: 60000 }).value,
    '…and the evaluator agrees a purchase never matches the cash-out rule');
  // …while two rules sharing an enum value DO overlap where their bands meet.
  const co2 = { code: 'co2', kind: 'pricing', when: { all: [{ fact: 'purpose', op: 'eq', value: 'cashout' }, { fact: 'ltv', op: 'lt', value: 80500 }] }, adjustment: { dimension: 'p' } };
  const r2 = analyzeRuleSet([co, co2]);
  ok(r2.overlaps.length === 1 && /purpose in \{cashout\}/.test(r2.overlaps[0].band),
    '…while two rules on the SAME enum value overlap, and the region names the value');
}
{
  // A conjunction that can never be satisfied is not a band — it is a rule that can never fire, and
  // treating its impossible span as real would invent an overlap with everything around it.
  const r = analyzeRuleSet([{ code: 'impossible', kind: 'pricing', when: { all: [{ fact: 'fico', op: 'gte', value: 780 }, { fact: 'fico', op: 'lt', value: 700 }] }, adjustment: { dimension: 'g' } }]);
  ok(r.unanalyzable.length === 1 && r.analyzed.banded === 0,
    'a conjunction that can never be satisfied is REPORTED, never treated as a band');
}

// ── B. ONLY PRICING RULES ARE CHECKED ─────────────────────────────────────────────────────────────
{
  const elig = (code, lo, hi) => ({ code, kind: 'eligibility', when: { fact: 'fico', op: 'between', value: [lo, hi] }, declineReason: 'x' });
  const r = analyzeRuleSet([elig('e1', 600, 700), elig('e2', 650, 750)]);
  ok(r.overlaps.length === 0,
    'two overlapping ELIGIBILITY rules are NOT flagged — declines accumulate by design so a borrower hears both reasons');
  ok(r.analyzed.pricingRules === 0, '…and they are not counted as pricing rules either');

  const bnd = (code, lo, hi) => ({ code, kind: 'bound', when: { fact: 'fico', op: 'between', value: [lo, hi] }, bound: { target: 'ltv', op: 'max', value: 70 } });
  const rb = analyzeRuleSet([bnd('b1', 600, 700), bnd('b2', 650, 750)]);
  ok(rb.overlaps.length === 0,
    'two overlapping BOUND rules are NOT flagged — bounds tighten to the most restrictive, which is the overlay guarantee');
}

// A pricing rule on a DIFFERENT dimension never collides with one on another: they are separate
// adjustments and both applying is exactly right.
{
  const r = analyzeRuleSet([band('fico_a', 'fico', 600, 700, 'fico_cltv_dscr'), band('amt_a', 'fico', 650, 750, 'loan_amount')]);
  ok(r.overlaps.length === 0, 'rules on two different DIMENSIONS never overlap each other');
  ok(r.analyzed.dimensions.length === 2, '…and both dimensions are reported as analyzed');
}

// ── C. A GAP IS ONLY REPORTED BETWEEN THE RULES' OWN EDGES ────────────────────────────────────────
{
  const r = analyzeRuleSet([band('lo', 'fico', 640, 660), band('hi', 'fico', 680, 700)]);
  const g = r.gaps[0] || {};
  ok(r.gaps.length === 1, 'a hole between two bands is reported');
  ok(g.band === '[660, 680)', '…naming exactly the uncovered band');
  ok(/nothing charges/.test(g.detail || ''), '…in words, not just an interval');
  ok(r.analyzed.gapsCheckedOn.includes('fico_cltv_dscr') && r.analyzed.gapsSkippedOn.length === 0,
    '…and the report says gaps WERE looked for on that dimension');
}
{
  // The trap: the analyzer is NOT told that FICO starts at 300, so it must not claim a gap below the
  // lowest band. Every rate sheet has a floor, and manufacturing a gap under all of them would make the
  // report useless on the first real sheet it saw.
  const r = analyzeRuleSet([band('only', 'fico', 640, 660)]);
  ok(r.gaps.length === 0, 'a single band produces NO gap — the analyzer never invents where an axis begins');
  const two = analyzeRuleSet([band('a', 'fico', 640, 660), band('b', 'fico', 660, 680)]);
  ok(two.gaps.length === 0, '…and contiguous bands leave none either');
}
{
  // An unbounded top: nothing can be missing above a rule that runs to infinity.
  const open = { code: 'top', kind: 'pricing', when: { fact: 'fico', op: 'gte', value: 700 }, adjustment: { dimension: 'fico_cltv_dscr', adjMilli: 0, unit: 'points' } };
  const r = analyzeRuleSet([band('lo', 'fico', 640, 700), open]);
  ok(r.gaps.length === 0 && r.overlaps.length === 0, 'a band meeting an open-ended rule at its own edge is neither a gap nor an overlap');
}
{
  // GAPS STAY ONE-DIMENSIONAL ON PURPOSE. A hole in a set of 2-D grid cells is a different and much
  // harder question, and a wrong answer would report a gap in a grid that is complete. So a dimension
  // carrying a multi-fact rule reports NO gaps — and SAYS it did not look, because `gaps: []` would
  // otherwise read as "none found" on exactly the sheets that matter.
  const r = analyzeRuleSet([band('lo', 'fico', 640, 660, 'g'), band('hi', 'fico', 680, 700, 'g'), cell('c', 780, 50500, 'g')]);
  ok(r.gaps.length === 0, 'a dimension carrying a multi-fact rule reports NO gaps rather than a guess');
  ok(r.analyzed.gapsSkippedOn.includes('g') && !r.analyzed.gapsCheckedOn.includes('g'),
    '…and NAMES the dimension it did not check, so an empty gap list is never mistaken for a clean one');
}

// ── D. WHAT IT COULD NOT READ IS NAMED ────────────────────────────────────────────────────────────
{
  // `neq` / `nin` describe the COMPLEMENT of a region, and the complement of a box is not a box. The
  // analyzer refuses rather than guessing, because a guessed complement invents overlaps that cannot
  // happen. These are the four real `dhvn_condo_*` rules' shape.
  const complement = { code: 'condo', kind: 'pricing', when: { all: [{ fact: 'property_type', op: 'in', value: ['Condo'] }, { fact: 'non_warrantable', op: 'neq', value: true }] }, adjustment: { dimension: 'pt', adjMilli: 500 } };
  const anyTree = { code: 'either', kind: 'pricing', when: { any: [{ fact: 'fico', op: 'gte', value: 700 }, { fact: 'ltv', op: 'lt', value: 60000 }] }, adjustment: { dimension: 'pt', adjMilli: 250 } };
  const noPred = { code: 'always', kind: 'pricing', when: null, adjustment: { dimension: 'pt', adjMilli: 125, unit: 'points' } };
  const r = analyzeRuleSet([complement, anyTree, noPred]);
  ok(r.unanalyzable.length === 3, 'a neq complement, an any-tree and a rule with no predicate are all REPORTED');
  ok(r.unanalyzable.every((u) => u.code && u.why), '…each named, with a reason a person can act on');
  ok(r.overlaps.length === 0 && r.gaps.length === 0, '…and none of them is silently treated as a region');
  ok(r.analyzed.pricingRules === 3 && r.analyzed.banded === 0,
    '…while the counts make plain that 3 pricing rules were considered and 0 could be read');
}

// A two-fact `all` IS a region — that is the whole generalization — while an any/not tree is not.
{
  const reg = _internals.regionOf({ all: [{ fact: 'fico', op: 'gte', value: 640 }, { fact: 'ltv', op: 'lt', value: 80000 }] });
  ok(reg && reg.numeric.size === 2 && reg.numeric.has('fico') && reg.numeric.has('ltv'),
    'a predicate spanning TWO facts reads as a region over BOTH of them');
  const same = _internals.regionOf({ all: [{ fact: 'fico', op: 'gte', value: 640 }, { fact: 'fico', op: 'lt', value: 680 }] });
  const iv = same && same.numeric.get('fico');
  ok(iv && iv.min === 640 && iv.max === 680 && iv.minInc === true && iv.maxInc === false,
    '…while the ordinary two-sided band on ONE fact reads as [640, 680)');
  ok(_internals.regionOf({ any: [{ fact: 'fico', op: 'gte', value: 640 }] }) === null,
    '…and an any-tree is refused, because a union of boxes is not a box');
}

// ── E. IT NEVER THROWS ────────────────────────────────────────────────────────────────────────────
{
  let threw = false;
  try {
    analyzeRuleSet([null, undefined, 42, 'nope', { kind: 'pricing' }, { kind: 'pricing', when: { fact: 'fico', op: 'between', value: 'garbage' }, adjustment: {} }]);
  } catch (e) { threw = true; }
  ok(!threw, 'garbage in the rule list never throws — a crash would take down the screen that asked');
  ok(analyzeRuleSet(null).overlaps.length === 0 && analyzeRuleSet(undefined).gaps.length === 0,
    'a missing rule list answers an empty report rather than failing');
}

// ── F. IT CAN READ THE REAL DEEPHAVEN SHEET ───────────────────────────────────────────────────────
// The guard against the defect that motivated the region rewrite. The first analyzer read 1 of these
// 133 pricing rules and reported no problems — a clean bill of health over 0.8% of the sheet. If a
// change ever puts that back, this fails LOUDLY rather than going quietly green.
{
  const { buildDeephavenGrid } = require('../src/longterm/ppe/deephaven-dscr-sheet');
  const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
  const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');

  const prog = rateSheetToProgram(gridToRateSheet(buildDeephavenGrid()));
  const rules = prog.rules || prog;
  const r = analyzeRuleSet(rules);

  ok(r.analyzed.pricingRules >= 130,
    `the real sheet carries the pricing rules this check is for (${r.analyzed.pricingRules})`);
  ok(r.analyzed.banded >= r.analyzed.pricingRules - 5,
    `nearly every real pricing rule is READ, not skipped (${r.analyzed.banded} of ${r.analyzed.pricingRules})`);
  ok(r.analyzed.banded / r.analyzed.pricingRules > 0.9,
    '…and the coverage is a real fraction of the sheet, never the 1-of-133 the interval version managed');
  ok(r.analyzed.dimensions.length >= 8,
    `every priced dimension is reached, not just one (${r.analyzed.dimensions.length})`);
  // What it cannot read is the four condo rules' `non_warrantable neq true` complement — refused on
  // purpose, and NAMED. The count is asserted loosely so adding a rule is not a test failure, but a
  // silent slide into "most of the sheet is unreadable" is.
  ok(r.unanalyzable.length <= 6 && r.unanalyzable.every((u) => u.code && u.why),
    'the handful it refuses come back with their codes and reasons');
  ok(r.overlaps.length === 0,
    'no two pricing rules on one dimension both charge the same real scenario — measured, not assumed');
  // Gaps are computable on NO dimension of this sheet (every one mixes multi-fact rules), and the
  // report must SAY so rather than presenting an empty list as a clean one.
  ok(r.analyzed.gapsCheckedOn.length + r.analyzed.gapsSkippedOn.length === r.analyzed.dimensions.length,
    'every analyzed dimension is accounted for as gap-checked or gap-skipped');
  ok(r.gaps.length === 0 && r.analyzed.gapsCheckedOn.length === 0,
    'the sheet reports no gaps AND states that gaps were looked for on no dimension of it');
}

console.log(`\n${fails.length ? `FAILURES: ${fails.length}` : 'OFFLINE: all passed'} (${pass} passed, ${fails.length} failed)`);
process.exit(fails.length ? 1 : 0);
