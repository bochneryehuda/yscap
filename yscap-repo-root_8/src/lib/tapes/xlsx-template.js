'use strict';
/**
 * Dependency-free .xlsx TEMPLATE FILLER.
 *
 * Unlike src/lib/xlsx.js (which builds a brand-new one-sheet workbook from
 * scratch), this module takes an EXISTING .xlsx template — with all its
 * formulas, hidden calc sheets, styles, dropdowns and formatting — and writes
 * data ONLY into the cells of one target sheet, leaving every other byte of the
 * workbook untouched. That is exactly what a capital-provider "data tape"
 * needs: the investor's own spreadsheet (e.g. Fidelis's Pricing Matrix / Data
 * Tape) must stay identical, and we only drop our loan's numbers into its input
 * row so its own formula tabs recalculate.
 *
 * How it stays faithful:
 *   - A .xlsx is a ZIP of XML parts. We unzip (src/lib/zip.js), rewrite the ONE
 *     worksheet part that holds the data-entry row(s), optionally flip
 *     `fullCalcOnLoad` on so the formula tabs recompute when opened, and re-zip.
 *     No other part (the pricing tabs, the definitions tab, the hidden lookup
 *     engines, sharedStrings, styles) is modified — they round-trip byte-for-byte.
 *   - Values go in as INLINE strings / numbers / date-serials so we never have
 *     to touch sharedStrings.xml, and each cell carries the style index the
 *     template already uses for that column (currency, date, text…), so the
 *     result looks exactly like the blank template with our figures typed in.
 *
 * No native deps (Render builds cleanly with only express + pg).
 */
const { zip, unzip } = require('../zip');

// ---- column-letter helpers ------------------------------------------------
function colToIndex(letters) {
  let n = 0;
  const s = String(letters).toUpperCase();
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n; // 1-based (A=1)
}
function indexToCol(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// XML text escaping (mirrors src/lib/xlsx.js). Strips the XML-1.0-illegal
// control chars that cannot be entity-encoded, then escapes the five specials.
function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
// Neutralize a spreadsheet formula-injection payload (leading = + - @) in a text
// cell, exactly like src/lib/xlsx.js safeCell — an address/name that starts with
// one of those must never be evaluated as a formula in the investor's file.
function safeStr(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s;
}

// ---- Excel date serial (1900 date system, day 0 = 1899-12-30) -------------
// Accepts a JS Date, an ISO/'YYYY-MM-DD' string, or an epoch-ms number and
// returns the integer day serial Excel uses. UTC math avoids timezone drift
// (a date is a calendar day, never a moment in a zone).
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
function toExcelSerial(value) {
  let y, mo, d;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    y = value.getUTCFullYear(); mo = value.getUTCMonth(); d = value.getUTCDate();
  } else {
    const s = String(value).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); // ISO date (optionally with time)
    if (m) { y = +m[1]; mo = +m[2] - 1; d = +m[3]; }
    else {
      const dt = new Date(s);
      if (isNaN(dt.getTime())) return null;
      y = dt.getUTCFullYear(); mo = dt.getUTCMonth(); d = dt.getUTCDate();
    }
  }
  const serial = Math.round((Date.UTC(y, mo, d) - EXCEL_EPOCH_UTC) / 86400000);
  return serial > 0 ? serial : null; // guard against garbage/pre-1900 dates
}

