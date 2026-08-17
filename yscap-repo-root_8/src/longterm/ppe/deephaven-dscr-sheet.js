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
 * SCOPE — the FULLY-CONFIRMED core only:
 *   • base-price ladder (coupon → basePoints), 28 coupons;
 *   • the DSCR-INDEPENDENT FICO×CLTV grid (`DSCR (All)`);
 *   • the SEPARATE additive DSCR-band table (≥1.25 flat; 1.00–1.24 baseline 0; <1.00 CLTV-segmented);
 *   • the flat DC/MA/NJ/NY state adder.
 * DELIBERATELY OMITTED (never guessed — see UNMEASURED): cash-out / condo / loan-amount (PARTIAL in the
 * live run) and prepay / interest-only / units (NOT measured). The harness will honestly report a
 * "missing on our side" for any scenario that needs one of these until a targeted re-measure fills them.
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
      { code: 'dhvn_min_loan', declineReason: 'Minimum Loan Amount $75,000', predicate: { fact: 'loan_amount', op: 'lt', value: 75000 } },
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
const LP_TABLES = { BASE, FICO_BANDS, CLTV_BANDS, FICO_CLTV_LP, DSCR_LT100_BY_CLTV };

// What is deliberately NOT in this sheet yet (never guessed) — fill from a targeted re-measure battery.
const UNMEASURED = [
  'cash-out refinance LLPA (PARTIAL: FICO≥720 @70=0.5/@80=2.625; FICO<720 @70=0.75 only)',
  'condo LLPA (PARTIAL: +0.125 at CLTV 65–70 only)',
  'loan-amount LLPA (PARTIAL: <125k +2.25, <150k +1.5, >1.5M +0.25 — few CLTV points)',
  'prepay-term differentiation (NOT measured — the live run always priced a 5-yr prepay)',
  'interest-only, escrow-waiver, 2–4 units (NOT measured)',
];

module.exports = { buildDeephavenGrid, LP_TABLES, UNMEASURED, _internals: { cost } };
