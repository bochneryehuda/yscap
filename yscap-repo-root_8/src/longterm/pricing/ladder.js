'use strict';
/**
 * LONG-TERM — a program's LADDER, and the two figures a movement report is
 * built from (owner-directed 2026-08-30; the research is
 * `docs/longterm/PRICING-RATE-MOVEMENT-REPORTS.md`).
 *
 * PURE. No database, no vendor, no config, no requires — so every rule here is
 * unit-testable, and a report can be reasoned about without a network.
 *
 * ⛔ MILLI-INTEGERS, NEVER FLOATS, on anything stored or compared. The engine's
 * own convention (`ppe/README.md`: *"Never introduce a float price/rate on a
 * stored or compared value"*), and it is not fussiness: a half-cent of float
 * drift accumulated across a 365-day series is a movement report that reports
 * movement which did not happen. A rate of 7.125% is `7125`; a price of 99.875
 * is `99875`.
 *
 * ⛔ AND THE SIGN CONVENTION IS THE ONE TRAP IN THE WHOLE FEATURE. This codebase
 * prices as `points = 100 − price`, so a program getting MORE EXPENSIVE means
 * its PRICE WENT DOWN. The owner's own phrasing — *"it went up by half a point"*
 * — means the COST went up, i.e. price −0.500. So every figure here is a signed
 * price delta the engine's way, and **nothing here renders anything**: the
 * wording ("0.500 more expensive" / "0.250 cheaper") belongs to whatever draws
 * the email, and a raw signed price must never reach a reader.
 */

/**
 * 7.125 → 7125. Anything unreadable is null, never 0 — a missing rate and a zero
 * rate are different facts and only one of them is a rung.
 *
 * ⛔ THE TYPE IS TESTED BEFORE THE VALUE, and that is the whole of this
 * function. `Number(null)`, `Number('')` and `Number(false)` are all **0**, and
 * 0 is finite — so the obvious `Number.isFinite(Number(v))` accepts every one of
 * them and turns a rung the vendor could not price into a rung at 0.000% priced
 * 0.000. Measured before this shipped: a programme whose every rung came back
 * null became a one-rung ladder that would have been STORED as a real programme
 * instead of counted unusable, and a 0/0 rung beside real ones straddles par and
 * interpolates a par rate out of nothing. A zero price is the best price on any
 * board, so the cost of this is not a missing row — it is a wrong headline.
 */
function milli(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1000) : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.round(n * 1000) : null;
  }
  return null;   // null, undefined, false, an array, an object — none is a price
}

/** 7125 → 7.125, for a caller that has to show one. */
function fromMilli(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n / 1000 : null;
}

/**
 * ONE PROGRAM'S LADDER, from `lp.parse()`'s own `rungs`.
 *
 * ⛔ ONE ROW PER RATE, AT ITS BEST PRICE. A vendor board can carry the same rate
 * twice under one program (two lock periods, two products), and keeping both
 * would make "the price at 7.125%" ambiguous — and a comparison between two
 * ambiguous figures is not a comparison. Best = HIGHEST price, because
 * `points = 100 − price`: the highest price is the cheapest rung, which is the
 * one an officer would actually quote.
 *
 * A rung with no readable rate or no readable price is DROPPED, not defaulted:
 * a rung priced at zero would be the best price on any board and would sit at
 * the top of every report.
 */
function ladderOf(rungs) {
  const best = new Map();
  for (const r of (Array.isArray(rungs) ? rungs : [])) {
    const rate = milli(r && r.rate);
    const price = milli(r && r.price);
    if (rate == null || price == null) continue;
    const prev = best.get(rate);
    if (prev == null || price > prev) best.set(rate, price);
  }
  return [...best.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rateMilli, bestPriceMilli]) => ({ rateMilli, bestPriceMilli }));
}

/**
 * THE PAR RATE — the rate at which this program prices at exactly 100.000,
 * interpolated between the two rungs that straddle par.
 *
 * ⛔ IT IS NEVER EXTRAPOLATED. A ladder entirely above or entirely below par
 * has no par rate, and inventing one by running the line off the end of the
 * data is how a report states a rate the vendor never quoted. Null is the
 * honest answer and every consumer must treat it as one.
 *
 * A ladder is sorted by rate ascending and price FALLS as the rate falls in
 * this convention — but nothing here assumes the direction: it walks adjacent
 * pairs and takes the first that straddles par, which is right whichever way
 * the ladder runs.
 */
function parRateMilli(ladder) {
  const L = Array.isArray(ladder) ? ladder : [];
  for (const p of L) if (p.bestPriceMilli === 100000) return p.rateMilli;
  for (let i = 0; i + 1 < L.length; i += 1) {
    const a = L[i]; const b = L[i + 1];
    const lo = Math.min(a.bestPriceMilli, b.bestPriceMilli);
    const hi = Math.max(a.bestPriceMilli, b.bestPriceMilli);
    if (lo > 100000 || hi < 100000) continue;
    const span = b.bestPriceMilli - a.bestPriceMilli;
    if (span === 0) continue;                       // a flat pair cannot locate par
    const t = (100000 - a.bestPriceMilli) / span;
    return Math.round(a.rateMilli + t * (b.rateMilli - a.rateMilli));
  }
  return null;
}