// ---- single-cell XML ------------------------------------------------------
// spec: { col:'H', value, type, style }
//   type: 'n' number | 'd' date | 's' inline string | 'b' bool | 'f' formula | 'auto'
//   style: numeric cellXfs index from the template's styles.xml (optional)
//   styleMap: {col: styleIndex} inherited from the template row (fallback style)
// Returns { idx, xml } or null when the cell should be omitted entirely.
function cellXml(spec, rowNum, styleMap) {
  const idx = colToIndex(spec.col);
  const ref = spec.col + rowNum;
  // Style: an explicit spec.style wins; otherwise inherit the template row's own
  // style for this column (styleMap) so a wide sheet keeps its per-column formats
  // (currency/date/percent) without the caller hardcoding every index.
  const styleIdx = (spec.style != null && spec.style !== '') ? spec.style
    : (styleMap && styleMap[spec.col] != null ? styleMap[spec.col] : null);
  const sAttr = styleIdx != null ? ` s="${styleIdx}"` : '';
  let type = spec.type || 'auto';
  let v = spec.value;

  // Formula cell: a per-row formula. `{r}` is replaced with this row's number so
  // each loan row references its own cells (e.g. "AF{r}+AH{r}"). The value is
  // EITHER a formula STRING ("AF{r}+AH{r}") OR an object { f, v } that also carries
  // a CACHED computed value. A cached value makes the cell DISPLAY its number in
  // viewers that don't recalculate (Google Sheets / macOS Quick Look / Numbers /
  // Excel with calc off) — without it, a formula cell shows blank there. Excel's
  // fullCalcOnLoad still recomputes on open, so the cached value never disagrees as
  // long as we compute it from the SAME inputs the formula references. Escape only
  // XML specials, not quotes.
  if (type === 'f') {
    let formula = v; let cached = null;
    if (v && typeof v === 'object') { formula = v.f; cached = v.v; }
    if (formula == null || formula === '') return sAttr ? { idx, xml: `<c r="${ref}"${sAttr}/>` } : null;
    const f = String(formula).replace(/\{r\}/g, String(rowNum))
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Only a FINITE numeric cached value is emitted (a text formula result would
    // need a t="str" cell type; our cached formulas are all numbers). A null /
    // non-finite cached value → just the formula, exactly as before.
    const vXml = (typeof cached === 'number' && isFinite(cached)) ? `<v>${cached}</v>` : '';
    return { idx, xml: `<c r="${ref}"${sAttr}><f>${f}</f>${vXml}</c>` };
  }

  const isBlank = v == null || v === '';
  if (isBlank) {
    // Preserve the template's styled-but-empty look: emit a bare styled cell so
    // the column keeps its currency/date/text format even when we have no value.
    if (sAttr) return { idx, xml: `<c r="${ref}"${sAttr}/>` };
    return null; // no value and no style → omit the cell (default formatting)
  }

  if (type === 'auto') type = (typeof v === 'number' && isFinite(v)) ? 'n' : 's';

  if (type === 'n') {
    const num = Number(v);
    if (!isFinite(num)) { // fall back to text rather than emit an invalid number
      return { idx, xml: `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(safeStr(v))}</t></is></c>` };
    }
    return { idx, xml: `<c r="${ref}"${sAttr}><v>${num}</v></c>` };
  }
  if (type === 'd') {
    const serial = toExcelSerial(v);
    if (serial == null) return sAttr ? { idx, xml: `<c r="${ref}"${sAttr}/>` } : null;
    return { idx, xml: `<c r="${ref}"${sAttr}><v>${serial}</v></c>` };
  }
  if (type === 'b') {
    return { idx, xml: `<c r="${ref}"${sAttr} t="b"><v>${v ? 1 : 0}</v></c>` };
  }
  // string
  return { idx, xml: `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(safeStr(v))}</t></is></c>` };
}

// Build one <row> element for rowNum from an array of cell specs, cloning the
// row-level attributes (style, height, customFormat) from a template row's
// opening tag so injected/added rows look identical to the template's data row.
function rowXml(rowNum, cells, templateRowAttrs, spans, styleMap) {
  const parts = cells
    .map((c) => cellXml(c, rowNum, styleMap))
    .filter(Boolean)
    .sort((a, b) => a.idx - b.idx)
    .map((c) => c.xml)
    .join('');
  // Clone attrs from the template data row but force our own r= and spans=.
  // Strip a trailing "/" too: if the template's data row is SELF-CLOSING
  // (<row r="2" .../>), the attr capture includes the slash — leaving it would
  // emit a self-closing tag with dangling cells.
  let attrs = (templateRowAttrs || '')
    .replace(/\s*\br="\d+"/, '')
    .replace(/\s*\bspans="[^"]*"/, '')
    .replace(/\/\s*$/, '')
    .trim();
  const spansAttr = spans ? ` spans="${spans}"` : '';
  return `<row r="${rowNum}"${spansAttr}${attrs ? ' ' + attrs : ''}>${parts}</row>`;
}

/**
 * fillXlsxTemplate(templateBuf, opts) -> Buffer
 *
 * opts:
 *   sheetPart   {string}  zip part of the target sheet, e.g. 'xl/worksheets/sheet5.xml'
 *   firstRow    {number}  first data row (e.g. 2 — row 1 is the header)
 *   rows        {Array<Array<cellSpec>>}  one inner array per loan/data row
 *   lastCol     {string}  last column letter (e.g. 'AV') — used for dimension/spans
 *   extendValidations {boolean} widen each dataValidation sqref to cover all rows
 *   forceFullCalc {boolean} set fullCalcOnLoad on workbook.xml (default true)
 *   inheritStyles {boolean} inherit each column's style from the template's first
 *                 data row (so a wide sheet keeps its per-column formats without
 *                 the caller specifying every style index)
 */
function fillXlsxTemplate(templateBuf, opts) {
  const {
    sheetPart,
    firstRow = 2,
    rows = [],
    lastCol = 'AV',
    extendValidations = true,
    forceFullCalc = true,
    inheritStyles = false,
  } = opts || {};
  if (!sheetPart) throw new Error('fillXlsxTemplate: sheetPart is required');

  const parts = unzip(templateBuf);
  const sheet = parts.find((p) => p.name === sheetPart);
  if (!sheet) throw new Error(`fillXlsxTemplate: sheet part not found: ${sheetPart}`);

  let xml = sheet.data.toString('utf8');
  const spans = `1:${colToIndex(lastCol)}`;

  // Capture the template's first data row opening-tag attributes to clone onto
  // every row we write (so multi-row/bulk output matches the single-row look).
  const firstRowOpen = xml.match(new RegExp(`<row r="${firstRow}"([^>]*)>`));
  const templateRowAttrs = firstRowOpen ? firstRowOpen[1] : ' customFormat="1"';

  // Optionally learn the template row's per-column styles once (from the ORIGINAL
  // xml, before any replacement) so every written row — including bulk rows the
  // template doesn't physically have — inherits the sample row's exact formats.
  let styleMap = null;
  if (inheritStyles) {
    styleMap = {};
    const rowM = xml.match(new RegExp(`<row r="${firstRow}"[^>]*>[\\s\\S]*?</row>`));
    if (rowM) {
      const re = /<c r="([A-Z]+)\d+"[^>]*?\bs="(\d+)"/g;
      let m;
      while ((m = re.exec(rowM[0]))) styleMap[m[1]] = Number(m[2]);
    }
  }

  // Build and splice each data row.
  rows.forEach((cells, i) => {
    const rowNum = firstRow + i;
    const newRow = rowXml(rowNum, cells, templateRowAttrs, spans, styleMap);
    // A self-closing row (<row r="N" .../>) must be matched FIRST: it also
    // satisfies the open/close regex (whose `[^>]*` eats the slash and whose
    // `[\s\S]*?</row>` then runs into the NEXT row), which would swallow every
    // row in between and corrupt the sheet. Test the self-closing form first.
    const selfClose = new RegExp(`<row r="${rowNum}"[^>]*/>`);
    const openRe = new RegExp(`<row r="${rowNum}"[^>]*>[\\s\\S]*?</row>`);
    if (selfClose.test(xml)) {
      xml = xml.replace(selfClose, newRow);
    } else if (openRe.test(xml)) {
      xml = xml.replace(openRe, newRow);
    } else {
      // Row doesn't exist in the template — insert it in row order just before
      // </sheetData> (rows beyond the template's pre-existing ones, e.g. bulk).
      xml = xml.replace('</sheetData>', `${newRow}</sheetData>`);
    }
  });

  // Grow <dimension> to cover any added rows, but NEVER shrink it on EITHER axis
  // — the template may keep stray styled cells beyond our data (below the last row
  // AND to the right of lastCol), and a used-range that excludes real cells can
  // trip strict readers into a repair prompt. Take the max of the existing end
  // column/row and what we wrote.
  const wantMax = Math.max(firstRow + rows.length - 1, firstRow);
  xml = xml.replace(/<dimension ref="([A-Z]+\d+):([A-Z]+)(\d+)"\/>/, (m, start, endCol, endRow) => {
    const col = colToIndex(endCol) >= colToIndex(lastCol) ? endCol : lastCol;
    const row = Math.max(Number(endRow), wantMax);
    return `<dimension ref="${start}:${col}${row}"/>`;
  });

  // Widen dropdown (data-validation) ranges to cover every written row so the
  // investor sees the same picklists on each loan row, not just the first.
  if (extendValidations && rows.length > 1) {
    const lastData = firstRow + rows.length - 1;
    xml = xml.replace(/sqref="([A-Z]+)(\d+)"/g, (full, col, r) => {
      if (Number(r) === firstRow) return `sqref="${col}${firstRow}:${col}${lastData}"`;
      return full;
    });
  }

  sheet.data = Buffer.from(xml, 'utf8');

  // Force the formula tabs (pricing / eligibility) to recompute on open. We only
  // added input values; the workbook's own formulas are untouched, so a full
  // recalc yields the investor's own pricing for our loan.
  if (forceFullCalc) setFullCalcOnLoad(parts);

  return zip(parts);
}


// ===========================================================================
// CELL-LEVEL FILL — write single cells inside rows that already hold content
// ===========================================================================
/*
 * `fillXlsxTemplate` above replaces WHOLE ROWS, which is right for a data tape
 * (row 1 headers, row 2..N one loan each — nothing else lives on those rows).
 * An investor's PRICING / ELIGIBILITY tool is the other shape: its input cells
 * sit in one column (C6, C7, C9 …) on rows that ALSO carry the printed label in
 * column B and the hidden engine's helper formulas in J/K. Replacing such a row
 * would delete the label and the formula that reads the cell we just wrote.
 *
 * So this half writes CELLS: it swaps exactly the `<c>` elements named, leaves
 * every other cell in the row byte-identical, and never touches another part of
 * the workbook. Same guarantees as the row filler — inline strings (so
 * sharedStrings.xml round-trips), the template's own style index inherited per
 * cell (so a currency/percent cell keeps its format), and formula-injection
 * neutralized on text.
 */

// One cell reference → { col, row }. Returns null for anything that is not an
// A1 reference, so a bad map entry is refused instead of silently skipped.
function parseRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(String(ref || '').trim().toUpperCase());
  return m ? { col: m[1], row: Number(m[2]) } : null;
}

