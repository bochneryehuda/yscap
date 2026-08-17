#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the DSCR field manifest's per-field metadata is DERIVED, and stays honest.
 *
 * The manifest published `core` and `advanced` as bare key strings, so the scenario-entry screen drew
 * 61 fields under their raw technical key with no label, no input type and NO UNIT — including `ltv`
 * and `dscr`, which the engine reads in THOUSANDTHS. A user typing `80` into a field the engine reads
 * as 0.08% is a silent mispricing, not an error, so the unit is the single most dangerous thing to
 * leave unsaid.
 *
 * WHAT THIS SUITE REALLY GUARDS is that the metadata is GENERATED, never hand-maintained: every type
 * and enum must come from the validator's OWN definitions, so a validator that gains a value gains it
 * in the manifest too. The failure mode it exists to prevent is a label/enum table that quietly goes
 * stale and then lies about a field that decides a price.
 *
 * PURE: no network, no DB.
 */
const meta = require('../src/longterm/ppe/field-manifest-meta');
const { _internals: route } = require('../src/longterm/routes/dscr-pricer');
const model = require('../src/longterm/lenderprice/search-model')._internals;
const registry = require('../src/longterm/lenderprice/field-registry');

let pass = 0; const fails = [];
function ok(cond, label) { if (cond) { pass += 1; console.log(`  ok   ${label}`); } else { fails.push(label); console.log(` FAIL  ${label}`); } }
const byKey = (list, k) => list.find((f) => f.key === k);

// ---- 1. the milli units — the mispricing this exists to prevent ------------------------------
for (const [key, unit] of [['ltv', 'milli_percent'], ['dscr', 'milli']]) {
  const d = meta.describeField(key);
  ok(d.unit === unit, `${key} publishes its unit (${d.unit})`);
  ok(typeof d.unitNote === 'string' && /thousandth/i.test(d.unitNote), `${key} explains the unit in words`);
}
ok(!meta.describeField('fico').unit, 'a field with no real unit publishes NO unit (fico) — silence, not a guess');

// ---- 2. types + enums come from the VALIDATORS, not a private copy ----------------------------
const booleans = model.BOOLEAN_FIELDS;
for (const b of booleans.slice(0, 6)) ok(meta.describeField(b).type === 'boolean', `${b} is typed boolean from BOOLEAN_FIELDS`);

const pt = meta.describeField('propertyType');
ok(pt.type === 'enum', 'propertyType is an enum');
const realPropertyTypes = Array.isArray(registry.PROPERTY_TYPES) ? registry.PROPERTY_TYPES
  : (registry.PROPERTY_TYPES instanceof Map ? [...registry.PROPERTY_TYPES.keys()] : Object.keys(registry.PROPERTY_TYPES));
ok(pt.enumValues.length === realPropertyTypes.length,
  `propertyType's enum is the registry's OWN list, value for value (${pt.enumValues.length})`);
ok(realPropertyTypes.every((v) => pt.enumValues.includes(v)), 'every registry property type is published');

const occ = meta.describeField('occupancy');
// OCCUPANCY_STATES is an OBJECT map, not an array — reading `.length` off it yields undefined, which
// is what an earlier cut of this assertion did (it failed against perfectly correct output). Compare
// against its KEYS, the same normalization the describer applies.
const occStates = Object.keys(model.OCCUPANCY_STATES);
ok(occ.type === 'enum' && occ.enumValues.length === occStates.length,
  `occupancy takes its enum from the validator (${occ.enumValues.join('/')})`);
ok(occStates.every((v) => occ.enumValues.includes(v)), 'every published occupancy state is carried');

const lock = meta.describeField('lockDays');
ok(lock.type === 'enum' && lock.enumValues.length > 0, `lockDays publishes the LIVE lock list (${lock.enumValues.length})`);

// ---- 3. labels are COMPUTED, and say so -------------------------------------------------------
ok(meta.labelFor('selfEmployed') === 'Self employed', 'camelCase becomes a readable label');
ok(meta.labelFor('ltv') === 'LTV' && meta.labelFor('dscr') === 'DSCR', 'a known initialism stays upper-case');
ok(meta.labelFor('noMortgageHistory') === 'No mortgage history', 'a three-word key reads as a sentence');
ok(meta.describeField('monthlyIncome').labelDerived === true,
  'every label is STAMPED derived — no reader can mistake it for a vendor-authored name');

// ---- 4. what is NOT known stays absent --------------------------------------------------------
const mi = meta.describeField('monthlyIncome');
ok(!mi.type && !mi.enumValues && !mi.unit, 'an undescribed field publishes NO invented type/enum/unit');
const bk = meta.describeField('bankruptcy');
ok(bk.type === 'object' && /not published/i.test(bk.unitNote || ''),
  'a nested-object field says it is an object and that its shape is not published — never a fake scalar type');

// ---- 5. the manifest carries it WITHOUT breaking any existing reader --------------------------
const m = route.buildFieldManifest();
ok(Array.isArray(m.core) && typeof m.core[0] === 'string', 'core is STILL a bare key array (existing readers untouched)');
ok(Array.isArray(m.advanced) && typeof m.advanced[0] === 'string', 'advanced is STILL a bare key array');
ok(Array.isArray(m.coreMeta) && m.coreMeta.length === m.core.length, 'coreMeta describes every core field, one for one');
ok(Array.isArray(m.advancedMeta) && m.advancedMeta.length === m.advanced.length, 'advancedMeta describes every advanced field');
ok(m.coreMeta.every((f) => m.core.includes(f.key)), 'coreMeta introduces no field the manifest does not accept');
ok(byKey(m.coreMeta, 'ltv').unit === 'milli_percent', 'the manifest itself carries the ltv unit');
ok(m.coreMeta.every((f) => typeof f.label === 'string' && f.label.length > 0), 'every core field now has a label');

// ---- 6. the derivation must FOLLOW the validator, not shadow it -------------------------------
// The strongest guarantee: describeField reads the live lists, so a value added to a validator shows
// up with no edit here. Proven by mutating the live list in memory and re-asking.
const before = meta.describeField('attachment').enumValues.length;
model.ATTACHMENT_TYPES.push('__probe__');
const after = meta.describeField('attachment').enumValues.length;
model.ATTACHMENT_TYPES.pop();
ok(after === before + 1, 'a value added to the validator appears in the manifest with NO edit here (generated, not copied)');
ok(meta.describeField('attachment').enumValues.length === before, 'and the probe was cleanly removed');

console.log(`\n${fails.length ? `FAILURES: ${fails.length}` : 'OFFLINE: all passed'} (${pass} passed, ${fails.length} failed)`);
process.exit(fails.length ? 1 : 0);
