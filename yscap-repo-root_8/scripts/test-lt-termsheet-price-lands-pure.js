'use strict';
/**
 * A TERM SHEET IS NEVER ISSUED FROM A PRICE THE RATE SHEET'S OWN BREAKDOWN REFUSES.
 *
 * ── THE GAP THIS CLOSES ────────────────────────────────────────────────────
 *
 * A LoanNEX board row's PRICE comes from the search call; its ITEMISATION comes from a
 * separate, on-demand call. Nothing in the system compared the two. So a row could show a
 * price the rate sheet's own breakdown does not support — measured at 0.875 points on a
 * real board, in silence — and `snapshot.buildMember` would put it on a document a
 * borrower signs, because its only validation of the price was `num(s.rawPrice)`: "is it
 * a number".
 *
 * The asymmetry is what made this indefensible rather than merely missing. The same
 * function ALREADY refuses with `payment_disagreement` when the board's monthly payment
 * and its own differ by more than a dollar. The team knew this class of guard and built
 * it for the cheaper number: the price sets the origination, the closing sheet and the
 * cash to close.
 *
 * And it is not neutral. `pricing/merge.js` elects the HIGHER price per investor and the
 * board sorts highest first, so an overstated row is exactly the one an officer picks.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 * When the breakdown HAS been fetched, base + adjustments must come to the points behind
 * the price being issued. When it has NOT been fetched, nothing is claimed and nothing is
 * refused — most rows are issued without anybody opening the build, and refusing those
 * would stop the desk working over a check nobody asked for. Silence stays silence; a
 * contradiction stops.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const snapshot = require(path.join(__dirname, '..', 'src/longterm/termsheet/snapshot.js'));

let n = 0;
let failures = 0;
const ok = (c, w) => { n += 1; if (c) console.log('  ok  ', w); else { failures += 1; console.log(' FAIL ', w); } };

const PLAN = { borrowerPaid: 2, ysp: 2, lenderPaid: 2, applicationFee: 500, commitmentFee: 1595 };
const SCENARIO = {
  purpose: 'Purchase', propertyType: 'Single family', value: 425000, loan: 276250,
  ltv: 65, termYears: 30, dscr: 1.14, fico: 801, state: 'NJ', city: 'Newton', zip: '07860',
  rentMonthly: 2800, taxMonthly: 660, insuranceMonthly: 65, hoaMonthly: 0,
  prepayMonths: 60, prepayStructure: '5 Year',
};

/** The owner's own quote of 2026-09-04, as the board sends it to the export door. */
function selection(extra = {}) {
  return {
    consumerLabel: 'Ruby', product: '30 Yr. Fixed', label: null,
    mode: 'borrowerPaid', waiveLenderFees: false,
    ratePct: 6.375,
    rawPrice: 101.965,
    vendorMonthlyPI: null,
    internal: { investor: 'RubyNQM Funding', investorKey: 'ruby', lender: 'RubyNQM Funding',
      program: 'CORR: Investor - DSCR', product: '30 Yr. Fixed', rateSheet: null,
      rateGridId: null, rawPrice: 101.965, adjustedPoints: -1.965 },
    pricedAt: '2026-09-04T13:43:00.000Z',
    pricedDscr: null,
    scenario: SCENARIO,
    ...extra,
  };
}

console.log('A. a build that LANDS on the price is issued exactly as before');
{
  /* 100.340 base, adjustments summing to -1.625 points, landing on -1.965 => 101.965. */
  const r = snapshot.buildMember(selection({
    priceLanding: { basePoints: -0.34, adjustmentPoints: -1.625, adjustedPoints: -1.965 },
  }), PLAN);
  ok(r && r.ok === true, `A1 a self-consistent build issues (${r && r.ok ? 'issued' : (r && r.error) || 'refused'})`);
}

console.log('\nB. a build that does NOT land is refused, and the refusal names the gap');
{
  /* The incident shape: the itemisation supports 101.090, the board says 101.965. */
  const r = snapshot.buildMember(selection({
    priceLanding: { basePoints: -0.34, adjustmentPoints: -0.75, adjustedPoints: -1.965 },
  }), PLAN);
  ok(r && r.ok !== true, 'B1 a build that does not support the price REFUSES to issue');
  ok(r && r.error === 'price_disagreement', `B2 …under its own name (${r && r.error})`);
  const m = String((r && r.message) || '');
  ok(/101\.090/.test(m) && /101\.965/.test(m),
    `B3 …stating BOTH numbers, so nobody has to take the arithmetic on trust (${m.slice(0, 120)}…)`);
  ok(/0\.875/.test(m), 'B4 …and the size of the gap');
  ok(/[Rr]e-price/.test(m), 'B5 …and what to do about it — a refusal with no way forward is a dead end');
}