// The `<c r="REF" …>` element for ONE reference, matched safely. The
// SELF-CLOSING form is tested FIRST for the same reason the row filler tests it
// first: `[^>]*` happily eats the trailing slash, after which `[\s\S]*?</c>`
// runs on to the NEXT cell's closing tag and swallows everything in between.
function cellRe(ref) {
  return new RegExp(`<c r="${ref}"(?:\\s[^>]*?)?/>|<c r="${ref}"(?:\\s[^>]*?)?>[\\s\\S]*?</c>`);
}
// The style index a cell already carries in the template (null when it has none).
function styleOf(cellXmlStr) {
  const m = /\ss="(\d+)"/.exec(cellXmlStr || '');
  return m ? Number(m[1]) : null;
}

/**
 * cellElement(ref, spec, inheritedStyle) → the `<c>` XML for one written cell.
 *
 * spec: { value, type, style }
 *   type 'n' number | 'd' date serial | 's' inline string | 'b' bool
 *        | 'blank' erase the value but KEEP the cell's formatting
 *        | 'auto' (default) number when the value is a finite number, else string
 *
 * A null/'' value is written as `blank` — an input cell we cannot fill must end
 * up EMPTY, never carrying whatever the vendor's sample loan left in it.
 */
function cellElement(ref, spec, inheritedStyle) {
  const styleIdx = (spec && spec.style != null && spec.style !== '') ? spec.style : inheritedStyle;
  const sAttr = styleIdx != null ? ` s="${styleIdx}"` : '';
  let type = (spec && spec.type) || 'auto';
  const v = spec ? spec.value : null;
  if (type === 'blank' || v == null || v === '') return `<c r="${ref}"${sAttr}/>`;
  if (type === 'auto') type = (typeof v === 'number' && isFinite(v)) ? 'n' : 's';
  if (type === 'n') {
    const num = Number(v);
    if (!isFinite(num)) return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(safeStr(v))}</t></is></c>`;
    return `<c r="${ref}"${sAttr}><v>${num}</v></c>`;
  }
  if (type === 'd') {
    const serial = toExcelSerial(v);
    if (serial == null) return `<c r="${ref}"${sAttr}/>`;
    return `<c r="${ref}"${sAttr}><v>${serial}</v></c>`;
  }
  if (type === 'b') return `<c r="${ref}"${sAttr} t="b"><v>${v ? 1 : 0}</v></c>`;
  return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(safeStr(v))}</t></is></c>`;
}

