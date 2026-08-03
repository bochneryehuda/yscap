'use strict';
/**
 * THE VALUATION ENGINE — the sales-comparison grid, in code.
 *
 * This is the maths behind "build your own AVM": pick comparables out of the
 * research warehouse, adjust each one to the subject, and reconcile the adjusted
 * prices into an indicated value with an honest range and a list of the things a
 * reviewer would object to.
 *
 * PURE. No database, no HTTP, no dates-from-the-clock except where a `today` is
 * passed in. Everything here is a function of its arguments, which is what makes
 * the grid testable and what makes a saved valuation reproducible years later.
 *
 * THE THREE THINGS IT REFUSES TO DO
 *
 *  1. IT NEVER INVENTS AN ADJUSTMENT RATE. `deriveMarketRates` reads OUR OWN
 *     comparable observations and returns a rate only when there are enough
 *     paired observations to support one. Below the floor it returns null WITH A
 *     REASON, the grid shows a blank line, and the human types the number. A
 *     fabricated $/sqft rate is worse than an empty box, because a number on a
 *     screen gets believed.
 *
 *  2. IT NEVER HIDES A WEAK ANSWER. Two comps, or comps a year old, or a 40%
 *     gross adjustment still produce a value — and produce it wearing every
 *     warning that applies. The caller decides whether to show it; the engine
 *     will not quietly suppress the caveats to make the number look clean.
 *
 *  3. IT IS NOT AN APPRAISAL. Nothing here is USPAP work product. The output
 *     carries `disclaimer` on purpose, and every surface that renders it must
 *     keep that text with the number.
 *
 * SIGN CONVENTION (the one every appraisal grid uses, and the one people get
 * backwards): the adjustment is applied to the COMPARABLE, to make it look like
 * the SUBJECT. A comp that is SUPERIOR to the subject gets a NEGATIVE adjustment
 * (it sold for more than the subject would, so take money off). A comp that is
 * INFERIOR gets a POSITIVE one. adjusted = sale price + Σ adjustments.
 */

// ---------------------------------------------------------------------------
// THE GRID LINES — the URAR sales-comparison grid, in its canonical order.
// A saved valuation stores adjustments keyed by these; the order here is the
// order they render, so the grid always reads like the form an appraiser knows.
// ---------------------------------------------------------------------------
const GRID_LINES = Object.freeze([
  { key: 'sale_concessions', label: 'Sale or financing concessions' },
  { key: 'market_conditions', label: 'Date of sale / time' },
  { key: 'location', label: 'Location' },
  { key: 'site', label: 'Site / lot' },
  { key: 'view', label: 'View' },
  { key: 'design_style', label: 'Design (style)' },
  { key: 'quality', label: 'Quality of construction' },
  { key: 'age', label: 'Actual age' },
  { key: 'condition', label: 'Condition' },
  { key: 'room_count', label: 'Above-grade room count' },
  { key: 'gla', label: 'Gross living area' },
  { key: 'basement', label: 'Basement & finished rooms below grade' },
  { key: 'functional', label: 'Functional utility' },
  { key: 'hvac', label: 'Heating / cooling' },
  { key: 'energy', label: 'Energy efficient items' },
  { key: 'garage', label: 'Garage / carport' },
  { key: 'porch_patio', label: 'Porch / patio / deck' },
  { key: 'other', label: 'Other' },
]);
const GRID_KEYS = new Set(GRID_LINES.map((l) => l.key));

// The UAD ordinal scales, best → worst (index IS the rank).
const CONDITION_SCALE = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'];
const QUALITY_SCALE = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'];
const rankOf = (scale, v) => { const i = scale.indexOf(String(v || '').toUpperCase()); return i < 0 ? null : i; };

// ---------------------------------------------------------------------------
// REVIEW THRESHOLDS — OUR OWN review flags, and it matters that they are ours.
//
// The famous "15% net / 25% gross" pair is widely repeated as a Fannie Mae rule.
// IT IS NOT ONE ANY MORE: Fannie REMOVED those hard adjustment limits from the
// Selling Guide in December 2014, and Collateral Underwriter does not apply them
// — it compares an adjustment against what OTHER appraisers did on similar
// properties instead. The 1-mile radius and the 90-day recency preference are
// lender overlays too, not GSE requirements. (Sources and the current guide
// references: docs/research/COMP-DATABASE-INDUSTRY-RESEARCH.md §3.)
//
// They are kept here because they are still good internal smell tests — a comp
// needing a 30% gross correction really is a weak comp — but the warnings below
// are worded as OUR opinion, never as "Fannie requires". Do not re-label them as
// a GSE rule in any UI copy.
// ---------------------------------------------------------------------------
const THRESHOLDS = Object.freeze({
  netAdjPct: 15,          // net adjustments over 15% of the sale price: worth a look
  grossAdjPct: 25,        // gross adjustments over 25% likewise
  lineAdjPct: 10,         // any single line over 10% of the sale price
  maxAgeMonths: 12,       // a comp older than a year needs explaining
  preferredAgeMonths: 6,
  maxDistanceMiles: 1,    // the urban convention; rural properly goes wider
  glaTolerancePct: 25,    // a comp more than a quarter off the subject's size
  minClosedComps: 3,      // three closed sales is the floor for an opinion of value
});

