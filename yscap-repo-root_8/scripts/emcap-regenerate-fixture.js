#!/usr/bin/env node
'use strict';
/**
 * EMCAP workbook -> committed pricing artifacts: the regeneration pipeline.
 *
 * The Silver Program's rates/tier-grid are transcribed from the note buyer's
 * "RTL Seller Pricing & Eligibility Tool v1" Excel workbook. Two committed
 * artifacts are DERIVED from that workbook and must stay reproducible from it:
 *
 *   (1) scripts/fixtures/emcap-pricing-tool-v1.json
 *       - "rates": every priced grid cell of the workbook's HIDDEN "Engine"
 *         sheet (defined names RateKeys/RateVals -> columns A/B, rows 2+):
 *         9-part key `mkt|size|prod|purp|term|tier|AR band|FICO band|LTC band`
 *         -> note-buyer grid rate (1,555 cells in v1).
 *       - "tierGrid": the Engine sheet's TG* columns (E=key, F=maxloan,
 *         G=minfico, H=maxacq, I=maxar, J=maxltc; 18 rows; absent/"NA" -> null).
 *       Serialization is BYTE-EXACT (key-sorted, one entry per line, no
 *       indentation, `": "` separator, no trailing newline) so a regeneration
 *       from the same workbook reproduces the committed file bit-for-bit.
 *
 *   (2) The RATE_BLOCKS + TG literals inside web/v2/tools/silver-program.js
 *       (and its 5 byte-identical sibling copies). RATE_BLOCKS packs the rates
 *       into the fixed 54-slot block geometry (3 AR x 3 FICO x 6 LTC per
 *       `mkt|size|prod|purp|term|tier` block; value = rate / 0.000125, an
 *       integer on the 0.0125% lattice; 0 = no priced cell). This tool
 *       COMPILES those literals from the workbook and VERIFIES them against
 *       the live engine text -- it NEVER writes an engine file (the engines
 *       are frozen; updating them is a human step with owner authorization,
 *       see docs/SILVER-PROGRAM-EMCAP.md "Regenerating from a new workbook").
 *
 * Source-of-truth precedence (owner-accepted): the hidden Engine sheet governs.
 * The display tab "EMCAP_Pricing Matrix" (tab 2) shows 251 priced cells the
 * Engine sheet deliberately omits -- 84 BRIDGE cells under the 75.01%-80.00%
 * AR-LTV display band (the Engine sheet never prices AR above 75%) and 167
 * 24-month REFINANCE cells (the Engine sheet carries no R|24 keys, so the
 * workbook's own Pricing Tool cannot quote them either). The cross-source
 * verifier in --check re-derives tab 2 from scratch and FAILS on any
 * divergence beyond exactly that expected list, so a future workbook update
 * surfaces every new difference explicitly.
 *
 * ARCHIVED SOURCE WORKBOOK (committed next to the fixture):
 *   scripts/fixtures/EMCAP_Pricing_Tool_v1.xlsx
 *   sha256 432ff2d8c34bd28ca159aae44806177afa2607f5669cd229e5b885942535182b
 *   (EMCAP_Pricing_Tool_v1_33.xlsx, June 2026 guideline version -- the exact
 *   byte-identical file the committed fixture + engine literals were built
 *   from. If you archive a NEW workbook version, update ARCHIVE_SHA256 below.)
 *
 * USAGE
 *   node scripts/emcap-regenerate-fixture.js [modes] [--xlsx <path>|<path>]
 *
 *   (no mode flags)   CHECK-ONLY default: runs --check AND --blocks, writes
 *                     nothing, exit 0 clean / 1 on any drift.
 *   --check           Extract the Engine sheet, serialize, and byte-diff
 *                     against the committed fixture (per-key diff on
 *                     mismatch); plus the tab-2 cross-source verification.
 *   --blocks          Compile the RATE_BLOCKS + TG literals from the workbook
 *                     and verify the LIVE engine copies carry exactly them
 *                     (string extraction + a semantic reconstruction check).
 *   --write           Rewrite the fixture JSON from the workbook (refused
 *                     while the cross-source check reports an UNEXPECTED
 *                     divergence -- resolve/confirm those first). Never
 *                     touches an engine file: when the engine literals drift,
 *                     it prints the exact human procedure instead.
 *   --out <path>      Alternate output path for --write (default: the
 *                     committed fixture).
 *   --emit-blocks <path>  Write the freshly compiled RATE_BLOCKS + TG literal
 *                     text to <path> (for the human engine-update step).
 *   --xlsx <path>     Source workbook (default: the archived one). A bare
 *                     positional argument works too.
 *
 * Exit codes: 0 = clean, 1 = verification failure / refused write, 2 = usage
 * or I/O error. Pure Node (node:zlib inflate + a minimal central-directory
 * ZIP reader) -- no python, no npm dependencies, no network.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const REPO_ROOT = path.join(__dirname, '..');
const ARCHIVE_XLSX = path.join(__dirname, 'fixtures', 'EMCAP_Pricing_Tool_v1.xlsx');
const ARCHIVE_SHA256 = '432ff2d8c34bd28ca159aae44806177afa2607f5669cd229e5b885942535182b';
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'emcap-pricing-tool-v1.json');
const ENGINE_MAIN = path.join(REPO_ROOT, 'web', 'v2', 'tools', 'silver-program.js');
const ENGINE_COPIES = [
  'web/v2/tools/silver-program.js',
  'web/tools/silver-program.js',
  'web/portal/engines/silver-program.js',
  'web/v2/portal/engines/silver-program.js',
  'app/public/engines/silver-program.js',
  'app-v2/public/engines/silver-program.js'
];

/* ---------------- fixed grid geometry (the frozen engine's band contract) ----------------
   A workbook whose Engine sheet uses any band OUTSIDE these lists is a GEOMETRY
   change: the block compiler fails loudly and the engine needs a human rework
   (new band arrays + block layout), not a regeneration. */
const AR_BANDS = ['<64.99%', '65.00%-70.00%', '70.01%-75.00%'];
const FICO_BANDS_12 = ['FICO 700+', 'FICO 660-699', 'FICO 640-659']; // tiers 1-2
const FICO_BANDS_3 = ['FICO 700+', 'FICO 680-699', 'FICO 640-679']; // tier 3
const LTC_BANDS = ['<74.99%', '75.00%-80.00%', '80.01%-85.00%', '85.01%-87.50%', '87.51%-89.99%', '90.00%-92.50%'];
const RATE_UNIT = 0.000125; // RATE_BLOCKS stores rate / 0.000125 (0.0125% lattice)
const TG_PRODUCTS = ['FF', 'GUC', 'BR'];
const TG_PURPOSES = ['P', 'R'];
const TG_TIERS = [1, 2, 3];

