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

// ── 5b. The investor identity chain, and the number that must survive ────────
// Owner-directed: the shorthand name comes first, the accurate name later, and the
// investor's OWN loan number last — and that last one must survive everything.
check(INV.IDENTITY_CHAIN.length === 3, 'the identity chain has three steps');
check(INV.IDENTITY_CHAIN[0].fieldId === 'CX.WHICHINVESTOR', 'step 1 is the shorthand name');
check(INV.IDENTITY_CHAIN[1].fieldId === 'VEND.X263', 'step 2 is the accurate name');
check(INV.IDENTITY_CHAIN[2].fieldId === 'VEND.X276', "step 3 is the investor's loan number");
check(INV.INVESTOR_LOAN_NUMBER_FIELD === 'VEND.X276', 'the loan-number field is VEND.X276');

// The field id this is NOT. VEND.X267 holds postcodes in the live tenant, so keying
// the loan number on it would store a PO-Box postcode as the investor's loan number.
const zip = INV.INVESTOR_FIELDS.find((f) => f.fieldId === 'VEND.X267');
check(!!zip && /zip/i.test(zip.label), 'VEND.X267 is recorded as the investor ZIP, not a loan number');
check(INV.INVESTOR_LOAN_NUMBER_FIELD !== 'VEND.X267', 'the loan number is never keyed on the ZIP field');
const refField = INV.INVESTOR_FIELDS.find((f) => f.fieldId === 'VEND.X276');
check(!!refField && refField.mustSurvive === true, 'the investor loan number is marked must-survive');

// Real investor loan numbers seen live must be kept verbatim, whatever their shape.
for (const n of ['25098221', '5260318508', '12025062483', '175154', 'ABC-99/2']) {
  const r = INV.investorLoanNumber(n);
  check(r.usable && r.value === n, `investor loan number ${JSON.stringify(n)} is kept verbatim`);
}
// …and the things that are provably NOT a loan number are refused with a reason.
for (const [bad, why] of [['Broadview funding', 'investor name'], ['---', 'placeholder'],
  ['', 'blank'], [null, 'blank'], ['   ', 'blank'], ['//', 'no letters or digits']]) {
  const r = INV.investorLoanNumber(bad);
  check(!r.usable && !!r.reason, `${JSON.stringify(bad)} is refused as a loan number (${why})`);
}
check(INV.investorLoanNumber('Deephaven').usable === false,
  'an investor NAME in the loan-number box never becomes a loan number');

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

// ── 7. Term structures, PITI and the DSCR arithmetic ─────────────────────────
// The owner named the shapes he expects ("10 years interest only and 40 year … regular
// 30 year fix … 20 year term"). These pin what the LIVE book actually contains, so a
// future edit cannot quietly invent a product the tenant has never written.
const T = require(path.join(ROOT, 'src/longterm/encompass/terms'));

check(T.TERM_STRUCTURES.length >= 6, `${T.TERM_STRUCTURES.length} term structures recorded`);
check(T.TERM_STRUCTURES.every((s) => typeof s.plainEnglish === 'string' && s.plainEnglish.length > 30),
  'every term structure is explained in plain words, not just numbers');

const fixed30 = T.TERM_STRUCTURES.find((s) => s.key === 'fixed_30');
check(fixed30 && fixed30.termMonths === 360 && fixed30.interestOnlyMonths === null,
  'the 30-year fixed is 360 months with no interest-only period');
check(fixed30 && fixed30.loans === 444, 'the 30-year fixed is the bulk of the book (444 loans)');

const io30 = T.TERM_STRUCTURES.find((s) => s.key === 'io_10_then_30');
check(io30 && io30.termMonths === 360 && io30.interestOnlyMonths === 120 && io30.amortizingMonths === 240,
  "the owner's 30-year / 10-year-IO amortizes over the REMAINING 240 months");
const io40 = T.TERM_STRUCTURES.find((s) => s.key === 'io_10_then_40');
check(io40 && io40.termMonths === 480 && io40.interestOnlyMonths === 120 && io40.amortizingMonths === 360,
  "the owner's 40-year / 10-year-IO amortizes over the remaining 360 months");

// The interest-only period is in MONTHS. Reading 120 as years, or as a loan term,
// would size the payment on a completely different loan.
check(T.TERM_FIELDS.interestOnlyMonths.fieldId === '1177'
  && T.TERM_FIELDS.interestOnlyMonths.unit === 'months',
  'the interest-only period is field 1177 and is recorded in MONTHS');
check(T.TERM_FIELDS.termMonths.fieldId === '4' && T.TERM_FIELDS.termMonths.unit === 'months',
  'the loan term is field 4, also in months — a different field from the IO period');

// What the owner named that the tenant does not contain must stay recorded as absent,
// never quietly added as though we had seen it.
const twenty = T.TERM_STRUCTURES_NOT_PRESENT.find((s) => s.termMonths === 240);
check(!!twenty && twenty.loans === 0, 'the 20-year term is recorded as NOT present in the book');
check(!T.TERM_STRUCTURES.some((s) => s.termMonths === 240),
  'no 20-year structure is claimed as observed');
