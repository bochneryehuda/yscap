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
