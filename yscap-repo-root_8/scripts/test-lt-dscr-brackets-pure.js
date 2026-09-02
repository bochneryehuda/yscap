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
/* ⛔ A CRASHING TEST IS NOT A FAILING TEST, AND IT IS WORSE THAN ONE.
   A `priceByBracket` that refuses answers `{ok:false}` with no `brackets`, so a bare
   `res.brackets.length` throws a TypeError, kills the process and stops the battery
   where it stands — every assertion after it silently never runs. Found by the
   post-merge audit of #1405: two mutations were genuinely caught by their own
   assertion and then took the whole suite down with them, which would mask any
   LATER mutation behind an EARLIER one. `list()` reads a possibly-absent array as
   empty, so the assertion states a false fact and the run carries on to the end. */
const list = (v) => (Array.isArray(v) ? v : []);
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
section('A2. the bands are IN the board, not a section of their own');
// =============================================================================
{
  /* Owner-directed 2026-09-01, correcting the first cut: *"I don't like it this way.
     It should not be a separate section… before 5.75 it should say which bracket this
     is… and after 6.125 it should say here is a break that changed the bracket.
     Basically the same as it was before. Every rate and every investor added, but that
     whole section should be divided in brackets, and it should work the same."*

     None of that is visible to a unit test of these modules, so it is pinned on the
     SOURCE. */
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'app-v2', 'src', 'longterm', f), 'utf8');
  const pricer = src('LtPricer.jsx');

  ok(!fs.existsSync(path.join(__dirname, '..', 'app-v2', 'src', 'longterm', 'LtBracketBoard.jsx')),
    '⛔ the separate section is GONE — its file no longer exists');
  ok(!/LtBracketBoard/.test(pricer), '…and nothing mounts it any more');

  ok(/export function bandedStack\(/.test(pricer),
    '⛔ the board is built banded — headings interleaved with the ordinary rate rows');
  ok(/kind: 'band'/.test(pricer) && /kind: 'rate'/.test(pricer),
    '…as one flat list, so the row keys and the expand-all set stay a single sequence');
  ok(/const st = buildRateStack\(programs \|\| \[\]\);/.test(pricer),
    '⛔ …and each band goes through the SAME `buildRateStack` the whole board uses, so a row behaves identically');
  ok(/<BandDivider key=\{it\.key\}/.test(pricer) && /<RateRow key=\{it\.key\} row=\{it\.row\}/.test(pricer),
    '⛔ the divider and the ordinary row are rendered from ONE walk of that list');
  ok(/key: `\$\{b\.tier\}:\$\{r\.key\}`/.test(pricer),
    '⛔ a row key carries its band — one rate can sit in two bands at two prices, and a shared key would collapse them');
  ok(/banded \|\| \{ items: stack\.rates\.map/.test(pricer),
    '⛔ until the band searches land it walks the ordinary stack — the board keeps its usual speed');

  // The press still fires them, and still not from an effect.
  ok(/runBrackets\(toScenario\(f\), bracketFigures\(/.test(pricer),
    'the Search press fires the band searches itself');
  ok(!/useEffect\([^)]*runBrackets/.test(pricer), '…and no effect fires them');
  ok(/effectiveScenario: r && r\.effectiveScenario/.test(pricer),
    'the loan amount comes from the answer just received, not the previous render\'s');
  ok(/taxMonthly: perMonth\(/.test(pricer) && /insuranceMonthly: perMonth\(/.test(pricer),
    '…and the tax and insurance through `perMonth`, never the raw box');
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
  /* ⛔ THE FIXTURE IS THE **FULL** PARSE SHAPE, because that is what the board is
     built from now — `priceBuild.noteRate`, `options[]` — so a band renders with the
     same rows, the same lender grouping and the same details panel as the whole
     board. A `{rate, price}` fixture would be testing a shape the screen never
     receives. */
  const opt = (rate, price) => ({ priceBuild: { noteRate: rate, price }, monthlyPayment: null });
  const built = boardMod.buildBoard(F, [{ tier: t, sentRatio: boardMod.sendRatioFor(t, F, []),
    programs: [{ lender: 'A', options: [opt(6.5, 101), opt(11.125, 99)] }] }]);
  const shown = list(built.brackets).flatMap((b) => list(b.programs).flatMap((p) => p.options.map((o) => o.priceBuild.noteRate)));
  ok(shown.includes(6.5) && !shown.includes(11.125),
    '⛔ the rate whose own ratio is in another band is dropped from this band\'s row');
  ok(built.droppedOutOfBand === 1, `…and the drop is COUNTED (${built.droppedOutOfBand}), never silent`);
  ok(built.brackets?.[0]?.programs?.[0]?.options?.[0]?.dscr === boardMod.ratioAtRate(F, 6.5),
    'every shown quote carries the ratio it actually reaches, ON the option the screen draws');
  /* AND THE SUMMARY SHAPE STILL WORKS — the discovery loop may be handed either, and
     one reading of "where does a rate live" serves both. */
  const rungBuilt = boardMod.buildBoard(F, [{ tier: t, sentRatio: boardMod.sendRatioFor(t, F, []),
    programs: [{ lender: 'A', rungs: [{ rate: 6.5, price: 101 }, { rate: 11.125, price: 99 }] }] }]);
  ok(rungBuilt.brackets?.[0]?.quoteCount === 1 && rungBuilt.droppedOutOfBand === 1,
    'the summary parse shape bands identically — one reading of where a rate lives, not two');
  /* ⛔ A RATE IS WHATEVER THE VENDOR SAYS IT IS — no eighths assumed anywhere. The
     owner raised this directly: rates usually step by eighths (6.125, 6.25, 6.375)
     but the edges vary (7.499, 6.99, 6.990, 6.999). Nothing here rounds a rate, snaps
     it to a grid, or keys anything on its text, so an odd rate bands on its own
     arithmetic like any other — asserted rather than assumed, because a rate quietly
     snapped to a neighbouring eighth would land in a neighbouring band on the edges. */
  const ODD = [7.499, 6.99, 6.999, 6.125, 6.375];
  const oddBuilt = boardMod.buildBoard(F, ODD.map((rate) => ({
    tier: boardMod.tierAtRate(F, rate),
    sentRatio: boardMod.sendRatioFor(boardMod.tierAtRate(F, rate), F, [{ rate }]),
    programs: [{ lender: 'X', options: [opt(rate, 100)] }],
  })).filter((r) => r.tier != null));
  const oddShown = list(oddBuilt.brackets).flatMap((b) => list(b.programs).flatMap((p) => p.options.map((o) => o.priceBuild.noteRate)));
  ok(ODD.every((r) => oddShown.includes(r)),
    `⛔ every odd rate survives with its exact value (${oddShown.join(', ')})`);
  ok(oddBuilt.droppedOutOfBand === 0, '…and none of them is dropped as out of band');
  ok(boardMod.ratioAtRate(F, 6.99) === boardMod.ratioAtRate(F, 6.990),
    '6.99 and 6.990 are the same rate and reach the same ratio');
  ok(boardMod.ratioAtRate(F, 6.999) <= boardMod.ratioAtRate(F, 6.99),
    '…and 6.999 is genuinely dearer than 6.99, never rounded onto it');
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
    const shownTiers = list(out.brackets).map((b) => b.tier);
    ok(shownTiers.length > 1, `⛔ the board is split across several brackets (${shownTiers.join(', ')})`);
    ok(shownTiers.join(',') === [...shownTiers].sort((a, b) => b - a).join(','),
      '⛔ strongest bracket first — the owner\'s own economics, and it falls out of the arithmetic');
    // The cheapest rate really is in the strongest bracket.
    const best = list(out.brackets)[0] || {};
    const worst = list(out.brackets)[list(out.brackets).length - 1];
    ok(best.bestRate < worst.bestRate,
      `⛔ the cheapest rate (${best.bestRate}%) sits in the strongest bracket and the dearest (${worst.bestRate}%) in the weakest`);
    // The discovery loop found the investor no single search could have shown.
    const harbor = list(out.brackets).some((b) => b.programs.some((p) => p.lender === 'Harbor'));
    ok(harbor, '⛔ an investor that only prices at a low ratio IS found — the answer to "don\'t go only by the rates that are coming up"');
    ok(asked.length <= boardMod.MAX_BRACKETS, `it converges (${asked.length} searches, ceiling ${boardMod.MAX_BRACKETS})`);
    ok(asked.every((a) => a != null),
      '⛔ NO PROBE SEARCH — every call carries a real ratio, so nothing re-asks the search the officer just ran');
    const sent = asked.filter((a) => a != null);
    ok(new Set(sent).size === sent.length, '⛔ no bracket is ever priced twice');
    ok(out.searchCount === sent.length, `the search count is honest (${out.searchCount})`);

    // ⛔ EVERY QUOTE IS PRICED IN THE BAND ITS OWN RATE REACHES — the invariant.
    let breaches = 0;
    for (const b of out.brackets) for (const p of b.programs) for (const o of boardMod.optionsOf(p)) {
      const { rate, monthlyPi } = boardMod.optionRate(o);
      if (!boardMod.selfConsistent(F, { rate, monthlyPi }, b.tier)) breaches += 1;
    }
    ok(breaches === 0, '⛔ THE INVARIANT: every quote on the finished board is priced in the band its own rate reaches');

    // ── empties and failures are two different facts ────────────────────────
    const emptyRun = await runMod.priceByBracket(FIG, async () => ({ ok: true, parsed: { programs: [] } }), { seedDscr: SEED });
    ok(list(emptyRun.brackets).length === 0 && list(emptyRun.empty).length > 0,
      'a bracket that came back with nothing is not drawn as a row…');
    ok(emptyRun.empty.every((b) => b.emptyReason),
      '…and SAYS why it is empty, so silence is never mistaken for "we did not look"');

    const failRun = await runMod.priceByBracket(FIG, async () => ({ ok: false, error: 'lp_price_500_after_retry', message: 'upstream' }), { seedDscr: SEED });
    ok(failRun.ok === true && list(failRun.failedBrackets).length > 0 && list(failRun.brackets).length === 0,
      '⛔ a bracket whose search FAILED is reported as a failure, never as a bracket with no rates');
    ok((list(failRun.failedBrackets)[0] || {}).error === 'lp_price_500_after_retry', '…carrying the vendor\'s own reason');

    /* ⛔ NO RATIO TYPED IS NOT A REFUSAL ANY MORE (owner-directed 2026-09-01: *"we
       don't need a target rate anymore… If you don't have a targeted rate, go by the
       average… do it in your backend."*). Asking an officer for a ratio was the tail
       wagging the dog: a ratio needs a payment, a payment needs a rate, and the rates
       are what the search is FOR. The server works a starting band out from a typical
       coupon and the frontier finds the rest from what actually comes back — so the
       seed picks the first question, never a price. */
    const noRatio = await runMod.priceByBracket(FIG, mkRun(), {});
    ok(noRatio.ok === true, '⛔ a deal with NO typed ratio still prices — the officer supplies nothing');
    ok(list(noRatio.brackets).length > 1,
      `…and still finds several bands (${list(noRatio.brackets).map((b) => b.tier).join(', ')})`);
    ok(noRatio.seedTier === boardMod.dscrTier(boardMod.seedRatioFrom(F, null)),
      `…starting from the band a typical ${boardMod.TYPICAL_RATE_PCT}% coupon reaches (band ${noRatio.seedTier})`);
    const typedWins = await runMod.priceByBracket(FIG, mkRun(), { seedDscr: 1.45 });
    ok(typedWins.seedTier === boardMod.dscrTier(1.45),
      '…and a ratio somebody DID type still wins — they know their deal');
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
      for (const q of list(b.programs).flatMap((p) => boardMod.optionsOf(p).map((o) => boardMod.optionRate(o)))) {
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
      for (const q of list(b.programs).flatMap((p) => boardMod.optionsOf(p).map((o) => boardMod.optionRate(o)))) {
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


    // =========================================================================
    section('G. ⛔ THE SHEET JUDGES THE BAND THE OPTION WAS PRICED IN — NOT THE FORM\'S RATIO');
    // =========================================================================
    /* Owner-reported 2026-09-02, the day after the banded board shipped: *"Option
       5.75% — Harbor has moved band. These figures come to 1.25, a higher DSCR band
       than the 1.14 it was priced in… the 5.75 was actually priced on the 1.25 band…
       You should not look at the original scenario. You should look at what was the
       actual pricing on."*

       Section F proved the gate cannot fire on this board — but it built each
       selection with `scenario.dscr` = the band's own ratio, which is what the
       browser SHOULD have sent and did not. The real screen sent the FORM's ratio for
       every option, so every option outside the seed's band read as "moved band".
       This section builds selections the way the browser now builds them — the
       form's ratio as the scenario, the option's own stamp as `pricedDscr` — and
       runs the real gate. The control drops the stamp and the owner's sentence
       comes straight back. */
    const FORM = 1.14;                                   // the owner's typed ratio, band 6
    const formTier = tiers.dscrTier(FORM);
    const stamped = [];                                  // every option, with its stamp
    for (const b of list(out.brackets)) {
      for (const p of list(b.programs)) {
        for (const o of boardMod.optionsOf(p)) {
          const { rate } = boardMod.optionRate(o);
          stamped.push({ rate, dscr: o.dscr, tier: o.dscrTier, band: b.label });
        }
      }
    }
    const elsewhere = stamped.filter((q) => q.tier !== formTier);
    ok(stamped.length > 0 && stamped.every((q) => Number.isFinite(q.dscr) && Number.isInteger(q.tier)),
      `CONTROL every option on the board carries its own ratio and band (${stamped.length} options)`);
    ok(elsewhere.length > 0,
      `CONTROL ${elsewhere.length} of them were priced in a band OTHER than the form's ${FORM} (band ${formTier}) — the case the report is about`);

    const selFor = (q, withStamp) => ({
      label: 'A', consumerLabel: 'Platinum A', product: '30-Year Fixed DSCR', mode: 'borrowerPaid',
      ratePct: q.rate, rawPrice: 100, scenario: scFor(FORM), pricedAt: '2026-09-01T13:00:00.000Z',
      ...(withStamp ? { pricedDscr: q.dscr } : {}),
    });
    const gateOf = (sel) => {
      const built = snapshot.buildSnapshot({ selections: [sel], plan: PLAN, prepared: PREP });
      return built.ok ? snapshot.exportGate(built.snapshot) : { error: built.error };
    };

    const nowRefused = stamped.filter((q) => (gateOf(selFor(q, true)) || {}).error === 'dscr_below_priced');
    ok(nowRefused.length === 0,
      `⛔ selections built the way the browser now builds them — form ${FORM}, the option's own stamp — pass the real gate: ${stamped.length - nowRefused.length} of ${stamped.length}`
      + (nowRefused.length ? ` (refused: ${nowRefused.map((q) => `${q.rate}% in ${q.band}`).join('; ')})` : ''));

    const wasRefused = stamped.filter((q) => (gateOf(selFor(q, false)) || {}).error === 'dscr_below_priced');
    ok(wasRefused.length === elsewhere.length && wasRefused.length > 0,
      `⛔ CONTROL: the same selections WITHOUT the stamp refuse exactly the options outside the form's band (${wasRefused.length} of ${stamped.length}) — which is the owner's report`);
    const first = elsewhere[0] && gateOf(selFor(elsewhere[0], false));
    ok(!!first && /it was priced in/.test(first.message || '') && new RegExp(FORM.toFixed(2).replace('.', '\\.')).test(first.message || ''),
      `…and the control's sentence names the form's ${FORM.toFixed(2)} as "the ratio it was priced in", which is the misreading`);

    /* WHAT THE MEMBER SAYS IT WAS PRICED AT. The stamp becomes the member's own
       scenario ratio — the scenario as it was PRICED for this option — so the cart
       stores it, the document prints it and the re-price rule judges it, all from
       one field. */
    const one = elsewhere[0] || stamped[0];
    const m = snapshot.buildMember(selFor(one, true), PLAN);
    ok(m.ok && m.member.scenario.dscr === one.dscr && m.member.dscr === one.dscr,
      `the member's scenario carries the ratio it was PRICED at (${one.dscr}), not the form's ${FORM}`);
    const bare = snapshot.buildMember(selFor(one, false), PLAN);
    ok(bare.ok && bare.member.scenario.dscr === FORM,
      `…and with no stamp — an unbracketed board, an older cart — the form's ratio stands (${FORM})`);
    for (const [label, junk] of [['0', 0], ['-1', -1], ['"x"', 'x'], ['""', ''], ['null', null], ['NaN', NaN]]) {
      const j = snapshot.buildMember({ ...selFor(one, false), pricedDscr: junk }, PLAN);
      ok(j.ok && j.member.scenario.dscr === FORM,
        `…a stamp of ${label} is ignored, never judged on (scenario keeps ${FORM})`);
    }

    /* ⛔ AND THE RULE ITSELF DID NOT SOFTEN. A stamp is a fact about where the price
       came from, not a licence: figures that leave that band still refuse, both ways. */
    const bandOf = one.tier;
    const lower = tiers.DSCR_TIERS.find((t) => t.tier === bandOf - 1);
    const higher = tiers.DSCR_TIERS.find((t) => t.tier === bandOf + 1);
    if (lower || higher) {
      const pull = (ratio) => {
        // Rent that produces `ratio` against THIS option's own payment.
        const built = snapshot.buildMember(selFor(one, true), PLAN);
        const pi = built.member.monthlyPI;
        return Math.ceil(ratio * (pi + TAX + INS));
      };
      if (lower) {
        const g = gateOf({ ...selFor(one, true), scenario: { ...scFor(FORM), rentMonthly: pull(lower.from + 0.001) } });
        ok(g && g.error === 'dscr_below_priced' && g.direction === 'down',
          `figures that drop this option into band ${lower.tier} still refuse, downward`);
      }
      if (higher) {
        const g = gateOf({ ...selFor(one, true), scenario: { ...scFor(FORM), rentMonthly: pull(higher.from + 0.001) } });
        ok(g && g.error === 'dscr_below_priced' && g.direction === 'up',
          `figures that lift this option into band ${higher.tier} still refuse, upward`);
      }
    }


    // =========================================================================
    section('H. ⛔ EACH OPTION\'S RATIO COMES FROM THE VENDOR\'S OWN PAYMENT — INTEREST-ONLY INCLUDED — NEVER FROM THE CALCULATOR');
    // =========================================================================
    /* Owner, 2026-09-02: *"make sure that the same bracket levels calculate
       accordingly to the principal, interest, taxes, and insurance. If it's
       interest-only, it calculates it differently according to the interest-only
       monthly payments, so the ratios are better, and all the brackets get
       adjusted… make sure it's calculated from the actual payment and not from
       your search calculator, which may be wrong."*

       `ratioAtRate` takes the vendor's quoted monthly P&I when the option carries
       one and recomputes only when the vendor was silent — and that recompute
       honours the scenario's interest-only flag. Neither path reads the
       calculator. Pinned from the outside so a refactor cannot quietly route the
       board back through an estimate. */
    const vendorPI = 1234.56;                                    // a figure no amortisation of LOAN at these rates produces
    const withVendor = boardMod.ratioAtRate(F, 7.0, vendorPI);
    const expectVendor = Math.round((RENT / (Math.round((vendorPI + TAX + INS) * 100) / 100)) * 100) / 100;
    ok(withVendor === expectVendor,
      `⛔ with a vendor payment on the option, the ratio is rent ÷ (THAT payment + taxes + insurance): ${withVendor} = ${expectVendor}`);
    const silent = boardMod.ratioAtRate(F, 7.0, null);
    ok(silent != null && silent !== withVendor,
      `…and with the vendor silent it recomputes from the rate instead (${silent}), so the two are visibly different paths`);
    const asOption = boardMod.optionRate({ priceBuild: { noteRate: 7.0 }, monthlyPayment: { monthlyPI: vendorPI } });
    ok(asOption.rate === 7.0 && asOption.monthlyPi === vendorPI,
      '…and an option\'s own `monthlyPayment.monthlyPI` is what `optionRate` hands to it');

    // INTEREST-ONLY: the same loan at the same rate carries a smaller payment, so the
    // ratio is higher and can sit in a better band — "all the brackets get adjusted".
    const Fio = boardMod.readFigures({ ...FIG, interestOnly: true });
    ok(Fio != null && Fio.interestOnly === true, 'CONTROL an interest-only reading of the same deal is accepted');
    const rAmort = boardMod.ratioAtRate(F, 7.5, null);
    const rIO = boardMod.ratioAtRate(Fio, 7.5, null);
    const ioPayment = Math.round((LOAN * (7.5 / 100) / 12) * 100) / 100;
    const expectIO = Math.round((RENT / (Math.round((ioPayment + TAX + INS) * 100) / 100)) * 100) / 100;
    ok(rIO === expectIO,
      `⛔ vendor silent + interest-only: the fallback uses the interest-only payment (loan × rate ÷ 12 = ${ioPayment}) → ${rIO}`);
    ok(rIO > rAmort,
      `…which is a BETTER ratio than the amortising one at the same rate (${rIO} > ${rAmort})`);
    ok(tiers.dscrTier(rIO) >= tiers.dscrTier(rAmort),
      `…so the option lands in the same or a stronger band (band ${tiers.dscrTier(rIO)} vs ${tiers.dscrTier(rAmort)})`);
    // And a vendor payment on an IO product is simply the vendor's IO payment — no special case.
    ok(boardMod.ratioAtRate(Fio, 7.5, ioPayment) === rIO,
      '…and a vendor that quotes that same IO payment lands on exactly the same ratio — one arithmetic, two sources');

    // NOTHING HERE READS THE CALCULATOR. The typical coupon seeds which band is asked
    // FIRST; it never enters a ratio.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'pricing', 'bracket-board.js'), 'utf8');
    const fn = /function ratioAtRate\([\s\S]*?\n\}/.exec(src);
    ok(!!fn && !/TYPICAL_RATE_PCT|dscrCalc|seedRatio/.test(fn[0]),
      '⛔ `ratioAtRate` reads the vendor payment or recomputes from THIS rate — never the seed coupon or the calculator');
    ok(!/require\(.*dscrCalc/.test(src), '…and the board module imports no browser calculator at all');

    console.log(bad ? `\n${bad} FAILED` : '\nALL PASSED');
  process.exit(bad ? 1 : 0);
}

main();
