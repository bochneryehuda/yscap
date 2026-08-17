#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE TWO ELIGIBILITY LAYERS MUST AGREE ON EVERY CELL, AND THIS IS THE TEST THAT PROVES IT.
 *
 * WHAT WAS WRONG (R10 divergence B). Layer 1 (the rate sheet, `deephaven-dscr-sheet.js`) carried a FLAT
 * eligibility envelope — max LTV 80, DSCR<1.00 → 75, DSCR<1.00 & FICO<700 → 70, min FICO 640 — while
 * Layer 2 (the eligibility matrix, `deephaven-matrix.js`) carries the real FOUR-AXIS grid: loan TIER ×
 * FICO floor × purpose × DSCR band. Layer 1 knew nothing about the tiers, so on a $1.75M or $2.25M loan
 * it priced cells the matrix refuses. MEASURED before the fix over the 1,152-cell reproduction sweep:
 * **164 divergences, every one in the same direction — Layer 1 ELIGIBLE where Layer 2 declines.**
 *
 * WHY IT MATTERED EVEN THOUGH LAYER 2 IS AUTHORITATIVE. The program verdict a borrower sees goes through
 * `evaluateProgram` → `evaluateEligibility` (Layer 2), so the loose layer was not over-lending in
 * production. But Layer 1 is the leg the Lender Price AGREEMENT harness prices, and it is the sheet a
 * future investor's program is built from — a rate-sheet layer that answers "eligible" on a loan the
 * matrix refuses is a wrong answer waiting for the day something reads it directly.
 *
 * WHY THE GRID IS TRANSCRIBED TWICE ON PURPOSE. The standing rule is "one definition, never a second
 * copy" — and the exception, stated in the same rule, is a mirror whose disagreement is caught by a test.
 * These two layers exist to CATCH EACH OTHER: one is transcribed from the vendor's Excel rate sheet, the
 * other from the published product matrix, and importing one into the other would collapse them into a
 * single source, so a transcription error would be agreed with rather than caught. They are also written
 * in DIFFERENT SHAPES — explicit half-open FICO ranges in Layer 1, descending floors with "highest floor
 * met" in Layer 2 — which is what makes this test a real check rather than a tautology.
 *
 * THE SWEEP IS DELIBERATELY BOUNDARY-HEAVY. A rule break lives at its boundary, so every axis carries the
 * value just below, the value at, and the value just above each threshold — 639/640, 1,500,000/1,500,001,
 * 999/1000. An off-by-one in either layer's comparison operator shows up here and nowhere else.
 *
 * PURE: no network, no DB, no live Lender Price.
 */
const { buildDeephavenGrid, _internals } = require('../src/longterm/ppe/deephaven-dscr-sheet');
const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');
const { quoteProgram } = require('../src/longterm/ppe/quote');
const matrix = require('../src/longterm/ppe/deephaven-matrix');
const rules = require('../src/longterm/ppe/rules');

let pass = 0; const fails = [];
function ok(cond, label) { if (cond) { pass += 1; console.log(`  ok   ${label}`); } else { fails.push(label); console.log(` FAIL  ${label}`); } }

const program = rateSheetToProgram(gridToRateSheet(buildDeephavenGrid()),
  { code: 'DHVN_DSCR30', name: 'Deephaven DSCR 30yr', investorCode: 'DHVN' });

// Every axis carries its boundaries: just-below / at / just-above each threshold in either layer.
const FICO = [619, 639, 640, 659, 660, 679, 680, 699, 700, 719, 720, 760, 820];
const LTV_PCT = [50, 60, 64.999, 65, 69.999, 70, 74.999, 75, 79.999, 80, 80.001, 85];
const DSCR = [740, 749, 750, 999, 1000, 1249, 1250, 1400];
const PURPOSE = ['purchase', 'refinance', 'cashout'];
const LOAN = [74999, 75000, 199999, 200000, 500000, 1500000, 1500001, 2000000, 2000001, 2500000, 2500001];

