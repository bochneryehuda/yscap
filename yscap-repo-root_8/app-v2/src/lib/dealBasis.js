/* WHAT A DEAL IS SIZED ON, as the portal reads it (owner-directed 2026-08-02).
 *
 * A DELIBERATE MIRROR of the server's `src/lib/deal-basis.js`, and nothing more
 * — the same arrangement, and for the same reason, as `lib/payoff.js`: the file
 * and application screens have to decide WHICH BOX TO SHOW before they have
 * fetched anything, and that decision has to be the one the pricing engine will
 * actually make. A screen that asks a refinancing borrower for a purchase price
 * is asking for a figure the engine never reads.
 *
 * Because it is a mirror it is the drift risk, so it mirrors exactly three
 * answers and it is PINNED: `scripts/test-refi-basis-pure.js` runs both modules
 * over every loan-purpose spelling the system stores and fails the moment they
 * disagree. Anything richer than these three (what the structure implies, what
 * is still missing, why it matters) is asked of the server.
 */

// Mirrors deal-basis.sizesOnAsIsValue — which is itself byte-for-byte the test
// pricing.js loanTypeOf uses to pick the engine's denominator.
export function sizesOnAsIsValue(loanType) {
  return /refi/i.test(String(loanType == null ? '' : loanType));
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const dayString = (v) => {
  if (v == null || v === '') return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/* The figure this loan is sized on, and what to call it. Mirrors
   deal-basis.dealBasis; see that module for the whole story. */
export function dealBasis(app) {
  const a = app || {};
  const onAsIs = sizesOnAsIsValue(a.loan_type);
  const asIs = num(a.as_is_value);
  const price = num(a.purchase_price);
  return onAsIs
    ? {
      sizedOnAsIs: true,
      basis: asIs != null && asIs > 0 ? asIs : null,
      basisLabel: 'As-is value',
      asIsValue: asIs,
      purchasePrice: null,
      missingBasis: !(asIs != null && asIs > 0),
    }
    : {
      sizedOnAsIs: false,
      basis: price != null && price > 0 ? price : null,
      basisLabel: 'Purchase price',
      // Unchanged purchase behaviour: a blank as-is value means "worth what I am
      // paying for it".
      asIsValue: asIs != null && asIs > 0 ? asIs : price,
      purchasePrice: price,
      missingBasis: !(price != null && price > 0),
    };
}

/* Whole months of ownership from the acquisition date — the seasoning the owner
   asked for. Calendar-string arithmetic only (never a Date, never an epoch), and
   null rather than a guess when there is no date, it cannot be read, or it is in
   the future. */
export function seasoningMonths(acquisitionDate, asOf) {
  const from = dayString(acquisitionDate);
  if (!from) return null;
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const to = dayString(asOf) || `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;
  return months < 0 ? null : months;
}

export function seasoningText(acquisitionDate, asOf) {
  const m = seasoningMonths(acquisitionDate, asOf);
  if (m == null) return null;
  if (m < 1) return 'under a month';
  if (m < 24) return `${m} month${m === 1 ? '' : 's'}`;
  const y = Math.floor(m / 12);
  const r = m % 12;
  return r ? `${y} yr ${r} mo` : `${y} years`;
}

export default dealBasis;
