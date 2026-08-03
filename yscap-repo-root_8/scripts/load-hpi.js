#!/usr/bin/env node
/**
 * LOAD THE HOUSE PRICE INDEX.
 *
 *   node scripts/load-hpi.js <file.xlsx>
 *   node scripts/load-hpi.js --url https://www.fhfa.gov/hpi/download/quarterly_datasets/hpi_po_state.csv
 *
 * The FHFA republishes quarterly, so this is run quarterly. It UPSERTS, so
 * running it twice changes nothing and a revised quarter overwrites rather than
 * duplicating. It validates the whole file BEFORE writing a row: a half-loaded
 * index is worse than none, because the reader would then answer confidently for
 * the states that made it in.
 *
 * NOTE the download is served as `.csv` and is in fact an `.xlsx`. That is the
 * FHFA's doing, not a mistake here, and `hpi-load` reads the workbook with
 * Node's own zlib rather than adding a spreadsheet dependency to a backend whose
 * entire dependency list is `express` and `pg`.
 */
'use strict';
const fs = require('fs');
const db = require('../src/db');
const H = require('../src/lib/research/hpi-load');

(async () => {
  const args = process.argv.slice(2);
  const urlAt = args.indexOf('--url');
  let buf;
  try {
    if (urlAt >= 0) {
      const url = args[urlAt + 1] || 'https://www.fhfa.gov/hpi/download/quarterly_datasets/hpi_po_state.csv';
      console.log(`fetching ${url}`);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`the download answered ${r.status}`);
      buf = Buffer.from(await r.arrayBuffer());
    } else {
      const file = args[0];
      if (!file) { console.error('usage: node scripts/load-hpi.js <file.xlsx> | --url [url]'); process.exit(2); }
      buf = fs.readFileSync(file);
    }
    const rows = H.parseFhfaState(buf);
    console.log(`parsed ${rows.length} rows across ${new Set(rows.map((r) => r.region)).size} states`);
    const out = await H.saveHpi(db, rows);
    const newest = (await db.query(
      "SELECT year, quarter FROM hpi_index WHERE region_type='state' ORDER BY year DESC, quarter DESC LIMIT 1")).rows[0];
    console.log(`stored ${out.written} rows for ${out.regions} states; newest quarter `
      + `${newest ? `${newest.year} Q${newest.quarter}` : '(none)'}`);
    process.exit(0);
  } catch (e) {
    // REFUSED WHOLE. Nothing was written, and the previous index is untouched.
    console.error('the index was NOT loaded:', (e && e.message) || e);
    process.exit(1);
  }
})();
