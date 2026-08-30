'use strict';
/**
 * LONG-TERM TERM SHEETS — the SERVER's copy of the compensation overlay.
 *
 * ⛔ THIS IS A MIRROR, AND A MIRROR THAT IS ALLOWED TO DRIFT IS WORSE THAN NO
 * MIRROR. The canonical module is `app-v2/src/longterm/compOverlay.js`; this file
 * exists because a term sheet is rendered on the SERVER and a screen cannot
 * require server code (the `lib/payoff.js` arrangement this repository uses
 * throughout, and the same reason `app-v2/src/longterm/dscrCalc.js` mirrors
 * `src/longterm/encompass/formulas.js`).
 *
 * `scripts/test-lt-termsheet-overlay-mirror.mjs` runs BOTH modules over a battery
 * that spans every branch — the two comp modes, prices above / at / below par,
 * the waive with a credit that covers the fees and one that cannot, and every
 * refusal — and fails the moment they disagree on a single figure. Change one,
 * change the other, in the same commit.
 *
 * WHY THE SERVER RE-DERIVES THE MONEY AT ALL, rather than storing what the
 * browser computed: a term sheet is a document we issue, and the figures on it
 * must be ours. The client posts the vendor's raw price and the officer's
 * choices; every dollar on the page is worked out here, from the compensation
 * plan the server itself resolved. That is also what makes the officer's copy
 * and the borrower's copy provably the same document.
 *
 * ⛔ NOTHING HERE EVER REACHES THE WIRE. Lender Price is asked the same question
 * in every mode (`search-model.js` pins `compensationType: 'BorrowerCompPlan'`);
 * this is display arithmetic on the answer. Owner-directed 2026-08-23: *"We are
 * building overlays on top of Lender Price … Leave Lender Price exactly how it
 * is."*
 *
 * PURE: no database, no network, no requires.
 */

/** The three positions of the switch, in the owner's own display order —
 *  *"the middle should be raw pricing, and the left should be borrower-paid
 *  and the right lender-paid"*.
 *
 *  DELIBERATELY A DIFFERENT SHAPE FROM THE BROWSER'S COPY, which carries a
 *  display LABEL per position because it draws the switch. The server has no
 *  business holding a label for a control it never renders, so what the drift
 *  guard compares here is the ORDER. */
const COMP_MODES = ['borrowerPaid', 'raw', 'lenderPaid'];

/** The positions a TERM SHEET may be issued from. Raw is deliberately absent —
 *  owner-directed 2026-08-30: *"raw pricing should not be able to export term
 *  sheets, only borrower-paid or lender-paid."* */
const ISSUABLE_MODES = ['borrowerPaid', 'lenderPaid'];

const nn = (v) => Number.isFinite(v);
const r3 = (v) => Math.round(v * 1000) / 1000;   // points, to a thousandth
const r2 = (v) => Math.round(v * 100) / 100;     // dollars, to the cent

/**
 * A compensation plan as this module needs it, or null.
 *
 * ⛔ FAIL TO NOTHING, NEVER TO A WRONG NUMBER. A plan with a missing or
 * unreadable figure is refused WHOLE. `Number(null)` and `Number('')` are both
 * 0 — a finite, non-negative, completely wrong figure — so absence is refused
 * BEFORE coercion, or a plan the resolver marked unreadable would normalize to
 * "everybody works for free and the fees are $0".
 */
function normalizePlan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const p = {};
  for (const k of ['lenderPaid', 'borrowerPaid', 'ysp', 'applicationFee', 'commitmentFee']) {
    const v = raw[k];
    if (v == null || (typeof v === 'string' && v.trim() === '')) return null;
    const n = Number(v);
    if (!nn(n) || n < 0) return null;
    p[k] = n;
  }
  return p;
}

/**
 * How many POINTS the displayed price moves down from the raw one.
 *
 *   raw          → 0     (the identity)
 *   lenderPaid   → the lender-paid comp (the investor pays it, so the price the
 *                  file gets is that much lower)
 *   borrowerPaid → the YSP only. The borrower-paid comp does NOT move the price
 *                  — it is charged as origination on the fee list instead.
 *
 * An unknown mode or an unreadable plan answers null: "cannot overlay", never a
 * silent 0.
 */
function compShiftPoints(mode, plan) {
  if (mode === 'raw') return 0;
  const p = normalizePlan(plan);
  if (!p) return null;
  if (mode === 'lenderPaid') return r3(p.lenderPaid);
  if (mode === 'borrowerPaid') return r3(p.ysp);
  return null;
}

/** A price with the shift applied. Null-safe on both sides. */
function shiftedPrice(rawPrice, shift) {
  if (!nn(rawPrice) || !nn(shift)) return null;
  return r3(rawPrice - shift);
}

/**
 * THE FEE LIST for one quote. Null in raw mode (raw is the vendor's answer
 * verbatim, not our charging story) and null when the inputs cannot carry the
 * arithmetic — a missing raw price or loan amount yields NO fee list rather than
 * one with invented figures.
 *
 * THE WAIVE (lender-paid only): the two lender-fee lines do not populate and
 * their cash comes out of the CREDIT — or, when the credit cannot cover them,
 * lands on the BUYDOWN — in DOLLARS, not points, so the buydown line a waive has
 * touched carries cash-derived points and can never disagree with its own
 * dollars.
 */
