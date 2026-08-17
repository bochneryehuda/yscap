'use strict';
/**
 * LT PPE — a stored rate sheet as a flat map of ADDRESSABLE CELLS.
 *
 * `ratesheet-diff.js` diffs two rulesets as a KEYED set-difference — `{ ruleKey → value }` in, a
 * localized per-cell delta out — which is what turns "version 2 is different" into "the 7.125 / 30-day
 * price moved 0.150 and the cash-out LLPA is new". It has never had anything to hand it: nothing
 * turned a STORED sheet (`store.loadRateSheet`'s rows) into that map. This is that one definition, so
 * a diff, a future ingest comparison and any drift check all address a cell the same way.
 *
 * THE KEY IS THE WHOLE DESIGN, and two rules make it usable:
 *
 *   1. A KEY DESCRIBES THE CELL, NOT ITS ROW. A row's `id` changes every time a grid is replaced —
 *      `replaceBasePrices` deletes and re-inserts — so keying on it would report every cell of every
 *      sheet as removed-and-added on every save, which is the same as reporting nothing. The key is
 *      built from what the cell IS: its coupon, lock and product; its dimension and bands.
 *   2. TWO CELLS THAT ADDRESS THE SAME THING ARE A FINDING, NOT A SILENT OVERWRITE. Writing a map
 *      means the second write wins and the first disappears — and a sheet carrying two LLPAs for one
 *      band is a real loading mistake that would then be invisible in every diff forever. Duplicates
 *      are collected and reported; the FIRST value is kept so the map is deterministic.
 *
 * A CODE IS PREFERRED OVER THE BANDS, deliberately: a human renaming a band (700-739 → 700-740) with
 * the same code reads as one cell CHANGED, which is what happened; keyed on the bands it would read as
 * one removed and one added, which loses the connection between them. A cell with no code falls back
 * to its bands, which is the only stable thing it has.
 *
 * PURE: no DB, no network, no clock. LT-only; no RTL imports.
 */

/** A band as a key fragment. `null` is an OPEN end and must not read the same as a zero bound. */
function band(lo, hi) {
  const s = (v) => (v == null ? '*' : String(v));
  return `${s(lo)}..${s(hi)}`;
}

function bandsOf(a) {
  return [
    `fico=${band(a.fico_min, a.fico_max)}`,
    `ltv=${band(a.ltv_min, a.ltv_max)}`,
    `dscr=${band(a.dscr_min, a.dscr_max)}`,
  ].join(',');
}

/**
 * One stored sheet → { cells, duplicates, counts }.
 *
 *   cells      — { key → value }, ready for `ratesheet-diff.diffRulesets`. A price/adjustment cell's
 *                value is its NUMBER (so the diff's numeric classification applies); a cell whose
 *                meaning is not one number (a predicate, the cap tiers) is its own object.
 *   duplicates — [{ key, kept, dropped }] — two rows addressing one cell. Never silently merged.
 *   counts     — { basePrices, adjustments, priceLimit } so a caller can say what it read.
 */
function sheetToCells(sheet) {
  const cells = {};
  const duplicates = [];
  const put = (key, value) => {
    if (Object.prototype.hasOwnProperty.call(cells, key)) {
      duplicates.push({ key, kept: cells[key], dropped: value });
      return;
    }
    cells[key] = value;
  };

  const bp = (sheet && Array.isArray(sheet.basePrices)) ? sheet.basePrices : [];
  for (const r of bp) {
    // The coupon, the lock and the product ARE the identity of a base-price cell — that is exactly
    // what `quote.selectRungs` filters on when it decides which rungs a scenario prices from.
    put(`base|rate=${r.note_rate_milli_pct}|lock=${r.lock_days}|product=${r.product || ''}`, r.price_milli);
  }

  const adj = (sheet && Array.isArray(sheet.adjustments)) ? sheet.adjustments : [];
  for (const a of adj) {
    const id = a.code ? `code=${a.code}` : `${a.dimension || 'other'}|${bandsOf(a)}`;
    put(`llpa|${id}`, a.adj_milli);
    // The BANDS of a coded cell are their own addressable fact. Keyed only on the amount, moving a
    // band while leaving the number alone would diff as NO CHANGE — and a repriced band is precisely
    // the change a reviewer is looking for. It is a non-numeric cell, so the classifier sends it to
    // review rather than treating it as a refresh, which is the right answer for a rule change.
    if (a.code) put(`llpa|code=${a.code}|bands`, bandsOf(a));
    // A free-form predicate is a RULE. It is carried whole; the diff hashes it canonically.
    if (a.predicate) put(`llpa|${id}|predicate`, a.predicate);
  }

  const pl = sheet && sheet.priceLimit;
  if (pl) {
    put('limit|min_price_milli', pl.min_price_milli);
    put('limit|rounding_increment_milli', pl.rounding_increment_milli);
    put('limit|rounding_mode', pl.rounding_mode);
    put('limit|on_exceed', pl.on_exceed);
    put('limit|cap_tiers', pl.cap_tiers || []);
  }

  return {
    cells,
    duplicates,
    counts: { basePrices: bp.length, adjustments: adj.length, priceLimit: pl ? 1 : 0 },
  };
}

module.exports = { sheetToCells, _internals: { band, bandsOf } };
