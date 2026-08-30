#!/usr/bin/env node
'use strict';
/**
 * TWO PROGRAMS, ONE LOAN — the parity suite (pure, offline).
 *
 * WHAT IT IS FOR. A merged pricing board is only worth anything if both programs
 * were asked about the SAME loan. Every defect this file guards against was
 * silent: nothing threw, both vendors answered, and the difference between two
 * different loans was presented as a pricing advantage.
 *
 * The measured defects, all real before 2026-08-30:
 *   • `selfEmployed` reached Lender Price and was DROPPED by LoanNEX.
 *   • `firstTimeInvestor` likewise.
 *   • LoanNEX had NO first-time-home-buyer and NO rural field at all.
 *   • An omitted prepay was five years on one program and NOTHING on the other.
 *   • An omitted DSCR was 1.5 on one and null on the other.
 *   • "MultiFamily" meant FIVE-plus units on one and TWO-to-four on the other.
 *
 * PROVEN TO FAIL. Each of these was applied to the production code and the named
 * assertion went red, with the rest of the battery green either side:
 *   1. revert `readFlags` in loannex/scenario.js to `s.isSelfEmployed` → BTN-4
 *   2. drop the `isFirstTimeHomebuyer` line from the built body      → BTN-1
 *   3. drop the `isRuralProperty` line                                → BTN-5
 *   4. put the prepay default back to `s.prepayMonths == null ? null` → DEF-1
 *   5. map `multifamily` back to TwoToFourUnits                       → PROP-3
 *   6. let `attachEvidence` skip `evidenceCoversRate`                 → SHAPE-5
 *   7. make `applyRouting` fall back to the other source              → ROUTE-4
 *   8. report a failed portal login as a success                          → LOGIN-5
 *
 * And, for the three things the owner added on 2026-08-30 — the margin holdback,
 * the investor settings and the one-system view:
 *   9.  move the holdback from 0.25 to 0.5                                → MARGIN-1
 *  10.  recompute the points off the rounded price instead of shifting    → MARGIN-2
 *  11.  drop the already-applied guard, so a second call takes 0.50       → MARGIN-5
 *  12.  hold back on Lender Price too, whose feed already carries ours    → MARGIN-6
 *  13.  leave the program's best-price figure quoting the raw number      → MARGIN-8
 *  14.  skip the holdback in combined-pricer.js entirely                    → MARGIN-9
 *  15.  pre-fill a missing white label with the investor's REAL name      → SET-2/2b/3
 *  16.  stop pre-filling Button Finance off                               → HIDE-2, SET-6
 *  17.  coerce a non-boolean on/off instead of refusing it                → SET-7
 *  18.  make the pre-filled source `both` again                           → ROUTE-1, SET-5
 *  19.  drop NQM/Acra/eResi from the owner's standing instruction         → OWNER-1/2/5
 *  20.  keep the vendor on every row of the ordinary board                → ONE-2/3
 *  21.  keep the per-vendor summary counts on the ordinary board          → ONE-4
 *  22.  turn the source reveal on by default                              → ONE-7
 *  23.  keep `source` on the unified option rows nobody asked about       → ONE-8
 *
 * A crashing test also "fails" and looks like proof, so every fixture here is
 * built so a wrong answer fails CLEANLY rather than throwing out of the battery.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const shared = require('../src/longterm/pricing/scenario-defaults');
const routing = require('../src/longterm/pricing/investor-routing');
const quoteShape = require('../src/longterm/pricing/quote-shape');
const vendorMargin = require('../src/longterm/pricing/vendor-margin');
const nexScenario = require('../src/longterm/loannex/scenario');
const nexParse = require('../src/longterm/loannex/parse');
const nexRegistry = require('../src/longterm/loannex/field-registry');
const portalLogin = require('../src/longterm/loannex/portal-login');
const lpModel = require('../src/longterm/lenderprice/search-model');
const lpRegistry = require('../src/longterm/lenderprice/field-registry');
const capture = require('../src/longterm/loannex/capture/quick-prices.json');
const ladders = require('../src/longterm/loannex/capture/rate-stack-vs-board.json');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }

const reg = nexRegistry.capturedRegistry();
const BASE = { purpose: 'Purchase', value: 500000, loan: 375000, zip: '08201', fico: 760, dscr: 1.3 };

/** Ask BOTH programs about one scenario. Total: a refusal is data, never a throw. */
function both(sc) {
  const v = lpModel.validateScenario({ ...BASE, ...sc });
  if (!v.ok) return { lp: { refused: v.error }, nex: { refused: 'not_reached' }, scenario: null };
  let lpBody = null, lpErr = null;
  try { lpBody = lpModel.buildSearch(v.scenario); } catch (e) { lpErr = e.code || e.message; }
  let nexBody = null, nexErr = null;
  try { nexBody = nexScenario.buildNexApp(v.scenario, reg, { countyKey: 31001 }); } catch (e) { nexErr = e.code || e.message; }
  return { lp: lpErr ? { refused: lpErr } : lpBody, nex: nexErr ? { refused: nexErr } : nexBody, scenario: v.scenario };
}
const refused = (x) => !!(x && x.refused);

console.log('Two programs, one loan — parity');

// ---- 1. THE DEFAULTS ARE ONE SET OF NUMBERS --------------------------------
{
  // `dscr: undefined` really removes it — BASE carries one, and a test that
  // silently kept it would prove the default fires when it never ran.
  const r = both({ dscr: undefined });
  ok(r.scenario && r.scenario.dscr === undefined, 'DEF-0 (fixture) the scenario under test genuinely omits the DSCR');
  ok(r.nex.prePaymentPenaltyTermInMonths === String(shared.DSCR_PROFILE.prepayMonths),
    `DEF-1 an omitted prepay is the shared five-year default on LoanNEX too (${r.nex.prePaymentPenaltyTermInMonths})`);
  ok(Number(r.nex.qualifiedDscr) === shared.DSCR_PROFILE.dscr,
    `DEF-2 …and an omitted DSCR is the shared 1.5, not null (${r.nex.qualifiedDscr})`);
  ok(r.nex.qualifiedMr === shared.DSCR_PROFILE.reservesMonths && r.nex.overrides.qualifiedMr === shared.DSCR_PROFILE.reservesMonths,
    'DEF-3 …and reserves are the shared 24 on every field LoanNEX wants it on');
  // Read out of the Lender Price REQUEST, not out of a copy of the constant —
  // otherwise this proves only that the test agrees with itself.
  const c = (r.lp.model && r.lp.model.criteria) || (r.lp.criteria) || {};
  ok(c.dscr === shared.DSCR_PROFILE.dscr,
    `DEF-4 the SAME 1.5 is what Lender Price actually puts on the wire (${c.dscr})`);
  ok(c.loanYear === shared.DSCR_PROFILE.termYears,
    `DEF-5 …and the same 30-year term (${c.loanYear})`);
  // An explicit zero is a real answer on both and must survive the default.
  const z = both({ prepayMonths: 0, dscr: 0 });
  ok(z.nex.prePaymentPenaltyTermInMonths === '0' && Number(z.nex.qualifiedDscr) === 0,
    'DEF-6 an explicit 0 prepay / 0 DSCR is an ANSWER, not an omission — the default never eats it');
}

