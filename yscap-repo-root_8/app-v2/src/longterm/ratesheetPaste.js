// LT PPE — reading a rate-sheet grid out of a PASTE.
//
// WHY A PASTE. The source of a rate sheet is an Excel file (the Deephaven
// `Corr_Flow_Rate_Sheet` DSCR tab is the one in hand), and what a person actually
// has is a block of cells on the clipboard. A per-row form for a grid of a few
// hundred cells is a worse tool for the same job, and re-keying a price sheet by
// hand is how a digit moves.
//
// THE RULES, AND EVERY ONE OF THEM IS ABOUT NOT GUESSING:
//
//   1. IT NEVER DROPS A LINE SILENTLY. A line it cannot read is REPORTED with its
//      own line number and what was wrong with it. Skipping the unreadable ones is
//      how a sheet ends up quietly missing its top rate band, and nothing on the
//      screen would say so.
//   2. IT REFUSES, IT DOES NOT COERCE. `Number('')` is 0 and `Number('7,125')` is
//      NaN; a price of 0 written into a live sheet is a 100-point giveaway. Every
//      cell must read as a plain decimal or the line is refused.
//   3. IT FINDS DUPLICATE CELLS BEFORE THE DATABASE DOES. The grid is unique on
//      (rate, lock, product). The write is atomic now, so a duplicate can no longer
//      leave a half-written sheet — but a refusal from the database says
//      "duplicate key value violates constraint lt_ppe_base_price_cell_uk", while
//      this says which two lines collide and on what.
//   4. THE UNITS ARE THE MIGRATION'S, STATED ONCE. db/560: `note_rate_milli_pct` is
//      milli-percent (7.125% -> 7125) and `price_milli` is milli-points (102.850 ->
//      102850, par 100000). Both are ×1000 and both are INTEGER columns, so the
//      conversion ROUNDS. That is not decoration: a note rate of `8.005` gives
//      `8005.000000000001` in binary floating point, and an adjustment of `-2.047`
//      gives `-2047.0000000000002` — both plausible values, and both refused by an
//      INTEGER column unrounded. (Many nearby values, 7.125 and 102.850 among them,
//      happen to be exact; the guard is for the ones that are not.)
//   5. A HEADER ROW IS ALLOWED, ONCE, AT THE TOP. Excel copies the labels with the
//      cells. A non-numeric FIRST line is taken as a header; a non-numeric line
//      anywhere else is a problem, because by then it is far more likely to be a
//      merged cell or a section break that would silently shift the columns.
//
// PURE — no React, no fetch, no DOM. It is the whole reason the paste can be unit
// tested without a browser.

/** Split a pasted block into cells: Excel gives TABs; a CSV gives commas. */
function splitCells(line) {
  if (line.includes('\t')) return line.split('\t');
  if (line.includes(',')) return line.split(',');
  return line.trim().split(/\s{2,}/);          // last resort: a space-aligned dump
}

/**
 * A plain decimal, else null. Accepts a trailing % and surrounding spaces, and
 * a value wrapped in quotes (Excel does that to anything it thinks is text).
 * REFUSES a thousands separator rather than guessing which side of it is which.
 */
function decimal(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim();
  if (s.endsWith('%')) s = s.slice(0, -1).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Milli-units: ×1000, rounded, because the column is an INTEGER (rule 4). */
function milli(n) { return Math.round(n * 1000); }

/**
 * parseBasePrices(text) -> { rows, problems, headerSkipped }
 *   rows     — [{ noteRateMilliPct, lockDays, priceMilli, product }] ready to POST
 *   problems — [{ line, text, why }] every line that could not be used, and why
 *
 * Columns: rate, lock days, price, and an optional product label.
 */
export function parseBasePrices(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const rows = [];
  const problems = [];
  const seen = new Map();          // "rate|lock|product" -> the line that claimed it
  let headerSkipped = false;
  let firstContent = true;

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    if (!raw.trim()) return;                       // a blank line is not a problem
    const cells = splitCells(raw);
    // Named `noteRate` rather than `rate`: `format.js` exports a formatter called `rate`, and
    // `test-lt-pipeline-columns-pure.js` refuses ANY definition of that name anywhere in a
    // Long-Term front-end file — deliberately, because a second copy of a formatter is how one
    // screen comes to print 0.97% where another prints 97%. A local variable is not a formatter,
    // but the rule cannot see scope and the honest fix is the name, not a weaker rule. It is also
    // the more accurate name: this column IS the note rate.
    const noteRate = decimal(cells[0]);

    if (noteRate === null && firstContent) { headerSkipped = true; firstContent = false; return; }
    firstContent = false;

    if (noteRate === null) {
      problems.push({ line: lineNo, text: raw.trim(), why: 'the first column is not a rate' });
      return;
    }
    const lock = decimal(cells[1]);
    const price = decimal(cells[2]);
    if (lock === null) { problems.push({ line: lineNo, text: raw.trim(), why: 'no lock period' }); return; }
    if (!Number.isInteger(lock)) { problems.push({ line: lineNo, text: raw.trim(), why: 'the lock period is not a whole number of days' }); return; }
    if (price === null) { problems.push({ line: lineNo, text: raw.trim(), why: 'no price' }); return; }

    const product = String(cells[3] == null ? '' : cells[3]).trim();
    // A THOUSANDS SEPARATOR IN A COMMA-SPLIT LINE IS THE ONE COERCION THAT SURVIVES every check
    // above: "7.500,30,1,024.5" splits into four cells and the PRICE reads as a perfectly valid 1
    // — a 1.000 price on a live sheet, silently, where 1024.5 was meant. The tell is that the
    // fourth column is a product LABEL, so a fourth column that parses as a number is not a
    // product; it is the back half of a split number. Refused by SHAPE, so no plausible range for
    // a rate or a price has to be invented here (a range guessed too tight refuses a real sheet,
    // which is the expensive direction).
    if (product && decimal(product) !== null) {
      problems.push({
        line: lineNo, text: raw.trim(),
        why: 'the fourth column is a number, not a product name — check for a thousands separator in the price',
      });
      return;
    }
    const key = `${milli(noteRate)}|${lock}|${product}`;
    if (seen.has(key)) {
      problems.push({
        line: lineNo, text: raw.trim(),
        why: `the same cell is already on line ${seen.get(key)} (rate ${noteRate}, ${lock}-day lock${product ? `, ${product}` : ''})`,
      });
      return;
    }
    seen.set(key, lineNo);
    rows.push({ noteRateMilliPct: milli(noteRate), lockDays: lock, priceMilli: milli(price), product });
  });

  return { rows, problems, headerSkipped };
}

