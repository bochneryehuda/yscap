#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the AGREEMENT RUN'S TWO AUDIT MODULES, wired (ratesheet-agreement.js × rung-digest.js ×
 * disqualifier-reconciler.js). PURE, offline: no DB, no network, no RTL imports. OUR side is the REAL
 * `quote.quoteProgram` against a small real program — never a fixture that agrees with itself.
 *
 * TWO THINGS ARE PROVEN HERE, and the first is a BEHAVIOUR CHANGE TO A GATE.
 *
 * 1. THE BOTH-DECLINE GAP. `parity-detectors` ends its eligibility axis with "both decline — agree on
 *    the outcome (reason-set comparison is a later refinement)", so a scenario where WE declined on
 *    FICO and Lender Price declined on a state restriction scored a clean agreement and was counted
 *    under `agreedDeclined`. Section B proves the coarse layer alone is still fooled by exactly that,
 *    and that the orchestrator — now that the per-layer reconciler decides a both-decline — is not.
 *    A scenario that agreed before can now DISAGREE, or fall out of `comparable` when the reasons
 *    cannot be read at all. That is the point, and it is deliberate.
 *
 * 2. THE DIGEST EARNS ITS PLACE AND COSTS NOTHING. An agreeing scenario carries no digest (section F1);
 *    a disagreement whose cause is NOT an LLPA — a base-grid gap, a margin gap — itemizes as an empty
 *    dimension list, and only the digest says where in the build-up the two engines parted (F2/F3).
 *
 * PROVEN TO FAIL — thirteen mutations were applied to the PRODUCTION code, one at a time, and each was
 * confirmed to fail BY ASSERTION (never by ending the run: three of them originally failed by THROWING,
 * which is the false proof CLAUDE.md warns about, so E1/E3/F3 now catch their own throw and assert on
 * the shape instead). The CONTROL — this suite plus test-lt-ppe-ratesheet-agreement.js, unmutated —
 * was green on either side of every one:
 *
 *   the both-decline branch deleted (the pre-fix behaviour) → B3 B5 B6 B7 C2 C3 C4 C6
 *   the `indeterminate` arm removed                        → C2 C3 C4 C6
 *   an unknown no longer vetoes a disagreement             → C1 C2 C3 C4 C6
 *   `safeReconcileDeclines` unguarded                      → E1 E2
 *   `safeDigest` unguarded                                 → E3
 *   the digest built for every scenario                    → F1
 *   the digest assignment MOVED above the decline branch   → F6  (F6 catches a move, not an added
 *                                                                second computation — stated, not implied)
 *   `buildOursLeg`'s `.program` stamp removed              → D1 D2 (the LIVE route passes no program,
 *                                                                so without the stamp none of this
 *                                                                would ever bite in production)
 *   the decline-row cap removed                            → G2
 *   `worstRung` dropped from the stored record             → F3 F4
 *   the incomparable reason left unstated                  → C3 C4 C6
 *   the `notStored` statement emptied                      → G1
 *   the free-text decline-reason cap removed               → G4
 *
 * LT-only.
 */
const fs = require('fs');
const path = require('path');
const agreement = require('../src/longterm/ppe/ratesheet-agreement');
const { detectDifferences } = require('../src/longterm/ppe/parity-detectors');
const { quoteProgram } = require('../src/longterm/ppe/quote');
const { buildOursLeg } = require('../src/longterm/ppe/lp-agreement-legs');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }

console.log('LT PPE — the agreement run says WHERE it diverged, and WHY each side declined\n');