const num = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const round = (n, to = 1) => (n == null ? null : Math.round(n / to) * to);
const median = (arr) => {
  const a = arr.filter((n) => Number.isFinite(n)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/** Whole months between two 'YYYY-MM-DD' strings (a - b), or null. */
function monthsBetween(a, b) {
  if (!a || !b) return null;
  const pa = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(a).slice(0, 10));
  const pb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(b).slice(0, 10));
  if (!pa || !pb) return null;
  return (+pa[1] - +pb[1]) * 12 + (+pa[2] - +pb[2]) + (+pa[3] - +pb[3]) / 30.44;
}

// ---------------------------------------------------------------------------
// 1. ADJUST ONE COMP
// ---------------------------------------------------------------------------
/**
 * Apply an adjustment set to one comparable.
 * @param {object} comp   { sale_price, gla, ... }
 * @param {object|Array} adjustments  { gla: -5000, condition: 10000 } or [{key,amount,note}]
 * @returns {{salePrice, lines, adjustedPrice, netAdjustment, grossAdjustment, netAdjPct, grossAdjPct, pricePerSqft}}
 */
function adjustComp(comp, adjustments) {
  const salePrice = num(comp && (comp.sale_price != null ? comp.sale_price : comp.salePrice));
  const lines = normalizeAdjustments(adjustments);
  let net = 0, gross = 0;
  for (const l of lines) { net += l.amount; gross += Math.abs(l.amount); }
  const adjusted = salePrice == null ? null : salePrice + net;
  const gla = num(comp && comp.gla);
  return {
    salePrice, lines,
    adjustedPrice: adjusted,
    netAdjustment: net,
    grossAdjustment: gross,
    netAdjPct: salePrice ? (net / salePrice) * 100 : null,
    grossAdjPct: salePrice ? (gross / salePrice) * 100 : null,
    pricePerSqft: adjusted != null && gla ? adjusted / gla : null,
  };
}

/** Accept either an object map or a line array; always return an ordered line array. */
function normalizeAdjustments(adjustments) {
  const out = [];
  if (!adjustments) return out;
  // A GRID LINE HAS TO FIT ITS COLUMN. `adjusted_price` is numeric(14,2) and
  // `net_adj_pct` is numeric(8,2) — so the PERCENTAGE overflows an order of
  // magnitude before the money does. A pasted 5000000000 on a $300,000 comp made
  // Postgres answer 22003 and the route had no catch, which reads to the user as
  // "PILOT is broken", not "that number is too big". A line this size is a paste
  // accident, never a real adjustment, so it is DROPPED like an unknown key
  // rather than clamped to a number nobody typed.
  const MAX_ADJ = 1e9;
  const push = (key, amount, note, source) => {
    const a = num(amount);
    if (a == null || a === 0) return;
    if (!Number.isFinite(a) || Math.abs(a) > MAX_ADJ) return;
    if (!GRID_KEYS.has(key)) return;      // an unknown line is dropped, never silently summed
    out.push({ key, label: labelOf(key), amount: a, note: note || null, source: source || 'user' });
  };
  if (Array.isArray(adjustments)) {
    for (const l of adjustments) if (l) push(l.key, l.amount, l.note, l.source);
  } else {
    for (const [k, v] of Object.entries(adjustments)) {
      if (v && typeof v === 'object') push(k, v.amount, v.note, v.source);
      else push(k, v, null, 'user');
    }
  }
  const order = GRID_LINES.map((l) => l.key);
  out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return out;
}
const labelOf = (key) => (GRID_LINES.find((l) => l.key === key) || {}).label || key;

// ---------------------------------------------------------------------------
// 2. WHAT A REVIEWER WOULD SAY
// ---------------------------------------------------------------------------
/**
 * Per-comp warnings. Plain English, because the people reading this are not
 * appraisers — each one says what is wrong and why it matters.
 */