// Put one cell into a row's XML: replace the existing element when the template
// has that cell, otherwise INSERT it in column order (a spreadsheet's cells must
// be in ascending column order within a row, or Excel reports the file as
// damaged). Returns the new row XML.
function putCellInRow(rowXmlStr, ref, spec) {
  const parsed = parseRef(ref);
  const re = cellRe(ref);
  const existing = re.exec(rowXmlStr);
  if (existing) {
    return rowXmlStr.slice(0, existing.index)
      + cellElement(ref, spec, styleOf(existing[0]))
      + rowXmlStr.slice(existing.index + existing[0].length);
  }
  const el = cellElement(ref, spec, null);
  const want = colToIndex(parsed.col);
  // First cell to the RIGHT of ours — insert before it.
  const scan = /<c r="([A-Z]+)\d+"/g;
  let m;
  while ((m = scan.exec(rowXmlStr))) {
    if (colToIndex(m[1]) > want) return rowXmlStr.slice(0, m.index) + el + rowXmlStr.slice(m.index);
  }
  const close = rowXmlStr.lastIndexOf('</row>');
  if (close > -1) return rowXmlStr.slice(0, close) + el + rowXmlStr.slice(close);
  // A self-closing empty row (<row r="9" …/>) — reopen it around the new cell.
  return rowXmlStr.replace(/\/>\s*$/, `>${el}</row>`);
}

