/**
 * THE TIME ADJUSTMENT — defensible, from a published index and the CONTRACT date.
 *
 * A comparable that sold fourteen months ago sold in a different market, and the
 * grid's "date of sale" line corrects for that. Two things make the correction
 * defensible, and this build had neither:
 *
 * ─── 1. THE RATE COMES FROM AN INDEX, NOT FROM OUR FIFTY SALES ──────────────
 *
 * The most dangerous wrong answer in this whole build came from measuring the
 * trend on our own data: sales bunched into a single month produced **3.95% a
 * month** and pre-filled **+$190,750 on a $400,000 comparable**. Fifty
 * properties in one town cannot measure a market. The FHFA's purchase-only index
 * can, because it is built from every conforming repeat sale in the state — the
 * same source a real appraiser cites, and one a reviewer can check against a
 * press release.
 *
 * ─── 2. THE MARKET DATE IS THE CONTRACT DATE, NOT THE SETTLEMENT ────────────
 *
 * A sale that CLOSED in June was agreed in March. The price evidences March's
 * market; June is when the paperwork finished. Adjusting from the settlement
 * date credits the sale with three months of movement it never saw — and on a
 * fast market that is real money in the wrong direction. UAD states both
 * (`s06/25;c03/25`) and `db/425` reads the contract month, so this is a
 * correction we can make on data we already hold.
 *
 * ─── WHAT IT REFUSES ────────────────────────────────────────────────────────
 *
 *  · NO INDEX FOR THAT MARKET → no adjustment. Never a national figure standing
 *    in for a state: that is the same "a rate about nowhere" refusal the
 *    adjustment corpus and the market rates already make.
 *  · A PERIOD THE INDEX DOES NOT COVER → refused rather than extrapolated. The
 *    FHFA publishes about two months after a quarter closes, so a sale from last
 *    month has no index yet; inventing one is exactly the confident-wrong answer
 *    this exists to replace. Where only the RECENT end is uncovered the
 *    adjustment is measured to the last published quarter and SAYS how many
 *    months were left uncovered.
 *  · AN IMPLAUSIBLE RESULT → refused. A published index should never say a
 *    market moved 40% in a year, and if our reading of it does, the reading is
 *    wrong, not the market.
 *
 * Pure. No database, no network — the series is passed in.
 */
'use strict';

const RULES = Object.freeze({
  // Above this over the whole period, our reading of the index is wrong rather
  // than the market being extraordinary.
  MAX_TOTAL_PCT: 60,
  // A single month moving more than this is likewise a reading error.
  MAX_MONTHLY_PCT: 3,
  // Below this the adjustment is noise and dropped to zero, so a grid is not
  // littered with $137 lines that imply a precision nobody has.
  MIN_PCT: 0.5,
});

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 'YYYY-MM-DD' or 'YYYY-MM' → months since year 0, for arithmetic. */
function monthIndex(d) {
  if (!d) return null;
  const s = String(d).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(s)) return null;
  const [y, m] = s.split('-').map(Number);
  if (m < 1 || m > 12) return null;
  return y * 12 + (m - 1);
}
/** A quarter's MIDPOINT month, which is what a quarterly index actually measures. */
const quarterMonthIndex = (year, quarter) => year * 12 + (quarter - 1) * 3 + 1;

/**
 * WHICH DATE EVIDENCES THE MARKET. The contract date when the report states one,
 * the settlement date otherwise — and it always says which it used, because
 * "adjusted 14 months" and "adjusted 11 months" are different claims about the
 * same sale and a reviewer must be able to tell them apart.
 */
function marketDateOf(comp) {
  const c = comp || {};
  const contract = c.contract_date || c.contract_month || null;
  if (contract && monthIndex(contract) != null) {
    return { date: String(contract).slice(0, 7), basis: 'contract', stated: true };
  }
  const sale = c.sale_date || c.last_sale_date || null;
  if (sale && monthIndex(sale) != null) {
    return { date: String(sale).slice(0, 7), basis: 'settlement', stated: false };
  }
  return { date: null, basis: null, stated: false };
}

/**
 * The index value at a month, interpolated between quarter midpoints.
 *
 * A quarterly series says what a quarter was worth, not what March 4th was
 * worth; stepping between quarters would make a sale on the last day of a
 * quarter and one on the first day of the next look 3 months apart in market
 * terms when they are one day apart. Linear interpolation between midpoints is
 * the ordinary way to read a quarterly index monthly, and the result reports
 * that it is interpolated.
 */
function indexAt(series, mIdx, { prefer = 'sa' } = {}) {
  const pts = [];
  for (const r of series || []) {
    const y = num(r.year), q = num(r.quarter);
    if (y == null || q == null) continue;
    const v = prefer === 'sa'
      ? (num(r.index_sa) != null ? num(r.index_sa) : num(r.index_nsa))
      : (num(r.index_nsa) != null ? num(r.index_nsa) : num(r.index_sa));
    if (v == null || v <= 0) continue;
    pts.push({ m: quarterMonthIndex(y, q), v });
  }
  if (!pts.length) return null;
  pts.sort((a, b) => a.m - b.m);
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (mIdx < first.m) return { value: null, before: true, first, last };
  if (mIdx > last.m) return { value: null, after: true, first, last };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (mIdx >= a.m && mIdx <= b.m) {
      const t = b.m === a.m ? 0 : (mIdx - a.m) / (b.m - a.m);
      return { value: a.v + (b.v - a.v) * t, interpolated: mIdx !== a.m && mIdx !== b.m, first, last };
    }
  }
  return { value: last.v, first, last };
}