function compWarnings(subject, comp, adj, { today = null } = {}) {
  const w = [];
  const T = THRESHOLDS;
  if (adj.netAdjPct != null && Math.abs(adj.netAdjPct) > T.netAdjPct) {
    w.push({ code: 'net_adj_high', severity: 'warning',
      text: `The adjustments move this sale by ${adj.netAdjPct.toFixed(0)}% overall — over the ${T.netAdjPct}% an appraisal reviewer expects. It may not be a close enough match.` });
  }
  if (adj.grossAdjPct != null && adj.grossAdjPct > T.grossAdjPct) {
    w.push({ code: 'gross_adj_high', severity: 'warning',
      text: `The adjustments add up to ${adj.grossAdjPct.toFixed(0)}% of the sale price — over the ${T.grossAdjPct}% guideline. A lot of correcting means it is not really comparable.` });
  }
  for (const l of adj.lines) {
    if (adj.salePrice && Math.abs(l.amount) / adj.salePrice * 100 > T.lineAdjPct) {
      w.push({ code: 'line_adj_high', severity: 'info',
        text: `The "${l.label}" adjustment alone is ${(Math.abs(l.amount) / adj.salePrice * 100).toFixed(0)}% of the sale price.` });
    }
  }
  const age = today && comp.sale_date ? monthsBetween(today, comp.sale_date) : null;
  if (age != null && age > T.maxAgeMonths) {
    w.push({ code: 'comp_stale', severity: 'warning',
      text: `This sale closed about ${Math.round(age)} months ago — older than the ${T.maxAgeMonths} months normally accepted without explaining why.` });
  }
  const d = num(comp.distance_miles);
  if (d != null && d > T.maxDistanceMiles) {
    w.push({ code: 'comp_far', severity: 'info',
      text: `It is about ${d.toFixed(1)} miles from the subject. Over a mile is usual only where properties are spread out.` });
  }
  const sg = num(subject && subject.gla), cg = num(comp.gla);
  if (sg && cg) {
    const off = Math.abs(cg - sg) / sg * 100;
    if (off > T.glaTolerancePct) {
      w.push({ code: 'gla_off', severity: 'warning',
        text: `It is ${off.toFixed(0)}% ${cg > sg ? 'bigger' : 'smaller'} than the subject (${Math.round(cg)} vs ${Math.round(sg)} sq ft) — a big size gap makes the price-per-foot comparison shaky.` });
    }
  }
  if (comp.sale_status && comp.sale_status !== 'closed') {
    w.push({ code: 'not_closed', severity: 'warning',
      text: `This is ${comp.sale_status === 'active' ? 'a property still for sale' : 'a sale that has not closed yet'} — that is an asking price, not a proven sale price.` });
  }
  if (comp.sale_type && /reo|short|estate|relocation/i.test(String(comp.sale_type))) {
    w.push({ code: 'distressed', severity: 'info',
      text: `The appraiser marked this sale "${comp.sale_type}" — a forced or non-arm's-length sale usually sells below the open market.` });
  }
  if (adj.salePrice == null) {
    w.push({ code: 'no_price', severity: 'fatal', text: 'This comparable has no sale price, so it cannot be used in the value.' });
  }
  return w;
}

/** Whole-set warnings: is this collection of comps enough to stand on? */
function setWarnings(subject, comps, { today = null } = {}) {
  const w = [];
  const T = THRESHOLDS;
  // THE SAME SET THE VALUE IS COMPUTED FROM — `reconcile` filters switched-off
  // comps and this did not, so warnings described rows that were not in the
  // answer. Concretely: four comps with three switched off produced a value
  // resting on ONE comp and NO "too few comps" warning, and `finalize` gates on
  // the value's own comp count, so that valuation could be finished clean.
  const usable = comps.filter((c) => c.adjustedPrice != null && c.include !== false);
  const closed = usable.filter((c) => (c.sale_status || 'closed') === 'closed');
  if (closed.length < T.minClosedComps) {
    w.push({ code: 'too_few_comps', severity: closed.length === 0 ? 'fatal' : 'warning',
      text: `Only ${closed.length} closed sale${closed.length === 1 ? '' : 's'} — an opinion of value normally rests on at least ${T.minClosedComps}.` });
  }
  // BRACKETING: a defensible value has comps ABOVE and BELOW the subject on the
  // things that drive price. Without it the answer is an extrapolation.
  const sg = num(subject && subject.gla);
  if (sg && usable.length >= 2) {
    const glas = usable.map((c) => num(c.gla)).filter((n) => n != null);
    if (glas.length >= 2 && !(glas.some((g) => g >= sg) && glas.some((g) => g <= sg))) {
      w.push({ code: 'no_gla_bracket', severity: 'info',
        text: `Every comparable is ${glas[0] > sg ? 'bigger' : 'smaller'} than the subject. Picking some on each side of its size makes the answer much harder to argue with.` });
    }
  }
  const prices = usable.map((c) => c.adjustedPrice).filter((n) => n != null);
  if (prices.length >= 2) {
    const lo = Math.min(...prices), hi = Math.max(...prices);
    const mid = median(prices);
    if (mid && (hi - lo) / mid > 0.25) {
      w.push({ code: 'wide_spread', severity: 'warning',
        text: `After adjusting, the comparables still range from ${money(lo)} to ${money(hi)} — a spread that wide means the answer is a range, not a number.` });
    }
  }
  if (today) {
    const ages = usable.map((c) => monthsBetween(today, c.sale_date)).filter((n) => n != null);
    if (ages.length && Math.min(...ages) > T.preferredAgeMonths) {
      w.push({ code: 'all_stale', severity: 'info',
        text: `The newest sale here is about ${Math.round(Math.min(...ages))} months old. Nothing recent means the market may have moved underneath these numbers.` });
    }
  }
  return w;
}
const money = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'));

