#!/usr/bin/env node
'use strict';
/**
 * LONG-TERM — EACH INVESTOR'S OWN MARGIN HOLDBACK (pure, offline).
 *
 * Owner-directed 2026-08-30: *"We can add extra company margin holdbacks on top
 * of each and every program… If it's a set on LoanNEX, we should be able to
 * increase or decrease the margin holdbacks accordingly… The pricing that it
 * should add on top of LoanNEX pricing as a company margin holdback should be
 * hidden for consumers, it should be baked into the rate any time when customers
 * and consumers are looking at it."*
 *
 * THREE THINGS THIS GUARDS, and each is a different way to be wrong:
 *  1. the arithmetic — one signed number per investor, floored at zero, never a
 *     giveaway;
 *  2. the AIM — an investor's extra lands on THAT investor's rows and nobody
 *     else's, which is the whole reason it is per-investor;
 *  3. what a consumer sees — the deduction in the price and nowhere else.
 *
 * PROVEN TO FAIL: let the total go negative and FLOOR-* go red; apply the board
 * figure to every program and AIM-* go red; leave the program stamps on the
 * ordinary board and HIDE-* go red; make a blank box store a zero and
 * BLANK-1 goes red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const fs = require('fs');
const path = require('path');
const vm = require('../src/longterm/pricing/vendor-margin');
const settings = require('../src/longterm/pricing/investor-settings');
const routing = require('../src/longterm/pricing/investor-routing');
const mergeMod = require('../src/longterm/pricing/merge');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const src = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

console.log('Each investor\'s own margin holdback');

// ---- A. ONE SIGNED NUMBER ANSWERS BOTH HALVES -------------------------------
console.log('\n== A. ADD ON TOP, OR TAKE IT BACK DOWN ==');
const R = (saved, extra) => vm.resolveHoldback('loannex', saved, extra);
ok(R(null, 0.25).points === 0.5 && R(null, 0.25).extraApplied === true,
  `ADD-1 an extra of 0.25 on top of the standing 0.25 holds back 0.5 (got ${R(null, 0.25).points})`);
ok(R(null, -0.15).points === 0.1,
  `DOWN-1 …and an extra of −0.15 takes the same investor down to 0.1 (got ${R(null, -0.15).points}) — one number does both, so there is nothing to reconcile`);
ok(R(null, -0.25).points === 0 && R(null, -0.25).origin === 'setting',
  'DOWN-2 …and −0.25 removes it on that investor alone, recorded as a DECISION rather than as an absence');
ok(R(0.5, 0.25).points === 0.75 && R(0.5, 0.25).base === 0.5,
  'ADD-2 …and it stacks on whatever the standing figure has been moved to, not on a constant');
ok(R(null, null).points === 0.25 && R(null, null).extraApplied === false,
  'ADD-3 …while an investor nobody has answered for is priced on the standing holdback exactly as before');

// ⛔ THE FLOOR. A negative effective holdback is not a smaller holdback, it is a
// giveaway — it would ADD to the vendor's price and quote better execution than
// the investor offered.
console.log('\n== B. IT CAN NEVER BECOME A GIVEAWAY ==');
{
  const r = R(null, -0.4);
  ok(r.points === 0 && r.floored === true,
    `FLOOR-1 an extra of −0.4 against a 0.25 holdback comes to zero, never −0.15 (got ${r.points})`);
  ok(r.problem && r.problem.error === 'extra_below_zero' && /ADD to the price/.test(r.problem.message),
    'FLOOR-2 …and the floor is REPORTED, because somebody asked for something arithmetic cannot do and being told beats a board that quietly did something else');
  let below = 0;
  for (let base = 0; base <= 2; base = Math.round((base + 0.05) * 100) / 100) {
    for (let ex = -3; ex <= 3; ex = Math.round((ex + 0.05) * 100) / 100) {
      if (vm.resolveHoldback('loannex', base, ex).points < 0) below++;
    }
  }
  ok(below === 0, `FLOOR-3 …and across every base/extra pair not one produces a negative holdback (${below})`);
}
ok(R(null, 'abc').points === 0.25 && R(null, 'abc').problem.error === 'extra_not_a_number',
  'REFUSE-1 an extra that is not a number is refused and the standing holdback stands — never a guess applied to a price');
ok(R(null, 25).points === 0.25 && R(null, 25).problem.error === 'extra_too_large',
  'REFUSE-2 …and 25 points reads as a slipped decimal, which is what it is');

// ---- C. IT LANDS ON THAT INVESTOR AND NOBODY ELSE ---------------------------
console.log('\n== C. WHOSE ROWS IT MOVES ==');
{
  const cfg = settings.readSettings({ nqm: { holdback: 0.25 }, acra: { holdback: -0.25 } });
  const extraFor = (prog) => {
    const hit = mergeMod.resolveInvestor(prog, null);
    if (!hit || !hit.key) return null;
    const row = settings.settingFor(hit.key, cfg.settings);
    return row && row.holdbackOrigin === 'setting' ? row.holdback : null;
  };
  const board = () => ({
    source: 'loannex',
    programs: [
      { investor: 'NQM Funding', rungs: [{ rate: 7, price: 101.5, points: -1.5 }] },
      { investor: 'Acra Lending', rungs: [{ rate: 7, price: 101.5, points: -1.5 }] },
      { investor: 'Deephaven Mortgage', rungs: [{ rate: 7, price: 101.5, points: -1.5 }] },
    ],
  });
  const out = vm.applyToBoard(board(), 'loannex', { extraFor });
  const at = (n) => out.programs.find((p) => p.investor === n);
  ok(at('NQM Funding').rungs[0].price === 101 && at('NQM Funding').marginHoldback === 0.5,
    `AIM-1 the investor with +0.25 is priced at 101 (got ${at('NQM Funding').rungs[0].price})`);
  ok(at('Acra Lending').rungs[0].price === 101.5 && at('Acra Lending').marginHoldback === 0,
    `AIM-2 …the one with −0.25 keeps the vendor's own price (got ${at('Acra Lending').rungs[0].price})`);
  ok(at('Deephaven Mortgage').rungs[0].price === 101.25 && at('Deephaven Mortgage').marginHoldback === 0.25,
    `AIM-3 …and every other investor is untouched at the standing 0.25 (got ${at('Deephaven Mortgage').rungs[0].price}) — an extra that leaked onto the rest of the board would be the whole feature going wrong`);
  ok(at('NQM Funding').rungs[0].points === -1 && at('Acra Lending').rungs[0].points === -1.5,
    'AIM-4 …and each row\'s points move with its own price, so no row contradicts itself');
  // The AIM is resolved by the ONE resolver, never a second lookup — asserted at
  // BOTH ends now that the closure lives in `investor-routing` rather than being
  // written out in the route: the route uses the shared resolver, and the shared
  // resolver asks the merge. Either half alone would pass while the chain was
  // broken in the other.
  ok(/routing\.extraResolver\(/.test(src('src/longterm/routes/combined-pricer.js')),
    'AIM-5 …and the route resolves a row\'s investor through the SHARED resolver rather than a second lookup of its own');
  ok(/function extraResolver\(/.test(src('src/longterm/pricing/investor-routing.js'))
    && /merge\.resolveInvestor\(/.test(src('src/longterm/pricing/investor-routing.js')),
  'AIM-5b …and that resolver is merge\'s own, so the extra can never land on an investor the merge put elsewhere');

  /* AN INVESTOR SOMEBODY ADDED BY HAND CARRIES ITS OWN EXTRA TOO (2026-09-02).
     The whole chain has to know about it or the extra silently does nothing: the
     row is resolved by the same resolver, the setting is read against the same
     effective roster, and the price moves. A chain that knew about the investor
     in one of those three places and not the others would take the standing
     figure off a row somebody had deliberately set an extra on. */
  /* ⛔ THE ROUTE'S OWN RESOLVER, NOT A COPY OF IT. This used to re-type the
     closure `priceBoth` builds — resolve the row, read the setting, return the
     extra — which meant the test went on passing whatever the route did. It now
     calls `routing.extraResolver`, the one definition the board itself uses, so
     a route that stopped threading the hand-added investors reddens this. */
  const roster = require('../src/longterm/pricing/investor-roster');
  const routeSrc = src('src/longterm/routes/combined-pricer.js');
  ok(/const extraFor = routing\.extraResolver\(/.test(routeSrc),
    'AIM-10a the board builds its per-investor extra with the SHARED resolver, so this test drives the same code the board runs');

  const custom = roster.readCustom({
    sweptside: { label: 'Sweptside Capital Partners', whiteLabel: 'Northgate', aliases: ['Sweptside Cap'] },
  }).custom;
  const board2 = () => ({ source: 'loannex', programs: [{ investor: 'Sweptside Cap', rungs: [{ rate: 7, price: 101.5, points: -1.5 }] }] });

  const withCustom = vm.applyToBoard(board2(), 'loannex', {
    extraFor: routing.extraResolver(settings.readSettings({ sweptside: { holdback: 0.25 } }, custom).settings, null, custom),
  });
  ok(withCustom.programs[0].rungs[0].price === 101 && withCustom.programs[0].marginHoldback === 0.5,
    `AIM-10 a hand-added investor's own extra reaches its rows (got ${withCustom.programs[0].rungs[0].price})`);

  // CONTROL: the same board and the same resolver, with no hand-added investors
  // in force. The row is nobody, so nobody's extra applies and the standing
  // figure stands — which is what this did before any of it existed.
  const without = vm.applyToBoard(board2(), 'loannex', {
    extraFor: routing.extraResolver(settings.readSettings({ sweptside: { holdback: 0.25 } }).settings, null),
  });
  ok(without.programs[0].rungs[0].price === 101.25 && without.programs[0].marginHoldback === 0.25,
    'AIM-11 CONTROL: with none in force that same row is nobody, so it takes the standing figure alone');
}
{
  // With nobody carrying an extra, the board is what it always was.
  const plain = vm.applyToBoard({ source: 'loannex', programs: [{ investor: 'X', rungs: [{ rate: 7, price: 101.5, points: -1.5 }] }] }, 'loannex', {});
  ok(plain.programs[0].rungs[0].price === 101.25,
    'AIM-6 …and a board with no extra set anywhere prices exactly as it did before any of this');
  const lpb = { source: 'lenderprice', programs: [{ investor: 'X', rungs: [{ rate: 7, price: 100.5, points: -0.5 }] }] };
  ok(vm.applyToBoard(lpb, 'lenderprice', {}) === lpb,
    'AIM-7 …and Lender Price with no extra comes back as the SAME OBJECT — provably untouched');
  ok(vm.applyToBoard(lpb, 'lenderprice', { saved: 0.5 }) === lpb,
    'AIM-8 …and the GLOBAL figure still cannot reach it, because its feed already carries ours and a second one would take it twice');
  const lpExtra = vm.applyToBoard(lpb, 'lenderprice', { extraFor: () => 0.1 });
  ok(lpExtra.programs[0].rungs[0].price === 100.4,
    `AIM-9 …while a per-investor extra DOES reach it — the owner asked for one on "each and every program" (got ${lpExtra.programs[0].rungs[0].price})`);
}

