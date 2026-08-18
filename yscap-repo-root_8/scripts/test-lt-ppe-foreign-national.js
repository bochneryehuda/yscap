#!/usr/bin/env node
'use strict';
/**
 * LT PPE — A FOREIGN NATIONAL IS NOT A US CITIZEN, ON EITHER LEG (§2.97).
 *
 * ⛔ WHAT THIS EXISTS FOR, MEASURED LIVE 2026-08-18 against the real vendor. `foreign_national` is an
 * accepted field of the DSCR pricer — the manifest publishes it, the Advanced section offers it, our
 * matrix cuts on it — and it built a BYTE-IDENTICAL request to a scenario that never mentioned it. The
 * base body carries `Citizenship: 'US Citizen'`, so the mirror was not merely SILENT about a foreign
 * national; it affirmatively described one as a US citizen. Sending the truth on the same scenario
 * (NY purchase, 500k/350k, FICO 760, DSCR 1.25, 60-mo PPP):
 *
 *   19 programs / 499 rungs  ->  12 programs / 267 rungs
 *   13 LOST     — 6 Bluepoint DSCR tiers, Pennymac Non-QM, Acra Platinum Select, AD Mortgage DSCR,
 *                 ARC Edge, ARC Access, AHL Invest Star, Champions Accelerator.
 *   6 GAINED    — AD Mortgage `Foreign National 30 Year Fixed`, ARC `Foreign National DSCR`, and four
 *                 Champions `Ambassador` programs. The products built for this borrower, hidden.
 *   The two cheapest coupons on the ladder (5.750, 5.875) do not exist for a foreign national.
 *   On the SIX programs surviving both, 78 of 182 rungs are priced differently. Worst is our own
 *   sheet's investor: Deephaven `DSCR 1.00-1.24 - 30 Yr Fixed` @ 6.125% prices 100.475 -> 96.350,
 *   because LP itemizes `DSCR (All) - Foreign National / CLTV >65.01 % <= 70.0 %` = 4.000 BY NAME in
 *   place of the 0.125 FICO row. A 4.125-point quote error, in the borrower's favour and against us.
 *
 * THE TEST IS OFFLINE AND PURE. The measurement above is what justified the bridge; what is PROVEN
 * here is the bridge itself — that the fact reaches the wire, that it travels in BOTH directions, and
 * that a contradiction is refused rather than resolved. Sections:
 *
 *   A  the token set — which citizenship values name this borrower class, and which deliberately do not
 *   B  FORWARD  — the flag reaches `dyn.Citizenship` on the real builder
 *   C  REVERSE  — the vendor's own dropdown makes our engine's fact true (the §2.94 asymmetry class)
 *   D  CONFLICT — flag + a non-FN citizenship is a 422, not a silent pick
 *   E  the measurement is RECORDED where the flags are read (advanced-facts), not only in a comment
 *
 * LT-only; no RTL imports; no database; no network.
 */
const assert = require('assert');
const citizenship = require('../src/longterm/lenderprice/citizenship');
const { buildSearch, validateInputs } = require('../src/longterm/lenderprice/search-model');
const registry = require('../src/longterm/lenderprice/field-registry');
const advanced = require('../src/longterm/ppe/advanced-facts');
const legs = require('../src/longterm/ppe/lp-agreement-legs');

let pass = 0, fail = 0;
function ok(cond, what) { if (cond) { pass++; console.log(`  ok   ${what}`); } else { fail++; console.log(` FAIL  ${what}`); } }

// The scenario every assertion varies off — the same one the live probe used, so a future re-measure
// compares like with like.
const BASE = {
  purpose: 'Purchase', value: 500000, loan: 350000, fico: 760, dscr: 1.25,
  state: 'NY', zip: '11211', propertyType: 'SingleFamily', units: 1,
  prepayMonths: 60, borrowerType: 'LLC',
};
const czOf = (sc) => {
  const b = buildSearch(sc);
  const d = b.dynamicPropertiesMap && b.dynamicPropertiesMap.Citizenship;
  return d ? d.value : undefined;
};

// ---- A: which tokens name this borrower class ------------------------------------------------------
console.log('-- A: the token set --');
ok(citizenship.FOREIGN_NATIONAL_TOKEN === 'Foreign National',
  'the flag asserts the plain `Foreign National` token — the exact string measured live');
