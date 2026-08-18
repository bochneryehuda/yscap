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

// ---- §2b THE MAX-LTV GRID — INDEPENDENTLY TRANSCRIBED, DELIBERATELY A SECOND COPY ----------------
//
// WHAT WAS WRONG (R10 divergence B, measured 2026-08-17). This layer's eligibility envelope was three
// FLAT rules — max LTV 80, DSCR<1.00 → 75, DSCR<1.00 & FICO<700 → 70 — plus a single flat min FICO of
// 640. The real matrix is a FOUR-AXIS grid: loan TIER × FICO floor × purpose × DSCR band. So this layer
// knew nothing about the tiers, and on a $1.75M or $2.25M loan it priced cells the matrix refuses:
// re-measured over a 1,152-cell sweep, **164 divergences, every single one in the same direction — this
// layer ELIGIBLE where Layer 2 declines.** The dominant causes are exactly the two the grid encodes:
// the per-tier FICO FLOORS (T2/T3 require 660, this layer only ever checked 640) and the tier-aware LTV
// caps (T2/T3 drop to 65/70/60).
//
// WHY A SECOND COPY IS THE RIGHT ANSWER HERE, when this repo's standing rule is "one definition, never a
// second copy". The two layers exist to CATCH EACH OTHER: Layer 1 is the rate sheet transcribed from the
// vendor's Excel, Layer 2 is the eligibility matrix transcribed from the published product matrix, and
// the whole point of keeping them independent is that a transcription error in one is caught by the
// other. Importing Layer 2's `GRID` here would collapse them into one source and destroy that property —
// a typo would simply be agreed with, twice. So this is transcribed AGAIN, from the matrix, in a
// DIFFERENT SHAPE (explicit half-open FICO ranges here; descending floors + "highest floor met" there),
// which is what makes the drift test a real check rather than a tautology: two different shapes that must
// still produce the same verdict on every cell. `scripts/test-lt-ppe-l1-l2-ltv-grid.js` sweeps the whole
// space and fails on ANY disagreement, in EITHER direction.
//
// UNITS: fico RAW, ltv MILLI-percent (80% → 80000), dscr MILLI (1.00 → 1000), loan RAW dollars.
// A `null` cap is the matrix's own N/A — INELIGIBLE at any LTV, never a guessed cap.
// FICO ranges are HALF-OPEN [min, max) so a score can never fall in two rows (this repo's stated
// defense against the classic "740 is in two bands" bug); `max: null` = no upper bound.
const SHEET_LTV_GRID = [
  { tier: 'T1', loanMinExclusive: null, loanMax: 1500000, tierMinFico: 640, rows: [
    { fico: [720, null], purchase_ge1: 80, cashout_ge1: 80, purchase_lt1: 75,   cashout_lt1: 70 },
    { fico: [700, 720],  purchase_ge1: 80, cashout_ge1: 75, purchase_lt1: 75,   cashout_lt1: 65 },
    { fico: [680, 700],  purchase_ge1: 75, cashout_ge1: 75, purchase_lt1: 70,   cashout_lt1: 65 },
    { fico: [640, 680],  purchase_ge1: 70, cashout_ge1: 70, purchase_lt1: null, cashout_lt1: null },
  ] },
  { tier: 'T2', loanMinExclusive: 1500000, loanMax: 2000000, tierMinFico: 660, rows: [
    { fico: [700, null], purchase_ge1: 80, cashout_ge1: 75, purchase_lt1: 70,   cashout_lt1: 65 },
    { fico: [680, 700],  purchase_ge1: 75, cashout_ge1: 75, purchase_lt1: 65,   cashout_lt1: 65 },
    { fico: [660, 680],  purchase_ge1: 65, cashout_ge1: 65, purchase_lt1: null, cashout_lt1: null },
  ] },
  { tier: 'T3', loanMinExclusive: 2000000, loanMax: 2500000, tierMinFico: 660, rows: [
    { fico: [700, null], purchase_ge1: 70, cashout_ge1: 70, purchase_lt1: 60,   cashout_lt1: 60 },
    { fico: [660, 700],  purchase_ge1: 65, cashout_ge1: 65, purchase_lt1: null, cashout_lt1: null },
  ] },
];

