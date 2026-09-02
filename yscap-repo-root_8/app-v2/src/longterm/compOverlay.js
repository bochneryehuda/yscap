/**
 * LONG-TERM PRICING ENGINE — the COMPENSATION OVERLAY.
 *
 * Owner-directed 2026-08-23, and the one rule everything here serves:
 *
 *   "We are building overlays on top of Lender Price. You are not going to actually take
 *    this switch in Lender Price. You are going to leave Lender Price always searched as
 *    borrower-paid. This is just overlays on top of them. … Leave Lender Price exactly
 *    how it is. We're not doing any changes to Lender Price right now."
 *
 * ⛔ NOTHING IN THIS MODULE EVER REACHES THE WIRE. The search request is built by
 * `scenarioFields.toScenario` and the server pins `compensationType: 'BorrowerCompPlan'`
 * (src/longterm/lenderprice/search-model.js) — the vendor is asked the same question in
 * every mode. This module only decides how the ANSWER is displayed and what the fee list
 * says. Raw mode is the identity: shift 0, no fee list, the vendor's numbers verbatim.
 *
 * THE MODEL, in the owner's own numbers (lender-paid comp of 2.0):
 *
 *     raw 102  →  shows 100 (par)  — the investor pays us the 2; no origination charged.
 *     raw 103  →  shows 101       — the borrower receives a 1.000 credit.
 *     raw 101  →  shows  99       — the borrower pays a 1.000 buydown.
 *
 * (The dictation said "1.4" on that last row; the owner confirmed 2026-08-23 it was a
 *  slip of language — the rule as stated gives 1.000.)
 *
 * Borrower-paid keeps the raw price on the board (less any YSP, below) and charges the
 * comp as ORIGINATION on the fee list instead. The owner's YSP example: raw 100.25 with
 * a 0.25 YSP shows 100, the fee list shows only the origination, and the YSP itself is
 * never printed — "keeping the YSP invisible. The lender-paid compensation should always
 * also be kept invisible on both of the sides." That is why nothing this module returns
 * for a comp mode ever contains the words or the figures of the plan — only prices,
 * charges and credits.
 *
 * PURE, AND DELIBERATELY NOT JSX — the same reason as priceBuild.js: what a money figure
 * MEANS must be testable by CI, and CI installs no front-end build tools. Plain ESM,
 * no imports, so `node scripts/test-lt-comp-overlay.mjs` loads it directly.
 */

/** The three positions of the switch, in DISPLAY ORDER — raw in the middle, exactly as
 *  the owner drew it: "the middle should be raw pricing, and the left should be
 *  borrower-paid and the right lender-paid". */
export const COMP_MODES = [
  { value: 'borrowerPaid', label: 'Borrower-paid' },
  { value: 'raw', label: 'Raw pricing' },
  { value: 'lenderPaid', label: 'Lender-paid' },
];

/** The default the board opens on. "The way it should work on default, the search should
 *  be raw pricing." */
export const DEFAULT_COMP_MODE = 'raw';

/** The seeded figures, DOCUMENTED here and pinned by test against the server's declared
 *  settings defaults (scripts/test-lt-comp-plan.mjs) so the two can never drift. The live
 *  plan always comes from the server (settings resolve person → company → these); this
 *  constant is never used to price — a missing plan fails to raw, never to this. */
export const DEFAULT_COMP_PLAN = {
  lenderPaid: 2.0, borrowerPaid: 2.0, ysp: 0, applicationFee: 1595, commitmentFee: 500,
};

const nn = (v) => Number.isFinite(v);
const r3 = (v) => Math.round(v * 1000) / 1000;   // points, to a thousandth — how a rate sheet quotes
const r2 = (v) => Math.round(v * 100) / 100;     // dollars, to the cent

/**
 * A compensation plan as this module needs it, or null.
 *
 * ⛔ FAIL TO RAW, NEVER TO A WRONG NUMBER. A plan with a missing or unreadable figure is
 * NOT patched with a guess — the whole plan is refused, the caller gets null, and the
 * screen's rule is that a null plan means the comp modes show raw pricing WITH A NOTICE.
 * A quietly-invented 0 here would price every loan as though the person works for free;
 * a quietly-invented 2 would charge somebody the company default they had overridden.
 */
