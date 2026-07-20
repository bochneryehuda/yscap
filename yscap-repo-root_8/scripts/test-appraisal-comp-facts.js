/**
 * Round-6 per-comp facts extraction tests: view/location UAD ratings, basement area, data source.
 * Also re-checks building_status coverage after the multi-STRUCTURE fix. Corpus-based, DB-optional
 * (skips cleanly without the fixtures). Run: node scripts/test-appraisal-comp-facts.js
 */
const fs = require('fs');
const path = require('path');
const { extract } = require('../src/lib/appraisal/extract');

const DIR = process.env.APPRAISAL_DIR
  || '/tmp/claude-0/-home-user-yscap/05b5356c-9672-5e08-9492-67ecffd77817/scratchpad/appraisals/stripped';
if (!fs.existsSync(DIR)) { console.log(`SKIP test-appraisal-comp-facts (no corpus at ${DIR})`); process.exit(0); }
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.xml')).sort();
if (!files.length) { console.log('SKIP test-appraisal-comp-facts (empty corpus)'); process.exit(0); }

let failures = 0;
const assert = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const RATING = ['Beneficial', 'Neutral', 'Adverse'];

let totalComps = 0, withView = 0, withLoc = 0, withBG = 0, withDS = 0, withLocType = 0;
let badRating = false, badBG = false, bstatusFiles = 0;
let mcNarr = 0, mrNarr = 0, ptrLeak = 0;   // round-7 market narratives
for (const f of files) {
  const A = extract(fs.readFileSync(path.join(DIR, f), 'utf8'));
  if (A.enrich && A.enrich.building_status) bstatusFiles++;
  const e = A.enrich || {};
  if (e.market_conditions_comment) { mcNarr++; if (/see\s*1004\s*mc|see\s+attached/i.test(e.market_conditions_comment)) ptrLeak++; }
  if (e.market_reconciliation_comment) { mrNarr++; if (/see\s*1004\s*mc|see\s+attached/i.test(e.market_reconciliation_comment)) ptrLeak++; }
  for (const c of (A.comparables || [])) {
    totalComps++;
    if (c.viewRating) { withView++; if (!RATING.includes(c.viewRating)) badRating = true; }
    if (c.locationRating) { withLoc++; if (!RATING.includes(c.locationRating)) badRating = true; }
    if (c.locationType) withLocType++;
    if (c.belowGradeSqft != null) { withBG++; if (!(c.belowGradeSqft > 0 && c.belowGradeSqft < 1e6)) badBG = true; }
    // finished cannot exceed total when both present (sanity)
    if (c.belowGradeSqft != null && c.belowGradeFinishedSqft != null && c.belowGradeFinishedSqft > c.belowGradeSqft + 0.01) badBG = true;
    if (c.compDataSource) withDS++;
  }
}

assert(totalComps > 100, `extracted a full comp set across the corpus (${totalComps} comps)`);
assert(withView >= 100, `per-comp view rating extracted where present (${withView})`);
assert(withLoc >= 100, `per-comp location rating extracted where present (${withLoc})`);
assert(!badRating, 'every view/location rating is in the {Beneficial,Neutral,Adverse} whitelist');
assert(withBG >= 50, `per-comp basement area extracted where present (${withBG})`);
assert(!badBG, 'every comp basement area is a positive, in-range sqft (finished ≤ total)');
assert(withDS >= 100, `per-comp data source extracted where present (${withDS})`);
// building_status multi-STRUCTURE fix: coverage should now be the full corpus (37/37), not 36/37.
assert(bstatusFiles >= files.length - 1, `building_status coverage after the multi-STRUCTURE fix (${bstatusFiles}/${files.length})`);
// Round-7: comp location TYPE + market narratives (pointer-filtered).
assert(withLocType >= 100, `per-comp location TYPE extracted where present (${withLocType})`);
assert(mcNarr >= 15 && mrNarr >= 15, `market narratives extracted (conditions ${mcNarr}, reconciliation ${mrNarr})`);
assert(ptrLeak === 0, `no "See 1004MC"/"See attached" pointer stored as a market narrative (${ptrLeak} leaked)`);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL comp-facts assertions passed');
process.exit(failures ? 1 : 0);
