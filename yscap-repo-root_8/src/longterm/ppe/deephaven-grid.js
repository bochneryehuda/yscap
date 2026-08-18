'use strict';
/**
 * LT PPE — the RATE-SHEET GRID model (E3/E5, owner-directed 2026-08-17: "each Investor designed like a
 * rate sheet … every box on the Excel sheet means a rule"). PURE: no DB, no network, no clock.
 *
 * A DSCR investor rate sheet, as a human sees it in Excel (documented in
 * docs/longterm/RATE-SHEET-KNOWLEDGE.md §2, the Deephaven "Corr Flow" DSCR tab), is three things:
 *   (1) a BASE-PRICE grid — one row per coupon (note rate), one price per term/product at a lock;
 *   (2) a FICO × CLTV price-adjustment grid, segmented into DSCR bands — the LLPA box, where every
 *       cell is a plus/minus to the PRICE, and an `N/A` cell means the deal is INELIGIBLE there;
 *   (3) other LLPA tables — loan-amount tiers, prepay, property type, state, … each a banded or
 *       predicate-based price adjustment.
 *
 * This module converts that human grid, ONCE, into the EXACT stored shape the rest of the built
 * pipeline already prices (`ratesheet.rateSheetToProgram` → `quote.quoteProgram`): `basePrices[]`
 * (`ratesheet-ingest` cells) + `adjustments[]` (`ratesheet.adjustmentToRule` rows) + a `priceLimit`.
 * So the Excel editor (E3) and the Excel import (E5) both speak this one grid shape, and neither has
 * to know the stored column names. `bandPredicate` is IMPORTED from ratesheet.js — the ONE definition
 * of a half-open [min,max) band → a rules.js predicate — so a band can never be interpreted two ways.
 *
 * FAITHFUL, NOT CLEVER — three rules that keep a wrong number off a rate sheet:
 *   • Bands are EXPLICIT [min,max) half-open ranges the caller supplies (the Excel parser decides how
 *     a column header like "760-779" becomes {min:760,max:780}); this module never infers a range
 *     from a bare label, because "is the 75 column ≤75 or (70,75]?" is a per-sheet reading, not ours.
 *   • An `N/A` / null cell is INELIGIBILITY (a decline predicate), NEVER a 0-point adjustment — a 0
 *     adjustment would happily PRICE a combination the sheet forbids.
 *   • Every number crosses to integer milli-units by `Math.round(x * scale)` (price/points), and a
 *     predicate threshold (loan amount, units) stays in its own natural unit — never scaled.
 *
 * FAIL CLOSED: a malformed band, an unreadable cell, or a non-numeric price is recorded in
 * `problems[]` and EXCLUDED, never silently priced. LT-only. No RTL imports.
 */

const { bandPredicate } = require('./ratesheet');
const { sheetOverlapProblems } = require('./adjustment-overlap');

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }
function milli(x, scale) { return Math.round(x * scale); }

// THE SIGN RULE — a money rule, so it is written down. A rate-sheet cell is a PRICE adjustment where
// a POSITIVE value is a PREMIUM that IMPROVES the price (better credit / lower leverage), per
// RATE-SHEET-KNOWLEDGE §2. The pricing engine works in POINTS (`points = 100 − price`, §1), where a
// stored `adj_milli` is SUBTRACTED from the price — so a positive adj_milli makes the price WORSE
// (fixture: dscr adj +250 prices "102.850 − 0.250"; fico adj −125 prices "+0.125"). The two are
// OPPOSITE, so a sheet price-adjustment value V (premium-positive) becomes engine `adj_milli = −V`.
// Getting this backwards flips every price on the sheet; it is proven end-to-end in the grid test.
function priceAdjMilli(sheetValue, scale) { return milli(-sheetValue, scale); }

// A [min,max) band → a short stable key/label fragment. Half-open, so max is the exclusive upper edge.
function bandKey(min, max) {
  return `${min == null ? '' : min}_${max == null ? '' : max}`;
}
function bandLabel(name, min, max, unit = '') {
  const u = unit ? unit : '';
  if (min != null && max != null) return `${name} ${min}${u}–${max}${u}`;
  if (min != null) return `${name} ≥${min}${u}`;
  if (max != null) return `${name} <${max}${u}`;
  return `${name} any`;
}

// Validate an explicit {min,max} band. Returns null when OK, or a reason string when malformed.
function bandProblem(b) {
  if (b == null || typeof b !== 'object') return 'band is not an object';
  const { min, max } = b;
  if (min != null && !isNum(min)) return 'band min is not a number';
  if (max != null && !isNum(max)) return 'band max is not a number';
  if (min == null && max == null) return 'band is fully open (min and max both absent)';
  if (min != null && max != null && !(min < max)) return `band min ${min} is not < max ${max}`;
  return null;
}

