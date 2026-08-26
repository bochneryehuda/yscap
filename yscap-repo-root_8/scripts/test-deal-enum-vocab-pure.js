'use strict';
/*
 * EVERY VALUE A DOOR CAN PRODUCE MUST REACH A REAL CLICKUP OPTION.
 *
 * Owner-reported 2026-08-26, file YSCAP258134859 (598 Pawling Ave, Troy NY):
 * *"This is a fix and hold, not a fix and flip, but it was not filled in ClickUp
 * as a fix and hold. I think the program field was empty. Check it out … Check
 * out the actual dropdown that is available in ClickUp through the connector."*
 *
 * WHAT THE CONNECTOR SHOWED (captured verbatim into
 * scripts/fixtures/clickup-deal-dropdowns.json): the *Program dropdown DOES carry
 * "Fix & Hold With Construction", and the crosswalk maps our canonical
 * 'Fix & Hold' onto it in both directions. The mapping was never broken. What was
 * broken is that the PUBLIC loan application files its own display dialect —
 * 'Fix & Hold (BRRRR)' — and the push has no key for it, so it dropped the field
 * IN SILENCE. Measured over the form's own options: 3 of 4 programs, BOTH
 * refinances, 5 of 7 property types and 2 of 5 rehab types.
 *
 * THIS SUITE IS GENERATED FROM THE DOORS, WHICH IS THE POINT. It reads the
 * marketing form's actual <option value> attributes and the portal's actual
 * picker lists out of the source, so a door that adds an option nobody mapped
 * fails the build instead of quietly filing a blank card. A hand-typed list of
 * "values to check" would go stale on the next option somebody adds — which is
 * precisely how this happened.
 *
 * PURE — no database, no network.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const VOCAB = require('../src/lib/enum-vocab');
const X = require('../src/clickup/crosswalk');

let n = 0;
const ok = (m) => { n++; console.log('PASS ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); ok(m); };
const yes = (v, m) => { assert.ok(v, m); ok(m); };

const ROOT = path.join(__dirname, '..');
const SRC = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const LIVE = JSON.parse(SRC('scripts/fixtures/clickup-deal-dropdowns.json'));
/* The crosswalk's option-list argument wants ClickUp's own shape — objects
   carrying `name` — so it is handed the captured objects verbatim rather than a
   list of strings (a string array silently matches NOTHING in `notInOptions` and
   would make every value look unmappable, which is a fact about the test rather
   than about the code). */
const liveOptions = (col) => LIVE.fields[col].options || [];
const optionNames = (col) => liveOptions(col).map((o) => o.name);
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const offeredLive = (col, label) => label != null && optionNames(col).some((o) => norm(o) === norm(label));

// ── A. THE OWNER'S OWN FILE ─────────────────────────────────────────────────
console.log("\nA. the reported file: a Fix & Hold that could not fill its ClickUp field");
{
  // What the public form sends, and therefore what intake.js used to file raw.
  const raw = 'Fix & Hold (BRRRR)';
  eq(VOCAB.canonicalEnum('program', raw), 'Fix & Hold', 'A1 the form value canonicalizes to the spelling the rest of the system uses');
  eq(X.toClickUpLabel('program', raw), 'Fix & Hold With Construction', 'A2 and it now reaches a ClickUp option instead of being dropped');
  yes(offeredLive('program', 'Fix & Hold With Construction'), 'A3 that option really is in the LIVE dropdown (captured from the workspace, not assumed)');
  eq(X.unmappableToClickUp('program', raw, liveOptions('program')), false, 'A4 so it no longer reads as "PILOT has a value ClickUp cannot hold"');
  // The read side must still land on OUR canonical spelling, or the two
  // directions drift and the inbound pull starts storing the alias.
  eq(X.fromClickUpLabel('program', 'Fix & Hold With Construction'), 'Fix & Hold', 'A5 the inbound read still stores the canonical value — the write-side fold never touched the read side');
}

// ── B. EVERY OPTION THE PUBLIC FORM OFFERS ──────────────────────────────────
console.log('\nB. the public loan application — read out of the form itself');
const FORM = SRC('web/v2/tools/loan-application.html');

