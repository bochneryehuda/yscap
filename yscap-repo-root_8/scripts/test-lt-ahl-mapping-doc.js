#!/usr/bin/env node
'use strict';
/**
 * AHL — the mapping table in the doc IS the builder's own answer (pure, offline).
 *
 * WHY THIS IS A TEST AND NOT A GENERATOR YOU REMEMBER TO RUN. The owner asked for
 * the mapping and the defaults to be written down. A hand-kept table is a second
 * copy of the mapping, and the copy that drifts is the one somebody reads BEFORE
 * changing a default — so the document would be at its most wrong exactly when it
 * mattered most. This derives the table by running the REAL builder over
 * scenarios that differ in exactly one thing and watching which fields move, then
 * asserts the document says the same. Change a default and this goes red until
 * the doc is regenerated.
 *
 * Usage:
 *   node scripts/test-lt-ahl-mapping-doc.js            # check the doc is current
 *   node scripts/test-lt-ahl-mapping-doc.js --write    # regenerate it
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const scenario = require('../src/longterm/ahl/scenario');
const registry = require('../src/longterm/ahl/field-registry');
const capturedForm = require('../src/longterm/ahl/capture/form-registry.json');

const BASE = {
  purpose: 'cashout', value: 500000, loan: 350000, fico: 760, dscr: 1.3,
  propertyType: 'Condo', units: 4, state: 'CT', zip: '06105', city: 'Hartford',
  prepayMonths: 60, occupancy: 'Investment', citizenship: 'US Citizen',
};

/** What each scenario key is called on the officer's side, and what it drives. */
const DRIVEN_BY = {
  LoanPurpose: 'purpose', RefiPurpose: 'purpose',
  FICO: 'fico', DSCR: 'dscr',
  PropertyValue: 'value / loan / ltv (the amount triangle)', LoanAmount: 'value / loan / ltv (the amount triangle)',
  PropState: 'state', PropZip: 'zip', PropCity: 'city',
  PropertyType: 'propertyType (+ units for a 2-4)', Units: 'units',
  Occupancy: 'occupancy', CitizenshipType: 'citizenship',
  PrepayPenaltyPeriod: 'prepayMonths', PrepayPenaltyType: 'prepayStructure',
  LoanTerm: 'termYears — or BOTH when unpinned (the fan-out)',
  InterestOnly: 'io — or BOTH when unpinned (the fan-out)',
  LockTerm: 'lockDays — or BOTH when unpinned (the fan-out)',
  RentIndicator: 'shortTermRental',
  WaiveEscrows: 'escrowWaive', FirstTimeInvestor: 'firstTimeInvestor', FirstTimeHomeBuyer: 'fthb',
  RuralArea: 'rural', SelfEmployed: 'selfEmployed', RentFree: 'livingRentFree',
  WarrantableCondo: 'nonWarrantable', Condotel: 'nonWarrantable',
  Channel: 'the `AHL_CHANNEL` setting — NOT the scenario',
};

const WHY_PINNED = {
  Action: 'The form\'s verb. Every other value (`Select Rate`, `Lock`) is a WRITE; the client refuses them.',
  ConsumerPurpose: 'A DSCR investment loan is business-purpose. `Personal` would put a TRID consumer loan on the board — a different product with different disclosures. AHL quotes it back in its own refusals.',
  Channel: 'A BUSINESS DECISION, NOT A MAPPING — see the channel section. It is a setting rather than a scenario field, and every board says which channel it was priced on.',
  DocType: '**THE PRODUCT WALL.** AHL\'s next option, `Investor - No Ratio`, is its Bridge / Rehab / Ground-Up shelf — the SHORT-TERM product. Pinning this is what keeps a Long-Term module out of RTL\'s product.',
};

function bodyOf(sc, opts) {
  return Object.fromEntries(scenario.build(sc, opts).legs[0].body);
}

const base = bodyOf(BASE);
// A field is SCENARIO-DRIVEN if changing one scenario key moves it.
const probes = [
  ['purpose', { purpose: 'purchase' }], ['fico', { fico: 700 }], ['dscr', { dscr: 1.0 }],
  ['value/loan', { value: 400000, loan: 300000 }], ['state', { state: 'FL' }], ['zip', { zip: '33101' }],
  ['city', { city: 'Miami' }], ['propertyType', { propertyType: 'SingleFamily', units: 1 }],
  ['occupancy', { occupancy: 'Primary' }], ['citizenship', { citizenship: 'Foreign National' }],
  ['prepayMonths', { prepayMonths: 36 }], ['prepayStructure', { prepayStructure: 'declining' }],
  ['shortTermRental', { shortTermRental: true }],
  ['escrowWaive', { escrowWaive: true }], ['firstTimeInvestor', { firstTimeInvestor: true }],
  ['fthb', { fthb: true }], ['rural', { rural: true }], ['selfEmployed', { selfEmployed: true }],
  ['livingRentFree', { livingRentFree: true }], ['nonWarrantable', { nonWarrantable: true }],
];
const moves = new Map();
for (const [name, patch] of probes) {
  let b; try { b = bodyOf({ ...BASE, ...patch }); } catch (_) { continue; }
  for (const k of new Set([...Object.keys(base), ...Object.keys(b)])) {
    if (base[k] !== b[k]) { if (!moves.has(k)) moves.set(k, []); moves.get(k).push(name); }
  }
}
// The fan-out axis moves between LEGS rather than between scenarios.
const legBodies = scenario.build(BASE).legs.map((l) => Object.fromEntries(l.body));
for (const k of Object.keys(base)) {
  if (new Set(legBodies.map((b) => b[k])).size > 1) { if (!moves.has(k)) moves.set(k, []); moves.get(k).push('the product fan-out'); }
}
// Conditional fields appear on some builds and not others.
const conditional = new Set();
for (const [, patch] of probes) {
  let b; try { b = bodyOf({ ...BASE, ...patch }); } catch (_) { continue; }
  for (const k of Object.keys(b)) if (!(k in base)) conditional.add(k);
}
for (const k of Object.keys(base)) {
  const bare = bodyOf({ purpose: 'purchase', value: 500000, loan: 350000, fico: 760, state: 'CT' });
  if (!(k in bare)) conditional.add(k);
}

