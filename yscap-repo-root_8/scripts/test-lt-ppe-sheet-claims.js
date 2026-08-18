#!/usr/bin/env node
'use strict';
/**
 * LT PPE - THE SHEET NOTES MUST STILL BE TRUE OF THE CODE.
 *
 * OFFLINE: pure. No database, no vendor call.
 *
 * WHAT THESE NOTES ARE. Each Deephaven sheet module exports an `UNMEASURED` list: prose recording what
 * the sheet does NOT decide, and why, so a reader can tell "we chose not to" from "nobody looked". It is
 * the most valuable prose in this workstream and the most drift-prone, because it is where an owner
 * question and a piece of code meet - and **several of its sentences are statements ABOUT the code.**
 *
 * WHAT WENT WRONG, MEASURED 2026-08-18. §2.69 wired the margin holdback into `pricing.priceRung` and
 * corrected the wiring note on `deephaven-dscr-sheet.js`. **The same false sentence survived in the
 * sibling max-price sheet**, which still read: *"THE HOLDBACK IS NOT YET APPLIED TO THE PRICE BY THE
 * ENGINE ... quote.js deliberately does NOT subtract it ... wiring it into pricing.priceRung ... belongs
 * in its own commit."* Measured: `priceRung` on a 105.000 base with a 0.25 holdback prices **104.750**.
 * It subtracts. So the note described a commit that had already happened and would have sent the next
 * reader to make the change **a second time, on a price** - the repo's own "fix the root and every place
 * it surfaces" rule, failed by me in the commit that fixed the root.
 *
 * SO THE CLAIMS ARE CHECKED, NOT TRUSTED. Every entry below is BICONDITIONAL: the claim is present in
 * the prose **if and only if** the code still behaves that way. A claim that goes stale fails; and code
 * that changes back without the note being restored fails too, which is the half a "must not appear"
 * test would miss.
 */
const path = require('path');

const PPE = path.join(__dirname, '..', 'src', 'longterm', 'ppe');
const pricing = require(path.join(PPE, 'pricing'));
const dscrSheet = require(path.join(PPE, 'deephaven-dscr-sheet'));
const maxPrice = require(path.join(PPE, 'deephaven-dscr-prepay-maxprice'));

let pass = 0;
const failures = [];
function ok(cond, what) { if (cond) { pass += 1; return; } failures.push(what); }

const SHEETS = {
  'deephaven-dscr-sheet': dscrSheet.UNMEASURED,
  'deephaven-dscr-prepay-maxprice': maxPrice.UNMEASURED,
};
const ALL_PROSE = Object.values(SHEETS).flat().join('\n');

/**
 * Each claim: the SENTENCE that asserts something about the code, and a live measurement of whether the
 * code still does that. `holds()` must never read the prose - that would be the claim checking itself.
 */
const CLAIMS = [
  {
    id: 'holdback_not_applied',
    // THE ONE THAT WAS STALE. Written as the sentence actually used, so this is about a real claim
    // rather than a keyword sweep.
    claim: /HOLDBACK IS NOT YET APPLIED TO THE PRICE BY THE ENGINE/i,
    says: 'the engine does not subtract the margin holdback from the price',
    holds: () => {
      const base = { rate: 7.5, basePriceMilli: 105000, adjustmentCostMilli: 0, marginMilli: 0 };
      const without = pricing.priceRung({ ...base, holdbackMilli: 0 }).rawPriceMilli;
      const withHb = pricing.priceRung({ ...base, holdbackMilli: 250 }).rawPriceMilli;
      return without === withHb;                 // "not applied" = the holdback changes nothing
    },
  },
  {
    // ⛔ REVERSED 2026-08-18 BY THE OWNER, and the claim reversed with it. This entry used to pin the
    // opposite — that above $2,500,000 `loanAmountMaxPrice` returns null (uncapped by this axis) — and
    // the guard held, because the code really did that. A guard can only ever prove the prose and the
    // code agree; it cannot know the pair is wrong. The owner's words settle it: "anything above 2.5
    // million files the same cap as 2.5 million."
    id: 'above_2_5m_takes_the_2_5m_cap',
    claim: /the top tier carries upward and loanAmountMaxPrice returns 103\.5 for any amount above \$2,500,000/,
    says: "a loan above $2,500,000 takes the same cap as one at $2,500,000 — the owner's own rule",
    holds: () => maxPrice.loanAmountMaxPrice(3000000) === 103.5
      && maxPrice.loanAmountMaxPrice(2500000) === 103.5
      && maxPrice.loanAmountMaxPrice(10000000) === 103.5,
  },
  {
    id: 'clamp_floor_then_cap',
    claim: /the engine's pricing\.clamp is floor-then-cap/,
    says: 'the engine applies the floor first and the cap second',
    // Only a floor ABOVE the cap can tell the two orders apart: floor-then-cap ends on the cap,
    // cap-then-floor ends on the floor. Anything else measures nothing.
    holds: () => pricing.clamp(50000, 101000, 98000) === 98000,
  },
  {
    id: 'min_price_is_a_floor',
    claim: /MIN PRICE 98\.000 is implemented as a FLOOR \(the price is clamped up to it\)/,
    says: 'a price under the sheet minimum is raised to it rather than declining the scenario',
    holds: () => pricing.clamp(90000, 98000, null) === 98000,
  },
  {
    id: 'floor_carries_no_holdback',
    claim: /the 98\.000 floor is carried EXACTLY as the sheet states it and no holdback is applied to it/,
    says: 'the sheet minimum reaches the grid unshifted by our holdback',
    holds: () => {
      const grid = maxPrice.buildPrepayMaxPriceGrid();
      return grid && grid.priceLimit && grid.priceLimit.minPrice === maxPrice.SHEET_TABLES.MIN_PRICE;
    },
  },
];