/**
 * THE ANCHOR RATE — the rung whose price sits closest to par YESTERDAY.
 *
 * ⛔ CHOSEN FROM THE EARLIER DAY AND HELD. If it were re-chosen each day it
 * would drift with the very thing it is measuring, and a program could show no
 * movement while every rung on it re-priced. Par-adjacent because that is where
 * a real quote sits.
 *
 * Ties break to the LOWER rate, so the choice is deterministic — two runs over
 * one board must not disagree about what was measured.
 */
function anchorRateMilli(ladder) {
  let best = null;
  for (const p of (Array.isArray(ladder) ? ladder : [])) {
    const d = Math.abs(p.bestPriceMilli - 100000);
    if (best === null || d < best.d || (d === best.d && p.rateMilli < best.rateMilli)) {
      best = { d, rateMilli: p.rateMilli };
    }
  }
  return best ? best.rateMilli : null;
}

/** The price at one exact rate, or null when that rung is not on this ladder.
 *  Deliberately NOT interpolated: the anchor exists to compare like with like,
 *  and a made-up price at a rate nobody quoted is not that. */
function priceAt(ladder, rateMilli) {
  for (const p of (Array.isArray(ladder) ? ladder : [])) {
    if (p.rateMilli === rateMilli) return p.bestPriceMilli;
  }
  return null;
}

/**
 * WHAT MOVED between two days of one program — the two metrics, because one is
 * not enough (research §2):
 *
 *   • `anchorDelta` — Δ price at ONE fixed rate. *"What does this do to the deal
 *     I quoted yesterday?"*
 *   • `sheetDelta` — the mean Δ price across every rung present on BOTH days.
 *     *"Did the whole sheet move, or just one corner of it?"*
 *
 * They answer different questions and they routinely disagree; the shape where
 * one part of a ladder re-prices is exactly what an officer wants told, and it
 * is invisible in an average. So both travel, `disagree` says when they differ
 * by more than the caller's threshold, and the caller decides the wording.
 *
 * ⛔ EVERYTHING IS NULL RATHER THAN ZERO WHEN IT CANNOT BE MEASURED. A program
 * that is new today, one whose anchor rung has gone, and one that genuinely did
 * not move are three different facts, and a zero would tell a reader the third
 * about all three.
 */
function compareLadders(before, after, opts = {}) {
  const b = Array.isArray(before) ? before : [];
  const a = Array.isArray(after) ? after : [];
  const out = {
    anchorRateMilli: null,
    anchorBeforeMilli: null,
    anchorAfterMilli: null,
    anchorDeltaMilli: null,
    sheetDeltaMilli: null,
    rungsCompared: 0,
    parBeforeMilli: parRateMilli(b),
    parAfterMilli: parRateMilli(a),
    parDeltaMilli: null,
    disagree: false,
  };
  if (!b.length || !a.length) return out;

  const anchor = Number.isFinite(Number(opts.anchorRateMilli))
    ? Number(opts.anchorRateMilli) : anchorRateMilli(b);
  out.anchorRateMilli = anchor;
  if (anchor != null) {
    out.anchorBeforeMilli = priceAt(b, anchor);
    out.anchorAfterMilli = priceAt(a, anchor);
    if (out.anchorBeforeMilli != null && out.anchorAfterMilli != null) {
      out.anchorDeltaMilli = out.anchorAfterMilli - out.anchorBeforeMilli;
    }
  }

  const byRate = new Map(a.map((p) => [p.rateMilli, p.bestPriceMilli]));
  let sum = 0; let n = 0;
  for (const p of b) {
    const now = byRate.get(p.rateMilli);
    if (now == null) continue;                 // a rung on only one day is not a movement
    sum += now - p.bestPriceMilli; n += 1;
  }
  out.rungsCompared = n;
  if (n) out.sheetDeltaMilli = Math.round(sum / n);

  if (out.parBeforeMilli != null && out.parAfterMilli != null) {
    out.parDeltaMilli = out.parAfterMilli - out.parBeforeMilli;
  }

  const threshold = Number.isFinite(Number(opts.disagreeThresholdMilli))
    ? Number(opts.disagreeThresholdMilli) : 125;   // an eighth of a point
  if (out.anchorDeltaMilli != null && out.sheetDeltaMilli != null) {
    out.disagree = Math.abs(out.anchorDeltaMilli - out.sheetDeltaMilli) > threshold;
  }
  return out;
}

module.exports = {
  milli, fromMilli, ladderOf, parRateMilli, anchorRateMilli, priceAt, compareLadders,
};
