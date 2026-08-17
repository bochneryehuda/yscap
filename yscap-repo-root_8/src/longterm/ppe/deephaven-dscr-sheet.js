'use strict';
/**
 * LT PPE — OUR INDEPENDENT-ANALYSIS Deephaven DSCR sheet, encoded from the LIVE Lender Price
 * reconstruction (docs/longterm/ppe-research/LP-DEEPHAVEN-DSCR-LIVE-TABLES.md, sheet v12.7.25). This is
 * the SHEET-UNDER-TEST for the ≥200-scenario agreement gate — it is NOT wired into the live pricer and
 * is NEVER trusted until the agreement harness proves it matches Lender Price to the penny (owner HARD
 * RULE 2026-08-17). buildDeephavenGrid() → a deephaven-grid.gridToRateSheet input.
 *
 * THE SIGN, written down because it is a money rule: Lender Price quotes LLPAs COST-POSITIVE (a positive
 * value WORSENS the price — FICO 640 costs +2.5..+3.875 points). deephaven-grid.gridToRateSheet expects
 * PREMIUM-POSITIVE cells (positive IMPROVES the price). So EVERY Lender Price value is NEGATED here
 * (`cost(v) = -v`). This is proven end-to-end in the test, which reproduces Lender Price's OWN itemized
 * values from the captured live battery.
 *
 * SCOPE — the FULLY-CONFIRMED core plus the CLTV-segmented add-ons, each value re-derived directly from
 * the captured live battery (never guessed):
 *   • base-price ladder (coupon → basePoints), 28 coupons;
 *   • the DSCR-INDEPENDENT FICO×CLTV grid (`DSCR (All)`);
 *   • the SEPARATE additive DSCR-band table (≥1.25 flat; 1.00–1.24 baseline 0; <1.00 CLTV-segmented);
 *   • the flat DC/MA/NJ/NY state adder;
 *   • §7 cash-out refinance (split at FICO 720), condo, and 2–4 units — all CLTV-segmented;
 *   • the FOUR families measured live 2026-08-17 — interest-only, escrow-waiver, non-warrantable
 *     (which REPLACES the condo line), and the 2D loan-amount table (>1.5M / >2M / <150k / <125k × CLTV).
 * DELIBERATELY OMITTED (never guessed — see UNMEASURED): the two loan-amount n/e cells (>$2M @ 75/80 and
 * <$125k @ 80 — inferred LTV caps, not encoded as eligibility overlays), the prepay-structure LLPA (the
 * 5%-Fixed credit is measured but not yet wired into Layer-1), non-warrantable on a non-condo, and the
 * cash-out FICO<720 @ 80% cell (n/e). The harness honestly reports a "missing on our side" for any of these.
 *
 * LT-only. No RTL imports, no network, no DB.
 */

// Lender Price value (cost-positive) → deephaven-grid cell/adj (premium-positive).
const cost = (v) => (v == null ? null : -v);

// ---- §3 base ladder: [coupon, basePoints]. price = 100 − basePoints -----------------------------
const BASE = [
  [6.125, 0.150], [6.250, -0.500], [6.375, -1.050], [6.500, -1.600], [6.625, -2.100], [6.750, -2.600],
  [6.875, -3.075], [6.990, -3.525], [7.125, -3.975], [7.250, -4.400], [7.375, -4.800], [7.500, -5.175],
  [7.625, -5.550], [7.750, -5.925], [7.875, -6.300], [7.990, -6.675], [8.125, -7.050], [8.250, -7.390],
  [8.375, -7.690], [8.500, -7.990], [8.625, -8.271], [8.750, -8.552], [8.875, -8.834], [8.990, -9.099],
  [9.125, -9.365], [9.250, -9.552], [9.375, -9.740], [9.500, -9.927],
];

