'use strict';
/**
 * WHAT A DEAL IS SIZED ON — one reading, every surface (owner-directed 2026-08-02).
 *
 * The owner, after a cash-out refinance turned up carrying purchase-style
 * economics: "Once a file is refinance then instead of asking for the purchase
 * price just ask him right away for the as is value because that's what it
 * counts for, it doesn't count for the purchase price … we need to build up all
 * the pricing all the tools to understand that as is value is the one that sets
 * how much initial he can get instead of looking on the purchase price."
 *
 * THE ENGINES ALREADY AGREED. `standard-program.js` sizes the acquisition
 * (initial) advance off `acqDenom = purchase ? min(pp, aiv) : aiv` and the cost
 * basis off `(purchase ? pp : aiv) + rehab`; `gold-standard.js` does the same
 * (`aivForBudget`, the heavy-rehab basis and the exit test all read the as-is
 * value on a refinance). Nothing in this module changes a single one of those
 * formulas — it is the layer ABOVE them that had been asking the wrong question.
 *
 * WHAT WAS ACTUALLY WRONG was everything upstream: the forms asked a refinancing
 * borrower for a purchase price, the file stored one, the completeness panel
 * demanded one, and `pricing.js` quietly used it as a stand-in for the as-is
 * value when the as-is box was blank. A purchase price on a refinance is not a
 * value — it is either meaningless or it is the price the borrower paid YEARS
 * ago, which is a different field entirely (`original_purchase_price`).
 *
 * ONE PREDICATE, DELIBERATELY THE ENGINE'S OWN. `sizesOnAsIsValue` is the SAME
 * substring test `pricing.js loanTypeOf` uses to decide which matrix row and
 * which denominator the frozen engine gets. That coupling is the point: the
 * question "which number does this screen ask for?" and the question "which
 * number does the loan size on?" must have one answer, or a screen can ask for a
 * figure the engine never reads. `payoff.isRefinance` answers a NEARBY but
 * different question — is there an existing loan to retire — and is deliberately
 * the richer reading (it routes through the Condition Center's own
 * `normLoanPurpose`). On every spelling the system actually stores they agree,
 * and `scripts/test-refi-basis-pure.js` pins that agreement over the portal enum,
 * the ClickUp crosswalk values and the legacy spellings; if a future label ever
 * splits them, that test fails rather than the two quietly diverging.
 *
 * PURE — no database, no network, never throws.
 */

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/* Is this loan sized on the property's CURRENT (as-is) value rather than on a
   purchase price? True for every refinance.

   The test is `/refi/` — byte-for-byte `pricing.js loanTypeOf`'s — and it must
   stay that way. "Delayed Purchase Financing" is correctly NOT a refinance here
   (it carries purchase leverage and the frozen engine reads it as a purchase),
   which is the same call `normLoanPurpose` makes for the same stated reason. */
function sizesOnAsIsValue(loanType) {
  return /refi/i.test(String(loanType == null ? '' : loanType));
}

/* THE FIGURE THE LOAN IS SIZED ON, and what to call it on screen.

   `basis` is null when the file cannot answer yet — on a refinance that means
   nobody has entered an as-is value, which is a real gap (the loan cannot be
   sized at all), not a zero. `missingBasis` says so plainly so a caller can
   refuse a registration or raise a pill instead of quietly pricing off nothing.

   On a PURCHASE this returns exactly what the file already showed: the entered
   purchase price, with the as-is value defaulting to it when left blank ("worth
   what I'm paying for it" — the long-standing rule, unchanged). Callers that
   need the assignment breakdown of that price still use `dealPrice.dealPurchase`;
   this module deliberately does not re-derive it. */
function dealBasis(app) {
  const a = app || {};
  const onAsIs = sizesOnAsIsValue(a.loan_type);
  const asIs = num(a.as_is_value);
  const price = num(a.purchase_price);
  if (onAsIs) {
    return {
      sizedOnAsIs: true,
      basis: asIs != null && asIs > 0 ? asIs : null,
      basisLabel: 'As-is value',
      basisHint: 'A refinance is sized on what the property is worth today.',
      asIsValue: asIs,
      // A purchase price is not part of a refinance. Report it as absent so no
      // screen, tape or export presents a stale figure as this deal's price.
      purchasePrice: null,
      originalPurchasePrice: num(a.original_purchase_price),
      acquisitionDate: dayString(a.acquisition_date),
      seasoningMonths: seasoningMonths(a.acquisition_date),
      missingBasis: !(asIs != null && asIs > 0),
    };
  }
  return {
    sizedOnAsIs: false,
    basis: price != null && price > 0 ? price : null,
    basisLabel: 'Purchase price',
    basisHint: 'A purchase is sized on the lower of the purchase price and the as-is value.',
    // Unchanged purchase behaviour: a blank as-is value means "worth what I am
    // paying for it".
    asIsValue: asIs != null && asIs > 0 ? asIs : price,
    purchasePrice: price,
    originalPurchasePrice: num(a.original_purchase_price),
    acquisitionDate: dayString(a.acquisition_date),
    seasoningMonths: seasoningMonths(a.acquisition_date),
    missingBasis: !(price != null && price > 0),
  };
}

/* A date column arrives as a 'YYYY-MM-DD' STRING from this repo's pg type parser
   (src/db.js OID 1082) but as a Date from a hand-built object. Both are reduced
   to the calendar string the rest of the system speaks — never a Date, never an
   epoch (the 2026-07-15 date-incident rule). */
function dayString(v) {
  if (v == null || v === '') return null;
  const s = typeof v === 'string' ? v.slice(0, 10) : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/* HOW LONG THE BORROWER HAS OWNED IT, in whole months — the seasoning the owner
   asked for ("so we can count seasoning and stuff like that").
 *
 * Calendar arithmetic on the date STRING only, so it cannot drift by a timezone
 * (the same discipline as `term-options.js`). Returns null rather than a number
 * whenever the answer would be a guess: no acquisition date on file, an
 * unparseable one, or a date in the future (which is not ownership, it is a typo
 * or a pending purchase). A same-month acquisition is 0 months owned, not null —
 * "bought this month" is a real, and rather important, answer.
 */
function seasoningMonths(acquisitionDate, asOf) {
  const from = dayString(acquisitionDate);
  if (!from) return null;
  const to = dayString(asOf) || todayString();
  if (!to) return null;
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;          // the anniversary day has not come round yet
  return months < 0 ? null : months;
}

function todayString() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* Plain-language seasoning, for a screen or a term sheet. Null when unknown, so
   a caller can drop the row entirely rather than print "— months". */
function seasoningText(acquisitionDate, asOf) {
  const m = seasoningMonths(acquisitionDate, asOf);
  if (m == null) return null;
  if (m < 1) return 'under a month';
  if (m < 24) return `${m} month${m === 1 ? '' : 's'}`;
  const y = Math.floor(m / 12);
  const r = m % 12;
  return r ? `${y} yr ${r} mo` : `${y} years`;
}

module.exports = {
  sizesOnAsIsValue,
  dealBasis,
  seasoningMonths,
  seasoningText,
  _internals: { dayString, todayString, num },
};