// ---- D. WHAT A CONSUMER SEES -----------------------------------------------
console.log('\n== D. HIDDEN FROM CONSUMERS, BAKED INTO THE RATE ==');
{
  const priced = {
    investor: 'NQM Funding', source: 'loannex', lenderId: 'X-1',
    marginHoldback: 0.5, marginHoldbackBase: 0.25, marginHoldbackExtra: 0.25,
    marginHoldbackOrigin: 'setting', marginHoldbackProblem: null,
    rungs: [{ rate: 7, price: 101, points: -1, vendorPrice: 101.5, marginHoldback: 0.5 }],
  };
  const shown = routing._internals.stripSource(priced);
  const leaked = Object.keys(shown).filter((k) => /marginHoldback/i.test(k));
  ok(leaked.length === 0,
    `HIDE-1 the program carries no trace of the holdback on the ordinary board (${leaked.join(', ') || 'none'}) — since it became per-investor the PROGRAM carries it too, and a program-level field is not touched by the rung mapping`);
  const rungLeak = Object.keys(shown.rungs[0]).filter((k) => /marginHoldback|vendorPrice/i.test(k));
  ok(rungLeak.length === 0, `HIDE-2 …nor does the rung (${rungLeak.join(', ') || 'none'})`);
  ok(shown.rungs[0].price === 101 && shown.rungs[0].points === -1,
    'HIDE-3 …and the PRICE is untouched — the deduction is already in it, which is exactly what "baked into the rate" means');
  ok(JSON.stringify(shown).indexOf('101.5') === -1,
    'HIDE-4 …and the vendor\'s own pre-holdback price is nowhere in what a consumer is handed');
}
{
  // …and it is still all there for an admin who ASKS.
  const board = vm.applyToBoard(
    { source: 'loannex', programs: [{ investor: 'NQM Funding', rungs: [{ rate: 7, price: 101.5, points: -1.5 }] }] },
    'loannex', { extraFor: () => 0.25 },
  );
  const revealed = routing.applyRouting({ investors: [{ key: 'nqm', investor: 'NQM Funding', presentIn: ['loannex'], programs: { loannex: board.programs } }] }, { revealSource: true });
  const p = revealed.investors[0].programs[0];
  ok(p && p.marginHoldback === 0.5 && p.marginHoldbackExtra === 0.25,
    'HIDE-5 …while an admin who asks for the source gets the whole trail back — nothing is thrown away, the flag decides what is SHOWN');
}


