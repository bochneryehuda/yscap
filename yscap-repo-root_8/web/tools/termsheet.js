/* =====================================================================
   YS CAPITAL — TERM SHEET STUDIO
   Instant, signable Standard Program term sheet (fix & flip / fix & hold,
   ground-up, bridge — purchase, refinance, cash-out). All eligibility,
   maximum leverage, pricing and loan sizing come from the shared engine
   (standard-program.js / window.YSP). The page shows the BORROWER NOTE
   RATE only. Shared YS helpers: num, fmtUSD, fmtPct, put, syncURL, share.
   ===================================================================== */
(function () {
  "use strict";

  // MINIMUM INTEREST (owner-directed 2026-07-14, ALL programs current and
  // future): every term sheet carries a three-month minimum EARNED interest
  // provision — a payoff before three full months of interest simply pays the
  // remainder of that minimum at payoff. Industry-standard bridge/RTL term;
  // it is a minimum-interest (interest floor) provision, NOT a prepayment
  // penalty, and the wording must always say so.
  var MIN_INTEREST_ROW = "3 months (minimum earned interest \u2014 not a prepayment penalty)";
  var MIN_INTEREST_DETAIL = "All programs carry a 3-month minimum earned interest provision: if the loan pays off before three full months of interest have accrued, the remainder of that minimum is due at payoff. This is an interest floor, not a prepayment penalty.";


  var LENDER = { name: "YS Capital Group", nmls: "2609746", email: "sales@yscapgroup.com", phone: "718-831-2168" };
  var FEES = { lender: 2195, credit: 150, appraisal: 800 };   // flat third-party estimates (origination % comes from the engine / admin field)
  // Company-wide pricing defaults (Pricing Admin Center, owner-directed
  // 2026-07-14): seeded to the historic literals, then overwritten live from
  // /api/pricing-defaults so a company fee/markup change reaches every new term
  // sheet on the marketing generator AND the portal studio. The admin studio
  // fields still override per session; a per-file registration still snapshots.
  var CO = { markupStd: 0.5, markupGold: 0.5, origStd: 1.25, origGold: 1.25, lender: 2195, credit: 150, appraisal: 800, title: null, extraFees: [] };

  var el = function (id) { return document.getElementById(id); };
  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };
  var val = function (id) { var e = el(id); return e ? String(e.value).trim() : ""; };
  var num = function (id) { return YS.num(id); };
  function chk(id) { var e = el(id); return !!(e && e.checked); }
  // #104: the loan is made to the borrowing ENTITY when one is named (the vesting
  // LLC — business-purpose loans are to the entity, guaranteed by the individual);
  // otherwise to the individual borrower. This is the "who the loan is to" name
  // used on the term sheet / letter / filename. The individual borrower is still
  // tracked separately (guarantor / signatory).
  function borrowerOfRecord() { return val("entityName") || val("borrowerName"); }

  // Leverage choice: null = the deal's maximum achievable leverage (default).
  // Otherwise an LTC bucket the borrower has dialled down to for a better rate.
  var chosenLTC = null;
  var goldChosenLTC = null;   // admin leverage slider for Gold (targetLTC); Gold rate is flat across leverage
  var lastDeal = null;   // tracks deal-type changes (to default the ground-up term/reserve once)
  var chosenProgram = null;   // null = offers view; "standard" | "gold" = drilled into that program's detail

  var INELIGIBLE_CITIES = ["baltimore", "philadelphia", "detroit", "chicago"];
  function detectCity(addr) {
    var a = String(addr || "").toLowerCase();
    for (var i = 0; i < INELIGIBLE_CITIES.length; i++) if (a.indexOf(INELIGIBLE_CITIES[i]) > -1) return INELIGIBLE_CITIES[i];
    return "";
  }

  /* ---------------- deal helpers ---------------- */
  function purpose() { return val("dealPurpose") || "Purchase"; }
  function isRefi() { return purpose().indexOf("refinance") > -1 || purpose().indexOf("Refinance") > -1; }
  function isCashOut() { return purpose().toLowerCase().indexOf("cash-out") > -1; }
  function dealType() { return val("dealType"); }
  function isGroundUp() { return YSP.normStrategy(dealType()) === "NC"; }
  function isAssign() { return chk("isAssign"); }
  function effPurchase() { return isRefi() ? num("asIs") : num("price"); }  // total purchase price

  /* ---------------- build the engine input ---------------- */
  function gather() {
    var o = {
      loanType: isRefi() ? "Refinance" : "Purchase",
      cashOut: isCashOut(),
      strategy: dealType(),
      state: val("propState"),
      city: "",                                              // term sheet has no dedicated city field
      address: chk("addrTBD") ? "" : val("propAddr"),        // ineligible city inside address -> manual review (see engine cityCheck)
      propertyType: val("propType"),
      fico: num("fico"),
      expFlips: num("expFlips"), expHolds: num("expBrrrr"), expGround: num("expGround"),
      purchasePrice: isRefi() ? num("asIs") : effPurchase(),
      asIsValue: num("asIs"),
      arv: num("arv"),
      rehabBudget: num("construction"),
      term: num("tsTerm") || 12,
      irMonths: num("irMonths"),
      irAmount: num("irAmount"),   // exact interest-reserve $ amount (overrides months when > 0)
      accrual: "Non-Dutch",
      sqftAddition: chk("sqft"),
      heavyRehab: (YSP.normStrategy(dealType()) === "FF") ? (val("rehabScope") === "heavy") : false,
      isAssignment: isAssign() && !isRefi(), sellerPrice: num("origPrice")
    };
    // Admin assignment exception: an approved effective purchase price (clamped by the
    // engine to never exceed the REAL price) — applies to assignment purchases only.
    var effOvr = adminNumRaw("tsEffPrice"); if (effOvr != null && effOvr > 0) o.ovrEffPrice = effOvr;
    if (manualOn()) {                                        // admin manual scenario: set the basis directly
      o.forcePrice = true;                                   // allow sizing even if the deal is otherwise ineligible
      var mIr = adminNumRaw("tsMIr"); if (mIr != null) o.irMonths = mIr;
      var ltv = adminNumRaw("tsMLtv"); if (ltv != null) o.ovrAcqLTV = ltv / 100;
      var arv = adminNumRaw("tsMArv"); if (arv != null) o.ovrARLTV = arv / 100;
      var ltc = adminNumRaw("tsMLtc"); if (ltc != null) o.ovrLTC = ltc / 100;
      var rt = adminNumRaw("tsMRate"); if (rt != null) o.ovrRate = rt / 100;
    }
    return o;
  }

  /* ---------------- required fields for pricing / export ---------------- */
  // State + FICO + the core values are required before a scenario can be priced and exported.
  // Strategy and purpose carry defaults; experience is optional (0 is valid).
  function missingFields() {
    var miss = [];
    if (!val("propState")) miss.push("Property state");
    if (!(num("fico") > 0)) miss.push("Estimated FICO");
    if (isRefi()) {
      if (!(num("asIs") > 0)) miss.push("As-is value");
    } else if (isAssign()) {
      if (!(num("origPrice") > 0)) miss.push("Seller's contract price");
      if (!(num("price") > 0)) miss.push("Purchase price");
    } else if (!(num("price") > 0)) {
      miss.push("Purchase price");
    }
    if (YSP.normStrategy(dealType()) !== "BR") {   // bridge is as-is only: no ARV, no construction
      if (!(num("arv") > 0)) miss.push("After-repair value (ARV)");
      if (!(num("construction") > 0)) miss.push("Construction / rehab budget");
    }
    return miss;
  }
  function readyToPrice() { return missingFields().length === 0; }
  // Term-sheet ISSUE policy (owner-directed 2026-07-17): a term sheet may be issued
  // only when a real loan can be sized and the deal is not hard-ineligible. A sized
  // MANUAL / escalation deal (exit shortfall, city review, admin manual basis) IS
  // issuable, but the PDF prints stamped "subject to manual review \u2014 not valid without
  // our countersignature". A hard-INELIGIBLE or unsizeable deal can NOT print one.
  function issueDeal() { var d = calc(); if (chosenProgram === "gold") { var g = calcGold(); if (g && !g.unavailable) d = g; } return d; }
  function canIssue(d) { return !!(d && d.totalLoan > 0 && d.status !== "INELIGIBLE"); }
  function needsManualStamp(d) { return !!(d && (d.status === "MANUAL" || d.exitShortfall > 0 || d.cityReview)); }

  // Professional, state-specific overlay note shown only once a limiting state is chosen.
  var STATE_NAMES = { FL: "Florida", CA: "California", NY: "New York" };
  function stateOverlayNote(d) {
    var st = (d.inp.state || "").toUpperCase();
    if (st === "FL") {
      return "Per the Florida program overlay, maximum leverage is reduced and fix & flip / fix & hold refinances (cash-out and rate-and-term) are not eligible. Your terms reflect the Florida limits.";
    }
    if (st === "CA" || st === "NY") {
      return "Per the " + STATE_NAMES[st] + " program overlay, maximum leverage is reduced and fix & flip / fix & hold refinances (cash-out and rate-and-term) are not eligible. Your terms reflect the " + STATE_NAMES[st] + " limits.";
    }
    return "";
  }

  // Build a prefilled manual-review email to YS so an ineligible/edge scenario can be desk-reviewed.
  function manualReviewMailto(d) {
    var L = [];
    L.push("Please review the following scenario for manual underwriting:");
    L.push("");
    L.push("Deal purpose: " + purpose());
    L.push("Strategy: " + (dealType() || "—"));
    L.push("Property state: " + (val("propState") || "—"));
    if (val("propAddr")) L.push("Property: " + val("propAddr"));
    if (!isRefi()) {
      L.push("Purchase price: " + (num("price") ? YS.fmtUSD(num("price")) : "—"));
      if (isAssign()) L.push("Seller's contract price: " + (num("origPrice") ? YS.fmtUSD(num("origPrice")) : "—"));
    }
    L.push("As-is value: " + (num("asIs") ? YS.fmtUSD(num("asIs")) : "—"));
    L.push("ARV: " + (num("arv") ? YS.fmtUSD(num("arv")) : "—"));
    L.push("Rehab budget: " + (num("construction") ? YS.fmtUSD(num("construction")) : "$0"));
    L.push("Requested term: " + (num("tsTerm") || 12) + " months");
    L.push("Interest reserve: " + (num("irAmount") > 0 ? YS.fmtUSD(num("irAmount")) : (num("irMonths") || 0) + " months"));
    L.push("Estimated FICO: " + (num("fico") || "—"));
    L.push("Experience (36 mo): flips " + (num("expFlips") || 0) + ", holds/BRRRR " + (num("expBrrrr") || 0) + ", ground-up " + (num("expGround") || 0));
    if (d && d.totalLoan > 0) L.push("Indicated loan amount: " + YS.fmtUSD(d.totalLoan));
    L.push("");
    var probs = (d && d.reasons || []).filter(function (r) { return r.level !== "ELIGIBLE"; }).map(function (r) { return "• " + r.msg; });
    if (probs.length) { L.push("Flagged:"); L.push(probs.join("\n")); L.push(""); }
    L.push("Please advise on options. Thank you.");
    var subj = "Manual review request — " + (dealType() || "scenario") + (val("propState") ? " (" + val("propState") + ")" : "");
    return "mailto:" + LENDER.email + "?subject=" + encodeURIComponent(subj) + "&body=" + encodeURIComponent(L.join("\n"));
  }

  /* ---------------- conditionals ---------------- */
  function show(node, on) { if (node) node.classList.toggle("hidden", !on); }
  function updateConditionals() {
    var tbd = chk("addrTBD");
    show($('[data-cond="addr"]'), !tbd);
    show($('[data-cond="addrTBDnote"]'), tbd);
    var purchaseOnly = !isRefi();
    $$('[data-cond="purchaseOnly"]').forEach(function (n) { show(n, purchaseOnly); });
    $$('[data-cond="refiOnly"]').forEach(function (n) { show(n, isRefi()); });
    // rehab scope (light/heavy) and sq-ft addition apply only to fix & flip / fix & hold
    var isFF = YSP.normStrategy(dealType()) === "FF";
    $$('[data-cond="ffOnly"]').forEach(function (n) { show(n, isFF); });
    if (!isFF) { var sq = el("sqft"); if (sq) sq.checked = false; }
    // Bridge is as-is only — no rehab, no ARV, no interest reserve. Hide all of it and clear the values.
    var isBridge = YSP.normStrategy(dealType()) === "BR";
    $$('[data-cond="hasRehab"]').forEach(function (n) { show(n, !isBridge); });
    $$('[data-cond="bridgeOnly"]').forEach(function (n) { show(n, isBridge); });
    if (isBridge) { ["construction", "arv", "irMonths", "irAmount"].forEach(function (id) { var e = el(id); if (e && e.value) e.value = ""; }); }

    // Ground-up defaults: first time the user selects ground-up, set an 18-month term and
    // pre-fill a full-term financed reserve (required for non-top-tier; optional for 8+ experience).
    var dt = dealType();
    if (dt !== lastDeal) {
      var nowGround = YSP.normStrategy(dt) === "NC";
      var wasGround = YSP.normStrategy(lastDeal || "") === "NC";
      if (nowGround && !wasGround) {
        if (el("tsTerm") && num("tsTerm") < 18) el("tsTerm").value = 18;
        if (el("irMonths") && num("irMonths") < 18) el("irMonths").value = 18;
      }
      lastDeal = dt;
    }
    show($('[data-cond="isAssign"]'), purchaseOnly && isAssign());
    // assignment fee is derived: total purchase price − seller's price (always reconcile)
    if (purchaseOnly && isAssign()) { var fe = el("assignFee"); if (fe) fe.value = Math.max(0, num("price") - num("origPrice")) || ""; }
    // experience total readout
    var et = el("expTotal");
    if (et) {
      var sc = YSP.normStrategy(dealType());
      var tot = YSP.projectCount(sc, { flips: num("expFlips"), holds: num("expBrrrr"), ground: num("expGround") });
      et.textContent = tot + (tot === 1 ? " project" : " projects") + (isGroundUp() ? " · ground-up only" : " · counts toward this deal");
    }
    var ae = el("assignErr");
    if (ae && ae.style.display === "block") {
      var okMatch = !isAssign() || num("origPrice") <= num("price") + 1;
      if (okMatch) ae.style.display = "none";
    }
  }

  /* ---------------- compute (delegates to the engine) ---------------- */
  function reserveMonths(totalLoan) { return (totalLoan || 0) > 1000000 ? 4 : 2; }  // Standard Program liquidity: 2 months of payments to show under $1M, 4 months over $1M
  function calc() {
    var inp = gather();
    if (chosenLTC) inp.targetLTC = chosenLTC;
    var R = YSP.evaluate(inp);
    if (manualOn()) { if (R.status === "INELIGIBLE") R.status = "MANUAL"; R.exitShortfall = 0; }   // admin-priced basis
    var s = R.sizing || {};
    var asg = R.assignment;
    var rate = (R.noteRate || 0) * 100;                    // borrower note rate only
    // Rounding policy (owner-directed 2026-07-09): report the financed loan in
    // WHOLE DOLLARS floored down, and reconcile the breakdown EXACTLY — floor the
    // initial advance + holdback and let the financed reserve absorb the residual
    // (or the initial, when there is no reserve). Mirrors the LOS and the server
    // (pricing.js). The engine's sizing math is unchanged.
    var totalLoan = Math.floor(s.totalLoan || 0);
    var rehabHoldbackR = Math.floor(s.rehabLoan || 0);
    var initialAdvance = Math.floor(s.acquisition || 0);
    var financedIRr = 0;
    if ((s.financedIR || 0) > 0.5) financedIRr = Math.max(0, totalLoan - initialAdvance - rehabHoldbackR);
    else initialAdvance = Math.max(0, totalLoan - rehabHoldbackR);
    var origPct = adminOrigPct("standard");
    var origFee = (totalLoan) * origPct;                  // origination % (admin-overridable; default 1%)
    // interest-only payment logic (industry standard): during construction the borrower pays
    // interest only on funds DRAWN — starts on the initial advance, grows to the full loan.
    var rFrac = (R.noteRate || 0) / 12;
    var initialPayment = initialAdvance * rFrac;           // while only the initial advance is out
    var fullPayment = totalLoan * rFrac;                   // after all rehab draws complete
    var monthlyInterest = s.monthlyInterest || fullPayment;
    var title = (typeof YSTitle !== "undefined" && YSTitle) ? YSTitle.estimate(inp.state, totalLoan, inp.loanType) : { total: 0 };
    var titleOvr = adminTitle();
    var titleCost = (titleOvr != null) ? titleOvr : (title.total || 0);
    var lenderFee = adminFeeUW(), creditFee = adminFeeCredit(), apprFee = adminFeeAppr();
    var closing = origFee + lenderFee + creditFee + titleCost + extraFeesTotal();      // + company extra fees (NY settlement etc.); appraisal is POC (excluded)
    var excessOOP = (s.assignmentExcessOOP != null ? s.assignmentExcessOOP : (R.assignment && R.assignment.excessOOP)) || 0;
    var cashToClose = (s.downPayment || 0) + excessOOP + closing;   // reserve is never brought to the table
    var reserves = fullPayment * reserveMonths(totalLoan);  // Standard liquidity buffer: months of interest on top of cash to close
    var liquidity = cashToClose + reserves;
    var basisPrice = (asg ? asg.recognizedPrice : (inp.loanType === "Purchase" ? effPurchase() : num("asIs")));
    var displayCost = basisPrice + num("construction") + financedIRr;

    return {
      R: R, inp: inp, eff: (inp.loanType === "Purchase" ? effPurchase() : num("asIs")), basisPrice: basisPrice,
      constr: num("construction"), asg: asg, pricingReady: !!R.pricingReady,
      asIs: num("asIs"), arv: num("arv"), rate: rate, term: inp.term, irMonths: inp.irMonths,
      totalLoan: totalLoan, initialAdvance: initialAdvance, rehabHoldback: rehabHoldbackR,
      financedIR: financedIRr, unfinancedIR: 0,
      maxReserve: s.maxReserve || 0, reserveCapped: !!s.reserveCapped, reserveCapBy: s.reserveCapBy || "",
      maxReserveMonths: s.maxReserveMonths || 0, desiredReserve: s.desiredReserve || 0,
      initialPayment: initialPayment, fullPayment: fullPayment, monthlyInterest: monthlyInterest,
      totalCost: displayCost, downPayment: s.downPayment || 0, excessOOP: excessOOP,
      origFee: origFee, origPct: origPct, lenderFee: lenderFee, creditFee: creditFee, apprFee: apprFee, titleCost: titleCost, titleInfo: title,
      closing: closing, extraFees: extraFeeList(), cashToClose: cashToClose, reserves: reserves, reserveMo: reserveMonths(totalLoan), liquidity: liquidity,
      ltcPct: s.ltcPct || 0, ltvPct: s.acqLtvPct || 0, arvPct: s.arvPct || 0,
      binding: s.binding || "", caps: R.caps, status: R.status, reasons: R.reasons || [],
      exitShortfall: R.exitShortfall || 0, cityReview: R.cityReview || null,
      tierLabel: R.tierLabel, fico: inp.fico
    };
  }

  // Full Gold Standard detail, shaped exactly like calc() so the shared detail renderer can
  // drive the Gold panel. Returns null if the Gold engine is unavailable; {unavailable:true}
  // when the program isn't offered in this state.
  function calcGold() {
    var GS = (typeof GSP !== "undefined" && GSP) ? GSP : null;
    if (!GS) return null;
    var inp = gather();
    if (goldChosenLTC) inp.targetLTC = goldChosenLTC;     // admin Gold leverage slider
    var R = GS.evaluate(inp);
    if (R.available === false) return { unavailable: true, gold: true, R: R, status: "UNAVAILABLE", reasons: R.reasons || [], totalLoan: 0 };
    // Gold Standard renovation carries NO financed interest reserve — force the requested
    // months to zero so nothing populates in the term sheet / studio (Gold path only).
    if (R.kind === "reno") inp.irMonths = 0;
    if (manualOn()) { if (R.status === "INELIGIBLE") R.status = "MANUAL"; R.exitShortfall = 0; }   // admin-priced basis
    var s = R.sizing || {};
    var rate = (R.noteRate || 0) * 100;
    // Rounding policy (owner-directed 2026-07-09) — see calc(); same floor +
    // reconcile so the Gold breakdown sums exactly to the (floored) total loan.
    var totalLoan = Math.floor(s.totalLoan || 0);
    var rehabHoldbackR = Math.floor(s.rehabLoan || 0);
    var initialAdvance = Math.floor(s.acquisition || 0);
    var financedIRr = 0;
    if ((s.financedIR || 0) > 0.5) financedIRr = Math.max(0, totalLoan - initialAdvance - rehabHoldbackR);
    else initialAdvance = Math.max(0, totalLoan - rehabHoldbackR);
    var origPct = adminOrigPct("gold");
    var origFee = totalLoan * origPct;                    // origination % (admin-overridable; default 1%)
    var rFrac = (R.noteRate || 0) / 12;
    var title = (typeof YSTitle !== "undefined" && YSTitle) ? YSTitle.estimate(inp.state, totalLoan, inp.loanType) : { total: 0 };
    var titleOvr = adminTitle();
    var titleCost = (titleOvr != null) ? titleOvr : (title.total || 0);
    var lenderFee = adminFeeUW(), creditFee = adminFeeCredit(), apprFee = adminFeeAppr();
    var closing = origFee + lenderFee + creditFee + titleCost + extraFeesTotal();
    var excessOOP = (s.assignmentExcessOOP != null ? s.assignmentExcessOOP : (R.assignment && R.assignment.excessOOP)) || 0;
    var cashToClose = (s.downPayment || 0) + excessOOP + closing;
    var goldReservePct = R.liquidityPct || 0.05;
    var goldReserve = totalLoan * goldReservePct;            // Gold reserve = 5% of the loan, shown ON TOP of cash to close
    var asg = R.assignment;
    var basisPrice = (asg ? asg.recognizedPrice : (inp.loanType === "Purchase" ? effPurchase() : num("asIs")));
    return {
      R: R, inp: inp, gold: true, eff: basisPrice, basisPrice: basisPrice,
      constr: num("construction"), asg: asg, pricingReady: !!R.pricingReady,
      escalations: R.escalations || [],
      asIs: num("asIs"), arv: num("arv"), rate: rate, term: inp.term, irMonths: inp.irMonths,
      totalLoan: totalLoan, initialAdvance: initialAdvance, rehabHoldback: rehabHoldbackR,
      financedIR: financedIRr, unfinancedIR: 0,
      maxReserve: s.maxReserve || 0, reserveCapped: !!s.reserveCapped, reserveCapBy: s.reserveCapBy || "",
      maxReserveMonths: s.maxReserveMonths || 0, desiredReserve: s.desiredReserve || 0,
      initialPayment: initialAdvance * rFrac, fullPayment: totalLoan * rFrac, monthlyInterest: totalLoan * rFrac,
      totalCost: basisPrice + num("construction") + financedIRr,
      downPayment: s.downPayment || 0, excessOOP: excessOOP,
      origFee: origFee, origPct: origPct, lenderFee: lenderFee, creditFee: creditFee, apprFee: apprFee, titleCost: titleCost, titleInfo: title,
      closing: closing, extraFees: extraFeeList(), cashToClose: cashToClose, reserves: goldReserve, reserveMo: 0,
      liquidity: cashToClose + goldReserve, liquidityPct: goldReservePct,
      ltcPct: s.ltcPct || 0, ltvPct: s.acqLtvPct || 0, arvPct: s.arvPct || 0,
      binding: s.binding || "", caps: R.caps, status: R.status, reasons: R.reasons || [],
      exitShortfall: R.exitShortfall || 0, tierLabel: R.tierLabel, fico: inp.fico,
      productLabel: R.productLabel, irLocked: !!R.irLocked, irRequired: !!R.irRequired, drawFee: R.drawFee || 0
    };
  }

  /* ---------------- render ---------------- */
  function statusClass(st) { return st === "ELIGIBLE" ? "good" : st === "MANUAL" ? "warn" : "bad"; }
  function statusText(st) { return st === "ELIGIBLE" ? "Eligible" : st === "MANUAL" ? "Eligible — manual" : "Not eligible"; }

  function firstReason(rs) { for (var i = 0; i < (rs || []).length; i++) if (rs[i].level !== "ELIGIBLE") return rs[i].msg; return ""; }
  // Shorten any reason string to a plain first-clause for the cards.
  function shortMsg(m) {
    if (!m) return "";
    m = m.split(" \u2014 ")[0].split(". ")[0].trim();
    if (m.length > 74) m = m.slice(0, 72).replace(/[\s,;:]+\S*$/, "") + "\u2026";
    return m;
  }
  function shortReason(rs) { return shortMsg(firstReason(rs)); }
  function exitMsg(rs) { for (var i = 0; i < (rs || []).length; i++) if (/exit doesn't support/.test(rs[i].msg)) return rs[i].msg; return firstReason(rs); }
  function setBadge(id, status, ready) {
    var e = el(id); if (!e) return;
    if (!ready) { e.textContent = "\u2014"; e.className = "pcard-badge"; return; }
    if (status === "UNAVAILABLE") { e.textContent = "Not offered"; e.className = "pcard-badge bad"; return; }
    e.textContent = statusText(status); e.className = "pcard-badge " + statusClass(status);
  }

  // Populate the two headline program cards (Standard from the live calc; Gold Standard from its engine)
  // and the auto comparison note. Returns the Gold Standard result for reuse.
  function renderPrograms(d, ready) {
    var EM = "\u2014";
    // ---- Standard card ----
    var stdExit = ready && (d.exitShortfall > 0);
    var stdCity = ready && !!d.cityReview;
    var stdSized = ready && d.totalLoan > 0 && d.status !== "INELIGIBLE" && !stdExit && !stdCity;
    YS.put("stdLoanBig", (stdExit || stdCity) ? "Manual" : (stdSized ? YS.fmtUSD(d.totalLoan) : ((ready && d.status !== "INELIGIBLE") ? "$0" : EM)));
    YS.put("stdRateBig", (stdSized && d.pricingReady && d.rate > 0) ? d.rate.toFixed(2) + "%" : EM);
    YS.put("stdOrigBig", stdSized ? YS.fmtUSD2(d.origFee) : EM);
    YS.put("stdOrigPts", origPtStr(adminOrigPct("standard")));
    setBadge("stdBadge", d.status, ready);
    var stdWhy = stdExit ? shortMsg(exitMsg(d.reasons)) : (d.status !== "ELIGIBLE" ? shortReason(d.reasons) : "");
    YS.put("stdSub", !ready ? "Enter price, budget & ARV to begin"
      : (stdWhy || (d.caps ? "Max LTC " + pctLbl(d.caps.maxLTC) + " \u00b7 " + (d.tierLabel || "") : "")));

    // ---- Gold Standard card ----
    var GS = (typeof GSP !== "undefined" && GSP) ? GSP : null;
    var gInp = gather(); if (goldChosenLTC) gInp.targetLTC = goldChosenLTC;
    var G = GS ? GS.evaluate(gInp) : { available: false, reasons: [{ level: "UNAVAILABLE", msg: "Gold Standard pricing unavailable." }] };
    var goldCard = el("pcardGold");
    if (G.available === false) {
      YS.put("goldLoanBig", EM); YS.put("goldRateBig", EM); YS.put("goldOrigBig", EM);
      setBadge("goldBadge", "UNAVAILABLE", ready);
      YS.put("goldSub", (G.reasons && G.reasons[0]) ? G.reasons[0].msg : "Not offered in this state");
      if (goldCard) goldCard.classList.add("pcard-off");
    } else {
      if (goldCard) goldCard.classList.remove("pcard-off");
      var gs = G.sizing || {};
      var goldExit = ready && (G.exitShortfall > 0);   // costs>ARV is INELIGIBLE (kept for the explanatory sub-line)
      var gSized = ready && (gs.totalLoan > 0) && G.status !== "INELIGIBLE" && !goldExit;
      YS.put("goldLoanBig", gSized ? YS.fmtUSD(Math.floor(gs.totalLoan)) : ((ready && G.status !== "INELIGIBLE") ? "$0" : EM));
      YS.put("goldRateBig", (gSized && G.pricingReady && G.noteRate > 0) ? (G.noteRate * 100).toFixed(2) + "%" : EM);
      YS.put("goldOrigBig", gSized ? YS.fmtUSD2(Math.floor(gs.totalLoan || 0) * adminOrigPct("gold")) : EM);
      YS.put("goldOrigPts", origPtStr(adminOrigPct("gold")));
      setBadge("goldBadge", G.status, ready);
      var goldWhy = goldExit ? shortMsg(exitMsg(G.reasons)) : (G.status !== "ELIGIBLE" ? shortReason(G.reasons) : "");
      YS.put("goldSub", !ready ? EM : (goldWhy || ((G.productLabel || "") + " \u00b7 " + (G.tierLabel || ""))));
    }

    // ---- comparison note ----
    var note = el("progNote");
    if (note) {
      var msg = comparisonNote(d, G, ready);
      if (msg) { note.style.display = ""; note.innerHTML = msg; } else { note.style.display = "none"; note.innerHTML = ""; }
    }
    return G;
  }

  function comparisonNote(d, G, ready) {
    if (!ready) return "";
    var stdOk = d.status !== "INELIGIBLE" && d.totalLoan > 0;
    var goldOk = G.available !== false && G.status !== "INELIGIBLE" && G.sizing && G.sizing.totalLoan > 0;
    if (stdOk && goldOk && d.pricingReady && G.pricingReady) {
      var dLoan = d.totalLoan - G.sizing.totalLoan, dRate = (d.rate / 100) - G.noteRate, parts = [];
      if (Math.abs(dRate) > 0.00005) parts.push("<strong>" + (dRate > 0 ? "Gold Standard" : "Standard") + "</strong> is <strong>" + (Math.abs(dRate) * 100).toFixed(2) + "% cheaper</strong> on rate");
      if (Math.abs(dLoan) > 500) parts.push("<strong>" + (dLoan > 0 ? "Standard" : "Gold Standard") + "</strong> lends <strong>" + YS.fmtUSD(Math.abs(dLoan)) + " more</strong>");
      var tail = "", sM = d.status === "MANUAL", gM = G.status === "MANUAL";
      if (sM || gM) tail = " " + (sM && gM ? "Both need manual review." : ("The <strong>" + (sM ? "Standard" : "Gold Standard") + "</strong> option needs manual review."));
      return (parts.length ? (parts.join(" \u00b7 ") + ".") : "Both programs price the same on this deal.") + tail;
    }
    if (stdOk && !goldOk) return (G.available === false)
      ? "Only the <strong>Standard Program</strong> is available here \u2014 the Gold Standard isn't offered in this state."
      : "Only the <strong>Standard Program</strong> qualifies as entered.";
    if (goldOk && !stdOk) return "Only the <strong>Gold Standard Program</strong> qualifies as entered.";
    return "";
  }

  function pctLbl(x) { return (Math.round(x * 1000) / 10) + "%"; }

  // Gold leverage ladder — mirrors YSP.priceLadder but for the Gold engine. Gold's rate is flat
  // across leverage; the ladder exists only so an admin can issue a smaller-loan / lower-leverage term sheet.
  function goldLadder() {
    var GS = (typeof GSP !== "undefined" && GSP) ? GSP : null;
    if (!GS) return { eligible: false, rows: [] };
    var base = gather();
    var full = GS.evaluate(base);
    if (full.available === false || full.status === "INELIGIBLE" || !full.sizing || !(full.sizing.totalLoan > 0)) return { eligible: false, rows: [] };
    var maxLtc = full.sizing.ltcPct || 0;
    if (!(maxLtc > 0)) return { eligible: false, rows: [] };
    var floor = Math.min(0.50, maxLtc), rows = [], seen = {};
    var steps = [Math.round(maxLtc * 1000) / 1000];               // exact max first
    for (var v = Math.floor(maxLtc / 0.05) * 0.05; v >= floor - 1e-9; v -= 0.05) { steps.push(Math.round(v * 1000) / 1000); }
    for (var i = 0; i < steps.length; i++) {
      var b = steps[i]; if (b > maxLtc + 1e-9) continue; var key = b.toFixed(3); if (seen[key]) continue; seen[key] = 1;
      var ev = (rows.length === 0) ? full : GS.evaluate(Object.assign({}, base, { targetLTC: b }));
      var s = ev.sizing || {}; if (!(s.totalLoan > 0)) continue;
      rows.push({ ltc: b, targetLtcPct: s.ltcPct, totalLoan: s.totalLoan, initialAdvance: s.acquisition, downPayment: s.downPayment, rehabHoldback: s.rehabLoan, noteRate: ev.noteRate || 0, isMax: rows.length === 0 });
    }
    return { eligible: rows.length > 0, maxLtc: maxLtc, binding: (full.sizing && full.sizing.binding) || "", rows: rows };
  }

  // Draw the leverage slider. Standard: lower leverage earns a lower rate (from the pricing ladder).
  // Gold: same rate at every step — the slider only trades loan size for cash down. Slider shows only
  // when a program is drilled into.
  function renderLeverage(ready) {
    var wrap = el("rLevWrap"); if (!wrap) return;
    var isGold = chosenProgram === "gold";
    if (!ready || !chosenProgram) { wrap.style.display = "none"; return; }
    // On a manual admin exception (LTC/rate overwritten) the leverage-by-tier ladder
    // is meaningless — the admin fixed the basis, so every "tier" would show the same
    // overridden loan/rate. Hide the slider entirely (audit #13/#35).
    if (manualOn() && (adminNumRaw("tsMLtc") != null || adminNumRaw("tsMRate") != null)) { wrap.style.display = "none"; return; }
    var ladder = isGold ? goldLadder() : YSP.priceLadder(gather());
    if (!ladder.eligible || !ladder.rows.length) { wrap.style.display = "none"; return; }
    var rows = ladder.rows;
    var ltcs = rows.map(function (r) { return r.ltc; });
    var chosen = isGold ? goldChosenLTC : chosenLTC;
    if (chosen && ltcs.indexOf(chosen) < 0) { if (isGold) goldChosenLTC = null; else chosenLTC = null; chosen = null; }
    var effIdx = chosen ? ltcs.indexOf(chosen) : 0;
    if (effIdx < 0) effIdx = 0;
    var maxV = rows.length - 1, row = rows[effIdx];
    var slider = el("rLevSlider");
    slider.max = String(maxV);
    slider.value = String(maxV - effIdx);                         // right end = maximum leverage
    slider.disabled = rows.length <= 1;
    var lv = el("rLevVal"), hint = el("rLevHint");
    var progEl = el("rLevProg"); if (progEl) progEl.textContent = isGold ? "\u00b7 Gold Standard" : "\u00b7 Standard";
    if (effIdx === 0) {
      lv.textContent = "Maximum \u00b7 " + pctLbl(row.targetLtcPct) + " LTC";
      if (rows.length <= 1) {
        hint.innerHTML = isGold
          ? "This deal is already at its maximum leverage \u2014 there's no lower step to issue."
          : ("This deal is already at its lowest (best-priced) tier" + (ladder.binding ? (" \u2014 leverage is capped by " + ladder.binding) : "") + ", so lowering leverage further won't reduce the rate.");
      } else {
        hint.innerHTML = isGold
          ? "You're at <b>maximum leverage</b>. Drag left to issue a term sheet with <b>less leverage</b> \u2014 a smaller loan and more cash down. Gold's rate is the same at every step."
          : "You're at <b>maximum leverage</b> \u2014 the largest loan this deal supports. Drag the slider left to take less leverage and earn a lower rate.";
      }
    } else {
      lv.textContent = pctLbl(row.targetLtcPct) + " LTC";
      if (isGold) {
        hint.innerHTML = "<b>Reduced leverage.</b> At " + pctLbl(row.targetLtcPct) + " LTC the loan is <b>" + YS.fmtUSD(Math.floor(row.totalLoan)) +
          "</b>, cash down " + YS.fmtUSD(Math.floor(row.downPayment)) + ". Gold's rate is unchanged across leverage. Drag right for more.";
      } else {
        var maxRow = rows[0], delta = (maxRow.noteRate - row.noteRate) * 100;
        hint.innerHTML = "<b>Lower leverage, lower rate.</b> At " + pctLbl(row.targetLtcPct) +
          " LTC your rate is <b>" + (row.noteRate * 100).toFixed(2) + "%</b> \u2014 " + delta.toFixed(2) +
          "% below the maximum-leverage rate. Loan " + YS.fmtUSD(Math.floor(row.totalLoan)) +
          ", cash down " + YS.fmtUSD(Math.floor(row.downPayment)) + ". Drag right for more leverage.";
      }
    }
    wrap.style.display = "";
  }

  // Show the offers (cards) by default; reveal a single program's full detail when drilled into.
  function applyProgramView(ready) {
    var stdCard = el("pcardStd"), goldCard = el("pcardGold");
    if (stdCard) stdCard.classList.toggle("pcard-active", chosenProgram === "standard");
    if (goldCard) goldCard.classList.toggle("pcard-active", chosenProgram === "gold");
    var head = el("progDetailHead");
    if (head) head.textContent = (chosenProgram === "gold" ? "Gold Standard Program" : "Standard Program") + " \u2014 full breakdown";
    var lev = el("rLevWrap"); if (lev && !chosenProgram) lev.style.display = "none";   // slider shows for the drilled-in program (Standard or Gold)
    var pdf = el("tsPdf"); if (pdf) pdf.textContent = "Download " + (chosenProgram === "gold" ? "Gold Standard" : "Standard") + " Term Sheet (PDF) \u2913";
    var detail = el("progDetail"); if (detail) detail.style.display = chosenProgram ? "" : "none";
    var mb = el("rManualBanner"); if (mb) mb.hidden = !(manualOn() && chosenProgram);
    var hint = el("progHint"); if (hint) hint.style.display = (ready && !chosenProgram) ? "" : "none";
  }
  function selectProgram(p) {
    if (p === "gold") { var gc = el("pcardGold"); if (gc && gc.classList.contains("pcard-off")) return; }  // not offered here
    chosenProgram = (chosenProgram === p) ? null : p;            // tap the open program again to collapse
    recompute();
    if (chosenProgram) { var dt = el("progDetail"); if (dt && dt.scrollIntoView) { try { dt.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch (e) {} } }
  }

  function tierNudge(d) {
    if (!d || !d.tierLabel || d.status === "INELIGIBLE" || !(d.totalLoan > 0)) return "";
    var inp = d.inp || {}, isGold = !!d.gold, sc = YSP.normStrategy(inp.strategy);
    var count, thresholds, unit;
    if (isGold) {
      if (sc === "NC") { count = num("expGround"); thresholds = [8, 4, 2]; unit = "ground-up"; }
      else { count = num("expFlips") + num("expBrrrr"); thresholds = [10, 5, 2]; unit = "renovation / bridge"; }
    } else {
      count = (sc === "NC") ? num("expGround") : (num("expFlips") + num("expBrrrr") + num("expGround"));
      thresholds = [3, 1, 0]; unit = "completed";
    }
    var tierNum = count >= thresholds[0] ? 1 : count >= thresholds[1] ? 2 : count >= thresholds[2] ? 3 : 0;
    if (tierNum <= 0) return "";
    if (tierNum === 1) return "<strong>Top tier.</strong> You're at the strongest experience tier \u2014 the highest leverage and best pricing this program offers.";
    var need = Math.max(1, thresholds[tierNum - 2] - count);
    return "<strong>You're at Tier " + tierNum + "</strong> \u2014 " + count + " " + unit + " project" + (count === 1 ? "" : "s") + " on file. Just " + need + " more completed project" + (need === 1 ? "" : "s") + " reaches Tier " + (tierNum - 1) + ", with more leverage and a lower rate.";
  }

  /* ---- Admin pricing controls (soft, client-side gate; reveals two fields on the same page) ---- */
  var ADMIN_HASH = 6019969998889003;   // cyrb53("Yscg@12345"). Soft gate only — see note; change = new hash.
  function cyrb53(str, seed) {
    seed = seed >>> 0; var h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (var i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }
  function adminNum(id, dflt) { var e = el(id); if (!e) return dflt; var v = parseFloat(String(e.value).replace(/,/g, "")); return (isFinite(v) && v >= 0) ? v : dflt; }
  // Read the admin markup fields (default 0.5% each; Gold Tier 1 is exempt in-engine) and push into both engines.
  function syncAdminMarkup() {
    var std = adminNum("tsYspStd", CO.markupStd), gold = adminNum("tsYspGold", CO.markupGold);
    try { if (typeof YSP !== "undefined" && YSP.setMarkup) YSP.setMarkup(std / 100); } catch (e) {}
    try { if (typeof GSP !== "undefined" && GSP && GSP.setMarkup) GSP.setMarkup(gold / 100); } catch (e) {}
  }
  // Admin fee/origination overrides. Defaults reproduce current behavior exactly.
  function adminOrigPct(prog) { return adminNum(prog === "gold" ? "tsOrigGold" : "tsOrigStd", prog === "gold" ? CO.origGold : CO.origStd) / 100; }  // fraction
  function adminFeeUW() { return adminNum("tsFeeUW", CO.lender); }
  function adminFeeCredit() { return adminNum("tsFeeCredit", CO.credit); }
  // Company "extra fees" (e.g. the NY settlement-agent fee) that apply to this
  // deal's state (empty state = all files). A real closing cost, so it flows into
  // cash-to-close AND the liquidity to show (owner-directed 2026-07-17).
  function extraFeeList() {
    var st = (val("propState") || "").trim().toUpperCase();
    return (CO.extraFees || []).filter(function (f) { return f && f.name && Number(f.amount) > 0 && (!f.state || String(f.state).toUpperCase() === st); })
      .map(function (f) { return { name: String(f.name), amount: Number(f.amount) }; });
  }
  function extraFeesTotal() { return extraFeeList().reduce(function (a, f) { return a + f.amount; }, 0); }
  function adminFeeAppr() { return adminNum("tsFeeAppr", CO.appraisal); }
  function adminTitle() { var e = el("tsFeeTitle"); var v = e ? parseFloat(String(e.value).replace(/,/g, "")) : NaN; if (isFinite(v) && v >= 0) return v; return CO.title != null ? CO.title : null; }  // per-file field, else company flat, else estimate
  function origPctStr(frac) { var p = Math.round(frac * 100 * 1000) / 1000; return p + "%"; }
  function origPtStr(frac) { var p = Math.round(frac * 100 * 1000) / 1000; return p + (p === 1 ? " pt" : " pts"); }
  function adminNumRaw(id) { var e = el(id); if (!e) return null; var v = parseFloat(String(e.value).replace(/,/g, "")); return (isFinite(v) && v >= 0) ? v : null; }  // null = blank/unset
  // Fill the (blank) admin fee/markup inputs from the company defaults for
  // DISPLAY only. Never overwrite a value already present — a non-blank field is
  // an explicit per-file override (typed by staff or restored by the studio's
  // applyState) and must win. Pricing reads CO for any blank field via adminNum,
  // so the math is already correct before this ever runs.
  function seedAdminDefaults() {
    var s = function (id, v) { var e = el(id); if (e && String(e.value).trim() === "") e.value = v; };
    s("tsYspStd", String(CO.markupStd)); s("tsYspGold", String(CO.markupGold));
    s("tsOrigStd", String(CO.origStd)); s("tsOrigGold", String(CO.origGold));
    s("tsFeeUW", String(CO.lender)); s("tsFeeCredit", String(CO.credit)); s("tsFeeAppr", String(CO.appraisal));
    if (CO.title != null) s("tsFeeTitle", String(CO.title));
  }
  function manualOn() { var e = el("tsManualOn"); return !!(e && e.checked); }
  function wireAdmin() {
    var trig = el("tsAdminTrigger"), lock = el("tsAdminLock"), panel = el("tsAdminPanel"),
        pw = el("tsAdminPw"), go = el("tsAdminGo"), err = el("tsAdminErr"), hide = el("tsAdminHide");
    if (!trig) return;
    function openLock() { if (lock) lock.hidden = false; if (panel) panel.hidden = true; trig.setAttribute("aria-expanded", "true"); if (err) err.hidden = true; if (pw) { pw.value = ""; pw.focus(); } }
    function attempt() {
      if (!pw) return;
      if (cyrb53(pw.value, 0) === ADMIN_HASH) { if (lock) lock.hidden = true; if (panel) panel.hidden = false; trig.hidden = true; if (err) err.hidden = true; pw.value = ""; }
      else { if (err) err.hidden = false; if (pw.select) pw.select(); }
    }
    function setVal(id, v) { var e = el(id); if (e) e.value = v; }
    function manualVis() { var on = manualOn(); var mf = el("tsManualFields"), mh = el("tsManualHint"); if (mf) mf.hidden = !on; if (mh) mh.hidden = !on; }
    function lockDown() {
      if (panel) panel.hidden = true; if (lock) lock.hidden = true; trig.hidden = false; trig.setAttribute("aria-expanded", "false");
      setVal("tsYspStd", String(CO.markupStd)); setVal("tsYspGold", String(CO.markupGold)); setVal("tsOrigStd", String(CO.origStd)); setVal("tsOrigGold", String(CO.origGold));
      setVal("tsFeeUW", String(CO.lender)); setVal("tsFeeCredit", String(CO.credit)); setVal("tsFeeAppr", String(CO.appraisal)); setVal("tsFeeTitle", CO.title != null ? String(CO.title) : "");
      var mo = el("tsManualOn"); if (mo) mo.checked = false;
      setVal("tsMLtv", ""); setVal("tsMArv", ""); setVal("tsMLtc", ""); setVal("tsMRate", ""); setVal("tsMIr", "");
      manualVis();
      recompute();
    }
    trig.addEventListener("click", openLock);
    if (go) go.addEventListener("click", attempt);
    if (pw) pw.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); attempt(); } });
    if (hide) hide.addEventListener("click", lockDown);
    var mOn = el("tsManualOn"); if (mOn) mOn.addEventListener("change", manualVis);   // recompute comes from the form auto-wiring
  }

  function recompute() {
    syncAdminMarkup();
    updateConditionals();
    var miss = missingFields();
    var ready = miss.length === 0;                                // all required fields present
    renderLeverage(ready);                                        // clamp chosenLTC + draw the Standard slider
    var dStd = calc();                                            // Standard, priced at the chosen leverage
    renderPrograms(dStd, ready);                                  // both offer cards + comparison note
    var d = dStd;                                                 // detail renders the program you drilled into
    if (chosenProgram === "gold") { var gd = calcGold(); if (!gd || gd.unavailable) chosenProgram = null; else d = gd; }
    applyProgramView(ready);                                      // show/hide the detail; slider only for Standard
    var sized = ready && d.totalLoan > 0 && d.status !== "INELIGIBLE";
    var EM = "\u2014";

    YS.put("rLoan", sized ? YS.fmtUSD(d.totalLoan) : EM);
    YS.put("rLoan2", sized ? YS.fmtUSD(d.totalLoan) : EM);
    YS.put("rBind", !ready ? "Complete the highlighted fields to see your terms" : (d.status === "INELIGIBLE" ? "See eligibility below" : (d.cityReview ? "Confirm the property location — see below" : (d.totalLoan > 0 ? "Limited by " + d.binding : "Couldn't size a loan from these inputs — see why below"))));
    var nudgeEl = el("tierNudge"); if (nudgeEl) { var nm = ready ? tierNudge(d) : ""; nudgeEl.innerHTML = nm; nudgeEl.style.display = nm ? "" : "none"; }
    // "Purchase price" always shows the REAL price paid (seller + full assignment fee);
    // the capped sizing basis renders on its own "Effective purchase price" line (owner-directed 2026-07-17).
    YS.put("rEff", YS.fmtUSD(isRefi() ? d.basisPrice : (num("price") || d.basisPrice)));
    var rEffLbl = el("rEffLbl"); if (rEffLbl) rEffLbl.textContent = isRefi() ? "As-is value" : "Purchase price";
    var asgCapped = !isRefi() && isAssign() && d.asg && (d.asg.overLimit || d.asg.overridden);
    show($('[data-cond="asgEff"]'), asgCapped);
    if (asgCapped) YS.put("rEffAsg", YS.fmtUSD(d.asg.recognizedPrice));
    // Admin panel: show the live pre-approved effective price + the never-exceed cap.
    var effFld = el("tsEffPrice"), effHint = el("tsEffPriceHint");
    if (effFld) effFld.placeholder = (!isRefi() && isAssign() && d.asg) ? ("auto: " + YS.fmtUSD(d.asg.recognizedPrice)) : "auto";
    if (effHint) effHint.textContent = (!isRefi() && isAssign() && d.asg)
      ? ("Pre-approved effective purchase price: " + YS.fmtUSD(d.asg.recognizedPrice) + (d.asg.overridden ? " (override in effect)" : "") + ". Enter an approved exception figure \u2014 it can never exceed the real purchase price of " + YS.fmtUSD(d.asg.totalPrice) + ". All calculations size off this figure.")
      : "Applies to assignment purchases only \u2014 the effective price equals the purchase price on every other deal.";
    YS.put("rConstr", YS.fmtUSD(d.constr));
    YS.put("rIR", d.financedIR > 0 ? YS.fmtUSD(d.financedIR) : EM);
    YS.put("rCost", YS.fmtUSD(d.totalCost));
    YS.put("rAdvance", sized ? YS.fmtUSD(d.initialAdvance) : EM);
    var advLtvEl = el("rAdvanceLtv"); if (advLtvEl) advLtvEl.textContent = (sized && d.pricingReady && d.ltvPct > 0 && d.initialAdvance > 0) ? (YS.fmtPct(d.ltvPct, 1) + " LTV") : "";
    YS.put("rHoldback", sized ? YS.fmtUSD(d.rehabHoldback) : EM);
    var hbTag = el("rHoldbackTag"); if (hbTag) hbTag.textContent = (d.R && d.R.sizing && d.R.sizing.rehabOverCap) ? "(capped \u2014 see eligibility)" : "(= rehab, in draws)";
    YS.put("rRate", (sized && d.rate > 0) ? d.rate.toFixed(2) + "%" : EM);
    // two interest-only payment lines: initial-advance payment + fully-drawn payment
    YS.put("rPmtInit", (sized && d.initialPayment > 0) ? YS.fmtUSD(d.initialPayment) + "/mo" : EM);
    YS.put("rPmtFull", (sized && d.fullPayment > 0) ? YS.fmtUSD(d.fullPayment) + "/mo" : EM);
    YS.put("rTerm", d.term + " mo");
    YS.put("rLtc", (sized && d.ltcPct) ? YS.fmtPct(d.ltcPct, 1) : EM);
    YS.put("rArv", (sized && d.arvPct) ? YS.fmtPct(d.arvPct, 1) : EM);
    YS.put("rLtv", (sized && d.ltvPct) ? YS.fmtPct(d.ltvPct, 1) : EM);
    YS.put("rDown", sized ? YS.fmtUSD(d.downPayment) : EM);
    YS.put("rOrigLbl", "Origination (" + origPctStr((d.origPct != null ? d.origPct : 0.0125)) + ")");
    YS.put("rOrig", sized ? YS.fmtUSD2(d.origFee) : EM);
    YS.put("rLender", sized ? YS.fmtUSD2(d.lenderFee) : EM);
    YS.put("rCredit", sized ? YS.fmtUSD2(d.creditFee) : EM);
    YS.put("rAppr", sized ? (YS.fmtUSD2(d.apprFee) + " POC") : EM);
    YS.put("rTitle", (sized && d.titleCost > 0) ? YS.fmtUSD2(d.titleCost) : EM);
    (function () { var xf = (sized && d.extraFees) ? d.extraFees : [], w = el("rExtraWrap");
      if (w) { if (xf.length) { w.style.display = ""; var t = xf.reduce(function (a2, f) { return a2 + f.amount; }, 0);
        YS.put("rExtraLbl", xf.length === 1 ? xf[0].name : "Additional fees"); YS.put("rExtra", YS.fmtUSD2(t)); } else { w.style.display = "none"; } } })();
    YS.put("rCash", sized ? YS.fmtUSD2(d.cashToClose) : EM);
    YS.put("rLiquidity", sized ? YS.fmtUSD2(d.liquidity) : EM);
    YS.put("rTier", d.tierLabel || EM);
    YS.put("rFico", d.fico ? String(d.fico) : EM);

    // program max leverage (from FICO + experience) — only once a FICO is in
    var c = d.caps;
    YS.put("rMaxLtc", (ready && c) ? YS.fmtPct(c.maxLTC, c.maxLTC * 100 % 1 ? 1 : 0) : EM);
    YS.put("rMaxLtv", (ready && c) ? YS.fmtPct(c.maxAcqLTV, c.maxAcqLTV * 100 % 1 ? 1 : 0) : EM);
    YS.put("rMaxArv", (ready && c) ? YS.fmtPct(c.maxARLTV, c.maxARLTV * 100 % 1 ? 1 : 0) : EM);
    YS.put("rMaxLoan", (ready && c) ? YS.fmtUSD(c.maxLoan) : EM);

    // assignment note (financeable vs out-of-pocket)
    var an = el("rAssignNote");
    if (an) {
      var seller = num("origPrice"), total = num("price");
      if (!isRefi() && isAssign() && seller > 0 && total > seller) {
        var fee = Math.max(0, total - seller), a = d.asg;
        var capPhrase = (a && a.dollarCap) ? ("the lesser of " + YS.fmtUSD(a.dollarCap) + " or 15% of the original contract price") : "15% of the original contract price";
        if (a && a.overridden) {
          an.style.display = ""; an.className = "ts-assign ok";
          an.innerHTML = "<b>Admin exception in effect.</b> The effective purchase price is set to " + YS.fmtUSD(a.recognizedPrice) +
            " \u2014 " + YS.fmtUSD(a.financeableFee) + " of the " + YS.fmtUSD(a.fee) + " assignment fee is financed" +
            (a.excessOOP > 0.5 ? (", and <b>" + YS.fmtUSD(a.excessOOP) + " is paid out of pocket</b>") : "") +
            ". All terms are sized on the effective purchase price.";
        } else if (a && a.overLimit) {
          an.style.display = ""; an.className = "ts-assign warn";
          an.innerHTML = "<b>Assignment fee exceeds the financeable cap.</b> Up to " + YS.fmtUSD(a.maxFee) + " (" + capPhrase +
            ") is financeable; your fee is " + YS.fmtUSD(fee) + ", so <b>" + YS.fmtUSD(a.excessOOP) +
            " is paid out of pocket</b> and terms are sized on the effective purchase price of " + YS.fmtUSD(a.recognizedPrice) + ". A higher limit can be requested as an exception.";
        } else {
          an.style.display = ""; an.className = "ts-assign ok";
          an.innerHTML = "Assignment fee of " + YS.fmtUSD(fee) + " is within the program cap (" + YS.fmtUSD(a ? a.maxFee : 0.15 * seller) + " max \u2014 " + capPhrase + ") and is fully financeable.";
        }
      } else { an.style.display = "none"; }
    }

    // ---- "what's still missing" checklist box ----
    var mbox = el("rMissing");
    if (mbox) {
      if (!ready) {
        mbox.style.display = "";
        mbox.innerHTML = "<div class=\"tm-h\">To price this scenario and download a term sheet, add:</div><ul class=\"tm-list\">" +
          miss.map(function (m) { return "<li>" + m + "</li>"; }).join("") + "</ul>";
      } else { mbox.style.display = "none"; mbox.innerHTML = ""; }
    }
    // mark the missing inputs so the borrower can see exactly what's needed
    var REQMAP = { "Property state": "propState", "Estimated FICO": "fico", "As-is value": "asIs", "Seller's contract price": "origPrice", "Purchase price": "price", "After-repair value (ARV)": "arv", "Construction / rehab budget": "construction" };
    Object.keys(REQMAP).forEach(function (lbl) { var e = el(REQMAP[lbl]); var w = e && (e.closest ? e.closest(".input") : e.parentNode); if (w) w.classList.toggle("need", miss.indexOf(lbl) > -1); });

    // eligibility banner + reasons
    var badge = el("rStatus");
    if (badge) {
      if (!ready) { badge.textContent = "Add required fields"; badge.className = "verdict"; }
      else { badge.textContent = statusText(d.status); badge.className = "verdict " + statusClass(d.status); }
    }
    var rl = el("rReasons");
    if (rl) {
      rl.innerHTML = "";
      if (!ready) {
        var li0 = document.createElement("li"); li0.className = "reason";
        li0.textContent = "Complete the fields above to see pricing, leverage and your loan amount.";
        rl.appendChild(li0);
      } else if (d.reasons && d.reasons.length) {
        d.reasons.forEach(function (r) {
          var li = document.createElement("li");
          li.className = "reason " + statusClass(r.level);
          li.textContent = r.msg;
          rl.appendChild(li);
        });
      } else {
        var liE = document.createElement("li");
        liE.className = "reason " + statusClass(d.status);
        liE.textContent = d.status === "ELIGIBLE"
          ? "Eligible as entered \u2014 see your structure and terms above."
          : (d.totalLoan > 0 ? "Priced as entered." : "We couldn't size a loan from these inputs. Double-check the purchase price, as-is value, ARV and construction budget \u2014 or use \u201CSubmit for manual review\u201D and our team will take a look.");
        rl.appendChild(liE);
      }
    }

    // ---- state overlay note (only when a limiting state is chosen) ----
    var sn = el("rStateNote");
    if (sn) { var snt = ready ? stateOverlayNote(d) : ""; if (snt) { sn.style.display = ""; sn.textContent = snt; } else { sn.style.display = "none"; sn.textContent = ""; } }

    // ---- manual-review email button (ineligible scenario or pricing problem) ----
    var needsManual = ready && (d.status === "INELIGIBLE" || (d.status === "MANUAL"));
    var mbtn = el("rManualWrap");
    if (mbtn) {
      if (needsManual) {
        mbtn.style.display = "";
        var lead = d.status === "INELIGIBLE"
          ? "This scenario falls outside the standard program as entered."
          : "This scenario needs a manual underwrite.";
        mbtn.innerHTML = "<p class=\"tmv-lead\">" + lead + " You can send it to our team for a manual review.</p>" +
          "<a class=\"btn btn-outline\" id=\"rManualBtn\" href=\"" + manualReviewMailto(d) + "\">Submit for manual review ✉</a>";
      } else { mbtn.style.display = "none"; mbtn.innerHTML = ""; }
    }

    // ---- interest-reserve notes: term cap and/or leverage cap ----
    var irn = el("rIRnote");
    if (irn) {
      var notes = [];
      if (ready && d.R.reserveTermCapped) {
        if (d.R.reserveCapIsConstruction) {
          notes.push("<strong>Construction interest reserve capped at 75% of the full term (" + (Math.round(d.R.reserveTermMonths * 10) / 10) + " months).</strong> You requested " + d.irMonths +
            " months; a construction reserve is financed up to 75% of the term's interest, so it covers " + (Math.round(d.R.reserveTermMonths * 10) / 10) + " months.");
        } else {
          notes.push("<strong>Interest reserve capped at the loan term (" + d.R.reserveTermMonths + " months).</strong> You requested " + d.irMonths +
            " months, but a reserve can't finance more interest than the loan runs \u2014 so it covers " + (Math.round(d.R.reserveTermMonths * 10) / 10) + " months.");
        }
      }
      if (ready && d.reserveCapped && d.maxReserve >= 0) {
        notes.push("<strong>Maximum eligible interest reserve: " + YS.fmtUSD(d.maxReserve) +
          "</strong> (\u2248 " + (d.maxReserveMonths).toFixed(1) + " months). " + d.reserveCapBy +
          " limits the reserve further; the maximum eligible amount has been applied and the remainder isn't eligible to finance.");
      }
      if (notes.length) { irn.style.display = ""; irn.innerHTML = notes.join("<br><br>"); }
      else { irn.style.display = "none"; irn.innerHTML = ""; }
    }
    var resn = el("rResNote");
    if (resn) resn.textContent = d.gold
      ? ("Liquidity to show \u2248 cash to close plus " + Math.round((d.liquidityPct || 0.05) * 100) + "% of the loan amount \u2014 a reserve you demonstrate, not funds brought to closing.")
      : ("Liquidity to show \u2248 cash to close plus " + d.reserveMo + " months of interest \u2014 a reserve you demonstrate, not funds brought to closing.");
    var bn = el("rBindNote");
    if (bn) bn.textContent = (ready && sized && d.binding) ? ("On this deal, " + d.binding + " is the binding limit.") : "";

    // ---- escalation note: deal is eligible and fully priced, but flagged for additional review ----
    var esc = el("rEscNote");
    if (esc) {
      var escs = (d.escalations || []);
      if (ready && sized && escs.length) {
        esc.style.display = "";
        esc.innerHTML = "<strong>Eligible — additional manual review required.</strong> This deal is approved at the pricing and leverage shown; it also needs an escalation review because " + escs.join("; ") + ". This doesn't change eligibility.";
      } else { esc.style.display = "none"; esc.innerHTML = ""; }
    }

    // ---- refinance note: the two refi types and their caps, per program ----
    var rfn = el("rRefiNote");
    if (rfn) {
      if (isRefi()) {
        var payoff = num("payoff");
        var cashOutEst = payoff > 0 ? Math.max(0, d.totalLoan - payoff) : 0;
        var refiTxt = d.gold
          ? "<strong>Refinance types.</strong> A rate-&-term refi takes essentially no cash to you. A cash-out refi \u2014 cash to you over the lesser of $20,000 or 2% of the loan \u2014 is capped by the program leverage or 100% of verified hard costs; cash over $250,000 requires an escalation review."
          : "<strong>Refinance types.</strong> A rate-&-term refi takes no cash to you (proceeds at or under 2% of the loan). A cash-out refi \u2014 proceeds over 2% of the loan \u2014 is capped at $50,000 cash to the borrower.";
        if (payoff > 0) refiTxt += " On this deal, the new loan of " + YS.fmtUSD(d.totalLoan) + " less your " + YS.fmtUSD(payoff) + " payoff \u2248 " + YS.fmtUSD(cashOutEst) + " before closing costs.";
        rfn.style.display = ""; rfn.innerHTML = refiTxt;
      } else { rfn.style.display = "none"; rfn.innerHTML = ""; }
    }

    // ---- gate the term-sheet export until required fields are complete ----
    var pdf = el("tsPdf");
    if (pdf) {
      pdf.disabled = !ready;
      pdf.classList.toggle("is-disabled", !ready);
      pdf.title = ready ? "" : "Add the required fields above to download your term sheet";
    }
    var gate = el("tsExportNote");
    if (gate) { gate.style.display = ready ? "none" : ""; gate.textContent = ready ? "" : "Complete the required fields to enable the download."; }

    try { YS.syncURL(); } catch (e) {}
  }

  function validateAssign() {
    if (!isAssign() || isRefi()) return true;
    var o = num("origPrice"), p = num("price");
    var ae = el("assignErr");
    if (o > 0 && o > p + 1) { if (ae) ae.style.display = "block"; return false; }
    if (ae) ae.style.display = "none";
    return true;
  }

  /* ===================== PDF (branded, signable) ===================== */
  function loadScript(src) { return new Promise(function (res, rej) { var s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
  async function ensurePDF() {
    if (window.jspdf && window.jspdf.jsPDF) return;
    try { await loadScript("https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js"); }
    catch (e) { await loadScript("https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js"); }
    if (!(window.jspdf && window.jspdf.jsPDF)) throw new Error("pdf library failed to load");
  }
  async function ensureXLSX() {
    if (window.XLSX && window.XLSX.utils) return;
    try { await loadScript("https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js"); }
    catch (e) { await loadScript("https://unpkg.com/xlsx-js-style@1.2.0/dist/xlsx.bundle.js"); }
    if (!(window.XLSX && window.XLSX.utils)) throw new Error("spreadsheet library failed to load");
  }
  // Visible deal summary for the Excel export: inputs + both programs' headline results.
  function xlsxSections() {
    var d = calc();
    var gd = calcGold();                                   // full Gold object: slider- + override-connected
    var EM = "\u2014", pct = function (x) { return x ? (x * 100).toFixed(2) + "%" : EM; };
    var statusLabel = function (st) { return st === "ELIGIBLE" ? "Eligible" : st === "MANUAL" ? "Eligible (manual review)" : "Not eligible"; };
    var deal = [
      ["Loan purpose", purpose()], ["Strategy / program", dealType()],
      ["Property state", val("propState") || EM],
      ["Property type", val("propType") === "2-4" ? "2-4 units" : "Single-family"],
      ["Property address", chk("addrTBD") ? "To be determined" : (val("propAddr") || EM)],
      ["Borrower / entity", borrowerOfRecord() || EM]
    ];
    var costs = [
      ["Purchase price", num("price") ? money(num("price")) : EM],
      ["Construction / rehab budget", money(num("construction"))],
      ["As-is value", num("asIs") ? money(num("asIs")) : EM],
      ["After-repair value (ARV)", num("arv") ? money(num("arv")) : EM],
      ["Requested term (months)", String(num("tsTerm") || 12)],
      (num("irAmount") > 0)
        ? ["Interest reserve (amount)", money(num("irAmount"))]
        : ["Interest reserve (months)", String((d.inp && d.inp.irMonths) || num("irMonths") || 0)],
      ["Estimated FICO", num("fico") ? String(num("fico")) : EM],
      ["Experience (flips / holds / ground-up)", num("expFlips") + " / " + num("expBrrrr") + " / " + num("expGround")]
    ];
    if (d.asg && (d.asg.overLimit || d.asg.overridden)) {
      costs.splice(1, 0,
        ["Assignment \u2014 seller's contract price", money(d.asg.sellerPrice)],
        ["Assignment fee", money(d.asg.fee)],
        ["Effective purchase price (used for all sizing)", money(d.asg.recognizedPrice)]);
    }
    var stdExit = d.exitShortfall > 0, stdCity = !!d.cityReview, stdOk = !stdExit && !stdCity && d.pricingReady && d.status !== "INELIGIBLE" && d.totalLoan > 0;
    var std = [
      ["Status", statusLabel(d.status)],
      ["Loan amount", (stdExit || stdCity) ? "Manual review" : (stdOk && d.totalLoan ? money(d.totalLoan) : EM)],
      ["Note rate", (stdOk && d.rate > 0) ? d.rate.toFixed(2) + "%" : EM],
      ["Minimum interest", MIN_INTEREST_ROW],
      ["Initial advance", stdOk ? money(d.initialAdvance) : EM],
      ["Rehab / construction holdback", stdOk ? money(d.rehabHoldback) : EM],
      ["Down payment (equity)", stdOk ? money(d.downPayment) : EM],
      ["Leverage \u2014 LTC / as-is / ARV", stdOk ? (pct(d.ltcPct) + " / " + pct(d.ltvPct) + " / " + pct(d.arvPct)) : EM],
      ["Origination (" + origPctStr((d.origPct != null ? d.origPct : 0.0125)) + ")", (stdOk && d.totalLoan) ? money2(d.origFee) : EM],
      ["UW / processing / legal", stdOk ? money2(d.lenderFee) : EM],
      ["Credit report", stdOk ? money2(d.creditFee) : EM],
      ["Appraisal (est., POC)", stdOk ? money2(d.apprFee) : EM],
      ["Title / escrow (est.)", (stdOk && d.titleCost > 0) ? money2(d.titleCost) : EM],
      ["Estimated cash to close", stdOk ? money2(d.cashToClose) : EM],
      ["Liquidity to show", stdOk ? money2(d.liquidity) : EM]
    ];
    var gold;
    if (!gd || gd.unavailable) { gold = [["Availability", "Not offered in this state"]]; }
    else {
      var gExit = gd.exitShortfall > 0, gOk = !gExit && gd.pricingReady && gd.status !== "INELIGIBLE" && gd.totalLoan > 0;
      gold = [
        ["Status", statusLabel(gd.status)],
        ["Product", (gd.productLabel || EM) + (gd.tierLabel ? " \u00b7 " + gd.tierLabel : "")],
        ["Loan amount", gExit ? "Manual review" : (gOk && gd.totalLoan ? money(gd.totalLoan) : EM)],
        ["Note rate", (gOk && gd.rate > 0) ? gd.rate.toFixed(2) + "%" : EM],
        ["Minimum interest", MIN_INTEREST_ROW],
        ["Initial advance", gOk ? money(gd.initialAdvance) : EM],
        ["Rehab / construction holdback", gOk ? money(gd.rehabHoldback) : EM],
        ["Down payment (equity)", gOk ? money(gd.downPayment) : EM],
        ["Leverage \u2014 LTC / as-is / ARV", gOk ? (pct(gd.ltcPct) + " / " + pct(gd.ltvPct) + " / " + pct(gd.arvPct)) : EM],
        ["Origination (" + origPctStr((gd.origPct != null ? gd.origPct : 0.0125)) + ")", (gOk && gd.totalLoan) ? money2(gd.origFee) : EM],
        ["UW / processing / legal", gOk ? money2(gd.lenderFee) : EM],
        ["Credit report", gOk ? money2(gd.creditFee) : EM],
        ["Appraisal (est., POC)", gOk ? money2(gd.apprFee) : EM],
        ["Title / escrow (est.)", (gOk && gd.titleCost > 0) ? money2(gd.titleCost) : EM],
        ["Estimated cash to close", gOk ? money2(gd.cashToClose) : EM],
        ["Liquidity to show", gOk ? money2(gd.liquidity) : EM]
      ];
    }
    return [{ title: "Deal & property", items: deal }, { title: "Purchase & project costs", items: costs },
            { title: "Standard Program", items: std }, { title: "Gold Standard Program", items: gold }];
  }
  async function exportXlsx(btn) {
    var o = btn ? btn.textContent : ""; if (btn) { btn.textContent = "Exporting\u2026"; btn.disabled = true; }
    try {
      await ensureXLSX(); var X = window.XLSX, INK = "0B1014", TEAL = "1F3A40", aoa = [], merges = [];
      syncAdminMarkup();
      function row(c) { aoa.push(c); }
      function titleRow(text, fill, color, size) {
        row([{ v: text, s: { font: { bold: true, sz: size || 11, color: { rgb: color || "FFFFFF" } }, fill: { fgColor: { rgb: fill } }, alignment: { vertical: "center" } } }, { v: "" }]);
        merges.push({ s: { r: aoa.length - 1, c: 0 }, e: { r: aoa.length - 1, c: 1 } });
      }
      titleRow("YS CAPITAL GROUP  \u2014  TERM SHEET", INK, "FFFFFF", 13);
      titleRow("Generated " + new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) + "   \u00b7   NMLS ID 2609746", INK, "C9A86A", 9);
      row([{ v: "" }, { v: "" }]);
      xlsxSections().forEach(function (sec) {
        titleRow(sec.title.toUpperCase(), TEAL, "FFFFFF", 10);
        sec.items.forEach(function (it) {
          row([{ v: it[0], s: { font: { color: { rgb: "5B6770" }, sz: 10 } } }, { v: it[1] == null ? "" : String(it[1]), s: { font: { bold: true, color: { rgb: "13201C" }, sz: 10 }, alignment: { wrapText: true } } }]);
        });
        row([{ v: "" }, { v: "" }]);
      });
      row([{ v: "Indicative only \u2014 not a commitment to lend. Subject to underwriting, appraisal and final approval.", s: { font: { italic: true, color: { rgb: "5B6770" }, sz: 9 } } }, { v: "" }]);
      var ws = X.utils.aoa_to_sheet(aoa); ws["!cols"] = [{ wch: 32 }, { wch: 54 }]; ws["!merges"] = merges;
      var wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, "Term Sheet");
      var enc = "YSLOAN1\u0001" + JSON.stringify(YS.collectState());
      var chunks = []; for (var p = 0; p < enc.length; p += 30000) chunks.push(enc.slice(p, p + 30000));
      var aoa2 = [["YSLOANSTATE", chunks.length]]; chunks.forEach(function (ch) { aoa2.push([ch]); });
      var ws2 = X.utils.aoa_to_sheet(aoa2); X.utils.book_append_sheet(wb, ws2, "_ys");
      wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 2 }] };
      X.writeFile(wb, fileStem() + ".xlsx");
      flash("Excel exported.");
    } catch (e) { flash("Excel export needs an internet connection (loads the spreadsheet engine)."); }
    finally { if (btn) { btn.textContent = o; btn.disabled = false; } }
  }
  async function importXlsx(input) {
    var file = input && input.files && input.files[0]; if (!file) return;
    try {
      await ensureXLSX(); var X = window.XLSX, buf = await file.arrayBuffer(), wb = X.read(buf, { type: "array" }), st = null;
      if (wb.SheetNames.indexOf("_ys") > -1) {
        var aoa = X.utils.sheet_to_json(wb.Sheets["_ys"], { header: 1 });
        if (aoa[0] && String(aoa[0][0]) === "YSLOANSTATE") {
          var nch = parseInt(aoa[0][1], 10), s = "";
          for (var i = 1; i <= nch && i < aoa.length; i++) s += (aoa[i] && aoa[i][0]) ? aoa[i][0] : "";
          if (s.indexOf("YSLOAN1\u0001") === 0) { try { st = JSON.parse(s.slice(8)); } catch (e) {} }
        }
      }
      if (!st) { flash("That file has no saved YS term-sheet data to import."); return; }
      YS.applyState(st); updateConditionals(); recompute();
      flash("Term sheet imported.");
    } catch (e) { flash("Couldn't read that file \u2014 make sure it's a YS Excel export."); }
    finally { if (input) input.value = ""; }
  }
  function logoData() { try { if (!window.RB_LOGO) return null; return { dataURI: "data:image/png;base64," + window.RB_LOGO.b64, w: window.RB_LOGO.w, h: window.RB_LOGO.h }; } catch (e) { return null; } }
  function pdfSafe(s) { return String(s == null ? "" : s).replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, "-").replace(/\u2022/g, "*").replace(/\u2192/g, "->").replace(/[^\x00-\xFF]/g, ""); }
  function flash(msg) {
    var t = el("ts-toast"); if (!t) { t = document.createElement("div"); t.id = "ts-toast"; t.className = "ys-toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show"); clearTimeout(flash._t); flash._t = setTimeout(function () { t.classList.remove("show"); }, 2800);
  }
  function fileStem() {
    var nm = (borrowerOfRecord() || "Applicant").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Applicant";
    return "YS_Term_Sheet_" + nm + "_" + new Date().toISOString().slice(0, 10);
  }
  function money(n) { return YS.fmtUSD(n); } function money2(n) { return YS.fmtUSD2(n); }

  async function exportPdf(btn, returnBlob) {
    var label = btn ? btn.textContent : ""; if (btn) { btn.textContent = "Building term sheet\u2026"; btn.disabled = true; }
    try {
      await ensurePDF();
      syncAdminMarkup();
      var d = (chosenProgram === "gold") ? (calcGold() || calc()) : calc();
      var progName = (chosenProgram === "gold") ? "Gold Standard Program" : "Standard Program";
      var isBridge = d.inp && YSP.normStrategy(d.inp.strategy) === "BR";   // bridge: as-is only, no rehab/ARV/reserve
      var jsPDF = window.jspdf.jsPDF;
      var doc = new jsPDF({ unit: "pt", format: "letter", orientation: "portrait" });
      var W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 40;
      var INK = [11, 16, 20], TEAL = [31, 58, 64], GOLD = [150, 123, 68], GRAY = [91, 103, 112], DARK = [19, 32, 28], LINE = [228, 224, 214];
      var today = new Date(), exp = new Date(today.getTime() + 14 * 864e5);
      var fmtD = function (dt) { return dt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }); };
      var money = function (n) { return YS.fmtUSD(n); }; var money2 = function (n) { return YS.fmtUSD2(n); };
      var pc = function (x) { return (Math.round(x * 1000) / 10) + "%"; };
      var sized = d.pricingReady && d.totalLoan > 0 && d.status !== "INELIGIBLE";
      var stTxt = d.status === "ELIGIBLE" ? "Eligible" : d.status === "MANUAL" ? "Eligible \u2014 manual underwrite" : "Not eligible as entered";
      var pillC = d.status === "ELIGIBLE" ? [120, 168, 132] : d.status === "MANUAL" ? [176, 140, 70] : [184, 96, 74];

      function header() {
        doc.setFillColor.apply(doc, INK); doc.rect(0, 0, W, 76, "F");
        doc.setFillColor.apply(doc, GOLD); doc.rect(0, 76, W, 2.2, "F");
        var lg = logoData(); if (lg) { var h = 30, w = lg.w * (h / lg.h); try { doc.addImage(lg.dataURI, "PNG", M, 23, w, h); } catch (e) {} }
        doc.setTextColor(243, 239, 230); doc.setFont("times", "bold"); doc.setFontSize(18); doc.text("Preliminary Term Sheet", W - M, 35, { align: "right" });
        doc.setFont("times", "italic"); doc.setFontSize(9.5); doc.setTextColor(201, 168, 106); doc.text(progName + " \u00b7 business-purpose bridge financing", W - M, 51, { align: "right" });
        doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(170, 178, 182);
        doc.text(LENDER.name + " \u00b7 NMLS " + LENDER.nmls + " \u00b7 Issued " + fmtD(today), W - M, 65, { align: "right" });
      }
      function footer() {
        var _ob = window.YSBRAND;
        if (_ob) {
          doc.setFontSize(7.6); doc.setFont("helvetica", "bold"); doc.setTextColor(60, 66, 72);
          var _ph = _ob.direct || _ob.cell || "";
          doc.text(pdfSafe("Your YS Capital contact: " + _ob.name + (_ob.role ? ", " + _ob.role : "") + (_ph ? "  \u00b7  " + _ph : "") + (_ob.email ? "  \u00b7  " + _ob.email : "")), M, H - 40, { maxWidth: W - 2 * M });
        }
        doc.setFontSize(7); doc.setTextColor(150, 158, 162); doc.setFont("helvetica", "normal");
        doc.text(pdfSafe((manualOn() ? "Manually underwritten \u2014 pricing and leverage set by " + LENDER.name + " on a credit-committee basis. " : "") + "Indicative only \u2014 not a commitment or approval to lend. Subject to underwriting, appraisal, title and final credit approval. Not valid until countersigned by " + LENDER.name + "."), M, H - 26, { maxWidth: W - 2 * M });
      }
      function brk(need) { if (y + need > H - 54) { footer(); doc.addPage(); header(); y = 92; } }
      function cardHead(x, w, title, yy) {
        doc.setFillColor.apply(doc, TEAL); doc.roundedRect(x, yy, w, 17, 2.5, 2.5, "F");
        doc.setFont("helvetica", "bold"); doc.setFontSize(8.2); doc.setTextColor(255, 255, 255);
        doc.text(pdfSafe(title.toUpperCase()), x + 7, yy + 11.5); return yy + 23;
      }
      function rowIn(x, w, k, v, yy, opts) {
        opts = opts || {};
        doc.setFont("helvetica", opts.bold ? "bold" : "normal"); doc.setFontSize(opts.bold ? 8.5 : 7.9);
        doc.setTextColor.apply(doc, GRAY); doc.text(pdfSafe(k), x + 2, yy + 8, { maxWidth: w * 0.62 });
        doc.setFont("helvetica", "bold"); doc.setFontSize(opts.bold ? 8.7 : 7.9);
        doc.setTextColor.apply(doc, opts.accent ? GOLD : DARK); doc.text(pdfSafe(String(v)), x + w - 2, yy + 8, { align: "right" });
        yy += 14.4; doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.4); doc.line(x + 2, yy - 3.4, x + w - 2, yy - 3.4); return yy;
      }
      function band(t) { brk(30); doc.setFillColor.apply(doc, TEAL); doc.roundedRect(M, y, W - 2 * M, 17, 2.5, 2.5, "F"); doc.setFont("helvetica", "bold"); doc.setFontSize(8.2); doc.setTextColor(255, 255, 255); doc.text(pdfSafe(t.toUpperCase()), M + 7, y + 11.5); y += 23; }
      function rowFull(k, v, opts) { opts = opts || {}; brk(16); doc.setFont("helvetica", opts.bold ? "bold" : "normal"); doc.setFontSize(8.4); doc.setTextColor.apply(doc, GRAY); doc.text(pdfSafe(k), M + 3, y + 8); doc.setFont("helvetica", "bold"); doc.setFontSize(8.6); doc.setTextColor.apply(doc, opts.accent ? GOLD : DARK); doc.text(pdfSafe(String(v)), W - M - 3, y + 8, { align: "right" }); y += 15; doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.4); doc.line(M + 3, y - 3.5, W - M - 3, y - 3.5); }
      function para(t, size, lead) { var ls = doc.splitTextToSize(pdfSafe(t), W - 2 * M - 6); var lh = lead || (size === 7 ? 9 : 10.5); brk(ls.length * lh + 4); doc.setFont("helvetica", "normal"); doc.setFontSize(size || 8); doc.setTextColor(70, 78, 82); doc.text(ls, M + 3, y + 8); y += ls.length * lh + 6; }

      header();
      var y = 92;
      var who = borrowerOfRecord() || "Prospective Borrower";
      var prog = dealType() + " \u00b7 " + d.inp.loanType + (d.inp.cashOut ? " (cash-out)" : "");
      var where = chk("addrTBD") ? "Property: To be determined" : ("Property: " + (val("propAddr") || "\u2014") + (val("propState") ? ", " + val("propState") : ""));
      doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); doc.setTextColor.apply(doc, DARK); doc.text(pdfSafe(who), M, y);
      doc.setFont("helvetica", "normal"); doc.setFontSize(8.3); doc.setTextColor.apply(doc, GRAY); doc.text(pdfSafe(prog), W - M, y, { align: "right" });
      y += 13; doc.text(pdfSafe(where + "   \u00b7   Valid through " + fmtD(exp)), M, y); y += 14;

      if (needsManualStamp(d)) {
        // Say WHY manual review is needed, right in the banner \u2014 the engine's own MANUAL
        // reason(s), shortened. (Full text still appears in the eligibility snapshot below.)
        var manualWhy = (d.reasons || []).filter(function (r) { return r.level === "MANUAL"; }).map(function (r) { return shortMsg(r.msg); }).filter(Boolean);
        var manualLead = "Manual underwriting is needed" + (manualWhy.length ? ": " + manualWhy.join("  \u00b7  ") + "." : " for this scenario.") +
          " The figures below are indicative and subject to review \u2014 this term sheet is NOT valid without a countersignature from an authorized " + LENDER.name + " representative.";
        doc.setFont("helvetica", "normal"); doc.setFontSize(7.4);
        var manualLines = doc.splitTextToSize(pdfSafe(manualLead), W - 2 * M - 24);
        var manualBoxH = Math.max(25, 16 + manualLines.length * 8.5);
        brk(manualBoxH + 6);
        doc.setFillColor(250, 243, 228); doc.setDrawColor(200, 168, 96); doc.setLineWidth(0.8);
        doc.roundedRect(M, y, W - 2 * M, manualBoxH, 3, 3, "FD");
        doc.setFillColor(176, 140, 70); doc.rect(M, y, 3.5, manualBoxH, "F");
        doc.setFont("helvetica", "bold"); doc.setFontSize(8.6); doc.setTextColor(140, 104, 40);
        doc.text("REVIEW REQUIRED", M + 13, y + 10.5);
        doc.setFont("helvetica", "normal"); doc.setFontSize(7.4); doc.setTextColor(120, 92, 48);
        doc.text(manualLines, M + 13, y + 19.5);
        y += manualBoxH + 8;
      }

      // HERO
      var heroH = 60;
      doc.setFillColor.apply(doc, DARK); doc.roundedRect(M, y, W - 2 * M, heroH, 4, 4, "F");
      doc.setFillColor.apply(doc, GOLD); doc.rect(M, y + 4, 3.5, heroH - 8, "F");
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.8); doc.setTextColor(188, 194, 188); doc.text("ESTIMATED TOTAL LOAN AMOUNT", M + 16, y + 16);
      doc.setFont("times", "bold"); doc.setFontSize(25); doc.setTextColor(247, 244, 236); doc.text(sized ? money(d.totalLoan) : "\u2014", M + 16, y + 40);
      doc.setFont("helvetica", "bold"); doc.setFontSize(8.4); doc.setTextColor.apply(doc, d.pricingReady ? pillC : [150, 156, 150]); doc.text(pdfSafe(d.pricingReady ? stTxt : "Awaiting FICO score"), M + 16, y + 53);
      var rx = W - M - 16;
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(188, 194, 188); doc.text("NOTE RATE (INTEREST-ONLY)", rx, y + 16, { align: "right" });
      doc.setFont("times", "bold"); doc.setFontSize(16); doc.setTextColor(247, 244, 236); doc.text((d.pricingReady && d.rate > 0) ? d.rate.toFixed(2) + "%" : "\u2014", rx, y + 36, { align: "right" });
      doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(188, 194, 188); doc.text(d.term + "-month term \u00b7 " + origPctStr((d.origPct != null ? d.origPct : 0.0125)) + " origination", rx, y + 51, { align: "right" });
      y += heroH + 14;

      // TWO COLUMNS
      var colGap = 16, colW = (W - 2 * M - colGap) / 2, xL = M, xR = M + colW + colGap, yL = y, yR = y;
      yL = cardHead(xL, colW, "Loan structure", yL);
      yL = rowIn(xL, colW, isRefi() ? "As-is value" : "Purchase price", money(isRefi() ? d.basisPrice : (num("price") || d.basisPrice)), yL);
      if (!isRefi() && isAssign()) yL = rowIn(xL, colW, "Seller price / assignment fee", money(num("origPrice")) + " / " + money(Math.max(0, num("price") - num("origPrice"))), yL);
      if (!isRefi() && isAssign() && d.asg && (d.asg.overLimit || d.asg.overridden)) yL = rowIn(xL, colW, "Effective purchase price " + (d.asg.overridden ? "(admin exception)" : "(fee capped at 15%)"), money(d.asg.recognizedPrice), yL);
      if (!isBridge) {
        yL = rowIn(xL, colW, "Construction / rehab budget", money(d.constr), yL);
        if (d.financedIR > 0) { var finMo = (d.fullPayment > 0) ? Math.round(d.financedIR / d.fullPayment) : (d.irMonths || 0); yL = rowIn(xL, colW, "Financed interest reserve (" + finMo + " mo)", money(d.financedIR), yL); }
        yL = rowIn(xL, colW, "Total project cost", money(d.totalCost), yL, { bold: true });
        yL = rowIn(xL, colW, "Initial advance (at closing)", sized ? (money(d.initialAdvance) + (d.ltvPct > 0 ? "   (" + pc(d.ltvPct) + " LTV)" : "")) : "\u2014", yL);
        yL = rowIn(xL, colW, (d.R && d.R.sizing && d.R.sizing.rehabOverCap) ? "Construction holdback (capped \u2014 see eligibility)" : "Construction holdback (= rehab)", sized ? money(d.rehabHoldback) : "\u2014", yL);
      }
      yL = rowIn(xL, colW, isBridge ? "Total loan amount (disbursed at closing)" : "Total loan amount", sized ? money(d.totalLoan) : "\u2014", yL, { bold: true, accent: true });
      yL += 9;
      yL = cardHead(xL, colW, "Payments (interest-only)", yL);
      if (isBridge) {
        yL = rowIn(xL, colW, "Monthly payment", sized ? money(d.fullPayment) + "/mo" : "\u2014", yL, { bold: true });
      } else {
        yL = rowIn(xL, colW, "Initial pmt \u2014 on initial advance", sized ? money(d.initialPayment) + "/mo" : "\u2014", yL);
        yL = rowIn(xL, colW, "Full pmt \u2014 after all draws", sized ? money(d.fullPayment) + "/mo" : "\u2014", yL, { bold: true });
      }
      yL = rowIn(xL, colW, "Loan term", d.term + " months", yL);

      yR = cardHead(xR, colW, "Leverage", yR);
      if (!isBridge) {
        yR = rowIn(xR, colW, "Loan-to-cost (LTC)", sized ? pc(d.ltcPct) : "\u2014", yR);
        yR = rowIn(xR, colW, "Loan-to-ARV", sized ? pc(d.arvPct) : "\u2014", yR);
      }
      yR = rowIn(xR, colW, isBridge ? "Loan-to-value (as-is)" : "As-is (initial advance)", sized ? pc(d.ltvPct) : "\u2014", yR);
      if (d.caps && sized) yR = rowIn(xR, colW, isBridge ? "Program max \u2014 as-is" : "Program max \u2014 LTC / ARV / as-is", isBridge ? pc(d.caps.maxAcqLTV) : (pc(d.caps.maxLTC) + " / " + pc(d.caps.maxARLTV) + " / " + pc(d.caps.maxAcqLTV)), yR);
      yR = rowIn(xR, colW, isBridge ? "As-is value" : "As-is / ARV value", isBridge ? money(d.asIs) : (money(d.asIs) + " / " + money(d.arv)), yR);
      yR += 9;
      yR = cardHead(xR, colW, "Estimated cash to close", yR);
      yR = rowIn(xR, colW, "Origination fee (" + origPctStr((d.origPct != null ? d.origPct : 0.0125)) + ")", sized ? money2(d.origFee) : "\u2014", yR);
      yR = rowIn(xR, colW, "Underwriting / processing / legal", sized ? money2(d.lenderFee) : "\u2014", yR);
      yR = rowIn(xR, colW, "Credit report (avg)", sized ? money2(d.creditFee) : "\u2014", yR);
      yR = rowIn(xR, colW, "Appraisal (est., POC)", sized ? money2(d.apprFee) : "\u2014", yR);
      yR = rowIn(xR, colW, "Title / escrow / settlement (est.)", sized && d.titleCost > 0 ? money2(d.titleCost) : "\u2014", yR);
      if (sized && d.extraFees) d.extraFees.forEach(function (f) { yR = rowIn(xR, colW, f.name, money2(f.amount), yR); });
      if (!isRefi()) yR = rowIn(xR, colW, "Down payment (equity)", sized ? money(d.downPayment) : "\u2014", yR, { bold: true });
      if (d.excessOOP > 0) yR = rowIn(xR, colW, "Assignment over 15% (out of pocket)", money(d.excessOOP), yR);
      yR = rowIn(xR, colW, "Estimated cash to close", sized ? money2(d.cashToClose) : "\u2014", yR, { bold: true, accent: true });
      var liqLbl = d.gold ? ("Liquidity to show (" + Math.round((d.liquidityPct || 0.05) * 100) + "% of loan)") : ("Liquidity to show (" + d.reserveMo + " mo)");
      yR = rowIn(xR, colW, liqLbl, sized ? money2(d.liquidity) : "\u2014", yR);
      y = Math.max(yL, yR) + 4;

      if (d.reserveCapped && d.maxReserve >= 0) {
        band("Interest reserve");
        para("Maximum eligible interest reserve on this deal is " + money(d.maxReserve) + " (\u2248 " + d.maxReserveMonths.toFixed(1) + " months). The requested " + (num("irAmount") > 0 ? money(num("irAmount")) : d.irMonths + " months") + " exceeds what " + d.reserveCapBy + " allows; the maximum eligible amount has been applied and the remainder is not eligible to finance. Interest on any period beyond the reserve is paid as billed.");
      }

      if (!isRefi() && isAssign() && d.asg && (d.asg.overLimit || d.asg.overridden)) {
        band("Assignment");
        var capDesc = d.asg.dollarCap ? ("the financeable cap (lesser of " + money(d.asg.dollarCap) + " or 15% of the " + money(d.asg.sellerPrice) + " original contract price = " + money(d.asg.maxFee) + ")") : ("the program's 15% limit (" + money(d.asg.maxFee) + ", 15% of the " + money(d.asg.sellerPrice) + " original contract price)");
        if (d.asg.overridden) para("An approved exception sets the effective purchase price at " + money(d.asg.recognizedPrice) + ": " + money(d.asg.financeableFee) + " of the " + money(d.asg.fee) + " assignment fee is financed and all terms are sized on the effective purchase price" + (d.asg.excessOOP > 0.5 ? ("; the remaining " + money(d.asg.excessOOP) + " is paid out of pocket at closing") : "") + ".");
        else para("Your assignment fee of " + money(d.asg.fee) + " exceeds " + capDesc + ". " + money(d.asg.financeableFee) + " is financeable and all terms are sized on the effective purchase price of " + money(d.asg.recognizedPrice) + "; the remaining " + money(d.asg.excessOOP) + " is paid out of pocket at closing. A higher assignment limit may be requested as an exception, subject to credit-committee approval.");
      }

      band("How your loan amount is built");
      if (isBridge) {
        para("This is a stabilized bridge loan \u2014 it is sized against the as-is value only. The loan is capped at " + pc(d.caps ? d.caps.maxAcqLTV : 0) + " of the lower of purchase price or as-is value. A bridge has no rehab holdback, no loan-to-cost limit and no after-repair-value limit." + (d.pricingReady && d.binding ? (" On this deal, " + d.binding + " is the binding limit.") : ""));
      } else {
        para("Your maximum loan is the lesser of four program limits \u2014 the most conservative one sets your number. (1) The initial advance is capped at " + pc(d.caps ? d.caps.maxAcqLTV : 0) + " of the lower of purchase price or as-is value. (2) 100% of your rehab budget is financed and released in draws as work is verified \u2014 no rehab comes out of pocket." + ((d.R && d.R.sizing && d.R.sizing.rehabOverCap) ? " (On this deal the program cap limits the holdback below the budget \u2014 see the eligibility notes.)" : "") + " (3) The total loan can't exceed " + pc(d.caps ? d.caps.maxLTC : 0) + " loan-to-cost (purchase + rehab). (4) The total loan can't exceed " + pc(d.caps ? d.caps.maxARLTV : 0) + " of the after-repair value." + (d.pricingReady && d.binding ? (" On this deal, " + d.binding + " is the binding limit.") : ""));
      }

      band("Eligibility snapshot");
      rowFull("Experience tier (as entered)", d.tierLabel || "\u2014");
      rowFull("Estimated FICO", d.fico ? String(d.fico) : "Not provided");
      if (d.pricingReady) d.reasons.forEach(function (r) { para((r.level === "INELIGIBLE" ? "\u2022 Not eligible: " : r.level === "MANUAL" ? "\u2022 Manual underwrite: " : "\u2022 ") + r.msg, 7); });
      else para("\u2022 Add a representative FICO score to finalize pricing, leverage and your loan amount.", 7);

      band("Terms, conditions & disclosures");
      para("1.  Nature of this document.  This Preliminary Term Sheet is an indicative summary of potential financing terms only. It is NOT a loan commitment, approval, pre-approval, rate lock or guarantee to lend, and it creates no obligation on the part of " + LENDER.name + " or the prospective borrower.", 7.5);
      para("2.  Subject to underwriting.  Any financing remains subject to a complete application, satisfactory underwriting, independent appraisal / valuation, title and lien review, insurance, and entity, background and final credit approval. Final pricing, leverage, fees and net proceeds are determined at closing and may differ from the figures shown.", 7.5);
      para("3.  Business purpose only.  This is business / investment-purpose financing secured by non-owner-occupied real property. It is not an offer to extend consumer credit and is not subject to consumer-mortgage (TILA / RESPA) disclosures. A personal guaranty and a first-lien position are required.", 7.5);
      para("4.  Interest, draws & costs.  Interest accrues interest-only on the outstanding loan balance. Rehab funds are advanced by reimbursement draw after inspection, and the borrower carries interest on drawn amounts. The title / escrow figure is a planning estimate based on the state, loan size and transaction type (transfer and mortgage taxes are separate); the settlement agent issues the binding quote at closing.", 7.5);
      var scolW = (W - 2 * M - 30) / 2, sx1 = M, sx2 = M + scolW + 30;
      function sigBlock(x, who2, sub) {
        doc.setDrawColor(120, 128, 132); doc.setLineWidth(0.8); doc.line(x, y + 28, x + scolW, y + 28);
        doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor.apply(doc, DARK); doc.text(pdfSafe(who2), x, y + 41);
        doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor.apply(doc, GRAY); doc.text(pdfSafe(sub), x, y + 51);
        doc.line(x, y + 70, x + scolW - 90, y + 70); doc.text("Date", x, y + 81);
      }
      var coBorrowerName = pdfSafe((val("coBorrowerName") || "").trim());
      if (d.status === "INELIGIBLE") {
        // Not eligible as entered → no signable terms (unprofitable / ineligible deals get no term sheet).
        var inelWhy = (d.reasons || []).filter(function (r) { return r.level === "INELIGIBLE"; }).map(function (r) { return r.msg; }).filter(Boolean);
        para("5.  Eligibility.  As entered, this scenario does not meet the " + progName + " guidelines" + (inelWhy.length ? " \u2014 " + inelWhy.join(" ") : "") + ", so no terms are offered and this document is not signable. Please review the eligibility notes above; a revised scenario can be submitted for manual review.", 7.5);
        brk(70); band("Not eligible \u2014 no terms offered");
        doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor.apply(doc, GRAY);
        doc.text(pdfSafe("Because this scenario is not eligible as entered" + (inelWhy.length ? " (" + shortMsg(inelWhy[0]) + ")" : "") + ", there is no acceptance or signature block. Adjust the inputs above to see whether an eligible structure is available, or submit it to our team for a manual review."), M, y + 15, { maxWidth: W - 2 * M });
        y += 44; footer();
      } else {
        para("5.  Validity & acceptance.  This term sheet is valid through " + fmtD(exp) + (d.inp.state ? (" for a property located in " + d.inp.state) : "") + ". It is not binding unless and until it is accepted in writing by the borrower" + (coBorrowerName ? " and co-borrower" : "") + " below and countersigned by an authorized representative of " + LENDER.name + ".", 7.5);
        brk(coBorrowerName ? 200 : 110); band("Acceptance & signatures"); brk(86);
        // #104: when a borrowing entity is named, the entity is the borrower of
        // record and the individual signs as its authorized signatory / guarantor.
        var _tsEntity = (val("entityName") || "").trim(), _tsIndiv = (val("borrowerName") || "").trim();
        var _primaryName = _tsEntity || _tsIndiv || "Borrower";
        var _primarySub = _tsEntity
          ? (_tsIndiv ? ("Borrower (entity) — by " + _tsIndiv + ", authorized signatory / guarantor") : "Borrower (entity) / authorized signatory")
          : "Borrower / authorized signatory";
        sigBlock(sx1, _primaryName, _primarySub);
        // When the file has TWO borrowers, the term sheet carries a second
        // signature line for the co-borrower (owner-directed #137) side-by-side
        // with the borrower; the lender line drops to the next row.
        if (coBorrowerName) {
          sigBlock(sx2, coBorrowerName, "Co-borrower / authorized signatory");
          y += 92; brk(86);
          sigBlock(sx1, LENDER.name, "Authorized representative \u2014 required to validate");
        } else {
          sigBlock(sx2, LENDER.name, "Authorized representative \u2014 required to validate");
        }
        y += 92; footer();
      }

      // ---------------- FINAL PAGE: leverage / pricing ladder (STANDARD PROGRAM ONLY) ----------------
      // The Gold Standard Program prices a flat rate that does NOT vary by leverage, so there is no
      // per-LTC pricing ladder and this page must never render for Gold.
      // Suppress the ladder on a manual admin exception too — the overridden basis
      // makes every leverage step identical, so the page would print duplicate rows
      // on a signable document (audit #13/#35).
      var ladderOverridden = manualOn() && (adminNumRaw("tsMLtc") != null || adminNumRaw("tsMRate") != null);
      var lad = (!d.gold && !ladderOverridden) ? YSP.priceLadder(gather()) : { eligible: false, rows: [] };
      if (!d.gold && !ladderOverridden && lad.eligible && lad.rows.length) {
        doc.addPage(); header(); y = 92;
        doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.setTextColor.apply(doc, DARK);
        doc.text("Your pricing at every leverage level", M, y); y += 16;
        para("Lower leverage means less risk to the lender \u2014 so it earns a lower rate. The table shows the loan amount, cash to close and note rate at each leverage step this scenario supports. The highlighted row is the option you selected; taking less leverage trades a smaller loan for a better rate.");
        var tW = W - 2 * M;
        var cols = [
          { t: "Leverage (LTC)", w: 0.26, a: "l" },
          { t: "Loan amount", w: 0.20, a: "r" },
          { t: "Cash down", w: 0.18, a: "r" },
          { t: "Payment / mo", w: 0.18, a: "r" },
          { t: "Note rate", w: 0.18, a: "r" }
        ];
        brk(30 + lad.rows.length * 20);
        var hy = y;
        doc.setFillColor.apply(doc, INK); doc.rect(M, hy, tW, 22, "F");
        doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(243, 239, 230);
        var cx = M;
        cols.forEach(function (c) { var w = c.w * tW; doc.text(c.t, c.a === "r" ? cx + w - 7 : cx + 7, hy + 14, { align: c.a === "r" ? "right" : "left" }); cx += w; });
        var ry = hy + 22;
        var selLtc = chosenLTC || lad.rows[0].ltc;
        lad.rows.forEach(function (r, i) {
          var rowH = 20, isSel = Math.abs(r.ltc - selLtc) < 1e-9;
          if (isSel) { doc.setFillColor.apply(doc, GOLD); doc.rect(M, ry, tW, rowH, "F"); }
          else if (i % 2) { doc.setFillColor(244, 242, 236); doc.rect(M, ry, tW, rowH, "F"); }
          doc.setFont("helvetica", isSel ? "bold" : "normal"); doc.setFontSize(8.6);
          doc.setTextColor.apply(doc, isSel ? [28, 24, 16] : DARK);
          var vals = [
            pc(r.targetLtcPct) + (r.isMax ? "  (maximum)" : ""),
            money(Math.floor(r.totalLoan)), money(Math.floor(r.downPayment)), money(Math.floor(r.totalLoan) * (r.noteRate / 12)) + "/mo",
            (r.noteRate * 100).toFixed(2) + "%"
          ];
          var cx2 = M;
          cols.forEach(function (c, ci) { var w = c.w * tW; doc.text(vals[ci], c.a === "r" ? cx2 + w - 7 : cx2 + 7, ry + 13, { align: c.a === "r" ? "right" : "left" }); cx2 += w; });
          doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.3); doc.line(M, ry + rowH, M + tW, ry + rowH);
          ry += rowH;
        });
        y = ry + 10;
        para("Rates shown are the borrower note rate, interest-only, before third-party closing costs. Origination is " + origPctStr(d.origPct != null ? d.origPct : 0.0125) + " of the loan at every level. Final pricing, leverage and proceeds are confirmed at closing and may differ.", 7.5);
        footer();
      }

      if (d && (d.pricingReady || d.totalLoan > 0 || (borrowerOfRecord() || "").trim())) drawDerivationPage(doc, d, "Inputs & Loan Derivation", "This term sheet was generated from the inputs below, entered through the YS Capital Term Sheet Studio. This page records exactly what was provided and how the loan amount and leverage were determined.");
      // #99: when asked for a blob (the "email to my officer" path) return the PDF
      // bytes to attach server-side instead of downloading it.
      if (returnBlob) { if (btn) { btn.textContent = label; btn.disabled = false; } return doc.output("blob"); }
      doc.save(fileStem() + ".pdf");
      flash("Term sheet downloaded.");
    } catch (e) {
      flash("Term sheet export needs an internet connection (loads the PDF engine).");
    } finally { if (btn) { btn.textContent = label; btn.disabled = false; } }
  }
  function pctp(x) { return (Math.round(x * 1000) / 10) + "%"; }

  function prettyStrategy(s) {
    var n = YSP.normStrategy(s), low = String(s || "").toLowerCase();
    return n === "BR" ? "Bridge / stabilized" : n === "NC" ? "Ground-up construction"
      : (low.indexOf("hold") > -1 || low.indexOf("brrrr") > -1 ? "Fix & hold" : "Fix & flip");
  }
  function leverageLine(d, isBridge) {
    var parts = [];
    if (d.caps) {
      if (isBridge) { if (d.caps.maxAcqLTV) parts.push("up to " + pctp(d.caps.maxAcqLTV) + " of value"); }
      else {
        if (d.caps.maxLTC && d.caps.maxLTC < 1) parts.push("up to " + pctp(d.caps.maxLTC) + " of cost");
        if (d.caps.maxARLTV && d.caps.maxARLTV < 1) parts.push(pctp(d.caps.maxARLTV) + " of ARV");
      }
    }
    return parts.length ? parts.join(" \u00b7 ") : "Per program guidelines";
  }

  // ============ Proof of Funds / Pre-Qualification letter (bank-grade, one page) ============
  async function exportLetter(btn) {
    var label = btn ? btn.textContent : "";
    var borrower0 = (borrowerOfRecord() || "").trim();
    if (!borrower0) { flash("Enter the borrowing entity or borrower name to generate the letter."); var bn = el("entityName") || el("borrowerName"); if (bn) { bn.focus(); bn.classList.add("field-flag"); setTimeout(function(){ bn.classList.remove("field-flag"); }, 2400); } return; }
    if (btn) { btn.textContent = "Building letter\u2026"; btn.disabled = true; }
    try {
      await ensurePDF();
      syncAdminMarkup();
      var d = (chosenProgram === "gold") ? (calcGold() || calc()) : calc();
      if (!d || d.status === "INELIGIBLE" || d.exitShortfall > 0 || d.cityReview || !(d.totalLoan > 0)) {
        flash("This scenario isn't eligible as entered \u2014 adjust the deal to issue a proof-of-funds letter.");
        if (btn) { btn.textContent = label; btn.disabled = false; } return;
      }
      var progName = (chosenProgram === "gold") ? "Gold Standard Program" : "Standard Program";
      var isRefiTxn = (d.inp && d.inp.loanType === "Refinance");
      var isBridge = d.inp && YSP.normStrategy(d.inp.strategy) === "BR";
      var jsPDF = window.jspdf.jsPDF;
      var doc = new jsPDF({ unit: "pt", format: "letter", orientation: "portrait" });
      var W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 54;
      var INK = [11, 16, 20], TEAL = [31, 58, 64], GOLD = [150, 123, 68], GRAY = [95, 103, 110], DARK = [19, 32, 28], LINE = [223, 219, 209], SOFT = [247, 245, 239], BODY = [40, 46, 52];
      var today = new Date(), exp = new Date(today.getTime() + 30 * 864e5);
      var fmtD = function (dt) { return dt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }); };
      var money = function (n) { return YS.fmtUSD(Math.round(n || 0)); }; var money2 = function (n) { return YS.fmtUSD2(n || 0); };
      var borrower = borrower0;
      var tbd = chk("addrTBD"), addr = tbd ? "" : (val("propAddr") || "").trim(), st = (val("propState") || (d.inp && d.inp.state) || "").trim();
      var propLine = tbd ? "A residential investment property to be identified"
        : (addr ? (addr + (st ? ", " + st : "")) : (st ? ("A residential investment property in " + st) : "A residential investment property to be identified"));
      // The letter states the REAL purchase price (seller + full assignment fee) — the
      // capped effective basis stays internal to sizing (owner-directed 2026-07-17).
      var price = isRefiTxn ? (d.basisPrice || 0) : (num("price") || d.basisPrice || d.eff || 0);
      var stratWord = isBridge ? "acquisition" : (YSP.normStrategy(d.inp.strategy) === "NC" ? "acquisition and ground-up construction" : "acquisition and renovation");
      function refNo() {
        var y = today.getFullYear(), m = ("0" + (today.getMonth() + 1)).slice(-2), dd = ("0" + today.getDate()).slice(-2);
        var seed = Math.abs((Math.round(d.totalLoan || 0) * 31 + borrower.length * 17 + (st.charCodeAt(0) || 7)) % 10000);
        return "YSC-POF-" + y + m + dd + "-" + ("000" + seed).slice(-4);
      }

      // ---- letterhead ----
      doc.setFillColor.apply(doc, INK); doc.rect(0, 0, W, 92, "F");
      doc.setFillColor.apply(doc, GOLD); doc.rect(0, 92, W, 2.4, "F");
      var lg = logoData(); if (lg) { var h = 34, w = lg.w * (h / lg.h); try { doc.addImage(lg.dataURI, "PNG", M, 30, w, h); } catch (e) {} }
      doc.setTextColor(243, 239, 230); doc.setFont("times", "bold"); doc.setFontSize(11.5);
      doc.text("PRIVATE MORTGAGE BANKING", W - M, 41, { align: "right" });
      doc.setFont("times", "italic"); doc.setFontSize(9); doc.setTextColor(201, 168, 106);
      doc.text("Business-purpose real estate finance", W - M, 56, { align: "right" });
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(178, 185, 190);
      doc.text("NMLS " + LENDER.nmls + "   \u00b7   " + LENDER.phone + "   \u00b7   " + LENDER.email, W - M, 73, { align: "right" });

      var y = 126;
      doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor.apply(doc, DARK);
      doc.text(fmtD(today), W - M, y, { align: "right" });
      doc.setFontSize(8); doc.setTextColor.apply(doc, GRAY);
      doc.text("Reference: " + refNo(), W - M, y + 12, { align: "right" });

      y += 34;
      doc.setFont("times", "bold"); doc.setFontSize(13); doc.setTextColor.apply(doc, INK);
      doc.text("Proof of Funds & Pre-Qualification", M, y);
      doc.setDrawColor.apply(doc, GOLD); doc.setLineWidth(1.3); doc.line(M, y + 6, M + 182, y + 6);

      y += 26;
      function para(text, size, lead) {
        size = size || 9.6; lead = lead || (size + 3.9);
        doc.setFont("helvetica", "normal"); doc.setFontSize(size); doc.setTextColor.apply(doc, BODY);
        var lines = doc.splitTextToSize(pdfSafe(text), W - 2 * M);
        for (var i = 0; i < lines.length; i++) { doc.text(lines[i], M, y); y += lead; }
      }
      doc.setFont("helvetica", "normal"); doc.setFontSize(9.8); doc.setTextColor.apply(doc, BODY);
      doc.text("To Whom It May Concern:", M, y); y += 19;

      para(LENDER.name + " has reviewed the profile of " + borrower + " and the proposed transaction described below and is prepared to provide business-purpose mortgage financing of up to " + money(d.totalLoan) + " toward the " + stratWord + " of the referenced residential investment property, subject to the summary terms below and to " + LENDER.name + "'s customary underwriting.", 9.8);
      y += 3;
      para("For the purpose of evaluating an offer, " + borrower + " should be regarded as a ready, willing and able buyer whose financing is the functional equivalent of a cash offer. " + LENDER.name + " routinely closes qualified transactions in as few as ten (10) business days.", 9.8);

      // ---- terms summary box ----
      y += 9;
      var boxX = M, boxW = W - 2 * M, rowH = 17, headH = 20;
      var rows = [
        ["Borrower / entity", borrower],
        ["Property", propLine],
        ["Financing program", progName],
        ["Prepared to finance up to", money(d.totalLoan)],
        ["Transaction", (isRefiTxn ? "Refinance" : "Purchase") + "  \u00b7  " + prettyStrategy(d.inp.strategy)],
        [isRefiTxn ? "Estimated as-is value" : "Estimated purchase price", money(price)],
        ["Maximum leverage", leverageLine(d, isBridge)],
        ["Indicative term", (d.term || 12) + " months, interest-only"]
      ];
      var boxH = headH + rows.length * rowH + 8;
      doc.setFillColor.apply(doc, SOFT); doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.9);
      doc.roundedRect(boxX, y, boxW, boxH, 4, 4, "FD");
      doc.setFillColor.apply(doc, TEAL); doc.roundedRect(boxX, y, boxW, headH, 4, 4, "F"); doc.rect(boxX, y + 12, boxW, headH - 12, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(8.3); doc.setTextColor(255, 255, 255);
      doc.text("SUMMARY OF INDICATIVE TERMS", boxX + 13, y + 13.5);
      var yy = y + headH + 15;
      for (var r = 0; r < rows.length; r++) {
        doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor.apply(doc, GRAY);
        doc.text(pdfSafe(rows[r][0]), boxX + 13, yy);
        doc.setFont("helvetica", "bold"); doc.setTextColor.apply(doc, DARK);
        var vlines = doc.splitTextToSize(pdfSafe(rows[r][1]), boxW - 26 - 200);
        doc.text(vlines[0] || "", boxX + boxW - 13, yy, { align: "right" });
        if (r < rows.length - 1) { doc.setDrawColor(231, 228, 219); doc.setLineWidth(0.5); doc.line(boxX + 13, yy + 5.5, boxX + boxW - 13, yy + 5.5); }
        yy += rowH;
      }
      y = y + boxH + 20;

      para("This letter constitutes proof of funds and a pre-qualification only. It is not a loan commitment, approval, rate lock or guarantee to lend, and it creates no obligation on the part of " + LENDER.name + ". Any financing remains subject to a complete application, satisfactory underwriting, an independent appraisal or valuation, clear title and an acceptable first-lien position, insurance, and entity, background and final credit approval. This financing is for business and investment purposes only, secured by non-owner-occupied real property; a personal guaranty is required.", 8.6, 12.4);
      y += 3;
      para("This letter is valid for thirty (30) days from the date of issuance, through " + fmtD(exp) + ". To verify this letter or confirm the borrower's current standing, please contact the undersigned directly.", 8.6, 12.4);

      // ---- signature ----
      y += 16;
      doc.setFont("helvetica", "normal"); doc.setFontSize(9.8); doc.setTextColor.apply(doc, BODY);
      doc.text("Sincerely,", M, y); y += 38;
      doc.setDrawColor(120, 128, 132); doc.setLineWidth(0.9); doc.line(M, y, M + 228, y);
      doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); doc.setTextColor.apply(doc, DARK);
      var _obL = window.YSBRAND;
      doc.text(pdfSafe(_obL ? _obL.name : "Authorized Representative"), M, y + 14);
      doc.setFont("helvetica", "normal"); doc.setFontSize(8.3); doc.setTextColor.apply(doc, GRAY);
      if (_obL) {
        var _phL = _obL.direct || _obL.cell || "";
        doc.text(pdfSafe((_obL.role ? _obL.role + "   \u00b7   " : "") + LENDER.name + "   \u00b7   NMLS " + LENDER.nmls), M, y + 26);
        doc.text(pdfSafe((_phL ? _phL + "   \u00b7   " : "") + _obL.email), M, y + 37);
      } else {
        doc.text(LENDER.name + "   \u00b7   NMLS " + LENDER.nmls, M, y + 26);
        doc.text(LENDER.phone + "   \u00b7   " + LENDER.email, M, y + 37);
      }

      // ---- footer ----
      doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.8); doc.line(M, H - 48, W - M, H - 48);
      doc.setFont("helvetica", "normal"); doc.setFontSize(6.8); doc.setTextColor(150, 158, 162);
      doc.text(pdfSafe(MIN_INTEREST_DETAIL + " " + LENDER.name + " \u00b7 NMLS " + LENDER.nmls + " \u00b7 Business-purpose lending only. This document is proof of funds / pre-qualification and is not a commitment to lend or an offer to extend consumer credit. Figures are indicative and subject to full underwriting, appraisal, title and final credit approval."), M, H - 36, { maxWidth: W - 2 * M });

      drawDerivationPage(doc, d, "Basis for This Proof of Funds", "The figures in the preceding letter were generated from the inputs below, provided by the applicant through the YS Capital Term Sheet Studio. This page shows what was entered and how the financing amount was determined.");
      doc.save("YS-Capital-Proof-of-Funds-" + borrower.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") + ".pdf");
      flash("Proof-of-funds letter downloaded.");
    } catch (e) {
      flash("Letter export needs an internet connection (loads the PDF engine).");
    } finally { if (btn) { btn.textContent = label; btn.disabled = false; } }
  }

  // ---- soft lead capture on the happy path ----
  function leadMailto(s) {
    var subj = "Term sheet request \u2014 " + (s.borrower || s.program);
    var L = ["New term sheet request from the Term Sheet Studio:", "",
      "Borrower / entity: " + (s.borrower || "(not provided)"),
      "Reply-to: " + s.email, "Program: " + s.program,
      "Property: " + (s.property || "TBD") + (s.state ? ", " + s.state : ""),
      "Loan amount: " + (s.loanAmount ? YS.fmtUSD(s.loanAmount) : "\u2014"),
      "Note rate: " + (s.rate ? s.rate.toFixed(2) + "%" : "\u2014"),
      "Term: " + (s.term ? s.term + " months" : "\u2014"),
      "Eligibility: " + (s.status || "\u2014"), "", "Please send the full term sheet and follow up."];
    return "mailto:" + LENDER.email + "?subject=" + encodeURIComponent(subj) + "&body=" + encodeURIComponent(L.join("\n"));
  }
  function blobToB64(blob) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { var s = String(r.result); res(s.slice(s.indexOf(",") + 1)); }; r.onerror = rej; r.readAsDataURL(blob); }); }
  function leadBody(s) {
    return ["New term sheet request from the Term Sheet Studio:", "",
      "Borrower / entity: " + (s.borrower || "(not provided)"),
      "Reply-to: " + s.email, "Program: " + s.program,
      "Property: " + (s.property || "TBD") + (s.state ? ", " + s.state : ""),
      "Loan amount: " + (s.loanAmount ? YS.fmtUSD(s.loanAmount) : "\u2014"),
      "Note rate: " + (s.rate ? s.rate.toFixed(2) + "%" : "\u2014"),
      "Term: " + (s.term ? s.term + " months" : "\u2014"),
      "Eligibility: " + (s.status || "\u2014"), "", "The term sheet PDF is attached. Please follow up."].join("\n");
  }
  // #99: send the term sheet straight to the branded officer SERVER-SIDE (a real
  // branded email with the PDF attached) \u2014 no .eml the visitor has to open. Falls
  // back to the mailto draft only if the backend send fails / is offline.
  async function sendTermSheetToOfficer(summary) {
    var ob = window.YSBRAND || {};
    var code = ob.email ? String(ob.email).split("@")[0].toLowerCase().replace(/[^a-z0-9._-]/g, "") : "";
    var atts = [];
    try { var blob = await exportPdf(null, true); if (blob) atts.push({ filename: fileStem() + ".pdf", contentType: "application/pdf", dataBase64: await blobToB64(blob) }); } catch (e) { /* send without the attachment if the PDF engine failed */ }
    var r = await fetch("/api/leads", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "term_sheet", officerCode: code || undefined, name: summary.borrower || undefined, email: summary.email,
        subject: "Term sheet request \u2014 " + (summary.borrower || summary.program), message: leadBody(summary),
        attachments: atts, payload: summary }) });
    if (!r.ok) throw new Error("send " + r.status);
    return r.json();
  }
  function captureLead(btn) {
    var f = el("leadEmail"), note = el("leadNote");
    var email = (f ? f.value : "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (note) { note.textContent = "Please enter a valid email so we can send your term sheet."; note.style.color = "#b8604a"; }
      if (f) { f.focus(); f.classList.add("field-flag"); setTimeout(function () { f.classList.remove("field-flag"); }, 2400); }
      return;
    }
    // Same issue-policy gate as the download button (audit #56): never email a PDF
    // the screen didn't show, and never a term sheet for an ineligible/unsizeable deal.
    if (!readyToPrice()) { if (note) { note.textContent = "Add the required fields (state, FICO, price and ARV) first so we can prepare your term sheet."; note.style.color = "#b8604a"; } return; }
    if (!canIssue(issueDeal())) { if (note) { note.textContent = "This scenario isn't eligible as entered \u2014 submit it for manual review and our team will follow up."; note.style.color = "#b8604a"; } return; }
    var d = (chosenProgram === "gold") ? (calcGold() || calc()) : calc();
    var summary = {
      email: email, borrower: (borrowerOfRecord() || "").trim(),
      program: (chosenProgram === "gold") ? "Gold Standard Program" : "Standard Program",
      state: val("propState") || "", property: chk("addrTBD") ? "TBD" : (val("propAddr") || ""),
      loanAmount: (d && d.totalLoan) || 0, rate: (d && d.pricingReady && d.rate) ? d.rate : null,
      term: (d && d.term) || "", status: (d && d.status) || ""
    };
    if (btn) { btn.textContent = "Sending\u2026"; btn.disabled = true; }
    sendTermSheetToOfficer(summary).then(function () {
      if (note) { note.textContent = "Thanks \u2014 your term sheet is on its way to your YS Capital officer, who will follow up shortly."; note.style.color = ""; }
      if (btn) { btn.textContent = "Sent \u2713"; setTimeout(function () { btn.textContent = "Send it \u2192"; btn.disabled = false; }, 3200); }
    }).catch(function () {
      var sent = false;
      if (typeof window.YS_CAPTURE_LEAD === "function") { try { window.YS_CAPTURE_LEAD(summary); sent = true; } catch (e) {} }
      if (!sent) { try { window.location.href = leadMailto(summary); } catch (e) {} }
      if (note) { note.textContent = "Thanks \u2014 a YS Capital specialist will email your term sheet and follow up shortly."; note.style.color = ""; }
      if (btn) { btn.textContent = "Sent \u2713"; setTimeout(function () { btn.textContent = "Send it \u2192"; btn.disabled = false; }, 3200); }
    });
  }

  // ---- shared "inputs & how the loan was sized" page (POF page 2 + term sheet appendix) ----
  function drawDerivationPage(doc, d, title, intro) {
    doc.addPage();
    var W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 56;
    var INK = [11, 16, 20], TEAL = [31, 58, 64], GOLD = [150, 123, 68], GRAY = [95, 103, 110], DARK = [19, 32, 28], LINE = [223, 219, 209], BODY = [40, 46, 52];
    var money = function (n) { return YS.fmtUSD(Math.round(n || 0)); }; var money2 = function (n) { return YS.fmtUSD2(n || 0); };
    var pc = function (x) { return (Math.round((x || 0) * 1000) / 10) + "%"; };
    var inp = d.inp || {}, isRefi = inp.loanType === "Refinance";
    var sc = YSP.normStrategy(inp.strategy), isBridge = sc === "BR", hasRehab = num("construction") > 0 || sc === "NC" || sc === "FF";

    // header
    doc.setFillColor.apply(doc, INK); doc.rect(0, 0, W, 66, "F");
    doc.setFillColor.apply(doc, GOLD); doc.rect(0, 66, W, 2, "F");
    var lg = logoData(); if (lg) { var h = 27, w = lg.w * (h / lg.h); try { doc.addImage(lg.dataURI, "PNG", M, 20, w, h); } catch (e) {} }
    doc.setTextColor(243, 239, 230); doc.setFont("times", "bold"); doc.setFontSize(11.5);
    doc.text(pdfSafe(title), W - M, 33, { align: "right" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(178, 185, 190);
    doc.text(LENDER.name + "  \u00b7  NMLS " + LENDER.nmls, W - M, 48, { align: "right" });

    var y = 92;
    if (intro) {
      doc.setFont("helvetica", "italic"); doc.setFontSize(8.6); doc.setTextColor.apply(doc, GRAY);
      var il = doc.splitTextToSize(pdfSafe(intro), W - 2 * M);
      for (var i = 0; i < il.length; i++) { doc.text(il[i], M, y); y += 12; } y += 8;
    }
    function section(label, rows) {
      doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor.apply(doc, TEAL);
      doc.text(pdfSafe(label.toUpperCase()), M, y);
      doc.setDrawColor.apply(doc, GOLD); doc.setLineWidth(1.1); doc.line(M, y + 4, M + 26, y + 4);
      y += 16;
      for (var r = 0; r < rows.length; r++) {
        if (!rows[r]) continue;
        var kind = rows[r][2] || "", isTot = kind === "tot", isSub = kind === "sub";
        if (isTot) { doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.7); doc.line(M, y - 9, W - M, y - 9); }
        doc.setFont("helvetica", isTot ? "bold" : "normal"); doc.setFontSize(isSub ? 8 : 8.9); doc.setTextColor.apply(doc, isSub ? GRAY : (isTot ? DARK : BODY));
        doc.text(pdfSafe(rows[r][0]), M + (isSub ? 12 : 0), y);
        doc.setFont("helvetica", "bold"); doc.setFontSize(isSub ? 8 : 8.9); doc.setTextColor.apply(doc, isTot ? TEAL : DARK);
        var vlines = doc.splitTextToSize(pdfSafe(rows[r][1]), (W - 2 * M) * 0.56);
        doc.text(vlines[0] || "", W - M, y, { align: "right" });
        y += isSub ? 12.5 : 14.5;
      }
      y += 9;
    }

    var borrower = (borrowerOfRecord() || "").trim() || "Not provided";
    var ficoV = num("fico") > 0 ? String(num("fico")) : "\u2014";
    var expBits = [];
    if (num("expFlips") > 0) expBits.push(num("expFlips") + " fix & flip");
    if (num("expBrrrr") > 0) expBits.push(num("expBrrrr") + " BRRRR/stabilized");
    if (num("expGround") > 0) expBits.push(num("expGround") + " ground-up");
    if (num("expRentals") > 0) expBits.push(num("expRentals") + " rentals owned");

    // #104: the "all inputs on the last page" summary lists the borrowing entity,
    // the individual borrower and any co-borrower as SEPARATE rows.
    var _dpEntity = (val("entityName") || "").trim(), _dpIndiv = (val("borrowerName") || "").trim(), _dpCo = (val("coBorrowerName") || "").trim();
    section("Borrower & credit (as entered)", [
      _dpEntity ? ["Borrowing entity", _dpEntity] : null,
      [_dpEntity ? "Borrower (individual)" : "Borrower / entity", _dpEntity ? (_dpIndiv || "\u2014") : (borrower)],
      _dpCo ? ["Co-borrower", _dpCo] : null,
      ["Credit score used", ficoV],
      d.tierLabel ? ["Experience tier", d.tierLabel] : null,
      ["Experience entered", expBits.length ? expBits.join("  \u00b7  ") : "None entered"]
    ]);

    var propRow = chk("addrTBD") ? "To be determined" : ((val("propAddr") || "\u2014") + (val("propState") ? "" : ""));
    var assignOn = !!d.asg;   // only what actually priced (audit #48)
    section("Property & project (as entered)", [
      ["Property", propRow],
      ["State", val("propState") || inp.state || "\u2014"],
      ["Loan purpose", (isRefi ? "Refinance" : "Purchase") + (inp.cashOut ? " (cash-out)" : "")],
      ["Strategy", prettyStrategy(inp.strategy)],
      [isRefi ? "As-is value entered" : "Purchase price entered", money(isRefi ? num("asIs") : num("price"))],
      assignOn ? ["Assignment \u2014 seller's contract price", money(num("origPrice"))] : null,
      assignOn ? ["Assignment fee", money(num("assignFee"))] : null,
      (assignOn && d.asg && d.asg.overLimit) ? ["Effective purchase price \u2014 fee counted up to 15% of the seller's price", money(d.asg.recognizedPrice)] : null,
      (!isRefi && num("asIs") > 0) ? ["As-is value entered", money(num("asIs"))] : null,
      num("arv") > 0 ? ["After-repair value (ARV)", money(num("arv"))] : null,
      num("construction") > 0 ? ["Construction / rehab budget", money(num("construction"))] : null,
      ["Requested term", (inp.term || 12) + " months"],
      (inp.irAmount > 0)
        ? ["Requested interest reserve", money(inp.irAmount)]
        : (inp.irMonths > 0) ? ["Requested interest reserve", inp.irMonths + " months"] : null
    ]);

    // derivation
    var derivRows = [];
    if (isBridge || !hasRehab) {
      derivRows.push(["Basis (as-is value)", money(d.basisPrice)]);
      derivRows.push(["Loan advanced", money(d.totalLoan), "tot"]);
    } else {
      derivRows.push(["Cost basis \u2014 " + ((d.asg && (d.asg.overLimit || d.asg.overridden)) ? "effective purchase price" : "price / as-is basis"), money(d.basisPrice)]);
      derivRows.push(["Initial advance at closing", money(d.initialAdvance)]);
      derivRows.push(["= " + pc(d.ltvPct) + " of as-is value (initial LTV)", "", "sub"]);
      if (d.rehabHoldback > 0) derivRows.push(["Construction holdback \u2014 " + ((d.R && d.R.sizing && d.R.sizing.rehabOverCap) ? "capped below the budget" : "100% of budget"), money(d.rehabHoldback)]);
      if (d.financedIR > 0) { var fm = (d.fullPayment > 0) ? Math.round(d.financedIR / d.fullPayment) : (inp.irMonths || 0); derivRows.push(["Financed interest reserve (" + fm + " mo)", money(d.financedIR)]); }
      derivRows.push(["Total loan amount", money(d.totalLoan), "tot"]);
    }
    section("How the loan amount was determined", derivRows);

    section("Resulting leverage & pricing", [
      (d.ltcPct > 0 && !isBridge) ? ["Loan-to-cost (LTC)", pc(d.ltcPct)] : null,
      ["Initial / as-is LTV", pc(d.ltvPct)],
      (d.arvPct > 0) ? ["Loan-to-ARV", pc(d.arvPct)] : null,
      ["Note rate (interest-only)", (d.rate > 0 ? d.rate.toFixed(2) + "%" : "\u2014")],
      ["Minimum interest", MIN_INTEREST_ROW],
      ["Origination", origPctStr(d.origPct != null ? d.origPct : 0.0125) + " of loan"]
    ]);

    // footer
    doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.8); doc.line(M, H - 46, W - M, H - 46);
    doc.setFont("helvetica", "normal"); doc.setFontSize(6.8); doc.setTextColor(150, 158, 162);
    doc.text(pdfSafe(MIN_INTEREST_DETAIL + " Figures are indicative, derived from the inputs above, and subject to full underwriting, appraisal/valuation, title and final credit approval. " + LENDER.name + " \u00b7 NMLS " + LENDER.nmls + "."), M, H - 34, { maxWidth: W - 2 * M });
  }

  /* ===================== wiring ===================== */
  // #143 — the DOLLAR inputs show a nice comma-grouped accounting figure. This is
  // DISPLAY only and frozen-safe: YS.num() strips commas before parsing, so the
  // number the engine reads is byte-identical. Whole-dollar fields (no cents are
  // entered), so digit-grouping is all that's needed. Count/percent/FICO/term
  // inputs are deliberately excluded — they aren't dollar amounts.
  var MONEY_IDS = ["price", "origPrice", "assignFee", "construction", "asIs", "arv",
    "payoff", "irAmount", "tsFeeUW", "tsFeeCredit", "tsFeeTitle", "tsFeeAppr", "tsEffPrice"];
  function isMoneyInput(inp) { return inp && inp.id && MONEY_IDS.indexOf(inp.id) !== -1; }
  function groupDigits(s) {
    var d = String(s == null ? "" : s).replace(/[^\d]/g, "");
    return d ? Number(d).toLocaleString("en-US") : "";
  }
  // Cursor-preserving format for the field currently being typed in.
  function formatMoneyField(inp) {
    var caret = inp.selectionStart == null ? inp.value.length : inp.selectionStart;
    var digitsBefore = inp.value.slice(0, caret).replace(/[^\d]/g, "").length;
    var out = groupDigits(inp.value);
    if (out === inp.value) return;
    inp.value = out;
    var pos = 0, seen = 0;
    while (pos < out.length && seen < digitsBefore) { if (/\d/.test(out.charAt(pos))) seen++; pos++; }
    try { inp.setSelectionRange(pos, pos); } catch (e) {}
  }
  // Group every money field EXCEPT the one being typed in (never fight the caret).
  function formatMoneyInputs() {
    var active = document.activeElement;
    MONEY_IDS.forEach(function (id) {
      var e = el(id);
      if (!e || e === active) return;
      var out = groupDigits(e.value);
      if (out !== e.value) e.value = out;
    });
  }
  // Convert the dollar inputs to comma-capable text fields (number inputs reject
  // commas) and group any value already present (e.g. a portal prefill).
  function initMoneyInputs() {
    MONEY_IDS.forEach(function (id) {
      var e = el(id);
      if (!e) return;
      if (e.type === "number") { e.type = "text"; e.setAttribute("inputmode", "numeric"); }
      e.value = groupDigits(e.value);
    });
  }
  function wire() {
    try { YS.applyState(YS.readState()); } catch (e) {}
    initMoneyInputs();
    $$("#tsForm input, #tsForm select, #tsForm textarea").forEach(function (inp) {
      var h = function () {
        if (isMoneyInput(inp)) formatMoneyField(inp);   // the typed field (caret-safe)
        recompute();
        formatMoneyInputs();                            // group the rest (incl. after a prefill)
        var f = inp.closest && inp.closest(".field"); if (f) f.classList.remove("invalid");
      };
      inp.addEventListener("input", h); inp.addEventListener("change", h);
    });
    ["origPrice", "price"].forEach(function (id) { var e = el(id); if (e) e.addEventListener("blur", validateAssign); });
    var slider = el("rLevSlider");
    if (slider) slider.addEventListener("input", function () {
      var isGold = chosenProgram === "gold";
      var rows = ((isGold ? goldLadder() : YSP.priceLadder(gather())).rows) || [];
      if (!rows.length) return;
      var maxV = rows.length - 1;
      var idx = maxV - parseInt(slider.value, 10);
      if (idx < 0) idx = 0; if (idx > maxV) idx = maxV;
      var chosen = (idx === 0) ? null : rows[idx].ltc;             // top of range = max leverage
      if (isGold) goldChosenLTC = chosen; else chosenLTC = chosen;
      recompute();
    });
    var pdf = el("tsPdf"); if (pdf) pdf.addEventListener("click", function () {
      if (!readyToPrice()) { flash("Add the required fields (state, FICO, price and ARV) to download your term sheet."); return; }
      if (!canIssue(issueDeal())) { flash("This scenario isn't eligible as entered, so a term sheet can't be issued \u2014 use \u201CSubmit for manual review\u201D and our team will take a look."); return; }
      if (validateAssign()) exportPdf(pdf); else flash("The seller's contract price can't be more than the purchase price.");
    });
    var lt = el("tsLetter"); if (lt) lt.addEventListener("click", function () { exportLetter(lt); });
    var lead = el("leadSend"); if (lead) lead.addEventListener("click", function () { captureLead(lead); });
    var leadF = el("leadEmail"); if (leadF) leadF.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); captureLead(lead); } });
    var xls = el("tsXlsx"); if (xls) xls.addEventListener("click", function () { exportXlsx(xls); });
    var imp = el("tsImportBtn"), impFile = el("tsImport");
    if (imp && impFile) { imp.addEventListener("click", function () { impFile.click(); }); impFile.addEventListener("change", function () { importXlsx(impFile); }); }
    var scard = el("pcardStd"); if (scard) scard.addEventListener("click", function () { selectProgram("standard"); });
    var gcard = el("pcardGold"); if (gcard) gcard.addEventListener("click", function () { selectProgram("gold"); });
    var pback = el("progBack"); if (pback) pback.addEventListener("click", function () { chosenProgram = null; recompute(); });
    // info tooltips: tap toggles (hover/keyboard focus handle desktop); never let a tap fall through to the card
    document.addEventListener("click", function (ev) {
      var t = (ev.target && ev.target.closest) ? ev.target.closest(".tip") : null;
      var open = document.querySelectorAll(".tip.tip-open");
      for (var i = 0; i < open.length; i++) if (open[i] !== t) open[i].classList.remove("tip-open");
      if (t) { ev.preventDefault(); ev.stopPropagation(); t.classList.toggle("tip-open"); }
    });
    wireAdmin();
    // Pull company-wide pricing defaults, then recompute. Best-effort: on any
    // failure the tool keeps its seeded literals (never blocks the sheet).
    (function(){
      try {
        fetch("/api/pricing-defaults").then(function(r){ return r.ok ? r.json() : null; }).then(function(d){
          if (d && typeof d === "object") {
            if (d.markupStdPct != null) CO.markupStd = Number(d.markupStdPct);
            if (d.markupGoldPct != null) CO.markupGold = Number(d.markupGoldPct);
            if (d.origStdPct != null) CO.origStd = Number(d.origStdPct);
            if (d.origGoldPct != null) CO.origGold = Number(d.origGoldPct);
            if (d.lenderFee != null) CO.lender = Number(d.lenderFee);
            if (d.creditFee != null) CO.credit = Number(d.creditFee);
            if (d.appraisalFee != null) CO.appraisal = Number(d.appraisalFee);
            CO.title = (d.titleFee != null ? Number(d.titleFee) : null);
            CO.extraFees = Array.isArray(d.extraFees) ? d.extraFees : [];
          }
        }).catch(function(){}).then(function(){ seedAdminDefaults(); recompute(); });
      } catch (e) { recompute(); }
    })();
  }
  window.TS = { exportPdf: exportPdf, exportLetter: exportLetter, exportXlsx: exportXlsx, importXlsx: importXlsx, share: function (b) { try { YS.shareLink(b); } catch (e) {} },
    _calc: calc, _calcGold: calcGold, _xlsxSections: xlsxSections, _gather: gather, _manualOn: manualOn };
  window.APP = window.TS;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire();
})();