// ---- 2. THE BUTTONS REACH BOTH PROGRAMS ------------------------------------
{
  // Each button set under a spelling that is NOT the canonical one, so this
  // fails the moment either side stops reading the shared vocabulary.
  const r = both({ isFirstTimeHomebuyer: true, isFirstTimeInvestor: true, waiveEscrow: true, isSelfEmployed: true, isRuralProperty: true });
  const c = (r.lp.model && r.lp.model.criteria) || r.lp.criteria || {};
  ok(r.nex.isFirstTimeHomebuyer === true, 'BTN-1 first-time home buyer reaches LoanNEX');
  ok(c.firstTimeHomeBuyer === true, 'BTN-2 …and Lender Price, from the same word');
  ok(r.nex.isFirstTimeInvestor === true, 'BTN-3 first-time investor reaches LoanNEX');
  ok(r.nex.isRuralProperty === true, 'BTN-5 rural reaches LoanNEX (there was no field for it at all)');

  // THE TWO HALVES ARE TESTED SEPARATELY, AND THAT SEPARATION IS THE POINT.
  // Above, the flags are set under NON-canonical spellings and pass through
  // `validateScenario`, which adds the canonical name — so those assertions prove
  // the CANONICALIZER. They cannot prove the ADAPTER: reverting LoanNEX to read
  // its old private `isSelfEmployed` still passes, because the canonicalizer has
  // by then put both spellings on the scenario. (Measured — that exact mutation
  // sailed through the first cut of this suite.)
  //
  // So the adapter is asked DIRECTLY, with ONLY the canonical word present.
  const canonOnly = { ...BASE, state: 'NJ', selfEmployed: true, firstTimeInvestor: true, fthb: true, rural: true, escrowWaive: true };
  let direct = null, directErr = null;
  try { direct = nexScenario.buildNexApp(canonOnly, reg, { countyKey: 31001 }); } catch (e) { directErr = e.code || e.message; }
  ok(!directErr && direct.isSelfEmployed === true,
    `BTN-4 self-employed reaches LoanNEX from the CANONICAL word alone — the adapter reads the shared vocabulary, not a private name of its own${directErr ? ' (' + directErr + ')' : ''}`);
  ok(!directErr && direct.isFirstTimeInvestor === true && direct.isFirstTimeHomebuyer === true
    && direct.isRuralProperty === true && direct.escrow === 'Waived',
    'BTN-4b …and so does every other button, from the canonical word alone');
  ok(r.nex.escrow === 'Waived' && c.escrowWaiver === true, 'BTN-6 waive escrow reaches BOTH — "Waived" here, the flag there');
  // Untouched means untouched: the vendor's own app omits these keys until the
  // control is used, and so do we.
  const q = both({});
  ok(!Object.prototype.hasOwnProperty.call(q.nex, 'isFirstTimeHomebuyer')
    && !Object.prototype.hasOwnProperty.call(q.nex, 'isRuralProperty'),
    'BTN-7 a button nobody touched is not sent at all — no invented answer');
  // Two spellings that disagree is a question, not something to resolve quietly.
  const conflict = lpModel.validateScenario({ ...BASE, fthb: true, isFirstTimeHomebuyer: false });
  ok(conflict.ok === false && conflict.error === 'conflicting_flag',
    'BTN-8 two spellings of one button that disagree are refused, never resolved by whichever was read first');
  // A STRING "false" IS TRUTHY IN JAVASCRIPT, which is why Lender Price refuses a
  // non-boolean by name rather than reading it. The shared reader must not quietly
  // convert one on the way past and rob that guard of the chance — an earlier cut
  // of this work did exactly that, and the existing Lender Price suite caught it.
  const strFalse = lpModel.validateScenario({ ...BASE, io: 'false' });
  ok(strFalse.ok === false && strFalse.error === 'non_boolean_value',
    'BTN-9 a string "false" still reaches the vendor\'s own strict refusal — never coerced to a real boolean on the way');
  let flagThrew = null;
  try { shared.readFlag({ selfEmployed: 'true' }, 'selfEmployed'); } catch (e) { flagThrew = e.code; }
  ok(flagThrew === 'invalid_flag_value',
    'BTN-10 …and an adapter asking the shared reader directly gets a refusal, not a guess');
}

// ---- 3. ONE PROPERTY VOCABULARY --------------------------------------------
{
  const words = ['SingleFamily', 'sfr', 'single family', '2-4 units', 'TwoToFourUnits', 'Unit2_4',
    '2 - 4 Unit', 'duplex', 'condo', 'Condominium', 'townhome', 'PUD', 'coop', 'MultiFamily', '5+ units'];
  const disagree = [];
  for (const w of words) {
    const r = both({ propertyType: w });
    if (refused(r.lp) !== refused(r.nex)) disagree.push(`${w} (LP ${refused(r.lp) ? 'refuses' : 'accepts'}, LoanNEX ${refused(r.nex) ? 'refuses' : 'accepts'})`);
  }
  ok(disagree.length === 0, `PROP-1 every way a person writes a property type is accepted by BOTH programs or neither${disagree.length ? ' — ' + disagree.join('; ') : ''}`);
  const junk = both({ propertyType: 'Spaceship' });
  ok(refused(junk.lp) && refused(junk.nex), 'PROP-2 …and a property type neither vendor knows is refused by both, never defaulted to single-family');
  // The one word that used to mean two different buildings.
  const mf = both({ propertyType: 'MultiFamily' });
  const lpMf = lpRegistry.resolvePropertyType('MultiFamily');
  ok(mf.nex.propertyType === 'FivePlusUnits' && lpMf && lpMf.units === 5,
    'PROP-3 "MultiFamily" means FIVE-PLUS units on both — it used to mean 2-4 on one of them');
  const dup = both({ propertyType: 'duplex' });
  ok(dup.nex.propertyType === 'TwoToFourUnits', 'PROP-4 …and "duplex" is still the smaller building');
}

// ---- 4. INTEREST-ONLY IS A PRODUCT, NOT A QUESTION -------------------------
{
  const r = both({ io: true });
  const nexKeys = Object.keys(r.nex).join(' ').toLowerCase();
  ok(!/interestonly|isio\b/.test(nexKeys),
    'IO-1 LoanNEX is asked NO interest-only question — measured across every recorded body, it has no such field');
  const c = (r.lp.model && r.lp.model.criteria) || r.lp.criteria || {};
  ok(c.interestOnly === true, 'IO-2 …while Lender Price takes it as a real search input');
  const board = nexParse.parse(capture.response);
  const opts = quoteShape.optionsFromLoanNex(board, {});
  const split = quoteShape.splitInterestOnly(opts);
  ok(split.io.length > 0 && split.amortizing.length > 0,
    `IO-3 so LoanNEX is narrowed on the ANSWER instead — ${split.io.length} interest-only / ${split.amortizing.length} amortizing out of the one call`);
  ok(split.io.every((o) => o.terms.interestOnly === true) && split.amortizing.every((o) => o.terms.interestOnly === false),
    'IO-4 …and every row lands in the bucket its own product says');
  const unknown = quoteShape.splitInterestOnly([{ terms: { interestOnly: null } }]);
  ok(unknown.io.length === 0 && unknown.amortizing.length === 0 && unknown.unknown.length === 1,
    'IO-5 a row whose product does not say is COUNTED as unclassified, never guessed into an answer');
}