// THE OVERLAY AXES. The first cut of this sweep held units = 1, no subordinate lien, no interest-only,
// a SingleFamily property and no cash-out amount — so five of Layer 2's six overlays could not fire and
// the sweep would have passed with them entirely absent from Layer 1. A sweep that does not VARY a fact
// proves nothing about that fact; section 8 asserts each of these axes actually bites.
const OVERLAY = [
  { label: 'plain', units: 1, property_type: 'SingleFamily', interest_only: false, subordinate_amount: 0, cashout_amount: 0 },
  { label: 'interest-only', units: 1, property_type: 'SingleFamily', interest_only: true, subordinate_amount: 0, cashout_amount: 0 },
  { label: '5 units', units: 5, property_type: 'SingleFamily', interest_only: false, subordinate_amount: 0, cashout_amount: 0 },
  { label: '4 units', units: 4, property_type: 'SingleFamily', interest_only: false, subordinate_amount: 0, cashout_amount: 0 },
  { label: 'row home', units: 1, property_type: 'RowHome', interest_only: false, subordinate_amount: 0, cashout_amount: 0 },
  { label: 'condo', units: 1, property_type: 'Condo', interest_only: false, subordinate_amount: 0, cashout_amount: 0 },
  { label: 'subordinate lien', units: 1, property_type: 'SingleFamily', interest_only: false, subordinate_amount: 50000, cashout_amount: 0 },
  { label: 'big cash-out', units: 1, property_type: 'SingleFamily', interest_only: false, subordinate_amount: 0, cashout_amount: 900000 },
  { label: 'huge cash-out', units: 1, property_type: 'SingleFamily', interest_only: false, subordinate_amount: 0, cashout_amount: 1100000 },
];

function facts(fico, ltvPct, dscr, purpose, loan, ov) {
  const o = ov || OVERLAY[0];
  return {
    fico, ltv: Math.round(ltvPct * 1000), cltv: Math.round(ltvPct * 1000), dscr, purpose,
    loan_amount: loan, value: Math.round(loan / (ltvPct / 100)),
    state: 'TX', borrower_type: 'LLC', prepay_months: 60, lock_days: 30,
    units: o.units, property_type: o.property_type, interest_only: o.interest_only,
    subordinate_amount: o.subordinate_amount, cashout_amount: o.cashout_amount,
  };
}

// ---------------------------------------------------------------------------------------------
// 1. THE DRIFT SWEEP — zero disagreement, in EITHER direction.
// ---------------------------------------------------------------------------------------------
let cells = 0; const l1LooseEx = []; const l1StrictEx = [];
for (const fico of FICO) for (const ltvPct of LTV_PCT) for (const dscr of DSCR) for (const purpose of PURPOSE) for (const loan of LOAN) for (const ov of OVERLAY) {
  cells += 1;
  const f = facts(fico, ltvPct, dscr, purpose, loan, ov);
  const l1 = !!quoteProgram({ scenario: f, program, settings: {} }).eligible;
  const l2 = !!matrix.evaluateEligibility(f).eligible;
  if (l1 === l2) continue;
  const row = { fico, ltv: ltvPct, dscr, purpose, loan, overlay: ov.label, l1, l2 };
  if (l1 && !l2) { if (l1LooseEx.length < 5) l1LooseEx.push(row); } else if (l2 && !l1) { if (l1StrictEx.length < 5) l1StrictEx.push(row); }
}
console.log(`  ..   swept ${cells} cells (fico × ltv × dscr × purpose × loan, boundary-heavy)`);
ok(cells >= 10000, `the sweep is genuinely exhaustive (${cells} cells)`);
ok(l1LooseEx.length === 0,
  `Layer 1 is never LOOSER than Layer 2 — the measured defect, 164 such cells before the fix (${l1LooseEx.length} now)`);
if (l1LooseEx.length) for (const e of l1LooseEx) console.log(`        L1 eligible / L2 declines: ${JSON.stringify(e)}`);
ok(l1StrictEx.length === 0,
  `and Layer 1 is never STRICTER either — a mirror has to agree in BOTH directions (${l1StrictEx.length})`);
if (l1StrictEx.length) for (const e of l1StrictEx) console.log(`        L2 eligible / L1 declines: ${JSON.stringify(e)}`);

// ---------------------------------------------------------------------------------------------
// 2. THE SWEEP MUST CONTAIN THE CELLS THE DEFECT LIVED IN — a sweep that never reaches T2/T3 would
//    pass with the bug fully intact, so the coverage is asserted rather than assumed.
// ---------------------------------------------------------------------------------------------
const reachedT2 = LOAN.some((l) => l > 1500000 && l <= 2000000);
const reachedT3 = LOAN.some((l) => l > 2000000 && l <= 2500000);
ok(reachedT2 && reachedT3, 'the sweep actually reaches the $1.5–2.0MM and $2.0–2.5MM tiers, where the divergence lived');
const t2WeakFico = facts(640, 60, 1000, 'purchase', 1750000);
ok(!quoteProgram({ scenario: t2WeakFico, program, settings: {} }).eligible,
  'the reported example (FICO 640, $1.75MM, 60 LTV) now DECLINES in Layer 1 — it was eligible before');
ok(!matrix.evaluateEligibility(t2WeakFico).eligible, 'and Layer 2 declines it too (that was never in doubt)');