// ---------------------------------------------------------------------------
// 3. RECONCILE
// ---------------------------------------------------------------------------
/**
 * Reconcile adjusted comparables into an indicated value.
 *
 * WEIGHTING. The default is not "everything counts the same" — an appraiser
 * leans on the comp that needed the least correcting, and so does this. Each
 * comp's weight is 1 / (1 + gross adjustment %/100)², times a recency factor
 * that halves roughly every 12 months. A comp the user pinned a weight on
 * overrides that entirely (their judgement beats the formula, always).
 *
 * The headline number is the WEIGHTED MEAN; the median is reported beside it,
 * because when the two disagree the set is telling you something.
 *
 * @param {object} subject
 * @param {Array} comps  each already through adjustComp(), plus its facts
 * @param {object} opts  { today, method:'weighted'|'median'|'mean', roundTo }
 */
function reconcile(subject, comps, opts = {}) {
  const today = opts.today || null;
  const roundTo = opts.roundTo || 1000;
  const usable = comps.filter((c) => c.adjustedPrice != null && (c.include !== false));
  const weights = usable.map((c) => {
    if (num(c.weight) != null && num(c.weight) > 0) return num(c.weight);
    const gross = c.grossAdjPct == null ? 0 : Math.abs(c.grossAdjPct);
    let w = 1 / Math.pow(1 + gross / 100, 2);
    const age = today && c.sale_date ? monthsBetween(today, c.sale_date) : null;
    if (age != null && age > 0) w *= Math.pow(0.5, age / 12);
    // A listing or a pending sale is evidence, but it is not a closed sale.
    if (c.sale_status && c.sale_status !== 'closed') w *= 0.5;
    return w > 0 ? w : 0.0001;
  });
  const wsum = weights.reduce((a, b) => a + b, 0);
  const prices = usable.map((c) => c.adjustedPrice);
  const weighted = wsum > 0 ? usable.reduce((acc, c, i) => acc + c.adjustedPrice * weights[i], 0) / wsum : null;
  const mid = median(prices);
  const mean = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;

  const method = opts.method === 'median' ? 'median' : opts.method === 'mean' ? 'mean' : 'weighted';
  const raw = method === 'median' ? mid : method === 'mean' ? mean : weighted;

  // The RANGE is the honest part. The full spread of adjusted prices is the outer
  // range; the "likely" range is one weighted standard deviation either side,
  // which is where the comps actually cluster.
  let sd = null;
  if (weighted != null && wsum > 0 && usable.length > 1) {
    const v = usable.reduce((acc, c, i) => acc + weights[i] * Math.pow(c.adjustedPrice - weighted, 2), 0) / wsum;
    sd = Math.sqrt(v);
  }
  const per = usable.map((c) => (c.gla ? c.adjustedPrice / num(c.gla) : null)).filter((n) => n != null);

  return {
    method,
    indicatedValue: round(raw, roundTo),
    indicatedValueRaw: raw,
    weightedAverage: round(weighted, roundTo),
    median: round(mid, roundTo),
    mean: round(mean, roundTo),
    low: prices.length ? round(Math.min(...prices), roundTo) : null,
    high: prices.length ? round(Math.max(...prices), roundTo) : null,
    likelyLow: sd != null && raw != null ? round(raw - sd, roundTo) : null,
    likelyHigh: sd != null && raw != null ? round(raw + sd, roundTo) : null,
    spreadPct: mid && prices.length > 1 ? ((Math.max(...prices) - Math.min(...prices)) / mid) * 100 : null,
    pricePerSqft: per.length ? round(median(per), 1) : null,
    compCount: usable.length,
    closedCompCount: usable.filter((c) => (c.sale_status || 'closed') === 'closed').length,
    weights: usable.map((c, i) => ({ id: c.id || c.property_id || null, weight: weights[i] / (wsum || 1) })),
    confidence: confidenceOf(usable, sd, raw, today),
    disclaimer: DISCLAIMER,
  };
}

/**
 * A confidence LABEL, never a fake percentage. A percentage implies a calibrated
 * model behind it; this is a rule over comp count, spread and recency, and it
 * says so. `reasons` is what the screen shows under the label.
 */
