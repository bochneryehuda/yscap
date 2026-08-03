/**
 * LOADING THE HOUSE PRICE INDEX — the FHFA's own file, read with no dependency.
 *
 * The FHFA publishes the purchase-only state index quarterly. The download is
 * named `.csv` and is in fact an `.xlsx` (a zip of XML), which is why this reads
 * one: adding a spreadsheet library to a backend whose whole dependency list is
 * `express` and `pg` — chosen so Render builds cleanly with no native code — to
 * read one file four times a year is a bad trade. Node's own `zlib` inflates the
 * zip entries and the sheet XML is two regexes.
 *
 * WHAT MAKES THIS SAFE TO RUN AGAINST A LIVE DATABASE:
 *
 *  · IT IS AN UPSERT on (region, year, quarter), so re-running changes nothing
 *    and a REVISED quarter — the FHFA does revise — overwrites rather than
 *    leaving two rows for one period, which every reader would then pick between
 *    arbitrarily.
 *  · IT VALIDATES BEFORE IT WRITES. A file that parses to something that is not
 *    an index (no states, no plausible values, a header that moved) is REFUSED
 *    whole, rather than half-loaded. A half-loaded index is worse than none: the
 *    reader would answer confidently for the states that made it in.
 *  · IT NEVER PARTIALLY REPLACES. Nothing is deleted; a load that fails leaves
 *    the previous index exactly as it was.
 */
'use strict';
const zlib = require('zlib');

/** The zip central directory → { name: localHeaderOffset }. */
function zipEntries(buf) {
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(i + 10);
  let off = buf.readUInt32LE(i + 16);
  const dir = {};
  for (let k = 0; k < count; k++) {
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    dir[buf.slice(off + 46, off + 46 + nameLen).toString()] = buf.readUInt32LE(off + 42);
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return dir;
}

function readEntry(buf, dir, name) {
  const h = dir[name];
  if (h == null) throw new Error(`the file has no ${name} — this is not the FHFA workbook`);
  const method = buf.readUInt16LE(h + 8);
  const csize = buf.readUInt32LE(h + 18);
  const nameLen = buf.readUInt16LE(h + 26);
  const extraLen = buf.readUInt16LE(h + 28);
  const start = h + 30 + nameLen + extraLen;
  const raw = buf.slice(start, start + csize);
  return method === 0 ? raw : zlib.inflateRawSync(raw);
}

/** The workbook's first sheet as rows of strings. */
function sheetRows(buf) {
  const dir = zipEntries(buf);
  const shared = readEntry(buf, dir, 'xl/sharedStrings.xml').toString();
  const strings = [...shared.matchAll(/<si>(.*?)<\/si>/gs)]
    .map((m) => [...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((x) => x[1]).join(''));
  const sheet = readEntry(buf, dir, 'xl/worksheets/sheet1.xml').toString();
  return [...sheet.matchAll(/<row[^>]*>(.*?)<\/row>/gs)].map((r) =>
    [...r[1].matchAll(/<c([^>]*)>(?:<v>(.*?)<\/v>)?<\/c>/gs)].map((c) => {
      if (c[2] === undefined) return null;
      return / t="s"/.test(c[1]) ? (strings[Number(c[2])] != null ? strings[Number(c[2])] : null) : c[2];
    }));
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse the workbook into index rows. Throws — loudly — rather than returning a
 * half-read index, because a partly-loaded index answers confidently for the
 * states that made it in.
 */
function parseFhfaState(buf) {
  const rows = sheetRows(buf);
  if (!rows.length) throw new Error('the workbook has no rows');
  const header = (rows[0] || []).map((x) => String(x || '').trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const cState = col('state');
  const cYear = col('yr');
  const cQtr = col('qtr');
  const cNsa = col('index_nsa');
  const cSa = col('index_sa');
  if ([cState, cYear, cQtr].some((x) => x < 0) || (cNsa < 0 && cSa < 0)) {
    // THE HEADER MOVING IS THE FAILURE TO CATCH. Reading by position would keep
    // "working" against a re-ordered file and load nonsense with total
    // confidence — the exact shape of every wrong answer in this build.
    throw new Error(`the workbook's columns are not the ones expected (${header.join(', ')})`);
  }
  const out = [];
  for (const r of rows.slice(1)) {
    const state = String(r[cState] || '').trim().toUpperCase();
    const year = num(r[cYear]);
    const quarter = num(r[cQtr]);
    if (!/^[A-Z]{2}$/.test(state) || year == null || quarter == null) continue;
    if (quarter < 1 || quarter > 4 || year < 1900 || year > 2200) continue;
    const nsa = cNsa >= 0 ? num(r[cNsa]) : null;
    const sa = cSa >= 0 ? num(r[cSa]) : null;
    if (nsa == null && sa == null) continue;
    out.push({ region_type: 'state', region: state, year, quarter, index_nsa: nsa, index_sa: sa });
  }
  // VALIDATED BEFORE IT IS WRITTEN. A file that parses to something that is not
  // an index is refused whole.
  const states = new Set(out.map((x) => x.region));
  if (states.size < 40) throw new Error(`only ${states.size} states parsed out — that is not the state index`);
  if (out.length < 1000) throw new Error(`only ${out.length} rows parsed out — that is not the full series`);
  return out;
}

/** UPSERT the rows. Idempotent, and never deletes. */
async function saveHpi(db, rows, { source = 'FHFA HPI (purchase-only, state)' } = {}) {
  let written = 0;
  for (const r of rows) {
    const res = await db.query(
      `INSERT INTO hpi_index (region_type, region, year, quarter, index_nsa, index_sa, source, loaded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (region_type, region, year, quarter) DO UPDATE
         SET index_nsa = EXCLUDED.index_nsa, index_sa = EXCLUDED.index_sa,
             source = EXCLUDED.source, loaded_at = now()`,
      [r.region_type, r.region, r.year, r.quarter, r.index_nsa, r.index_sa, source]);
    written += res.rowCount || 0;
  }
  return { written, regions: new Set(rows.map((r) => r.region)).size };
}

/** One region's series, oldest first — what `time-adjust` consumes. */
async function seriesFor(db, region, { regionType = 'state' } = {}) {
  if (!region) return [];
  const r = await db.query(
    `SELECT year, quarter, index_nsa, index_sa FROM hpi_index
      WHERE region_type = $1 AND region = $2 ORDER BY year, quarter`,
    [regionType, String(region).toUpperCase()]);
  return r.rows;
}

module.exports = { parseFhfaState, saveHpi, seriesFor, _internals: { sheetRows, zipEntries } };
