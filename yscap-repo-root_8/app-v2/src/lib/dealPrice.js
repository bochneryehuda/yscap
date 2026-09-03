/* THE PURCHASE-PRICE FIGURES OF A DEAL — one definition, every surface.
 *
 * An assignment/wholesale purchase carries THREE numbers and they are easy to
 * mix up, so they are derived in exactly one place (owner-directed 2026-07-28,
 * after the closing desk showed only the original contract price on an
 * assignment):
 *
 *   original (seller's contract)  applications.underlying_contract_price
 *   assignment fee                applications.assignment_fee
 *   FINAL / total price paid      original + the FULL fee
 *
 * The frozen display rule (CLAUDE.md, 2026-07-17) governs the labels: anything
 * labeled "purchase price" shows the REAL total the borrower pays — never the
 * capped basis. The capped basis appears only under an explicit "Effective
 * purchase price" label, and only when the fee is over the program's cap — 15% of the
 * seller's contract on every program, 10% on the Speed Program (2026-09-03); the
 * quote carries the share it was sized at (`capPct`), so no surface assumes one.
 *
 * DISPLAY ONLY. This mirrors the derivation the frozen engine input builder
 * already performs (src/lib/pricing.js buildInputs: totalPrice = seller + fee
 * on an assignment, else purchase_price) — it re-derives no engine number, and
 * the effective price is READ from the registered quote, never recomputed here.
 */

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * @param {object} app the application row
 * @returns {{isAssignment:boolean, total:number|null, original:number|null,
 *            fee:number|null, effective:number|null, excessOutOfPocket:number|null,
 *            capPct:number|null}}
 *   total      what the borrower actually pays (the headline "purchase price")
 *   original   the seller's contract price — null unless this is an assignment
 *   fee        the assignment fee — null unless this is an assignment
 *   effective  the capped basis the loan sizes on, ONLY when the fee is over the
 *              cap so it differs from `total`; read from the registered quote
 *              (never re-derived), null when there is no registration or the
 *              whole fee is financeable
 *   capPct     the financeable share of the fee the registered quote was sized at
 *              (0.15; 0.10 on Speed) — READ from the quote, null when it is not
 *              carried (a quote registered before the field existed, or none)
 */
export function dealPurchase(app) {
  if (!app) return { isAssignment: false, total: null, original: null, fee: null, effective: null, excessOutOfPocket: null, capPct: null };
  const entered = num(app.purchase_price);
  const original = num(app.underlying_contract_price);
  const fee = num(app.assignment_fee);
  // Match the engine input builder: an assignment needs a real seller price to
  // be one. Without it we can only report the price that WAS entered, and we
  // must not label that total as the seller's original contract.
  const isAssignment = !!app.is_assignment && original != null && original > 0;
  if (!isAssignment) {
    return { isAssignment: false, total: entered, original: null, fee: null, effective: null, excessOutOfPocket: null, capPct: null };
  }
  const total = original + (fee || 0);
  // The capped basis, straight off the registered quote's assignment block
  // ({sellerPrice, fee, maxFee, financeableFee, excessOOP, recognizedPrice,
  // overLimit}). Surfaced only when it actually differs from what is paid.
  const asg = (app.registered_quote && app.registered_quote.assignment) || null;
  const recognized = asg ? num(asg.recognizedPrice) : null;
  const overCap = recognized != null && total - recognized > 0.5;
  return {
    isAssignment: true,
    total,
    original,
    fee,
    effective: overCap ? recognized : null,
    excessOutOfPocket: overCap ? (num(asg.excessOOP) != null ? num(asg.excessOOP) : total - recognized) : null,
    capPct: asg && num(asg.maxPct) > 0 ? num(asg.maxPct) : null,
  };
}

export default dealPurchase;
