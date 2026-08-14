#!/usr/bin/env node
'use strict';

/**
 * LONG-TERM — the Encompass field-intelligence layer stays honest.
 *
 * Guards the 2026-08-14 live census that lives in src/longterm/encompass/dictionary/**
 * and the settings registry that makes every tenant-specific choice configurable.
 *
 * It proves four things:
 *   1. the dictionary and catalogs load and are internally consistent;
 *   2. NO borrower PII leaked into the committed data (the census read live loans);
 *   3. the decoded DSCR formula still reproduces the tenant's own stored values;
 *   4. the settings registry is well-formed — every choice has a default and a key,
 *      so nothing tenant-specific is hard-coded somewhere else.
 *
 *   node scripts/test-lt-encompass-intelligence.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const ok = (m) => console.log('  ok  ', m);
const bad = (m) => { console.error('  FAIL', m); failures++; };
const check = (cond, m) => (cond ? ok(m) : bad(m));

console.log('LT Encompass field intelligence');

// ── 1. The census loads and is consistent ────────────────────────────────────
const enc = require(path.join(ROOT, 'src/longterm/encompass'));
const I = enc.intelligence;

check(I.META.loansAnalyzed >= 100,
  `census covers ${I.META.loansAnalyzed} loans (the owner asked for at least 100)`);
check((I.META.cohorts || {}).DSCR >= 100,
  `${(I.META.cohorts || {}).DSCR} long-term (DSCR) loans analysed`);
check(I.ids().length > 1000, `${I.ids().length} field ids carry evidence`);

const dscrRatio = I.field('CUST01FV');
check(!!dscrRatio, 'the DSCR field (CUST01FV) is in the dictionary');
check(dscrRatio && dscrRatio.calculated === true && /1005/.test(dscrRatio.calculation || ''),
  'the DSCR field carries the tenant calculation');

const rent = I.field('1005');
const piti = I.field('912');
check(rent && rent.contractPath === 'loan.subjectPropertyGrossRentalIncomeAmount',
  'field 1005 resolves to the gross-rent contract path');
check(piti && piti.contractPath === 'loan.proposedHousingExpenseTotal',
  'field 912 resolves to the proposed-total-housing contract path');

// Every entry must carry the things a developer needs to use it.
const missing = I.ids().filter((id) => {
  const f = I.field(id);
  return !f || !f.id || !f.kind || !f.fill || typeof f.fill.dscrPct !== 'number';
});
check(missing.length === 0, `every dictionary entry has id/kind/fill (${missing.length} malformed)`);

check(enc.programs.programs.length >= 5, `${enc.programs.programs.length} loan programs catalogued`);
check(enc.conditionLibrary.templates.length > 100,
  `${enc.conditionLibrary.templates.length} condition templates captured`);
check(enc.efolderCatalog.documentTypes.length > 100,
  `${enc.efolderCatalog.documentTypes.length} eFolder document types captured`);
check(enc.apiSurface.working().length > 0 && enc.apiSurface.blocked().length > 0,
  'the API surface records both working and blocked endpoints');

// ── 2. No borrower PII in the committed census ───────────────────────────────
// The census read 772 live loans. Identifying fields must be withheld, not stored.
const DICT_DIR = path.join(ROOT, 'src/longterm/encompass/dictionary');
const raw = fs.readdirSync(DICT_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => fs.readFileSync(path.join(DICT_DIR, f), 'utf8'))
  .join('\n');

for (const id of ['4000', '4002', '65', '1240', '66', '1402', '11', '12', '15']) {
  const f = I.field(id);
  if (!f) continue;
  check(!f.observedValues && f.valuesWithheld === 'identifying-or-high-cardinality',
    `field ${id} (${f.label}) withholds its values`);
}
// A structural backstop: nothing shaped like an SSN or an email address anywhere.
check(!/\b\d{3}-\d{2}-\d{4}\b/.test(raw), 'no SSN-shaped value in the committed census');
check(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|net|org)\b/.test(raw),
  'no email-shaped value in the committed census');

// ── 3. The decoded DSCR formula still reproduces the tenant's values ─────────
// These rent / housing-expense pairs and their ratios were read from live loans.
const CASES = [[2450, 1700.81, 1.44], [6000, 4949.12, 1.21], [2000, 1241.40, 1.61],
  [2850, 4549.20, 0.63], [4575, 1983.47, 2.31], [3100, 2959.47, 1.05]];
let dscrOk = true;
for (const [r, p, expected] of CASES) {
  if (enc.formulas.computeDscr(r, p) !== expected) dscrOk = false;
}
check(dscrOk, 'computeDscr reproduces the stored DSCR on every recorded live example');
check(enc.formulas.computeDscr(1000, 0) === null, 'computeDscr refuses a zero denominator');
check(enc.formulas.computeDscr(null, 1000) === null, 'computeDscr refuses a missing numerator');

// The CX.PITIA defect must stay documented — it is filled on ~all long-term files.
const defect = enc.formulas.KNOWN_DEFECTS.find((d) => d.fieldId === 'CX.PITIA');
check(!!defect && /912/.test(defect.correctSource || ''),
  'the CX.PITIA defect is recorded and points at field 912 instead');

// ── 4. The settings registry is well-formed ──────────────────────────────────
const S = require(path.join(ROOT, 'src/longterm/settings/encompass-settings'));

check(S.SETTINGS.length >= 20, `${S.SETTINGS.length} settings declared`);
const keys = S.SETTINGS.map((s) => s.key);
check(new Set(keys).size === keys.length, 'every setting key is unique');
const incomplete = S.SETTINGS.filter((s) => !s.key || !s.group || !s.label || !s.description
  || !s.type || s.default === undefined);
check(incomplete.length === 0,
  `every setting has key/group/label/description/type/default (${incomplete.length} incomplete)`);

// Our defaults must match what the census actually found.
const d = S.defaults();
check(d['dscr.ratioFieldId'] === 'CUST01FV', 'DSCR ratio field defaults to CUST01FV');
check(d['dscr.rentFieldId'] === '1005' && d['dscr.housingExpenseFieldId'] === '912',
  'DSCR inputs default to fields 1005 and 912');
check(d['efolder.writesEnabled'] === false,
  'eFolder writes ship OFF (authorized but not yet built or verified)');
check(d['conditions.model'] === 'enhanced',
  'the condition model defaults to Enhanced Conditions, not the legacy endpoints');
check(d['milestones.currentNameFieldId'] === 'MS.STATUS',
  'the current milestone reads from MS.STATUS (the pipeline column is blank in this tenant)');

// Overrides work, and a typo can never silently become configuration.
const r1 = S.resolve({ 'dscr.minimumRatio': 1.15 });
check(r1.settings['dscr.minimumRatio'] === 1.15, 'an override replaces our default');
check(r1.settings['dscr.ratioFieldId'] === 'CUST01FV', 'unrelated defaults survive an override');
const r2 = S.resolve({ 'dscr.mimimumRatio': 9 });
check(r2.rejectedKeys.includes('dscr.mimimumRatio'), 'an unknown setting key is rejected, not absorbed');

check(S.classifyProgram('Investor DSCR 30 YEAR FRM') === 'long-term', 'DSCR classifies as long-term');
check(S.classifyProgram('DSCR I/O 40 Year FRM') === 'long-term', 'DSCR I/O classifies as long-term');
check(S.classifyProgram('Fix & Flip Purchase + reno') === 'short-term', 'Fix & Flip classifies as short-term');
check(S.classifyProgram('') === 'other', 'an unknown program classifies as other, never as ours');

// ── 5. The investor registry resolves the mess to one identity ───────────────
const INV = enc.investors;
check(INV.INVESTORS.length >= 25, `${INV.INVESTORS.length} canonical investors registered`);
check(INV.summary().recordedSpellings >= 100,
  `${INV.summary().recordedSpellings} observed spellings recorded`);

// Every canonical entry must resolve to ITSELF from its own label and every alias.
let aliasMiss = 0;
for (const inv of INV.INVESTORS) {
  for (const a of [inv.label, ...inv.aliases]) {
    const r = INV.resolve(a);
    if (r.key !== inv.key) { aliasMiss++; console.error(`       ${JSON.stringify(a)} -> ${r.key} (want ${inv.key})`); }
  }
}
check(aliasMiss === 0, `every recorded spelling resolves to its own investor (${aliasMiss} misses)`);

// The specific pairs the owner named.
check(INV.sameInvestor('EmCap', 'EMCAP Financial'), 'EmCap === EMCAP Financial');
check(INV.sameInvestor('Oaktree', 'OAK TREE'), 'Oaktree === OAK TREE (the space does not matter)');
check(INV.sameInvestor('Deephaven Mortgage LLC', 'Deepahven'), 'a typo still resolves to Deephaven');
check(INV.sameInvestor('A&D Mortgage, LLC', 'AD'), 'the short code AD === A&D Mortgage');
check(!INV.sameInvestor('Deephaven', 'Oaktree'), 'two different investors never collapse');

// Junk must never resolve into a real company.
for (const nv of INV.NON_VALUES) {
  const r = INV.resolve(nv.raw);
  check(r.key === null, `${JSON.stringify(nv.raw)} does not resolve to an investor`);
}
check(INV.resolve('').key === null, 'a blank name resolves to nothing');
check(INV.resolve(null).key === null, 'a null name resolves to nothing');
check(!INV.sameInvestor('---', '--'), 'two placeholders are not "the same investor"');

// A company we have never seen must come back unresolved rather than guessed.
check(INV.resolve('Wells Fargo Home Mortgage').key === null,
  'an unknown investor is left unresolved, never guessed');

// ── 6. The dropdown catalog is usable for mapping ────────────────────────────
const DD = enc.dropdowns;
check(Object.keys(DD.FIELDS).length > 500,
  `${Object.keys(DD.FIELDS).length} constrained fields catalogued`);
check(DD.normalizeValue('Y') === 'true' && DD.normalizeValue(false) === 'false'
  && DD.normalizeValue('N') === 'false' && DD.normalizeValue(true) === 'true',
  'Y/N and true/false normalize to one representation');
check(DD.normalizeValue('Purchase') === 'Purchase', 'a non-boolean value passes through unchanged');
check(DD.normalizeValue(null) === null, 'a missing value stays missing');

// Custom dropdowns publish no options — their inferred set must say so.
const inferred = DD.list({ inferredOnly: true });
check(inferred.length > 0, `${inferred.length} custom dropdowns carry INFERRED options`);
check(inferred.every((f) => DD.options(f.id).every((o) => o.inferred)),
  'every option on a custom dropdown is flagged inferred, never presented as authoritative');

// The doc-type finding must stay recorded — the base milestone rule depends on it.
const docType = DD.NOTABLE.find((n) => n.fieldId === '2867');
check(!!docType && docType.observed.includes('DSCR'),
  "the loan-doc-type drift ('DSCR' is not a valid code) is recorded");
check(DD.isKnownValue('2867', 'NoDocumentation'), 'NoDocumentation is a known doc-type value');

// ── done ─────────────────────────────────────────────────────────────────────
if (failures) {
  console.error(`\nFAILED — ${failures} check(s).`);
  process.exit(1);
}
console.log('\nOK — the LT Encompass field intelligence is well-formed, PII-free and settings-driven.');
