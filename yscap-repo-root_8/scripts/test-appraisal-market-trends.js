/**
 * 1004MC market-trends extraction tests. Runs the real extractor over the stripped corpus and
 * asserts the never-guess rules for the MARKET/MARKET_INVENTORY grid: FULL-DOLLAR amounts (never
 * the $000s neighborhood scale), N/A/-/blank cells dropped, trend rows captured, and the flattened
 * current-market metrics + tripwires. Skips cleanly (exit 0) when the corpus dir is absent — matches
 * the other corpus/DB-optional tests. Run: node scripts/test-appraisal-market-trends.js
 */
const fs = require('fs');
const path = require('path');
const { extract } = require('../src/lib/appraisal/extract');

const DIR = process.env.APPRAISAL_DIR
  || '/tmp/claude-0/-home-user-yscap/05b5356c-9672-5e08-9492-67ecffd77817/scratchpad/appraisals/stripped';
if (!fs.existsSync(DIR)) { console.log(`SKIP test-appraisal-market-trends (no corpus at ${DIR})`); process.exit(0); }

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.xml')).sort();
if (!files.length) { console.log('SKIP test-appraisal-market-trends (empty corpus)'); process.exit(0); }

let failures = 0;
const assert = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };

let withGrid = 0, withSupply = 0, withTrend = 0;
let anyPriceScaleBug = false, anyBadTrend = false, anyNonLast3Flat = false, anyNegative = false;
const warnCodes = {};

for (const f of files) {
  let A;
  try { A = extract(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch (e) { assert(false, `extract threw on ${f}: ${e.message}`); continue; }
  const e = A.enrich || {};
  if (e.market_trends) {
    withGrid++;
    const g = e.market_trends;
    // Amounts are FULL DOLLARS — a MedianSalesPrice that came through the $000s path would be < 1000.
    for (const metric of ['MedianSalesPrice', 'MedianListPrice']) {
      const cell = g[metric];
      if (cell) for (const p of ['prior712', 'prior46', 'last3']) {
        if (cell[p] != null && cell[p] > 0 && cell[p] < 1000) anyPriceScaleBug = true;
      }
    }
    // Trend must be one of the whitelist, never a raw/unknown token or a period leaking in.
    for (const k of Object.keys(g)) {
      if (g[k].trend != null && !['Increasing', 'Stable', 'Declining'].includes(g[k].trend)) anyBadTrend = true;
      for (const p of ['prior712', 'prior46', 'last3']) if (g[k][p] != null && g[k][p] < 0) anyNegative = true;
    }
    // Flattened current-market values must equal the Last-3-Months cell exactly (never an older period).
    if (e.mc_months_supply != null && g.Supply && g.Supply.last3 != null && Number(e.mc_months_supply) !== Number(g.Supply.last3)) anyNonLast3Flat = true;
    if (e.mc_sale_to_list_pct != null && g.MedianSalesToListRatio && g.MedianSalesToListRatio.last3 != null && Number(e.mc_sale_to_list_pct) !== Number(g.MedianSalesToListRatio.last3)) anyNonLast3Flat = true;
    if (e.mc_price_trend != null && g.MedianSalesPrice && e.mc_price_trend !== g.MedianSalesPrice.trend) anyNonLast3Flat = true;
  }
  if (e.mc_months_supply != null) withSupply++;
  if (e.mc_price_trend != null) withTrend++;
  for (const w of (A.warnings || [])) if (/^mc_/.test(w.code)) warnCodes[w.code] = (warnCodes[w.code] || 0) + 1;
}

// The corpus is ~37 files; the 1004MC grid is present on ~33 of them.
assert(withGrid >= 25, `1004MC grid extracted on a strong majority of files (${withGrid}/${files.length})`);
assert(withSupply >= 15, `months-of-supply flattened on the files that carry it (${withSupply})`);
assert(withTrend >= 15, `price trend flattened on the files that carry it (${withTrend})`);
assert(!anyPriceScaleBug, 'no MedianSalesPrice/ListPrice cell fell below $1000 (would mean the $000s scale bug)');
assert(!anyBadTrend, 'every trend value is in the {Increasing,Stable,Declining} whitelist');
assert(!anyNegative, 'no market-grid metric came through negative');
assert(!anyNonLast3Flat, 'flattened mc_* values equal their Last-3-Months / trend cell exactly (no stale-period fallback)');
assert(Object.keys(warnCodes).length > 0, `at least one 1004MC tripwire fired across the corpus (${JSON.stringify(warnCodes)})`);

// Dual-grid regression guard: a condo file nests a SECOND MARKET_INVENTORY grid under
// MARKET > SUBJECT_PROJECT. The reader must keep the NEIGHBORHOOD grid (direct children of
// MARKET) — a recursive findAll would let the later project row clobber the neighborhood value.
// These three files were proven wrong before the fix (project's 0 / leaked value overwrote the
// neighborhood's 0.23 / 0.9 / "Unavailable"→null). Skip any that aren't in this corpus.
const KNOWN = { 'nan_Danziger.xml': 0.23, 'nan_Wieder1.xml': 0.9, 'nan_Wieder2.xml': null };
let checkedDual = 0;
for (const [fn, expected] of Object.entries(KNOWN)) {
  const p = path.join(DIR, fn);
  if (!fs.existsSync(p)) continue;
  const e = extract(fs.readFileSync(p, 'utf8')).enrich || {};
  const got = e.mc_months_supply == null ? null : Number(e.mc_months_supply);
  assert(got === expected, `${fn}: neighborhood months-supply is ${expected} (not the project grid's value) — got ${got}`);
  checkedDual++;
}
if (!checkedDual) console.log('NOTE dual-grid regression files not in this corpus — guard skipped');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL market-trends assertions passed');
process.exit(failures ? 1 : 0);
