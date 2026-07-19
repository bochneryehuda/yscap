'use strict';
/**
 * Shared, dependency-free .xlsx builder (OOXML, STORE-zipped) — the same technique the TPR
 * export uses, factored out so the Sitewire draw exports (SOW reallocation Version 1 vs 2, the
 * draw audit trail, a dispute packet) produce a REAL Excel workbook, not a CSV. No native deps
 * (Render builds cleanly with only express + pg). `rows` is an array of arrays; a finite number
 * is written as a numeric cell, everything else as an inline string. Returns a Buffer.
 */
const { zip } = require('./zip');

const xmlEsc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
function colLetter(n) { let s = ''; n += 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

// Neutralize a spreadsheet formula-injection payload on a leading =,+,-,@ in a string cell.
function safeCell(v) {
  if (typeof v === 'number' && isFinite(v)) return v;
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s;
}

function buildXlsx(rows, sheetName = 'Sheet1') {
  const sheetRows = rows.map((cells, ri) => {
    const r = ri + 1;
    const cs = cells.map((raw, ci) => {
      const val = safeCell(raw);
      const ref = colLetter(ci) + r;
      if (typeof val === 'number' && isFinite(val)) return `<c r="${ref}"><v>${val}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(val)}</t></is></c>`;
    }).join('');
    return `<row r="${r}">${cs}</row>`;
  }).join('');

  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '</Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + `<sheets><sheet name="${xmlEsc(String(sheetName).slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets>`
      + '</workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '</Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + `<sheetData>${sheetRows}</sheetData></worksheet>` },
  ].map((f) => ({ name: f.name, data: Buffer.from(f.data, 'utf8') }));
  return zip(files);
}

module.exports = { buildXlsx };
