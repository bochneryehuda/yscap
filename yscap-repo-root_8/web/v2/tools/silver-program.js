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

  /* Spelled-out / dotted STATE names normalize to the 2-letter code BEFORE any
     geography check runs (owner-directed 2026-07-30: the engine must say "which
     city and which zip is blocked … include these restrictions"). ONE chokepoint
     — stateOf() — feeds BOTH the exclusion list and the market map, so "Nevada"
     is refused exactly like "NV" and "New York"/"N.Y." price on the NYC grid. */
  var STATE_NAME_TO_CODE = {
    ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA", COLORADO: "CO",
    CONNECTICUT: "CT", DELAWARE: "DE", DISTRICTOFCOLUMBIA: "DC", WASHINGTONDC: "DC", FLORIDA: "FL",
    GEORGIA: "GA", HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA", KANSAS: "KS",
    KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD", MASSACHUSETTS: "MA", MICHIGAN: "MI",
    MINNESOTA: "MN", MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE", NEVADA: "NV",
    NEWHAMPSHIRE: "NH", NEWJERSEY: "NJ", NEWMEXICO: "NM", NEWYORK: "NY", NORTHCAROLINA: "NC",
    NORTHDAKOTA: "ND", OHIO: "OH", OKLAHOMA: "OK", OREGON: "OR", PENNSYLVANIA: "PA",
    RHODEISLAND: "RI", SOUTHCAROLINA: "SC", SOUTHDAKOTA: "SD", TENNESSEE: "TN", TEXAS: "TX",
    UTAH: "UT", VERMONT: "VT", VIRGINIA: "VA", WASHINGTON: "WA", WESTVIRGINIA: "WV",
    WISCONSIN: "WI", WYOMING: "WY",
    // AP-style abbreviations for the four BANNED states only (audit 2026-07-30,
    // item 5): "N.D."/"S.D." already normalize because they compact to two
    // letters, but "Nev." / "Minn." / "N.Dak." / "S. Dak." compact to 3-4 and
    // fell through to the raw passthrough, so they never blocked. Deliberately
    // NOT added for any other state — an abbreviation nobody uses is a
    // false-match risk, and only these four carry a refusal.
    NEV: "NV", MINN: "MN", NDAK: "ND", SDAK: "SD", NDAKOTA: "ND", SDAKOTA: "SD"
  };
  function stateCode(s) {
    var raw = up(s);
    if (!raw) return "";
    var compact = raw.replace(/[^A-Z]/g, "");
    if (compact.length === 2) return compact;                    // "NY", "N.Y.", " ny "
    return STATE_NAME_TO_CODE[compact] || raw;                   // "New York" → NY; unknown passes through
  }
  function stateOf(input) { return stateCode(input && input.state); }

  /* A RESOLVED state is a real 2-letter USPS code or a name/abbreviation the map
     above knows. stateCode() deliberately passes UNKNOWN text through verbatim
     (so nothing is silently reclassified), which means "any non-empty string"
     is NOT the same question as "do we know which state this is" — and gating
     the ZIP→banned-state fallback on non-emptiness let "Nevada, USA",
     "Las Vegas", "N/A", "??" and "unknown" DISABLE it, funding a Las Vegas deal
     (audit 2026-07-30, item 2). Every gate that means "we know the state" reads
     THIS, never stateOf() truthiness. */
  var VALID_STATE_CODES = (function () {
    var s = {}, k;
    for (k in STATE_NAME_TO_CODE) if (STATE_NAME_TO_CODE.hasOwnProperty(k)) s[STATE_NAME_TO_CODE[k]] = 1;
    s.PR = 1; s.VI = 1; s.GU = 1; s.AS = 1; s.MP = 1;            // territories the name map has no entry for
    return s;
  }());
  function stateResolved(input) {
    var raw = up(input && input.state);
    if (!raw) return "";
    var compact = raw.replace(/[^A-Z]/g, "");
    if (compact.length === 2 && VALID_STATE_CODES[compact]) return compact;
    return STATE_NAME_TO_CODE[compact] || "";                    // unresolvable text ⇒ we do NOT know the state
  }

  /* ZIP → STATE fallback for the four banned states. When the state FIELD is
     blank the ZIP still names the state, so a Las Vegas / Minneapolis / Fargo /
     Sioux Falls deal arriving as one unsplit line can't slip through
     (owner-directed 2026-07-30). USPS zip3 allocations of NV/MN/ND/SD. */
  var EXCLUDED_STATE_ZIP3 = {
    NV: ["889", "890", "891", "893", "894", "895", "897", "898"],
    MN: ["550", "551", "553", "554", "555", "556", "557", "558", "559", "560", "561", "562", "563", "564", "565", "566", "567"],
    ND: ["580", "581", "582", "583", "584", "585", "586", "587", "588"],
    SD: ["570", "571", "572", "573", "574", "575", "576", "577"]
  };
  var ZIP3_TO_EXCLUDED_STATE = (function () {
    var m = {};
    for (var st in EXCLUDED_STATE_ZIP3) {
      if (!EXCLUDED_STATE_ZIP3.hasOwnProperty(st)) continue;
      var a = EXCLUDED_STATE_ZIP3[st];
      for (var i = 0; i < a.length; i++) m[a[i]] = st;
    }
    return m;
  }());

  // NYC five-borough detection: ZIP first (high confidence), borough name second.
  var NYC_ZIP3 = ["100", "101", "102", "103", "104", "111", "112", "113", "114", "116"];
  var NYC_ZIP5 = ["11004", "11005"];   // Queens pockets inside the 110xx (mostly Nassau) prefix
  // Borough / city spellings that classify NYC. Address data arrives unsplit and
  // messy, so the common abbreviations ride the same list (owner-directed
  // 2026-07-30). Multi-word entries must match the FULL token sequence — see
  // nameHit(): "New York Mills, MN" is NOT New York City.
  var NYC_NAMES = ["new york city", "new york, ny", "new york", "manhattan", "brooklyn", "bklyn",
    "the bronx", "bronx", "queens", "staten island", "s.i.", "nyc"];
  // "New York" is ALSO the state's own name, so in FREE TEXT a trailing
  // "…, Rochester, New York" is the STATE, not the city — a bare "new york" in
  // an ADDRESS only classifies NYC when a state token follows it. Typed into the
  // CITY field it is unambiguous.
  var NYC_NAMES_NEED_TAIL = { "new york": 1 };
  // Tokens that may legitimately follow a multi-word borough name (the state /
  // country tail). Anything else means a DIFFERENT, longer city name.
  var CITY_TAIL_OK = { ny: 1, "new": 1, york: 1, nyc: 1, usa: 1, us: 1, united: 1, states: 1, america: 1, county: 1, borough: 1, city: 1 };

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

  /* ---------------- THE BAND EDGES — READ OFF THE LABELS, AND A ".99" EDGE IS THE
     ROUND NUMBER ABOVE IT ----------------
     OWNER-AUTHORIZED GUIDELINE CHANGE (2026-07-30, the owner's own words): "Fix this
     entire deal to allow every 75 to price as 74.99. And qualify the same, because this
     is a mistake from their excel sheet how they set it up, but in real life that should
     be the case. And it should be on every tier, on every scenario, on everything.
     Everything should go in this logic. We should do this small change to every single
     scenario. Every single pair, every single experience. Every single kind of a deal.
     It should not be this point 99. It should be the above."

     THE SHAPE OF THE PROBLEM. The workbook writes its band labels as percentages to two
     decimals and stops a band ONE HUNDREDTH OF A POINT short of the round number the
     next band advertises: "<64.99%" then "65.00%-70.00%"; "<74.99%" then
     "75.00%-80.00%"; "87.51%-89.99%" then "90.00%-92.50%". Between those two labels sits
     a seam — (64.99%, 65.00%], (74.99%, 75.00%], (89.99%, 90.00%] — that BOTH labels
     disclaim: the lower band says it ends at 64.99% and the upper band says it starts at
     65.00%. Read literally, a deal at exactly 65.00% / 75.00% / 90.00% is pushed UP into
     the dearer band (or into a band with no priced cell at all). Their sheet is a
     CHECKER — a human types a loan, which practically never lands on a round ratio — so
     the seam never bit them. Ours is a SIZER: it lands on the round number every time a
     cap or a de-leverage target binds. The owner's ruling is that the round number
     prices (and qualifies) as the band BELOW, everywhere.

     THE RULE, DERIVED FROM THE LABELS — never keyed to 0.65 / 0.75 / 0.90. Each band's
     upper edge is read out of its own label; an edge that ends in ".99" is LIFTED to the
     round number one hundredth above it. So the lower band covers up to and INCLUDING
     the round number and the band above starts strictly ABOVE it. A future workbook
     whose labels end on round numbers already parses to itself and nothing lifts.

     THIS REPLACES the narrower cap-only rule of the earlier 2026-07-30 commit
     (capBoundaryEdge / atCap's axis argument), which made the round number reachable
     ONLY where a tier cap sat exactly on the boundary. There is now exactly ONE
     mechanism — the classifier itself — so nothing can disagree with anything.

     READ-ONLY with respect to everything else: no rate cell, tier row, markup, fee or
     sizing formula is read or written here. The three lifted edges are the ONLY
     boundaries in the workbook that end in .99; every other band already ends on a round
     number and is byte-identical to before. */
  function bandUpperEdge(label, raw) {
    var s = clean(label), m = /^<\s*(\d+(?:\.\d+)?)\s*%$/.exec(s);
    if (!m) m = /^\d+(?:\.\d+)?\s*%\s*-\s*(\d+(?:\.\d+)?)\s*%$/.exec(s);
    if (!m) return null;                                 // unparseable label — never guessed
    var h = Math.round(parseFloat(m[1]) * 100);          // the edge in HUNDREDTHS of a percent
    if (!raw && h % 100 === 99) h += 1;                  // 64.99% → 65.00%, 74.99% → 75.00%, 89.99% → 90.00%
    return h / 10000;                                    // percent → fraction
  }
  function bandUpperEdges(labels, raw) {
    var out = [], i, e;
    for (i = 0; i < labels.length; i++) { e = bandUpperEdge(labels[i], raw); if (e == null) return null; out.push(e); }
    return out;
  }
  /* The UPPER EDGE of each band above, in band order — the exact boundaries
     ltcBand()/arBand() classify on AND the ladder the achievable-maximum lookup turns
     "the highest band that prices" back into a ratio with. ONE derivation, so a label
     change can never leave the two out of step. */
  var LTC_EDGES_UP = bandUpperEdges(LTC_BANDS);
  var AR_EDGES_UP  = bandUpperEdges(AR_BANDS);
  // The labels read LITERALLY, no lift. NOT a classifier — see STEP_EDGES_DESC.
  var LTC_EDGES_RAW = bandUpperEdges(LTC_BANDS, true);
  var AR_EDGES_RAW  = bandUpperEdges(AR_BANDS, true);
  function edgesDesc() {
    var seen = {}, out = [], a, i, v;
    for (a = 0; a < arguments.length; a++) {
      for (i = 0; i < arguments[a].length; i++) { v = arguments[a][i]; if (!seen[v]) { seen[v] = 1; out.push(v); } }
    }
    out.sort(function (x, y) { return y - x; });
    return out;
  }
  /* THE STEP-DOWN'S CANDIDATE LADDER — a SEARCH SPACE, not a policy.
     It carries the lifted edges AND the literal ones. The lifted edge is the one that
     matters (a candidate capped at 75.00% buys the same cell as one at 74.99% for a
     bigger loan, so it always wins the lattice's size test); the literal edge is kept as
     an extra, slightly smaller rung because it can be REACHABLE where the round one is
     not. A BRIDGE is the case that proves it: it is sized on the AS-IS value, so the
     AR-LTV axis is not a step-down candidate at all, and when the as-is value sits a
     hair above the after-repair value a loan at exactly 75.00% loan-to-cost implies an
     after-repair ratio a few hundred-thousandths OVER the 75% AR cap — no priced cell.
     The 74.99% rung pulls it back under; without it the search fell to the next rung
     (70.00%) and the loan dropped by ~$123k. Since the lattice only ever keeps the
     LARGEST priced loan (then the cheapest cell), a richer ladder can never make a deal
     worse — it can only find a structure that was there all along. */
  var STEP_EDGES_DESC = edgesDesc(LTC_EDGES_UP, AR_EDGES_UP, LTC_EDGES_RAW, AR_EDGES_RAW);
  var AR_EDGES_DESC   = edgesDesc(AR_EDGES_UP, AR_EDGES_RAW);
  /* The BORROWER-FACING price ladder's rungs are the lifted edges only: a rung one
     hundredth of a point under another buys the identical cell and would print as a
     near-duplicate row. */
  var LADDER_EDGES_DESC = edgesDesc(LTC_EDGES_UP, AR_EDGES_UP);

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
  // Caps print to 2 decimals: a 1-decimal format rounds an admin/de-leverage basis
  // like 0.8999 to a flat "90%", which reads as a DIFFERENT cap than the one that
  // actually bound (owner-directed 2026-07-30: say exactly which guideline is holding
  // it up). Trailing zeros stay trimmed: 0.925 → "92.5%", 0.90 → "90%". (The band
  // edges themselves no longer end in .99 — see bandUpperEdge — but a caller may still
  // hand us any number.)
  function pct2(x) { return (Math.round(x * 10000) / 100) + "%"; }
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
  function isNycZip(z) { return NYC_ZIP5.indexOf(z) > -1 || NYC_ZIP3.indexOf(z.slice(0, 3)) > -1; }
  function geoCheck(input) {
    var st = stateOf(input);
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
      if (zTyped && st && st !== "NY" && isNycZip(z)) {
        // Same two-typed-fields data problem, on the MARKET side: an NYC ZIP with
        // a state that isn't NY would otherwise price silently on the Standard
        // grid at Standard leverage (audit 2026-07-30, finding B). Mirrors the
        // excluded-ZIP zipstate path exactly — MANUAL, never a silent price.
        return {
          level: "MANUAL", label: "the NYC five boroughs", source: "zipstate",
          reason: "The ZIP code entered is in the NYC five boroughs (which price on their own rate grid, with their own leverage and loan-size limits) but the state entered doesn't match that ZIP — one of the two is wrong. This needs manual review to confirm the property's real location before it can be priced."
        };
      }
      // The fallback is gated on a RESOLVED state, never on "the field is
      // non-blank" (audit 2026-07-30, item 2): stateCode() passes unknown text
      // through verbatim, so "Nevada, USA" / "Las Vegas" / "Nev." / "N/A" / "??"
      // read as an authoritative state and DISABLED this whole branch — funding a
      // Las Vegas property, while the SAME text against a Philadelphia ZIP
      // correctly went to review. A typed VALID state stays authoritative.
      var zipState = stateResolved(input) ? null : ZIP3_TO_EXCLUDED_STATE[z.slice(0, 3)];
      if (zipState) {
        // The ZIP is provably inside a banned STATE. With NO state text at all the
        // typed ZIP is decisive (a ZIP read out of free text goes to review,
        // mirroring the banned-metro ZIP path). With state text we cannot RESOLVE,
        // the two fields may or may not agree — never price it silently; mirror the
        // existing zipstate MANUAL branch.
        var zsName = STATE_NAMES[zipState] || zipState;
        if (st) return { level: "MANUAL", label: zsName, source: "zipstate" };
        if (zTyped) return { level: "INELIGIBLE", label: zsName, source: "zip" };
        return { level: "MANUAL", label: zsName, source: "address" };
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
    // An excluded STATE named only in FREE TEXT was never caught: this fallback
    // scanned EXCLUDED_CITIES only, and Las Vegas / Minneapolis / Fargo / Sioux
    // Falls are not excluded CITIES — so "123 Main St, Las Vegas, Nevada" priced
    // (audit 2026-07-30, item 4; owner-directed: say which city and which zip is
    // blocked, include these restrictions). Read through the SAME
    // STATE_NAME_TO_CODE chokepoint, so a name and its AP abbreviation resolve
    // identically here and in the typed field. MANUAL, never a hard refusal: a
    // free-text read is lower confidence than a typed field (Nevada, Missouri and
    // Nevada, Iowa are real towns), and the engine's doctrine everywhere else is
    // "typed field refuses, free text goes to review".
    if (!stateResolved(input)) {
      var txtState = stateTailOf(input.state) || stateTailOf(input.city) || stateTailOf(input.address || input.propAddr);
      if (txtState && EXCLUDED_STATES.indexOf(txtState) > -1)
        return { level: "MANUAL", label: (STATE_NAMES[txtState] || txtState), source: "address" };
    }
    return null;
  }
  // The TRAILING state of a free-text line: a US address ends "…, City, ST" (or
  // "…, City, State"), optionally with the legacy ", USA" tail zipFromText also
  // strips. POSITION is the guard that keeps a STREET name from firing — "123
  // Nevada Ave, Denver, CO" ends in CO, so the Nevada in the street is never
  // read as the state. Whole tokens only, and any run containing a DIGIT is
  // dropped outright so "123 2nd St" can never contribute an "ND".
  function stateTailOf(t) {
    var s = clean(t)
      .replace(/(?:^|[\s,.;:])(?:u\.?\s?s\.?(?:\s?a\.?)?|united\s+states(?:\s+of\s+america)?)[\s,.;:]*$/i, "")
      .replace(/[\s,.;:\-]+$/, "");
    if (!s) return "";
    var flat = up(s).replace(/[A-Z0-9]*[0-9][A-Z0-9]*/g, " ").replace(/[^A-Z]+/g, " ").trim();
    if (!flat) return "";
    var toks = flat.split(" ");
    var n = toks.length, joined = "", cands = [], w;
    for (w = 1; w <= 3 && w <= n; w++) {                  // longest tail first: "NORTH DAKOTA" before "DAKOTA"
      joined = toks.slice(n - w).join("");
      cands.unshift(joined);
    }
    for (var i = 0; i < cands.length; i++) {
      var cd = cands[i];
      if (STATE_NAME_TO_CODE[cd]) return STATE_NAME_TO_CODE[cd];
      if (cd.length === 2 && VALID_STATE_CODES[cd]) return cd;
    }
    return "";
  }
  function zipFromText(t) {
    // Only a TRAILING 5-digit group reads as the ZIP — "60629 Main St, Dallas"
    // starts with a HOUSE NUMBER, and reading it as a ZIP hard-declined real
    // deals (audit 2026-07-30, finding 1). US addresses end "…, ST 12345".
    // A legacy pipeline address ends ", USA" (or a stray period) AFTER the ZIP,
    // which used to hide the ZIP completely — strip that tail first, then apply
    // the SAME end-anchored read so a house number still never counts
    // (audit 2026-07-30, finding F). The country token must follow a separator
    // so a city ending in "us" ("Columbus") is never chopped.
    var s = clean(t)
      .replace(/(?:^|[\s,.;:])(?:u\.?\s?s\.?(?:\s?a\.?)?|united\s+states(?:\s+of\s+america)?)[\s,.;:]*$/i, "")
      .replace(/[\s,.;:]+$/, "");
    var m = s.match(/\b(\d{5})(?:-\d{4})?\s*$/);
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

  // Borough-name match. WORD boundaries keep "Queensbury"/"Bronxville" from
  // reading as Queens/the Bronx (audit 2026-07-30, finding 4); a MULTI-WORD name
  // must additionally match the whole token sequence, so "New York Mills" is not
  // New York City (finding A). Internal whitespace is collapsed first so
  // "Staten  Island" reads the same as "Staten Island" (finding E).
  function squash(s) { return low(s).replace(/\s+/g, " "); }
  function nameHit(hay, name, isCity) {
    if (!hay) return false;
    var esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var re = new RegExp("(^|[^a-z])" + esc + "($|[^a-z])", "g");
    var m;
    while ((m = re.exec(hay)) !== null) {
      var end = m.index + (m[1] ? m[1].length : 0) + name.length;
      // the next word attached to the match (separated only by spaces/commas/dots)
      var t = /^[ ,.]{0,3}([a-z]+)/.exec(hay.slice(end));
      var tail = t ? t[1] : "";
      var ok = true;
      if (name.indexOf(" ") > -1 && tail && !CITY_TAIL_OK[tail]) ok = false;   // a longer, different city
      if (NYC_NAMES_NEED_TAIL[name] && !isCity && !CITY_TAIL_OK[tail]) ok = false;  // the STATE's own name in free text
      if (ok) return true;
      re.lastIndex = m.index + 1;
    }
    return false;
  }
  // Market token: NYC five boroughs vs everything else.
  function marketOf(input) {
    var st = stateOf(input);
    if (st && st !== "NY") return "STD";
    var z = zip5(input.zip) || zipFromText(input.address || input.propAddr);
    if (z) {
      if (isNycZip(z)) return "NYC";
      return "STD";
    }
    // Name fallback — the CITY field is judged on its own (a typed city is
    // unambiguous), the free-text address second.
    var cityHay = squash(input.city), addrHay = squash(input.address || input.propAddr || "");
    for (var i = 0; i < NYC_NAMES.length; i++) {
      if (nameHit(cityHay, NYC_NAMES[i], true)) return "NYC";
      if (nameHit(addrHay, NYC_NAMES[i], false)) return "NYC";
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

  /* ---------------- band classification (the Pricing Tool's bands, with the
     owner-authorized .99 edge lift of 2026-07-30 baked into the edge list) ----------------
     A ratio falls in the FIRST band whose upper edge it does not exceed. Because a ".99"
     edge was lifted to the round number above it, a deal at exactly 65.00% AR-LTV /
     75.00% loan-to-cost / 90.00% loan-to-cost — and everything in the seam below it —
     classifies in the LOWER, cheaper band, and the band above starts strictly above that
     round number. Every other edge is unchanged, so every other ratio bands as before. */
  function bandOf(labels, edges, r) {
    if (!(r > 0)) return null;
    for (var i = 0; i < edges.length; i++) if (r <= edges[i]) return labels[i];
    return null;                                   // above the top band — never priced
  }
  function arBand(r)  { return bandOf(AR_BANDS,  AR_EDGES_UP,  r); }
  function ltcBand(r) { return bandOf(LTC_BANDS, LTC_EDGES_UP, r); }
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

  /* ---------------- ACHIEVABLE maximum leverage ----------------
     THE RATE GRID *IS* THE LEVERAGE POLICY. A tier-grid cap the grid never prices is
     a number no borrower on that profile can ever reach — printing it as the "program
     maximum" is precisely the misleading display the owner reported (2026-07-30):
     "the tier two cannot anytime get 92.5 even if it says that it's available because
     it doesn't price — so keep that tier at 85%."

     For the deal's grid FAMILY (market | size | product | purpose | term | tier |
     FICO band) this scans every priced cell and returns the UPPER EDGE of the highest
     LTC band and the highest AR-LTV band that carry ANY price. Derived from the grid
     itself, so it stays right for every family and every future regeneration of the
     workbook — nothing is hard-coded per tier.
       e.g. STD | S | GUC | R | 18 | T2 | FICO 700+ prices LTC bands 1–3 only
            (<74.99%, 75–80%, 80.01–85%) ⇒ achievable max LTC = 85.00%, not the tier
            grid's 92.50%; and AR bands 1–2 only ⇒ achievable max AR-LTV = 70.00%.
     Returns null when the family has NO priced cell at all (there is nothing to
     achieve — the caller falls back to the tier row and the engine separately raises
     its "No priced grid cell" reason). READ-ONLY: no rate, band edge, tier cap or
     sizing formula is computed or changed here. */
  function achievableCaps(mkt, sizeBand, prodTok, purp, termTok, tier, ficoB) {
    if (!ficoB) return null;
    var block = RATE_BLOCKS[mkt + "|" + sizeBand + "|" + prodTok + "|" + purp + "|" + termTok + "|T" + tier];
    if (!block) return null;
    var fl = (tier === 3) ? FICO_BANDS_3 : FICO_BANDS_12;
    var j = fl.indexOf(ficoB);
    if (j < 0) return null;
    var bestLtc = -1, bestAr = -1, i, k;
    for (i = 0; i < AR_BANDS.length; i++) {
      for (k = 0; k < LTC_BANDS.length; k++) {
        if (block[(i * 3 + j) * 6 + k] > 0) {
          if (k > bestLtc) bestLtc = k;
          if (i > bestAr) bestAr = i;
        }
      }
    }
    if (bestLtc < 0) return null;                       // this FICO band prices nothing
    /* The edges are the LIFTED ones (see bandUpperEdge), so a family whose highest
       priced band is one of the three .99-labelled bands reports the ROUND number the
       deal can now genuinely reach — 65.00% AR-LTV, 75.00% / 90.00% loan-to-cost —
       instead of the sliver beneath it. Nothing else about this lookup changed, and
       where the tier row is the lower of the two the tier row still wins (the caller
       takes the minimum), so a whole-band gap such as GUC tier 2's 92.50% over an
       85.00% frontier is still reported at the actually-priced 85.00%. */
    return { maxLTC: LTC_EDGES_UP[bestLtc], maxARLTV: AR_EDGES_UP[bestAr] };
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
      if (sizedL > SMALL_MAX + 0.5) {
        // The LARGE grid has genuine holes (e.g. STD GUC tier 1, FICO 640-659 has
        // no >$2.5M cells at ANY leverage) and the deal dead-ended at "no priced
        // grid cell" — while the workbook funds exactly $2.5M for the same sponsor
        // on the SMALL grid (GUC audit 2026-07-30, finding 4: 27 dead ends).
        // Retry the small band capped at its own $2.5M ceiling. Scoped tightly to
        // the no-cell case: a large-band refusal for ANY other reason (tier caps,
        // geography, the FICO floor, a value-add failure) is INELIGIBLE or carries
        // its own reason and is never resurrected here.
        if (isNoCellOnly(rL)) {
          var rS = evaluateBand(input, "S", SMALL_MAX);
          if (rS.status !== "INELIGIBLE" && rS.noteRate > 0) return rS;
        }
        return rL;                                   // genuinely a large-band loan
      }
      // Large-band tiering caps it back under $2.5M — stay small-band, capped there.
      var r2 = evaluateBand(input, "S", SMALL_MAX);
      return r2;
    }
    return r;
  }
  // TRUE when the ONLY thing standing between this evaluation and a price is the
  // absence of a grid cell (no rate, MANUAL, and the no-cell reason is present).
  function isNoCellOnly(ev) {
    if (!ev || ev.status !== "MANUAL" || ev.noteRate > 0) return false;
    var rs = ev.reasons || [];
    for (var i = 0; i < rs.length; i++) if (/No priced grid cell/.test(rs[i].msg)) return true;
    return false;
  }

  function evaluateBand(input, sizeBand, loanCapOverride) {
    var reasons = [], status = "ELIGIBLE";
    // The tier-grid row for this product | purpose | tier, verbatim, and the PROGRAM
    // MAXIMUM a borrower on this profile can actually reach. Both are filled the moment
    // the tier row is read (below) and NEVER narrowed afterwards — see the note there.
    // null until then, and on the paths that never get a row at all.
    var tierRow = null, progMax = null;
    function add(level, msg, code) { var r = { level: level, msg: msg }; if (code) r.code = code; reasons.push(r); if (RANK[level] > RANK[status]) status = level; }

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
      if (geo.level === "INELIGIBLE") add("INELIGIBLE", geo.reason || ("Properties in " + geo.label + " are not eligible for the Silver Program."));
      else {
        geoReview = geo.label;
        add("MANUAL", geo.reason || (geo.source === "city"
          ? "Properties in " + geo.label + " aren't eligible for the Silver Program — this scenario needs manual review."
          : geo.source === "zipstate"
            ? "The ZIP code entered is in " + geo.label + " (not eligible for the Silver Program) but the state entered doesn't match that ZIP — one of the two is wrong. This needs manual review to confirm the property's real location before it can be priced."
            : "This address looks like it's in " + geo.label + ", which isn't eligible for the Silver Program — it needs manual review to confirm the exact location (a ZIP code decides). If the property isn't in " + geo.label + ", we can price it."));
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
    /* ================================================================
       THREE DIFFERENT MEANINGS OF "MAX LEVERAGE" — the result carries all three,
       because conflating them is the bug the owner reported on 2026-07-30.

       tierRow  (result `tierCaps`)  — the WORKBOOK's Tier Grid row, verbatim, captured
                 BEFORE anything narrows it. The guideline document's own numbers. This
                 is what the shadow-parity monitor validates against; it is NOT what a
                 borrower is shown, because the grid does not price every cap it lists.

       progMax  (result `caps`)      — the PROGRAM MAXIMUM a borrower on this profile can
                 ACTUALLY reach: the tier row, lowered to the highest LTC / AR-LTV band
                 the rate grid genuinely prices for this family (see achievableCaps).
                 Owner-directed: "the tier two cannot anytime get 92.5 even if it says
                 that it's available because it doesn't price — so keep that tier at 85%."
                 FIXED for the profile: it is a function of FICO band, experience tier,
                 product, purpose, market, size band and term — never of the interest
                 reserve, the rehab budget, the ARV or the price. This is what every
                 "Program maximum leverage — from FICO & experience" surface shows, on
                 all three programs, with no Silver special-casing.

       capsEff  (result `pricedCeiling`) — the ceiling THIS DEAL was actually sized and
                 priced at: progMax's tier row narrowed by a voluntary de-leverage, an
                 admin basis, and above all by the grid-aware STEP-DOWN that walks the
                 deal down to a priced cell. A financed interest reserve is part of the
                 COST BASIS, so changing it moves the deal into a different band and
                 moves THIS number — which is correct, and is exactly why it may never
                 be printed under a label promising the program maximum. Every
                 enforcement path (the shadow monitor, the structure underwriter, the
                 registered-product checks) measures against THIS one.

       `capsEff` remains the ONLY thing the sizing waterfall is ever handed, so no loan
       amount, rate, band edge or dollar figure moves — only the result's field names.
       ================================================================ */
    tierRow = { maxLoan: c.maxLoan, minFico: c.minFico, maxAcqLTV: c.maxAcqLTV, maxARLTV: c.maxARLTV, maxLTC: c.maxLTC };
    progMax = { maxLoan: c.maxLoan, minFico: c.minFico, maxAcqLTV: c.maxAcqLTV, maxARLTV: c.maxARLTV, maxLTC: c.maxLTC };
    (function () {
      // The reachable frontier is read straight off the rate grid, on the LIFTED band
      // edges (owner-authorized 2026-07-30 — see bandUpperEdge), so a family whose top
      // priced band is one of the three .99-labelled bands reports the round number.
      var ach = achievableCaps(market, sizeBand, pTok, purp, termTok, tier, ficoBand(tier, fico || 700));
      if (!ach) return;                                   // nothing prices here — the tier row is the honest fallback
      if (ach.maxLTC < progMax.maxLTC) progMax.maxLTC = ach.maxLTC;
      if (ach.maxARLTV < progMax.maxARLTV) progMax.maxARLTV = ach.maxARLTV;
    }());
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
    // Name the TIER that set the floor — "below the 700 minimum for this tier"
    // left the reader hunting for which tier they landed in (owner-directed
    // 2026-07-30: say exactly which guideline is holding it up).
    if (fico > 0 && fico < c.minFico) add("MANUAL", "FICO " + fico + " is below the Tier " + tier + " minimum of " + c.minFico + " — eligible with a credit-committee waiver review.");

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
    // NOTE the num()-sanitized aiv/arv: the raw input values reach the shared
    // sizing waterfall, and a NON-NUMERIC arv ("900,000" from a pasted field)
    // made every sizing figure NaN while the deal still reported ELIGIBLE
    // (audit 2026-07-30, finding F). aiv/arv are already Math.max(0, num(...))
    // above, so for every numeric input this is byte-identical.
    var dealForSize = {
      loanType: loanType, purchasePrice: effPurchase, asIsValue: aiv, arv: arv,
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
    /* ---------------- THE RATE ALWAYS BELONGS TO THE STRUCTURE WE REPORT ----------------
       OWNER-AUTHORIZED (2026-07-30, the owner's own words): "If something is
       ineligible on the Excel pricer from AMCAP, that should go to manual review.
       And it should not price themselves. And we need to find above why this issue
       is happening and fix the root bug, not just fix the scenarios, not fix the
       front. Fix the real source of the issue how it was built."

       THE ROOT. This is a TWO-PASS loop: pass 1 sizes on a guessed rate and reads a
       rate off that structure; pass 2 re-sizes on the real rate — which changes the
       financed interest reserve, and therefore the loan, and therefore its LTC and
       AR-LTV bands. The second pass used to end `rateAt(sizing) || rate`. That `||
       rate` is the bug, and the flaw it encodes is a DESIGN one: it guaranteed we
       always HAVE a rate rather than that the rate is CORRECT. When the re-sized
       structure landed in a band the workbook does not price, `rateAt` returned null
       and we silently kept pass 1's rate — a rate belonging to a structure that no
       longer exists. Worse, because `rate` was then truthy, the grid-aware step-down
       below never ran and the "No priced grid cell" reason never fired, so the deal
       was reported ELIGIBLE carrying a rateKey naming a cell the workbook has no
       value for. Reproduced: GUC purchase tier 2, 24-month, NJ — ELIGIBLE at 10.75%
       on STD|S|GUC|P|24|T2|70.01%-75.00%|FICO 660-699|80.01%-85.00%, which is not
       one of the workbook's 1,555 cells.

       THE FIX IS THE INVARIANT, not a special case: the reported rate is ALWAYS
       `rateAt` of the structure being reported, or there is no rate. Dropping the
       fallback is what makes the rest of the engine work as it was already written
       — a null rate lets the step-down lattice search for a structure the grid
       genuinely prices, and if none exists the deal falls to the existing MANUAL
       reason ("No priced grid cell for this profile — submit for individual
       review"). Nothing new is invented here; the fallback was suppressing the
       machinery that was already correct.

       The same shape is present in the Standard and Gold engines (both frozen and
       NOT covered by this authorization) — reported to the owner, not changed. */
    if (rate) { dealForSize.noteRateForIR = rate; sizing = YSP.sizeLoan(dealForSize, capsEff); rate = rateOvr || rateAt(sizing); }

    // A loan sized right up to a leverage cap lands exactly ON that cap — but the
    // reported total is rounded to the cent, so the ratio it implies can come back
    // a hair ABOVE the cap (0.925 → 0.9250000000000002; on a small basis the cent
    // of rounding is worth ~3e-8 of ratio). Read literally that is the NEXT band,
    // which has no cell, so the deal forfeited a WHOLE band of leverage — the
    // engine landed at 89.99% loan-to-cost on a deal the grid prices at 92.5%, for
    // the same rate (parity audit 2026-07-30: 70 of 3,450 sized deals, up to $145k
    // short). A cap-bound structure is classified AT its cap. The window is 1e-6 —
    // four orders of magnitude below the narrowest band (0.0249), so it can only
    // ever absorb rounding, never reclassify a genuinely different structure.
    // THE SEAM AT A .99 BAND LABEL IS NO LONGER THIS FUNCTION'S BUSINESS (owner-
    // authorized 2026-07-30 — see bandUpperEdge): the classifier itself now covers
    // (64.99%, 65.00%], (74.99%, 75.00%] and (89.99%, 90.00%] on the band below, for
    // every deal and every cap, so the cap-only mechanism this used to carry
    // (capBoundaryEdge / an `axis` argument) is gone and there is exactly ONE rule.
    // What remains is the pure ROUNDING snap, which is unrelated and still needed.
    function atCap(ratio, cap) {
      if (!(cap > 0)) return ratio;
      if (ratio > cap && ratio < cap + 1e-6) ratio = cap;
      return ratio;
    }
    function rateAt(s) {
      var g = gridRate(market, sizeBand, pTok, purp, termTok, tier,
        arBand(atCap(arForBand(s), capsEff.maxARLTV)), ficoBand(tier, fico || 700),
        ltcBand(atCap(s.ltcPct > 0 ? s.ltcPct : capsEff.maxLTC, capsEff.maxLTC)));
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
    // The frontier the grid prices is NOT always an LTC band edge — very often it
    // is an AR-LTV band edge (the workbook's own max sits at e.g. 64.99% of the
    // ARV, one cent under the next AR band). Stepping only the LTC edge down
    // under-lent 54 deals by up to $12k and then blamed loan-to-cost for a cap
    // the after-repair value had set (GUC audit 2026-07-30, finding 3). So BOTH
    // band families are candidate frontiers, each scanned high→low (a higher edge
    // is always the larger loan, so the first that prices is that family's best),
    // and the LARGER of the two priced loans wins — the true maximum structure
    // the grid buys. The winning family NAMES itself in the reason.
    if (!rate && !rateOvr && sizing.totalLoan > 0 && fico > 0) {
      // The candidate ladders are the DERIVED band edges — see STEP_EDGES_DESC: the
      // lifted edge (65.00% / 75.00% / 90.00%) is the one that normally wins, and the
      // literal .99 edge rides along as a slightly smaller fallback rung for the cases
      // where the round one is not reachable.
      var EDGES = STEP_EDGES_DESC;
      var AR_EDGES = AR_EDGES_DESC;
      // Same cap-bound rounding rule as the primary pass: a candidate sized to the
      // edge it is testing must be classified AT that edge, or every candidate
      // would reject itself and the search would walk past the real frontier (this
      // is what left NYC fix & flip at 78.5% of a band the grid prices to 80%).
      var gridAt = function (s, capsTry) {
        var arRatio = (sc === "BR") ? (s.totalLoan / (arv || aiv)) : (arv > 0 ? s.totalLoan / arv : 0);
        return gridRate(market, sizeBand, pTok, purp, termTok, tier,
          arBand(atCap(arRatio, capsTry.maxARLTV)), ficoBand(tier, fico || 700),
          ltcBand(atCap(s.ltcPct > 0 ? s.ltcPct : capsTry.maxLTC, capsTry.maxLTC)));
      };
      // A candidate is evaluated EXACTLY the way the primary pass evaluates the
      // deal: seed the financed reserve with the rate guess for THIS candidate's
      // own cap edges, size, settle on the bands achieved, re-size. Reusing the
      // primary pass's guess (computed at the deal's FULL leverage) sized the
      // reserve for a different structure, which landed the candidate in a
      // neighbouring, unpriced band — so a leverage step the grid genuinely prices
      // was rejected and the search dropped a further band (parity audit
      // 2026-07-30: a GUC deal held at 74.99% of an 80% band, $99,997 short).
      var tryCaps = function (capsTry) {
        var seed = gridRate(market, sizeBand, pTok, purp, termTok, tier,
          arBand(Math.min(capsTry.maxARLTV, 0.75)), ficoBand(tier, fico || 700),
          ltcBand(Math.min(capsTry.maxLTC, 0.925)));
        var d2 = {
          loanType: loanType, purchasePrice: effPurchase, asIsValue: aiv, arv: arv,
          rehabBudget: rehab, irMonths: irMonthsEff, irAmount: irAmountReq, accrual: input.accrual,
          noteRateForIR: (seed == null ? 0.10 : seed) + effMarkup(),
          reserveCapMonths: termMonths, reserveInCost: true, bridge: (sc === "BR")
        };
        var s2 = YSP.sizeLoan(d2, capsTry);
        if (!(s2.totalLoan > 0)) return null;
        var g2 = gridAt(s2, capsTry);
        if (g2 == null) return null;
        d2.noteRateForIR = g2 + effMarkup();
        var s3 = YSP.sizeLoan(d2, capsTry);
        // The re-size produced no loan at all, so the FIRST-pass structure stands —
        // and (s2, g2) is a consistent pair, because g2 IS gridAt(s2).
        if (!(s3.totalLoan > 0)) return { caps: capsTry, grid: g2, total: s2.totalLoan, sizing: s2 };
        var g3 = gridAt(s3, capsTry);
        /* SAME ROOT AS THE MAIN RATE/IR LOOP ABOVE, ONE LEVEL DOWN (owner-authorized
           2026-07-30 — "it should not price themselves ... fix the real source of the
           issue how it was built"). This used to end `grid: (g3 == null ? g2 : g3)`
           while still returning `sizing: s3` — pairing the rate of a structure it
           THREW AWAY (s2) with the structure it REPORTS (s3). That is what actually
           produced the reported defect: the block below states that "tryCaps already
           settled the rate on the bands its FINAL sizing lands in ... the charged
           cell and the printed structure are the same one by construction", and this
           fallback was the one path where that sentence was false. A GUC purchase
           tier 2, 24-month NJ deal came back ELIGIBLE at 10.75% on
           STD|S|GUC|P|24|T2|70.01%-75.00%|FICO 660-699|80.01%-85.00% — not one of
           the workbook's 1,555 cells.
           A candidate whose FINAL structure the grid does not price is not a
           candidate. Rejecting it is not a loss: the lattice simply keeps searching
           the other cap pairs, and only if EVERY pair fails does the deal fall to
           the existing "No priced grid cell — submit for individual review", which
           is the outcome the owner asked for. */
        if (g3 == null) return null;
        return { caps: capsTry, grid: g3, total: s3.totalLoan, sizing: s3 };
      };
      // THE FRONTIER IS A LATTICE, NOT A LINE. Tightening ONE axis at a time can
      // never reach a structure that needs BOTH: cap only the loan-to-cost and the
      // loan stays wide enough that its AFTER-REPAIR ratio sits in an unpriced AR
      // band; cap only the after-repair value and the loan stays wide enough that
      // its LOAN-TO-COST sits in an unpriced LTC band — while the pair (85% LTC AND
      // 70% AR) prices, for $39,512 more (parity audit 2026-07-30). So the search is
      // the full CROSS PRODUCT of the two band-edge families, exactly the candidate
      // set the workbook's own max-eligible frontier is drawn from. Both lists carry
      // the deal's OWN cap first, so "reduce only the other axis" is a candidate too.
      var ltcCands = [capsEff.maxLTC], arCands = [capsEff.maxARLTV], ee;
      for (ee = 0; ee < EDGES.length; ee++) {
        if (EDGES[ee] > capsEff.maxLTC - 1e-9) continue;         // at/above the deal's own cap
        ltcCands.push(EDGES[ee]);
      }
      // The AR axis only bounds a value-add product — a bridge is sized on the as-is
      // value, so its after-repair ratio is a reporting figure, not a wall.
      if (sc !== "BR" && arv > 0) {
        for (ee = 0; ee < AR_EDGES.length; ee++) {
          if (AR_EDGES[ee] > capsEff.maxARLTV - 1e-9) continue;
          // Land on the largest WHOLE-DOLLAR loan inside the band, which is the
          // workbook's own frontier: edge x ARV can fall on a half dollar (0.65 x
          // $625,001 = $406,250.65) and a loan reported one cent above the edge
          // reads into the NEXT — unpriced — AR band.
          arCands.push(Math.min(AR_EDGES[ee], Math.floor(AR_EDGES[ee] * arv) / arv));
        }
      }
      // THE LATTICE OPTIMISES LOAN SIZE — AND, ON A TIE, PRICE.
      // When the loan is pinned by the after-repair value or the tier dollar cap,
      // the LTC cap is a FREE parameter: several candidates fund the IDENTICAL
      // total while landing in differently priced LTC bands. Scanning
      // least-restrictive-first and keeping only a STRICT size improvement kept
      // the LOOSEST caps, so the borrower was charged MORE for the same loan —
      // e.g. a $2,673,677.25 ground-up loan priced 10.375% instead of 10.125%,
      // +$10,026 of interest over 18 months for the same money (audit 2026-07-30,
      // item 1: 7 same-loan rate increases per 200k scenarios). The ordering is
      // therefore, in strict priority:
      //   (1) a MATERIALLY larger loan always wins (the workbook's own max-eligible
      //       frontier — never trade loan size for rate);
      //   (2) on effectively the same loan (within $0.50), the LOWER grid rate wins;
      //   (3) on the same loan AND the same rate, the caps that CUT LESS win — a
      //       tightening that changes neither the loan nor the price bound nothing,
      //       and naming it would blame a guideline that is not holding the deal
      //       back (measured: preferring the tighter caps there invented 102
      //       after-repair-cap claims and 21 loan-to-cost claims per 30k that the
      //       sizing does not sit on). So the reason only ever names a cap that
      //       genuinely moved the structure.
      var cutCount = function (cc) {
        return (cc.maxLTC < capsEff.maxLTC - 1e-9 ? 1 : 0) + (cc.maxARLTV < capsEff.maxARLTV - 1e-9 ? 1 : 0);
      };
      /* CASH TO CLOSE, at a fixed total loan (owner-directed 2026-07-30, asked and
         answered in the owner's own words: "Would rather take the more expensive
         option with less cash to close.").
         At the same total loan the LTC cap is a free parameter, and two candidates
         can fund the identical loan while splitting it differently between the
         acquisition advance and the financed interest reserve. Every dollar that
         moves out of the advance is a dollar the borrower has to bring to the
         table: a real case moved a $1,234,795.50 loan from a $308,699 to a
         $411,599 cash requirement — for a quarter point off the rate. Over the term
         that roughly evens out (the bigger reserve prepays interest they would owe
         anyway) but the cash TIMING is much worse, and cash at closing is the
         scarcest thing these borrowers have. So the advance is compared BEFORE the
         rate, and a dearer cell that needs less cash now wins.
         `acquisition` is the right measure on every product: on a purchase it is
         what reaches the seller (down payment = cost basis minus advance), and on a
         refinance it is what retires the existing loan (or, on a cash-out, what the
         borrower receives) — in both directions a LARGER advance is less cash out
         of pocket. The $0.50 window matches the loan comparison, so float noise can
         never flip the choice. */
      var advance = function (r) { return (r && r.sizing && r.sizing.acquisition > 0) ? r.sizing.acquisition : 0; };
      var betterThan = function (got, keep) {
        if (!keep) return true;
        if (got.total > keep.total + 0.5) return true;           // (1) materially larger loan
        if (got.total < keep.total - 0.5) return false;
        var ga = advance(got), ka = advance(keep);               // (2) same loan ⇒ less cash to close
        if (ga > ka + 0.5) return true;
        if (ga < ka - 0.5) return false;
        if (got.grid < keep.grid - 1e-12) return true;           // (3) same loan + cash, cheaper cell
        if (got.grid > keep.grid + 1e-12) return false;
        var gc = cutCount(got.caps), kc = cutCount(keep.caps);   // (4) all equal ⇒ cut less
        if (gc !== kc) return gc < kc;
        if (got.caps.maxLTC > keep.caps.maxLTC + 1e-9) return true;
        if (got.caps.maxLTC < keep.caps.maxLTC - 1e-9) return false;
        return got.caps.maxARLTV > keep.caps.maxARLTV + 1e-9;
      };
      var best = null, li, ai;
      for (li = 0; li < ltcCands.length; li++) {
        for (ai = 0; ai < arCands.length; ai++) {
          if (li === 0 && ai === 0) continue;                    // the caps that just failed
          var got = tryCaps({ maxLoan: capsEff.maxLoan, minFico: capsEff.minFico, maxAcqLTV: capsEff.maxAcqLTV, maxARLTV: arCands[ai], maxLTC: ltcCands[li] });
          if (got && betterThan(got, best)) best = got;
        }
      }
      if (best) {
        // tryCaps already settled the rate on the bands its FINAL sizing lands in
        // (the same second pass the main rate/IR loop runs), so the charged cell and
        // the printed structure are the same one by construction.
        /* MEASURED AGAINST THE PROGRAM MAXIMUM, NOT THE RAW TIER ROW. `capsEff` here
           is still the tier row, which can advertise leverage the grid never prices
           (GUC refi tier 2: 92.5% loan-to-cost against a grid that stops at 85%).
           Comparing against it announced "leverage is capped at 70% of the
           after-repair value" on a deal whose ceiling IS the program maximum of 70%
           — naming a guideline as if it had held the deal back when the borrower is
           already at the most the program offers. The sentence exists to explain a
           ceiling BELOW the program maximum, so that is what it now tests, matching
           the published `pricedCeiling` (clamped to the same maximum). */
        var cutLtc = best.caps.maxLTC < capsEff.maxLTC - 1e-9;
        var cutAr = best.caps.maxARLTV < capsEff.maxARLTV - 1e-9;
        rate = best.grid + effMarkup();
        sizing = best.sizing;
        capsEff = best.caps;
        // NAME the guideline that actually holds the deal back — blaming
        // loan-to-cost for a cap the after-repair value set sent borrowers to
        // reduce the wrong number (GUC audit 2026-07-30, finding 3).
        // The `code` is an ADDITIVE, stable marker (existing readers use .level/.msg
        // only) so a DISPLAY surface can find this exact sentence without pattern-
        // matching its wording — it is the "why is this deal's ceiling below the tier
        // maximum" explanation the studio prints beside `tierCaps` (owner-directed
        // 2026-07-30). No wording, level or number changes.
        if (cutLtc || cutAr) {
          add("ELIGIBLE", "Leverage is capped at " +
            (cutLtc && cutAr
              ? (pct2(best.caps.maxLTC) + " loan-to-cost and " + pct2(best.caps.maxARLTV) + " of the after-repair value")
              : cutAr
                ? (pct2(best.caps.maxARLTV) + " of the after-repair value")
                : (pct2(best.caps.maxLTC) + " loan-to-cost")) +
            " — the program doesn't price this profile above " + (cutAr && !cutLtc ? "that after-repair band" : "that band") + " for this market.",
            "leverage_capped");
        }
      }
    }

    // ---- no priced grid cell at any leverage → individual review ----
    // The reported key is derived through atCap() — BYTE-FOR-BYTE the expressions
    // rateAt()/gridAt() charge off — so the key always names the cell the engine
    // actually priced on. Deriving it from the RAW ratios instead named a cell the
    // workbook does not price whenever atCap fired: a cap-bound loan reported
    // "…|90.00%-92.50%" while it was charged the 87.51%-89.99% cell (audit
    // 2026-07-30, item 3; owner-directed: everything should tie up, the buy rate
    // included). No rate, band edge, cap or sizing figure moves — only the label.
    var arB = arBand(atCap(arForBand(sizing), capsEff.maxARLTV)),
        fB = ficoBand(tier, fico || 700),
        lB = ltcBand(atCap(sizing.ltcPct > 0 ? sizing.ltcPct : capsEff.maxLTC, capsEff.maxLTC));
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
    // A ground-up loan is sized against the AFTER-REPAIR value, so with no ARV on
    // file every cap collapses to zero and the deal reported "the rehab budget
    // exceeds what this program can finance" — a refusal about the wrong field
    // (audit 2026-07-30, finding F). Name the missing input instead.
    // EVERY value-add product is sized against the AFTER-REPAIR value (capARV =
    // maxARLTV x ARV is a hard wall in the shared waterfall), so with no ARV on
    // file the caps collapse to zero for fix & flip / fix & hold exactly as they do
    // for ground-up. Scoping the named reason to ground-up left a F&F deal
    // reporting ELIGIBLE with a $0 loan and "Meets the Silver Program guidelines"
    // (audit 2026-07-30, item 7). A BRIDGE is sized on the as-is value (capARV is
    // Infinity there) and genuinely needs no ARV — it is the only exemption.
    var arvMissing = (sc !== "BR") && !(arv > 0);
    if (arvMissing) add("MANUAL", (sc === "NC")
      ? "After-repair value is required to size a ground-up loan — enter the completed (as-built) value and this scenario can be priced."
      : "After-repair value is required to size a fix & flip / fix & hold loan — enter the after-repair value and this scenario can be priced.");
    else if (sizing.rehabOverCap) add("MANUAL", "The rehab budget exceeds what this program can finance — the loan is capped at " + usd(sizing.totalLoan) + ", so the remaining budget would be funded out of pocket. Reduce the scope or use a larger facility.");

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
      // `caps` = the PROGRAM MAXIMUM (fixed for the profile); `pricedCeiling` = what
      // THIS deal was sized/priced at. See the three-meanings note at the tier-row
      // read. Every enforcement path reads `pricedCeiling`; every "program maximum"
      // display reads `caps`.
      caps: progMax, pricedCeiling: capsEff, noteRate: rate || 0, sizing: sizing,
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
        pricingReady: fico > 0, assignment: assignment, noteRate: 0, sizing: null,
        // All three leverage meanings are present on EVERY result shape, including the
        // early refusals, so no surface ever has to fall back to the wrong one:
        //   caps          = the PROGRAM MAXIMUM this profile can actually reach (fixed)
        //   pricedCeiling = what THIS deal was sized and priced at (may be lower)
        //   tierCaps      = the workbook Tier Grid row, verbatim (guideline document)
        caps: progMax, pricedCeiling: null, tierCaps: tierRow
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
  var LADDER_BUCKETS = LADDER_EDGES_DESC;
  function priceLadder(input) {
    var full = evaluate(input);
    if (full.status === "INELIGIBLE" || !full.sizing || !(full.sizing.totalLoan > 0)) {
      return { eligible: false, status: full.status, reasons: full.reasons, rows: [] };
    }
    var maxLtc = full.sizing.ltcPct;
    var rows = [];
    // TRUE-MAX top rung. The bucket-skip (`b > maxLtc` → continue) left the top
    // rung a whole band BELOW the deal's real maximum in 71% of ladders (up to a
    // $223k gap), so the term sheet's ladder page contradicted its own page 1
    // (owner-directed 2026-07-30: "everything should tie up… the Max leverage the
    // loan amounts"). Adopting the Standard engine's ltcBucket semantics
    // (standard-program.js priceLadder): the FIRST row is the deal's EXACT
    // maximum sizing — the very numbers evaluate() reports — and the band-edge
    // rungs below it are the voluntary de-leverage steps.
    // Its `ltc` is 0 on purpose: that is the ONLY marker that round-trips back
    // through evaluate() as "no targetLTC", i.e. reproduces this exact maximum.
    // Any real edge value would re-cap the sizing and could shift the loan.
    var trueMax = (full.noteRate > 0);
    if (trueMax) {
      var fs = full.sizing;
      rows.push({
        ltc: 0, targetLtcPct: fs.ltcPct, totalLoan: fs.totalLoan, initialAdvance: fs.acquisition,
        downPayment: fs.downPayment, rehabHoldback: fs.rehabLoan, noteRate: full.noteRate,
        monthlyPayment: round2(fs.totalLoan * (full.noteRate / 12)),
        isMax: true
      });
    }
    for (var i = 0; i < LADDER_BUCKETS.length; i++) {
      var b = LADDER_BUCKETS[i];
      // with a true-max rung in place, only rungs strictly BELOW it are steps;
      // without one (nothing prices at the max) keep the original bucket window.
      if (trueMax ? (b >= maxLtc - 1e-9) : (b > maxLtc + 1e-4)) continue;
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