// ---- 5. THE BOARD ALREADY CONTAINS EVERY RATE STACK ------------------------
{
  // The owner's worry: "they only give us a rate stack after we click, and we
  // need to do that for each and every program." Measured against ONE recorded
  // transaction: the rate stack IS the ladder already in the pricing answer.
  const key = (r) => `${Number(r.rate).toFixed(4)}|${r.lockDays}`;
  const boardMap = new Map(ladders.quickPricesRows.map((r) => [key(r), Number(r.price)]));
  let compared = 0, differ = 0;
  for (const r of ladders.rateStackRows) {
    const b = boardMap.get(key(r));
    if (b === undefined) { differ++; continue; }
    compared++;
    if (Math.abs(b - Number(r.price)) > 0.0005) differ++;
  }
  ok(ladders.rateStackRows.length > 50 && compared === ladders.rateStackRows.length && differ === 0,
    `STACK-1 the per-program rate stack is the ladder the single pricing call already returned — ${compared}/${ladders.rateStackRows.length} pairs identical, 0 differ`);
  ok(boardMap.size === ladders.rateStackRows.length,
    'STACK-2 …and neither carries a rate or a lock the other does not');
  // The LLPA arithmetic, on the vendor's own numbers.
  const pe = ladders.evidenceSample.pricingEvidence;
  const total = pe.adjustments.reduce((s, a) => s + a.priceAdjustment, 0);
  ok(Math.abs((pe.basePrice + total) - pe.price) < 0.0005,
    `STACK-3 base price + the named LLPA lines = the price on the board (${pe.basePrice} ${total >= 0 ? '+' : '−'} ${Math.abs(total)} = ${pe.price})`);
}

// ---- 6. ONE SHAPE, WHICHEVER VENDOR ----------------------------------------
{
  const board = nexParse.parse(capture.response);
  const nexOpts = quoteShape.optionsFromLoanNex(board, { loanAmount: 375000, fico: 760 });
  const lpOpts = quoteShape.optionsFromLenderPrice([{
    lender: 'X', program: 'P', priceBuild: { noteRate: 7, price: 100 }, adjustments: [], terms: { dayLock: 30 }, rateSheet: { expired: false },
  }]);
  const shapeOf = (o) => JSON.stringify(Object.keys(o).sort());
  ok(shapeOf(nexOpts[0]) === shapeOf(lpOpts[0]),
    'SHAPE-1 a LoanNEX row and a Lender Price row are the same object — the screen cannot tell them apart');
  ok(nexOpts[0].adjustments === null && lpOpts[0].adjustments !== null,
    'SHAPE-2 a LoanNEX row says its LLPAs are NOT FETCHED (null), not that it has none ([])');
  ok(nexOpts[0].flags.expired === null,
    'SHAPE-3 LoanNEX states no rate-sheet staleness, so the row says "unknown" — never a reassuring false');
  ok(nexOpts.every((o) => o.terms.dayLock != null),
    'SHAPE-4 every row carries its own lock period — a 60-day quote can never be read as a 30-day one');
  // Evidence: attaches when it describes THIS rate and lock, refuses otherwise.
  const ev = {
    rate: ladders.evidenceSample.pricingEvidence.rate,
    lockPeriod: ladders.evidenceSample.lockPeriod,
    price: ladders.evidenceSample.pricingEvidence.price,
    basePrice: ladders.evidenceSample.pricingEvidence.basePrice,
    adjustments: ladders.evidenceSample.pricingEvidence.adjustments,
    addOns: [],
  };
  const target = { ...quoteShape.emptyOption(), priceBuild: { ...quoteShape.emptyOption().priceBuild, noteRate: ev.rate }, terms: { ...quoteShape.emptyOption().terms, dayLock: ev.lockPeriod } };
  const attached = quoteShape.attachEvidence(target, ev);
  ok(attached.adjustments && attached.adjustments.length === ev.adjustments.length && attached.evidence.reconciles === true,
    'SHAPE-5a an evidence for THIS rate and lock lands, and its arithmetic is checked rather than trusted');
  const wrong = quoteShape.attachEvidence(target, { ...ev, rate: ev.rate + 1 });
  ok(wrong.adjustments === null && wrong.evidence.appliesToThisRate === false,
    'SHAPE-5 an evidence for a DIFFERENT rate is refused — one rate\'s LLPAs are never copied onto another');
}