console.log('\nC. ABSENT IS NOT A FAILURE — a row nobody opened the build on still issues');
{
  const none = snapshot.buildMember(selection(), PLAN);
  ok(none && none.ok === true, 'C1 no build sent at all: issued, exactly as before this guard existed');

  const nulled = snapshot.buildMember(selection({ priceLanding: null }), PLAN);
  ok(nulled && nulled.ok === true, 'C2 an explicit null: the same');

  /* A HALF-KNOWN BUILD CLAIMS NOTHING. Treating a missing half as zero would refuse
     honest rows and, far worse, could let a real gap read as clean. */
  for (const [what, land] of [
    ['no base', { basePoints: null, adjustmentPoints: -0.75, adjustedPoints: -1.965 }],
    ['no adjustments', { basePoints: -0.34, adjustmentPoints: null, adjustedPoints: -1.965 }],
    ['no final points', { basePoints: -0.34, adjustmentPoints: -0.75, adjustedPoints: null }],
  ]) {
    const r = snapshot.buildMember(selection({ priceLanding: land }), PLAN);
    ok(r && r.ok === true, `C3 ${what}: unknown is not a refusal`);
  }
  const junk = snapshot.buildMember(selection({ priceLanding: 'yes' }), PLAN);
  ok(junk && junk.ok === true, 'C4 …and a value that is not a build at all claims nothing either');
}

console.log('\nD. the tolerance is a rounding allowance, not a licence');
{
  const hair = snapshot.buildMember(selection({
    priceLanding: { basePoints: -0.34, adjustmentPoints: -1.6249, adjustedPoints: -1.965 },
  }), PLAN);
  ok(hair && hair.ok === true, 'D1 floating-point noise inside a thousandth still issues');

  const tenth = snapshot.buildMember(selection({
    priceLanding: { basePoints: -0.34, adjustmentPoints: -1.525, adjustedPoints: -1.965 },
  }), PLAN);
  ok(tenth && tenth.ok !== true, 'D2 …but a tenth of a point is real money on a signed document');
}

console.log('\nE. the browser actually SENDS it — a server rule nothing feeds is not a rule');
{
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'app-v2/src/longterm/LtPricer.jsx'), 'utf8');
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /* ⛔ THE EXPRESSION IS EXTRACTED AND RUN, NOT READ.
     The first cut of this section asserted `/priceLanding:/` and the field names —
     and a mutation that NEUTERED the send (`(false && o && o.priceBuild …)`) passed
     every one of them, because the key and the names were all still there. A source
     check cannot tell a live expression from a disabled one, and a server rule
     nothing feeds is not a rule. So the board's own ternary is lifted out of the
     shipped file and EXECUTED. */
  const m = CODE.match(/priceLanding: (\([\s\S]*?)\n\s*pricedAt:/);
  ok(!!m, 'E1 the board\'s own priceLanding expression was found — if this fails the guard tests nothing');
  const expr = m ? m[1].replace(/,\s*$/, '') : 'null';
  const send = new Function('o', `return ${expr};`);

  const fetched = send({ priceBuild: { basePoints: -0.34, adjustmentPoints: -1.625, adjustedPoints: -1.965 } });
  ok(fetched && fetched.basePoints === -0.34 && fetched.adjustmentPoints === -1.625 && fetched.adjustedPoints === -1.965,
    `E2 a row whose breakdown was fetched really sends all three figures (${JSON.stringify(fetched)})`);

  /* …AND ONLY THEN. An unopened row must send nothing, or every ordinary issue would
     start being judged against a build nobody has. */
  ok(send({ priceBuild: { basePoints: -0.34, adjustmentPoints: null, adjustedPoints: -1.965 } }) == null,
    'E3 a half-fetched build sends nothing at all');
  ok(send({}) == null && send(null) == null,
    'E4 …and so does a row with no build, and no row');
}

console.log('\nF. the guard it was modelled on is untouched');
{
  const r = snapshot.buildMember(selection({ vendorMonthlyPI: 99999 }), PLAN);
  ok(r && r.error === 'payment_disagreement',
    `F1 the monthly-payment cross-check still refuses exactly as it did (${r && r.error})`);
}

console.log(`\n${failures === 0 ? `OFFLINE: all ${n} passed` : `FAILURES: ${failures} of ${n}`}`);
assert.strictEqual(failures, 0, `${failures} failed`);
