'use strict';
/**
 * LT PPE — THE POINT-FOR-POINT PARITY MATRIX (master plan P9). PURE: no DB, no network, no clock.
 *
 * Takes ONE run's per-scenario results (`shadow.runShadow` → `results[]`) and slices them by the
 * scenario's own FACTS — state, FICO band, LTV band, DSCR band, purpose — reporting per cell how often
 * the two engines agreed and, where they did not, how far apart the PRICE was. Today's parity number is
 * a single rate for the whole run: it says we disagree, never WHERE, so nobody can tell one bad FICO
 * band from a sheet that is wrong everywhere.
 *
 * THE BANDS ARE THE SHEET'S OWN EDGES, NEVER INVENTED. A dashboard that cuts FICO at 660/680/700
 * because those are the usual numbers is describing somebody else's rate sheet: if THIS sheet breaks at
 * 679, a cell straddling the break averages a good band with a bad one and the average hides both.
 * `bandsFromProgram` derives each axis's cut points from the program's OWN rules — the same discipline
 * `rule-coverage.gapsForDimension` uses to decompose a grid, and it REUSES that module's `regionOf`
 * rather than re-reading predicates, so the two can never disagree about where a sheet breaks.
 *
 * NOTHING IS EVER SILENTLY BUCKETED. A scenario the facts cannot place — no facts at all, a fact this
 * run has no bands for, a value that is not a number where a band expects one — is counted as
 * UNSLICEABLE for that dimension, WITH the reason, and is never dropped and never folded into a
 * neighbouring cell. Every dimension reconciles: cells + unsliceable = the run's own total, and the
 * report carries that arithmetic so a caller can check it rather than trust it.
 *
 * It MEASURES. It never decides (the cutover gate is `cutover.js`) and never persists.
 *
 * LT-only. No RTL imports.
 */

const { _internals: coverage } = require('./rule-coverage');

const PRICE_KIND = 'price_mismatch';
const NEG_INF = Number.NEGATIVE_INFINITY;
const POS_INF = Number.POSITIVE_INFINITY;

// A run of any size is fine, but a single dimension with an absurd number of distinct enum values is a
// report nobody can read AND a sign the fact is not categorical at all (a loan amount, say). Capped
// with the count REPORTED, never silently truncated.
const MAX_CELLS_PER_DIMENSION = 200;

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }

/**
 * Every numeric CUT POINT the program's rules use, per fact.
 *
 * A rule's predicate reduces to a region — a box of numeric intervals — and each interval's finite ends
 * are places the sheet's behaviour changes. Collect them across every rule and you have the axes the
 * sheet is actually built on. A rule whose predicate cannot be read as a region (an `neq` complement,
 * an `any`) contributes nothing rather than a guess; it does not make the other rules' edges wrong.
 *
 * Returns Map<fact, number[]> — sorted, de-duplicated, finite edges only. Never throws.
 */
function bandsFromProgram(program) {
  const edges = new Map();
  const rules = (program && Array.isArray(program.rules)) ? program.rules : [];
  for (const rule of rules) {
    let region = null;
    try { region = coverage.regionOf(rule && rule.when); } catch (_) { region = null; }
    if (!region || !region.numeric) continue;
    for (const [fact, iv] of region.numeric) {
      if (!edges.has(fact)) edges.set(fact, new Set());
      const set = edges.get(fact);
      if (isNum(iv.min) && iv.min > NEG_INF) set.add(iv.min);
      if (isNum(iv.max) && iv.max < POS_INF) set.add(iv.max);
    }
  }
  const out = new Map();
  for (const [fact, set] of edges) {
    const sorted = Array.from(set).filter(isNum).sort((a, b) => a - b);
    if (sorted.length) out.set(fact, sorted);
  }
  return out;
}

/**
 * The half-open bands an edge list defines, including the open ends.
 *   [700, 760] → [-inf,700) [700,760) [760,+inf)
 * HALF-OPEN because that is the house convention (`rules.js` `between` is `min <= x < max`): a band
 * that closed both ends would claim a scenario sitting exactly on an edge belongs to two cells, and it
 * would then be counted twice and the reconciliation would silently stop adding up.
 */
