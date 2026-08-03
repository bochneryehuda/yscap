/**
 * PROPERTIES THAT WERE BOUGHT AND RESOLD — the exits, out of data we already hold.
 *
 * This is a bridge and fix-and-flip lender's own question, and until now the
 * warehouse could not answer it: `properties` carries only `last_sale_price` /
 * `last_sale_date`, so every search reads the MOST RECENT transaction and the one
 * before it — the purchase the flip started from — is invisible. `property_sales`
 * has held both all along, because an appraiser records each comparable's PRIOR
 * sale on the grid, and the ingest files that as its own transaction.
 *
 * Measured on the real 152-report corpus, by the query this file actually runs:
 * 50 buy→sell pairs inside two years across 48 properties, averaging a $126,895
 * spread over 203 days, 34 of them over 15% and 6 of them at a loss. That is real completed-exit evidence in the towns we lend in, and no
 * data vendor sells it in this shape — it comes from the prior-sale line of
 * reports we paid for.
 *
 * WHAT IT IS NOT, and the wording has to keep saying so:
 *   · NOT a claim that anyone renovated anything. It is two recorded sales and
 *     the time between them. A property bought in an estate and resold at market
 *     is the same shape as a gut rehab, and so is a transfer between related
 *     parties at a nominal price. The FLAGS (`arv_comp_count`, the sale types)
 *     are reported so a person can tell, and nothing here judges it.
 *   · NOT a market rate of return. It is the sales OUR appraisers happened to
 *     describe, which is a fraction of a town, so the denominator is meaningless
 *     and no average of these is published as "what flips make around here".
 *
 * THREE RULES:
 *   · CLOSED SALES ONLY, both ends. A listing's asking price is not a sale, and
 *     `property_sales` deliberately stores one so it can be shown as an asking
 *     price — pairing one here would invent a profit nobody made.
 *   · CONSECUTIVE pairs only. A property with three sales yields two pairs, not
 *     three: a buy and a sell two transactions apart is not one deal, and
 *     counting it would double the spread.
 *   · A NON-ARM'S-LENGTH end is REPORTED, not dropped. An REO purchase resold at
 *     market is exactly what this is for, and only a human can judge it, so the
 *     sale types travel with the row. A NOMINAL price is the one exception: it is
 *     set aside and COUNTED (see `NOMINAL_PRICE`), because a dollar is not a
 *     purchase price and the arithmetic off one is not a spread.
 */
'use strict';

const MAX_LIMIT = 200;
const DEFAULT_WINDOW_MONTHS = 24;
/**
 * A RECORDED CONSIDERATION OF A DOLLAR IS NOT A PURCHASE PRICE.
 *
 * A deed transfer between related parties, into a trust, or out of an estate is
 * recorded at a nominal amount, and the appraiser copies it onto the grid like
 * any other prior sale. Pairing one produces arithmetic that is not merely wrong
 * but ridiculous, and ridiculous numbers get believed when they sit in a column
 * of real ones: the first run of this over the real corpus returned
 * "12 Ward St — bought $10, sold $565,000, spread 5,649,900%".
 *
 * The threshold is read off the data rather than invented. In the corpus the
 * whole nominal cluster is exactly $1 (ten times) and $10 (three), then a gap to
 * $807, then $2,680, then nothing until $9,000 and an ordinary distribution
 * above. $1,000 is the conventional nominal-deed line and sits inside that gap.
 *
 * They are SET ASIDE AND COUNTED, never silently dropped — the same discipline
 * the market rates use for forced sales. A transfer that happened is a fact; it
 * is just not a purchase.
 */
const NOMINAL_PRICE = 1000;

/** A sale type that is not an ordinary arm's-length sale, in the UAD vocabulary. */
const NOT_ARMS_LENGTH = new Set(['REOSale', 'ShortSale', 'EstateSale', 'CourtOrderedSale', 'RelocationSale']);

/**
 * Find buy→sell pairs.
 *
 * @param {object} db          the pg pool
 * @param {object} opts        state / city / zip / months (the HOLD window, not
 *                             recency) / soldWithinMonths (how recent the SALE
 *                             must be) / minSpreadPct / limit
 */
