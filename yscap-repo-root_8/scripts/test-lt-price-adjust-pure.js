'use strict';
/**
 * LT — EVENING OUT A PRICE OUT OF OUR OWN COMPENSATION (§40).
 *
 * The rule is money, and the one way to get it wrong that costs us rather than
 * the borrower is to invert the sign. So the direction is asserted from the
 * OWNER'S OWN two examples, and the underlying arithmetic is checked against
 * `overlay` itself rather than restated here — a test that re-typed
 * `rawPrice - comp` would agree with a broken module that made the same mistake.
 */

const adj = require('../src/longterm/termsheet/price-adjust');
const overlay = require('../src/longterm/termsheet/overlay');

let bad = 0;
const ok = (cond, label) => {
  if (cond) console.log(`  ok   ${label}`);
  else { bad += 1; console.error(`  FAIL ${label}`); }
};
const section = (t) => console.log(`\n${t}`);

/* A plan where our lender-paid compensation is exactly the 2 points the owner
   talks about, so the examples below read as they do in their own message. */
const PLAN = { borrowerPaid: 2, ysp: 2, lenderPaid: 2, applicationFee: 500, commitmentFee: 1595 };

// ===========================================================================
section('A. the owner\'s own two examples, to the point');
// ===========================================================================
{
  // displayPrice = rawPrice - comp, so a display of 101.1 at 2 points comp is a
  // raw price of 103.1. Derived through the OVERLAY, never hand-typed.
  const raw = 103.1;
  const down = adj.applyAdjustment({ plan: PLAN, mode: 'lenderPaid', rawPrice: raw, deltaPoints: -0.1 });
  ok(down.ok, 'A1 a -0.1 adjustment is accepted');
  ok(down.priceBefore === 101.1 && down.priceAfter === 101,
    `A2 ⛔ "-0.1 brings it down from a 101.1 to a 101.0" — got ${down.priceBefore} → ${down.priceAfter}`);
  ok(down.compBefore === 2 && down.compAfter === 2.1,
    `A3 ⛔ …and "instead of 2 points, we're going to make 2.1" — got ${down.compBefore} → ${down.compAfter}`);
  ok(down.compDelta === 0.1, 'A4 …reported as a POSITIVE move in our favour, so no screen has to derive the direction');

  const raw2 = 103;
  const up = adj.applyAdjustment({ plan: PLAN, mode: 'lenderPaid', rawPrice: raw2, deltaPoints: 0.1 });
  ok(up.priceBefore === 101 && up.priceAfter === 101.1,
    `A5 ⛔ "+0.1 brings it up from 101.0 to 101.1" — got ${up.priceBefore} → ${up.priceAfter}`);
  ok(up.compBefore === 2 && up.compAfter === 1.9,
    `A6 ⛔ …and "instead of 2 points lender-paid, we'll only make 1.9" — got ${up.compBefore} → ${up.compAfter}`);
  ok(up.compDelta === -0.1, 'A7 …reported as a NEGATIVE move, because we gave it away');
}

// ===========================================================================
section('B. the price it reports is the price the OVERLAY would draw');
// ===========================================================================
{
  /* ⛔ THE ONE ASSERTION THAT CANNOT BE FOOLED BY A SHARED MISTAKE. The adjuster
     and the document must agree about what "the price" is; asking the overlay
     is the only way to prove it without re-typing its formula here. */
  let drift = 0;
  for (const mode of ['lenderPaid', 'borrowerPaid']) {
    for (const raw of [98, 100, 101.375, 103.1, 104.875]) {
      const a = adj.applyAdjustment({ plan: PLAN, mode, rawPrice: raw, deltaPoints: -0.05 });
      if (!a.ok) { drift += 1; continue; }
      // What the overlay itself shows for this quote, before any adjustment.
      const charges = overlay.quoteCharges(mode, PLAN, raw, 375000, false);
      if (!charges || Math.abs(charges.displayPrice - a.priceBefore) > 1e-9) drift += 1;
    }
  }
  ok(drift === 0, `B1 the adjuster's "price before" equals the overlay's own display price on every case (${drift} disagreed)`);
}

// ===========================================================================
section('C. it refuses rather than guessing');
// ===========================================================================
{
  const raw = adj.applyAdjustment({ plan: PLAN, mode: 'raw', rawPrice: 103, deltaPoints: -0.1 });
  ok(!raw.ok && raw.code === 'mode_not_adjustable',
    'C1 raw pricing has no compensation of ours to move, and says so');
  ok(!adj.applyAdjustment({ plan: PLAN, mode: 'lenderPaid', rawPrice: null, deltaPoints: -0.1 }).ok,
    'C2 no price → refused, never an invented one');
  ok(!adj.applyAdjustment({ plan: PLAN, mode: 'lenderPaid', rawPrice: 103, deltaPoints: 0 }).ok,
    'C3 a zero adjustment is refused rather than reported as a change');
  const big = adj.applyAdjustment({ plan: PLAN, mode: 'lenderPaid', rawPrice: 103, deltaPoints: 25 });
  ok(!big.ok && big.code === 'delta_too_large',
    'C4 ⛔ a typed 25 (meaning 0.25) is caught as a decimal slip, not applied');
  /* ⛔ THE ONE THAT PROTECTS THE COMPANY. Giving away more than we make is us
     writing a cheque to do the loan, and is far likelier to be a mistyped sign.

     ⛔ THE FIXTURE HAS TO BE A THIN PLAN, and finding that out is the point. With
     the 2-point plan above, `comp_negative` is UNREACHABLE — the 2-point cap
     fires first — so a test written against PLAN would have "passed" the guard
     while never once executing it. The guard only bites where compensation is
     SMALLER than the cap, which is the ordinary thin-margin option it exists to
     protect. Asserted here, and the ordering asserted below it. */
  const THIN = { ...PLAN, lenderPaid: 0.5, ysp: 0.5 };
  const neg = adj.applyAdjustment({ plan: THIN, mode: 'lenderPaid', rawPrice: 103, deltaPoints: 1 });
  ok(!neg.ok && neg.code === 'comp_negative',
    'C5 ⛔ giving away more than a thin option earns is refused — we never pay a borrower to take the loan');
  ok(/0\.500 points/.test(neg.message),
    'C6 …and the refusal names the most that CAN be given away, so it is not a dead end');
  const capped = adj.applyAdjustment({ plan: THIN, mode: 'lenderPaid', rawPrice: 103, deltaPoints: 3 });
  ok(!capped.ok && capped.code === 'delta_too_large',
    'C6b …while a decimal slip is still caught as a slip, not as a compensation problem — the cap is asked first');
  const exact = adj.applyAdjustment({ plan: THIN, mode: 'lenderPaid', rawPrice: 103, deltaPoints: 0.5 });
  ok(exact.ok && exact.compAfter === 0,
    'C7 giving away exactly all of it is allowed — zero compensation is a real choice, negative is not');
}

