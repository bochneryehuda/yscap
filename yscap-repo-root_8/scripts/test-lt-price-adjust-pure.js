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
const snapshot = require('../src/longterm/termsheet/snapshot');
const internalRecord = require('../src/longterm/termsheet/internal');
const fs = require('fs');
const path = require('path');

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

// ===========================================================================
section('F. the adjustment reaches the money as a MOVED PLAN, not a second number');
// ===========================================================================
{
  /* ⛔ WHY THIS SHAPE. Every figure on a long-term sheet — the displayed price, the
     origination line, the closing sheet, the cash to close — is derived from the
     plan by `overlay`, through one function. So the adjustment is expressed as a
     moved plan and picked up by all of them for free. An adjustment carried as its
     own figure would have to be added in by hand at each of those places, and the
     one that was missed would be the one that quietly under-charged. */
  const e = adj.effectivePlan({ plan: PLAN, mode: 'lenderPaid', deltaPoints: 0.25 });
  ok(e.ok && e.adjusted === true, 'F1 an adjustment answers with a plan');
  ok(e.plan.lenderPaid === 1.75, 'F2 giving 0.25 away leaves 1.75 of our lender-paid compensation');
  ok(e.plan.ysp === PLAN.ysp && e.plan.borrowerPaid === PLAN.borrowerPaid
    && e.plan.applicationFee === PLAN.applicationFee && e.plan.commitmentFee === PLAN.commitmentFee,
    'F3 …and NOTHING else on the plan moves');

  const b = adj.effectivePlan({ plan: PLAN, mode: 'borrowerPaid', deltaPoints: -0.1 });
  ok(b.plan.ysp === 2.1 && b.plan.lenderPaid === PLAN.lenderPaid,
    'F4 on borrower-paid it is the YSP that moves — the same key `compShiftPoints` reads');

  /* ⛔ THE KEY IT MOVES IS THE KEY THE OVERLAY READS. Asserted against `overlay`
     itself, not restated: a moved plan that the overlay does not read would be an
     adjustment that changes no price, silently. */
  ok(overlay.compShiftPoints('lenderPaid', e.plan) === 1.75
    && overlay.compShiftPoints('borrowerPaid', b.plan) === 2.1,
    'F5 ⛔ and the overlay reads the moved value — so every figure downstream moves with it');

  ok(adj.effectivePlan({ plan: PLAN, mode: 'lenderPaid', deltaPoints: 0 }).plan === PLAN,
    'F6 ⛔ no adjustment returns the plan by IDENTITY — an unadjusted option prices exactly as it always did');
  ok(adj.effectivePlan({ plan: PLAN, mode: 'lenderPaid', deltaPoints: null }).plan === PLAN
    && adj.effectivePlan({ plan: PLAN, mode: 'lenderPaid', deltaPoints: '' }).plan === PLAN,
    'F7 …and so do an absent one and an empty box');

  // Every refusal `applyAdjustment` makes is `effectivePlan`'s refusal too — they
  // are the same guards, not a second set that could be looser.
  ok(adj.effectivePlan({ plan: PLAN, mode: 'lenderPaid', deltaPoints: 5 }).code === 'delta_too_large',
    'F8 the 2-point cap still bites');
  ok(adj.effectivePlan({ plan: { ...PLAN, lenderPaid: 0.5 }, mode: 'lenderPaid', deltaPoints: 0.75 }).code === 'comp_negative',
    'F9 ⛔ …and so does the guard that stops us writing the borrower a cheque');
  ok(adj.effectivePlan({ plan: PLAN, mode: 'raw', deltaPoints: 0.1 }).code === 'mode_not_adjustable',
    'F10 raw pricing has nothing of ours to give away');
  ok(adj.effectivePlan({ plan: PLAN, mode: 'lenderPaid', deltaPoints: 'abc' }).code === 'no_delta',
    'F11 junk in the box is refused, not read as zero');

  ok(adj.priceNow({ plan: PLAN, mode: 'lenderPaid', rawPrice: 103.1 }) === 101.1,
    'F12 the price a screen is told it reads at is the overlay\'s own arithmetic');
  ok(adj.priceNow({ plan: PLAN, mode: 'raw', rawPrice: 103.1 }) === null,
    'F13 …and "we cannot tell you" is null, never a confident 0.000');
}