function confidenceOf(comps, sd, value, today) {
  const reasons = [];
  let score = 0;
  const closed = comps.filter((c) => (c.sale_status || 'closed') === 'closed').length;
  if (closed >= 5) { score += 2; reasons.push(`${closed} closed sales`); }
  else if (closed >= 3) { score += 1; reasons.push(`${closed} closed sales`); }
  else reasons.push(`only ${closed} closed sale${closed === 1 ? '' : 's'}`);

  if (sd != null && value) {
    const cv = sd / value;
    if (cv <= 0.05) { score += 2; reasons.push('the sales agree closely'); }
    else if (cv <= 0.10) { score += 1; reasons.push('the sales mostly agree'); }
    else reasons.push('the sales disagree a lot');
  }
  const gross = comps.map((c) => c.grossAdjPct).filter((n) => n != null);
  if (gross.length) {
    const g = median(gross);
    if (g <= 10) { score += 2; reasons.push('very little adjusting was needed'); }
    else if (g <= 25) { score += 1; reasons.push('a normal amount of adjusting'); }
    else reasons.push('a lot of adjusting was needed');
  }
  if (today) {
    const ages = comps.map((c) => monthsBetween(today, c.sale_date)).filter((n) => n != null);
    if (ages.length) {
      const a = median(ages);
      if (a <= 6) { score += 1; reasons.push('recent sales'); }
      else if (a > 12) { score -= 1; reasons.push('the sales are over a year old'); }
    }
  }
  const label = score >= 6 ? 'strong' : score >= 4 ? 'fair' : score >= 2 ? 'weak' : 'very weak';
  return { label, score, reasons, basis: 'a rule over comp count, agreement, adjustment size and recency — not a statistical model' };
}

const DISCLAIMER = 'This is an internal value indication built from the comparable sales in our own appraisal reports. '
  + 'It is NOT an appraisal, it is not USPAP work product, and it may not be used in place of one. '
  + 'It exists to help staff research a property before ordering the real thing.';

// ---------------------------------------------------------------------------
// 4. DERIVE ADJUSTMENT RATES FROM OUR OWN DATA
// ---------------------------------------------------------------------------
/**
 * What our own comparable observations say a square foot / a bedroom / a bath /
 * a condition grade is worth in a market, and how fast that market is moving.
 *
 * METHOD, and its honest limits. This is a MEDIAN-OF-RATIOS read, not a
 * regression: for $/sqft it is the median of (sale price ÷ GLA) over the closed
 * sales in the set; for a bedroom/bath/condition grade it is the difference in
 * median price-per-foot between the groups, applied to the subject's size. That
 * is the same arithmetic an appraiser does by hand, and it is defensible on a
 * few dozen sales in a way that a hedonic regression is not.
 *
 * EVERY RATE CARRIES ITS SAMPLE. Below `minSample` the rate is null with a
 * reason, because a "$142 per square foot" derived from three sales is a
 * coincidence with a dollar sign on it.
 *
 * @param {Array} obs  closed comparable observations: {sale_price, gla, beds, baths_full, baths_half, condition_uad, sale_date}
 * @param {object} opts {minSample=8, today}
 */
function deriveMarketRates(obs, opts = {}) {
  const minSample = opts.minSample || 8;
  const today = opts.today || null;
  const rows = (obs || []).filter((o) => num(o.sale_price) != null && (o.sale_status || 'closed') === 'closed');
  const withGla = rows.filter((o) => num(o.gla) > 200);
  const out = { sampleSize: rows.length, minSample };

  const ppsf = withGla.map((o) => num(o.sale_price) / num(o.gla));
  out.pricePerSqft = withGla.length >= minSample
    ? { value: round(median(ppsf), 1), n: withGla.length, basis: `median of sale price ÷ living area across ${withGla.length} closed sales` }
    : { value: null, n: withGla.length, why: `only ${withGla.length} closed sales with a living area — need ${minSample} before a rate means anything` };

  // The GLA ADJUSTMENT RATE is NOT the full price per foot. An extra square foot
  // of the same house is worth a fraction of the average foot (the land, the
  // kitchen and the systems are already paid for); the trade convention is a
  // quarter to a half. We publish the range and use the midpoint, and we SAY so.
  out.glaAdjustmentPerSqft = out.pricePerSqft.value == null ? { value: null, why: out.pricePerSqft.why }
    : { value: round(out.pricePerSqft.value * 0.4, 1),
        low: round(out.pricePerSqft.value * 0.25, 1), high: round(out.pricePerSqft.value * 0.5, 1),
        n: withGla.length,
        basis: 'about 40% of the average price per foot — an extra foot of the same house is worth less than the average foot, and the trade convention is a quarter to a half' };

  out.perBedroom = groupDelta(withGla, (o) => num(o.beds), minSample, 'bedroom');
  out.perBath = groupDelta(withGla, (o) => {
    const f = num(o.baths_full), h = num(o.baths_half);
    return f == null && h == null ? null : (f || 0) + (h || 0) * 0.5;
  }, minSample, 'bathroom');
  out.perConditionGrade = groupDelta(withGla, (o) => rankOf(CONDITION_SCALE, o.condition_uad), minSample, 'condition grade', true);

  // TIME. The monthly change in median price-per-foot between the older half and
  // the newer half of the set. Crude on purpose — anything cleverer on this much
  // data is false precision — and null unless both halves are big enough.
  out.monthlyMarketChangePct = timeTrend(withGla, today, minSample);
  return out;
}

