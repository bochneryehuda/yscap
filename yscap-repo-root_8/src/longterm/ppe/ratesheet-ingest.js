'use strict';
/**
 * LT PPE — rate-sheet INGESTION normalizer (MEGA plan §7.3, feeding §7.2). PURE: no DB, no network,
 * no clock. Turns a raw upstream pull (a grid of product × note-rate × lock → price rows) into the
 * normalized Layer-1 base-price CELLS the rest of the pipeline speaks:
 *   cellKey `productId/noteRateMilli/lockDays` → basePriceMilli
 * — which then feed ratesheet-diff (prev vs today) and the base-price store / rateSheetToProgram.
 *
 * The caller adapts the vendor's raw grid into the explicit `rows` shape below (the vendor-specific
 * parsing is the caller's, and is captured/verified there); this module owns the deterministic,
 * unit-safe normalization + shape validation. A REFERENCE-CODE CROSSWALK (vendor product code ↔ our
 * productId) is required — an unmapped product is a PROBLEM, never a guessed id (§7.3 "a first-class
 * crosswalk table"). FAIL CLOSED: a bad/duplicate/unmapped row is recorded as a problem and excluded,
 * never silently priced. Monotonicity (§7.3/§7.4 guardrail) reuses ratesheet-diff — one definition.
 *
 * UNITS: rate percent (7.125) → milli-percent int (7125); price points (102.850) → milli-points int
 * (102850). Scale factors are parameters (default 1000).
 *
 * LT-only. No RTL imports.
 */

const { priceMonotonicityViolations } = require('./ratesheet-diff');

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }

/**
 * Normalize raw rows into base-price cells.
 *   rows: [{ productCode, noteRate, lockDays, price, term? }]
 *   crosswalk: { [productCode]: productId }
 *   opts: { rateScale=1000, priceScale=1000 }
 * Returns { cells:{cellKey:basePriceMilli}, rows:[{productId, productCode, noteRateMilli, lockDays,
 *           basePriceMilli, term}], problems:[{row, reason}] }.
 */
function normalizeGrid(rows = [], crosswalk = {}, opts = {}) {
  const rateScale = opts.rateScale == null ? 1000 : opts.rateScale;
  const priceScale = opts.priceScale == null ? 1000 : opts.priceScale;
  const cells = {};
  const out = [];
  const problems = [];
  const seen = new Map(); // cellKey -> basePriceMilli (to catch conflicting duplicates)

  (Array.isArray(rows) ? rows : []).forEach((r, i) => {
    if (!r || typeof r !== 'object') { problems.push({ row: i, reason: 'row is not an object' }); return; }
    const productId = Object.prototype.hasOwnProperty.call(crosswalk, r.productCode) ? crosswalk[r.productCode] : null;
    if (productId == null) { problems.push({ row: i, reason: `unmapped product code ${JSON.stringify(r.productCode)}` }); return; }
    if (!isNum(r.noteRate)) { problems.push({ row: i, reason: 'note rate is not a number' }); return; }
    if (!isNum(r.price)) { problems.push({ row: i, reason: 'price is not a number' }); return; }
    if (!Number.isInteger(r.lockDays) || r.lockDays <= 0) { problems.push({ row: i, reason: `bad lockDays ${JSON.stringify(r.lockDays)}` }); return; }

    const noteRateMilli = Math.round(r.noteRate * rateScale);
    const basePriceMilli = Math.round(r.price * priceScale);
    const cellKey = `${productId}/${noteRateMilli}/${r.lockDays}`;

    if (seen.has(cellKey)) {
      if (seen.get(cellKey) !== basePriceMilli) problems.push({ row: i, reason: `duplicate cell ${cellKey} with a different price (${seen.get(cellKey)} vs ${basePriceMilli})` });
      return; // an exact duplicate is deduped; a conflicting one is a problem and excluded
    }
    seen.set(cellKey, basePriceMilli);
    cells[cellKey] = basePriceMilli;
    out.push({ productId, productCode: r.productCode, noteRateMilli, lockDays: r.lockDays, basePriceMilli, term: r.term == null ? null : r.term });
  });

  return { cells, rows: out, problems };
}

/**
 * Validate the normalized grid's SHAPE (§7.3).
 *   normalized: the normalizeGrid result.
 *   opts: { monotonicityToleranceMilli=0, minRungsPerLadder=0, expectedLockDays?:[...] }
 * Checks, per (productId, lockDays) ladder: price non-decreasing as rate rises (monotonicity), and a
 * minimum rung count; optionally that every expected lock period is present for each product.
 * Returns { ok, problems:[{kind, detail, productId?, lockDays?}] }.
 */
function validateShape(normalized = {}, opts = {}) {
  const tol = opts.monotonicityToleranceMilli == null ? 0 : opts.monotonicityToleranceMilli;
  const minRungs = opts.minRungsPerLadder == null ? 0 : opts.minRungsPerLadder;
  const rows = Array.isArray(normalized.rows) ? normalized.rows : [];
  const problems = [];

  // group into ladders by product+lock
  const ladders = new Map();
  const productLocks = new Map();
  for (const r of rows) {
    const key = `${r.productId}/${r.lockDays}`;
    if (!ladders.has(key)) ladders.set(key, []);
    ladders.get(key).push({ rate: r.noteRateMilli, price: r.basePriceMilli });
    if (!productLocks.has(r.productId)) productLocks.set(r.productId, new Set());
    productLocks.get(r.productId).add(r.lockDays);
  }

  for (const [key, rungs] of ladders) {
    const [productId, lockDays] = key.split('/');
    if (rungs.length < minRungs) problems.push({ kind: 'too_few_rungs', detail: `ladder ${key} has ${rungs.length} rung(s), needs ${minRungs}`, productId, lockDays: Number(lockDays) });
    const viol = priceMonotonicityViolations(rungs, { tolerance: tol });
    for (const v of viol) problems.push({ kind: 'monotonicity', detail: `price ${v.higherPrice} at rate ${v.higherRate} is below ${v.lowerPrice} at rate ${v.lowerRate}`, productId, lockDays: Number(lockDays) });
  }

  if (Array.isArray(opts.expectedLockDays) && opts.expectedLockDays.length) {
    for (const [productId, locks] of productLocks) {
      for (const ld of opts.expectedLockDays) {
        if (!locks.has(ld)) problems.push({ kind: 'missing_lock', detail: `product ${productId} is missing lock period ${ld}`, productId, lockDays: ld });
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * One-call ingest: normalize + validate. `ok` is true only when there are NO normalization problems
 * AND the shape is valid — a caller should refuse to promote a snapshot that is not `ok` (§7.4).
 */
function ingestGrid(rows, crosswalk, opts = {}) {
  const normalized = normalizeGrid(rows, crosswalk, opts);
  const shape = validateShape(normalized, opts);
  return {
    cells: normalized.cells,
    rows: normalized.rows,
    problems: normalized.problems,
    shape,
    ok: normalized.problems.length === 0 && shape.ok,
  };
}

module.exports = { normalizeGrid, validateShape, ingestGrid };
