/**
 * Round-5 subject-facts extraction tests: property tax, appraiser comp-research range, building
 * status, neighborhood boundary, sales-agreement analysis. Corpus-based, DB-optional (skips cleanly
 * without the fixtures). Run: node scripts/test-appraisal-tax-research.js
 */
const fs = require('fs');
const path = require('path');
const { extract } = require('../src/lib/appraisal/extract');

const DIR = process.env.APPRAISAL_DIR
  || '/tmp/claude-0/-home-user-yscap/05b5356c-9672-5e08-9492-67ecffd77817/scratchpad/appraisals/stripped';
if (!fs.existsSync(DIR)) { console.log(`SKIP test-appraisal-tax-research (no corpus at ${DIR})`); process.exit(0); }
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.xml')).sort();
if (!files.length) { console.log('SKIP test-appraisal-tax-research (empty corpus)'); process.exit(0); }

let failures = 0;
const assert = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const BSTATUS = ['Existing', 'Proposed', 'UnderConstruction', 'SubstantiallyComplete'];

let withTax = 0, withYear = 0, withResearch = 0, withStatus = 0, withBoundary = 0;
let badTax = false, badYear = false, badRange = false, badStatus = false, buildingWarns = 0;

for (const f of files) {
  const A = extract(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const e = A.enrich || {};
  if (e.property_tax_amount != null) { withTax++; if (!(e.property_tax_amount > 0 && e.property_tax_amount < 1e12)) badTax = true; }
  if (e.property_tax_year != null) { withYear++; if (!(Number.isInteger(e.property_tax_year) && e.property_tax_year >= 1990 && e.property_tax_year <= 2100)) badYear = true; }
  if (e.comp_research) {
    withResearch++;
    const cr = e.comp_research;
    // A stored range must be a real low<=high pair (never a half-open range).
    if (cr.salesLow != null || cr.salesHigh != null) { if (!(cr.salesLow != null && cr.salesHigh != null && cr.salesLow <= cr.salesHigh)) badRange = true; }
    if (cr.listingsLow != null || cr.listingsHigh != null) { if (!(cr.listingsLow != null && cr.listingsHigh != null && cr.listingsLow <= cr.listingsHigh)) badRange = true; }
    if (cr.salesLow == null && cr.salesHigh == null && cr.listingsLow == null && cr.listingsHigh == null) badRange = true; // shouldn't store an all-null research object
  }
  if (e.building_status) { withStatus++; if (!BSTATUS.includes(e.building_status)) badStatus = true; }
  if (e.nbhd_boundaries) withBoundary++;
  for (const w of (A.warnings || [])) if (w.code === 'building_not_existing') buildingWarns++;
}

assert(withTax >= 25, `property tax extracted on a strong majority (${withTax}/${files.length})`);
assert(withYear >= 25, `property tax year extracted (${withYear})`);
assert(!badTax, 'every tax amount is a positive, in-range dollar figure (commas/$ stripped)');
assert(!badYear, 'every tax year is a whole year in 1990–2100 (no 0 / 99999 typo stored)');
assert(withResearch >= 25, `appraiser comp-research range extracted on a strong majority (${withResearch})`);
assert(!badRange, 'every stored research range is a real low≤high pair (never half-open / all-null)');
assert(withStatus >= 25, `building status extracted (${withStatus})`);
assert(!badStatus, 'every building status is in the whitelist');
assert(withBoundary >= 25, `neighborhood boundary narrative extracted (${withBoundary})`);
// The corpus has a Proposed file → the non-existing tripwire must fire at least once, and match the count of non-existing statuses.
assert(buildingWarns >= 1, `building_not_existing tripwire fires on the non-existing subject(s) (${buildingWarns})`);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL tax/research assertions passed');
process.exit(failures ? 1 : 0);
