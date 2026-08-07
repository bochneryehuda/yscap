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
  var MIN_INTEREST_DETAIL = "This loan carries a 3-month minimum earned interest provision: if the loan pays off before three full months of interest have accrued, the remainder of that minimum is due at payoff. This is an interest floor, not a prepayment penalty.";


  var LENDER = { name: "YS Capital Group", nmls: "2609746", email: "sales@yscapgroup.com", phone: "718-831-2168" };
  var FEES = { lender: 2195, credit: 150, appraisal: 800 };   // flat third-party estimates (origination % comes from the engine / admin field)
  // Company-wide pricing defaults (Pricing Admin Center, owner-directed
  // 2026-07-14): seeded to the historic literals, then overwritten live from
  // /api/pricing-defaults so a company fee/markup change reaches every new term
  // sheet on the marketing generator AND the portal studio. The admin studio
  // fields still override per session; a per-file registration still snapshots.
  var CO = { markupStd: 0.5, markupGold: 0.5, markupSilver: 0.5, origStd: 1.25, origGold: 1.25, origSilver: 1.25, lender: 2195, credit: 150, appraisal: 800, title: null, extraFees: [], markupTiers: null };

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
  var silverChosenLTC = null; // leverage slider for Silver (targetLTC); Silver's grid rate varies by LTC band like Standard
  var lastDeal = null;   // tracks deal-type changes (to default the ground-up term/reserve once)
  var chosenProgram = null;   // null = offers view; "standard" | "gold" | "silver" | "manual" = drilled into that program's detail
                              // ("manual" = the admin-priced scenario — prices on the Standard engine with the
                              //  admin-set basis, exactly what the server records for a Manual Program register)

  var INELIGIBLE_CITIES = ["baltimore", "philadelphia", "detroit", "chicago"];
  function detectCity(addr) {
    var a = String(addr || "").toLowerCase();
    for (var i = 0; i < INELIGIBLE_CITIES.length; i++) if (a.indexOf(INELIGIBLE_CITIES[i]) > -1) return INELIGIBLE_CITIES[i];
    return "";
  }

  /* ---------------- deal helpers ---------------- */
  /* NOTE RATE display — up to 3 decimals, never fewer than 2, one trailing zero
     trimmed, so 10.625% prints as 10.625 (not 10.63) and 10.30% stays 10.30
     (owner-directed 2026-08-04). Takes a PERCENT number (e.g. d.rate = 10.625, or
     noteRate*100). Changes no pricing number — the engine still produces the rate;
     this only stops the display from throwing away its third decimal. Mirrors the
     server helper src/lib/rate-format.js so every surface shows the SAME rate. */
  function fmtRate3(pctNum) {
    var n = Number(pctNum);
    if (!isFinite(n)) return "";
    var s = n.toFixed(3);
    if (s.charAt(s.length - 1) === "0") s = s.slice(0, -1);
    return s;
  }
  function purpose() { return val("dealPurpose") || "Purchase"; }
  function isRefi() { return purpose().indexOf("refinance") > -1 || purpose().indexOf("Refinance") > -1; }
  /* CASH TO CLOSE ON A REFINANCE (owner-directed 2026-08-04). A purchase brings a
     down payment plus closing costs. A refinance has no down payment; instead the
     borrower brings whatever the funds that advance at closing (the INITIAL ADVANCE
     — the rehab holdback funds later in draws) do NOT cover of the existing-loan
     payoff PLUS the closing costs. This is the exact mirror of the "cash to you"
     figure (structuralCashOut = funded − payoff − closing): exactly one of {cash to
     you, cash you bring} is greater than zero. On the owner's example (initial
     173,550, payoff 220,000, closing 10,254.38) it is
     max(0, 220,000 + 10,254.38 − 173,550) = 56,704.38. No pricing number moves. */
  function refiCashToClose(initialAdvance, closing) {
    return Math.max(0, Math.max(0, num("payoff")) + (closing || 0) - (initialAdvance || 0));
  }
  function isCashOut() { return purpose().toLowerCase().indexOf("cash-out") > -1; }
  /* WHO the payoff goes to, as a sentence fragment — "" when nobody was named, so
     every caller reads the same whether or not the officer filled it in. */
  function payoffLender() { return (val("payoffLender") || "").trim(); }
  function payoffLoanNo() { return (val("payoffLoanNo") || "").trim(); }
  /* WHAT THE STRUCTURE IMPLIES the borrower receives AT THE TABLE: the money that
     actually funds on closing day, less the loan being retired, less the closing
     costs. All three come from the frozen calc — this is arithmetic on the
     engine's own output, not a pricing rule.

     IT IS THE INITIAL ADVANCE, NOT THE WHOLE LOAN. A renovation loan's rehab
     holdback is released later, draw by draw, against work completed, and a
     financed interest reserve is held back too (totalLoan = initialAdvance +
     rehabHoldback + financedReserve). Netting the payoff off the TOTAL would
     quote the borrower money they will not see for months — on a heavy-rehab
     refinance, overstated by the entire construction budget. */
  /* A REAL advance wins even when it is ZERO — the fallback is for an advance
     that is genuinely ABSENT, not for one that happens to be nothing. `> 0`
     would fall back to the whole loan on a zero advance, which is precisely the
     overstatement this helper exists to prevent.

     `numOrNull` is deliberately the SAME rule as the server model's `num()`
     (src/lib/payoff.js) — absent/blank/unreadable is null, everything else is a
     number — so the two implementations of "what funds at closing" cannot
     disagree on an edge. Note `isFinite(null)` is TRUE in JavaScript and
     `Number('')` is 0, so both have to be excluded BEFORE the numeric test; a
     bare isFinite() check reads a blank as a zero advance. */
  function numOrNull(v) {
    // TRIMMED, like the server's num(). Round 4 taught the server that a box of
    // spaces is an empty box (`Number('   ')` is 0) and left this side behind —
    // breaking the very invariant the note above states. Latent today (the calc
    // only ever passes real numbers here), which is exactly the kind of drift
    // that becomes a live bug the day someone passes a string.
    if (v === null || v === undefined || String(v).trim() === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  function fundedAtClose(d) {
    if (!d) return 0;
    var a = numOrNull(d.initialAdvance);
    if (a !== null) return a;
    var t = numOrNull(d.totalLoan);
    return t !== null ? t : 0;
  }
  function structuralCashOut(d) {
    var funded = fundedAtClose(d);
    if (!(funded > 0)) return 0;
    return Math.max(0, funded - num("payoff") - (d.closing || 0));
  }
  /* The figure of record: whatever the officer TYPED, else what the structure
     implies. A typed value wins because a real deal can net differently (a
     holdback, a reserve, a second lien) and the number that matters is the one
     actually going to the borrower. */
  /* ZERO IS A TYPED ANSWER, NOT AN EMPTY BOX (post-merge audit 2026-07-31).
     `num()` returns 0 for a BLANK field, so it cannot tell "nothing typed" from
     "typed nothing" — and `typed > 0` therefore ignored a deliberate 0, on the
     very deal where the structural figure is most likely to be wrong.
     `YS.opt()` is the blank-aware reader (null when blank), which is the same
     rule the server model uses. A negative is never an answer — nobody receives
     a negative cheque — and is refused at both write doors. */
  function cashOutOfRecord(d) {
    var typed = YS.opt("cashOutAmt");
    return (typed !== null && typed >= 0) ? typed : structuralCashOut(d);
  }
  function payoffWhoTxt() {
    var who = payoffLender(), no = payoffLoanNo();
    if (!who && !no) return "";
    if (who && no) return " to " + who + " (loan #" + no + ")";
    return who ? " to " + who : " (loan #" + no + ")";
  }
  function dealType() { return val("dealType"); }
  function isGroundUp() { return YSP.normStrategy(dealType()) === "NC"; }
  function isAssign() { return chk("isAssign"); }
  function effPurchase() { return isRefi() ? num("asIs") : num("price"); }  // total purchase price

  /* ---------------- build the engine input ---------------- */
  // ---------------- interest reserve: months <-> the reserve THE LOAN CARRIES ----------------
  // Owner-directed 2026-07-20: the reserve is ONE value shown two ways. Fill EITHER the
  // months field or the dollar field and the other fills in to match. The field the user
  // drives is the SOURCE; the other is a DERIVED mirror (data-derived="1"), written for
  // display only. gather() feeds the engine ONLY the source field (a derived field reads
  // as 0), so the priced/registered result is byte-identical to the old "fill one, leave
  // the other blank" behavior — no pricing math changes.
  //
  // DISPLAY-TRUTH FIX (owner-reported 2026-07-30: "I'm putting in 12 months reserve, right
  // next to it the box converts to $186,000 — but the Excel structure gives me $210,000
  // interest reserve"). The mirror used to be an INDEPENDENT ESTIMATE,
  // Math.round(months x monthly payment), which is NOT the reserve the loan carries — every
  // reserve rule sits between the request and the structure:
  //   • the LEVERAGE caps shrink it (ARV / as-is / LTC / program max loan) — `reserveCapped`
  //     + `reserveCapBy` on the sizing;
  //   • the loan TERM caps it (`reserveTermCapped` / `reserveTermMonths`);
  //   • Gold finances ZERO on a renovation (`R.reserveEligible === false`) and LOCKS a full
  //     75%-of-term construction reserve on ground-up at tier 2/3 and tier 1 at $1.5MM+
  //     (`irLocked`) — which finances MORE than a smaller request, the owner's own direction;
  //   • the frozen whole-dollar breakdown reconciliation moves the last dollar or two
  //     (reserve = flooredTotal − flooredInitial − flooredHoldback).
  // So the mirror now shows d.financedIR — the SAME reconciled figure the structure row, the
  // term-sheet PDF, the Excel export, the derivation page, the leverage ladder and the
  // server's registration (`pricing.normalize` → `quote.sizing.financedReserve`) all report —
  // and irNoteText() states the request, the financed figure and WHY they differ in the
  // ENGINE'S OWN WORDS. It also NAMES the program, because the reserve is per-program and the
  // Excel prints one section per program. All DISPLAY ONLY: no engine input, no formula, no
  // frozen number is touched (the engine still receives ONLY the source field).
  function irIsDerived(id) { var e = el(id); return !!(e && e.dataset && e.dataset.derived === "1"); }
  function setIrSource(src) {
    var m = el("irMonths"), a = el("irAmount");
    if (src === "amount") { if (a) delete a.dataset.derived; if (m) m.dataset.derived = "1"; }
    else { if (m) delete m.dataset.derived; if (a) a.dataset.derived = "1"; }
  }
  // Whole-dollar money wording, LOCAL to these helpers (not YS.fmtUSD) so the reserve link
  // stays self-contained and the DOM harness in scripts/test-ir-reserve-link.js can assert
  // the exact copy the owner reads.
  function irUsd(n) {
    var v = Math.round(Math.abs(Number(n) || 0));
    return "$" + String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  // The reserve REQUEST exactly as the engine received it (the SOURCE field only — a derived
  // mirror reads as 0, the same gate gather() uses). EVERY surface that prints "what was asked
  // for" must use this, never a raw read of the dollar box: that box now carries the FINANCED
  // figure whenever months is the source, so a raw read would print the financed number under
  // a "requested" label (owner-reported 2026-07-30).
  function irRequestText() {
    var a = irIsDerived("irAmount") ? 0 : num("irAmount");
    if (a > 0) return irUsd(a);
    var m = irIsDerived("irMonths") ? 0 : num("irMonths");
    return m > 0 ? (m + (m === 1 ? " month" : " months")) : "";
  }
  // THE reserve figure: what the loan carries, never an estimate. d.financedIR is already the
  // reconciled whole-dollar reserve (calc/calcGold/calcSilver derive it as
  // flooredTotal − flooredInitial − flooredHoldback, exactly like src/lib/pricing.js).
  function irFinanced(d, sized) {
    var v = (sized && d) ? Math.round(Number(d.financedIR) || 0) : 0;
    return v > 0 ? v : 0;
  }
  // The months that financed reserve actually buys, at the SAME payment the structure prints.
  // null = nothing to show (unsized / no payment yet).
  function irFinancedMonths(d, sized) {
    var pay = (d && d.fullPayment > 0) ? Number(d.fullPayment) : 0;
    if (!sized || !(pay > 0)) return null;
    return Math.round((irFinanced(d, sized) / pay) * 10) / 10;
  }
  function irProgramLabel(d, progLabel) {
    if (progLabel) return progLabel;
    return (d && d.gold) ? "Gold Standard Program" : (d && d.silver) ? "Silver Program" : "Standard Program";
  }
  // "12 months requested; $60,000 financed on the Silver Program — capped by the 70%
  // after-repair-value ceiling." Empty string when the loan carries exactly what was asked
  // for and no program rule reshaped it (the box alone already tells the truth).
  function irNoteText(d, sized, progLabel) {
    var m = el("irMonths"), a = el("irAmount");
    if (!m || !a || !d) return "";
    var amountIsSource = (a.dataset.derived === "1") ? false
      : (m.dataset.derived === "1") ? true
      : num("irAmount") > 0;
    var reqMonths = amountIsSource ? 0 : num("irMonths");
    var reqAmount = amountIsSource ? num("irAmount") : 0;
    if (!(reqMonths > 0) && !(reqAmount > 0)) return "";
    if (!sized) return "";
    var R = (d && d.R) || {};
    var noReserve = (R.reserveEligible === false);              // Gold renovation: never any reserve
    var locked = !!(d.irLocked || R.irLocked);                  // Gold ground-up: reserve set by the program
    var capped = !!d.reserveCapped;                            // leverage / max-loan ceiling
    var termCapped = !!R.reserveTermCapped;                    // asked for more months than the term
    if (!noReserve && !locked && !capped && !termCapped) return "";
    var capMo = Math.round((Number(R.reserveTermMonths) || 0) * 10) / 10;
    var financed = irFinanced(d, sized);
    var prog = irProgramLabel(d, progLabel);
    var req = amountIsSource ? (irUsd(reqAmount) + " requested")
      : (reqMonths + (reqMonths === 1 ? " month" : " months") + " requested");
    var why = [];
    if (noReserve) why.push("this program finances no interest reserve on a renovation loan");
    else if (locked) why.push("this program sets the construction reserve at " + capMo + " months (75% of the " +
      (d.term || 0) + "-month term) on a ground-up loan at this tier");
    if (capped && d.reserveCapBy) why.push("capped by " + d.reserveCapBy);
    else if (capped) why.push("capped by the program leverage ceiling");
    if (termCapped && !noReserve && !locked) why.push("a reserve can\'t cover more interest than the " + capMo + "-month term");
    var tail = why.length ? (" — " + why.join("; ")) : "";
    // THE INVARIANT (owner-directed 2026-07-30): the reader must NEVER be shown less than
    // the loan actually finances. Over-stating a request that then gets capped is fine and
    // only needs explaining; UNDER-stating is the defect. When the program finances MORE
    // than the entry (Gold locks a full 75%-of-term construction reserve and DISCARDS an
    // exact-dollar request outright), the source box the user typed is the smaller number —
    // so the note LEADS with the financed figure instead of burying it after the ask.
    var overFinanced = locked && (amountIsSource ? (financed > reqAmount + 1) : (capMo > reqMonths + 1e-9));
    if (overFinanced) {
      return "This loan finances " + irUsd(financed) + " of interest reserve on the " + prog +
        " — MORE than the " + (amountIsSource ? irUsd(reqAmount) : (reqMonths + (reqMonths === 1 ? " month" : " months"))) +
        " you entered" + tail + ".";
    }
    return req + "; " + irUsd(financed) + " financed on the " + prog + tail + ".";
  }
  // Fill the non-source field with the reserve THE LOAN CARRIES (never an estimate) and write
  // the plain-language note next to the pair.
  function syncIrMirror(d, sized, progLabel) {
    var m = el("irMonths"), a = el("irAmount");
    if (!m || !a) return;
    // Source = the field NOT marked derived (the flags carry real user intent, set on
    // input). Only when NEITHER is flagged (a fresh load / portal prefill) do we infer
    // from the value: a real dollar amount wins (matches the engine's amount>0 override),
    // otherwise months. Trusting the flag — not the current value — means clearing the
    // source field can never resurrect the stale mirror as a phantom reserve.
    var amountIsSource = (a.dataset.derived === "1") ? false
      : (m.dataset.derived === "1") ? true
      : num("irAmount") > 0;
    if (amountIsSource) {
      m.dataset.derived = "1"; delete a.dataset.derived;
      var mo = (num("irAmount") > 0) ? irFinancedMonths(d, sized) : null;
      var mv = (mo == null) ? "" : String(mo);
      if (m.value !== mv) m.value = mv;
    } else {
      a.dataset.derived = "1"; delete m.dataset.derived;
      var av = (sized && num("irMonths") > 0) ? String(irFinanced(d, sized)) : "";
      if (a.value !== av) a.value = av;
    }
    var note = el("irFinNote");
    if (note) {
      var t = irNoteText(d, sized, progLabel);
      if (note.textContent !== t) note.textContent = t;
      if (note.style) note.style.display = t ? "" : "none";
    }
  }

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
      irMonths: irIsDerived("irMonths") ? 0 : num("irMonths"),
      irAmount: irIsDerived("irAmount") ? 0 : num("irAmount"),   // exact $ reserve (overrides months when > 0); a DERIVED mirror reads as 0 so only the SOURCE field prices
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
    // Out-of-pocket rehab exception (owner-authorized 2026-07-31): bring part of the
    // rehab out of pocket so the initial advance rises toward its cap. Read on EVERY
    // program (the box lives in the admin zone). The re-slice (oopReslice) caps it at
    // the max, so a stale value can never over-slice. Ignored by the engines — applied
    // in calc()/normalize() as a pure transform of the already-sized structure.
    var oopReq = adminNumRaw("tsOopRehab"); if (oopReq != null && oopReq > 0) o.oopRehab = oopReq;
    if (chk("tsOopRehabMax")) o.oopRehabMax = true;
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
  function issueDeal() { var d = calc(); if (chosenProgram === "gold") { var g = calcGold(); if (g && !g.unavailable) d = g; } else if (chosenProgram === "silver") { var sv = calcSilver(); if (sv && !sv.unavailable) d = sv; } return d; }
  // The deal object for the currently drilled-in program (falls back to Standard).
  function calcChosen() {
    if (chosenProgram === "gold") return calcGold() || calc();
    if (chosenProgram === "silver") { var sv = calcSilver(); return (sv && !sv.unavailable) ? sv : calc(); }
    return calc();
  }
  function progOf(d) { return d && d.gold ? "gold" : (d && d.silver ? "silver" : "standard"); }
  function chosenProgramName(withManual) {
    if (chosenProgram === "manual") return "Manual Program";
    if (chosenProgram === "gold") return "Gold Standard Program";
    if (chosenProgram === "silver") return "Silver Program";
    return (withManual && manualOn()) ? "Manual Program" : "Standard Program";
  }
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

  // Build the manual-review request text (sent to our team THROUGH THE BACKEND —
  // no mail client) so an ineligible/edge scenario can be desk-reviewed.
  function manualReviewText(d) {
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
    // The REQUEST as the engine received it, plus the reserve the loan actually carries —
    // a raw read of the dollar box would print the FINANCED figure as if it were the ask.
    L.push("Interest reserve requested: " + (irRequestText() || "none") +
      ((d && d.financedIR > 0) ? (" · financed on this scenario: " + YS.fmtUSD(d.financedIR)) : ""));
    L.push("Estimated FICO: " + (num("fico") || "—"));
    L.push("Experience (36 mo): flips " + (num("expFlips") || 0) + ", holds/BRRRR " + (num("expBrrrr") || 0) + ", ground-up " + (num("expGround") || 0));
    if (d && d.totalLoan > 0) L.push("Indicated loan amount: " + YS.fmtUSD(d.totalLoan));
    L.push("");
    var probs = (d && d.reasons || []).filter(function (r) { return r.level !== "ELIGIBLE"; }).map(function (r) { return "• " + r.msg; });
    if (probs.length) { L.push("Flagged:"); L.push(probs.join("\n")); L.push(""); }
    L.push("Please advise on options. Thank you.");
    var subj = "Manual review request — " + (dealType() || "scenario") + (val("propState") ? " (" + val("propState") + ")" : "");
    return { subject: subj, body: L.join("\n") };
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
    // A cash-out figure only exists on a cash-out refinance — a rate-&-term takes
    // no cash, so asking for the number there would invite the very thing the
    // structure is not.
    $$('[data-cond="cashOutOnly"]').forEach(function (n) { show(n, isRefi() && isCashOut()); });
    // rehab scope (light/heavy) and sq-ft addition apply only to fix & flip / fix & hold
    var isFF = YSP.normStrategy(dealType()) === "FF";
    $$('[data-cond="ffOnly"]').forEach(function (n) { show(n, isFF); });
    if (!isFF) { var sq = el("sqft"); if (sq) sq.checked = false; }
    // Bridge is as-is only — no rehab, no ARV, no interest reserve. Hide all of it and clear the values.
    var isBridge = YSP.normStrategy(dealType()) === "BR";
    $$('[data-cond="hasRehab"]').forEach(function (n) { show(n, !isBridge); });
    $$('[data-cond="bridgeOnly"]').forEach(function (n) { show(n, isBridge); });
    if (isBridge) { ["construction", "arv", "irMonths", "irAmount"].forEach(function (id) { var e = el(id); if (e && e.value) e.value = ""; }); }

    // Ground-up default: first time the user selects ground-up, set an 18-month term.
    // The INTEREST RESERVE ENTRY IS NEVER PRE-FILLED (owner-directed 2026-07-30:
    // "it should be defaulted to zero when you start filling out … you can default
    // the term but you don't default the interest reserve"). Where a program
    // REQUIRES a reserve (Gold ground-up forces the full-term reserve for
    // non-top tiers inside the frozen engine), the requirement still populates
    // the PRICED STRUCTURE on its own — the engines apply their own reserve
    // rules regardless of the requested months; only the blank entry changed.
    var dt = dealType();
    if (dt !== lastDeal) {
      var nowGround = YSP.normStrategy(dt) === "NC";
      var wasGround = YSP.normStrategy(lastDeal || "") === "NC";
      if (nowGround && !wasGround) {
        if (el("tsTerm") && num("tsTerm") < 18) el("tsTerm").value = 18;
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

  /* OUT-OF-POCKET REHAB EXCEPTION re-slice (owner-authorized 2026-07-31) — the ONE
     definition shared by calc()/calcGold()/calcSilver(), mirroring src/lib/pricing.js
     normalize() so the studio ALWAYS displays exactly what would register. It floors
     the engine's sized split (the frozen rounding policy, unchanged) and then, only
     when an out-of-pocket amount is supplied, moves X dollars from the rehab holdback
     into the initial advance — capped so the initial never exceeds its acquisition
     ceiling (maxAcqLTV x acqDenom) and the holdback never goes negative. Total loan /
     rate / caps / financed reserve are untouched; byte-identical when oopRehab is 0.
     `maxOopRehab`/`initialCut`/`maxInitial` are the two figures the Manual section
     shows before anything is entered. */
  function oopReslice(R, inp) {
    var s = R.sizing || {};
    var totalLoan = Math.floor(s.totalLoan || 0);
    var rehabHoldback = Math.floor(s.rehabLoan || 0);
    var initialAdvance = Math.floor(s.acquisition || 0);
    var financedIR = 0;
    if ((s.financedIR || 0) > 0.5) financedIR = Math.max(0, totalLoan - initialAdvance - rehabHoldback);
    else initialAdvance = Math.max(0, totalLoan - rehabHoldback);
    var effCaps = R.pricedCeiling || R.caps || {};       // EFFECTIVE sizing cap (Silver splits pricedCeiling from the program max)
    var maxInitial = Math.floor(Math.max(0, (effCaps.maxAcqLTV || 0) * (s.acqDenom || 0)));
    var initialCut = Math.max(0, maxInitial - initialAdvance);
    var maxOopRehab = Math.max(0, Math.min(initialCut, rehabHoldback));
    var reqOop = (inp && inp.oopRehabMax) ? maxOopRehab : Math.max(0, Math.floor((inp && inp.oopRehab) || 0));
    var oopRehab = Math.max(0, Math.min(reqOop, maxOopRehab));
    if (oopRehab > 0) { initialAdvance += oopRehab; rehabHoldback -= oopRehab; }
    var downPayment = Math.max(0, (s.downPayment || 0) - oopRehab);
    return { totalLoan: totalLoan, rehabHoldback: rehabHoldback, initialAdvance: initialAdvance,
      financedIR: financedIR, downPayment: downPayment, oopRehab: oopRehab,
      maxOopRehab: maxOopRehab, initialCut: initialCut, maxInitial: maxInitial };
  }

  /* ---------------- compute (delegates to the engine) ---------------- */
  function reserveMonths(totalLoan) { return (totalLoan || 0) > 1000000 ? 4 : 2; }  // Standard Program liquidity: 2 months of payments to show under $1M, 4 months over $1M
  // Closing-cost buffer on the LIQUIDITY TO SHOW (owner-authorized 2026-07-31:
  // "add a buffer for extra closing costs… about 1% of the deal… we should not
  // run short… we can waive it on the manual side"). 1% of the loan amount is
  // added to the liquidity-to-show figure on every program; the portal host may
  // waive it per file via the read-only liqBufferWaived hidden input (the same
  // shape as coBorrowerPgWaived). DISPLAY + the tool's own liquidity figure
  // only — loan sizing, rates and caps are untouched.
  function liqBufferWaived(){ var e=document.getElementById("liqBufferWaived"); return !!(e && (e.value==="1"||e.value==="true")); }
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
    var _sl = oopReslice(R, inp);                        // floored split + OOP-rehab re-slice (byte-identical when no exception)
    var totalLoan = _sl.totalLoan;
    var rehabHoldbackR = _sl.rehabHoldback;
    var initialAdvance = _sl.initialAdvance;
    var financedIRr = _sl.financedIR;
    var origPct = liveOrigPct();                          // manual basis on => the Manual knob (see liveOrigPct)
    var origFee = (totalLoan) * origPct;                  // origination % (admin-overridable; default 1%)
    // interest-only payment logic (industry standard): during construction the borrower pays
    // interest only on funds DRAWN — starts on the initial advance, grows to the full loan.
    var rFrac = (R.noteRate || 0) / 12;
    // Use the engine's own payment figures (round2 of the sized loan) so the printed
    // monthly payment / reserve / liquidity match the REGISTERED file to the penny.
    // normalize() persists s.fullPayment/s.initialPayment; recomputing here on the
    // floored loan drifted 1-2 cents (audit 2026-07-19). Falls back to the floored
    // loan if the engine ever omits them. Does NOT touch the financed-reserve
    // reconciliation (that stays on the floored totalLoan/initial/holdback residual).
    var initialPayment = (_sl.oopRehab > 0) ? (initialAdvance * rFrac) : (s.initialPayment != null ? Number(s.initialPayment) : initialAdvance * rFrac);   // while only the initial advance is out (rises with a raised initial)
    var fullPayment = (s.fullPayment != null ? Number(s.fullPayment) : totalLoan * rFrac);                 // after all rehab draws complete
    var monthlyInterest = s.monthlyInterest || fullPayment;
    var title = (typeof YSTitle !== "undefined" && YSTitle) ? YSTitle.estimate(inp.state, totalLoan, inp.loanType) : { total: 0 };
    var titleOvr = adminTitle();
    var titleCost = (titleOvr != null) ? titleOvr : (title.total || 0);
    var lenderFee = adminFeeUW(), creditFee = adminFeeCredit(), apprFee = adminFeeAppr();
    var closing = origFee + lenderFee + creditFee + titleCost + extraFeesTotal();      // + company extra fees (NY settlement etc.); appraisal is POC (excluded)
    var excessOOP = (s.assignmentExcessOOP != null ? s.assignmentExcessOOP : (R.assignment && R.assignment.excessOOP)) || 0;
    var cashToClose = isRefi() ? refiCashToClose(initialAdvance, closing) : (_sl.downPayment + excessOOP + closing);   // reserve is never brought to the table; OOP rehab is funded over construction, not here
    var reserves = fullPayment * reserveMonths(totalLoan);  // Standard liquidity buffer: months of interest on top of cash to close
    var closingBuffer = liqBufferWaived() ? 0 : Math.round(totalLoan * 0.01 * 100) / 100;   // 1% closing-cost buffer (owner-authorized 2026-07-31); waivable per file
    var liquidity = cashToClose + reserves + _sl.oopRehab + closingBuffer;  // OOP rehab is part of the liquidity the borrower must show (+0 by default)
    var basisPrice = (asg ? asg.recognizedPrice : (inp.loanType === "Purchase" ? effPurchase() : num("asIs")));
    // TOTAL COST goes by the LOWER of the acquisition price and the as-is value
    // (owner-directed 2026-08-05) — the engine's own acqDenom (min(price, as-is) on a
    // purchase, the as-is value on a refi). basisPrice stays the REAL price shown as
    // "Purchase price"; only the total-cost/LTC basis drops to the as-is value when it
    // is lower. Falls back to basisPrice if the deal did not size. Byte-identical when
    // the as-is value is >= the price (acqDenom === basisPrice).
    var costAcq = (s.acqDenom > 0) ? s.acqDenom : basisPrice;
    var displayCost = costAcq + num("construction") + financedIRr;

    return {
      R: R, inp: inp, eff: (inp.loanType === "Purchase" ? effPurchase() : num("asIs")), basisPrice: basisPrice,
      constr: num("construction"), asg: asg, pricingReady: !!R.pricingReady,
      asIs: num("asIs"), arv: num("arv"), rate: rate, term: inp.term, irMonths: inp.irMonths,
      totalLoan: totalLoan, initialAdvance: initialAdvance, rehabHoldback: rehabHoldbackR,
      financedIR: financedIRr, unfinancedIR: 0,
      maxReserve: s.maxReserve || 0, reserveCapped: !!s.reserveCapped, reserveCapBy: s.reserveCapBy || "",
      maxReserveMonths: s.maxReserveMonths || 0, desiredReserve: s.desiredReserve || 0,
      initialPayment: initialPayment, fullPayment: fullPayment, monthlyInterest: monthlyInterest,
      totalCost: displayCost, downPayment: _sl.downPayment, excessOOP: excessOOP,
      oopRehab: _sl.oopRehab, maxOopRehab: _sl.maxOopRehab, initialCut: _sl.initialCut, maxInitial: _sl.maxInitial,
      origFee: origFee, origPct: origPct, lenderFee: lenderFee, creditFee: creditFee, apprFee: apprFee, titleCost: titleCost, titleInfo: title,
      closing: closing, extraFees: extraFeeList(), cashToClose: cashToClose, reserves: reserves, reserveMo: reserveMonths(totalLoan), liquidity: liquidity,
      closingBuffer: closingBuffer, closingBufferWaived: liqBufferWaived(),
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
    var _g = oopReslice(R, inp);                         // floored split + OOP-rehab re-slice (byte-identical when no exception)
    var totalLoan = _g.totalLoan;
    var rehabHoldbackR = _g.rehabHoldback;
    var initialAdvance = _g.initialAdvance;
    var financedIRr = _g.financedIR;
    var origPct = adminOrigPct("gold");
    var origFee = totalLoan * origPct;                    // origination % (admin-overridable; default 1%)
    var rFrac = (R.noteRate || 0) / 12;
    var title = (typeof YSTitle !== "undefined" && YSTitle) ? YSTitle.estimate(inp.state, totalLoan, inp.loanType) : { total: 0 };
    var titleOvr = adminTitle();
    var titleCost = (titleOvr != null) ? titleOvr : (title.total || 0);
    var lenderFee = adminFeeUW(), creditFee = adminFeeCredit(), apprFee = adminFeeAppr();
    var closing = origFee + lenderFee + creditFee + titleCost + extraFeesTotal();
    var excessOOP = (s.assignmentExcessOOP != null ? s.assignmentExcessOOP : (R.assignment && R.assignment.excessOOP)) || 0;
    var cashToClose = isRefi() ? refiCashToClose(initialAdvance, closing) : (_g.downPayment + excessOOP + closing);
    var goldReservePct = R.liquidityPct || 0.05;
    var goldReserve = totalLoan * goldReservePct;            // Gold reserve = 5% of the loan, shown ON TOP of cash to close
    var closingBuffer = liqBufferWaived() ? 0 : Math.round(totalLoan * 0.01 * 100) / 100;   // 1% closing-cost buffer (owner-authorized 2026-07-31); waivable per file
    var asg = R.assignment;
    var basisPrice = (asg ? asg.recognizedPrice : (inp.loanType === "Purchase" ? effPurchase() : num("asIs")));
    // Total cost goes by the LOWER of the acquisition price and the as-is value
    // (owner-directed 2026-08-05) — the engine's acqDenom. See calc().
    var costAcq = (s.acqDenom > 0) ? s.acqDenom : basisPrice;
    return {
      R: R, inp: inp, gold: true, eff: basisPrice, basisPrice: basisPrice,
      constr: num("construction"), asg: asg, pricingReady: !!R.pricingReady,
      escalations: R.escalations || [],
      asIs: num("asIs"), arv: num("arv"), rate: rate, term: inp.term, irMonths: inp.irMonths,
      totalLoan: totalLoan, initialAdvance: initialAdvance, rehabHoldback: rehabHoldbackR,
      financedIR: financedIRr, unfinancedIR: 0,
      maxReserve: s.maxReserve || 0, reserveCapped: !!s.reserveCapped, reserveCapBy: s.reserveCapBy || "",
      maxReserveMonths: s.maxReserveMonths || 0, desiredReserve: s.desiredReserve || 0,
      initialPayment: (_g.oopRehab > 0 ? (initialAdvance * rFrac) : (s.initialPayment != null ? Number(s.initialPayment) : initialAdvance * rFrac)), fullPayment: (s.fullPayment != null ? Number(s.fullPayment) : totalLoan * rFrac), monthlyInterest: (s.fullPayment != null ? Number(s.fullPayment) : totalLoan * rFrac),
      totalCost: costAcq + num("construction") + financedIRr,
      downPayment: _g.downPayment, excessOOP: excessOOP,
      oopRehab: _g.oopRehab, maxOopRehab: _g.maxOopRehab, initialCut: _g.initialCut, maxInitial: _g.maxInitial,
      origFee: origFee, origPct: origPct, lenderFee: lenderFee, creditFee: creditFee, apprFee: apprFee, titleCost: titleCost, titleInfo: title,
      closing: closing, extraFees: extraFeeList(), cashToClose: cashToClose, reserves: goldReserve, reserveMo: 0,
      liquidity: cashToClose + goldReserve + _g.oopRehab + closingBuffer, liquidityPct: goldReservePct,
      closingBuffer: closingBuffer, closingBufferWaived: liqBufferWaived(),
      ltcPct: s.ltcPct || 0, ltvPct: s.acqLtvPct || 0, arvPct: s.arvPct || 0,
      binding: s.binding || "", caps: R.caps, status: R.status, reasons: R.reasons || [],
      exitShortfall: R.exitShortfall || 0, tierLabel: R.tierLabel, fico: inp.fico,
      productLabel: R.productLabel, irLocked: !!R.irLocked, irRequired: !!R.irRequired, drawFee: R.drawFee || 0
    };
  }

  // Full Silver Program detail, shaped exactly like calc() so the shared detail
  // renderer can drive the Silver panel. The Silver program (its own rate grid) works
  // like Standard mechanically: reserve financed + in cost + full-term cap, the
  // same liquidity-to-show months, the same fee stack — only the guideline
  // engine (window.SVP) differs. Returns null when the engine isn't loaded.
  function calcSilver() {
    var SV = (typeof SVP !== "undefined" && SVP) ? SVP : null;
    if (!SV) return null;
    var inp = gather();
    if (silverChosenLTC) inp.targetLTC = silverChosenLTC;
    var R = SV.evaluate(inp);
    if (manualOn()) { if (R.status === "INELIGIBLE") R.status = "MANUAL"; R.exitShortfall = 0; }   // admin-priced basis
    var s = R.sizing || {};
    var asg = R.assignment;
    var rate = (R.noteRate || 0) * 100;
    // Rounding policy (owner-directed 2026-07-09) — see calc(); same floor +
    // reconcile so the Silver breakdown sums exactly to the (floored) total loan.
    var _sv = oopReslice(R, inp);                        // floored split + OOP-rehab re-slice (byte-identical when no exception)
    var totalLoan = _sv.totalLoan;
    var rehabHoldbackR = _sv.rehabHoldback;
    var initialAdvance = _sv.initialAdvance;
    var financedIRr = _sv.financedIR;
    var origPct = adminOrigPct("silver");
    var origFee = totalLoan * origPct;
    var rFrac = (R.noteRate || 0) / 12;
    var title = (typeof YSTitle !== "undefined" && YSTitle) ? YSTitle.estimate(inp.state, totalLoan, inp.loanType) : { total: 0 };
    var titleOvr = adminTitle();
    var titleCost = (titleOvr != null) ? titleOvr : (title.total || 0);
    var lenderFee = adminFeeUW(), creditFee = adminFeeCredit(), apprFee = adminFeeAppr();
    var closing = origFee + lenderFee + creditFee + titleCost + extraFeesTotal();
    var excessOOP = (s.assignmentExcessOOP != null ? s.assignmentExcessOOP : (R.assignment && R.assignment.excessOOP)) || 0;
    var cashToClose = isRefi() ? refiCashToClose(initialAdvance, closing) : (_sv.downPayment + excessOOP + closing);
    var reserves = (s.fullPayment != null ? Number(s.fullPayment) : totalLoan * rFrac) * reserveMonths(totalLoan);   // same liquidity buffer as Standard
    var closingBuffer = liqBufferWaived() ? 0 : Math.round(totalLoan * 0.01 * 100) / 100;   // 1% closing-cost buffer (owner-authorized 2026-07-31); waivable per file
    var basisPrice = (asg ? asg.recognizedPrice : (inp.loanType === "Purchase" ? effPurchase() : num("asIs")));
    // Total cost goes by the LOWER of the acquisition price and the as-is value
    // (owner-directed 2026-08-05) — the engine's acqDenom. See calc().
    var costAcq = (s.acqDenom > 0) ? s.acqDenom : basisPrice;
    return {
      R: R, inp: inp, silver: true, eff: basisPrice, basisPrice: basisPrice,
      constr: num("construction"), asg: asg, pricingReady: !!R.pricingReady,
      asIs: num("asIs"), arv: num("arv"), rate: rate, term: inp.term, irMonths: inp.irMonths,
      totalLoan: totalLoan, initialAdvance: initialAdvance, rehabHoldback: rehabHoldbackR,
      financedIR: financedIRr, unfinancedIR: 0,
      maxReserve: s.maxReserve || 0, reserveCapped: !!s.reserveCapped, reserveCapBy: s.reserveCapBy || "",
      maxReserveMonths: s.maxReserveMonths || 0, desiredReserve: s.desiredReserve || 0,
      initialPayment: (_sv.oopRehab > 0 ? (initialAdvance * rFrac) : (s.initialPayment != null ? Number(s.initialPayment) : initialAdvance * rFrac)),
      fullPayment: (s.fullPayment != null ? Number(s.fullPayment) : totalLoan * rFrac),
      monthlyInterest: s.monthlyInterest || (s.fullPayment != null ? Number(s.fullPayment) : totalLoan * rFrac),
      totalCost: costAcq + num("construction") + financedIRr,
      downPayment: _sv.downPayment, excessOOP: excessOOP,
      oopRehab: _sv.oopRehab, maxOopRehab: _sv.maxOopRehab, initialCut: _sv.initialCut, maxInitial: _sv.maxInitial,
      origFee: origFee, origPct: origPct, lenderFee: lenderFee, creditFee: creditFee, apprFee: apprFee, titleCost: titleCost, titleInfo: title,
      closing: closing, extraFees: extraFeeList(), cashToClose: cashToClose, reserves: reserves, reserveMo: reserveMonths(totalLoan), liquidity: cashToClose + reserves + _sv.oopRehab + closingBuffer,
      closingBuffer: closingBuffer, closingBufferWaived: liqBufferWaived(),
      ltcPct: s.ltcPct || 0, ltvPct: s.acqLtvPct || 0, arvPct: s.arvPct || 0,
      // `d.caps` keeps the meaning every reader in this file already assumes: the
      // EFFECTIVE ceiling this deal was sized and priced at. The Silver engine now
      // publishes that as `pricedCeiling` and publishes the PROGRAM MAXIMUM (already
      // lowered to the highest band the grid actually prices) as `caps` — so the two
      // are mapped apart here, once, and no other reader in this file changes meaning
      // (engine contract split 2026-07-30).
      binding: s.binding || "", caps: R.pricedCeiling || R.caps, progCaps: R.caps, tierCaps: R.tierCaps || null,
      status: R.status, reasons: R.reasons || [],
      exitShortfall: R.exitShortfall || 0, cityReview: R.geoReview || null,
      tierLabel: R.tierLabel, fico: inp.fico, overlays: R.overlays || [], market: R.market, sizeBand: R.sizeBand
    };
  }

  /* ---------------- render ---------------- */
  function statusClass(st) { return st === "ELIGIBLE" ? "good" : st === "MANUAL" ? "warn" : "bad"; }
  function statusText(st) { return st === "ELIGIBLE" ? "Eligible" : st === "MANUAL" ? "Not eligible as-is — manual-review exception" : "Not eligible"; }
  // The CARD badge is a chip in a ~249px box; the full statusText above is 270px
  // wide on its own and used to spill out of the card (audit 2026-07-30). The card
  // keeps a SHORT label and its sub-line states the actual reason; the detail
  // panel's verdict keeps the full wording.
  function badgeText(st) { return st === "ELIGIBLE" ? "Eligible" : st === "MANUAL" ? "Manual review" : "Not eligible"; }

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
    e.textContent = badgeText(status); e.className = "pcard-badge " + statusClass(status);
  }

  /* ---- CARD ORIGINATION: whole dollars, and it can never leave the box ----
     Owner-reported 2026-07-30 ("there generation fees keeps go out of the box"):
     $27,218.75 / $28,000.00 at 1.5rem inside a ~120px stat column spilled past
     the card's right edge. Two presentation-only changes, CARD ONLY:
       cardUSD  - drops the CENTS on the card (the loan amount above it is already
                  whole-dollar, and "$28,000" is 3 characters shorter). The detail
                  panel, the PDF, the Excel export and the derivation page keep
                  YS.fmtUSD2 and their existing precision — untouched.
       fitStat  - after the text is in, step the font down a small ladder until it
                  fits. Belt-and-braces with the CSS overflow:hidden + ellipsis
                  backstop, so a longer value than any we can produce today still
                  cannot escape (same treatment as .pcard-badge). */
  function cardUSD(n) { return YS.fmtUSD(Math.round(Number(n) || 0)); }
  var FIT_IDS = ["stdRateBig", "stdOrigBig", "goldRateBig", "goldOrigBig", "silverRateBig", "silverOrigBig", "manRateBig", "manOrigBig"];
  function fitStat(e) {
    if (!e) return;
    e.removeAttribute("data-fit");
    // clientWidth 0 => the card is hidden; measuring now would shrink it wrongly.
    if (!e.clientWidth) return;
    for (var step = 1; step <= 4; step++) {
      if (e.scrollWidth <= e.clientWidth) return;
      e.setAttribute("data-fit", String(step));
    }
  }
  function fitStats() { for (var i = 0; i < FIT_IDS.length; i++) fitStat(el(FIT_IDS[i])); }

  // Populate the two headline program cards (Standard from the live calc; Gold Standard from its engine)
  // and the auto comparison note. Returns the Gold Standard result for reuse.
  function renderPrograms(d, ready) {
    var EM = "\u2014";
    // ---- Standard card ----
    var stdExit = ready && (d.exitShortfall > 0);
    var stdCity = ready && !!d.cityReview;
    var stdSized = ready && d.totalLoan > 0 && d.status !== "INELIGIBLE" && !stdExit && !stdCity;
    YS.put("stdLoanBig", (stdExit || stdCity) ? "Manual" : (stdSized ? YS.fmtUSD(d.totalLoan) : ((ready && d.status !== "INELIGIBLE") ? "$0" : EM)));
    YS.put("stdRateBig", (stdSized && d.pricingReady && d.rate > 0) ? fmtRate3(d.rate) + "%" : EM);
    YS.put("stdOrigBig", stdSized ? cardUSD(d.origFee) : EM);
    YS.put("stdOrigPts", origPtStr(liveOrigPct()));
    setBadge("stdBadge", d.status, ready);
    var stdWhy = stdExit ? shortMsg(exitMsg(d.reasons)) : (d.status !== "ELIGIBLE" ? shortReason(d.reasons) : "");
    // The card's "Max LTC" is the TIER maximum \u2014 a fixed-sounding label must carry a
    // fixed number (see tierMaxOf). It used to read `caps`, the effective ceiling,
    // which moves with the leverage slider / an admin basis (owner-reported class,
    // 2026-07-30). "This deal caps at \u2026" is the separate, honest wording when the
    // deal's own ceiling is lower.
    var stdTier = tierMaxOf(d);
    YS.put("stdSub", !ready ? "Enter price, budget & ARV to begin"
      : (stdWhy || (stdTier ? ("Max LTC " + pctLbl(stdTier.maxLTC) + (pricedBelowTier(stdTier, d.caps) ? " \u00b7 this deal caps at " + pctLbl(d.caps.maxLTC) : "") + " \u00b7 " + (d.tierLabel || "")) : "")));

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
      YS.put("goldRateBig", (gSized && G.pricingReady && G.noteRate > 0) ? fmtRate3(G.noteRate * 100) + "%" : EM);
      YS.put("goldOrigBig", gSized ? cardUSD(Math.floor(gs.totalLoan || 0) * adminOrigPct("gold")) : EM);
      YS.put("goldOrigPts", origPtStr(adminOrigPct("gold")));
      setBadge("goldBadge", G.status, ready);
      var goldWhy = goldExit ? shortMsg(exitMsg(G.reasons)) : (G.status !== "ELIGIBLE" ? shortReason(G.reasons) : "");
      YS.put("goldSub", !ready ? EM : (goldWhy || ((G.productLabel || "") + " \u00b7 " + (G.tierLabel || ""))));
    }

    // ---- Silver card ----
    var SV = (typeof SVP !== "undefined" && SVP) ? SVP : null;
    var sInp = gather(); if (silverChosenLTC) sInp.targetLTC = silverChosenLTC;
    var S = SV ? SV.evaluate(sInp) : null;
    var silverCard = el("pcardSilver");
    if (!S) {
      YS.put("silverLoanBig", EM); YS.put("silverRateBig", EM); YS.put("silverOrigBig", EM);
      setBadge("silverBadge", "UNAVAILABLE", ready);
      YS.put("silverSub", "Silver pricing unavailable");
      if (silverCard) silverCard.classList.add("pcard-off");
    } else {
      if (silverCard) silverCard.classList.remove("pcard-off");
      var ss = S.sizing || {};
      var silverExit = ready && (S.exitShortfall > 0);
      var silverGeo = ready && !!S.geoReview;
      var sSized = ready && (ss.totalLoan > 0) && S.status !== "INELIGIBLE" && !silverExit && !silverGeo;
      YS.put("silverLoanBig", silverGeo ? "Manual" : (sSized ? YS.fmtUSD(Math.floor(ss.totalLoan)) : ((ready && S.status !== "INELIGIBLE") ? "$0" : EM)));
      YS.put("silverRateBig", (sSized && S.pricingReady && S.noteRate > 0) ? fmtRate3(S.noteRate * 100) + "%" : EM);
      YS.put("silverOrigBig", sSized ? cardUSD(Math.floor(ss.totalLoan || 0) * adminOrigPct("silver")) : EM);
      YS.put("silverOrigPts", origPtStr(adminOrigPct("silver")));
      setBadge("silverBadge", S.status, ready);
      var silverWhy = silverExit ? shortMsg(exitMsg(S.reasons)) : (S.status !== "ELIGIBLE" ? shortReason(S.reasons) : "");
      // The Silver card's "Max LTC" is the engine's PROGRAM MAXIMUM (S.caps) \u2014 the tier
      // cap already lowered to the highest leverage band the rate grid genuinely prices,
      // so it is both FIXED and REACHABLE. This is the exact line the owner watched move
      // while they edited the interest reserve (2026-07-30), and it must never show the
      // raw tier row (S.tierCaps, e.g. 92.5% on GUC tier 2) which the grid never prices.
      // The step-down's ceiling for THIS deal rides beside it, plainly labelled.
      var svProg = S.caps || null, svEff = S.pricedCeiling || S.caps;
      YS.put("silverSub", !ready ? EM : (silverWhy || (svProg ? ("Max LTC " + pctLbl(svProg.maxLTC) + (pricedBelowTier(svProg, svEff) ? " \u00b7 this deal caps at " + pctLbl(svEff.maxLTC) : "") + " \u00b7 " + (S.tierLabel || "")) : (S.tierLabel || ""))));
    }

    // ---- Manual card ----
    // The Manual Program is the admin-priced scenario (tsManualOn + the custom
    // LTV/LTC/ARV/rate basis in the pricing controls). It prices on the Standard
    // engine with that basis \u2014 the SAME numbers the server records when a manual
    // product registers \u2014 so the card shows `d` (the live calc), never a program
    // engine's variant. With the manual scenario OFF the card is informational
    // (dimmed, not selectable), exactly like a not-offered Gold card.
    var mOn = manualBasisOn();
    var manCard = el("pcardManual");
    if (manCard) manCard.classList.toggle("pcard-off", !mOn);
    if (!mOn) {
      YS.put("manLoanBig", EM); YS.put("manRateBig", EM); YS.put("manOrigBig", EM);
      YS.put("manOrigPts", origPtStr(adminOrigPct("manual")));
      var mb0 = el("manBadge"); if (mb0) { mb0.textContent = "Admin-priced"; mb0.className = "pcard-badge"; }
      YS.put("manSub", manualOn()
        ? "Almost there \u2014 a Manual Program needs a custom LTV, LTC or ARV basis. Set one in the pricing controls; a rate or fee change alone registers under the chosen program (with admin approval)."
        : "A custom product priced by our team \u2014 leverage, rate and fees set case-by-case. It unlocks when a custom LTV / LTC / ARV basis is set in the pricing controls.");
    } else {
      var mSized = ready && d.totalLoan > 0 && d.status !== "INELIGIBLE";
      YS.put("manLoanBig", mSized ? YS.fmtUSD(d.totalLoan) : ((ready && d.status !== "INELIGIBLE") ? "$0" : EM));
      YS.put("manRateBig", (mSized && d.pricingReady && d.rate > 0) ? fmtRate3(d.rate) + "%" : EM);
      YS.put("manOrigBig", mSized ? cardUSD(d.origFee) : EM);
      YS.put("manOrigPts", origPtStr(adminOrigPct("manual")));
      setBadge("manBadge", d.status, ready);
      YS.put("manSub", !ready ? EM : "Manually underwritten on the admin-set basis \u2014 registers as a Manual Program and goes to an admin for approval.");
    }
    // With a STRUCTURAL manual basis set, the basis flows into EVERY engine's
    // inputs, and the server records ANY register carrying one as a Manual
    // Program priced on the Standard engine \u2014 so the three program cards can no
    // longer show what would really register. Dim them and point at the Manual
    // card; clearing the basis (or the checkbox) restores them (their own
    // availability branches above manage pcard-off when !mOn).
    var stdCard0 = el("pcardStd");
    if (stdCard0) stdCard0.classList.toggle("pcard-off", mOn);
    if (mOn) {
      var gc0 = el("pcardGold"), sc0 = el("pcardSilver");
      if (gc0) gc0.classList.add("pcard-off");
      if (sc0) sc0.classList.add("pcard-off");
      YS.put("stdSub", "Manual scenario is on \u2014 pricing is admin-set. See the Manual card.");
      YS.put("goldSub", "Manual scenario is on \u2014 see the Manual card.");
      YS.put("silverSub", "Manual scenario is on \u2014 see the Manual card.");
    }

    // ---- comparison note ----
    var note = el("progNote");
    if (note) {
      var msg = comparisonNote(d, G, S, ready);
      if (msg) { note.style.display = ""; note.innerHTML = msg; } else { note.style.display = "none"; note.innerHTML = ""; }
    }
    // Every headline stat now holds its final text — size it to the column it
    // actually got (the two stats share ~249px of card; ~105px each at 1024px).
    fitStats();
    return G;
  }

  function comparisonNote(d, G, S, ready) {
    if (!ready) return "";
    // Structural manual basis: the program comparison is meaningless (every card
    // prices on the admin-set basis and a register records a Manual Program).
    if (manualBasisOn()) return "";
    // Normalize the three programs into comparable rows.
    var progs = [
      { name: "Standard", ok: d.status !== "INELIGIBLE" && d.totalLoan > 0 && d.pricingReady, rate: (d.rate || 0) / 100, loan: d.totalLoan || 0, manual: d.status === "MANUAL" },
      { name: "Gold Standard", ok: !!(G && G.available !== false && G.status !== "INELIGIBLE" && G.sizing && G.sizing.totalLoan > 0 && G.pricingReady && G.noteRate > 0), rate: (G && G.noteRate) || 0, loan: (G && G.sizing && G.sizing.totalLoan) || 0, manual: !!(G && G.status === "MANUAL") },
      { name: "Silver", ok: !!(S && S.status !== "INELIGIBLE" && S.sizing && S.sizing.totalLoan > 0 && S.pricingReady && S.noteRate > 0), rate: (S && S.noteRate) || 0, loan: (S && S.sizing && S.sizing.totalLoan) || 0, manual: !!(S && S.status === "MANUAL") }
    ];
    var live = progs.filter(function (p) { return p.ok; });
    if (!live.length) return "";
    if (live.length === 1) {
      if (live[0].name === "Standard" && G && G.available === false)
        return "Only the <strong>Standard Program</strong> qualifies as entered \u2014 the Gold Standard isn't offered in this state.";
      return "Only the <strong>" + live[0].name + " Program</strong> qualifies as entered.";
    }
    var byRate = live.slice().sort(function (a, b) { return a.rate - b.rate; });
    var byLoan = live.slice().sort(function (a, b) { return b.loan - a.loan; });
    var parts = [];
    if (byRate.length > 1 && (byRate[1].rate - byRate[0].rate) > 0.00005)
      parts.push("<strong>" + byRate[0].name + "</strong> has the <strong>lowest rate</strong> (" + fmtRate3(byRate[0].rate * 100) + "%)");
    if (byLoan.length > 1 && (byLoan[0].loan - byLoan[1].loan) > 500)
      parts.push("<strong>" + byLoan[0].name + "</strong> lends the <strong>most</strong> (" + YS.fmtUSD(byLoan[0].loan) + ")");
    var manuals = live.filter(function (p) { return p.manual; }).map(function (p) { return p.name; });
    var tail = manuals.length ? (" The <strong>" + manuals.join("</strong> and <strong>") + "</strong> option" + (manuals.length > 1 ? "s need" : " needs") + " manual review.") : "";
    return (parts.length ? (parts.join(" \u00b7 ") + ".") : "The qualifying programs price about the same on this deal.") + tail;
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
    var isGold = chosenProgram === "gold", isSilver = chosenProgram === "silver";
    if (!ready || !chosenProgram) { wrap.style.display = "none"; return; }
    // On a manual admin exception (LTC/rate overwritten) the leverage-by-tier ladder
    // is meaningless — the admin fixed the basis, so every "tier" would show the same
    // overridden loan/rate. Hide the slider entirely (audit #13/#35).
    if (manualOn() && (adminNumRaw("tsMLtc") != null || adminNumRaw("tsMRate") != null)) { wrap.style.display = "none"; return; }
    var ladder = isGold ? goldLadder() : (isSilver ? SVP.priceLadder(gather()) : YSP.priceLadder(gather()));
    if (!ladder.eligible || !ladder.rows.length) { wrap.style.display = "none"; return; }
    var rows = ladder.rows;
    var ltcs = rows.map(function (r) { return r.ltc; });
    var chosen = isGold ? goldChosenLTC : (isSilver ? silverChosenLTC : chosenLTC);
    if (chosen && ltcs.indexOf(chosen) < 0) { if (isGold) goldChosenLTC = null; else if (isSilver) silverChosenLTC = null; else chosenLTC = null; chosen = null; }
    var effIdx = chosen ? ltcs.indexOf(chosen) : 0;
    if (effIdx < 0) effIdx = 0;
    var maxV = rows.length - 1, row = rows[effIdx];
    var slider = el("rLevSlider");
    slider.max = String(maxV);
    slider.value = String(maxV - effIdx);                         // right end = maximum leverage
    slider.disabled = rows.length <= 1;
    var lv = el("rLevVal"), hint = el("rLevHint");
    var progEl = el("rLevProg"); if (progEl) progEl.textContent = isGold ? "\u00b7 Gold Standard" : (isSilver ? "\u00b7 Silver" : (chosenProgram === "manual" ? "\u00b7 Manual" : "\u00b7 Standard"));
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
          " LTC your rate is <b>" + fmtRate3(row.noteRate * 100) + "%</b> \u2014 " + delta.toFixed(2) +
          "% below the maximum-leverage rate. Loan " + YS.fmtUSD(Math.floor(row.totalLoan)) +
          ", cash down " + YS.fmtUSD(Math.floor(row.downPayment)) + ". Drag right for more leverage.";
      }
    }
    wrap.style.display = "";
  }

  // Show the offers (cards) by default; reveal a single program's full detail when drilled into.
  function applyProgramView(ready) {
    var stdCard = el("pcardStd"), goldCard = el("pcardGold"), silverCard = el("pcardSilver"), manCard = el("pcardManual");
    if (stdCard) stdCard.classList.toggle("pcard-active", chosenProgram === "standard");
    if (goldCard) goldCard.classList.toggle("pcard-active", chosenProgram === "gold");
    if (silverCard) silverCard.classList.toggle("pcard-active", chosenProgram === "silver");
    if (manCard) manCard.classList.toggle("pcard-active", chosenProgram === "manual");
    var head = el("progDetailHead");
    if (head) head.textContent = chosenProgramName(false) + " \u2014 full breakdown";
    var lev = el("rLevWrap"); if (lev && !chosenProgram) lev.style.display = "none";   // slider shows for the drilled-in program
    var pdf = el("tsPdf"); if (pdf) pdf.textContent = "Download " + (chosenProgram === "gold" ? "Gold Standard" : chosenProgram === "silver" ? "Silver" : chosenProgram === "manual" ? "Manual Program" : "Standard") + " Term Sheet (PDF) \u2913";
    var detail = el("progDetail"); if (detail) detail.style.display = chosenProgram ? "" : "none";
    var mb = el("rManualBanner"); if (mb) mb.hidden = !(manualOn() && chosenProgram);
    var hint = el("progHint"); if (hint) hint.style.display = (ready && !chosenProgram) ? "" : "none";
  }
  function selectProgram(p) {
    // A dimmed card is not selectable: Gold when not offered in the state,
    // Silver with no engine, Manual while the admin scenario is off, and the
    // three program cards while the admin scenario is ON (a register would
    // record a Manual Program regardless of the card \u2014 see renderPrograms).
    var CARD_OF = { standard: "pcardStd", gold: "pcardGold", silver: "pcardSilver", manual: "pcardManual" };
    var card = el(CARD_OF[p]);
    if (card && card.classList.contains("pcard-off")) return;
    chosenProgram = (chosenProgram === p) ? null : p;            // tap the open program again to collapse
    recompute();
    if (chosenProgram) { var dt = el("progDetail"); if (dt && dt.scrollIntoView) { try { dt.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch (e) {} } }
  }

  function tierNudge(d) {
    if (!d || !d.tierLabel || d.status === "INELIGIBLE" || !(d.totalLoan > 0)) return "";
    var inp = d.inp || {}, isGold = !!d.gold, isSilver = !!d.silver, sc = YSP.normStrategy(inp.strategy);
    var count, thresholds, unit;
    if (isSilver) {
      // Silver tiers depend on the loan-size band: ≤$2.5M needs 3+/1–2/0 comps; over $2.5M needs 5+/2–4.
      count = (sc === "NC") ? num("expGround") : (num("expFlips") + num("expBrrrr") + num("expGround"));
      thresholds = (d.sizeBand === "L") ? [5, 2, 0] : [3, 1, 0];
      unit = (sc === "NC") ? "ground-up" : "completed";
    } else if (isGold) {
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

  /* ---- Admin pricing controls (password checked SERVER-SIDE; reveals the fields on this page) ----
     The password used to live right here, as a cyrb53 hash with the plaintext in the
     comment beside it — in a file anyone can open — and the comparison ran in the
     visitor's own browser, so it could be skipped from the console entirely. Both
     halves moved to POST /api/pricing-admin/unlock (src/routes/pricing-admin.js).
     SAME PASSWORD, and still NO login required: staff working from a shared
     term-sheet link must be able to open these controls (owner-directed).
     Unlocking reveals controls this page already has — markup and origination reach
     the tool through /api/pricing-defaults either way — so pricing math is
     identical whether or not anyone ever unlocks. */
  function checkAdminPassword(pw, cb) {
    var done = false;
    var finish = function (ok) { if (!done) { done = true; cb(ok); } };
    try {
      // Never let a slow/blocked network leave the Unlock button dead.
      var timer = setTimeout(function () { finish(false); }, 12000);
      fetch("/api/pricing-admin/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: String(pw == null ? "" : pw) })
      }).then(function (r) {
        return r.ok ? r.json().catch(function () { return null; }) : null;
      }).then(function (d) {
        clearTimeout(timer); finish(!!(d && d.ok === true));
      }).catch(function () { clearTimeout(timer); finish(false); });
    } catch (e) { finish(false); }
  }
  function adminNum(id, dflt) { var e = el(id); if (!e) return dflt; var v = parseFloat(String(e.value).replace(/,/g, "")); return (isFinite(v) && v >= 0) ? v : dflt; }
  // Build the per-tier markup map (fractions) for a program from the company
  // defaults (percents in CO.markupTiers). Returns null when nothing is set for
  // that program → the engine keeps its historic per-tier behavior for it.
  function tierMapFor(prog) {
    var src = (CO.markupTiers && CO.markupTiers[prog]) || null;
    var out = null;
    if (src) {
      for (var t = 1; t <= 3; t++) {
        var v = src[t] != null ? src[t] : src[String(t)];
        if (v != null && v !== "" && isFinite(Number(v)) && Number(v) >= 0) { out = out || {}; out[t] = Number(v) / 100; }
      }
    }
    return out;
  }
  // Read the admin markup fields (default 0.5% each) and push into every engine.
  // Item 15: ALSO push the per-experience-tier markup overlay — the company
  // per-tier defaults, plus the studio's manual GOLD top-tier field — so the
  // studio prices exactly what would register. null keeps the historic per-tier
  // behavior (Gold Tier 1 = 0). setMarkupTiers is set on EVERY sync (never left
  // stale), so an unconfigured studio prices byte-for-byte as before.
  function syncAdminMarkup() {
    var std = adminNum("tsYspStd", CO.markupStd), gold = adminNum("tsYspGold", CO.markupGold), silver = adminNum("tsYspSilver", CO.markupSilver);
    try { if (typeof YSP !== "undefined" && YSP.setMarkup) YSP.setMarkup(std / 100); } catch (e) {}
    try { if (typeof GSP !== "undefined" && GSP && GSP.setMarkup) GSP.setMarkup(gold / 100); } catch (e) {}
    try { if (typeof SVP !== "undefined" && SVP && SVP.setMarkup) SVP.setMarkup(silver / 100); } catch (e) {}
    var stdT = tierMapFor("standard"), goldT = tierMapFor("gold"), silvT = tierMapFor("silver");
    // The studio's manual Gold top-tier field overlays the company default for Gold Tier 1.
    var goldT1 = adminNumRaw("tsYspGoldT1");
    if (goldT1 != null) { goldT = goldT || {}; goldT[1] = goldT1 / 100; }
    try { if (typeof YSP !== "undefined" && YSP.setMarkupTiers) YSP.setMarkupTiers(stdT); } catch (e) {}
    try { if (typeof GSP !== "undefined" && GSP && GSP.setMarkupTiers) GSP.setMarkupTiers(goldT); } catch (e) {}
    try { if (typeof SVP !== "undefined" && SVP && SVP.setMarkupTiers) SVP.setMarkupTiers(silvT); } catch (e) {}
  }
  // Admin fee/origination overrides. Defaults reproduce current behavior exactly.
  // MANUAL has its own knob (owner-reported 2026-07-30: "we don't have a word to
  // enter origination fee for the manual program"). It falls back to the STANDARD
  // company default when blank, exactly like its three siblings — a blank field
  // always means "use the company default", never 0.
  function adminOrigPct(prog) {
    if (prog === "gold") return adminNum("tsOrigGold", CO.origGold) / 100;
    if (prog === "silver") return adminNum("tsOrigSilver", CO.origSilver) / 100;
    // MANUAL falls back to the STANDARD KNOB AS RESOLVED — the Standard FIELD if
    // the staffer typed one, else the company default. NOT the bare company
    // default: that is what the server does (pricing.js `origKey` picks
    // origManualPct only when it is really present, else origStdPct), and the
    // card must never print a percentage the registration will not use. Audit
    // 2026-07-30: with Standard=2.0 typed and the manual field seeded to the
    // company 1.25, the card said 1.25 while the pre-existing contract (and every
    // already-registered file) prices that manual product at 2.0.
    if (prog === "manual") { var m = adminNumRaw("tsOrigManual"); if (m != null) return m / 100; }
    return adminNum("tsOrigStd", CO.origStd) / 100;
  }  // fraction
  // The live calc (`d`) always runs the STANDARD engine — but with a STRUCTURAL
  // manual basis set the file registers as a Manual Program (the server's
  // manual-program.resolveProgram), so its origination comes from the Manual knob.
  // ONE helper, so the calc, the Standard + Manual cards, the detail rows, the
  // PDF, the Excel and the derivation page can never disagree about which
  // percentage priced `d`.
  function liveOrigPct() { return adminOrigPct(manualBasisOn() ? "manual" : "standard"); }
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
    s("tsYspStd", String(CO.markupStd)); s("tsYspGold", String(CO.markupGold)); s("tsYspSilver", String(CO.markupSilver));
    s("tsOrigStd", String(CO.origStd)); s("tsOrigGold", String(CO.origGold)); s("tsOrigSilver", String(CO.origSilver));
    // tsOrigManual is DELIBERATELY NOT SEEDED. Its three siblings have a company
    // default of their own, so seeding them writes back exactly what the server
    // would have used anyway. The Manual knob's default is "whatever Standard
    // resolves to", which is NOT a fixed number — seeding it with CO.origStd
    // froze a stale copy of Standard onto the register payload, so a Standard
    // override of 2.0% silently registered a Manual Program at 1.25% and the
    // approval card named a percentage that did not govern (audit 2026-07-30).
    // Blank is the contract everywhere: studio (adminOrigPct), payload
    // (buildInputs skips ''), approval detector (hasValue false).
    s("tsFeeUW", String(CO.lender)); s("tsFeeCredit", String(CO.credit)); s("tsFeeAppr", String(CO.appraisal));
    if (CO.title != null) s("tsFeeTitle", String(CO.title));
    syncManualOrigHint();
  }
  // Show the staffer WHICH number a blank Manual field will actually use — it
  // tracks the Standard field, not a fixed literal.
  function syncManualOrigHint() {
    var e = el("tsOrigManual"); if (!e) return;
    try { e.placeholder = String(adminNum("tsOrigStd", CO.origStd)); } catch (_) { /* cosmetic only */ }
  }
  function manualOn() { var e = el("tsManualOn"); return !!(e && e.checked); }
  // A STRUCTURAL manual basis (custom LTV / LTC / ARV) is what actually makes a
  // register record a Manual Program — the server's manual-program.resolveProgram
  // flips on the structural keys only; a rate-only override or the bare checkbox
  // keeps the requested program (with an admin-approval escalation). The Manual
  // CARD lights, the program cards dim, and the drill-in auto-switches on THIS
  // predicate, never on the checkbox alone (audit 2026-07-30 #2).
  function manualBasisOn() {
    return manualOn() && (adminNumRaw("tsMLtv") != null || adminNumRaw("tsMArv") != null || adminNumRaw("tsMLtc") != null);
  }

  /* ---- Term-sheet options (owner-directed 2026-07-22) ----
     DISPLAY / record-only attributes layered ON TOP of the frozen engine — none
     of these change any sized number, rate, cap, fee, cash-to-close or the
     liquidity to show. gather() still feeds the engine accrual:"Non-Dutch"
     unchanged (byte-identical pricing); the values below only drive what the
     term sheet PRINTS and what the register snapshot saves. */
  // 3-month minimum earned interest: OFF by default on Standard & Gold (an admin
  // adds it per program); ON by default on a MANUAL / custom scenario (an admin
  // may turn it off). prog = "standard" | "gold"; a manual scenario overrides.
  function minInterestOn(prog) {
    if (manualOn()) { var e = el("tsMinIntManual"); return e ? !!e.checked : true; }
    return (prog === "gold") ? chk("tsMinIntGold") : (prog === "silver") ? chk("tsMinIntSilver") : chk("tsMinIntStd");
  }
  // Accrual type — Non-Dutch / As-Drawn by default; admin may switch to Dutch /
  // Full-Boat. Label + saved field only (the engine input stays Non-Dutch).
  function accrualType() { var e = el("tsAccrual"); var v = e ? String(e.value || "").toLowerCase() : ""; return v.indexOf("dutch") === 0 ? "dutch" : "non_dutch"; }
  function accrualLabel(t) { t = t || accrualType(); return t === "dutch" ? "Dutch / Full-Boat" : "Non-Dutch / Drawn"; }
  function accrualDetail(t) { t = t || accrualType(); return t === "dutch"
    ? "Dutch / Full-Boat interest: interest accrues on the entire committed loan amount from closing, including construction funds not yet drawn."
    : "Non-Dutch / As-Drawn interest: interest accrues only on the amount actually advanced and outstanding; the interest-bearing balance increases with each construction draw."; }
  // Deferred origination fee — a % of the loan paid at EXIT (payoff). NEVER part
  // of cash-to-close or the liquidity to show. Default 0.
  function deferredOrigPct() { var e = el("tsDeferredOrig"); if (!e) return 0; var v = parseFloat(String(e.value).replace(/,/g, "")); return (isFinite(v) && v > 0) ? Math.min(100, v) : 0; }   // percent, 1 = 1%
  // Co-borrower personal-guaranty WAIVER (owner-directed 2026-07-22). By DEFAULT
  // both the borrower and the co-borrower personally guarantee the loan (full
  // recourse). A super-admin APPROVED exception waives the co-borrower's guaranty —
  // they stay a member of the borrowing entity but are not a guarantor. This is a
  // READ-ONLY flag set on the file (never a free studio toggle); it arrives as the
  // coBorrowerPgWaived input value ("true"/"1"). Meaningful only with a co-borrower.
  function pgWaived() { var e = el("coBorrowerPgWaived"); if (!e) return false; var v = String(e.value == null ? e.checked : e.value).toLowerCase(); return v === "true" || v === "1" || v === "on" || v === "yes"; }
  // Compose the guaranty / recourse wording — mirrors src/lib/term-options.js
  // guarantySummary() so the printed sheet and the server email agree.
  function guarantyInfo() {
    var b = (val("borrowerName") || "").trim();
    var co = (val("coBorrowerName") || "").trim();
    var hasCo = !!co;
    var waived = pgWaived() && hasCo;
    var guarantors = waived ? [b].filter(Boolean) : [b, co].filter(Boolean);
    var list = guarantors.join(" & ");
    var jointly = guarantors.length > 1 ? ", jointly and severally," : "";
    var recourseLine, disclosure;
    if (waived) {
      recourseLine = list
        ? ("Full recourse. Personally guaranteed by " + list + " only. " + co + " is a member of the borrowing entity but is not a personal guarantor (approved exception).")
        : ("Full recourse. " + co + " is a member of the borrowing entity but is not a personal guarantor (approved exception).");
      disclosure = "This is a full-recourse loan. " + (list || "The primary borrower") + " shall execute an unconditional, continuing personal guaranty of the Loan. " + co + ", although a member of the borrowing entity, is not required to execute a personal guaranty and shall be a non-guarantor member (this guaranty waiver was granted by an approved lender exception).";
    } else {
      recourseLine = list ? ("Full recourse. Personally guaranteed" + jointly + " by " + list + ".") : "Full recourse. A personal guaranty is required.";
      disclosure = guarantors.length > 1
        ? ("This is a full-recourse loan. Repayment and performance of all obligations shall be personally guaranteed, jointly and severally, by " + list + " under an unconditional and continuing guaranty. Each guarantor may be pursued for the entire balance, not only a pro-rata share.")
        : ("This is a full-recourse loan. Repayment and performance of all obligations shall be personally guaranteed by " + (list || "the borrower") + " under an unconditional and continuing guaranty.");
    }
    return { hasCo: hasCo, waived: waived, guarantors: guarantors, list: list, coName: co, recourseLine: recourseLine, disclosure: disclosure, coSignerRole: waived ? "Co-borrower / member (non-guarantor)" : "Co-borrower / guarantor" };
  }
  // Draw fee by program (owner-directed 2026-07-22). Gold: physical only, $250.
  // Standard AND Silver (a copy of the Standard housekeeping defaults,
  // owner-confirmed 2026-07-29): hybrid $299 / physical $499. Display only.
  function drawFeeLines(prog) {
    return (prog === "gold")
      ? ["$250 per draw — physical inspection only (no virtual inspections)"]
      : ["$299 per draw — hybrid inspection", "$499 per draw — physical inspection"];
  }
  // Full-precision percent (owner-directed 2026-07-22): the EXACT figure, up to 2
  // decimals with trailing zeros trimmed (87.5 stays 87.5, 70 stays 70, 83.33
  // keeps both places) — never rounded to a whole number. Display only.
  function pcFull(x) { var v = Math.round((x || 0) * 100 * 100) / 100; var s = v.toFixed(2).replace(/\.?0+$/, ""); return s + "%"; }

  /* ==================================================================
     TWO DIFFERENT TRUTHS ABOUT "MAX LEVERAGE" — never one number
     ------------------------------------------------------------------
     Owner-reported 2026-07-30 (Silver, ground-up refinance, tier 2): "the Max LTV
     keeps changing when I change the interest reserve — if I make the reserve 18
     months it's max 65 LTC, if I make the interest 12 months it's max 74.99 LTC …
     the Max LTC should never change, each tier has its own Max LTC … it shouldn't
     change based on what you're changing the interest reserve."

     The owner is right, and the tier maximum is even higher than they thought:
     for this product/purpose/tier the workbook's Tier Grid says 92.5%, fixed.

     ROOT CAUSE: every surface printed the engine's `caps`, which is the EFFECTIVE
     ceiling AFTER the Silver engine's grid-aware step-down has lowered it to reach
     a priced cell. A financed interest reserve is part of the COST BASIS, so
     changing it moves the deal into a different priced band, which moves the
     step-down's effective cap — and a label promising the PROGRAM maximum moved
     while the borrower edited a reserve. The same class also showed up wherever a
     voluntary de-leverage (the slider) or an admin basis narrowed `caps`.

     THE FIX IS TO SAY BOTH THINGS, SEPARATELY:
       tier — the PROGRAM/TIER maximum. Fixed for this product | purpose | tier.
              Never moves when a deal input moves. This is what the label
              "Program maximum leverage — from FICO & experience" must show.
       eff  — the most THIS deal can be priced at. May be lower; gets its own
              clearly-labelled line and says WHY.

     WHERE `tier` COMES FROM, per program (always the ENGINE, never a copy of the
     numbers here, so the display can never drift from the guideline):
       Silver   — `R.tierCaps`, the engine's read-only passthrough of its own
                  Tier Grid row. It is the ONLY reliable source here: the
                  step-down is driven by the deal, so it cannot be stripped by
                  nulling an input.
       Standard — `YSP.caps(regime, loanType, strategyCode, tier)`, the engine's
                  own published matrix lookup.
       Gold     — Gold publishes no tier lookup and has NO step-down, so its caps
                  move only with the slider / an admin basis. Re-evaluating with
                  exactly those stripped is therefore exact. A genuine program
                  overlay (the adverse-market reduction, which Gold already
                  escalates about) deliberately stays INSIDE the program maximum —
                  it is a market guideline, not a deal-input artifact.
     PURE DISPLAY: nothing here computes, rounds or re-derives a cap. ================================================================== */
  function tierMaxOf(d) {
    if (!d) return null;
    var R = d.R;
    // SILVER publishes it directly: the engine's `caps` IS the program maximum, already
    // lowered to the highest band the rate grid genuinely prices. NEVER read `tierCaps`
    // here — that is the raw workbook row (92.5% on GUC tier 2), a leverage the grid
    // never prices and therefore exactly the unreachable number we are removing.
    if (d.silver) return d.progCaps || (R && R.caps) || null;
    if (d.gold) {
      var GS = (typeof GSP !== "undefined" && GSP) ? GSP : null;
      if (!GS || !R || !R.caps) return (R && R.caps) || null;
      try {
        // strip ONLY the borrower's/admin's own narrowing — never a program rule
        var bare = GS.evaluate(Object.assign({}, d.inp, { targetLTC: 0, ovrAcqLTV: 0, ovrARLTV: 0, ovrLTC: 0 }));
        return (bare && bare.caps) || R.caps;
      } catch (e) { return R.caps; }
    }
    if (!R || !R.caps) return null;
    try {
      var row = YSP.caps(R.regime, R.loanType, R.strategyCode, R.tier);
      return row || R.caps;
    } catch (e2) { return R.caps; }
  }
  // Is the deal's own priced ceiling BELOW the program maximum on any leverage axis?
  function pricedBelowTier(tier, eff) {
    if (!tier || !eff) return false;
    return (eff.maxLTC < tier.maxLTC - 1e-9) || (eff.maxARLTV < tier.maxARLTV - 1e-9) || (eff.maxAcqLTV < tier.maxAcqLTV - 1e-9);
  }
  /* The plain-language reason THIS deal's ceiling sits under the tier maximum.
     The Silver engine already writes the sentence (reason code `leverage_capped`)
     — we print the engine's own words so the explanation can never disagree with
     the number it explains. Everything else is named from what is actually
     engaged, in the order a reader would want it. Never invents a reason. */
  function pricedWhy(d, tier, eff) {
    var out = [];
    var rs = (d && d.reasons) || [];
    for (var i = 0; i < rs.length; i++) if (rs[i] && rs[i].code === "leverage_capped") out.push(rs[i].msg);
    if (!out.length) {
      // the sq-ft overlay (Standard purchase F&F) states itself in the reasons too
      for (var j = 0; j < rs.length; j++) {
        var m = (rs[j] && rs[j].msg) || "";
        if (/square feet|sq\.? ?ft/i.test(m) && /leverage|loan-to-cost|LTC/i.test(m)) { out.push(m); break; }
      }
    }
    var ovrOn = (adminNumRaw("tsMLtc") != null || adminNumRaw("tsMLtv") != null || adminNumRaw("tsMArv") != null);
    var chosen = d && d.silver ? silverChosenLTC : (d && d.gold ? goldChosenLTC : chosenLTC);
    if (ovrOn) out.push("An approved exception sets the leverage basis for this deal, so it is priced on that basis rather than the program maximum.");
    else if (chosen && eff && tier && eff.maxLTC < tier.maxLTC - 1e-9)
      out.push("You have chosen to take less leverage than the program allows (the leverage slider), which is what lowered this deal's ceiling.");
    if (!out.length) out.push("On this deal the program prices a lower leverage band than the tier maximum. The tier maximum itself has not changed.");
    out.push("The program maximum above is set by the tier (your FICO and experience) and does not change when you change the deal — including the interest reserve.");
    return out.join(" ");
  }

  /* ---- why the initial advance is smaller than "max % x purchase price" ----
     On a PURCHASE the engine sizes the acquisition advance on the LOWER of the
     (effective) purchase price and the as-is value — standard-program.js sizeLoan's
     `acqDenom`, which the Gold engine reuses, which is why this reads identically on
     both programs. When the appraised as-is value comes in under the price THAT is the
     base, so the advance lands well below "max % x price" with nothing on screen saying
     why (owner-reported 2026-07-28: 90% read as 90% of $545,600 = $491,040, not 90% of
     the $515,000 as-is = $463,500). Returns "" when there is nothing to explain — the
     price is the base, a refinance (always sized on the as-is value by definition), or a
     figure is missing. PURE DISPLAY: every number is read back out of the engine's own
     sizing result; nothing is computed, rounded or re-derived here. */
  function advanceBasisNote(d) {
    var s = (d && d.R && d.R.sizing) || null;
    if (!s || !s.purchase) return "";
    var aiv = +s.aiv || 0, price = +s.pp || 0;
    if (!(aiv > 0) || !(price > 0) || aiv >= price - 0.5) return "";
    var capPct = (d.caps && d.caps.maxAcqLTV > 0) ? pcFull(d.caps.maxAcqLTV) : "";
    // On a capped assignment `s.pp` IS the effective price the engine sized on — label it
    // as such so this never contradicts the "Effective purchase price" row above it.
    var priceLbl = (d.asg && d.asg.overLimit) ? "effective purchase price" : "purchase price";
    return "<b>Sized on the as-is value, not the price.</b> The appraised as-is value (" + YS.fmtUSD(aiv) +
      ") came in below the " + priceLbl + " (" + YS.fmtUSD(price) + "), and the initial advance is capped at " +
      (capPct ? capPct : "the program maximum") + " of the <b>lower</b> of the two — so it is " +
      (capPct ? capPct : "that maximum") + " of the as-is value, not of the price.";
  }

  /* ---- estimated key dates (interest-only fix & flip convention) ----
     First payment = the 1st of the SECOND month after closing (close anytime in
     July -> first payment Sept 1; the stub/per-diem interest from closing to
     month-end is collected at closing). Maturity = the Nth scheduled payment
     counted FROM the first payment = first payment + (term - 1) months, so a
     12-payment loan matures on its 12th payment, never a 13th. Dates are kept as
     calendar Y/M/D triples (never a parsed date string) to avoid any tz drift. */
  function parseYMD(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "").trim()); if (!m) return null; var y = +m[1], mo = +m[2], d = +m[3]; if (mo < 1 || mo > 12 || d < 1 || d > 31) return null; return { y: y, mo: mo, d: d }; }
  function daysInMonth(y, mo) { return new Date(y, mo, 0).getDate(); }   // mo 1-12
  function addMonthsYMD(o, add) { var t = (o.y * 12 + (o.mo - 1)) + add; var ny = Math.floor(t / 12), nm = (t % 12) + 1; return { y: ny, mo: nm, d: Math.min(o.d, daysInMonth(ny, nm)) }; }
  function estClosingYMD() { return parseYMD(val("estClosingDate")); }
  function firstPaymentYMD(close) { close = close || estClosingYMD(); if (!close) return null; return addMonthsYMD({ y: close.y, mo: close.mo, d: 1 }, 2); }
  function maturityYMD(fp, term) { if (!fp) return null; var t = (term || 12); return addMonthsYMD(fp, t - 1); }
  function fmtDateLong(o) { if (!o) return ""; return new Date(o.y, o.mo - 1, o.d).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }); }

  function wireAdmin() {
    var trig = el("tsAdminTrigger"), lock = el("tsAdminLock"), panel = el("tsAdminPanel"),
        pw = el("tsAdminPw"), go = el("tsAdminGo"), err = el("tsAdminErr"), hide = el("tsAdminHide");
    if (!trig) return;
    function openLock() { if (lock) lock.hidden = false; if (panel) panel.hidden = true; trig.setAttribute("aria-expanded", "true"); if (err) err.hidden = true; if (pw) { pw.value = ""; pw.focus(); } }
    var checking = false;   // one request at a time (the unlock route is rate-limited)
    function attempt() {
      if (!pw || checking) return;
      checking = true;
      if (go) { go.disabled = true; }
      if (err) err.hidden = true;
      checkAdminPassword(pw.value, function (ok) {
        checking = false;
        if (go) { go.disabled = false; }
        if (ok) { if (lock) lock.hidden = true; if (panel) panel.hidden = false; trig.hidden = true; if (err) err.hidden = true; pw.value = ""; }
        else { if (err) err.hidden = false; if (pw.select) pw.select(); }
      });
    }
    function setVal(id, v) { var e = el(id); if (e) e.value = v; }
    function manualVis() {
      var on = manualOn();
      var mf = el("tsManualFields"), mh = el("tsManualHint"); if (mf) mf.hidden = !on; if (mh) mh.hidden = !on;
      // The "3-month minimum interest" choice differs by scenario: manual shows the
      // ON-by-default toggle you can turn OFF; Standard/Gold show the OFF-by-default
      // add-it checkboxes.
      var mm = el("tsMinIntManualRow"), pp = el("tsMinIntProgRow"); if (mm) mm.hidden = !on; if (pp) pp.hidden = on;
    }
    function lockDown() {
      if (panel) panel.hidden = true; if (lock) lock.hidden = true; trig.hidden = false; trig.setAttribute("aria-expanded", "false");
      setVal("tsYspStd", String(CO.markupStd)); setVal("tsYspGold", String(CO.markupGold)); setVal("tsYspSilver", String(CO.markupSilver)); setVal("tsOrigStd", String(CO.origStd)); setVal("tsOrigGold", String(CO.origGold)); setVal("tsOrigSilver", String(CO.origSilver)); setVal("tsOrigManual", "");   // blank = follow Standard (it has no default of its own)
      setVal("tsYspGoldT1", "");   // blank = Gold top tier keeps its normal (0 / company-default) markup
      setVal("tsFeeUW", String(CO.lender)); setVal("tsFeeCredit", String(CO.credit)); setVal("tsFeeAppr", String(CO.appraisal)); setVal("tsFeeTitle", CO.title != null ? String(CO.title) : "");
      var mo = el("tsManualOn"); if (mo) mo.checked = false;
      setVal("tsMLtv", ""); setVal("tsMArv", ""); setVal("tsMLtc", ""); setVal("tsMRate", ""); setVal("tsMIr", "");
      // Reset the term-sheet options to their defaults: Non-Dutch accrual, no
      // deferred fee, min-interest OFF for Standard/Gold and ON for manual.
      setVal("tsAccrual", "non_dutch"); setVal("tsDeferredOrig", "");
      var mis = el("tsMinIntStd"); if (mis) mis.checked = false;
      var mig = el("tsMinIntGold"); if (mig) mig.checked = false;
      var misv = el("tsMinIntSilver"); if (misv) misv.checked = false;
      var mim = el("tsMinIntManual"); if (mim) mim.checked = true;
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
    syncManualOrigHint();          // a blank Manual field hints the Standard value it will use
    updateConditionals();
    var miss = missingFields();
    var ready = miss.length === 0;                                // all required fields present
    // A structural manual basis coming ON makes the Manual card the only
    // registrable product — move a program drill-in over to it FIRST (before
    // the leverage slider and the detail deal are drawn, audit 2026-07-30 #4),
    // so no tick renders a Gold/Silver ladder under a Manual head. The detail
    // then shows the Standard-engine calc on the admin basis — exactly what a
    // register records.
    if (manualBasisOn() && chosenProgram && chosenProgram !== "manual") chosenProgram = "manual";
    if (chosenProgram === "manual" && !manualBasisOn()) chosenProgram = null;   // basis cleared → collapse to the offers view
    renderLeverage(ready);                                        // clamp chosenLTC + draw the Standard slider
    var dStd = calc();                                            // Standard, priced at the chosen leverage
    renderPrograms(dStd, ready);                                  // both offer cards + comparison note
    var d = dStd;                                                 // detail renders the program you drilled into
    if (chosenProgram === "gold") { var gd = calcGold(); if (!gd || gd.unavailable) chosenProgram = null; else d = gd; }
    else if (chosenProgram === "silver") { var svd = calcSilver(); if (!svd || svd.unavailable) chosenProgram = null; else d = svd; }
    applyProgramView(ready);                                      // show/hide the detail; slider only for Standard
    var sized = ready && d.totalLoan > 0 && d.status !== "INELIGIBLE";
    // The dollar box shows the reserve the loan CARRIES for the program in view (never a
    // months x payment estimate) and names that program — the reserve is per-program and
    // the Excel prints one section per program (owner-reported 2026-07-30).
    syncIrMirror(d, sized, chosenProgramName(false));
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
    // The initial advance is capped at the program's max as-is % of the LOWER of the (effective)
    // purchase price and the as-is value. When the as-is value is the lower one the advance reads
    // far below "max % x price" and nothing on the row said why (owner-reported 2026-07-28) — so
    // the badge names the base and a short note explains it. Display only: every figure is read
    // back out of the engine's own sizing result; no number is computed or changed here.
    var advWhy = advanceBasisNote(d);
    var advLtvEl = el("rAdvanceLtv"); if (advLtvEl) advLtvEl.textContent = (sized && d.pricingReady && d.ltvPct > 0 && d.initialAdvance > 0) ? (pcFull(d.ltvPct) + (advWhy ? " of as-is value" : " LTV")) : "";
    var advWhyEl = el("rAdvanceWhy");
    if (advWhyEl) {
      var showWhy = sized && d.pricingReady && d.initialAdvance > 0 && !!advWhy;
      advWhyEl.style.display = showWhy ? "" : "none";
      advWhyEl.innerHTML = showWhy ? advWhy : "";
    }
    YS.put("rHoldback", sized ? YS.fmtUSD(d.rehabHoldback) : EM);
    var hbTag = el("rHoldbackTag"); if (hbTag) hbTag.textContent = (d.R && d.R.sizing && d.R.sizing.rehabOverCap) ? "(capped \u2014 see eligibility)" : ((sized && d.oopRehab > 0) ? "(financed portion, in draws)" : "(= rehab, in draws)");
    YS.put("rRate", (sized && d.rate > 0) ? fmtRate3(d.rate) + "%" : EM);
    // two interest-only payment lines: initial-advance payment + fully-drawn payment
    YS.put("rPmtInit", (sized && d.initialPayment > 0) ? YS.fmtUSD(d.initialPayment) + "/mo" : EM);
    YS.put("rPmtFull", (sized && d.fullPayment > 0) ? YS.fmtUSD(d.fullPayment) + "/mo" : EM);
    YS.put("rTerm", d.term + " mo");
    YS.put("rLtc", (sized && d.ltcPct) ? pcFull(d.ltcPct) : EM);
    YS.put("rArv", (sized && d.arvPct) ? pcFull(d.arvPct) : EM);
    YS.put("rLtv", (sized && d.ltvPct) ? pcFull(d.ltvPct) : EM);
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
    /* ON-SCREEN refinance cash-to-close, matching the PDF: hide the purchase
       "Down payment" row on a refi, and on a RATE-AND-TERM show the existing-loan
       payoff and the funds advanced so the visible line items sum to the shown
       cash-to-close (the PDF/xlsx already reconcile; the panel did not). A cash-out
       shows neither row — cash-to-close is $0 and the "cash to you" figure lives in
       the refinance note below (owner-directed 2026-08-04). */
    (function () {
      var refi = isRefi(), rt = refi && !isCashOut() && num("payoff") > 0;
      var row = function (wrapId, valId, show, v) {
        var w = el(wrapId); if (!w) return;
        w.style.display = show ? "" : "none";
        if (show && valId) YS.put(valId, v);
      };
      row("rDownWrap", null, !refi);
      row("rRefiPayoffWrap", "rRefiPayoff", sized && rt, YS.fmtUSD(num("payoff")));
      row("rRefiAdvWrap", "rRefiAdv", sized && rt, "−" + YS.fmtUSD(fundedAtClose(d)));
    })();
    YS.put("rLiquidity", sized ? YS.fmtUSD2(d.liquidity) : EM);
    // 1% closing-cost buffer inside the liquidity to show (owner-authorized
    // 2026-07-31) — the amount, or "Waived" when the portal host waived it.
    YS.put("rLiqBuffer", !sized ? EM : (d.closingBufferWaived ? "Waived" : YS.fmtUSD2(d.closingBuffer || 0)));
    YS.put("rTier", d.tierLabel || EM);
    YS.put("rFico", d.fico ? String(d.fico) : EM);
    // Out-of-pocket rehab exception (owner-authorized 2026-07-31): the OOP row in the
    // loan structure (shown ONLY when an amount is applied), and the two figures the
    // Manual/admin zone shows first — how much the initial is being cut, and the max
    // out-of-pocket rehab that an exception could allow.
    (function () {
      var w = el("rOopWrap");
      if (w) { if (sized && d.oopRehab > 0) { w.style.display = ""; YS.put("rOopRehab", YS.fmtUSD(d.oopRehab)); } else { w.style.display = "none"; } }
      YS.put("oopInitialCut", sized ? YS.fmtUSD(d.initialCut || 0) : EM);
      YS.put("oopMaxRehab", sized ? YS.fmtUSD(d.maxOopRehab || 0) : EM);
      var info = el("oopInfoWrap");
      if (info) info.style.display = (sized && d.pricingReady && (d.maxOopRehab || 0) > 0) ? "" : "none";
    }());

    // PROGRAM / TIER maximum leverage (from FICO + experience) — FIXED for the tier.
    // This block must NEVER move when a deal input moves (owner-reported 2026-07-30:
    // it was showing the effective post-step-down ceiling, so editing the interest
    // reserve appeared to change the tier's own Max LTC). See tierMaxOf().
    var c = tierMaxOf(d) || d.caps;
    YS.put("rMaxLtc", (ready && c) ? pcFull(c.maxLTC) : EM);
    YS.put("rMaxLtv", (ready && c) ? pcFull(c.maxAcqLTV) : EM);
    YS.put("rMaxArv", (ready && c) ? pcFull(c.maxARLTV) : EM);
    YS.put("rMaxLoan", (ready && c) ? YS.fmtUSD(c.maxLoan) : EM);
    // ...and, on its OWN clearly-labelled line, the most THIS deal can be priced at,
    // with the engine's own sentence saying why it is lower. Hidden when the deal
    // reaches the tier maximum, so a clean deal shows one number and no caveat.
    (function () {
      var wrap = el("rPricedWrap"); if (!wrap) return;
      var eff = d.caps, lower = ready && !!c && pricedBelowTier(c, eff);
      wrap.style.display = lower ? "" : "none";
      if (!lower) return;
      YS.put("rPricedLtc", pcFull(eff.maxLTC));
      YS.put("rPricedArv", pcFull(eff.maxARLTV));
      var w = el("rPricedWhy"); if (w) w.textContent = pricedWhy(d, c, eff);
    }());

    // ---- term-sheet options: live key dates, accrual, min-interest, deferred
    // origination fee, draw fee (owner-directed 2026-07-22). Display/record only. ----
    var _prog = progOf(d);
    var _close = estClosingYMD(), _fp = firstPaymentYMD(_close), _mat = maturityYMD(_fp, d.term);
    var kdWrap = el("rKeyDates");
    if (kdWrap) {
      if (_close) {
        kdWrap.style.display = "";
        YS.put("rEstClosing", fmtDateLong(_close));
        YS.put("rFirstPayment", _fp ? fmtDateLong(_fp) : EM);
        YS.put("rMaturity", _mat ? fmtDateLong(_mat) : EM);
      } else { kdWrap.style.display = "none"; }
    }
    YS.put("rAccrual", accrualLabel());
    var _mi = minInterestOn(_prog);
    YS.put("rMinInt", _mi ? "3 months (minimum earned interest — not a prepayment penalty)" : "Not included");
    var _def = deferredOrigPct();
    var defWrap = el("rDeferredWrap");
    if (defWrap) { if (_def > 0) { defWrap.style.display = ""; YS.put("rDeferred", pcFull(_def / 100) + " of the loan, paid at payoff (exit fee)"); } else { defWrap.style.display = "none"; } }
    var _isBridge = YSP.normStrategy(d.inp && d.inp.strategy) === "BR";
    var dfRow = el("rDrawFeeRow");
    if (dfRow) dfRow.style.display = _isBridge ? "none" : "";   // a bridge / as-is loan has no construction draws
    if (!_isBridge) YS.put("rDrawFee", drawFeeLines(_prog).join(" · "));

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

    // ---- exception / manual-review request (ineligible scenario or pricing
    // problem) — collects the visitor's contact info and submits straight to
    // our team through the backend; never opens the visitor's mail client ----
    var needsManual = ready && (d.status === "INELIGIBLE" || (d.status === "MANUAL"));
    var mbtn = el("rManualWrap");
    if (mbtn) {
      if (needsManual) {
        mbtn.style.display = "";
        var lead = d.status === "INELIGIBLE"
          ? "This scenario falls outside the standard program as entered."
          : "This scenario needs a manual underwrite.";
        if (!mbtn.querySelector("#rManualBtn")) {
          mbtn.innerHTML = "<p class=\"tmv-lead\">" + lead + " You can send it to our team for a manual review.</p>" +
            "<button class=\"btn btn-outline\" id=\"rManualBtn\" type=\"button\">Request an exception / manual review</button>";
        } else {
          var mlead = mbtn.querySelector(".tmv-lead");
          if (mlead) mlead.textContent = lead + " You can send it to our team for a manual review.";
        }
        var mb = el("rManualBtn"); if (mb) mb.onclick = function () { openExceptionAsk(d); };
      } else { mbtn.style.display = "none"; mbtn.innerHTML = ""; }
    }

    // ---- interest-reserve notes: term cap and/or leverage cap ----
    var irn = el("rIRnote");
    if (irn) {
      var notes = [];
      if (ready && d.R.reserveTermCapped) {
        if (d.R.reserveCapIsConstruction) {
          notes.push("<strong>Construction interest reserve capped at 75% of the full term (" + (Math.round(d.R.reserveTermMonths * 10) / 10) + " months).</strong> You requested " + (irRequestText() || (d.irMonths + " months")) +
            "; a construction reserve is financed up to 75% of the term's interest, so it covers " + (Math.round(d.R.reserveTermMonths * 10) / 10) + " months.");
        } else {
          notes.push("<strong>Interest reserve capped at the loan term (" + d.R.reserveTermMonths + " months).</strong> You requested " + (irRequestText() || (d.irMonths + " months")) +
            ", but a reserve can't finance more interest than the loan runs \u2014 so it covers " + (Math.round(d.R.reserveTermMonths * 10) / 10) + " months.");
        }
      }
      if (ready && d.reserveCapped && d.maxReserve >= 0) {
        notes.push("<strong>Maximum eligible interest reserve: " + YS.fmtUSD(d.maxReserve) +
          "</strong> (\u2248 " + (d.maxReserveMonths).toFixed(1) + " months). " + d.reserveCapBy +
          " limits the reserve further; the maximum eligible amount has been applied and the remainder isn't eligible to finance. " +
          "This loan finances <strong>" + YS.fmtUSD(d.financedIR) + "</strong> \u2014 the figure in the reserve box, the structure above, the term sheet and the export.");
      }
      if (notes.length) { irn.style.display = ""; irn.innerHTML = notes.join("<br><br>"); }
      else { irn.style.display = "none"; irn.innerHTML = ""; }
    }
    var resn = el("rResNote");
    // The buffer phrase rides the explanatory line (owner-authorized 2026-07-31):
    // "+ a 1% closing-cost buffer" normally, "buffer waived" when the host waived it.
    var bufPhrase = d.closingBufferWaived ? " (closing-cost buffer waived)" : " plus a 1% closing-cost buffer";
    if (resn) resn.textContent = d.gold
      ? ("Liquidity to show \u2248 cash to close plus " + Math.round((d.liquidityPct || 0.05) * 100) + "% of the loan amount" + bufPhrase + " \u2014 a reserve you demonstrate, not funds brought to closing.")
      : ("Liquidity to show \u2248 cash to close plus " + d.reserveMo + " months of interest" + bufPhrase + " \u2014 a reserve you demonstrate, not funds brought to closing.");
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
        var refiTxt = d.gold
          ? "<strong>Refinance types.</strong> A rate-&-term refi takes essentially no cash to you. A cash-out refi \u2014 cash to you over the lesser of $20,000 or 2% of the loan \u2014 is capped by the program leverage or 100% of verified hard costs; cash over $250,000 requires an escalation review."
          : d.silver
          ? "<strong>Refinance types.</strong> A rate-&-term refi takes no cash to you. Cash-out proceeds are capped at 50% of the total projected project profit; interest reserves are netted from cash-out proceeds; a stabilized refi needs the borrower current on all payments and taxes."
          : "<strong>Refinance types.</strong> A rate-&-term refi takes no cash to you (proceeds at or under 2% of the loan). A cash-out refi \u2014 proceeds over 2% of the loan \u2014 is capped at $50,000 cash to the borrower.";
        /* WHAT THE BORROWER ACTUALLY WALKS AWAY WITH (owner-directed 2026-07-31:
           "on cash out then you should have also how much the cash out is
           afterwards after the payoff and the closing cost. And obviously for rate
           and term there's no cash out just payoff").
           The old line stopped at "before closing costs", which is the number
           nobody can use \u2014 the borrower asks what they RECEIVE. Closing costs are
           already computed by the frozen calc (d.closing); subtracting them here is
           display arithmetic on figures the engine produced, not a pricing change.
           A rate-&-term refinance is defined by taking essentially no cash, so it
           states the payoff and stops \u2014 quoting a "cash to you" figure there would
           invite exactly the cash-out the structure is not. */
        if (payoff > 0) {
          // cashOutOfRecord (typed override, else structural) — the SAME figure the
          // PDF and the cash-out box print, so the on-screen note can never show a
          // different "cash to you" than the sheet (owner-directed 2026-08-04).
          var netOut = cashOutOfRecord(d);
          refiTxt += " On this deal, the new loan of " + YS.fmtUSD(d.totalLoan) + " pays off " + YS.fmtUSD(payoff) + payoffWhoTxt() + ".";
          if (isCashOut()) {
            refiTxt += " Of that loan, " + YS.fmtUSD(fundedAtClose(d)) + " funds at the closing table; after the payoff and " + YS.fmtUSD(d.closing || 0) + " of closing costs, cash to you \u2248 <strong>" + YS.fmtUSD(netOut) + "</strong>.";
          }
        }
        rfn.style.display = ""; rfn.innerHTML = refiTxt;
      } else { rfn.style.display = "none"; rfn.innerHTML = ""; }
    }

    /* The cash-out box SHOWS ITS WORK. The placeholder carries the structural
       figure so an untouched box is never a mystery, and the help line says
       whether the number in play is the officer's or the structure's — the
       officer should never have to guess which one the term sheet will print. */
    var coEl = el("cashOutAmt"), coHelp = el("cashOutAmtHelp");
    if (coEl && isRefi() && isCashOut()) {
      var structural = structuralCashOut(d);
      coEl.placeholder = structural > 0 ? YS.fmtUSD(structural) : "auto — from the structure";
      if (coHelp) {
        // Blank-aware, so a deliberate 0 reports as YOUR number rather than
        // silently reading as an untouched box (same rule as cashOutOfRecord).
        var typedCo = YS.opt("cashOutAmt");
        /* The working shown is the ADVANCE AT CLOSING, not the whole loan — on a
           renovation refinance the rehab holdback funds later in draws, so the
           whole loan is not what the borrower walks away with. */
        var derivTxt = "advance at closing " + YS.fmtUSD(fundedAtClose(d)) +
          " − payoff " + YS.fmtUSD(num("payoff")) + " − closing " + YS.fmtUSD(d.closing || 0);
        coHelp.textContent = (typedCo !== null && typedCo >= 0)
          ? ("You entered " + YS.fmtUSD(typedCo) + ". The structure implies " + YS.fmtUSD(structural) +
             " (" + derivTxt + ").")
          : (structural > 0
            ? ("From the structure: " + derivTxt + " = " + YS.fmtUSD(structural) + ". Type a number to override it.")
            : "Enter the payoff above and this fills in from the structure.");
      }
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
  /* ---------- OUR OWN COPY FIRST, the outside hosts only as a backup -------
     Owner-directed 2026-08-03. These two loaders reached for a CDN and NOTHING
     ELSE — so a jsdelivr/unpkg outage, or an officer whose corporate network
     blocks public file hosts, lost the term sheet PDF, the proof-of-funds
     letter AND the Excel export in one go, on a browser that was plainly
     online and already talking to us. The vendored copies have been sitting in
     tools/vendor/ the whole time; the Scope of Work and Track Record tools
     have always tried them first. This makes the term sheet behave the same.
     If the page loaded, the engine loads — no second host has to be up.
     Versions are unchanged: vendor/jspdf.umd.min.js IS the pinned 2.5.1, and
     vendor/xlsx.bundle.js is the same xlsx-js-style 1.2.0 build the other two
     tools already load in production. termsheet.js uses no autoTable, so
     jsPDF alone is enough here.                                            */
  async function loadFirst(srcs, ready, what) {
    if (ready()) return;
    for (var i = 0; i < srcs.length; i++) {
      // A source that 404s AND one that loads but defines nothing both fall
      // through to the next — only "the library is actually here" stops us.
      try { await loadScript(srcs[i]); } catch (e) { continue; }
      if (ready()) return;
    }
    throw new Error(what + " failed to load");
  }
  var haveJsPDF = function () { return !!(window.jspdf && window.jspdf.jsPDF); };
  var haveXLSX = function () { return !!(window.XLSX && window.XLSX.utils); };
  async function ensurePDF() {
    await loadFirst([
      "vendor/jspdf.umd.min.js",                                        // ours
      "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js",
      "https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js"
    ], haveJsPDF, "pdf library");
  }
  async function ensureXLSX() {
    await loadFirst([
      "vendor/xlsx.bundle.js",                                          // ours
      "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js",
      "https://unpkg.com/xlsx-js-style@1.2.0/dist/xlsx.bundle.js"
    ], haveXLSX, "spreadsheet library");
  }
  // Visible deal summary for the Excel export: inputs + both programs' headline results.
  /* Excel: the two leverage TRUTHS as two rows. The export used to carry only the
     deal's ACHIEVED leverage and no cap at all, so a reader could not tell the tier
     maximum from what this deal happens to price at — the same confusion the owner
     hit on screen (2026-07-30). The tier row is always present; the priced-ceiling
     row appears only when it is genuinely lower, and states why in the same cell. */
  function xlsxTierMaxRow(dd, pct) {
    var t = dd ? tierMaxOf(dd) : null;
    if (!t) return null;
    return ["Program maximum — LTC / as-is / ARV — fixed, does not change with the deal",
            pct(t.maxLTC) + " / " + pct(t.maxAcqLTV) + " / " + pct(t.maxARLTV)];
  }
  function xlsxPricedRow(dd, pct) {
    var t = dd ? tierMaxOf(dd) : null;
    if (!t || !dd.caps || !pricedBelowTier(t, dd.caps)) return null;
    return ["Most this deal can be priced at — LTC / ARV",
            pct(dd.caps.maxLTC) + " / " + pct(dd.caps.maxARLTV) + "  —  " + pricedWhy(dd, t, dd.caps)];
  }

  function xlsxSections() {
    var d = calc();
    var gd = calcGold();                                   // full Gold object: slider- + override-connected
    var EM = "\u2014", pct = function (x) { return x ? pcFull(x) : EM; };   // full-precision, trailing zeros trimmed \u2014 byte-identical to the on-screen / PDF leverage figures (owner-directed 2026-07-22)
    var statusLabel = function (st) { return st === "ELIGIBLE" ? "Eligible" : st === "MANUAL" ? "Not eligible as-is — manual-review exception" : "Not eligible"; };
    var deal = [
      ["Loan purpose", purpose()], ["Strategy / program", dealType()],
      ["Property state", val("propState") || EM],
      ["Property type", val("propType") === "2-4" ? "2-4 units" : "Single-family"],
      ["Property address", chk("addrTBD") ? "To be determined" : (val("propAddr") || EM)],
      ["Borrower / entity", borrowerOfRecord() || EM]
    ];
    var costs = [
      // A REFINANCE has no purchase price — it is sized on the as-is value (shown on
      // the next row). Every other surface (studio detail, PDF, deal-profile) drops
      // the purchase-price row on a refi; the xlsx alone kept it, and because `price`
      // is not cleared on switching to refinance it could print a stale figure
      // (owner-directed 2026-08-04).
      isRefi() ? null : ["Purchase price", num("price") ? money(num("price")) : EM],
      ["Construction / rehab budget", money(num("construction"))],
      ["As-is value", num("asIs") ? money(num("asIs")) : EM],
      ["After-repair value (ARV)", num("arv") ? money(num("arv")) : EM],
      ["Requested term (months)", String(num("tsTerm") || 12)],
      // What was ASKED FOR (source field only). What each program actually FINANCES is a
      // row inside that program's own section below — the reserve is per-program.
      ["Interest reserve requested", irRequestText() || "None"],
      ["Estimated FICO", num("fico") ? String(num("fico")) : EM],
      ["Experience (flips / holds / ground-up)", num("expFlips") + " / " + num("expBrrrr") + " / " + num("expGround")],
      (function () { var c = estClosingYMD(); return ["Estimated closing date", c ? fmtDateLong(c) : EM]; })(),
      (function () { var c = estClosingYMD(), fp = firstPaymentYMD(c); return ["First payment date (estimated)", fp ? fmtDateLong(fp) : EM]; })(),
      (function () { var c = estClosingYMD(), fp = firstPaymentYMD(c), mt = maturityYMD(fp, num("tsTerm") || 12); return ["Maturity date (estimated)", mt ? fmtDateLong(mt) : EM]; })(),
      deferredOrigPct() > 0 ? ["Deferred origination fee (paid at payoff)", pcFull(deferredOrigPct() / 100)] : null
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
      ["Note rate", (stdOk && d.rate > 0) ? fmtRate3(d.rate) + "%" : EM],
      minInterestOn("standard") ? ["Minimum interest", MIN_INTEREST_ROW] : null,
      ["Interest accrual", accrualLabel()],
      (YSP.normStrategy(dealType()) === "BR") ? null : ["Draw fee", drawFeeLines("standard").join("; ")],
      ["Initial advance", stdOk ? money(d.initialAdvance) : EM],
      ["Rehab / construction holdback", stdOk ? money(d.rehabHoldback) : EM],
      (stdOk && d.oopRehab > 0) ? ["Out-of-pocket rehab (funded over construction)", money(d.oopRehab)] : null,
      // The reserve THIS program finances — the reconciled figure the studio box, the PDF,
      // the derivation page and the registration all carry. It is NOT months x payment, and
      // it differs per program, which is why every section states its own (2026-07-30).
      ["Financed interest reserve", stdOk ? money(d.financedIR) : EM],
      isRefi() ? null : ["Down payment (equity)", stdOk ? money(d.downPayment) : EM],
      ["Leverage \u2014 LTC / as-is / ARV", stdOk ? (pct(d.ltcPct) + " / " + pct(d.ltvPct) + " / " + pct(d.arvPct)) : EM],
      xlsxTierMaxRow(d, pct), xlsxPricedRow(d, pct),
      ["Origination (" + origPctStr((d.origPct != null ? d.origPct : 0.0125)) + ")", (stdOk && d.totalLoan) ? money2(d.origFee) : EM],
      ["UW / processing / legal", stdOk ? money2(d.lenderFee) : EM],
      ["Credit report", stdOk ? money2(d.creditFee) : EM],
      ["Appraisal (est., POC)", stdOk ? money2(d.apprFee) : EM],
      ["Title / escrow (est.)", (stdOk && d.titleCost > 0) ? money2(d.titleCost) : EM],
      ["Estimated cash to close", stdOk ? money2(d.cashToClose) : EM],
      // 1% closing-cost buffer feeding the liquidity-to-show total (owner-authorized 2026-07-31)
      stdOk ? ["Closing cost buffer (1% of loan amount)", d.closingBufferWaived ? "Waived" : money2(d.closingBuffer || 0)] : null,
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
        ["Note rate", (gOk && gd.rate > 0) ? fmtRate3(gd.rate) + "%" : EM],
        minInterestOn("gold") ? ["Minimum interest", MIN_INTEREST_ROW] : null,
        ["Interest accrual", accrualLabel()],
        (YSP.normStrategy(dealType()) === "BR") ? null : ["Draw fee", drawFeeLines("gold").join("; ")],
        ["Initial advance", gOk ? money(gd.initialAdvance) : EM],
        ["Rehab / construction holdback", gOk ? money(gd.rehabHoldback) : EM],
        (gOk && gd.oopRehab > 0) ? ["Out-of-pocket rehab (funded over construction)", money(gd.oopRehab)] : null,
        ["Financed interest reserve", gOk ? money(gd.financedIR) : EM],
        isRefi() ? null : ["Down payment (equity)", gOk ? money(gd.downPayment) : EM],
        ["Leverage \u2014 LTC / as-is / ARV", gOk ? (pct(gd.ltcPct) + " / " + pct(gd.ltvPct) + " / " + pct(gd.arvPct)) : EM],
        xlsxTierMaxRow(gd, pct), xlsxPricedRow(gd, pct),
        ["Origination (" + origPctStr((gd.origPct != null ? gd.origPct : 0.0125)) + ")", (gOk && gd.totalLoan) ? money2(gd.origFee) : EM],
        ["UW / processing / legal", gOk ? money2(gd.lenderFee) : EM],
        ["Credit report", gOk ? money2(gd.creditFee) : EM],
        ["Appraisal (est., POC)", gOk ? money2(gd.apprFee) : EM],
        ["Title / escrow (est.)", (gOk && gd.titleCost > 0) ? money2(gd.titleCost) : EM],
        ["Estimated cash to close", gOk ? money2(gd.cashToClose) : EM],
        // 1% closing-cost buffer feeding the liquidity-to-show total (owner-authorized 2026-07-31)
        gOk ? ["Closing cost buffer (1% of loan amount)", gd.closingBufferWaived ? "Waived" : money2(gd.closingBuffer || 0)] : null,
        ["Liquidity to show", gOk ? money2(gd.liquidity) : EM]
      ];
    }
    // Extra company fees (NY settlement etc.) as their own line, inserted before
    // "Estimated cash to close" so the Excel fee list adds up to cash-to-close just
    // like the on-screen panel and the PDF (audit 2026-07-19 — Excel was the only
    // surface that folded the fee into the total without naming it).
    if (stdOk && d.extraFees && d.extraFees.length) {
      var si = std.findIndex(function (r) { return r && r[0] === "Estimated cash to close"; });
      if (si > -1) Array.prototype.splice.apply(std, [si, 0].concat(d.extraFees.map(function (f) { return [f.name, money2(f.amount)]; })));
    }
    if (gd && !gd.unavailable && gOk && gd.extraFees && gd.extraFees.length) {
      var gi = gold.findIndex(function (r) { return r && r[0] === "Estimated cash to close"; });
      if (gi > -1) Array.prototype.splice.apply(gold, [gi, 0].concat(gd.extraFees.map(function (f) { return [f.name, money2(f.amount)]; })));
    }
    // ---- Silver Program section (same shape as the Standard block) ----
    var sd = calcSilver();
    var silver;
    if (!sd) { silver = [["Availability", "Silver pricing unavailable"]]; }
    else {
      var sExit = sd.exitShortfall > 0, sGeo = !!sd.cityReview, sOk = !sExit && !sGeo && sd.pricingReady && sd.status !== "INELIGIBLE" && sd.totalLoan > 0;
      silver = [
        ["Status", statusLabel(sd.status)],
        ["Loan amount", (sExit || sGeo) ? "Manual review" : (sOk && sd.totalLoan ? money(sd.totalLoan) : EM)],
        ["Note rate", (sOk && sd.rate > 0) ? fmtRate3(sd.rate) + "%" : EM],
        minInterestOn("silver") ? ["Minimum interest", MIN_INTEREST_ROW] : null,
        ["Interest accrual", accrualLabel()],
        (YSP.normStrategy(dealType()) === "BR") ? null : ["Draw fee", drawFeeLines("silver").join("; ")],
        ["Initial advance", sOk ? money(sd.initialAdvance) : EM],
        ["Rehab / construction holdback", sOk ? money(sd.rehabHoldback) : EM],
        (sOk && sd.oopRehab > 0) ? ["Out-of-pocket rehab (funded over construction)", money(sd.oopRehab)] : null,
        ["Financed interest reserve", sOk ? money(sd.financedIR) : EM],
        isRefi() ? null : ["Down payment (equity)", sOk ? money(sd.downPayment) : EM],
        ["Leverage — LTC / as-is / ARV", sOk ? (pct(sd.ltcPct) + " / " + pct(sd.ltvPct) + " / " + pct(sd.arvPct)) : EM],
        xlsxTierMaxRow(sd, pct), xlsxPricedRow(sd, pct),
        ["Origination (" + origPctStr((sd.origPct != null ? sd.origPct : 0.0125)) + ")", (sOk && sd.totalLoan) ? money2(sd.origFee) : EM],
        ["UW / processing / legal", sOk ? money2(sd.lenderFee) : EM],
        ["Credit report", sOk ? money2(sd.creditFee) : EM],
        ["Appraisal (est., POC)", sOk ? money2(sd.apprFee) : EM],
        ["Title / escrow (est.)", (sOk && sd.titleCost > 0) ? money2(sd.titleCost) : EM],
        ["Estimated cash to close", sOk ? money2(sd.cashToClose) : EM],
        // 1% closing-cost buffer feeding the liquidity-to-show total (owner-authorized 2026-07-31)
        sOk ? ["Closing cost buffer (1% of loan amount)", sd.closingBufferWaived ? "Waived" : money2(sd.closingBuffer || 0)] : null,
        ["Liquidity to show", sOk ? money2(sd.liquidity) : EM]
      ];
      if (sOk && sd.extraFees && sd.extraFees.length) {
        var svi = silver.findIndex(function (r) { return r && r[0] === "Estimated cash to close"; });
        if (svi > -1) Array.prototype.splice.apply(silver, [svi, 0].concat(sd.extraFees.map(function (f) { return [f.name, money2(f.amount)]; })));
      }
    }
    // REFINANCE: reconcile each block's fee list to cash-to-close by naming the
    // existing-loan payoff and the funds advanced at closing (owner-directed
    // 2026-08-04) — otherwise a refi's fees sum to closing costs while cash-to-close
    // includes the payoff shortfall, which looks like an error.
    if (isRefi() && !isCashOut() && num("payoff") > 0) {
      [[std, d, stdOk], [gold, gd, (gd && !gd.unavailable && gOk)], [silver, sd, (sd && sOk)]].forEach(function (pr) {
        var rows = pr[0], dd = pr[1], ok = pr[2];
        if (!ok || !dd) return;
        var i = rows.findIndex(function (r) { return r && r[0] === "Estimated cash to close"; });
        if (i > -1) Array.prototype.splice.apply(rows, [i, 0].concat([
          ["Existing loan payoff", money(num("payoff"))],
          ["Less funds advanced at closing (initial advance)", "−" + money(fundedAtClose(dd))]
        ]));
      });
    }
    // Some rows are conditional (min-interest, deferred fee) and come through as
    // null — drop them so the Excel writer never dereferences a null pair.
    // With a structural manual basis engaged, the "Standard" block IS the Manual
    // Program's pricing (the manual product prices on the Standard engine with
    // the admin basis) — title it honestly so the export never claims a Standard
    // registration the server wouldn't record.
    var stdTitle = manualBasisOn() ? "Manual Program (admin-set basis)" : "Standard Program";
    return [{ title: "Deal & property", items: deal.filter(Boolean) }, { title: isRefi() ? "Property & project costs" : "Purchase & project costs", items: costs.filter(Boolean) },
            { title: stdTitle, items: std.filter(Boolean) }, { title: "Gold Standard Program", items: gold.filter(Boolean) },
            { title: "Silver Program", items: silver.filter(Boolean) }];
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
      // Per-export identity (owner-directed 2026-07-31): the unique term-sheet
      // id + the exact export date & time, same as the PDF footer carries.
      var xlsId = tsIdNew(), xlsStamp = tsExportStamp();
      titleRow("Generated " + xlsStamp + "   \u00b7   " + xlsId + "   \u00b7   NMLS ID 2609746", INK, "C9A86A", 9);
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
      // Same sales/officer heads-up as the PDF download — an Excel term sheet is
      // a generated term sheet too. Only for a priced deal (no noise for a
      // half-filled scenario); best-effort, never blocks the export.
      try {
        // Skip entirely in the embedded portal studio (notifyGeneration would
        // refuse anyway — this just avoids serializing the workbook for nothing).
        var dX = EMBEDDED ? null : calcChosen();
        if (dX && (dX.pricingReady || dX.totalLoan > 0)) {
          notifyGeneration(dX, "Term sheet (Excel)", {
            dataBase64: X.write(wb, { bookType: "xlsx", type: "base64" }),
            filename: fileStem() + ".xlsx",
            contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          });
        }
      } catch (e) {}
    } catch (e) { flash("Excel export failed. Refresh the page and try again \u2014 if it keeps happening, tell the team."); }
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
  /* ---------- a value that must fit a fixed slot, never silently lost -------
     Owner-directed 2026-08-03, alongside the Scope of Work address fix. The
     proof-of-funds summary box and the derivation page each wrapped a value to
     its slot and then drew ONLY vlines[0] \u2014 so a long property line lost its
     city / state / ZIP with nothing on the page to say so. Same family as the
     SOW overlap (a value that does not fit its slot), different symptom: the
     tail was dropped rather than painted over the neighbour.
     The value now STACKS: the break is taken at the FIRST comma (the street /
     city-state-ZIP seam), after shrinking a half point at a time so most
     addresses still fit on one line. Capped at TWO lines and ellipsis-clamped
     past that, because both surfaces are fixed-height pages \u2014 an unbounded
     grow would push the signature block (or the next section) off the sheet,
     and a visible "..." still beats a silent drop.
     A value that ALREADY FITS comes back unchanged at its original size, so
     every term sheet that lays out correctly today is byte-for-byte unchanged.
     Byte-identical in web/tools and web/v2/tools (guarded by
     scripts/test-termsheet-slot-fit-pure.js).                              */
  function fitSlotLines(doc, val, maxW, font, style, size, minSize, maxLines) {
    var set = function (s) { doc.setFont(font, style); doc.setFontSize(s); };
    var fs = size; set(fs);
    if (doc.getTextWidth(val) <= maxW) return { fs: fs, lines: [val] };
    var c = val.indexOf(",");
    var parts = c > 0 ? [val.slice(0, c).trim(), val.slice(c + 1).trim()] : [val];
    var tooWide = function () { for (var i = 0; i < parts.length; i++) if (doc.getTextWidth(parts[i]) > maxW) return true; return false; };
    while (fs > minSize && tooWide()) { fs -= 0.5; set(fs); }
    var lines = [];
    for (var p = 0; p < parts.length; p++) doc.splitTextToSize(parts[p], maxW).forEach(function (w) { lines.push(w); });
    var cap = maxLines || 2;
    if (lines.length > cap) lines = lines.slice(0, cap - 1).concat([lines.slice(cap - 1).join(" ")]);
    for (var k = 0; k < lines.length; k++) {                    // a run with no break point can still overflow
      if (doc.getTextWidth(lines[k]) <= maxW) continue;
      var t = lines[k];
      while (t.length > 1 && doc.getTextWidth(t + "...") > maxW) t = t.slice(0, -1);
      lines[k] = t + "...";
    }
    return { fs: fs, lines: lines };
  }
  function flash(msg) {
    var t = el("ts-toast"); if (!t) { t = document.createElement("div"); t.id = "ts-toast"; t.className = "ys-toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show"); clearTimeout(flash._t); flash._t = setTimeout(function () { t.classList.remove("show"); }, 2800);
  }
  function fileStem() {
    var nm = (borrowerOfRecord() || "Applicant").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Applicant";
    return "YS_Term_Sheet_" + nm + "_" + new Date().toISOString().slice(0, 10);
  }
  function money(n) { return YS.fmtUSD(n); } function money2(n) { return YS.fmtUSD2(n); }

  /* ---------------- provenance + export identity (owner-directed 2026-07-31) ----------------
     Every term sheet PDF carries a stamp saying HOW it was generated and whether
     it is INITIAL or FINAL. The portal hosts set window.TS_PROVENANCE
     ({kind:'website'|'borrower_portal'|'officer'|'file'|'file_final'|'portal'});
     when absent the tool self-derives: standalone officer link -> 'officer',
     plain public site -> 'website', embedded with no context -> 'portal'. */
  var PROV_COPY = {
    website:         { title: "WEBSITE ESTIMATE",      sub: "Generated from the YS Capital website" },
    borrower_portal: { title: "BORROWER PORTAL DRAFT", sub: "Self-generated in the borrower portal" },
    officer:         { title: "OFFICER PREPARED",      sub: "Generated by a YS Capital loan officer" },
    portal:          { title: "PORTAL GENERATED",      sub: "Generated in the PILOT portal" },
    file:            { title: "ACTIVE LOAN FILE",      sub: "Generated from an active loan file — Products & Pricing" },
    file_final:      { title: "FINAL TERM SHEET",      sub: "Issued for signature — all clearances complete" }
  };
  function provKind() {
    try { var p = window.TS_PROVENANCE; if (p && p.kind && PROV_COPY[p.kind]) return p.kind; } catch (e) {}
    if (!EMBEDDED) return window.YSBRAND ? "officer" : "website";
    return "portal";
  }
  // Unique per-export term-sheet id: TS-<epoch base36>-<4 random base36>, uppercase.
  function tsIdNew() {
    var A = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ", r = "";
    for (var i = 0; i < 4; i++) r += A.charAt(Math.floor(Math.random() * 36));
    return "TS-" + Date.now().toString(36).toUpperCase() + "-" + r;
  }
  // Exact export date AND time with timezone (the desk's clock — New York).
  function tsExportStamp() {
    try {
      return new Date().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" });
    } catch (e) { return new Date().toLocaleString("en-US"); }
  }

  async function exportPdf(btn, returnBlob) {
    // Open fatal appraisal findings HOLD term-sheet generation (owner-directed
    // 2026-07-31): the portal host sets window.TS_ISSUE_HOLD with the reason.
    if (window.TS_ISSUE_HOLD) { flash(String(window.TS_ISSUE_HOLD)); return; }
    var label = btn ? btn.textContent : ""; if (btn) { btn.textContent = "Building term sheet\u2026"; btn.disabled = true; }
    try {
      await ensurePDF();
      syncAdminMarkup();
      var d = calcChosen();
      var progName = chosenProgramName(true);
      var isBridge = d.inp && YSP.normStrategy(d.inp.strategy) === "BR";   // bridge: as-is only, no rehab/ARV/reserve
      var jsPDF = window.jspdf.jsPDF;
      var doc = new jsPDF({ unit: "pt", format: "letter", orientation: "portrait" });
      var W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 40;
      var INK = [20, 27, 34], TEAL = [47, 127, 134], GOLD = [174, 135, 70], GRAY = [75, 88, 92], DARK = [20, 27, 34], LINE = [223, 216, 203];
      var today = new Date(), exp = new Date(today.getTime() + 14 * 864e5);
      var fmtD = function (dt) { return dt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }); };
      var money = function (n) { return YS.fmtUSD(n); }; var money2 = function (n) { return YS.fmtUSD2(n); };
      var pc = function (x) { var v = Math.round((x || 0) * 100 * 100) / 100; return v.toFixed(2).replace(/\.?0+$/, "") + "%"; };   // exact figure, up to 2 decimals, trailing zeros trimmed (owner-directed 2026-07-22 — never round to a whole number)
      var sized = d.pricingReady && d.totalLoan > 0 && d.status !== "INELIGIBLE";
      var stTxt = d.status === "ELIGIBLE" ? "Eligible" : d.status === "MANUAL" ? "Eligible \u2014 manual underwrite" : "Not eligible as entered";
      var pillC = d.status === "ELIGIBLE" ? [120, 168, 132] : d.status === "MANUAL" ? [176, 140, 70] : [184, 96, 74];
      // Provenance + export identity \u2014 computed ONCE per export (owner-directed
      // 2026-07-31); header()/footer() read them on every page.
      var provK = provKind(), provFinal = provK === "file_final";
      var tsId = tsIdNew(), tsStamp = tsExportStamp();

      function header() {
        doc.setFillColor.apply(doc, INK); doc.rect(0, 0, W, 76, "F");
        doc.setFillColor.apply(doc, GOLD); doc.rect(0, 76, W, 2.2, "F");
        doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.5); doc.line(0, 79.4, W, 79.4);   // fine warm hairline beneath the gold rule
        var lg = logoData(); if (lg) { var h = 30, w = lg.w * (h / lg.h); try { doc.addImage(lg.dataURI, "PNG", M, 23, w, h); } catch (e) {} }
        doc.setTextColor(244, 240, 231); doc.setFont("times", "bold"); doc.setFontSize(18); doc.text(provFinal ? "Final Term Sheet" : "Preliminary Term Sheet", W - M, 35, { align: "right" });
        doc.setFont("times", "italic"); doc.setFontSize(9.5); doc.setTextColor(174, 135, 70); doc.text(progName + " \u00b7 business-purpose bridge financing", W - M, 51, { align: "right" });
        doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(176, 184, 186);
        doc.text(LENDER.name + " \u00b7 NMLS " + LENDER.nmls + " \u00b7 Issued " + fmtD(today), W - M, 65, { align: "right", charSpace: 0.3 });
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
        // Term-sheet identity line on EVERY page (owner-directed 2026-07-31):
        // Initial/Final + the unique id + the exact export date & time.
        doc.setFontSize(6); doc.setTextColor.apply(doc, GRAY);
        doc.text(pdfSafe((provFinal ? "Final" : "Initial") + " term sheet \u00b7 " + tsId + " \u00b7 Exported " + tsStamp), W - M, H - 14, { align: "right" });
      }
      function brk(need) { if (y + need > H - 54) { footer(); doc.addPage(); header(); y = 92; } }
      function cardHead(x, w, title, yy) {
        doc.setFillColor.apply(doc, TEAL); doc.roundedRect(x, yy, w, 17, 2.5, 2.5, "F");
        doc.setFillColor.apply(doc, GOLD); doc.rect(x + 4, yy + 4, 2.2, 9, "F");   // gold accent tab
        doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(255, 255, 255);
        doc.text(pdfSafe(title.toUpperCase()), x + 11, yy + 11.5, { charSpace: 0.6 }); return yy + 23;
      }
      /* Measure-first row engine (owner-reported 2026-07-31: a wrapping key —
         "construction holdback is being capped" — ran into the line below).
         The VALUE is measured at its own font first; a value wider than 60% of
         the row steps its size down half a point at a time (never below 6.5pt)
         so it can never collide leftward into the key. The KEY then wraps
         inside the room the value actually leaves and the row grows by the
         measured height — divider and accent band included. A single-line row
         advances exactly the legacy 14.4 (rowIn) / 15 (rowFull), so every
         non-wrapping card is laid out identically to before. */
      function fitValue(vTxt, size, budget) {
        doc.setFont("helvetica", "bold"); doc.setFontSize(size);
        var vw = doc.getTextWidth(vTxt);
        while (vw > budget && size > 6.5) { size = Math.max(6.5, Math.round((size - 0.5) * 10) / 10); doc.setFontSize(size); vw = doc.getTextWidth(vTxt); }
        return { size: size, width: vw };
      }
      function rowIn(x, w, k, v, yy, opts) {
        opts = opts || {};
        var vTxt = pdfSafe(String(v));
        var vFit = fitValue(vTxt, opts.bold ? 8.7 : 7.9, w * 0.6);
        // Key budget = the room the value leaves (2pt insets + an 8pt gutter),
        // clamped to [38%, 62%] of the row — a long value can't silently
        // under-run the key's budget, a short one can't let the key crowd it.
        var keyMax = Math.max(w * 0.38, Math.min(w * 0.62, w - 4 - vFit.width - 8));
        var kSize = opts.bold ? 8.5 : 7.9;
        doc.setFont("helvetica", opts.bold ? "bold" : "normal"); doc.setFontSize(kSize);
        var kLines = doc.splitTextToSize(pdfSafe(k), keyMax);
        var lineH = kSize * 1.15;   // jsPDF line height (factor 1.15): ~9.1 @7.9pt, ~9.8 @8.5pt bold
        var adv = kLines.length > 1 ? Math.max(14.4, kLines.length * lineH + 5.3) : 14.4;
        if (opts.accent) { doc.setFillColor(248, 245, 238); doc.rect(x, yy - 1.5, w, adv - 0.8, "F"); }   // soft ivory band behind headline totals — as tall as the measured row
        doc.setFont("helvetica", opts.bold ? "bold" : "normal"); doc.setFontSize(kSize);
        doc.setTextColor.apply(doc, GRAY); doc.text(kLines, x + 2, yy + 8);
        doc.setFont("helvetica", "bold"); doc.setFontSize(vFit.size);
        doc.setTextColor.apply(doc, opts.accent ? GOLD : DARK); doc.text(vTxt, x + w - 2, yy + 8, { align: "right" });
        yy += adv; doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.4); doc.line(x + 2, yy - 3.4, x + w - 2, yy - 3.4); return yy;   // divider under the LAST line
      }
      function band(t) { brk(30); doc.setFillColor.apply(doc, TEAL); doc.roundedRect(M, y, W - 2 * M, 17, 2.5, 2.5, "F"); doc.setFillColor.apply(doc, GOLD); doc.rect(M + 4, y + 4, 2.2, 9, "F"); doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(255, 255, 255); doc.text(pdfSafe(t.toUpperCase()), M + 11, y + 11.5, { charSpace: 0.6 }); y += 23; }
      function rowFull(k, v, opts) {
        opts = opts || {};
        var vTxt = pdfSafe(String(v));
        var fw = W - 2 * M;
        var vFit = fitValue(vTxt, 8.6, fw * 0.6);
        // Key wraps in the room the value leaves (3pt insets + a 10pt gutter);
        // floored at 25% of the row so a pathological value can't zero the key.
        var keyMax = Math.max(fw * 0.25, fw - 6 - vFit.width - 10);
        doc.setFont("helvetica", opts.bold ? "bold" : "normal"); doc.setFontSize(8.4);
        var kLines = doc.splitTextToSize(pdfSafe(k), keyMax);
        var lineH = 8.4 * 1.15;   // ~9.7
        var adv = kLines.length > 1 ? Math.max(15, kLines.length * lineH + 5.3) : 15;
        brk(adv + 1);   // break BEFORE drawing when the measured row would cross the page bottom (mirrors para)
        doc.setFont("helvetica", opts.bold ? "bold" : "normal"); doc.setFontSize(8.4);
        doc.setTextColor.apply(doc, GRAY); doc.text(kLines, M + 3, y + 8);
        doc.setFont("helvetica", "bold"); doc.setFontSize(vFit.size);
        doc.setTextColor.apply(doc, opts.accent ? GOLD : DARK); doc.text(vTxt, W - M - 3, y + 8, { align: "right" });
        y += adv; doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.4); doc.line(M + 3, y - 3.5, W - M - 3, y - 3.5);   // divider under the LAST line
      }
      function para(t, size, lead) { var ls = doc.splitTextToSize(pdfSafe(t), W - 2 * M - 6); var lh = lead || (size === 7 ? 9 : 10.5); brk(ls.length * lh + 4); doc.setFont("helvetica", "normal"); doc.setFontSize(size || 8); doc.setTextColor(70, 78, 82); doc.text(ls, M + 3, y + 8); y += ls.length * lh + 6; }

      // A dedicated, high-end DISCLOSURES page placed BEFORE the signature page
      // (owner-directed 2026-07-22). Everything a term sheet needs for our
      // attorneys/legal to analyze the structure — business-purpose,
      // due diligence, title, legal fees, insurance, the accrual definition, the
      // (conditional) minimum-interest + deferred-fee items, the general
      // disclaimer and the indemnification. Same warm ink/gold system as the
      // rest of the document. Called only on a signable (eligible) sheet.
      function disclosuresPage() {
        footer();   // footer the page we're leaving (T&C paras) — every page carries the disclaimer line
        doc.addPage(); header(); y = 92;
        doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.setTextColor.apply(doc, DARK);
        doc.text("Disclosures & conditions", M, y);
        doc.setDrawColor.apply(doc, GOLD); doc.setLineWidth(1.3); doc.line(M, y + 5.5, M + 42, y + 5.5);
        y += 18;
        para("The following supplements the terms above and forms part of this term sheet.", 8);
        y += 2;
        function item(h, body) {
          brk(38);
          doc.setFont("helvetica", "bold"); doc.setFontSize(8.7); doc.setTextColor.apply(doc, TEAL);
          doc.text(pdfSafe(h), M + 3, y + 8); y += 15;
          para(body, 8, 11);
          y += 3;
        }
        item("Business purpose only", "This loan is made solely for business, commercial or investment purposes and is NOT for personal, family, or household (consumer) use. It is secured by non-owner-occupied real property, is not subject to consumer-mortgage (TILA / RESPA) disclosures, and requires a personal guaranty and a first-lien position.");
        item("Personal guaranty / recourse", guarantyInfo().disclosure);
        item("Interest accrual", accrualDetail());
        item("Due diligence", "Borrower will provide all necessary due diligence to Lender.");
        item("Title", "Borrower shall provide a Title Report and Title Insurance to the satisfaction of the Lender. Lender's title coverage must be approved.");
        item("Legal fees and expenses", "The Borrower shall be required to pay for all legal fees and services related to the loan transaction. Additionally, the Borrower shall pay the Lender underwriting / processing fee and all other applicable Lender fees.");
        item("Insurance", "Borrower shall provide insurance certificates satisfactory to Lender.");
        if (minInterestOn(progOf(d))) item("Minimum interest", "This loan carries a 3-month minimum earned interest provision: if the loan pays off before three full months of interest have accrued, the remainder of that minimum is due at payoff. This is an interest floor / minimum earned-interest provision, not a prepayment penalty.");
        if (deferredOrigPct() > 0) item("Deferred origination fee", "A deferred origination fee of " + pc(deferredOrigPct() / 100) + " of the loan amount is payable at payoff as an exit fee. It is not collected at closing and is not part of the cash to close or the liquidity to show.");
        item("Disclaimer", "This term sheet does not set forth all of the terms of the loan contemplated hereunder. Additional terms and conditions may be set by the Lender prior to closing. This term sheet is not a commitment to lend money and is subject to, among other things, the Lender's sole discretion regarding Borrower's status, the Property, the Loan, title, and due diligence.");
        item("Acknowledgement & indemnification", "By accepting these terms you confirm that you will not hold YS Capital Group and/or the Lender liable for any damages related to their decision not to make the loan for any reason. You also confirm that you will indemnify and hold harmless YS Capital Group and the Lender from any claims or liabilities related to this transaction.");
        footer();
      }

      header();
      var y = 92;
      // ---- Provenance badge (owner-directed 2026-07-31): a right-aligned
      // rounded-rect stamp directly under the header band saying HOW this sheet
      // was generated and whether it is INITIAL or FINAL. GOLD border + title
      // for the initial kinds, TEAL for a final sheet; every kind except
      // file_final also carries "INITIAL TERM SHEET \u2014 NOT FINAL". The recipient
      // block starts BELOW the badge so nothing overlaps. Page 1 only.
      (function () {
        var cp = PROV_COPY[provK] || PROV_COPY.website;
        var ac = provFinal ? TEAL : GOLD;
        var notFinal = "INITIAL TERM SHEET \u2014 NOT FINAL";
        // Width fits the longest line (title incl. letter-spacing), clamped 150-180pt.
        doc.setFont("helvetica", "bold"); doc.setFontSize(8);
        var tW = doc.getTextWidth(pdfSafe(cp.title)) + Math.max(0, pdfSafe(cp.title).length - 1) * 0.8;
        doc.setFontSize(6.5);
        var nW = provFinal ? 0 : doc.getTextWidth(pdfSafe(notFinal));
        doc.setFont("helvetica", "normal"); doc.setFontSize(6.5);
        var sW = doc.getTextWidth(pdfSafe(cp.sub));
        var bw = Math.max(150, Math.min(180, Math.ceil(Math.max(tW, sW, nW)) + 20));
        var bx = W - M - bw, by = 86;
        var subL = doc.splitTextToSize(pdfSafe(cp.sub), bw - 18);
        var subLead = 6.5 * 1.15;
        var bh = 21 + (subL.length - 1) * subLead + (provFinal ? 0 : 8.6) + 7;
        if (bh < 30) bh = 30;
        if (provFinal) doc.setFillColor(244, 249, 249); else doc.setFillColor(252, 249, 243);   // whisper of teal / warm ivory behind the stamp
        doc.setDrawColor.apply(doc, ac); doc.setLineWidth(1);
        doc.roundedRect(bx, by, bw, bh, 3, 3, "FD");
        doc.setFillColor.apply(doc, ac); doc.rect(bx + 5, by + 5.5, 2.2, 8.4, "F");   // accent tab beside the title
        doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor.apply(doc, ac);
        doc.text(pdfSafe(cp.title), bx + 11, by + 12.5, { charSpace: 0.8 });
        doc.setFont("helvetica", "normal"); doc.setFontSize(6.5); doc.setTextColor.apply(doc, GRAY);
        doc.text(subL, bx + 11, by + 21);
        if (!provFinal) {
          doc.setFont("helvetica", "bold"); doc.setFontSize(6.5); doc.setTextColor.apply(doc, GOLD);
          doc.text(pdfSafe(notFinal), bx + 11, by + 21 + (subL.length - 1) * subLead + 8.6, { charSpace: 0.3 });
        }
        y = by + bh + 12;
      })();
      // Recipient block (owner-directed 2026-07-22): so the attorneys can read the
      // structure, show ALL parties \u2014 the vesting entity (loan is to the entity),
      // the individual borrower/guarantor, and the co-borrower \u2014 plus the loan
      // purpose (Purchase / Refinance) and the program.
      var _tsEntity0 = (val("entityName") || "").trim(), _tsIndiv0 = (val("borrowerName") || "").trim(), _tsCo0 = (val("coBorrowerName") || "").trim();
      // Guaranty set (owner-directed 2026-07-22): both individuals guarantee by
      // default; an approved co-borrower waiver drops the co-borrower to a
      // non-guarantor member. _gi.list is the guarantor list (both when not waived,
      // so the default sub-line is unchanged).
      var _gi = guarantyInfo();
      var _guarLabel = _gi.guarantors.length > 1 ? "Guarantors: " : "Guarantor: ";
      var primaryName = _tsEntity0 || _tsIndiv0 || "Prospective Borrower";
      var partiesSub = _tsEntity0
        ? ("Vesting entity" + (_gi.list ? ("  \u00b7  " + _guarLabel + _gi.list) : "") + (_gi.waived ? ("  \u00b7  Member (non-guarantor): " + _tsCo0) : ""))
        : (_tsCo0
            ? (_gi.waived ? ("Borrower: " + _tsIndiv0 + "  \u00b7  Co-borrower (non-guarantor member): " + _tsCo0) : ("Borrower & co-borrower: " + _gi.list))
            : "Individual borrower");
      var purposeLabel = isRefi() ? (isCashOut() ? "Cash-out refinance" : "Rate & term refinance") : "Purchase";
      var where = chk("addrTBD") ? "Property: To be determined" : ("Property: " + (val("propAddr") || "\u2014") + (val("propState") ? ", " + val("propState") : ""));
      doc.setFont("helvetica", "bold"); doc.setFontSize(11.5); doc.setTextColor.apply(doc, DARK); doc.text(pdfSafe(primaryName), M, y);
      doc.setFont("helvetica", "bold"); doc.setFontSize(8.3); doc.setTextColor.apply(doc, GOLD); doc.text(pdfSafe(progName), W - M, y, { align: "right" });
      y += 12.5;
      doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor.apply(doc, GRAY); doc.text(pdfSafe(partiesSub), M, y);
      doc.text(pdfSafe(purposeLabel + "  \u00b7  " + prettyStrategy(d.inp.strategy)), W - M, y, { align: "right" });
      y += 12.5;
      doc.text(pdfSafe(where + "   \u00b7   Valid through " + fmtD(exp)), M, y);
      // Loan-officer branding (owner-directed 2026-07-31): a "Prepared by" block
      // as the right column of the recipient area \u2014 name (bold), role, NMLS,
      // phone, email at 7pt GRAY. Only when window.YSBRAND carries a name; an
      // unbranded PDF stays byte-identical. The footer contact line stays too.
      var _pb = window.YSBRAND, _pbName = _pb ? String(_pb.name || "").trim() : "";
      if (_pbName) {
        var _pbPh = _pb.direct || _pb.cell || "";
        y += 10.5;
        doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor.apply(doc, GRAY);
        doc.text(pdfSafe("Prepared by " + _pbName + (_pb.role ? " \u00b7 " + _pb.role : "") + (_pb.nmls ? " \u00b7 NMLS " + _pb.nmls : "")), W - M, y, { align: "right" });
        if (_pbPh || _pb.email) {
          y += 9;
          doc.setFont("helvetica", "normal"); doc.setFontSize(7);
          doc.text(pdfSafe([_pbPh, _pb.email].filter(Boolean).join("  \u00b7  ")), W - M, y, { align: "right" });
        }
        doc.setFontSize(8);   // restore the recipient block's size for anything that follows
      }
      y += 14;
      doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.5); doc.line(M, y - 4, W - M, y - 4);   // fine rule closing the recipient block

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
      var heroH = 64;
      doc.setFillColor.apply(doc, DARK); doc.roundedRect(M, y, W - 2 * M, heroH, 4, 4, "F");
      doc.setFillColor.apply(doc, GOLD); doc.rect(M, y + 4, 3.5, heroH - 8, "F");
      doc.setDrawColor(64, 74, 82); doc.setLineWidth(0.6); doc.line(W - M - 172, y + 15, W - M - 172, y + heroH - 15);   // hairline between amount + rate
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.4); doc.setTextColor(176, 184, 186); doc.text("ESTIMATED TOTAL LOAN AMOUNT", M + 16, y + 17, { charSpace: 0.7 });
      doc.setFont("times", "bold"); doc.setFontSize(26); doc.setTextColor(244, 240, 231); doc.text(sized ? money(d.totalLoan) : "\u2014", M + 16, y + 43);
      doc.setFont("helvetica", "bold"); doc.setFontSize(8.4); doc.setTextColor.apply(doc, d.pricingReady ? pillC : [150, 156, 150]); doc.text(pdfSafe(d.pricingReady ? stTxt : "Awaiting FICO score"), M + 16, y + 55);
      var rx = W - M - 16;
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.2); doc.setTextColor(176, 184, 186); doc.text("NOTE RATE (INTEREST-ONLY)", rx, y + 17, { align: "right", charSpace: 0.5 });
      doc.setFont("times", "bold"); doc.setFontSize(17); doc.setTextColor(244, 240, 231); doc.text((d.pricingReady && d.rate > 0) ? fmtRate3(d.rate) + "%" : "\u2014", rx, y + 40, { align: "right" });
      doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(176, 184, 186); doc.text(d.term + "-month term \u00b7 " + origPctStr((d.origPct != null ? d.origPct : 0.0125)) + " origination", rx, y + 55, { align: "right" });
      y += heroH + 16;

      // TWO COLUMNS
      var colGap = 16, colW = (W - 2 * M - colGap) / 2, xL = M, xR = M + colW + colGap, yL = y, yR = y;
      yL = cardHead(xL, colW, "Loan structure", yL);
      yL = rowIn(xL, colW, isRefi() ? "As-is value" : "Purchase price", money(isRefi() ? d.basisPrice : (num("price") || d.basisPrice)), yL);
      if (!isRefi() && isAssign()) yL = rowIn(xL, colW, "Seller price / assignment fee", money(num("origPrice")) + " / " + money(Math.max(0, num("price") - num("origPrice"))), yL);
      if (!isRefi() && isAssign() && d.asg && (d.asg.overLimit || d.asg.overridden)) yL = rowIn(xL, colW, "Effective purchase price " + (d.asg.overridden ? "(admin exception)" : d.asg.dollarCap ? "(fee capped at the program limit)" : "(fee capped at 15%)"), money(d.asg.recognizedPrice), yL);
      if (!isBridge) {
        yL = rowIn(xL, colW, "Construction / rehab budget", money(d.constr), yL);
        if (d.financedIR > 0) { var finMo = (d.fullPayment > 0) ? Math.round(d.financedIR / d.fullPayment) : (d.irMonths || 0); yL = rowIn(xL, colW, "Financed interest reserve (" + finMo + " mo)", money(d.financedIR), yL); }
        yL = rowIn(xL, colW, "Total project cost", money(d.totalCost), yL, { bold: true });
        yL = rowIn(xL, colW, "Initial advance (at closing)", sized ? (money(d.initialAdvance) + (d.ltvPct > 0 ? "   (" + pc(d.ltvPct) + " LTV)" : "")) : "\u2014", yL);
        yL = rowIn(xL, colW, (d.R && d.R.sizing && d.R.sizing.rehabOverCap) ? "Construction holdback (capped \u2014 see eligibility)" : (d.oopRehab > 0 ? "Construction holdback (financed portion)" : "Construction holdback (= rehab)"), sized ? money(d.rehabHoldback) : "\u2014", yL);
        if (sized && d.oopRehab > 0) yL = rowIn(xL, colW, "Out-of-pocket rehab (funded over construction)", money(d.oopRehab), yL);
      }
      yL = rowIn(xL, colW, isBridge ? "Total loan amount (disbursed at closing)" : "Total loan amount", sized ? money(d.totalLoan) : "\u2014", yL, { bold: true, accent: true });
      /* THE PAYOFF IS PART OF THE STRUCTURE ON A REFINANCE (owner-directed
         2026-07-31: "it should be part of the real structure also on the term
         sheet also on the structure screen everywhere by refinancing
         transaction"). Naming WHO and WHICH loan is what lets the closing attorney
         and the title company request the payoff letter without a phone call; the
         net cash line is the number the borrower actually asks about, and it is
         printed only on a cash-out \u2014 a rate-&-term takes no cash by definition. */
      if (isRefi() && num("payoff") > 0) {
        var _po = num("payoff"), _poWho = payoffLender(), _poNo = payoffLoanNo();
        yL = rowIn(xL, colW, "Existing loan payoff", money(_po), yL);
        if (_poWho) yL = rowIn(xL, colW, "Paid off to", _poWho, yL);
        if (_poNo) yL = rowIn(xL, colW, "Their loan number", _poNo, yL);
        if (isCashOut() && sized) {
          /* cashOutOfRecord, NOT arithmetic inlined here: the officer may have
             typed a cash-out figure, and the printed sheet must quote the number
             of record — the same one the panel and the help line show. Inlining
             it once meant a typed override never reached the PDF. */
          yL = rowIn(xL, colW, "Estimated cash to you (after payoff & closing costs)",
            money(cashOutOfRecord(d)), yL, { bold: true });
        }
      }
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
      // "Program max" is the TIER maximum \u2014 fixed, never the post-step-down ceiling
      // (owner-reported 2026-07-30). When this deal cannot be priced that high, the
      // deal's own ceiling prints on its OWN row underneath and the band below the
      // leverage card explains why.
      var _pdfTier = tierMaxOf(d);
      if (_pdfTier && sized) yR = rowIn(xR, colW, isBridge ? "Program max \u2014 as-is" : "Program max \u2014 LTC / ARV / as-is", isBridge ? pc(_pdfTier.maxAcqLTV) : (pc(_pdfTier.maxLTC) + " / " + pc(_pdfTier.maxARLTV) + " / " + pc(_pdfTier.maxAcqLTV)), yR);
      if (_pdfTier && sized && pricedBelowTier(_pdfTier, d.caps)) yR = rowIn(xR, colW, isBridge ? "This deal prices up to \u2014 as-is" : "This deal prices up to \u2014 LTC / ARV / as-is", isBridge ? pc(d.caps.maxAcqLTV) : (pc(d.caps.maxLTC) + " / " + pc(d.caps.maxARLTV) + " / " + pc(d.caps.maxAcqLTV)), yR);
      yR = rowIn(xR, colW, isBridge ? "As-is value" : "As-is / ARV value", isBridge ? money(d.asIs) : (money(d.asIs) + " / " + money(d.arv)), yR);
      yR += 9;
      yR = cardHead(xR, colW, "Estimated cash to close", yR);
      yR = rowIn(xR, colW, "Origination fee (" + origPctStr((d.origPct != null ? d.origPct : 0.0125)) + ")", sized ? money2(d.origFee) : "\u2014", yR);
      yR = rowIn(xR, colW, "Underwriting / processing / legal", sized ? money2(d.lenderFee) : "\u2014", yR);
      yR = rowIn(xR, colW, "Credit report (avg)", sized ? money2(d.creditFee) : "\u2014", yR);
      yR = rowIn(xR, colW, "Appraisal (est., POC)", sized ? money2(d.apprFee) : "\u2014", yR);
      yR = rowIn(xR, colW, "Title / escrow / settlement (est.)", sized && d.titleCost > 0 ? money2(d.titleCost) : "\u2014", yR);
      if (sized && d.extraFees) d.extraFees.forEach(function (f) { yR = rowIn(xR, colW, f.name, money2(f.amount), yR); });
      // REFINANCE: the borrower brings the existing-loan payoff, less the funds that
      // advance at closing (the initial advance), on top of the closing costs above.
      // These two rows make the section reconcile to the cash-to-close total
      // (fees + payoff \u2212 funds advanced). Owner-directed 2026-08-04.
      // ONLY rate-and-term: there the borrower brings a positive shortfall, so
      // "fees + payoff \u2212 funds advanced = cash to close" reconciles. On a CASH-OUT
      // the funds advanced exceed payoff + closing, so cash-to-close is $0 and these
      // two rows would sum NEGATIVE against it; the cash-out already carries its own
      // "cash to you" line in the loan-structure column (owner-directed 2026-08-04).
      if (isRefi() && !isCashOut() && sized && num("payoff") > 0) {
        yR = rowIn(xR, colW, "Existing loan payoff", money(num("payoff")), yR);
        yR = rowIn(xR, colW, "Less funds advanced at closing (initial advance)", "\u2212" + money(fundedAtClose(d)), yR);
      }
      if (!isRefi()) yR = rowIn(xR, colW, "Down payment (equity)", sized ? money(d.downPayment) : "\u2014", yR, { bold: true });
      if (d.excessOOP > 0) yR = rowIn(xR, colW, ((d.asg && d.asg.dollarCap) ? "Assignment over cap (out of pocket)" : "Assignment over 15% (out of pocket)"), money(d.excessOOP), yR);
      yR = rowIn(xR, colW, "Estimated cash to close", sized ? money2(d.cashToClose) : "\u2014", yR, { bold: true, accent: true });
      // 1% closing-cost buffer inside the liquidity to show (owner-authorized
      // 2026-07-31) \u2014 printed just before the liquidity total; a waived buffer
      // prints nothing extra.
      if (sized && d.closingBuffer > 0) yR = rowIn(xR, colW, "Closing cost buffer (1% of loan)", money2(d.closingBuffer), yR);
      var liqLbl = d.gold ? ("Liquidity to show (" + Math.round((d.liquidityPct || 0.05) * 100) + "% of loan)") : ("Liquidity to show (" + d.reserveMo + " mo)");
      yR = rowIn(xR, colW, liqLbl, sized ? money2(d.liquidity) : "\u2014", yR);
      y = Math.max(yL, yR) + 4;

      if (d.reserveCapped && d.maxReserve >= 0) {
        band("Interest reserve");
        para("Maximum eligible interest reserve on this deal is " + money(d.maxReserve) + " (\u2248 " + d.maxReserveMonths.toFixed(1) + " months). The requested " + (irRequestText() || (d.irMonths + " months")) + " exceeds what " + d.reserveCapBy + " allows; the maximum eligible amount has been applied and the remainder is not eligible to finance. Interest on any period beyond the reserve is paid as billed.");
      }

      if (!isRefi() && isAssign() && d.asg && (d.asg.overLimit || d.asg.overridden)) {
        band("Assignment");
        var capDesc = d.asg.dollarCap ? ("the financeable cap (lesser of " + money(d.asg.dollarCap) + " or 15% of the " + money(d.asg.sellerPrice) + " original contract price = " + money(d.asg.maxFee) + ")") : ("the program's 15% limit (" + money(d.asg.maxFee) + ", 15% of the " + money(d.asg.sellerPrice) + " original contract price)");
        if (d.asg.overridden) para("An approved exception sets the effective purchase price at " + money(d.asg.recognizedPrice) + ": " + money(d.asg.financeableFee) + " of the " + money(d.asg.fee) + " assignment fee is financed and all terms are sized on the effective purchase price" + (d.asg.excessOOP > 0.5 ? ("; the remaining " + money(d.asg.excessOOP) + " is paid out of pocket at closing") : "") + ".");
        else para("Your assignment fee of " + money(d.asg.fee) + " exceeds " + capDesc + ". " + money(d.asg.financeableFee) + " is financeable and all terms are sized on the effective purchase price of " + money(d.asg.recognizedPrice) + "; the remaining " + money(d.asg.excessOOP) + " is paid out of pocket at closing. A higher assignment limit may be requested as an exception, subject to credit-committee approval.");
      }

      band("How your loan amount is built");
      // The numbered "program limits" list states the TIER maximum (it is a statement
      // about the PROGRAM, so it must not carry a post-step-down number), and the
      // separate sentence below states what THIS deal prices at and why.
      var _bldCaps = tierMaxOf(d) || d.caps;
      var _bldLower = pricedBelowTier(_bldCaps, d.caps);
      if (isBridge) {
        para("This is a stabilized bridge loan \u2014 it is sized against the as-is value only. The loan is capped at " + pc(_bldCaps ? _bldCaps.maxAcqLTV : 0) + " of the lower of purchase price or as-is value. A bridge has no rehab holdback, no loan-to-cost limit and no after-repair-value limit." + (d.pricingReady && d.binding ? (" On this deal, " + d.binding + " is the binding limit.") : ""));
      } else {
        para("Your maximum loan is the lesser of four program limits \u2014 the most conservative one sets your number. (1) The initial advance is capped at " + pc(_bldCaps ? _bldCaps.maxAcqLTV : 0) + " of the lower of purchase price or as-is value. (2) 100% of your rehab budget is financed and released in draws as work is verified \u2014 no rehab comes out of pocket." + ((d.R && d.R.sizing && d.R.sizing.rehabOverCap) ? " (On this deal the program cap limits the holdback below the budget \u2014 see the eligibility notes.)" : "") + " (3) The total loan can't exceed " + pc(_bldCaps ? _bldCaps.maxLTC : 0) + " loan-to-cost (purchase + rehab). (4) The total loan can't exceed " + pc(_bldCaps ? _bldCaps.maxARLTV : 0) + " of the after-repair value." + (d.pricingReady && d.binding ? (" On this deal, " + d.binding + " is the binding limit.") : ""));
        if (_bldLower && sized) para("These four limits are your program maximum and are set by your tier (FICO and experience) \u2014 they do not change when the deal changes. On this deal the program prices up to " + pc(d.caps.maxLTC) + " loan-to-cost and " + pc(d.caps.maxARLTV) + " of the after-repair value, which is lower. " + pricedWhy(d, _bldCaps, d.caps));
      }

      band("Eligibility snapshot");
      rowFull("Experience tier (as entered)", d.tierLabel || "\u2014");
      rowFull("Estimated FICO", d.fico ? String(d.fico) : "Not provided");
      (function () { var sc = YSP.normStrategy(d.inp.strategy); var tot = YSP.projectCount(sc, { flips: num("expFlips"), holds: num("expBrrrr"), ground: num("expGround") }); rowFull("Experience claimed (last 36 months)", tot + (tot === 1 ? " project" : " projects")); })();
      if (d.pricingReady) d.reasons.forEach(function (r) { para((r.level === "INELIGIBLE" ? "\u2022 Not eligible: " : r.level === "MANUAL" ? "\u2022 Manual underwrite: " : "\u2022 ") + r.msg, 7); });
      else para("\u2022 Add a representative FICO score to finalize pricing, leverage and your loan amount.", 7);

      // ---- Key dates (owner-directed 2026-07-22): estimated, driven by the
      // estimated closing date; recalculate whenever it moves. ----
      var _close = estClosingYMD(), _fp = firstPaymentYMD(_close), _mat = maturityYMD(_fp, d.term);
      band("Key dates");
      rowFull("Loan term", d.term + " months");
      rowFull("Estimated closing date", _close ? fmtD(new Date(_close.y, _close.mo - 1, _close.d)) : "To be set before issuing");
      rowFull("First payment date (estimated)", _fp ? fmtD(new Date(_fp.y, _fp.mo - 1, _fp.d)) : "\u2014");
      rowFull("Maturity date (estimated)", _mat ? fmtD(new Date(_mat.y, _mat.mo - 1, _mat.d)) : "\u2014");
      para("First payment and maturity are ESTIMATES based on the estimated closing date and recalculate if it moves. The first payment is generally the first day of the second month after closing (the partial/stub interest from closing through the end of the closing month is collected at closing); maturity is the " + d.term + "th scheduled payment counted from the first payment \u2014 a full term is not added to the first payment.", 7);

      // ---- Additional loan terms (owner-directed 2026-07-22) ----
      band("Additional loan terms");
      rowFull("Guaranty / recourse", guarantyInfo().recourseLine);
      rowFull("Interest accrual", accrualLabel() + (accrualType() === "dutch" ? " \u2014 interest on the full committed amount" : " \u2014 interest on funds drawn"));
      if (minInterestOn(progOf(d))) rowFull("Minimum interest", "3 months (minimum earned interest \u2014 not a prepayment penalty)");
      var _def = deferredOrigPct();
      if (_def > 0) rowFull("Deferred origination fee \u2014 paid at payoff (exit fee)", pc(_def / 100) + " of the loan; not part of cash to close");
      if (!isBridge) {   // a bridge / as-is loan has no construction draws
        rowFull("Construction draw fee", d.gold ? "$250 per draw" : "$299 (hybrid) / $499 (physical)");
        para(d.gold ? "Gold Standard construction draws require a physical inspection (no virtual inspections) at $250 per draw." : (d.silver ? "Silver Program construction draws are $299 per draw with a hybrid inspection, or $499 per draw with a physical inspection." : "Standard construction draws are $299 per draw with a hybrid inspection, or $499 per draw with a physical inspection."), 7);
      }

      band("Terms, conditions & disclosures");
      para("1.  Nature of this document.  This Preliminary Term Sheet is an indicative summary of potential financing terms only. It is NOT a loan commitment, approval, pre-approval, rate lock or guarantee to lend, and it creates no obligation on the part of " + LENDER.name + " or the prospective borrower.", 7.5);
      para("2.  Subject to underwriting.  Any financing remains subject to a complete application, satisfactory underwriting, independent appraisal / valuation, title and lien review, insurance, and entity, background and final credit approval. Final pricing, leverage, fees and net proceeds are determined at closing and may differ from the figures shown.", 7.5);
      para("3.  Business purpose only.  This is business / investment-purpose financing secured by non-owner-occupied real property. It is not an offer to extend consumer credit and is not subject to consumer-mortgage (TILA / RESPA) disclosures. A personal guaranty and a first-lien position are required.", 7.5);
      para("4.  Interest, draws & costs.  Interest accrues interest-only on the outstanding loan balance. Rehab funds are advanced by reimbursement draw after inspection, and the borrower carries interest on drawn amounts. The title / escrow figure is a planning estimate based on the state, loan size and transaction type (transfer and mortgage taxes are separate); the settlement agent issues the binding quote at closing.", 7.5);
      var scolW = (W - 2 * M - 30) / 2, sx1 = M, sx2 = M + scolW + 30;
      function sigBlock(x, who2, sub, aSig, aDt) {
        doc.setDrawColor(120, 128, 132); doc.setLineWidth(0.8); doc.line(x, y + 28, x + scolW, y + 28);
        doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor.apply(doc, DARK); doc.text(pdfSafe(who2), x, y + 41);
        doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor.apply(doc, GRAY); doc.text(pdfSafe(sub), x, y + 51);
        doc.line(x, y + 70, x + scolW - 90, y + 70); doc.text("Date", x, y + 81);
        // Invisible DocuSign anchors: white, tiny (4pt) text placed ON the
        // signature and date lines — a human never sees them, DocuSign finds them
        // in the text layer and drops the recipient's tab there. Document-unique
        // (ts_*) so a tab never accidentally lands on another doc in the envelope.
        if (aSig || aDt) {
          doc.setTextColor(255, 255, 255); doc.setFontSize(4);
          if (aSig) doc.text(aSig, x + 2, y + 25);
          if (aDt) doc.text(aDt, x + 2, y + 67);
          doc.setFontSize(7.5); doc.setTextColor.apply(doc, GRAY);
        }
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
        // A full DISCLOSURES page prints right before the signature page
        // (owner-directed 2026-07-22) — signable sheets only.
        disclosuresPage();
        // Pre-check LO context so the acceptance paragraph + reserve height account for it.
        var _tsLoBrandPre = (typeof window !== "undefined" && window.YSBRAND) ? window.YSBRAND : null;
        var _tsHasLoPre = !!(_tsLoBrandPre && String(_tsLoBrandPre.name || "").trim());
        para("5.  Validity & acceptance.  This term sheet is valid through " + fmtD(exp) + (d.inp.state ? (" for a property located in " + d.inp.state) : "") + ". It is not binding unless and until it is accepted in writing by the borrower" + (coBorrowerName ? " and co-borrower" : "") + (_tsHasLoPre ? ", acknowledged by the originating loan officer," : "") + " below and countersigned by an authorized representative of " + LENDER.name + ".", 7.5);
        var _sigRowsPre = 1 + (coBorrowerName ? 1 : 0) + (_tsHasLoPre ? 1 : 0);
        brk(_sigRowsPre >= 3 ? 292 : (_sigRowsPre === 2 ? 200 : 110)); band("Acceptance & signatures"); brk(86);
        // #104: when a borrowing entity is named, the entity is the borrower of
        // record and the individual signs as its authorized signatory / guarantor.
        var _tsEntity = (val("entityName") || "").trim(), _tsIndiv = (val("borrowerName") || "").trim();
        var _primaryName = _tsEntity || _tsIndiv || "Borrower";
        var _primarySub = _tsEntity
          ? (_tsIndiv ? ("Borrower (entity) — by " + _tsIndiv + ", authorized signatory / guarantor") : "Borrower (entity) / authorized signatory")
          : "Borrower / authorized signatory";
        sigBlock(sx1, _primaryName, _primarySub, "/ts_b1_sig/", "/ts_b1_dt/");
        // When the file has TWO borrowers, the term sheet carries a second
        // signature line for the co-borrower (owner-directed #137) side-by-side
        // with the borrower; the lender line drops to the next row.
        // Loan officer signature block (owner-directed 2026-07-21): the assigned
        // loan officer signs the term sheet FIRST alongside the borrower(s); the
        // super_admin lender counter-signs LAST. Only added when window.YSBRAND
        // carries a name \u2014 an unbranded PDF stays byte-identical.
        var _tsLoBrand = (typeof window !== "undefined" && window.YSBRAND) ? window.YSBRAND : null;
        var _tsLoName = _tsLoBrand ? String(_tsLoBrand.name || "").trim() : "";
        var _tsHasLo = !!_tsLoName;
        var _loSub = _tsHasLo ? ("Loan officer \u2014 " + LENDER.name + (_tsLoBrand && _tsLoBrand.nmls ? (" \u00b7 NMLS " + _tsLoBrand.nmls) : "")) : "";
        if (coBorrowerName) {
          // A waived co-borrower still SIGNS (as an authorized member of the
          // entity) — only their role sub-line changes to "non-guarantor".
          sigBlock(sx2, coBorrowerName, guarantyInfo().coSignerRole, "/ts_b2_sig/", "/ts_b2_dt/");
          y += 92; brk(_tsHasLo ? 178 : 86);
          if (_tsHasLo) {
            sigBlock(sx1, _tsLoName, _loSub, "/ts_lo_sig/", "/ts_lo_dt/");
            sigBlock(sx2, LENDER.name, "Authorized representative \u2014 required to validate", "/ts_admin_sig/", "/ts_admin_dt/");
          } else {
            sigBlock(sx1, LENDER.name, "Authorized representative \u2014 required to validate", "/ts_admin_sig/", "/ts_admin_dt/");
          }
        } else if (_tsHasLo) {
          sigBlock(sx2, _tsLoName, _loSub, "/ts_lo_sig/", "/ts_lo_dt/");
          y += 92; brk(86);
          sigBlock(sx1, LENDER.name, "Authorized representative \u2014 required to validate", "/ts_admin_sig/", "/ts_admin_dt/");
        } else {
          sigBlock(sx2, LENDER.name, "Authorized representative \u2014 required to validate", "/ts_admin_sig/", "/ts_admin_dt/");
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
      var lad = (!d.gold && !ladderOverridden) ? (d.silver ? SVP.priceLadder(gather()) : YSP.priceLadder(gather())) : { eligible: false, rows: [] };
      if (!d.gold && !ladderOverridden && lad.eligible && lad.rows.length) {
        doc.addPage(); header(); y = 92;
        doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.setTextColor.apply(doc, DARK);
        doc.text(d.silver ? "Your pricing at every step down" : "Your pricing at every leverage level", M, y);
        doc.setDrawColor.apply(doc, GOLD); doc.setLineWidth(1.3); doc.line(M, y + 5.5, M + 42, y + 5.5);   // gold rule under the heading
        y += 16;
        /* SILVER READS DIFFERENTLY BECAUSE IT PRICES DIFFERENTLY (owner-directed
           2026-08-06). EMCAP prices on BOTH the cost ratio and the value ratio, so a
           step down can be earned on either side and each row must show both — a row
           that displayed only the LTC would misrepresent what bought the rate. Every
           row is a REAL price improvement (the ladder never offers a step that buys
           nothing), and each is the LARGEST loan at that rate. */
        para(d.silver
          ? "A smaller loan earns a better rate. Each row below is a real price improvement \u2014 and is the largest loan that earns that rate, so you never give up more than you have to. A step can come from the cost side or the value side; the \u201cStep\u201d column says which, and both ratios are shown because moving one moves the other. The highlighted row is the option you selected."
          : "Lower leverage means less risk to the lender \u2014 so it earns a lower rate. The table shows the loan amount, cash to close and note rate at each leverage step this scenario supports. The highlighted row is the option you selected; taking less leverage trades a smaller loan for a better rate.");
        var tW = W - 2 * M;
        var cols = d.silver ? [
          { t: "Step", w: 0.15, a: "l" },
          { t: "Loan amount", w: 0.17, a: "r" },
          { t: "Initial advance", w: 0.17, a: "r" },
          { t: "Cost (LTC)", w: 0.12, a: "r" },
          { t: "Value (ARV)", w: 0.12, a: "r" },
          { t: "Payment / mo", w: 0.14, a: "r" },
          { t: "Note rate", w: 0.13, a: "r" }
        ] : [
          { t: "Leverage (LTC)", w: 0.26, a: "l" },
          { t: "Loan amount", w: 0.20, a: "r" },
          { t: "Cash down", w: 0.18, a: "r" },
          { t: "Payment / mo", w: 0.18, a: "r" },
          { t: "Note rate", w: 0.18, a: "r" }
        ];
        brk(30 + lad.rows.length * 20);
        var hy = y;
        doc.setFillColor.apply(doc, INK); doc.rect(M, hy, tW, 22, "F");
        doc.setFillColor.apply(doc, GOLD); doc.rect(M, hy, tW, 1.6, "F");   // gold cap rule atop the header row
        doc.setFont("helvetica", "bold"); doc.setFontSize(8.3); doc.setTextColor(244, 240, 231);
        var cx = M;
        cols.forEach(function (c) { var w = c.w * tW; doc.text(c.t, c.a === "r" ? cx + w - 7 : cx + 7, hy + 14, { align: c.a === "r" ? "right" : "left", charSpace: 0.3 }); cx += w; });
        var ry = hy + 22;
        // The highlighted rung must be the one THIS program's slider selected —
        // reading the Standard slider's chosenLTC on a Silver sheet highlighted a
        // row the borrower never picked (and vice versa). Dispatch exactly like
        // renderLeverage does. Silver's top rung carries ltc 0 (its "no targetLTC
        // / true maximum" marker), which is also what an unset slider resolves to.
        var selLtc = (d.silver ? silverChosenLTC : (d.gold ? goldChosenLTC : chosenLTC)) || lad.rows[0].ltc;
        lad.rows.forEach(function (r, i) {
          /* MATCH THE SELECTED RUNG BY ITS OWN IDENTITY WHEN IT HAS ONE. On Silver a
             cost-side and a value-side rung can legitimately land on the SAME LTC, so
             the old `r.ltc` compare could highlight the wrong row on a document that
             goes out for signature. A value-side rung carries ltc === null, so the
             numeric compare can never match one by accident either. */
          var rowH = 20;
          var isSel = (r.ltc == null) ? false : Math.abs(r.ltc - selLtc) < 1e-9;
          if (isSel) { doc.setFillColor.apply(doc, GOLD); doc.rect(M, ry, tW, rowH, "F"); }
          else if (i % 2) { doc.setFillColor(244, 240, 231); doc.rect(M, ry, tW, rowH, "F"); }
          doc.setFont("helvetica", isSel ? "bold" : "normal"); doc.setFontSize(8.6);
          doc.setTextColor.apply(doc, isSel ? [20, 27, 34] : DARK);
          var vals = d.silver ? [
            r.isMax ? "Maximum" : (r.cut === "arv" ? "Value cut" : "Cost cut"),
            money(Math.floor(r.totalLoan)), money(Math.floor(r.initialAdvance)),
            pc(r.targetLtcPct), pc(r.arvPct),
            money(Math.floor(r.totalLoan) * (r.noteRate / 12)) + "/mo",
            fmtRate3(r.noteRate * 100) + "%"
          ] : [
            pc(r.targetLtcPct) + (r.isMax ? "  (maximum)" : ""),
            money(Math.floor(r.totalLoan)), money(Math.floor(r.downPayment)), money(Math.floor(r.totalLoan) * (r.noteRate / 12)) + "/mo",
            fmtRate3(r.noteRate * 100) + "%"
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

      if (d && (d.pricingReady || d.totalLoan > 0 || (borrowerOfRecord() || "").trim())) drawDerivationPage(doc, d, "Inputs & Loan Derivation", "This term sheet was generated from the inputs below, entered through the YS Capital Term Sheet Studio. This page records exactly what was provided and how the loan amount and leverage were determined. Term sheet ID " + tsId + " · exported " + tsStamp + ".");
      // #99: when asked for a blob (the "email to my officer" path) return the PDF
      // bytes to attach server-side instead of downloading it.
      if (returnBlob) { if (btn) { btn.textContent = label; btn.disabled = false; } return doc.output("blob"); }
      doc.save(fileStem() + ".pdf");
      flash("Term sheet downloaded.");
      // Sales-desk heads-up with the exact generated sheet (best-effort,
      // never blocks or delays the download).
      try { notifyGeneration(d, "Term sheet", doc.output("blob")); } catch (e) {}
    } catch (e) {
      flash("Term sheet export failed. Refresh the page and try again \u2014 if it keeps happening, tell the team.");
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
    // Open fatal appraisal findings HOLD generation here too (owner-directed
    // 2026-07-31) — the portal host sets window.TS_ISSUE_HOLD with the reason.
    if (window.TS_ISSUE_HOLD) { flash(String(window.TS_ISSUE_HOLD)); return; }
    var label = btn ? btn.textContent : "";
    var borrower0 = (borrowerOfRecord() || "").trim();
    if (!borrower0) { flash("Enter the borrowing entity or borrower name to generate the letter."); var bn = el("entityName") || el("borrowerName"); if (bn) { bn.focus(); bn.classList.add("field-flag"); setTimeout(function(){ bn.classList.remove("field-flag"); }, 2400); } return; }
    if (btn) { btn.textContent = "Building letter\u2026"; btn.disabled = true; }
    try {
      await ensurePDF();
      syncAdminMarkup();
      var d = calcChosen();
      if (!d || d.status === "INELIGIBLE" || d.exitShortfall > 0 || d.cityReview || !(d.totalLoan > 0)) {
        flash("This scenario isn't eligible as entered \u2014 adjust the deal to issue a proof-of-funds letter.");
        if (btn) { btn.textContent = label; btn.disabled = false; } return;
      }
      var progName = chosenProgramName(false);
      var isRefiTxn = (d.inp && d.inp.loanType === "Refinance");
      var isBridge = d.inp && YSP.normStrategy(d.inp.strategy) === "BR";
      var jsPDF = window.jspdf.jsPDF;
      var doc = new jsPDF({ unit: "pt", format: "letter", orientation: "portrait" });
      var W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 54;
      var INK = [20, 27, 34], TEAL = [47, 127, 134], GOLD = [174, 135, 70], GRAY = [75, 88, 92], DARK = [20, 27, 34], LINE = [223, 216, 203], SOFT = [244, 240, 231], BODY = [40, 46, 52];
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
      doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.5); doc.line(0, 95.6, W, 95.6);   // fine warm hairline beneath the gold rule
      var lg = logoData(); if (lg) { var h = 34, w = lg.w * (h / lg.h); try { doc.addImage(lg.dataURI, "PNG", M, 30, w, h); } catch (e) {} }
      doc.setTextColor(244, 240, 231); doc.setFont("times", "bold"); doc.setFontSize(11.5);
      doc.text("PRIVATE MORTGAGE BANKING", W - M, 41, { align: "right", charSpace: 1 });
      doc.setFont("times", "italic"); doc.setFontSize(9); doc.setTextColor(174, 135, 70);
      doc.text("Business-purpose real estate finance", W - M, 56, { align: "right" });
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(176, 184, 186);
      doc.text("NMLS " + LENDER.nmls + "   \u00b7   " + LENDER.phone + "   \u00b7   " + LENDER.email, W - M, 73, { align: "right", charSpace: 0.3 });

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
        // "Leverage on this financing" — the caps THIS loan is sized at, matching the
        // "prepared to finance up to $X" figure directly above. Relabelled from
        // "Maximum leverage", which read as a PROGRAM maximum while carrying the
        // deal's own (possibly stepped-down) ceiling (owner-reported label class,
        // 2026-07-30). The program/tier maximum belongs on the term sheet, not on a
        // one-page proof-of-funds letter addressed to a seller.
        ["Leverage on this financing", leverageLine(d, isBridge)],
        ["Indicative term", (d.term || 12) + " months, interest-only"]
      ];
      // Measure every value BEFORE the box is drawn: a row needing a second
      // line makes the BOX taller, instead of having its tail dropped.
      var POF_VLH = 10.5;                                       // a stacked value line
      var vfit = rows.map(function (rw) { return fitSlotLines(doc, pdfSafe(rw[1]), boxW - 26 - 200, "helvetica", "bold", 8.5, 7.5, 2); });
      var rowAdv = vfit.map(function (f) { return rowH + (f.lines.length - 1) * POF_VLH; });
      var boxH = headH + rowAdv.reduce(function (a, b) { return a + b; }, 0) + 8;
      doc.setFillColor.apply(doc, SOFT); doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.9);
      doc.roundedRect(boxX, y, boxW, boxH, 4, 4, "FD");
      doc.setFillColor.apply(doc, TEAL); doc.roundedRect(boxX, y, boxW, headH, 4, 4, "F"); doc.rect(boxX, y + 12, boxW, headH - 12, "F");
      doc.setFillColor.apply(doc, GOLD); doc.rect(boxX + 5, y + 6, 2.4, headH - 12, "F");   // gold accent tab
      doc.setFont("helvetica", "bold"); doc.setFontSize(8.3); doc.setTextColor(255, 255, 255);
      doc.text("SUMMARY OF INDICATIVE TERMS", boxX + 14, y + 13.5, { charSpace: 0.6 });
      var yy = y + headH + 15;
      for (var r = 0; r < rows.length; r++) {
        doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor.apply(doc, GRAY);
        doc.text(pdfSafe(rows[r][0]), boxX + 13, yy);
        doc.setFont("helvetica", "bold"); doc.setFontSize(vfit[r].fs); doc.setTextColor.apply(doc, DARK);
        // Drawn line by line at our OWN spacing, so the divider below sits where
        // we measured it (jsPDF's own multi-line spacing is font-size derived).
        (function (f, base) { f.lines.forEach(function (ln, k) { doc.text(ln, boxX + boxW - 13, base + k * POF_VLH, { align: "right" }); }); })(vfit[r], yy);
        var lastLine = yy + (vfit[r].lines.length - 1) * POF_VLH;   // divider under the LAST line
        if (r < rows.length - 1) { doc.setDrawColor(231, 228, 219); doc.setLineWidth(0.5); doc.line(boxX + 13, lastLine + 5.5, boxX + boxW - 13, lastLine + 5.5); }
        yy += rowAdv[r];
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
      doc.text(pdfSafe((minInterestOn(chosenProgram === "gold" ? "gold" : chosenProgram === "silver" ? "silver" : "standard") ? MIN_INTEREST_DETAIL + " " : "") + LENDER.name + " \u00b7 NMLS " + LENDER.nmls + " \u00b7 Business-purpose lending only. This document is proof of funds / pre-qualification and is not a commitment to lend or an offer to extend consumer credit. Figures are indicative and subject to full underwriting, appraisal, title and final credit approval."), M, H - 36, { maxWidth: W - 2 * M });

      drawDerivationPage(doc, d, "Basis for This Proof of Funds", "The figures in the preceding letter were generated from the inputs below, provided by the applicant through the YS Capital Term Sheet Studio. This page shows what was entered and how the financing amount was determined.");
      doc.save("YS-Capital-Proof-of-Funds-" + borrower.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") + ".pdf");
      flash("Proof-of-funds letter downloaded.");
      // Sales-desk heads-up with the exact generated letter (best-effort).
      try { notifyGeneration(d, "Proof of funds letter", doc.output("blob")); } catch (e) {}
    } catch (e) {
      flash("Letter export failed. Refresh the page and try again \u2014 if it keeps happening, tell the team.");
    } finally { if (btn) { btn.textContent = label; btn.disabled = false; } }
  }

  // ---- soft lead capture on the happy path ----
  function blobToB64(blob) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { var s = String(r.result); res(s.slice(s.indexOf(",") + 1)); }; r.onerror = rej; r.readAsDataURL(blob); }); }

  /* ---- sales-desk notification on every GENERATED document (owner-directed
     2026-07-24) + the optional "want a follow-up?" contact ask ----
     When a visitor downloads a term sheet or proof-of-funds letter, the sales
     desk is told server-side EXACTLY what was generated (figures + the PDF
     itself). No contact info is required for that; we ask for it right after,
     and it is never a requirement. The anti-bot form token is fetched at page
     load so it carries the human dwell the server checks. */
  var FORM_TOKEN = { t: null, at: 0 };
  // The server accepts a token for ~2h; a studio tab often stays open longer.
  // Treat a held token older than ~100 minutes as stale and re-fetch.
  var TOKEN_FRESH_MS = 100 * 60 * 1000;
  // The SAME page is embedded inside the PILOT portal (TermSheetStudio iframe)
  // for staff/borrower work — those internal generations must NOT ping the
  // sales desk as "a visitor generated a term sheet." Public visitors open the
  // tool directly (never in a frame), so frame-embedding is the reliable tell.
  var EMBEDDED = (function () { try { return window.self !== window.top; } catch (e) { return true; } })();
  function fetchFormToken() {
    return fetch("/api/leads/token").then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.t) { FORM_TOKEN.t = d.t; FORM_TOKEN.at = Date.now(); } return FORM_TOKEN.t; })
      .catch(function () { return null; });
  }
  function dealMetaRows(d, kind) {
    return [
      { label: "Document", value: kind },
      { label: "Program", value: chosenProgramName(false) },
      { label: "Borrower / entity", value: (borrowerOfRecord() || "").trim() },
      { label: "Property", value: (chk("addrTBD") ? "TBD" : (val("propAddr") || "")) + (val("propState") ? ", " + val("propState") : "") },
      { label: "Loan amount", value: (d && d.totalLoan) ? YS.fmtUSD(d.totalLoan) : "" },
      { label: "Note rate", value: (d && d.pricingReady && d.rate) ? fmtRate3(d.rate) + "%" : "" },
      { label: "Term", value: (d && d.term) ? d.term + " months" : "" },
      { label: "Purchase price", value: num("price") ? YS.fmtUSD(num("price")) : "" },
      { label: "Rehab budget", value: num("construction") ? YS.fmtUSD(num("construction")) : "" },
      { label: "ARV", value: num("arv") ? YS.fmtUSD(num("arv")) : "" },
      { label: "Eligibility", value: (d && d.status) || "" }
    ];
  }
  var _lastGen = null;   // {leadId, contactToken} \u2192 lets the optional contact ask attach to the same lead
  // fileArg: a Blob (PDF path) OR a ready {dataBase64, filename, contentType}
  // (the Excel path) OR null \u2014 the notification sends with whatever it gets.
  function notifyGeneration(d, kind, fileArg) {
    if (EMBEDDED) return;   // internal portal studio \u2014 not a marketing-site visitor
    try {
      var doSend = function () {
        if (!FORM_TOKEN.t) return;
        var addr = chk("addrTBD") ? "TBD" : (val("propAddr") || val("propState") || "");
        var subject = kind + " generated \u2014 " + ((chosenProgram === "gold") ? "Gold Standard" : (chosenProgram === "silver") ? "Silver" : (chosenProgram === "manual") ? "Manual Program" : "Standard") +
          (d && d.totalLoan ? " \u2014 " + YS.fmtUSD(d.totalLoan) : "") + (addr ? " \u2014 " + addr : "");
        var ob = window.YSBRAND || {};
        var code = ob.email ? String(ob.email).split("@")[0].toLowerCase().replace(/[^a-z0-9._-]/g, "") : "";
        var attsP;
        if (fileArg && typeof fileArg === "object" && fileArg.dataBase64) {
          attsP = Promise.resolve([{ filename: fileArg.filename || (fileStem() + ".pdf"),
            contentType: fileArg.contentType || "application/octet-stream", dataBase64: fileArg.dataBase64 }]);
        } else if (fileArg) {
          attsP = blobToB64(fileArg).then(function (b64) { return [{ filename: fileStem() + ".pdf", contentType: "application/pdf", dataBase64: b64 }]; }).catch(function () { return []; });
        } else {
          attsP = Promise.resolve([]);
        }
        attsP.then(function (atts) {
          return fetch("/api/leads", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: "term_sheet_generated", formToken: FORM_TOKEN.t,
              officerCode: code || undefined, subject: subject,
              message: "A visitor generated a " + kind.toLowerCase() + " in the Term Sheet Studio. The exact figures are below" + (atts.length ? " and the PDF is attached." : "."),
              attachments: atts,
              payload: { kind: kind, metaRows: dealMetaRows(d, kind), loanAmount: (d && d.totalLoan) || 0, program: chosenProgram } }) });
        }).then(function (r) { return (r && r.ok) ? r.json() : null; })
          .then(function (resp) {
            if (resp && resp.leadId && resp.contactToken) { _lastGen = { leadId: resp.leadId, contactToken: resp.contactToken }; offerContactAsk(); }
          }).catch(function () {});
      };
      if (FORM_TOKEN.t && (Date.now() - FORM_TOKEN.at) < TOKEN_FRESH_MS) doSend();
      else fetchFormToken().then(function (t) { if (t) setTimeout(doSend, 3400); });
    } catch (e) {}
  }
  function offerContactAsk() {
    if (document.getElementById("tsContactAsk")) return;
    var box = document.createElement("div");
    box.id = "tsContactAsk";
    box.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:230;background:var(--card,#fff);border:1px solid var(--line,#d8d2c4);border-radius:12px;box-shadow:0 12px 32px rgba(10,14,17,.18);padding:14px 16px;max-width:340px";
    box.innerHTML = '<button type="button" id="tsAskX" aria-label="Close" style="position:absolute;top:6px;right:9px;border:0;background:none;cursor:pointer;font-size:1rem">\u2715</button>' +
      '<p style="margin:0 24px 8px 0;font-weight:600">Want us to follow up on this term sheet?</p>' +
      '<p style="margin:0 0 10px;font-size:.85rem;opacity:.75">Optional \u2014 leave an email or phone number and a YS Capital specialist will reach out.</p>' +
      '<input id="tsAskEmail" type="email" placeholder="Email" autocomplete="email" style="width:100%;margin:0 0 6px;padding:9px 11px;border:1px solid var(--line,#d8d2c4);border-radius:8px;font-size:16px">' +
      '<input id="tsAskPhone" type="tel" placeholder="Phone (optional)" autocomplete="tel" style="width:100%;margin:0 0 8px;padding:9px 11px;border:1px solid var(--line,#d8d2c4);border-radius:8px;font-size:16px">' +
      '<button type="button" id="tsAskSend" class="btn btn-solid" style="width:100%">Request a follow-up</button>' +
      '<p id="tsAskNote" style="display:none;margin:8px 0 0;font-size:.85rem"></p>';
    document.body.appendChild(box);
    document.getElementById("tsAskX").onclick = function () { box.remove(); };
    document.getElementById("tsAskSend").onclick = function () {
      var em = (document.getElementById("tsAskEmail").value || "").trim();
      var ph = (document.getElementById("tsAskPhone").value || "").trim();
      var noteEl = document.getElementById("tsAskNote");
      var warn = function (t) { noteEl.style.display = ""; noteEl.textContent = t; noteEl.style.color = "#b8604a"; };
      if (!em && !ph) return warn("Add an email or phone number first.");
      if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return warn("That email doesn't look right.");
      if (!_lastGen) { box.remove(); return; }
      fetch("/api/leads/contact", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId: _lastGen.leadId, contactToken: _lastGen.contactToken, email: em || undefined, phone: ph || undefined }) })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
        .then(function () { box.innerHTML = '<p style="margin:0;font-weight:600">Thanks \u2014 we\u2019ll be in touch shortly.</p>'; setTimeout(function () { box.remove(); }, 3800); })
        .catch(function () { warn("Couldn\u2019t save right now \u2014 you can also call 718-831-2168."); });
    };
  }
  /* ---- exception / manual-review ask (contact info + scenario \u2192 sales desk) ---- */
  function openExceptionAsk(d) {
    var old = document.getElementById("tsExcOv"); if (old) old.remove();
    var ov = document.createElement("div"); ov.id = "tsExcOv";
    ov.style.cssText = "position:fixed;inset:0;background:rgba(10,14,17,.55);z-index:240;display:flex;align-items:center;justify-content:center;padding:16px";
    ov.innerHTML = '<div style="background:var(--card,#fff);max-width:520px;width:100%;max-height:88vh;overflow:auto;border-radius:14px;padding:18px 20px;position:relative">' +
      '<button type="button" id="tsExcX" aria-label="Close" style="position:absolute;top:10px;right:12px;border:0;background:none;font-size:1.05rem;cursor:pointer">\u2715</button>' +
      '<h3 style="margin:0 0 6px">Request an exception / manual review</h3>' +
      '<p style="margin:0 0 12px;opacity:.8">We\u2019ll send this exact scenario to our team. Leave your contact info and a specialist will get back to you with options.</p>' +
      '<input id="tsExcName" placeholder="Your name" autocomplete="name" style="width:100%;margin:0 0 6px;padding:10px 12px;border:1px solid var(--line,#d8d2c4);border-radius:8px;font-size:16px">' +
      '<input id="tsExcEmail" type="email" placeholder="Your email" autocomplete="email" style="width:100%;margin:0 0 6px;padding:10px 12px;border:1px solid var(--line,#d8d2c4);border-radius:8px;font-size:16px">' +
      '<input id="tsExcPhone" type="tel" placeholder="Your phone" autocomplete="tel" style="width:100%;margin:0 0 6px;padding:10px 12px;border:1px solid var(--line,#d8d2c4);border-radius:8px;font-size:16px">' +
      '<textarea id="tsExcNote" placeholder="Anything we should know? (optional)" rows="3" style="width:100%;margin:0 0 8px;padding:10px 12px;border:1px solid var(--line,#d8d2c4);border-radius:8px;font-size:16px"></textarea>' +
      '<p id="tsExcErr" style="display:none;color:#b8604a;margin:0 0 8px"></p>' +
      '<button type="button" id="tsExcSend" class="btn btn-solid" style="width:100%">Send to our team \u2192</button></div>';
    document.body.appendChild(ov); document.body.style.overflow = "hidden";
    var close = function () { ov.remove(); document.body.style.overflow = ""; };
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    document.getElementById("tsExcX").onclick = close;
    document.getElementById("tsExcSend").onclick = function () {
      var nm = (document.getElementById("tsExcName").value || "").trim();
      var em = (document.getElementById("tsExcEmail").value || "").trim();
      var ph = (document.getElementById("tsExcPhone").value || "").trim();
      var extra = (document.getElementById("tsExcNote").value || "").trim();
      var err = document.getElementById("tsExcErr");
      var warn = function (t) { err.style.display = ""; err.textContent = t; };
      if (!em && !ph) return warn("Add your email or phone so we can get back to you.");
      if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return warn("That email doesn\u2019t look right.");
      var sum = manualReviewText(d);
      var ob = window.YSBRAND || {};
      var code = ob.email ? String(ob.email).split("@")[0].toLowerCase().replace(/[^a-z0-9._-]/g, "") : "";
      var sbtn = document.getElementById("tsExcSend");
      sbtn.disabled = true; sbtn.textContent = "Sending\u2026";
      fetch("/api/leads", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "term_sheet_exception", officerCode: code || undefined,
          name: nm || undefined, email: em || undefined, phone: ph || undefined,
          subject: "Exception request \u2014 " + (sum.subject.replace(/^Manual review request \u2014 /, "")),
          message: sum.body + (extra ? "\n\nVisitor note:\n" + extra : ""),
          formToken: FORM_TOKEN.t || undefined,
          payload: { kind: "exception_request", metaRows: dealMetaRows(d, "Exception request") } }) })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
        .then(function () {
          ov.firstChild.innerHTML = '<h3 style="margin:0 0 6px">Sent \u2713</h3><p style="margin:0;opacity:.8">Our team has your scenario and contact details \u2014 a specialist will reach out shortly.</p>';
          setTimeout(close, 3200);
        })
        .catch(function () { warn("We couldn\u2019t send this right now \u2014 please try again in a moment, or call 718-831-2168."); sbtn.disabled = false; sbtn.textContent = "Send to our team \u2192"; });
    };
  }
  function leadBody(s) {
    return ["New term sheet request from the Term Sheet Studio:", "",
      "Borrower / entity: " + (s.borrower || "(not provided)"),
      "Reply-to: " + s.email, "Program: " + s.program,
      "Property: " + (s.property || "TBD") + (s.state ? ", " + s.state : ""),
      "Loan amount: " + (s.loanAmount ? YS.fmtUSD(s.loanAmount) : "\u2014"),
      "Note rate: " + (s.rate ? fmtRate3(s.rate) + "%" : "\u2014"),
      "Term: " + (s.term ? s.term + " months" : "\u2014"),
      "Eligibility: " + (s.status || "\u2014"), "", "The term sheet PDF is attached. Please follow up."].join("\n");
  }
  // #99: send the term sheet straight to the branded officer SERVER-SIDE (a real
  // branded email with the PDF attached) \u2014 no .eml the visitor has to open. With
  // no branded officer the backend routes it to the sales desk.
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
    var d = calcChosen();
    var summary = {
      email: email, borrower: (borrowerOfRecord() || "").trim(),
      program: chosenProgramName(false),
      state: val("propState") || "", property: chk("addrTBD") ? "TBD" : (val("propAddr") || ""),
      loanAmount: (d && d.totalLoan) || 0, rate: (d && d.pricingReady && d.rate) ? d.rate : null,
      term: (d && d.term) || "", status: (d && d.status) || ""
    };
    if (btn) { btn.textContent = "Sending\u2026"; btn.disabled = true; }
    sendTermSheetToOfficer(summary).then(function () {
      if (note) { note.textContent = "Thanks \u2014 your term sheet is on its way to your YS Capital officer, who will follow up shortly."; note.style.color = ""; }
      if (btn) { btn.textContent = "Sent \u2713"; setTimeout(function () { btn.textContent = "Send it \u2192"; btn.disabled = false; }, 3200); }
    }).catch(function () {
      // Backend unreachable \u2192 tell the truth and let them retry (a CRM hook may
      // still capture it). No mail-client hand-off.
      var sent = false;
      if (typeof window.YS_CAPTURE_LEAD === "function") { try { window.YS_CAPTURE_LEAD(summary); sent = true; } catch (e) {} }
      if (sent) {
        if (note) { note.textContent = "Thanks \u2014 a YS Capital specialist will email your term sheet and follow up shortly."; note.style.color = ""; }
        if (btn) { btn.textContent = "Sent \u2713"; setTimeout(function () { btn.textContent = "Send it \u2192"; btn.disabled = false; }, 3200); }
        return;
      }
      if (note) { note.textContent = "We couldn\u2019t send this right now \u2014 please try again in a moment, or call 718-831-2168."; note.style.color = "#b8604a"; }
      if (btn) { btn.textContent = "Send it \u2192"; btn.disabled = false; }
    });
  }

  // ---- shared "inputs & how the loan was sized" page (POF page 2 + term sheet appendix) ----
  function drawDerivationPage(doc, d, title, intro) {
    doc.addPage();
    var W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 56;
    var INK = [20, 27, 34], TEAL = [47, 127, 134], GOLD = [174, 135, 70], GRAY = [75, 88, 92], DARK = [20, 27, 34], LINE = [223, 216, 203], BODY = [40, 46, 52];
    var money = function (n) { return YS.fmtUSD(Math.round(n || 0)); }; var money2 = function (n) { return YS.fmtUSD2(n || 0); };
    var pc = function (x) { var v = Math.round((x || 0) * 100 * 100) / 100; return v.toFixed(2).replace(/\.?0+$/, "") + "%"; };   // exact figure, up to 2 decimals trimmed
    var inp = d.inp || {}, isRefi = inp.loanType === "Refinance";
    var sc = YSP.normStrategy(inp.strategy), isBridge = sc === "BR", hasRehab = num("construction") > 0 || sc === "NC" || sc === "FF";
    var _dpProg = progOf(d);
    var _dpClose = estClosingYMD(), _dpFp = firstPaymentYMD(_dpClose), _dpMat = maturityYMD(_dpFp, inp.term || 12);

    // header
    doc.setFillColor.apply(doc, INK); doc.rect(0, 0, W, 66, "F");
    doc.setFillColor.apply(doc, GOLD); doc.rect(0, 66, W, 2, "F");
    doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.5); doc.line(0, 69.2, W, 69.2);   // fine warm hairline beneath the gold rule
    var lg = logoData(); if (lg) { var h = 27, w = lg.w * (h / lg.h); try { doc.addImage(lg.dataURI, "PNG", M, 20, w, h); } catch (e) {} }
    doc.setTextColor(244, 240, 231); doc.setFont("times", "bold"); doc.setFontSize(11.5);
    doc.text(pdfSafe(title), W - M, 33, { align: "right" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(176, 184, 186);
    doc.text(LENDER.name + "  \u00b7  NMLS " + LENDER.nmls, W - M, 48, { align: "right", charSpace: 0.3 });

    var y = 92;
    if (intro) {
      doc.setFont("helvetica", "italic"); doc.setFontSize(8.6); doc.setTextColor.apply(doc, GRAY);
      var il = doc.splitTextToSize(pdfSafe(intro), W - 2 * M);
      for (var i = 0; i < il.length; i++) { doc.text(il[i], M, y); y += 12; } y += 8;
    }
    function section(label, rows) {
      doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor.apply(doc, TEAL);
      doc.text(pdfSafe(label.toUpperCase()), M, y, { charSpace: 0.8 });
      doc.setDrawColor.apply(doc, GOLD); doc.setLineWidth(1.3); doc.line(M, y + 4, M + 30, y + 4);
      y += 16;
      for (var r = 0; r < rows.length; r++) {
        if (!rows[r]) continue;
        var kind = rows[r][2] || "", isTot = kind === "tot", isSub = kind === "sub";
        // Measure the value FIRST: a row that needs a second line grows, and the
        // total row's ivory band grows with it instead of half-covering it.
        var vf = fitSlotLines(doc, pdfSafe(rows[r][1]), (W - 2 * M) * 0.56, "helvetica", "bold", isSub ? 8 : 8.9, 7.5, 2);
        var vExtra = (vf.lines.length - 1) * 11;
        if (isTot) { doc.setFillColor(248, 245, 238); doc.rect(M, y - 10.5, W - 2 * M, 15 + vExtra, "F"); doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.7); doc.line(M, y - 9, W - M, y - 9); }
        doc.setFont("helvetica", isTot ? "bold" : "normal"); doc.setFontSize(isSub ? 8 : 8.9); doc.setTextColor.apply(doc, isSub ? GRAY : (isTot ? DARK : BODY));
        doc.text(pdfSafe(rows[r][0]), M + (isSub ? 12 : 0), y);
        doc.setFont("helvetica", "bold"); doc.setFontSize(vf.fs); doc.setTextColor.apply(doc, isTot ? TEAL : DARK);
        (function (f, base) { f.lines.forEach(function (ln, k) { doc.text(ln, W - M, base + k * 11, { align: "right" }); }); })(vf, y);
        y += (isSub ? 12.5 : 14.5) + vExtra;
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
      (assignOn && d.asg && (d.asg.overLimit || d.asg.overridden)) ? ["Effective purchase price \u2014 " + (d.asg.overridden ? "approved exception" : d.asg.dollarCap ? "fee capped at the program limit" : "fee counted up to 15% of the seller's price"), money(d.asg.recognizedPrice)] : null,
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

    // The derivation page has to answer "where did this number come from", so it
    // shows BOTH ceilings and never one that moves under a fixed-sounding label
    // (owner-reported 2026-07-30).
    var _dvTier = tierMaxOf(d), _dvLower = _dvTier && d.caps && pricedBelowTier(_dvTier, d.caps);
    section("Resulting leverage & pricing", [
      _dvTier ? ["Program maximum — LTC / as-is / ARV", pc(_dvTier.maxLTC) + " / " + pc(_dvTier.maxAcqLTV) + " / " + pc(_dvTier.maxARLTV) + "  (fixed for this profile)"] : null,
      _dvLower ? ["Most this deal can be priced at — LTC / ARV", pc(d.caps.maxLTC) + " / " + pc(d.caps.maxARLTV)] : null,
      _dvLower ? ["Why this deal is lower", pricedWhy(d, _dvTier, d.caps)] : null,
      (d.ltcPct > 0 && !isBridge) ? ["Loan-to-cost (LTC)", pc(d.ltcPct)] : null,
      ["Initial / as-is LTV", pc(d.ltvPct)],
      (d.arvPct > 0) ? ["Loan-to-ARV", pc(d.arvPct)] : null,
      ["Note rate (interest-only)", (d.rate > 0 ? fmtRate3(d.rate) + "%" : "\u2014")],
      ["Interest accrual", accrualLabel()],
      minInterestOn(_dpProg) ? ["Minimum interest", MIN_INTEREST_ROW] : null,
      deferredOrigPct() > 0 ? ["Deferred origination fee (paid at payoff)", pcFull(deferredOrigPct() / 100) + " of loan"] : null,
      ["Origination", origPctStr(d.origPct != null ? d.origPct : 0.0125) + " of loan"],
      isBridge ? null : ["Construction draw fee", drawFeeLines(_dpProg).join("; ")]
    ]);

    section("Key dates (estimated \u2014 from the estimated closing date)", [
      ["Loan term", (inp.term || 12) + " months"],
      ["Estimated closing date", _dpClose ? fmtDateLong(_dpClose) : "Not set"],
      ["First payment date", _dpFp ? fmtDateLong(_dpFp) : "\u2014"],
      ["Maturity date", _dpMat ? fmtDateLong(_dpMat) : "\u2014"]
    ]);

    // footer
    doc.setDrawColor.apply(doc, LINE); doc.setLineWidth(0.8); doc.line(M, H - 46, W - M, H - 46);
    doc.setFont("helvetica", "normal"); doc.setFontSize(6.8); doc.setTextColor(150, 158, 162);
    doc.text(pdfSafe((minInterestOn(_dpProg) ? MIN_INTEREST_DETAIL + " " : "") + "Figures are indicative, derived from the inputs above, and subject to full underwriting, appraisal/valuation, title and final credit approval. " + LENDER.name + " \u00b7 NMLS " + LENDER.nmls + "."), M, H - 34, { maxWidth: W - 2 * M });
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
    // Interest reserve months<->amount: capture-phase so the SOURCE field is marked
    // BEFORE the (bubble-phase) recompute above reads it. Programmatic mirror writes set
    // .value directly and never fire "input", so this can never loop.
    ["irMonths", "irAmount"].forEach(function (id) {
      var e = el(id);
      if (e) e.addEventListener("input", function () { setIrSource(id === "irAmount" ? "amount" : "months"); }, true);
    });
    ["origPrice", "price"].forEach(function (id) { var e = el(id); if (e) e.addEventListener("blur", validateAssign); });
    var slider = el("rLevSlider");
    if (slider) slider.addEventListener("input", function () {
      var isGold = chosenProgram === "gold", isSilver = chosenProgram === "silver";
      var rows = ((isGold ? goldLadder() : isSilver ? SVP.priceLadder(gather()) : YSP.priceLadder(gather())).rows) || [];
      if (!rows.length) return;
      var maxV = rows.length - 1;
      var idx = maxV - parseInt(slider.value, 10);
      if (idx < 0) idx = 0; if (idx > maxV) idx = maxV;
      var chosen = (idx === 0) ? null : rows[idx].ltc;             // top of range = max leverage
      if (isGold) goldChosenLTC = chosen; else if (isSilver) silverChosenLTC = chosen; else chosenLTC = chosen;
      recompute();
    });
    // Fetch the anti-bot form token at load — by the time a sheet is generated
    // it carries the human dwell the sales-desk notification endpoint checks.
    try { fetchFormToken(); } catch (e) {}
    var pdf = el("tsPdf"); if (pdf) pdf.addEventListener("click", function () {
      if (!readyToPrice()) { flash("Add the required fields (state, FICO, price and ARV) to download your term sheet."); return; }
      if (!canIssue(issueDeal())) { flash("This scenario isn't eligible as entered, so a term sheet can't be issued \u2014 use \u201CRequest an exception / manual review\u201D and our team will take a look."); return; }
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
    var svcard = el("pcardSilver"); if (svcard) svcard.addEventListener("click", function () { selectProgram("silver"); });
    var mcard = el("pcardManual"); if (mcard) mcard.addEventListener("click", function () { selectProgram("manual"); });
    // The stat columns get narrower as the viewport shrinks, so the adaptive
    // font-size ladder has to re-run on resize — otherwise a value that fitted at
    // 1440px would spill at 1024px until the next recompute.
    (function () {
      var t = null;
      window.addEventListener("resize", function () {
        if (t) clearTimeout(t);
        t = setTimeout(function () { t = null; try { fitStats(); } catch (e) {} }, 90);
      });
    })();
    // TBD confirmation (owner-directed 2026-07-29): ticking "Property is TBD" must be
    // an explicit, informed choice — without the full address the engines can't check
    // ZIP / city / county / borough restrictions (the state alone isn't enough), so
    // the user agrees before the address is waived. Fires only on a REAL interaction:
    // programmatic restores (share link / Excel import / studio prefill) set .checked
    // directly without dispatching events (suite.js applyState), so they never nag.
    var tbdBox = el("addrTBD"), tbdWarn = el("tbdWarn");
    if (tbdBox && tbdWarn) {
      var tbdAgreed = false;
      var tbdClose = function (agree) {
        tbdWarn.classList.add("hidden");
        if (agree) { tbdAgreed = true; return; }
        tbdBox.checked = false;
        updateConditionals(); recompute();
        var addrF = el("propAddr"); if (addrF) { try { addrF.focus(); } catch (_) { } }
      };
      var tbdAgreeBtn = el("tbdWarnAgree"), tbdBackBtn = el("tbdWarnBack");
      tbdBox.addEventListener("change", function () {
        if (tbdBox.checked && !tbdAgreed) {
          tbdWarn.classList.remove("hidden");
          // Move focus INTO the dialog so keyboard users land on the safe choice
          // (and Escape works — the key fires where the focus is).
          if (tbdBackBtn) { try { tbdBackBtn.focus(); } catch (_) { } }
        }
      });
      if (tbdAgreeBtn) tbdAgreeBtn.addEventListener("click", function () { tbdClose(true); });
      if (tbdBackBtn) tbdBackBtn.addEventListener("click", function () { tbdClose(false); });
      // Document-level so Escape closes no matter where the focus sits.
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && !tbdWarn.classList.contains("hidden")) tbdClose(false);
      });
    }
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
            if (d.markupSilverPct != null) CO.markupSilver = Number(d.markupSilverPct);
            if (d.origStdPct != null) CO.origStd = Number(d.origStdPct);
            if (d.origGoldPct != null) CO.origGold = Number(d.origGoldPct);
            if (d.origSilverPct != null) CO.origSilver = Number(d.origSilverPct);
            if (d.lenderFee != null) CO.lender = Number(d.lenderFee);
            if (d.creditFee != null) CO.credit = Number(d.creditFee);
            if (d.appraisalFee != null) CO.appraisal = Number(d.appraisalFee);
            CO.title = (d.titleFee != null ? Number(d.titleFee) : null);
            CO.extraFees = Array.isArray(d.extraFees) ? d.extraFees : [];
            // Per-tier markup company defaults (item 15) — { standard:{1,2,3},
            // gold, silver } of percents, or null (feature off). syncAdminMarkup
            // pushes it into the engines; null keeps the historic per-tier markup.
            CO.markupTiers = (d.markupTiers && typeof d.markupTiers === "object") ? d.markupTiers : null;
          }
        }).catch(function(){}).then(function(){ seedAdminDefaults(); recompute(); });
      } catch (e) { recompute(); }
    })();
  }
  window.TS = { exportPdf: exportPdf, exportLetter: exportLetter, exportXlsx: exportXlsx, importXlsx: importXlsx, share: function (b) { try { YS.shareLink(b); } catch (e) {} },
    _calc: calc, _calcGold: calcGold, _calcSilver: calcSilver, _xlsxSections: xlsxSections, _gather: gather, _manualOn: manualOn };
  window.APP = window.TS;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire); else wire();
})();
