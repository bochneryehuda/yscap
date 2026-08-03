/**
 * WHAT OUR APPRAISERS ACTUALLY CHARGE FOR A SQUARE FOOT — and why that is a
 * different claim from what a square foot is worth.
 *
 * The warehouse holds 16,685 adjustment lines against roughly 1,700 distinct
 * sales — about **9× more adjustment evidence than sale evidence**
 * (`docs/research/WHERE-THIS-IS-GOING.md`). That ratio is the whole opportunity,
 * and it only pays off if the claim being made is the right one.
 *
 * THE WRONG CLAIM: *"a bathroom is worth $12,000 in Paterson."* Indefensible on
 * this data — the sample is our own handful of reports, not the market, and
 * regressing it returns negative bathrooms.
 *
 * THE RIGHT CLAIM: *"this report used $18 a foot; the other 40 reports in this
 * county used $45–70."* Defensible precisely BECAUSE it is a statement about our
 * appraisers rather than about the market — every number in it is something we
 * were handed in writing, and the reviewer is being pointed at a document, not
 * given an estimate. It is what Fannie's own Collateral Underwriter does.
 *
 * FIVE RULES, and every one of them changes what the number means:
 *
 *  1. **A DECLINE IS NOT A RATE OF ZERO.** An appraiser who saw a 200-square-foot
 *     gap and adjusted $0 made a JUDGEMENT — that the difference did not matter
 *     here. Averaging that in as "$0 a foot" turns a considered decision into
 *     evidence about price and drags every median toward zero. Declines are
 *     counted, reported, and never mixed into the rates. Measured on the real
 *     corpus this is not a rounding matter: 621 of 767 Age lines and 326 of 767
 *     BasementArea lines are exactly this.
 *
 *  2. **THE IQR, NEVER A STANDARD DEVIATION.** A σ implies a normal distribution
 *     and a calibrated model; this is a small, skewed, human sample. The
 *     quartiles are what an appraiser would themselves quote, and a reader can
 *     act on "half of them were between $45 and $70" without believing anything
 *     about the shape.
 *
 *  3. **DISTINCT APPRAISERS AND DISTINCT REPORTS, NOT ROWS.** One report
 *     contributes three lines for the same subject and one appraiser writes many
 *     reports; counting rows makes one person's habit look like a consensus.
 *
 *  4. **NO ONE APPRAISER MAY BE MORE THAN 40% OF THE SAMPLE.** With a book this
 *     size one prolific appraiser genuinely can be most of a county, and their
 *     personal rate would then be reported back to them as what everybody does.
 *     Over the cap their lines are thinned (the median of their own rates stands
 *     in for them) rather than the whole market refused.
 *
 *  5. **IT REFUSES.** Too few rates, too few appraisers, too few reports — the
 *     ordinary answer in most markets, because we hold what our own reports
 *     described.
 *
 * Pure. No database, no network.
 */
'use strict';

const RULES = Object.freeze({
  MIN_RATES: 5,          // fewer than five is an anecdote
  MIN_REPORTS: 3,
  MIN_APPRAISERS: 2,     // one appraiser is one habit
  MAX_APPRAISER_SHARE: 0.40,
  // A rate computed from a tiny difference is arithmetic, not a market signal:
  // a $500 adjustment over a 5-foot gap is $100 a foot. db/441 already refuses
  // the smallest of these when it stores `unit_delta`; this is the second net,
  // because a consumer must not depend on how the writer happened to be tuned.
  MIN_DELTA: 25,
  // Nobody adjusts a thousand dollars a square foot. A rate past this is a
  // mis-parsed line or a mis-stated area, and one of them drags a median further
  // than ten good rows pull it back.
  MAX_RATE: 500,
});

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Quantile of a SORTED array, by linear interpolation. */
function quantile(sorted, q) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

/**
 * One adjustment line → the rate it implies, or a reason it implies none.
 * @returns {{rate:number|null, decline:boolean, why:string|null}}
 */
