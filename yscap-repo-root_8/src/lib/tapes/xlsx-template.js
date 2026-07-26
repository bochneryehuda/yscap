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
  if (forceFullCalc) {
    const wb = parts.find((p) => p.name === 'xl/workbook.xml');
    if (wb) {
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
  }

  return zip(parts);
}

module.exports = { fillXlsxTemplate, toExcelSerial, colToIndex, indexToCol, xmlEsc, safeStr };
