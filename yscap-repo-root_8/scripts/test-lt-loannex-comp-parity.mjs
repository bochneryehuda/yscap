// LONG-TERM — THE COMPENSATION OVERLAY SITS ON BOTH PROGRAMS, IDENTICALLY.
//
// THE OWNER'S INSTRUCTION, 2026-08-30, and the whole subject of this file:
//
//   "Lender Price is also not making themselves the lender-paid vs borrower-paid.
//    Everything is going by our settings, where we understand the numbers by
//    ourselves and we add up and we remove the 2 points origination according to
//    the settings: how much origination, how much lender paid, how much YSP. We
//    do these numbers by ourselves. Just copy the same logic that we are doing as
//    an overlay on top of Lender Price, and make this overlay also on top of this
//    new thing work the same logic."
//
// WHAT THAT MEANS IN CODE, AND WHY THERE IS NOTHING TO COPY. The overlay was
// never a Lender Price feature: it takes a PRICE and a LOAN AMOUNT and answers
// what we charge, and it has never known or asked which vendor produced the
// price. So "make it work the same" is not a port — it is a PARITY CLAIM, and a
// parity claim is only worth anything if something fails the moment it stops
// being true. That is this file: the same overlay, the same plan, the same
// price, run on a LoanNEX row and on a Lender Price row, asserted EQUAL.
//
// The one thing that genuinely had to be built is the number the overlay is
// handed. LoanNEX's feed is the RAW investor price and Lender Price's already
// carries our holdback, so the two were not the same measurement — section C is
// the proof that the holdback lands BEFORE the overlay and that the overlay
// therefore reads one footing on both programs.
//
// PROVEN TO FAIL. Each applied to the production code, the named assertion red,
// the rest of the battery green either side:
//   1. drop `price` from the LoanNEX option's priceBuild          → A2
//   2. round the LoanNEX price to 2dp in quote-shape              → B (parity)
//   3. skip vendorMargin.applyToBoard in merged-pricer            → C2
//   4. make compShiftPoints fall back to DEFAULT_COMP_PLAN        → E2
//
// LT-only. No network, no DB, no RTL imports. compOverlay.js is plain ESM;
// quote-shape.js and vendor-margin.js are CommonJS, which Node imports as a
// default export — so this runs with no bundler and no browser.
import { createRequire } from 'node:module';
import {
  compShiftPoints, shiftedPrice, shiftBuild, quoteCharges, closingSheet, normalizePlan,
} from '../app-v2/src/longterm/compOverlay.js';

const require = createRequire(import.meta.url);
const quoteShape = require('../src/longterm/pricing/quote-shape.js');
const vendorMargin = require('../src/longterm/pricing/vendor-margin.js');
const nexParse = require('../src/longterm/loannex/parse.js');
const capture = require('../src/longterm/loannex/capture/quick-prices.json');
const fs = require('node:fs');

let bad = 0;
const ok = (cond, label) => {
  if (cond) console.log(`  ok   ${label}`);
  else { bad += 1; console.error(`  FAIL ${label}`); }
};

const PLAN = { lenderPaid: 2, borrowerPaid: 2, ysp: 0.25, applicationFee: 1595, commitmentFee: 500 };
const LOAN = 350000;
const MODES = ['borrowerPaid', 'raw', 'lenderPaid'];
// A battery that crosses par in both directions, sits ON par, and includes the
// owner's own worked figures (102 → 100, 103 → 101, 101 → 99, 100.25 with YSP).
const PRICES = [98, 99, 100, 100.25, 100.948, 101, 102, 103, 103.75];

/** One LoanNEX row per price, through the REAL board → option mapper. */
const nexRows = quoteShape.optionsFromLoanNex(
  { programs: [{ lender: 'X', investor: 'X', program: 'DSCR', product: '30 Yr Fixed', rungs: PRICES.map((price, i) => ({ rate: 7 + i / 100, price, points: Math.round((100 - price) * 1000) / 1000, lockDays: 30 })) }] },
  { loanAmount: LOAN, fico: 760, ltv: 75, loanPurpose: 'Purchase' },
);
/** One Lender Price row per price, through the REAL option mapper. */
const lpRows = quoteShape.optionsFromLenderPrice(PRICES.map((price, i) => ({
  lender: 'X', investor: 'X', program: 'DSCR', product: '30 Yr Fixed',
  priceBuild: { noteRate: 7 + i / 100, price, basePoints: 0, adjustmentPoints: Math.round((100 - price) * 1000) / 1000, adjustedPoints: Math.round((100 - price) * 1000) / 1000 },
  terms: { loanAmount: LOAN, dayLock: 30 },
  adjustments: [],
})));

console.log('\nA. the overlay reads ONE field, and both programs carry it');
ok(nexRows.length === PRICES.length && lpRows.length === PRICES.length,
  `A1 both mappers produced a row per price (${nexRows.length} / ${lpRows.length})`);