// ---------------------------------------------------------------------------------------------
// 3. THE ADDED RULES CAN ONLY EVER DECLINE. That is what makes them safe beside the existing flat
//    envelope: a rule set that can only subtract cannot make an ineligible loan eligible.
// ---------------------------------------------------------------------------------------------
const gridRules = _internals.ltvGridEligibility();
ok(gridRules.length > 0, `the grid compiles to real eligibility rules (${gridRules.length})`);
ok(gridRules.every((r) => r.code && r.declineReason && r.predicate),
  'every compiled rule carries a code, a human decline reason and a predicate');
ok(new Set(gridRules.map((r) => r.code)).size === gridRules.length, 'every compiled rule code is unique');

// ---------------------------------------------------------------------------------------------
// 4. FICO ROWS ARE HALF-OPEN AND COVER THEIR TIER WITH NO GAP AND NO OVERLAP. This is the classic
//    "740 falls in two bands" bug; an overlap would apply two caps at once and a gap would apply none.
// ---------------------------------------------------------------------------------------------
for (const t of _internals.SHEET_LTV_GRID) {
  const rows = t.rows;
  ok(rows[0].fico[1] === null, `${t.tier}: the top FICO row is open-ended`);
  let contiguous = true;
  for (let i = 1; i < rows.length; i += 1) if (rows[i].fico[1] !== rows[i - 1].fico[0]) contiguous = false;
  ok(contiguous, `${t.tier}: the FICO rows are contiguous and non-overlapping (half-open [min, max))`);
  ok(rows[rows.length - 1].fico[0] === t.tierMinFico, `${t.tier}: the lowest row starts exactly at the tier's own minimum FICO (${t.tierMinFico})`);
}

// ---------------------------------------------------------------------------------------------
// 5. THE TIERS PARTITION THE LOAN RANGE — no dollar can be in two tiers or in none. A loan of exactly
//    $1,500,000 must be T1 in BOTH layers (the boundary the two shapes are most likely to disagree on).
// ---------------------------------------------------------------------------------------------
const tiers = _internals.SHEET_LTV_GRID;
ok(tiers[0].loanMinExclusive === null, 'the first tier is open at the bottom');
let partition = true;
for (let i = 1; i < tiers.length; i += 1) if (tiers[i].loanMinExclusive !== tiers[i - 1].loanMax) partition = false;
ok(partition, 'the loan tiers partition the range with no gap and no overlap');
for (const boundary of [1500000, 2000000, 2500000]) {
  const inTiers = tiers.filter((t) => boundary <= t.loanMax && (t.loanMinExclusive == null || boundary > t.loanMinExclusive));
  ok(inTiers.length === 1, `a loan of exactly $${boundary.toLocaleString()} belongs to exactly ONE tier (${inTiers.map((t) => t.tier).join(',') || 'none'})`);
}

// ---------------------------------------------------------------------------------------------
// 6. AN N/A CELL IS INELIGIBLE AT ANY LEVERAGE — never a guessed cap. Layer 2's matrix marks the
//    weak-FICO / DSCR<1.00 corners N/A, and "no cap stated" must never read as "no cap".
// ---------------------------------------------------------------------------------------------
const naCell = facts(660, 50, 900, 'purchase', 500000);   // T1, FICO 640–679, DSCR < 1.00 → N/A
ok(!quoteProgram({ scenario: naCell, program, settings: {} }).eligible && !matrix.evaluateEligibility(naCell).eligible,
  'an N/A cell declines at 50% LTV in BOTH layers — an N/A is not a high cap');

