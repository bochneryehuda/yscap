'use strict';
/**
 * LT — THE DSCR-BRACKET-AWARE PRICING BOARD.
 *
 * Owner-reported 2026-09-01, quoting a live refusal: *"Option 11.125% — Harbor
 * has moved band. These figures come to 0.93, which is a lower DSCR band than
 * the 1.25 it was priced in — so the rate on it is one this loan no longer
 * qualifies for."* The refusal was right; the board should never have offered
 * the rate. So: price a separate scenario per bracket and show every rate under
 * the bracket its own true ratio reaches.
 *
 * ⛔ THE HEADLINE ASSERTION IS SECTION F, AND IT IS NOT A RESTATEMENT OF THE
 * CODE. It takes the finished board, builds a REAL term-sheet snapshot from each
 * quote, and runs the REAL `snapshot.exportGate` over it — the very function
 * that produced the owner's sentence. A board this feature builds must be
 * incapable of triggering it. Anything less would be this module agreeing with
 * itself.
 *
 * PURE: no database, no network, no vendor. The pricer is injected.
 */

const boardMod = require('../src/longterm/pricing/bracket-board');
const runMod = require('../src/longterm/pricing/bracket-run');
const tiers = require('../src/longterm/pricing/dscr-tiers');
const snapshot = require('../src/longterm/termsheet/snapshot');
const searchModel = require('../src/longterm/lenderprice/search-model');
const fs = require('fs');
const path = require('path');

let bad = 0;
const ok = (c, m) => { if (c) console.log('  ok   ' + m); else { bad += 1; console.error('  FAIL ' + m); } };
const section = (t) => console.log('\n' + t);

/* THE DEAL. Chosen so a real board's rate span crosses several brackets, which
   is the whole condition the feature exists for — a deal that never leaves one
   band would pass every check here while proving nothing. */
const RENT = 3000, TAX = 400, INS = 150, LOAN = 300000, TERM = 30;
const FIG = { rentMonthly: RENT, taxMonthly: TAX, insuranceMonthly: INS, loanAmount: LOAN, termYears: TERM };
const F = boardMod.readFigures(FIG);

// =============================================================================
section('A. the bracket table is SHARED, not rebuilt — the owner\'s own instruction');
// =============================================================================
{
  ok(F != null, 'CONTROL the fixture is a deal a ratio can be worked out from');
  // The instruction was: *"Don't rebuild that bracket. I want to stay that
  // bracket, just share that bracket, because if the bracket is changing you
  // should automatically change yourself as well."* Object IDENTITY is the only
  // check that proves sharing rather than agreement — two equal copies would
  // pass a value comparison and still drift the day one is edited.
  ok(snapshot.DSCR_TIERS === tiers.DSCR_TIERS,
    '⛔ the re-price rule and the board hold the SAME table object, not two equal ones');
  ok(boardMod.DSCR_TIERS === tiers.DSCR_TIERS, '…and so does the board builder');
  const snapSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'termsheet', 'snapshot.js'), 'utf8');
  const stripped = snapSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/const\s+DSCR_TIERS\s*=\s*\[/.test(stripped),
    '…and the second copy is GONE from snapshot.js, so there is nothing left to drift');
  ok(tiers.DSCR_TIERS.length === 11, `the ladder is the owner's eleven tiers (${tiers.DSCR_TIERS.length})`);
}