const rows = [];
for (const [k, v] of Object.entries(base)) {
  const driver = moves.get(k);
  const kind = driver ? (conditional.has(k) ? 'scenario, when stated' : 'scenario') : 'PINNED';
  rows.push({ field: k, value: v, kind, driver: DRIVEN_BY[k] || (driver ? driver.join(', ') : '—'), why: WHY_PINNED[k] || '' });
}
for (const k of [...conditional].filter((k) => !(k in base)).sort()) {
  rows.push({ field: k, value: '(omitted unless stated)', kind: 'scenario, when stated', driver: DRIVEN_BY[k] || '—', why: '' });
}

const out = [];
const say = (x) => out.push(x);
say('### Fields this adapter SENDS\n');
say('| AHL field | What we send on the reference scenario | Class | Driven by |');
say('|---|---|---|---|');
for (const r of rows.sort((a, b) => (a.kind === b.kind ? a.field.localeCompare(b.field) : (a.kind === 'PINNED' ? -1 : 1))))
  say(`| \`${r.field}\` | \`${r.value}\` | ${r.kind === 'PINNED' ? '**always, pinned**' : r.kind} | ${r.driver} |`);

const sent = new Set(rows.map((r) => r.field));
const known = new Set([...Object.keys(capturedForm), ...Object.keys(registry.RADIO_GROUPS), ...Object.keys(registry.BOOLEAN_FIELDS)]);
const notSent = [...known].filter((k) => !sent.has(k)).sort();
say(`\n### Fields on AHL's form this adapter NEVER sends (${notSent.length})\n`);
say(notSent.map((k) => `\`${k}\``).join(', '));
say('\nEach is left to AHL\'s own default. They are agency, FHA/VA, compensation and');
say('fee-ledger controls: measured on the reference scenario, dropping all of them');
say('left the price ladder byte-identical.');

const pinned = rows.filter((x) => x.kind === 'PINNED');
say(`\n### The ${pinned.length} always-filled fields, and why each is not a scenario input\n`);
for (const r of pinned) say(`- **\`${r.field}\` = \`${r.value}\`** — ${r.why}`);

// ── The document must say what the builder actually does ────────────────────
const fs = require('fs');
const path = require('path');
const DOC = path.join(__dirname, '..', 'docs', 'longterm', 'AHL-PRICING-MAPPING.md');
const START = '<!-- GENERATED: node scripts/test-lt-ahl-mapping-doc.js --write -->';
const END = '<!-- END GENERATED -->';
const generated = `${START}\n\n${out.join('\n')}\n\n${END}`;
const doc = fs.readFileSync(DOC, 'utf8');
const i = doc.indexOf(START);
const j = doc.indexOf(END);

if (process.argv.includes('--write')) {
  if (i < 0 || j < 0) { console.error(`The markers are missing from ${DOC}.`); process.exit(1); }
  fs.writeFileSync(DOC, doc.slice(0, i) + generated + doc.slice(j + END.length));
  console.log('AHL mapping table regenerated in docs/longterm/AHL-PRICING-MAPPING.md');
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok   ${m}`); } else { fail += 1; console.log(`  FAIL ${m}`); } };
console.log('\nAHL — the written mapping is the builder\'s own answer\n');
ok(i >= 0 && j > i, 'DOC-1 the generated block is present in docs/longterm/AHL-PRICING-MAPPING.md');
const current = i >= 0 && j > i ? doc.slice(i, j + END.length) : '';
ok(current === generated,
  'DOC-2 the table in the document is exactly what the builder produces today — regenerate with `node scripts/test-lt-ahl-mapping-doc.js --write`');
ok(rows.filter((r) => r.kind === 'PINNED').length === 4,
  `DOC-3 there are exactly 4 always-filled fields, and the document names every one (${rows.filter((r) => r.kind === 'PINNED').map((r) => r.field).join(', ')})`);
ok(rows.some((r) => r.field === 'DocType' && r.kind === 'PINNED' && r.value === 'Investor - DSCR'),
  'DOC-4 the product wall is one of them — a mapping doc that stopped saying so would be the one somebody read before changing it');
console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