function rateOf(row) {
  const amount = num(row && row.amount);
  const delta = num(row && row.unit_delta);
  if (delta == null || Math.abs(delta) < RULES.MIN_DELTA) {
    return { rate: null, decline: false, why: 'no measurable difference to have adjusted for' };
  }
  if (amount == null) return { rate: null, decline: false, why: 'the line states no amount' };
  // RULE 1. A real gap and no money is a DECISION, and it is recorded as one.
  if (amount === 0) return { rate: null, decline: true, why: 'the appraiser adjusted nothing for it' };
  const rate = amount / delta;
  // A NEGATIVE RATE MEANS THE SIGNS DISAGREE — the appraiser adjusted UP for a
  // comparable that was already bigger. That is a data error or a line we have
  // misread, never a market rate, and averaging it in is how a corpus starts
  // reporting that space is worth less than nothing.
  if (rate <= 0) return { rate: null, decline: false, why: 'the adjustment runs against the difference' };
  if (rate > RULES.MAX_RATE) return { rate: null, decline: false, why: 'implausibly large for one unit' };
  return { rate, decline: false, why: null };
}

/**
 * Summarize what our appraisers charged, for one line type in one market.
 *
 * @param {Array} rows  adjustment lines, each with `amount`, `unit_delta`,
 *                      `unit_delta_basis`, `appraisal_id`, `appraiser_id`
 * @returns {{available:boolean, gate:string|null, why:string|null,
 *            median:number|null, q1:number|null, q3:number|null,
 *            n:number, reports:number, appraisers:number, declines:number,
 *            basis:string|null, capped:boolean, sentence:string|null}}
 */
