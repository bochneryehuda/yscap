'use strict';
/**
 * LT PPE — OUR INDEPENDENT-ANALYSIS Deephaven DSCR sheet, encoded from the LIVE Lender Price
 * reconstruction (docs/longterm/ppe-research/LP-DEEPHAVEN-DSCR-LIVE-TABLES.md, sheet v12.7.25). This is
 * the SHEET-UNDER-TEST for the ≥200-scenario agreement gate — it is NOT wired into the live pricer and
 * is NEVER trusted until the agreement harness proves it matches Lender Price to the penny (owner HARD
 * RULE 2026-08-17). buildDeephavenGrid() → a deephaven-grid.gridToRateSheet input.
 *
 * ⛔ THE SIGN — a money rule, and the one this sheet got WRONG until 2026-08-17. READ THIS BEFORE
 * TOUCHING A NUMBER.
 *
 * Lender Price DISPLAYS an itemized LLPA as an ABSOLUTE MAGNITUDE — its screen does NOT carry the
 * direction. The DIRECTION lives on the rate sheet, and ONLY on the rate sheet. This sheet was
 * originally reconstructed from LP's displayed values and then negated uniformly (`cost(v) = -v`),
 * which encoded every genuine CREDIT as a CHARGE (wrong by TWICE its value) and got every genuine
 * CHARGE right only by accident. Proven live: at FICO 760 / CLTV 50% / NY / coupon 7.500 LP reports
 * `adjustmentPoints = -0.5`, which is exactly `-(0.875 credit) + (0.375 NY charge)` — the 0.875 is a
 * CREDIT, and we had it as a charge. Likewise DSCR ≥ 1.25 IMPROVES the price by 0.25; we charged 0.25.
 *
 * SO: the SOURCE OF TRUTH IS THE EXCEL, never LP's displayed magnitudes —
 * `docs/longterm/ppe-research/matrices/deephaven-dscr-ratesheet-corr-t0.json`, extracted verbatim.
 * That sheet is PREMIUM-POSITIVE (a positive value IMPROVES the price), which is exactly what
 * deephaven-grid.gridToRateSheet expects, so **an Excel cell maps DIRECTLY onto a grid cell with NO
 * negation**. Every `SHEET_*` table below is the JSON's own signed value, cell for cell.
 *
 * The full chain, so it can be checked rather than trusted: sheet value V → deephaven-grid
 * `priceAdjMilli(V) = -V` → engine `adjMilli` → `costMilli = adjMilli` → `price = base - Σ costMilli`.
 * Therefore `price = base + Σ V`: a POSITIVE V raises the price. A credit is positive; a charge is
 * negative. TEST ON THE PRICE, NEVER ON THE MAGNITUDE — the magnitudes matched while the signs did
 * not, which is precisely why the old suite passed on a sheet that mispriced every strong-credit loan.
 *
 * SCOPE — the FULLY-CONFIRMED core plus the CLTV-segmented add-ons, each value re-derived directly from
 * the captured live battery (never guessed):
 *   • base-price ladder (coupon → basePoints), 28 coupons;
 *   • the DSCR-INDEPENDENT FICO×CLTV grid (`DSCR (All)`);
 *   • the SEPARATE additive DSCR-band table (≥1.25 flat; 1.00–1.24 baseline 0; <1.00 CLTV-segmented);
 *   • the flat DC/MA/NJ/NY state adder;
 *   • §7 cash-out refinance (split at FICO 720), condo, and 2–4 units — all CLTV-segmented;
 *   • interest-only, escrow-waiver, non-warrantable (which REPLACES the condo line), and the 2D
 *     loan-amount table (>2M / >1.5M / <250k / <150k / <125k × CLTV);
 *   • Short-Term Rental (rental-type row) — added 2026-08-17 from the sheet.
 * DELIBERATELY OMITTED (never guessed — see UNMEASURED): the loan-amount / cash-out / STR n/e cells
 * (inferred LTV caps, not encoded as eligibility overlays), the prepay-structure LLPA and the max-price
 * caps / lock + extension pricing (all present in the JSON but a SEPARATE build — see UNMEASURED), the
 * sheet's Foreign National row (a borrower-type dimension, not a FICO band — no fact to key it on), and
 * non-warrantable on a non-condo. The harness honestly reports a "missing on our side" for any of these.
 *
 * LT-only. No RTL imports, no network, no DB.
 */

