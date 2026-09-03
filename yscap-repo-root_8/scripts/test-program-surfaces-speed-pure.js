#!/usr/bin/env node
'use strict';
/**
 * THE SPEED PROGRAM ON EVERY SERVER SURFACE THE THIRD PROGRAM REACHES (owner-directed 2026-09-03;
 * docs/SPEED-PROGRAM-RESEARCH.md §3.4 / §7 — "grep -i silver and answer every hit"). The engine
 * composition itself is proven in test-speed-levers-pure.js and the pricing wrapper in
 * test-rate-build-up.js; THIS file is the surfaces with no suite of their own: the structuring
 * lever, the label maps (activity feed, e-sign package, draw report), the conditions rule-field
 * enum, the two PROGRAMS sets (now derived from program-availability.PROGRAM_KEYS), and the shape of
 * the register doors (one normalizer, no fourth ternary; the tape picker reads the derived list).
 *
 * PURE — no database, no network. Every assertion prints PASS/FAIL and the file exits non-zero on
 * any failure. Each one was shown to fail under a deliberate mutation before it was trusted (the
 * mutation is named in the build report, per the repo's build rules).
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  PASS ${m}`); } else { fail++; console.error(`  FAIL ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const { PROGRAM_KEYS } = require('../src/lib/program-availability');
const { programKey } = require('../src/lib/vesting-program-rule');

console.log('\n1. The lists that are DERIVED, not re-typed');
{
  const intake = require('../src/lib/intake-auto-register');
  eq([...intake.PROGRAMS].sort(), [...PROGRAM_KEYS].sort(), 'intake-auto-register.PROGRAMS IS program-availability.PROGRAM_KEYS');
  eq(intake.publicProgram('speed'), 'speed', 'a public form may register Speed');
  eq(intake.publicProgram('manual'), null, '…and still never Manual');
  const offer = require('../src/lib/term-sheet-offer');
  eq([...offer.PROGRAMS].sort(), [...PROGRAM_KEYS, 'manual'].sort(), 'term-sheet-offer.PROGRAMS IS PROGRAM_KEYS + manual');
  eq(offer.offerProgram('speed'), 'speed', 'an offer may carry Speed');
  eq(offer.offerProgram(' Speed '), 'speed', 'offerProgram trims + lowercases as it always did');
  eq(offer.offerProgram('speedy'), null, '…and anything that is not a key is refused');
  ok(PROGRAM_KEYS.every((k) => programKey(k) === k), 'every marketed key is a fixed point of the one normalizer');
}

console.log('\n2. The conditions rule-field enum and the dashboards filter');
{
  const reg = require('../src/lib/conditions/field-registry');
  const f = reg.FIELDS.find((x) => x.key === 'registered_program');
  const vs = f.options.map((o) => o.v);
  ok(f.options.some((o) => o.v === 'speed' && o.label === 'Speed Program'), 'registered_program enum offers { speed: "Speed Program" }');
  ok(vs.indexOf('speed') === vs.indexOf('silver') + 1 && vs.indexOf('speed') < vs.indexOf('none'), 'right after silver, before none');
  ok(PROGRAM_KEYS.every((k) => vs.includes(k)), 'every marketed program is a rule-field value');
}

console.log('\n3. The counterfactual structuring lever');
{
  const S = require('../src/lib/underwriting/structuring');
  const base = { loanAmount: 450000 };
  const toSpeed = S.LEVERS.swap_program_speed(base, 'standard');
  eq(toSpeed.swap, 'speed', 'from Standard the lever swaps to speed');
  eq(toSpeed.label, 'Switch to Speed program', '…with the Speed label');
  ok(toSpeed.inputs === base, 'the inputs are passed through untouched (program is a separate argument)');
  const fromSpeed = S.LEVERS.swap_program_speed(base, 'speed');
  eq(fromSpeed.swap, 'standard', 'from Speed the lever swaps back to standard');
  eq(fromSpeed.label, 'Switch to Standard program', '…with the Standard label');
  // Same SHAPE as the Silver lever: the two are interchangeable to the caller.
  eq(Object.keys(toSpeed).sort(), Object.keys(S.LEVERS.swap_program_silver(base, 'standard')).sort(), 'same result shape as swap_program_silver');
  // And it runs through the real wrapper: the alternative is priced on the frozen composition.
  const P = require('../src/lib/pricing');
  if (P.enginesReady()) {
    const app = { purchase_price: 400000, as_is_value: 400000, arv: 600000, rehab_budget: 100000, fico: 720, loan_type: 'Purchase',
      program: 'Standard', property_type: 'SFR', units: 1, term: '12', property_address: { state: 'NJ', city: 'Newark', oneLine: '1 Test St, Newark, NJ 07102' } };
    const inputs = P.buildInputs(app, { flips: 3, holds: 0, ground: 0 }, null);
    const baseline = P.quoteProgram('standard', inputs);
    const res = S.explore(inputs, 'standard', baseline, { levers: ['swap_program_speed'] });
    ok(res.length === 1 && res[0].key === 'swap_program_speed' && res[0].ok && res[0].program === 'speed', 'explore() prices the Speed alternative through pricing.quoteProgram');
    ok(res[0].quote && res[0].quote.noteRate >= baseline.noteRate, 'and Speed never prices below Standard (the higher of the two parents\' rates)');
  } else {
    ok(true, 'engines unavailable here — explore() not exercised');
  }
}

console.log('\n4. The label maps a registered program prints through');
{
  ok(/speed: 'Speed Program'/.test(read('src/lib/activity.js')), 'activity feed PROGRAM_NAME has speed');
  ok(/if \(pr === 'speed'\) return 'Speed Program';/.test(read('src/lib/esign/orchestrate.js')), 'e-sign package programLabel has speed');
  ok(/\/speed\/i\.test\(String\(a\.program \|\| ''\)\) \? 'Speed Program'/.test(read('src/sitewire/draw-report.js')), 'draw report program label has speed');
  ok(/speed:\s*'The Speed program'/.test(read('src/clickup/crosswalk.js')), 'ClickUp crosswalk maps speed');
  eq(require('../src/lib/pricing').PROGRAM_LABEL.speed, 'Speed Program', 'pricing.PROGRAM_LABEL.speed (file overview, emails read this table)');
}

console.log('\n5. The register doors: ONE normalizer, no fourth ternary; the tape picker reads the derived list');
{
  const staff = read('src/routes/staff.js'), borrower = read('src/routes/borrower.js'), tpo = read('src/routes/tpo.js');
  const ternary = /b\.program === 'gold' \? 'gold'/;
  ok(!ternary.test(staff) && !ternary.test(borrower) && !ternary.test(tpo), 'no door keeps its own gold/silver/standard ternary');
  ok(!/summary\.program\) === 'gold' \? 'gold'/.test(staff), 'the counter-accept door neither');
  eq((staff.match(/manualProgram\.requestedProgramKey\(/g) || []).length, 2, 'staff.js: register + counter-accept both call requestedProgramKey');
  ok(/manualProgram\.requestedProgramKey\(b\.program\)/.test(borrower), 'borrower.js register calls requestedProgramKey');
  ok(/manualProgram\.requestedProgramKey\(b\.program\)/.test(tpo), 'tpo.js register calls requestedProgramKey');
  ok(/for \(const p of require\('\.\.\/lib\/program-availability'\)\.PROGRAM_KEYS\)/.test(tpo), 'tpo.js own-stamp loop iterates PROGRAM_KEYS');
  ok(/Pick a real program \(\$\{progAvail\.PROGRAM_KEYS\.join\(', '\)\}\)/.test(staff), 'the program-exception refusal lists PROGRAM_KEYS, never a typed trio');
  ok(/tapes\.programsForProvider\(tape\.buyerKey\)/.test(staff) && /pr\.program = ANY\(\$\$\{params\.length\}::text\[\]\)/.test(staff), 'the bulk-tape loan picker gates on the derived program LIST');
  ok(!/programForProvider\(tape\.buyerKey\)/.test(staff), '…and no longer on the single 1:1 program');
  // No Speed markup / origination knob anywhere (owner decision 2026-09-03): nothing sticks a Speed markup to a file.
  ok(!/markupSpeedPct|file_markup_speed_pct|origSpeedPct/.test(staff + borrower + tpo + read('src/routes/admin-pricing.js') + read('src/routes/admin-tpo.js')), 'no Speed markup/origination knob on any route');
}

console.log(fail ? `\nFAIL ${fail} assertion(s) failed (${pass} passed)` : `\nPASS test-program-surfaces-speed-pure: ${pass} assertions`);
process.exit(fail ? 1 : 0);