export function normalizePlan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const p = {};
  for (const k of ['lenderPaid', 'borrowerPaid', 'ysp', 'applicationFee', 'commitmentFee']) {
    const v = raw[k];
    // ⛔ `Number(null)` and `Number('')` are BOTH 0 — a finite, non-negative, completely
    // wrong figure. A plan the server marked unreadable (nulls) would have normalized to
    // "everybody works for free and the fees are $0". Absence is refused BEFORE coercion.
    if (v == null || (typeof v === 'string' && v.trim() === '')) return null;
    const n = Number(v);
    if (!nn(n) || n < 0) return null;
    p[k] = n;
  }
  return p;
}

/**
 * How many POINTS the displayed price moves down from the raw one, per mode.
 *
 *   raw          → 0     (the identity — the board is Lender Price verbatim)
 *   lenderPaid   → the lender-paid comp (the investor pays it, so the price the file
 *                  gets is that much lower)
 *   borrowerPaid → the YSP only (default 0 → the raw price). The borrower-paid comp
 *                  itself does NOT move the price — it is charged as origination on
 *                  the fee list instead.
 *
 * An unknown mode or a null plan answers null — "cannot overlay", which the screen
 * treats as raw-with-a-notice, never as a silent 0.
 */
export function compShiftPoints(mode, plan) {
  if (mode === 'raw') return 0;
  const p = normalizePlan(plan);
  if (!p) return null;
  if (mode === 'lenderPaid') return r3(p.lenderPaid);
  if (mode === 'borrowerPaid') return r3(p.ysp);
  return null;
}

/** A price with the shift applied. Null-safe on both sides: no price or no shift → null,
 *  and the screen draws its em dash rather than inventing par. */
export function shiftedPrice(rawPrice, shift) {
  if (!nn(rawPrice) || !nn(shift)) return null;
  return r3(rawPrice - shift);
}

/**
 * The drill-down's price build, shifted CONSISTENTLY.
 *
 * Price is 100 − points, so moving the displayed price DOWN by `shift` is moving the
 * points UP by `shift` — and it is applied to the BASE, exactly the mechanic the owner
 * described investors using ("we're putting it somewhere in the backend, and they show
 * the base price higher"). The LLPA lines are untouched, so the arithmetic the screen
 * shows still sums: shifted base + the same adjustments = shifted final. The build
 * never says why the base moved — the comp stays invisible, as directed.
 */
export function shiftBuild(b, shift) {
  const src = b && typeof b === 'object' ? b : {};
  if (!nn(shift) || shift === 0) return src;
  return {
    ...src,
    basePoints: nn(src.basePoints) ? r3(src.basePoints + shift) : src.basePoints,
    /* ⛔ THE BASE PRICE MOVES WITH THE BASE POINTS, or the two rows contradict each other.
       Only a sheet that STATES a base price has this key — LoanNEX does, Lender Price does not —
       so leaving it out shifted one vendor's base and not the other's: on a LoanNEX row with the
       comp switch on, "Base price" and "Base points" stopped satisfying price = 100 − points and
       disagreed by exactly the comp shift, while the same row on Lender Price stayed consistent
       because its price is derived from the points that had moved. One line, one vendor, and the
       two boards no longer describe the same base two ways. */
    basePrice: nn(src.basePrice) ? r3(src.basePrice - shift) : src.basePrice,
    adjustedPoints: nn(src.adjustedPoints) ? r3(src.adjustedPoints + shift) : src.adjustedPoints,
    price: nn(src.price) ? r3(src.price - shift) : src.price,
  };
}

/**
 * ONE lender-fee line — LISTED WHETHER OR NOT IT IS WAIVED.
 *
 * ⛔ A WAIVED FEE IS NAMED AND SHOWN AT ZERO, NEVER OMITTED. Owner-directed
 * 2026-08-30: *"On the one where it has lender fees, you need to list out the
 * lender fees, because the next one, you're waiving the lender fees. You need to
 * be able to see the difference."* A comparison whose waived column simply has
 * two fewer rows than the column beside it does not SHOW a difference — it hides
 * one, and the reader has to notice an ABSENCE to find the saving that is the
 * entire point of the option.
 *
 * ⛔ THE ARITHMETIC IS UNMOVED, BY CONSTRUCTION. `dollars` is 0 on a waived
 * line — exactly the 0 that `lineDollars()` already returned when the line was
 * absent — so every total downstream is byte-identical to before this changed.
 * `fullDollars` carries what it WOULD have been, which is what lets the sheet
 * print the saving rather than leave the reader to work it out.
 */