// ---------------------------------------------------------------------------
// A - EVERY CLAIM IS BICONDITIONAL.
// ---------------------------------------------------------------------------
for (const c of CLAIMS) {
  const present = c.claim.test(ALL_PROSE);
  let holds;
  try { holds = c.holds() === true; } catch (e) {
    ok(false, `A ${c.id}: the measurement itself threw (${String((e && e.message) || e).slice(0, 120)}) — an unmeasurable claim is not a passing claim`);
    continue;
  }
  if (present && !holds) {
    ok(false, `A ${c.id}: THE NOTE IS STALE — the sheets still say "${c.says}", and the code no longer does. `
      + 'A note about the code that the code contradicts is worse than no note: it sends the next reader to make a change that was already made.');
  } else if (!present && holds) {
    ok(false, `A ${c.id}: the code still behaves as "${c.says}" but no sheet note records it any more. `
      + 'Either restore the note or change the code — a decision nobody wrote down is one nobody can question.');
  } else {
    ok(true, `A ${c.id}: the note and the code agree (${present ? 'both say so' : 'neither does'})`);
  }
}

// ---------------------------------------------------------------------------
// B - AND THE STALE CLAIM CANNOT COME BACK IN OTHER WORDS. A biconditional on one exact sentence is
//     defeated by a paraphrase, and this particular claim is about MONEY.
// ---------------------------------------------------------------------------
{
  const REWORDINGS = [
    /deliberately does NOT subtract/i,
    /is not (?:yet )?applied to the price/i,
    /does not apply the holdback to the price/i,
  ];
  // Measured live, never assumed: if the engine really did stop subtracting, these sentences would be
  // TRUE again and this section must not fire.
  const engineSubtracts = pricing.priceRung({ rate: 7.5, basePriceMilli: 105000, holdbackMilli: 250 }).rawPriceMilli
    !== pricing.priceRung({ rate: 7.5, basePriceMilli: 105000, holdbackMilli: 0 }).rawPriceMilli;
  ok(engineSubtracts, 'B1 the engine subtracts the holdback — the fact the rest of this section is about');
  if (engineSubtracts) {
    for (const re of REWORDINGS) {
      const hit = Object.entries(SHEETS).find(([, list]) => list.some((t) => re.test(t)));
      ok(!hit, `B2 no sheet note says the holdback is unapplied in other words (${re}) — found in ${hit && hit[0]}`);
    }
  }
}

// ---------------------------------------------------------------------------
// C - THE GUARD MUST BE ABLE TO SEE THE PROSE AT ALL. A claim table matched against an empty string
//     passes every biconditional whose code half is false, which is most of them.
// ---------------------------------------------------------------------------
{
  for (const [name, list] of Object.entries(SHEETS)) {
    ok(Array.isArray(list) && list.length > 0, `C1 ${name} exports its UNMEASURED notes (${Array.isArray(list) ? list.length : 'not an array'})`);
    ok(Array.isArray(list) && list.every((t) => typeof t === 'string' && t.length > 40),
      `C2 ${name}'s notes are real sentences — a one-word entry is a placeholder, not a decision`);
  }
  ok(ALL_PROSE.length > 2000, `C3 the prose under test is a real corpus (${ALL_PROSE.length} characters)`);
  // At least one claim must currently be PRESENT, or this whole file could be passing on an empty
  // corpus and nobody would know.
  ok(CLAIMS.some((c) => c.claim.test(ALL_PROSE)),
    'C4 at least one claim is actually found in the prose — a table that matches nothing proves nothing');
}

console.log(failures.length
  ? `FAIL - lt ppe sheet claims (${pass} passed, ${failures.length} failed)\n  ${failures.join('\n  ')}`
  : `ok - lt ppe sheet claims (${pass} assertions)`);
process.exit(failures.length ? 1 : 0);