// ===========================================================================
section('G. through the SNAPSHOT — the document moves, and says nothing about it');
// ===========================================================================
{
  const SC = {
    purpose: 'Purchase', propertyType: 'Single family', value: 500000, loan: 375000,
    ltv: 75, termYears: 30, dscr: 1.24, fico: 740, state: 'NJ',
    rentMonthly: 3900, taxMonthly: 620, insuranceMonthly: 145,
  };
  const sel = (adjust) => ({
    label: 'A', consumerLabel: 'Platinum', product: 'P', mode: 'borrowerPaid',
    ratePct: 7.375, rawPrice: 103.1, scenario: SC, pricedAt: '2026-08-30T13:30:00.000Z',
    priceAdjustment: adjust,
    internal: { investor: 'Deephaven', rawPrice: 103.1 },
  });
  const build = (a) => snapshot.buildSnapshot({ selections: [sel(a)], plan: PLAN, anchorIndex: 0, prepared: {} });

  const plain = build(undefined);
  const moved = build(-0.1);
  ok(plain.ok && moved.ok, 'G1 both build');
  ok(plain.snapshot.members[0].charges.displayPrice === 101.1,
    `G2 unadjusted, the sheet prices at 101.100 (${plain.snapshot.members[0].charges.displayPrice})`);
  ok(moved.snapshot.members[0].charges.displayPrice === 101,
    `G3 ⛔ the owner's own example, end to end: typing -0.1 issues at 101.000 (${moved.snapshot.members[0].charges.displayPrice})`);

  /* ⛔ IT IS A REAL RE-PRICE OF THE WHOLE OPTION, not a moved headline. The
     origination the borrower is charged comes off the same plan, so it has to move
     too — if it did not, the sheet would quote a price it does not charge. */
  const oc = (m) => JSON.stringify(m.charges);
  ok(oc(plain.snapshot.members[0]) !== oc(moved.snapshot.members[0]),
    'G4 …and the whole charges block moves with it, not just the price line');

  /* ⛔ THE RATE NEVER MOVES. This is what makes the control safe to hand an officer:
     the worst case is that we earn less than we meant to, never that a borrower is
     quoted a rate the loan did not qualify for. */
  ok(plain.snapshot.members[0].ratePct === moved.snapshot.members[0].ratePct
    && plain.snapshot.members[0].monthlyPI === moved.snapshot.members[0].monthlyPI,
    'G5 ⛔ the RATE and the monthly payment are untouched — nothing here goes near the vendor');

  /* ⛔ THE MONEY DECISION IS NOT ON THE BORROWER'S DOCUMENT. "We gave away 0.1 of
     our compensation" is a fact about US. It is not an investor's name, so rule 10
     does not reach it — it is simply nobody's business but ours, and a field on the
     document is one careless layout change away from being drawn on it. */
  const doc = JSON.stringify(moved.snapshot);
  ok(!/adjustmentPoints|compBefore|compAfter|priceBeforeAdjustment/.test(doc),
    'G6 ⛔ none of the compensation arithmetic is anywhere on the document');
  ok(!('adjustment' in moved.snapshot.members[0]),
    'G7 …and the member carries no adjustment key at all');

  /* …but it IS reported, in its OWN list beside the members. It is deliberately NOT
     merged into `internal` here: that block is the CLIENT's, and `store.issueSheet`
     projects it a second time on the way to the database, which would strip a
     server-added key silently. The writer merges this in after that projection. */
  const rec = internalRecord.withAdjustment(moved.internal[0], moved.adjustments[0]);
  ok(rec.adjustmentPoints === -0.1, 'G8 ⛔ the staff record says by how much');
  ok(rec.compBefore === 2 && rec.compAfter === 2.1, 'G9 …and out of whose money it came');
  ok(rec.priceBeforeAdjustment === 101.1 && rec.priceAfterAdjustment === 101,
    'G10 …and what the price read before and after');
  ok(rec.investor === 'Deephaven' && rec.rawPrice === 103.1,
    'G11 …alongside the vendor facts that were already recorded');
  ok(internalRecord.wasAdjusted(rec) === true && internalRecord.wasAdjusted(plain.internal[0]) === false,
    'G12 …and a screen can ask which of the two it is looking at');
  ok(JSON.stringify(internalRecord.withAdjustment(plain.internal[0], plain.adjustments[0]))
      === JSON.stringify({ investor: 'Deephaven', rawPrice: 103.1 }),
    'G13 ⛔ an option nobody adjusted records exactly what it always did');
  ok(plain.adjustments[0] === null && moved.adjustments[0] != null,
    'G14a …and the sibling list says which of the two each option is');

  /* ⛔ THE BROWSER CANNOT FORGE IT. `projectInternal` is a pass-through whitelist of
     VENDOR facts; the adjustment is the server's own arithmetic and is merged on
     top, so an adjustment posted in the internal block is simply dropped. */
  const forged = snapshot.buildSnapshot({
    selections: [{ ...sel(undefined), internal: { investor: 'X', adjustmentPoints: -99, compAfter: 999 } }],
    plan: PLAN, anchorIndex: 0, prepared: {},
  });
  const forgedRec = internalRecord.withAdjustment(forged.internal[0], forged.adjustments[0]);
  ok(forgedRec.adjustmentPoints === undefined && forgedRec.compAfter === undefined,
    'G14 ⛔ an adjustment posted by the browser is dropped — only the server may record one');

  const refused = build(9);
  ok(!refused.ok && refused.error === 'delta_too_large',
    'G15 ⛔ and a slip refuses the WHOLE sheet rather than issuing one priced on a number nobody meant');
  ok(refused.memberIndex === 0, 'G16 …naming which option it was');
}

