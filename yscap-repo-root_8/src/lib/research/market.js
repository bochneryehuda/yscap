'use strict';
/**
 * THE MARKET SIDE OF THE WAREHOUSE (db/423).
 *
 * Fannie Mae Form 1004MC is the appraiser's own read of a market area THEY drew
 * the boundary of, over three windows the form states RELATIVELY — "Prior 7–12
 * Months", "Prior 4–6 Months", "Current – 3 Months". Two things follow, and they
 * are the whole reason this module exists.
 *
 *  1. RELATIVE WINDOWS CANNOT BE COMPARED. A report effective March 2026 and one
 *     effective September 2025 both say "last 3 months" about completely
 *     different quarters. Stored as the form words them they can never share an
 *     axis. `periodWindows` resolves each against the report's own effective date
 *     into real dates, which is what turns a pile of reports into a time series.
 *
 *  2. IT IS AN OPINION, NOT A MEASUREMENT. Nothing here may be presented as "the
 *     market". `summarize` therefore always returns the number of REPORTS behind
 *     every figure — an average over two reports and over two hundred are
 *     different claims and must never look alike.
 *
 * The period maths is PURE and calendar-string only ('YYYY-MM-DD' end to end, the
 * repo's standing rule) — a JS Date would read a date-only value as UTC midnight
 * and can shift the month in a western timezone.
 */

/** MISMO 1004MC metric name → our column. Anything not listed is ignored, not guessed. */
const METRIC_COLUMN = Object.freeze({
  TotalSales: 'total_sales',
  TotalListings: 'total_listings',
  AbsorptionRate: 'absorption_rate',
  Supply: 'months_supply',
  MedianSalesPrice: 'median_sale_price',
  MedianListPrice: 'median_list_price',
  MedianSalesDOM: 'median_sale_dom',
  MedianListDOM: 'median_list_dom',
  MedianSalesToListRatio: 'median_sale_to_list_pct',
});
const METRIC_COLUMNS = Object.freeze(Object.values(METRIC_COLUMN));

/**
 * THE THREE WINDOWS, non-overlapping and contiguous backwards from the report's
 * effective date E:
 *
 *     last3     [E-3mo,  E)
 *     prior46   [E-6mo,  E-3mo)
 *     prior712  [E-12mo, E-6mo)
 *
 * Together they cover exactly the twelve months before the report, with no gap
 * and no double-count — so stacking many reports gives a real month-by-month
 * picture rather than a blur. Returns null for an unreadable date rather than
 * anchoring a window on today, which would file old data as current.
 */
function periodWindows(effectiveDate) {
  const e = dayString(effectiveDate);
  if (!e) return null;
  return {
    last3: { period_start: addMonths(e, -3), period_end: e },
    prior46: { period_start: addMonths(e, -6), period_end: addMonths(e, -3) },
    prior712: { period_start: addMonths(e, -12), period_end: addMonths(e, -6) },
  };
}

/** 'YYYY-MM-DD' (or a Date/timestamp) → 'YYYY-MM-DD', else null. Never a JS Date. */
function dayString(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v).trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Shift a calendar day by whole months, clamping the day to the target month's
 * length — 31 May minus 3 months is 28/29 February, not an invalid 31st that
 * Postgres would refuse.
 */