// =============================================================================
section('A2. one press, two speeds — and the figures are the screen\'s to send');
// =============================================================================
{
  /* ⛔ THE BAND SEARCHES ARE FIRED BY THE SEARCH PRESS, NOT BY AN EFFECT. The owner's
     shape (2026-09-01): *"You press Search once, same as today… the board appears as
     fast as it does now… a moment later the rates re-group themselves."* An effect
     would fire on re-renders nobody asked for, which is the standing rule about live
     vendor calls — "never from an effect, never on a keystroke, only on a deliberate
     press". None of that is visible to a unit test of these modules, so it is pinned
     on the SOURCE.

     ⛔ AND THE FIGURES CANNOT BE RE-READ FROM THE SCENARIO. `scenarioFields.toScenario`
     OMITS the loan amount in LTV mode, on purpose — its own comment says why. The tax
     and insurance boxes carry a monthly/yearly switch the screen has already applied,
     so reading them raw would put a yearly tax bill on the board as a monthly one: a
     payment twelve times too high, and a band wrong on every row. */
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'app-v2', 'src', 'longterm', f), 'utf8');
  const pricer = src('LtPricer.jsx');
  const bb = src('LtBracketBoard.jsx');

  ok(/runBrackets\(toScenario\(f\), bracketFigures\(/.test(pricer),
    '⛔ the Search press fires the band searches itself');
  ok(!/useEffect\([^)]*runBrackets/.test(pricer), '…and no effect fires them');
  ok(!/ltApi\./.test(bb),
    '⛔ …and the band board itself calls no vendor door at all, so a re-render can never spend a search');
  ok(/effectiveScenario: r && r\.effectiveScenario/.test(pricer),
    '⛔ the loan amount comes from the answer just received, not the previous render\'s');
  ok(/taxMonthly: perMonth\(/.test(pricer) && /insuranceMonthly: perMonth\(/.test(pricer),
    '…and the tax and insurance through `perMonth`, never the raw box');
  ok(/figures: \{ figures \}|\{ figures \}/.test(pricer),
    '…and they are forwarded to the server rather than dropped');
  ok(/setBrk\(\{ busy: false, res: null, err: null \}\);/.test(pricer),
    'a new search clears the last one\'s bands — one answer never sits under another question');
}

// =============================================================================
section('A3. a TYPED ratio above the vendor\'s ceiling is priced, not refused');
// =============================================================================
{
  /* Owner-directed 2026-09-01: *"If somebody types it in without putting in the
     scenario, types in more than 2.0, it should automatically send it to Lender
     Price as 2.0, should not be rejected."*

     ⛔ AND IT IS PRICE-NEUTRAL, WHICH IS WHAT MAKES IT SAFE RATHER THAN CONVENIENT.
     The ladder's top band is "1.50 AND ABOVE" — there is nothing above it — so 2.4
     and 2.00 are the same band and buy the same price. Lender Price refuses anything
     over 2.00 outright, so 2.00 is the strongest ratio the vendor can be told at all:
     clamping to it is the best answer available, not an approximation of one. */
  const base = {
    purpose: 'Purchase', propertyType: 'Single family', value: 400000, loan: 300000,
    termYears: 30, fico: 740, state: 'NJ', zip: '08701',
  };
  const at = (d) => searchModel.validateScenario({ ...base, dscr: d });

  const over = at(2.4);
  ok(over.ok === true, '⛔ a typed 2.4 is ACCEPTED — the whole point of the owner\'s instruction');
  ok(over.scenario.dscr === searchModel.VENDOR_MAX_DSCR,
    `…and priced at the ceiling (${over.scenario.dscr}), which is what the vendor will take`);
  ok(over.dscrClamped && over.dscrClamped.typed === 2.4 && over.dscrClamped.priced === 2,
    '⛔ …and it SAYS so — a number changed silently behind whoever typed it is the one thing this may not do');
  ok(tiers.dscrTier(2.4) === tiers.dscrTier(2),
    '⛔ …and it is price-neutral: 2.4 and 2.00 are the SAME band, so nothing is mispriced');
  ok(tiers.DSCR_TIERS[tiers.DSCR_TIERS.length - 1].to === null,
    '…because the top band is open above — there is no band beyond it to fall out of');

  // Nothing else moved.
  const atCeiling = at(2);
  ok(atCeiling.ok === true && atCeiling.dscrClamped === null,
    'a typed 2.00 is untouched and reports no clamp');
  ok(at(1.25).ok === true && at(1.25).scenario.dscr === 1.25 && at(1.25).dscrClamped === null,
    'an ordinary ratio is carried through exactly as typed');
  ok(at(-1).ok === false && at(-1).error === 'out_of_range',
    '⛔ a NEGATIVE ratio is still refused — this widens one case, not the validator');
  ok(at('x').ok === false && at('x').error === 'invalid_number', '…and junk is still refused');
  ok(at(0).ok === true && at(0).scenario.dscr === 0,
    '…and a deliberate 0 ("No DSCR") still means what it always meant');

  /* ⛔ THE CEILING IS ONE NUMBER, IMPORTED RATHER THAN RESTATED. The validator that
     REFUSES and the board that CLAMPS TO it must never drift, so the board takes the
     constant from the module that enforces it. Identity, not equality. */
  ok(boardMod.VENDOR_MAX_DSCR === searchModel.VENDOR_MAX_DSCR,
    `⛔ the board and the validator hold ONE ceiling (${boardMod.VENDOR_MAX_DSCR})`);
}

// =============================================================================
section('B. the ratio at a rate — measured, monotone, and the owner\'s own case');
// =============================================================================
{
  const r = (rate) => boardMod.ratioAtRate(F, rate);
  ok(r(6.5) === 1.23 && r(8.5) === 1.05 && r(11.125) === 0.87,
    `three rates give three ratios (${r(6.5)}, ${r(8.5)}, ${r(11.125)})`);
  // ⛔ THE PROPERTY THE WHOLE FEATURE RESTS ON. If the ratio did not fall as the
  // rate rose, a bracket would not be a contiguous run of rates and grouping by
  // it would be meaningless. Walked rather than argued.
  let monotone = true, prev = Infinity;
  for (let rate = 3; rate <= 15; rate += 0.125) {
    const v = r(Math.round(rate * 1000) / 1000);
    if (v == null || v > prev) { monotone = false; break; }
    prev = v;
  }
  ok(monotone, '⛔ the ratio falls as the rate rises, over every eighth from 3% to 15%');
  // The owner's own report: a rate priced as though the loan were at 1.25 while
  // its true ratio is far below it.
  ok(boardMod.tierAtRate(F, 11.125) !== tiers.dscrTier(1.25),
    `⛔ the reported case reproduces: 11.125% reaches tier ${boardMod.tierAtRate(F, 11.125)}, not the ${tiers.dscrTier(1.25)} it was priced in`);
  // Nothing is guessed from half a deal.
  ok(boardMod.readFigures({ ...FIG, rentMonthly: null }) === null, 'no rent → no figures, never a zero');
  ok(boardMod.readFigures({ ...FIG, taxMonthly: null }) === null, 'no property tax → no figures');
  ok(boardMod.readFigures({ ...FIG, termYears: null }) === null, 'an amortising deal with no term → no figures');
  ok(boardMod.readFigures({ ...FIG, termYears: null, interestOnly: true }) !== null,
    '…but interest-only needs no term, because the payment does not use one');
  ok(boardMod.ratioAtRate(F, null) === null && boardMod.ratioAtRate(null, 7) === null, 'an unusable input answers null');
  // The vendor's own P&I wins when it quoted one.
  const withVendor = boardMod.ratioAtRate(F, 7, 5000);
  ok(withVendor === boardMod.ratioAtRate({ ...F }, 7, 5000) && withVendor < r(7),
    '⛔ the vendor\'s own monthly P&I is used when quoted, so the ratio reconciles with the payment column');
}

// =============================================================================
section('C. the ratio a bracket is searched at always lands in that bracket');
// =============================================================================
{
  // ⛔ THIS IS THE SAFETY PROPERTY. A search ratio that fell in a neighbouring
  // band would price the wrong scenario and re-arm the very refusal this feature
  // exists to prevent. Asserted for every tier, with and without observed rates.
  let placed = 0, wrong = [];
  for (const t of tiers.DSCR_TIERS) {
    const s = boardMod.sendRatioFor(t.tier, F, []);
    if (s == null || tiers.dscrTier(s) !== t.tier) wrong.push(t.tier); else placed += 1;
  }
  ok(wrong.length === 0, `⛔ every one of the ${placed} brackets has a search ratio inside its own band`);
  // With rates in hand it takes the WORST ratio in the band — the one every
  // other rate there beats — so nothing is ever priced above what it earns.
  const rates = [{ rate: 6.5 }, { rate: 6.625 }, { rate: 6.75 }];
  const t7 = boardMod.tierAtRate(F, 6.75);
  const sent = boardMod.sendRatioFor(t7, F, rates);
  const worst = Math.min(...rates
    .map((x) => boardMod.ratioAtRate(F, x.rate))
    .filter((v) => v != null && tiers.dscrTier(v) === t7));
  ok(sent === worst, `⛔ it sends the LOWEST ratio any rate in the band reaches (${sent}), never a better one`);
  ok(tiers.dscrTier(sent) === t7, '…and that figure still sits in the band it is for');
  ok(boardMod.sendRatioFor(999, F, []) === null, 'a bracket that does not exist yields no search ratio');

  /* ⛔ THE STRONGEST BAND IS OPEN ABOVE, AND THE VENDOR IS NOT. `validateScenario`
     refuses a `criteria.dscr` outside [0, 2] before anything reaches the wire, so
     an ordinary strong deal — this one reaches 2.04 — would have had its BEST band
     refused at the door and reported as a failed search. The band nobody would
     have noticed missing. Asserted against the REAL validator, not against our own
     constant, or this would only prove the module agrees with itself. */
  const STRONG = boardMod.readFigures({ ...FIG, rentMonthly: 5000 });
  const strongRatio = boardMod.ratioAtRate(STRONG, 6.5);
  ok(strongRatio > boardMod.VENDOR_MAX_DSCR,
    `CONTROL an ordinary strong deal really does exceed the vendor's ceiling (${strongRatio})`);
  /* ⛔ AND THE VENDOR ITSELF IS ASKED, not our own constant — otherwise this only
     proves the module agrees with itself. Since 2026-09-01 the validator CLAMPS a
     typed over-ceiling ratio rather than refusing it (owner-directed), so what is
     asserted is that 2.04 CANNOT BE SENT AS TYPED: whatever reaches the wire is the
     ceiling, and the change is reported rather than made silently. */
  const vendorSays = searchModel.validateScenario({
    purpose: 'Purchase', propertyType: 'Single family', value: 400000, loan: LOAN,
    termYears: TERM, fico: 740, state: 'NJ', zip: '08701', dscr: strongRatio,
  });
  ok(vendorSays.ok === true && vendorSays.scenario.dscr === boardMod.VENDOR_MAX_DSCR,
    `CONTROL …and the vendor's own validator will not carry it as typed — it prices at ${vendorSays.scenario && vendorSays.scenario.dscr}`);
  ok(vendorSays.dscrClamped && vendorSays.dscrClamped.typed === strongRatio,
    '…and says so, rather than changing the number behind whoever typed it');
  const topBand = boardMod.tierAtRate(STRONG, 6.5);
  const clamped = boardMod.sendRatioFor(topBand, STRONG, [{ rate: 6.5 }]);
  ok(clamped === boardMod.VENDOR_MAX_DSCR,
    `⛔ so the top band is searched at the ceiling (${clamped}), not at a figure the vendor refuses`);
  ok(tiers.dscrTier(clamped) === topBand,
    '…and the clamped figure still sits in the band it is for, so it is honest as well as accepted');
}

// =============================================================================
section('D. an out-of-band quote is DROPPED, never shown');
// =============================================================================
{
  const t = boardMod.tierAtRate(F, 6.5);
  const built = boardMod.buildBoard(F, [{ tier: t, sentRatio: boardMod.sendRatioFor(t, F, []),
    quotes: [{ lender: 'A', rate: 6.5, price: 101 }, { lender: 'B', rate: 11.125, price: 99 }] }]);
  const shown = built.brackets.flatMap((b) => b.quotes.map((q) => q.rate));
  ok(shown.includes(6.5) && !shown.includes(11.125),
    '⛔ the rate whose own ratio is in another band is dropped from this band\'s row');
  ok(built.droppedOutOfBand === 1, `…and the drop is COUNTED (${built.droppedOutOfBand}), never silent`);
  ok(built.brackets[0].quotes[0].dscr === boardMod.ratioAtRate(F, 6.5),
    'every shown quote carries the ratio it actually reaches');
  /* ⛔ A RATE IS WHATEVER THE VENDOR SAYS IT IS — no eighths assumed anywhere. The
     owner raised this directly: rates usually step by eighths (6.125, 6.25, 6.375)
     but the edges vary (7.499, 6.99, 6.990, 6.999). Nothing here rounds a rate, snaps
     it to a grid, or keys anything on its text, so an odd rate bands on its own
     arithmetic like any other — asserted rather than assumed, because a rate quietly
     snapped to a neighbouring eighth would land in a neighbouring band on the edges. */
  const ODD = [7.499, 6.99, 6.999, 6.125, 6.375];
  const oddTier = boardMod.tierAtRate(F, 6.99);
  const oddBuilt = boardMod.buildBoard(F, ODD.map((rate) => ({
    tier: boardMod.tierAtRate(F, rate), sentRatio: boardMod.sendRatioFor(boardMod.tierAtRate(F, rate), F, [{ rate }]),
    quotes: [{ lender: 'X', rate, price: 100 }],
  })).filter((r) => r.tier != null));
  const oddShown = oddBuilt.brackets.flatMap((b) => b.quotes.map((q) => q.rate));
  ok(ODD.every((r) => oddShown.includes(r)),
    `⛔ every odd rate survives with its exact value (${oddShown.join(', ')})`);
  ok(oddBuilt.droppedOutOfBand === 0, '…and none of them is dropped as out of band');
  ok(boardMod.ratioAtRate(F, 6.99) === boardMod.ratioAtRate(F, 6.990),
    '6.99 and 6.990 are the same rate and reach the same ratio');
  ok(oddTier != null && boardMod.ratioAtRate(F, 6.999) <= boardMod.ratioAtRate(F, 6.99),
    '…and 6.999 is genuinely dearer than 6.99, never rounded onto it');
  /* ⛔ THE SERVER WRITES THE RATIO, NOT THE SCREEN. `test-lt-pipeline-columns-pure`
     forbids an LT screen defining a formatter of its own — because `pct` takes a
     whole percent and `rate` takes a fraction, and a hand-rolled copy prints
     0.97% or 7250.0% on a figure somebody quotes out loud. The shared set has no
     two-place ratio, and the shared `ratio` trims trailing zeros, so "1.2" would
     sit beside a band labelled "1.20". So the band and the quote carry their own
     TEXT, from the same place that decided the number — which is the design this
     whole feature rests on rather than a workaround for the guard. */
  ok(built.brackets[0].sentRatioText === boardMod.sendRatioFor(t, F, []).toFixed(2)
    && /^\d+\.\d{2}$/.test(built.brackets[0].sentRatioText),
    `⛔ the band carries its search ratio as text, two places (${built.brackets[0].sentRatioText})`);
  ok(/^\d+\.\d{2}$/.test(built.brackets[0].quotes[0].dscrText),
    `…and every quote carries its own ratio the same way (${built.brackets[0].quotes[0].dscrText})`);
  ok(boardMod.ratioText(1.2) === '1.20' && boardMod.ratioText(null) === null,
    '…never trimmed to "1.2", and a figure that is not a ratio has no text at all');
  ok(boardMod.selfConsistent(F, { rate: 6.5 }, t) === true
    && boardMod.selfConsistent(F, { rate: 11.125 }, t) === false,
    'the invariant is askable of one quote on its own');
}

// =============================================================================
async function main() {
  section('E. the run discovers brackets round by round, converges, and reports failures');
  /* A STUB VENDOR THAT BEHAVES LIKE THE REAL ONE IN THE ONE WAY THAT MATTERS:
     an investor only appears when the search ratio reaches its own minimum. That
     is the whole reason a single-search board cannot see the low brackets, and a
     stub that returned the same rates whatever was asked would make the
     discovery loop look unnecessary. */
  const asked = [];
  const prog = (lender, rates) => ({ lender, program: lender + ' DSCR', rungs: rates.map((x) => ({ rate: x, price: 100, monthly: null })) });
  const mkRun = () => async (dscr) => {
    asked.push(dscr);
    const programs = [prog('Broad', [6.5, 7.0, 8.5])];
    // "Harbor" prices only for weak ratios — invisible to any search asked high.
    if (dscr < 1.00) programs.push(prog('Harbor', [10.5, 11.125]));
    return { ok: true, parsed: { programs } };
  };
  /* THE SEED IS THE BAND THE OFFICER'S OWN SCENARIO SITS IN. There is deliberately
     no probe search any more: the officer has just pressed Search, so pricing the
     deal again to discover which bands to ask about would spend a vendor call
     re-asking a question answered a moment ago. */
  const SEED = boardMod.ratioAtRate(F, 7.0);
  const run = (extra) => runMod.priceByBracket(FIG, mkRun(), Object.assign({ seedDscr: SEED }, extra || {}));

    const out = await run();
    ok(out.ok === true, 'the run comes back');
    const shownTiers = out.brackets.map((b) => b.tier);
    ok(shownTiers.length > 1, `⛔ the board is split across several brackets (${shownTiers.join(', ')})`);
    ok(shownTiers.join(',') === [...shownTiers].sort((a, b) => b - a).join(','),
      '⛔ strongest bracket first — the owner\'s own economics, and it falls out of the arithmetic');
    // The cheapest rate really is in the strongest bracket.
    const best = out.brackets[0];
    const worst = out.brackets[out.brackets.length - 1];
    ok(best.bestRate < worst.bestRate,
      `⛔ the cheapest rate (${best.bestRate}%) sits in the strongest bracket and the dearest (${worst.bestRate}%) in the weakest`);
    // The discovery loop found the investor no single search could have shown.
    const harbor = out.brackets.some((b) => b.quotes.some((q) => q.lender === 'Harbor'));
    ok(harbor, '⛔ an investor that only prices at a low ratio IS found — the answer to "don\'t go only by the rates that are coming up"');
    ok(asked.length <= boardMod.MAX_BRACKETS, `it converges (${asked.length} searches, ceiling ${boardMod.MAX_BRACKETS})`);
    ok(asked.every((a) => a != null),
      '⛔ NO PROBE SEARCH — every call carries a real ratio, so nothing re-asks the search the officer just ran');
    const sent = asked.filter((a) => a != null);
    ok(new Set(sent).size === sent.length, '⛔ no bracket is ever priced twice');
    ok(out.searchCount === sent.length, `the search count is honest (${out.searchCount})`);

    // ⛔ EVERY QUOTE IS PRICED IN THE BAND ITS OWN RATE REACHES — the invariant.
    let breaches = 0;
    for (const b of out.brackets) for (const q of b.quotes) if (!boardMod.selfConsistent(F, q, b.tier)) breaches += 1;
    ok(breaches === 0, '⛔ THE INVARIANT: every quote on the finished board is priced in the band its own rate reaches');

    // ── empties and failures are two different facts ────────────────────────
    const emptyRun = await runMod.priceByBracket(FIG, async () => ({ ok: true, parsed: { programs: [] } }), { seedDscr: SEED });
    ok(emptyRun.brackets.length === 0 && emptyRun.empty.length > 0,
      'a bracket that came back with nothing is not drawn as a row…');
    ok(emptyRun.empty.every((b) => b.emptyReason),
      '…and SAYS why it is empty, so silence is never mistaken for "we did not look"');

    const failRun = await runMod.priceByBracket(FIG, async () => ({ ok: false, error: 'lp_price_500_after_retry', message: 'upstream' }), { seedDscr: SEED });
    ok(failRun.ok === true && failRun.failedBrackets.length > 0 && failRun.brackets.length === 0,
      '⛔ a bracket whose search FAILED is reported as a failure, never as a bracket with no rates');
    ok(failRun.failedBrackets[0].error === 'lp_price_500_after_retry', '…carrying the vendor\'s own reason');

    const noSeed = await runMod.priceByBracket(FIG, mkRun(), {});
    ok(noSeed.ok === false && noSeed.error === 'lt_bracket_no_seed',
      'with neither a ratio nor a board to start from it refuses plainly, rather than guessing a band');
    const noFigs = await runMod.priceByBracket({ rentMonthly: 3000 }, mkRun(), { seedDscr: SEED });
    ok(noFigs.ok === false && noFigs.error === 'lt_bracket_figures_incomplete',
      'half a deal is refused with a reason, never bracketed on guesses');

    // =========================================================================
    section('F. ⛔ THE OWNER\'S REFUSAL CANNOT FIRE ON A BOARD BUILT THIS WAY');
    // =========================================================================
    /* Not an assertion about this module — the REAL export gate, the one that
       produced the owner's sentence, run over a REAL snapshot built from each
       quote the board offers. */
    const PLAN = { borrowerPaid: 2, ysp: 2, lenderPaid: 2, applicationFee: 500, commitmentFee: 1595 };
    const PREP = { borrowerName: 'Miriam Rosenberg', propertyAddress: '14 Oak Street, Lakewood, NJ 08701' };
    const scFor = (dscr) => ({
      purpose: 'Purchase', propertyType: 'Single family', value: 400000, loan: LOAN, ltv: 75,
      termYears: TERM, fico: 740, state: 'NJ', city: 'Lakewood', zip: '08701',
      rentMonthly: RENT, taxMonthly: TAX, insuranceMonthly: INS, hoaMonthly: 0,
      prepayMonths: 60, prepayStructure: '5 Year', dscr,
    });
    let checked = 0, refused = [];
    for (const b of out.brackets) {
      for (const q of b.quotes) {
        const built = snapshot.buildSnapshot({
          selections: [{ label: 'A', consumerLabel: 'Platinum A', product: '30-Year Fixed DSCR', mode: 'borrowerPaid',
            ratePct: q.rate, rawPrice: 100, scenario: scFor(b.sentRatio), pricedAt: '2026-09-01T13:00:00.000Z' }],
          plan: PLAN, prepared: PREP,
        });
        const g = snapshot.exportGate(built.snapshot);
        checked += 1;
        if (g && g.error === 'dscr_below_priced') refused.push(`${q.rate}% in band ${b.label}`);
      }
    }
    ok(checked > 0, `CONTROL there were ${checked} quotes to put through the real export gate`);
    ok(refused.length === 0,
      `⛔ NOT ONE of the ${checked} quotes triggers "has moved band" — the reported failure is structurally impossible here`
      + (refused.length ? ` (${refused.join('; ')})` : ''));

    /* AND THE CONTROL, WITHOUT WHICH THE ABOVE PROVES NOTHING: the same gate,
       the same quotes, priced the OLD way — one assumed ratio for the whole
       board — must refuse. If it did not, section F would be passing because the
       gate never fires rather than because the board is sound. */
    let oldRefused = 0;
    for (const b of out.brackets) {
      for (const q of b.quotes) {
        const built = snapshot.buildSnapshot({
          selections: [{ label: 'A', consumerLabel: 'Platinum A', product: '30-Year Fixed DSCR', mode: 'borrowerPaid',
            ratePct: q.rate, rawPrice: 100, scenario: scFor(1.25), pricedAt: '2026-09-01T13:00:00.000Z' }],
          plan: PLAN, prepared: PREP,
        });
        const g = snapshot.exportGate(built.snapshot);
        if (g && g.error === 'dscr_below_priced') oldRefused += 1;
      }
    }
    ok(oldRefused > 0,
      `⛔ CONTROL: the same rates priced the old way — one assumed 1.25 for the whole board — DO refuse (${oldRefused} of ${checked}), which is the bug`);

    console.log(bad ? `\n${bad} FAILED` : '\nALL PASSED');
  process.exit(bad ? 1 : 0);
}

main();
