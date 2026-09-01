'use strict';
/**
 * LONG-TERM — THE DSCR-BRACKET-AWARE PRICING BOARD (owner-directed 2026-09-01).
 *
 * PURE. No database, no network, no config — the one require that reaches outside
 * this folder is the vendor's own DSCR ceiling, taken from the module that
 * enforces it rather than restated here. Every rule is unit-testable and a board
 * can be reasoned about without a network.
 *
 * ── THE PROBLEM, IN THE OWNER'S OWN WORDS ────────────────────────────────────
 * *"Option 11.125% — Harbor has moved band. These figures come to 0.93, which is
 * a lower DSCR band than the 1.25 it was priced in — so the rate on it is one
 * this loan no longer qualifies for. Re-price at 0.93 and issue from the new
 * price."*
 *
 * That refusal is CORRECT and it is not what needs fixing. What needs fixing is
 * that the board offered the rate at all. A search is priced at ONE assumed
 * ratio, so every rate on the board is priced as though the loan achieves that
 * ratio — but the ratio a loan actually achieves depends on the RATE, because
 * the rate decides the payment and the payment is the DSCR's denominator. A
 * cheap rate leaves a strong ratio; an expensive one can leave a ratio in a band
 * the loan does not reach. So a single-ratio board mixes rates the loan
 * qualifies for with rates it does not, and nothing on screen tells them apart
 * until an officer tries to issue and is refused.
 *
 * ── THE FIX, AND WHY IT NEEDS NO NEW BUSINESS RULE ───────────────────────────
 * Price a SEPARATE scenario per DSCR bracket, and show every rate under the
 * bracket its OWN true ratio falls in. The owner: *"Every rate is going to show
 * up with the correct pricing according to what his real ratio is."*
 *
 * Nothing here invents a rule. The three it stands on all already existed:
 *   1. WHAT A BRACKET IS — `./dscr-tiers`, the owner's own eleven-tier ladder,
 *      SHARED rather than rebuilt (their explicit instruction). The board and
 *      the re-price refusal read one table, so they cannot disagree.
 *   2. WHAT A RATIO IS — `encompass/formulas.computeDscr`, the tenant's own
 *      Round(rent / PITIA, 2).
 *   3. WHAT A PAYMENT IS — `termsheet/overlay.monthlyPI`, already the server's
 *      one definition, and only used when the vendor did not quote its own.
 *
 * ── THE INVARIANT THIS EXISTS TO HOLD ────────────────────────────────────────
 * ⛔ FOR EVERY QUOTE ON THE FINISHED BOARD, THE BRACKET IT WAS PRICED IN IS THE
 * BRACKET ITS OWN RATE REACHES. That is exactly the test `snapshot.ratioProblem`
 * applies before an export, so a sheet built from this board cannot produce the
 * owner's refusal. It is asserted directly (`selfConsistent`) rather than
 * assumed, and every quote that fails it is DROPPED rather than shown — a rate
 * whose price the loan has not earned is the whole defect.
 *
 * ── AND THE CONSEQUENCE THE OWNER ASKED FOR, WHICH IS FREE ───────────────────
 * *"High rates, if it's not eligible according to the brackets, don't fit with
 * that high LTV — it's not going to populate."* A high rate is now searched at
 * the LOW ratio it actually produces, so an investor whose minimum DSCR that
 * ratio misses simply does not come back. Nobody had to write that rule down;
 * asking the vendor the true question is what enforces it.
 */

const { DSCR_TIERS, dscrTier, tierRow, tierLabel } = require('./dscr-tiers');
const { monthlyPI } = require('../termsheet/overlay');
const { computeDscr } = require('../encompass/formulas');

const nn = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
};

/** At most this many separate vendor searches for one board. */
const MAX_BRACKETS = DSCR_TIERS.length;
/** How many discovery rounds the caller may run before it stops widening. */
const MAX_ROUNDS = 4;
/**
 * THE HIGHEST RATIO LENDER PRICE WILL ACCEPT — IMPORTED, never restated.
 *
 * Their own request validation refuses `criteria.dscr` above it, so a strong deal
 * (rent 5,000 against a 2,446 payment reaches 2.04, which is ordinary) would have
 * had its BEST band refused at the door and reported as a failed search. Found by
 * reading the validator rather than by a board coming back short, which is why the
 * strongest band is exactly the one nobody would have noticed missing.
 *
 * It is taken from `search-model`, which is the module that ENFORCES it, so the
 * number that is checked and the number that is clamped to cannot drift. That one
 * require is the only thing in this file that is not self-contained, and it buys
 * the guarantee.
 */