// ---- D2. AND NOT RECOVERABLE BY SUBTRACTION ---------------------------------
console.log('\n== D2. THE HOLDBACK IS NOT RECOVERABLE BY SUBTRACTION ==');
{
  /* AUDIT F5. Stripping the trail is only half of hiding a number. The vendor ALSO publishes a
     price floor and a price ceiling on its explain payload, `breakdown.priceOf` prints both beside
     the HELD-BACK price, and `shiftBase` used to move only the base — so the panel carried
     `{price: 104.25, floor: 98, ceiling: 104.5}` and CEILING MINUS PRICE was the holdback, read
     straight off, with no field named `marginHoldback` anywhere in sight.

     WHAT IS AND IS NOT MEASURED HERE, stated because the task this came from claimed more than
     this repository can show. Every explain payload in `loannex/capture/` was walked: SEVEN carry a
     ceiling, and the ceiling BINDS (price === ceiling) on NONE of them — so on the recorded
     traffic the subtraction yields the vendor's headroom rather than our margin. The task's "binds
     on 28 of 34 rates" could not be reproduced from anything committed here and is not repeated.
     The defect is real regardless and is fixed on its own terms: a price and its own bounds must be
     on ONE scale, and where the ceiling does bind — which is the vendor's choice, not ours — the
     gap IS the holdback. A guard that waits for the vendor to bind its ceiling before it protects
     the margin is a guard that fails on the day it matters. */
  // ⛔ THE MODULE'S OWN ROUNDING, not a second copy. A guard that rounds differently from the code
  // it judges will one day disagree with it about a tenth of a point and be believed.
  const round3 = vm._internals.r3;
  const PTS = 0.25;
  const vendorBuild = () => ({
    price: 104.5, basePoints: -4.5, basePrice: 104.5,
    priceFloor: 98, priceCeiling: 104.5, adjustmentPoints: 0,
  });

  const shifted = vm._internals.shiftBase(vendorBuild(), PTS);
  const boardPrice = round3(100 - shifted.basePoints);
  ok(boardPrice === 104.25 && shifted.priceCeiling === 104.25 && shifted.priceFloor === 97.75,
    `SUB-1 the bounds move WITH the price (price ${boardPrice}, floor ${shifted.priceFloor}, ceiling ${shifted.priceCeiling}) — before this, the ceiling rode out at the vendor's own 104.5`);
  ok(round3(shifted.priceCeiling - boardPrice) === 0,
    'SUB-2 THE ONE THAT MATTERS: ceiling minus price is now ZERO where it used to be exactly the holdback');
  ok(round3(vendorBuild().priceCeiling - boardPrice) === PTS,
    `SUB-2b …and the control says the subtraction really did work: the vendor's OWN ceiling minus the board price is still ${PTS}, which is what a reader had`);
  ok(round3(shifted.vendorPriceCeiling - shifted.priceCeiling) === PTS
    && round3(shifted.vendorPriceFloor - shifted.priceFloor) === PTS,
    'SUB-3 both bounds moved by the SAME amount as the price, and by the holdback exactly — a bound on a different scale from the price it bounds is not a bound');
  ok(shifted.vendorPriceFloor === 98 && shifted.vendorPriceCeiling === 104.5,
    'SUB-4 the vendor\'s own figures ride along under `vendor*` names for the reveal, exactly as `vendorBasePoints` does — nothing is thrown away');

  // ⛔ CALLED TWICE, the way a re-priced option can be. `vendorPriceFloor` is the base for the
  // shift once it exists, so the holdback is taken ONCE however many times this runs.
  const twice = vm._internals.shiftBase(shifted, PTS);
  ok(twice.priceCeiling === 104.25 && twice.priceFloor === 97.75 && twice.vendorPriceCeiling === 104.5,
    'SUB-5 shifting an already-shifted build takes the holdback ONCE — the raw figure is the base, never the shifted one');

  // A LENDER PRICE build has no bounds at all. Nothing may be invented for it.
  const noBounds = vm._internals.shiftBase({ basePoints: -1, basePrice: 101 }, PTS);
  ok(!('priceFloor' in noBounds) && !('priceCeiling' in noBounds)
    && !('vendorPriceFloor' in noBounds) && !('vendorPriceCeiling' in noBounds),
    'SUB-6 a build the vendor gave no bounds for gets none invented — a floor we made up is indistinguishable from one a sheet published');

  // AND THE ORDINARY BOARD CARRIES NEITHER RAW FIGURE.
  const row = {
    investor: 'NQM Funding', source: 'loannex', lenderId: 'X-1', marginHoldback: PTS,
    options: [{ marginHoldback: PTS, priceBuild: { ...shifted, price: boardPrice } }],
  };
  const shown = routing._internals.stripSource(row);
  const pb = shown.options[0].priceBuild;
  const raw = Object.keys(pb).filter((k) => /^vendor/i.test(k));
  ok(raw.length === 0, `SUB-7 the ordinary board carries no \`vendor*\` figure at all (${raw.join(', ') || 'none'}) — keeping the raw ceiling under a new name would move the subtraction one field along, not close it`);

  /* THE SWEEP, which is the guard that will still be right about a field nobody has written yet.
     Rather than naming floor and ceiling, it walks EVERY number the ordinary board hands over and
     asserts that none of them sits exactly one holdback away from the price. A future field with
     this same defect reddens this line on the day it is added. */
  const nums = [];
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'number') nums.push([k, v]);
      else if (v && typeof v === 'object') walk(v);
    }
  }(shown));
  const tells = nums.filter(([k, v]) => k !== 'price' && round3(Math.abs(v - boardPrice)) === PTS);
  ok(tells.length === 0,
    `SUB-8 THE SWEEP: no number anywhere on the ordinary board sits exactly one holdback from the price (${tells.map(([k, v]) => `${k}=${v}`).join(', ') || 'none of ' + nums.length + ' numbers'})`);
}