function feeLine(key, label, amount, waived) {
  const full = r2(amount);
  return waived
    ? { key, label, points: null, dollars: 0, waived: true, fullDollars: full }
    : { key, label, points: null, dollars: full, waived: false, fullDollars: full };
}

/**
 * THE FEE LIST for one quote — "every single DSCR file should list the fees that we're
 * charging": origination (if there is one), the buydown (if the price is under par),
 * and the two lender fees, the $1,595 application and the $500 commitment (both live in
 * settings, seeded with exactly those figures).
 *
 * Returns null in raw mode (raw is the vendor's answer verbatim, not our charging
 * story) and null when the inputs cannot carry the arithmetic — a missing raw price or
 * loan amount yields NO fee list rather than one with invented figures.
 *
 * The answer, for a comp mode:
 *   {
 *     mode, displayPrice,
 *     lines: [{ key, label, points, dollars, basis?, waived?, fullDollars? }...],
 *     credit: { points, dollars } | null,            // what comes back, after any waive
 *     waivedDollars,                                 // 0 unless the waive applied
 *     borrowerPaysDollars, borrowerCreditDollars, netDollars,
 *   }
 *
 * THE WAIVE (lender-paid only — "borrower-paid compensation should not have the option
 * [to] waive lender fees"): the two lender-fee lines are still LISTED, at zero, with
 * what they would have been (see `feeLine` — the owner asked to be able to SEE the
 * difference against the option beside it), and their cash
 * comes out of the CREDIT — or, when the credit cannot cover them, lands on the BUYDOWN
 * — in DOLLARS, not points: "if it's a $100[k] loan, then this deduction is more than
 * two points, but if it's a $1 million loan, then the deduction is less than 0.2 points.
 * It should take it down from the actual cash calculation." So the buydown/credit line
 * a waive has touched carries cash-derived points (cash ÷ loan × 100), not grid points.
 */
