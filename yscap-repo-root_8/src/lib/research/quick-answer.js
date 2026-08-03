/**
 * QUICK ANSWER — an address, a few basics, and roughly what properties like that
 * have been coming in at. BUILT TO REFUSE.
 *
 * The owner's "quick mode". It is the most dangerous surface in this whole build
 * for one reason: it looks like a Zestimate. A single figure next to an address
 * is read as a valuation no matter how much small print sits under it, and this
 * warehouse holds roughly 7% of a town — only the houses that appeared in an
 * appraisal we paid for. So the shape of the answer is the safety feature:
 *
 *  · NEVER A POINT ESTIMATE. The headline is a RANGE. A median is quoted inside
 *    it, never on its own and never first.
 *  · ALWAYS THE DENOMINATOR. "between $385,000 and $470,000" is a claim about
 *    the market; "in the 9 appraisals we hold" is a claim about our files, which
 *    is the only claim we can support. The two are never separated.
 *  · ALWAYS THE RECENCY SPAN. A range built from sales two years old is a
 *    statement about 2024, and a reader cannot tell unless it is said.
 *  · IT REFUSES BELOW FIVE. Four sales is an anecdote. Below the floor there is
 *    no range, no median and no number of any kind — the refusal names our
 *    coverage rather than telling somebody to widen their filters, because in
 *    most towns no filter change will help.
 *
 * Pure. No database, no network.
 */
'use strict';