const { VENDOR_MAX_DSCR } = require('../lenderprice/search-model');

/**
 * THE FIGURES A RATIO IS WORKED OUT FROM, normalised — or null when the deal
 * cannot produce a ratio at all.
 *
 * ⛔ NOTHING IS GUESSED, AND A MISSING PIECE IS NEVER A ZERO. Without the rent,
 * the taxes, the insurance, the loan amount or the term there is no ratio, and a
 * blank read as zero would make a property look cheaper than it is and put every
 * rate in a bracket it has not earned. HOA is the one exception and only because
 * the owner set it that way: blank means none.
 */
function readFigures(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const rentMonthly = num(f.rentMonthly);
  const taxMonthly = num(f.taxMonthly);
  const insuranceMonthly = num(f.insuranceMonthly);
  const loanAmount = num(f.loanAmount);
  const termYears = num(f.termYears);
  const hoaMonthly = num(f.hoaMonthly);
  if (rentMonthly == null || rentMonthly <= 0) return null;
  if (taxMonthly == null || taxMonthly < 0) return null;
  if (insuranceMonthly == null || insuranceMonthly < 0) return null;
  if (loanAmount == null || loanAmount <= 0) return null;
  const interestOnly = !!f.interestOnly;
  // An interest-only payment does not use the term, so a term is only required
  // when the payment amortises. Refusing one we do not need would stand the
  // whole feature down on an ordinary interest-only deal.
  if (!interestOnly && (termYears == null || termYears <= 0)) return null;
  return {
    rentMonthly, taxMonthly, insuranceMonthly, loanAmount, termYears,
    interestOnly, hoaMonthly: hoaMonthly != null && hoaMonthly > 0 ? hoaMonthly : 0,
  };
}

/**
 * THE TRUE DSCR AT ONE RATE — the ratio this loan actually achieves if it takes
 * that rate. Null when it cannot be worked out.
 *
 * ⛔ THE VENDOR'S OWN MONTHLY P&I WINS WHEN IT QUOTED ONE. The board prints that
 * figure in a column of its own, so a ratio computed from a locally-recomputed
 * payment could differ from the payment sitting beside it and the row would not
 * add up — the same reasoning `dscrCalc.housingPayment` records for taking the
 * P&I rather than computing it. We recompute only when the vendor was silent.
 *
 * ⛔ AND THIS IS WHY THE WHOLE FEATURE IS TRACTABLE: the payment depends on the
 * RATE, not on the PRICE. So the map from rate to ratio is a property of the
 * DEAL and does not move when a different bracket is searched — which is what
 * lets one bracket's board be classified with confidence, and what makes the
 * ratio strictly falling as the rate rises.
 */
function ratioAtRate(figures, ratePct, vendorMonthlyPi = null) {
  const f = figures;
  if (!f) return null;
  const rate = num(ratePct);
  if (rate == null || rate < 0) return null;
  const quoted = num(vendorMonthlyPi);
  const pi = quoted != null && quoted > 0 ? quoted
    : monthlyPI({ loanAmount: f.loanAmount, ratePct: rate, termYears: f.termYears, interestOnly: f.interestOnly });
  if (!nn(pi) || pi <= 0) return null;
  const pitia = Math.round((pi + f.taxMonthly + f.insuranceMonthly + f.hoaMonthly) * 100) / 100;
  if (!(pitia > 0)) return null;
  return computeDscr(f.rentMonthly, pitia);
}

/** The bracket one rate lands in, or null. */
function tierAtRate(figures, ratePct, vendorMonthlyPi = null) {
  return dscrTier(ratioAtRate(figures, ratePct, vendorMonthlyPi));
}

/**
 * THE RATIO TO SEARCH A BRACKET AT.
 *
 * ⛔ THE LOWEST RATIO ANY RATE IN THE BRACKET ACHIEVES, and that choice is the
 * safety property of the whole feature rather than a preference. Every rate in
 * the bracket achieves at least that ratio, so nothing is ever priced at a ratio
 * the loan does not reach — a board that over-stated the ratio would hand back
 * exactly the too-good rate the owner reported.
 *
 * With rates in hand it is measured from them. With none — a bracket reached for
 * on the strength of a neighbour — it falls back to the band's own lower edge,
 * which is the same figure by construction (the worst rate in a band is the one
 * sitting on its floor). The open-below band has no floor, so it takes a value
 * just inside its ceiling.
 *
 * ⛔ AND IT IS CHECKED TO LAND IN THE BAND IT IS FOR. A ratio that fell in a
 * neighbouring band would search the wrong scenario and re-arm the very refusal
 * this exists to prevent, so an unplaceable ratio yields null and that bracket is
 * simply not priced.
 */