// ---- E. THE SETTING ITSELF --------------------------------------------------
console.log('\n== E. THE SETTING ==');
{
  const cfg = settings.readSettings({ nqm: { holdback: 0 }, acra: { holdback: 'x' }, eresi: { holdback: 25 } });
  ok(settings.settingFor('nqm', cfg.settings).holdbackOrigin === 'setting'
    && settings.settingFor('nqm', cfg.settings).holdback === 0,
    'BLANK-1 a typed 0 is a DECISION — "hold nothing back on this investor" — and is stored as one');
  ok(settings.settingFor('deephaven', cfg.settings).holdbackOrigin === 'default',
    'BLANK-2 …while an investor nobody answered for says so, which is what lets a screen show which rows were decided');
  const codes = cfg.problems.filter((x) => /holdback/.test(x.error)).map((x) => x.error);
  ok(codes.includes('holdback_not_a_number') && codes.includes('holdback_too_large'),
    `REPORT-1 a refused value is reported BY NAME rather than dropped or applied (${codes.join(', ')})`);
  ok(!('holdback' in (cfg.settings.acra || {})) && !('holdback' in (cfg.settings.eresi || {})),
    'REPORT-2 …and a refused value is not stored, so no board is ever priced on one');
  ok(settings.MAX_INVESTOR_HOLDBACK === vm.MAX_HOLDBACK_POINTS,
    'REPORT-3 …and the settings ceiling is the SAME number the pricing side enforces — two ceilings for one kind of figure is how a screen accepts what the board then refuses');
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
