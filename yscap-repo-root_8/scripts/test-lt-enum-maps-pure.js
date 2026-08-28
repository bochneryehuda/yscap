'use strict';
/**
 * LT test — EVERY VALUE MAP IS KEYED ON WHAT ENCOMPASS ACTUALLY SENDS.
 *
 * WHY THIS EXISTS. `AMORTIZATION` mapped `fixed`, `adjustable` and `arm`. Field
 * 608's real values, measured across 772 live loans, are `Fixed` (765 loans) and
 * `AdjustableRate` (1). `enumOf` lowercases and strips non-letters, so the tenant's
 * own word keys as `adjustablerate` — which the map did not carry. The one
 * adjustable-rate loan in the entire book therefore fell through to null: two of
 * the map's three keys were spellings nobody has ever sent, and only `fixed` could
 * match anything.
 *
 * AND NULL DID NOT LEAVE IT BLANK. `amortization_type` is `NOT NULL DEFAULT
 * 'fixed'` and the sync COALESCEs onto what is already in the row, so that loan
 * mirrored as **FIXED** — a confident wrong answer to "can this borrower's payment
 * move", with the ARM section correctly absent because the row really did say
 * fixed. No error, no log line, no empty result. That is the shape of this whole
 * class: a value map is a hand-written guess at somebody else's vocabulary, being
 * wrong about it is silent, and a sensible default turns the silence into a claim.
 *
 * SO THE CENSUS IS THE JUDGE, NOT A REVIEWER. `field-dictionary.json` records the
 * values each field was OBSERVED to hold on real loans and the values Encompass
 * DECLARES it may hold. A value the tenant has actually sent that no map
 * recognises is a build failure; a declared-but-never-seen value is reported so a
 * decision about it is deliberate rather than accidental.
 *
 * PURE. Reads the mapper's own exported declaration and the census file. No
 * database, no network.
 */

const path = require('path');
const fs = require('fs');

const mapper = require('../src/longterm/application/mapper');
const dictionary = require('../src/longterm/encompass/dictionary/field-dictionary.json');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

/** The mapper's own key form — imported, never re-implemented, or this test would
 *  be checking a normalizer the mirror does not use. */
const enumOf = mapper._internals.enumOf;
const recognises = (map, value) => enumOf(map, value) !== null;

const fields = dictionary.fields || {};
const meta = dictionary.meta || {};

// ── The census has to be real, or every check below passes by finding nothing ──
console.log('the census this is judged against');

check(Object.keys(fields).length > 3000,
  `the field dictionary carries ${Object.keys(fields).length} fields — a dictionary that failed to load would make every check below vacuous`);
check(Number(meta.loansAnalyzed) > 100,
  `…measured across ${meta.loansAnalyzed} live loans on ${meta.generated}, so "Encompass sends this" is a measurement rather than a memory`);

const maps = mapper.ENUM_MAPS;
check(maps && Object.keys(maps).length >= 3,
  `the mapper exports its value maps as ONE declaration (${Object.keys(maps || {}).join(', ')}) — a guard reading a second copy would agree with whatever it was handed`);

// ── The check that matters ────────────────────────────────────────────────────
console.log('\nevery value the tenant has actually sent is recognised');

const unmapped = [];
const checkedFields = [];
for (const [name, decl] of Object.entries(maps)) {
  const field = fields[decl.fieldId];
  if (!field) {
    failures += 1;
    console.error(`  FAIL ${name}: field ${decl.fieldId} is not in the census at all — the map is being checked against nothing`);
    continue;
  }
  const observed = field.observedValues || [];
  if (!observed.length) {
    failures += 1;
    console.error(`  FAIL ${name}: field ${decl.fieldId} records no observed values, so this map is unverifiable`);
    continue;
  }
  checkedFields.push(`${name}=${decl.fieldId}`);
  for (const o of observed) {
    if (!recognises(decl.map, o.value)) unmapped.push(`${name} (field ${decl.fieldId}): ${JSON.stringify(o.value)} on ${o.count} loan(s)`);
  }
}

check(unmapped.length === 0,
  `THE ONE THAT MATTERS: not one value the tenant has sent falls through a map into null${unmapped.length ? `:\n       ${unmapped.join('\n       ')}` : ` (${checkedFields.join(', ')})`}`);

// The bug that started this, pinned by name so it cannot come back quietly.
const amort = maps.amortizationType;
check(amort && recognises(amort.map, 'AdjustableRate'),
  "an adjustable-rate loan reads as adjustable — `AdjustableRate` is the word field 608 actually holds, and the map used to carry 'adjustable' and 'arm', neither of which the tenant has ever sent, so the one ARM in the book mirrored as FIXED off the column's own default");
check(amort && enumOf(amort.map, 'AdjustableRate') === 'adjustable',
  '…and it lands on the value the COLUMN can hold, which is the enum `(fixed, adjustable)` — recognising the word and storing something the column rejects would only move the failure');
check(amort && enumOf(amort.map, 'Fixed') === 'fixed',
  '…while a fixed loan is unmoved, which is 765 of the 766 loans that carry the field');

// ── Declared but never seen: reported, never silently accepted ───────────────
console.log('\na value Encompass allows but the tenant has never sent');

for (const [name, decl] of Object.entries(maps)) {
  const field = fields[decl.fieldId];
  if (!field) continue;
  const seen = new Set((field.observedValues || []).map((o) => String(o.value)));
  const allowed = (field.allowedValues || []).map((a) => a.value).filter((v) => !seen.has(String(v)));
  const unrecognised = allowed.filter((v) => !recognises(decl.map, v));
  if (unrecognised.length) {
    console.log(`  note ${name}: ${unrecognised.join(', ')} — allowed by Encompass, never sent on this book, and deliberately not mapped (a value nobody has seen is a guess about somebody else's vocabulary; it mirrors as null, which is honest, and this line is here so the next person chooses rather than discovers)`);
  }
}
check(true, 'every value Encompass merely ALLOWS is listed rather than assumed either way — mapping one nobody has sent is a guess, and dropping one silently is how this class starts');

// ── The mapper reads the declaration, not a private copy ────────────────────
console.log('\nthe mirror applies the maps this test checked');

const src = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/application/mapper.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

for (const name of Object.keys(maps)) {
  check(new RegExp(`enumOf\\(ENUM_MAPS\\.${name}\\.map,`).test(src),
    `${name} is applied through the exported declaration — a call site reading a bare local would let the guard pass while the mirror used a different map`);
}
check(!/enumOf\(\s*(AMORTIZATION|LOAN_PURPOSE|LIEN_POSITION)\s*,/.test(src),
  '…and no call site reaches around it to a bare map, which is exactly how one copy drifts from the other');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