// ===========================================================================
section('H. SOURCE — one money path, and the three documents share it');
// ===========================================================================
{
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const snap = strip(read('src/longterm/termsheet/snapshot.js'));
  ok(/effectivePlan\(/.test(snap),
    'H1 the snapshot derives the effective plan rather than adjusting a figure of its own');
  ok(/quoteCharges\(mode, eff\.plan,/.test(snap),
    'H2 ⛔ …and prices the option ON it — the one place an adjustment can reach the money');
  ok(!/priceAdjustment/.test(strip(read('src/longterm/termsheet/overlay.js'))),
    'H3 ⛔ the overlay knows nothing about adjustments — there is no second money path to keep in step');

  /* ⛔ THE WRITE PATH MERGES IT AFTER PROJECTING, not before. `issueSheet` projects
     the client's block a second time on purpose; a server key merged in earlier is
     stripped there silently, which is exactly what happened before this was found. */
  const store = strip(read('src/longterm/termsheet/store.js')).replace(/\s+/g, ' ');
  ok(store.includes('withAdjustment( internalRecord.projectInternal'),
    'H3b the writer projects the client block and merges the server\'s arithmetic ON TOP of it');
  ok(/adjustments = \[\]/.test(store) && /adjustments\[i\]/.test(store),
    'H3c …taking it from its OWN list, so widening what a caller may record stays impossible');
  ok(!strip(read('src/longterm/termsheet/snapshot.js')).replace(/\s+/g, ' ')
    .includes('withAdjustment('),
    'H3d ⛔ …and the build does NOT merge it where the writer would silently strip it');

  const panel = strip(read('app-v2/src/longterm/TermSheetPanel.jsx'));
  ok((panel.match(/function PriceAdjuster\(/g) || []).length === 1,
    'H4 ⛔ ONE control on the screen, not one per workflow');
  /* ⛔ THIS COUNT IS NOT PROOF THE CONTROL DRAWS, and that is measured rather than
     supposed: `{false && <PriceAdjuster …/>}` leaves both literals in the file and
     renders nothing, and this assertion passed on exactly that. What proves a mount
     is live is section H of `test-lt-termsheet-issue-render.mjs`, which RENDERS both
     screens. The count is kept because it is free and it names the two sites; do not
     read it as more than that. */
  ok((panel.match(/<PriceAdjuster/g) || []).length === 2,
    'H5 the control is mounted at exactly two sites (a count only — the render suite proves they draw)');
  ok(/priceAdjustment: adjusts\[m\.id\]/.test(panel),
    'H6 a collected option carries its own adjustment into the sheet');
  ok(/priceAdjustment: adjust/.test(panel),
    'H7 …and so does a single one');
  ok(!/rawPrice\s*-\s*comp|compAfter\s*=/.test(panel),
    'H8 ⛔ the screen works out no money at all — every figure it shows is the server\'s');
}

console.log('');
if (bad) { console.error(`${bad} FAILED`); process.exit(1); }
console.log('ALL PASSED');
