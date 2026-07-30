/* =====================================================================
   silver-program.js  —  "Silver Program" loan engine
   ---------------------------------------------------------------------
   Third YS Capital program, built as a structural sibling of the Standard
   Program engine. Source of truth for the
   guidelines/rates: the note buyer's RTL Seller Pricing & Eligibility Tool v1
   (June 2026 guideline version) — every tier cap, rate cell, band edge
   and eligibility check below is transcribed from that workbook
   (Tier Grid + the note buyer_Pricing Matrix + Underwriting Commentary + the
   hidden Engine tab), NOT copied from the Standard program.
   IMPORTANT brand & pricing rules, mirroring the other engines:
     • The source program / note-buyer name is NEVER exposed anywhere
       user-facing (same rule as the other engines). This file ships to the
       browser: keep every comment name-free. Borrower copy says "Silver Program".
     • The borrower NOTE RATE = the the note buyer grid rate + the YS markup
       (default 0.5%). The internal grid/buy rate is never returned.
       NOTE: the note buyer's buy rate is floored at (note rate − 1.00pt), so a
       markup above 1.00% is eaten by the note buyer, not earned.
     • Origination default 1.25% of the total loan (same as Standard).
   Distinct mechanics vs. the Standard Program (do not cross-wire):
     • Rates come from a fixed GRID keyed on
       market|size|product|purpose|term|tier|AR-LTV band|FICO band|LTC band
       — no additive build-up, no judicial/heavy adders.
     • Tiering depends on LOAN SIZE: ≤$2.5M needs 3+/1–2/0 comparable
       projects for Tier 1/2/3; over $2.5M needs 5+/2–4/<2.
     • GC-only experience caps the tier (T2 small / T3 large).
     • Markets: NYC five boroughs price on their own grid (no F&F refi,
       no loans over $2.5M there); everywhere else is "Standard market".
     • Geography excluded by ZIP/state: Philadelphia 191xx, Chicago
       606–608xx, Baltimore (8 zips), Detroit 481–483xx, NV, MN, ND, SD.
     • The after-repair value must EXCEED total project cost
       (value-add required — LTC must be greater than AR-LTV).
     • Fix & hold exit needs DSCR ≥ 1.00 when rent is known; refi
       cash-out is capped at 50% of projected project profit.
     • Terms 12 / 18 / 24 months; 18 needs a >$100k budget and 24 a
       >$200k budget on the F&F/F&H product.
   Interest reserve works EXACTLY like the Standard Program
   (owner-directed 2026-07-29): financed into the loan, part of the
   COST BASIS, capped at the full loan term.
   Reuses the shared loan-sizing math from standard-program.js
   (YSP.sizeLoan, YSP.normStrategy, YSP.exitShortfall) so all programs
   size identically off their own caps.
   Exposes window.SVP (browser) and module.exports (Node, for tests).
   ===================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./standard-program.js"));
  else root.SVP = factory(root.YSP);
}(typeof self !== "undefined" ? self : this, function (YSP) {
  "use strict";

  /* ---------------- program constants ---------------- */
  var MARKUP = 0.005;            // YS markup over the the note buyer grid rate (borrower pays grid + markup)
  var MARKUP_MAX = 0.01;         // hard cap (owner-directed 2026-07-29): the program's buy-rate floor is the note
                                 // rate minus 1.00pt, so any spread above 1 point is never earned — cap it here.
  var MARKUP_OVR = null;         // admin-set markup override (fraction); null = default; clamped to MARKUP_MAX
  function effMarkup() { var m = (MARKUP_OVR == null) ? MARKUP : MARKUP_OVR; return (m > MARKUP_MAX) ? MARKUP_MAX : m; }
  function setMarkup(f) { MARKUP_OVR = (typeof f === "number" && isFinite(f) && f >= 0) ? Math.min(f, MARKUP_MAX) : null; }
  var ORIG_PCT = 0.0125;         // 1.25% origination on the total loan (same as Standard)
  var MIN_LOAN = 100000;         // grid floor: "Loan Sizes $100k–$2.5m" / "$2.5m–$4.5m"
  var SMALL_MAX = 2500000;       // small/large loan-size band boundary
  var ABS_MAX_LOAN = 4500000;    // Tier 1 ceiling (large band)
  var SPREAD_NOTE = 0.01;        // the note buyer buy rate floor = note rate − 1.00pt (markup above 1pt is not earned)

  /* ---------------- geography (the note-buyer Underwriting Commentary) ----------------
     Hard exclusions by ZIP prefix / exact ZIP / state. When we only have a city
     name (no ZIP), the deal routes to MANUAL review to confirm the exact
     location, mirroring the Standard engine's city/address confidence split. */
  var EXCLUDED_ZIP3 = ["191",                       // Greater Philadelphia
                       "606", "607", "608",         // Greater Chicago
                       "481", "482", "483"];        // Greater Detroit
  var EXCLUDED_ZIP5 = ["21201", "21202", "21205", "21215", "21216", "21217", "21223", "21229"]; // Greater Baltimore
  var EXCLUDED_STATES = ["NV", "MN", "ND", "SD"];
  var EXCLUDED_CITIES = [
    { city: "philadelphia", state: "PA", label: "Greater Philadelphia" },
    { city: "chicago",      state: "IL", label: "Greater Chicago" },
    { city: "baltimore",    state: "MD", label: "Greater Baltimore" },
    { city: "detroit",      state: "MI", label: "Greater Detroit" }
  ];
  var STATE_NAMES = { NV: "Nevada", MN: "Minnesota", ND: "North Dakota", SD: "South Dakota" };

  // NYC five-borough detection: ZIP first (high confidence), borough name second.
  var NYC_ZIP3 = ["100", "101", "102", "103", "104", "111", "112", "113", "114", "116"];
  var NYC_ZIP5 = ["11004", "11005"];   // Queens pockets inside the 110xx (mostly Nassau) prefix
  var NYC_NAMES = ["new york city", "new york, ny", "manhattan", "brooklyn", "the bronx", "bronx", "queens", "staten island", "nyc"];

  // Ineligible property types: the note buyer's sheet is silent on property types, so the
  // Silver program keeps the same 1–4-unit residential footprint as the Standard
  // program (owner-confirmed default: copy of the Standard program's list).
  // The program lends on 1-4 unit RESIDENTIAL only (same footprint as Standard).
  // The value can arrive as free text from the pipeline sync, so the refusal list
  // carries the common synonyms too — matched as exact normalized tokens (soak
  // audit 2026-07-30: "office" priced because only "commercial" was listed).
  var INELIGIBLE_PROPERTY = ["co-op", "cooperative", "mobile home", "manufactured", "mixed-use", "mixed use", "commercial",
    "rural", "agricultural", "bed and breakfast", "boarding house", "half-way house", "care facility", "condemned", "multifamily 5+", "5+ units",
    "office", "retail", "warehouse", "industrial", "hotel", "motel", "storage", "self storage", "self-storage",
    "land", "vacant land", "lot", "gas station", "apartment building", "multi 5+", "5+", "multifamily 5+ units", "mixed"];

  /* ---------------- tier grid (the note-buyer "Tier Grid" tab, June 2026) ----------------
     row = [maxLoan, minFICO, maxAcqLTV, maxARLTV, maxLTC]; null = ineligible
     key = Product(FF|GUC|BR) | Purpose(P|R) | Tier(1|2|3)
     The grid is market-independent — NYC limits come from the rate grid
     itself (no NYC F&F-refi or over-$2.5M cells exist, so those combos
     fail with "no priced grid cell"). */
  var NA = null;
  var TG = {
    "FF|P|1":  [4500000, 640, 0.90, 0.75, 0.925],
    "FF|P|2":  [2500000, 660, 0.90, 0.75, 0.925],
    "FF|P|3":  [950000,  680, 0.75, 0.65, 0.85],
    "FF|R|1":  [2500000, 700, 0.75, 0.70, 0.85],
    "FF|R|2":  [2500000, 700, 0.65, 0.70, 0.75],
    "FF|R|3":  NA,
    "GUC|P|1": [4500000, 640, 0.80, 0.75, 0.925],
    "GUC|P|2": [2500000, 660, 0.70, 0.75, 0.925],
    "GUC|P|3": [950000,  680, 0.65, 0.65, 0.80],
    "GUC|R|1": [4500000, 640, 0.80, 0.75, 0.925],
    "GUC|R|2": [2500000, 660, 0.70, 0.75, 0.925],
    "GUC|R|3": [950000,  680, 0.65, 0.65, 0.80],
    "BR|P|1":  [4500000, 670, 0.75, 0.75, 0.75],
    "BR|P|2":  [2500000, 670, 0.75, 0.75, 0.75],
    "BR|P|3":  [950000,  680, 0.70, 0.70, 0.70],
    "BR|R|1":  [2500000, 700, 0.75, 0.75, 0.75],
    "BR|R|2":  [2500000, 700, 0.70, 0.70, 0.70],
    "BR|R|3":  [950000,  700, 0.65, 0.65, 0.65]
  };

  /* ---------------- rate grid (the note-buyer "Engine" tab: 1,555 priced cells) ----------------
     Bands, in grid order. Tier 3 uses its own FICO banding (the sheet's rule).   */
  var AR_BANDS  = ["<64.99%", "65.00%-70.00%", "70.01%-75.00%"];
  var FICO_BANDS_12 = ["FICO 700+", "FICO 660-699", "FICO 640-659"];   // tiers 1–2
  var FICO_BANDS_3  = ["FICO 700+", "FICO 680-699", "FICO 640-679"];   // tier 3
  var LTC_BANDS = ["<74.99%", "75.00%-80.00%", "80.01%-85.00%", "85.01%-87.50%", "87.51%-89.99%", "90.00%-92.50%"];

  /* Each block = market|size|product|purpose|term|tier → 54 cells (3 AR × 3 FICO × 6 LTC)
     flattened in band order above. Values are the note-buyer grid rate in
     units of 0.0125% (multiply by 0.000125); 0 = no priced cell (NA).
     GENERATED from the the note buyer workbook's hidden Engine tab — verified by an exact
     round-trip of all 1,555 cells (scripts/test-silver-program.js re-verifies
     shape + spot values). Do not hand-edit; regenerate from the workbook.       */
    var RATE_BLOCKS = {
    "NYC|S|BR|P|12|T1": [700,720,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,720,720,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,740,740,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|BR|P|12|T2": [720,740,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,740,760,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,760,780,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|BR|P|12|T3": [800,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,820,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,840,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|BR|P|18|T1": [700,720,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,720,720,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,740,740,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|BR|P|18|T2": [720,740,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,740,760,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,760,780,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|BR|P|18|T3": [800,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,820,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,840,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|BR|P|24|T1": [700,720,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,720,720,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,740,740,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|BR|P|24|T2": [720,740,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,740,760,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,760,780,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|BR|P|24|T3": [800,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,820,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,840,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|BR|R|12|T1": [740,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,760,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,780,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|BR|R|12|T2": [820,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,840,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|BR|R|12|T3": [900,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|BR|R|18|T1": [740,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,760,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,780,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|BR|R|18|T2": [820,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,840,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|BR|R|18|T3": [900,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|FF|P|12|T1": [680,690,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,690,700,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,700,710,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|FF|P|12|T2": [690,700,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,710,720,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,730,740,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|FF|P|18|T1": [690,700,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,700,710,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,710,720,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|FF|P|18|T2": [700,710,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,720,730,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,740,750,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|FF|P|24|T1": [700,710,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,710,720,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,720,730,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|FF|P|24|T2": [710,720,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,730,740,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,750,760,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|GUC|P|12|T1": [690,710,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,710,730,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,730,750,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|GUC|P|12|T2": [700,720,0,0,0,0,740,760,0,0,0,0,0,0,0,0,0,0,720,740,0,0,0,0,760,780,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|GUC|P|18|T1": [700,720,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,720,740,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,740,760,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|GUC|P|18|T2": [710,730,0,0,0,0,750,770,0,0,0,0,0,0,0,0,0,0,730,750,0,0,0,0,770,790,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|GUC|P|24|T1": [710,730,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,730,750,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,750,770,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|GUC|P|24|T2": [720,740,0,0,0,0,760,780,0,0,0,0,0,0,0,0,0,0,740,760,0,0,0,0,780,800,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|GUC|R|12|T1": [690,710,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,710,730,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,730,750,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|GUC|R|12|T2": [700,720,0,0,0,0,740,760,0,0,0,0,0,0,0,0,0,0,720,740,0,0,0,0,760,780,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|GUC|R|18|T1": [700,720,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,720,740,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,740,760,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "NYC|S|GUC|R|18|T2": [710,730,0,0,0,0,750,770,0,0,0,0,0,0,0,0,0,0,730,750,0,0,0,0,770,790,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|BR|P|12|T1": [700,720,0,0,0,0,720,740,0,0,0,0,0,0,0,0,0,0,720,720,0,0,0,0,740,740,0,0,0,0,0,0,0,0,0,0,740,740,0,0,0,0,760,760,0,0,0,0,0,0,0,0,0,0],
    "STD|L|BR|P|12|T2": [720,740,0,0,0,0,740,760,0,0,0,0,0,0,0,0,0,0,740,760,0,0,0,0,760,780,0,0,0,0,0,0,0,0,0,0,760,780,0,0,0,0,780,800,0,0,0,0,0,0,0,0,0,0],
    "STD|L|BR|P|12|T3": [800,0,0,0,0,0,820,0,0,0,0,0,0,0,0,0,0,0,820,0,0,0,0,0,840,0,0,0,0,0,0,0,0,0,0,0,840,0,0,0,0,0,860,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|BR|P|18|T1": [700,720,0,0,0,0,720,740,0,0,0,0,0,0,0,0,0,0,720,720,0,0,0,0,740,740,0,0,0,0,0,0,0,0,0,0,740,740,0,0,0,0,760,760,0,0,0,0,0,0,0,0,0,0],
    "STD|L|BR|P|18|T2": [720,740,0,0,0,0,740,760,0,0,0,0,0,0,0,0,0,0,740,760,0,0,0,0,760,780,0,0,0,0,0,0,0,0,0,0,760,780,0,0,0,0,780,800,0,0,0,0,0,0,0,0,0,0],
    "STD|L|BR|P|18|T3": [800,0,0,0,0,0,820,0,0,0,0,0,0,0,0,0,0,0,820,0,0,0,0,0,840,0,0,0,0,0,0,0,0,0,0,0,840,0,0,0,0,0,860,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|BR|P|24|T1": [700,720,0,0,0,0,720,740,0,0,0,0,0,0,0,0,0,0,720,720,0,0,0,0,740,740,0,0,0,0,0,0,0,0,0,0,740,740,0,0,0,0,760,760,0,0,0,0,0,0,0,0,0,0],
    "STD|L|BR|P|24|T2": [720,740,0,0,0,0,740,760,0,0,0,0,0,0,0,0,0,0,740,760,0,0,0,0,760,780,0,0,0,0,0,0,0,0,0,0,760,780,0,0,0,0,780,800,0,0,0,0,0,0,0,0,0,0],
    "STD|L|BR|P|24|T3": [800,0,0,0,0,0,820,0,0,0,0,0,0,0,0,0,0,0,820,0,0,0,0,0,840,0,0,0,0,0,0,0,0,0,0,0,840,0,0,0,0,0,860,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|BR|R|12|T1": [740,0,0,0,0,0,760,0,0,0,0,0,0,0,0,0,0,0,760,0,0,0,0,0,780,0,0,0,0,0,0,0,0,0,0,0,780,0,0,0,0,0,800,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|BR|R|12|T2": [820,0,0,0,0,0,840,0,0,0,0,0,0,0,0,0,0,0,840,0,0,0,0,0,860,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|BR|R|12|T3": [900,0,0,0,0,0,920,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|BR|R|18|T1": [740,0,0,0,0,0,760,0,0,0,0,0,0,0,0,0,0,0,760,0,0,0,0,0,780,0,0,0,0,0,0,0,0,0,0,0,780,0,0,0,0,0,800,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|BR|R|18|T2": [820,0,0,0,0,0,840,0,0,0,0,0,0,0,0,0,0,0,840,0,0,0,0,0,860,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|BR|R|18|T3": [900,0,0,0,0,0,920,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|FF|P|12|T1": [660,670,680,690,700,700,700,710,720,730,740,740,0,0,0,0,0,0,670,680,690,700,710,710,710,720,730,740,750,0,0,0,0,0,0,0,680,690,700,710,720,720,720,730,740,750,760,0,0,0,0,0,0,0],
    "STD|L|FF|P|12|T2": [668,678,688,698,708,708,708,718,728,738,748,748,0,0,0,0,0,0,688,698,708,718,728,728,728,738,748,758,768,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|FF|P|18|T1": [670,680,690,700,710,710,710,720,730,740,750,750,0,0,0,0,0,0,680,690,700,710,720,720,720,730,740,750,760,0,0,0,0,0,0,0,690,700,710,720,730,730,730,740,750,760,770,0,0,0,0,0,0,0],
    "STD|L|FF|P|18|T2": [678,688,698,708,718,718,718,728,738,748,758,758,0,0,0,0,0,0,698,708,718,728,738,738,738,748,758,768,778,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|FF|P|24|T1": [680,690,700,710,720,720,720,730,740,750,760,760,0,0,0,0,0,0,690,700,710,720,730,730,730,740,750,760,770,0,0,0,0,0,0,0,700,710,720,730,740,740,740,750,760,770,780,0,0,0,0,0,0,0],
    "STD|L|FF|P|24|T2": [688,698,708,718,728,728,728,738,748,758,768,768,0,0,0,0,0,0,708,718,728,738,748,748,748,758,768,778,788,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|FF|R|12|T1": [840,860,880,0,0,0,860,880,900,0,0,0,0,0,0,0,0,0,860,880,900,0,0,0,880,900,920,0,0,0,0,0,0,0,0,0,880,900,920,0,0,0,900,920,940,0,0,0,0,0,0,0,0,0],
    "STD|L|FF|R|12|T2": [840,860,0,0,0,0,860,880,0,0,0,0,0,0,0,0,0,0,860,880,0,0,0,0,880,900,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|FF|R|18|T1": [850,870,890,0,0,0,890,910,930,0,0,0,0,0,0,0,0,0,870,890,910,0,0,0,910,930,950,0,0,0,0,0,0,0,0,0,890,910,930,0,0,0,930,950,970,0,0,0,0,0,0,0,0,0],
    "STD|L|GUC|P|12|T1": [660,670,670,680,690,700,700,710,710,720,730,740,0,0,0,0,0,0,670,680,680,690,700,710,710,720,720,730,740,0,0,0,0,0,0,0,680,700,700,720,740,760,720,740,740,760,780,0,0,0,0,0,0,0],
    "STD|L|GUC|P|12|T2": [700,720,740,0,0,0,740,760,780,0,0,0,0,0,0,0,0,0,720,740,760,0,0,0,760,780,800,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|GUC|P|12|T3": [820,840,0,0,0,0,860,880,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|GUC|P|18|T1": [670,680,680,690,700,710,710,720,720,730,740,750,0,0,0,0,0,0,680,690,690,700,710,720,720,730,730,740,750,0,0,0,0,0,0,0,690,710,710,730,750,770,730,750,750,770,790,0,0,0,0,0,0,0],
    "STD|L|GUC|P|18|T2": [710,730,750,0,0,0,750,770,790,0,0,0,0,0,0,0,0,0,730,750,770,0,0,0,770,790,810,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|GUC|P|18|T3": [830,850,0,0,0,0,870,890,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|GUC|P|24|T1": [680,700,700,720,740,760,720,740,740,760,780,800,0,0,0,0,0,0,700,720,720,740,760,780,740,760,760,780,800,0,0,0,0,0,0,0,720,740,740,760,780,800,760,780,780,800,820,0,0,0,0,0,0,0],
    "STD|L|GUC|P|24|T2": [720,740,760,0,0,0,760,780,800,0,0,0,0,0,0,0,0,0,740,760,780,0,0,0,780,800,820,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|GUC|P|24|T3": [840,860,0,0,0,0,880,900,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|GUC|R|12|T1": [660,670,670,680,690,700,700,710,710,720,730,740,0,0,0,0,0,0,670,680,680,690,700,710,710,720,720,730,740,0,0,0,0,0,0,0,680,700,700,720,740,760,720,740,740,760,780,0,0,0,0,0,0,0],
    "STD|L|GUC|R|12|T2": [700,720,740,0,0,0,740,760,780,0,0,0,0,0,0,0,0,0,720,740,760,0,0,0,760,780,800,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|GUC|R|12|T3": [820,840,0,0,0,0,860,880,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|GUC|R|18|T1": [670,680,680,690,700,710,710,720,720,730,740,750,0,0,0,0,0,0,680,690,690,700,710,720,720,730,730,740,750,0,0,0,0,0,0,0,690,710,710,730,750,770,730,750,750,770,790,0,0,0,0,0,0,0],
    "STD|L|GUC|R|18|T2": [710,730,750,0,0,0,750,770,790,0,0,0,0,0,0,0,0,0,730,750,770,0,0,0,770,790,810,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|L|GUC|R|18|T3": [830,850,0,0,0,0,870,890,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|BR|P|12|T1": [700,720,0,0,0,0,720,740,0,0,0,0,740,760,0,0,0,0,720,720,0,0,0,0,740,740,0,0,0,0,760,760,0,0,0,0,740,740,0,0,0,0,760,760,0,0,0,0,780,780,0,0,0,0],
    "STD|S|BR|P|12|T2": [720,740,0,0,0,0,740,760,0,0,0,0,0,0,0,0,0,0,740,760,0,0,0,0,760,780,0,0,0,0,0,0,0,0,0,0,760,780,0,0,0,0,780,800,0,0,0,0,0,0,0,0,0,0],
    "STD|S|BR|P|12|T3": [800,0,0,0,0,0,820,0,0,0,0,0,0,0,0,0,0,0,820,0,0,0,0,0,840,0,0,0,0,0,0,0,0,0,0,0,840,0,0,0,0,0,860,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|BR|P|18|T1": [700,720,0,0,0,0,720,740,0,0,0,0,740,760,0,0,0,0,720,720,0,0,0,0,740,740,0,0,0,0,760,760,0,0,0,0,740,740,0,0,0,0,760,760,0,0,0,0,780,780,0,0,0,0],
    "STD|S|BR|P|18|T2": [720,740,0,0,0,0,740,760,0,0,0,0,0,0,0,0,0,0,740,760,0,0,0,0,760,780,0,0,0,0,0,0,0,0,0,0,760,780,0,0,0,0,780,800,0,0,0,0,0,0,0,0,0,0],
    "STD|S|BR|P|18|T3": [800,0,0,0,0,0,820,0,0,0,0,0,0,0,0,0,0,0,820,0,0,0,0,0,840,0,0,0,0,0,0,0,0,0,0,0,840,0,0,0,0,0,860,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|BR|P|24|T1": [700,720,0,0,0,0,720,740,0,0,0,0,740,760,0,0,0,0,720,720,0,0,0,0,740,740,0,0,0,0,760,760,0,0,0,0,740,740,0,0,0,0,760,760,0,0,0,0,780,780,0,0,0,0],
    "STD|S|BR|P|24|T2": [720,740,0,0,0,0,740,760,0,0,0,0,0,0,0,0,0,0,740,760,0,0,0,0,760,780,0,0,0,0,0,0,0,0,0,0,760,780,0,0,0,0,780,800,0,0,0,0,0,0,0,0,0,0],
    "STD|S|BR|P|24|T3": [800,0,0,0,0,0,820,0,0,0,0,0,0,0,0,0,0,0,820,0,0,0,0,0,840,0,0,0,0,0,0,0,0,0,0,0,840,0,0,0,0,0,860,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|BR|R|12|T1": [740,0,0,0,0,0,760,0,0,0,0,0,780,0,0,0,0,0,760,0,0,0,0,0,780,0,0,0,0,0,800,0,0,0,0,0,780,0,0,0,0,0,800,0,0,0,0,0,820,0,0,0,0,0],
    "STD|S|BR|R|12|T2": [820,0,0,0,0,0,840,0,0,0,0,0,0,0,0,0,0,0,840,0,0,0,0,0,860,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|BR|R|12|T3": [900,0,0,0,0,0,920,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|BR|R|18|T1": [740,0,0,0,0,0,760,0,0,0,0,0,780,0,0,0,0,0,760,0,0,0,0,0,780,0,0,0,0,0,800,0,0,0,0,0,780,0,0,0,0,0,800,0,0,0,0,0,820,0,0,0,0,0],
    "STD|S|BR|R|18|T2": [820,0,0,0,0,0,840,0,0,0,0,0,0,0,0,0,0,0,840,0,0,0,0,0,860,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|BR|R|18|T3": [900,0,0,0,0,0,920,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|FF|P|12|T1": [640,650,660,670,680,680,680,690,700,710,720,720,700,710,720,730,740,740,650,660,670,680,690,690,690,700,710,720,730,730,710,720,730,740,750,0,660,670,680,690,700,700,700,710,720,730,740,740,720,730,740,750,760,0],
    "STD|S|FF|P|12|T2": [660,670,680,690,700,700,700,710,720,730,740,740,0,0,0,0,0,0,680,690,700,710,720,720,720,730,740,750,760,760,0,0,0,0,0,0,700,710,720,730,740,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|FF|P|12|T3": [720,740,760,0,0,0,760,780,800,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|FF|P|18|T1": [650,660,670,680,690,690,690,700,710,720,730,730,710,720,730,740,750,750,660,670,680,690,700,700,700,710,720,730,740,740,720,730,740,750,760,0,670,680,690,700,710,710,710,720,730,740,750,750,730,740,750,760,770,0],
    "STD|S|FF|P|18|T2": [670,680,690,700,710,710,710,720,730,740,750,750,0,0,0,0,0,0,690,700,710,720,730,730,730,740,750,760,770,770,0,0,0,0,0,0,710,720,730,740,750,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|FF|P|18|T3": [730,750,770,0,0,0,770,790,810,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|FF|P|24|T1": [660,670,680,690,700,700,700,710,720,730,740,740,720,730,740,750,760,760,670,680,690,700,710,710,710,720,730,740,750,750,730,740,750,760,770,770,680,690,700,710,720,720,720,730,740,750,760,760,740,750,760,770,780,780],
    "STD|S|FF|P|24|T2": [680,690,700,710,720,720,720,730,740,750,760,760,0,0,0,0,0,0,700,710,720,730,740,740,740,750,760,770,780,780,0,0,0,0,0,0,720,730,740,750,760,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|FF|P|24|T3": [740,760,780,0,0,0,780,800,820,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|FF|R|12|T1": [840,860,880,0,0,0,860,880,900,0,0,0,880,900,920,0,0,0,860,880,900,0,0,0,880,900,920,0,0,0,900,920,940,0,0,0,880,900,920,0,0,0,900,920,940,0,0,0,920,940,960,0,0,0],
    "STD|S|FF|R|12|T2": [840,860,0,0,0,0,860,880,0,0,0,0,0,0,0,0,0,0,860,880,0,0,0,0,880,900,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|FF|R|18|T1": [850,870,890,0,0,0,890,910,930,0,0,0,910,930,950,0,0,0,870,890,910,0,0,0,910,930,950,0,0,0,930,950,970,0,0,0,890,910,930,0,0,0,930,950,970,0,0,0,950,970,990,0,0,0],
    "STD|S|GUC|P|12|T1": [630,650,650,670,690,710,670,690,690,710,730,750,690,710,710,730,750,770,650,670,670,690,710,730,690,710,710,730,750,770,710,730,730,750,770,790,670,690,690,710,730,750,710,730,730,750,770,790,730,750,750,770,790,810],
    "STD|S|GUC|P|12|T2": [700,720,740,0,0,0,740,760,780,0,0,0,0,0,0,0,0,0,720,740,760,0,0,0,760,780,800,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|GUC|P|12|T3": [820,840,0,0,0,0,860,880,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|GUC|P|18|T1": [640,660,660,680,700,720,680,700,700,720,740,760,700,720,720,740,760,780,660,680,680,700,720,740,700,720,720,740,760,780,720,740,740,760,780,800,680,700,700,720,740,760,720,740,740,760,780,800,740,760,760,780,800,820],
    "STD|S|GUC|P|18|T2": [710,730,750,0,0,0,750,770,790,0,0,0,0,0,0,0,0,0,730,750,770,0,0,0,770,790,810,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|GUC|P|18|T3": [830,850,0,0,0,0,870,890,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|GUC|P|24|T1": [650,670,670,690,710,730,690,710,710,730,750,770,710,730,730,750,770,790,670,690,690,710,730,750,710,730,730,750,770,790,730,750,750,770,790,810,690,710,710,730,750,770,730,750,750,770,790,810,750,770,770,790,810,830],
    "STD|S|GUC|P|24|T2": [720,740,760,0,0,0,760,780,800,0,0,0,0,0,0,0,0,0,740,760,780,0,0,0,780,800,820,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|GUC|P|24|T3": [840,860,0,0,0,0,880,900,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|GUC|R|12|T1": [630,650,650,670,690,710,670,690,690,710,730,750,690,710,710,730,750,770,650,670,670,690,710,730,690,710,710,730,750,770,710,730,730,750,770,790,670,690,690,710,730,750,710,730,730,750,770,790,730,750,750,770,790,810],
    "STD|S|GUC|R|12|T2": [700,720,740,0,0,0,740,760,780,0,0,0,0,0,0,0,0,0,720,740,760,0,0,0,760,780,800,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|GUC|R|12|T3": [820,840,0,0,0,0,860,880,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|GUC|R|18|T1": [640,660,660,680,700,720,680,700,700,720,740,760,700,720,720,740,760,780,660,680,680,700,720,740,700,720,720,740,760,780,720,740,740,760,780,800,680,700,700,720,740,760,720,740,740,760,780,800,740,760,760,780,800,820],
    "STD|S|GUC|R|18|T2": [710,730,750,0,0,0,750,770,790,0,0,0,0,0,0,0,0,0,730,750,770,0,0,0,770,790,810,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    "STD|S|GUC|R|18|T3": [830,850,0,0,0,0,870,890,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]
  };

  /* ---------------- small helpers ---------------- */
  function clean(s) { return String(s == null ? "" : s).trim(); }
  function up(s) { return clean(s).toUpperCase(); }
  function low(s) { return clean(s).toLowerCase(); }
  function num(x) { return (typeof x === "number" && isFinite(x)) ? x : 0; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function pct(x) { return (Math.round(x * 1000) / 10) + "%"; }
  function usd(n) { return "$" + Math.round(n).toLocaleString("en-US"); }
  function zip5(z) {
    var d = clean(z).replace(/[^0-9]/g, "").slice(0, 5);
    return d.length === 5 ? d : "";
  }

  // Product token: reuse the Standard normalizer (FF / NC / BR) but speak the note buyer's
  // grid dialect (FF / GUC / BR) when building rate keys.
  function prodToken(sc) { return sc === "NC" ? "GUC" : sc; }

  // Exit strategy: F&F sells, F&H/rental/DSCR rents, bridge is stabilized.
  function exitOf(sc, strategyText) {
    if (sc === "BR") return "BRIDGE";
    var s = low(strategyText);
    if (/hold|rental|rent|dscr|brrrr/.test(s)) return "HOLD";
    return "FLIP";
  }

  /* ---------------- geography ---------------- */
  // The state each excluded ZIP block belongs to — a ZIP that contradicts the
  // deal's own state is a misparse (e.g. a 5-digit HOUSE NUMBER in free text),
  // never grounds to refuse the deal (audit 2026-07-30, finding 1).
  var EXCLUDED_ZIP_STATE = { "191": "PA", "606": "IL", "607": "IL", "608": "IL", "481": "MI", "482": "MI", "483": "MI", "212": "MD" };
  function zipStateConsistent(z, st) {
    if (!st) return true;                                  // no state to contradict
    var implied = EXCLUDED_ZIP_STATE[z.slice(0, 3)];
    return !implied || implied === st;
  }
  function geoCheck(input) {
    var st = up(input.state);
    if (st && EXCLUDED_STATES.indexOf(st) > -1)
      return { level: "INELIGIBLE", label: (STATE_NAMES[st] || st), source: "state" };
    var zTyped = zip5(input.zip);
    var zText = zipFromText(input.address || input.propAddr);
    var z = zTyped || zText;
    if (z) {
      var excluded = EXCLUDED_ZIP5.indexOf(z) > -1 || EXCLUDED_ZIP3.indexOf(z.slice(0, 3)) > -1;
      if (excluded && zipStateConsistent(z, st)) {
        // A ZIP parsed out of free text is lower confidence than a typed ZIP
        // field — refuse hard only on the typed field; route a text-parsed hit
        // to manual review to confirm the location (mirrors the city path).
        if (zTyped) return { level: "INELIGIBLE", label: zipLabel(z), source: "zip" };
        return { level: "MANUAL", label: zipLabel(z), source: "address" };
      }
      if (excluded && zTyped) {
        // The TYPED ZIP names an excluded market but the TYPED state contradicts
        // it. Two typed fields disagreeing is a data problem, not a free-text
        // misparse — never price it silently; a human confirms which is right
        // (re-audit 2026-07-30, finding 1b-i).
        return { level: "MANUAL", label: zipLabel(z), source: "zipstate" };
      }
      if (zipStateConsistent(z, st)) return null;   // a known good ZIP is decisive — no city-name second-guessing
      // contradicting state on a TEXT-parsed "ZIP" ⇒ likely a house number — fall
      // through to the city-name check instead of trusting it.
    }
    // No ZIP: fall back to the city name, at manual-review confidence.
    var city = low(input.city), addr = low(input.address || input.propAddr || "");
    for (var i = 0; i < EXCLUDED_CITIES.length; i++) {
      var c = EXCLUDED_CITIES[i];
      if (st && st !== c.state) continue;
      if (city.indexOf(c.city) > -1) return { level: "MANUAL", label: c.label, source: "city" };
      if (addr.indexOf(c.city) > -1) return { level: "MANUAL", label: c.label, source: "address" };
    }
    return null;
  }
  function zipFromText(t) {
    // Only a TRAILING 5-digit group reads as the ZIP — "60629 Main St, Dallas"
    // starts with a HOUSE NUMBER, and reading it as a ZIP hard-declined real
    // deals (audit 2026-07-30, finding 1). US addresses end "…, ST 12345".
    var m = clean(t).match(/\b(\d{5})(?:-\d{4})?\s*$/);
    return m ? m[1] : "";
  }
  function zipLabel(z) {
    var p = z.slice(0, 3);
    if (p === "191") return "Greater Philadelphia";
    if (p === "606" || p === "607" || p === "608") return "Greater Chicago";
    if (p === "481" || p === "482" || p === "483") return "Greater Detroit";
    if (EXCLUDED_ZIP5.indexOf(z) > -1) return "Greater Baltimore";
    return "an excluded market";
  }

  // Market token: NYC five boroughs vs everything else.
  function marketOf(input) {
    var st = up(input.state);
    if (st && st !== "NY") return "STD";
    var z = zip5(input.zip) || zipFromText(input.address || input.propAddr);
    if (z) {
      if (NYC_ZIP5.indexOf(z) > -1 || NYC_ZIP3.indexOf(z.slice(0, 3)) > -1) return "NYC";
      return "STD";
    }
    // Name fallback needs WORD boundaries — "Queensbury"/"Bronxville" must not
    // read as Queens/the Bronx (audit 2026-07-30, finding 4).
    var hay = low(input.city) + " | " + low(input.address || input.propAddr || "");
    for (var i = 0; i < NYC_NAMES.length; i++) {
      var re = new RegExp("(^|[^a-z])" + NYC_NAMES[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|[^a-z])");
      if (re.test(hay)) return "NYC";
    }
    return "STD";
  }

  /* ---------------- experience → tier ---------------- */
  // Comparable-project count follows the same split as the Standard engine:
  // ground-up deals count ground-up projects only; F&F/F&H/bridge count all.
  function projectCount(sc, exp) { return YSP.projectCount(sc, exp); }
  function tierBase(sizeBand, n) {
    if (sizeBand === "L") return n >= 5 ? 1 : (n >= 2 ? 2 : 3);
    return n >= 3 ? 1 : (n >= 1 ? 2 : 3);
  }
  // GC-only experience caps the tier: Tier 2 max on small loans, Tier 3 on large.
  function tierOf(sizeBand, n, gcOnly) {
    var t = tierBase(sizeBand, n);
    if (gcOnly) t = (sizeBand === "L") ? 3 : Math.max(t, 2);
    return t;
  }
  function tierLabel(t) { return "Tier " + t + (t === 1 ? " — experienced" : t === 2 ? " — established" : " — first-time investor"); }

  function caps(prodTok, loanType, tier) {
    var row = TG[prodTok + "|" + (loanType === "Refinance" ? "R" : "P") + "|" + tier];
    if (!row) return null;
    return { maxLoan: row[0], minFico: row[1], maxAcqLTV: row[2], maxARLTV: row[3], maxLTC: row[4] };
  }

  /* ---------------- band classification (exact Pricing Tool formulas) ---------------- */
  function arBand(r) {
    if (!(r > 0)) return null;
    if (r <= 0.6499) return AR_BANDS[0];
    if (r <= 0.70) return AR_BANDS[1];
    if (r <= 0.75) return AR_BANDS[2];
    return null;                                   // > 75% — never priced
  }
  function ltcBand(r) {
    if (!(r > 0)) return null;
    if (r <= 0.7499) return LTC_BANDS[0];
    if (r <= 0.80) return LTC_BANDS[1];
    if (r <= 0.85) return LTC_BANDS[2];
    if (r <= 0.875) return LTC_BANDS[3];
    if (r <= 0.8999) return LTC_BANDS[4];
    if (r <= 0.925) return LTC_BANDS[5];
    return null;                                   // > 92.5% — never priced
  }
  function ficoBand(tier, fico) {
    if (!(fico > 0)) return null;
    if (tier === 3) {
      if (fico >= 700) return FICO_BANDS_3[0];
      if (fico >= 680) return FICO_BANDS_3[1];
      if (fico >= 640) return FICO_BANDS_3[2];
      return null;
    }
    if (fico >= 700) return FICO_BANDS_12[0];
    if (fico >= 660) return FICO_BANDS_12[1];
    if (fico >= 640) return FICO_BANDS_12[2];
    return null;
  }

  // Term bucket: the grid prices 12 / 18 / 24-month terms.
  function termToken(months) {
    var t = num(months) || 12;
    if (t <= 12) return "12";
    if (t <= 18) return "18";
    return "24";
  }

  /* ---------------- rate lookup ---------------- */
  function gridRate(mkt, sizeBand, prodTok, purp, termTok, tier, arB, ficoB, ltcB) {
    if (!arB || !ficoB || !ltcB) return null;
    var block = RATE_BLOCKS[mkt + "|" + sizeBand + "|" + prodTok + "|" + purp + "|" + termTok + "|T" + tier];
    if (!block) return null;
    var fl = (tier === 3) ? FICO_BANDS_3 : FICO_BANDS_12;
    var i = AR_BANDS.indexOf(arB), j = fl.indexOf(ficoB), k = LTC_BANDS.indexOf(ltcB);
    if (i < 0 || j < 0 || k < 0) return null;
    var v = block[(i * 3 + j) * 6 + k];
    return v > 0 ? v * 0.000125 : null;
  }
  // The exact 9-part key the the note buyer workbook uses — exposed for tests/tooling parity.
  function rateKey(mkt, sizeBand, prodTok, purp, termTok, tier, arB, ficoB, ltcB) {
    return [mkt, sizeBand, prodTok, purp, termTok, "T" + tier, arB, ficoB, ltcB].join("|");
  }

  // Borrower note rate for a deal profile (grid + markup); null when no grid cell.
  function noteRate(o) {
    var g = gridRate(o.market, o.sizeBand, prodToken(o.strategyCode), o.loanType === "Refinance" ? "R" : "P",
      termToken(o.term), o.tier, arBand(o.arltv), ficoBand(o.tier, o.fico), ltcBand(o.ltc));
    if (g == null) return null;
    return g + effMarkup();
  }

  /* ---------------- evaluate ---------------- */
  var RANK = { ELIGIBLE: 0, MANUAL: 1, INELIGIBLE: 2 };

  function evaluate(input) {
    input = input || {};
    // Loan-size band: use the stated loan when given; otherwise size small-first
    // and step up to the large band only when the sized loan exceeds $2.5M AND
    // the sponsor's experience carries a large-band tier whose ceiling allows it.
    var stated = num(input.loanAmount);
    // A stated loan picks its band — and the SIZED max must stay inside that band
    // too (soak audit 2026-07-30: a $913k stated loan printed a $3.87M max at
    // SMALL-band pricing; the small band's ceiling is $2.5M, above it the deal
    // must be priced on the LARGE grid). So a small-band stated loan sizes capped
    // at the band ceiling, exactly like the step-down path below.
    if (stated > 0) return stated > SMALL_MAX ? evaluateBand(input, "L") : evaluateBand(input, "S", SMALL_MAX);
    var r = evaluateBand(input, "S");
    var sized = r.sizing && r.sizing.totalLoan || 0;
    if (sized > SMALL_MAX + 0.5) {
      var rL = evaluateBand(input, "L");
      var sizedL = rL.sizing && rL.sizing.totalLoan || 0;
      if (sizedL > SMALL_MAX + 0.5) return rL;       // genuinely a large-band loan
      // Large-band tiering caps it back under $2.5M — stay small-band, capped there.
      var r2 = evaluateBand(input, "S", SMALL_MAX);
      return r2;
    }
    return r;
  }

  function evaluateBand(input, sizeBand, loanCapOverride) {
    var reasons = [], status = "ELIGIBLE";
    function add(level, msg) { reasons.push({ level: level, msg: msg }); if (RANK[level] > RANK[status]) status = level; }

    var loanType = clean(input.loanType) === "Refinance" ? "Refinance" : "Purchase";
    var purp = loanType === "Refinance" ? "R" : "P";
    var sc = YSP.normStrategy(input.strategy);         // FF / NC / BR
    var pTok = prodToken(sc);                          // FF / GUC / BR
    var exit = exitOf(sc, input.strategy);
    var market = marketOf(input);
    var fico = Math.max(0, Math.round(num(input.fico)));
    var exp = { flips: num(input.expFlips), holds: num(input.expHolds), ground: num(input.expGround) };
    var pcount = projectCount(sc, exp);
    var gcOnly = input.gcOnlyExperience === true;
    var tier = tierOf(sizeBand, pcount, gcOnly);
    var cashOut = loanType === "Refinance" && !!input.cashOut;
    var termMonths = num(input.term) || 12;
    var termTok = termToken(termMonths);

    // ---- assignment / wholesale: the YS company-wide rule (frozen 2026-07-17)
    //      — financeable fee capped at 15% of the ORIGINAL (seller's) contract
    //      price; sizing runs off the recognized (effective) price. the note buyer's own
    //      sheet caps assignment fees at 15% of the gross price, which is looser;
    //      the company rule is the binding one for every program. ----
    var totalPP = Math.max(0, num(input.purchasePrice));
    var sellerPP = Math.max(0, num(input.sellerPrice));
    var isAssignment = loanType === "Purchase" && !!input.isAssignment && sellerPP > 0;
    var assignment = null;
    var effPurchase = totalPP;
    if (isAssignment) {
      var rawFee = Math.max(0, totalPP - sellerPP);
      var maxFee = 0.15 * sellerPP;
      var financeableFee = Math.min(rawFee, maxFee);
      var excessFee = Math.max(0, rawFee - financeableFee);
      effPurchase = sellerPP + financeableFee;
      var ovrEff = Math.max(0, num(input.ovrEffPrice));
      if (ovrEff > 0) {
        effPurchase = Math.min(Math.max(ovrEff, sellerPP), totalPP);
        financeableFee = effPurchase - sellerPP;
        excessFee = Math.max(0, rawFee - financeableFee);
      }
      assignment = {
        sellerPrice: round2(sellerPP), totalPrice: round2(totalPP), fee: round2(rawFee),
        maxFee: round2(maxFee), financeableFee: round2(financeableFee), excessOOP: round2(excessFee),
        recognizedPrice: round2(effPurchase), overLimit: excessFee > 0.5, maxPct: 0.15,
        overridden: ovrEff > 0
      };
    }

    var rehab = (sc === "BR") ? 0 : Math.max(0, num(input.rehabBudget));
    var aiv = Math.max(0, num(input.asIsValue));
    var arv = Math.max(0, num(input.arv));

    // ---- hard gates ----
    var geo = geoCheck(input);
    var geoReview = null;
    if (geo) {
      if (geo.level === "INELIGIBLE") add("INELIGIBLE", "Properties in " + geo.label + " are not eligible for the Silver Program.");
      else {
        geoReview = geo.label;
        add("MANUAL", geo.source === "city"
          ? "Properties in " + geo.label + " aren't eligible for the Silver Program — this scenario needs manual review."
          : geo.source === "zipstate"
            ? "The ZIP code entered is in " + geo.label + " (not eligible for the Silver Program) but the state entered doesn't match that ZIP — one of the two is wrong. This needs manual review to confirm the property's real location before it can be priced."
            : "This address looks like it's in " + geo.label + ", which isn't eligible for the Silver Program — it needs manual review to confirm the exact location (a ZIP code decides). If the property isn't in " + geo.label + ", we can price it.");
      }
    }
    var propLc = low(input.propertyType);
    if (propLc && INELIGIBLE_PROPERTY.indexOf(propLc) > -1) add("INELIGIBLE", title(propLc) + " properties are not eligible.");
    if (input.ownerOccupied) add("INELIGIBLE", "Owner-occupied properties are not eligible — business-purpose only.");
    if (fico > 0 && fico < 640) add("INELIGIBLE", "A representative FICO of at least 640 is required on the Silver Program.");
    if (loanType === "Refinance" && input.midConstruction) add("INELIGIBLE", "Mid-way completed construction projects are not eligible for funding.");
    if (String(input.accrual || "").toLowerCase() === "dutch") add("INELIGIBLE", "Dutch loans (interest accruing on undrawn holdback) are not eligible — interest must accrue on the outstanding balance only.");
    if (input.sellerFinancing === true) add("INELIGIBLE", "Loans showing evidence of seller financing are not eligible.");
    if (gcOnly && (input.subdivision === true || /sub-?division/.test(propLc))) add("INELIGIBLE", "GC-only experience cannot qualify for sub-division projects.");

    // ---- tier grid row ----
    var c = caps(pTok, loanType, tier);
    if (!c) {
      if (pTok === "FF" && loanType === "Refinance" && tier === 3)
        add("INELIGIBLE", "Fix & flip / fix & hold refinances require prior experience (first-time investors are not eligible).");
      else
        add("INELIGIBLE", "This strategy isn't available for the selected loan type and experience.");
      return result(status, reasons, base());
    }
    if (loanCapOverride > 0) c = { maxLoan: Math.min(c.maxLoan, loanCapOverride), minFico: c.minFico, maxAcqLTV: c.maxAcqLTV, maxARLTV: c.maxARLTV, maxLTC: c.maxLTC };

    // ---- NYC grid limits (no priced cells exist for these — fail with a plain reason) ----
    if (market === "NYC" && pTok === "FF" && purp === "R")
      add("INELIGIBLE", "Fix & flip / fix & hold refinances are not offered in the NYC five boroughs on this program.");
    if (market === "NYC" && sizeBand === "L")
      add("INELIGIBLE", "Loans over " + usd(SMALL_MAX) + " are not offered in the NYC five boroughs on this program.");

    // ---- term gates: 18-month needs >$100k budget, 24-month >$200k (F&F/F&H product only) ----
    if (termTok === "18" && pTok === "FF" && rehab <= 100000)
      add("INELIGIBLE", "An 18-month term on fix & flip / fix & hold needs a project budget over $100,000 — choose a 12-month term.");
    if (termTok === "24" && pTok === "FF" && rehab <= 200000)
      add("INELIGIBLE", "A 24-month term on fix & flip / fix & hold needs a project budget over $200,000 — choose a 12- or 18-month term.");
    if (termMonths > 24) add("MANUAL", "The maximum initial term is 24 months — a " + termMonths + "-month term needs manual review.");

    // ---- value-add gate: the ARV must EXCEED total project cost (LTC > AR-LTV).
    //      Renovation / construction products only — a stabilized bridge has no
    //      value-add component and is sized on the as-is value instead. ----
    var basisForExit = (loanType === "Purchase" ? effPurchase : aiv) + rehab;
    var exitGap = 0;
    if (sc !== "BR" && arv > 0 && basisForExit > 0 && arv <= basisForExit + 0.5) {
      exitGap = round2(Math.max(0, basisForExit - arv));
      add("INELIGIBLE", "The after-repair value must exceed the total cost basis of " + usd(basisForExit) +
        " (value-add required)" + (exitGap > 0 ? " — it is short by " + usd(exitGap) : " — they are equal") +
        ". Ineligible deals can be submitted for individual review.");
    }

    // ---- HARD GATE: never price an ineligible deal (admin forcePrice bypasses) ----
    if (status === "INELIGIBLE" && !input.forcePrice) return result(status, reasons, base());
    if (geoReview && !input.forcePrice) return result(status, reasons, base({ geoReview: geoReview }));

    // ---- FICO vs tier minimum (≥640 but below the tier min ⇒ manual/waiver) ----
    if (fico > 0 && fico < c.minFico) add("MANUAL", "FICO " + fico + " is below the " + c.minFico + " minimum for this tier — eligible with a credit-committee waiver review.");

    // ---- effective caps: voluntary de-leverage + admin overrides ----
    var capsEff = { maxLoan: c.maxLoan, minFico: c.minFico, maxAcqLTV: c.maxAcqLTV, maxARLTV: c.maxARLTV, maxLTC: c.maxLTC };
    if (input.targetLTC && input.targetLTC > 0) capsEff.maxLTC = Math.min(capsEff.maxLTC, input.targetLTC);
    if (input.ovrAcqLTV > 0) capsEff.maxAcqLTV = input.ovrAcqLTV;
    if (input.ovrARLTV > 0) capsEff.maxARLTV = input.ovrARLTV;
    if (input.ovrLTC > 0) capsEff.maxLTC = input.ovrLTC;
    var rateOvr = (input.ovrRate > 0) ? input.ovrRate : 0;

    // ---- size the loan (shared frozen waterfall; reserve in cost, full-term cap
    //      — the Standard Program's interest-reserve mechanic, owner-directed) ----
    var irMonthsReq = Math.max(0, num(input.irMonths));
    var irMonthsEff = Math.min(irMonthsReq, termMonths);
    var reserveTermCapped = irMonthsReq > termMonths;
    var irAmountReq = (sc === "BR") ? 0 : Math.max(0, num(input.irAmount));
    var dealForSize = {
      loanType: loanType, purchasePrice: effPurchase, asIsValue: input.asIsValue, arv: input.arv,
      rehabBudget: rehab, irMonths: irMonthsEff, irAmount: irAmountReq, accrual: input.accrual,
      noteRateForIR: 0.10, reserveCapMonths: termMonths, reserveInCost: true, bridge: (sc === "BR")
    };
    // Rate guess at the cap edges, then settle on the achieved bands (two passes,
    // mirroring the Standard engine's IR/rate loop).
    var arForBand = function (s) {
      var denom = (sc === "BR") ? (arv || aiv) : arv;
      return denom > 0 ? (s.totalLoan / denom) : 0;
    };
    var guess = rateOvr || (gridRate(market, sizeBand, pTok, purp, termTok, tier,
      arBand(Math.min(capsEff.maxARLTV, 0.75)), ficoBand(tier, fico || 700), ltcBand(Math.min(capsEff.maxLTC, 0.925))) || 0.10) + (rateOvr ? 0 : effMarkup());
    dealForSize.noteRateForIR = guess;
    var sizing = YSP.sizeLoan(dealForSize, capsEff);
    var rate = rateOvr || rateAt(sizing);
    if (rate) { dealForSize.noteRateForIR = rate; sizing = YSP.sizeLoan(dealForSize, capsEff); rate = rateOvr || (rateAt(sizing) || rate); }

    function rateAt(s) {
      var g = gridRate(market, sizeBand, pTok, purp, termTok, tier,
        arBand(arForBand(s)), ficoBand(tier, fico || 700), ltcBand(s.ltcPct > 0 ? s.ltcPct : capsEff.maxLTC));
      return g == null ? null : g + effMarkup();
    }

    // ---- grid-aware leverage step-down -------------------------------------
    // The rate grid IS the leverage policy: where the workbook has no priced
    // cell (e.g. NYC F&F above 80% LTC, or a tier/AR combo with no high-LTC
    // pricing), the note buyer simply doesn't buy that structure. Rather than dead-end,
    // step the target LTC down one band edge at a time and re-size — landing on
    // the MAXIMUM structure the grid actually prices. Only when no leverage
    // level prices at all (e.g. a FICO band with no cells in this market) does
    // the deal go to individual review.
    var gridCapped = false;
    if (!rate && !rateOvr && sizing.totalLoan > 0 && fico > 0) {
      var EDGES = [0.925, 0.8999, 0.875, 0.85, 0.80, 0.7499, 0.70, 0.6499];
      var startLtc = sizing.ltcPct > 0 ? sizing.ltcPct : capsEff.maxLTC;
      for (var e = 0; e < EDGES.length && !rate; e++) {
        if (EDGES[e] >= startLtc - 1e-9) continue;              // only step DOWN
        if (EDGES[e] > capsEff.maxLTC + 1e-9) continue;
        var capsTry = { maxLoan: capsEff.maxLoan, minFico: capsEff.minFico, maxAcqLTV: capsEff.maxAcqLTV, maxARLTV: capsEff.maxARLTV, maxLTC: EDGES[e] };
        var deal2 = {
          loanType: loanType, purchasePrice: effPurchase, asIsValue: input.asIsValue, arv: input.arv,
          rehabBudget: rehab, irMonths: irMonthsEff, irAmount: irAmountReq, accrual: input.accrual,
          noteRateForIR: dealForSize.noteRateForIR, reserveCapMonths: termMonths, reserveInCost: true, bridge: (sc === "BR")
        };
        var s2 = YSP.sizeLoan(deal2, capsTry);
        if (!(s2.totalLoan > 0)) continue;
        var g2 = gridRate(market, sizeBand, pTok, purp, termTok, tier,
          arBand((sc === "BR") ? (s2.totalLoan / (arv || aiv)) : (arv > 0 ? s2.totalLoan / arv : 0)),
          ficoBand(tier, fico || 700), ltcBand(s2.ltcPct > 0 ? s2.ltcPct : EDGES[e]));
        if (g2 != null) {
          rate = g2 + effMarkup();
          deal2.noteRateForIR = rate;
          sizing = YSP.sizeLoan(deal2, capsTry);
          capsEff = capsTry;
          gridCapped = true;
          add("ELIGIBLE", "Leverage is capped at " + pct(EDGES[e]) + " loan-to-cost — the program doesn't price higher leverage for this market and profile.");
        }
      }
    }

    // ---- no priced grid cell at any leverage → individual review ----
    var arB = arBand(arForBand(sizing)), fB = ficoBand(tier, fico || 700), lB = ltcBand(sizing.ltcPct > 0 ? sizing.ltcPct : capsEff.maxLTC);
    var key = rateKey(market, sizeBand, pTok, purp, termTok, tier, arB || "-", fB || "-", lB || "-");
    if (!rate && sizing.totalLoan > 0 && fico > 0) {
      add("MANUAL", "No priced grid cell for this profile — submit for individual review.");
    }

    // ---- min / max loan ----
    var hasLoan = num(input.loanAmount) > 0;
    if (hasLoan) {
      if (input.loanAmount < MIN_LOAN) add("INELIGIBLE", "The minimum loan amount is $100,000.");
      else if (input.loanAmount > c.maxLoan) add("INELIGIBLE", "Loan amount exceeds the " + usd(c.maxLoan) + " program maximum for this profile.");
    }
    // The SIZED loan below the $100k floor flags whether or not an amount was
    // stated — a stated $3M on a deal that can only support $70k is still a deal
    // the program can't fund at its minimum (soak audit 2026-07-30).
    if (sizing.totalLoan < MIN_LOAN && sizing.totalLoan > 0) {
      add("MANUAL", "Sized below the $100,000 minimum — increase the deal size or leverage.");
    }
    if (sizing.rehabOverCap) add("MANUAL", "The rehab budget exceeds what this program can finance — the loan is capped at " + usd(sizing.totalLoan) + ", so the remaining budget would be funded out of pocket. Reduce the scope or use a larger facility.");

    // ---- DSCR gate (fix & hold exit): projected DSCR must be ≥ 1.00 when known ----
    var dscr = 0;
    var rent = Math.max(0, num(input.monthlyRent));
    if (num(input.dscr) > 0) dscr = num(input.dscr);
    else if (exit === "HOLD" && rent > 0 && sizing.fullPayment > 0) dscr = rent / sizing.fullPayment;
    if (exit === "HOLD" && dscr > 0 && dscr < 1)
      add("INELIGIBLE", "The projected DSCR of " + (Math.round(dscr * 100) / 100).toFixed(2) + " is below the 1.00 minimum for a fix & hold / rental exit. Ineligible deals can be submitted for individual review.");

    // ---- refinance cash-out cap: proceeds ≤ 50% of projected project profit ----
    var cashOutAmt = Math.max(0, num(input.cashOutAmount));
    if (loanType === "Refinance" && cashOutAmt > 0) {
      var profit = Math.max(0, num(input.projectedProfit)) || Math.max(0, arv - basisForExit);
      if (profit > 0 && cashOutAmt > 0.5 * profit + 0.5)
        add("INELIGIBLE", "Cash-out proceeds of " + usd(cashOutAmt) + " exceed 50% of the projected project profit (" + usd(0.5 * profit) + ").");
    }

    // ---- assignment messaging (same mechanic as the Standard engine) ----
    if (assignment && assignment.overridden) {
      add("MANUAL", "Admin exception: the effective purchase price is set to " + usd(assignment.recognizedPrice) + " — " +
        usd(assignment.financeableFee) + " of the " + usd(assignment.fee) + " assignment fee is financed" +
        (assignment.excessOOP > 0.5 ? ("; " + usd(assignment.excessOOP) + " is brought out of pocket at closing") : "") + ".");
    } else if (assignment && assignment.overLimit) {
      add("ELIGIBLE", usd(assignment.financeableFee) + " of the " + usd(assignment.fee) + " assignment fee is financed (the 15% cap is " + usd(assignment.maxFee) +
        ", 15% of the " + usd(assignment.sellerPrice) + " contract price); the loan is sized on the " + usd(assignment.recognizedPrice) + " effective price and the remaining " +
        usd(assignment.excessOOP) + " is brought to closing as extra cash to close. To finance more of the assignment fee, request an exception.");
    }
    if (sizing) sizing.assignmentExcessOOP = assignment ? assignment.excessOOP : 0;

    // ---- required-document / overlay checklist (auto-filters to this loan,
    //      mirroring the the note buyer tool's section 5 — informational, never a gate) ----
    var overlays = buildOverlays({
      loanType: loanType, sc: sc, exit: exit, gcOnly: gcOnly, rehab: rehab,
      totalLoan: sizing.totalLoan || num(input.loanAmount), cashOutAmt: cashOutAmt,
      ltcOver: sizing.reserveCapped || sizing.rehabOverCap, isAssignment: isAssignment
    });

    if (!reasons.length) reasons.push({ level: "ELIGIBLE", msg: "Meets the Silver Program guidelines." });

    return result(status, reasons, base({
      caps: capsEff, noteRate: rate || 0, sizing: sizing,
      reserveTermCapped: reserveTermCapped, reserveTermMonths: termMonths,
      exitShortfall: exitGap, dscr: dscr > 0 ? Math.round(dscr * 100) / 100 : null,
      assignment: assignment, overlays: overlays, rateKey: key,
      pricingReady: fico > 0
    }));

    function base(extra) {
      var o = {
        program: "silver", market: market, sizeBand: sizeBand,
        tier: tier, tierLabel: tierLabel(tier), strategyCode: sc, product: pTok, exit: exit,
        loanType: loanType, cashOut: cashOut, projectCount: pcount, gcOnly: gcOnly,
        pricingReady: fico > 0, assignment: assignment, caps: null, noteRate: 0, sizing: null
      };
      for (var k2 in (extra || {})) o[k2] = extra[k2];
      return o;
    }
  }

  function result(status, reasons, extra) {
    var o = { program: "silver", status: status, eligible: status !== "INELIGIBLE", reasons: reasons };
    for (var k in extra) if (extra.hasOwnProperty(k)) o[k] = extra[k];
    return o;
  }
  function title(s) { return clean(s).replace(/\b\w/g, function (m) { return m.toUpperCase(); }); }

  /* ---------------- overlays (the note-buyer Underwriting Commentary, auto-filtered) ---------------- */
  function buildOverlays(x) {
    var L = [];
    function o(key, applies, requirement) { L.push({ key: key, applies: !!applies, requirement: requirement }); }
    o("appraisal_comps", true, "≥1 As-Is and ≥1 ARV comp on a 1004: sale within 12 months, <15% net adjustments, same ZIP. Interior photos required; the submitting lender's name must appear on the appraisal.");
    o("refi_background", x.loanType === "Refinance", "Provide current-financing background & exit strategy. Purchase price is used as the As-Is value where no value-add work was completed since acquisition (an As-Is appraisal is usable if acquired >18 months prior).");
    o("guc_refi_docs", x.loanType === "Refinance" && x.sc === "NC", "Within 18 months of acquisition, Purchase Price + documented value-add (invoices, credited 1:1) may be used. Mid-way completed projects are NOT eligible.");
    o("bridge_refi", x.loanType === "Refinance" && x.sc === "BR", "Borrower current on all payments (VOM/payoff) with no missed payments; taxes current; project profitable including new fees & carry; interest reserves are netted from cash-out proceeds; LTC/AR-LTV are inclusive of reserve funding.");
    o("cashout_cap", x.loanType === "Refinance" && x.cashOutAmt > 0, "Cash-out proceeds may not exceed 50% of total projected project profitability.");
    o("exp_over_1m", x.totalLoan > 1000000, "Prior projects must show budgets and re-sale values within 80% of the current submission.");
    o("exp_guc_500k", x.sc === "NC" && x.rehab > 500000, "Only other new-construction projects qualify as experience; budgets and re-sale values within 80% of the current submission.");
    o("gc_only", x.gcOnly, "GC experience requires documented proof of completion. GC-only caps at Tier 2 (≤$2.5M) / Tier 3 (>$2.5M) and cannot qualify for sub-division projects.");
    o("oop_rehab", x.ltcOver, "Where borrower out-of-pocket rehab funds are needed to make the structure eligible, those funds must be fully injected before any lender rehab releases. The lender targets 100% of go-forward costs.");
    o("entity_ownership", true, "Verify entity ownership & property acquisition for prior projects that can't be third-party verified; the borrower must own ≥25% of the entity (operating agreements / entity docs).");
    o("background", true, "BK/FCL within 5 years, tax liens or judgments over $15k, or prior financial-crime offenses are ineligible (all individuals in the entity). Negative Elementix remarks need an LOE — case by case.");
    o("prior_sale_24mo", x.loanType === "Purchase", "A property sold within the last 24 months needs evidence of an arms-length transaction plus detail on the prior sale and the sponsor's acquisition & exit.");
    o("assignment_caps", x.isAssignment, "Assignment fees, A/B transactions and seller credits are each capped at 15%; seller financing is ineligible.");
    return L;
  }

  /* ---------------- pricing ladder (leverage ↔ rate, like the Standard engine) ----------------
     Buckets are the grid's own LTC band edges, so each rung is a real pricing band. */
  var LADDER_BUCKETS = [0.925, 0.8999, 0.875, 0.85, 0.80, 0.7499, 0.70, 0.6499];
  function priceLadder(input) {
    var full = evaluate(input);
    if (full.status === "INELIGIBLE" || !full.sizing || !(full.sizing.totalLoan > 0)) {
      return { eligible: false, status: full.status, reasons: full.reasons, rows: [] };
    }
    var maxLtc = full.sizing.ltcPct;
    var rows = [];
    for (var i = 0; i < LADDER_BUCKETS.length; i++) {
      var b = LADDER_BUCKETS[i];
      if (b > maxLtc + 1e-4) continue;                 // can't lever above the deal's own max
      var ev = evaluate(assign({}, input, { targetLTC: b }));
      var s = ev.sizing || {};
      if (!(s.totalLoan > 0) || !(ev.noteRate > 0)) continue;
      if (rows.length && Math.abs(rows[rows.length - 1].totalLoan - s.totalLoan) < 1) continue;   // dedupe identical rungs
      rows.push({
        ltc: b, targetLtcPct: s.ltcPct, totalLoan: s.totalLoan, initialAdvance: s.acquisition,
        downPayment: s.downPayment, rehabHoldback: s.rehabLoan, noteRate: ev.noteRate,
        monthlyPayment: round2(s.totalLoan * (ev.noteRate / 12)),
        isMax: false
      });
    }
    if (rows.length) rows[0].isMax = true;
    return { eligible: true, status: full.status, maxLtc: maxLtc, binding: (full.sizing && full.sizing.binding) || "", maxNoteRate: full.noteRate, rows: rows };
  }
  function assign(t) { for (var i = 1; i < arguments.length; i++) { var s = arguments[i]; for (var k in s) if (s.hasOwnProperty(k)) t[k] = s[k]; } return t; }

  /* ---------------- public API ---------------- */
  return {
    evaluate: evaluate,
    priceLadder: priceLadder,
    setMarkup: setMarkup,
    // exposed for tooling / tests
    marketOf: marketOf, geoCheck: geoCheck, tierOf: tierOf, projectCount: projectCount,
    caps: caps, gridRate: gridRate, rateKey: rateKey, noteRate: noteRate,
    arBand: arBand, ltcBand: ltcBand, ficoBand: ficoBand, termToken: termToken, prodToken: prodToken,
    constants: {
      MARKUP: MARKUP, MARKUP_MAX: MARKUP_MAX, ORIG_PCT: ORIG_PCT, MIN_LOAN: MIN_LOAN, SMALL_MAX: SMALL_MAX, ABS_MAX_LOAN: ABS_MAX_LOAN,
      SPREAD_NOTE: SPREAD_NOTE, TG: TG, AR_BANDS: AR_BANDS, FICO_BANDS_12: FICO_BANDS_12, FICO_BANDS_3: FICO_BANDS_3,
      LTC_BANDS: LTC_BANDS, EXCLUDED_STATES: EXCLUDED_STATES, EXCLUDED_ZIP3: EXCLUDED_ZIP3, EXCLUDED_ZIP5: EXCLUDED_ZIP5,
      RATE_BLOCKS: RATE_BLOCKS
    }
  };
}));