function addMonths(day, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const y0 = +m[1], mo0 = +m[2] - 1, d0 = +m[3];
  const total = y0 * 12 + mo0 + months;
  const y = Math.floor(total / 12);
  const mo = total - y * 12;
  const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const d = Math.min(d0, lastDay);
  return `${String(y).padStart(4, '0')}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * `market_trends` ({ MetricType: { last3, prior46, prior712, trend } }) →
 * { periods: { last3: {col: n, …}, … }, trends: { MetricType: 'Increasing', … } }.
 *
 * A period that carried NO readable metric is left out entirely rather than
 * written as a row of nulls — "the report did not state this window" and "the
 * window was all zeroes" are different things.
 */
function gridToPeriods(marketTrends) {
  const grid = marketTrends && typeof marketTrends === 'object' && !Array.isArray(marketTrends)
    ? marketTrends : null;
  const out = { periods: {}, trends: {} };
  if (!grid) return out;
  for (const [metric, cell] of Object.entries(grid)) {
    if (!cell || typeof cell !== 'object') continue;
    const col = METRIC_COLUMN[metric];
    if (cell.trend) out.trends[metric] = cell.trend;
    if (!col) continue;                                   // a metric we do not model — ignored, never guessed
    for (const label of ['last3', 'prior46', 'prior712']) {
      const v = cell[label];
      if (v == null || !Number.isFinite(Number(v))) continue;
      (out.periods[label] || (out.periods[label] = {}))[col] = Number(v);
    }
  }
  return out;
}

/**
 * Record one report's market read. Idempotent per report (the unique indexes in
 * db/423 are per appraisal / per import), so a re-ingest refreshes rather than
 * duplicates — the same contract `upsertObservation` follows.
 *
 * Returns {written:false} when the report carried NO market data at all, which is
 * common and is not an error: a 1004MC is only attached to some report types.
 */
async function writeMarket(db, a, ctx = {}) {
  const grid = gridToPeriods(a.market_trends);
  const hasNeighbourhood = a.nbhd_builtup != null || a.nbhd_value_trend != null
    || a.nbhd_demand_supply != null || a.nbhd_marketing_time != null || a.present_land_use != null;
  if (!Object.keys(grid.periods).length && !Object.keys(grid.trends).length && !hasNeighbourhood) {
    return { written: false };
  }

  const cols = {
    appraisal_id: ctx.appraisalId || null,
    import_id: ctx.importId || null,
    application_id: a.application_id || null,
    property_id: ctx.propertyId || null,
    appraiser_id: ctx.appraiserId || null,
    state: txt(a.subject_state), city: txt(a.subject_city), zip: txt(a.subject_zip),
    county: txt(a.subject_county),
    // Filled only if a caller genuinely knows them; the ingest does not (see the
    // note at its call site), and the subject's position is reachable through
    // `property_id` once the geocoder has placed that property.
    latitude: ctx.latitude == null ? null : ctx.latitude,
    longitude: ctx.longitude == null ? null : ctx.longitude,
    effective_date: dayString(a.effective_date),
    form_type: txt(a.form_type),
    // The appraiser's own per-metric conclusion, plus the flattened headline the
    // importer already stores, so a report that carried ONLY the trend row still
    // records a direction.
    trends: JSON.stringify(Object.assign({}, grid.trends,
      a.mc_price_trend ? { MedianSalesPrice: a.mc_price_trend } : null)),
    nbhd_location_type: txt(a.nbhd_location_type),
    nbhd_builtup: txt(a.nbhd_builtup),
    nbhd_growth: txt(a.nbhd_growth),
    nbhd_value_trend: txt(a.nbhd_value_trend),
    nbhd_demand_supply: txt(a.nbhd_demand_supply),
    nbhd_marketing_time: txt(a.nbhd_marketing_time),
    nbhd_price_low: a.nbhd_price_low, nbhd_price_high: a.nbhd_price_high,
    nbhd_price_predominant: a.nbhd_price_predominant,
    nbhd_age_predominant: a.nbhd_age_predominant,
    nbhd_boundaries: txt(a.nbhd_boundaries),
    nbhd_adverse_financing: txt(a.nbhd_adverse_financing),
    nbhd_foreclosure_activity: txt(a.nbhd_foreclosure_activity),
    // jsonb — through `bindable`, because a jsonb column reads back as a JS
    // object and binding it raw makes node-postgres send a Postgres array
    // literal (the roll-up wipe of PR #974).
    present_land_use: bindableJson(a.present_land_use),
    market_conditions_comment: txt(a.market_conditions_comment),
    market_reconciliation_comment: txt(a.market_reconciliation_comment),
    comp_research: txt(a.comp_research),
  };

  const keys = Object.keys(cols);
  const conflict = ctx.importId ? '(import_id) WHERE import_id IS NOT NULL'
    : '(appraisal_id) WHERE appraisal_id IS NOT NULL';
  const updatable = keys.filter((k) => k !== 'appraisal_id' && k !== 'import_id');
  const obs = (await db.query(
    `INSERT INTO market_observations (${keys.join(',')})
     VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')})
     ON CONFLICT ${conflict} DO UPDATE SET
       ${updatable.map((k) => `${k} = EXCLUDED.${k}`).join(', ')}, updated_at = now()
     RETURNING id`, keys.map((k) => cols[k]))).rows[0];

  const windows = periodWindows(cols.effective_date) || {};
  let periods = 0;
  for (const [label, metrics] of Object.entries(grid.periods)) {
    const w = windows[label] || { period_start: null, period_end: null };
    const pcols = Object.assign({ observation_id: obs.id, period_label: label }, w, metrics);
    const pk = Object.keys(pcols);
    await db.query(
      `INSERT INTO market_periods (${pk.join(',')})
       VALUES (${pk.map((_, i) => '$' + (i + 1)).join(',')})
       ON CONFLICT (observation_id, period_label) DO UPDATE SET
         ${pk.filter((k) => k !== 'observation_id' && k !== 'period_label')
    .map((k) => `${k} = EXCLUDED.${k}`).join(', ')}`,
      pk.map((k) => pcols[k]));
    periods++;
  }
  return { written: true, id: obs.id, periods };
}

/**
 * "What have our appraisers said about this market, and how confident can we be?"
 *
 * EVERY figure carries `reports` — the number of separate appraisals behind it.
 * That is not decoration: this is opinion data from areas each appraiser drew
 * themselves, and an average over two reports must never look like an average
 * over two hundred. Returns the windows newest first so the caller can plot them.
 */
async function summarize(db, { state, city, zip, months = 24, sinceDay = null } = {}) {
  const params = [];
  const P = (v) => { params.push(v); return '$' + params.length; };
  const where = ['p.period_start IS NOT NULL'];
  if (state) where.push(`o.state = ${P(String(state).toUpperCase())}`);
  if (city) where.push(`lower(o.city) = ${P(String(city).toLowerCase())}`);
  if (zip) where.push(`o.zip = ${P(String(zip))}`);
  if (sinceDay) where.push(`p.period_start >= ${P(sinceDay)}`);
  else if (months > 0) where.push(`p.period_start >= (CURRENT_DATE - ${P(String(months) + ' months')}::interval)`);

  const r = await db.query(
    `SELECT date_trunc('month', p.period_start)::date AS month,
            count(DISTINCT o.id)::int                AS reports,
            round(avg(p.months_supply)::numeric, 2)  AS months_supply,
            round(avg(p.median_sale_to_list_pct)::numeric, 2) AS sale_to_list_pct,
            round(avg(p.median_sale_dom)::numeric, 0)         AS median_dom,
            round(avg(p.median_sale_price)::numeric, 0)       AS median_sale_price,
            sum(p.total_sales)::int                           AS total_sales
       FROM market_periods p
       JOIN market_observations o ON o.id = p.observation_id
      WHERE ${where.join(' AND ')}
      GROUP BY 1 ORDER BY 1 DESC`, params);

  return {
    where: { state: state || null, city: city || null, zip: zip || null },
    months: r.rows,
    // The denominator for the WHOLE answer, so a caller that plots only the
    // series still has one number telling them how much to trust it.
    reports: r.rows.reduce((n, x) => Math.max(n, x.reports), 0),
    note: 'Each figure is an average of what our own appraisers reported for their '
      + 'own market areas — not a measured market statistic. Read it with the report count.',
  };
}

const txt = (v) => { const s = v == null ? '' : String(v).trim(); return s === '' ? null : s; };
/** A jsonb value the driver can bind — see PR #974. */
function bindableJson(v) {
  if (v == null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

module.exports = {
  writeMarket, summarize, periodWindows, gridToPeriods,
  METRIC_COLUMN, METRIC_COLUMNS,
  _internals: { addMonths, dayString, bindableJson },
};