// ---- §4 FICO bands (raw score) and CLTV bands (percent, .5 boundaries so every WHOLE CLTV lands in
// the band Lender Price puts it in — LP's real edges are at X.01, exact for the whole-CLTV battery) --
const FICO_BANDS = [
  { min: 780, max: null }, { min: 760, max: 780 }, { min: 740, max: 760 }, { min: 720, max: 740 },
  { min: 700, max: 720 }, { min: 680, max: 700 }, { min: 660, max: 680 }, { min: 640, max: 660 },
];
const CLTV_BANDS = [
  { min: null, max: 50.5 }, { min: 50.5, max: 55.5 }, { min: 55.5, max: 60.5 }, { min: 60.5, max: 65.5 },
  { min: 65.5, max: 70.5 }, { min: 70.5, max: 75.5 }, { min: 75.5, max: 80.5 },
];
// §4 cells, LENDER PRICE cost-positive values (rows = FICO band above, cols = CLTV band above).
// null = `n/e` (the DSCR-matching container declined → an ineligibility, never a priced 0).
const FICO_CLTV_LP = [
  [1.000, 0.750, 0.625, 0.500, 0.125, 0.250, 0.750],
  [0.875, 0.750, 0.625, 0.500, 0.125, 0.250, 1.125],
  [0.750, 0.625, 0.500, 0.375, 0.125, 0.500, 1.500],
  [0.625, 0.500, 0.375, 0.125, 0.375, 0.875, 1.875],
  [0.250, 0.125, 0.000, 0.250, 1.000, 1.500, 2.625],
  [0.000, 0.250, 0.500, 0.750, 1.625, 2.500, null],
  [0.500, 0.750, 1.000, 1.250, 2.125, 3.750, null],
  [2.500, 2.750, 3.000, 3.375, 3.875, null, null],
];

// ---- §5 DSCR-band add-on (SEPARATE additive; dscr fact is MILLI: 1.25 → 1250, 1.00 → 1000) --------
// ≥1.25 flat +0.25; 1.00–1.24 baseline 0 (no entry); <1.00 CLTV-segmented, per CLTV band (percent).
const DSCR_LT100_BY_CLTV = [
  { cltv: { min: null, max: 50.5 }, lp: 0.750 },
  { cltv: { min: 50.5, max: 55.5 }, lp: 0.875 },
  { cltv: { min: 55.5, max: 60.5 }, lp: 1.000 },
  { cltv: { min: 60.5, max: 65.5 }, lp: 1.250 },
  { cltv: { min: 65.5, max: 70.5 }, lp: 1.500 },
  { cltv: { min: 70.5, max: 75.5 }, lp: 2.000 },
  // 75–80 for DSCR<1.00 is n/e (eligibility caps LTV at ≤75% for DSCR<1.00) — no priced entry.
];
const cltvMilliPredicate = (cb) => ({ fact: 'ltv', op: 'between', value: [cb.min == null ? 0 : cb.min * 1000, (cb.max == null ? 100 : cb.max) * 1000] });

// ---- §7 add-on LLPAs, CLTV-segmented (MEASURED live 2026-08-17 from the captured battery — every value
// re-derived directly from the sweep report, never guessed). Values are LENDER PRICE cost-positive; each
// aligns index-for-index with CLTV_BANDS (50/55/60/65/70/75/80). A 0 emits NO adjustment (LP emits no
// line for a zero band); `null` = n/e (an eligibility cap, no priced entry). ----------------------------
const CASHOUT_GE720_BY_CLTV = [0, 0.125, 0.250, 0.250, 0.500, 0.875, 2.625]; // "Cash Out Refinance, FICO >= 720"
const CASHOUT_LT720_BY_CLTV = [0.250, 0.375, 0.375, 0.500, 0.750, 1.000, null]; // "…, FICO < 720"; 80% is n/e (LTV cap)
const CONDO_BY_CLTV = [0, 0, 0, 0.125, 0.125, 0.250, 0.500]; // "Condo" (AllCondoRateAdjustment)
const UNITS_BY_CLTV = [0.250, 0.250, 0.500, 0.500, 0.750, 1.000, 1.500]; // "2-4 Units" (UnitRateAdjustment)
// The FOUR add-on families MEASURED live against Lender Price 2026-08-17 (docs/longterm/ppe-research/
// DEEPHAVEN-MISSING-LLPA-MEASURED.md) — every value verified constant across all 56 coupons on both
// priced containers. cost-positive, index-aligned to CLTV_BANDS [50,55,60,65,70,75,80].
const IO_BY_CLTV = [0.250, 0.250, 0.250, 0.500, 0.625, 0.750, 1.250];      // "Other - Interest Only"
const ESCROW_BY_CLTV = [0.250, 0.250, 0.250, 0.250, 0.250, 0.250, 0.250];   // "Other - Escrow Waiver" (flat +0.25)
const NONWARR_BY_CLTV = [0.750, 0.750, 0.750, 0.750, 0.750, 1.000, 1.000];  // "Other - Non-Warrantable" (REPLACES the Condo line)
// Loan-amount is 2D (tier × CLTV); tiers are mutually exclusive (most-specific fires). 0 = a real zero
// band (no line); null = n/e (the matching DSCR container declined — an INFERRED LTV cap, left unpriced).
const LOANAMT_GT_1_5M_BY_CLTV = [0, 0, 0, 0.125, 0.250, 0.250, 0.250];      // "Loan Amount - > 1,500,000" (1.5M < loan <= 2.0M)
const LOANAMT_GT_2_0M_BY_CLTV = [0.250, 0.250, 0.375, 0.500, 0.500, null, null]; // "Loan Amount - > 2,000,000" (75/80 n/e: >$2M → LTV <=70%)
const LOANAMT_LT_150K_BY_CLTV = [1.250, 1.250, 1.250, 1.500, 1.500, 1.500, 1.750]; // "Loan Amount - < 150,000" (125k <= loan < 150k)
const LOANAMT_LT_125K_BY_CLTV = [1.750, 1.750, 2.000, 2.250, 2.250, 2.500, null]; // "Loan Amount - < 125,000" (80 n/e: small-loan @80% declines)
const cltvBandLabel = (cb) => (cb.min == null ? 'CLTV To 50.0%' : `CLTV ${cb.min - 0.5}–${cb.max - 0.5}%`);