// ---- 7. BUTTON FINANCE IS PRE-FILLED OFF — AS A SETTING, NOT AS CODE --------
// Owner-directed 2026-08-30: *"For Button Finance, just pre-fill that as off,
// and whenever we're ready for it, we're gonna turn it on over there. We're
// gonna put in the white label name for it, and we're gonna put it there so
// that it should take it from LoanNEX."*
//
// These assertions were RE-POINTED, not reverted, when the hard-coded
// suppression list was replaced by the investor settings: the OUTCOME the owner
// asked for is unchanged (they are not displayed), and what moved is that
// turning them on is now a setting rather than a deploy.
{
  const merged = {
    sources: { lenderprice: { answered: true }, loannex: { answered: true } },
    summary: {},
    investors: [
      { key: 'pennymac', investor: 'PennyMac', presentIn: ['lenderprice', 'loannex'], programs: { lenderprice: [{ source: 'lenderprice' }], loannex: [{ source: 'loannex' }] }, best: {} },
      { key: 'button_finance', investor: 'Button Finance', presentIn: ['loannex'], programs: { lenderprice: [], loannex: [{ source: 'loannex' }] }, best: {} },
    ],
    unmapped: [],
  };
  const out = routing.applyRouting(merged, { routes: {} });
  ok(!out.investors.some((i) => /button/i.test(String(i.investor))),
    'HIDE-1 Button Finance is not on the investor list');
  ok(out.hidden.some((h) => h.key === 'button_finance' && h.why === 'switched_off' && /pre-filled off/i.test(String(h.reason))),
    'HIDE-2 …and the removal is REPORTED with its reason, so a short board can always be accounted for');
  // They used to arrive as an UNMAPPED NAME, which is how they slipped past a
  // key-based rule in the first place. The registry knows them now, so they
  // resolve to a key on every road in and the setting can actually reach them.
  const resolved = require('../src/longterm/encompass/investors').resolve('Button Finance, Inc.');
  ok(resolved && resolved.key === 'button_finance',
    'HIDE-3 the vendor\'s own spelling resolves to a key — an unmapped NAME could never be switched off by a setting');
  const on = routing.applyRouting(merged, { routes: { button_finance: { enabled: true, source: 'loannex', whiteLabel: 'Slate Capital' } } });
  const btn = on.investors.find((i) => i.key === 'button_finance');
  ok(btn && btn.whiteLabel === 'Slate Capital' && btn.programCount === 1,
    'HIDE-4 …and "whenever we\'re ready" is one setting away — on, named, and fetched from LoanNEX, with no deploy');
  // NOT a price change. The holdback the owner authorized lives in ONE module,
  // and it is not this one — a board that both routes AND re-prices is a board
  // where nobody can say which of the two moved a number.
  //
  // ⛔ THIS GUARD IS ABOUT ARITHMETIC, NOT ABOUT A WORD. It used to fail on the
  // mere STRING "holdback", and went red the day routing learned to STRIP the
  // holdback's audit trail off the ordinary board — the OPPOSITE of adjusting a
  // price. A guard that reads as a broken feature is a guard somebody loosens to
  // nothing, so it is re-pointed rather than relaxed: the holdback's SIZE still
  // may not be written down a second time, and the BEHAVIOUR is pinned directly,
  // which no future wording can drift past.
  {
    const code = require('fs').readFileSync(require.resolve('../src/longterm/pricing/investor-routing'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok(!/0\.25/.test(code),
      'HIDE-5 the holdback SIZE is written down in exactly one module, and it is not this one');

    // The behavioural half: route a board and every rung comes back with the
    // price and the points it went in with, to the cent, with the reveal on and
    // with it off. A module that re-priced could not pass this whatever it said.
    const rung = { rate: 7.25, price: 101.25, points: -1.25, lockDays: 30 };
    const priced = {
      investors: [{ key: 'nqm', investor: 'NQM Funding', presentIn: ['loannex'],
        programs: { lenderprice: [], loannex: [{ source: 'loannex', program: 'P', rungs: [{ ...rung }] }] }, best: {} }],
      unmapped: [],
    };
    const rungsOf = (b) => b.investors.flatMap((i) => i.programs).flatMap((p) => p.rungs || []);
    const plainRungs = rungsOf(routing.applyRouting(priced, { routes: {} }));
    const shownRungs = rungsOf(routing.applyRouting(priced, { routes: {}, revealSource: true }));
    ok(plainRungs.length === 1 && plainRungs[0].price === rung.price && plainRungs[0].points === rung.points
      && shownRungs.length === 1 && shownRungs[0].price === rung.price && shownRungs[0].points === rung.points,
      'HIDE-5b …and routing a board moves no price and no points figure, either way the source flag is set');
  }
}

// ---- 8. THE PER-INVESTOR SOURCE SETTING ------------------------------------
{
  // Deliberately investors with NO standing instruction — otherwise these
  // assertions would be re-testing the owner rule rather than the default.
  const board = () => ({
    sources: { lenderprice: { answered: true }, loannex: { answered: true } },
    summary: {},
    investors: [
      { key: 'pennymac', investor: 'PennyMac', presentIn: ['lenderprice', 'loannex'], programs: { lenderprice: [{ source: 'lenderprice', p: 1 }], loannex: [{ source: 'loannex', p: 2 }] }, best: { lenderprice: { rate: 7 }, loannex: { rate: 6.9 } } },
      { key: 'visio', investor: 'Visio Lending', presentIn: ['lenderprice', 'loannex'], programs: { lenderprice: [{ source: 'lenderprice', p: 4 }], loannex: [{ source: 'loannex', p: 5 }] }, best: { lenderprice: { rate: 7.2 }, loannex: { rate: 7.15 } } },
      // Quoted by LoanNEX ONLY — the case ROUTE-4 is about.
      { key: 'champions', investor: 'Champions', presentIn: ['loannex'], programs: { lenderprice: [], loannex: [{ source: 'loannex', p: 3 }] }, best: { lenderprice: null, loannex: { rate: 7.1 } } },
    ],
    unmapped: [],
  });
  // ONE INVESTOR, ONE SOURCE. The pre-fill is Lender Price — that is where the
  // system fetches everything today, and the owner's own framing is "not touch
  // our own pricing engine that we currently have".
  const dflt = routing.applyRouting(board(), { routes: {}, revealSource: true });
  const pm = dflt.investors.find((i) => i.key === 'pennymac');
  ok(pm && pm.source === 'lenderprice' && pm.sourceOrigin === 'default' && pm.programCount === 1,
    'ROUTE-1 with nothing set an investor comes from ONE program — Lender Price, the one everything is fetched from today');
  const one = routing.applyRouting(board(), { routes: { pennymac: { source: 'loannex' } }, revealSource: true });
  const moved = one.investors.find((i) => i.key === 'pennymac');
  ok(moved.shownFrom.join() === 'loannex' && moved.bySource.lenderprice.length === 0 && moved.bySource.loannex.length === 1,
    'ROUTE-2 switching an investor to LoanNEX shows LoanNEX\'s programs and drops the other side\'s');
  const untouched = one.investors.find((i) => i.key === 'visio');
  ok(untouched && untouched.source === 'lenderprice' && untouched.sourceOrigin === 'default',
    'ROUTE-3 …and touches no other investor');
  const away = routing.applyRouting(board(), { routes: {} });
  ok(!away.investors.some((i) => i.key === 'champions') && away.hidden.some((h) => h.key === 'champions' && h.why === 'source_had_no_quote'),
    'ROUTE-4 an investor whose source answered but did not quote them is HIDDEN with a reason — never quietly served the other program\'s price');
  const off = routing.applyRouting(board(), { routes: { pennymac: { enabled: false } } });
  ok(!off.investors.some((i) => i.key === 'pennymac') && off.hidden.some((h) => h.why === 'switched_off'),
    'ROUTE-5 an investor switched off is off on both programs');
  ok(off.summary.investorCount === off.investors.length,
    'ROUTE-6 the summary counts the board that is actually returned, not the one before the settings were applied');
  // ── THE THREE INVESTORS THE OWNER NAMED ────────────────────────────────
  // "There are three investors that are actually using LoanNEX for their
  // locking, and it's much more accurate: NQM, ACRA and eResi… these three
  // investors should be populated from LoanNEX instead."
  {
    const b = {
      sources: { lenderprice: { answered: true }, loannex: { answered: true } }, summary: {}, unmapped: [],
      investors: [
        { key: 'nqm', investor: 'NQM Funding', presentIn: ['lenderprice', 'loannex'], programs: { lenderprice: [{ source: 'lenderprice' }], loannex: [{ source: 'loannex' }] }, best: {} },
        { key: 'acra', investor: 'Acra Lending - Corr', presentIn: ['lenderprice', 'loannex'], programs: { lenderprice: [{ source: 'lenderprice' }], loannex: [{ source: 'loannex' }] }, best: {} },
        { key: 'eresi', investor: 'eResi', presentIn: ['lenderprice', 'loannex'], programs: { lenderprice: [{ source: 'lenderprice' }], loannex: [{ source: 'loannex' }] }, best: {} },
        { key: 'pennymac', investor: 'PennyMac', presentIn: ['lenderprice', 'loannex'], programs: { lenderprice: [{ source: 'lenderprice' }], loannex: [{ source: 'loannex' }] }, best: {} },
      ],
    };
    const out = routing.applyRouting(b, { routes: {}, revealSource: true });
    const three = ['nqm', 'acra', 'eresi'].map((k) => out.investors.find((i) => i.key === k));
    ok(three.every((i) => i && i.shownFrom.join() === 'loannex' && i.bySource.lenderprice.length === 0),
      'OWNER-1 NQM, Acra and eResi are priced from LoanNEX and are NOT populated from Lender Price');
    ok(three.every((i) => i.sourceOrigin === 'owner_directed'),
      'OWNER-2 …and the board says WHY — an owner instruction, not a default and not something a comparison decided');
    const other = out.investors.find((i) => i.key === 'pennymac');
    ok(other && other.source === 'lenderprice' && other.sourceOrigin === 'default' && other.bySource.lenderprice.length === 1,
      'OWNER-3 …and every OTHER investor is untouched, still fetched exactly where it was — "not touch our own pricing engine"');
    // The settings must still be able to put one back without a deploy.
    const over = routing.applyRouting(b, { routes: { nqm: { source: 'lenderprice' } }, revealSource: true });
    const nqm = over.investors.find((i) => i.key === 'nqm');
    ok(nqm && nqm.shownFrom.join() === 'lenderprice' && nqm.sourceOrigin === 'setting',
      'OWNER-4 a setting overrides the standing instruction, so a bad day at LoanNEX is one change away and not a deploy');
    // If LoanNEX is DOWN, those three are hidden — never quietly served Lender
    // Price's second-hand number — and the reason names the outage.
    const down = routing.applyRouting({
      ...b,
      sources: { lenderprice: { answered: true }, loannex: { answered: false, error: 'loannex_login_not_configured' } },
      investors: b.investors.map((i) => ({ ...i, presentIn: ['lenderprice'], programs: { lenderprice: [{ source: 'lenderprice' }], loannex: [] } })),
    }, { routes: {} });
    const outage = down.hidden.filter((h) => ['nqm', 'acra', 'eresi'].includes(h.key));
    ok(outage.length === 3 && outage.every((h) => h.why === 'source_did_not_answer' && /did not answer/.test(h.reason)),
      'OWNER-5 with LoanNEX down those three are HIDDEN and the reason says the program did not answer — Lender Price is never substituted for them');
  }

  const junk = routing.readSettings('{"acra":{"source":"sometimes"}}');
  ok(!junk.settings.acra && junk.problems.some((p) => p.error === 'unknown_source'),
    'ROUTE-7 an unrecognised source is refused BY NAME, never read as "off" — a typo must not hide a lender');
  ok(routing.readSettings('not json').problems.some((p) => p.error === 'unparsable'),
    'ROUTE-8 …and unreadable settings complain instead of silently applying nothing');
}

// ---- 9. THE PORTAL SIGN-IN --------------------------------------------------
{
  const I = portalLogin._internals;
  ok(I.antiforgeryTokenFromHtml('<input name="__RequestVerificationToken" type="hidden" value="CfDJ8abc" />') === 'CfDJ8abc'
    && I.antiforgeryTokenFromHtml('<input value="CfDJ8xyz" name="__RequestVerificationToken">') === 'CfDJ8xyz',
    'LOGIN-1 the antiforgery token is read whichever order the attributes are written in');
  ok(I.antiforgeryTokenFromHtml('<html>no form here</html>') === null,
    'LOGIN-2 …and a page without one yields NOTHING, so the sign-in fails closed rather than posting a blank token');
  ok(I.tokenKeyFromIframeHtml('<iframe src="https://webapp.loannex.com/nex-app?portal=nqmfcorr&amp;tokenKey=772d1d51-39b1-4bca-bf6b-a394bc418e8f"></iframe>')
    === '772d1d51-39b1-4bca-bf6b-a394bc418e8f',
    'LOGIN-3 the ticket is read out of the investor-portal iframe, entity-escaped ampersand and all');
  const jar = I.newJar();
  I.absorb(jar, { headers: { getSetCookie: () => ['.AspNetCore.Antiforgery.X=abc; path=/; httponly', 'Auth=zzz; path=/'] } });
  ok(I.cookieHeader(jar) === '.AspNetCore.Antiforgery.X=abc; Auth=zzz',
    'LOGIN-4 the cookie jar carries the antiforgery cookie back — without it a good password fails like a bad one');
  I.absorb(jar, { headers: { getSetCookie: () => ['Auth=; expires=Thu, 01 Jan 1970 00:00:00 GMT'] } });
  ok(!/Auth=/.test(I.cookieHeader(jar)),
    'LOGIN-4b …and a blanked cookie is a DELETE, so a dead session is never sent back');
  let threw = null;
  try { I.assertPortalPath('POST', '/loans/locks'); } catch (e) { threw = e.code; }
  ok(threw === 'loannex_portal_path_blocked',
    'LOGIN-6 the sign-in module may request four paths and nothing else — it can never reach a booking endpoint');
  ok(I.assertPortalPath('GET', '/account/Logoff') && I.assertPortalPath('POST', '/Account/Login'),
    'LOGIN-6b …and the vendor\'s own mixed casing is accepted, because the recording uses both');
  ok(!/Password=Yy|Password=[^<]/.test(I.scrub('UserName=x&Password=hunter2&__RequestVerificationToken=CfDJ8zz'))
    && /<redacted>/.test(I.scrub('UserName=x&Password=hunter2')),
    'LOGIN-7 a password can never reach a log or an error message');
  const src = require('fs').readFileSync(require.resolve('../src/longterm/loannex/portal-login'), 'utf8');
  ok(/tokenKey/.test(src) && /if \(!tokenKey\)/.test(src),
    'LOGIN-5 success is judged by a TICKET coming back, not by guessing the shape of a response body nobody recorded');
}


// ---- 10. THE MARGIN HOLDBACK WE ADD OURSELVES ------------------------------
// Owner-directed 2026-08-30, in writing: *"Every investor from LoanNEX needs to
// get the 0.25 margin hold back added, the same way you see in certain programs
// that Lender Price is adding it manually. On LoanNEX, everybody, you need to
// add this manually."*
{
  const raw = nexParse.parse(capture.response);
  const held = vendorMargin.applyToBoard(raw, 'loannex');
  const rawRungs = raw.programs.flatMap((p) => p.rungs || []);
  const heldRungs = held.programs.flatMap((p) => p.rungs || []);

  let priced = 0, exact = 0, worstPrice = 0, worstPoints = 0, disagree = 0;
  for (let i = 0; i < heldRungs.length; i++) {
    const a = rawRungs[i], b = heldRungs[i];
    if (!Number.isFinite(Number(a.price))) continue;
    priced++;
    worstPrice = Math.max(worstPrice, Math.abs((Number(a.price) - Number(b.price)) - 0.25));
    worstPoints = Math.max(worstPoints, Math.abs((Number(b.points) - Number(a.points)) - 0.25));
    if (Math.abs((Number(a.price) - Number(b.price)) - 0.25) < 1e-9) exact++;
    // The price and the points must still describe ONE number: 100 − price is
    // the identity between them, and a board where they disagree by a
    // thousandth is a board somebody spends an afternoon on.
    if (Math.abs(Number(b.points) - (100 - Number(b.price))) > 0.0011) disagree++;
  }
  ok(priced > 5000 && exact === priced && worstPrice < 1e-9,
    `MARGIN-1 every LoanNEX price is held back by EXACTLY 0.25 — ${exact}/${priced} rungs, worst deviation ${worstPrice.toFixed(9)}`);
  ok(worstPoints < 1e-9,
    `MARGIN-2 …and the points move up by exactly the same 0.25, so the two still describe one number (worst ${worstPoints.toFixed(9)})`);
  ok(disagree === 0,
    `MARGIN-3 …with price and points never drifting apart — points are SHIFTED, never recomputed off a rounded price (${disagree} disagreements)`);
  ok(heldRungs.every((r) => !Number.isFinite(Number(r.price)) || (Number.isFinite(Number(r.vendorPrice)) && r.marginHoldback === 0.25)),
    'MARGIN-4 the vendor\'s own number is kept on every rung — a number we changed must always reconcile to the number we were given');
  const twice = vendorMargin.applyToBoard(held, 'loannex');
  ok(twice === held,
    'MARGIN-5 applying it twice is a NO-OP, not 0.50 — a board already held back refuses to be held back again');
  const lpBoard = { programs: [{ rungs: [{ rate: 7, price: 100.5, points: -0.5 }] }] };
  ok(vendorMargin.applyToBoard(lpBoard, 'lenderprice') === lpBoard && vendorMargin.holdbackFor('lenderprice') === 0,
    'MARGIN-6 Lender Price holds back NOTHING here — its feed already carries ours, and taking it again would double it');
  ok(vendorMargin.holdbackFor('somebody_else') === 0,
    'MARGIN-7 …and a vendor nobody has authorized a holdback for gets none, rather than inheriting LoanNEX\'s');
  {
    // The per-program summary is derived from the rungs, so it has to move with
    // them: a `maxPrice` still quoting the raw number contradicts every row.
    const p = held.programs.find((x) => (x.rungs || []).some((r) => Number.isFinite(Number(r.price))));
    const best = Math.max(...p.rungs.filter((r) => Number.isFinite(Number(r.price))).map((r) => Number(r.price)));
    ok(Math.abs(Number(p.maxPrice) - best) < 1e-9,
      'MARGIN-8 the program\'s own best-price figure is recomputed from the held-back rungs, not left quoting the raw one');
  }
  {
    // ORDER MATTERS, and it is the subtle version of the same bug: hold back
    // AFTER the comparison and the merge elects on raw prices while the board
    // shows held-back ones, so the stated reason would not match the numbers.
    //
    // ⛔ ANCHORED ON THE MERGE ITSELF, NOT ON ONE SPELLING OF IT. This read
    // `routing.applyRouting(merge(` — the two calls written as one expression —
    // and went red the day the merged board was given a name so a second, purely
    // internal routing pass could re-use it. The ORDER had not moved at all. A
    // guard that fails on a rename reads as a broken feature and gets loosened to
    // nothing, so it now anchors on the `merge(boards` call, which is the thing
    // the holdback has to come before.
    const src = require('fs').readFileSync(require.resolve('../src/longterm/routes/combined-pricer'), 'utf8');
    const atMargin = src.indexOf('vendorMargin.applyToBoard');
    const atMerge = src.indexOf('merge(boards');
    ok(atMargin > 0 && atMerge > atMargin,
      'MARGIN-9 …and it is applied BEFORE the merge and the comparison, so nothing is ever elected on a number the board does not show');
  }
}

// ---- 11. THE INVESTOR SETTINGS ---------------------------------------------
// Owner-directed 2026-08-30: *"You should open a settings menu where you have
// every single investor listed. Pre-fill a white label name for everybody, and
// if their products are coming up, pre-fill where it's fetching their product…
// For every investor, we can always switch it from where we want to take the
// information."*
{
  const registry = require('../src/longterm/encompass/investors');
  const d = routing.describeSettings('');
  const keys = new Set(d.investors.map((r) => r.key));
  ok(d.investors.length === registry.list().length && registry.list().every((x) => keys.has(x.key)),
    `SET-1 EVERY investor is listed (${d.investors.length}) — the roster is derived from the one investor registry, so there is no second list to go stale`);
  // MEASURED AGAINST THE SHEET, never against the row's own flag: a pre-fill
  // that invents a name also clears the flag, so an assertion built on the flag
  // agrees with itself and proves nothing. The count and the NAME are the two
  // independent facts a guess cannot satisfy.
  const sheet = require('../src/longterm/lenderprice/investor-programs');
  const namedBySheet = registry.list().filter((x) => sheet.whiteLabelOf(x.key)).length;
  ok(d.investors.filter((r) => r.whiteLabel).length === namedBySheet,
    `SET-2 a white label is never INVENTED to fill a box — exactly the ${namedBySheet} the white-label sheet actually names carry one, and no more`);
  ok(d.investors.every((r) => !r.whiteLabel || String(r.whiteLabel).trim().toLowerCase() !== String(r.label).trim().toLowerCase()),
    'SET-2b …and no row is pre-filled with the investor\'s REAL name, which is the one name a client may never see');
  ok(d.summary.missingWhiteLabel === d.investors.length - namedBySheet && d.investors.every((r) => r.whiteLabelMissing === !r.whiteLabel),
    `SET-3 …and the ones with no client-safe name yet are REPORTED (${d.summary.missingWhiteLabel}), so they can be named on purpose`);
  const three = ['nqm', 'acra', 'eresi'].map((k) => d.investors.find((r) => r.key === k));
  ok(three.every((r) => r && r.source === 'loannex' && r.sourceOrigin === 'owner_directed'),
    'SET-4 the three the owner named are pre-filled to LoanNEX, and the row says the instruction is where that came from');
  ok(d.investors.filter((r) => r.key !== 'nqm' && r.key !== 'acra' && r.key !== 'eresi').every((r) => r.source === 'lenderprice'),
    'SET-5 …and every other investor is pre-filled to Lender Price — where the system fetches everything today');
  const btn = d.investors.find((r) => r.key === 'button_finance');
  ok(btn && btn.enabled === false && btn.enabledOrigin === 'owner_directed' && d.summary.off === 1,
    'SET-6 Button Finance is pre-filled OFF and is the only one that is — the rest are on');
  const set = routing.readSettings('{"acra":{"enabled":"yes"},"not_an_investor":{"source":"loannex"}}');
  ok(set.problems.some((p) => p.investor === 'acra' && p.error === 'non_boolean_enabled') && set.settings.acra === undefined,
    'SET-7 a non-boolean "on" is REFUSED rather than coerced — the string "no" is truthy, and a coerced switch is a lender switched on by a typo');
  ok(set.problems.some((p) => p.investor === 'not_an_investor' && p.error === 'unknown_investor'),
    'SET-8 …and a setting for an investor nobody has heard of is reported BY NAME rather than silently matching nothing');

  // ---- THE WAY BACK TO THE PRE-FILL --------------------------------------
  // The whole map is sent on every save, so a row that HAS a setting must re-send
  // it or the save would drop it — which means that without a deliberate way back,
  // a row that was ever touched is pinned FOREVER: setting it to exactly the
  // pre-fill value still stores a restatement, and a later change to the owner's
  // standing instruction never reaches it. The route's own note calls returning a
  // row to its pre-fill "the one thing somebody auditing this will want to do most
  // often", so this pins BOTH halves — the server telling the screen what the
  // pre-fill would answer, and the screen's own rule for expressing it.
  {
    const fresh = routing.describeSettings(null, {}).investors.find((r) => r.key === 'nqm');
    ok(fresh && fresh.prefill && fresh.prefill.source === 'loannex' && fresh.prefill.enabled === true,
      'SET-9 every row says what it WOULD answer with no setting of its own, so a screen can offer the way back rather than only describe it');
    const btnPinnedOn = routing.describeSettings({ button_finance: { enabled: true } }, {})
      .investors.find((r) => r.key === 'button_finance');
    ok(btnPinnedOn && btnPinnedOn.enabled === true && btnPinnedOn.prefill.enabled === false,
      'SET-9b …and the pre-fill it reports is the owner\'s instruction, not a copy of whatever is stored right now');

    // The SCREEN'S OWN rule, lifted verbatim out of the JSX — never retyped here,
    // or this would prove only that the test agrees with itself.
    const jsx = require('fs').readFileSync(require.resolve('../app-v2/src/longterm/LtCombinedSettings.jsx'), 'utf8');
    const from = jsx.indexOf('function patchOf(');
    const patchOf = eval('(' + jsx.slice(from, jsx.indexOf('\n}\n', from) + 3).replace(/^function patchOf/, 'function') + ')');
    const sendWhole = (rows, edits) => {
      const body = {};
      for (const r of rows) { const patch = patchOf(r, edits[r.key] || {}); if (Object.keys(patch).length) body[r.key] = patch; }
      return body;
    };
    const pinned = routing.readSettings(
      sendWhole(routing.describeSettings(null, {}).investors, { nqm: { source: 'lenderprice' } })).settings;
    const afterPin = routing.describeSettings(pinned, {}).investors.find((r) => r.key === 'nqm');
    ok(afterPin.source === 'lenderprice' && afterPin.sourceOrigin === 'setting',
      'SET-10 a row somebody moved off the pre-fill is stored, and the row says the setting is where that came from');

    // Typed BACK to the pre-fill value by hand: still pinned. That is the trap.
    const byHand = routing.readSettings(
      sendWhole(routing.describeSettings(pinned, {}).investors, { nqm: { source: 'loannex' } })).settings;
    ok(routing.describeSettings(byHand, {}).investors.find((r) => r.key === 'nqm').sourceOrigin === 'setting',
      'SET-10b …and typing it back to the pre-fill VALUE leaves it pinned — a restatement is still a setting, which is why a way back has to exist');

    // The button: the key leaves the map entirely and the row answers to the pre-fill again.
    const reset = sendWhole(routing.describeSettings(pinned, {}).investors, { nqm: { reset: true } });
    const afterReset = routing.describeSettings(routing.readSettings(reset).settings, {}).investors.find((r) => r.key === 'nqm');
    ok(reset.nqm === undefined && afterReset.source === 'loannex' && afterReset.sourceOrigin === 'owner_directed',
      'SET-11 "use the pre-fill" leaves the row out of the saved map altogether, so it follows the standing instruction again');

    // …and it touches nobody else, which is what makes it safe to press.
    const others = routing.describeSettings(routing.readSettings(reset).settings, {}).investors
      .filter((r) => r.key !== 'nqm');
    const base = routing.describeSettings(null, {}).investors.filter((r) => r.key !== 'nqm');
    ok(others.length === base.length && others.every((r, i) => r.source === base[i].source && r.enabled === base[i].enabled),
      'SET-11b …and resetting one row changes nothing about any other');
  }
}

// ---- 12. ONE SYSTEM --------------------------------------------------------
// Owner-directed 2026-08-30: *"At our system, it shouldn't be a difference from
// where it's taking the information. It should be something where the admin can
// go in and click to see the source of the info, and it's telling him the
// source. At our system, it should sound like one system. It shouldn't sound
// like it's coming from different places."*
{
  // Built by the REAL holdback, exactly as the pipeline builds it.
  const heldNexPrograms = vendorMargin.applyToBoard({
    source: 'loannex',
    programs: [{ source: 'loannex', investorOrganizationGuid: 'g', program: 'B', rungs: [{ rate: 6.9, price: 101.5, points: -1.5, lockDays: 30 }] }],
  }, 'loannex').programs;

  const board = () => ({
    sources: { lenderprice: { answered: true }, loannex: { answered: false, error: 'loannex_login_not_configured' } },
    summary: { inBoth: 1, lenderpriceOnly: 0, loannexOnly: 0, electedLoannex: 1 },
    unmapped: [],
    investors: [
      {
        key: 'nqm', investor: 'NQM Funding', presentIn: ['lenderprice', 'loannex'],
        // ⛔ THE LOANNEX SIDE GOES THROUGH THE REAL HOLDBACK. This fixture had NO
        // RUNGS AT ALL, so ONE-2 and ONE-3 were structurally unable to reach the
        // fingerprint the holdback leaves — `marginHoldback` and `vendorPrice` on
        // every LoanNEX rung and on no Lender Price one — and both passed for
        // months over a board that still said which vendor produced each row.
        // Deriving the rungs from `vendor-margin.js` itself is what stops the
        // guard drifting from the thing it guards.
        programs: { lenderprice: [{ source: 'lenderprice', lenderId: 42, program: 'A', rungs: [{ rate: 7, price: 100.75, points: -0.75, lockDays: 30 }] }], loannex: heldNexPrograms },
        best: { lenderprice: { rate: 7 }, loannex: { rate: 6.9 } }, comparison: { x: 1 }, reason: 'because',
      },
      {
        key: 'pennymac', investor: 'PennyMac', presentIn: ['lenderprice'],
        programs: { lenderprice: [{ source: 'lenderprice', lenderId: 7, program: 'C' }], loannex: [] },
        best: { lenderprice: { rate: 7.5 } },
      },
    ],
  });
  const plain = routing.applyRouting(board(), { routes: {} });
  const flat = plain.investors.flatMap((i) => i.programs);
  ok(plain.investors.every((i) => Array.isArray(i.programs)) && flat.length === 2,
    'ONE-1 an investor comes back with ONE flat list of programs — not a list per vendor, which is what makes a board read as two systems');
  ok(!/"source"|lenderId|investorOrganizationGuid|marginHoldback|vendorPrice/.test(JSON.stringify(flat)),
    'ONE-2 …and not one row says which vendor produced it — the vendor ids go too, and so does the holdback trail, which is stamped on LoanNEX rungs and no others and so names the vendor by its mere presence');
  {
    // The fingerprint is REMOVED, never NEUTRALISED: the price and the points a
    // rung carries are the held-back ones and must come through untouched.
    const nexRung = flat.flatMap((p) => p.rungs || []).find((r) => r.rate === 6.9);
    ok(!!nexRung && nexRung.price === heldNexPrograms[0].rungs[0].price && nexRung.points === heldNexPrograms[0].rungs[0].points,
      'ONE-2b …while the held-back price and points themselves are untouched — the trail is dropped, not the deduction');
    const adminFlat = routing.applyRouting(board(), { routes: {}, revealSource: true }).investors.flatMap((i) => i.programs);
    const adminRung = adminFlat.flatMap((p) => p.rungs || []).find((r) => r.rate === 6.9);
    ok(!!adminRung && adminRung.marginHoldback === 0.25 && adminRung.vendorPrice === 101.5,
      'ONE-2c …and an admin who ASKS still gets the whole trail — the raw vendor price and the size of the deduction');
  }
  ok(plain.sources === undefined && !/lenderprice|loannex/i.test(JSON.stringify(plain.investors)),
    'ONE-3 …and the board carries no vendor names at all: `sources`, its errors, and every per-investor mention are gone');
  ok(plain.summary.inBoth === undefined && plain.summary.electedLoannex === undefined && plain.summary.fromLoanNex === undefined,
    'ONE-4 …nor the per-vendor counts, which describe where the board came FROM — exactly what an ordinary reader is not shown');
  const admin = routing.applyRouting(board(), { routes: {}, revealSource: true });
  const nqm = admin.investors.find((i) => i.key === 'nqm');
  ok(nqm.source === 'loannex' && nqm.sourceOrigin === 'owner_directed' && nqm.shownFrom.join() === 'loannex' && !!nqm.bySource && !!admin.sources,
    'ONE-5 an admin who ASKS is told the source, where it came from, and the per-vendor split — the owner\'s "click to see the source"');
  ok(plain.investors.length === admin.investors.length
    && plain.investors.every((p, i) => p.programCount === admin.investors[i].programCount),
    'ONE-6 NOTHING is discarded either way — the same investors, the same programs; the flag decides what is SHOWN, not what is kept');
  {
    const src = require('fs').readFileSync(require.resolve('../src/longterm/routes/combined-pricer'), 'utf8');
    ok(/revealSource:\s*b\.revealSource === true \|\| String\(req\.query\.source \|\| ''\) === 'show'/.test(src),
      'ONE-7 …and the reveal is an explicit ASK on the route — never the default, so the ordinary board can never leak it');
    ok(/delete row\.source/.test(src),
      'ONE-8 …including on the unified option rows, which carry the vendor internally because the two are shaped differently on the wire');

    // ⛔ AND THE INTERNAL COPY MUST ACTUALLY EXIST. The option shaper needs each
    // row's vendor because the two are shaped differently on the wire — and the
    // ordinary board has had exactly that stripped off. It used to fall back to
    // grouping the STRIPPED list by `source`, which is nobody's source, so every
    // row was dropped as unshapeable and `?shape=options` answered EMPTY unless
    // the caller ALSO asked to see the source. `shape` and `source` are separate
    // request parameters, so that pairing was never guaranteed.
    ok(!/groupBySource\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
      'ONE-9 the option shaper never re-groups the reveal-stripped list — that list has no vendor on it by design, so grouping it drops every row');
    ok(/revealSource: true \}\)\.investors/.test(src),
      'ONE-9b …it takes the split from a revealing pass over the same merged board instead, which is the only place it can honestly come from');

    // The behaviour itself: the same board, shaped both ways, yields the same
    // number of shapeable rows. A shaper that could not see the vendor would
    // answer nothing on the ordinary board while answering fully on the admin's.
    {
      const raw = require('../src/longterm/pricing/merge').merge(
        { lenderprice: null, loannex: { source: 'loannex', programs: [{ source: 'loannex', lender: 'NQM Funding', investor: 'NQM Funding', program: 'P', rungs: [{ rate: 7, price: 101, points: -1, lockDays: 30 }] }] } },
        { errors: {} });
      const splitFor = (reveal) => {
        const routed = routing.applyRouting(raw, { revealSource: reveal });
        const lookup = new Map();
        if (!reveal) for (const x of routing.applyRouting(raw, { revealSource: true }).investors) lookup.set(x.key, x.bySource);
        return routed.investors.reduce((n, x) => {
          const by = x.bySource || lookup.get(x.key) || { lenderprice: [], loannex: [] };
          return n + by.lenderprice.length + by.loannex.length;
        }, 0);
      };
      ok(splitFor(true) === 1 && splitFor(false) === 1,
        'ONE-9c …so the ordinary board can shape exactly what the admin\'s board can — an option list that empties itself unless somebody asks for the source is not one system, it is no system');
    }
  }
}