// ---- OUR sheet-under-test: a small real program the real quoteProgram prices --------------------
const BASE_GRID = [
  { rate: 70000, lockDays: 30, basePriceMilli: 101500 },
  { rate: 71250, lockDays: 30, basePriceMilli: 102850 },
];
const RULES = [
  // dimension `fico`, read from the rule's SOLE LEAF FACT — never from the reason prose.
  { code: 'elig_fico_min', kind: 'eligibility', when: { fact: 'fico', op: 'lt', value: 660 }, declineReason: 'FICO below 660' },
  // dimension `state`, likewise.
  { code: 'no_ny', kind: 'eligibility', when: { fact: 'state', op: 'eq', value: 'NY' }, declineReason: 'New York not eligible' },
  // A STATE LLPA, deliberately: `StatesRateAdjustment` is one of the adjTypes BOTH the fine reconciler
  // and the digest's classifier resolve to the same canonical `state`, so a per-dimension row here is
  // genuinely comparable on both sides rather than one-sided on either.
  { code: 'llpa_tx', kind: 'pricing', when: { fact: 'state', op: 'eq', value: 'TX' }, adjustment: { code: 'llpa_tx', dimension: 'state', adjMilli: 500, reason: 'Texas' } },
];
const PROGRAM = { code: 'DHVN_DSCR30', name: 'DSCR 30yr', investorCode: 'DHVN', rules: RULES, baseGrid: BASE_GRID };
const SETTINGS = { 'pricing.correspondent_margin_milli': 250, 'pricing.rounding_mode': 'none', 'pricing.price_floor_milli': 98000 };
const FILTER = { investor: 'DHVN' };
const OPTS = { filter: FILTER, program: PROGRAM };

const PRICED = { state: 'TX', fico: 740, ltv: 70000, dscr: 1200, purpose: 'purchase', lock_days: 30, loan_amount: 500000 };
const LOWFICO = { ...PRICED, fico: 640 };
const ours = (sc) => quoteProgram({ scenario: sc, program: PROGRAM, settings: SETTINGS });

// Sanity on OUR side before anything is compared to it.
const qPriced = ours(PRICED);
const qLow = ours(LOWFICO);
ok(qPriced.eligible && qPriced.ladder.length === 2, 'SETUP the real engine prices the 740-FICO scenario');
ok(qPriced.ladder[1].finalPriceMilli === 102100, '  the 102.850 rung → 102.100 (−0.25 margin −0.50 state LLPA)');
ok(!qLow.eligible && qLow.declines.length === 1 && qLow.declines[0].code === 'elig_fico_min',
  'SETUP the 640-FICO scenario is declined by our engine, on the FICO rule alone');

// ---- Lender Price legs (the client.parseFull / parseDisqualified shapes) ------------------------
function lpOption(noteRate, price, basePoints, adjustmentPoints, adjustments, holdbackVal) {
  return {
    priceBuild: { noteRate, price, baseRate: noteRate, basePoints, adjustmentPoints },
    adjustments,
    holdback: { investor: [{ value: holdbackVal }] },
    flags: {},
  };
}
const STATE_LLPA = [{ adjType: 'StatesRateAdjustment', reason: 'Texas', value: 0.5 }];
const AGREE_OPTS = [
  lpOption(70.0, 100.750, -1.5, 0.5, STATE_LLPA, 0.25),
  lpOption(71.25, 102.100, -2.85, 0.5, STATE_LLPA, 0.25),
];
const lpFull = (options) => ({ programs: [{ lender: 'Deephaven', investor: 'DHVN', program: 'DSCR 30yr', product: '30yr', options }] });
const lpDisq = (reasons) => ({ ready: true, lenders: [{ lender: 'Deephaven', investor: 'DHVN', items: [{ program: 'DSCR 30yr', reasons }] }] });
const NO_RUNGS = { programs: [] };
// Reason texts the crosswalk can actually READ: the adjType names the dimension, the text carries the
// threshold or the state. These are the shapes real captures carry (disqualify-crosswalk's header).
const DQ_FICO = lpDisq([{ rule: 'FICO - below 660', adjType: 'FicoRateAdjustment' }]);
const DQ_STATE = lpDisq([{ rule: 'Not available in NY', adjType: 'StatesRateAdjustment' }]);
const DQ_MYSTERY = lpDisq([{ rule: 'Vendor rule 17', adjType: 'MysteryAdjustment' }]);