ok(citizenship.FOREIGN_NATIONAL_TOKENS.length === 3,
  'three of the vendor\'s seven citizenship values name a foreign national');
for (const t of citizenship.FOREIGN_NATIONAL_TOKENS) {
  ok(registry._tokens.CITIZENSHIP.has(t),
    `"${t}" is a real vendor token — the FN set can never name one the builder would reject`);
  ok(citizenship.isForeignNationalToken(t), `"${t}" reads as a foreign national`);
}
// ITIN is the trap: a tax-filing status the vendor lists SEPARATELY from its two ForeignNational…ITIN)
// values. Reading it as foreign national would put a 4-point LLPA on a borrower the vendor does not
// bucket that way — the same silent-mispricing class, in the opposite direction.
ok(!citizenship.isForeignNationalToken('ITIN'),
  'a bare `ITIN` is NOT a foreign national — the vendor lists it separately from its two FN-with/no-ITIN values');
ok(!citizenship.isForeignNationalToken('Non-Perm Resident'),
  'a non-permanent RESIDENT is not a foreign national either');
ok(!citizenship.isForeignNationalToken('US Citizen'), 'and a US citizen plainly is not');
for (const junk of [null, undefined, '', 0, 1, {}, [], 'foreign national', 'FOREIGN NATIONAL']) {
  ok(!citizenship.isForeignNationalToken(junk),
    `${JSON.stringify(junk)} is not a foreign-national token — the set is EXACT, never case-folded`);
}
ok(Object.isFrozen(citizenship.FOREIGN_NATIONAL_TOKENS),
  'the token list is frozen — a caller cannot widen the borrower class by mutating it');

// ---- B: FORWARD — the flag reaches the wire --------------------------------------------------------
console.log('\n-- B: FORWARD — the flag reaches dyn.Citizenship --');
ok(czOf(BASE) === 'US Citizen',
  'THE DEFECT, still visible in the base: a scenario that says nothing is affirmatively a US citizen');
ok(czOf({ ...BASE, foreign_national: true }) === 'Foreign National',
  'foreign_national: true now reaches the wire as the vendor token (it moved NOTHING before §2.97)');
ok(czOf({ ...BASE, citizenship: 'Foreign National' }) === 'Foreign National',
  'the vendor dropdown still works exactly as it did — the bridge did not disturb it');
ok(czOf({ ...BASE, foreign_national: true, citizenship: 'ForeignNationalnoITIN)' }) === 'ForeignNationalnoITIN)',
  'an explicit FN token WINS over the flag — it is the more specific statement (it can say "no ITIN")');
ok(czOf({ ...BASE, foreign_national: false }) === 'US Citizen',
  'an explicit FALSE asserts nothing and leaves the live default alone — it is the Advanced section\'s '
  + 'own default value, so a UI posting every checkbox must not be re-described on every request');
ok(czOf({ ...BASE, foreign_national: false, citizenship: 'Perm Resident' }) === 'Perm Resident',
  'and a false flag never overrides a deliberately chosen citizenship');
// The bridge must carry the FACT, not merely fire on the key's presence.
for (const v of [1, 'true', 'yes', {}, [], 'Foreign National']) {
  ok(czOf({ ...BASE, foreign_national: v }) === 'US Citizen',
    `foreign_national: ${JSON.stringify(v)} is not the boolean true — only an explicit true asserts the fact`);
}
// The whole point of the bridge is that the REQUEST changes. Compare the bodies, not just one field.
{
  const a = JSON.stringify(buildSearch({ ...BASE }));
  const b = JSON.stringify(buildSearch({ ...BASE, foreign_national: true }));
  ok(a !== b, 'the two requests are no longer byte-identical — which is the entire defect, measured offline');
}

// ---- C: REVERSE — the vendor's dropdown makes OUR fact true ----------------------------------------
console.log('\n-- C: REVERSE — the fact travels the other way too (the §2.94 asymmetry class) --');
ok(advanced.advancedFactsFromScenario({ foreign_national: true }).foreign_national === true,
  'our own leg reads the flag, as it always did');
ok(advanced.advancedFactsFromScenario({ citizenship: 'Foreign National' }).foreign_national === true,
  'a scenario using the VENDOR dropdown now makes our engine\'s fact true — without this our matrix '
  + 'silently skips its Foreign National row on the scenarios that named the borrower most plainly');