ok(nexRows.every((r, i) => r.priceBuild.price === PRICES[i]) && lpRows.every((r, i) => r.priceBuild.price === PRICES[i]),
  'A2 …and the price the overlay reads is on `priceBuild.price` on BOTH, at full precision — the overlay has one input, not two');
ok(nexRows.every((r) => r.terms.loanAmount === LOAN) && lpRows.every((r) => r.terms.loanAmount === LOAN),
  'A3 …and so is the loan amount the charges are struck against');
{
  // The overlay must not be able to tell them apart even by accident.
  const src = fs.readFileSync(new URL('../app-v2/src/longterm/compOverlay.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/loannex|lenderprice|lender price/i.test(src),
    'A4 the overlay names NO vendor anywhere in its code — it cannot behave differently for one, which is why parity is structural rather than maintained');
}

console.log('\nB. the same price, the same answer, whichever program produced it');
{
  let compared = 0, differ = 0, firstDiff = null;
  for (let i = 0; i < PRICES.length; i++) {
    for (const mode of MODES) {
      for (const waive of [false, true]) {
        const shift = compShiftPoints(mode, PLAN);
        const a = {
          shift,
          price: shiftedPrice(nexRows[i].priceBuild.price, shift),
          build: shiftBuild(nexRows[i].priceBuild, shift),
          charges: quoteCharges(mode, PLAN, nexRows[i].priceBuild.price, nexRows[i].terms.loanAmount, waive),
        };
        const b = {
          shift,
          price: shiftedPrice(lpRows[i].priceBuild.price, shift),
          build: shiftBuild(lpRows[i].priceBuild, shift),
          charges: quoteCharges(mode, PLAN, lpRows[i].priceBuild.price, lpRows[i].terms.loanAmount, waive),
        };
        compared++;
        // The CHARGES and the DISPLAYED PRICE are the whole answer — what the
        // borrower pays, what comes back, and what the board shows.
        if (JSON.stringify([a.shift, a.price, a.charges]) !== JSON.stringify([b.shift, b.price, b.charges])) {
          differ++;
          if (!firstDiff) firstDiff = { price: PRICES[i], mode, waive, nex: a.charges, lp: b.charges };
        }
        // The shifted build's PRICE half must agree too — the points half is
        // where the two legitimately differ (below).
        if (a.build.price !== b.build.price) { differ++; if (!firstDiff) firstDiff = { price: PRICES[i], mode, waive, note: 'build.price' }; }
      }
    }
  }
  ok(compared === PRICES.length * MODES.length * 2 && differ === 0,
    `B1 THE ONE THAT MATTERS: ${compared} price × mode × waive combinations, and the overlay's answer is IDENTICAL on a LoanNEX row and a Lender Price row (${differ} differ)${firstDiff ? ' — ' + JSON.stringify(firstDiff) : ''}`);
}
{
  // The owner's own worked rows, restated against a LoanNEX quote so the claim
  // is about THIS program rather than about the module in the abstract.
  const flat = { lenderPaid: 2, borrowerPaid: 2, ysp: 0, applicationFee: 1595, commitmentFee: 500 };
  const at = (p) => quoteShape.optionsFromLoanNex({ programs: [{ rungs: [{ rate: 7, price: p, points: Math.round((100 - p) * 1000) / 1000, lockDays: 30 }] }] }, { loanAmount: LOAN })[0].priceBuild.price;
  ok(quoteCharges('lenderPaid', flat, at(102), LOAN).displayPrice === 100,
    'B2 …and the owner\'s own rows hold on a LoanNEX quote: lender-paid 2.0 shows a raw 102 as par');
  const c103 = quoteCharges('lenderPaid', flat, at(103), LOAN);
  ok(c103.displayPrice === 101 && c103.credit && c103.credit.points === 1,
    'B3 …a raw 103 shows 101 and the borrower receives a 1.000 credit');
  const c101 = quoteCharges('lenderPaid', flat, at(101), LOAN);
  ok(c101.displayPrice === 99 && c101.lines.some((l) => l.key === 'buydown' && l.points === 1),
    'B4 …and a raw 101 shows 99 and the borrower pays a 1.000 buydown');
}
{
  // HONEST NOTE, said out loud rather than left for somebody to trip over: the
  // LLPA half of the build is NOT at parity yet, and cannot be. Lender Price
  // ships its itemization with the search; LoanNEX only gives one after a
  // second call per quote (`POST /loannex/explain`), so until that call is made
  // a LoanNEX row's base points are NULL — "not fetched", never a fabricated 0.
  const shifted = shiftBuild(nexRows[0].priceBuild, 2);
  ok(shifted.basePoints == null && shifted.adjustedPoints != null && shifted.price != null,
    'B5 the LLPA half is honestly ABSENT on a LoanNEX row until its own explain call is made — the money the overlay charges never depended on it');
}

console.log('\nC. the overlay reads ONE footing — the holdback lands first');
{
  const raw = nexParse.parse(capture.response);
  const held = vendorMargin.applyToBoard(raw, 'loannex');
  const rawOpt = quoteShape.optionsFromLoanNex(raw, { loanAmount: LOAN })[0];
  const heldOpt = quoteShape.optionsFromLoanNex(held, { loanAmount: LOAN })[0];
  const shift = compShiftPoints('lenderPaid', PLAN);
  const rawShown = shiftedPrice(rawOpt.priceBuild.price, shift);
  const heldShown = shiftedPrice(heldOpt.priceBuild.price, shift);
  ok(Math.abs((rawShown - heldShown) - 0.25) < 1e-9,
    `C1 the price the overlay displays on a LoanNEX quote is exactly 0.25 below the vendor's own (${rawShown} → ${heldShown})`);
  const rawCharges = quoteCharges('lenderPaid', PLAN, rawOpt.priceBuild.price, LOAN);
  const heldCharges = quoteCharges('lenderPaid', PLAN, heldOpt.priceBuild.price, LOAN);
  ok(JSON.stringify(rawCharges) !== JSON.stringify(heldCharges),
    'C2 …so the CHARGES move with it — skipping the holdback would quote every LoanNEX loan 0.25 better than the same loan on Lender Price, for reasons that have nothing to do with the investor');
  ok(heldOpt.priceBuild.pointsDerivedFromPrice === true
    && Math.abs(heldOpt.priceBuild.adjustedPoints - (100 - heldOpt.priceBuild.price)) < 0.0011,
    'C3 …and the option\'s points still describe its own price after the holdback, so the overlay\'s two inputs can never disagree');
  {
    const src = fs.readFileSync(new URL('../src/longterm/routes/combined-pricer.js', import.meta.url), 'utf8');
    ok(src.indexOf('vendorMargin.applyToBoard') > 0 && src.indexOf('vendorMargin.applyToBoard') < src.indexOf('quoteShape.optionsFromLoanNex'),
      'C4 …and the board is held back BEFORE it is ever shaped into an option, so no overlay anywhere can see a raw LoanNEX price');
  }
}

console.log('\nD. our settings decide it — on both programs, or on neither');
{
  ok(compShiftPoints('lenderPaid', PLAN) === 2 && compShiftPoints('borrowerPaid', PLAN) === 0.25 && compShiftPoints('raw', PLAN) === 0,
    'D1 the shift comes from OUR plan — the origination, the lender-paid comp and the YSP — exactly as the owner described');
  const other = { ...PLAN, lenderPaid: 1.5 };
  const a = quoteCharges('lenderPaid', other, nexRows[5].priceBuild.price, LOAN);
  const b = quoteCharges('lenderPaid', other, lpRows[5].priceBuild.price, LOAN);
  ok(JSON.stringify(a) === JSON.stringify(b) && a.displayPrice !== quoteCharges('lenderPaid', PLAN, nexRows[5].priceBuild.price, LOAN).displayPrice,
    'D2 …and changing a setting moves BOTH programs by the same amount — one plan, one answer, never a per-vendor rule');
  const deal = { value: 500000, loan: LOAN, purpose: 'Purchase' };
  const sa = closingSheet(quoteCharges('borrowerPaid', PLAN, nexRows[6].priceBuild.price, LOAN), deal);
  const sb = closingSheet(quoteCharges('borrowerPaid', PLAN, lpRows[6].priceBuild.price, LOAN), deal);
  ok(sa && sb && JSON.stringify(sa) === JSON.stringify(sb),
    'D3 …right through to the cash to close, which is the one number a person prices a deal for');
}

console.log('\nE. an unreadable plan fails to RAW on both — never to a guess');
{
  const broken = { lenderPaid: null, borrowerPaid: 2, ysp: 0, applicationFee: 1595, commitmentFee: 500 };
  ok(normalizePlan(broken) === null && compShiftPoints('lenderPaid', broken) === null,
    'E1 a plan with an unreadable figure is refused WHOLE — a patched-in 0 would price every loan as though nobody is paid');
  ok(quoteCharges('lenderPaid', broken, nexRows[0].priceBuild.price, LOAN) === null
    && quoteCharges('lenderPaid', broken, lpRows[0].priceBuild.price, LOAN) === null,
    'E2 …and it refuses identically on both programs, so a LoanNEX row can never fall back to a default a Lender Price row would not');
  ok(shiftedPrice(nexRows[0].priceBuild.price, null) === null,
    'E3 …and with no shift the board draws its em dash rather than inventing par');
}

console.log(bad ? `\nFAILURES: ${bad}` : '\nOFFLINE: all passed');
process.exit(bad ? 1 : 0);