/**
 * The value of one step of a grouping variable, read as the difference in median
 * $/sqft between adjacent groups. `inverse` flips the sign for a scale where a
 * HIGHER number is WORSE (condition C1 is best, C6 is worst).
 */
function groupDelta(rows, keyOf, minSample, label, inverse = false) {
  const groups = new Map();
  for (const o of rows) {
    const k = keyOf(o);
    if (k == null) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(num(o.sale_price) / num(o.gla));
  }
  const keys = [...groups.keys()].sort((a, b) => a - b).filter((k) => groups.get(k).length >= 3);
  const n = keys.reduce((acc, k) => acc + groups.get(k).length, 0);
  if (keys.length < 2 || n < minSample) {
    return { value: null, n, why: `not enough sales spread across different ${label} counts to read a difference (${n} usable, need ${minSample} across at least two groups)` };
  }
  const deltas = [];
  for (let i = 1; i < keys.length; i++) {
    const step = keys[i] - keys[i - 1];
    if (!step) continue;
    deltas.push((median(groups.get(keys[i])) - median(groups.get(keys[i - 1]))) / step);
  }
  const d = median(deltas);
  if (d == null) return { value: null, n, why: `could not read a per-${label} difference from this set` };
  const signed = inverse ? -d : d;
  // A DERIVED RATE WITH THE WRONG SIGN IS WORSE THAN NO RATE. More bedrooms, more
  // bathrooms and a better condition grade are worth MORE, always — so a negative
  // reading means the sample is telling us about something else (a small set where
  // the four-bedrooms happen to be the tired ones). Refuse it and say why, rather
  // than pre-filling a grid line that subtracts money for an extra bathroom.
  if (!(signed > 0)) {
    return { value: null, n, why: `our sales do not show a consistent price difference by ${label} yet — the ${n} we have point the wrong way, which means the sample is too small or too mixed to read` };
  }
  return {
    valuePerSqft: round(signed, 0.01), n,
    groups: keys.map((k) => ({ key: k, n: groups.get(k).length, medianPricePerSqft: round(median(groups.get(k)), 1) })),
    basis: `difference in median price per foot between ${label} groups (${n} sales) — multiply by the subject's living area to get dollars`,
  };
}

/** Monthly % change in median $/sqft, older half vs newer half. Null when thin. */
function timeTrend(rows, today, minSample) {
  const dated = rows.filter((o) => o.sale_date).slice().sort((a, b) => String(a.sale_date).localeCompare(String(b.sale_date)));
  if (dated.length < minSample * 2) {
    return { value: null, n: dated.length, why: `only ${dated.length} dated sales — a market trend needs at least ${minSample * 2} before it is anything but noise` };
  }
  const half = Math.floor(dated.length / 2);
  const older = dated.slice(0, half), newer = dated.slice(half);
  const mo = median(older.map((o) => num(o.sale_price) / num(o.gla)));
  const mn = median(newer.map((o) => num(o.sale_price) / num(o.gla)));
  const midOlder = older[Math.floor(older.length / 2)].sale_date;
  const midNewer = newer[Math.floor(newer.length / 2)].sale_date;
  const months = monthsBetween(String(midNewer).slice(0, 10), String(midOlder).slice(0, 10));
  if (!mo || !mn || !months || months <= 0) return { value: null, n: dated.length, why: 'the sales are not spread over enough time to read a trend' };
  const pct = ((mn - mo) / mo) * 100 / months;
  return {
    value: round(pct, 0.01), n: dated.length, monthsApart: round(months, 0.1),
    basis: `median price per foot moved ${round(((mn - mo) / mo) * 100, 0.1)}% over about ${round(months, 0.1)} months between the older and newer halves of the set`,
  };
}

// ---------------------------------------------------------------------------
// 5. SUGGEST A STARTING GRID
// ---------------------------------------------------------------------------
/**
 * Pre-fill the adjustment lines we can actually support, so the user starts from
 * something rather than eighteen blank boxes. Every suggestion carries its
 * REASON, and a line we cannot support is simply absent — never zero-filled,
 * because a zero reads as "no difference" rather than "we don't know".
 *
 * Suggested today: living area, bedroom count, bath count, condition grade, and
 * time. The rest (location, view, site, garage, basement…) need judgement about
 * things the grid data cannot see, so they stay for the human.
 */