/* ---------------- the KNOWN, ACCEPTED Engine-vs-tab-2 differences ----------------
   Tab 2 prices exactly these classes of cells that the hidden Engine sheet
   (and therefore the fixture + the frozen engine) deliberately omits. Counts
   are pinned: if a new workbook changes them IN EITHER DIRECTION the check
   fails and a human must re-confirm the contract with the owner, then update
   this table. */
const EXPECTED_TAB2_ONLY = {
  bridge_ar_7501: {
    count: 84,
    describe: 'BRIDGE display cells under the 75.01%-80.00% AR-LTV band (Engine sheet prices AR only to 75%)',
    match: (r) => r.prod === 'BR' && r.ar === '75.01%-80.00%'
  },
  refi24: {
    count: 167,
    describe: '24-month REFINANCE cells (Engine sheet carries no R|24 keys; the workbook Pricing Tool cannot quote them)',
    match: (r) => r.purp === 'R' && r.term === '24'
  }
};

/* =====================================================================
 * Minimal ZIP reader (central directory based; STORE + DEFLATE)
 * ===================================================================== */
function readZipEntries(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('readZipEntries: expected a Buffer');
  // Find the End Of Central Directory record (scan back through max comment).
  const MIN_EOCD = 22;
  let eocd = -1;
  const stop = Math.max(0, buf.length - MIN_EOCD - 65535);
  for (let i = buf.length - MIN_EOCD; i >= stop; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP: end-of-central-directory record not found (not a zip/xlsx?)');
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOfs = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOfs === 0xffffffff) {
    throw new Error('ZIP: zip64 archive not supported by this minimal reader');
  }
  if (cdOfs + cdSize > buf.length) throw new Error('ZIP: central directory out of bounds');
  const entries = new Map();
  let p = cdOfs;
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP: bad central-directory signature at ' + p);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOfs = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (flags & 0x1) throw new Error('ZIP: encrypted entry not supported: ' + name);
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOfs === 0xffffffff) {
      throw new Error('ZIP: zip64 entry not supported: ' + name);
    }
    // Local header gives the true data offset (its name/extra can differ from CD).
    if (buf.readUInt32LE(localOfs) !== 0x04034b50) throw new Error('ZIP: bad local-header signature for ' + name);
    const lNameLen = buf.readUInt16LE(localOfs + 26);
    const lExtraLen = buf.readUInt16LE(localOfs + 28);
    const dataOfs = localOfs + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataOfs, dataOfs + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error('ZIP: unsupported compression method ' + method + ' for ' + name);
    if (data.length !== uncompSize) {
      throw new Error('ZIP: size mismatch for ' + name + ' (got ' + data.length + ', header says ' + uncompSize + ')');
    }
    entries.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/* =====================================================================
 * SpreadsheetML parsing (regex-based, mirrors the verified extraction)
 * ===================================================================== */
function decodeXml(s) {
  // Same replacement set/order as the verified extraction scripts.
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function loadSharedStrings(entries) {
  const xml = entries.get('xl/sharedStrings.xml');
  if (!xml) return [];
  const out = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml.toString('utf8')))) {
    const parts = [];
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(m[1]))) parts.push(t[1]);
    out.push(decodeXml(parts.join('')));
  }
  return out;
}

/** Parse one worksheet into a cell map: "A1" -> { t, v, f } (v decoded/typed). */
function parseSheetCells(xmlBuf, strings) {
  const xml = xmlBuf.toString('utf8');
  const cells = new Map();
  const re = /<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const ref = m[1];
    const attrs = m[2];
    const inner = m[3] || '';
    const tm = /t="([^"]+)"/.exec(attrs);
    const t = tm ? tm[1] : 'n';
    const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
    const fm = /<f[^>]*>([\s\S]*?)<\/f>/.exec(inner);
    let val = null;
    if (vm) {
      const raw = vm[1];
      if (t === 's') {
        const idx = Number(raw);
        if (!Number.isInteger(idx) || idx < 0 || idx >= strings.length) {
          throw new Error('sheet parse: bad shared-string index ' + raw + ' at ' + ref);
        }
        val = strings[idx];
      } else if (t === 'str' || t === 'e') {
        val = decodeXml(raw);
      } else { // 'n', 'b', untyped
        const n = raw.trim() === '' ? NaN : Number(raw);
        val = Number.isFinite(n) ? n : decodeXml(raw);
      }
    }
    cells.set(ref, { t, v: val, f: fm ? decodeXml(fm[1]) : null });
  }
  // sheet dimension (used as the row ceiling for the matrix walk)
  const dm = /<dimension ref="[A-Z]+\d+:([A-Z]+)(\d+)"\s*\/>/.exec(xml);
  const maxRow = dm ? Number(dm[2]) : null;
  return { cells, maxRow };
}

function colNum(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function colName(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** Resolve sheet name -> zip entry path via workbook.xml + its rels. */
function workbookSheetMap(entries) {
  const wb = entries.get('xl/workbook.xml');
  const rels = entries.get('xl/_rels/workbook.xml.rels');
  if (!wb || !rels) throw new Error('xlsx: missing xl/workbook.xml or its rels');
  const relMap = new Map();
  {
    const re = /<Relationship\b([^>]*?)\/>/g;
    let m;
    const relsXml = rels.toString('utf8');
    while ((m = re.exec(relsXml))) {
      const id = /Id="([^"]+)"/.exec(m[1]);
      const target = /Target="([^"]+)"/.exec(m[1]);
      if (id && target) relMap.set(id[1], target[1]);
    }
  }
  const sheets = [];
  {
    const re = /<sheet\b([^>]*?)\/>/g;
    let m;
    const wbXml = wb.toString('utf8');
    while ((m = re.exec(wbXml))) {
      const name = /name="([^"]+)"/.exec(m[1]);
      const rid = /r:id="([^"]+)"/.exec(m[1]);
      const state = /state="([^"]+)"/.exec(m[1]);
      if (!name || !rid) continue;
      let target = relMap.get(rid[1]) || '';
      target = target.replace(/^\//, '');
      if (!target.startsWith('xl/')) target = 'xl/' + target;
      sheets.push({ name: decodeXml(name[1]), state: state ? state[1] : 'visible', entry: target });
    }
  }
  return sheets;
}

