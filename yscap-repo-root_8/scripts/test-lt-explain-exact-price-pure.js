/**
 * THE PRICE WE HAND BACK IS THE SHEET'S OWN, TO THE LAST DECIMAL.
 *
 * ── WHAT WENT WRONG, MEASURED LIVE ON 2026-09-03 ───────────────────────────
 * The owner reported rows on NQM, Acra and E-Resi that showed no itemised LLPAs, no base price
 * and no final price — the Details panel saying "the rate sheet accepted the question and returned
 * no breakdown for this quote". That sentence blamed the vendor. It was ours.
 *
 * LoanNEX finds the quote to itemise by matching the price we send back against its own sheet
 * EXACTLY. Our parser rounds every price to three decimals for display. On one live board (Hartford
 * County CT, 500k/375k, 760 FICO, DSCR 1.30) **269 of 4,396 rungs carry a fourth decimal** —
 * 104.1762, 100.7605, 103.8855, 96.6756. Sent back rounded, the sheet found nothing and answered
 * `{"status":"Success"}` with no body at all.
 *
 * Proven both ways on one quote with everything else held identical:
 *
 *     productId 38068, investorId 7233, hash 38068-1382-33114-5316, rate 6.875, 30-day lock
 *       price 104.1762  →  a full breakdown
 *       price 104.176   →  {"status":"Success"}, no body
 *
 * And across the board, one quote per investor that needed a fourth decimal: 8 of 8 answered with
 * the exact price, 0 of 8 answered with the rounded one. The four investors that carried
 * fourth-decimal prices were Acra, E-Resi, NQM and Ellington — three of them exactly the ones the
 * owner reported.
 *
 * ⛔ WHY ROUNDING BACK UP DOES NOT RESCUE IT. The explain door already added our 0.25 holdback back
 * on before asking, precisely so the vendor is asked about its own number. But that arithmetic runs
 * on a figure that has ALREADY lost its fourth decimal: 104.1762 → 104.176 → 103.926 → 104.176. The
 * holdback was never the problem; the rounding was, and it happens two steps earlier.
 *
 * ── THE FIX THIS PINS ──────────────────────────────────────────────────────
 * Every LoanNEX rung now carries `priceExact` — the vendor's own number, untouched — beside the
 * rounded `price` a screen shows. It survives the holdback unshifted (our margin is not on their
 * sheet), rides out on the explain handle, and `evidence()` sends it. Nothing else reads it.
 *
 * PURE: no network, no database. `global.fetch` is replaced so the OUTGOING BODY can be read —
 * which is the only place this defect was ever visible.
 *
 * Sections: A the parser, B the holdback, C the handle, D the wire, E what must not move.
 */
'use strict';
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const parse = require(path.join(ROOT, 'src/longterm/loannex/parse'));
const vendorMargin = require(path.join(ROOT, 'src/longterm/pricing/vendor-margin'));
const quoteShape = require(path.join(ROOT, 'src/longterm/pricing/quote-shape'));
const nex = require(path.join(ROOT, 'src/longterm/loannex/client'));