check(!T.TERM_STRUCTURES.some((s) => s.termMonths === 120),
  'no 10-year TERM is claimed — 120 in this book is always the interest-only period');

// PITI: read the total, never rebuild it.
check(T.PITI.totalFieldId === '912', 'the housing-expense total is field 912');
check(T.PITI.components.length === 7, 'all seven PITI components are recorded');
check(T.PITI.components.some((c) => c.fieldId === '228')
  && T.PITI.components.some((c) => c.fieldId === '1405')
  && T.PITI.components.some((c) => c.fieldId === '230'),
  'P&I, taxes and hazard insurance are all named components');
check(/never rebuild it/i.test(T.PITI.theOtherThirtyNine.consequence),
  'the rule "read the total, never rebuild it" is written down with its reason');

// DSCR: the formula is exact; the outlier is an input problem, and our own helper refuses it.
check(T.DSCR_MEASURED.verification.includes('323'),
  'the DSCR formula is recorded as verified on every file that carries one');
check(T.DSCR_MEASURED.outlier.piti === 0.02,
  'the 300,000 DSCR outlier is recorded as a two-cent PITI, not a formula fault');
check(enc.formulas.computeDscr(6000, 0.02) === 300000,
  'the formula itself does reproduce the outlier from those inputs');

// describeStructure must DESCRIBE, never round an unseen shape into a known one.
const d1 = T.describeStructure(360, 120);
check(d1 && d1.amortizingMonths === 240 && d1.knownStructure === true,
  'a 30-year with 120 IO months describes itself and is flagged known');
const d2 = T.describeStructure(240, null);
check(d2 && d2.termMonths === 240 && d2.knownStructure === false,
  'a 20-year is described honestly and flagged as NOT a structure we have seen');
check(T.describeStructure(null, 120) === null, 'no term means no structure, never a guess');
check(T.describeStructure(0, 0) === null, 'a zero term is refused');
check(T.amortizingMonths(360, 400) === 0,
  'an interest-only period longer than the term leaves nothing amortizing, never a negative');
check(T.amortizingMonths(360, '') === 360, 'a blank interest-only period means none');
check(T.amortizingMonths('abc', 1) === null, 'junk in means null out, never NaN');

// The ARM defect must stay recorded — field 608 says "Fixed" on both ARM files.
const armDefect = T.KNOWN_TERM_DEFECTS.find((x) => x.key === 'DEFECT-AMORT-ARM');
check(!!armDefect && /program name/i.test(armDefect.ourRule),
  'our rule is to read fixed-vs-adjustable from the program name, not field 608');

// ── 8. The CX.PITIA finding, and the fix ─────────────────────────────────────
// The owner challenged this one directly ("I do believe it's correct"), so the
// evidence is pinned rather than left as a comment. Field LABELS alone are not
// proof; what settles it is that the formula REPRODUCES the stored value, that the
// result is not a monthly payment, and that the label's own five fields land on the
// real housing expense exactly.
check(!!defect, 'the CX.PITIA finding is recorded');
check(defect.calculation === 'Sum([#228], [#140], [#136], [#142], [#144])',
  'the tenant formula is recorded verbatim, not paraphrased');
check(Object.keys(defect.proof || {}).length === 4,
  'the finding carries all four independent proofs, not just the field labels');
check(/760 of 761/.test(defect.proof['1']),
  'proof 1: the formula was shown to REPRODUCE the stored value on the live loans');
check(/standardFields/.test(defect.proof['2']) && /CX\.RTLDOWNPAYMENT/.test(defect.proof['2']),
  "proof 2: the field ids come from ICE's own schema, corroborated by the tenant's own other formula");
check(/ZERO land within 2%/.test(defect.proof['3']),
  'proof 3: the result is not a monthly payment on a single one of 451 loans');

// The fix must be the label's OWN five fields, all from the Expenses Proposed block.
check(defect.theFix.calculation === 'Sum([#228], [#1405], [#230], [#232], [#233])',
  'the recorded fix is P&I + Taxes + Insurance + MI + HOA — exactly what the label promises');
for (const id of ['228', '1405', '230', '232', '233']) {
  check(defect.theFix.calculation.includes(`[#${id}]`), `the fix uses field ${id}`);
}
for (const id of ['140', '136', '142', '144']) {
  check(!defect.theFix.calculation.includes(`[#${id}]`),
    `the fix drops field ${id} — it is not a monthly housing expense`);
}
check(/88% land\s+within 2%/.test(defect.theFix.verified) && /median gap \$0\.00/.test(defect.theFix.verified),
  'the fix was VERIFIED against the real housing expense, not merely proposed');

// And the rule that makes all of this harmless to us either way.
check(/never reads CX\.PITIA/i.test(defect.ourRule) && /912/.test(defect.ourRule),
  'our own rule stands: the long-term side reads field 912, never CX.PITIA');
check(!/CX\.PITIA/.test(enc.formulas.DSCR_RATIO.calculation),
  'the DSCR formula itself does not touch CX.PITIA');

// ── done ─────────────────────────────────────────────────────────────────────
if (failures) {
  console.error(`\nFAILED — ${failures} check(s).`);
  process.exit(1);
}
console.log('\nOK — the LT Encompass field intelligence is well-formed, PII-free and settings-driven.');