function findSheet(sheets, wanted) {
  if (wanted === 'engine') {
    let s = sheets.find((x) => x.name === 'Engine');
    if (!s) {
      const hidden = sheets.filter((x) => x.state === 'hidden');
      if (hidden.length === 1) s = hidden[0];
    }
    if (!s) throw new Error('workbook: no "Engine" sheet (and no single hidden sheet) -- cannot extract rates');
    return s;
  }
  if (wanted === 'matrix') {
    let s = sheets.find((x) => x.name === 'EMCAP_Pricing Matrix');
    if (!s) s = sheets.find((x) => /Pricing Matrix/i.test(x.name));
    if (!s) throw new Error('workbook: no "EMCAP_Pricing Matrix" sheet -- cannot run the cross-source check');
    return s;
  }
  throw new Error('findSheet: unknown wanted=' + wanted);
}

/* =====================================================================
 * Engine sheet -> fixture data  { rates, tierGrid }
 * ===================================================================== */
/**
 * SERIALIZATION ACCOMMODATION (the one number-formatting subtlety):
 * Excel caches computed cell values as full-precision doubles -- e.g. the
 * Engine sheet stores `8.6250000000000005E-2` for an intended 8.625% because
 * the tab-2 formula chain landed 1 ULP off the clean decimal. The committed
 * fixture stores the INTENDED grid decimals (0.08625), so extraction snaps
 * every numeric cell to 6 decimal places. Every real grid step is >= 0.0125%
 * (1.25e-4) and every tier-grid value has <= 3 decimals, so this collapses
 * only sub-1e-6 float noise -- it can never mask a real guideline change.
 */
function cleanNumber(v) {
  return Number(v.toFixed(6));
}
function parseEngineTab(cells) {
  const rates = {};
  const srcCells = {};
  let r = 2;
  for (;;) {
    const a = cells.get('A' + r);
    if (!a || a.v == null) break;
    if (typeof a.v !== 'string') throw new Error('Engine sheet: non-string rate key at A' + r);
    const key = a.v;
    const b = cells.get('B' + r);
    if (!b || typeof b.v !== 'number' || !Number.isFinite(b.v)) {
      throw new Error('Engine sheet: rate value missing/non-numeric at B' + r + ' for key "' + key + '"');
    }
    if (Object.prototype.hasOwnProperty.call(rates, key)) {
      throw new Error('Engine sheet: duplicate rate key "' + key + '" at row ' + r);
    }
    if (key.split('|').length !== 9) {
      throw new Error('Engine sheet: key at A' + r + ' is not a 9-part key: "' + key + '"');
    }
    rates[key] = cleanNumber(b.v);
    const c = cells.get('C' + r);
    srcCells[key] = c && typeof c.v === 'string' ? c.v : null;
    r++;
  }
  const tierGrid = {};
  const tgNum = (cell, what, row) => {
    if (!cell || cell.v == null) return null;
    if (cell.v === 'NA') return null;
    if (typeof cell.v === 'number' && Number.isFinite(cell.v)) return cleanNumber(cell.v);
    throw new Error('Engine sheet: tier-grid ' + what + ' at row ' + row + ' is neither number nor NA: ' + JSON.stringify(cell.v));
  };
  let tr = 2;
  for (;;) {
    const e = cells.get('E' + tr);
    if (!e || e.v == null) break;
    if (typeof e.v !== 'string') throw new Error('Engine sheet: non-string tier-grid key at E' + tr);
    const key = e.v;
    if (Object.prototype.hasOwnProperty.call(tierGrid, key)) {
      throw new Error('Engine sheet: duplicate tier-grid key "' + key + '" at row ' + tr);
    }
    tierGrid[key] = {
      maxacq: tgNum(cells.get('H' + tr), 'maxacq(H)', tr),
      maxar: tgNum(cells.get('I' + tr), 'maxar(I)', tr),
      maxloan: tgNum(cells.get('F' + tr), 'maxloan(F)', tr),
      maxltc: tgNum(cells.get('J' + tr), 'maxltc(J)', tr),
      minfico: tgNum(cells.get('G' + tr), 'minfico(G)', tr)
    };
    tr++;
  }
  return { rates, tierGrid, srcCells };
}

/* =====================================================================
 * Byte-exact fixture serialization
 *   { \n "rates": { \n "key": v, ... } , "tierGrid": { nested } }  --
 *   key-sorted (ASCII), one entry per line, zero indentation, '": "'
 *   separator, numbers in shortest JS/JSON form, NO trailing newline.
 * ===================================================================== */
function jsonNum(v) {
  if (v === null) return 'null';
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('serialize: non-finite value ' + v);
  return JSON.stringify(v);
}
function serializeFixture(data) {
  const L = [];
  L.push('{');
  L.push('"rates": {');
  const rk = Object.keys(data.rates).sort();
  rk.forEach((k, i) => L.push(JSON.stringify(k) + ': ' + jsonNum(data.rates[k]) + (i < rk.length - 1 ? ',' : '')));
  L.push('},');
  L.push('"tierGrid": {');
  const tk = Object.keys(data.tierGrid).sort();
  tk.forEach((k, i) => {
    L.push(JSON.stringify(k) + ': {');
    const fk = Object.keys(data.tierGrid[k]).sort();
    fk.forEach((f, j) => L.push(JSON.stringify(f) + ': ' + jsonNum(data.tierGrid[k][f]) + (j < fk.length - 1 ? ',' : '')));
    L.push(i < tk.length - 1 ? '},' : '}');
  });
  L.push('}');
  L.push('}');
  return L.join('\n');
}

/* =====================================================================
 * Tab 2 (EMCAP_Pricing Matrix) -> priced-cell records (cross-source input)
 * ===================================================================== */
const PRODUCT_MAP = { 'F&F / F&H': 'FF', 'GUC': 'GUC', 'BRIDGE': 'BR' };
const AR_PAT = /^(<\s*64\.99%|\d{2}\.\d{2}%-\d{2}\.\d{2}%)$/;
const FICO_PAT = /^FICO /;

