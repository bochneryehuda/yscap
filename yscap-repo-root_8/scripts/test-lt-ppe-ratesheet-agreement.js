#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the ≥200-scenario Lender Price AGREEMENT orchestrator (ratesheet-agreement.js), pure/offline.
 * Proves it COMPOSES the pieces correctly: a real quote.quoteProgram ladder against a hand-built LP leg
 * (client.parseFull / parseDisqualified shape), through detectDifferences + reconcileLlpas + boundsProbe.
 *
 * THE LOAD-BEARING CASE (PROVEN TO FAIL): two itemized LP LLPAs that OFFSET so the STACK TOTAL still
 * equals ours — the coarse detectDifferences alone reports AGREE, and only because the orchestrator also
 * runs the per-dimension reconcile does the scenario correctly DISAGREE. The test calls detectDifferences
 * directly to show the coarse layer is fooled, then the orchestrator to show it is not.
 *
 * Also: a matching scenario meets the gate; an eligibility agreement (both decline) counts; the dangerous
 * "we price what LP declines" disagrees; no-LP-signal is incomparable (never counted); one thrown LP leg
 * becomes an engine_error and the batch survives.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const agreement = require('../src/longterm/ppe/ratesheet-agreement');
const { detectDifferences } = require('../src/longterm/ppe/parity-detectors');
const { normalizeLpFull } = require('../src/longterm/ppe/lp-normalize-full');
const { quoteProgram } = require('../src/longterm/ppe/quote');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }

console.log('LT PPE — Lender Price agreement orchestrator\n');

// ---- OUR sheet-under-test: a small real program the real quoteProgram prices --------------------
const BASE_GRID = [
  { rate: 70000, lockDays: 30, basePriceMilli: 101500 },
  { rate: 71250, lockDays: 30, basePriceMilli: 102850 },
  { rate: 72500, lockDays: 30, basePriceMilli: 104000 },
];
const RULES = [
  { code: 'no_ny', kind: 'eligibility', when: { fact: 'state', op: 'eq', value: 'NY' }, declineReason: 'New York not eligible' },
  { code: 'cashout', kind: 'pricing', when: { fact: 'purpose', op: 'eq', value: 'cashout' }, adjustment: { code: 'cashout', category: 'purpose', adjMilli: 500 } },
];
const PROGRAM = { code: 'DHVN_DSCR30', name: 'DSCR 30yr', investorCode: 'DHVN', rules: RULES, baseGrid: BASE_GRID };
const SETTINGS = { 'pricing.correspondent_margin_milli': 250, 'pricing.rounding_mode': 'none', 'pricing.price_floor_milli': 98000 };
const FILTER = { investor: 'DHVN' };

const CASHOUT = { state: 'TX', fico: 740, ltv: 70000, dscr: 1200, purpose: 'cashout', lock_days: 30, loan_amount: 500000 };
const NY = { state: 'NY', fico: 740, ltv: 70000, dscr: 1200, purpose: 'purchase', lock_days: 30, loan_amount: 500000 };
const ours = (sc) => quoteProgram({ scenario: sc, program: PROGRAM, settings: SETTINGS });

// Sanity: the real engine prices the cashout ladder to exactly 0.25(margin)+0.5(cashout) below the sheet.
const q = ours(CASHOUT);
ok(q.eligible && q.ladder.length === 3, 'real quoteProgram: cashout scenario prices a 3-rung ladder');
ok(q.ladder[1].finalPriceMilli === 102100, '  the 102.850 rung → 102.100 (−0.25 margin −0.50 cashout)');

// ---- LP leg builders (the client.parseFull / parseDisqualified shapes) --------------------------
function lpOption(noteRate, price, basePoints, adjustmentPoints, adjustments, holdbackVal) {
  return {
    priceBuild: { noteRate, price, baseRate: noteRate, basePoints, adjustmentPoints },
    adjustments,
    holdback: { investor: [{ value: holdbackVal }] },
    flags: {},
  };
}
// An LP program that AGREES with ours to the penny on all three rungs.
const AGREE_OPTS = [
  lpOption(70.0, 100.750, -1.5, 0.5, [{ adjType: 'purpose', reason: 'Cash-Out', value: 0.5 }], 0.25),
  lpOption(71.25, 102.100, -2.85, 0.5, [{ adjType: 'purpose', reason: 'Cash-Out', value: 0.5 }], 0.25),
  lpOption(72.5, 103.250, -4.0, 0.5, [{ adjType: 'purpose', reason: 'Cash-Out', value: 0.5 }], 0.25),
];
const lpFull = (options) => ({ programs: [{ lender: 'Deephaven', investor: 'DHVN', program: 'DSCR 30yr', product: '30yr', options }] });
const lpDisq = (reasons) => ({ ready: true, lenders: [{ lender: 'Deephaven', investor: 'DHVN', items: [{ program: 'DSCR 30yr', reasons }] }] });
const OPTS = { filter: FILTER };

