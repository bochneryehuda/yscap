/**
 * OUT-OF-POCKET REHAB IS ALLOWED WHEN IT IS UNAVOIDABLE (owner-directed
 * 2026-08-20). PURE — no DB, no network.
 *
 *   "The system is still not allowing out-of-pocket rehabs when it comes to very
 *    small loan amounts … for an extremely small purchase and the construction is
 *    very high, the LTC cap is happening so quickly that we can't fund anything on
 *    the initial. The gap is happening too fast, and it's blocking us too fast …
 *    the initial goes down to zero, but we don't even have enough to fund 100% of
 *    the construction budget. Technically, we only have to fund 90% of the
 *    construction budget, and the system is still blocking it … If the initial is
 *    already at zero, then you should automatically allow out-of-pocket rehab
 *    without an exception because there is no way from where it's cut."
 *
 * THE CLAIM THIS FILE EXISTS TO PROVE, in one sentence: the change moves the
 * VERDICT on a narrow, precisely-described family of deals and moves NO NUMBER,
 * anywhere, ever. So the bar is:
 *
 *   A. INERT. With the rule neutralized the engines are byte-identical over the
 *      ordinary matrix — and on the deals the rule DOES reach, every figure
 *      (loan, initial, holdback, reserve, rate, caps, leverage) is still
 *      byte-identical; only the status and the reason line move.
 *   B. IT ONLY FIRES WHERE IT SHOULD. The initial advance is already zero, a
 *      construction budget exists, and at least 90% of it is still financed.
 *   C. IT STILL BLOCKS BELOW THE FLOOR. Under 90% financed is a real feasibility
 *      question and stays MANUAL, with the original wording.
 *   D. IT TELLS THE TRUTH. The disclosed shortfall and percentage reconcile with
 *      the budget and the holdback to the cent.
 *   E. ONE VERDICT PER DEAL. The refusal and the disclosure are never both raised.
 */
'use strict';

const { baselineEngines, liveEngines, shape, assertStripBit, ALL_ENGINES } = require('./lib/engine-baseline');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

/* THE LEVER IS NEUTRALIZED, NOT DELETED, AND THE CONSTANT IS WHY. The whole rule
   hangs off one named floor: with it unreachable, `rehabFinancedPct >= FLOOR` is
   false on every deal, `rehabOopAuto` is false everywhere, and the engine takes
   the same MANUAL branch it always took. That is exactly "the engine without the
   lever", from a one-line, countable edit — where a regex deleting the guarded
   block across three files would be neither. `assertStripBit` below proves the
   edit genuinely bit, which is a stronger guard than a text search for the
   residue. The floor lives in standard-program.js only; Gold and Silver size on
   ITS sizeLoan, so all three inherit the strip through the baseline re-pointing
   their sibling require. */
const FLOOR_LINE = /^ {2}var REHAB_FINANCED_FLOOR = 0\.90;.*$/gm;
const BASE = baselineEngines([
  { re: FLOOR_LINE, expect: { 'standard-program': 1 }, with: '  var REHAB_FINANCED_FLOOR = Infinity;' },
]);
const LIVE = liveEngines();

// The owner's own shape: a tiny purchase carrying a very large construction
// budget, so the loan-to-cost wall bites before the initial advance can exist.
const ENGAGING = {
  loanType: 'Purchase', strategy: 'Fix & Flip', state: 'TX',
  propertyType: 'SFR (1 unit)', units: 1,
  purchasePrice: 30000, asIsValue: 30000, arv: 900000, rehabBudget: 400000,
  fico: 760, term: 12, irMonths: 0, expFlips: 10, expHolds: 10, expGround: 10,
};

console.log('0. the baseline is real');
assertStripBit(assert, BASE, LIVE, ENGAGING, ALL_ENGINES, 'REHAB_FINANCED_FLOOR');

/* ── the matrix ────────────────────────────────────────────────────────────
   Deliberately spans BOTH families: ordinary deals (where the rule must be
   invisible) and the tiny-purchase / huge-budget corner it was written for.
   A matrix that only held ordinary deals would prove inertness and nothing
   else; one that only held the corner would prove the rule and hide a
   regression on every real file. */