// 6b. EACH N/A CELL IS PROVEN DIRECTLY, because the SWEEP CANNOT PROVE FOUR OF THE SIX.
//
// Mutating an N/A cell to a real cap and re-running the sweep was expected to turn it red. For the T3
// cell it does. For the T1 and T2 cells it does NOT — and that is not a weak test, it is a real fact
// about the rule set: every N/A cell is a DSCR < 1.00 cell, and four of the six span FICO ranges that
// sit entirely below 680, which the pre-existing flat rule `dhvn_min_fico_lt100` ("DSCR < 1.00: Min
// FICO 680") already refuses on its own. The two encodings agree, so removing either leaves the verdict
// unchanged and no end-to-end sweep can tell them apart. Only T3's cell reaches FICO 680–699, where the
// flat rule does not apply, so only that one is observable end to end.
//
// Redundancy that AGREES is not a defect, but it is exactly how a rule gets deleted later on the
// strength of a green suite. So each N/A cell's own compiled predicate is fired DIRECTLY here, against
// facts built from the cell itself — proving the mechanism for all six regardless of what else would
// also have caught them. Do not "simplify" either encoding away on the strength of the other.
const compiled = _internals.ltvGridEligibility();
let naProven = 0; let naMissing = 0;
for (const t of _internals.SHEET_LTV_GRID) {
  for (const r of t.rows) {
    for (const pc of ['purchase', 'cashout']) {
      for (const band of ['ge1', 'lt1']) {
        if (r[`${pc}_${band}`] !== null) continue;
        const code = `dhvn_na_${t.tier.toLowerCase()}_${r.fico[0]}_${pc}_${band}`;
        const rule = compiled.find((x) => x.code === code);
        if (!rule) { naMissing += 1; continue; }
        // Facts squarely inside the cell, at a LOW leverage no cap could ever refuse — so a decline
        // here can only be the N/A itself.
        const f = {
          fico: r.fico[0], ltv: 30000, cltv: 30000,
          dscr: band === 'ge1' ? 1300 : 900,
          purpose: pc === 'cashout' ? 'cashout' : 'purchase',
          loan_amount: t.loanMinExclusive == null ? 500000 : t.loanMinExclusive + 1,
        };
        if (rules.evalPredicate(rule.predicate, f)) naProven += 1; else naMissing += 1;
      }
    }
  }
}
ok(naMissing === 0 && naProven === 6,
  `every N/A cell compiles to a rule that fires on its own at 30% LTV (${naProven}/6 proven, ${naMissing} missing)`);

// ---------------------------------------------------------------------------------------------
// 7. A SCENARIO WITH NO LOAN AMOUNT STILL HAS A LEVERAGE CAP. No tier predicate can fire without a
//    loan amount (the rules engine fails safe to false on a missing fact), which is exactly why the
//    flat envelope rules were KEPT rather than replaced. Deleting them would leave this uncapped.
// ---------------------------------------------------------------------------------------------
const noLoan = { fico: 760, ltv: 85000, cltv: 85000, dscr: 1250, purpose: 'purchase', state: 'TX', property_type: 'SingleFamily', units: 1 };
ok(!quoteProgram({ scenario: noLoan, program, settings: {} }).eligible,
  'with no loan amount, 85% LTV is still declined by the flat backstop — the grid alone could not judge it');

// ---------------------------------------------------------------------------------------------
// 8. EVERY OVERLAY AXIS MUST ACTUALLY BITE. Five of Layer 2's six overlays were entirely absent from
//    Layer 1 and the first sweep could not see them, because it never varied units, property type,
//    interest-only, the subordinate lien or the cash-out amount. An axis that never changes the answer
//    is an axis the sweep is not testing, so each is proven to flip a verdict on its own.
// ---------------------------------------------------------------------------------------------
const dec = (f) => !quoteProgram({ scenario: f, program, settings: {} }).eligible;
const base = (over) => facts(760, 60, 1250, 'purchase', 500000, over);
const plain = OVERLAY[0];
ok(!dec(base(plain)), 'the control cell is ELIGIBLE — so each refusal below is caused by the overlay, not the cell');
const OV = (label) => OVERLAY.find((o) => o.label === label);
ok(dec(base(OV('5 units'))), '5+ units is refused');
ok(!dec(base(OV('4 units'))), '…and 4 units is not — the cut is at 5, not "more than one"');
ok(dec(base(OV('row home'))), 'a Row Home is refused');
ok(!dec(base(OV('condo'))), '…and a condo is not — this program takes condos');
ok(dec(base(OV('subordinate lien'))), 'a subordinate lien is refused');
ok(dec(facts(760, 60, 900, 'purchase', 500000, OV('interest-only'))), 'interest-only below 1.00x DSCR is refused');
ok(dec(facts(760, 85, 1250, 'purchase', 500000, OV('interest-only'))), 'interest-only above 80% LTV is refused');
ok(dec(facts(760, 70, 1250, 'cashout', 500000, OV('big cash-out'))), '$900k cash-out above 65% LTV is refused (the $500k step)');
ok(!dec(facts(760, 60, 1250, 'cashout', 500000, OV('big cash-out'))), '…and the same $900k at 60% LTV is not — the cap steps with leverage');
ok(dec(facts(760, 60, 1250, 'cashout', 500000, OV('huge cash-out'))), '…while $1.1M is refused even at 60% LTV');
ok(dec(facts(760, 79, 1250, 'purchase', 100000, plain)), 'a $100k loan at 79% is refused — the small-loan cap, stricter than its own grid cell');
ok(!dec(facts(760, 75, 1250, 'purchase', 100000, plain)), '…and the same loan at 75% is fine, so the cap is 75 and not a blanket refusal');

console.log(`\n${fails.length ? `FAILURES: ${fails.length}` : 'OFFLINE: all passed'} (${pass} passed, ${fails.length} failed)`);
process.exit(fails.length ? 1 : 0);