function bandsOf(edges) {
  const list = [];
  const es = (edges || []).filter(isNum).slice().sort((a, b) => a - b);
  if (!es.length) return list;
  list.push({ lo: NEG_INF, hi: es[0] });
  for (let i = 0; i < es.length - 1; i += 1) list.push({ lo: es[i], hi: es[i + 1] });
  list.push({ lo: es[es.length - 1], hi: POS_INF });
  return list;
}

function bandLabel(b) {
  if (b.lo === NEG_INF) return `< ${b.hi}`;
  if (b.hi === POS_INF) return `>= ${b.lo}`;
  return `${b.lo}–${b.hi}`;
}

// Which band a value falls in, or null when it is not a number this axis can place.
function bandIndex(bands, v) {
  if (!isNum(v)) return null;
  for (let i = 0; i < bands.length; i += 1) {
    if (v >= bands[i].lo && v < bands[i].hi) return i;
  }
  return null;
}

// A fresh, zeroed cell. Every counter exists from the start so a cell with nothing in it reports 0
// rather than undefined — "none" and "not measured" must never render the same.
function emptyCell(key, label) {
  return {
    key,
    label,
    total: 0,
    agreed: 0,
    disagreed: 0,
    errors: 0,
    incomparable: 0,
    overlay: 0,
    agreementRate: null,
    priceDelta: { samples: 0, scenarios: 0, worstAbsMilli: null, minMilli: null, maxMilli: null, meanMilli: null },
  };
}

// Fold one result into a cell.
function addToCell(cell, r) {
  cell.total += 1;
  if (r.error) cell.errors += 1;
  if (r.incomparable) cell.incomparable += 1;
  if (r.overlay) cell.overlay += 1;
  if (r.agree) { cell.agreed += 1; } else { cell.disagreed += 1; }

  const deltas = [];
  for (const f of (Array.isArray(r.findings) ? r.findings : [])) {
    if (f && f.kind === PRICE_KIND && isNum(f.deltaMilli)) deltas.push(f.deltaMilli);
  }
  if (!deltas.length) return;
  const pd = cell.priceDelta;
  // `scenarios` counts SCENARIOS with a price gap; `samples` counts the individual coupons. They are
  // different questions — "how much of the book is off" vs "how many rungs" — and reporting one under
  // the other's name is how a single scenario disagreeing on eight coupons reads as eight bad loans.
  pd.scenarios += 1;
  for (const d of deltas) {
    pd.samples += 1;
    pd.minMilli = pd.minMilli == null ? d : Math.min(pd.minMilli, d);
    pd.maxMilli = pd.maxMilli == null ? d : Math.max(pd.maxMilli, d);
    const abs = Math.abs(d);
    pd.worstAbsMilli = pd.worstAbsMilli == null ? abs : Math.max(pd.worstAbsMilli, abs);
    pd._sum = (pd._sum || 0) + d;
  }
}

function finishCell(cell) {
  cell.agreementRate = cell.total ? cell.agreed / cell.total : null;
  const pd = cell.priceDelta;
  // The MEAN is signed on purpose: a sheet that is uniformly a quarter point light is a different
  // problem from one scattered either side of Lender Price, and an average of absolute values cannot
  // tell them apart. `worstAbsMilli` is the one that answers "how bad does it get".
  pd.meanMilli = pd.samples ? pd._sum / pd.samples : null;
  delete pd._sum;
  return cell;
}

/**
 * Slice one run by one FACT.
 *   results — shadow.runShadow results (each { agree, facts, findings, error?, … }).
 *   fact    — the fact key to slice on.
 *   bands   — a numeric edge list for a continuous fact, or null to slice a categorical one by its own
 *             distinct observed values.
 * Returns { dimension, kind, cells, unsliceable:[{ why, count }], total, cellsTruncated }.
 */