function parseMatrixTab(cells, maxRowHint) {
  const grid = new Map(); // `${row}|${col}` -> value
  let maxRow = maxRowHint || 0;
  for (const [ref, c] of cells) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!m) continue;
    const row = Number(m[2]);
    const col = colNum(m[1]);
    if (row > maxRow) maxRow = row;
    grid.set(row + '|' + col, c.v);
  }
  const val = (r, c) => {
    const v = grid.get(r + '|' + c);
    return v === undefined ? null : v;
  };
  const sval = (r, c) => {
    const v = val(r, c);
    return typeof v === 'string' ? v.replace(/&lt;/g, '<').replace(/&amp;/g, '&') : v;
  };

  // --- sections: rows whose column-B cell is "NN MONTH TERM" start a market/size section
  const sectionStarts = [];
  for (let r = 1; r <= maxRow; r++) {
    if (typeof sval(r, 2) === 'string' && /^12 MONTH TERM$/.test(sval(r, 2))) sectionStarts.push(r);
  }
  if (!sectionStarts.length) throw new Error('tab 2: no "12 MONTH TERM" section headers found');
  let nycFromRow = Infinity;
  for (let r = 1; r <= maxRow; r++) {
    const v = sval(r, 2);
    if (typeof v === 'string' && /New York City/i.test(v)) { nycFromRow = r; break; }
  }
  const sections = sectionStarts.map((start, i) => {
    const end = i + 1 < sectionStarts.length ? sectionStarts[i + 1] - 1 : maxRow;
    const sizeStr = sval(start + 1, 2);
    let size = null;
    if (typeof sizeStr === 'string' && /\$100k-\$2\.5m/.test(sizeStr)) size = 'S';
    else if (typeof sizeStr === 'string' && /\$2\.5m-\$4\.5m/.test(sizeStr)) size = 'L';
    if (!size) throw new Error('tab 2: cannot read the loan-size banner under the section at row ' + start + ' (got ' + JSON.stringify(sizeStr) + ')');
    return { start, end, mkt: start >= nycFromRow ? 'NYC' : 'STD', size };
  });
  const sectionOf = (r) => {
    for (let i = sections.length - 1; i >= 0; i--) if (r >= sections[i].start) return sections[i];
    throw new Error('tab 2: row ' + r + ' precedes every section');
  };

  // --- term column groups, derived from the first section's term-header row
  const firstHdrRow = sectionStarts[0];
  const termCols = [];
  for (let c = 1; c <= 60; c++) {
    const v = sval(firstHdrRow, c);
    const m = typeof v === 'string' ? /^(\d{2}) MONTH TERM$/.exec(v) : null;
    if (m) termCols.push({ col: c, term: m[1] });
  }
  if (termCols.length !== 3) throw new Error('tab 2: expected 3 term header columns, found ' + termCols.length);
  const GROUPS = [];
  for (const { col, term } of termCols) {
    GROUPS.push({ term, purp: 'P', lcol: col });
    GROUPS.push({ term, purp: 'R', lcol: col + 10 });
  }

  // --- product tables: column-B "Pricing Matrix - Purchase Loans (<product>)" banners
  const tables = [];
  for (let r = 1; r <= maxRow; r++) {
    const v = sval(r, 2);
    const m = typeof v === 'string' ? /^Pricing Matrix - Purchase Loans \((.*)\)$/.exec(v) : null;
    if (m) {
      const prod = PRODUCT_MAP[m[1]];
      if (!prod) throw new Error('tab 2: unknown product banner "' + m[1] + '" at row ' + r + ' -- extend PRODUCT_MAP after owner confirmation');
      tables.push({ row: r, prod });
    }
  }
  if (!tables.length) throw new Error('tab 2: no product banners found');
  // sanity: purchase/refinance banners sit at the derived group columns
  for (const g of GROUPS) {
    const v = sval(tables[0].row, g.lcol);
    const want = g.purp === 'P' ? 'Purchase' : 'Refinance';
    if (typeof v !== 'string' || !v.startsWith('Pricing Matrix - ' + want + ' Loans (')) {
      throw new Error('tab 2: expected a "' + want + '" banner at row ' + tables[0].row + ' col ' + colName(g.lcol) + ', got ' + JSON.stringify(v));
    }
  }

  // --- walk each product table x tier x column group
  const records = [];   // FICO-row cells (the priced grid)
  const dupRecords = []; // AR-label display rows (informational)
  tables.forEach((tbl, ti) => {
    const tend = ti + 1 < tables.length ? tables[ti + 1].row - 1 : maxRow;
    const { mkt, size } = sectionOf(tbl.row);
    const tiers = [];
    for (let r = tbl.row + 1; r <= tend; r++) {
      const v = sval(r, 2);
      if (typeof v === 'string' && /^Tier \d/.test(v)) tiers.push({ row: r, tnum: v.split(/\s+/)[1] });
    }
    tiers.forEach((tier, k) => {
      const tend2 = k + 1 < tiers.length ? tiers[k + 1].row - 1 : tend;
      for (const g of GROUPS) {
        let hdr = null;
        for (let r = tier.row; r <= tend2; r++) {
          if (sval(r, g.lcol) === 'AR-LTV') { hdr = r; break; }
        }
        if (hdr == null) continue;
        const ltcs = [];
        for (let i = 1; i <= 6; i++) ltcs.push(sval(hdr, g.lcol + i));
        if (ltcs.some((x) => typeof x !== 'string')) {
          throw new Error('tab 2: bad LTC header row at ' + hdr + ' col ' + colName(g.lcol));
        }
        let curAR = null;
        for (let r = hdr + 1; r <= tend2; r++) {
          const lab = sval(r, g.lcol);
          if (lab == null) continue;
          if (typeof lab === 'string' && AR_PAT.test(lab.trim())) {
            curAR = lab.trim();
            for (let i = 1; i <= 6; i++) {
              dupRecords.push({ mkt, size, prod: tbl.prod, purp: g.purp, term: g.term, tier: 'T' + tier.tnum, ar: curAR, fico: '(label-row)', ltc: ltcs[i - 1], v: val(r, g.lcol + i), ref: colName(g.lcol + i) + r });
            }
          } else if (typeof lab === 'string' && FICO_PAT.test(lab.trim())) {
            for (let i = 1; i <= 6; i++) {
              records.push({ mkt, size, prod: tbl.prod, purp: g.purp, term: g.term, tier: 'T' + tier.tnum, ar: curAR, fico: lab.trim(), ltc: ltcs[i - 1], v: val(r, g.lcol + i), ref: colName(g.lcol + i) + r });
            }
          }
        }
      }
    });
  });
  return { records, dupRecords, sections, groups: GROUPS };
}

