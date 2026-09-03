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
  /* ⛔ RE-POINTED, NOT LOOSENED, by the owner-authorised cut-down of 2026-09-03
     ("Round it down, same as everywhere else"). 6.5% used to read 1.23 because the
     ratio was ROUNDED TO NEAREST; its true figure is 1.2299…, so the band it has
     actually earned is 1.22. The other two are unmoved — the change only ever bites
     where the third decimal was lifting a loan into a band above its own. */
  ok(r(6.5) === 1.22 && r(8.5) === 1.05 && r(11.125) === 0.87,
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
    /* ⛔ CUT with this test's OWN arithmetic, never by calling the production rule —
       an expectation that asked `sendAs` would agree with whatever `sendAs` did and
       prove nothing. A plain floor is a second, independent implementation of "cut
       down to two decimals"; on this fixture (1.2371…) it is nowhere near a float
       boundary, so the two can only disagree if the production rule stops cutting. */
    const expectIO = Math.floor((RENT / (Math.round((ioPayment + TAX + INS) * 100) / 100)) * 100) / 100;
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
    /* ⛔ THROUGH THE SHARED STRIPPER, like every other "must not appear" rule in this file.
       This one read the RAW source, which can only ever fail wrongly (a comment naming the
       calculator would trip it) and never pass wrongly — safe, but the odd one out, and the
       pre-merge audit of 2026-09-03 flagged it as fragile. */
    const { stripComments: stripSrc } = require('./lib/strip-comments');
    ok(!/require\(.*dscrCalc/.test(stripSrc(src)), '…and the board module imports no browser calculator at all');

  }

  // =============================================================================
  section('N. the band is searched at a ratio the loan has EARNED — cut down, never rounded up');
  // =============================================================================
  {
    /* ⛔ THE OWNER-AUTHORISED CHANGE OF 2026-09-03. Asked what to do about the bands
       still rounding the DSCR to nearest, the owner answered: *"Round it down, same as
       everywhere else."* That is the standing rule of 2026-08-30 finally reaching the one
       surface it had been left off. THIS MOVES PRICES, so it is measured rather than
       asserted, and measured against a baseline built by NEUTRALISING this file's own
       changed line — never by reading git, which proves inertness only until the change
       is committed and then compares the engine to itself. */
    const Module = require('module');
    const bbPath = path.join(__dirname, '..', 'src', 'longterm', 'pricing', 'bracket-board.js');
    const bbSrc = fs.readFileSync(bbPath, 'utf8');
    /* ⛔ THE STRIP MATCHES THE LEVER'S SHAPE, NOT ITS EXACT TEXT, and that is not
       convenience — it is what stops the whole comparison degenerating. A literal string
       match fails the moment somebody edits the ARGUMENT (`… / pitia + 0.005`), the
       baseline is then the UNCHANGED source, `BEFORE === AFTER`, and "not one ratio went
       up" passes because nothing was compared. MEASURED: that exact mutation made N3 pass
       for the wrong reason. So the shape is matched, and N4's `moved > 0` is folded into
       N3 below so a degenerate baseline can never satisfy the safety property either. */
    /* The FIELD is matched loosely too. A lever asking for the wrong field ('ltv' cuts
       the other way) must still be STRIPPED, or the guard refuses to build a baseline and
       N3 stands down on the very mutation it exists to catch. */
    const LEVER_RE = /tierRounding\.sendAs\('[a-z]+',\s*([^;]*?),\s*2\)/g;
    const found = bbSrc.match(LEVER_RE) || [];
    ok(found.length === 2,
      `N0 CONTROL: the board settles a DSCR through the one door in exactly two places (${found.length}) — the ratio and the search ratio`);
    const inRatio = /function ratioAtRate\([\s\S]*?\n\}/.exec(bbSrc);
    const ratioLever = inRatio ? (inRatio[0].match(LEVER_RE) || []) : [];
    ok(ratioLever.length === 1,
      `N0a …one of them inside \`ratioAtRate\`, which is the one this baseline neutralises (${ratioLever.length})`);
    const baseSrc = ratioLever.length === 1
      ? bbSrc.replace(ratioLever[0], ratioLever[0].replace(LEVER_RE, 'Math.round(($1) * 100) / 100'))
      : bbSrc;
    ok(baseSrc !== bbSrc && (inRatio ? !LEVER_RE.test(/function ratioAtRate\([\s\S]*?\n\}/.exec(baseSrc)[0]) : false),
      'N0b …and the baseline genuinely has it replaced by the OLD round-to-nearest');
    const mod = new Module(bbPath, null);
    mod.filename = bbPath;
    mod.paths = Module._nodeModulePaths(path.dirname(bbPath));
    mod._compile(baseSrc, bbPath);
    const BEFORE = mod.exports;
    ok(typeof BEFORE.ratioAtRate === 'function' && typeof BEFORE.sendRatioFor === 'function',
      'N0c …and the baseline engine really loaded');

    /* The owner's own shape: a deal whose true ratio sits just under a band edge. */
    const EDGE = boardMod.readFigures({ rentMonthly: 2490, taxMonthly: 0, insuranceMonthly: 0, hoaMonthly: 0, loanAmount: 300000, termYears: 30, interestOnly: true });
    // interest-only at 8% on 300,000 = 2,000/month exactly, so rent/PITIA = 1.245 on the nose.
    const edgeAfter = boardMod.ratioAtRate(EDGE, 8);
    const edgeBefore = BEFORE.ratioAtRate(EDGE, 8);
    ok(edgeBefore === 1.25 && edgeAfter === 1.24,
      `⛔ N1 THE ONE THAT MATTERS: a 1.245 deal used to be searched at 1.25 and is now searched at 1.24 (${edgeBefore} → ${edgeAfter})`);
    ok(tiers.dscrTier(edgeAfter) < tiers.dscrTier(edgeBefore),
      `N1b …which is the band BELOW the one it was being priced in (${tiers.dscrTier(edgeAfter)} vs ${tiers.dscrTier(edgeBefore)}) — the whole point of the rule`);

    /* THE SWEEP. Real-shaped figures, every eighth from 5.25% to 11.5%. */
    const rents = [1800, 2400, 2490, 3000, 3850, 5000];
    const loansA = [180000, 300000, 420000, 640000];
    const taxesA = [180, 450, 800];
    const insA = [65, 165];
    const hoasA = [0, 340];
    const ratesA = [];
    for (let r = 5.25; r <= 11.5 + 1e-9; r += 0.125) ratesA.push(Math.round(r * 1000) / 1000);
    let combos = 0; let wentUp = 0; let moved = 0; let bandWorse = 0; let bandBetter = 0;
    let nullsBefore = 0; let nullsAfter = 0;
    const deals = [];
    for (const rent of rents) for (const loan of loansA) for (const tax of taxesA) for (const i of insA) for (const hoa of hoasA) {
      const fg = boardMod.readFigures({ rentMonthly: rent, taxMonthly: tax, insuranceMonthly: i, hoaMonthly: hoa, loanAmount: loan, termYears: 30 });
      if (!fg) continue;
      deals.push(fg);
      for (const rate of ratesA) {
        const b = BEFORE.ratioAtRate(fg, rate);
        const a = boardMod.ratioAtRate(fg, rate);
        combos += 1;
        if (b == null) nullsBefore += 1;
        if (a == null) nullsAfter += 1;
        if (b == null || a == null) continue;
        if (a > b) wentUp += 1;
        if (a !== b) moved += 1;
        const tb = tiers.dscrTier(b); const ta = tiers.dscrTier(a);
        if (ta !== tb) { if (ta < tb) bandWorse += 1; else bandBetter += 1; }
      }
    }
    ok(combos > 1000, `N2 CONTROL: the sweep really ran (${combos} deal/rate combinations over ${deals.length} deals)`);
    /* `moved > 0` is part of THIS assertion, not only of N4: without it a baseline that
       failed to build reads as "nothing went up" and the safety property passes having
       compared an engine to itself. */
    ok(moved > 0 && wentUp === 0 && bandBetter === 0,
      `⛔ N3 THE SAFETY PROPERTY: the two engines genuinely differ (${moved} ratios moved) and not one ratio went UP, not one band improved (${wentUp} up, ${bandBetter} better)`);
    ok(moved > 0 && bandWorse > 0,
      `N4 …and it is not a no-op either: ${moved} ratios moved a cent (${((moved / combos) * 100).toFixed(1)}%) and ${bandWorse} landed in the band the loan has actually earned (${((bandWorse / combos) * 100).toFixed(2)}%)`);
    ok(nullsBefore === nullsAfter,
      `N5 …and nothing became unworkable — the same ${nullsAfter} combinations answer null either way`);

    /* ⛔ AND NO BAND GOES UNPRICED. `sendRatioFor` yields null when the ratio it picks
       does not land in the band it is for, and that band is then not searched at all —
       so a change that pushed a ratio across an edge could silently take a whole band
       off the board. This is the assertion that would have caught it. */
    let lost = 0; let gained = 0; let both = 0;
    const rateRows = ratesA.map((r) => ({ rate: r }));
    for (const fg of deals) {
      for (const row of tiers.DSCR_TIERS) {
        const t = row.tier != null ? row.tier : row;
        const b = BEFORE.sendRatioFor(t, fg, rateRows);
        const a = boardMod.sendRatioFor(t, fg, rateRows);
        if (b != null && a == null) lost += 1;
        else if (b == null && a != null) gained += 1;
        else if (b != null) both += 1;
      }
    }
    ok(both > 0, `N6 CONTROL: bands really were priced on both engines (${both})`);
    ok(lost === 0,
      `⛔ N7 …and NOT ONE band stopped being priceable (${lost} lost, ${gained} newly reachable)`);

    /* ═══════════════════════════════════════════════════════════════════════
       N11..N14 · THE RULE ITSELF, POINTWISE — because N3..N7 are DIRECTIONAL.

       ⛔ THE PRE-MERGE AUDIT OF 2026-09-03 DEFEATED EVERY ASSERTION ABOVE WITH
       THREE MUTATIONS THAT RE-ARM ROUND-TO-NEAREST ON PART OF THE INPUT SPACE,
       each leaving all eight suites GREEN with a green control:

         M3  `if (quoted != null && quoted > 0) return Math.round((f.rentMonthly / pitia) * 100) / 100;`
             — THE LIVE PRODUCTION PATH. `vendorMonthlyPi` is set on every real
             Lender Price option (`client.js` reads `monthlyPI ?? total`), and this
             module's own header says the vendor's quoted payment WINS when it
             quoted one. So this undoes the owner's authorised change on
             essentially every real board.
         M2  `if (__r >= 1.25) return Math.round(__r * 100) / 100;`
             — the best-priced bands: rent 2,990 / PITIA 2,000 = 1.495 goes to the
             ≥1.50 top band instead of the one below it. The owner's reported
             defect, at the top of the ladder.
         M4  `if (f.loanAmount > 400000) return Math.round(...)`.

       WHY THEY SURVIVED: N3/N4/N5/N7 assert a DIRECTION (`after ≤ before`, no band
       improved, none lost), which any PARTIAL re-arming of round-to-nearest
       satisfies — a ratio that is rounded to nearest never goes UP relative to a
       baseline that also rounds to nearest, it is the SAME. The only assertion that
       pins the RULE was N1, a single point, at 8%, interest-only, with NO vendor
       payment — so the whole vendor path was unasserted. Confirmed by the audit:
       under the `+0.005` mutation N1/N1b failed while N3..N10 all passed on an
       engine that rounds to nearest everywhere.

       SO THE RULE IS PINNED AS AN EQUALITY, AT EVERY POINT, AGAINST AN ORACLE.
       The oracle takes the payment from `termsheet/overlay.monthlyPI` — a DIFFERENT
       module, which a mutation of `ratioAtRate` cannot reach, and the one definition
       of what a payment is on this product — and does its OWN cutting-down with its
       OWN arithmetic. It deliberately does NOT ask `tier-rounding` the question the
       module under test asks it: a helper that delegated would MOVE WITH the rule
       and every assertion here would pass vacuously the day somebody flipped it.

       The PITIA line restates production's shape on purpose. If production ever
       changes how a PITIA is settled, these fail — correctly: that would move every
       searched ratio on every board and is a decision, not a tidy-up. */
    const { monthlyPI: oraclePI } = require('../src/longterm/termsheet/overlay');
    /** Cut to 2dp, never up — this suite's OWN arithmetic, never `tier-rounding`'s. */
    const cutHere = (n) => {
      if (!Number.isFinite(n)) return null;
      const x = n * 100;
      const whole = Math.round(x);
      /* The same float-slack shape production uses: a value within noise of a whole
         number IS that whole number, so a typed 1.15 (×100 = 114.99999999999999) is
         not cut to 1.14. Restated rather than imported, for the reason above. */
      const eps = Math.max(1e-9, Math.abs(x) * 1e-12);
      return (Math.abs(x - whole) < eps ? whole : Math.floor(x)) / 100;
    };
    const oracleRatio = (fg, rate, vendorPi) => {
      const pi = (vendorPi != null && vendorPi > 0)
        ? vendorPi
        : oraclePI({ loanAmount: fg.loanAmount, ratePct: rate, termYears: fg.termYears, interestOnly: fg.interestOnly });
      if (!Number.isFinite(pi) || pi <= 0) return null;
      const pitia = Math.round((pi + fg.taxMonthly + fg.insuranceMonthly + fg.hoaMonthly) * 100) / 100;
      if (!(pitia > 0)) return null;
      if (!Number.isFinite(fg.rentMonthly)) return null;
      return cutHere(fg.rentMonthly / pitia);
    };

    let pointsPlain = 0; let mismatchPlain = 0; let firstPlain = null;
    let cutSomething = 0;
    for (const fg of deals) {
      for (const rate of ratesA) {
        const got = boardMod.ratioAtRate(fg, rate);
        const want = oracleRatio(fg, rate, null);
        pointsPlain += 1;
        if (got !== want) { mismatchPlain += 1; if (!firstPlain) firstPlain = { rate, got, want, loan: fg.loanAmount, rent: fg.rentMonthly }; }
        /* How many of these the rule ACTUALLY BITES on — without this the equality
           could hold over a battery where nothing was ever cut, and prove nothing. */
        if (want != null && want !== Math.round((fg.rentMonthly / (Math.round((oraclePI({ loanAmount: fg.loanAmount, ratePct: rate, termYears: fg.termYears, interestOnly: fg.interestOnly }) + fg.taxMonthly + fg.insuranceMonthly + fg.hoaMonthly) * 100) / 100)) * 100) / 100) cutSomething += 1;
      }
    }
    ok(cutSomething > 100,
      `N11 CONTROL: the rule genuinely bites over this battery (${cutSomething} of ${pointsPlain} points are cut below where round-to-nearest would put them)`);
    ok(mismatchPlain === 0,
      `⛔ N11a THE RULE, POINTWISE: every one of ${pointsPlain} ratios is EXACTLY the cut-down value${firstPlain ? ` — first mismatch ${JSON.stringify(firstPlain)}` : ''}`);

    /* ⛔ N12 · THE VENDOR'S OWN PAYMENT — the path the audit's M3 mutation lives on,
       and the one no assertion above passes at all. Every real Lender Price option
       carries a quoted monthly payment, so this is not an edge case: it is what
       essentially every board on the live system takes. */
    const vendorPis = [1450.5, 1687.33, 1900, 2000, 2100, 2333.67, 2750.25, 3100.4];
    let pointsVendor = 0; let mismatchVendor = 0; let firstVendor = null; let vendorCut = 0;
    for (const fg of deals) {
      for (const vp of vendorPis) {
        /* The RATE is passed too and is deliberately ignored by production when a
           vendor payment is present — asserted below, because a mutation that
           started using it would change every searched ratio silently. */
        const got = boardMod.ratioAtRate(fg, 7.5, vp);
        const want = oracleRatio(fg, 7.5, vp);
        pointsVendor += 1;
        if (got !== want) { mismatchVendor += 1; if (!firstVendor) firstVendor = { vp, got, want, rent: fg.rentMonthly }; }
        const nearest = want == null ? null : Math.round((fg.rentMonthly / (Math.round((vp + fg.taxMonthly + fg.insuranceMonthly + fg.hoaMonthly) * 100) / 100)) * 100) / 100;
        if (want != null && want !== nearest) vendorCut += 1;
      }
    }
    ok(vendorCut > 50,
      `N12 CONTROL: the vendor-payment battery genuinely exercises the rule (${vendorCut} of ${pointsVendor} points are cut)`);
    ok(mismatchVendor === 0,
      `⛔ N12a THE VENDOR'S OWN PAYMENT IS CUT DOWN TOO — ${pointsVendor} points, every one exact${firstVendor ? ` — first mismatch ${JSON.stringify(firstVendor)}` : ''}`);
    ok(boardMod.ratioAtRate(deals[0], 5.25, 2000) === boardMod.ratioAtRate(deals[0], 11.5, 2000),
      'N12b …and the rate is ignored when the vendor quoted a payment — the vendor\'s figure wins, whatever coupon it came from');

    /* ═══ N16 · THE INPUT SPACE, NOT A BATTERY — and an oracle that borrows nothing ═══
       ⛔ WHY THIS EXISTS, AND WHAT IT REPLACES. The re-audit of 2026-09-03 defeated
       N11a and N12a WITHOUT touching the rounding rule's shape at all — it simply
       re-armed round-to-nearest on a REGION the lists above do not reach:

         · `if (quoted != null && quoted > 3200) return Math.round(r * 100) / 100;`
           `vendorPis` stops at $3,100.40. A $500,000 loan at 7.5% over 30 years pays
           $3,496, so this is not an edge — it is essentially every jumbo board.
           MEASURED under it: rent 5,980 / P&I 4,000 = 1.495 bought the ≥1.50 TOP band.
         · `if (f.hoaMonthly > 0 && f.hoaMonthly !== 340) return Math.round(...)`.
           `hoasA` is [0, 340], so every condo and PUD on the system rounded to nearest.

       Both passed all 204 LT suites. A fixed list proves the rule at the points
       somebody thought of; it says nothing about the ones they did not.

       ⛔ AND THE ORACLE NO LONGER DELEGATES. N11/N12's oracle took its payment from
       `overlay.monthlyPI` — the same function production takes it from — so a mutation
       THERE moved both sides together and went unseen: `if (loanAmount > 500000)
       return r2(... * 0.97)` was green across all 204, while the bracket ratio on a
       $750,000 loan moved 0.86 → 0.88, a BETTER band. `piHere` below is the textbook
       annuity written out here, computed a different way from production's algebraic
       rearrangement, so nothing production can be mutated into moves it. */
    {
      /** The payment, from first principles. Deliberately `P·r(1+r)ⁿ / ((1+r)ⁿ−1)`
          where production writes `P·r / (1−(1+r)⁻ⁿ)` — the same identity by a
          different route, so the two agreeing is evidence rather than tautology. */
      const piHere = ({ loanAmount, ratePct, termYears, interestOnly }) => {
        if (!Number.isFinite(loanAmount) || loanAmount <= 0) return null;
        if (!Number.isFinite(ratePct) || ratePct < 0) return null;
        const r = ratePct / 100 / 12;
        const r2h = (x) => Math.round(x * 100) / 100;
        if (interestOnly) return r2h(loanAmount * r);
        if (!Number.isFinite(termYears) || termYears <= 0) return null;
        const n = Math.round(termYears * 12);
        if (n <= 0) return null;
        if (r === 0) return r2h(loanAmount / n);
        const g = Math.pow(1 + r, n);
        return r2h((loanAmount * r * g) / (g - 1));
      };

      /* THE PAYMENT ITSELF, ACROSS THE WHOLE RANGE WE LEND IN — including jumbo,
         which nothing anywhere pinned. Compared with a ONE CENT tolerance because
         the two formulations differ in the last bits of a float, and a 3% error
         (the mutation that got through) is thousands of times that. */
      let piPoints = 0; let piBad = 0; let firstPi = null; let worst = 0;
      for (const loan of [50000, 175000, 499999, 500001, 750000, 1200000, 2500000, 5000000]) {
        for (const rate of [0, 3.125, 5.25, 6.875, 7.5, 9.99, 12.5, 15]) {
          for (const term of [15, 20, 30, 40]) {
            for (const io of [false, true]) {
              const mine = piHere({ loanAmount: loan, ratePct: rate, termYears: term, interestOnly: io });
              const prod = oraclePI({ loanAmount: loan, ratePct: rate, termYears: term, interestOnly: io });
              piPoints += 1;
              const d = (mine == null || prod == null) ? (mine === prod ? 0 : Infinity) : Math.abs(mine - prod);
              if (d > worst && Number.isFinite(d)) worst = d;
              if (!(d <= 0.011)) { piBad += 1; if (!firstPi) firstPi = { loan, rate, term, io, mine, prod }; }
            }
          }
        }
      }
      ok(piBad === 0,
        `⛔ N16 THE MONTHLY PAYMENT IS ITSELF PINNED, over ${piPoints} points to $5,000,000 — worst disagreement ${worst.toFixed(4)}${firstPi ? ` — first ${JSON.stringify(firstPi)}` : ''}`);

      /** The ratio oracle again, this time on `piHere` — it borrows NOTHING from
          production but the figures the deal is made of. */
      const oracleFree = (fg, rate, vendorPi) => {
        const pi = (vendorPi != null && vendorPi > 0)
          ? vendorPi
          : piHere({ loanAmount: fg.loanAmount, ratePct: rate, termYears: fg.termYears, interestOnly: fg.interestOnly });
        if (!Number.isFinite(pi) || pi <= 0) return null;
        const pitia = Math.round((pi + fg.taxMonthly + fg.insuranceMonthly + fg.hoaMonthly) * 100) / 100;
        if (!(pitia > 0) || !Number.isFinite(fg.rentMonthly)) return null;
        return cutHere(fg.rentMonthly / pitia);
      };

      /* A SEEDED WALK OF THE SPACE. Deterministic (the same numbers on every run and
         on every machine, so a failure is reproducible), and wide enough that no
         region of it is reachable by a rule keyed on a threshold: every figure is
         drawn from a continuous range rather than a short list, so a mutation gated
         on "vendor payment over X" or "HOA is not exactly Y" has nowhere to hide. */
      let seed = 20260903;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      const pick = (lo, hi) => lo + rnd() * (hi - lo);
      let pts = 0; let bad = 0; let first = null; let bit = 0; let vendorPts = 0; let jumboPts = 0; let hoaPts = 0;
      for (let i = 0; i < 40000; i += 1) {
        const fg = boardMod.readFigures({
          rentMonthly: Math.round(pick(400, 30000) * 100) / 100,
          taxMonthly: Math.round(pick(0, 3000) * 100) / 100,
          insuranceMonthly: Math.round(pick(0, 900) * 100) / 100,
          hoaMonthly: rnd() < 0.45 ? 0 : Math.round(pick(1, 2400) * 100) / 100,
          loanAmount: Math.round(pick(60000, 3500000)),
          termYears: [15, 20, 30, 40][Math.floor(rnd() * 4)],
          interestOnly: rnd() < 0.35,
        });
        const rate = Math.round(pick(3, 15) * 1000) / 1000;
        /* Half the points go down the VENDOR-PAYMENT path — the live production path
           — and its range runs to $25,000 a month, far past any list. */
        const vp = rnd() < 0.5 ? Math.round(pick(150, 25000) * 100) / 100 : null;
        const got = boardMod.ratioAtRate(fg, rate, vp);
        const want = oracleFree(fg, rate, vp);
        pts += 1;
        if (vp != null) vendorPts += 1;
        if (fg.loanAmount > 500000) jumboPts += 1;
        if (fg.hoaMonthly > 0) hoaPts += 1;
        if (got !== want) { bad += 1; if (!first) first = { rate, vp, got, want, fg }; }
        /* The control, point by point: how often the rule actually BITES here. An
           equality over a space where nothing is ever cut would prove nothing. */
        if (want != null) {
          const pi = (vp != null && vp > 0) ? vp : piHere({ loanAmount: fg.loanAmount, ratePct: rate, termYears: fg.termYears, interestOnly: fg.interestOnly });
          if (Number.isFinite(pi) && pi > 0) {
            const pitia = Math.round((pi + fg.taxMonthly + fg.insuranceMonthly + fg.hoaMonthly) * 100) / 100;
            if (pitia > 0 && want !== Math.round((fg.rentMonthly / pitia) * 100) / 100) bit += 1;
          }
        }
      }
      ok(bit > 5000,
        `N16a CONTROL: the rule bites across the space (${bit} of ${pts} points cut below round-to-nearest)`);
      ok(vendorPts > 15000 && jumboPts > 5000 && hoaPts > 15000,
        `N16b CONTROL: the walk really covers the regions the fixed lists miss (${vendorPts} vendor-payment, ${jumboPts} over $500k, ${hoaPts} with an HOA)`);
      ok(bad === 0,
        `⛔ N16c THE RULE HOLDS OVER THE SPACE: ${pts} points, every one exactly the cut-down value${first ? ` — first mismatch ${JSON.stringify(first)}` : ''}`);
    }

    /* ⛔ N13 · THE TOP OF THE LADDER — the audit's M2 shape, stated as a value.
       rent 2,990 against a PITIA of exactly 2,000 is 1.495: cut down it is 1.49 and
       sits BELOW the ≥1.50 top band; rounded to nearest it is 1.50 and buys the best
       band on the sheet. This is the owner's own reported defect at its most
       expensive point, so it is pinned as a number rather than as a direction. */
    const TOP = boardMod.readFigures({ rentMonthly: 2990, taxMonthly: 0, insuranceMonthly: 0, hoaMonthly: 0, loanAmount: 300000, termYears: 30, interestOnly: true });
    const topRatio = boardMod.ratioAtRate(TOP, 8);
    ok(topRatio === 1.49,
      `⛔ N13 a 1.495 deal is searched at 1.49, never 1.50 (${topRatio})`);
    ok(tiers.dscrTier(topRatio) < tiers.dscrTier(1.5),
      `N13b …which is the band below the top one (${tiers.dscrTier(topRatio)} vs ${tiers.dscrTier(1.5)})`);
    ok(boardMod.ratioAtRate(TOP, 99, 2000) === 1.49,
      'N13c …and the same deal reached through the VENDOR\'s quoted payment is cut identically');

    /* ⛔ N14 · A LARGE LOAN — the audit's M4 shape. The rule is about the RATIO, so
       nothing about the size of the loan may change it. */
    const BIG = boardMod.readFigures({ rentMonthly: 9960, taxMonthly: 0, insuranceMonthly: 0, hoaMonthly: 0, loanAmount: 1200000, termYears: 30, interestOnly: true });
    const bigRatio = boardMod.ratioAtRate(BIG, 8);
    ok(bigRatio === 1.24,
      `⛔ N14 a $1.2M loan at the same 1.245 ratio is cut down exactly as a small one is (${bigRatio})`);

    /* ⛔ N15 · WHAT IS ACTUALLY ONE-WAY ABOUT THE SEARCHED RATIO.
       The header claimed the searched ratio "moves in 5,176 — always downward."
       The pre-merge audit of 2026-09-03 measured that false, and it is: over the
       header's own 69,696-pair battery about 1,214 of ~5,165 moves go UP.

       THE MECHANISM is why that is the SAFE direction and not a defect.
       `sendRatioFor` asks for the LOWEST ratio any rate in the band achieves;
       cutting each rate's ratio down can push the rate that WAS that minimum out
       of the band, leaving a HIGHER minimum. So the vendor is asked for a
       STRONGER DSCR than before, which can only ever fetch a worse price.

       So the DIRECTION is not asserted — asserting it would pin a claim that is
       false. What is asserted is what the safety actually rests on, and the split
       is REPORTED in the message so a future reader gets the measured fact rather
       than a tidy story. */
    let sPairs = 0; let sLost = 0; let sGained = 0; let sUp = 0; let sDown = 0; let sOutside = 0;
    let firstOutside = null;
    for (const fg of deals) {
      for (const row of tiers.DSCR_TIERS) {
        const t = row.tier != null ? row.tier : row;
        const b = BEFORE.sendRatioFor(t, fg, rateRows);
        const a = boardMod.sendRatioFor(t, fg, rateRows);
        sPairs += 1;
        if (b != null && a == null) sLost += 1;
        else if (b == null && a != null) sGained += 1;
        if (b == null || a == null) continue;
        if (a > b) sUp += 1; else if (a < b) sDown += 1;
        /* ⛔ THE CONTRACT `sendRatioFor` STATES: an unplaceable ratio yields null
           rather than searching the wrong band. A ratio that came back at all must
           therefore sit in the band it was asked for. */
        if (tiers.dscrTier(a) !== t) { sOutside += 1; if (!firstOutside) firstOutside = { tier: t, ratio: a }; }
      }
    }
    /* The suite's own battery is the smaller one (288 deals × the 11-band ladder);
       the header's 69,696-pair figure comes from its own wider battery, measured
       separately. Both show the same split, which is the point. */
    ok(sPairs > 1000 && (sUp + sDown) > 0,
      `N15 CONTROL: the ladder sweep really ran (${sPairs} pairs, ${sUp + sDown} moved)`);
    ok(sOutside === 0,
      `⛔ N15a EVERY SEARCHED RATIO LANDS IN THE BAND IT IS FOR (${sOutside} outside${firstOutside ? ` — ${JSON.stringify(firstOutside)}` : ''}) — a ratio in a neighbouring band would search the wrong scenario`);
    ok(sLost === 0,
      `⛔ N15b …and NOT ONE band stopped being priceable (${sLost} lost, ${sGained} newly reachable)`);
    ok(sUp > 0 && sDown > 0,
      `N15c THE MEASURED SPLIT, recorded rather than claimed one-way: ${sDown} moves down and ${sUp} UP — the header said "always downward" and that was false`);

    /* ONE DOOR, both places this file settles a ratio. A bare round in `sendRatioFor`
       would let the two answer differently the day either side gains a third decimal. */
    /* Through the SHARED stripper. The two-regex idiom this file used elsewhere is a
       SKELETON KEY: it strips block comments first, so it cannot tell a `/*` inside a line
       comment or a string from a real one, and a "must not appear" rule PASSES over a file
       it swallowed (main, 2026-09-03). */
    const { stripComments } = require('./lib/strip-comments');
    const strippedBb = stripComments(bbSrc);
    ok(/tierRounding\.sendAs\('dscr'/.test(strippedBb) && !/Math\.round\(best \* 100\)/.test(strippedBb),
      'N8 both places go through the one rounding door — no bare round-to-nearest is left in the board');
    ok(!/computeDscr/.test(strippedBb),
      'N9 …and the board no longer calls the tenant\'s own round-to-nearest formula');

    /* ⛔ AND `computeDscr` ITSELF IS UNTOUCHED — it is Encompass's own CUST01FV formula,
       owner-confirmed 2026-08-14 and FROZEN. What moved is its CALLER, which is the same
       shape the term-sheet fix took. Asserted here so a future "tidy-up" cannot decide the
       frozen formula should be cut down to match. */
    const formulas = require('../src/longterm/encompass/formulas');
    ok(formulas.computeDscr(2490, 2000) === 1.25,
      '⛔ N10 the tenant\'s frozen formula still ROUNDS TO NEAREST — only its caller moved');

    console.log(bad ? `\n${bad} FAILED` : '\nALL PASSED');
  process.exit(bad ? 1 : 0);
}

main();