function sendRatioFor(tier, figures, rates) {
  const row = tierRow(tier);
  if (!row) return null;
  let best = null;
  for (const r of (Array.isArray(rates) ? rates : [])) {
    const ratio = ratioAtRate(figures, r && r.rate != null ? r.rate : r, r && r.monthlyPi);
    if (ratio == null || dscrTier(ratio) !== tier) continue;
    if (best == null || ratio < best) best = ratio;
  }
  if (best == null) best = row.from != null ? row.from : Math.round((row.to - 0.01) * 100) / 100;
  /* ⛔ CLAMPED TO WHAT THE VENDOR ACCEPTS, AND ONLY WHERE THE CLAMP IS HONEST.
     The top band is open above, so a strong deal's own ratio can exceed the
     vendor's ceiling; clamping lands on 2.00, which is still inside that band, so
     the band is still searched at a ratio the loan genuinely reaches. Every
     bounded band's worst ratio is below its own ceiling of 1.50, so none of them
     is ever clamped. The band test below is what keeps this honest rather than
     convenient: a clamp that moved the figure into a neighbouring band would
     search the wrong scenario, so it yields null and that band is not priced. */
  const rounded = Math.min(Math.round(best * 100) / 100, VENDOR_MAX_DSCR);
  return dscrTier(rounded) === tier ? rounded : null;
}

/**
 * WHERE TO START WHEN NOBODY TYPED A RATIO (owner-directed 2026-09-01: *"we don't
 * need a target rate anymore… If you don't have a targeted rate, go by the
 * average, which is how it's usually coming up. Do it in your backend."*).
 *
 * ⛔ THE OFFICER SHOULD NOT HAVE TO SUPPLY A RATIO TO A FEATURE WHOSE WHOLE JOB IS
 * TO FIND EVERY BAND. Asking for one was the tail wagging the dog: a DSCR cannot be
 * worked out without a payment, a payment cannot be worked out without a rate, and
 * the rates are exactly what the search is for.
 *
 * ⛔ IT IS A STARTING POINT, NOT AN ANSWER, AND NOTHING IS PRICED ON IT. The seed
 * only decides which band is asked about FIRST; the frontier then walks outward
 * over whatever the boards actually return, so a seed a little off costs one extra
 * round and changes no price. That is what makes a sensible default safe here when
 * a guessed ratio would not be.
 *
 * `TYPICAL_RATE_PCT` is the middle of where this book's DSCR coupons sit. Deliberately
 * a plain, adjustable number rather than anything derived: derived from WHAT? The
 * board we have not run yet is the only honest source, and reaching for one just to
 * pick a starting point would spend the very call this exists to save.
 */
const TYPICAL_RATE_PCT = Number(process.env.LP_BRACKET_SEED_RATE_PCT || 7) || 7;

function seedRatioFrom(figures, typedDscr) {
  const typed = num(typedDscr);
  // A ratio somebody actually typed always wins — they know their deal.
  if (typed != null && typed > 0 && dscrTier(typed) != null) return typed;
  return ratioAtRate(figures, TYPICAL_RATE_PCT);
}

/**
 * WHICH BRACKETS A SET OF RATES REACHES — the brackets worth pricing, as a sorted
 * list of tier numbers. A rate whose ratio cannot be worked out contributes
 * nothing rather than a guess.
 */
