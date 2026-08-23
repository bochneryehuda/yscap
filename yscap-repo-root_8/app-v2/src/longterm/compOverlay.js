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
 * (The dictation said "1.4" on that last row; the rule the owner stated — subtract the
 *  comp, then measure from 100 — gives 1.000, and the flag is with the owner.)
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
    adjustedPoints: nn(src.adjustedPoints) ? r3(src.adjustedPoints + shift) : src.adjustedPoints,
    price: nn(src.price) ? r3(src.price - shift) : src.price,
  };
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
 *     lines: [{ key, label, points, dollars }...],   // exactly what is charged
 *     credit: { points, dollars } | null,            // what comes back, after any waive
 *     waivedDollars,                                 // 0 unless the waive applied
 *     borrowerPaysDollars, borrowerCreditDollars, netDollars,
 *   }
 *
 * THE WAIVE (lender-paid only — "borrower-paid compensation should not have the option
 * [to] waive lender fees"): the two lender-fee lines do not populate, and their cash
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

  // THE BUYDOWN — what it costs to be under par. When the waive has pushed cash onto it
  // the honest points figure is the CASH-derived one, so points and dollars on the line
  // can never disagree with each other.
  if (buydownDollars > 0) {
    lines.push({
      key: 'buydown', label: 'Buydown (discount points)',
      points: r3((buydownDollars / loan) * 100), dollars: buydownDollars,
    });
  }

  // THE TWO LENDER FEES — flat dollars, no points column. Absent entirely when waived:
  // "it should not populate as fees".
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