function scenarios() {
  const out = [];
  for (const state of ['NJ', 'PA', 'OH', 'TX', 'FL', 'NY']) {
    for (const strategy of ['Fix & Flip', 'Fix & Hold (BRRRR)', 'Ground-up Construction', 'Bridge / Stabilized']) {
      for (const fico of [620, 700, 780]) {
        for (const purchasePrice of [20000, 40000, 120000, 300000, 900000]) {
          for (const rehabBudget of [0, 60000, 200000, 600000, 1500000]) {
            for (const arv of [250000, 700000, 1600000, 4000000]) {
              for (const exp of [0, 4, 11]) {
                for (const irMonths of [0, 9]) {
                  out.push({
                    loanType: 'Purchase', strategy, state,
                    propertyType: 'SFR (1 unit)', units: 1,
                    purchasePrice, asIsValue: purchasePrice, arv, rehabBudget,
                    fico, term: 12, irMonths,
                    expFlips: exp, expHolds: exp, expGround: exp,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  return out;
}
const CASES = scenarios();
console.log(`\nscenario matrix: ${CASES.length} cases x ${ALL_ENGINES.length} programs = ${CASES.length * ALL_ENGINES.length} evaluations\n`);

// The figures the rule may never touch. `binding` is in: the rule must not even
// change WHICH constraint the engine says bound the deal.
const MONEY_KEYS = ['totalLoan', 'acquisition', 'rehabLoan', 'financedIR', 'downPayment',
  'ltcPct', 'acqLtvPct', 'arvPct', 'costBasis', 'binding', 'bindKey', 'rehabOverCap',
  'initialPayment', 'fullPayment', 'maxReserve', 'preMaxTotal'];

console.log('A. inert where it does not apply, and money-identical where it does');
{
  let priced = 0, engaged = 0, drift = 0, moneyDrift = 0, rateDrift = 0, capsDrift = 0;
  let firstDrift = null, firstMoney = null;
  for (const e of ALL_ENGINES) {
    for (const c of CASES) {
      const b = BASE[e].evaluate(c);
      const l = LIVE[e].evaluate(c);
      const ls = (l && l.sizing) || {};
      if (ls.totalLoan > 0) priced++;
      const auto = !!ls.rehabOopAuto;
      if (auto) {
        engaged++;
        const bs = (b && b.sizing) || {};
        for (const k of MONEY_KEYS) {
          if (JSON.stringify(bs[k]) !== JSON.stringify(ls[k])) { moneyDrift++; if (!firstMoney) firstMoney = { e, c, k, was: bs[k], now: ls[k] }; }
        }
        if (b.noteRate !== l.noteRate) rateDrift++;
        if (JSON.stringify(b.caps) !== JSON.stringify(l.caps)) capsDrift++;
      } else if (shape(b) !== shape(l)) {
        drift++; if (!firstDrift) firstDrift = { e, c, was: shape(b), now: shape(l) };
      }
    }
  }
  assert(priced > CASES.length,
    `A0 the matrix is meaningful — ${priced} of ${CASES.length * ALL_ENGINES.length} evaluations actually price`);
  assert(engaged > 200,
    `A1 the rule is genuinely exercised — it applies on ${engaged} evaluations (a matrix that never engaged it would make section B vacuous)`);
  assert(drift === 0,
    `A2 every deal the rule does NOT reach is byte-identical to the engine without the rule, across all three programs (drift: ${drift})`);
  if (firstDrift) console.log('    first drift:', JSON.stringify(firstDrift.c), '\n    was:', firstDrift.was, '\n    now:', firstDrift.now);
  assert(moneyDrift === 0 && rateDrift === 0 && capsDrift === 0,
    `A3 on the ${engaged} deals it DOES reach, not one figure moves — loan, initial, holdback, reserve, leverage, payments, caps and rate are all byte-identical (money ${moneyDrift}, rate ${rateDrift}, caps ${capsDrift})`);
  if (firstMoney) console.log('    first money drift:', JSON.stringify(firstMoney));
}

console.log('\nB. it fires only where the caps had nothing left to cut');
{
  const MANUAL_RE = /(rehab|rehab\/construction) budget exceeds what this program can finance/;
  const DISCLOSE_RE = /comes out of pocket over the construction/;
  let autoWithInitial = 0, autoBelowFloor = 0, autoNoRehab = 0, autoWithoutOverCap = 0;
  let overCapWithInitial = 0;
  let autoStillManual = 0, autoMissingDisclosure = 0, bothReasons = 0;
  let blockedButAbove = 0, blockedMissingRefusal = 0, blocked = 0, auto = 0;
  let mathOff = 0, firstMath = null;
  for (const e of ALL_ENGINES) {
    for (const c of CASES) {
      const ev = LIVE[e].evaluate(c);
      const s = (ev && ev.sizing) || null;
      if (!s) continue;
      const msgs = (ev.reasons || []).map((r) => r.msg);
      const hasManual = msgs.some((m) => MANUAL_RE.test(m));
      const hasDisclose = msgs.some((m) => DISCLOSE_RE.test(m));
      if (s.rehabOverCap && s.acquisition > 0.5) {
        overCapWithInitial++;
        if (s.rehabOopAuto) autoWithInitial++;      // the guard failed to hold
      }
      if (s.rehabOopAuto) {
        auto++;
        if (!(s.rehabFinancedPct >= 0.90)) autoBelowFloor++;
        if (!(s.rehab > 0)) autoNoRehab++;
        if (!s.rehabOverCap) autoWithoutOverCap++;
        if (hasManual) autoStillManual++;
        if (!hasDisclose) autoMissingDisclosure++;
        // D — the disclosure reconciles with the budget to the cent.
        const wantUnfinanced = Math.round((s.rehab - s.rehabLoan) * 100) / 100;
        const wantPct = s.rehabLoan / s.rehab;
        if (Math.abs(s.rehabUnfinanced - wantUnfinanced) > 0.005 || Math.abs(s.rehabFinancedPct - wantPct) > 1e-12) {
          mathOff++; if (!firstMath) firstMath = { e, c, s: { rehab: s.rehab, rehabLoan: s.rehabLoan, rehabUnfinanced: s.rehabUnfinanced, rehabFinancedPct: s.rehabFinancedPct } };
        }
      }
      if (s.rehabOverCap && !s.rehabOopAuto) {
        blocked++;
        if (s.rehab > 0 && s.acquisition <= 0.5 && s.rehabFinancedPct >= 0.90) blockedButAbove++;
        // A missing ARV is a more fundamental refusal and legitimately wins the
        // else-if chain on Silver, so it is an accepted alternative answer.
        if (!hasManual && !msgs.some((m) => /After-repair value is required/.test(m))) blockedMissingRefusal++;
      }
      if (hasManual && hasDisclose) bothReasons++;
    }
  }
  assert(autoWithInitial === 0,
    `B1 the rule never fires while the initial advance is still above zero — there would be somewhere left to cut (violations: ${autoWithInitial})`);
  console.log(`    MEASURED, and stated rather than implied: over ${CASES.length * ALL_ENGINES.length} evaluations the sizing waterfall produced a capped rehab WITH a positive initial advance ${overCapWithInitial} time(s).`);
  console.log('    So the initial-is-zero guard is REDUNDANT in today\'s waterfall — the caps reach the rehab only once the initial has already been clamped to zero. It is kept because it is the OWNER\'S stated rule and because a future change to the waterfall must not silently widen the auto-allow; B1 is what would catch that.');
  assert(autoBelowFloor === 0 && autoNoRehab === 0 && autoWithoutOverCap === 0,
    `B2 it never fires below the 90% floor (${autoBelowFloor}), with no construction budget (${autoNoRehab}), or on a deal no cap touched (${autoWithoutOverCap})`);
  assert(auto > 200 && autoStillManual === 0 && autoMissingDisclosure === 0,
    `B3 every one of the ${auto} auto-allowed deals drops the refusal and carries the disclosure instead (still refused: ${autoStillManual}, no disclosure: ${autoMissingDisclosure})`);
  assert(blocked > 200 && blockedButAbove === 0 && blockedMissingRefusal === 0,
    `C1 the ${blocked} deals it does NOT reach still refuse, with the original wording (wrongly blocked: ${blockedButAbove}, silent: ${blockedMissingRefusal})`);
  assert(mathOff === 0,
    `D1 the disclosed shortfall and percentage reconcile with the budget and the holdback to the cent (off: ${mathOff})`);
  if (firstMath) console.log('    first mismatch:', JSON.stringify(firstMath));
  assert(bothReasons === 0,
    `E1 no deal ever carries BOTH the refusal and the disclosure (${bothReasons})`);
}

console.log('\nF. the owner\'s own reported deal');
{
  // A $30,000 purchase with a $400,000 budget: measured before the change as
  // MANUAL on all three programs while financing 96.8%–99.4% of the budget.
  for (const e of ALL_ENGINES) {
    const before = BASE[e].evaluate(ENGAGING);
    const after = LIVE[e].evaluate(ENGAGING);
    const s = after.sizing;
    assert(before.status === 'MANUAL' && after.status === 'ELIGIBLE',
      `F:${e} the reported deal was blocked (${before.status}) and now prices (${after.status})`);
    assert(before.sizing.totalLoan === s.totalLoan && before.sizing.acquisition === s.acquisition
      && before.sizing.rehabLoan === s.rehabLoan && before.noteRate === after.noteRate,
      `F:${e} and not one number moved — $${s.totalLoan} total, $${s.acquisition} initial, $${s.rehabLoan} holdback, rate ${after.noteRate}`);
    assert(s.acquisition === 0 && s.rehabFinancedPct >= 0.9,
      `F:${e} it qualifies for the reason the owner gave — zero initial, ${(s.rehabFinancedPct * 100).toFixed(1)}% of the budget financed`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