/**
 * parseAdjustments(text) -> { rows, problems, headerSkipped }
 *   Columns: code, dimension, min, max, adjustment (points).
 *
 * The band is written into the pair the DIMENSION names — `fico` fills ficoMin/Max,
 * `ltv` fills ltvMin/Max, `dscr` fills dscrMin/Max — because those are the columns
 * db/560 gives the engine to band on. A dimension with no band pair of its own is
 * REFUSED rather than written into a neighbouring one, which would silently price
 * an LTV adjustment off the borrower's credit score.
 */
const BAND_COLUMNS = { fico: ['ficoMin', 'ficoMax'], ltv: ['ltvMin', 'ltvMax'], dscr: ['dscrMin', 'dscrMax'] };

export function parseAdjustments(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const rows = [];
  const problems = [];
  let headerSkipped = false;
  let firstContent = true;

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    if (!raw.trim()) return;
    const cells = splitCells(raw).map((c) => String(c == null ? '' : c).trim());
    const [code, dimensionRaw, minRaw, maxRaw, adjRaw] = cells;
    const dimension = String(dimensionRaw || '').toLowerCase();
    const adj = decimal(adjRaw);

    // A HEADER HAS NO NUMBERS ANYWHERE — not merely a missing last column.
    //
    // Keying this on "the adjustment column does not parse" was wrong, and wrong in the module's own
    // worst direction: a genuine FIRST data row whose adjustment cell is blank ("a  dscr  1.0  1.25")
    // was silently swallowed as a header, so an LLPA nobody loaded left no trace at all — which is
    // precisely the dropped-line class every other rule here exists to prevent. A real header carries
    // labels in every column, so it has NO readable number in any of min/max/adjustment; a data row
    // missing only its amount still has its band, and is refused with a reason.
    if (firstContent && adj === null && decimal(minRaw) === null && decimal(maxRaw) === null) {
      headerSkipped = true; firstContent = false; return;
    }
    firstContent = false;

    if (!code) { problems.push({ line: lineNo, text: raw.trim(), why: 'no code' }); return; }
    if (!dimension) { problems.push({ line: lineNo, text: raw.trim(), why: 'no dimension' }); return; }
    if (!BAND_COLUMNS[dimension]) {
      problems.push({
        line: lineNo, text: raw.trim(),
        why: `"${dimensionRaw}" is not a dimension this grid can band on (fico, ltv or dscr)`,
      });
      return;
    }
    // Rule 2, and the one that matters most here: a blank adjustment must never
    // become 0. A zero-point LLPA reads exactly like one that was never loaded.
    if (adj === null) { problems.push({ line: lineNo, text: raw.trim(), why: 'no adjustment amount' }); return; }

    const min = decimal(minRaw);
    const max = decimal(maxRaw);
    if (minRaw && min === null) { problems.push({ line: lineNo, text: raw.trim(), why: 'the band start is not a number' }); return; }
    if (maxRaw && max === null) { problems.push({ line: lineNo, text: raw.trim(), why: 'the band end is not a number' }); return; }
    if (min !== null && max !== null && min >= max) {
      // Bands are half-open [min,max), so min === max matches nothing at all — a
      // rule that can never fire, which is worse than an error because it is silent.
      problems.push({ line: lineNo, text: raw.trim(), why: `the band ${min}–${max} can never match (the start must be below the end)` });
      return;
    }

    const [minCol, maxCol] = BAND_COLUMNS[dimension];
    rows.push({
      code, dimension, adjMilli: milli(adj),
      [minCol]: min, [maxCol]: max,
      priority: 0,
    });
  });

  return { rows, problems, headerSkipped };
}

/** Milli-points back to the points a person reads (1250 -> "1.25"). */
export function points(milliValue) {
  if (milliValue == null || !Number.isFinite(Number(milliValue))) return '—';
  return (Number(milliValue) / 1000).toFixed(3).replace(/\.?0+$/, '');
}

export default { parseBasePrices, parseAdjustments, points };