function tiersFromRates(figures, rates) {
  const seen = new Set();
  for (const r of (Array.isArray(rates) ? rates : [])) {
    const t = tierAtRate(figures, r && r.rate != null ? r.rate : r, r && r.monthlyPi);
    if (t != null) seen.add(t);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * THE NEXT ROUND OF BRACKETS TO PRICE — the frontier.
 *
 * ⛔ THIS IS WHAT ANSWERS *"don't go only by the rates that are coming up"*, and
 * the naive reading of that sentence — price the brackets the first board's
 * rates land in — was BUILT AND MEASURED TO FAIL. Two ways, both real:
 *
 *   1. A HOLE IN THE MIDDLE. On a measured fixture the first board's rates fell
 *      in bands 7 and 5 and nothing landed in 6, so band 6 was never asked about
 *      — even though the ratio moves continuously with the rate, so a rate in
 *      band 6 plainly exists and simply was not on that one board.
 *   2. AN INVESTOR NO SEARCH COULD REACH. A lender who prices only at a weak
 *      ratio cannot appear on a board asked at a strong one, so its bracket is
 *      never observed, so it is never asked about, so it is never observed. The
 *      exact chicken-and-egg the owner was describing.
 *
 * So the frontier is the observed bands, plus **every band between the weakest
 * and the strongest** (the run is contiguous because the ratio falls smoothly as
 * the rate rises — a gap means nothing landed there, never that nothing can),
 * plus **`reach` bands beyond each end**. The caller walks outward while the
 * edges keep producing quotes and stops when they stop, so the search widens
 * exactly as far as the board rewards and no further.
 *
 * It converges because a band leaves the frontier the moment it is priced, and
 * there are eleven of them.
 */
function bracketFrontier(figures, rates, alreadyPriced, opts = {}) {
  const reach = Number.isInteger(opts.reach) && opts.reach >= 0 ? opts.reach : 1;
  const done = new Set(Array.isArray(alreadyPriced) ? alreadyPriced : []);
  /* THE ANCHORS ARE WHAT THE WIDENING GROWS FROM, in order of how much they are
     worth: bands real rates have been seen in, else the SEED — the band the
     officer's own scenario sits in — else whatever has already been priced. The
     seed is what lets the very first round happen at all now that there is no
     probe search to observe rates from. */
  const observed = tiersFromRates(figures, rates);
  const seed = Number.isInteger(opts.seedTier) ? [opts.seedTier] : [];
  const anchors = observed.length ? observed : (seed.length ? seed : [...done]);
  if (!anchors.length) return [];
  const lo = Math.min(...anchors) - reach;
  const hi = Math.max(...anchors) + reach;
  const out = [];
  for (const t of DSCR_TIERS) {
    if (t.tier < lo || t.tier > hi) continue;
    if (done.has(t.tier)) continue;
    out.push(t.tier);
  }
  // Nearest the observed band first, so a widening that has to stop early stops
  // having asked the most likely questions rather than the most speculative.
  const mid = (Math.min(...anchors) + Math.max(...anchors)) / 2;
  out.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
  return out.slice(0, MAX_BRACKETS);
}

/**
 * IS THIS QUOTE SOUND? — the invariant, asked of one quote.
 *
 * The bracket the search was priced in must be the bracket this rate's own ratio
 * reaches. This is `snapshot.ratioProblem`'s test, asked before a rate is ever
 * shown rather than after somebody tries to issue it.
 */
function selfConsistent(figures, quote, pricedTier) {
  const t = tierAtRate(figures, quote && quote.rate, quote && quote.monthlyPi);
  return t != null && t === pricedTier;
}

/**
 * A DSCR AS IT IS WRITTEN — two places, always, because that is what a DSCR IS
 * here (`Round(rent / PITIA, 2)`) and what every band edge carries. It is
 * produced HERE rather than on the screen for the reason the whole feature
 * rests on: the ladder, the band a quote sits in and the ratio it was searched
 * at are the server's answers, so the TEXT of those figures is too. A browser
 * that formatted them itself would be one trailing zero away from printing
 * "1.2" beside a band labelled "1.20".
 */
function ratioText(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : null;
}

/**
 * ONE OPTION'S RATE AND THE VENDOR'S OWN MONTHLY P&I, whichever parse shape it
 * came from. The summary parse calls a rung `{rate, monthly}`; the FULL parse —
 * the one the board's own details panel is built on — nests them as
 * `priceBuild.noteRate` and `monthlyPayment.monthlyPI`. Reading both here is what
 * lets the banded board be the SAME board, with the same click-through, rather
 * than a thinner second one beside it.
 */
function optionRate(o) {
  if (!o || typeof o !== 'object') return { rate: null, monthlyPi: null };
  const pb = o.priceBuild || null;
  const mp = o.monthlyPayment || null;
  return {
    rate: num(pb ? pb.noteRate : o.rate),
    monthlyPi: num(mp ? (mp.monthlyPI != null ? mp.monthlyPI : mp.total) : o.monthly != null ? o.monthly : o.monthlyPi),
  };
}

/** Every option a program carries, whichever parse shape it came from. */
function optionsOf(p) {
  if (!p || typeof p !== 'object') return [];
  if (Array.isArray(p.options)) return p.options;
  if (Array.isArray(p.rungs)) return p.rungs;
  return [];
}

/** Put a filtered option list back on a program under the key it arrived on. */
function withOptions(p, list) {
  return Array.isArray(p.options)
    ? Object.assign({}, p, { options: list, optionCount: list.length })
    : Object.assign({}, p, { rungs: list, rungCount: list.length });
}

/**
 * THE FINISHED BOARD — every bracket that actually has rates, best bracket first,
 * each carrying only the options whose own ratio belongs to it.
 *
 * `runs` is `[{ tier, sentRatio, programs }]` — one per vendor search, `programs`
 * exactly as the vendor's parse produced them. What comes back is the SAME shape,
 * filtered, so the screen renders a bracket with the code it already uses for the
 * whole board: the same rows, the same lender grouping, the same details panel.
 * That is the owner's own instruction (2026-09-01): *"Every rate and every
 * investor added, but that whole section should be divided in brackets, and it
 * should work the same."*
 *
 * ⛔ ONLY BRACKETS THAT ACTUALLY HAVE RATES (*"you're not going to have empty
 * brackets"*). A bracket that was asked about and came back with nothing this loan
 * reaches is REPORTED as empty — with the reason — rather than drawn as a row
 * nobody can use, and rather than hidden as though it was never asked.
 *
 * ⛔ STRONGEST BRACKET FIRST, which is the owner's own economics: *"lower rates
 * mean better ratios."* Not imposed here — it falls out, because the ratio falls
 * as the rate rises, so the cheapest rates are in the highest bracket by
 * arithmetic.
 */
function buildBoard(figures, runs) {
  const f = figures;
  const list = Array.isArray(runs) ? runs : [];
  const brackets = [];
  let droppedTotal = 0;
  for (const run of list) {
    const tier = run && Number.isInteger(run.tier) ? run.tier : null;
    const row = tierRow(tier);
    if (!row) continue;
    const programs = [];
    let kept = 0;
    let dropped = 0;
    let bestRate = null;
    for (const p of (Array.isArray(run.programs) ? run.programs : [])) {
      const inBand = [];
      for (const o of optionsOf(p)) {
        const { rate, monthlyPi } = optionRate(o);
        const ratio = ratioAtRate(f, rate, monthlyPi);
        if (ratio == null || dscrTier(ratio) !== tier) { dropped += 1; continue; }
        // The ratio this rate reaches rides ON the option, so every surface that
        // draws it — a row, a details panel, a term sheet built from it — states
        // the same figure without recomputing it.
        inBand.push(Object.assign({}, o, { dscr: ratio, dscrText: ratioText(ratio), dscrTier: tier }));
        kept += 1;
        if (bestRate == null || rate < bestRate) bestRate = rate;
      }
      if (inBand.length) programs.push(withOptions(p, inBand));
    }
    droppedTotal += dropped;
    brackets.push({
      tier,
      label: tierLabel(tier),
      from: row.from,
      to: row.to,
      sentRatio: num(run.sentRatio),
      sentRatioText: ratioText(num(run.sentRatio)),
      programs,
      quoteCount: kept,
      bestRate,
      // Why a bracket a search was run for is showing nothing. Silence here is
      // what a reader mistakes for "we did not look".
      emptyReason: kept ? null
        : ((Array.isArray(run.programs) && run.programs.length) ? 'no_rate_in_band' : 'no_quotes_returned'),
    });
  }
  brackets.sort((a, b) => b.tier - a.tier);   // strongest ratio first
  const withRates = brackets.filter((b) => b.quoteCount > 0);
  return {
    brackets: withRates,
    empty: brackets.filter((b) => b.quoteCount === 0),
    bracketCount: withRates.length,
    quoteCount: withRates.reduce((n, b) => n + b.quoteCount, 0),
    droppedOutOfBand: droppedTotal,
  };
}

module.exports = {
  MAX_BRACKETS, MAX_ROUNDS,
  readFigures, ratioAtRate, tierAtRate, sendRatioFor, ratioText,
  tiersFromRates, bracketFrontier, selfConsistent, buildBoard, VENDOR_MAX_DSCR,
  optionRate, optionsOf, seedRatioFrom, TYPICAL_RATE_PCT,
  DSCR_TIERS, dscrTier, tierLabel,
};
