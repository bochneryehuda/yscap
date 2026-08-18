#!/usr/bin/env node
'use strict';
/**
 * LT PPE - WE MAY NOT CHARGE FOR SOMETHING LENDER PRICE WAS NEVER TOLD.
 *
 * OFFLINE: builds real request bodies in memory. No database, no vendor call.
 *
 * THE MEASURED DEFECT THIS PREVENTS FROM RECURRING (2026-08-17, recorded in `agreement-scenarios.js`):
 * the battery set our overlay fact `short_term_rental` while Lender Price was told nothing, and LP's
 * own field defaults to LONG-term. So our engine priced a SHORT-term rental and LP priced a LONG-term
 * one - **28 `llpa_extra_ours` lines, our 0.5 charge against nothing**, on the single STR scenario.
 *
 * THAT IS NOT A SHEET DISAGREEMENT. IT IS TWO DIFFERENT LOANS. And it is the worse kind of wrong,
 * because the agreement rate it drags down is what the go-live gate reads: a phantom disagreement looks
 * exactly like a real one, so it does not read as "we measured this badly", it reads as "our sheet is
 * off". It was fixed structurally - `buildSearch` now infers LP's `rentalTerm` from our STR fact - and
 * measured on 2026-08-18 as the ONLY priced fact that had the problem. Nothing stopped a second one.
 *
 * THE INVARIANT, and it is one sentence: EVERY FACT OUR SHEET PRICES ON MUST REACH LENDER PRICE.
 * A fact only the OVERLAY reads is fine and is deliberately excluded - an overlay decline is scored as
 * OVERLAY, not as a defect (2.7). The rule is about CHARGES, not opinions.
 *
 * BOTH SIDES ARE DERIVED, WHICH IS THE WHOLE POINT:
 *   - what we PRICE on comes from walking the built sheet's own tables for `fact` keys, so adding an
 *     LLPA puts its fact in scope automatically;
 *   - what we TRANSMIT is measured by BUILDING TWO REAL REQUEST BODIES, one with the fact set and one
 *     without, and diffing them. Never by matching names: our `escrow_waiver` is LP's `escrowWaive`
 *     and our `interest_only` is LP's `io`, so a name check would report the healthy cases as broken
 *     and would have missed the STR case entirely (both sides spell it the same).
 */
const path = require('path');
const fs = require('fs');

const LT = path.join(__dirname, '..', 'src', 'longterm');
const { buildDeephavenGrid } = require(path.join(LT, 'ppe', 'deephaven-dscr-sheet'));
const searchModel = require(path.join(LT, 'lenderprice', 'search-model'));
const FOUNDATION = JSON.parse(fs.readFileSync(path.join(LT, 'lenderprice', 'search-base.json'), 'utf8'));

let pass = 0;
const failures = [];
function ok(cond, what) { if (cond) { pass += 1; return; } failures.push(what); }

// A scenario every probe starts from: eligible, complete, and boring.
const CORE = {
  purpose: 'Purchase', value: 500000, loan: 350000, fico: 760, dscr: 1.25,
  prepayMonths: 60, state: 'CA', zip: '90001', county: '06037',
};

/**
 * HOW TO MOVE EACH PRICED FACT ON A SCENARIO.
 *
 * This map is hand-written and therefore the one thing here that can go stale - so it is COVERAGE
 * CHECKED below: a priced fact with no probe fails the suite rather than being skipped, which is what
 * stops "we added an LLPA and the guard quietly stopped covering it".
 *
 * The value only has to CHANGE the request; it does not have to be realistic.
 */
const PROBE = {
  dscr: { dscr: 1.05 },
  fico: { fico: 680 },
  ltv: { loan: 400000 },                    // ltv is derived from loan vs value
  loan_amount: { loan: 275000 },
  purpose: { purpose: 'Cash out', cashoutAmount: 50000 },
  state: { state: 'NJ', zip: '07036', county: '34039' },
  property_type: { propertyType: 'Condo' },
  units: { units: 3 },
  escrow_waiver: { escrowWaive: true },
  interest_only: { io: true },
  non_warrantable: { nonWarrantable: true },
  short_term_rental: { short_term_rental: true },
};