// Strip the CACHED RESULT from every formula cell on a sheet, keeping the
// formula itself.
//
// Why: the vendor ships their tool with a SAMPLE loan typed in, so every formula
// cell carries that sample's answer as a cached value. We overwrite the inputs;
// the cached answers are then stale. Excel recalculates on open (fullCalcOnLoad
// below) and replaces them — but a viewer that does NOT recalculate would render
// the sample's "ELIGIBLE" over OUR loan's inputs, which is the one failure mode
// nobody would catch by looking. Dropping the cached value makes such a viewer
// show an EMPTY cell instead of a wrong one: fail closed, never fail plausible.
// (The row filler above does the opposite for the cells IT writes, and for the
// same reason — there the cached value is one we computed from the same inputs
// the formula reads, so it cannot disagree.)
function clearCachedFormulaValues(sheetXml) {
  return sheetXml.replace(/<c (?:[^>]*?)\/>|<c (?:[^>]*?)>[\s\S]*?<\/c>/g, (cell) => {
    if (cell.indexOf('<f') === -1) return cell;      // not a formula cell
    return cell.replace(/<v>[\s\S]*?<\/v>/g, '');
  });
}

/**
 * fillXlsxCells(templateBuf, opts) -> Buffer
 *
 * opts:
 *   sheetPart    {string}  zip part of the sheet to write into
 *   cells        {Object}  { 'C6': { value, type, style }, … } — A1 refs
 *   clearCached  {boolean} drop stale cached formula results on that sheet
 *   forceFullCalc{boolean} set fullCalcOnLoad on workbook.xml (default true)
 *
 * Every other zip part — the pricing tabs, the hidden lookup engine, styles,
 * sharedStrings, the dropdown definitions — round-trips byte-for-byte.
 */