// Sheet (premium-positive) → the LP-frame magnitude LP would DISPLAY for the same cell. Retained only
// to derive the deprecated LP_TABLES view below and to state the relationship in one place; it is NOT
// applied to any cell any more — a sheet value goes into the grid untouched.
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
// §4 cells — VERBATIM from the rate sheet (matrices/deephaven-dscr-ratesheet-corr-t0.json,
// `priceAdjustmentsFicoByCltv`), PREMIUM-POSITIVE: + IMPROVES the price, − WORSENS it. Rows = FICO band
// above, cols = CLTV band above. `null` = the sheet's own "N/A" (an ineligibility, never a priced 0).
// A strong file at low leverage earns a CREDIT and a weak file at high leverage pays a CHARGE — the
// sign flips left-to-right and top-to-bottom, which is the shape the old all-positive encoding lost.
// The sheet's 9th row (Foreign National) is deliberately NOT here: it is a borrower TYPE, not a FICO
// band, and there is no fact to key it on. See UNMEASURED.
const SHEET_FICO_CLTV = [
  [1.000, 0.750, 0.625, 0.500, 0.125, -0.250, -0.750],  // 780+
  [0.875, 0.750, 0.625, 0.500, 0.125, -0.250, -1.125],  // 760–779
  [0.750, 0.625, 0.500, 0.375, -0.125, -0.500, -1.500], // 740–759
  [0.625, 0.500, 0.375, 0.125, -0.375, -0.875, -1.875], // 720–739
  [0.250, 0.125, 0.000, -0.250, -1.000, -1.500, -2.625],// 700–719
  [0.000, -0.250, -0.500, -0.750, -1.625, -2.500, null],// 680–699
  [-0.500, -0.750, -1.000, -1.250, -2.125, -3.750, null],// 660–679
  [-2.500, -2.750, -3.000, -3.375, -3.875, null, null], // 640–659
];

// ---- §5 DSCR-band add-on (SEPARATE additive; dscr fact is MILLI: 1.25 → 1250, 1.00 → 1000) --------
// Sheet block `priceAdjustmentsDscr`, PREMIUM-POSITIVE. A strong DSCR is a CREDIT: ≥1.25 is +0.25 flat
// across every CLTV, which IMPROVES the price — proven live (DSCR 1.30 → 105.925 vs DSCR 1.20 →
// 105.675, i.e. 0.25 BETTER). This is the row the old encoding had exactly backwards as a 0.25 charge.
const SHEET_DSCR_GE125 = 0.25;
// The sheet labels its middle row "1.15 – 1.24" and lists no row at all for 1.00–1.14, but LP's own
// container is "1.00-1.24" and a live probe at DSCR 1.10 priced IDENTICALLY to 1.20 — so the whole
// 1.00–1.24 span is the 0 baseline and carries no entry. Measured, not assumed.
const SHEET_DSCR_LT100_BY_CLTV = [
  { cltv: { min: null, max: 50.5 }, sheet: -0.750 },
  { cltv: { min: 50.5, max: 55.5 }, sheet: -0.875 },
  { cltv: { min: 55.5, max: 60.5 }, sheet: -1.000 },
  { cltv: { min: 60.5, max: 65.5 }, sheet: -1.250 },
  { cltv: { min: 65.5, max: 70.5 }, sheet: -1.500 },
  { cltv: { min: 70.5, max: 75.5 }, sheet: -2.000 },
  // 75–80 for DSCR<1.00 is the sheet's own "N/A" (eligibility caps LTV at ≤75%) — no priced entry.
];
const cltvMilliPredicate = (cb) => ({ fact: 'ltv', op: 'between', value: [cb.min == null ? 0 : cb.min * 1000, (cb.max == null ? 100 : cb.max) * 1000] });

