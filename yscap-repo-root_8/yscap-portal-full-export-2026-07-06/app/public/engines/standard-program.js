/* =====================================================================
   YS CAPITAL — STANDARD PROGRAM ENGINE
   Single source of truth for eligibility, maximum leverage, pricing and
   loan sizing on the YS Standard Program (fix & flip / fix & hold,
   ground-up construction, and bridge — purchase, refinance, cash-out).

   Pricing is returned as the BORROWER NOTE RATE ONLY. The internal program
   buy rate and the YS markup are never exposed by this module.

   Exposes window.YSP (browser) and module.exports (Node, for tests).
   Pure functions, no DOM. Drop-in for term-sheet + loan-application.
   ===================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.YSP = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------------------------------------------------------------------
     1. PROGRAM CONSTANTS  (rate add-ons, floor/cap, YS markup, origination)
     --------------------------------------------------------------------- */
  var MARKUP = 0.005;          // YS markup applied to the program buy rate (borrower pays buy + 0.5%)
  var MARKUP_OVR = null;       // admin-set markup override (fraction); null = use default MARKUP
  function effMarkup() { return (MARKUP_OVR == null) ? MARKUP : MARKUP_OVR; }
  function setMarkup(f) { MARKUP_OVR = (typeof f === "number" && isFinite(f) && f >= 0) ? f : null; }
  var ORIG_PCT = 0.0125;       // origination fee — always 1.25% of the total loan
  var RA = {
    floor: 0.0925, cap: 0.105,         // buy-rate floor / cap (markup added AFTER the cap)
    base: { FF: 0.095, NC: 0.0975, BR: 0.095 },
    tier: { 1: -0.001, 2: 0.0, 3: 0.002 },
    fico740: -0.001, fico700: 0.0, ficoLt: 0.002,
    term13: 0.002, cashout: 0.005, judicial: 0.001, nonjudicial: -0.001, heavy: 0.002,
    sqftLtcCap: 0.875,
    lev: { 0.65: -0.002, 0.70: -0.001, 0.75: 0.0, 0.80: 0.001, 0.85: 0.002, 0.90: 0.003, 0.925: 0.004 }
  };

  /* ---------------------------------------------------------------------
     2. LEVERAGE & ELIGIBILITY MATRIX  — three state regimes
        row = [maxLoan, minFICO, maxAcqLTV, maxARLTV, maxLTC]; null = ineligible
        key = LoanType | Strategy(FF|NC|BR) | Tier(1|2|3)
     --------------------------------------------------------------------- */
  var NA = null;
  var MATRIX = {
    NAT: {
      "Purchase|FF|1": [2500000, 600, 0.90, 0.75, 0.925], "Purchase|FF|2": [2500000, 660, 0.90, 0.70, 0.925], "Purchase|FF|3": [950000, 680, 0.80, 0.65, 0.85],
      "Purchase|NC|1": [2500000, 680, 0.70, 0.70, 0.85], "Purchase|NC|2": [2500000, 700, 0.70, 0.65, 0.85], "Purchase|NC|3": [950000, 740, 0.60, 0.60, 0.80],
      "Purchase|BR|1": [2500000, 600, 0.75, 0.75, 0.75], "Purchase|BR|2": [2500000, 660, 0.70, 0.70, 0.70], "Purchase|BR|3": [950000, 680, 0.70, 0.70, 0.70],
      "Refinance|FF|1": [2500000, 640, 0.80, 0.70, 0.85], "Refinance|FF|2": [2500000, 660, 0.75, 0.65, 0.80], "Refinance|FF|3": NA,
      "Refinance|NC|1": [2500000, 680, 0.70, 0.70, 0.85], "Refinance|NC|2": [2500000, 700, 0.70, 0.65, 0.85], "Refinance|NC|3": [950000, 740, 0.60, 0.60, 0.80],
      "Refinance|BR|1": [1500000, 680, 0.70, 0.70, 0.70], "Refinance|BR|2": [1500000, 700, 0.70, 0.70, 0.70], "Refinance|BR|3": [950000, 740, 0.65, 0.65, 0.65]
    },
    FL: {
      "Purchase|FF|1": [1500000, 700, 0.85, 0.70, 0.875], "Purchase|FF|2": [1500000, 730, 0.85, 0.70, 0.85], "Purchase|FF|3": [950000, 740, 0.80, 0.65, 0.85],
      "Purchase|NC|1": [1500000, 700, 0.70, 0.70, 0.80], "Purchase|NC|2": [1500000, 730, 0.70, 0.65, 0.80], "Purchase|NC|3": [950000, 740, 0.60, 0.60, 0.80],
      "Purchase|BR|1": [1500000, 700, 0.75, 0.75, 0.75], "Purchase|BR|2": [1500000, 730, 0.70, 0.70, 0.70], "Purchase|BR|3": [950000, 740, 0.70, 0.70, 0.70],
      "Refinance|FF|1": NA, "Refinance|FF|2": NA, "Refinance|FF|3": NA,
      "Refinance|NC|1": [1500000, 700, 0.70, 0.70, 0.80], "Refinance|NC|2": [1500000, 730, 0.70, 0.65, 0.80], "Refinance|NC|3": [950000, 740, 0.60, 0.60, 0.80],
      "Refinance|BR|1": [1500000, 700, 0.65, 0.65, 0.65], "Refinance|BR|2": [1500000, 730, 0.65, 0.65, 0.65], "Refinance|BR|3": [950000, 740, 0.60, 0.60, 0.60]
    },
    CANY: {
      "Purchase|FF|1": [3500000, 640, 0.90, 0.75, 0.925], "Purchase|FF|2": [3500000, 660, 0.90, 0.70, 0.925], "Purchase|FF|3": [950000, 680, 0.80, 0.70, 0.85],
      "Purchase|NC|1": [3500000, 680, 0.70, 0.70, 0.85], "Purchase|NC|2": [3500000, 700, 0.70, 0.65, 0.85], "Purchase|NC|3": [950000, 740, 0.60, 0.60, 0.80],
      "Purchase|BR|1": [3500000, 600, 0.75, 0.75, 0.75], "Purchase|BR|2": [3500000, 660, 0.70, 0.70, 0.70], "Purchase|BR|3": [950000, 680, 0.70, 0.70, 0.70],
      "Refinance|FF|1": NA, "Refinance|FF|2": NA, "Refinance|FF|3": NA,
      "Refinance|NC|1": [3500000, 680, 0.70, 0.70, 0.85], "Refinance|NC|2": [3500000, 700, 0.70, 0.65, 0.85], "Refinance|NC|3": [950000, 740, 0.60, 0.60, 0.80],
      "Refinance|BR|1": [2500000, 680, 0.70, 0.70, 0.70], "Refinance|BR|2": [2500000, 700, 0.70, 0.70, 0.70], "Refinance|BR|3": [950000, 740, 0.65, 0.65, 0.65]
    }
  };

  var JUDICIAL = ["CT","DE","FL","IL","IN","IA","KS","KY","LA","ME","MD","MA","NE","NJ","NM","NY","ND","OH","PA","SC","VT","WI"];
  var INELIGIBLE_STATES = ["IN","LA"];
  var INELIGIBLE_PROPERTY = ["co-op","cooperative","mobile home","manufactured","mixed-use","mixed use","commercial",
    "rural","agricultural","bed and breakfast","boarding house","half-way house","care facility","condemned","multifamily 5+","5+ units"];

  /* ---------------------------------------------------------------------
     3. SMALL HELPERS
     --------------------------------------------------------------------- */
  function clean(s) { return String(s == null ? "" : s).trim(); }
  function up(s) { return clean(s).toUpperCase(); }
  function low(s) { return clean(s).toLowerCase(); }

  function regimeOf(state) {
    var s = up(state);
    if (s === "FL") return "FL";
    if (s === "CA" || s === "NY") return "CANY";
    return "NAT";
  }

  /* ---- locality eligibility (shared across programs) ----
     Cities excluded for EVERY YS program. Each is scoped to its state so a street
     named after a city in another state can't false-trigger. */
  var GENERAL_INELIGIBLE_CITIES = [
    { city: "philadelphia", state: "PA", label: "Philadelphia" },
    { city: "baltimore",    state: "MD", label: "Baltimore" }
  ];
  // Standard Program adds two more cities on top of the general list.
  var STANDARD_INELIGIBLE_CITIES = GENERAL_INELIGIBLE_CITIES.concat([
    { city: "detroit", state: "MI", label: "Detroit" },
    { city: "chicago", state: "IL", label: "Chicago" }
  ]);

  // Detect an ineligible city from a structured city field and/or a free-text address.
  // Returns { label, source } where source is "city" (matched a dedicated city field —
  // high confidence) or "address" (matched only inside free-text address — lower
  // confidence, because a street can share a city's name, so the caller routes it to
  // manual review to confirm location rather than a hard decline). State-scoped: an
  // explicit non-matching state means it's almost certainly a same-named street elsewhere.
  function cityMatch(input, list) {
    var state = up(input && input.state);
    var cityStr = low((input && input.city) || "");
    var addrStr = low((input && (input.address || input.propAddr)) || "");
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (state && state !== c.state) continue;             // explicit different state -> skip
      if (cityStr.indexOf(c.city) > -1) return { label: c.label, source: "city" };
      if (addrStr.indexOf(c.city) > -1) return { label: c.label, source: "address" };
    }
    return null;
  }
  // Public: full match object { label, source } or null. program = "standard" | "general".
  function cityCheck(input, program) {
    return cityMatch(input, program === "standard" ? STANDARD_INELIGIBLE_CITIES : GENERAL_INELIGIBLE_CITIES);
  }
  // Public (back-compat): just the ineligible-city label (or null).
  function cityIneligible(input, program) {
    var m = cityCheck(input, program);
    return m ? m.label : null;
  }

  /* ---- exit / profitability gate (shared across programs) ----
     The after-repair value must at least cover the all-in basis (acquisition + rehab).
     If ARV < acquisition + rehab the exit doesn't support the loan on ANY program, so the
     deal is routed to manual pricing. Break-even (ARV == basis) is the lowest acceptable point.
     Returns the shortfall amount (basis - ARV) when negative, else 0. Skipped when ARV is blank. */
  function exitShortfall(acquisition, rehab, arv) {
    var basis = Math.max(0, acquisition || 0) + Math.max(0, rehab || 0);
    var a = Math.max(0, arv || 0);
    if (a <= 0 || basis <= 0) return 0;        // no ARV entered (e.g. some bridge deals) -> no exit test
    return (a < basis - 0.5) ? round2(basis - a) : 0;
  }
  // Normalize any program label to FF (fix&flip/fix&hold), NC (ground-up), BR (bridge)
  function normStrategy(x) {
    var s = low(x);
    if (s.indexOf("ground") > -1 || s.indexOf("construction") > -1 || s === "nc") return "NC";
    if (s.indexOf("bridge") > -1 || s === "br") return "BR";
    if (s.indexOf("flip") > -1 || s.indexOf("hold") > -1 || s.indexOf("brrrr") > -1 ||
        s.indexOf("rental") > -1 || s === "ff" || s === "f&f" || s === "f&h") return "FF";
    return "FF";
  }
  function foreclosureType(state) { return JUDICIAL.indexOf(up(state)) > -1 ? "Judicial" : "Non-Judicial"; }

  /* Experience → tier with the YS split:
     - Ground-up deals count GROUND-UP projects only (flip/hold experience ⇒ first-timer for ground-up).
     - Fix&flip / fix&hold / bridge deals count ALL renovate-and-exit projects (flips + holds + ground-ups).  */
  function projectCount(strategyCode, exp) {
    exp = exp || {};
    var flips = Math.max(0, exp.flips || 0), holds = Math.max(0, exp.holds || 0), ground = Math.max(0, exp.ground || 0);
    if (strategyCode === "NC") return ground;
    return flips + holds + ground;
  }
  function tierFromCount(n) { return n >= 3 ? 1 : (n >= 1 ? 2 : 3); }
  function tierLabel(t) { return t === 1 ? "Tier 1 — experienced (3+ projects)" : t === 2 ? "Tier 2 — established (1–2 projects)" : "Tier 3 — first-time investor"; }

  function caps(regime, loanType, strategyCode, tier) {
    var row = MATRIX[regime] && MATRIX[regime][loanType + "|" + strategyCode + "|" + tier];
    if (!row) return null;
    return { maxLoan: row[0], minFico: row[1], maxAcqLTV: row[2], maxARLTV: row[3], maxLTC: row[4] };
  }

  function ltcBucket(ltc) {
    var b = [0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.925];
    for (var i = 0; i < b.length; i++) if (ltc <= b[i] + 1e-9) return b[i];
    return null; // above 92.5% — never eligible
  }

  /* ---------------------------------------------------------------------
     4. PRICING  — returns BORROWER NOTE RATE ONLY (buy rate + markup)
        The buy rate is computed internally and never returned/exposed.
        ltcForPricing = the deal's LTC (sized loan), bucketed up.
     --------------------------------------------------------------------- */
  function noteRate(o) {
    var sc = o.strategyCode, base = RA.base[sc];
    var bucket = ltcBucket(o.ltc);
    if (bucket === null) return null;
    var buy = base
      + (RA.tier[o.tier] || 0)
      + (o.fico >= 740 ? RA.fico740 : (o.fico >= 700 ? RA.fico700 : RA.ficoLt))
      + (RA.lev[bucket] || 0)
      + (o.term >= 13 ? RA.term13 : 0)
      + (o.loanType === "Refinance" && o.cashOut ? RA.cashout : 0)
      + (o.foreclosure === "Judicial" ? RA.judicial : RA.nonjudicial)
      + (o.heavy ? RA.heavy : 0);
    buy = Math.max(RA.floor, Math.min(RA.cap, buy));   // floor/cap applies to the buy rate
    return buy + effMarkup();                          // borrower note rate (only this leaves the module)
  }

  /* ---------------------------------------------------------------------
     5. LOAN SIZING WATERFALL
        Rules: rehab is 100% financed (no OOP) and never shaved; the INITIAL
        (acquisition) advance is the plug that absorbs every reduction; the
        interest reserve is financed into the loan.
     --------------------------------------------------------------------- */
  function round2(n) { return Math.round(n * 100) / 100; }

  function sizeLoan(d, c) {
    // d: deal inputs; c: caps row. Returns full structure + binding constraint.
    var purchase = d.loanType === "Purchase";
    var pp = Math.max(0, d.purchasePrice || 0);
    var aiv = Math.max(0, d.asIsValue || 0);
    var isBridge = !!d.bridge;                   // bridge / stabilized: sized on the as-is value ONLY
    var arv = Math.max(0, d.arv || 0);
    var rehab = isBridge ? 0 : Math.max(0, d.rehabBudget || 0);
    var irMonths = isBridge ? 0 : Math.max(0, d.irMonths || 0);
    var reserveInCost = (d.reserveInCost !== false);   // Standard Program: reserve is part of cost

    // value bases
    var acqDenom = purchase ? Math.min(pp || aiv, aiv || pp) : aiv;     // lower of [PP, AIV] for purchase; AIV for refi
    if (!(acqDenom > 0)) acqDenom = purchase ? pp : aiv;
    var costBasis0 = (purchase ? pp : aiv) + rehab;                    // [PP or AIV] + rehab, WITHOUT reserve

    var rehabLoan = rehab;                       // 100% financed, no OOP
    var A = c.maxAcqLTV * acqDenom;              // cap on the acquisition (initial) advance
    var capARV = isBridge ? Infinity : c.maxARLTV * arv;   // no after-repair-value limit on a bridge
    var stdMax = c.maxLoan;                       // tier dollar cap on total (hard wall)
    var m = c.maxLTC;                             // LTC factor
    var capHard = Math.min(capARV, stdMax);      // the hard walls
    var rate = (d.noteRateForIR || 0.105);

    // With reserve R financed and reserve in the LTC cost basis:
    //   initial(R) = min( A,  capHard - rehab - R,  m*(costBasis0 + R) - rehab - R )
    //   total(R)   = initial(R) + rehab + R   — monotone, plateaus at capHard.
    // When LTC is the active term, initial drops 0.075 per $1 of R (borrower brings the 7.5%);
    // the reserve keeps growing the loan only until total hits the ARV / max-loan wall.
    function initialAt(R) {
      // reserve-in-cost (Standard, GS ground-up): reserve sits in BOTH numerator and cost basis.
      // reserve-not-in-cost (GS renovation/bridge): reserve is financed (numerator) but NOT in cost
      //   basis — so it eats LTC headroom (total incl. reserve capped at m*costBasis0), "capped by the LTC".
      var byLtc = reserveInCost ? (m * (costBasis0 + R) - rehab - R) : (m * costBasis0 - rehab - R);
      return Math.min(A, capHard - rehab - R, byLtc);
    }
    function totalAt(R) { return Math.max(0, initialAt(R)) + rehab + R; }
    function maxReserveFit(cap) {                // largest R with total(R) still under the hard wall
      if (totalAt(cap) < capHard - 1e-6) return cap;
      var lo = 0, hi = Math.max(cap, capHard);
      for (var b = 0; b < 64; b++) { var mid = (lo + hi) / 2; if (totalAt(mid) < capHard - 1e-6) lo = mid; else hi = mid; }
      return lo;
    }

    // ---- reserve sizing -------------------------------------------------------------
    // The initial advance is ALWAYS maxed first. For an OPTIONAL reserve that is not part of the
    // cost basis (renovation / bridge), the reserve then takes ONLY the room left under the caps —
    // it never erodes the initial advance. Whatever is requested beyond that room is simply not
    // eligible (not financed, not counted). For an in-cost reserve (construction; Standard Program)
    // the reserve grows the basis and is sized together with the initial, as before.
    var initialMax = Math.max(0, initialAt(0));
    var rehabOverCap = false;
    // Hard-cap guard: rehab is 100% financed, but rehab alone can't exceed the max-loan / ARV wall.
    if (initialMax + rehabLoan > capHard + 0.5) { rehabLoan = Math.max(0, capHard - initialMax); rehabOverCap = true; }

    var financedIR = 0, totalLoan = 0, fullPmt = 0, desired = 0, acquisition = initialMax, maxReserve = 0;
    if (reserveInCost === false) {
      // room for the reserve ON TOP of the maxed initial (does not move the initial):
      //   total = initialMax + rehab + R  must stay under both capHard and the fixed LTC ceiling.
      maxReserve = Math.max(0, Math.min(capHard - rehabLoan - initialMax, (m < 1 ? (m * costBasis0 - rehabLoan - initialMax) : Infinity)));
      acquisition = initialMax;
      totalLoan = acquisition + rehabLoan;
      if (irMonths > 0) {
        for (var it = 0; it < 40; it++) {
          fullPmt = totalLoan * (rate / 12);
          desired = irMonths * fullPmt;
          var Rfit = Math.max(0, Math.min(desired, maxReserve));
          var newTotal = acquisition + rehabLoan + Rfit;
          if (Math.abs(Rfit - financedIR) < 0.5 && Math.abs(newTotal - totalLoan) < 0.5) { financedIR = Rfit; totalLoan = newTotal; break; }
          financedIR = Rfit; totalLoan = newTotal;
        }
        fullPmt = totalLoan * (rate / 12); desired = irMonths * fullPmt;
      }
      totalLoan = acquisition + rehabLoan + financedIR;
    } else {
      // in-cost reserve: grows the basis, sized together with the initial
      totalLoan = totalAt(0);
      if (irMonths > 0) {
        for (var it2 = 0; it2 < 40; it2++) {
          fullPmt = totalLoan * (rate / 12);
          desired = irMonths * fullPmt;
          var Rfit2 = Math.max(0, Math.min(desired, maxReserveFit(desired)));
          var newTotal2 = totalAt(Rfit2);
          if (Math.abs(Rfit2 - financedIR) < 0.5 && Math.abs(newTotal2 - totalLoan) < 0.5) { financedIR = Rfit2; totalLoan = newTotal2; break; }
          financedIR = Rfit2; totalLoan = newTotal2;
        }
        fullPmt = totalLoan * (rate / 12); desired = irMonths * fullPmt;
      }
      acquisition = Math.max(0, initialAt(financedIR));
      totalLoan = acquisition + rehabLoan + financedIR;
      if (totalLoan > capHard + 0.5) { rehabLoan = Math.max(0, capHard - acquisition - financedIR); rehabOverCap = true; totalLoan = acquisition + rehabLoan + financedIR; }
      maxReserve = irMonths > 0 ? maxReserveFit(Math.max(desired, capHard)) : 0;
    }

    // Final loan-to-cost guard: on rehab-dominant deals the 100%-financed rehab can push the total
    // past the LTC ceiling even with a zero initial advance (the per-advance LTC term only bounds the
    // initial). Cap the total at the LTC wall, bring the excess rehab out of pocket, and flag for review.
    if (m < 1) {
      var ltcBasisG = costBasis0 + (reserveInCost ? financedIR : 0);
      if (ltcBasisG > 0 && totalLoan > m * ltcBasisG + 0.5) {
        rehabLoan = Math.max(0, m * ltcBasisG - acquisition - financedIR);
        totalLoan = acquisition + rehabLoan + financedIR;
        fullPmt = totalLoan * (rate / 12);
        rehabOverCap = true;
      }
    }

    // reserve metrics: financedIR is what actually fits; the request beyond it is not eligible
    var reserveCapped = irMonths > 0 && desired > financedIR + 1;
    var maxReserveMonths = fullPmt > 0 ? financedIR / fullPmt : 0;
    var reserveCapBy = "";
    if (reserveCapped) {
      if (reserveInCost === false && (m < 1) && (m * costBasis0 - rehabLoan - initialMax) <= (capHard - rehabLoan - initialMax) + 1e-6)
        reserveCapBy = "the " + pct(c.maxLTC) + " loan-to-cost ceiling";
      else
        reserveCapBy = (capARV <= stdMax) ? "the " + pct(c.maxARLTV) + " after-repair-value ceiling" : "the program maximum loan amount";
    }
    var unfinancedIR = 0;                         // reserve is NEVER charged to the borrower at close

    // monthly interest-only payments
    var initialPayment = acquisition * (rate / 12);
    var fullPayment = totalLoan * (rate / 12);
    var monthlyInterest = fullPayment;

    // which constraint bound the total?
    var binding = "program leverage", bindKey = "none";
    var EPS = 2;
    var ltcBasis = costBasis0 + (reserveInCost ? financedIR : 0);
    if (acquisition <= 0) {
      // The initial advance is fully absorbed by the leverage caps — the loan finances the
      // rehab in full (released in draws). This is NOT a manual trigger; only a failed profit
      // margin (handled by the exit gate) sends a deal to manual review.
      bindKey = "rehabonly";
      if (Math.abs(totalLoan - capARV) < EPS && capARV <= stdMax + EPS) binding = "the " + pct(c.maxARLTV) + " ARV cap (no initial advance needed)";
      else if (Math.abs(totalLoan - m * ltcBasis) < EPS) binding = "the " + pct(c.maxLTC) + " loan-to-cost cap (no initial advance needed)";
      else binding = "the financed rehab budget (no initial advance needed)";
    }
    else {
      var atAcq = Math.abs(acquisition - A) < EPS;
      var atARV = Math.abs(totalLoan - capARV) < EPS && capARV <= stdMax + EPS;
      var atMax = Math.abs(totalLoan - stdMax) < EPS && stdMax <= capARV + EPS;
      var atLTC = Math.abs(totalLoan - m * ltcBasis) < EPS;
      if (atARV && capARV < stdMax - EPS) { binding = "the " + pct(c.maxARLTV) + " ARV cap"; bindKey = "arv"; }
      else if (atMax) { binding = "the program maximum loan amount"; bindKey = "maxloan"; }
      else if (atLTC && !atAcq) { binding = "the " + pct(c.maxLTC) + " loan-to-cost cap"; bindKey = "ltc"; }
      else if (atAcq) { binding = "the " + pct(c.maxAcqLTV) + " as-is (initial advance) cap"; bindKey = "acq"; }
    }

    var ltcPct = ltcBasis > 0 ? totalLoan / ltcBasis : 0;
    var acqLtvPct = acqDenom > 0 ? acquisition / acqDenom : 0;
    var arvPct = arv > 0 ? totalLoan / arv : 0;
    var downPayment = purchase ? Math.max(0, pp - acquisition) : 0;

    return {
      purchase: purchase, pp: pp, aiv: aiv, arv: arv, rehab: rehab,
      acqDenom: acqDenom, costBasis: ltcBasis,
      totalLoan: round2(totalLoan), acquisition: round2(acquisition), rehabLoan: round2(rehabLoan),
      financedIR: round2(financedIR), unfinancedIR: 0, monthlyInterest: monthlyInterest,
      initialPayment: round2(initialPayment), fullPayment: round2(fullPayment),
      maxReserve: round2(Math.max(0, maxReserve)), reserveCapped: reserveCapped, rehabOverCap: rehabOverCap,
      reserveCapBy: reserveCapBy, maxReserveMonths: maxReserveMonths, desiredReserve: round2(desired),
      downPayment: round2(downPayment),
      ltcPct: ltcPct, acqLtvPct: acqLtvPct, arvPct: arvPct,
      binding: binding, bindKey: bindKey,
      preMaxTotal: Math.min(capARV, m * costBasis0, A + rehabLoan)   // base total before $ max cap
    };
  }
  function pct(x) { return (Math.round(x * 1000) / 10) + "%"; }

  /* ---------------------------------------------------------------------
     6. ELIGIBILITY  — geography, property, FICO, min loan, refi bans, caps.
        Returns status ELIGIBLE | MANUAL | INELIGIBLE + reason list.
        `loanAmount` optional: when provided (application), checks it against
        the max-loan band; when omitted (term sheet sizes its own max), the
        sizer's preMaxTotal drives the national F&F T1 manual-underwrite note.
     --------------------------------------------------------------------- */
  var RANK = { ELIGIBLE: 0, MANUAL: 1, INELIGIBLE: 2 };
  function evaluate(input) {
    var reasons = [], status = "ELIGIBLE";
    function add(level, msg) { reasons.push({ level: level, msg: msg }); if (RANK[level] > RANK[status]) status = level; }

    var loanType = clean(input.loanType) === "Refinance" ? "Refinance" : "Purchase";
    var sc = normStrategy(input.strategy);
    var state = up(input.state);
    var city = low(input.city);
    var regime = regimeOf(state);
    var cashOut = loanType === "Refinance" && !!input.cashOut;
    var fico = Math.max(0, Math.round(input.fico || 0));
    var exp = { flips: input.expFlips || 0, holds: input.expHolds || 0, ground: input.expGround || 0 };
    var pcount = projectCount(sc, exp);
    var tier = tierFromCount(pcount);

    // ---- assignment / wholesale 15% financeable cap ----------------------
    // The program finances an assignment fee up to 15% of the TOTAL purchase price.
    // Any excess is paid out of pocket; leverage and pricing size off the
    // "recognized" price = seller price + financeable assignment.
    var totalPP = Math.max(0, input.purchasePrice || 0);
    var sellerPP = Math.max(0, input.sellerPrice || 0);
    var isAssignment = loanType === "Purchase" && !!input.isAssignment && sellerPP > 0;
    var assignment = null;
    var effPurchase = totalPP;                        // price used for all leverage/pricing math
    if (isAssignment) {
      var rawFee = Math.max(0, totalPP - sellerPP);   // seller + fee always reconcile to the total
      var maxFee = 0.15 * totalPP;                    // 15% of the TOTAL purchase price
      var financeableFee = Math.min(rawFee, maxFee);
      var excessFee = Math.max(0, rawFee - financeableFee);
      effPurchase = sellerPP + financeableFee;        // recognized price
      assignment = {
        sellerPrice: round2(sellerPP), totalPrice: round2(totalPP), fee: round2(rawFee),
        maxFee: round2(maxFee), financeableFee: round2(financeableFee), excessOOP: round2(excessFee),
        recognizedPrice: round2(effPurchase), overLimit: excessFee > 0.5, maxPct: 0.15
      };
    }

    // derived flags — Bridge is acquisition-only, so any rehab budget is ignored (not allowed)
    var rehab = (sc === "BR") ? 0 : Math.max(0, input.rehabBudget || 0);
    // Heavy-rehab base is the PROPERTY VALUE (lower of purchase price and as-is value) — the same
    // basis the program uses for Acq LTV and Cost Basis. Standard flags Heavy when the rehab budget
    // exceeds 25% of that value (the Gold program's parallel test is 50% of value). Measuring against
    // value (not purchase + rehab) is what makes the literal ">25%" threshold correct.
    var ppH = effPurchase, aivH = (input.asIsValue || 0);
    var heavyBasis = (loanType === "Purchase")
      ? Math.min(ppH > 0 ? ppH : Infinity, aivH > 0 ? aivH : Infinity)
      : (aivH > 0 ? aivH : ppH);
    if (!isFinite(heavyBasis) || heavyBasis <= 0) heavyBasis = ppH || aivH || 0;
    var autoHeavy = sc !== "NC" && heavyBasis > 0 && (rehab / heavyBasis) > 0.25;
    // Heavy rehab (>25% of value) adds +0.20% per the matrix. The objective test always applies;
    // an explicit "Light" selection can only ESCALATE to Heavy, never suppress the objective trigger.
    // (Sq-ft additions are handled separately as an 87.5% LTC cap, not this rate add-on.)
    var heavy = sc !== "NC" && (autoHeavy || input.heavyRehab === true);
    var heavyAuto = autoHeavy;                    // surfaced so the UI can suggest the Heavy option
    var sqft = !!input.sqftAddition;
    var foreclosure = foreclosureType(state);

    // ---- hard gates (independent of the matrix) ----
    if (state && INELIGIBLE_STATES.indexOf(state) > -1) add("INELIGIBLE", "Properties in " + stateName(state) + " are not eligible.");
    var cityHit = cityCheck(input, "standard");
    var cityReview = null;
    if (cityHit) {
      cityReview = cityHit.label;                              // both sources -> manual review, no pricing (see CITY-REVIEW GATE)
      if (cityHit.source === "city")
        add("MANUAL", "Properties in " + cityHit.label + " aren't eligible for the Standard Program \u2014 this scenario needs manual review.");
      else
        add("MANUAL", "This address looks like it's in " + cityHit.label + ", which isn't eligible for the Standard Program \u2014 it needs manual review to confirm the exact location. If the property isn't in " + cityHit.label + ", we can price it.");
    }
    var propLc = low(input.propertyType);
    if (propLc && INELIGIBLE_PROPERTY.indexOf(propLc) > -1) add("INELIGIBLE", title(propLc) + " properties are not eligible.");
    if (input.ownerOccupied) add("INELIGIBLE", "Owner-occupied properties are not eligible — business-purpose only.");
    if (fico > 0 && fico < 600) add("INELIGIBLE", "A representative FICO of at least 600 is required.");
    if (loanType === "Refinance" && input.midConstruction) add("INELIGIBLE", "Mid-construction refinances are not eligible.");
    if (String(input.accrual || "").toLowerCase() === "dutch") add("INELIGIBLE", "Dutch loans (interest accruing on undrawn holdback) are not eligible — interest must accrue on the outstanding balance only.");

    var c = caps(regime, loanType, sc, tier);
    if (!c) {
      if (sc === "FF" && loanType === "Refinance" && (regime === "FL" || regime === "CANY"))
        add("INELIGIBLE", "Fix & flip / fix & hold refinances are not available in " + (regime === "FL" ? "Florida" : "California or New York") + ".");
      else if (sc === "FF" && loanType === "Refinance" && tier === 3)
        add("INELIGIBLE", "Fix & flip / fix & hold refinances require prior experience (first-time investors are not eligible).");
      else
        add("INELIGIBLE", "This strategy isn't available for the selected loan type and experience.");
      return result(status, reasons, { regime: regime, tier: tier, tierLabel: tierLabel(tier), strategyCode: sc, loanType: loanType, projectCount: pcount, pricingReady: fico > 0, assignment: assignment, caps: null });
    }

    // ---- HARD GATE: if ANY ineligible reason fired above, no terms are offered — never price an
    //      ineligible deal. (Admin manual override passes forcePrice to size on an admin-defined basis.) ----
    if (status === "INELIGIBLE" && !input.forcePrice) {
      return result(status, reasons, { regime: regime, tier: tier, tierLabel: tierLabel(tier), strategyCode: sc, loanType: loanType, projectCount: pcount, pricingReady: fico > 0, assignment: assignment, caps: null });
    }
    // ---- CITY-REVIEW GATE: an ineligible-city name detected inside a free-text address routes to
    //      manual review with NO pricing until the exact location is confirmed. (An admin manual
    //      override / forcePrice bypasses this to price on a confirmed basis.) ----
    if (cityReview && !input.forcePrice) {
      return result(status, reasons, { regime: regime, tier: tier, tierLabel: tierLabel(tier), strategyCode: sc, loanType: loanType, projectCount: pcount, pricingReady: fico > 0, assignment: assignment, caps: null, cityReview: cityReview });
    }

    // effective LTC cap with sq-ft override
    var maxLTC = (loanType === "Purchase" && sc === "FF" && sqft) ? Math.min(c.maxLTC, RA.sqftLtcCap) : c.maxLTC;
    // optional leverage choice: borrower may take LESS than the program max LTC for better pricing
    if (input.targetLTC && input.targetLTC > 0) maxLTC = Math.min(maxLTC, input.targetLTC);
    var capsEff = { maxLoan: c.maxLoan, minFico: c.minFico, maxAcqLTV: c.maxAcqLTV, maxARLTV: c.maxARLTV, maxLTC: maxLTC };
    // ---- admin manual override: set the qualifying basis directly (only when > 0; default untouched) ----
    if (input.ovrAcqLTV > 0) capsEff.maxAcqLTV = input.ovrAcqLTV;
    if (input.ovrARLTV > 0) capsEff.maxARLTV = input.ovrARLTV;
    if (input.ovrLTC > 0) { maxLTC = input.ovrLTC; capsEff.maxLTC = input.ovrLTC; }
    var rateOvr = (input.ovrRate > 0) ? input.ovrRate : 0;   // admin-set final note rate

    // ---- FICO vs tier minimum (>=600 but below min ⇒ waiver / manual) ----
    if (fico > 0 && fico < c.minFico) add("MANUAL", "FICO " + fico + " is below the " + c.minFico + " minimum for this tier — eligible with a credit-committee waiver review.");

    // ---- size the loan to the program max for this profile ----
    // Never finance more interest than the loan term: cap reserve months at the term.
    var termMonths = input.term || 12;
    var irMonthsReq = Math.max(0, input.irMonths || 0);
    var irMonthsEff = Math.min(irMonthsReq, termMonths);
    var reserveTermCapped = irMonthsReq > termMonths;
    var rate0 = rateOvr || noteRate({ strategyCode: sc, tier: tier, fico: fico || 700, ltc: maxLTC, term: termMonths,
      loanType: loanType, cashOut: cashOut, foreclosure: foreclosure, heavy: heavy });
    var dealForSize = {
      loanType: loanType, purchasePrice: effPurchase, asIsValue: input.asIsValue, arv: input.arv,
      rehabBudget: rehab, irMonths: irMonthsEff, accrual: input.accrual, noteRateForIR: rate0 || 0.105,
      reserveInCost: true, bridge: (sc === "BR")
    };
    var sizing = sizeLoan(dealForSize, capsEff);

    // settle the rate on the achieved LTC bucket (one refinement for the IR/rate loop)
    var rate = rateOvr || noteRate({ strategyCode: sc, tier: tier, fico: fico || 700, ltc: sizing.ltcPct > 0 ? sizing.ltcPct : maxLTC,
      term: input.term || 12, loanType: loanType, cashOut: cashOut, foreclosure: foreclosure, heavy: heavy });
    if (rate) {
      dealForSize.noteRateForIR = rate; sizing = sizeLoan(dealForSize, capsEff);
      rate = rateOvr || (noteRate({ strategyCode: sc, tier: tier, fico: fico || 700, ltc: sizing.ltcPct > 0 ? sizing.ltcPct : maxLTC,
        term: input.term || 12, loanType: loanType, cashOut: cashOut, foreclosure: foreclosure, heavy: heavy }) || rate);
    }

    // ---- max-loan / minimum-loan ----
    var hasLoan = (input.loanAmount || 0) > 0;
    var checkAmt = hasLoan ? input.loanAmount : null;
    if (hasLoan) {
      if (checkAmt < 100000) add("INELIGIBLE", "The minimum loan amount is $100,000.");
      else if (checkAmt > c.maxLoan) add("INELIGIBLE", "Loan amount exceeds the " + usd(c.maxLoan) + " program maximum for this profile.");
    } else {
      // term-sheet path: the loan is sized down to the program max; only flag the floor
      if (sizing.totalLoan < 100000 && sizing.totalLoan > 0) add("MANUAL", "Sized below the $100,000 minimum — increase the deal size or leverage.");
    }
    // ---- initial term: the Standard Program's max allowable term is 24 months ----
    if ((input.term || 0) > 24) add("MANUAL", "The maximum initial term is 24 months — a " + (input.term || 0) + "-month term needs manual review.");
    // rehab/construction budget larger than the program can finance (total is capped at the max/ARV wall)
    if (sizing.rehabOverCap) add("MANUAL", "The rehab budget exceeds what this program can finance — the loan is capped at " + usd(sizing.totalLoan) + ", so the remaining budget would be funded out of pocket. Reduce the scope or use a larger facility.");
    // ---- exit / profitability gate: ARV must cover acquisition + rehab, else manual pricing ----
    var exitGap = exitShortfall((loanType === "Purchase" ? effPurchase : (input.asIsValue || 0)), rehab, input.arv);
    if (exitGap > 0) add("MANUAL", "The after-repair value doesn't cover the purchase plus rehab (short by " + usd(exitGap) + ") — the exit doesn't support the loan, so it's sent for manual pricing.");

    // ---- assignment over-limit messaging + cash-to-close adjustment ----
    if (assignment && assignment.overLimit) {
      add("MANUAL", "Assignment fee of " + usd(assignment.fee) + " exceeds the 15% program limit (" + usd(assignment.maxFee) +
        ", 15% of the " + usd(assignment.totalPrice) + " purchase price). " + usd(assignment.financeableFee) + " is financeable; " +
        usd(assignment.excessOOP) + " must be brought out of pocket at closing. A higher limit may be requested as an exception.");
      if (sizing) sizing.assignmentExcessOOP = assignment.excessOOP;
    }

    if (!reasons.length) reasons.push({ level: "ELIGIBLE", msg: "Meets the Standard Program guidelines." });

    return result(status, reasons, {
      regime: regime, tier: tier, tierLabel: tierLabel(tier), strategyCode: sc, loanType: loanType,
      cashOut: cashOut, projectCount: pcount, foreclosure: foreclosure, heavy: heavy, heavyAuto: heavyAuto, sqft: sqft,
      reserveTermCapped: reserveTermCapped, reserveTermMonths: termMonths,
      exitShortfall: exitGap, cityReview: cityReview,
      assignment: assignment, pricingReady: fico > 0,
      caps: capsEff, noteRate: rate, sizing: sizing
    });
  }

  function result(status, reasons, extra) {
    var o = { status: status, eligible: status !== "INELIGIBLE", reasons: reasons };
    for (var k in extra) o[k] = extra[k];
    return o;
  }

  /* ---------------------------------------------------------------------
     6b. PRICING LADDER — the loan amount, payment and NOTE RATE at every
         leverage (LTC) step from the deal's achievable maximum down to 65%.
         Lets a borrower trade leverage for a better rate. Each rate is the
         exact program rate for that LTC bucket (buy-rate build-up + markup).
     --------------------------------------------------------------------- */
  var LADDER_BUCKETS = [0.925, 0.90, 0.85, 0.80, 0.75, 0.70, 0.65];
  function priceLadder(input) {
    var full = evaluate(input);
    if (full.status === "INELIGIBLE" || !full.sizing || !(full.sizing.totalLoan > 0)) {
      return { eligible: false, status: full.status, reasons: full.reasons, rows: [] };
    }
    var maxLtc = full.sizing.ltcPct;                 // the most leverage this deal can take
    var maxBucket = ltcBucket(maxLtc) || maxLtc;     // its pricing bucket (the deal's actual top tier)
    var rows = [];
    for (var i = 0; i < LADDER_BUCKETS.length; i++) {
      var b = LADDER_BUCKETS[i];
      if (b > maxBucket + 1e-9) continue;            // can't price above the deal's own bucket
      var ev = evaluate(Object.assign({}, input, { targetLTC: b }));
      var s = ev.sizing || {};
      if (!(s.totalLoan > 0)) continue;
      var rate = ev.noteRate || 0;
      rows.push({
        ltc: b,
        targetLtcPct: s.ltcPct,
        totalLoan: s.totalLoan,
        initialAdvance: s.acquisition,
        downPayment: s.downPayment,
        rehabHoldback: s.rehabLoan,
        noteRate: rate,
        monthlyPayment: round2(s.totalLoan * (rate / 12)),
        isMax: Math.abs(b - maxBucket) < 1e-9
      });
    }
    return { eligible: true, status: full.status, maxLtc: maxLtc, maxBucket: maxBucket, binding: (full.sizing && full.sizing.binding) || "", maxNoteRate: full.noteRate, rows: rows };
  }

  /* ---------------------------------------------------------------------
     7. FORMAT / NAME HELPERS (display only)
     --------------------------------------------------------------------- */
  function usd(n) { return "$" + Math.round(n).toLocaleString("en-US"); }
  function title(s) { return clean(s).replace(/\b\w/g, function (m) { return m.toUpperCase(); }); }
  var STATE_NAMES = { IN: "Indiana", LA: "Louisiana" };
  function stateName(s) { return STATE_NAMES[up(s)] || up(s); }

  /* ---------------------------------------------------------------------
     8. PUBLIC API
     --------------------------------------------------------------------- */
  return {
    evaluate: evaluate,
    priceLadder: priceLadder,
    setMarkup: setMarkup,
    // exposed for tooling / tests
    regimeOf: regimeOf, normStrategy: normStrategy, foreclosureType: foreclosureType,
    cityIneligible: cityIneligible, cityCheck: cityCheck, exitShortfall: exitShortfall,
    projectCount: projectCount, tierFromCount: tierFromCount, caps: caps, noteRate: noteRate,
    sizeLoan: sizeLoan, ltcBucket: ltcBucket,
    constants: { MARKUP: MARKUP, ORIG_PCT: ORIG_PCT, RA: RA, MATRIX: MATRIX }
  };
});