const leg = (full, disqualified) => () => ({ full, disqualified });

async function main() {
  // ============================================================================================
  // A. BOTH DECLINE, FOR THE SAME REASON → a real eligibility agreement, itemized
  // ============================================================================================
  const same = await agreement.runOne(LOWFICO, ours, leg(NO_RUNGS, DQ_FICO), OPTS);
  ok(same.agree === true && same.bothDeclined === true && !same.incomparable,
    'A1 both decline the 640-FICO loan on FICO → an agreement, counted');
  ok(same.declineReconcile && same.declineReconcile.verdict === 'agree'
    && same.declineReconcile.layers.layer2.agreements[0].dimension === 'fico',
    'A2 …and it is ITEMIZED — layer 2 (eligibility), dimension `fico`, on both sides');
  const sameSum = agreement.summarize([same]);
  ok(sameSum.agreedDeclined === 1 && sameSum.agreedPriced === 0 && sameSum.gateMet === true,
    'A3 the summary counts it as a DECLINED agreement, and the gate is met');
  ok(sameSum.declines.bothDeclined === 1 && sameSum.declines.reasonsAgree === 1
    && sameSum.declines.byLayer.layer2.agreements === 1,
    'A4 the ineligibility axis is rolled up — 1 both-decline, reasons agreed, on layer 2');

  // ============================================================================================
  // B. BOTH DECLINE, FOR DIFFERENT REASONS — THE GAP
  // ============================================================================================
  // The CONTROL first: the coarse layer, alone, still calls this an agreement. That sentence is in
  // parity-detectors' own source ("reason-set comparison is a later refinement"), and this is it.
  const coarseAlone = detectDifferences(
    { ours: qLow, lp: { eligible: false, rungs: [] }, lpDisqualified: { ready: true, declined: [{ program: 'DSCR 30yr', reasons: [{ rule: 'Not available in NY', adjType: 'StatesRateAdjustment' }] }] } },
    {},
  );
  ok(coarseAlone.verdict === 'agree',
    'B1 CONTROL: detectDifferences ALONE calls a both-decline an agreement, whatever the reasons were');

  const diff = await agreement.runOne(LOWFICO, ours, leg(NO_RUNGS, DQ_STATE), OPTS);
  ok(diff.bothDeclined === true && diff.incomparable === false,
    'B2 the same scenario is a both-decline and IS comparable (LP gave a real decline)');
  ok(diff.agree === false,
    'B3 PROVEN-TO-FAIL: we decline on FICO, Lender Price on a state rule → NOT an agreement');
  ok(diff.declineReconcile.verdict === 'disagree'
    && diff.declineReconcile.layers.layer2.onlyOurs[0].dimension === 'fico'
    && diff.declineReconcile.layers.layer2.onlyAuthority[0].dimension === 'state',
    'B4 …and it names both sides: `fico` only ours, `state` only theirs, both on layer 2');
  const diffSum = agreement.summarize([diff]);
  ok(diffSum.disagreed === 1 && diffSum.agreed === 0 && diffSum.gateMet === false
    && diffSum.declines.reasonsDisagree === 1,
    'B5 the gate FAILS on it, and the roll-up says why it failed');
  const rec = diffSum.disagreements[0];
  ok(rec && rec.declineVerdict === 'disagree' && rec.declineMismatch.length === 2
    && rec.declineMismatch.some((x) => x.side === 'ours' && x.dimension === 'fico')
    && rec.declineMismatch.some((x) => x.side === 'authority' && x.dimension === 'state'),
    'B6 the STORED record carries the mismatch — a re-run against a paid vendor is not needed to ask again');

  // A layer-3 (prepayment) decline against a layer-2 one is the same defect on two different layers,
  // and must never read as "we agree it is ineligible".
  const PPP_PROGRAM = { ...PROGRAM, rules: [...RULES, { code: 'ppp_ny', kind: 'eligibility', dimension: 'prepay', when: { fact: 'prepay_months', op: 'eq', value: 0 }, declineReason: 'No-prepay not allowed' }] };
  const oursPpp = (sc) => quoteProgram({ scenario: sc, program: PPP_PROGRAM, settings: SETTINGS });
  const pppScenario = { ...PRICED, prepay_months: 0 };
  const layerSplit = await agreement.runOne(pppScenario, oursPpp, leg(NO_RUNGS, DQ_STATE), { filter: FILTER, program: PPP_PROGRAM });
  ok(layerSplit.agree === false
    && layerSplit.declineReconcile.layers.layer3.onlyOurs[0].dimension === 'prepay'
    && layerSplit.declineReconcile.layers.layer2.onlyAuthority[0].dimension === 'state',
    'B7 a prepayment decline (layer 3) against an eligibility decline (layer 2) is a disagreement, per layer');

  // ============================================================================================
  // C. BOTH DECLINE, REASONS UNREADABLE → incomparable, with the reason stated. Never an agreement,
  //    and never a disagreement either: nothing was shown to differ.
  // ============================================================================================
  const mystery = await agreement.runOne(LOWFICO, ours, leg(NO_RUNGS, DQ_MYSTERY), OPTS);
  // THE SUBTLE ONE. The reconciler sets an unreadable reason aside as `unknown` and reconciles what is
  // LEFT — so our FICO decline stands alone and the LAYER reports it as `only_ours`, i.e. the report's
  // own verdict is `disagree`. Taken at face value that says "we decline something Lender Price does
  // not", when the truth may be that their unreadable reason WAS the FICO one. The unknown vetoes it.
  ok(mystery.declineReconcile.verdict === 'disagree'
    && mystery.declineReconcile.summary.unknown === 1
    && mystery.declineOutcome === 'indeterminate',
    'C1 an unknown reason VETOES the disagreement it would otherwise manufacture out of our own decline');
  ok(mystery.agree === false && mystery.incomparable === true,
    'C2 PROVEN-TO-FAIL: it is NOT counted as an agreement (the gap), and NOT as a disagreement');
  ok(mystery.incomparableReason === 'decline_reasons_unreadable',
    'C3 …and the verdict SAYS which kind of incomparable it is');
  const mySum = agreement.summarize([mystery]);
  ok(mySum.comparable === 0 && mySum.gateMet === false
    && mySum.incomparableByReason.decline_reasons_unreadable === 1
    && mySum.declines.reasonsIndeterminate === 1,
    'C4 the run proves nothing from it — 0 comparable, and the summary names the cause');
  const noSignal = await agreement.runOne(PRICED, ours, leg(NO_RUNGS, { ready: true, lenders: [] }), OPTS);
  ok(noSignal.incomparable === true && noSignal.incomparableReason === 'lp_no_signal',
    'C5 the OTHER incomparable — Lender Price answered nothing — keeps its own distinct reason');

  // The same shape from OUR side: with no program in reach, a decline carries no readable dimension.
  // This is the plumbing-gap case, and it must fail the same way — quietly agreeing would be the old
  // behaviour wearing a new name.
  const noProgram = await agreement.runOne(LOWFICO, ours, leg(NO_RUNGS, DQ_FICO), { filter: FILTER });
  ok(noProgram.agree === false && noProgram.incomparableReason === 'decline_reasons_unreadable',
    'C6 with no program to read our decline\'s dimension from, the both-decline is incomparable — never agreed');

  // ============================================================================================
  // D. THE PLUMBING — the ours leg carries the sheet it prices from, so the LIVE route (which passes
  //    no program of its own) gets the reconciliation without a second source for the same fact.
  // ============================================================================================
  const stamped = buildOursLeg(PROGRAM, SETTINGS);
  ok(stamped.program === PROGRAM, 'D1 buildOursLeg stamps the sheet-under-test on the leg it returns');
  const viaLeg = await agreement.runOne(LOWFICO, stamped, leg(NO_RUNGS, DQ_FICO), { filter: FILTER });
  ok(viaLeg.agree === true && viaLeg.declineReconcile.verdict === 'agree',
    'D2 …and with NO opts.program the run still reconciles the reasons — the route is covered');
  const explicit = await agreement.runOne(LOWFICO, stamped, leg(NO_RUNGS, DQ_FICO), { filter: FILTER, program: PPP_PROGRAM });
  ok(explicit.declineReconcile !== null, 'D3 an explicit opts.program still wins over the stamp');

  // ============================================================================================
  // E. GUARDED — an audit may never cost a verdict that has already been reached
  // ============================================================================================
  // EACH OF THESE CATCHES ITS OWN THROW, deliberately. Removing a guard makes the call THROW, and an
  // uncaught throw ends the run — a red suite that looks like proof while the assertion below it never
  // ran. Catching here means the guard's removal fails THIS assertion, by name.
  const throwingProgram = { get rules() { throw new Error('rules exploded'); } };
  let thrown = null; let reconcilerEscaped = false;
  try {
    thrown = await agreement.runOne(LOWFICO, ours, leg(NO_RUNGS, DQ_STATE), { filter: FILTER, program: throwingProgram });
  } catch (_) { reconcilerEscaped = true; }
  ok(!reconcilerEscaped && thrown && thrown.declineReconcile === null && thrown.bothDeclined === true
    && thrown.incomparable === false && thrown.agree === true,
    'E1 a reconciler that THROWS leaves the verdict exactly as the coarse and fine axes left it');
  const thrownSum = thrown ? agreement.summarize([thrown]) : null;
  ok(thrownSum && thrownSum.declines.notReconciled === 1 && thrownSum.declines.reasonsAgree === 0,
    'E2 …and the summary SAYS the reasons were never reconciled, rather than implying they agreed');
  let digestGuard = 'threw';
  try {
    digestGuard = agreement._internals.safeDigest({ get ladder() { throw new Error('ladder exploded'); } }, true, [], 0);
  } catch (_) { /* the guard is gone — E3 fails below by assertion, not by ending the run */ }
  ok(digestGuard === null,
    'E3 a digest that throws is swallowed to null — it can never break a comparison');

  // ============================================================================================
  // F. THE DIGEST — attached only where it is worth reading, and it names the build-up component
  // ============================================================================================
  const agreed = await agreement.runOne(PRICED, ours, leg(lpFull(AGREE_OPTS), { ready: true, lenders: [] }), OPTS);
  ok(agreed.agree === true && agreed.digest === null,
    'F1 an AGREEING scenario carries no digest — a run of 300 does not need 300 divergence tables');

  // A BASE-GRID gap: every LLPA agrees and the final price agrees, so the per-dimension reconcile has
  // NOTHING to say. Only the digest can point at the base.
  const BASE_OFF = [lpOption(70.0, 100.750, -1.0, 0.5, STATE_LLPA, 0.25), AGREE_OPTS[1]];
  const baseOff = await agreement.runOne(PRICED, ours, leg(lpFull(BASE_OFF), { ready: true, lenders: [] }), OPTS);
  const baseRow = baseOff.digest && baseOff.digest.rungs.find((r) => r.rate === 70000);
  ok(baseOff.agree === false && baseOff.digest !== null && baseRow && baseRow.matched,
    'F2 a base-grid disagreement builds a digest, with the offending coupon matched to Lender Price\'s');
  ok(baseRow.base.deltaMilli === -500 && baseRow.final.deltaMilli === 0
    && baseRow.adjustments.every((a) => a.deltaMilli === 0),
    '   …and it lands the −500 on the BASE row while every LLPA and the final price agree');
  const baseSum = agreement.summarize([baseOff]);
  const baseRec = baseSum.disagreements[0];
  ok(baseRec && baseRec.dimensions.length === 0 && baseRec.worstRung
    && baseRec.worstRung.baseDeltaMilli === -500
    && baseRec.worstRung.rate === 70000,
    'F3 the STORED record would name no LLPA at all — the worst rung is what says it is the base');

  // A MARGIN gap: same shape, different component. This is what "where in the build-up" means.
  const MARGIN_OFF = AGREE_OPTS.map((o) => ({ ...o, holdback: { investor: [{ value: 0.5 }] } }));
  const marginOff = await agreement.runOne(PRICED, ours, leg(lpFull(MARGIN_OFF), { ready: true, lenders: [] }), OPTS);
  const marginSum = agreement.summarize([marginOff]);
  const marginRec = marginSum.disagreements[0];
  ok(marginOff.agree === false && marginRec && marginRec.worstRung
    && marginRec.worstRung.marginDeltaMilli === -250,
    'F4 a margin-only gap is named on the MARGIN row (−250), not left as an unexplained price difference');
  ok(typeof baseOff.digest.toText === 'function' && /coupon 70000/.test(baseOff.digest.toText())
    && /base/.test(baseOff.digest.toText()),
    'F5 the digest renders the human-scannable table it exists for');

  // The ORDER is the safety property: the digest is built after the last thing that can move the
  // verdict. Reordering it above the decline branch fails this.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'ppe', 'ratesheet-agreement.js'), 'utf8');
  const body = src.slice(src.indexOf('async function runOne'));
  ok(body.indexOf('const digest =') > body.lastIndexOf('agree = false;'),
    'F6 the digest is computed AFTER every line that can change `agree`');

  // ============================================================================================
  // G. WHAT REACHES THE STORED SUMMARY IS BOUNDED, AND THE BOUND IS STATED
  // ============================================================================================
  ok(typeof marginSum.notStored === 'string' && marginSum.notStored.length > 20,
    'G1 the summary SAYS what it does not carry — a cap nobody is told about reads as the whole story');
  const many = [];
  for (let i = 0; i < 6; i += 1) many.push({ dimension: `d_ours_${i}`, reason: `r${i}` });
  const manyLp = [];
  for (let i = 0; i < 6; i += 1) manyLp.push({ dimension: `d_lp_${i}`, reason: `r${i}` });
  const bigRecord = agreement._internals.disagreementRecord({
    scenario: 'big', ourEligible: false, lpEligible: false, worstDeltaMilli: 0,
    declineReconcile: { verdict: 'disagree', layers: { layer2: { onlyOurs: many, onlyAuthority: manyLp, agreements: [] }, layer3: { onlyOurs: [], onlyAuthority: [], agreements: [] } } },
  });
  ok(bigRecord.declineMismatch.length === agreement.DECLINE_ROWS_PER_SCENARIO
    && bigRecord.declineRowsOmitted === 12 - agreement.DECLINE_ROWS_PER_SCENARIO,
    `G2 a 12-row decline mismatch stores ${agreement.DECLINE_ROWS_PER_SCENARIO} and COUNTS the rest as omitted`);
  ok(agreement._internals.disagreementRecord({ scenario: 'x' }).declineMismatch.length === 0,
    'G3 a priced disagreement (no declines) carries no decline rows and no digest fields it cannot fill');
  // A vendor's decline REASON is free text and is the one field here with no natural size. Capped, and
  // the cap SHOWS — a reader is never handed a sentence that looks complete and is not.
  const longReason = 'x'.repeat(400);
  const clipped = agreement._internals.disagreementRecord({
    scenario: 'long', declineReconcile: { verdict: 'disagree', summary: { unknown: 0 }, layers: { layer2: { agreements: [], onlyOurs: [{ dimension: 'fico', reason: longReason }], onlyAuthority: [] } } },
  }).declineMismatch[0];
  ok(clipped.reason.length === agreement.REASON_TEXT_MAX && clipped.reason.endsWith('…'),
    `G4 a ${longReason.length}-character vendor reason is cut to ${agreement.REASON_TEXT_MAX} and ENDS in an ellipsis, so the cut is visible`);

  console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