/* Pull the <option value="…"> list for one <select id="…">, and the radio values
   for one radio group. Reading the FORM rather than a copy of it is what keeps
   this test honest as the form changes. */
function selectOptions(id) {
  const m = FORM.match(new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`));
  assert.ok(m, `the form still has a <select id="${id}"> — if it was renamed, point this test at the new id rather than deleting the check`);
  return [...m[1].matchAll(/<option value="([^"]*)"/g)].map((x) => x[1].replace(/&amp;/g, '&')).filter(Boolean);
}
function radioValues(name) {
  const vals = [...FORM.matchAll(new RegExp(`name="${name}" value="([^"]*)"`, 'g'))].map((x) => x[1].replace(/&amp;/g, '&'));
  assert.ok(vals.length, `the form still has a radio group named "${name}"`);
  return [...new Set(vals)];
}

const DOORS = [
  { col: 'program', label: 'Deal / project type', values: selectOptions('dealType') },
  { col: 'loan_type', label: 'Loan purpose', values: radioValues('purpose') },
  { col: 'property_type', label: 'Property type', values: selectOptions('propType') },
  { col: 'rehab_type', label: 'Rehab type', values: selectOptions('rehabType') },
];

/* A value with NO ClickUp option at all is a different, already-handled fact —
   it is kept in PILOT and parked as a review by inbound-enum-guard. It is listed
   here BY NAME so it is a recorded decision rather than a silent exemption. */
const NO_CLICKUP_TWIN = {
  property_type: ['PUD'],   // the live dropdown has no PUD option; folding it into
                            // Townhouse or SFR would file a type nobody chose.
};

for (const d of DOORS) {
  yes(d.values.length >= 3, `B1 ${d.label}: read ${d.values.length} options straight out of the form`);
  for (const v of d.values) {
    const canon = VOCAB.canonicalEnum(d.col, v);
    const label = X.toClickUpLabel(d.col, canon);
    if ((NO_CLICKUP_TWIN[d.col] || []).includes(v)) {
      yes(label == null, `B2 ${d.label} "${v}" has no ClickUp option and is deliberately left alone`);
      continue;
    }
    yes(label != null, `B3 ${d.label} "${v}" reaches a ClickUp label ("${label}") instead of being dropped in silence`);
    yes(offeredLive(d.col, label), `B4 ${d.label} "${v}" -> "${label}", which the LIVE dropdown actually offers`);
  }
}