function quoteCharges(mode, plan, rawPrice, loanAmount, waiveLenderFees = false) {
  if (mode === 'raw') return null;
  const p = normalizePlan(plan);
  const shift = compShiftPoints(mode, p);
  if (p == null || shift == null) return null;
  if (!nn(rawPrice)) return null;
  const loan = nn(loanAmount) && loanAmount > 0 ? loanAmount : null;
  if (loan == null) return null;

  const displayPrice = shiftedPrice(rawPrice, shift);
  const ptsToDollars = (pts) => r2((pts / 100) * loan);

  const parGap = r3(displayPrice - 100);
  let creditDollars = parGap > 0 ? ptsToDollars(parGap) : 0;
  let buydownDollars = parGap < 0 ? ptsToDollars(-parGap) : 0;

  const lines = [];

  // ORIGINATION — borrower-paid only. Under lender-paid the investor pays the
  // compensation and the borrower pays no origination, so the line is ABSENT
  // rather than printed as zero.
  if (mode === 'borrowerPaid' && p.borrowerPaid > 0) {
    lines.push({
      key: 'origination', label: 'Origination',
      points: r3(p.borrowerPaid), dollars: ptsToDollars(p.borrowerPaid),
    });
  }

  const feeTotal = r2(p.applicationFee + p.commitmentFee);
  const waived = mode === 'lenderPaid' && waiveLenderFees === true;
  let waivedDollars = 0;
  if (waived) {
    waivedDollars = feeTotal;
    const short = r2(feeTotal - creditDollars);
    if (short <= 0) {
      creditDollars = r2(creditDollars - feeTotal);
    } else {
      creditDollars = 0;
      buydownDollars = r2(buydownDollars + short);
    }
  }

  if (buydownDollars > 0) {
    lines.push({
      key: 'buydown', label: 'Buydown (discount points)',
      points: r3((buydownDollars / loan) * 100), dollars: buydownDollars,
    });
  }

  if (!waived) {
    lines.push({ key: 'applicationFee', label: 'Application fee', points: null, dollars: r2(p.applicationFee) });
    lines.push({ key: 'commitmentFee', label: 'Commitment fee', points: null, dollars: r2(p.commitmentFee) });
  }

  const borrowerPaysDollars = r2(lines.reduce((s, l) => s + (nn(l.dollars) ? l.dollars : 0), 0));
  const borrowerCreditDollars = r2(creditDollars);

  return {
    mode,
    displayPrice,
    lines,
    credit: borrowerCreditDollars > 0
      ? { points: r3((borrowerCreditDollars / loan) * 100), dollars: borrowerCreditDollars }
      : null,
    waivedDollars,
    borrowerPaysDollars,
    borrowerCreditDollars,
    netDollars: r2(borrowerPaysDollars - borrowerCreditDollars),
  };
}

/**
 * THE CLOSING SHEET — the totals under the fee list, ending in the one number a
 * deal is priced for: what the borrower brings to the table.
 *
 * `downPaymentDollars` is null on a REFINANCE (there is no down payment) rather
 * than a fabricated 0, and null when the value or the loan cannot be read, or
 * the loan exceeds the value — a data problem is never rendered as a negative
 * down payment. A credit REDUCES cash to close, which is what a credit is on
 * every closing statement.
 *
 * ⛔ DISPLAY MATH ONLY. Nothing here prices a loan or reaches the wire.
 */
function closingSheet(charges, deal) {
  if (!charges || typeof charges !== 'object' || !Array.isArray(charges.lines)) return null;
  const d = deal && typeof deal === 'object' ? deal : {};
  const lineDollars = (key) => {
    const l = charges.lines.find((x) => x && x.key === key);
    return l && nn(l.dollars) ? l.dollars : 0;
  };
  const originationDollars = r2(lineDollars('origination'));
  const lenderFeesDollars = r2(lineDollars('applicationFee') + lineDollars('commitmentFee'));
  const buydownDollars = r2(lineDollars('buydown'));
  const closingCostDollars = nn(charges.netDollars) ? r2(charges.netDollars) : null;

  const value = nn(d.propertyValue) && d.propertyValue > 0 ? d.propertyValue : null;
  const loan = nn(d.loanAmount) && d.loanAmount > 0 ? d.loanAmount : null;
  const purchase = d.purpose === 'Purchase';
  const downPaymentDollars = purchase && value != null && loan != null && value >= loan
    ? r2(value - loan) : null;
  const downPaymentPct = downPaymentDollars != null && value
    ? Math.round((downPaymentDollars / value) * 10000) / 100 : null;

  const cashToCloseDollars = closingCostDollars == null
    ? null
    : r2((downPaymentDollars != null ? downPaymentDollars : 0) + closingCostDollars);

  return {
    originationDollars, lenderFeesDollars, buydownDollars, closingCostDollars,
    downPaymentDollars, downPaymentPct, cashToCloseDollars,
    purchase,
  };
}

/**
 * The monthly principal-and-interest payment.
 *
 * TWO SHAPES, picked by what the scenario says — the same rule
 * `app-v2/src/longterm/dscrCalc.js` carries, and for the same reason: during an
 * interest-only period nothing is being repaid, so the term does not enter it.
 * A ZERO rate is answered directly rather than divided by.
 */
function monthlyPI({ loanAmount, ratePct, termYears, interestOnly }) {
  if (!nn(loanAmount) || loanAmount <= 0) return null;
  if (!nn(ratePct) || ratePct < 0) return null;
  const r = ratePct / 100 / 12;
  if (interestOnly) return r2(loanAmount * r);
  if (!nn(termYears) || termYears <= 0) return null;
  const n = Math.round(termYears * 12);
  if (n <= 0) return null;
  if (r === 0) return r2(loanAmount / n);
  return r2((loanAmount * r) / (1 - Math.pow(1 + r, -n)));
}

module.exports = {
  COMP_MODES, ISSUABLE_MODES,
  normalizePlan, compShiftPoints, shiftedPrice, quoteCharges, closingSheet, monthlyPI,
};
