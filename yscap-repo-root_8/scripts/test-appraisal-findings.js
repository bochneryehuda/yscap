/**
 * Smoke test for the PILOT findings engine (src/lib/appraisal/findings).
 * Parses one real appraisal, compares it to a mock loan file with deliberate mismatches,
 * and prints the findings + the badge/blocking summary. No DB, no network.
 */
const fs = require('fs');
const path = require('path');
const { extract } = require('../src/lib/appraisal/extract');
const { computeFindings, summarize } = require('../src/lib/appraisal/findings');

const DIR = process.env.APPRAISAL_DIR
  || '/tmp/claude-0/-home-user-yscap/05b5356c-9672-5e08-9492-67ecffd77817/scratchpad/appraisals/stripped';
const FILE = process.env.APPRAISAL_FILE || 'Completed_Product_(Data)_08108509.xml';
const p = path.join(DIR, FILE);
if (!fs.existsSync(p)) { console.error(`No file ${p}; set APPRAISAL_DIR/APPRAISAL_FILE.`); process.exit(0); }

const A = extract(fs.readFileSync(p, 'utf8'));
console.log(`Appraisal: ${A.formType}  ${A.subject.address}, ${A.subject.city} ${A.subject.state}`);
console.log(`  ARV=${A.values.arv}  As-Is=${A.values.asIs} (${A.values.asIsConfidence})  units=${A.subject.units}\n`);

// Mock loan file with deliberate mismatches: units 2 (appraisal 3), ARV 560k (appraisal 575k),
// As-Is matches (430k), purchase 415k.
const file = {
  property_address: { line: '148 Plymouth St, New Haven, CT' },
  units: 2,
  arv: 560000,
  as_is_value: 430000,
  purchase_price: 415000,
  property_type: 'Multi 2-4',
};

const findings = computeFindings(A, file, { today: '2026-07-19' });
const s = summarize(findings);
console.log(`Findings: ${findings.length}  →  fatal ${s.fatal}, warning ${s.warning}, info ${s.info}  |  blocks CTC: ${s.blocksCtc}\n`);
for (const f of findings) {
  const val = f.appraisalValue != null ? `appraisal=${f.appraisalValue} file=${f.fileValue}` : '';
  console.log(`  [${f.severity.toUpperCase()}] ${f.code} — ${f.title}`);
  if (val) console.log(`      ${val}${f.reprices ? '  (reprices)' : ''}${f.blocksCtc ? '  (blocks CTC)' : ''}`);
  console.log(`      actions: ${(f.actions || []).join(', ')}`);
}

// Sanity assertions (non-fatal — this is a smoke test).
const codes = findings.map((f) => f.code);
const expect = ['units_mismatch', 'arv_mismatch'];
const missing = expect.filter((c) => !codes.includes(c));
console.log(`\n${missing.length ? 'MISSING expected findings: ' + missing.join(', ') : 'OK — expected mismatches (units, ARV) all raised.'}`);

// ---- HARD regression: address-mismatch must read every property_address shape ----
// The portal stores the street under `line1` (normalized) or `oneLine` (display), NOT always
// `line`. A matching file address in any of these shapes must NOT fire a false fatal.
let addrFail = 0;
const addrAssert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) addrFail++; };
const hasAddr = (f) => computeFindings(A, f, { today: '2026-07-19' }).some((x) => x.code === 'address_mismatch');
const subjStreet = A.subject.address;               // e.g. "148 Plymouth St"
const base = { units: A.subject.units, arv: A.values.arv, as_is_value: A.values.asIs };
if (subjStreet) {
  console.log('\n--- address-mismatch regression ---');
  addrAssert(!hasAddr({ ...base, property_address: { line1: subjStreet, city: A.subject.city, state: A.subject.state } }),
    'no false fatal when the street lives in property_address.line1');
  addrAssert(!hasAddr({ ...base, property_address: { oneLine: `${subjStreet}, ${A.subject.city}, ${A.subject.state}` } }),
    'no false fatal when the address is a property_address.oneLine string');
  addrAssert(!hasAddr({ ...base, property_address: { street: subjStreet, city: A.subject.city, state: A.subject.state } }),
    'no false fatal when the street lives in property_address.street');
  addrAssert(hasAddr({ ...base, property_address: { line1: '9999 Nowhere Blvd', city: A.subject.city, state: A.subject.state } }),
    'a genuinely different street STILL fires the fatal (true positive preserved)');
}
if (addrFail) { console.log(`\n${addrFail} ADDRESS REGRESSION FAILURE(S)`); process.exit(1); }
console.log('\nALL address-mismatch regression assertions passed');

// ---- HARD regression: arv_unreadable must key off the computed BASIS, not a raw enum regex ----
// A reno appraisal whose basis extract() resolved to 'ARV' via the AsIs-plus-hypothetical or the
// inferred path (conditionOfAppraisal is 'AsIs'/null, so the old /SubjectTo/ regex missed it) with
// an UNREADABLE arv must still raise the FATAL — else it slips past clear-to-close.
let basisFail = 0;
const bAssert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) basisFail++; };
const codesFor = (vals) => computeFindings({ ...A, formType: 'FNM1004', values: { ...A.values, ...vals } }, base, { today: '2026-07-19' }).map((x) => x.code);
console.log('\n--- arv_unreadable basis regression ---');
bAssert(codesFor({ basis: 'ARV', arv: null, conditionOfAppraisal: 'AsIs' }).includes('arv_unreadable'),
  'basis=ARV via AsIs+hypothetical, arv unreadable → FATAL fires');
bAssert(codesFor({ basis: 'ARV', arv: null, conditionOfAppraisal: null }).includes('arv_unreadable'),
  'basis=ARV inferred (no condition enum), arv unreadable → FATAL fires');
bAssert(codesFor({ basis: 'ARV', arv: null, conditionOfAppraisal: 'SubjectToRepairs' }).includes('arv_unreadable'),
  'belt-and-suspenders: the SubjectTo enum path still fires');
bAssert(!codesFor({ basis: 'ASIS', arv: null, conditionOfAppraisal: 'AsIs' }).includes('arv_unreadable'),
  'a pure As-Is deal (basis=ASIS) does NOT fire the reno-ARV fatal');
if (basisFail) { console.log(`\n${basisFail} BASIS REGRESSION FAILURE(S)`); process.exit(1); }
console.log('\nALL arv_unreadable basis regression assertions passed');
