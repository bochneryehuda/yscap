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
 *   8. drop Button Finance from SUPPRESSED                            → HIDE-1/2
 *   9. report a failed portal login as a success                      → LOGIN-5
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const shared = require('../src/longterm/pricing/scenario-defaults');
const routing = require('../src/longterm/pricing/investor-routing');
const quoteShape = require('../src/longterm/pricing/quote-shape');
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

// ---- 7. BUTTON FINANCE IS NOT DISPLAYED ------------------------------------
{
  const merged = {
    summary: {},
    investors: [
      { key: 'pennymac', investor: 'PennyMac', presentIn: ['lenderprice', 'loannex'], programs: { lenderprice: [{}], loannex: [{}] }, best: {} },
      { key: 'button', investor: 'Button Finance, Inc.', presentIn: ['loannex'], programs: { lenderprice: [], loannex: [{}] }, best: {} },
    ],
    unmapped: [{ source: 'loannex', name: 'Button Finance, Inc.', programs: ['DSCR'] }, { source: 'loannex', name: 'Somebody Else' }],
  };
  const out = routing.applyRouting(merged, { routes: {} });
  ok(!out.investors.some((i) => /button/i.test(String(i.investor))),
    'HIDE-1 Button Finance is not on the investor list');
  ok(!out.unmapped.some((u) => /button/i.test(String(u.name))),
    'HIDE-2 …nor on the unmapped list, which is the road they actually arrive by (they resolve to no investor key)');
  ok(out.hidden.filter((h) => /button/i.test(String(h.investor))).length === 2 && out.hidden.every((h) => !!h.reason),
    'HIDE-3 …and every removal is REPORTED with its reason, so a short board can always be accounted for');
  ok(/button ?finance/i.test(JSON.stringify(routing.SUPPRESSED)) && routing.suppressionFor('button finance llc') && !routing.suppressionFor('Acra Lending'),
    'HIDE-4 the match survives the punctuation and the corporate suffix, and catches nobody else');
  // NOT a price change. The owner's 0.25 sentence is an open question, not a rule.
  ok(!/0\.25|holdback/i.test(require('fs').readFileSync(require.resolve('../src/longterm/pricing/investor-routing'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')),
    'HIDE-5 no price is adjusted anywhere in the routing code — the 0.25 holdback is a question, not an implemented rule');
}

// ---- 8. THE PER-INVESTOR SOURCE SWITCH -------------------------------------
{
  // Deliberately investors with NO standing instruction — otherwise these
  // assertions would be re-testing the owner rule rather than the default.
  const board = () => ({
    summary: {},
    investors: [
      { key: 'pennymac', investor: 'PennyMac', presentIn: ['lenderprice', 'loannex'], programs: { lenderprice: [{ p: 1 }], loannex: [{ p: 2 }] }, best: { lenderprice: { rate: 7 }, loannex: { rate: 6.9 } } },
      { key: 'champions', investor: 'Champions', presentIn: ['loannex'], programs: { lenderprice: [], loannex: [{ p: 3 }] }, best: { lenderprice: null, loannex: { rate: 7.1 } } },
    ],
    unmapped: [],
  });
  const dflt = routing.applyRouting(board(), { routes: {} });
  ok(dflt.investors.length === 2 && dflt.investors.every((i) => i.route === 'both' && i.routeIsDefault),
    'ROUTE-1 with nothing set, every investor is shown from BOTH programs — nothing routes itself');
  const one = routing.applyRouting(board(), { routes: { pennymac: 'loannex' } });
  const acra = one.investors.find((i) => i.key === 'pennymac');
  ok(acra.shownFrom.join() === 'loannex' && acra.programs.lenderprice.length === 0 && acra.programs.loannex.length === 1,
    'ROUTE-2 routing an investor to LoanX shows LoanX\'s programs and drops the other side\'s');
  ok(one.investors.find((i) => i.key === 'champions').route === 'both',
    'ROUTE-3 …and touches no other investor');
  const away = routing.applyRouting(board(), { routes: { champions: 'lenderprice' } });
  ok(!away.investors.some((i) => i.key === 'champions') && away.hidden.some((h) => h.key === 'champions' && h.why === 'routed_source_absent'),
    'ROUTE-4 an investor routed to a program that did not quote them is HIDDEN with a reason — never quietly served the other program\'s price');
  const off = routing.applyRouting(board(), { routes: { pennymac: 'off' } });
  ok(!off.investors.some((i) => i.key === 'pennymac') && off.hidden.some((h) => h.why === 'route_off'),
    'ROUTE-5 an investor switched off is off on both programs');
  ok(off.summary.investorCount === off.investors.length,
    'ROUTE-6 the summary counts the board that is actually returned, not the one before routing');
  // ── THE THREE INVESTORS THE OWNER NAMED ────────────────────────────────
  // "NQM, ACRA and eResi lock on LoanX… it shouldn't populate these three
  // investors from Lender Price, and these three should be populated from LoanX
  // instead." Everything else stays exactly as it was.
  {
    const b = {
      sources: { lenderprice: { answered: true }, loannex: { answered: true } }, summary: {}, unmapped: [],
      investors: [
        { key: 'nqm', investor: 'NQM Funding', presentIn: ['lenderprice', 'loannex'], programs: { lenderprice: [{ a: 1 }], loannex: [{ b: 1 }] }, best: {} },
        { key: 'acra', investor: 'Acra Lending - Corr', presentIn: ['lenderprice', 'loannex'], programs: { lenderprice: [{ a: 1 }], loannex: [{ b: 1 }] }, best: {} },
        { key: 'eresi', investor: 'eResi', presentIn: ['lenderprice', 'loannex'], programs: { lenderprice: [{ a: 1 }], loannex: [{ b: 1 }] }, best: {} },
        { key: 'pennymac', investor: 'PennyMac', presentIn: ['lenderprice', 'loannex'], programs: { lenderprice: [{ a: 1 }], loannex: [{ b: 1 }] }, best: {} },
      ],
    };
    const out = routing.applyRouting(b, { routes: {} });
    const three = ['nqm', 'acra', 'eresi'].map((k) => out.investors.find((i) => i.key === k));
    ok(three.every((i) => i && i.shownFrom.join() === 'loannex' && i.programs.lenderprice.length === 0),
      'OWNER-1 NQM, Acra and eResi are priced from LoanX and are NOT populated from Lender Price');
    ok(three.every((i) => i.routeSource === 'owner_directed'),
      'OWNER-2 …and the board says WHY — an owner instruction, not a default and not something the comparison decided');
    const other = out.investors.find((i) => i.key === 'pennymac');
    ok(other && other.route === 'both' && other.shownFrom.length === 2 && other.programs.lenderprice.length === 1,
      'OWNER-3 …and every OTHER investor is untouched, still shown from both — "not touch our own pricing engine"');
    // The environment must still be able to put one back without a deploy.
    const over = routing.applyRouting(b, { routes: { nqm: 'both' } });
    const nqm = over.investors.find((i) => i.key === 'nqm');
    ok(nqm && nqm.shownFrom.length === 2 && nqm.routeSource === 'setting',
      'OWNER-4 a setting overrides the standing instruction, so a bad day at LoanX is one change away and not a deploy');
    // If LoanX is DOWN, those three are hidden — never quietly served Lender
    // Price's second-hand number — and the reason names the outage.
    const down = routing.applyRouting({ ...b, sources: { lenderprice: { answered: true }, loannex: { answered: false, error: 'loannex_login_not_configured' } }, investors: b.investors.map((i) => ({ ...i, presentIn: ['lenderprice'], programs: { lenderprice: [{ a: 1 }], loannex: [] } })) }, { routes: {} });
    const outage = down.hidden.filter((h) => ['nqm', 'acra', 'eresi'].includes(h.key));
    ok(outage.length === 3 && outage.every((h) => h.why === 'routed_source_did_not_answer' && /did not answer/.test(h.reason)),
      'OWNER-5 with LoanX down those three are HIDDEN and the reason says the program did not answer — Lender Price is never substituted for them');
  }

  const junk = routing.readRoutes('{"acra":"sometimes"}');
  ok(!junk.routes.acra && junk.problems.some((p) => p.error === 'unknown_route'),
    'ROUTE-7 an unrecognised route is refused BY NAME, never read as "off" — a typo must not hide a lender');
  ok(routing.readRoutes('not json').problems.some((p) => p.error === 'unparsable'),
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

console.log(fail ? `\nFAILURES: ${fail} (${pass} passed, ${fail} failed)` : `\nOFFLINE: all passed (${pass} passed, 0 failed)`);
process.exit(fail ? 1 : 0);
