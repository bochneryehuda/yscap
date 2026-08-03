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
 * Measured on the real 152-report corpus: 56 buy→sell pairs inside two years
 * across 52 properties, averaging a $165,816 spread over 215 days, 41 of them
 * over 15%. That is real completed-exit evidence in the towns we lend in, and no
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
  const where = [
    // Both ends must be settled sales with a real price. `sale_status` is NULL
    // for a closed sale (db/157), so the COALESCE is load-bearing.
    "COALESCE(s1.sale_status,'closed') = 'closed'",
    "COALESCE(s2.sale_status,'closed') = 'closed'",
    's1.sale_price > 0', 's2.sale_price > 0',
    's1.sale_date IS NOT NULL', 's2.sale_date IS NOT NULL',
  ];
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

  // CONSECUTIVE ONLY. `NOT EXISTS` a closed sale strictly between the two, so a
  // property with three sales yields the two real deals and not a third pair
  // spanning both of them.
  const rows = (await db.query(
    `SELECT s1.property_id,
            p.display_address, p.city, p.state, p.zip,
            p.property_type, p.units, p.gla, p.beds, p.year_built,
            p.arv_comp_count, p.asis_comp_count, p.photo_count,
            s1.sale_date  AS bought_on,  s1.sale_price AS bought_for,  s1.sale_type AS bought_type,
            s2.sale_date  AS sold_on,    s2.sale_price AS sold_for,    s2.sale_type AS sold_type,
            (s2.sale_date - s1.sale_date)::int AS held_days,
            (s2.sale_price - s1.sale_price)    AS spread,
            round((s2.sale_price - s1.sale_price) / s1.sale_price * 100, 1) AS spread_pct
       FROM property_sales s1
       JOIN property_sales s2
         ON s2.property_id = s1.property_id AND s2.sale_date > s1.sale_date
       JOIN properties p ON p.id = s1.property_id
      WHERE ${where.join(' AND ')}
        AND NOT EXISTS (
          SELECT 1 FROM property_sales mid
           WHERE mid.property_id = s1.property_id
             AND COALESCE(mid.sale_status,'closed') = 'closed'
             AND mid.sale_date > s1.sale_date AND mid.sale_date < s2.sale_date)
      ORDER BY s2.sale_date DESC, s1.property_id
      LIMIT ${limit}`, params)).rows;

  // SET ASIDE IN JS, NOT IN SQL, so the count is of what was actually found
  // rather than of what a second query happened to see, and so the reason can be
  // stated per row if a caller ever wants it.
  const nominal = rows.filter((r) => Number(r.bought_for) < NOMINAL_PRICE
    || Number(r.sold_for) < NOMINAL_PRICE);
  const real = rows.filter((r) => !nominal.includes(r));

  const out = real.map((r) => Object.assign({}, r, {
    // SAID PLAINLY, so nothing has to be inferred from two enum values.
    bought_arms_length: r.bought_type ? !NOT_ARMS_LENGTH.has(r.bought_type) : null,
    sold_arms_length: r.sold_type ? !NOT_ARMS_LENGTH.has(r.sold_type) : null,
    held_months: r.held_days == null ? null : Math.round((r.held_days / 30.4375) * 10) / 10,
    // The appraiser's own signal that the resale was of a FINISHED house. Never
    // asserted from the spread — a big number is not evidence of a renovation.
    resold_as_renovated: Number(r.arv_comp_count) > 0,
  }));
  return {
    rows: out,
    setAside: nominal.length,
    setAsideNote: nominal.length
      ? `${nominal.length} pair${nominal.length === 1 ? '' : 's'} left out because one end was recorded `
        + 'at a nominal amount — a deed transfer between related parties or out of an estate, not a purchase'
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