function suggestAdjustments(subject, comp, rates, opts = {}) {
  const today = opts.today || null;
  const lines = [];
  const sqftRate = rates && rates.glaAdjustmentPerSqft ? num(rates.glaAdjustmentPerSqft.value) : null;
  const sg = num(subject && subject.gla), cg = num(comp && comp.gla);
  if (sqftRate && sg && cg && Math.abs(sg - cg) >= 25) {
    lines.push({ key: 'gla', amount: round((sg - cg) * sqftRate, 50), source: 'suggested',
      note: `${Math.round(sg - cg)} sq ft ${sg > cg ? 'more' : 'less'} than this sale, at about $${sqftRate}/sq ft (${rates.glaAdjustmentPerSqft.basis})` });
  }
  // The URAR grid has ONE "above-grade room count" line covering total rooms,
  // bedrooms and baths, so the bedroom and bath differences are summed into it
  // rather than split across two lines the form does not have.
  const perBed = rates && rates.perBedroom ? num(rates.perBedroom.valuePerSqft) : null;
  const perBath = rates && rates.perBath ? num(rates.perBath.valuePerSqft) : null;
  const sb = num(subject && subject.beds), cb = num(comp && comp.beds);
  const sBath = bathsOf(subject), cBath = bathsOf(comp);
  let rooms = 0; const roomNotes = [];
  if (perBed && sg && sb != null && cb != null && sb !== cb) {
    rooms += (sb - cb) * perBed * sg;
    roomNotes.push(`${Math.abs(sb - cb)} ${Math.abs(sb - cb) === 1 ? 'bedroom' : 'bedrooms'} ${sb > cb ? 'more' : 'fewer'}`);
  }
  if (perBath && sg && sBath != null && cBath != null && sBath !== cBath) {
    rooms += (sBath - cBath) * perBath * sg;
    roomNotes.push(`${Math.abs(sBath - cBath)} ${Math.abs(sBath - cBath) === 1 ? 'bathroom' : 'bathrooms'} ${sBath > cBath ? 'more' : 'fewer'}`);
  }
  if (rooms) {
    lines.push({ key: 'room_count', amount: round(rooms, 250), source: 'suggested',
      note: `subject has ${roomNotes.join(' and ')} (read from the price difference between room counts in our own sales)` });
  }
  const perGrade = rates && rates.perConditionGrade ? num(rates.perConditionGrade.valuePerSqft) : null;
  const sc = rankOf(CONDITION_SCALE, subject && subject.condition_uad);
  const cc = rankOf(CONDITION_SCALE, comp && comp.condition_uad);
  if (perGrade && sg && sc != null && cc != null && sc !== cc) {
    // A LOWER rank index is BETTER (C1 best). The subject being better than the
    // comp means the comp is inferior, so the comp gets a POSITIVE adjustment.
    lines.push({ key: 'condition', amount: round((cc - sc) * perGrade * sg, 250), source: 'suggested',
      note: `subject is ${subject.condition_uad}, this sale is ${comp.condition_uad} (${rates.perConditionGrade.basis})` });
  }
  const trend = rates && rates.monthlyMarketChangePct ? num(rates.monthlyMarketChangePct.value) : null;
  const months = today && comp && comp.sale_date ? monthsBetween(today, comp.sale_date) : null;
  if (trend && months && months > 1 && num(comp.sale_price)) {
    lines.push({ key: 'market_conditions', amount: round(num(comp.sale_price) * (trend / 100) * months, 250), source: 'suggested',
      note: `sold about ${Math.round(months)} months ago; our own sales moved about ${trend}% a month (${rates.monthlyMarketChangePct.basis})` });
  }
  // Concessions the appraiser recorded are a FACT, not a judgement — a seller
  // credit inflated the recorded price by exactly that much.
  const conc = num(comp && comp.concession_amount);
  if (conc && conc > 0) {
    lines.push({ key: 'sale_concessions', amount: -conc, source: 'suggested',
      note: `the appraiser recorded ${money(conc)} of seller concessions on this sale` });
  }
  return lines.filter((l) => l.amount != null && l.amount !== 0);
}
function bathsOf(p) {
  if (!p) return null;
  const f = num(p.baths_full), h = num(p.baths_half);
  if (f == null && h == null) {
    const t = String(p.baths_text || p.baths || '').trim();
    const m = /^(\d{1,2})(?:\.(\d))?$/.exec(t);
    return m ? +m[1] + (m[2] ? +m[2] * 0.5 : 0) : null;
  }
  return (f || 0) + (h || 0) * 0.5;
}

// ---------------------------------------------------------------------------
// 6. RANK CANDIDATE COMPS
// ---------------------------------------------------------------------------
/**
 * How good a comparable is this, for THIS subject? 0..100, with the reasons.
 * Used to order the "suggested comparables" list; the human still picks.
 *
 * The weights mirror what actually moves a value: distance and recency first
 * (a sale down the street last month beats a better-matched one across town two
 * years ago), then size, then the categorical matches.
 */