const RULES = Object.freeze({
  // Five is the floor. Below it a "range" is two numbers that happen to be the
  // smallest and largest of a handful, and the median is whichever one landed in
  // the middle — neither describes anything.
  MIN_MATCHES: 5,
  // Past this the set does not agree with itself well enough for the range to be
  // useful. Reported, never a refusal: a wide range IS the honest answer, it
  // just has to say it is wide.
  WIDE_SPREAD: 0.6,
  // A set whose newest sale is older than this is a statement about a market
  // that has moved. Still answered, and still said.
  STALE_MONTHS: 18,
});

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Whole months between two 'YYYY-MM-DD' strings, or null. */
function monthsBetween(from, to) {
  if (!from || !to) return null;
  const a = String(from).slice(0, 10);
  const b = String(to).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  let m = (by - ay) * 12 + (bm - am);
  if (bd < ad) m -= 1;
  return m;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

const dollars = (n) => (n == null ? null : `$${Math.round(n).toLocaleString('en-US')}`);
/** Rounded the way a person says it: $428k, $1.24m. */
function approx(n) {
  if (n == null) return null;
  if (n >= 1000000) return `$${(n / 1000000).toFixed(2).replace(/0$/, '')}m`;
  return `$${Math.round(n / 1000)}k`;
}

/**
 * @param {object} opts
 * @param {Array}  opts.rows      matching properties — each with `last_sale_price`,
 *                                `last_sale_date` and optionally `comp_set`
 * @param {object} opts.asked     what was searched for, for the wording
 * @param {string} opts.today     'YYYY-MM-DD'
 * @param {number} opts.heldNearby how many properties we hold in that area AT ALL,
 *                                so an empty answer can blame coverage with a number
 */
function quickAnswer(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const rows = Array.isArray(o.rows) ? o.rows : [];
  const asked = (o.asked && typeof o.asked === 'object') ? o.asked : {};
  const today = o.today || null;
  const heldNearby = num(o.heldNearby);

  // A row with no price cannot contribute to a range, and counting it in the
  // denominator would overstate what the answer rests on. Counted separately and
  // reported, never silently dropped.
  const priced = [];
  let noPrice = 0;
  for (const r of rows) {
    const p = num(r && r.last_sale_price);
    if (p == null || p <= 0) { noPrice++; continue; }
    /* WHICH GRID IT SAT ON is read from the property's own counters, not from a
       `comp_set` column — that lives on the OBSERVATION, and a property row does
       not carry one. Reading it there gave every row `null`, which the tally
       then reported as "0 of 18 were as-is grids": not a missing answer but a
       confident wrong one, saying all eighteen were after-repair grids when in
       fact we had not looked. */
    const asis = num(r.asis_comp_count);
    const arv = num(r.arv_comp_count);
    const known = asis != null || arv != null;
    priced.push({ price: p, date: r.last_sale_date ? String(r.last_sale_date).slice(0, 10) : null,
      knowsGrid: known, isAsIs: known && (asis || 0) > 0, isArv: known && (arv || 0) > 0,
      gla: num(r.gla), address: r.display_address || null });
  }

  const coverage = {
    matched: rows.length,
    usable: priced.length,
    noPrice,
    heldNearby: heldNearby == null ? null : heldNearby,
  };

  const no = (gate, why) => ({ available: false, gate, why, coverage,
    n: priced.length, low: null, high: null, median: null, sentence: null, rules: RULES });

  if (priced.length < RULES.MIN_MATCHES) {
    // THE REFUSAL BLAMES OUR COVERAGE, because that is what is true. Telling
    // somebody to widen their filters implies a wider search would find
    // something, and in most towns it will not: we hold only what our own
    // reports described.
    const held = heldNearby != null ? heldNearby : null;
    let why;
    if (priced.length === 0 && (held === 0 || held == null)) {
      why = 'We hold nothing at all like this nearby. Our records only cover properties that appeared '
        + 'in an appraisal we paid for, so a town we have not lent in is simply empty — no change to '
        + 'the search will help.';
    } else {
      why = `Only ${priced.length} of the properties we hold nearby match this closely`
        + (held != null ? `, out of ${held} we hold in the area at all` : '')
        + `. Below ${RULES.MIN_MATCHES} there is no range worth quoting — a handful of sales is an `
        + 'anecdote, not a pattern, and our records cover only what our own reports described.';
    }
    if (noPrice > 0) {
      why += ` (${noPrice} more matched but state no sale price, so they cannot go in a range.)`;
    }
    return no('too_few', why);
  }

  const prices = priced.map((p) => p.price).sort((a, b) => a - b);
  const low = prices[0];
  const high = prices[prices.length - 1];
  const mid = median(prices);
  const q1 = quantile(prices, 0.25);
  const q3 = quantile(prices, 0.75);

  const dates = priced.map((p) => p.date).filter(Boolean).sort();
  const oldest = dates.length ? dates[0] : null;
  const newest = dates.length ? dates[dates.length - 1] : null;
  const spanMonths = monthsBetween(oldest, newest);
  const newestMonthsAgo = today && newest ? monthsBetween(newest, today) : null;

  // Counted only over the rows that actually STATE it. A tally over rows that
  // never said is a claim about data we do not have.
  const gridKnown = priced.filter((p) => p.knowsGrid);
  const asIs = gridKnown.filter((p) => p.isAsIs).length;
  const arv = gridKnown.filter((p) => p.isArv).length;

  const spread = mid ? (high - low) / mid : null;
  const flags = [];
  if (spread != null && spread > RULES.WIDE_SPREAD) {
    flags.push({ code: 'wide', message: `These are spread wide — the highest is ${Math.round((high / low - 1) * 100)}% `
      + 'above the lowest, so treat the range as a range and not as a value.' });
  }
  if (newestMonthsAgo != null && newestMonthsAgo > RULES.STALE_MONTHS) {
    flags.push({ code: 'stale', message: `Nothing here sold in the last ${RULES.STALE_MONTHS} months — `
      + 'this describes an earlier market.' });
  }
  if (noPrice > 0) {
    flags.push({ code: 'no_price', message: `${noPrice} more property${noPrice === 1 ? '' : 's'} matched `
      + 'but states no sale price, so it is not in these figures.' });
  }

  return {
    available: true,
    gate: null,
    why: null,
    n: priced.length,
    coverage,
    // THE RANGE IS THE HEADLINE. The median is here, and every sentence puts it
    // inside the range rather than in front of it.
    low, high, median: mid, q1, q3,
    lowText: dollars(low), highText: dollars(high), medianText: dollars(mid),
    medianApprox: approx(mid),
    spanMonths, oldest, newest, newestMonthsAgo,
    asIsCount: gridKnown.length ? asIs : null,
    arvCount: gridKnown.length ? arv : null,
    gridKnownCount: gridKnown.length,
    flags,
    asked,
    sentence: describeQuick({
      n: priced.length, low, high, median: mid, spanMonths, newestMonthsAgo,
      asIsCount: gridKnown.length ? asIs : null, gridKnownCount: gridKnown.length, asked,
    }),
    rules: RULES,
  };
}

/**
 * The answer as one sentence, in the owner's own shape:
 * "In the 9 appraisals we hold within 1 mile in the last 18 months, 1-unit houses
 *  1,200–1,900 sqft in C4 came in between $385,000 and $470,000 — median $428k.
 *  7 of 9 were as-is grids. Most recent 3 months ago."
 */
function describeQuick(a) {
  if (!a || !a.n) return null;
  const asked = a.asked || {};
  const where = [];
  if (asked.radiusMiles) where.push(`within ${asked.radiusMiles} mile${asked.radiusMiles === 1 ? '' : 's'}`);
  else if (asked.city) where.push(`in ${asked.city}`);
  else if (asked.state) where.push(`in ${asked.state}`);
  if (asked.months) where.push(`in the last ${asked.months} months`);

  const what = [];
  if (asked.units) what.push(`${asked.units}-unit`);
  if (asked.propertyType) what.push(String(asked.propertyType).toLowerCase());
  const size = asked.glaMin && asked.glaMax
    ? `${Number(asked.glaMin).toLocaleString('en-US')}–${Number(asked.glaMax).toLocaleString('en-US')} sqft`
    : null;
  if (size) what.push(size);
  if (asked.condition) what.push(`in ${asked.condition}`);

  const subject = what.length ? what.join(' ') : 'properties';
  const parts = [
    `In the ${a.n} propert${a.n === 1 ? 'y' : 'ies'} we hold${where.length ? ' ' + where.join(' ') : ''}, `
    + `${subject} came in between ${dollars(a.low)} and ${dollars(a.high)} — median ${approx(a.median)}.`,
  ];
  // Said only about the ones that stated it. Silence beats "0 of 18", which
  // reads as "none of them were" rather than "we did not look".
  if (a.asIsCount != null && a.gridKnownCount > 0) {
    parts.push(`${a.asIsCount} of the ${a.gridKnownCount} that say were as-is grids.`);
  }
  if (a.newestMonthsAgo != null) {
    parts.push(a.newestMonthsAgo <= 0 ? 'Most recent this month.'
      : `Most recent ${a.newestMonthsAgo} month${a.newestMonthsAgo === 1 ? '' : 's'} ago.`);
  }
  if (a.spanMonths != null && a.spanMonths > 0) {
    parts.push(`They span ${a.spanMonths} month${a.spanMonths === 1 ? '' : 's'}.`);
  }
  return parts.join(' ');
}

module.exports = { quickAnswer, describeQuick, RULES, _internals: { monthsBetween, approx, quantile } };