const recKey = (x) => [x.mkt, x.size, x.prod, x.purp, x.term, x.tier, x.ar, x.fico, x.ltc].join('|');

/* =====================================================================
 * Cross-source verification: Engine sheet vs tab 2
 * ===================================================================== */
function crossSourceCheck(engineRates, matrix) {
  const problems = [];
  const expectedCounts = {};
  for (const k of Object.keys(EXPECTED_TAB2_ONLY)) expectedCounts[k] = 0;

  const tab2 = new Map();
  for (const r of matrix.records) {
    const k = recKey(r);
    if (tab2.has(k)) problems.push('tab 2: duplicate grid key "' + k + '" (' + tab2.get(k).ref + ' vs ' + r.ref + ')');
    else tab2.set(k, r);
  }
  const priced = matrix.records.filter((r) => typeof r.v === 'number');

  // A) every tab-2 priced cell is in the Engine sheet with the same rate, OR
  //    belongs to exactly one expected omission class.
  for (const r of priced) {
    const k = recKey(r);
    if (Object.prototype.hasOwnProperty.call(engineRates, k)) {
      if (Math.abs(engineRates[k] - r.v) > 1e-12) {
        problems.push('VALUE MISMATCH Engine-vs-tab2 for key "' + k + '": Engine sheet ' + engineRates[k] + ' vs tab 2 cell ' + r.ref + ' = ' + r.v);
      }
      continue;
    }
    let cls = null;
    for (const [name, spec] of Object.entries(EXPECTED_TAB2_ONLY)) {
      if (spec.match(r)) { cls = name; break; }
    }
    if (cls) expectedCounts[cls]++;
    else problems.push('NEW tab-2-only priced cell (not in the Engine sheet, outside every expected class): "' + k + '" = ' + r.v + ' at ' + r.ref);
  }

  // B) every Engine-sheet key exists in tab 2 as a priced cell with the same rate.
  for (const [k, rate] of Object.entries(engineRates)) {
    const r = tab2.get(k);
    if (!r) problems.push('Engine-sheet key missing from tab 2 entirely: "' + k + '"');
    else if (typeof r.v !== 'number') problems.push('Engine-sheet key "' + k + '" is unpriced in tab 2 (' + r.ref + ' = ' + JSON.stringify(r.v) + ')');
    else if (Math.abs(rate - r.v) > 1e-12) problems.push('VALUE MISMATCH tab2-vs-Engine for key "' + k + '": tab 2 ' + r.v + ' (' + r.ref + ') vs Engine sheet ' + rate);
  }

  // C) the expected omission classes must match the pinned counts exactly.
  for (const [name, spec] of Object.entries(EXPECTED_TAB2_ONLY)) {
    if (expectedCounts[name] !== spec.count) {
      problems.push('EXPECTED-DIFFERENCE COUNT CHANGED for class "' + name + '" (' + spec.describe + '): found ' + expectedCounts[name] + ', contract pins ' + spec.count + '. A workbook structure change must be owner-confirmed; then update EXPECTED_TAB2_ONLY in scripts/emcap-regenerate-fixture.js.');
    }
  }

  const expectedTotal = Object.values(expectedCounts).reduce((a, b) => a + b, 0);
  return { ok: problems.length === 0, problems, expectedCounts, expectedTotal, pricedCount: priced.length, sharedCount: priced.length - expectedTotal };
}

/* =====================================================================
 * RATE_BLOCKS + TG literal compilation (must match the frozen engine text)
 * ===================================================================== */
function compileRateBlocks(rates) {
  const blocks = new Map();
  for (const [key, rate] of Object.entries(rates)) {
    const p = key.split('|');
    if (p.length !== 9) throw new Error('blocks: key is not 9-part: "' + key + '"');
    const [mkt, size, prod, purp, term, tier, ar, fico, ltc] = p;
    const blockKey = [mkt, size, prod, purp, term, tier].join('|');
    const ficoList = tier === 'T3' ? FICO_BANDS_3 : FICO_BANDS_12;
    const i = AR_BANDS.indexOf(ar);
    const j = ficoList.indexOf(fico);
    const kk = LTC_BANDS.indexOf(ltc);
    if (i < 0 || j < 0 || kk < 0) {
      throw new Error('GEOMETRY CHANGE: key "' + key + '" uses a band outside the frozen engine geometry (AR/FICO/LTC band lists). The engine needs a human rework, not a regeneration.');
    }
    if (!blocks.has(blockKey)) blocks.set(blockKey, new Array(54).fill(0));
    const arr = blocks.get(blockKey);
    const slot = (i * 3 + j) * 6 + kk;
    if (arr[slot] !== 0) throw new Error('blocks: duplicate slot for key "' + key + '"');
    const unitsRaw = rate / RATE_UNIT;
    const units = Math.round(unitsRaw);
    if (Math.abs(unitsRaw - units) > 1e-6 || units <= 0) {
      throw new Error('LATTICE VIOLATION: rate ' + rate + ' for key "' + key + '" is not a positive multiple of ' + RATE_UNIT + ' (0.0125%). The RATE_BLOCKS integer encoding cannot carry it -- owner/engine rework needed.');
    }
    arr[slot] = units;
  }
  const keys = [...blocks.keys()].sort();
  const lines = ['    var RATE_BLOCKS = {'];
  keys.forEach((k, idx) => {
    lines.push('    ' + JSON.stringify(k) + ': [' + blocks.get(k).join(',') + ']' + (idx < keys.length - 1 ? ',' : ''));
  });
  lines.push('  };');
  return { literal: lines.join('\n'), blockCount: keys.length, blocks };
}