// The loan-tier predicate. `loanMinExclusive` is EXCLUSIVE and `loanMax` INCLUSIVE, matching the
// matrix's own half-open-by-dollar tiering (T1 loan<=1.5M, T2 1.5M<loan<=2.0M, T3 2.0M<loan<=2.5M), so
// a loan of exactly $1,500,000 is T1 in both layers rather than falling into two tiers or neither.
const tierPredicate = (t) => (t.loanMinExclusive == null
  ? [{ fact: 'loan_amount', op: 'lte', value: t.loanMax }]
  : [{ fact: 'loan_amount', op: 'gt', value: t.loanMinExclusive }, { fact: 'loan_amount', op: 'lte', value: t.loanMax }]);

// The FICO row predicate — half-open [min, max).
const ficoPredicate = (r) => (r.fico[1] == null
  ? [{ fact: 'fico', op: 'gte', value: r.fico[0] }]
  : [{ fact: 'fico', op: 'gte', value: r.fico[0] }, { fact: 'fico', op: 'lt', value: r.fico[1] }]);

// Purpose CLASS. The matrix has two columns — cash-out, and everything else (purchase / rate-term) — so
// the non-cash-out side is expressed as "not cashout" rather than by listing purposes: a purpose we have
// not seen must fall on the SAME side the matrix puts it, and the matrix's own column is the residual.
const purposePredicate = (pc) => [{ fact: 'purpose', op: pc === 'cashout' ? 'eq' : 'neq', value: 'cashout' }];
const dscrBandPredicate = (band) => [{ fact: 'dscr', op: band === 'ge1' ? 'gte' : 'lt', value: 1000 }];

/**
 * Compile SHEET_LTV_GRID into this layer's eligibility rules. Two kinds come out of each cell:
 *   • an N/A cell  → a decline on the cell alone (ineligible at ANY leverage);
 *   • a real cap   → a decline when the scenario's LTV exceeds it.
 * Plus one per-tier minimum-FICO decline for the tiers that have a floor above the program's own 640.
 *
 * Every rule can only ever DECLINE, so adding them can only ever TIGHTEN this layer — it is structurally
 * incapable of making a loan eligible that was not. That is what makes it safe to land beside the
 * existing flat envelope rules rather than replacing them: those stay as a backstop for a scenario whose
 * loan amount is absent, where no tier predicate can fire at all (the rules engine fails SAFE to false on
 * a missing fact, so without them such a scenario would have NO leverage cap).
 */
function ltvGridEligibility() {
  const out = [];
  for (const t of SHEET_LTV_GRID) {
    if (t.tierMinFico > 640) {
      out.push({
        code: `dhvn_min_fico_${t.tier.toLowerCase()}`,
        dimension: 'fico',
        declineReason: `Loan > $${(t.loanMinExclusive / 1000000).toFixed(1)}MM: Min FICO ${t.tierMinFico}`,
        predicate: { all: [...tierPredicate(t), { fact: 'fico', op: 'lt', value: t.tierMinFico }] },
      });
    }
    for (const r of t.rows) {
      for (const pc of ['purchase', 'cashout']) {
        for (const band of ['ge1', 'lt1']) {
          const cap = r[`${pc}_${band}`];
          const where = [...tierPredicate(t), ...ficoPredicate(r), ...purposePredicate(pc), ...dscrBandPredicate(band)];
          const who = `${t.tier} FICO ${r.fico[0]}${r.fico[1] == null ? '+' : `–${r.fico[1] - 1}`}, ${pc === 'cashout' ? 'cash-out' : 'purchase/rate-term'}, DSCR ${band === 'ge1' ? '>= 1.00' : '< 1.00'}`;
          if (cap == null) {
            // NO `dimension`, DELIBERATELY. This cell is refused whatever the LTV, so its predicate
            // names no constraint fact to read one from — and the harness's own discipline is that a
            // rule with no single dimension is surfaced as UNKNOWN, never given a guessed one. Calling
            // it `ltv` ("a max-LTV of nothing") is arguable and is exactly the guess this refuses.
            // MEASURED, not assumed: leaving it off does NOT reach the rule as null — deephaven-grid's
            // sheet converter defaults a dimension-less ineligibility to the literal `'eligibility'`.
            // ratesheet.ineligibilityToRule is where that placeholder becomes an honest null, and the
            // reason it must is written there.
            out.push({ code: `dhvn_na_${t.tier.toLowerCase()}_${r.fico[0]}_${pc}_${band}`, declineReason: `Not eligible: ${who}`, predicate: { all: where } });
          } else {
            out.push({ code: `dhvn_ltv_${t.tier.toLowerCase()}_${r.fico[0]}_${pc}_${band}`, dimension: 'ltv', declineReason: `Max LTV/CLTV ${cap}%: ${who}`, predicate: { all: [...where, { fact: 'ltv', op: 'gt', value: cap * 1000 }] } });
          }
        }
      }
    }
  }
  return out.concat(OVERLAY_ELIGIBILITY);
}

