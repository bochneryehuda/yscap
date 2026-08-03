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
  // AN ASKING PRICE IS NOT A SALE. `reconcile` already halves a listing's weight,
  // but a half-weighted listing in a small set still carries a lot — a recent,
  // well-matched one was measured at 36% of the total — and it counts in FULL
  // toward the median, the range and the price per foot, which are plain
  // unweighted statistics over the same rows. The value is still produced (rule 2
  // of this engine: never hide a weak answer, show it wearing its caveats); the
  // reader is simply told how much of it is what somebody is asking.
  const open = usable.filter((c) => c.sale_status && c.sale_status !== 'closed');
  if (open.length && usable.length) {
    const share = Math.round((open.length / usable.length) * 100);
    if (share >= 25) {
      w.push({ code: 'listings_in_the_answer', severity: 'warning',
        text: `${open.length} of the ${usable.length} comparables ${open.length === 1 ? 'is' : 'are'} still `
          + `for sale or under contract — about ${share}% of this answer rests on what somebody is ASKING, `
          + 'not on what anybody paid. Asking prices lead the market on the way up and lag it on the way down.' });
    }
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
  // HOW MUCH OF THIS ANSWER IS AN ASKING PRICE. A listing is halved above, but a
  // half-weighted listing in a small set still carries a lot: with three comps a
  // recent, well-matched listing was measured carrying 36% of the total — and it
  // counts in FULL toward the median, the range and the price per foot, which are
  // plain unweighted statistics over the same rows. A number resting a third on
  // what somebody is ASKING is a different claim from one resting on what people
  // PAID, and the reader has to be told which they are looking at.
  const openWeight = usable.reduce((acc, c, i) =>
    acc + ((c.sale_status && c.sale_status !== 'closed') ? weights[i] : 0), 0);
  const listingWeightPct = wsum > 0 ? round((openWeight / wsum) * 100, 0.1) : 0;
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
    // What share of the weighted answer is an ASKING price rather than a sale.
    listingWeightPct,

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
  // A FORCED SALE IS NOT A MARKET PRICE. A bank selling REO, a short sale, an
  // estate or a relocation is transacting under a constraint an ordinary buyer
  // and seller do not have, and the price says so — measured, 8 REO alongside 8
  // arm's-length dragged the median down to $217/sqft. They were neither filtered
  // out NOR selectable, so every derived rate quietly averaged two different
  // markets. They are set aside here and the count is REPORTED, never dropped in
  // silence: on a corpus where distressed sales are most of what we hold, "we set
  // 14 aside" is the most important line on the panel.
  const closedRows = (obs || []).filter((o) => num(o.sale_price) != null && (o.sale_status || 'closed') === 'closed');
  const rows = closedRows.filter((o) => !isDistressed(o.sale_type));
  const setAside = closedRows.length - rows.length;
  const withGla = rows.filter((o) => num(o.gla) > 200);
  const out = { sampleSize: rows.length, minSample,
    distressedSetAside: setAside,
    distressedNote: setAside
      ? `${setAside} forced sale${setAside === 1 ? '' : 's'} (bank-owned, short sale, estate or `
        + 'relocation) were left out of these rates — a sale under that kind of pressure is not '
        + 'what an ordinary buyer would pay'
      : null };

  const ppsf = withGla.map((o) => num(o.sale_price) / num(o.gla));
  out.pricePerSqft = withGla.length >= minSample
    ? { value: round(median(ppsf), 1), n: withGla.length, basis: `median of sale price ÷ living area across ${withGla.length} closed sales` }
    : { value: null, n: withGla.length, why: `only ${withGla.length} closed sales with a living area — need ${minSample} before a rate means anything` };

  // The GLA ADJUSTMENT RATE is NOT the full price per foot. An extra square foot
  // of the same house is worth a fraction of the average foot (the land, the
  // kitchen and the systems are already paid for); the trade convention is a
  // quarter to a half. We publish the range and use the midpoint, and we SAY so.
  //
  // AND A MEASURED PEER RATE BEATS THE CONVENTION. `opts.peerGlaRate` is what
  // appraisers in THIS market actually wrote on their grids — each size
  // adjustment divided by the size difference it was made for (db/441, from the
  // adjustment corpus). The 40% figure above is a rule of thumb about a national
  // trade habit; this is evidence from the reports we paid for. Measured over the
  // 152 real reports: 468 usable rates, ZERO negative, median $40/sq ft.
  //
  // It is PASSED IN rather than queried here, because this function is pure and
  // its purity is what makes every rate in it testable without a database.
  //
  // The convention remains the fallback, and the two are never blended: they are
  // different KINDS of claim — one is what local appraisers did, the other is a
  // national habit — and averaging them would produce a number that is neither,
  // with a `basis` that could not honestly describe it. Whichever is used says so.
  //
  // AND THE RATE IS PER BASIS, because a foot of living area and a foot of gross
  // BUILDING area are not the same foot (db/443). Splitting them was correct and
  // it STRANDED evidence: measured across our own markets, 8 of the 18 that
  // cleared the sample floor hold their adjustments almost entirely on 1025
  // grids — Scranton 19, Elizabeth 11, Pittston 10, Roselle 8, all building area
  // — so asking only for living area drops those markets back to the national
  // rule of thumb while we hold twenty real local adjustments in each. They are
  // also exactly the 2-4 unit towns. So BOTH are carried, and the suggester picks
  // the one that matches the comparable in front of it; they are never blended.
  const peer = opts.peerGlaRate;
  const peerUsable = peer && peer.ok && num(peer.median) > 0 && num(peer.n) >= minSample;
  const peerGba = opts.peerGlaRateGba;
  const gbaUsable = peerGba && peerGba.ok && num(peerGba.median) > 0 && num(peerGba.n) >= minSample;
  out.glaAdjustmentPerSqftGba = gbaUsable
    ? { value: round(num(peerGba.median), 1),
        low: peerGba.q1 == null ? null : round(num(peerGba.q1), 1),
        high: peerGba.q3 == null ? null : round(num(peerGba.q3), 1),
        n: peerGba.n, source: 'peer', basis_of: 'gba',
        // WHERE IT CAME FROM, IN THE SENTENCE ITSELF. The rate may have been
        // measured one rung out from the subject's own town, and "$28 a foot in
        // Newark" and "$28 a foot across New Jersey" are different claims — only
        // one of them true. `where` is the scope the corpus actually answered at.
        scope: peerGba.scope || null, relaxed: !!peerGba.relaxed,
        basis: `what appraisers ${peerGba.where || 'in this market'} actually adjusted on 2-4 unit grids, across ${peerGba.n} size adjustments measured on gross building area` }
    : null;
  out.glaAdjustmentPerSqft = peerUsable
    ? { value: round(num(peer.median), 1),
        low: peer.q1 == null ? null : round(num(peer.q1), 1),
        high: peer.q3 == null ? null : round(num(peer.q3), 1),
        n: peer.n, source: 'peer',
        scope: peer.scope || null, relaxed: !!peer.relaxed,
        basis: `what appraisers ${peer.where || 'in this market'} actually adjusted, across ${peer.n} size adjustments on reports we paid for` }
    : out.pricePerSqft.value == null ? { value: null, source: 'none', why: out.pricePerSqft.why }
      : { value: round(out.pricePerSqft.value * 0.4, 1),
        low: round(out.pricePerSqft.value * 0.25, 1), high: round(out.pricePerSqft.value * 0.5, 1),
        n: withGla.length, source: 'convention',
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
    groups.get(k).push({ ppsf: num(o.sale_price) / num(o.gla), gla: num(o.gla), price: num(o.sale_price) });
  }
  const ppsfOf = (k) => median(groups.get(k).map((r) => r.ppsf));
  const glaOf = (k) => median(groups.get(k).map((r) => r.gla));
  const keys = [...groups.keys()].sort((a, b) => a - b).filter((k) => groups.get(k).length >= 3);
  const n = keys.reduce((acc, k) => acc + groups.get(k).length, 0);
  if (keys.length < 2 || n < minSample) {
    return { value: null, n, why: `not enough sales spread across different ${label} counts to read a difference (${n} usable, need ${minSample} across at least two groups)` };
  }
  // SIZE IS THE CONFOUND, AND IT IS NOT SUBTLE. Price per foot runs INVERSELY to
  // size (the land, the kitchen and the systems are already paid for), and more
  // bedrooms and bathrooms come with more house — so the price-per-foot gap
  // between a 2-bath group and a 3-bath group is mostly measuring the SIZE
  // difference, not the bathroom. Multiplied back by the subject's living area it
  // produced a measured **$86,940 for one bathroom**, while the identical
  // confound pointing the other way was correctly refused as "the wrong sign" and
  // the message blamed the sample — when 73 sales is not a small sample, it is a
  // sample answering a different question.
  //
  // A step is only readable when the two groups are genuinely comparable in size.
  // Anything wider is skipped, and if that leaves nothing the refusal NAMES the
  // confound rather than the sample size, because "get more sales" is the wrong
  // advice for a problem more sales will not fix.
  const MAX_GLA_SPREAD = 0.15;
  const deltas = []; let confounded = 0;
  for (let i = 1; i < keys.length; i++) {
    const step = keys[i] - keys[i - 1];
    if (!step) continue;
    const gA = glaOf(keys[i - 1]), gB = glaOf(keys[i]);
    if (gA > 0 && gB > 0 && Math.abs(gB - gA) / Math.min(gA, gB) > MAX_GLA_SPREAD) { confounded++; continue; }
    deltas.push((ppsfOf(keys[i]) - ppsfOf(keys[i - 1])) / step);
  }
  // A DISCARDED STEP IS EVIDENCE OF A CONFOUND, NOT A ROW TO IGNORE. Skipping it
  // and medianing whatever survived turned a CORRECT refusal into a confident
  // wrong answer: on the live NJ segment the 2.5→3 bath step (1,480 vs 3,152 sqft)
  // was the strongly negative delta that used to trigger the "wrong sign"
  // refusal, and dropping it left one surviving step publishing $23.54/sqft —
  // **$35,250 for one bathroom**. The guard built to stop "$86,940 for one
  // bathroom" produced $35,250 on the first real market it saw.
  //
  // So a set where ANY step is confounded is a confounded set. It is the same
  // sample either way; removing the inconvenient half does not make the rest
  // trustworthy, it just hides why it looked wrong.
  if (confounded) {
    return { value: null, n, confoundedSteps: confounded, readableSteps: deltas.length,
      why: `the sales with more ${label}s in this market are also materially BIGGER houses, so the `
        + `difference in price per foot between them is measuring the size, not the ${label} — `
        + `this is not something more sales would fix, and a rate read off it would be wrong by a `
        + 'multiple, not by a little' };
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
  // A PLAUSIBILITY CEILING, because a confound can survive every check above and
  // still produce a number nobody would type. Expressed against the market's own
  // median sale price rather than as a fixed dollar figure, so it means the same
  // thing in Paterson and in Tenafly: one bedroom, one bathroom or one condition
  // grade is not worth a quarter of the whole house. Past that the reading is
  // telling us about something other than the thing it is named for.
  const medPrice = median(rows.map((o) => num(o.sale_price)).filter((v) => v != null));
  const medGla = median(rows.map((o) => num(o.gla)).filter((v) => v > 0));
  const dollarsAtMedian = medGla ? signed * medGla : null;
  if (medPrice && dollarsAtMedian != null && dollarsAtMedian > medPrice * 0.25) {
    return { value: null, n,
      why: `this set reads as ${money(round(dollarsAtMedian, 250))} for one ${label} on a typical house `
        + `here (${money(round(medPrice, 1000))}) — a quarter of the whole property for one ${label} is `
        + 'not a rate, it is a sign the groups differ in some other way we cannot see, so nothing is '
        + 'filled in' };
  }
  return {
    valuePerSqft: round(signed, 0.01), n,
    // What that rate comes to in DOLLARS on a typical house here — the figure a
    // human is actually being asked to sanity-check, which a per-foot rate hides.
    approxDollarsOnTypicalHouse: dollarsAtMedian == null ? null : round(dollarsAtMedian, 250),
    confoundedSteps: confounded || undefined,
    groups: keys.map((k) => ({ key: k, n: groups.get(k).length,
      medianPricePerSqft: round(ppsfOf(k), 1), medianGla: round(glaOf(k), 1) })),
    basis: `difference in median price per foot between ${label} groups (${n} sales, matched for size) `
      + '— multiply by the subject\'s living area to get dollars',
  };
}

/**
 * THE TWO HALVES HAVE TO BE FAR ENOUGH APART TO BE A TREND.
 *
 * A percentage gap divided by the months between the halves is a RATE, and this
 * used to gate only on how MANY dated sales there were — never on how far apart
 * they sat. Sixteen sales all closed inside one month still passed, and a 4% gap
 * over ONE month became 3.95% A MONTH. The same sixteen readings spread over a
 * year read 0.33%/month: a 12-fold swing driven entirely by the spacing.
 *
 * `suggestAdjustments` then multiplied that by the months since a comp sold with
 * no ceiling, so a $400,000 comp sold a year ago was pre-filled at **+$190,750**
 * — a 47.7% net adjustment offered to a human as a suggestion.
 *
 * Three guards, and each refuses OUT LOUD rather than returning a quiet number:
 *   * the half-midpoints must be at least MIN_TREND_MONTHS apart;
 *   * the resulting rate must be inside MAX_MONTHLY_PCT. A crude median-of-halves
 *     on a few dozen sales that says the market is moving faster than ~1.5% a
 *     month is telling us the two halves differ for some reason OTHER than time
 *     (different streets, different sizes, a couple of distressed sales) — the
 *     honest reading of an implausible rate is "this method cannot see it";
 *   * the total dollars are capped per comp where it is applied, below.
 */
/**
 * IS THIS SALE'S PRICE A MARKET PRICE?
 *
 * Read off the appraiser's OWN stated sale type — never guessed from the price
 * being low, which would be circular. Anything we cannot read is treated as an
 * ORDINARY sale, deliberately: excluding on a hunch would quietly shrink the
 * sample, and this warehouse's rule is that an unread fact is not a "yes".
 */
// NO WORD BOUNDARIES — the vocabulary this system actually stores is CamelCase
// with no spaces. `extract.js` whitelists exactly `ArmsLengthSale`, `REOSale`,
// `EstateSale`, `ShortSale`, `Listing`, `CourtOrderedSale` and `ingest.js` stores
// them verbatim, so `\breo\b` could not match `REOSale` (O→S is not a boundary)
// and the filter was a no-op on every real row. `compWarnings` 390 lines above
// has always used the boundary-free form and got this right — the two are now in
// step, which is the point: one file must not label a comp "bank-owned, sells
// below market" on screen while the other folds it into the rate.
const DISTRESSED_RE = /(reo|bank[\s-]*owned|foreclos|short[\s-]*sale|estate|relocation|auction|trustee|sheriff|court[\s-]*ordered|distress)/i;
function isDistressed(saleType) {
  const s = saleType == null ? '' : String(saleType).trim();
  return s !== '' && DISTRESSED_RE.test(s);
}

const MIN_TREND_MONTHS = 6;
const MAX_MONTHLY_PCT = 1.5;
// …and a ceiling on the DOLLARS a time adjustment may carry on one comp, since a
// legal rate compounded over a long-ago sale gets there anyway. 15% mirrors the
// net-adjustment figure this desk already flags for review.
const MAX_TIME_ADJ_PCT = 15;
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
  if (months < MIN_TREND_MONTHS) {
    // NAME THE SPAN THE USER CAN SEE. `months` is between the two half-MIDPOINTS,
    // roughly half the set's actual span — so a user who supplied nine months of
    // sales was told they supplied five, a number matching nothing on their
    // screen.
    const span = monthsBetween(String(dated[dated.length - 1].sale_date).slice(0, 10),
      String(dated[0].sale_date).slice(0, 10));
    return { value: null, n: dated.length, monthsApart: round(months, 0.1), spanMonths: round(span, 0.1),
      why: `these ${dated.length} sales cover about ${round(span, 0.1)} month${span < 1.5 ? '' : 's'} — `
        + 'dividing a price gap by that little time turns ordinary scatter into a huge monthly rate, '
        + 'so we need about a year of sales before calling anything a trend' };
  }
  const pct = ((mn - mo) / mo) * 100 / months;
  if (!(Math.abs(pct) <= MAX_MONTHLY_PCT)) {
    return { value: null, n: dated.length, monthsApart: round(months, 0.1),
      why: `this set reads as ${round(pct, 0.01)}% a month, which is faster than a market moves — `
        + `the two halves almost certainly differ for some reason other than time (different streets, `
        + `different sizes, a distressed sale or two), so there is nothing here we can honestly call a trend` };
  }
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
  // THE RATE HAS TO MATCH THE FOOT BEING MEASURED. The delta here is the subject's
  // LIVING area minus whatever this comparable stated — and on a 1025 (2-4 unit)
  // grid that is gross BUILDING area, which db/427 records on the comp itself.
  // The peer rates are measured the same way round (db/443), so a building-area
  // comp is adjusted at the building-area rate. Without this the 2-4 unit markets
  // fall back to the national rule of thumb while we hold twenty real local
  // adjustments in each. A comp that does not say which foot it used is treated as
  // living area, which is what it is on a 1004 and on every row written before
  // db/427.
  const basisOf = (x) => String((x && x.gla_basis) || '').trim().toLowerCase();
  const compGba = basisOf(comp) === 'gba';
  // THE SUBJECT'S FOOT MATTERS TOO. Every peer rate is measured as the SUBJECT's
  // living area minus the comparable's, so a subject stated in gross building
  // area matches neither rate. Rare — of the properties we have lent on, exactly
  // one of 132 is in that state — but silently applying a rate to a delta it was
  // not measured from is the thing this whole split exists to stop.
  const subjectGba = basisOf(subject) === 'gba';
  // A USABLE VALUE, not object truthiness. Testing the object meant a
  // hand-built `{value:null}` would be "matched" and the comparable would lose
  // its size line altogether rather than falling back — the one asymmetry in the
  // pick, and the fallback is the whole reason the other branch exists.
  //
  // AND ZERO IS NOT A USABLE VALUE HERE, which is the same hole left half-shut:
  // `!= null` is true for 0, and a rate of 0 is then falsy at the size-line guard
  // below, so the comparable loses its size line entirely rather than falling
  // back to the living-area rate. `deriveMarketRates` cannot emit one (it guards
  // `median > 0`), but `market_rates` is STORED as jsonb and read back, so the
  // predicate has to match the contract rather than rely on the producer. This
  // is deliberately NOT the general rule that a zero rate is a refusal — a
  // derived rate of exactly 0 stays meaningful elsewhere; it is this pick, where
  // 0 can only come from a value the engine would never have written.
  const gbaRate = rates && rates.glaAdjustmentPerSqftGba;
  const matched = !subjectGba && compGba && gbaRate && num(gbaRate.value) > 0;
  const rate = matched ? rates.glaAdjustmentPerSqftGba : (rates && rates.glaAdjustmentPerSqft) || null;
  const sqftRate = rate ? num(rate.value) : null;
  const sg = num(subject && subject.gla), cg = num(comp && comp.gla);
  if (sqftRate && sg && cg && Math.abs(sg - cg) >= 25) {
    // THE MISMATCH IS STATED, NOT SWALLOWED. A 2-4 unit comparable in a market
    // where we hold no building-area adjustments falls back to the living-area
    // rate — which is what happened to every such comp before the two were told
    // apart, so it is not a regression — but the two rates differ materially
    // ($45 against $28 on our own corpus), and a suggestion carrying somebody
    // else's foot has to say so or it gets believed.
    const mismatch = subjectGba || (compGba && !matched);
    lines.push({ key: 'gla', amount: round((sg - cg) * sqftRate, 50), source: 'suggested',
      note: `${Math.round(sg - cg)} sq ft ${sg > cg ? 'more' : 'less'} than this sale, at about $${sqftRate}/sq ft (${rate.basis})`
        + (mismatch
          ? (subjectGba
            ? ' — NOTE the property being valued states gross BUILDING area while every rate here is '
              + 'measured from a LIVING area subject, so the two feet do not match; check it before accepting'
            : ' — NOTE this sale states gross BUILDING area and the rate is measured on LIVING area, '
              + 'because this market has too few 2-4 unit adjustments to read one; check it before accepting')
          : '') });
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
    // A CEILING ON THE DOLLARS, on top of the ceiling on the RATE. A rate inside
    // MAX_MONTHLY_PCT is still compounded by however long ago the comp sold, so a
    // three-year-old sale would carry a 54% adjustment on a perfectly ordinary
    // 1.5%/month reading. Past MAX_TIME_ADJ_PCT of the sale price the suggestion
    // stops being a nudge and becomes the value, and a human should be typing it:
    // the line is capped and SAYS it was capped, rather than quietly shrinking.
    const raw = num(comp.sale_price) * (trend / 100) * months;
    const cap = num(comp.sale_price) * (MAX_TIME_ADJ_PCT / 100);
    const capped = Math.abs(raw) > cap;
    const amount = capped ? Math.sign(raw) * cap : raw;
    lines.push({ key: 'market_conditions', amount: round(amount, 250), source: 'suggested',
      note: `sold about ${Math.round(months)} months ago; our own sales moved about ${trend}% a month `
        + `(${rates.monthlyMarketChangePct.basis})`
        + (capped ? ` — held at ${MAX_TIME_ADJ_PCT}% of the sale price, because ${Math.round(months)} months `
          + 'at that rate comes to more than a time adjustment should ever carry on its own; '
          + 'read the sale yourself before accepting it' : '') });
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
