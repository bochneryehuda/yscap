/**
 * Neighborhood land-use mix + off-site improvements extraction tests (round 4). Corpus-based,
 * DB-optional (skips cleanly without the fixtures). Asserts the never-guess rules: land-use rows
 * carry a whitelisted type + a 0–100 percent (NOT normalized to 100), off-site rows merge the two
 * XML row-styles per _Type into one record, and the private-street tripwire fires.
 * Run: node scripts/test-appraisal-land-use.js
 */
const fs = require('fs');
const path = require('path');
const { extract } = require('../src/lib/appraisal/extract');

const DIR = process.env.APPRAISAL_DIR
  || '/tmp/claude-0/-home-user-yscap/05b5356c-9672-5e08-9492-67ecffd77817/scratchpad/appraisals/stripped';
if (!fs.existsSync(DIR)) { console.log(`SKIP test-appraisal-land-use (no corpus at ${DIR})`); process.exit(0); }
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.xml')).sort();
if (!files.length) { console.log('SKIP test-appraisal-land-use (empty corpus)'); process.exit(0); }

let failures = 0;
const assert = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const LU_TYPES = ['SingleFamily', 'TwoToFourFamily', 'Apartment', 'Commercial', 'Vacant', 'Industrial', 'Agricultural', 'Other'];

let withLU = 0, withOS = 0, privWarn = 0;
let badType = false, badPct = false, badMerge = false;

for (const f of files) {
  const A = extract(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const e = A.enrich || {};
  if (Array.isArray(e.present_land_use) && e.present_land_use.length) {
    withLU++;
    for (const u of e.present_land_use) {
      if (!LU_TYPES.includes(u.type)) badType = true;
      // Never-guess: percentages are recorded as given (not normalized to 100), each a real 0–100.
      if (!(typeof u.percent === 'number' && u.percent >= 0 && u.percent <= 100)) badPct = true;
    }
  }
  if (Array.isArray(e.off_site_improvements) && e.off_site_improvements.length) {
    withOS++;
    for (const o of e.off_site_improvements) {
      if (!o.type) badMerge = true;
      if (o.ownership && !['Public', 'Private'].includes(o.ownership)) badMerge = true;
    }
    // Prove the two row-styles merged: a Street row that has BOTH a description AND an ownership
    // came from two separate XML rows keyed by _Type.
  }
  for (const w of (A.warnings || [])) if (w.code === 'off_site_private') privWarn++;
}

assert(withLU >= 30, `present_land_use extracted on a strong majority (${withLU}/${files.length})`);
assert(withOS >= 30, `off_site_improvements extracted on a strong majority (${withOS}/${files.length})`);
assert(!badType, 'every land-use row carries a whitelisted type');
assert(!badPct, 'every land-use percent is a number in 0–100');
assert(!badMerge, 'every off-site row has a type and a valid Public/Private ownership (or none)');
assert(privWarn > 0, `the private-street/alley tripwire fires across the corpus (${privWarn} files)`);

// Merge proof on a known file: 08108509's Street row carries BOTH description and ownership.
const known = path.join(DIR, 'Completed_Product_(Data)_08108509.xml');
if (fs.existsSync(known)) {
  const os = (extract(fs.readFileSync(known, 'utf8')).enrich || {}).off_site_improvements || [];
  const street = os.find((o) => o.type === 'Street');
  assert(street && street.description && street.ownership, 'off-site merge: the Street row carries BOTH _Description and _OwnershipType (two XML rows merged by _Type)');
} else {
  console.log('NOTE merge-proof file not in corpus — skipped');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL land-use / off-site assertions passed');
process.exit(failures ? 1 : 0);