/**
 * Convert a human rate-sheet grid into the stored sheet shape.
 *
 *   grid = {
 *     lockDays: 45,                              // the base grid's lock period (days)
 *     scale: 1000,                               // milli scale for prices/points (default 1000)
 *     terms: [{ key, product }],                 // the base grid's price columns
 *     base:  [{ coupon, prices:{ [termKey]: price } }],
 *     ficoCltvByDscr: [{ dscr:{min,max}, ficoBands:[{min,max}], cltvBands:[{min,max}],
 *                        cells:[[pointsOrNull, ...perCltv], ...perFico] }],
 *     llpaTables: [{ dimension, fact?, reason?,
 *                    bands?:[{min,max,adj}],       // banded → predicate on `fact` (default = dimension)
 *                    predicate?, adj? }],          // OR one predicate + one adjustment
 *     priceLimit: { minPrice?, roundingMode?, roundingIncrement?, capTiers?[] },
 *   }
 *
 * Returns { basePrices[], adjustments[], ineligibilities[], priceLimit, problems[] } — `basePrices` +
 * `adjustments` + `priceLimit` plug straight into `ratesheet.rateSheetToProgram`; `ineligibilities`
 * are decline predicates for the eligibility rule table (the N/A boxes).
 */
function gridToRateSheet(grid = {}, opts = {}) {
  const problems = [];
  const scale = isNum(grid.scale) ? grid.scale : (isNum(opts.scale) ? opts.scale : 1000);
  const investor = grid.investor || opts.investor || null;
  const program = grid.program || opts.program || null;
  const prefix = [investor, program].filter(Boolean).join('_') || 'sheet';

  // ---- (1) base-price grid --------------------------------------------------
  const basePrices = [];
  const lockDays = grid.lockDays;
  const terms = Array.isArray(grid.terms) ? grid.terms : [];
  const termByKey = new Map(terms.map((t) => [t && t.key, t]));
  if (!Number.isInteger(lockDays) || lockDays <= 0) {
    problems.push({ where: 'base', reason: `bad lockDays ${JSON.stringify(lockDays)}` });
  } else if (terms.length === 0) {
    problems.push({ where: 'base', reason: 'no term/product columns' });
  } else {
    (Array.isArray(grid.base) ? grid.base : []).forEach((row, i) => {
      if (!row || !isNum(row.coupon)) { problems.push({ where: `base[${i}]`, reason: 'coupon is not a number' }); return; }
      const prices = (row.prices && typeof row.prices === 'object') ? row.prices : {};
      for (const [termKey, price] of Object.entries(prices)) {
        const term = termByKey.get(termKey);
        if (!term || !term.product) { problems.push({ where: `base[${i}].${termKey}`, reason: 'unknown term key (not in grid.terms)' }); continue; }
        if (!isNum(price)) { problems.push({ where: `base[${i}].${termKey}`, reason: 'price is not a number' }); continue; }
        basePrices.push({
          note_rate_milli_pct: milli(row.coupon, scale),
          lock_days: lockDays,
          product: term.product,
          price_milli: milli(price, scale),
        });
      }
    });
  }

  // ---- (2) FICO × CLTV × DSCR adjustment grid -------------------------------
  // Every non-null cell = a PRICING adjustment (points). A null / 'N/A' cell = an INELIGIBILITY on
  // exactly that (dscr × fico × cltv) box. CLTV maps to the engine's `ltv` leverage fact (the stored
  // adjustment row bands only fico/ltv/dscr — ratesheet.adjustmentToRule).
  const adjustments = [];
  const ineligibilities = [];
  (Array.isArray(grid.ficoCltvByDscr) ? grid.ficoCltvByDscr : []).forEach((block, bi) => {
    const where = `ficoCltvByDscr[${bi}]`;
    if (!block || typeof block !== 'object') { problems.push({ where, reason: 'block is not an object' }); return; }
    const dp = bandProblem(block.dscr || { min: null, max: null });
    // A DSCR band may be fully open ONLY if there is exactly one block (the sheet is not DSCR-segmented).
    if (dp && !(dp === 'band is fully open (min and max both absent)' && (grid.ficoCltvByDscr.length === 1))) {
      problems.push({ where: `${where}.dscr`, reason: dp }); return;
    }
    const dscr = block.dscr || { min: null, max: null };
    const ficoBands = Array.isArray(block.ficoBands) ? block.ficoBands : [];
    const cltvBands = Array.isArray(block.cltvBands) ? block.cltvBands : [];
    const cells = Array.isArray(block.cells) ? block.cells : [];
    if (ficoBands.length === 0 || cltvBands.length === 0) { problems.push({ where, reason: 'block has no fico or no cltv bands' }); return; }
    // validate the axis bands once
    let axisBad = false;
    ficoBands.forEach((b, i) => { const p = bandProblem(b); if (p) { problems.push({ where: `${where}.ficoBands[${i}]`, reason: p }); axisBad = true; } });
    cltvBands.forEach((b, i) => { const p = bandProblem(b); if (p) { problems.push({ where: `${where}.cltvBands[${i}]`, reason: p }); axisBad = true; } });
    if (axisBad) return;
    ficoBands.forEach((fb, r) => {
      const rowCells = Array.isArray(cells[r]) ? cells[r] : [];
      cltvBands.forEach((cb, c) => {
        const cell = rowCells[c];
        const dk = bandKey(dscr.min, dscr.max);
        const code = `${prefix}_fc_${dk}_${bandKey(fb.min, fb.max)}_${bandKey(cb.min, cb.max)}`;
        const reason = `${bandLabel('FICO', fb.min, fb.max)} × ${bandLabel('CLTV', cb.min, cb.max, '%')} × ${bandLabel('DSCR', dscr.min, dscr.max)}`;
        // UNIT CONVENTION (the engine's, proven by the pricing fixture): FICO is a RAW score
        // (780), while the leverage and DSCR facts are MILLI — CLTV 75% → ltv_max 75000, DSCR 1.25
        // → dscr_min 1250. So fico bands pass through, ltv/dscr bands scale. A loan-amount threshold
        // (llpaTables below) stays RAW dollars — its fact is not milli.
        const common = {
          fico_min: fb.min, fico_max: fb.max,
          ltv_min: cb.min == null ? null : milli(cb.min, scale), ltv_max: cb.max == null ? null : milli(cb.max, scale),
          dscr_min: dscr.min == null ? null : milli(dscr.min, scale), dscr_max: dscr.max == null ? null : milli(dscr.max, scale),
        };
        if (cell == null || cell === 'N/A' || cell === 'n/a') {
          // INELIGIBLE box — a decline predicate, never a priced 0.
          ineligibilities.push({ code, kind: 'eligibility', dimension: 'fico_cltv_dscr', declineReason: `Not eligible: ${reason}`, ...common });
          return;
        }
        if (!isNum(cell)) { problems.push({ where: `${where}.cells[${r}][${c}]`, reason: `cell is neither a number nor N/A (${JSON.stringify(cell)})` }); return; }
        adjustments.push({
          code, dimension: 'fico_cltv_dscr', ...common,
          adj_milli: priceAdjMilli(cell, scale), unit: 'points', reason, cumulative: true, priority: 0,
        });
      });
    });
  });

  // ---- (3) other LLPA tables (loan amount, prepay, property type, state, …) -
  // Banded on a fact OTHER than fico/ltv/dscr → a predicate on that fact (bandPredicate, imported).
  // Or a single explicit predicate + adjustment. The threshold stays in its own unit (NOT scaled).
  (Array.isArray(grid.llpaTables) ? grid.llpaTables : []).forEach((tbl, ti) => {
    const where = `llpaTables[${ti}]`;
    if (!tbl || typeof tbl !== 'object') { problems.push({ where, reason: 'table is not an object' }); return; }
    const dimension = tbl.dimension || tbl.fact || 'other';
    const fact = tbl.fact || tbl.dimension;
    if (Array.isArray(tbl.bands)) {
      if (!fact) { problems.push({ where, reason: 'banded llpa table has no `fact`/`dimension`' }); return; }
      tbl.bands.forEach((b, bi) => {
        const p = bandProblem({ min: b && b.min, max: b && b.max });
        if (p) { problems.push({ where: `${where}.bands[${bi}]`, reason: p }); return; }
        if (!isNum(b.adj)) { problems.push({ where: `${where}.bands[${bi}]`, reason: 'band adj is not a number' }); return; }
        const predicate = bandPredicate(fact, b.min, b.max);
        adjustments.push({
          code: `${prefix}_${dimension}_${bandKey(b.min, b.max)}`,
          dimension, predicate,
          adj_milli: priceAdjMilli(b.adj, scale), unit: 'points',
          reason: tbl.reason || bandLabel(dimension, b.min, b.max), cumulative: true, priority: tbl.priority || 0,
        });
      });
      return;
    }
    if (tbl.predicate && isNum(tbl.adj)) {
      adjustments.push({
        code: tbl.code || `${prefix}_${dimension}`,
        dimension, predicate: tbl.predicate,
        adj_milli: priceAdjMilli(tbl.adj, scale), unit: 'points',
        reason: tbl.reason || dimension, cumulative: true, priority: tbl.priority || 0,
      });
      return;
    }
    problems.push({ where, reason: 'llpa table is neither banded (bands+fact) nor a predicate+adj' });
  });

  // ---- (4) explicit ELIGIBILITY bounds (min/max FICO, LTV, DSCR, loan amount) ------------------
  // Beyond the N/A grid boxes: the sheet's own eligibility envelope, each an open-ended or compound
  // decline PREDICATE on a fact the scenario carries (fico/ltv/dscr in the grid's milli scale, loan
  // amount RAW). A missing predicate is a bug (a rule that declines nothing is silently useless), so it
  // is recorded in problems[] and skipped — never emitted as a decline-everything rule.
  (Array.isArray(grid.eligibility) ? grid.eligibility : []).forEach((e, ei) => {
    const where = `eligibility[${ei}]`;
    if (!e || typeof e !== 'object' || !e.predicate || typeof e.predicate !== 'object') {
      problems.push({ where, reason: 'eligibility rule needs a `predicate`' });
      return;
    }
    ineligibilities.push({
      code: e.code || `${prefix}_elig_${ei}`,
      kind: 'eligibility',
      dimension: e.dimension || 'eligibility',
      declineReason: e.declineReason || 'Not eligible',
      predicate: e.predicate,
      priority: e.priority || 0,
    });
  });

  // ---- price limit ----------------------------------------------------------
  let priceLimit;
  if (grid.priceLimit && typeof grid.priceLimit === 'object') {
    const pl = grid.priceLimit;
    priceLimit = {
      min_price_milli: isNum(pl.minPrice) ? milli(pl.minPrice, scale) : null,
      rounding_mode: pl.roundingMode || 'nearest_eighth',
      rounding_increment_milli: isNum(pl.roundingIncrement) ? milli(pl.roundingIncrement, scale) : null,
      cap_tiers: Array.isArray(pl.capTiers) ? pl.capTiers : [],
    };
  }

  // ---- (5) DOUBLE-CHARGE CHECK ------------------------------------------------------------------
  // Every adjustment row above ACCUMULATES onto the price, so two rows covering one loan on one
  // dimension — two overlapping DSCR blocks, or the same row pasted twice — charge the borrower twice.
  // A grid that compiles cleanly and then double-charges is exactly the "fail closed, and never
  // silently" case this file's own header promises, and until now `problems[]` came back EMPTY for it.
  // The rows are NOT rewritten: an investor's sheet is theirs, so the compiler REPORTS and a human
  // decides. Detection is delegated whole to `rule-coverage.analyzeRuleSet` through
  // `adjustment-overlap` — the same one definition the pricer uses, so the compile-time report and the
  // price-time report can never say different things about the same two rules.
  for (const p of sheetOverlapProblems(adjustments, { where: 'adjustments' })) problems.push(p);

  return { basePrices, adjustments, ineligibilities, priceLimit, problems };
}

