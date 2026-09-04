/* =====================================================================
   YS Capital — THE SPEED PROGRAM  (owner-directed 2026-09-03)

   A COMPOSITION of the Standard (Fidelis, window.YSP) and Silver (EMCAP,
   window.SVP) engines — never a third guideline book. In the owner's words:
   "the Speed Program should be combined with the conservativeness from the
   Standard program and from the Silver program … it should just share …
   always the lesser loan amount between the two programs, the lesser max
   LTV, the lesser max initial, the lesser max ARV, the more conservative
   geographic restrictions … the rate should be the more expensive rate from
   the two programs … the higher origination fees … only going to allow a 10%
   assignment fee … something that we can sell to either note buyer."

   TWO SECTIONS, AND THEY ARE NOT THE SAME THING (owner-reported 2026-09-03,
   after reading the composition panel): "There's one section where it goes
   over why the standard program is, why the silver program is, and chooses
   the middle. Another section of the overlays is no interest reserve, 90%
   LTC, and a $1 million loan amount." So:

     1. THE COMPOSITION — for each ceiling axis, what STANDARD allows, what
        SILVER allows, and the lesser of the two. Those two columns are each
        parent's OWN published guideline row (tierRowOf) and carry no lever
        of ours; the panel must never print a Speed overlay in them.
     2. THE OVERLAYS — this program's own, on top of that lesser: the maximum
        loan, the maximum loan-to-cost, no financed interest reserve, and the
        assignment share. They are listed by `overlayList` and are the ONLY
        numbers this file owns.

   HOW IT IS BUILT — one sentence: run both frozen engines on the Speed
   basis (assignment fee financeable at 10%, no financed reserve), take the
   elementwise MINIMUM of the ceiling each engine says THIS deal may reach,
   apply the overlays, pin BOTH engines to that combined ceiling through
   their own voluntary levers (targetLoan / targetAcqLTV / targetARLTV /
   targetLTC — each a MIN, each inert when unset), and report the evaluation
   with the HIGHER note rate. Refuse if either refuses; MANUAL if either is
   MANUAL.

   WHY IT IS NEVER "THE LESSER OF THE TWO LOAN AMOUNTS" (owner-directed):
   "even though it's going to be less than both programs, you still need to
   enforce the max LTV cap from both programs … if the effective purchase
   price is less … if one of those programs allows a 70% ARV and one of them
   allows 75% ARV, you need to be even less with your loan amount." A 10%
   effective price is a smaller base; a loan below either program's own
   figure can still sit above 90% of THAT base. Ceilings are combined, and
   the loan falls out of the ONE frozen sizing waterfall (YSP.sizeLoan,
   which both engines already share) — no total is ever compared or min'd.
   Measured in docs/SPEED-PROGRAM-RESEARCH.md §4: the shortcut over-lends by
   $9,424 and $13,331 on two of five scenarios.

   WHY THE STRUCTURE IS THE HIGHER-RATE ENGINE'S EVALUATION (decision D3):
   under an identical ceiling the two engines differ ONLY in the financed
   interest reserve, which each prices at its own rate. Reporting the
   higher-rate engine's evaluation means the reserve is funded at the rate
   the borrower will actually pay. The other engine's rate at this SAME
   structure is carried on `speed.standard` / `speed.silver`, so the
   derivation page can show both.

   WHAT THIS FILE DOES NOT CONTAIN: a matrix, a grid, a geography list, a
   tier ladder, an assignment formula, a rate. Every number comes out of the
   two engines it composes; when EMCAP sends a new workbook or the Standard
   matrix moves, Speed moves with it. The four constants below are the Speed
   Program's OWN overlays and nothing else.

   Reuses YSP / SVP exactly as src/lib/pricing.js loads them; the server and
   the browser run this same file (two byte-identical copies, web/tools and
   web/v2/tools — scripts/test-engine-copies-match.js). Proven by
   scripts/test-speed-program-pure.js: dual-sellability (each program alone,
   at ITS OWN 15% rule and caps, accepts every Speed loan), rate ≥ both,
   worst status wins, the 10% basis, the overlays, cap attribution.
   Exposes window.SPP (browser) and module.exports (Node).
   ===================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./standard-program.js"), require("./silver-program.js"));
  else root.SPP = browserView(factory(root.YSP, root.SVP));
  function browserView(a) {
    var out = {}, k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k) && k !== "constants") out[k] = a[k];
    return out;
  }
}(typeof self !== "undefined" ? self : this, function (YSP, SVP) {
  "use strict";

  /* ---------------- the Speed Program's OWN overlays (owner 2026-09-03) ---------------- */
  var SPEED_MAX_LOAN = 800000;         // "Let's move down the maximum of the speed program to $800,000."
  var ASSIGNMENT_MAX_PCT = 0.10;       // "only going to allow a 10% assignment fee (wholesale fee)"
  /* Two more overlays (owner-directed 2026-09-03, second message): "on this Speed Program
     we never allow interest reserve. Financed interest reserve … even if you're putting
     in the pricer that you need interest reserve, this program is gonna have even a
     smaller loan amount because we don't allow financed interest reserve. We're going
     to cap it at 90% LTC, never more than 90% LTC, even if both programs allow."
     The reserve is part of the cost basis on both parents, so financing it lifts the
     loan-to-cost wall the loan can reach; refusing it is one more way the Speed loan
     is smaller than either parent's while still under every one of their caps. */
  var SPEED_MAX_LTC = 0.90;            // never more than 90% loan-to-cost
  var FINANCED_RESERVE_ALLOWED = false; // no financed interest reserve, whatever was requested
  var MAX_PASSES = 4;                  // the ceiling fixed point (Silver may step down under a pin)
  var ORIG_PCT = 0.0125;               // the engine-constant fallback for the Speed origination chain
                                       // (per-file origSpeedPct → company orig_speed_pct → this)
  var LABEL = { standard: "Standard", silver: "Silver", both: "both programs", speed: "a Speed Program overlay" };
  var PROGRAM_NAME = { standard: "Standard Program", silver: "Silver Program" };
  var RANK = { ELIGIBLE: 0, MANUAL: 1, INELIGIBLE: 2, ERROR: 3 };
  var CAP_KEYS = ["maxLoan", "maxAcqLTV", "maxARLTV", "maxLTC"];
  var LADDER_BUCKETS = [0.925, 0.90, 0.85, 0.80, 0.75, 0.70, 0.65];

  /* ---------------- small helpers (own copies; the engines' are private) ---------------- */
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function round2(n) { return Math.round(num(n) * 100) / 100; }
  function usd(n) { return "$" + Math.round(num(n)).toLocaleString("en-US"); }
  function pct(x) { return (Math.round(num(x) * 1000) / 10) + "%"; }
  function assign(t) { for (var i = 1; i < arguments.length; i++) { var s = arguments[i]; if (s) for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k]; } return t; }
  function sized(ev) { return !!(ev && ev.sizing && num(ev.sizing.totalLoan) > 0); }
  function worse(a, b) { return (RANK[a] == null ? 3 : RANK[a]) >= (RANK[b] == null ? 3 : RANK[b]) ? a : b; }

  /* The ceiling THIS deal was sized at, per engine. Standard publishes it as `caps`
     (its effective caps row); Silver publishes THREE meanings and the enforcement
     one is `pricedCeiling` (what the deal was priced at, after the step-down
     lattice) — never `caps`, which is the program maximum, nor `tierCaps`. */
  function ceilingOf(name, ev) {
    var c = ev ? (name === "silver" ? (ev.pricedCeiling || ev.caps) : ev.caps) : null;
    if (!c) return null;
    return { maxLoan: num(c.maxLoan), minFico: num(c.minFico), maxAcqLTV: num(c.maxAcqLTV), maxARLTV: num(c.maxARLTV), maxLTC: num(c.maxLTC) };
  }

  /* The combined ceiling: elementwise MIN over the two engines and the Speed wall,
     with WHO SET IT recorded per axis (the derivation page prints it; the tests
     assert it). minFico is the MAX (the stricter floor) — informational, since
     each engine already routes a FICO under its own tier minimum to MANUAL. */
  function combine(cS, cV) {
    var out = { maxLoan: 0, minFico: Math.max(cS.minFico, cV.minFico), maxAcqLTV: 0, maxARLTV: 0, maxLTC: 0 };
    var donor = {};
    for (var i = 0; i < CAP_KEYS.length; i++) {
      var k = CAP_KEYS[i], s = cS[k], v = cV[k];
      if (Math.abs(s - v) < 1e-12) { out[k] = s; donor[k] = "both"; }
      else if (s < v) { out[k] = s; donor[k] = "standard"; }
      else { out[k] = v; donor[k] = "silver"; }
    }
    if (SPEED_MAX_LOAN < out.maxLoan - 1e-9) { out.maxLoan = SPEED_MAX_LOAN; donor.maxLoan = "speed"; }
    if (SPEED_MAX_LTC < out.maxLTC - 1e-9) { out.maxLTC = SPEED_MAX_LTC; donor.maxLTC = "speed"; }
    return { caps: out, donor: donor };
  }
  /* WHO REALLY SET THE DOLLAR WALL. The Speed wall is applied through `targetLoan`
     BEFORE pass A (so Silver reads its small-band tier for the pinned deal, which is
     the correct tier for the loan actually being made), which means each engine's
     published ceiling already carries the wall and `combine` above cannot tell the
     wall from a tier row that happens to sit at the same figure. So the attribution
     is read off each engine's OWN tier wall — Standard's exported caps row for the
     regime/loan type/strategy/tier it landed in, Silver's verbatim tier row — and the
     wall is credited only when it is genuinely below both. Attribution only: the
     figure itself is the MIN either way. */
  /* THE PARENT'S OWN GUIDELINE ROW — its published tier row for the profile this deal
     landed in, carrying NO lever: not Speed's walls, not a voluntary target, not the
     step-down lattice. This is what "what does Standard allow / what does Silver allow"
     means on the composition table, and it is why that table can no longer print
     Speed's own $800,000 wall in the two parents' columns (owner-reported 2026-09-03:
     "it's saying that the maximum loan amount of the standard and the silver is $1
     million … which is not true. They have their own stuff"). Standard exposes the row
     through YSP.caps(); Silver publishes it as `tierCaps` (the workbook Tier Grid row,
     verbatim). Null when unreadable — the caller falls back to the enforced ceiling. */
  function tierRowOf(name, ev) {
    try {
      if (name === "silver") { var tc = ev && ev.tierCaps; return tc ? { maxLoan: num(tc.maxLoan), minFico: num(tc.minFico), maxAcqLTV: num(tc.maxAcqLTV), maxARLTV: num(tc.maxARLTV), maxLTC: num(tc.maxLTC) } : null; }
      var row = YSP.caps(ev.regime, ev.loanType, ev.strategyCode, ev.tier);
      return row ? { maxLoan: num(row.maxLoan), minFico: num(row.minFico), maxAcqLTV: num(row.maxAcqLTV), maxARLTV: num(row.maxARLTV), maxLTC: num(row.maxLTC) } : null;
    } catch (_) { return null; }
  }
  function wallDonor(evS, evV, key, speedWall, combined) {
    var rowS = tierRowOf("standard", evS), rowV = tierRowOf("silver", evV);
    var wallS = rowS && num(rowS[key]) > 0 ? num(rowS[key]) : Infinity;
    var wallV = rowV && num(rowV[key]) > 0 ? num(rowV[key]) : Infinity;
    var own = Math.min(wallS, wallV);
    if (!(own < Infinity)) return combined;
    if (speedWall < own - 1e-9) return "speed";
    if (Math.abs(wallS - wallV) < 1e-9) return "both";
    return wallS < wallV ? "standard" : "silver";
  }
  function maxLoanDonor(evS, evV, combined) { return wallDonor(evS, evV, "maxLoan", SPEED_MAX_LOAN, combined); }
  /* The 90% loan-to-cost wall, attributed the same way. (Standard's own row can sit
     below the wall on a square-footage addition — 87.5% — and then pass A already
     credits Standard through `combine`; this only resolves the tie the pin creates.) */
  function maxLtcDonor(evS, evV, combined) { return combined === "both" ? wallDonor(evS, evV, "maxLTC", SPEED_MAX_LTC, combined) : combined; }
  function sameCaps(a, b) {
    for (var i = 0; i < CAP_KEYS.length; i++) if (Math.abs(num(a[CAP_KEYS[i]]) - num(b[CAP_KEYS[i]])) > 1e-9) return false;
    return true;
  }

  /* The Speed basis: the caller's input with the Speed Program's own overlays on
     top. Both are MINs against whatever the caller already set, so a stricter
     caller value survives and nothing here can ever loosen. */
  function speedInput(input) {
    var inp = assign({}, input || {});
    var callerPct = num(inp.assignmentMaxPct);
    inp.assignmentMaxPct = callerPct > 0 ? Math.min(ASSIGNMENT_MAX_PCT, callerPct) : ASSIGNMENT_MAX_PCT;
    var callerLoan = num(inp.targetLoan);
    inp.targetLoan = callerLoan > 0 ? Math.min(SPEED_MAX_LOAN, callerLoan) : SPEED_MAX_LOAN;
    // Never more than 90% loan-to-cost — a MIN against the caller's own voluntary ceiling.
    var callerLtc = num(inp.targetLTC);
    inp.targetLTC = callerLtc > 0 ? Math.min(SPEED_MAX_LTC, callerLtc) : SPEED_MAX_LTC;
    // No financed interest reserve, whatever was requested: both parents read irMonths /
    // irAmount as the request to finance, so zeroing them here is the whole rule — the
    // parents then size, price and settle the rate on a reserve-free structure. What was
    // asked for is remembered on `speed.reserveRequested` so the surfaces can say so.
    if (!FINANCED_RESERVE_ALLOWED) { inp.irMonths = 0; inp.irAmount = 0; }
    return inp;
  }
  function reserveRequested(input) {
    var m = num(input && input.irMonths), a = num(input && input.irAmount);
    return (m > 0 || a > 0) ? { months: m > 0 ? m : null, amount: a > 0 ? a : null } : null;
  }
  function pinTo(inp, caps) {
    return assign({}, inp, { targetLoan: caps.maxLoan, targetAcqLTV: caps.maxAcqLTV, targetARLTV: caps.maxARLTV, targetLTC: caps.maxLTC });
  }

  /* Which engine's evaluation is the Speed answer: the HIGHER note rate (an
     engine with no price — Silver's "no priced grid cell" — never donates);
     ties → the smaller loan; still tied → Standard. */
  function pickDonor(evS, evV) {
    var rS = num(evS.noteRate), rV = num(evV.noteRate);
    if (rS > rV + 1e-12) return "standard";
    if (rV > rS + 1e-12) return "silver";
    var tS = sized(evS) ? evS.sizing.totalLoan : Infinity, tV = sized(evV) ? evV.sizing.totalLoan : Infinity;
    return tV < tS - 0.5 ? "silver" : "standard";
  }

  /* Reasons are CARRIED, never rewritten: each engine's own sentence, prefixed with
     the program that raised it, so a reader sees "[Silver] Properties in Nevada are
     not eligible for the Silver Program" and not a sentence nobody authorised. Each
     engine's "Meets the … guidelines." line is dropped (Speed states its own); a
     sentence both engines raise identically is kept once, tagged [Both]. */
  function isMeetsLine(r) { return /^Meets the .* guidelines\.$/.test(String(r && r.msg || "")); }
  /* THE ASSIGNMENT-CAP SENTENCE IS SPEED'S, NOT THE PARENTS' (owner-reported 2026-09-03:
     "it's saying that this is relevant for both. This is also an overlay only for this
     program"). Both engines raise the identical sentence because both were handed the
     Speed Program's 10% share, so the plain de-duplication tagged it [Both] — and read
     as if Standard and Silver each capped assignment fees at 10%, which neither does
     (their own rule is 15%). Whenever the share in force is BELOW the company's 15%, it
     is this program's overlay and it is tagged as one. */
  function isAssignmentCapLine(r) { return /assignment fee is financed \(the /.test(String(r && r.msg || "")); }
  function mergeReasons(evS, evV, sharePct) {
    var overlayShare = num(sharePct) > 0 && num(sharePct) < 0.15;
    var out = [], seen = {};
    var listS = (evS && evS.reasons) || [], listV = (evV && evV.reasons) || [];
    var inV = {};
    for (var j = 0; j < listV.length; j++) inV[listV[j].level + "|" + listV[j].msg] = true;
    for (var i = 0; i < listS.length; i++) {
      var r = listS[i]; if (isMeetsLine(r)) continue;
      var key = r.level + "|" + r.msg; if (seen[key]) continue; seen[key] = true;
      if (overlayShare && isAssignmentCapLine(r)) { out.push({ level: r.level, msg: "[Speed overlay] " + r.msg, code: r.code || "speed_assignment_cap", program: "speed" }); continue; }
      out.push({ level: r.level, msg: (inV[key] ? "[Both] " : "[Standard] ") + r.msg, code: r.code, program: inV[key] ? "both" : "standard" });
    }
    for (var k2 = 0; k2 < listV.length; k2++) {
      var r2 = listV[k2]; if (isMeetsLine(r2)) continue;
      var key2 = r2.level + "|" + r2.msg; if (seen[key2]) continue; seen[key2] = true;
      if (overlayShare && isAssignmentCapLine(r2)) { out.push({ level: r2.level, msg: "[Speed overlay] " + r2.msg, code: r2.code || "speed_assignment_cap", program: "speed" }); continue; }
      out.push({ level: r2.level, msg: "[Silver] " + r2.msg, code: r2.code, program: "silver" });
    }
    return out;
  }

  /* A compact, shape-stable summary of one engine's evaluation for the explain block. */
  function summary(ev, ownCeiling) {
    var c = ev ? (ev.pricedCeiling || ev.caps) : null;
    return {
      status: ev ? ev.status : "ERROR",
      tier: ev ? (ev.tier || null) : null,
      tierLabel: ev ? (ev.tierLabel || null) : null,
      noteRate: ev && ev.noteRate ? num(ev.noteRate) : null,
      totalLoan: sized(ev) ? ev.sizing.totalLoan : null,
      initialAdvance: sized(ev) ? ev.sizing.acquisition : null,
      financedIR: sized(ev) ? num(ev.sizing.financedIR) : null,
      ceiling: c ? { maxLoan: num(c.maxLoan), maxAcqLTV: num(c.maxAcqLTV), maxARLTV: num(c.maxARLTV), maxLTC: num(c.maxLTC) } : null,
      ownCeiling: ownCeiling || null,
    };
  }

  function speedLine(caps, donor, evS, evV, rateDonor) {
    var who = function (k) { return donor[k] === "speed" ? "the Speed Program's own wall" : (LABEL[donor[k]] || donor[k]); };
    var rS = num(evS.noteRate), rV = num(evV.noteRate);
    return "Sized under the lesser of the Standard and Silver programs, then the Speed Program's own overlays (" + usd(SPEED_MAX_LOAN) + " maximum loan, " + pct(SPEED_MAX_LTC) + " maximum loan-to-cost, no financed interest reserve, assignment fees financeable to " + pct(ASSIGNMENT_MAX_PCT) + ")" +
      ". Enforced: max loan " + usd(caps.maxLoan) + " (" + who("maxLoan") + "), acquisition LTV " + pct(caps.maxAcqLTV) + " (" + who("maxAcqLTV") +
      "), after-repair LTV " + pct(caps.maxARLTV) + " (" + who("maxARLTV") + "), loan-to-cost " + pct(caps.maxLTC) + " (" + who("maxLTC") +
      "); priced at the higher of the two rates for this structure — Standard " + (rS ? pct(rS) : "unpriced") + ", Silver " + (rV ? pct(rV) : "unpriced") +
      " → " + LABEL[rateDonor] + ".";
  }
  /* THE SPEED PROGRAM'S OWN OVERLAYS, as a list — the second section of the
     composition panel (owner-directed 2026-09-03: "There's one section where it goes
     over why the standard program is, why the silver program is, and chooses the
     middle. Another section of the overlays is no interest reserve, 90% LTC, and a
     $1 million loan amount"). The FIGURES come from the constants above, so a surface
     can never print a stale one, and the parents' columns never carry them. */
  function overlayList(inp) {
    return [
      { key: "max_loan", label: "Maximum loan", value: usd(SPEED_MAX_LOAN),
        note: "The Speed Program never lends more than " + usd(SPEED_MAX_LOAN) + ", whatever the two programs allow." },
      { key: "max_ltc", label: "Maximum loan-to-cost", value: pct(SPEED_MAX_LTC),
        note: "Never more than " + pct(SPEED_MAX_LTC) + " of cost, even where both programs allow more." },
      { key: "no_reserve", label: "Financed interest reserve", value: "Not allowed",
        note: "Interest is never financed into a Speed loan; it is paid from the borrower's own funds." },
      { key: "assignment", label: "Assignment fee financeable", value: pct(num(inp && inp.assignmentMaxPct) || ASSIGNMENT_MAX_PCT),
        note: "Of the seller's contract price — the company rule is 15%; the Speed Program allows " + pct(ASSIGNMENT_MAX_PCT) + "." },
    ];
  }
  function reserveLine(req) {
    if (!req) return null;
    var asked = req.months ? (req.months + " month" + (req.months === 1 ? "" : "s")) : usd(req.amount);
    return { level: "ELIGIBLE", program: "speed", code: "speed_no_financed_reserve",
      msg: "Interest reserve is not financed on the Speed Program — the " + asked + " requested are not in this loan; interest is paid from the borrower's own funds and the liquidity to show is measured accordingly." };
  }

  function result(status, reasons, extra) {
    var o = { program: "speed", status: status, eligible: status !== "INELIGIBLE" && status !== "ERROR", reasons: reasons };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
    return o;
  }

  /* The fields every engine result carries, so every surface that reads a Standard
     or Silver result reads a Speed one the same way. `caps` and `pricedCeiling` are
     BOTH the combined ceiling (there is no separate "program maximum" for a deal;
     the combination IS the program). */
  function baseFields(evS, evV, donorEv) {
    return {
      tier: donorEv.tier || null,
      tierLabel: (evS.tierLabel || evV.tierLabel) ? ("Standard " + (evS.tierLabel || "—") + " · Silver " + (evV.tierLabel || "—")) : null,
      strategyCode: donorEv.strategyCode || evS.strategyCode || evV.strategyCode || null,
      loanType: donorEv.loanType || evS.loanType || evV.loanType || null,
      cashOut: !!(evS.cashOut || evV.cashOut),
      projectCount: donorEv.projectCount != null ? donorEv.projectCount : (evS.projectCount != null ? evS.projectCount : evV.projectCount),
      pricingReady: !!(evS.pricingReady && evV.pricingReady),
      // Standard-side facts the term sheet prints (judicial state, heavy rehab, the
      // sub-$100k exception) and Silver-side facts (market, DSCR, overlays, the
      // grid cell) both ride along — a Speed file must satisfy both books.
      regime: evS.regime || null, foreclosure: evS.foreclosure || null, heavy: !!evS.heavy, heavyAuto: !!evS.heavyAuto, sqft: !!evS.sqft,
      cityReview: evS.cityReview || null, judicialSmallPurchase: evS.judicialSmallPurchase || null,
      market: evV.market || null, sizeBand: evV.sizeBand || null, product: evV.product || null, exit: evV.exit || null,
      gcOnly: !!evV.gcOnly, dscr: evV.dscr != null ? evV.dscr : null, overlays: evV.overlays || null, rateKey: evV.rateKey || null,
      geoReview: evV.geoReview || null,
      reserveTermCapped: !!(evS.reserveTermCapped || evV.reserveTermCapped),
      reserveTermMonths: donorEv.reserveTermMonths || evS.reserveTermMonths || evV.reserveTermMonths || null,
      exitShortfall: Math.max(num(evS.exitShortfall), num(evV.exitShortfall)),
      assignment: donorEv.assignment || evS.assignment || evV.assignment || null,
      tierCaps: null,
    };
  }

  /* ---------------- THE COMPOSITION ---------------- */
  function evaluate(input) {
    try { return evaluateInner(input); }
    catch (e) {
      // Never throw into a quote: an error is an ERROR status, not an eligible deal.
      return result("ERROR", [{ level: "INELIGIBLE", msg: "The Speed Program could not be priced: " + (e && e.message ? e.message : String(e)) }],
        { caps: null, pricedCeiling: null, noteRate: 0, sizing: null, assignment: null, speed: null, tierCaps: null });
    }
  }

  function evaluateInner(input) {
    var inp = speedInput(input);
    var typed = num(inp.loanAmount);

    // Pass A — each engine's OWN ceiling for THIS deal, read on the Speed basis.
    var evS = YSP.evaluate(inp), evV = SVP.evaluate(inp);
    var status = worse(evS.status, evV.status);
    var cS = ceilingOf("standard", evS), cV = ceilingOf("silver", evV);
    var reasons;
    if (status === "INELIGIBLE" || !cS || !cV || !sized(evS) || !sized(evV)) {
      // One program refuses, or one could not size (a city review with no pricing, a
      // missing figure): Speed carries both programs' sentences and no structure.
      reasons = mergeReasons(evS, evV, inp.assignmentMaxPct);
      if (typed > SPEED_MAX_LOAN) reasons.unshift({ level: "INELIGIBLE", msg: "Loan amount exceeds the Speed Program's " + usd(SPEED_MAX_LOAN) + " maximum.", program: "speed" });
      if (!reasons.length) reasons.push({ level: status === "INELIGIBLE" ? "INELIGIBLE" : "MANUAL", msg: "The Speed Program could not size this deal on both programs — submit for individual review.", program: "speed" });
      var st0 = typed > SPEED_MAX_LOAN ? "INELIGIBLE" : (status === "ELIGIBLE" ? "MANUAL" : status);
      return result(st0, reasons, assign(baseFields(evS, evV, pickDonor(evS, evV) === "silver" ? evV : evS), {
        caps: null, pricedCeiling: null, noteRate: 0, sizing: null,
        speed: { maxLoanCap: SPEED_MAX_LOAN, maxLtcCap: SPEED_MAX_LTC, financedReserveAllowed: FINANCED_RESERVE_ALLOWED, reserveRequested: reserveRequested(input), assignmentMaxPct: inp.assignmentMaxPct, overlays: overlayList(inp), passes: 0, converged: false, rateDonor: null, capDonor: null,
          standard: summary(evS, cS), silver: summary(evV, cV) },
      }));
    }
    /* The parents' OWN rows for the display — never the pinned ceilings, which carry
       Speed's walls (see tierRowOf). Falls back to the pinned ceiling when a row is
       unreadable, which can only make the display more conservative, never wrong-way. */
    var ownS = tierRowOf("standard", evS) || cS, ownV = tierRowOf("silver", evV) || cV;
    var comb = combine(cS, cV), caps = comb.caps, donor = comb.donor;
    donor.maxLoan = maxLoanDonor(evS, evV, donor.maxLoan);
    donor.maxLTC = maxLtcDonor(evS, evV, donor.maxLTC);

    // Pass B — both engines under the SAME ceiling. Silver's step-down lattice may
    // lower its ceiling again under the pin (an unpriced cell), so iterate to a
    // fixed point; the ceiling is non-increasing and the bands are finite.
    var passes = 0, converged = false;
    while (passes < MAX_PASSES) {
      passes++;
      var pinned = pinTo(inp, caps);
      evS = YSP.evaluate(pinned); evV = SVP.evaluate(pinned);
      status = worse(evS.status, evV.status);
      cS = ceilingOf("standard", evS); cV = ceilingOf("silver", evV);
      if (status === "INELIGIBLE" || !cS || !cV || !sized(evS) || !sized(evV)) {
        reasons = mergeReasons(evS, evV, inp.assignmentMaxPct);
        if (!reasons.length) reasons.push({ level: "MANUAL", msg: "The Speed Program could not size this deal on both programs under the combined ceiling — submit for individual review.", program: "speed" });
        return result(status === "ELIGIBLE" ? "MANUAL" : status, reasons, assign(baseFields(evS, evV, pickDonor(evS, evV) === "silver" ? evV : evS), {
          caps: caps, pricedCeiling: caps, noteRate: 0, sizing: null,
          speed: { maxLoanCap: SPEED_MAX_LOAN, maxLtcCap: SPEED_MAX_LTC, financedReserveAllowed: FINANCED_RESERVE_ALLOWED, reserveRequested: reserveRequested(input), assignmentMaxPct: inp.assignmentMaxPct, overlays: overlayList(inp), passes: passes, converged: false, rateDonor: null, capDonor: donor,
            standard: summary(evS, ownS), silver: summary(evV, ownV) },
        }));
      }
      var next = combine(cS, cV);
      if (sameCaps(next.caps, caps)) { converged = true; break; }
      // A lower ceiling came back and there is no pass left to size at it: keep `caps`
      // as the ceiling the two evaluations WERE sized at (the reported structure and the
      // reported ceiling must be the same one), and fall through as not converged.
      if (passes >= MAX_PASSES) break;
      // Keep the ORIGINAL attribution where the figure did not move; a newly lowered
      // axis is attributed to whoever lowered it.
      for (var i = 0; i < CAP_KEYS.length; i++) if (Math.abs(next.caps[CAP_KEYS[i]] - caps[CAP_KEYS[i]]) > 1e-9) donor[CAP_KEYS[i]] = next.donor[CAP_KEYS[i]];
      caps = next.caps;
    }
    if (!converged) {
      reasons = mergeReasons(evS, evV, inp.assignmentMaxPct);
      reasons.unshift({ level: "MANUAL", msg: "The Speed Program could not settle on a structure both programs price after " + MAX_PASSES + " passes — submit for individual review.", program: "speed" });
      status = worse(status, "MANUAL");
    }

    var rateDonor = pickDonor(evS, evV);
    var donorEv = rateDonor === "silver" ? evV : evS;
    var other = rateDonor === "silver" ? evS : evV;

    /* THE LESSER MAX INITIAL, EVEN WHEN A PARENT'S OWN FLOOR — NOT A CAP — SETS IT.
       Under one combined ceiling the two parents differ only by the reserve, priced at
       each rate — EXCEPT where one carries a floor of its own on the initial advance
       (Standard's judicial-state sub-$100k exception holds the initial $20,000 below
       the price). The owner's rule is "the lesser max initial", so when the rate
       donor's initial exceeds the other parent's by more than the reserve difference,
       the donor is re-sized with its acquisition lever pinned to the other's initial
       (a MIN, so nothing loosens) — and the structure stays the donor's, reserve
       funded at its rate. Measured in the soak (seed 7): a $77,772 Pittsburgh bridge,
       Standard $57,772 vs Silver $58,329. */
    if (sized(donorEv) && sized(other)) {
      var dInit = num(donorEv.sizing.acquisition) - num(other.sizing.acquisition);
      var dRes = Math.abs(num(donorEv.sizing.financedIR) - num(other.sizing.financedIR));
      var denom = num(donorEv.sizing.acqDenom);
      if (dInit > dRes + 1 && denom > 0) {
        var pinAcq = Math.min(caps.maxAcqLTV, num(other.sizing.acquisition) / denom);
        var re = (rateDonor === "silver" ? SVP : YSP).evaluate(assign(pinTo(inp, caps), { targetAcqLTV: pinAcq }));
        if (sized(re) && re.status !== "INELIGIBLE") {
          donorEv = re; if (rateDonor === "silver") evV = re; else evS = re;
          /* THE REPORTED CEILING IS ALWAYS THE ONE THE REPORTED STRUCTURE WAS SIZED AT.
             The alignment tightened the acquisition wall below the combined ceiling, so
             the combined ceiling moves with it and the axis is credited to the parent
             whose own floor set the smaller initial — otherwise the panel would print an
             acquisition LTV this loan was never sized at. */
          if (pinAcq < caps.maxAcqLTV - 1e-9) {
            caps = assign({}, caps, { maxAcqLTV: pinAcq });
            donor.maxAcqLTV = (rateDonor === "silver") ? "standard" : "silver";
          }
        }
      }
    }
    // The rate is the higher of the two whatever structure was kept.
    var noteRate = Math.max(num(evS.noteRate), num(evV.noteRate));
    if (Math.abs(noteRate - num(donorEv.noteRate)) > 1e-12) rateDonor = (num(evS.noteRate) >= num(evV.noteRate)) ? "standard" : "silver";

    // A price is required from BOTH programs for an ELIGIBLE Speed quote — "sellable
    // to either note buyer" means each has a rate for this loan.
    if (!(num(evS.noteRate) > 0) || !(num(evV.noteRate) > 0)) status = worse(status, "MANUAL");
    if (typed > SPEED_MAX_LOAN) status = "INELIGIBLE";

    reasons = converged ? mergeReasons(evS, evV, inp.assignmentMaxPct) : reasons;

    /* SELLABLE TO EITHER BUYER MEANS EACH BUYER'S OWN BOOK ACCEPTS THIS LOAN — on ITS
       OWN basis. The passes above run the parents on the Speed basis (10% share), and a
       gate that reads the recognized price can pass there and FAIL under the parent's
       own 15% rule, where the recognized price — and the cost basis — is higher
       (Silver's "the after-repair value must exceed the cost basis" did exactly that in
       the soak, seed 7). So each parent is asked once more, on the caller's own input
       (its own 15% rule) pinned only to the Speed loan amount: an INELIGIBLE there is
       an INELIGIBLE here, a MANUAL there is a MANUAL here, and its sentence is carried. */
    if (sized(donorEv)) {
      var gateIn = assign({}, input || {}, { targetLoan: num(donorEv.sizing.totalLoan) });
      var gS = YSP.evaluate(gateIn), gV = SVP.evaluate(gateIn);
      var gStatus = worse(gS.status, gV.status);
      if (RANK[gStatus] > RANK[status]) status = gStatus;
      var gateReasons = mergeReasons(gS, gV), have = {};
      for (var q = 0; q < reasons.length; q++) have[reasons[q].level + "|" + reasons[q].msg] = true;
      for (var g = 0; g < gateReasons.length; g++) {
        var gr = gateReasons[g];
        if (gr.level === "ELIGIBLE") continue;
        if (have[gr.level + "|" + gr.msg]) continue;
        reasons.push(assign({}, gr, { msg: gr.msg + " (on that program's own guidelines for this loan amount)" }));
      }
    }
    if (typed > SPEED_MAX_LOAN) reasons.unshift({ level: "INELIGIBLE", msg: "Loan amount exceeds the Speed Program's " + usd(SPEED_MAX_LOAN) + " maximum.", program: "speed" });
    reasons.unshift({ level: "ELIGIBLE", msg: speedLine(caps, donor, evS, evV, rateDonor), program: "speed", code: "speed_composition" });
    var rl = reserveLine(reserveRequested(input)); if (rl) reasons.splice(1, 0, rl);
    if (status !== "INELIGIBLE" && reasons.length === 1) reasons.push({ level: "ELIGIBLE", msg: "Meets the Speed Program guidelines — the stricter of the Standard and Silver programs.", program: "speed" });

    return result(status, reasons, assign(baseFields(evS, evV, donorEv), {
      caps: caps, pricedCeiling: caps,
      noteRate: noteRate || 0,
      sizing: donorEv.sizing,
      speed: {
        maxLoanCap: SPEED_MAX_LOAN, maxLtcCap: SPEED_MAX_LTC, financedReserveAllowed: FINANCED_RESERVE_ALLOWED, reserveRequested: reserveRequested(input), assignmentMaxPct: inp.assignmentMaxPct, overlays: overlayList(inp), passes: passes, converged: converged,
        rateDonor: rateDonor, capDonor: donor,
        standard: summary(evS, ownS), silver: summary(evV, ownV),
      },
    }));
  }

  /* ---------------- PRICING LADDER — the Standard shape, through the composition ---------------- */
  function priceLadder(input) {
    var full = evaluate(input);
    if (full.status === "INELIGIBLE" || full.status === "ERROR" || !sized(full)) {
      return { eligible: false, status: full.status, reasons: full.reasons, rows: [] };
    }
    var maxLtc = full.sizing.ltcPct;
    var rows = [], seenTotal = {};
    var top = { ltc: maxLtc, targetLtcPct: full.sizing.ltcPct, totalLoan: full.sizing.totalLoan, initialAdvance: full.sizing.acquisition,
      downPayment: full.sizing.downPayment, rehabHoldback: full.sizing.rehabLoan, noteRate: full.noteRate || 0,
      monthlyPayment: round2(full.sizing.totalLoan * ((full.noteRate || 0) / 12)), isMax: true };
    rows.push(top); seenTotal[Math.round(top.totalLoan)] = true;
    for (var i = 0; i < LADDER_BUCKETS.length; i++) {
      var b = LADDER_BUCKETS[i];
      if (b > maxLtc - 1e-9) continue;
      var ev = evaluate(assign({}, input, { targetLTC: b }));
      if (ev.status === "INELIGIBLE" || !sized(ev)) continue;
      var s = ev.sizing, key = Math.round(s.totalLoan);
      if (seenTotal[key]) continue;                       // a rung that buys nothing is noise
      seenTotal[key] = true;
      var rate = ev.noteRate || 0;
      rows.push({ ltc: b, targetLtcPct: s.ltcPct, totalLoan: s.totalLoan, initialAdvance: s.acquisition, downPayment: s.downPayment,
        rehabHoldback: s.rehabLoan, noteRate: rate, monthlyPayment: round2(s.totalLoan * (rate / 12)), isMax: false });
    }
    return { eligible: true, status: full.status, maxLtc: maxLtc, binding: (full.sizing && full.sizing.binding) || "", maxNoteRate: full.noteRate, rows: rows };
  }

  /* Markup hooks FORWARD TO BOTH ENGINES. The Speed Program has its OWN margin (owner
     2026-09-03, second message — the Pricing Admin Center's markup_speed_pct and Speed
     per-tier values, the per-file sticky markup): the server hands it to this hook and
     both parents price at it, so the note rate is the higher of the two BUY rates plus
     the Speed margin (Silver's frozen engine clamps any margin it receives at 1.00%).
     The same forwarding lets the server's rate build-up measure the buy rate by pinning
     the margin and re-pricing (pricing.js measureRateBuildUp), proving itself or omitting. */
  function setMarkup(f) { YSP.setMarkup(f); SVP.setMarkup(f); }
  function setMarkupTiers(m) { YSP.setMarkupTiers(m); SVP.setMarkupTiers(m); }

  return {
    evaluate: evaluate,
    priceLadder: priceLadder,
    setMarkup: setMarkup, setMarkupTiers: setMarkupTiers,
    speedInput: speedInput, combine: combine, ceilingOf: ceilingOf,
    constants: { SPEED_MAX_LOAN: SPEED_MAX_LOAN, SPEED_MAX_LTC: SPEED_MAX_LTC, FINANCED_RESERVE_ALLOWED: FINANCED_RESERVE_ALLOWED, ASSIGNMENT_MAX_PCT: ASSIGNMENT_MAX_PCT, MAX_PASSES: MAX_PASSES, ORIG_PCT: ORIG_PCT, LADDER_BUCKETS: LADDER_BUCKETS.slice() }
  };
}));