let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log('  ok  ' + name); };
const eq = (a, b, name) => { assert.strictEqual(a, b, `${name} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); pass++; console.log('  ok  ' + name); };

/**
 * A vendor board in the shape `/quick-prices` really answers, carrying the exact prices measured
 * live. 104.1762 is NQM's own number for productId 38068 at 6.875% on a 30-day lock; 102.5 is a
 * price that survives rounding, so the two paths are exercised side by side.
 */
const RAW = {
  status: 'Success',
  data: {
    investors: [{ id: 7233, name: 'NQM Funding', organizationGuid: 'g-nqm' }],
    programs: [{ id: 1382, name: 'CORR: Investor - DSCR', programCode: 'C9001', hasQuestions: true, questionsAnswered: false }],
    products: [{ id: 38068, mortgageProductId: 900 }],
    mortgageProducts: [{ id: 900, description: '30 Yr. Fixed', amortizationType: 'Fixed', termInMonths: 360, isInterestOnly: false }],
    prices: [
      { rate: 6.875, investorId: 7233, programId: 1382, productId: 38068, dscr: 1.3, payment: 2464.5,
        priceHashKey: '38068-1382-33114-5316', isException: false,
        lockTermPrices: [{ lockDays: 30, price: 104.1762, cushionedLockDays: 30 }] },
      { rate: 7, investorId: 7233, programId: 1382, productId: 38068, dscr: 1.3, payment: 2494.88,
        priceHashKey: '38068-1382-33114-5316', isException: false,
        lockTermPrices: [{ lockDays: 30, price: 102.5, cushionedLockDays: 30 }] },
    ],
  },
};

console.log('\nA · the parser keeps the sheet\'s own number');
const board = parse.parse(RAW);
const prog = (board.programs || [])[0];
ok(prog, 'A1 the board parses to one programme');
const fourth = (prog.rungs || []).find((r) => r.rate === 6.875);
const third = (prog.rungs || []).find((r) => r.rate === 7);
eq(fourth.price, 104.176, 'A2 the displayed price is still rounded to three decimals');
eq(fourth.priceExact, 104.1762, 'A3 the vendor\'s own fourth decimal is kept beside it');
eq(third.priceExact, 102.5, 'A4 a price that needs no fourth decimal is carried unchanged');
ok(fourth.priceExact !== fourth.price, 'A5 the two are genuinely different numbers on this rung');

console.log('\nB · the holdback moves our price and leaves the sheet\'s alone');
const held = vendorMargin.applyToBoard(board, 'loannex', {});
const hRung = ((held.programs || [])[0].rungs || []).find((r) => r.rate === 6.875);
eq(hRung.price, 103.926, 'B1 the board price has the 0.25 taken out of it');
eq(hRung.priceExact, 104.1762, 'B2 the sheet\'s own price is NOT held back');
eq(hRung.marginHoldback, 0.25, 'B3 what was taken is stamped on the rung');
ok(Math.round((hRung.price + 0.25) * 1000) / 1000 !== hRung.priceExact,
  'B4 adding the holdback back onto the rounded price does NOT reproduce the sheet\'s number — the defect in one line');

console.log('\nC · the handle carries it out to the browser');
const rows = quoteShape.programsFromLoanNex(held, { transactionId: 'txn-1' });
const opt = (rows[0].options || []).find((o) => o.explain && o.explain.rate === 6.875);
ok(opt && opt.explain, 'C1 the option row has an explain handle');
eq(opt.explain.price, 103.926, 'C2 the handle still states the price the screen shows');
eq(opt.explain.priceExact, 104.1762, 'C3 and the sheet\'s own price beside it');
eq(opt.explain.priceHashKey, '38068-1382-33114-5316', 'C4 the hash is unchanged');
eq(opt.explain.productId, 38068, 'C5 the product id is unchanged');
eq(opt.explain.lenderId, 7233, 'C6 the investor id is unchanged');
const lpHandle = quoteShape.programsFromLoanNex({ programs: [] }, {});
eq(lpHandle.length, 0, 'C7 an empty board yields no rows');

console.log('\nD · what actually goes on the wire');
/**
 * ⛔ THIS SECTION READS THE OUTGOING BODY, NOT A RETURN VALUE. The defect was invisible from the
 * outside: `evidence()` returned a well-formed "the sheet had nothing" answer, and every layer
 * above it behaved correctly on that answer. The only place the mistake existed was the number in
 * the request. A test that does not open the request cannot see it.
 */
const JWT = 'x.' + Buffer.from(JSON.stringify({
  exp: Math.floor(Date.now() / 1000) + 3600,
  'LoanNEX.ClaimData': JSON.stringify({ UserGuid: 'u-1', UserCredentials: { OrganizationId: 7 }, OriginAttributes: { PortalId: 3 } }),
})).toString('base64') + '.y';

const sent = [];
const realFetch = global.fetch;
const realTicket = process.env.NEX_TOKEN_KEY;
process.env.NEX_TOKEN_KEY = 'ticket-for-the-stub';
global.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? JSON.parse(init.body) : null;
  const answer = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (/\/tokens\//.test(u)) return answer({ data: { authenticationToken: JWT } });
  if (/\/loans\/apps\/.*\/settings/.test(u)) return answer({ data: {} });
  if (/\/lookups\/counties/.test(u)) return answer({ data: { counties: [{ key: 7003, name: 'Hartford County' }] } });
  if (/\/loans\/evidences\//.test(u)) { sent.push(body); return answer({ status: 'Success' }); }
  return answer({});
};

const SC = { purpose: 'Purchase', value: 500000, loan: 375000, zip: '06001', state: 'CT',
  county: 'Hartford', fico: 760, dscr: 1.3, propertyType: 'SingleFamily', prepayMonths: 60 };

(async () => {
  await nex.evidence(SC, opt.explain, { transactionId: 'txn-1' });
  const asked = sent[sent.length - 1];
  ok(asked && asked.data && asked.data.selectedPriceData, 'D1 a breakdown request was actually sent');
  eq(asked.data.selectedPriceData.price, 104.1762, 'D2 the price on the wire is the SHEET\'S, to the fourth decimal');
  ok(asked.data.selectedPriceData.price !== 103.926, 'D3 it is not our held-back board price');
  ok(asked.data.selectedPriceData.price !== 104.176, 'D4 and it is not the rounded one that came back empty');
  eq(asked.data.selectedPriceData.priceHashKey, '38068-1382-33114-5316', 'D5 the hash rides beside it');
  eq(asked.data.productId, 38068, 'D6 the product id rides beside it');
  eq(asked.data.investorId, 7233, 'D7 the investor id rides beside it');

  // A row shaped before `priceExact` existed still asks the question it asked yesterday.
  const older = { ...opt.explain };
  delete older.priceExact;
  await nex.evidence(SC, older, { transactionId: 'txn-1' });
  eq(sent[sent.length - 1].data.selectedPriceData.price, 103.926,
    'D8 with no exact price the rounded one is still sent — an older row is not broken by this');

  // And a quote that cannot identify itself is still refused before the call, as before.
  const before = sent.length;
  const r = await nex.evidence(SC, { ...opt.explain, priceHashKey: null }, {});
  eq(sent.length, before, 'D9 an unidentifiable quote still spends no vendor call');
  eq(r.absence.reason, 'quote_incomplete', 'D10 and still says so by name');

  global.fetch = realFetch;
  if (realTicket === undefined) delete process.env.NEX_TOKEN_KEY; else process.env.NEX_TOKEN_KEY = realTicket;

  console.log('\nE · what must not move');
  /**
   * The rounded price is what a person reads and what somebody quotes. If it ever became the exact
   * one, every screen would start showing four decimals and the holdback arithmetic would drift
   * against the points the parser derived. `priceExact` is for the vendor and for nobody else.
   */
  eq(hRung.points, -3.926, 'E1 points are still the shift of the derived points, not recomputed');
  eq(Math.round((hRung.price + Number(hRung.points)) * 1000) / 1000, 100,
    'E2 price and points on the board still sum to 100');
  eq(opt.priceBuild.price, 103.926, 'E3 the price build a screen draws is the rounded, held-back one');
  ok(!('priceExact' in opt.priceBuild), 'E4 the exact price is not in the price build — nothing on a screen reads it');

  console.log('\n' + pass + ' checks passed\n');
})().catch((e) => {
  global.fetch = realFetch;
  console.error('\nFAILED: ' + (e && e.message) + '\n');
  process.exit(1);
});