// ===========================================================================
section('D. the suggestions land on round numbers, and every one of them works');
// ===========================================================================
{
  // 103.1 raw at 2 points comp shows 101.1 — the owner's own figure.
  const s = adj.roundingSuggestions({ plan: PLAN, mode: 'lenderPaid', rawPrice: 103.1 });
  ok(s.length > 0, `D1 a price of 101.1 gets suggestions (${s.length})`);
  const targets = s.map((x) => x.target);
  ok(targets.includes(101), 'D2 …including DOWN to 101.00');
  ok(targets.includes(101.25), 'D3 …and UP to the next quarter, 101.25');
  ok(targets.includes(102), 'D4 …and up to the next whole point, 102.00');
  ok(s.every((x) => x.deltaPoints !== 0),
    'D5 ⛔ never a suggestion that moves nothing — that reads as a broken button, not as "already even"');
  /* ⛔ EVERY SUGGESTION IS A BUTTON THAT WILL WORK. They are produced by running
     each candidate through the SAME `applyAdjustment` the typed path uses, so a
     suggestion can never answer with the error the typed path would have given. */
  let unusable = 0;
  for (const x of s) {
    const a = adj.applyAdjustment({ plan: PLAN, mode: 'lenderPaid', rawPrice: 103.1, deltaPoints: x.deltaPoints });
    if (!a.ok || a.priceAfter !== x.target) unusable += 1;
  }
  ok(unusable === 0, `D6 ⛔ every suggestion applies cleanly and lands exactly on its stated number (${unusable} did not)`);

  // A price ALREADY on a quarter offers nothing in that grid — and still offers the whole point.
  const onGrid = adj.roundingSuggestions({ plan: PLAN, mode: 'lenderPaid', rawPrice: 103.25 });
  ok(!onGrid.some((x) => x.target === 101.25),
    'D7 a price already sitting on a quarter is not offered a move to where it already is');

  /* ⛔ THE FIXTURE THAT ISOLATES THE "would it actually apply?" FILTER, added after
     removing that filter changed NOTHING in the battery above — which means the
     battery was proving the code safe without ever exercising the guard.

     A THIN option is where it bites: at 0.5 points of compensation, rounding UP to
     the next whole point costs 0.9, which would take us below zero. With the filter
     the suggestion is simply not offered; without it, it is offered as a button that
     answers with an error when pressed. */
  const THIN2 = { ...PLAN, lenderPaid: 0.5, ysp: 0.5 };
  const thin = adj.roundingSuggestions({ plan: THIN2, mode: 'lenderPaid', rawPrice: 101.6 });
  ok(thin.length > 0, `D7b a thin option still gets the suggestions it CAN afford (${thin.length})`);
  ok(!thin.some((x) => x.target === 102),
    'D7c ⛔ …and is never offered the one it cannot — a suggestion is never a button that errors');
  ok(thin.every((x) => x.compAfter >= 0),
    'D7d ⛔ …so no suggestion on the board would take our compensation below zero');

  ok(adj.roundingSuggestions({ plan: PLAN, mode: 'raw', rawPrice: 103 }).length === 0,
    'D8 raw mode offers none, for the same reason it refuses one');
  ok(adj.roundingSuggestions({ plan: PLAN, mode: 'lenderPaid', rawPrice: null }).length === 0,
    'D9 …and a missing price offers none rather than throwing');
}

// ===========================================================================
section('E. the summary says which way the money went, in words');
// ===========================================================================
{
  const down = adj.applyAdjustment({ plan: PLAN, mode: 'lenderPaid', rawPrice: 103.1, deltaPoints: -0.1 });
  ok(/we make more/.test(down.summary), 'E1 taking more says "we make more"');
  const up = adj.applyAdjustment({ plan: PLAN, mode: 'lenderPaid', rawPrice: 103, deltaPoints: 0.1 });
  ok(/we give up/.test(up.summary), 'E2 giving it away says "we give up"');
  ok(/101\.100 → 101\.000/.test(down.summary) && /2\.000 → 2\.100/.test(down.summary),
    'E3 …and both numbers are in it, so the officer never has to hold one in their head');
}

console.log('');
if (bad) { console.error(`${bad} FAILED`); process.exit(1); }
console.log('ALL PASSED');