function sliceBy(results, fact, bands) {
  const list = Array.isArray(results) ? results : [];
  const cells = new Map();
  const skipped = new Map();
  const skip = (why) => skipped.set(why, (skipped.get(why) || 0) + 1);
  const bandList = bands && bands.length ? bandsOf(bands) : null;
  let truncated = 0;

  for (const r of list) {
    if (!r || typeof r !== 'object') { skip('the run produced no result for this scenario'); continue; }
    const facts = r.facts;
    if (!facts || typeof facts !== 'object') { skip('the scenario carried no facts, so it cannot be placed'); continue; }
    if (!Object.prototype.hasOwnProperty.call(facts, fact)) { skip(`the scenario does not state ${fact}`); continue; }
    const v = facts[fact];
    if (v == null) { skip(`${fact} is blank on this scenario`); continue; }

    let key; let label;
    if (bandList) {
      const i = bandIndex(bandList, v);
      // A NUMERIC axis refuses a non-numeric value rather than making a cell out of it: a cell called
      // "N/A" sitting beside real bands reads as a band of the sheet, and it is not one.
      if (i == null) { skip(`${fact} is not a number this axis can place (${JSON.stringify(v)})`); continue; }
      key = `${bandList[i].lo}:${bandList[i].hi}`;
      label = bandLabel(bandList[i]);
    } else {
      if (typeof v === 'object') { skip(`${fact} is not a value this axis can group by`); continue; }
      key = String(v);
      label = String(v);
    }

    if (!cells.has(key)) {
      if (cells.size >= MAX_CELLS_PER_DIMENSION) { truncated += 1; skip(`more than ${MAX_CELLS_PER_DIMENSION} distinct values of ${fact} — this axis is not categorical`); continue; }
      cells.set(key, emptyCell(key, label));
    }
    addToCell(cells.get(key), r);
  }

  const out = Array.from(cells.values()).map(finishCell);
  // Sorted so a report reads in the sheet's own order: bands by their lower edge, categories by name.
  out.sort((a, b) => (bandList ? Number(String(a.key).split(':')[0]) - Number(String(b.key).split(':')[0]) : String(a.label).localeCompare(String(b.label))));

  const unsliceable = Array.from(skipped.entries()).map(([why, count]) => ({ why, count }));
  return {
    dimension: fact,
    kind: bandList ? 'band' : 'category',
    cells: out,
    unsliceable,
    unsliceableTotal: unsliceable.reduce((n, u) => n + u.count, 0),
    total: list.length,
    cellsTruncated: truncated,
  };
}

/**
 * Does every dimension account for every scenario — cells + unsliceable = the run's own total?
 *
 * A slice that silently loses scenarios reports a BETTER agreement rate than the run earned, which is
 * the one direction a parity dashboard must never be wrong in. So the report carries the arithmetic
 * rather than leaving a reader to total the columns.
 *
 * EXPORTED SO IT CAN BE PROVEN. On the production path this is a THEOREM, not a behaviour: every
 * result either enters exactly one cell or is counted as unsliceable, so `buildParityMatrix` can never
 * produce a dimension that fails it, and hard-coding it to `true` therefore changes no output any
 * caller could observe. That is the same shape as the containment-vs-overlap mutation recorded in
 * parity status §2.20 — a green mutation that reveals a theorem rather than a coverage hole. Pulling
 * the check out as a named function is what makes it testable ON ITS OWN, against a hand-built lossy
 * dimension, so the check is proven to work even though the code cannot make it fire.
 */
function reconcilesAll(dimensions, total) {
  return (Array.isArray(dimensions) ? dimensions : []).every((d) => {
    const cells = (d && Array.isArray(d.cells)) ? d.cells.reduce((s, c) => s + (c && isNum(c.total) ? c.total : 0), 0) : 0;
    const un = d && isNum(d.unsliceableTotal) ? d.unsliceableTotal : 0;
    return cells + un === total;
  });
}