function buildDeephavenGrid() {
  const dscrTables = [];
  // ≥1.25 flat +0.25, all CLTV
  dscrTables.push({ dimension: 'dscr', code: 'dhvn_dscr_ge125', reason: 'DSCR Ratio - DSCR >= 1.25', predicate: { fact: 'dscr', op: 'gte', value: 1250 }, adj: cost(0.25) });
  // <1.00, CLTV-segmented
  for (const seg of DSCR_LT100_BY_CLTV) {
    dscrTables.push({
      dimension: 'dscr', code: `dhvn_dscr_lt100_${seg.cltv.min == null ? 'to' : seg.cltv.min}`,
      reason: `DSCR Ratio - DSCR < 1.00 / CLTV ${seg.cltv.min == null ? '<= 50' : seg.cltv.min + '–' + seg.cltv.max}`,
      predicate: { all: [{ fact: 'dscr', op: 'lt', value: 1000 }, cltvMilliPredicate(seg.cltv)] }, adj: cost(seg.lp),
    });
  }

  // §7 add-on LLPAs — cash-out (split at FICO 720), condo, and 2–4 units, each CLTV-segmented. A 0 or
  // null band emits NOTHING (LP itemizes no line there), so a non-add-on scenario is untouched.
  const addonTables = [];
  CLTV_BANDS.forEach((cb, i) => {
    const co720 = CASHOUT_GE720_BY_CLTV[i];
    if (co720) addonTables.push({ dimension: 'cashout', code: `dhvn_cashout_ge720_${i}`, reason: `Other - Cash Out Refinance, FICO >= 720 / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'purpose', op: 'eq', value: 'cashout' }, { fact: 'fico', op: 'gte', value: 720 }, cltvMilliPredicate(cb)] }, adj: cost(co720) });
    const coLt = CASHOUT_LT720_BY_CLTV[i];
    if (coLt) addonTables.push({ dimension: 'cashout', code: `dhvn_cashout_lt720_${i}`, reason: `Other - Cash Out Refinance, FICO < 720 / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'purpose', op: 'eq', value: 'cashout' }, { fact: 'fico', op: 'lt', value: 720 }, cltvMilliPredicate(cb)] }, adj: cost(coLt) });
    const condo = CONDO_BY_CLTV[i];
    // condo is gated on non_warrantable != true: a NON-warrantable condo emits the Non-Warrantable line
    // INSTEAD of the plain Condo line (measured — LP suppresses the Condo line there). lpScenarioToFacts
    // always emits non_warrantable (false/true), so a warrantable condo (false) still fires this line.
    if (condo) addonTables.push({ dimension: 'property_type', code: `dhvn_condo_${i}`, reason: `Other - Condo / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'property_type', op: 'in', value: ['Condo', 'Condos'] }, { fact: 'non_warrantable', op: 'neq', value: true }, cltvMilliPredicate(cb)] }, adj: cost(condo) });
    const units = UNITS_BY_CLTV[i];
    if (units) addonTables.push({ dimension: 'units', code: `dhvn_units_${i}`, reason: `Other - 2-4 Units / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'units', op: 'gte', value: 2 }, cltvMilliPredicate(cb)] }, adj: cost(units) });
    // ── the FOUR families measured live 2026-08-17 (Interest Only, Escrow Waiver, Non-Warrantable, Loan
    //    amount). A 0 or null band emits NOTHING, so a scenario carrying none of these is untouched. ──
    const io = IO_BY_CLTV[i];
    if (io) addonTables.push({ dimension: 'interest_only', code: `dhvn_io_${i}`, reason: `Other - Interest Only / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'interest_only', op: 'eq', value: true }, cltvMilliPredicate(cb)] }, adj: cost(io) });
    const ew = ESCROW_BY_CLTV[i];
    if (ew) addonTables.push({ dimension: 'escrow_waiver', code: `dhvn_escrow_${i}`, reason: `Other - Escrow Waiver / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'escrow_waiver', op: 'eq', value: true }, cltvMilliPredicate(cb)] }, adj: cost(ew) });
    const nw = NONWARR_BY_CLTV[i];
    if (nw) addonTables.push({ dimension: 'non_warrantable', code: `dhvn_nonwarr_${i}`, reason: `Other - Non-Warrantable / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'non_warrantable', op: 'eq', value: true }, cltvMilliPredicate(cb)] }, adj: cost(nw) });
    // loan-amount tiers — mutually exclusive by construction (the > 1.5M tier is bounded <= 2.0M):
    const la15 = LOANAMT_GT_1_5M_BY_CLTV[i];
    if (la15) addonTables.push({ dimension: 'loan_amount', code: `dhvn_loanamt_gt15_${i}`, reason: `Loan Amount - > 1,500,000 / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'loan_amount', op: 'gt', value: 1500000 }, { fact: 'loan_amount', op: 'lte', value: 2000000 }, cltvMilliPredicate(cb)] }, adj: cost(la15) });
    const la20 = LOANAMT_GT_2_0M_BY_CLTV[i];
    if (la20) addonTables.push({ dimension: 'loan_amount', code: `dhvn_loanamt_gt20_${i}`, reason: `Loan Amount - > 2,000,000 / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'loan_amount', op: 'gt', value: 2000000 }, cltvMilliPredicate(cb)] }, adj: cost(la20) });
    const la150 = LOANAMT_LT_150K_BY_CLTV[i];
    if (la150) addonTables.push({ dimension: 'loan_amount', code: `dhvn_loanamt_lt150_${i}`, reason: `Loan Amount - < 150,000 / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'loan_amount', op: 'gte', value: 125000 }, { fact: 'loan_amount', op: 'lt', value: 150000 }, cltvMilliPredicate(cb)] }, adj: cost(la150) });
    const la125 = LOANAMT_LT_125K_BY_CLTV[i];
    if (la125) addonTables.push({ dimension: 'loan_amount', code: `dhvn_loanamt_lt125_${i}`, reason: `Loan Amount - < 125,000 / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'loan_amount', op: 'lt', value: 125000 }, cltvMilliPredicate(cb)] }, adj: cost(la125) });
  });

  return {
    investor: 'DHVN', program: 'DSCR30', scale: 1000, lockDays: 30,
    terms: [{ key: '30F', product: '30 Yr Fixed' }],
    base: BASE.map(([coupon, basePoints]) => ({ coupon, prices: { '30F': 100 - basePoints } })),
    ficoCltvByDscr: [{
      dscr: { min: null, max: null }, // DSCR-INDEPENDENT ("DSCR (All)")
      ficoBands: FICO_BANDS,
      cltvBands: CLTV_BANDS,
      cells: FICO_CLTV_LP.map((row) => row.map(cost)),
    }],
    llpaTables: [
      // §6 state adder — DC/MA/NJ/NY flat +0.375
      { dimension: 'state', code: 'dhvn_state', reason: 'Other - State of DC, MA, NJ, NY', predicate: { fact: 'state', op: 'in', value: ['DC', 'MA', 'NJ', 'NY'] }, adj: cost(0.375) },
      ...dscrTables,
      ...addonTables,
    ],
    // §2/§10 — the eligibility ENVELOPE, verbatim from Lender Price's disqualify reasons. Facts: fico
    // RAW, ltv MILLI-percent (80% → 80000), dscr MILLI (1.00 → 1000), loan_amount RAW dollars.
    eligibility: [
      { code: 'dhvn_min_fico', declineReason: 'Min FICO 640', predicate: { fact: 'fico', op: 'lt', value: 640 } },
      { code: 'dhvn_min_fico_lt100', declineReason: 'DSCR < 1.00: Min FICO 680', predicate: { all: [{ fact: 'dscr', op: 'lt', value: 1000 }, { fact: 'fico', op: 'lt', value: 680 }] } },
      { code: 'dhvn_max_ltv', declineReason: 'Max LTV/CLTV 80%', predicate: { fact: 'ltv', op: 'gt', value: 80000 } },
      { code: 'dhvn_max_ltv_lt100', declineReason: 'DSCR < 1.00: Max LTV 75%', predicate: { all: [{ fact: 'dscr', op: 'lt', value: 1000 }, { fact: 'ltv', op: 'gt', value: 75000 }] } },
      { code: 'dhvn_max_ltv_lt100_weakfico', declineReason: 'DSCR < 1.00, FICO < 700: Max LTV 70%', predicate: { all: [{ fact: 'dscr', op: 'lt', value: 1000 }, { fact: 'fico', op: 'lt', value: 700 }, { fact: 'ltv', op: 'gt', value: 70000 }] } },
      { code: 'dhvn_min_dscr', declineReason: 'Minimum DSCR 0.75', predicate: { fact: 'dscr', op: 'lt', value: 750 } },
      // MIN LOAN is DSCR-GATED (owner/R10 2026-08-17): the flat $75k min ignored DSCR, so a $150k /
      // DSCR-0.90 loan PRICED when the matrix says it must decline. Split to mirror Layer-2
      // (deephaven-matrix MIN_LOAN_DSCR_GE1/LT1) EXACTLY — $75k for DSCR>=1.00, $200k for DSCR<1.00 —
      // including the fail-safe when DSCR is absent (neither branch fires, same as the matrix's
      // `dscr >= 1000` / `dscr < 1000` guards), so the two layers can never disagree on min-loan.
      { code: 'dhvn_min_loan_ge1', declineReason: 'Minimum Loan Amount $75,000 (DSCR >= 1.00x)', predicate: { all: [{ fact: 'dscr', op: 'gte', value: 1000 }, { fact: 'loan_amount', op: 'lt', value: 75000 }] } },
      { code: 'dhvn_min_loan_lt1', declineReason: 'Minimum Loan Amount $200,000 (DSCR < 1.00x)', predicate: { all: [{ fact: 'dscr', op: 'lt', value: 1000 }, { fact: 'loan_amount', op: 'lt', value: 200000 }] } },
      { code: 'dhvn_max_loan', declineReason: 'Maximum Loan Amount $2.5MM', predicate: { fact: 'loan_amount', op: 'gt', value: 2500000 } },
    ],
    priceLimit: {
      // §8 — no Deephaven price cap/floor was observed; loan size enters via a (not-yet-encoded)
      // loan-amount LLPA, not a cap. Rounding left to the pricer's default (nearest 1/8).
      minPrice: null,
    },
  };
}

// The Lender Price tables this sheet encodes, kept beside the grid so the test can reproduce LP's OWN
// itemized values (the offline agreement oracle) without re-deriving them.
const LP_TABLES = {
  BASE, FICO_BANDS, CLTV_BANDS, FICO_CLTV_LP, DSCR_LT100_BY_CLTV,
  CASHOUT_GE720_BY_CLTV, CASHOUT_LT720_BY_CLTV, CONDO_BY_CLTV, UNITS_BY_CLTV,
  IO_BY_CLTV, ESCROW_BY_CLTV, NONWARR_BY_CLTV,
  LOANAMT_GT_1_5M_BY_CLTV, LOANAMT_GT_2_0M_BY_CLTV, LOANAMT_LT_150K_BY_CLTV, LOANAMT_LT_125K_BY_CLTV,
};

// What is deliberately NOT in this sheet yet (never guessed) — fill from a targeted re-measure battery.
const UNMEASURED = [
  'cash-out FICO<720 @ CLTV 80% (n/e in the battery — cash-out LTV cap; confirm before encoding as eligibility)',
  'loan-amount n/e cells: >$2.0M @ CLTV 75/80 and <$125k @ CLTV 80 (INFERRED LTV caps — >$2M→LTV<=70%, small-loan@80% declines — measured as "no price", not yet encoded as eligibility overlays)',
  'prepay-structure LLPA: the 5%-Fixed credit is MEASURED (+0.500 vs the standard 5-yr step-down) but not yet wired into the Layer-1 sheet — deferred until the margin/adjustmentPoints layer is reconciled',
  'non-warrantable on a non-condo (SFR) — the NW line was measured only on a condo',
];

module.exports = { buildDeephavenGrid, LP_TABLES, UNMEASURED, _internals: { cost } };