function summarizeRates(rows, opts = {}) {
  const all = Array.isArray(rows) ? rows : [];
  const kept = [];
  let declines = 0;
  for (const r of all) {
    const v = rateOf(r);
    if (v.decline) { declines++; continue; }
    if (v.rate == null) continue;
    kept.push({
      rate: v.rate,
      report: r.appraisal_id == null ? null : String(r.appraisal_id),
      appraiser: r.appraiser_id == null ? null : String(r.appraiser_id),
      basis: r.unit_delta_basis || null,
    });
  }

  // RULE 4 — no one appraiser is the market. Over the cap, that appraiser is
  // reduced to ONE row carrying the median of their own rates: they still count,
  // once, as the one opinion they are.
  let capped = false;
  let sample = kept;
  const byAppraiser = new Map();
  for (const k of kept) {
    const id = k.appraiser || `row:${byAppraiser.size}`;
    if (!byAppraiser.has(id)) byAppraiser.set(id, []);
    byAppraiser.get(id).push(k);
  }
  // THE CAP IS A SHARE OF THE SAMPLE THAT RESULTS, NOT OF THE ONE WE STARTED
  // WITH. Sizing it against the original count left the prolific appraiser at 4
  // rows of a 7-row sample — 57%, well past the 40% the rule promises, and the
  // median still theirs. Against the OTHERS the arithmetic is exact: to be at
  // most 40% of everything, an appraiser may contribute at most `share/(1-share)`
  // times what everybody else did.
  //
  // …BUT NOT WHEN THERE IS ONLY ONE APPRAISER. Capping the only voice in the room
  // is meaningless — there is no majority to protect the sample from — and doing
  // it collapsed six lines to one, so the answer came back "too few rates" when
  // the true and far more useful answer is "this is one appraiser's habit".
  // A cap must never hide the gate that describes the real problem.
  const ratio = RULES.MAX_APPRAISER_SHARE / (1 - RULES.MAX_APPRAISER_SHARE);
  const allowedFor = (n) => Math.max(1, Math.floor((kept.length - n) * ratio));
  if (byAppraiser.size > 1 && [...byAppraiser.values()].some((v) => v.length > allowedFor(v.length))) {
    capped = true;
    sample = [];
    for (const [, rowsOf] of byAppraiser) {
      const allowed = allowedFor(rowsOf.length);
      if (rowsOf.length <= allowed) { sample.push(...rowsOf); continue; }
      // THINNED TO THE CAP, NOT TO ONE. Replacing a prolific appraiser with a
      // single median row starves the sample — nine lines plus three others
      // became four, which fell under the minimum and refused a perfectly good
      // market. Their rates are taken at even quantiles instead, so what
      // survives spans what they actually did rather than an arbitrary slice,
      // and their INFLUENCE is limited without their evidence being discarded.
      const own = rowsOf.map((x) => x.rate).sort((a, b) => a - b);
      for (let i = 0; i < allowed; i++) {
        const q = allowed === 1 ? 0.5 : i / (allowed - 1);
        sample.push(Object.assign({}, rowsOf[0], { rate: quantile(own, q) }));
      }
    }
  }

  const rates = sample.map((s) => s.rate).sort((a, b) => a - b);
  const reports = new Set(sample.map((s) => s.report).filter(Boolean)).size;
  const appraisers = new Set(sample.map((s) => s.appraiser).filter(Boolean)).size;
  const basis = (sample.find((s) => s.basis) || {}).basis || null;
  const base = { n: rates.length, reports, appraisers, declines, basis, capped,
    median: null, q1: null, q3: null, sentence: null };
  const no = (gate, why) => Object.assign({ available: false, gate, why }, base);

  if (rates.length < RULES.MIN_RATES) {
    return no('too_few_rates', declines > 0
      ? `only ${rates.length} of our reports put a number on this, and ${declines} looked at the same `
        + 'difference and adjusted nothing — too little either way to say what is usual'
      : `only ${rates.length} of our own reports adjusted for this at all`);
  }
  if (reports < RULES.MIN_REPORTS) {
    return no('too_few_reports', `these ${rates.length} lines come from ${reports} report`
      + `${reports === 1 ? '' : 's'} — that is not a pattern, it is a report`);
  }
  if (appraisers < RULES.MIN_APPRAISERS) {
    return no('one_appraiser', `every one of these came from the same appraiser — it is their habit, `
      + 'not what our appraisers do');
  }

  const median = quantile(rates, 0.5);
  const q1 = quantile(rates, 0.25);
  const q3 = quantile(rates, 0.75);
  const unit = basis === 'sqft_gba' ? 'a square foot of building' : (basis === 'sqft' ? 'a square foot' : 'a unit');
  return Object.assign({}, base, {
    available: true, gate: null, why: null,
    median: round2(median), q1: round2(q1), q3: round2(q3),
    // ALWAYS THE FULL SENTENCE. Every count that qualifies the number travels
    // with it — a median with no n, no report count and no decline count is the
    // indefensible version of this claim.
    sentence: `${reports} of our reports (${appraisers} appraisers) adjusted for this, at a median of `
      + `$${round2(median)} ${unit}; half of them were between $${round2(q1)} and $${round2(q3)}`
      + (declines ? `. ${declines} more saw the same difference and adjusted nothing` : '')
      + (capped ? '. One appraiser wrote more than their share, so they count once here' : ''),
  });
}

/**
 * WHERE THIS REPORT SITS AMONG THE OTHERS — the actual deliverable.
 *
 * Never "the correct rate is X". The comparison is to our own other reports, and
 * the verdict is always a place to look.
 */
function compareRate(thisRate, summary) {
  const r = num(thisRate);
  if (!summary || !summary.available || r == null || r <= 0) return null;
  const inside = r >= summary.q1 && r <= summary.q3;
  const unit = summary.basis === 'sqft_gba' ? 'a square foot of building'
    : (summary.basis === 'sqft' ? 'a square foot' : 'a unit');
  return {
    rate: round2(r),
    inside,
    // Not "high" or "low" as a verdict — WHERE it sits, which is a fact.
    where: inside ? 'in the usual range' : (r > summary.q3 ? 'above the usual range' : 'below the usual range'),
    sentence: `This report used $${round2(r)} ${unit}. ${summary.sentence}.`,
  };
}

module.exports = { summarizeRates, compareRate, rateOf, RULES, _internals: { quantile } };