// ---- §7 add-on LLPAs, CLTV-segmented — VERBATIM from the rate sheet's `priceAdjustmentsOther` block,
// PREMIUM-POSITIVE (− WORSENS the price). Every one of these families is a CHARGE on the sheet, which is
// why the old uniformly-negated encoding happened to produce the right number here while the FICO grid
// and the DSCR row were wrong. Each aligns index-for-index with CLTV_BANDS (50/55/60/65/70/75/80).
// A 0 emits NO adjustment (the sheet has no charge in that band); `null` = the sheet's own "N/A"
// (an eligibility cap, no priced entry — never a guessed 0). ---------------------------------------
const SHEET_CASHOUT_GE720 = [0, -0.125, -0.250, -0.250, -0.500, -0.875, -2.625]; // "Cash-Out | FICO ≥ 720"
const SHEET_CASHOUT_LT720 = [-0.250, -0.375, -0.375, -0.500, -0.750, -1.000, null]; // "Cash-Out | FICO < 720"; 80% N/A
const SHEET_CONDO = [0, 0, 0, -0.125, -0.125, -0.250, -0.500];              // "Condo" (AllCondoRateAdjustment)
const SHEET_UNITS = [-0.250, -0.250, -0.500, -0.500, -0.750, -1.000, -1.500]; // "2-4 Units" (UnitRateAdjustment)
const SHEET_IO = [-0.250, -0.250, -0.250, -0.500, -0.625, -0.750, -1.250];   // "Interest Only"
const SHEET_ESCROW = [-0.250, -0.250, -0.250, -0.250, -0.250, -0.250, -0.250]; // "Escrow Waiver" (flat −0.25)
const SHEET_NONWARR = [-0.750, -0.750, -0.750, -0.750, -0.750, -1.000, -1.000]; // "Non-Warrantable" (REPLACES Condo)
// "Rental Type — Short-Term Rental": a flat −0.5 charge across CLTV, N/A at 80%. On the sheet and never
// encoded until now. Keyed on the established `short_term_rental` boolean fact (advanced-facts.js), the
// same fact Layer-2's overlay rules already read, so the two layers cannot disagree about what STR means.
const SHEET_SHORT_TERM_RENTAL = [-0.500, -0.500, -0.500, -0.500, -0.500, -0.500, null];
// Loan-amount is 2D (tier × CLTV); tiers are mutually exclusive (most-specific fires). 0 = a real zero
// band (no line); null = the sheet's own "N/A" (an INFERRED LTV cap, left unpriced).
const SHEET_LOANAMT_GT_1_5M = [0, 0, 0, -0.125, -0.250, -0.250, -0.250];     // "> 1,500,000" (1.5M < loan <= 2.0M)
const SHEET_LOANAMT_GT_2_0M = [-0.250, -0.250, -0.375, -0.500, -0.500, null, null]; // "> 2,000,000" (75/80 N/A)
// "< 250,000": zero in every band EXCEPT 80% CLTV (−0.125). On the sheet and never encoded until now;
// it is the 150k–250k tier, sitting directly above the existing < 150,000 tier.
const SHEET_LOANAMT_LT_250K = [0, 0, 0, 0, 0, 0, -0.125];                    // "< 250,000" (150k <= loan < 250k)
const SHEET_LOANAMT_LT_150K = [-1.250, -1.250, -1.250, -1.500, -1.500, -1.500, -1.750]; // "< 150,000" (125k–150k)
const SHEET_LOANAMT_LT_125K = [-1.750, -1.750, -2.000, -2.250, -2.250, -2.500, null];   // "< 125,000" (80 N/A)
// "State**" — DC / MA / NJ / NY, flat. Sheet footnote O41.
const SHEET_STATE = -0.375;
const cltvBandLabel = (cb) => (cb.min == null ? 'CLTV To 50.0%' : `CLTV ${cb.min - 0.5}–${cb.max - 0.5}%`);

