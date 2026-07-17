/* =====================================================================
   gold-standard.js  —  "Gold Standard Program" loan engine
   ---------------------------------------------------------------------
   Second YS Capital program (separate from the Standard Program engine).
   IMPORTANT brand & pricing rules, mirroring the Standard engine:
     • The source program name is NEVER exposed anywhere user-facing.
     • The borrower NOTE RATE = the sheet price + adjustments (NO markup). The
       only borrower add-on is the 1% origination, same as the Standard Program.
   Distinct mechanics vs. the Standard Program (do not cross-wire):
     • Pricing is FLAT per product × tier — leverage does NOT change the
       rate. Leverage caps only limit the loan size.
     • Tiering is driven by EXPERIENCE (renovation/bridge vs. ground-up),
       with a FICO floor per tier. FICO is a price adjustment, not a tier.
     • Financed interest reserve is in the COST BASIS only for ground-up.
       Renovation (Light/Heavy Reno) may NOT finance an interest reserve at all —
       it is always zero and never enters cost; bridge never carried one.
     • Liquidity to show = 5% of the loan amount (not N months).
     • Eligible in 27 states only; min/max loan route to manual review.
   Reuses the shared loan-sizing math from standard-program.js (YSP.sizeLoan,
   YSP.normStrategy) so both programs size identically off the same caps.
   ===================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./standard-program.js"));
  else root.GSP = factory(root.YSP);
}(typeof self !== "undefined" ? self : this, function (YSP) {
  "use strict";

  /* ---------------- constants ---------------- */
  // Gold Standard has NO rate markup — the sheet's price IS the borrower note rate.
  // (The borrower's only add-on is the 1% origination, same as the Standard Program.)
  var MARKUP = 0.005;            // base YS markup (0.5%); top-experience Tier 1 is exempt — see markupFor()
  var MARKUP_OVR = null;         // admin-set markup override (fraction); null = default
  function effMarkup() { return (MARKUP_OVR == null) ? MARKUP : MARKUP_OVR; }
  // Tier 1 = the highest experience level (Fix & Flip / Bridge 10+, Ground-up 8+): NO markup, ever.
  // All other tiers carry the base markup (or the admin override when one is set).
  function markupFor(tier) { return (tier === 1) ? 0 : effMarkup(); }
  function setMarkup(f) { MARKUP_OVR = (typeof f === "number" && isFinite(f) && f >= 0) ? f : null; }
  var ORIG_PCT = 0.0125;         // 1.25% origination on the total loan
  var MAX_LOAN = 3000000, MIN_LOAN = 100000;
  var DRAW_FEE = 250;
  var LIQUIDITY_PCT = 0.05;      // liquidity to show = 5% of loan amount
  var GU_DEFAULT_TERM = 18;      // ground-up default & base term
  var RB_DEFAULT_TERM = 12;      // renovation / bridge default & base term

  // 27 eligible states (DC included)
  var STATES = ["AL","CO","CT","DE","DC","GA","IL","IN","KS","KY","MD","MA","MI","MO","NV",
                "NJ","NC","OH","OK","PA","RI","SC","TN","TX","UT","VA","WA"];

  // Adverse-market MSAs: eligible, but require a 5% reduction in LTC / LTAIV / LTARV (and escalation).
  var ADVERSE_MSAS = [
    { city: "baltimore",    state: "MD", label: "the Baltimore MSA" },
    { city: "chicago",      state: "IL", label: "the Chicago MSA" },
    { city: "detroit",      state: "MI", label: "the Detroit MSA" },
    { city: "memphis",      state: "TN", label: "the Memphis MSA" },
    { city: "philadelphia", state: "PA", label: "the Philadelphia MSA" }
  ];
  var ADVERSE_CUT = 0.05;   // 5% leverage reduction in adverse markets
  function adverseMarket(input) {
    var st = (input && input.state ? ("" + input.state).toUpperCase() : "");
    var hay = (((input && input.city) || "") + " | " + ((input && (input.address || input.propAddr)) || "")).toLowerCase();
    for (var i = 0; i < ADVERSE_MSAS.length; i++) {
      if (hay.indexOf(ADVERSE_MSAS[i].city) > -1 && (!st || st === ADVERSE_MSAS[i].state)) return ADVERSE_MSAS[i].label;
    }
    return null;
  }

  // Pricing adjustments (added to the product buy price)
  var ADJ = { fico740: -0.0025, ficoLt700: 0.0025, term3mo: 0.0025, loanGt15M: 0.0025, units24: 0.005 };

  // FICO floor per tier (below floor ⇒ manual review)
  var FICO_FLOOR = { 1: 680, 2: 680, 3: 700 };

  // Product matrix: product → tier → { ltaiv, ltc, arv, price }.  (null cap = not applicable)
  //   ltaiv = max initial advance / as-is value   ltc = max total / cost   arv = max total / ARV
  var P = {
    "Bridge-Purchase": { 1:{ltaiv:0.80, ltc:null, arv:null, price:0.0825}, 2:{ltaiv:0.80, ltc:null, arv:null, price:0.0875}, 3:{ltaiv:0.75, ltc:null, arv:null, price:0.0950} },
    "Bridge-RateTerm": { 1:{ltaiv:0.75, ltc:null, arv:null, price:0.0850}, 2:{ltaiv:0.75, ltc:null, arv:null, price:0.0900}, 3:{ltaiv:0.70, ltc:null, arv:null, price:0.0950} },
    "Bridge-Cashout":  { 1:{ltaiv:0.70, ltc:0.70, arv:null, price:0.0850}, 2:{ltaiv:0.70, ltc:0.70, arv:null, price:0.0900}, 3:{ltaiv:0.65, ltc:0.70, arv:null, price:0.0950} },
    "LightReno":       { 1:{ltaiv:0.90, ltc:0.93, arv:0.75, price:0.0775}, 2:{ltaiv:0.875,ltc:0.90, arv:0.75, price:0.0825}, 3:{ltaiv:0.85, ltc:0.85, arv:0.70, price:0.0900} },
    "HeavyReno":       { 1:{ltaiv:0.85, ltc:0.90, arv:0.70, price:0.0850}, 2:{ltaiv:0.80, ltc:0.85, arv:0.70, price:0.0900}, 3:{ltaiv:0.75, ltc:0.80, arv:0.65, price:0.0975} },
    "GroundUp":        { 1:{ltaiv:0.75, ltc:0.85, arv:0.70, price:0.0875}, 2:{ltaiv:0.70, ltc:0.85, arv:0.675,price:0.0950}, 3:{ltaiv:0.65, ltc:0.80, arv:0.65, price:0.1000} }
  };

  var PRODUCT_LABEL = {
    "Bridge-Purchase":"Bridge — Purchase", "Bridge-RateTerm":"Bridge — Rate & Term", "Bridge-Cashout":"Bridge — Cash-Out",
    "LightReno":"Light Renovation", "HeavyReno":"Heavy Renovation", "GroundUp":"Ground-Up Construction"
  };

  /* ---------------- small helpers ---------------- */
  function up(s) { return (s || "").toString().trim().toUpperCase(); }
  function low(s) { return (s || "").toString().trim().toLowerCase(); }
  function pct(x) { return (Math.round(x * 1000) / 10) + "%"; }
  function round2g(x) { return Math.round((x || 0) * 100) / 100; }
  function num(x) { return (typeof x === "number" && isFinite(x)) ? x : 0; }

  // experience tier by track (RB = renovation/bridge, GU = ground-up)
  function tierFromExp(track, n) {
    if (track === "GU") { if (n >= 8) return 1; if (n >= 4) return 2; if (n >= 2) return 3; return 0; }
    if (n >= 10) return 1; if (n >= 5) return 2; if (n >= 2) return 3; return 0;
  }
  function tierLabel(t) { return t ? ("Tier " + t) : "Ineligible"; }

  // Gold Standard "Heavy" definition: budget > 50% of as-is value, OR adding sq ft (>250), OR structural / change of use.
  function goldHeavy(input) {
    // Objective heavy-rehab triggers — ANY one forces Heavy, and an explicit "Light"
    // selection can NEVER downgrade an objective Heavy. Budget test is 50% or greater of the
    // purchase price or as-is value; plus ADU, GLA expansion > 250 sqft, change of use, or
    // modification/removal of load-bearing structures.
    var pp = num(input.purchasePrice), aiv = num(input.asIsValue), rehab = num(input.rehabBudget);
    var basis = Math.min(pp > 0 ? pp : Infinity, aiv > 0 ? aiv : Infinity);
    if (basis < Infinity && basis > 0 && rehab >= 0.50 * basis) return true;
    if (input.sqftAddition || input.aduAddition || input.changeOfUse || input.loadBearing) return true;
    return input.heavyRehab === true;   // otherwise honor an explicit escalation to Heavy; default Light
  }

  // 2-4 unit detection
  function isMultiUnit(input) {
    if (num(input.units) >= 2) return true;
    return /(^|[^0-9])2\s*-\s*4|duplex|triplex|two-?four|2-4|multi/.test(low(input.propertyType));
  }

  // resolve product + experience track from the deal inputs
  function productOf(input) {
    var sc = YSP.normStrategy(input.strategy);   // FF / NC / BR
    if (sc === "NC") return { product: "GroundUp", track: "GU", kind: "ground" };
    if (sc === "BR") {
      var refi = up(input.loanType) === "REFINANCE";
      var prod = "Bridge-Purchase";
      if (refi && input.cashOut) prod = "Bridge-Cashout";
      else if (refi) prod = "Bridge-RateTerm";
      return { product: prod, track: "RB", kind: "bridge" };
    }
    return { product: goldHeavy(input) ? "HeavyReno" : "LightReno", track: "RB", kind: "reno" };
  }

  // buy price = product price + adjustments (NO leverage adjustment)
  function buyPrice(product, tier, input, totalLoan) {
    var price = P[product][tier].price;
    var fico = num(input.fico);
    if (fico >= 740) price += ADJ.fico740;
    else if (fico > 0 && fico < 700) price += ADJ.ficoLt700;
    var base = (product === "GroundUp") ? GU_DEFAULT_TERM : RB_DEFAULT_TERM;
    var term = num(input.term) || base;
    price += Math.floor(Math.max(0, term - base) / 3) * ADJ.term3mo;   // +0.25% per added 3 months
    if (totalLoan > 1500000) price += ADJ.loanGt15M;
    if (isMultiUnit(input)) price += ADJ.units24;
    return price;
  }

  function result(status, reasons, extra) {
    var o = { program: "gold", status: status, eligible: status === "ELIGIBLE" || status === "MANUAL", reasons: reasons };
    for (var k in extra) if (extra.hasOwnProperty(k)) o[k] = extra[k];
    return o;
  }

  /* ---------------- evaluate ---------------- */
  function evaluate(input) {
    input = input || {};
    var reasons = [];
    function add(level, msg) { reasons.push({ level: level, msg: msg }); }
    var escalations = [];                 // notes that require escalation review but DON'T change eligibility
    function addEsc(msg) { escalations.push(msg); }

    var sc = YSP.normStrategy(input.strategy);
    var loanType = up(input.loanType) === "REFINANCE" ? "Refinance" : "Purchase";
    var state = up(input.state);
    var pr = productOf(input);

    // ---- state gate: Gold Standard simply does not exist outside its footprint ----
    if (state && STATES.indexOf(state) < 0) {
      return result("UNAVAILABLE", [{ level: "UNAVAILABLE", msg: "The Gold Standard Program isn't offered in " + state + "." }],
        { available: false, product: pr.product, productLabel: PRODUCT_LABEL[pr.product] });
    }

    // ---- experience → tier ----
    var renoCount = num(input.expFlips) + num(input.expHolds);
    var groundCount = num(input.expGround);
    var expN = (pr.track === "GU") ? groundCount : renoCount;
    var tier = tierFromExp(pr.track, expN);
    if (tier === 0) {
      return result("INELIGIBLE",
        [{ level: "INELIGIBLE", msg: "Requires at least 2 " + (pr.track === "GU" ? "ground-up construction" : "comparable renovation / bridge") +
          " projects in the last 36 months (" + expN + " on file)." }],
        { available: true, product: pr.product, productLabel: PRODUCT_LABEL[pr.product] });
    }

    var row = P[pr.product][tier];
    var fico = num(input.fico);

    // ---- property type / locality ----
    if (input.ownerOccupied) add("INELIGIBLE", "Owner-occupied properties are not eligible — business-purpose only.");
    if (loanType === "Refinance" && input.midConstruction) add("INELIGIBLE", "Mid-construction projects are not eligible.");
    // Foreign nationals are ineligible on this program (U.S. citizen or permanent resident only).
    var citz = (input.citizenship || "").toString().toLowerCase();
    if (input.foreignNational === true || input.isForeign === true || citz.indexOf("foreign") > -1)
      add("INELIGIBLE", "Foreign nationals are not eligible on this program.");
    // Dutch loans are ineligible — eligible loans accrue interest on the outstanding balance only.
    if (String(input.accrual || "").toLowerCase() === "dutch")
      add("INELIGIBLE", "Dutch loans (interest accruing on undrawn holdback) are not eligible — interest must accrue on the outstanding balance only.");
    // ---- ineligible property types / conditions (back-end gates; fire only when the data is present,
    //      so there is no new UI to fill in) ----
    var ptype = String(input.propertyType || "").toLowerCase();
    var PT = [
      ["condotel","condotels or resort properties"], ["resort","condotels or resort properties"],
      ["mobile","mobile or manufactured homes"], ["manufactured","mobile or manufactured homes"],
      ["co-op","co-ops"], ["coop","co-ops"], ["cooperative","co-ops"],
      ["timeshare","timeshares"], ["agricultur","agricultural, farm, or industrial properties"],
      ["farm","agricultural, farm, or industrial properties"], ["industrial","agricultural, farm, or industrial properties"],
      ["log cabin","log cabins"], ["geodesic","geodesic domes"],
      ["ground lease","properties subject to a ground lease"], ["earthen","earthen homes"],
      ["assisted living","assisted-living or non-profit facilities"], ["non-profit","assisted-living or non-profit facilities"], ["nonprofit","assisted-living or non-profit facilities"],
      ["native american","properties on Native American land"], ["tribal","properties on Native American land"],
      ["fractional","fractional-ownership properties"], ["unique","unique properties"]
    ];
    for (var _p = 0; _p < PT.length; _p++) { if (ptype.indexOf(PT[_p][0]) > -1) { add("INELIGIBLE", "This program does not lend on " + PT[_p][1] + "."); break; } }
    if (num(input.units) >= 5) add("INELIGIBLE", "Properties with 5 or more units are not eligible — 1–4 unit residential only.");
    if (num(input.condoStories) > 6) add("INELIGIBLE", "Condos in buildings over 6 stories are not eligible.");
    if (input.shortTermRental === true || /short.?term|vacation rental|\bstr\b|airbnb/.test(ptype)) add("INELIGIBLE", "Short-term / vacation rentals are not eligible.");
    if (input.rural === true) add("INELIGIBLE", "Rural properties are not eligible on this program.");
    if ((input.vacantLand === true || /vacant|raw land/.test(ptype)) && pr.kind !== "ground") add("INELIGIBLE", "Vacant land is eligible only when used for ground-up construction during the loan term.");
    if (input.environmentalIssue === true) add("INELIGIBLE", "Properties with known adverse environmental conditions are not eligible.");
    if (input.inLitigation === true) add("INELIGIBLE", "Properties currently in litigation are not eligible.");
    if (input.zoningViolation === true) add("INELIGIBLE", "Properties with zoning violations are not eligible.");
    if (input.purchaseOption === true) add("INELIGIBLE", "Properties subject to purchase options (lease-to-own, tenancy-at-will, etc.) are not eligible.");
    var vest = String(input.vesting || input.borrowerType || input.borrowerEntity || "").toLowerCase();
    if (vest && /individual|person|natural|sole propriet/.test(vest)) add("INELIGIBLE", "Loans must be originated to a legally formed entity (LLC, S-Corp, or C-Corp), not an individual borrower.");
    // Adverse markets (Baltimore, Chicago, Detroit, Memphis, Philadelphia MSAs) are ELIGIBLE,
    // but take a 5% leverage reduction and an escalation flag — applied to caps below.
    var adverseMkt = adverseMarket(input);

    // ---- FICO floor ----
    // Absolute minimum is 660 (all guarantors); below that the loan is ineligible.
    // 660–679 meets the minimum but sits under the lowest tier pricing floor → manual review.
    if (fico > 0 && fico < 660) add("INELIGIBLE", "All guarantors must have a minimum FICO of 660 — " + fico + " is below the program minimum.");
    else if (fico > 0 && fico < FICO_FLOOR[tier]) add("MANUAL", "FICO " + fico + " is below the Tier " + tier + " minimum of " + FICO_FLOOR[tier] + " — eligible with manual review.");

    // ---- interest-reserve rules ----------------------------------------
    // Ground-up (construction): reserve is in COST BASIS and is sized at 75% of the FULL-TERM
    //   interest — i.e. the financeable reserve is capped at 0.75 × term months of payments.
    //   • Tier 2/3 (under 8 ground-up projects): full-term reserve REQUIRED → locked at 0.75 × term.
    //   • Tier 1 (8+ ground-up): optional; if taken, financed at the LESSER of the months chosen
    //     or 0.75 × term (choose less → get less; choose more → capped at 75%).
    // Renovation (Light/Heavy Reno): a financed interest reserve is NOT PERMITTED. Whatever the
    //   borrower requests is ignored — the reserve is always zero, never financed, and never enters
    //   cost. Interest is paid as billed. (Bridge is acquisition-only and never carried a reserve.)
    var isGround = pr.kind === "ground";
    var isReno = pr.kind === "reno";
    var baseTerm = isGround ? GU_DEFAULT_TERM : RB_DEFAULT_TERM;
    var termMonths = num(input.term) || baseTerm;
    // Max initial term: 24 months for construction, 18 for non-construction.
    var maxTerm = isGround ? 24 : 18;
    var minTerm = isGround ? 18 : 12;   // rate-sheet term options: 12–18 (reno/bridge), 18–24 (construction)
    if (termMonths > maxTerm) add("INELIGIBLE", (isGround ? "Construction" : "Non-construction") + " loans have a maximum initial term of " + maxTerm + " months on this program — you entered " + termMonths + ".");
    else if (termMonths > 0 && termMonths < minTerm) add("MANUAL", (isGround ? "Construction" : "Renovation / bridge") + " loans are offered from " + minTerm + " to " + maxTerm + " months — a " + termMonths + "-month term needs manual review.");
    var irMonthsReq = Math.max(0, num(input.irMonths));
    // Renovation on this program cannot finance an interest reserve — force the request to zero
    // so nothing populates, nothing is financed, and nothing enters cost regardless of the input.
    if (isReno) irMonthsReq = 0;
    // Interest reserve may be requested as an exact dollar AMOUNT instead of months
    // (owner-directed 2026-07-12). Reno finances no reserve, and a LOCKED/mandatory
    // reserve (ground-up tier-2, or tier-1 sizing >= $1.5MM below) is always the
    // months-based 75%-of-term figure — so the amount override is dropped there.
    var irAmount = isReno ? 0 : Math.max(0, num(input.irAmount));
    var irRequired = false, irLocked = false;
    var reserveCapMonths = isGround ? 0.75 * termMonths : (isReno ? 0 : termMonths);   // ground-up: 75% of term; reno: none; bridge: term
    if (isGround && tier >= 2) { irMonthsReq = reserveCapMonths; irRequired = true; irLocked = true; irAmount = 0; }   // mandatory, locked at 75% of full term
    var irMonthsEff = Math.min(irMonthsReq, reserveCapMonths);          // lesser of chosen and the cap (reno ⇒ 0)
    var reserveTermCapped = irMonthsReq > reserveCapMonths + 1e-9;      // borrower asked for more than the cap allows
    var reserveCapIsConstruction = isGround;                            // cap reason: 75%-of-term vs loan-term
    var reserveInCost = isGround;                                       // <-- the key cost-basis difference (reno: never in cost)

    // ---- caps row for the shared sizer ----
    var caps = {
      maxLoan: MAX_LOAN,
      minFico: FICO_FLOOR[tier],
      maxAcqLTV: row.ltaiv,
      maxARLTV: (row.arv == null ? 1 : row.arv),
      maxLTC: (row.ltc == null ? 1 : row.ltc)
    };
    // Adverse markets: cut LTC, LTAIV, and LTARV by 5 percentage points (floored at 0).
    if (adverseMkt) {
      caps.maxAcqLTV = Math.max(0, caps.maxAcqLTV - ADVERSE_CUT);
      if (caps.maxARLTV < 1) caps.maxARLTV = Math.max(0, caps.maxARLTV - ADVERSE_CUT);
      if (caps.maxLTC < 1) caps.maxLTC = Math.max(0, caps.maxLTC - ADVERSE_CUT);
      addEsc("the property is in an adverse market (" + adverseMkt + "), which carries a 5% leverage reduction and requires review");
    }
    // optional voluntary de-leverage (slider): tighten LTC only
    if (input.targetLTC && input.targetLTC > 0 && caps.maxLTC) caps.maxLTC = Math.min(caps.maxLTC, input.targetLTC);
    // ---- admin manual override: set the qualifying basis directly (only when > 0; default untouched) ----
    if (input.ovrAcqLTV > 0) caps.maxAcqLTV = input.ovrAcqLTV;
    if (input.ovrARLTV > 0) caps.maxARLTV = input.ovrARLTV;
    if (input.ovrLTC > 0) caps.maxLTC = input.ovrLTC;
    var rateOvrG = (input.ovrRate > 0) ? input.ovrRate : 0;   // admin-set final note rate

    // ---- assignment / wholesale cap: financeable fee = lesser of $75,000 or 15% of the ORIGINAL (seller's) contract price ----
    // (owner-corrected 2026-07-17: the 15% is on the seller's price, never the fee-inclusive total.)
    // Any excess is brought to the table (out of pocket); leverage/pricing size off the recognized price.
    var totalPP = Math.max(0, num(input.purchasePrice) || 0);
    var sellerPP = Math.max(0, num(input.sellerPrice) || 0);
    var isAssign = loanType === "Purchase" && !!input.isAssignment && sellerPP > 0;
    var assignment = null;
    var effPurchase = totalPP;
    if (isAssign) {
      var rawFee = Math.max(0, totalPP - sellerPP);
      var maxFee = Math.min(75000, 0.15 * sellerPP);    // lesser of $75,000 or 15% of the seller's contract price
      var financeableFee = Math.min(rawFee, maxFee);
      var excessFee = Math.max(0, rawFee - financeableFee);
      effPurchase = sellerPP + financeableFee;          // recognized price
      assignment = {
        sellerPrice: round2g(sellerPP), totalPrice: round2g(totalPP), fee: round2g(rawFee),
        maxFee: round2g(maxFee), financeableFee: round2g(financeableFee), excessOOP: round2g(excessFee),
        recognizedPrice: round2g(effPurchase), overLimit: excessFee > 0.5, maxPct: 0.15, dollarCap: 75000
      };
    }
    // ---- HARD GATE: if any ineligible reason fired above, no terms are offered — never price an
    //      ineligible deal. (Exit-margin is checked post-sizing and handled separately; admin manual
    //      override passes forcePrice to size on an admin-defined basis.) ----
    if (reasons.some(function (r) { return r.level === "INELIGIBLE"; }) && !input.forcePrice) {
      return result("INELIGIBLE", reasons, {
        available: true, product: pr.product, productLabel: PRODUCT_LABEL[pr.product], kind: pr.kind,
        tier: tier, tierLabel: tierLabel(tier), caps: null, noteRate: 0, sizing: null, pricingReady: fico > 0,
        assignment: assignment, multiUnit: isMultiUnit(input)
      });
    }
    var dealForSize = {
      loanType: loanType, purchasePrice: effPurchase, asIsValue: input.asIsValue, arv: input.arv,
      rehabBudget: (pr.kind === "bridge" ? 0 : num(input.rehabBudget)),
      irMonths: irMonthsEff, irAmount: irAmount, accrual: input.accrual, reserveInCost: reserveInCost,
      // An exact-dollar reserve is capped at Gold's frozen reserve ceiling — the
      // 75%-of-term construction cap on ground-up (loan term otherwise) — exactly
      // like the months path, so an amount can never exceed what months could.
      reserveCapMonths: reserveCapMonths,
      noteRateForIR: 0.10, bridge: (pr.kind === "bridge")
    };
    var sizing = YSP.sizeLoan(dealForSize, caps);
    // Program rule: ALL construction loans require a full-term interest reserve; a Tier 1 sponsor may
    // elect to omit it ONLY for loans under $1.5MM. If a Tier 1 construction loan sizes at $1.5MM or
    // more, lock in the full-term (75%) reserve and re-size so it enters the cost basis.
    if (isGround && tier === 1 && !irRequired && sizing.totalLoan >= 1500000) {
      irMonthsReq = reserveCapMonths; irRequired = true; irLocked = true; irAmount = 0;
      irMonthsEff = Math.min(irMonthsReq, reserveCapMonths);
      reserveTermCapped = irMonthsReq > reserveCapMonths + 1e-9;
      dealForSize.irMonths = irMonthsEff; dealForSize.irAmount = 0;
      sizing = YSP.sizeLoan(dealForSize, caps);
    }
    var buy0 = buyPrice(pr.product, tier, input, sizing.totalLoan);
    dealForSize.noteRateForIR = rateOvrG || (buy0 + markupFor(tier));
    sizing = YSP.sizeLoan(dealForSize, caps);
    var buy = buyPrice(pr.product, tier, input, sizing.totalLoan);
    dealForSize.noteRateForIR = rateOvrG || (buy + markupFor(tier));
    sizing = YSP.sizeLoan(dealForSize, caps);
    var note = rateOvrG || (buy + markupFor(tier));

    // ---- min / max loan → manual review ----
    var loanAmt = sizing.totalLoan || 0;
    if (loanAmt > 0 && loanAmt < MIN_LOAN) add("MANUAL", "The supported loan of " + dollars(loanAmt) + " is below the $100,000 minimum — submit for manual review.");
    if (loanAmt > MAX_LOAN) add("MANUAL", "The supported loan exceeds the $3,000,000 maximum — submit for manual review.");
    // rehab/construction budget larger than the program can finance (total capped at the max/ARV wall)
    if (sizing.rehabOverCap) add("MANUAL", "The rehab/construction budget exceeds what this program can finance — the loan is capped at " + dollars(sizing.totalLoan) + ", so the remaining budget would be funded out of pocket. Reduce the scope or use a larger facility.");

    // ---- loan profitability: for any loan with a renovation or construction component,
    //      if total project costs exceed the ARV the loan is INELIGIBLE for purchase. Bridge is exempt
    //      (acquisition-only, no rehab / ARV component).
    var exitGap = (pr.kind === "bridge") ? 0 : YSP.exitShortfall(effPurchase, num(input.rehabBudget), input.arv);
    if (exitGap > 0) add("INELIGIBLE", "Total project costs exceed the after-repair value (short by " + dollars(exitGap) + ") — the business plan isn't profitable, so this loan is ineligible for purchase.");

    // ---- escalation triggers (Gold Standard Program): deal stays ELIGIBLE, but flagged for review ----
    var rb = num(input.rehabBudget);
    var aivForBudget = (loanType === "Purchase" ? effPurchase : num(input.asIsValue));
    if (loanAmt > 1500000) addEsc("the loan exceeds $1,500,000");
    if (isGround) {
      if (rb > 1000000) addEsc("the construction budget exceeds $1,000,000");
    } else if (rb > 0) {
      if (rb > 250000) addEsc("the renovation budget exceeds $250,000");
      else if (aivForBudget > 0 && rb > aivForBudget) addEsc("the renovation budget is above the as-is value");
    }

    // assignment excess (over the financeable cap) is paid at the table — flow it to cash-to-close.
    // Any assignment requires escalation, but the deal remains eligible and fully priced.
    if (sizing) sizing.assignmentExcessOOP = assignment ? assignment.excessOOP : 0;
    if (assignment) {
      if (assignment.overLimit) addEsc("the assignment fee of " + dollars(assignment.fee) + " exceeds the financeable cap (lesser of $75,000 or 15% of the seller's contract price = " + dollars(assignment.maxFee) + "), so " + dollars(assignment.excessOOP) + " is brought to the table");
      else addEsc("the purchase includes an assignment of contract");
    }

    // ---- liquidity to show = 5% of loan ----
    var liquidity = loanAmt * LIQUIDITY_PCT;

    var pricingReady = fico > 0;
    var status = reasons.some(function (r) { return r.level === "INELIGIBLE"; }) ? "INELIGIBLE"
               : reasons.some(function (r) { return r.level === "MANUAL"; }) ? "MANUAL" : "ELIGIBLE";
    if (status === "ELIGIBLE" && !reasons.length) reasons.push({ level: "ELIGIBLE", msg: "Meets the Gold Standard Program guidelines." });

    return result(status, reasons, {
      available: true,
      product: pr.product, productLabel: PRODUCT_LABEL[pr.product], kind: pr.kind,
      tier: tier, tierLabel: tierLabel(tier),
      caps: caps, noteRate: note, sizing: sizing, pricingReady: pricingReady,
      reserveInCost: reserveInCost, irRequired: irRequired, irLocked: irLocked, reserveEligible: !isReno,
      reserveTermCapped: reserveTermCapped, reserveTermMonths: reserveCapMonths, reserveCapIsConstruction: reserveCapIsConstruction, defaultTerm: baseTerm,
      exitShortfall: exitGap,
      assignment: assignment,
      escalations: escalations,
      liquidity: liquidity, liquidityPct: LIQUIDITY_PCT,
      origination: loanAmt * ORIG_PCT, origPct: ORIG_PCT, drawFee: DRAW_FEE,
      multiUnit: isMultiUnit(input)
    });
  }

  function dollars(n) { return "$" + Math.round(n).toLocaleString("en-US"); }

  /* ---------------- public API ---------------- */
  return {
    evaluate: evaluate,
    setMarkup: setMarkup,
    productOf: productOf,
    goldHeavy: goldHeavy,
    tierFromExp: tierFromExp,
    states: STATES.slice(),
    constants: { MARKUP: MARKUP, ORIG_PCT: ORIG_PCT, MAX_LOAN: MAX_LOAN, MIN_LOAN: MIN_LOAN, DRAW_FEE: DRAW_FEE,
      LIQUIDITY_PCT: LIQUIDITY_PCT, GU_DEFAULT_TERM: GU_DEFAULT_TERM, RB_DEFAULT_TERM: RB_DEFAULT_TERM,
      ADJ: ADJ, FICO_FLOOR: FICO_FLOOR, MATRIX: P, PRODUCT_LABEL: PRODUCT_LABEL }
  };
}));