function scoreComp(subject, comp, { today = null } = {}) {
  const parts = [];
  let score = 0, possible = 0, total = 0;
  // A FACT NOBODY STATED IS NOT A BAD MATCH. The score used to count an unknown at
  // its FULL weight with ZERO earned, which is a penalty for our own missing data
  // rather than a measure of similarity: a property next door, identical in every
  // way, with no coordinates and no size on file could not exceed 45 out of 100 —
  // and since a subject property was never geocoded at all (db/412), the largest
  // single weight was contributing nothing but noise to every comparison.
  //
  // So an unknown is EXCLUDED from the denominator, and the share of the weight we
  // could actually judge comes back as `coverage`. The two numbers say different
  // things and both are needed: 90 out of 100 on two facts is a weaker statement
  // than 78 on seven, and the screen can say so instead of the score pretending
  // to a confidence it does not have.
  const add = (weight, earned, label) => {
    total += weight; possible += weight; score += earned;
    parts.push({ label, earned: round(earned, 0.1), weight });
  };
  const unknown = (weight, label) => { total += weight; parts.push({ label, earned: null, weight: 0, unknown: true }); };

  const d = num(comp.distance_miles);
  if (d != null) add(25, 25 * Math.max(0, 1 - Math.min(d, 3) / 3), `${d.toFixed(2)} miles away`);
  // Same town is a real, weaker signal — not an unknown. It is scored at a reduced
  // weight so it can never outrank a measured distance.
  else if (subject && comp.city && subject.city && String(comp.city).toLowerCase() === String(subject.city).toLowerCase()) add(15, 9, 'same town (not measured)');
  else unknown(25, 'distance unknown');

  const age = today && comp.sale_date ? monthsBetween(today, comp.sale_date) : null;
  if (age != null) add(25, 25 * Math.max(0, 1 - Math.min(age, 24) / 24), `sold about ${Math.round(age)} months ago`);
  else unknown(25, 'sale date unknown');

  const sg = num(subject && subject.gla), cg = num(comp.gla);
  if (sg && cg) {
    const off = Math.abs(cg - sg) / sg;
    add(20, 20 * Math.max(0, 1 - Math.min(off, 0.5) / 0.5), `${Math.round(cg)} sq ft vs ${Math.round(sg)}`);
  } else unknown(20, 'size unknown');

  const sb = num(subject && subject.beds), cb = num(comp.beds);
  if (sb != null && cb != null) add(10, sb === cb ? 10 : Math.max(0, 10 - Math.abs(sb - cb) * 5), `${cb} bed vs ${sb}`);
  else unknown(10, 'bedroom count unknown');

  const sc = rankOf(CONDITION_SCALE, subject && subject.condition_uad);
  const cc = rankOf(CONDITION_SCALE, comp.condition_uad);
  if (sc != null && cc != null) add(10, Math.max(0, 10 - Math.abs(sc - cc) * 4), `condition ${comp.condition_uad} vs ${subject.condition_uad}`);
  else unknown(10, 'condition unknown');

  const st = subject && (subject.property_type || subject.property_category);
  if (st && comp.property_type) add(10, String(st).toLowerCase() === String(comp.property_type).toLowerCase() ? 10 : 0, `${comp.property_type} vs ${st}`);
  else unknown(10, 'property type unknown');

  // NOTHING KNOWN AT ALL IS NOT A PERFECT MATCH. With no facts to compare, the
  // exclusion rule would divide zero by zero; a score of 0 with a coverage of 0 is
  // the honest answer, and the caller can see both.
  return {
    score: possible > 0 ? round((score / possible) * 100, 0.1) : 0,
    coverage: total > 0 ? round((possible / total) * 100, 1) : 0,
    parts,
  };
}

/**
 * The whole grid in one call: adjust every comp, reconcile, and collect warnings.
 * This is what the route and the saved-valuation reader both go through, so the
 * screen and the stored report can never disagree about the arithmetic.
 */
function buildGrid(subject, comps, opts = {}) {
  const today = opts.today || null;
  const rows = (comps || []).map((c) => {
    const adj = adjustComp(c, c.adjustments);
    const merged = Object.assign({}, c, adj);
    merged.warnings = compWarnings(subject, c, adj, { today });
    return merged;
  });
  const value = reconcile(subject, rows, opts);
  return {
    subject, comps: rows, value,
    warnings: setWarnings(subject, rows, { today }),
    thresholds: THRESHOLDS, gridLines: GRID_LINES, disclaimer: DISCLAIMER,
  };
}

module.exports = {
  buildGrid, adjustComp, reconcile, compWarnings, setWarnings,
  deriveMarketRates, suggestAdjustments, scoreComp, normalizeAdjustments,
  monthsBetween, median, GRID_LINES, GRID_KEYS, THRESHOLDS, DISCLAIMER,
  CONDITION_SCALE, QUALITY_SCALE,
  _internals: { groupDelta, timeTrend, confidenceOf, rankOf, bathsOf, money },
};