function unmilli(x, scale) { return x / scale; }
// Dedupe {min,max} bands; sort by min (open-bottom first), then max (open-top last).
function uniqueSortedBands(bands) {
  const seen = new Map();
  for (const b of bands) { const k = `${b.min}|${b.max}`; if (!seen.has(k)) seen.set(k, { min: b.min, max: b.max }); }
  const lo = (v) => (v == null ? -Infinity : v);
  const hi = (v) => (v == null ? Infinity : v);
  return [...seen.values()].sort((a, b) => (lo(a.min) - lo(b.min)) || (hi(a.max) - hi(b.max)));
}

/**
 * THE INVERSE (E3 editor): a stored sheet → the human grid, so the Excel editor can RENDER a stored
 * rate sheet as an editable grid. It is the exact reverse of `gridToRateSheet`, so the round trip is
 * lossless on the DATA: `sheet → grid → sheet` reproduces the same base prices, the same FICO×CLTV×DSCR
 * cells (with N/A boxes back in place from the ineligibilities), and the same LLPA predicates/values.
 * The reconstructed rule CODES are regenerated by the forward pass from bands, so they are stable
 * labels rather than round-tripped data.
 *
 *   sheet = { basePrices[], adjustments[], ineligibilities[], priceLimit } (as gridToRateSheet emits)
 * Returns the grid shape gridToRateSheet consumes. Reverses every unit + the sign rule.
 */