function fillXlsxCells(templateBuf, opts) {
  const { sheetPart, cells = {}, clearCached = false, forceFullCalc = true } = opts || {};
  if (!sheetPart) throw new Error('fillXlsxCells: sheetPart is required');

  const parts = unzip(templateBuf);
  const sheet = parts.find((p) => p.name === sheetPart);
  if (!sheet) throw new Error(`fillXlsxCells: sheet part not found: ${sheetPart}`);
  let xml = sheet.data.toString('utf8');

  // Group the writes by row so each row's XML is rewritten once.
  const byRow = new Map();
  for (const ref of Object.keys(cells)) {
    const parsed = parseRef(ref);
    if (!parsed) throw new Error(`fillXlsxCells: not a cell reference: ${ref}`);
    if (!byRow.has(parsed.row)) byRow.set(parsed.row, []);
    byRow.get(parsed.row).push(ref);
  }

  let maxRow = 0; let maxCol = 0;
  for (const [rowNum, refs] of Array.from(byRow.entries()).sort((a, b) => a[0] - b[0])) {
    const selfClose = new RegExp(`<row r="${rowNum}"(?:\\s[^>]*?)?/>`);
    const openClose = new RegExp(`<row r="${rowNum}"(?:\\s[^>]*?)?>[\\s\\S]*?</row>`);
    const m = selfClose.exec(xml) || openClose.exec(xml);
    let rowXmlStr;
    let start; let end;
    if (m) { rowXmlStr = m[0]; start = m.index; end = m.index + m[0].length; }
    else {
      // The template has no such row — build an empty one and splice it in row
      // order (never appended blindly: rows must ascend).
      rowXmlStr = `<row r="${rowNum}"></row>`;
      const scan = /<row r="(\d+)"/g;
      let rm; let at = -1;
      while ((rm = scan.exec(xml))) { if (Number(rm[1]) > rowNum) { at = rm.index; break; } }
      if (at === -1) at = xml.indexOf('</sheetData>');
      if (at === -1) throw new Error('fillXlsxCells: sheet has no <sheetData>');
      start = at; end = at;
    }
    for (const ref of refs) {
      rowXmlStr = putCellInRow(rowXmlStr, ref, cells[ref]);
      maxCol = Math.max(maxCol, colToIndex(parseRef(ref).col));
    }
    maxRow = Math.max(maxRow, rowNum);
    xml = xml.slice(0, start) + rowXmlStr + xml.slice(end);
  }

  if (clearCached) xml = clearCachedFormulaValues(xml);

  // Grow <dimension> if we wrote outside it; NEVER shrink it (a used range that
  // excludes real cells trips strict readers into a repair prompt).
  xml = xml.replace(/<dimension ref="([A-Z]+\d+):([A-Z]+)(\d+)"\/>/, (full, startRef, endCol, endRow) => {
    const col = colToIndex(endCol) >= maxCol ? endCol : indexToCol(maxCol);
    const row = Math.max(Number(endRow), maxRow);
    return `<dimension ref="${startRef}:${col}${row}"/>`;
  });

  sheet.data = Buffer.from(xml, 'utf8');
  if (forceFullCalc) setFullCalcOnLoad(parts);
  // DEFLATE: a pricing/eligibility workbook carries whole rate-matrix sheets, and
  // re-zipping one STORED turns the 270 KB file the investor sent us into a 2.1 MB
  // one. What goes back to them should be the same kind of file they sent.
  return zip(parts, new Date(), { deflate: true });
}

// Force Excel to recompute every formula when the workbook opens. We only wrote
// input values; the workbook's own formulas are untouched, so a full recalc
// yields the vendor's own pricing/eligibility for OUR loan.
function setFullCalcOnLoad(parts) {
  const wb = parts.find((p) => p.name === 'xl/workbook.xml');
  if (!wb) return;
  let w = wb.data.toString('utf8');
  if (/<calcPr\b/.test(w)) {
    if (!/fullCalcOnLoad="1"/.test(w)) {
      w = w.replace(/<calcPr\b([^>]*?)\s*\/>/, (m, attrs) => `<calcPr${attrs} fullCalcOnLoad="1"/>`);
    }
  } else {
    w = w.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
  }
  wb.data = Buffer.from(w, 'utf8');
}

module.exports = {
  fillXlsxTemplate, fillXlsxCells,
  toExcelSerial, colToIndex, indexToCol, xmlEsc, safeStr,
  // exposed for the unit tests that pin the cell-level writer's edge cases
  _cells: { parseRef, cellElement, putCellInRow, clearCachedFormulaValues },
};