// ── C. EVERY VALUE THE PORTAL'S OWN PICKERS OFFER ───────────────────────────
console.log('\nC. the portal pickers — read out of the shared enum');
const ENUMS = SRC('app-v2/src/lib/enums.js');
function enumList(name) {
  const m = ENUMS.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\];`));
  assert.ok(m, `enums.js still exports ${name}`);
  return [...m[1].matchAll(/value:\s*'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1].replace(/\\'/g, "'"));
}
/* 'Not sure yet' maps to null ON PURPOSE — leave the ClickUp field blank for the
   officer to set — and 'DSCR / Rental' is the documented no-twin value. */
const DELIBERATE = new Set(['Not sure yet', 'DSCR / Rental']);
for (const [name, col] of [['PROGRAMS', 'program'], ['PROPERTY_TYPES', 'property_type'], ['LOAN_TYPES', 'loan_type']]) {
  const vals = enumList(name);
  yes(vals.length >= 4, `C1 ${name}: read ${vals.length} canonical values from the shared enum`);
  for (const v of vals) {
    if (DELIBERATE.has(v)) { ok(`C2 ${name} "${v}" is a recorded exception (deliberate blank / no ClickUp twin)`); continue; }
    const label = X.toClickUpLabel(col, v);
    yes(label != null && offeredLive(col, label), `C3 ${name} "${v}" -> "${label}", offered by the live dropdown`);
  }
}
yes(enumList('PROGRAMS').includes('Fix & Hold'), 'C4 Fix & Hold is on the shared program list — the owner\'s whole point');

// ── D. THE ALIAS TABLE CANNOT INVENT A VALUE ────────────────────────────────
console.log('\nD. every canonical side of the alias table is a value the crosswalk knows');
/* An alias may only point at a value the system genuinely uses: either one the
   ClickUp crosswalk can translate, or one the shared portal enum offers that is
   RECORDED as having no ClickUp twin (DSCR / Rental — kept in PILOT and parked as
   a review by inbound-enum-guard). Anything else is an alias pointing nowhere,
   which is worse than no alias: it rewrites a value into a spelling that then
   fails just as silently, one step further along. */
const ENUM_VALUES = {
  program: new Set(enumList('PROGRAMS').map(norm)),
  property_type: new Set(enumList('PROPERTY_TYPES').map(norm)),
  loan_type: new Set(enumList('LOAN_TYPES').map(norm)),
};
for (const col of VOCAB.COLUMNS) {
  const to = (X.FIELDS[col] || {}).to || {};
  const known = new Set(Object.keys(to).map(norm));
  for (const [alias, canon] of Object.entries(VOCAB.ALIASES[col])) {
    if (known.has(norm(canon))) { ok(`D1 ${col}: "${alias}" -> "${canon}", a value the ClickUp crosswalk can translate`); continue; }
    yes(DELIBERATE.has(canon) && (ENUM_VALUES[col] || new Set()).has(norm(canon)),
      `D1b ${col}: "${alias}" -> "${canon}" — a real portal value with no ClickUp twin, and RECORDED as one (never an alias pointing nowhere)`);
  }
}
eq(VOCAB.canonicalEnum('program', 'Something Nobody Has Ever Typed'), 'Something Nobody Has Ever Typed',
  'D2 an unrecognised value passes through UNCHANGED — never blanked, never nudged into a neighbouring option');
eq(VOCAB.canonicalEnum('program', null), null, 'D3 null stays null');
eq(VOCAB.canonicalEnum('program', ''), '', 'D4 blank stays blank');
eq(VOCAB.canonicalEnum('no_such_column', 'x'), 'x', 'D5 an unknown column is a pass-through, never a throw');
eq(VOCAB.canonicalEnum('property_type', 'PUD'), 'PUD', 'D6 PUD is deliberately NOT folded into another type');
// The dash fold: the portal writes an EN DASH in 'Multi 2–4' and every other
// producer writes a hyphen. CLAUDE.md already records that character costing a day.
eq(VOCAB.canonicalEnum('property_type', 'Multi 2-4'), 'Multi 2–4', 'D7 a hyphen folds to the portal\'s en-dash spelling');
eq(VOCAB.canonicalEnum('property_type', '2-4 Unit'), 'Multi 2–4', 'D8 and so does the form\'s own hyphenated spelling');

// ── E. CANONICALIZING CHANGES NO PRICE ──────────────────────────────────────
console.log('\nE. price-neutrality — the frozen engines read the alias and the canonical value identically');
{
  const pricing = require('../src/lib/pricing');
  const PT = require('../src/lib/property-type');
  const dealBasis = require('../src/lib/deal-basis');
  // engineStrategy is what decides which matrix a deal is priced on, so if an
  // alias and its canonical twin answered differently the fold would move money.
  const strategyOf = pricing.engineStrategy;
  yes(typeof strategyOf === 'function', 'E0 engineStrategy is reachable — without it there is no proof, only a claim');
  /* The engine's four RECOGNISED strategies. Anything else falls through
     `engineStrategy` unchanged, which means the engine prices it on no matrix at
     all — so for such a value "the same strategy" is not a meaningful claim and
     the honest property is that it is unrecognised on BOTH sides of the fold.
     Stated over the values a DOOR can actually produce, not over the alias
     table's lookup keys (those are lower-cased for matching and are not values
     anything stores). */
  const RECOGNISED = new Set(['Fix & Flip', 'Fix & Hold (BRRRR)', 'Bridge / Stabilized', 'Ground-up Construction']);
  const doorProgramValues = [...new Set([].concat(
    DOORS.find((d) => d.col === 'program').values,
    enumList('PROGRAMS'),
    ['DSCR Rental', 'SFR', 'Fix and Hold', 'Fix & Hold With Construction'],   // spellings older doors wrote
  ))];
  for (const v of doorProgramValues) {
    const before = strategyOf(v);
    const after = strategyOf(VOCAB.canonicalEnum('program', v));
    if (RECOGNISED.has(before) || RECOGNISED.has(after)) {
      eq(after, before, `E1 program "${v}" prices on exactly the same strategy after the fold`);
    } else {
      yes(!RECOGNISED.has(before) && !RECOGNISED.has(after),
        `E1 program "${v}" is priced on no matrix either way — the fold cannot move a number the engine never read`);
    }
  }
  // And the whole point of the owner's file, spelled out.
  eq(strategyOf('Fix & Hold (BRRRR)'), strategyOf('Fix & Hold'),
    'E1b the reported file prices identically before and after the fold — this changes which LABEL is stored, never what is priced');
  eq(strategyOf('Fix & Hold'), 'Fix & Hold (BRRRR)', 'E1c and that shared strategy is the engine\'s fix & hold matrix, not a fallthrough');
  // Whether it is exported or not, the property-type and refinance readings are.
  /* THE PROPERTY TYPE IS THE ONE THAT COULD REALLY BITE: db/322's reopen trigger
     compares it BY MEANING, so a fold that changed the meaning would flag every
     touched registration stale and reopen Products & Pricing across the book. */
  const doorPropValues = [...new Set([].concat(
    DOORS.find((d) => d.col === 'property_type').values,
    enumList('PROPERTY_TYPES'),
    ['SFR', 'Multi 2-4', 'Mixed Use'],   // the ClickUp labels the completeness panel used to write
  ))];
  for (const v of doorPropValues) {
    eq(PT.propertyTypeCompareKey(VOCAB.canonicalEnum('property_type', v)), PT.propertyTypeCompareKey(v),
      `E2 property type "${v}" MEANS the same after the fold — no registration is flagged stale by it`);
  }
  const doorLoanValues = [...new Set([].concat(
    DOORS.find((d) => d.col === 'loan_type').values, enumList('LOAN_TYPES'),
  ))];
  for (const v of doorLoanValues) {
    eq(dealBasis.sizesOnAsIsValue(VOCAB.canonicalEnum('loan_type', v)), dealBasis.sizesOnAsIsValue(v),
      `E3 loan type "${v}" is sized on the same basis after the fold`);
  }
}

// ── F. SOURCE GUARDS — no door keeps its own private copy of the list ───────
console.log('\nF. source guards');
{
  for (const f of ['app-v2/src/screens/Apply.jsx', 'app-v2/src/screens/StaffNewFile.jsx', 'app-v2/src/screens/StaffApplication.jsx']) {
    const src = stripComments(SRC(f));
    yes(/from '\.\.\/lib\/enums\.js'/.test(src), `F1 ${path.basename(f)} takes its program list from the shared enum`);
    yes(!/const PROGRAMS = \[/.test(src), `F2 ${path.basename(f)} keeps no hand-copied program array of its own`);
  }
  const nf = stripComments(SRC('app-v2/src/screens/StaffNewFile.jsx'));
  yes(!/'DSCR Rental'/.test(nf), "F3 the new-file form no longer offers 'DSCR Rental' — a spelling nothing else in the system accepts");
  const sa = stripComments(SRC('app-v2/src/screens/StaffApplication.jsx'));
  yes(!/options: \['SFR',/.test(sa), 'F4 the completeness panel no longer offers the CLICKUP labels as property types');
  const intake = stripComments(SRC('src/routes/intake.js'));
  for (const col of ['program', 'property_type', 'rehab_type', 'loan_type']) {
    yes(new RegExp(`canonicalEnum\\('${col}'`).test(intake), `F5 the public intake door canonicalizes ${col} on the way in`);
  }
  const cw = stripComments(SRC('src/clickup/crosswalk.js'));
  yes(/VOCAB\.canonicalEnum\(key, rawValue\)/.test(cw), 'F6 the ClickUp WRITE folds a dialect first, so rows already stored in one push correctly with no column rewrite');
  yes(!/VOCAB/.test(cw.split('function inverseFor')[1].split('function toClickUpLabel')[0] || ''),
    'F7 the READ side (inverseFor) is untouched — the inbound pull keeps landing on our canonical spelling');
}

console.log(`\ntest-deal-enum-vocab-pure: all ${n} checks passed.`);