/**
 * @param {object} opts
 * @param {object} opts.comp        the comparable (its dates and sale price)
 * @param {string} opts.effectiveDate the valuation's own date — what we adjust TO
 * @param {Array}  opts.series      the region's index rows
 * @param {string} [opts.region]    for the wording
 * @param {string} [opts.prefer]    'sa' (default) or 'nsa'
 * @returns {{available:boolean, pct:number|null, amount:number|null, months:number|null,
 *            basis:string|null, why:string|null, gate:string|null, ...}}
 */
function timeAdjustment(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const comp = o.comp || {};
  const region = o.region || null;
  const prefer = o.prefer === 'nsa' ? 'nsa' : 'sa';
  const series = Array.isArray(o.series) ? o.series : [];
  const price = num(comp.sale_price != null ? comp.sale_price : comp.last_sale_price);

  const md = marketDateOf(comp);
  const from = monthIndex(md.date);
  const to = monthIndex(o.effectiveDate);

  const shell = {
    available: false, pct: null, amount: null, months: null,
    marketDate: md.date, dateBasis: md.basis, contractStated: md.stated,
    region, prefer, source: 'FHFA HPI', gate: null, why: null,
    uncoveredMonths: 0, interpolated: false, rules: RULES,
  };
  const no = (gate, why) => Object.assign({}, shell, { gate, why });

  if (!series.length) {
    return no('no_index', `we hold no house price index for ${region || 'that market'}, so there is no `
      + 'defensible basis for a time adjustment — a national figure standing in for a state is a rate '
      + 'about nowhere');
  }
  if (from == null) return no('no_date', 'this comparable states no sale or contract date to adjust from');
  if (to == null) return no('no_effective_date', 'the valuation has no effective date to adjust to');

  const a = indexAt(series, from, { prefer });
  if (!a || a.value == null) {
    if (a && a.before) {
      return no('before_index', 'this sale is older than the published index, so there is nothing to '
        + 'measure the change against');
    }
    return no('after_index', 'this sale is more recent than the last published quarter of the index — '
      + 'the index lags by about two months, and inventing a value for the gap is exactly the confident '
      + 'guess this replaces');
  }

  // THE RECENT END IS ALLOWED TO BE SHORT, AND SAYS SO. The index always lags,
  // so an effective date of "today" is normally past the last published quarter.
  // Refusing outright would make the adjustment useless on every current
  // valuation; measuring to the last published point and reporting the months
  // left uncovered is both usable and honest.
  let b = indexAt(series, to, { prefer });
  let uncovered = 0;
  if (!b || b.value == null) {
    if (b && b.before) return no('before_index', 'the valuation date is older than the published index');
    uncovered = to - a.last.m;
    b = indexAt(series, a.last.m, { prefer });
    if (!b || b.value == null) return no('no_index', 'the index holds no usable value for that market');
  }

  const months = to - from;
  const pctRaw = ((b.value - a.value) / a.value) * 100;
  const perMonth = months > 0 ? pctRaw / months : 0;

  if (Math.abs(pctRaw) > RULES.MAX_TOTAL_PCT || Math.abs(perMonth) > RULES.MAX_MONTHLY_PCT) {
    return no('implausible', `reading the index gives ${pctRaw.toFixed(1)}% over ${months} months, `
      + 'which a published index should never say — the reading is wrong rather than the market being '
      + 'extraordinary, so no adjustment is offered');
  }

  // Below the floor the adjustment is noise. Reported as zero WITH a reason,
  // never as an absent line: "no adjustment because the market barely moved" and
  // "nobody has worked this line" are different things.
  const belowFloor = Math.abs(pctRaw) < RULES.MIN_PCT;
  const pct = belowFloor ? 0 : Number(pctRaw.toFixed(2));
  const amount = price != null ? Math.round((price * pct) / 100) : null;

  return Object.assign({}, shell, {
    available: true,
    pct,
    amount,
    months,
    perMonthPct: months > 0 ? Number(perMonth.toFixed(3)) : 0,
    fromIndex: Number(a.value.toFixed(2)),
    toIndex: Number(b.value.toFixed(2)),
    interpolated: !!(a.interpolated || b.interpolated),
    uncoveredMonths: uncovered,
    belowFloor,
    why: belowFloor
      ? `the index moved less than ${RULES.MIN_PCT}% over those ${months} months, which is not worth `
        + 'adjusting for'
      : null,
    sentence: describeTimeAdjustment({
      pct, amount, months, region, dateBasis: md.basis, marketDate: md.date,
      uncoveredMonths: uncovered, belowFloor, prefer,
    }),
  });
}

/** One plain line for the grid, naming which date it measured from. */
function describeTimeAdjustment(a) {
  if (!a) return null;
  const which = a.dateBasis === 'contract'
    ? 'Measured from the CONTRACT date, which is the market the price actually evidences'
    : 'Measured from the settlement date — this report states no contract date, so the true market '
      + 'date may be one to three months earlier';
  if (a.belowFloor) {
    return `No time adjustment: the index for ${a.region || 'this market'} barely moved over those `
      + `${a.months} months. ${which}.`;
  }
  const dir = a.pct > 0 ? 'rose' : 'fell';
  return `The index for ${a.region || 'this market'} ${dir} ${Math.abs(a.pct).toFixed(2)}% over the `
    + `${a.months} months since ${a.marketDate}`
    + (a.amount != null ? `, which is ${a.amount < 0 ? '−' : '+'}$${Math.abs(a.amount).toLocaleString('en-US')} on this sale` : '')
    + `. ${which}.`
    + (a.uncoveredMonths > 0
      ? ` The last ${a.uncoveredMonths} month${a.uncoveredMonths === 1 ? '' : 's'} are not yet published, `
        + 'so they are not in this figure.' : '');
}

module.exports = {
  timeAdjustment, describeTimeAdjustment, marketDateOf, indexAt, RULES,
  _internals: { monthIndex, quarterMonthIndex },
};