// ---- §2c THE SIX OVERLAYS THIS LAYER NEVER CARRIED ----------------------------------------------
//
// The Max-LTV grid was not the only thing missing. Layer 2 enforces SIX further matrix overlays that
// this layer had NO equivalent for at all, so a scenario touching any of them priced here while the
// matrix refused it. They were found by the drift sweep, not by reading: the first sweep held units=1,
// no subordinate lien, no interest-only, a SingleFamily property and no cash-out amount, so five of the
// six could not fire and the sixth (the small-loan cap) needed a loan under $125,000, which the coarse
// reproduction never reached — a sweep that does not VARY a fact cannot prove anything about it, which
// is why the drift test now varies every one of them and asserts that it does.
//
// Transcribed independently from the matrix, same discipline as the grid above: each can only DECLINE,
// so it can only tighten this layer. Units are the engine's: ltv MILLI-percent, dscr MILLI, dollars raw.
const OVERLAY_ELIGIBILITY = [
  // Small-loan LTV reduction. Note this is a SEPARATE cut from the grid cap and is the more restrictive
  // of the two wherever it fires — a $100k loan at 79% is inside its grid cell and still refused here.
  { code: 'dhvn_small_loan_ltv', dimension: 'ltv', declineReason: 'Loan < $125,000: Max LTV 75%',
    predicate: { all: [{ fact: 'loan_amount', op: 'lt', value: 125000 }, { fact: 'ltv', op: 'gt', value: 75000 }] } },
  // Interest-only overlay — its own leverage cap AND its own DSCR floor, both stricter than the program's.
  { code: 'dhvn_io_max_ltv', dimension: 'ltv', declineReason: 'Interest-Only: Max LTV 80%',
    predicate: { all: [{ fact: 'interest_only', op: 'eq', value: true }, { fact: 'ltv', op: 'gt', value: 80000 }] } },
  { code: 'dhvn_io_min_dscr', dimension: 'dscr', declineReason: 'Interest-Only: Min DSCR 1.00x',
    predicate: { all: [{ fact: 'interest_only', op: 'eq', value: true }, { fact: 'dscr', op: 'lt', value: 1000 }] } },
  // Cash-out proceeds caps — the limit steps DOWN as leverage rises, so both halves are needed; encoding
  // only the higher one would let a $900k cash-out through at 80% LTV.
  { code: 'dhvn_cashout_le65', dimension: 'cashout', declineReason: 'Max Cash-Out $1,000,000 (LTV <= 65%)',
    predicate: { all: [{ fact: 'purpose', op: 'eq', value: 'cashout' }, { fact: 'ltv', op: 'lte', value: 65000 }, { fact: 'cashout_amount', op: 'gt', value: 1000000 }] } },
  { code: 'dhvn_cashout_gt65', dimension: 'cashout', declineReason: 'Max Cash-Out $500,000 (LTV > 65%)',
    predicate: { all: [{ fact: 'purpose', op: 'eq', value: 'cashout' }, { fact: 'ltv', op: 'gt', value: 65000 }, { fact: 'cashout_amount', op: 'gt', value: 500000 }] } },
  // Subordinate financing is not allowed at all on this program (matrix R40).
  { code: 'dhvn_subordinate', dimension: 'subordinate_amount', declineReason: 'Subordinate Financing not allowed',
    predicate: { fact: 'subordinate_amount', op: 'gt', value: 0 } },
  // 5+ units — the program is 1–4 units plus condominiums.
  { code: 'dhvn_units_5plus', dimension: 'units', declineReason: '5+ units ineligible (program is 1–4 units + condos)',
    predicate: { fact: 'units', op: 'gte', value: 5 } },
  // Row Homes. Matched on the LP property-type vocabulary, the same spellings Layer 2 normalizes to; an
  // unrecognized label no-ops in BOTH layers — neither may disqualify on a name it does not know.
  { code: 'dhvn_row_home', dimension: 'property_type', declineReason: 'Row Homes ineligible',
    predicate: { fact: 'property_type', op: 'in', value: ['RowHome', 'Row Home', 'RowHouse', 'Row House', 'rowhome', 'rowhouse'] } },
];
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
    // WHICH FRAME THESE PRICES ARE IN, DECLARED — not left to a paragraph.
    //
    // The owner's rule is "LP = the investor's sheet MINUS our 0.25 holdback", and this ladder is
    // deliberately on the LP-MEASURED side of that subtraction, because LP's frame is the one the
    // composed price is compared in. So the holdback is ALREADY INSIDE these numbers.
    //
    // Since 2026-08-18 `pricing.priceRung` also SUBTRACTS the holdback from the price, on the owner's
    // written direction. Each half is right; together they take it off twice, and a configured 0.25
    // puts every quote 0.25 BELOW what Lender Price shows (reproduced: 105.175 -> 104.925). It is
    // latent only because no holdback is configured for this program today.
    //
    // The prices could not carry that fact, so nothing could check it — the frame lived in prose in
    // two files while the numbers travelled alone. It travels with them now, and `quote.js` REFUSES to
    // price rather than quote a number that is knowably 0.25 wrong.
    priceFrame: 'lp_post_holdback',
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
      { code: 'dhvn_min_fico', dimension: 'fico', declineReason: 'Min FICO 640', predicate: { fact: 'fico', op: 'lt', value: 640 } },
      // DO NOT DELETE THIS ON THE STRENGTH OF THE §2b GRID. It OVERLAPS the grid's N/A cells — every N/A
      // cell is a DSCR < 1.00 cell, and four of the six span FICO ranges entirely below 680 — so the two
      // encodings agree and no end-to-end sweep can tell them apart there (measured: mutating a T1 or T2
      // N/A cell to a real cap leaves the drift test green; only T3's cell, which reaches FICO 680–699,
      // is observable). Redundancy that agrees is fine; deleting one because the suite stays green is how
      // the rule is lost. The N/A mechanism is proven directly, per cell, in the drift test's §6b.
      { code: 'dhvn_min_fico_lt100', dimension: 'fico', declineReason: 'DSCR < 1.00: Min FICO 680', predicate: { all: [{ fact: 'dscr', op: 'lt', value: 1000 }, { fact: 'fico', op: 'lt', value: 680 }] } },
      { code: 'dhvn_max_ltv', dimension: 'ltv', declineReason: 'Max LTV/CLTV 80%', predicate: { fact: 'ltv', op: 'gt', value: 80000 } },
      { code: 'dhvn_max_ltv_lt100', dimension: 'ltv', declineReason: 'DSCR < 1.00: Max LTV 75%', predicate: { all: [{ fact: 'dscr', op: 'lt', value: 1000 }, { fact: 'ltv', op: 'gt', value: 75000 }] } },
      { code: 'dhvn_max_ltv_lt100_weakfico', dimension: 'ltv', declineReason: 'DSCR < 1.00, FICO < 700: Max LTV 70%', predicate: { all: [{ fact: 'dscr', op: 'lt', value: 1000 }, { fact: 'fico', op: 'lt', value: 700 }, { fact: 'ltv', op: 'gt', value: 70000 }] } },
      { code: 'dhvn_min_dscr', dimension: 'dscr', declineReason: 'Minimum DSCR 0.75', predicate: { fact: 'dscr', op: 'lt', value: 750 } },
      // MIN LOAN is DSCR-GATED (owner/R10 2026-08-17): the flat $75k min ignored DSCR, so a $150k /
      // DSCR-0.90 loan PRICED when the matrix says it must decline. Split to mirror Layer-2
      // (deephaven-matrix MIN_LOAN_DSCR_GE1/LT1) EXACTLY — $75k for DSCR>=1.00, $200k for DSCR<1.00 —
      // including the fail-safe when DSCR is absent (neither branch fires, same as the matrix's
      // `dscr >= 1000` / `dscr < 1000` guards), so the two layers can never disagree on min-loan.
      { code: 'dhvn_min_loan_ge1', dimension: 'loan_amount', declineReason: 'Minimum Loan Amount $75,000 (DSCR >= 1.00x)', predicate: { all: [{ fact: 'dscr', op: 'gte', value: 1000 }, { fact: 'loan_amount', op: 'lt', value: 75000 }] } },
      { code: 'dhvn_min_loan_lt1', dimension: 'loan_amount', declineReason: 'Minimum Loan Amount $200,000 (DSCR < 1.00x)', predicate: { all: [{ fact: 'dscr', op: 'lt', value: 1000 }, { fact: 'loan_amount', op: 'lt', value: 200000 }] } },
      { code: 'dhvn_max_loan', dimension: 'loan_amount', declineReason: 'Maximum Loan Amount $2.5MM', predicate: { fact: 'loan_amount', op: 'gt', value: 2500000 } },
      // §2b — the 4-axis Max-LTV grid + per-tier FICO floors (R10 divergence B). Every rule here can
      // only DECLINE, so this can only tighten; the flat rules above stay as the no-loan-amount backstop.
      ...ltvGridEligibility(),
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
  'the PREPAY LLPA family (6 terms × LLPA Other / LLPA 5% Fixed) — NOW BUILT, in the sibling module deephaven-dscr-prepay-maxprice.js. It is deliberately NOT merged into THIS grid: call buildPrepayMaxPriceGrid() to get the base sheet extended with it, so a caller chooses the 30-day / 3-year baseline sheet or the full one, and there is still only ONE base ladder',
  'MAX-PRICE caps — per prepay term AND the loan-amount tiers (105 / 104.5 / 103.5) with the 98.000 floor and the sheet\'s "lower of the two" rule — NOW BUILT in deephaven-dscr-prepay-maxprice.js (maxPriceFor / priceLimitFor). Not in this grid; see the note above',
  'LOCK-TERM (45/60) and EXTENSION pricing — NOW BUILT in deephaven-dscr-prepay-maxprice.js. The lock term is priced there on a `lock_term_days` fact (this grid publishes one base ladder, at 30 days, and `lock_days` is the engine\'s rung-selection key); the EXTENSION table is resolved + validated but deliberately NOT priced, because the sheet does not state how it composes with the lock-term adjustment',
  'the sheet\'s Foreign National row — a borrower TYPE, not a FICO band; there is no fact to key it on, so it is not encoded (would need a foreign_national dimension)',
  'non-warrantable on a non-condo (SFR) — the NW line was measured only on a condo',
  'Short-Term Rental: the VALUES are the sheet\'s, but Lender Price\'s own adjType/reason for this family is UNCONFIRMED (never measured live), so the agreement harness may surface it as a one-sided difference until a live probe pins the LP shape',
  'BASE LADDER — ANSWERED (owner 2026-08-17), and it is the same answer for every price on this sheet: "Lender Price max price is already after our 0.25 holdback … this is across the board." The sheet carries the INVESTOR\'s pre-holdback numbers and Lender Price shows the POST-holdback view, so LP = sheet − our margin holdback. Our BASE stays on the LP-measured values (it is the frame the composed price is compared in) and the 0.25 gap at all 28 coupons is now EXPLAINED, not unexplained — proven to the milli-point in test-lt-ppe-deephaven-dscr-prepay-maxprice.js §6. WIRING — CORRECTED 2026-08-18 (see parity doc 2.69): quote.js DOES subtract the holdback now, and this ladder did NOT move, so the two together took it off twice. The grid therefore DECLARES its frame (priceFrame lp_post_holdback, above) and quote.js refuses to price this sheet with a holdback rather than quoting 0.25 below Lender Price. Moving this ladder onto the sheet\'s own pre-holdback numbers is still the other way out, and is the owner\'s call',
  'PRICE ROUNDING: the program falls back to the pricer default of nearest-1/8, but LP\'s own quotes are NOT eighth-rounded (105.175 and 105.675 are not multiples of 0.125), so the rounded price cannot tie out to LP. The rate sheet says nothing about rounding, so nothing is invented here — the sheet\'s composed price (rawPriceMilli) is what agrees with LP to the penny, and the agreement harness must compare on that until the real rounding rule is confirmed',
];

// SHEET_LTV_GRID + ltvGridEligibility are exported for the L1↔L2 drift test ONLY — it asserts the
// transcription's own shape (contiguous half-open FICO rows, partitioned loan tiers) as well as the
// verdicts. Nothing in production may read them to SHORT-CIRCUIT the mirror: the two layers must stay
// independently transcribed, or the drift test becomes a tautology (see §2b).
module.exports = { buildDeephavenGrid, SHEET_TABLES, LP_TABLES, UNMEASURED, _internals: { cost, SHEET_LTV_GRID, ltvGridEligibility } };