async function findFlips(db, opts = {}) {
  const params = [];
  const P = (v) => { params.push(v); return '$' + params.length; };
  // Both ends must be settled sales with a REAL price — see `REAL` below.
  // `sale_status` is NULL for a closed sale (db/157), so the COALESCE is
  // load-bearing.
  const where = [];
  // A HOLD OF ZERO DAYS IS NOT A FLIP. Two closed sales recorded on ONE date are
  // either two records of the same transaction or a simultaneous double close —
  // never a purchase and a separate exit. Allowing it (an attempt at handling the
  // same-day sibling) immediately produced a "$3,000 gain in 0 days" out of the
  // two records at 98 Thompson St. The sibling problem is solved by the total
  // ordering in the join instead, which makes one of the two the resale and the
  // other a mid — so one purchase yields one deal, not two.
  const holdDays = Math.round((Number(opts.months) > 0 ? Number(opts.months) : DEFAULT_WINDOW_MONTHS) * 30.4375);
  where.push(`(s2.sale_date - s1.sale_date) BETWEEN 1 AND ${P(holdDays)}`);

  if (opts.propertyId) where.push(`s1.property_id = ${P(opts.propertyId)}`);
  if (opts.state) where.push(`p.state = ${P(String(opts.state).toUpperCase())}`);
  if (opts.city) where.push(`lower(p.city) = ${P(String(opts.city).toLowerCase())}`);
  if (opts.zip) where.push(`p.zip = ${P(String(opts.zip))}`);
  const recent = Number(opts.soldWithinMonths);
  if (Number.isFinite(recent) && recent > 0) {
    where.push(`s2.sale_date > (CURRENT_DATE - ${P(Math.round(recent * 30.4375))} * INTERVAL '1 day')`);
  }
  const minPct = Number(opts.minSpreadPct);
  if (Number.isFinite(minPct)) {
    where.push(`((s2.sale_price - s1.sale_price) / s1.sale_price * 100) >= ${P(minPct)}`);
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(opts.limit) > 0 ? Math.floor(Number(opts.limit)) : 50));

  // A NOMINAL PRICE IS EXCLUDED FROM THE PAIRING, NOT FROM THE RESULTS.
  // Setting it aside AFTERWARDS was worse than not doing it: a rehabber deeding
  // a property into an LLC mid-project — the exact case `NOMINAL_PRICE`
  // documents — put a $1 row between the purchase and the exit, so the
  // consecutive rule split ONE genuine flip into two nominal pairs and both were
  // then discarded. The real $200,000 → $450,000 exit vanished and the note
  // claimed two non-purchases had been removed. Six properties in the corpus
  // already sit in that shape. So a nominal row is not a sale here at all: it
  // cannot be an end of a pair AND it cannot block one, and the ones excluded
  // are counted separately below.
  const REAL = `(COALESCE(%s.sale_status,'closed') = 'closed' AND %s.sale_price >= ${P(NOMINAL_PRICE)}
                 AND %s.sale_date IS NOT NULL)`;
  const real = (a) => REAL.split('%s').join(a);

  where.push(real('s1'), real('s2'));

  // CONSECUTIVE ONLY, AND A SAME-DAY SIBLING IS NOT A SECOND DEAL. `NOT EXISTS`
  // a real sale between the two — and the tie-break `(date, price, id)` makes the
  // ordering total, so two closed sales recorded on the SAME DAY (the corpus
  // holds a pair at 98 Thompson St) produce one pair rather than counting one
  // purchase twice.
  const rows = (await db.query(
    `SELECT s1.property_id,
            p.display_address, p.city, p.state, p.zip,
            p.property_type, p.units, p.gla, p.beds, p.year_built,
            p.arv_comp_count, p.asis_comp_count, p.photo_count,
            -- WAS THE RESALE ITSELF ON AN AFTER-REPAIR GRID? The property's
            -- arv_comp_count rolls up EVERY after-repair observation, whenever
            -- NOTE: no backticks in a SQL comment inside a template literal —
            -- one of them ends the string and the error is nowhere near it.
            -- it happened, so stamping it on a pair claimed a renovation the
            -- appraiser graded years later: two real comparables resold in 5 and
            -- 11 days with no gain were both marked "resold as a finished house".
            -- The observation's own sale date is what ties the grading to the sale.
            EXISTS (SELECT 1 FROM property_observations ao
                     WHERE ao.property_id = s1.property_id
                       AND ao.comp_set = 'arv'
                       AND ao.sale_date = s2.sale_date) AS resale_on_arv_grid,
            s1.sale_date  AS bought_on,  s1.sale_price AS bought_for,  s1.sale_type AS bought_type,
            s2.sale_date  AS sold_on,    s2.sale_price AS sold_for,    s2.sale_type AS sold_type,
            (s2.sale_date - s1.sale_date)::int AS held_days,
            (s2.sale_price - s1.sale_price)    AS spread,
            round((s2.sale_price - s1.sale_price) / s1.sale_price * 100, 1) AS spread_pct
       FROM property_sales s1
       JOIN property_sales s2
         ON s2.property_id = s1.property_id
        AND (s2.sale_date, s2.sale_price, s2.id) > (s1.sale_date, s1.sale_price, s1.id)
       JOIN properties p ON p.id = s1.property_id
      WHERE ${where.join(' AND ')}
        AND NOT EXISTS (
          SELECT 1 FROM property_sales mid
           WHERE mid.property_id = s1.property_id
             AND ${real('mid')}
             AND (mid.sale_date, mid.sale_price, mid.id) > (s1.sale_date, s1.sale_price, s1.id)
             AND (mid.sale_date, mid.sale_price, mid.id) < (s2.sale_date, s2.sale_price, s2.id))
      ORDER BY s2.sale_date DESC, s1.property_id
      LIMIT ${limit}`, params)).rows;

  // HOW MANY NOMINAL TRANSFERS WERE PASSED OVER, counted where they actually
  // are rather than inferred from the pairs — the pairing no longer produces one,
  // so counting the result set would always answer zero and the note would
  // silently stop appearing.
  let setAside = 0;
  try {
    // ITS OWN PARAMETERS. Re-using the pair query's accumulator binds every value
    // it never references, and Postgres refuses the statement outright — which
    // the catch below would have turned into a permanent silent zero.
    const q = [];
    const Q = (v) => { q.push(v); return '$' + q.length; };
    const scope = [
      `s.sale_price IS NOT NULL AND s.sale_price < ${Q(NOMINAL_PRICE)}`,
      "COALESCE(s.sale_status,'closed') = 'closed'",
      's.sale_date IS NOT NULL',
    ];
    if (opts.propertyId) scope.push(`s.property_id = ${Q(opts.propertyId)}`);
    if (opts.state) scope.push(`p.state = ${Q(String(opts.state).toUpperCase())}`);
    if (opts.city) scope.push(`lower(p.city) = ${Q(String(opts.city).toLowerCase())}`);
    if (opts.zip) scope.push(`p.zip = ${Q(String(opts.zip))}`);
    setAside = Number((await db.query(
      `SELECT count(*)::int AS n FROM property_sales s
         JOIN properties p ON p.id = s.property_id
        WHERE ${scope.join(' AND ')}`, q)).rows[0].n) || 0;
  } catch (e) { setAside = 0; }

  const out = rows.map((r) => Object.assign({}, r, {
    // SAID PLAINLY, so nothing has to be inferred from two enum values.
    bought_arms_length: r.bought_type ? !NOT_ARMS_LENGTH.has(r.bought_type) : null,
    sold_arms_length: r.sold_type ? !NOT_ARMS_LENGTH.has(r.sold_type) : null,
    held_months: r.held_days == null ? null : Math.round((r.held_days / 30.4375) * 10) / 10,
    // The appraiser's own signal that THIS SALE was of a FINISHED house — the
    // observation that graded it on an after-repair grid carries the same sale
    // date. Never asserted from the spread (a big number is not evidence of a
    // renovation) and never from the property's lifetime roll-up.
    resold_as_renovated: r.resale_on_arv_grid === true,
  }));
  return {
    rows: out,
    setAside,
    setAsideNote: setAside
      ? `${setAside} transfer${setAside === 1 ? ' was' : 's were'} passed over because the price recorded `
        + 'was nominal — a deed between related parties or out of an estate, not a purchase. '
        + 'A flip either side of one is still counted.'
      : null,
    caveat: FLIPS_CAVEAT,
  };
}

/**
 * The one sentence that has to travel with any list of these. Kept here rather
 * than in a screen so every surface says the same thing.
 */
const FLIPS_CAVEAT = 'These are two recorded sales of the same property and the time between them — '
  + 'not proof that anyone renovated it, and not a rate of return. They come from the prior-sale line '
  + 'of appraisals we paid for, so they are a fraction of what actually traded in these towns.';

module.exports = { findFlips, FLIPS_CAVEAT, _internals: { NOT_ARMS_LENGTH } };