// ---------------------------------------------------------------------------
// What the sheet PRICES on — walked out of the built sheet, never listed here.
// ---------------------------------------------------------------------------
function pricedFacts(grid) {
  const facts = new Set();
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    for (const [k, v] of Object.entries(o)) {
      if (k === 'fact' && typeof v === 'string' && v) facts.add(v);
      walk(v);
    }
  };
  // ONLY the price-bearing tables. `eligibility` is deliberately NOT walked: a fact that only decides
  // eligibility is not a charge, and this rule is about charges.
  walk(grid.llpaTables);
  walk(grid.ficoCltvByDscr);
  walk(grid.base);
  return [...facts].sort();
}

// ---------------------------------------------------------------------------
// What we TRANSMIT — measured by diffing two real bodies.
// ---------------------------------------------------------------------------
function build(extra) {
  return JSON.stringify(searchModel.buildSearch({ ...CORE, ...extra }, { foundation: FOUNDATION }));
}

function transmits(probe) {
  let moved;
  try { moved = build(probe); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, transmitted: moved !== BARE };
}

let BARE;
try { BARE = build({}); } catch (e) {
  console.log(`FAIL - lt ppe priced facts transmitted (the baseline scenario would not build: ${e.message})`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
function main() {
  const grid = buildDeephavenGrid();
  const priced = pricedFacts(grid);

  ok(priced.length > 5, `the sheet prices on a real set of facts (${priced.length}: ${priced.join(', ')})`);

  // (A) COVERAGE — every priced fact has a probe, or this suite is quietly not covering it.
  const unprobed = priced.filter((f) => !PROBE[f]);
  ok(unprobed.length === 0,
    `every priced fact has a probe here — unprobed: ${unprobed.join(', ')}. Add one in the same commit as the LLPA, or this guard silently stops covering it.`);

  // (B) THE INVARIANT. A fact we charge on must reach Lender Price, or the two legs price different
  //     loans and every scenario carrying it manufactures a disagreement.
  for (const fact of priced) {
    const probe = PROBE[fact];
    if (!probe) continue;                       // already reported by (A)
    const r = transmits(probe);
    if (!r.ok) {
      ok(false, `${fact}: the probe would not build a request (${r.error}) — the guard cannot judge it, which is not the same as it passing`);
      continue;
    }
    ok(r.transmitted,
      `${fact} is CHARGED by our sheet and must reach Lender Price — it does not, so every scenario carrying it prices a different loan on each side (this is the 2026-08-17 short-term-rental defect: 28 phantom lines, our charge against nothing)`);
  }

  // (C) THE PROBE ITSELF MUST BE ABLE TO FAIL. A probe that changes nothing about the scenario would
  //     report "not transmitted" for a healthy fact and "transmitted" for none — so prove the baseline
  //     is stable and that an unrelated no-op really does read as no-op.
  ok(build({}) === BARE, 'C1 the baseline body is deterministic — two builds of the same scenario agree');
  const noop = transmits({ __not_a_field_anything_reads__: true });
  ok(noop.ok && noop.transmitted === false,
    'C2 a field nothing reads is measured as NOT transmitted — so "transmitted" means the body genuinely moved');

  // (D) THE STR CASE SPECIFICALLY, pinned by name. It is the one that actually happened, and the fix
  //     is an inference inside buildSearch rather than something the caller must remember.
  const strOnly = transmits({ short_term_rental: true });
  ok(strOnly.ok && strOnly.transmitted,
    'D1 setting ONLY our overlay fact short_term_rental still reaches Lender Price — the mapper infers its rentalTerm, so a caller cannot reintroduce the defect by forgetting the pair');

  // (E) OVERLAY-ONLY FACTS ARE OUT OF SCOPE, ON PURPOSE, and that is asserted rather than assumed —
  //     if one of these ever becomes a CHARGE it must enter scope through (A)/(B), not slip past.
  const OVERLAY_ONLY = ['rural_property', 'first_time_investor', 'first_time_homebuyer', 'foreign_national', 'declining_market'];
  const nowPriced = OVERLAY_ONLY.filter((f) => priced.includes(f));
  ok(nowPriced.length === 0,
    `these facts decide our OVERLAY only and are not charges, so Lender Price is not told them and that is correct — but ${nowPriced.join(', ') || 'none'} now appears in the priced set, which changes the answer: give it a probe and make sure it is transmitted`);

  console.log(failures.length
    ? `FAIL - lt ppe priced facts transmitted (${pass} passed, ${failures.length} failed)\n  ${failures.join('\n  ')}`
    : `ok - lt ppe priced facts transmitted (${pass} assertions)`);
  process.exit(failures.length ? 1 : 0);
}

main();