function fmtTgPct(v) {
  const s2 = v.toFixed(2);
  return Math.abs(parseFloat(s2) - v) < 1e-12 ? s2 : v.toFixed(3);
}
function compileTg(tierGrid) {
  const wantKeys = [];
  for (const prod of TG_PRODUCTS) for (const purp of TG_PURPOSES) for (const t of TG_TIERS) wantKeys.push(prod + '|' + purp + '|T' + t);
  const have = Object.keys(tierGrid);
  const missing = wantKeys.filter((k) => !have.includes(k));
  const extra = have.filter((k) => !wantKeys.includes(k));
  if (missing.length || extra.length) {
    throw new Error('TG GEOMETRY CHANGE: tier-grid keys differ from the frozen 18-row domain (missing: ' + missing.join(', ') + '; extra: ' + extra.join(', ') + ')');
  }
  // literal rows in domain order FF,GUC,BR x P,R x 1..3 with the engine's hand alignment
  const rows = [];
  let maxQ = 0;
  for (const prod of TG_PRODUCTS) for (const purp of TG_PURPOSES) for (const t of TG_TIERS) {
    const q = JSON.stringify(prod + '|' + purp + '|' + t);
    if (q.length > maxQ) maxQ = q.length;
    rows.push({ q, row: tierGrid[prod + '|' + purp + '|T' + t] });
  }
  const lines = ['  var TG = {'];
  rows.forEach(({ q, row }, idx) => {
    const pad = ' '.repeat(maxQ - q.length + 1);
    const isNA = row.maxloan === 0 || row.minfico == null;
    let body;
    if (isNA) body = 'NA';
    else {
      const loan = (String(row.maxloan) + ',').padEnd(8);
      body = '[' + loan + ' ' + row.minfico + ', ' + fmtTgPct(row.maxacq) + ', ' + fmtTgPct(row.maxar) + ', ' + fmtTgPct(row.maxltc) + ']';
    }
    lines.push('    ' + q + ':' + pad + body + (idx < rows.length - 1 ? ',' : ''));
  });
  lines.push('  };');
  return { literal: lines.join('\n') };
}

/** String-extract a literal region from live engine source. */
function extractLiteral(engineText, openLine) {
  const anchor = '\n' + openLine + '\n';
  const at = engineText.indexOf(anchor);
  if (at < 0) throw new Error('engine literal extraction: opening line not found: ' + JSON.stringify(openLine));
  const start = at + 1;
  const close = engineText.indexOf('\n  };', start);
  if (close < 0) throw new Error('engine literal extraction: closing "  };" not found after ' + JSON.stringify(openLine));
  return engineText.slice(start, close + '\n  };'.length);
}

/** Semantic double-check: the required engine module reconstructs the rates exactly. */
function semanticEngineCheck(rates, tierGrid) {
  const problems = [];
  let SVP;
  try {
    SVP = require(ENGINE_MAIN);
  } catch (e) {
    return { ok: false, problems: ['cannot require the live engine: ' + e.message] };
  }
  const C = SVP.constants;
  const engineCells = {};
  for (const bk of Object.keys(C.RATE_BLOCKS)) {
    const tier = bk.split('|')[5];
    const fl = tier === 'T3' ? C.FICO_BANDS_3 : C.FICO_BANDS_12;
    const arr = C.RATE_BLOCKS[bk];
    if (arr.length !== 54) problems.push('engine block ' + bk + ' length ' + arr.length + ' != 54');
    for (let i = 0; i < C.AR_BANDS.length; i++) {
      for (let j = 0; j < fl.length; j++) {
        for (let k = 0; k < C.LTC_BANDS.length; k++) {
          const v = arr[(i * 3 + j) * 6 + k];
          if (v > 0) engineCells[bk + '|' + C.AR_BANDS[i] + '|' + fl[j] + '|' + C.LTC_BANDS[k]] = v * RATE_UNIT;
        }
      }
    }
  }
  for (const [k, v] of Object.entries(rates)) {
    if (!(k in engineCells)) problems.push('fixture key missing from live engine blocks: "' + k + '"');
    else if (Math.abs(engineCells[k] - v) > 1e-12) problems.push('live engine rate differs for "' + k + '": engine ' + engineCells[k] + ' vs workbook ' + v);
  }
  for (const k of Object.keys(engineCells)) {
    if (!(k in rates)) problems.push('live engine prices a cell the workbook does not: "' + k + '"');
  }
  for (const [k, row] of Object.entries(tierGrid)) {
    const [prod, purp, tier] = k.split('|');
    const tgRow = C.TG[prod + '|' + purp + '|' + tier[1]];
    const isNA = row.maxloan === 0 || row.minfico == null;
    if (isNA) {
      if (tgRow !== null) problems.push('live engine TG["' + prod + '|' + purp + '|' + tier[1] + '"] should be NA');
    } else if (!tgRow || tgRow[0] !== row.maxloan || tgRow[1] !== row.minfico || tgRow[2] !== row.maxacq || tgRow[3] !== row.maxar || tgRow[4] !== row.maxltc) {
      problems.push('live engine TG["' + prod + '|' + purp + '|' + tier[1] + '"] differs from workbook tier grid');
    }
  }
  return { ok: problems.length === 0, problems };
}

/* =====================================================================
 * Top-level operations (shared by the CLI and the test)
 * ===================================================================== */
function readWorkbook(bufOrPath) {
  const buf = Buffer.isBuffer(bufOrPath) ? bufOrPath : fs.readFileSync(bufOrPath);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const entries = readZipEntries(buf);
  const strings = loadSharedStrings(entries);
  const sheets = workbookSheetMap(entries);
  const engineSheet = findSheet(sheets, 'engine');
  const matrixSheet = findSheet(sheets, 'matrix');
  const engineEntry = entries.get(engineSheet.entry);
  const matrixEntry = entries.get(matrixSheet.entry);
  if (!engineEntry) throw new Error('xlsx: missing entry ' + engineSheet.entry);
  if (!matrixEntry) throw new Error('xlsx: missing entry ' + matrixSheet.entry);
  const engineParsed = parseSheetCells(engineEntry, strings);
  const matrixParsed = parseSheetCells(matrixEntry, strings);
  const engine = parseEngineTab(engineParsed.cells);
  const matrix = parseMatrixTab(matrixParsed.cells, matrixParsed.maxRow);
  return {
    sha256,
    sheets,
    fixture: { rates: engine.rates, tierGrid: engine.tierGrid },
    srcCells: engine.srcCells,
    matrix
  };
}

