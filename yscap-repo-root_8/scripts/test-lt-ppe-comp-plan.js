#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the loan-officer compensation stack (D18 / E9), pure.
 *
 * WHAT IS BEING PROVED, and it is not arithmetic for its own sake. Every assertion below is a way a
 * loan officer's own pay figure, or the company's, could come out wrong and look fine:
 *
 *   A. THE OWNER'S OWN WORKED EXAMPLES land on the numbers they gave (2.000 default, $3,000 minimum on
 *      a $100,000 loan is 3 points, $50,000 maximum on a $5,000,000 loan is 1 point).
 *   B. THE HOLDBACK IS THE COMPANY'S, WHOLE — never split, never clamped, never counted toward the
 *      officer's floor or ceiling. Three separate ways it could leak into his side, each proven by
 *      moving the holdback and asserting his figures do not move at all.
 *   C. THE COMPANY MINIMUM IS A DEFAULT AND NOT A FLOOR (the owner's 2026-08-18 answer): an officer's
 *      own minimum that is LOWER is honoured, with no refusal and no silent bump back up.
 *   D. WHAT NOBODY HAS DECIDED IS REFUSED, NOT INVENTED: on a mixed front/back plan a clamp reports an
 *      exact total and NO front/back split, because where the money moved is an open question.
 *   E. IT NEVER MOVES A PRICE, and says so on every answer.
 *
 *   node scripts/test-lt-ppe-comp-plan.js
 *
 * LT-only. No DB, no network.
 */
const comp = require('../src/longterm/ppe/comp-plan');

let n = 0; let bad = 0;
function ok(cond, label) { n += 1; if (!cond) { bad += 1; console.log(` FAIL ${label}`); } }
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const HUNDRED_K = 100000 * 100;      // $100,000 in cents
const FIVE_M = 5000000 * 100;        // $5,000,000 in cents

// The company's own default plan, as the settings will pre-fill it.
const BASE = {
  companyHoldbackMilli: 250,        // the 0.25 that is never his
  officerMarginMilli: 2000,         // the 2.00 default
  splitPct: 60,                     // he keeps 60% of the origination
  splitBasis: 'front_only',
  mode: 'borrower_paid',
  minCents: null,
  maxCents: null,
};

// ---------------------------------------------------------------------------
// A. the default file
// ---------------------------------------------------------------------------
{
  const r = comp.computeComp(BASE, { loanAmountCents: HUNDRED_K });
  ok(r.ok, 'A1 the ordinary file computes');
  eq(r.officer.marginMilli, 2000, 'A2 the officer is on his 2.000 default');
  eq(r.officer.frontMilli, 2000, 'A3 …taken as origination, because the borrower is paying');
  eq(r.officer.backMilli, 0, 'A4 …and nothing in the back');
  eq(r.officer.grossCents, 2000 * 100, 'A5 2.000 points of $100,000 is $2,000');
  eq(r.officer.netCents, 1200 * 100, 'A6 …of which he keeps 60% = $1,200');
  eq(r.company.shareOfCompCents, 800 * 100, 'A7 …and the company takes $800 of the origination');
  eq(r.holdback.cents, 250 * 100, 'A8 the company also keeps its 0.25 = $250');
  eq(r.company.totalCents, (800 + 250) * 100, 'A9 …so the company makes $1,050 in total');
}

// ---------------------------------------------------------------------------
// B. the holdback is the company's, whole — three ways it could leak
// ---------------------------------------------------------------------------
{
  const small = comp.computeComp(BASE, { loanAmountCents: HUNDRED_K });
  const huge = comp.computeComp({ ...BASE, companyHoldbackMilli: 5000 }, { loanAmountCents: HUNDRED_K });

  eq(huge.officer.grossCents, small.officer.grossCents, 'B1 a bigger holdback does not change what the officer earns');
  eq(huge.officer.netCents, small.officer.netCents, 'B2 …and does not change what he nets');
  eq(huge.holdback.split, false, 'B3 THE ONE THAT MATTERS: the holdback is not split');
  eq(huge.company.shareOfCompCents, small.company.shareOfCompCents,
    'B4 …so the company\'s share of the SPLIT is unchanged — the holdback rides on its own line');
  eq(huge.company.totalCents, huge.holdback.cents + huge.company.shareOfCompCents,
    'B5 …and the company total is exactly the holdback plus its share, nothing else');

  // …and it is not counted toward his minimum. With a $2,100 minimum, an officer on 2.000 points of a
  // $100,000 loan earns $2,000 — so the minimum BINDS. It would NOT bind if the company's $250 were
  // wrongly counted as his.
  const withMin = comp.computeComp({ ...BASE, minCents: 2100 * 100 }, { loanAmountCents: HUNDRED_K });
  eq(withMin.clamp.applied, 'minimum', 'B6 THE ONE THAT MATTERS: the holdback is not counted toward his minimum');
  eq(withMin.officer.grossCents, 2100 * 100, 'B7 …so he is brought up to $2,100 of his own');
  eq(withMin.holdback.cents, 250 * 100, 'B8 …and the company\'s 0.25 is untouched by the clamp');
  eq(withMin.clamp.touchesHoldback, false, 'B9 …which the answer states rather than leaving to be inferred');
}

// ---------------------------------------------------------------------------
// C. the owner's two worked clamps
// ---------------------------------------------------------------------------
{
  const min = comp.computeComp({ ...BASE, minCents: 3000 * 100 }, { loanAmountCents: HUNDRED_K });
  eq(min.clamp.applied, 'minimum', 'C1 a $3,000 minimum binds on a $100,000 loan');
  eq(min.officer.marginMilli, 3000, 'C2 …and 3.000 points is what he is bumped to, not the standard 2');
  eq(min.officer.frontMilli, 3000, 'C3 …all of it in the origination, because that is his only side');

  const max = comp.computeComp({ ...BASE, maxCents: 50000 * 100 }, { loanAmountCents: FIVE_M });
  eq(max.clamp.applied, 'maximum', 'C4 a $50,000 maximum binds on a $5,000,000 loan');
  eq(max.officer.marginMilli, 1000, 'C5 …capping him at 1.000 point');
  eq(max.officer.grossCents, 50000 * 100, 'C6 …which is exactly the $50,000');

  const neither = comp.computeComp({ ...BASE, minCents: 500 * 100, maxCents: 50000 * 100 }, { loanAmountCents: HUNDRED_K });
  eq(neither.clamp.applied, null, 'C7 a min and a max that do not bind change nothing');
  eq(neither.officer.marginMilli, 2000, 'C8 …and he stays on his own number');
}

// ---------------------------------------------------------------------------
// D. the company minimum is a movable DEFAULT, not a floor (owner, 2026-08-18)
// ---------------------------------------------------------------------------
{
  // The company's default minimum is $3,000; this officer has set his own at $500. The resolver hands
  // the OFFICER's number down, and this engine simply uses it. If anything here treated the company's
  // as a floor, his $500 would be silently raised — the hard rule the owner said this is not.
  const officersOwn = comp.computeComp({ ...BASE, minCents: 500 * 100 }, { loanAmountCents: HUNDRED_K });
  ok(officersOwn.ok, 'D1 an officer minimum BELOW the company default is accepted, not refused');
  eq(officersOwn.clamp.applied, null, 'D2 …and it does not bind, so he stays on 2.000');
  eq(officersOwn.officer.marginMilli, 2000, 'D3 …with nothing silently bumped back up to the company number');
  ok(!JSON.stringify(officersOwn).includes('floor'), 'D4 …and no answer anywhere calls it a floor');
}

// ---------------------------------------------------------------------------
// E. the lender-paid side, and the split basis
// ---------------------------------------------------------------------------
{
  const lender = comp.computeComp({ ...BASE, mode: 'lender_paid' }, { loanAmountCents: HUNDRED_K });
  eq(lender.officer.backMilli, 2000, 'E1 on a lender-paid file his margin is earned in the back');
  eq(lender.officer.frontMilli, 0, 'E2 …with no origination charged to the borrower');
  eq(lender.officer.netCents, 2000 * 100,
    'E3 THE RECORDED READING: the split is on the origination, so he keeps every cent of the back');
  eq(lender.company.shareOfCompCents, 0, 'E4 …and the company takes no share of it');
  eq(lender.company.totalCents, 250 * 100, 'E5 …so the company has its 0.25 and nothing else');

  // The other reading, which is why this is a stated policy and not a constant: were the owner to say
  // the split covers the back too, ONE value moves and the arithmetic follows.
  const both = comp.computeComp({ ...BASE, mode: 'lender_paid', splitBasis: 'front_and_back' }, { loanAmountCents: HUNDRED_K });
  eq(both.officer.netCents, 1200 * 100, 'E6 under the other policy he nets 60% of the back instead');
  eq(both.company.shareOfCompCents, 800 * 100, 'E7 …and the company takes the rest');
}

// ---------------------------------------------------------------------------
// F. a mixed plan, and the clamp nobody has ruled on
// ---------------------------------------------------------------------------
{
  const mixed = { ...BASE, officerMarginMilli: 2250, officerFrontMilli: 2000, officerBackMilli: 250 };
  const plain = comp.computeComp(mixed, { loanAmountCents: HUNDRED_K });
  ok(plain.ok, 'F1 the owner\'s mixed example (2 points origination, 0.25 in the back) computes');
  eq(plain.officer.grossCents, 2250 * 100, 'F2 …and he earns $2,250 of his own');
  eq(plain.officer.netCents, (1200 + 250) * 100,
    'F3 …keeping 60% of the origination and all of the back');

  const clamped = comp.computeComp({ ...mixed, minCents: 3000 * 100 }, { loanAmountCents: HUNDRED_K });
  ok(clamped.ok, 'F4 a clamp on a mixed plan still answers');
  eq(clamped.officer.marginMilli, 3000, 'F5 …with the TOTAL exact');
  eq(clamped.officer.frontMilli, null,
    'F6 THE ONE THAT MATTERS: where the extra came from is nobody\'s decision yet, so it is not invented');
  eq(clamped.officer.backMilli, null, 'F7 …on either side');
  ok(clamped.unsettled.some((u) => u.code === 'clamp_allocation'), 'F8 …and the answer names what is unsettled');
  eq(clamped.officer.netCents, null, 'F9 …so his net is withheld rather than computed off a guess');
  eq(clamped.company.totalCents, null, 'F10 …and so is the company\'s');
}

// ---------------------------------------------------------------------------
// G. what it refuses
// ---------------------------------------------------------------------------
{
  const noLoan = comp.computeComp(BASE, {});
  ok(!noLoan.ok && noLoan.refusals.some((r) => r.code === 'no_loan_amount'), 'G1 no loan amount is refused');

  const noMode = comp.computeComp({ ...BASE, mode: null }, { loanAmountCents: HUNDRED_K });
  ok(!noMode.ok && noMode.refusals.some((r) => r.code === 'no_mode'), 'G2 an unstated comp mode is refused');

  const officerHoldback = comp.computeComp({ ...BASE, holdbackSource: 'officer' }, { loanAmountCents: HUNDRED_K });
  ok(!officerHoldback.ok && officerHoldback.refusals.some((r) => r.code === 'holdback_not_the_officers'),
    'G3 THE ONE THAT MATTERS: a holdback an officer set is refused, never quietly replaced');

  const mismatch = comp.computeComp({ ...BASE, officerFrontMilli: 1000, officerBackMilli: 250 }, { loanAmountCents: HUNDRED_K });
  ok(!mismatch.ok && mismatch.refusals.some((r) => r.code === 'front_back_mismatch'),
    'G4 front and back that do not add up to his margin are refused, not repaired');

  for (const badSplit of [null, -1, 101, 1.5, '60']) {
    const r = comp.computeComp({ ...BASE, splitPct: badSplit }, { loanAmountCents: HUNDRED_K });
    ok(!r.ok && r.refusals.some((x) => x.code === 'no_split'), `G5 an unusable split (${JSON.stringify(badSplit)}) is refused`);
  }

  const badBasis = comp.computeComp({ ...BASE, splitBasis: 'everything' }, { loanAmountCents: HUNDRED_K });
  ok(!badBasis.ok && badBasis.refusals.some((r) => r.code === 'no_split_basis'), 'G6 an unrecognised split basis is refused');

  const noHoldback = comp.computeComp({ ...BASE, companyHoldbackMilli: null }, { loanAmountCents: HUNDRED_K });
  ok(!noHoldback.ok && noHoldback.refusals.some((r) => r.code === 'no_holdback'),
    'G7 an unreadable holdback is refused rather than read as zero');
}

// ---------------------------------------------------------------------------
// H. it never moves a price, and it never throws
// ---------------------------------------------------------------------------
{
  const r = comp.computeComp(BASE, { loanAmountCents: HUNDRED_K });
  eq(r.priceEffect.applied, false, 'H1 nothing here changes a price');
  ok(/not settled/.test(r.priceEffect.reason), 'H2 …and the answer says why, on every file');

  for (const junk of [undefined, null, 0, 'plan', [], { officerMarginMilli: NaN }, { splitPct: Infinity }]) {
    let threw = false;
    try { comp.computeComp(junk, { loanAmountCents: junk === 0 ? 0 : HUNDRED_K }); } catch (_) { threw = true; }
    ok(!threw, `H3 junk in (${JSON.stringify(junk)}) is refused, never thrown`);
  }
}

console.log(bad ? `\n${bad} FAILED of ${n}` : `ok - lt ppe comp plan (${n} assertions)`);
process.exit(bad ? 1 : 0);
