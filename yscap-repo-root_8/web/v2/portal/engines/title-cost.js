/* =====================================================================
   YS Capital — Title cost estimator
   ---------------------------------------------------------------------
   Produces a planning ESTIMATE of the borrower's title-related closing
   costs for an RTL transaction, driven by three inputs:
       • state            (per-state cost regime / rate index)
       • loan amount      (lender's title-insurance premium scales with it)
       • transaction type (purchase vs refinance — refis get a reissue credit)

   What's included:
       • Lender's title-insurance premium (loan policy, 100% of the loan)
       • Title search / examination, settlement / escrow / closing fee,
         lender endorsements, and deed + mortgage recording fees
         (bundled per-state "fee").

   What's EXCLUDED (intentionally — quoted separately, vary by deal, and
   are frequently seller-paid): real-estate transfer taxes, mortgage /
   recordation taxes, owner's title policy, and any survey.

   These are estimates for planning the cash-to-close, NOT a title quote.
   The settlement agent issues the binding figures at closing.
   ===================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.YSTitle = api;
})(this, function () {
  "use strict";

  /* Lender's title-insurance premium on the LOAN amount.
     Regressive marginal schedule (rate per $1,000), national baseline = index 1.00.
     Promulgated states (TX / FL / NM) and high filed-rate states sit above 1.00 via
     the per-state index below; low-cost states sit below it. */
  var BANDS = [
    { upTo: 250000,    rate: 4.50 },   // first $250k
    { upTo: 500000,    rate: 3.75 },   // $250k – $500k
    { upTo: 1000000,   rate: 3.00 },   // $500k – $1M
    { upTo: 2000000,   rate: 2.25 },   // $1M – $2M
    { upTo: Infinity,  rate: 1.75 }    // $2M+
  ];

  function basePremium(loan) {
    loan = Math.max(0, loan || 0);
    var prev = 0, prem = 0;
    for (var i = 0; i < BANDS.length; i++) {
      var b = BANDS[i];
      if (loan <= prev) break;
      var slice = Math.min(loan, b.upTo) - prev;
      prem += (slice / 1000) * b.rate;
      prev = b.upTo;
    }
    return prem;
  }

  /* Per-state factors.
       premIdx — multiplies the lender's premium (relative to the national baseline)
       fee     — fixed bundle: title search/exam + settlement/escrow + endorsements
                 + deed & mortgage recording (attorney-closing states run higher)   */
  var DEF = { premIdx: 1.00, fee: 1150 };
  var STATE = {
    // Promulgated-rate states (highest premiums, set by the state)
    FL: { premIdx: 1.45, fee: 1050 }, TX: { premIdx: 1.40, fee: 1000 }, NM: { premIdx: 1.35, fee: 1000 },
    // High filed-rate / attorney-closing states
    NY: { premIdx: 1.35, fee: 1650 }, PA: { premIdx: 1.45, fee: 1400 }, DE: { premIdx: 1.30, fee: 1400 },
    MD: { premIdx: 1.25, fee: 1400 }, NJ: { premIdx: 1.20, fee: 1500 }, CT: { premIdx: 1.20, fee: 1400 },
    MA: { premIdx: 1.15, fee: 1400 }, RI: { premIdx: 1.15, fee: 1350 }, HI: { premIdx: 1.20, fee: 1200 },
    DC: { premIdx: 1.30, fee: 1400 },
    // Mid-high
    CA: { premIdx: 1.25, fee: 1100 }, IL: { premIdx: 1.15, fee: 1200 }, VA: { premIdx: 1.10, fee: 1200 },
    OH: { premIdx: 1.05, fee: 1100 }, WA: { premIdx: 1.10, fee: 1100 }, OR: { premIdx: 1.10, fee: 1100 },
    CO: { premIdx: 1.05, fee: 1000 }, NV: { premIdx: 1.05, fee: 1000 }, AZ: { premIdx: 1.00, fee: 950 },
    SC: { premIdx: 1.05, fee: 1300 }, AK: { premIdx: 1.05, fee: 1100 },
    // Mid (national-baseline premium, fees vary by closing custom)
    GA: { premIdx: 1.00, fee: 1200 }, NC: { premIdx: 1.00, fee: 1150 }, AL: { premIdx: 1.00, fee: 1200 },
    TN: { premIdx: 1.00, fee: 1100 }, MI: { premIdx: 1.00, fee: 1050 }, UT: { premIdx: 1.00, fee: 950 },
    ME: { premIdx: 1.00, fee: 1300 }, VT: { premIdx: 1.00, fee: 1300 }, NH: { premIdx: 1.00, fee: 1200 },
    MN: { premIdx: 0.95, fee: 1050 }, WI: { premIdx: 0.95, fee: 1050 },
    // Lower-cost
    MO: { premIdx: 0.70, fee: 950 }, IA: { premIdx: 0.65, fee: 900 }, MS: { premIdx: 0.80, fee: 1200 },
    SD: { premIdx: 0.80, fee: 1100 }, ND: { premIdx: 0.80, fee: 1150 }, NE: { premIdx: 0.80, fee: 950 },
    KS: { premIdx: 0.80, fee: 950 }, AR: { premIdx: 0.80, fee: 1000 }, KY: { premIdx: 0.85, fee: 1100 },
    WV: { premIdx: 0.85, fee: 1200 }, OK: { premIdx: 0.80, fee: 1000 }, WY: { premIdx: 0.85, fee: 950 },
    MT: { premIdx: 0.85, fee: 1000 }, ID: { premIdx: 0.90, fee: 950 }
    // IN and LA are program-ineligible states — no factors required.
  };

  /* Refinances still need a new lender's policy at 100% of the loan, but commonly
     receive a reissue / substitution credit on the premium. */
  var REFI_PREMIUM_FACTOR = 0.80;

  function isRefi(txn) {
    return ((txn || "") + "").toLowerCase().indexOf("refi") > -1;
  }

  /* estimate(state, loan, txnType) -> { total, premium, fees, state, known, refi } */
  function estimate(state, loan, txnType) {
    var st = ((state || "") + "").trim().toUpperCase();
    var f = STATE[st] || DEF;
    loan = Math.max(0, loan || 0);
    var refi = isRefi(txnType);
    var premium = basePremium(loan) * f.premIdx * (refi ? REFI_PREMIUM_FACTOR : 1);
    var fees = f.fee;
    var total = Math.round((premium + fees) / 5) * 5;        // nearest $5
    return {
      total: loan > 0 ? total : 0,
      premium: Math.round(premium),
      fees: fees,
      state: st || null,
      known: !!STATE[st],
      refi: refi
    };
  }

  return { estimate: estimate, basePremium: basePremium, STATE: STATE, DEF: DEF, BANDS: BANDS };
});