function buildDeephavenGrid() {
  const dscrTables = [];
  // ≥1.25 — a CREDIT of +0.25 flat across every CLTV (it IMPROVES the price).
  dscrTables.push({ dimension: 'dscr', code: 'dhvn_dscr_ge125', reason: 'DSCR Ratio - DSCR >= 1.25', predicate: { fact: 'dscr', op: 'gte', value: 1250 }, adj: SHEET_DSCR_GE125 });
  // <1.00, CLTV-segmented — charges.
  for (const seg of SHEET_DSCR_LT100_BY_CLTV) {
    dscrTables.push({
      dimension: 'dscr', code: `dhvn_dscr_lt100_${seg.cltv.min == null ? 'to' : seg.cltv.min}`,
      reason: `DSCR Ratio - DSCR < 1.00 / CLTV ${seg.cltv.min == null ? '<= 50' : seg.cltv.min + '–' + seg.cltv.max}`,
      predicate: { all: [{ fact: 'dscr', op: 'lt', value: 1000 }, cltvMilliPredicate(seg.cltv)] }, adj: seg.sheet,
    });
  }

  // §7 add-on LLPAs — cash-out (split at FICO 720), condo, and 2–4 units, each CLTV-segmented. A 0 or
  // null band emits NOTHING (LP itemizes no line there), so a non-add-on scenario is untouched.
  const addonTables = [];
  CLTV_BANDS.forEach((cb, i) => {
    const co720 = SHEET_CASHOUT_GE720[i];
    if (co720) addonTables.push({ dimension: 'cashout', code: `dhvn_cashout_ge720_${i}`, reason: `Other - Cash Out Refinance, FICO >= 720 / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'purpose', op: 'eq', value: 'cashout' }, { fact: 'fico', op: 'gte', value: 720 }, cltvMilliPredicate(cb)] }, adj: co720 });
    const coLt = SHEET_CASHOUT_LT720[i];
    if (coLt) addonTables.push({ dimension: 'cashout', code: `dhvn_cashout_lt720_${i}`, reason: `Other - Cash Out Refinance, FICO < 720 / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'purpose', op: 'eq', value: 'cashout' }, { fact: 'fico', op: 'lt', value: 720 }, cltvMilliPredicate(cb)] }, adj: coLt });
    const condo = SHEET_CONDO[i];
    // condo is gated on non_warrantable != true: a NON-warrantable condo emits the Non-Warrantable line
    // INSTEAD of the plain Condo line (measured — LP suppresses the Condo line there). lpScenarioToFacts
    // always emits non_warrantable (false/true), so a warrantable condo (false) still fires this line.
    if (condo) addonTables.push({ dimension: 'property_type', code: `dhvn_condo_${i}`, reason: `Other - Condo / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'property_type', op: 'in', value: ['Condo', 'Condos'] }, { fact: 'non_warrantable', op: 'neq', value: true }, cltvMilliPredicate(cb)] }, adj: condo });
    const units = SHEET_UNITS[i];
    if (units) addonTables.push({ dimension: 'units', code: `dhvn_units_${i}`, reason: `Other - 2-4 Units / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'units', op: 'gte', value: 2 }, cltvMilliPredicate(cb)] }, adj: units });
    // ── Interest Only, Escrow Waiver, Non-Warrantable, Short-Term Rental, Loan amount. A 0 or null band
    //    emits NOTHING, so a scenario carrying none of these is untouched. ──
    const io = SHEET_IO[i];
    if (io) addonTables.push({ dimension: 'interest_only', code: `dhvn_io_${i}`, reason: `Other - Interest Only / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'interest_only', op: 'eq', value: true }, cltvMilliPredicate(cb)] }, adj: io });
    const ew = SHEET_ESCROW[i];
    if (ew) addonTables.push({ dimension: 'escrow_waiver', code: `dhvn_escrow_${i}`, reason: `Other - Escrow Waiver / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'escrow_waiver', op: 'eq', value: true }, cltvMilliPredicate(cb)] }, adj: ew });
    const nw = SHEET_NONWARR[i];
    if (nw) addonTables.push({ dimension: 'non_warrantable', code: `dhvn_nonwarr_${i}`, reason: `Other - Non-Warrantable / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'non_warrantable', op: 'eq', value: true }, cltvMilliPredicate(cb)] }, adj: nw });
    // Short-Term Rental — the sheet's "Rental Type" row. Keyed on the shared `short_term_rental` fact.
    const str = SHEET_SHORT_TERM_RENTAL[i];
    if (str) addonTables.push({ dimension: 'short_term_rental', code: `dhvn_str_${i}`, reason: `Other - Short-Term Rental / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'short_term_rental', op: 'eq', value: true }, cltvMilliPredicate(cb)] }, adj: str });
    // loan-amount tiers — mutually exclusive by construction (the > 1.5M tier is bounded <= 2.0M):
    const la15 = SHEET_LOANAMT_GT_1_5M[i];
    if (la15) addonTables.push({ dimension: 'loan_amount', code: `dhvn_loanamt_gt15_${i}`, reason: `Loan Amount - > 1,500,000 / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'loan_amount', op: 'gt', value: 1500000 }, { fact: 'loan_amount', op: 'lte', value: 2000000 }, cltvMilliPredicate(cb)] }, adj: la15 });
    const la20 = SHEET_LOANAMT_GT_2_0M[i];
    if (la20) addonTables.push({ dimension: 'loan_amount', code: `dhvn_loanamt_gt20_${i}`, reason: `Loan Amount - > 2,000,000 / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'loan_amount', op: 'gt', value: 2000000 }, cltvMilliPredicate(cb)] }, adj: la20 });
    // "< 250,000" — the 150k–250k tier, zero everywhere except 80% CLTV.
    const la250 = SHEET_LOANAMT_LT_250K[i];
    if (la250) addonTables.push({ dimension: 'loan_amount', code: `dhvn_loanamt_lt250_${i}`, reason: `Loan Amount - < 250,000 / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'loan_amount', op: 'gte', value: 150000 }, { fact: 'loan_amount', op: 'lt', value: 250000 }, cltvMilliPredicate(cb)] }, adj: la250 });
    const la150 = SHEET_LOANAMT_LT_150K[i];
    if (la150) addonTables.push({ dimension: 'loan_amount', code: `dhvn_loanamt_lt150_${i}`, reason: `Loan Amount - < 150,000 / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'loan_amount', op: 'gte', value: 125000 }, { fact: 'loan_amount', op: 'lt', value: 150000 }, cltvMilliPredicate(cb)] }, adj: la150 });
    const la125 = SHEET_LOANAMT_LT_125K[i];
    if (la125) addonTables.push({ dimension: 'loan_amount', code: `dhvn_loanamt_lt125_${i}`, reason: `Loan Amount - < 125,000 / ${cltvBandLabel(cb)}`, predicate: { all: [{ fact: 'loan_amount', op: 'lt', value: 125000 }, cltvMilliPredicate(cb)] }, adj: la125 });
  });

  return {
    investor: 'DHVN', program: 'DSCR30', scale: 1000, lockDays: 30,
    terms: [{ key: '30F', product: '30 Yr Fixed' }],
    base: BASE.map(([coupon, basePoints]) => ({ coupon, prices: { '30F': 100 - basePoints } })),
    ficoCltvByDscr: [{
      dscr: { min: null, max: null }, // DSCR-INDEPENDENT ("DSCR (All)")
      ficoBands: FICO_BANDS,
      cltvBands: CLTV_BANDS,
      // The sheet's own signed cells, straight in — NO negation (see THE SIGN at the top of this file).
      cells: SHEET_FICO_CLTV.map((row) => row.slice()),
    }],
    llpaTables: [
      // §6 state adder — DC/MA/NJ/NY flat +0.375
      { dimension: 'state', code: 'dhvn_state', reason: 'Other - State of DC, MA, NJ, NY', predicate: { fact: 'state', op: 'in', value: ['DC', 'MA', 'NJ', 'NY'] }, adj: SHEET_STATE },
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

// THE SOURCE OF TRUTH, exported so the test asserts against the SHEET rather than re-deriving it.
// Every value here is the Excel's own signed cell (premium-positive: + improves the price).
const SHEET_TABLES = {
  BASE, FICO_BANDS, CLTV_BANDS,
  FICO_CLTV: SHEET_FICO_CLTV,
  DSCR_GE125: SHEET_DSCR_GE125,
  DSCR_LT100_BY_CLTV: SHEET_DSCR_LT100_BY_CLTV,
  CASHOUT_GE720: SHEET_CASHOUT_GE720, CASHOUT_LT720: SHEET_CASHOUT_LT720,
  CONDO: SHEET_CONDO, UNITS: SHEET_UNITS, IO: SHEET_IO, ESCROW: SHEET_ESCROW,
  NONWARR: SHEET_NONWARR, SHORT_TERM_RENTAL: SHEET_SHORT_TERM_RENTAL, STATE: SHEET_STATE,
  LOANAMT_GT_1_5M: SHEET_LOANAMT_GT_1_5M, LOANAMT_GT_2_0M: SHEET_LOANAMT_GT_2_0M,
  LOANAMT_LT_250K: SHEET_LOANAMT_LT_250K, LOANAMT_LT_150K: SHEET_LOANAMT_LT_150K,
  LOANAMT_LT_125K: SHEET_LOANAMT_LT_125K,
};

// DEPRECATED — the LP-frame MAGNITUDE view (what Lender Price would DISPLAY), derived from the sheet so
// the two can never drift. Kept only so an existing reader does not break; it carries NO direction, and
// asserting on it is exactly the mistake that let a mispriced sheet pass. Assert on the PRICE instead.
const LP_TABLES = {
  BASE, FICO_BANDS, CLTV_BANDS,
  FICO_CLTV_LP: SHEET_FICO_CLTV.map((row) => row.map(cost)),
  DSCR_LT100_BY_CLTV: SHEET_DSCR_LT100_BY_CLTV.map((s) => ({ cltv: s.cltv, lp: cost(s.sheet) })),
};

// What is deliberately NOT in this sheet (never guessed) — fill from a targeted re-measure battery.
const UNMEASURED = [
  'cash-out FICO<720 @ CLTV 80%, STR @ CLTV 80% (the sheet says N/A — an LTV cap; confirm before encoding as eligibility)',
  'loan-amount N/A cells: >$2.0M @ CLTV 75/80 and <$125k @ CLTV 80 (INFERRED LTV caps — >$2M→LTV<=70%, small-loan@80% declines — not yet encoded as eligibility overlays)',
  'the PREPAY LLPA family (6 terms × LLPA Other / LLPA 5% Fixed) — fully specified in the rate-sheet JSON (maxPricePrepayBuydown) but OUT OF SCOPE here: it is a separate build with the margin/adjustmentPoints layer',
  'MAX-PRICE caps — per prepay term AND the loan-amount tiers (105 / 104.5 / 103.5) with the 98.000 floor and the sheet\'s "lower of the two" rule — fully specified in the JSON, out of scope here',
  'LOCK-TERM (45/60) and EXTENSION pricing — fully specified in the JSON (termExtensionAdjustments); we price only the 30-day base, out of scope here',
  'the sheet\'s Foreign National row — a borrower TYPE, not a FICO band; there is no fact to key it on, so it is not encoded (would need a foreign_national dimension)',
  'non-warrantable on a non-condo (SFR) — the NW line was measured only on a condo',
  'Short-Term Rental: the VALUES are the sheet\'s, but Lender Price\'s own adjType/reason for this family is UNCONFIRMED (never measured live), so the agreement harness may surface it as a one-sided difference until a live probe pins the LP shape',
  'BASE LADDER: the sheet quotes 0.25 HIGHER than every live LP measurement at every coupon (e.g. 7.500 → sheet 105.425 vs LP 105.175). Our BASE is kept on the LP-measured values so the FINAL PRICE agrees with LP; the 0.25 is unexplained (likely Lender Paid Comp, per the sheet\'s own max-price note) and needs one business answer before the base is moved',
  'PRICE ROUNDING: the program falls back to the pricer default of nearest-1/8, but LP\'s own quotes are NOT eighth-rounded (105.175 and 105.675 are not multiples of 0.125), so the rounded price cannot tie out to LP. The rate sheet says nothing about rounding, so nothing is invented here — the sheet\'s composed price (rawPriceMilli) is what agrees with LP to the penny, and the agreement harness must compare on that until the real rounding rule is confirmed',
];

module.exports = { buildDeephavenGrid, SHEET_TABLES, LP_TABLES, UNMEASURED, _internals: { cost } };