// ---- 1) a MATCHING scenario meets the gate -----------------------------------------------------
const rMatch = agreement.runOne(CASHOUT, ours, () => ({ full: lpFull(AGREE_OPTS), disqualified: { ready: true, lenders: [] } }), OPTS);
Promise.resolve(rMatch).then((m) => {
  ok(m.agree === true && !m.incomparable, 'MATCH: our engine and LP agree on every rung');
  ok(m.rungReconciles.length === 3 && m.rungReconciles.every((x) => x.agree), '  every rung reconciles per-dimension');
  ok(m.bounds.every((b) => b.agree && b.checks.samePrice), '  every cap/floor probe is faithful');
  main();
});

async function main() {
  // ---- 2) THE OFFSETTING CASE — the coarse layer is fooled, the orchestrator is not -------------
  // LP itemizes purpose +0.7 and loanamount −0.2 (sum 0.5 = our one cashout cell). The STACK TOTAL
  // (adjustmentPoints 0.5, price 102.100) still matches ours, so detectDifferences alone → AGREE.
  const OFFSET_OPTS = AGREE_OPTS.map((o, i) => (i === 1
    ? lpOption(71.25, 102.100, -2.85, 0.5, [
      { adjType: 'purpose', reason: 'Cash-Out', value: 0.7 },
      { adjType: 'loanamount', reason: 'Loan amount', value: -0.2 },
    ], 0.25)
    : o));
  // Prove the COARSE layer is fooled:
  const lpNorm = normalizeLpFull(lpFull(OFFSET_OPTS), FILTER);
  const bestRungs = agreement._internals.bestRungsOf(lpNorm);
  const coarseAlone = detectDifferences({ ours: q, lp: { eligible: true, rungs: bestRungs } }, {});
  ok(coarseAlone.verdict === 'agree', 'OFFSETTING: detectDifferences ALONE is fooled (stack total agrees) → verdict agree');
  // The orchestrator adds the per-dimension reconcile and correctly disagrees:
  const off = await agreement.runOne(CASHOUT, ours, () => ({ full: lpFull(OFFSET_OPTS), disqualified: { ready: true, lenders: [] } }), OPTS);
  ok(off.agree === false, '  PROVEN-TO-FAIL: the orchestrator DISAGREES on the offsetting rung');
  const rec = off.rungReconciles.find((x) => x.rate === 71250);
  // The deltas are MAGNITUDE deltas: Lender Price publishes no direction on an itemized line, so
  // reconcileLlpas compares |ours| against |theirs| (comparing our signed value against LP's magnitude
  // flagged every credit in the book — 8,344 lines on the live 299-scenario battery, all `ours === -lp`,
  // with ZERO genuine value disagreements). The property under test does not move: two cell errors that
  // CANCEL in the stack total are still each named. Their SIGNED values ride along as ourSignedMilli.
  const purposeIt = rec && rec.itemized.find((it) => it.dimension === 'purpose');
  const loanIt = rec && rec.itemized.find((it) => it.dimension === 'loan_amount');
  ok(rec && !rec.agree && purposeIt && purposeIt.deltaMilli !== 0 && loanIt && loanIt.deltaMilli !== 0,
    '  and names BOTH offending dimensions (magnitude deltas '
    + `${purposeIt && purposeIt.deltaMilli} / ${loanIt && loanIt.deltaMilli})`);

  // ---- 2b) coarseIgnore + skipBounds: a margin-only net-price difference is NOT gated ------------
  // LP agrees on every itemized LLPA but its DISPLAYED price differs by a margin (Deephaven: LP's
  // price carries an unreconciled origination the LLPA stack is not folded into). The itemized
  // reconcile agrees; only final_price / llpa_total / bounds differ. Gating those out → agree.
  const marginOpts = AGREE_OPTS.map((o2) => ({ ...o2, priceBuild: { ...o2.priceBuild, price: o2.priceBuild.price + 1.25 } }));
  const lpMargin = () => ({ full: lpFull(marginOpts), disqualified: { ready: true, lenders: [] } });
  const strict = await agreement.runOne(CASHOUT, ours, lpMargin, OPTS);
  ok(strict.agree === false && strict.rungReconciles.every((r) => r.agree),
    'MARGIN: a net-price-only difference disagrees under the strict gate (but every LLPA reconciles)');
  const lenient = await agreement.runOne(CASHOUT, ours, lpMargin, { ...OPTS, coarseIgnore: ['final_price', 'llpa_total', 'margin'], skipBounds: true });
  ok(lenient.agree === true, '…and with coarseIgnore + skipBounds (the compensation layer) the rate-sheet agreement holds');

  // ---- 3) an ELIGIBILITY agreement (both decline) COUNTS as agreement ---------------------------
  const bothDecline = await agreement.runOne(NY, ours, () => ({ full: { programs: [] }, disqualified: lpDisq([{ rule: 'state', adjType: 'StatesRateAdjustment' }]) }), OPTS);
  ok(bothDecline.agree === true && !bothDecline.incomparable && !bothDecline.ourEligible && !bothDecline.lpEligible,
    'ELIGIBILITY: both decline the NY scenario → a real agreement, counted');

  // ---- 4) the DANGEROUS direction — we price what LP declines -----------------------------------
  const danger = await agreement.runOne(CASHOUT, ours, () => ({ full: { programs: [] }, disqualified: lpDisq([{ rule: 'dscr', adjType: 'DscrRateAdjustment' }]) }), OPTS);
  ok(danger.agree === false && danger.coarse.summary.byCategory.disqualification_missing === 1,
    'DANGEROUS: our engine prices a loan LP declines → disagree (disqualification_missing)');

  // ---- 5) no LP signal at all → INCOMPARABLE (never counted as agree OR disagree) ---------------
  const incomp = await agreement.runOne(CASHOUT, ours, () => ({ full: { programs: [] }, disqualified: { ready: true, lenders: [] } }), OPTS);
  ok(incomp.incomparable === true && incomp.agree === false, 'INCOMPARABLE: LP gave no rungs and no decline → incomparable');

  // ---- 6) a thrown LP leg becomes engine_error and the batch survives ---------------------------
  const scenarios = [CASHOUT, NY, CASHOUT];
  let calls = 0;
  const lpLeg = (sc) => {
    calls += 1;
    if (calls === 2) throw new Error('LP timeout');
    if (sc === NY) return { full: { programs: [] }, disqualified: lpDisq([{ rule: 'state' }]) };
    return { full: lpFull(AGREE_OPTS), disqualified: { ready: true, lenders: [] } };
  };
  const batch = await agreement.runRatesheetAgreement(scenarios, { ours, lp: lpLeg }, { ...OPTS, concurrency: 1 });
  ok(batch.results.length === 3, 'BATCH: all three scenarios produced a verdict despite the throw');
  ok(batch.summary.errors === 1, '  the thrown leg is counted as one engine_error');
  ok(batch.results.some((r) => r.error === 'lp'), '  and the failure is attributed to the LP side');

  // ---- 7) the GATE report ----------------------------------------------------------------------
  const clean = await agreement.runRatesheetAgreement([CASHOUT], { ours, lp: () => ({ full: lpFull(AGREE_OPTS), disqualified: { ready: true, lenders: [] } }) }, OPTS);
  ok(clean.summary.gateMet === true && clean.summary.agreed === 1 && clean.summary.disagreed === 0,
    'GATE: a fully-agreeing batch meets the E3 gate');
  const dirty = await agreement.runRatesheetAgreement([CASHOUT], { ours, lp: () => ({ full: lpFull(OFFSET_OPTS), disqualified: { ready: true, lenders: [] } }) }, OPTS);
  ok(dirty.summary.gateMet === false && dirty.summary.byDimension.purpose === 1 && dirty.summary.byDimension.loan_amount === 1,
    '  a single offsetting disagreement fails the gate and names both dimensions');
  // the report SPLITS the two disagreeing dimensions: purpose is a cell we DO encode that is wrong (a
  // SURPRISE), loan_amount is a whole family our sheet does not carry yet (a KNOWN unencoded family).
  ok(JSON.stringify(dirty.summary.surprises) === JSON.stringify(['purpose'])
    && JSON.stringify(dirty.summary.pendingEncodeFamilies) === JSON.stringify(['loan_amount']),
    '  and it labels them apart: purpose = surprise, loan_amount = known-unencoded family (task #62)');
  ok(dirty.summary.byStatus.llpa_mismatch === 1 && dirty.summary.byStatus.llpa_missing_ours === 1
    && dirty.summary.byDimensionStatus.loan_amount.llpa_missing_ours === 1,
    '  byStatus / byDimensionStatus break the disagreements down by kind');

  // ---- 7b) a WHOLE missing family (task #62) is labelled pendingEncode, NOT a surprise ----------
  // LP prices a loan-amount LLPA our sheet carries no cell for; purpose still matches to the penny, so
  // the ONLY disagreement is llpa_missing_ours on a known-unencoded family. The gate still fails.
  const MISSING_OPTS = AGREE_OPTS.map((o2, i) => (i === 1
    ? lpOption(71.25, 102.100, -2.85, 0.5, [
      { adjType: 'purpose', reason: 'Cash-Out', value: 0.5 },
      { adjType: 'loanamount', reason: 'Loan amount > $1.5M', value: 0.3 },
    ], 0.25)
    : o2));
  const miss = await agreement.runRatesheetAgreement([CASHOUT], { ours, lp: () => ({ full: lpFull(MISSING_OPTS), disqualified: { ready: true, lenders: [] } }) }, OPTS);
  ok(miss.summary.gateMet === false && miss.summary.disagreed === 1,
    'PENDING-ENCODE: a missing known family still FAILS the gate (owner HARD RULE — agree on every LLPA)');
  ok(miss.summary.byStatus.llpa_missing_ours === 1 && miss.summary.byStatus.llpa_mismatch === undefined,
    '  the sole disagreement is a missing-ours, never a mismatch');
  ok(JSON.stringify(miss.summary.pendingEncodeFamilies) === JSON.stringify(['loan_amount'])
    && miss.summary.surprises.length === 0,
    '  loan_amount is labelled a known-unencoded family; there are NO surprises (nothing we encode is wrong)');

  // ---- 7c) a WRONG encoded cell is a SURPRISE, never pendingEncode ------------------------------
  const SURPRISE_OPTS = AGREE_OPTS.map((o2, i) => (i === 1
    ? lpOption(71.25, 102.100, -2.85, 0.5, [{ adjType: 'purpose', reason: 'Cash-Out', value: 0.7 }], 0.25)
    : o2));
  const surp = await agreement.runRatesheetAgreement([CASHOUT], { ours, lp: () => ({ full: lpFull(SURPRISE_OPTS), disqualified: { ready: true, lenders: [] } }) }, OPTS);
  ok(surp.summary.gateMet === false && surp.summary.byStatus.llpa_mismatch === 1,
    'SURPRISE: a wrong encoded cell fails the gate as a llpa_mismatch');
  ok(JSON.stringify(surp.summary.surprises) === JSON.stringify(['purpose'])
    && surp.summary.pendingEncodeFamilies.length === 0,
    '  purpose is a SURPRISE — a cell we encode is wrong; it is NEVER a known-unencoded family');
  // a batch that is only ever incomparable does NOT meet the gate (comparable === 0)
  const empty = await agreement.runRatesheetAgreement([CASHOUT], { ours, lp: () => ({ full: { programs: [] }, disqualified: { ready: true, lenders: [] } }) }, OPTS);
  ok(empty.summary.gateMet === false && empty.summary.comparable === 0 && empty.summary.incomparable === 1,
    '  a batch with no comparable scenario never meets the gate');

  // ---- 7) THE STORED EVIDENCE — which scenarios disagreed, and WHERE ----------------------------
  // `agreement-store.recordRun` stores the summary WHOLE and stores nothing else, so a run's summary is
  // the only thing that outlives it. It used to carry `disagreeing` — bare scenario LABELS, silently
  // sliced at 50 — so a stored record could say "41 disagreed" beside a list naming where NONE of them
  // went wrong, and the only way to ask again was to re-run 200+ scenarios against a PAID vendor.
  {
    const one = agreement.summarize([off]);
    const rec = one.disagreements[0];
    const dims = rec.dimensions.map((d) => d.dimension).sort();
    ok(one.disagreeing.length === 1 && one.disagreeing[0] === off.scenario,
      'EVIDENCE: the bare-label list keeps its old shape (stored summaries already carry it)');
    ok(JSON.stringify(dims) === JSON.stringify(['loan_amount', 'purpose']),
      '  and the record NAMES both offending dimensions rather than only the scenario');
    // The two rows carry DIFFERENT statuses and that is the whole value of recording them: `purpose` is
    // a cell we encode and got wrong (a real sheet bug), `loan_amount` is a family we do not carry yet
    // (task #62). A record that flattened both to "mismatch" would send a reader to fix a cell that
    // does not exist. Both sit on the same coupon, which is what makes them one offsetting pair.
    const statusOf = (d) => (rec.dimensions.find((x) => x.dimension === d) || {}).status;
    ok(statusOf('purpose') === 'llpa_mismatch' && statusOf('loan_amount') === 'llpa_missing_ours'
      && rec.dimensions.every((d) => d.rate === 71250 && d.deltaMilli !== 0),
      '  with the coupon, the signed delta, and each row\'s OWN status (a wrong cell vs an unencoded family)');
    ok(rec.worstDeltaMilli === off.worstDeltaMilli && rec.ourEligible === true && rec.lpEligible === true,
      '  plus the magnitude and who said the loan was eligible');

    // A disagreement with NO itemized cause: every LLPA reconciles and only the net price / cap probe
    // differ. The record must still say why, or the reader is told a scenario failed for no reason.
    const priceOnly = agreement.summarize([strict]).disagreements[0];
    ok(priceOnly.dimensions.length === 0 && priceOnly.categories.includes('final_price')
      && priceOnly.boundsFailed.includes('samePrice'),
      '  a net-price-only disagreement names the coarse axis and the failed bounds check');

    // AN IGNORED AXIS IS NEVER NAMED AS THE CAUSE. Same LP leg, with the margin-laden coarse axes gated
    // out but the cap/floor probe still gating: it disagrees on bounds ALONE, and `final_price` — which
    // still DIFFERS and is still tallied in byCategory — must not appear as a reason.
    const ignored = await agreement.runOne(CASHOUT, ours, lpMargin, { ...OPTS, coarseIgnore: ['final_price', 'llpa_total', 'margin'] });
    const ignoredSum = agreement.summarize([ignored]);
    ok(ignored.agree === false && ignoredSum.disagreements[0].categories.length === 0
      && ignoredSum.disagreements[0].boundsFailed.includes('samePrice')
      && ignoredSum.byCategory.final_price === 3,
      '  an axis the caller told the gate to ignore is tallied (once per rung) but never named as the cause');

    // CONTROL: the same leg the run is told to accept in full records nothing at all.
    ok(agreement.summarize([lenient]).disagreements.length === 0,
      '  CONTROL: an agreeing scenario contributes no evidence record');

    // EVERY recorded disagreement names at least one cause. `agree` is false only via a gating coarse
    // axis or the fine gate, so a record with nothing in it would mean the evidence lost the reason.
    const mixed = agreement.summarize([off, strict, danger, ignored, lenient, incomp]);
    ok(mixed.disagreements.length === 4
      && mixed.disagreements.every((d) => d.categories.length || d.dimensions.length || d.boundsFailed.length),
      '  every recorded disagreement names a cause — none is recorded blank');
  }

  // ---- 7b) THE CAP IS STATED, NOT SILENT -------------------------------------------------------
  {
    const many = agreement.summarize(new Array(agreement.DISAGREEMENT_SAMPLE + 10).fill(off));
    ok(many.disagreed === agreement.DISAGREEMENT_SAMPLE + 10
      && many.disagreements.length === agreement.DISAGREEMENT_SAMPLE
      && many.disagreeing.length === agreement.DISAGREEMENT_SAMPLE
      && many.disagreementsOmitted === 10,
      `CAP: ${agreement.DISAGREEMENT_SAMPLE + 10} disagreements → ${agreement.DISAGREEMENT_SAMPLE} recorded and the other 10 SAID to be omitted`);

    // The per-scenario row cap says so too. Hand-built because a synthetic 15-dimension reconcile is
    // the point; summarize()'s contract is over the verdict shape, whoever produced it.
    const wide = {
      scenario: 'wide', agree: false, ourEligible: true, lpEligible: true, worstDeltaMilli: 900,
      coarse: { differences: [] }, gatingCategories: [], bounds: [], boundsGate: ['samePrice'],
      rungReconciles: [{
        rate: 70000,
        itemized: Array.from({ length: 15 }, (_, i) => ({ dimension: `d${i}`, status: 'llpa_mismatch', deltaMilli: 10 + i })),
      }],
    };
    const w = agreement.summarize([wide]).disagreements[0];
    ok(w.dimensions.length === agreement.DIMENSION_ROWS_PER_SCENARIO
      && w.dimensionsOmitted === 15 - agreement.DIMENSION_ROWS_PER_SCENARIO,
      `  and a scenario with 15 offending dimensions records ${agreement.DIMENSION_ROWS_PER_SCENARIO} and names the ${15 - agreement.DIMENSION_ROWS_PER_SCENARIO} it dropped`);
  }

  console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
}