function rateSheetToGrid(sheet = {}, opts = {}) {
  const scale = isNum(opts.scale) ? opts.scale : 1000;
  const basePrices = Array.isArray(sheet.basePrices) ? sheet.basePrices : [];
  const adjustments = Array.isArray(sheet.adjustments) ? sheet.adjustments : [];
  const ineligibilities = Array.isArray(sheet.ineligibilities) ? sheet.ineligibilities : [];

  // ---- base grid ----
  const products = [];
  const rates = [];
  const priceAt = new Map();
  let lockDays = null;
  for (const b of basePrices) {
    if (lockDays == null) lockDays = b.lock_days;
    if (!products.includes(b.product)) products.push(b.product);
    if (!rates.includes(b.note_rate_milli_pct)) rates.push(b.note_rate_milli_pct);
    priceAt.set(`${b.note_rate_milli_pct}|${b.product}`, b.price_milli);
  }
  rates.sort((a, b) => a - b);
  const terms = products.map((p) => ({ key: p, product: p }));
  const base = rates.map((rate) => {
    const prices = {};
    for (const p of products) { const k = `${rate}|${p}`; if (priceAt.has(k)) prices[p] = unmilli(priceAt.get(k), scale); }
    return { coupon: unmilli(rate, scale), prices };
  });

  // ---- FICO × CLTV × DSCR blocks (adjustments + ineligibilities) ----
  const fc = [...adjustments, ...ineligibilities].filter((a) => a.dimension === 'fico_cltv_dscr');
  const byDscr = new Map();
  for (const a of fc) {
    const dk = `${a.dscr_min}|${a.dscr_max}`;
    if (!byDscr.has(dk)) byDscr.set(dk, { dscr: { min: a.dscr_min, max: a.dscr_max }, items: [] });
    byDscr.get(dk).items.push(a);
  }
  const ficoCltvByDscr = [];
  for (const blk of byDscr.values()) {
    const ficoBands = uniqueSortedBands(blk.items.map((a) => ({ min: a.fico_min, max: a.fico_max })));
    const cltvBandsMilli = uniqueSortedBands(blk.items.map((a) => ({ min: a.ltv_min, max: a.ltv_max })));
    const cellAt = new Map();
    for (const a of blk.items) {
      const k = `${a.fico_min}|${a.fico_max}|${a.ltv_min}|${a.ltv_max}`;
      const eligible = a.kind !== 'eligibility' && a.adj_milli != null;
      cellAt.set(k, eligible ? unmilli(-a.adj_milli, scale) : null);   // reverse the sign rule; N/A → null
    }
    const cells = ficoBands.map((fb) => cltvBandsMilli.map((cb) => {
      const k = `${fb.min}|${fb.max}|${cb.min}|${cb.max}`;
      return cellAt.has(k) ? cellAt.get(k) : null;
    }));
    ficoCltvByDscr.push({
      dscr: { min: blk.dscr.min == null ? null : unmilli(blk.dscr.min, scale), max: blk.dscr.max == null ? null : unmilli(blk.dscr.max, scale) },
      ficoBands,                                                        // FICO raw
      cltvBands: cltvBandsMilli.map((cb) => ({ min: cb.min == null ? null : unmilli(cb.min, scale), max: cb.max == null ? null : unmilli(cb.max, scale) })),
      cells,
    });
  }

  // ---- other LLPA tables: each non-fc adjustment → a single predicate+adj table (verbatim) ----
  const llpaTables = adjustments.filter((a) => a.dimension !== 'fico_cltv_dscr').map((a) => ({
    dimension: a.dimension, predicate: a.predicate, adj: unmilli(-a.adj_milli, scale),
    code: a.code, reason: a.reason,
  }));

  // ---- price limit ----
  let priceLimit;
  if (sheet.priceLimit && typeof sheet.priceLimit === 'object') {
    const pl = sheet.priceLimit;
    priceLimit = {
      minPrice: pl.min_price_milli == null ? null : unmilli(pl.min_price_milli, scale),
      roundingMode: pl.rounding_mode || 'nearest_eighth',
      roundingIncrement: pl.rounding_increment_milli == null ? null : unmilli(pl.rounding_increment_milli, scale),
      capTiers: Array.isArray(pl.cap_tiers) ? pl.cap_tiers : [],
    };
  }

  return { lockDays, scale, terms, base, ficoCltvByDscr, llpaTables, priceLimit };
}

module.exports = { gridToRateSheet, rateSheetToGrid, _internals: { bandKey, bandLabel, bandProblem, milli, uniqueSortedBands } };