// ---- 13. THE COMBINED BOARD IS THE GENERAL ENGINE'S OWN SHAPE --------------
// Owner-directed 2026-08-30: *"Don't touch our current setup that we currently
// have: our General Pricing Engine. Just make this totally separate, but copy
// everything from the General Pricing Engine and add this as it is… That should
// be jumping and going between Lender Price and LoanNEX."*
//
// The Combined Pricing Engine's screen is a COPY of the general one, so the
// board it reads has to be the shape that screen already reads. That is what
// these assertions are about: a LoanNEX ladder arriving as `options[]` with a
// `priceBuild`, exactly like a Lender Price program.
{
  const nexBoard = vendorMargin.applyToBoard(nexParse.parse(capture.response), 'loannex');
  // A Lender Price program in that vendor's OWN shape — options + priceBuild.
  const lpBoard = {
    programs: [{
      lender: 'PennyMac', investor: 'PennyMac', program: 'DSCR 30', product: '30 Yr Fixed', lenderId: 9,
      options: [{ priceBuild: { noteRate: 7.25, price: 100.5, adjustedPoints: -0.5 }, monthlyPayment: { monthlyPI: 2100 }, rateSheet: { expired: false, name: 'sheet' } }],
    }],
  };
  const merged = routing.applyRouting(
    require('../src/longterm/pricing/merge').merge({ lenderprice: lpBoard, loannex: nexBoard }, { errors: {} }),
    { routes: { pennymac: { source: 'lenderprice' } } },
  );
  const progs = quoteShape.programsForBoard(merged);
  ok(progs.length > 20 && progs.every((p) => Array.isArray(p.options)),
    `BOARD-1 every program on the combined board carries options[] — the shape the general engine's screen reads (${progs.length} programs)`);
  ok(progs.every((p) => !Array.isArray(p.rungs)),
    'BOARD-2 …and no LoanNEX ladder reaches the screen as `rungs`, which that screen would draw as nothing at all');
  const lpRow = progs.find((p) => p.lender === 'PennyMac');
  ok(lpRow && lpRow.options[0].priceBuild.price === 100.5 && lpRow.options[0].rateSheet.expired === false,
    'BOARD-3 a Lender Price row passes through UNTOUCHED — the general engine\'s own answer, not a re-shaping of it');
  const nxRow = progs.find((p) => p.options.length && p.options[0].stalenessUnknown === true);
  ok(nxRow && Number.isFinite(nxRow.options[0].priceBuild.noteRate) && Number.isFinite(nxRow.options[0].priceBuild.price),
    'BOARD-4 …and a LoanNEX rung arrives as an option with a real rate and price beside it');
  ok(nxRow && nxRow.options[0].rateSheet.expired === null,
    'BOARD-5 THE ONE THAT MATTERS: a LoanNEX option\'s rate-sheet staleness stays NULL — the screen reads `!!expired`, so a false here is a clean bill of health LoanNEX never gave us');
  ok(nxRow && nxRow.options[0].monthlyPayment && nxRow.options[0].monthlyPayment.monthlyPI > 0,
    'BOARD-6 …and the payment is the VENDOR\'s own, under the key that screen reads — never re-derived, or two screens would quote one loan two ways');
  ok(nxRow && nxRow.options[0].priceBuild.pointsDerivedFromPrice === true && nxRow.options[0].priceBuild.basePoints === null,
    'BOARD-7 …with the points flagged as DERIVED from the price, and the un-fetched LLPA base left null rather than a fabricated 0');
  ok(!/"source"|lenderId|investorOrganizationGuid/.test(JSON.stringify(progs)),
    'BOARD-8 and not one row on the ordinary board names a vendor — the one-system rule reaches the copied screen too');
  // The reveal has to be asked for in BOTH places, and the route does exactly
  // that (one `opts.revealSource` feeds both calls). Asking only here cannot
  // work and must not appear to: `applyRouting` has already stripped the vendor
  // off the Lender Price rows by then, and nothing downstream can restore a fact
  // that was thrown away — which is the honest behaviour, not a gap.
  const adminBoard = routing.applyRouting(
    require('../src/longterm/pricing/merge').merge({ lenderprice: lpBoard, loannex: nexBoard }, { errors: {} }),
    { routes: { pennymac: { source: 'lenderprice' } }, revealSource: true },
  );
  const shown = quoteShape.programsForBoard(adminBoard, { reveal: true });
  ok(shown.some((p) => p.source === 'loannex') && shown.some((p) => p.source === 'lenderprice'),
    'BOARD-9 …while an admin who asks gets the vendor back on every row, both vendors named');
  ok(quoteShape.programsForBoard(merged, { reveal: true }).every((p) => p.source === undefined || p.source === 'loannex'),
    'BOARD-9b …and a reveal asked for HERE alone cannot resurrect what the one-system view already dropped — the flag travels together or not at all');
  ok(progs.every((p) => p.investorKey) && progs.every((p) => p.whiteLabel !== undefined),
    'BOARD-10 every row carries the canonical investor key and the client-safe name the server resolved — never re-derived in a browser');
}

console.log(fail ? `\nFAILURES: ${fail} (${pass} passed, ${fail} failed)` : `\nOFFLINE: all passed (${pass} passed, 0 failed)`);
process.exit(fail ? 1 : 0);