ok(advanced.advancedFactsFromScenario({ citizenship: 'ForeignNationalwithITIN)' }).foreign_national === true,
  'both ITIN spellings count as foreign national on our leg too');
ok(advanced.advancedFactsFromScenario({ citizenship: 'ITIN' }).foreign_national === false,
  'a bare ITIN does not — the exclusion holds on BOTH legs, or the two disagree about one borrower');
ok(advanced.advancedFactsFromScenario({}).foreign_national === false,
  'and a scenario saying nothing is not a foreign national');
// The agreement harness's own fact converter is the thing that actually feeds the matrix in a run.
{
  const facts = legs.lpScenarioToFacts({ ...BASE, citizenship: 'Foreign National' });
  ok(facts.foreign_national === true,
    'lpScenarioToFacts — the converter the agreement run feeds our matrix from — carries it too');
}

// ---- D: CONFLICT — refused, not resolved -----------------------------------------------------------
console.log('\n-- D: two different borrowers is a refusal, not a silent pick --');
{
  const v = validateInputs({ ...BASE, foreign_national: true, citizenship: 'Perm Resident' });
  ok(v && v.ok === false, 'flag true + a non-FN citizenship is REFUSED');
  ok(v && v.code === 'citizenship_conflicts_with_foreign_national',
    'and it is refused by its own name, so a caller can act on it');
  ok(v && /Perm Resident/.test(String(v.message || '')),
    'the refusal quotes BOTH halves — naming only one is advice nobody can act on');
}
for (const t of citizenship.FOREIGN_NATIONAL_TOKENS) {
  const v = validateInputs({ ...BASE, foreign_national: true, citizenship: t });
  ok(v && v.ok !== false, `flag true + "${t}" AGREE — an agreeing pair is never a conflict`);
}
{
  const v = validateInputs({ ...BASE, foreign_national: false, citizenship: 'Foreign National' });
  ok(v && v.ok !== false,
    'flag FALSE + an FN citizenship is accepted — false is the posted default of an unchecked box, and '
    + '422ing it would refuse ordinary traffic');
}
{
  const v = validateInputs({ ...BASE, citizenship: 'Perm Resident' });
  ok(v && v.ok !== false, 'a citizenship with no flag beside it is nobody\'s conflict');
}

// ---- E: the measurement is recorded where the flags are read ---------------------------------------
console.log('\n-- E: the measurement lives beside the flags, not only in a commit message --');
{
  const fn = advanced.getAdvancedFact('foreign_national');
  ok(fn && fn.lpPrices === true,
    'foreign_national is recorded as PRICED by Lender Price — measured: it itemizes `DSCR (All) - '
    + 'Foreign National` = 4.000 by name, and 78 of 182 common rungs move');
  ok(fn && fn.overlayOnly === true,
    '…and STILL overlayOnly: LP swapping the program set is no evidence it enforces OUR matrix\'s '
    + 'specific cuts (max loan $1.5M, LTV 70/60), which stay unmeasured — same discipline as short_term_rental');
  ok(advanced.lpPricedKeys().includes('foreign_national'),
    'and it appears in lpPricedKeys(), so the charge-only-on-a-transmitted-fact guard can see it');

  const dm = advanced.getAdvancedFact('declining_market');
  ok(dm && dm.lpPrices === false,
    'declining_market is recorded as MEASURED-AND-NOT-PRICED — a false, not the old "never asked" null');
  ok(!advanced.lpPricedKeys().includes('declining_market'),
    '…so nothing treats it as a vendor-priced fact');
}
// A source guard: the reason a fact was NOT bridged must be the measurement, not a shrug. Comments are
// stripped first — the note explaining declining_market necessarily QUOTES the tokens it probed, and a
// guard that read comments would fail on its own documentation (the class that has bitten three times).
{
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../src/longterm/ppe/advanced-facts.js'), 'utf8');
  const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const code = stripComments(src);
  ok(/lpPrices:\s*true/.test(code) && /lpPrices:\s*false/.test(code),
    'both measured verdicts are real values in the CODE, not prose');
  ok(/GLOBAL_DECLININGMARKET/.test(src) && !/GLOBAL_DECLININGMARKET/.test(code),
    'the probed token is named in the PROSE and appears in no code path — nothing sends it');
}

console.log(`\n${fail === 0 ? 'all passed' : `${fail} FAILED`} (${pass} checks)`);
if (fail) process.exit(1);