/** Per-key diff of freshly extracted fixture data vs the committed fixture file. */
function fixtureCheck(wb, fixturePath) {
  const problems = [];
  let committedText = null;
  try {
    committedText = fs.readFileSync(fixturePath, 'utf8');
  } catch (e) {
    return { ok: false, problems: ['cannot read committed fixture ' + fixturePath + ': ' + e.message] };
  }
  const fresh = serializeFixture(wb.fixture);
  if (fresh === committedText) return { ok: true, problems: [], bytes: Buffer.byteLength(fresh) };

  // name every differing key
  let committed;
  try { committed = JSON.parse(committedText); } catch (e) {
    return { ok: false, problems: ['committed fixture is not valid JSON: ' + e.message] };
  }
  const cr = committed.rates || {};
  const fr = wb.fixture.rates;
  for (const k of Object.keys(fr)) {
    if (!(k in cr)) problems.push('rates key ONLY IN WORKBOOK (missing from committed fixture): "' + k + '" = ' + fr[k]);
    else if (Math.abs(cr[k] - fr[k]) > 0) problems.push('rates VALUE CHANGED for key "' + k + '": workbook ' + fr[k] + ' vs committed ' + cr[k]);
  }
  for (const k of Object.keys(cr)) {
    if (!(k in fr)) problems.push('rates key ONLY IN COMMITTED FIXTURE (gone from workbook): "' + k + '" = ' + cr[k]);
  }
  const ct = committed.tierGrid || {};
  const ft = wb.fixture.tierGrid;
  for (const k of new Set([...Object.keys(ct), ...Object.keys(ft)])) {
    const a = JSON.stringify(ft[k] ?? null);
    const b = JSON.stringify(ct[k] ?? null);
    if (a !== b) problems.push('tierGrid row differs for key "' + k + '": workbook ' + a + ' vs committed ' + b);
  }
  if (!problems.length) {
    problems.push('fixture data is EQUAL but the serialized bytes differ (formatting drift) -- the committed file was not produced by this serializer. Fresh length ' + fresh.length + ', committed length ' + committedText.length + '.');
  }
  return { ok: false, problems, freshText: fresh };
}

function blocksCheck(wb) {
  const problems = [];
  const rb = compileRateBlocks(wb.fixture.rates);
  const tg = compileTg(wb.fixture.tierGrid);
  const perCopy = [];
  let mainRb = null;
  let mainTg = null;
  for (const rel of ENGINE_COPIES) {
    const p = path.join(REPO_ROOT, rel);
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch (e) { problems.push('cannot read engine copy ' + rel + ': ' + e.message); continue; }
    let liveRb, liveTg;
    try {
      liveRb = extractLiteral(text, '    var RATE_BLOCKS = {');
      liveTg = extractLiteral(text, '  var TG = {');
    } catch (e) { problems.push(rel + ': ' + e.message); continue; }
    const rbOk = liveRb === rb.literal;
    const tgOk = liveTg === tg.literal;
    if (rel === ENGINE_COPIES[0]) { mainRb = liveRb; mainTg = liveTg; }
    else {
      if (mainRb !== null && liveRb !== mainRb) problems.push('engine copy DRIFT: ' + rel + ' RATE_BLOCKS literal differs from web/v2/tools copy');
      if (mainTg !== null && liveTg !== mainTg) problems.push('engine copy DRIFT: ' + rel + ' TG literal differs from web/v2/tools copy');
    }
    if (!rbOk) problems.push(rel + ': RATE_BLOCKS literal does NOT match the workbook-compiled literal (rate grid drift)');
    if (!tgOk) problems.push(rel + ': TG literal does NOT match the workbook-compiled literal (tier grid drift)');
    perCopy.push({ rel, rbOk, tgOk });
  }
  const sem = semanticEngineCheck(wb.fixture.rates, wb.fixture.tierGrid);
  if (!sem.ok) problems.push(...sem.problems.map((x) => 'semantic: ' + x));
  return { ok: problems.length === 0, problems, compiled: { rateBlocks: rb.literal, tg: tg.literal, blockCount: rb.blockCount }, perCopy };
}

const ENGINE_UPDATE_INSTRUCTIONS = `
ENGINE LITERALS ARE A HUMAN STEP (frozen engine -- owner authorization required):
  1. Get the owner's explicit written authorization for the rate/tier change.
  2. Re-run with --emit-blocks <path> to get the freshly compiled literal text.
  3. In web/v2/tools/silver-program.js replace the "    var RATE_BLOCKS = {"
     ... "  };" region and the "  var TG = {" ... "  };" region with the
     compiled text (nothing else in the file).
  4. Copy web/v2/tools/silver-program.js over the 5 sibling copies:
       web/tools/, web/portal/engines/, web/v2/portal/engines/,
       app/public/engines/, app-v2/public/engines/
  5. Bump the silver-program.js ?v= cache-busters (grep the CURRENT value
     first — a hard-coded version here goes stale on every engine change) in:
       web/v2/tools/term-sheet.html, web/v2/portal/index.html, app-v2/index.html
  6. Re-run this tool (--check --blocks), then node scripts/test-silver-program.js,
     MATRIX_N=500 node scripts/test-silver-workbook-matrix.js,
     node scripts/soak-silver-scenarios.js, node scripts/test-emcap-regenerate-pure.js.
  7. Record the change + new workbook sha256 in docs/SILVER-PROGRAM-EMCAP.md and
     the CLAUDE.md frozen-baseline notes; the owner re-freezes.
`;

/* ---------------- CLI ---------------- */
function parseArgs(argv) {
  const opt = { check: false, blocks: false, write: false, xlsx: null, out: null, emitBlocks: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') opt.check = true;
    else if (a === '--blocks') opt.blocks = true;
    else if (a === '--write') opt.write = true;
    else if (a === '--xlsx') opt.xlsx = argv[++i];
    else if (a === '--out') opt.out = argv[++i];
    else if (a === '--emit-blocks') opt.emitBlocks = argv[++i];
    else if (a === '--help' || a === '-h') opt.help = true;
    else if (!a.startsWith('-') && !opt.xlsx) opt.xlsx = a;
    else { console.error('unknown argument: ' + a); process.exit(2); }
  }
  if (!opt.check && !opt.blocks && !opt.write) { opt.check = true; opt.blocks = true; } // check-only default
  return opt;
}