export function quoteCharges(mode, plan, rawPrice, loanAmount, waiveLenderFees = false) {
  if (mode === 'raw') return null;
  const p = normalizePlan(plan);
  const shift = compShiftPoints(mode, p);
  if (p == null || shift == null) return null;
  if (!nn(rawPrice)) return null;
  const loan = nn(loanAmount) && loanAmount > 0 ? loanAmount : null;
  if (loan == null) return null;

  const displayPrice = shiftedPrice(rawPrice, shift);
  const ptsToDollars = (pts) => r2((pts / 100) * loan);

  // The gap from par, off the DISPLAYED price — above par comes back, below par is paid.
  const parGap = r3(displayPrice - 100);
  let creditDollars = parGap > 0 ? ptsToDollars(parGap) : 0;
  let buydownDollars = parGap < 0 ? ptsToDollars(-parGap) : 0;

  const lines = [];

  // ORIGINATION — borrower-paid only. In lender-paid the investor pays the comp and the
  // borrower pays no origination; the line is simply absent rather than printed as zero.
  if (mode === 'borrowerPaid' && p.borrowerPaid > 0) {
    lines.push({
      key: 'origination', label: 'Origination',
      points: r3(p.borrowerPaid), dollars: ptsToDollars(p.borrowerPaid),
      // The BASIS the points were taken of, so a sheet can break the fee down
      // ("2.000 points of the $375,000 loan amount") instead of asserting a
      // dollar figure the reader has to take on trust.
      basis: loan,
    });
  }

  // THE WAIVE — cash, off the credit first, then onto the buydown. Only lender-paid
  // offers it; a waive flag arriving in any other mode is ignored rather than obeyed.
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

  // THE BUYDOWN — what it costs to be under par.
  //
  // ⛔ THE DOLLARS ARE THE MONEY; THE POINTS ARE A ROUNDED RESTATEMENT OF THEM, and on a
  // waive-touched line the two can differ by ONE ROUNDING STEP. This comment used to claim
  // they "can never disagree", which is not true and was measured: at price 100.2 on a
  // $375,000 loan with the fees waived the line reads 2.359 points and $8,845, while 2.359%
  // of that loan is $8,846.25 — a $1.25 gap, and up to loan x 0.000005 (≈$25 on $5M).
  //
  // It is inherent, not a bug to route around: without a waive the DOLLARS are derived from
  // the points (they agree exactly); with one, the cash is the fact and the points are
  // derived back from it, and a 3-decimal points figure cannot express an arbitrary cash
  // amount. Deriving the dollars from the rounded points instead would make the POINTS
  // authoritative and move real money in every total, which is far worse than a rounding
  // step in a display figure. So the dollars stay authoritative and the gap is BOUNDED —
  // `test-lt-comp-overlay.mjs` fails if it ever exceeds one rounding step, which is what
  // would catch a changed rounding or a wrong basis.
  //
  // ⛔ DECIDED 2026-08-30 — THE POINTS STAY, AND THIS IS NOT AN OVERSIGHT. The term sheet
  // prints this line as "You pay $8,845.00 (2.359 pts)", so a reader who multiplies finds the
  // $1.25. It was put to the owner with the trade stated — drop the points and the gap goes
  // away, but the line loses a figure they want on the page — and the owner chose to KEEP
  // them: *"Just leave it like this. It's okay if the rounding is a little messed up for this
  // one line."*
  //
  // So a later sweep that flags this line again has found a DECISION, not a defect. Changing
  // it needs the owner's own words. What is still guarded is the SIZE of the gap: section M
  // of test-lt-comp-overlay.mjs fails if it ever exceeds one rounding step, and section N
  // fails if the points are dropped — so a "tidy-up" cannot quietly reverse the decision.
  if (buydownDollars > 0) {
    lines.push({
      key: 'buydown', label: 'Buydown (discount points)',
      points: r3((buydownDollars / loan) * 100), dollars: buydownDollars,
      basis: loan,
    });
  }

  // THE TWO LENDER FEES — flat dollars, no points column. LISTED either way; a
  // waived one carries dollars 0 and its full amount, so a comparison can show
  // the saving instead of leaving a reader to spot two missing rows.
  lines.push(feeLine('applicationFee', 'Application fee', p.applicationFee, waived));
  lines.push(feeLine('commitmentFee', 'Commitment fee', p.commitmentFee, waived));

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
 * THE CLOSING SHEET (owner-directed 2026-08-23) — the TOTALS under the fee list, ending in the
 * one number a person prices a deal for: what the borrower brings to the table.
 *
 * The owner's words, which are the spec: *"Total origination fee is zero. Total lender fee is
 * zero. Final closing cost has the total number, but it's wrong. Cash to close needs to include
 * the down payment percentage down plus all the closing cost fees, origination fees, and lender
 * fees."* The zeros were Lender Price's own comp-plan fee fields — figures about a plan we do
 * not keep at the vendor — so the sheet is OURS, summed from the SAME charge list the screen
 * already itemizes. One source: a total here can never disagree with the lines above it.
 *
 *   originationDollars   the origination line (0 when there is none — lender-paid, or a
 *                        zero-comp plan)
 *   lenderFeesDollars    application + commitment as charged (0 when waived)
 *   buydownDollars       the discount points paid to be under par (0 at or above)
 *   closingCostDollars   every charge, net of any credit — charges.netDollars, restated
 *   downPaymentDollars   value − loan, ON A PURCHASE ONLY. A refinance has no down payment,
 *                        so the row is null there rather than a fabricated 0 — and null is
 *                        also the answer when the value or the loan cannot be read, or the
 *                        loan exceeds the value (a data problem is never rendered as a
 *                        negative down payment).
 *   downPaymentPct       the "percentage down" the owner asked to see beside it (0–100).
 *   cashToCloseDollars   downPayment (when there is one) + the net closing cost. A credit
 *                        REDUCES it — that is what a credit is on every closing statement —
 *                        and on a refinance it is simply the net closing cost.
 *
 * ⛔ DISPLAY MATH ONLY, like everything in this module: nothing here reaches the wire, prices
 * a loan, or is a consumer disclosure. Null in, null out — a sheet that cannot be summed is
 * not summed. Pure; never throws.
 */
export function closingSheet(charges, deal) {
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
