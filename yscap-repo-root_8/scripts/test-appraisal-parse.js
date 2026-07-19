/**
 * Smoke test for the appraisal XML parser (src/lib/appraisal).
 * Runs it over a directory of real appraisal XMLs and prints form type, ARV/As-Is,
 * comp count, and any tripwire warnings — the way we verify the reader isn't guessing.
 *
 *   APPRAISAL_DIR=/path/to/xmls node scripts/test-appraisal-parse.js
 *
 * No DB, no network. Defaults to the local research corpus if present.
 */
const fs = require('fs');
const path = require('path');
const { extract } = require('../src/lib/appraisal/extract');

const DIR = process.env.APPRAISAL_DIR
  || '/tmp/claude-0/-home-user-yscap/05b5356c-9672-5e08-9492-67ecffd77817/scratchpad/appraisals/stripped';

if (!fs.existsSync(DIR)) {
  console.error(`No appraisal dir at ${DIR}. Set APPRAISAL_DIR.`);
  process.exit(0); // don't fail the suite when the corpus isn't mounted
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.xml')).sort();
let ok = 0, arvCount = 0, asisDefinite = 0;
const byForm = {};
console.log(`file                          form     ARV        As-Is     conf(arv/asis)  cmp  warns`);
for (const f of files) {
  const xml = fs.readFileSync(path.join(DIR, f), 'utf8');
  let r;
  try { r = extract(xml); } catch (e) { console.log(`${f.slice(0, 28).padEnd(30)} PARSE ERROR: ${e.message}`); continue; }
  if (!r.ok) { console.log(`${f.slice(0, 28).padEnd(30)} ${r.error}`); continue; }
  ok++;
  byForm[r.formType] = (byForm[r.formType] || 0) + 1;
  if (r.values.arv != null) arvCount++;
  if (r.values.asIsConfidence === 'definite') asisDefinite++;
  const nm = f.replace('Completed_Product_(Data)_', 'CP_').replace('.xml', '').slice(0, 28).padEnd(30);
  const arv = String(r.values.arv ?? '—').padEnd(10);
  const asis = String(r.values.asIs ?? '—').padEnd(9);
  const conf = `${r.values.arvConfidence.slice(0, 4)}/${r.values.asIsConfidence.slice(0, 4)}`.padEnd(15);
  console.log(`${nm} ${String(r.formType).padEnd(8)} ${arv} ${asis} ${conf} ${String(r.comparables.length).padEnd(4)} ${r.warnings.map((w) => w.code).join(',')}`);
}
console.log(`\nParsed ${ok}/${files.length}. Forms: ${JSON.stringify(byForm)}`);
console.log(`ARV present: ${arvCount}/${ok}  |  As-Is definite: ${asisDefinite}/${ok}`);