function main(argv) {
  const opt = parseArgs(argv);
  if (opt.help) {
    console.log('usage: node scripts/emcap-regenerate-fixture.js [--check] [--blocks] [--write] [--out <path>] [--emit-blocks <path>] [--xlsx <path>|<path>]');
    return 0;
  }
  const xlsxPath = opt.xlsx || ARCHIVE_XLSX;
  let wb;
  try {
    wb = readWorkbook(xlsxPath);
  } catch (e) {
    console.error('[emcap-regen] FAILED to read/parse workbook ' + xlsxPath + ': ' + e.message);
    return 2;
  }
  const isArchive = path.resolve(xlsxPath) === path.resolve(ARCHIVE_XLSX);
  console.log('[emcap-regen] workbook: ' + xlsxPath);
  console.log('[emcap-regen] sha256: ' + wb.sha256 + (isArchive ? (wb.sha256 === ARCHIVE_SHA256 ? ' (matches the recorded archive hash)' : ' *** DOES NOT MATCH the recorded archive hash ' + ARCHIVE_SHA256 + ' -- if the archive was deliberately replaced, update ARCHIVE_SHA256 in this script (step 1 of the docs procedure) ***') : ''));
  console.log('[emcap-regen] Engine sheet: ' + Object.keys(wb.fixture.rates).length + ' rate keys, ' + Object.keys(wb.fixture.tierGrid).length + ' tier-grid rows; tab 2: ' + wb.matrix.records.length + ' grid cells read');

  let failed = false;

  // cross-source check runs for --check and as the --write precondition
  let cross = null;
  if (opt.check || opt.write) {
    cross = crossSourceCheck(wb.fixture.rates, wb.matrix);
    if (cross.ok) {
      const parts = Object.entries(cross.expectedCounts).map(([k, n]) => n + ' ' + k);
      console.log('[check] cross-source (tab 2): ' + cross.pricedCount + ' priced cells; ' + cross.sharedCount + ' shared with the Engine sheet, all values equal; expected Engine-sheet omissions: ' + parts.join(' + ') + ' = ' + cross.expectedTotal + ' ... OK');
    } else {
      failed = true;
      console.error('[check] cross-source (tab 2): FAIL -- ' + cross.problems.length + ' problem(s):');
      for (const p of cross.problems.slice(0, 40)) console.error('    ' + p);
      if (cross.problems.length > 40) console.error('    ... and ' + (cross.problems.length - 40) + ' more');
    }
  }

  if (opt.check) {
    const fx = fixtureCheck(wb, FIXTURE_PATH);
    if (fx.ok) {
      console.log('[check] fixture: workbook extraction serializes BYTE-IDENTICAL to ' + path.relative(REPO_ROOT, FIXTURE_PATH) + ' (' + fx.bytes + ' bytes) ... OK');
    } else {
      failed = true;
      console.error('[check] fixture: FAIL -- committed fixture does not match this workbook:');
      for (const p of fx.problems.slice(0, 40)) console.error('    ' + p);
      if (fx.problems.length > 40) console.error('    ... and ' + (fx.problems.length - 40) + ' more');
      console.error('    (a deliberate workbook update regenerates with: node scripts/emcap-regenerate-fixture.js --write --xlsx <new.xlsx>)');
    }
  }

  if (opt.blocks) {
    const bc = blocksCheck(wb);
    if (bc.ok) {
      console.log('[blocks] RATE_BLOCKS (' + bc.compiled.blockCount + ' blocks) + TG literals: match all ' + ENGINE_COPIES.length + ' live engine copies; semantic reconstruction of all ' + Object.keys(wb.fixture.rates).length + ' cells exact ... OK');
    } else {
      failed = true;
      console.error('[blocks] FAIL -- ' + bc.problems.length + ' problem(s):');
      for (const p of bc.problems.slice(0, 20)) console.error('    ' + p);
      if (bc.problems.length > 20) console.error('    ... and ' + (bc.problems.length - 20) + ' more');
      console.error(ENGINE_UPDATE_INSTRUCTIONS);
    }
  }

  if (opt.emitBlocks) {
    const rb = compileRateBlocks(wb.fixture.rates);
    const tg = compileTg(wb.fixture.tierGrid);
    fs.writeFileSync(opt.emitBlocks, rb.literal + '\n\n' + tg.literal + '\n');
    console.log('[emit-blocks] compiled literals written to ' + opt.emitBlocks);
  }

  if (opt.write) {
    if (!cross.ok) {
      console.error('[write] REFUSED: the cross-source check reports unexpected Engine-vs-tab-2 divergence. Resolve it (or, after owner confirmation of a structure change, update EXPECTED_TAB2_ONLY) before writing the fixture.');
      return 1;
    }
    const outPath = opt.out || FIXTURE_PATH;
    const fresh = serializeFixture(wb.fixture);
    fs.writeFileSync(outPath, fresh);
    const back = fs.readFileSync(outPath, 'utf8');
    if (back !== fresh) {
      console.error('[write] FAILED read-back verification for ' + outPath);
      return 2;
    }
    console.log('[write] fixture written: ' + outPath + ' (' + Buffer.byteLength(fresh) + ' bytes, ' + Object.keys(wb.fixture.rates).length + ' rates + ' + Object.keys(wb.fixture.tierGrid).length + ' tierGrid rows)');
    // After a write, the engine literals may now be stale -- verify and instruct.
    const bc = blocksCheck(wb);
    if (bc.ok) {
      console.log('[write] live engine literals still match this workbook ... OK');
    } else {
      failed = true;
      console.error('[write] the live engine literals do NOT match the regenerated data -- the pipeline is not complete until a human updates the frozen engines:');
      console.error(ENGINE_UPDATE_INSTRUCTIONS);
    }
  }

  if (failed) {
    console.error('RESULT: DRIFT DETECTED (exit 1)');
    return 1;
  }
  console.log('RESULT: CLEAN -- committed artifacts are reproducible from this workbook (exit 0)');
  return 0;
}

module.exports = {
  ARCHIVE_XLSX,
  ARCHIVE_SHA256,
  FIXTURE_PATH,
  ENGINE_COPIES,
  EXPECTED_TAB2_ONLY,
  readZipEntries,
  loadSharedStrings,
  workbookSheetMap,
  parseSheetCells,
  cleanNumber,
  parseEngineTab,
  parseMatrixTab,
  serializeFixture,
  crossSourceCheck,
  compileRateBlocks,
  compileTg,
  extractLiteral,
  semanticEngineCheck,
  readWorkbook,
  fixtureCheck,
  blocksCheck,
  recKey,
  main
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
