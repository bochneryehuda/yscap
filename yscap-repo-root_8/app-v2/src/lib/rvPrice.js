/**
 * What a Richer Values order actually costs, and how a price is written down.
 *
 * ONE DEFINITION, because the same figure is read by the price panel, the order
 * button and the confirmation line underneath it. A number retyped in three places
 * is exactly how a button comes to promise one total while the panel above it shows
 * another — and this one is a price somebody reads out to a borrower.
 *
 * THE CARD FEE IS IN THE TOTAL (owner-directed 2026-08-16, asked directly and
 * answered: *"the borrower should be quoted the total with the $3.50"*). That
 * settles a question the order screen previously recorded as open.
 *
 * Their quote carries `cc_surcharge` OUTSIDE `total_price` — measured live against
 * their tenant, $3.50 flat, from their company settings `cc_surcharge_type: "flat"`
 * — and every route we pay by is a card, so the fee applies on essentially every
 * order. Before this the headline on the order screen was the one figure nobody
 * ever pays.
 *
 * It lives here rather than in the component so the arithmetic can be tested for
 * real; a screen is where it is DISPLAYED, not where it is decided.
 */

/**
 * Sum the two halves IN CENTS.
 *
 * Plain addition is exact for SOME prices and not others, which is the worst shape a
 * bug can have. `489.99 + 3.5` happens to come out exactly 493.49; `508.57 + 3.5`
 * comes out 512.0699999999999 — and their pricing moves with the state and the ZIP,
 * so which prices a desk sees is not something this code gets to choose. Rounding
 * each half to whole cents first makes every one of them exact.
 *
 * `moneyExact` below would round the tail away on screen either way, so this is not
 * about what is DISPLAYED — it is about the value itself, which anything that later
 * compares or sums it would be wrong about.
 *
 * @returns {number|null} null when there is no usable price — never 0, which would
 *   render as "$0.00" and read as a free appraisal.
 */
export function rvOrderTotal(price) {
  if (!price) return null;
  // `Number(null)` is 0 AND 0 IS FINITE, so a quote whose price came back null would
  // otherwise sail through and print "$0.00" — a free appraisal. The absent cases are
  // rejected BEFORE the conversion, never after it.
  if (price.total_price == null || price.total_price === '') return null;
  const base = Number(price.total_price);
  if (!Number.isFinite(base)) return null;
  const fee = Number(price.cc_surcharge);
  const feeCents = Number.isFinite(fee) && fee > 0 ? Math.round(fee * 100) : 0;
  return (Math.round(base * 100) + feeCents) / 100;
}

/**
 * A price somebody is QUOTED, shown to the cent.
 *
 * The portal's ordinary `money()` rounds to whole dollars, which is right for a loan
 * amount and wrong for a $489.99 invoice: rounded, the $3.50 card fee all but
 * disappears and the all-in total reads $493 against a real charge of $493.49 —
 * quoting a borrower LESS than they will be charged, which is the smaller version of
 * the bug this whole block exists to fix.
 */
export function moneyExact(n) {
  const v = Number(n);
  if (n == null || n === '' || !Number.isFinite(v)) return '—';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