/**
 * Build the whole matrix for one run.
 *   results — shadow.runShadow results.
 *   opts:
 *     program   — the priced program; its rules supply each numeric axis's OWN edges.
 *     bands     — { fact: [edges] } to override or supply an axis the program does not describe.
 *     dimensions— the facts to slice on. Defaults to every fact the run's scenarios actually state,
 *                 which keeps the report about THIS run rather than about a hard-coded list of
 *                 dimensions that may not appear in it.
 * Returns { total, agreed, disagreed, errors, incomparable, overlay, agreementRate, dimensions:[...],
 *           reconciles:boolean, factsSeen:[...], factsMissing:number }.
 */
function buildParityMatrix(results, opts = {}) {
  const list = Array.isArray(results) ? results : [];
  const programBands = bandsFromProgram(opts.program);
  const override = (opts.bands && typeof opts.bands === 'object') ? opts.bands : {};

  // Which facts this run actually states. Deriving them beats a fixed list for the same reason the
  // bands are derived: a dimension nobody priced would render as an empty table, and a dimension the
  // run DID vary would be missing from the report entirely.
  const seen = new Set();
  let factsMissing = 0;
  for (const r of list) {
    if (r && r.facts && typeof r.facts === 'object') {
      for (const k of Object.keys(r.facts)) seen.add(k);
    } else { factsMissing += 1; }
  }
  const dims = Array.isArray(opts.dimensions) && opts.dimensions.length
    ? opts.dimensions.filter((d) => typeof d === 'string' && d)
    : Array.from(seen).sort();

  const dimensions = dims.map((fact) => {
    const edges = Object.prototype.hasOwnProperty.call(override, fact)
      ? (Array.isArray(override[fact]) ? override[fact] : null)
      : (programBands.get(fact) || null);
    return sliceBy(list, fact, edges);
  });

  let agreed = 0; let disagreed = 0; let errors = 0; let incomparable = 0; let overlay = 0;
  for (const r of list) {
    if (!r || typeof r !== 'object') { disagreed += 1; continue; }
    if (r.error) errors += 1;
    if (r.incomparable) incomparable += 1;
    if (r.overlay) overlay += 1;
    if (r.agree) agreed += 1; else disagreed += 1;
  }

  const reconciles = reconcilesAll(dimensions, list.length);

  return {
    total: list.length,
    agreed,
    disagreed,
    errors,
    incomparable,
    overlay,
    agreementRate: list.length ? agreed / list.length : null,
    dimensions,
    reconciles,
    factsSeen: Array.from(seen).sort(),
    // Said out loud: a run whose scenarios carry no facts cannot be sliced at all, and that is a
    // property of the RUN, not an empty result.
    factsMissing,
  };
}

/**
 * The cells worth a human's attention first: worst agreement rate, then worst price gap. Never invents
 * a threshold — it RANKS, and what counts as "bad enough to act on" is the tolerance decision that
 * belongs to the owner (master plan Part 4), not to a sort function.
 */
function worstCells(matrix, limit = 10) {
  const rows = [];
  for (const d of ((matrix && matrix.dimensions) || [])) {
    for (const c of d.cells) {
      if (!c.total || c.agreementRate == null) continue;
      rows.push({
        dimension: d.dimension, key: c.key, label: c.label, total: c.total,
        agreementRate: c.agreementRate, worstAbsMilli: c.priceDelta.worstAbsMilli,
      });
    }
  }
  rows.sort((a, b) => (a.agreementRate - b.agreementRate)
    || ((b.worstAbsMilli || 0) - (a.worstAbsMilli || 0))
    || (b.total - a.total));
  const n = Number.isInteger(limit) && limit > 0 ? limit : 10;
  return rows.slice(0, n);
}

module.exports = {
  buildParityMatrix, sliceBy, bandsFromProgram, worstCells, reconcilesAll,
  _internals: { bandsOf, bandLabel, bandIndex, emptyCell, addToCell, finishCell, MAX_CELLS_PER_DIMENSION, PRICE_KIND },
};
