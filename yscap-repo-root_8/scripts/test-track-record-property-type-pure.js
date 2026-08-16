#!/usr/bin/env node
'use strict';
/**
 * WHAT KIND OF BUILDING A PAST DEAL WAS — pure. No database, no network.
 *
 * The property type on a track-record line is written by a borrower in a static
 * tool, edited by staff in the React Track Record Center, stored by two server
 * doors, and read straight out of the column by `corrfirst-track-record.js` to
 * fill a NOTE BUYER'S OWN CSV. That is four surfaces and one external form, so
 * the failures worth guarding are the ones that are silent:
 *
 *   A. THE THREE COPIES OF THE VOCABULARY CANNOT DRIFT. The list lives in
 *      `src/lib/property-type.js`; the portal bundle and the standalone tool
 *      cannot require server code, so each restates it. All three are read here
 *      and compared value for value AND group for group. A picker offering a
 *      type the server spells differently is a fact that quietly changes on save.
 *   B. EVERY OFFERED TYPE STILL REACHES A REAL CORRFIRST OPTION — except the two
 *      that deliberately do not, which must stay exactly two and stay named. A
 *      value that silently stops mapping ships a blank cell to a note buyer.
 *   C. A STORED ANSWER IS NEVER SILENTLY ERASED — the retired spelling still
 *      renders, an unknown spelling is offered back to itself, and the write
 *      door still accepts a type it has not been taught.
 *   D. THE WIRING IS ACTUALLY THERE. The bug this work fixes was a field that
 *      was collected, stored, and then dropped on the way out — nothing threw,
 *      nothing logged, and the answer was overwritten on the next save. Source
 *      guards, because no behavioural test can see a missing SELECT column.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PT = require('../src/lib/property-type');
const CF = require('../src/lib/corrfirst-track-record');

let pass = 0;
const ok = (what) => { pass++; console.log('  ✓', what); };
const root = (...p) => path.join(__dirname, '..', ...p);
const read = (...p) => fs.readFileSync(root(...p), 'utf8');

/* Lift a named array/object literal out of a file that this CommonJS test cannot
   require — the portal mirror is an ES module and the tool is a browser IIFE.
   Crude on purpose: what matters is that the VALUES agree, not how they load. */
function literal(text, name, where) {
  const at = text.indexOf(name);
  assert.ok(at >= 0, `${name} is missing from ${where}`);
  const eq = text.indexOf('=', at);
  assert.ok(eq > at, `${name} is not an assignment in ${where}`);
  const oCurly = text.indexOf('{', eq); const oSquare = text.indexOf('[', eq);
  const open = (oSquare !== -1 && (oCurly === -1 || oSquare < oCurly)) ? oSquare : oCurly;
  assert.ok(open !== -1, `could not find the literal for ${name} in ${where}`);
  let depth = 0; let end = -1;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > open, `could not read ${name} out of ${where}`);
  // eslint-disable-next-line no-new-func
  return new Function(`return (${text.slice(open, end + 1)});`)();
}

const shape = (groups) => groups.map((g) => `${g.group}: ${g.types.join(' | ')}`).join('\n');

/* ─────────── A. one vocabulary, three copies, no drift ─────────── */
console.log('\nA. the portal mirror and the borrower tool cannot drift from the server');
{
  const mirrorSrc = read('app-v2', 'src', 'lib', 'trackRecordPropertyTypes.js');
  const toolSrc = read('web', 'v2', 'tools', 'track-record.js');

  const mirror = literal(mirrorSrc, 'TRACK_RECORD_PROPERTY_GROUPS', 'the portal mirror');
  const tool = literal(toolSrc, 'PROP_TYPE_GROUPS', 'the borrower tool');

  assert.strictEqual(shape(mirror), shape(PT.TRACK_RECORD_PROPERTY_GROUPS),
    'the portal mirror disagrees with the server about the property-type vocabulary');
  ok('the portal mirror is the server list, group for group and value for value');

  assert.strictEqual(shape(tool), shape(PT.TRACK_RECORD_PROPERTY_GROUPS),
    'the borrower tool disagrees with the server about the property-type vocabulary');
  ok('the borrower tool is the server list, group for group and value for value');

  const mirrorLegacy = literal(mirrorSrc, 'TRACK_RECORD_LEGACY_PROPERTY_TYPES', 'the portal mirror');
  assert.deepStrictEqual(mirrorLegacy, Array.from(PT.TRACK_RECORD_LEGACY_PROPERTY_TYPES),
    'the portal mirror disagrees about the retired spellings');
  ok('the retired spellings agree too — a legacy value renders on every surface');

  // A duplicate would make one type reachable from two groups and would make the
  // "offer a stored value back" test below pick the wrong branch.
  const seen = new Set();
  for (const t of PT.TRACK_RECORD_PROPERTY_TYPES) {
    assert.ok(!seen.has(t), `"${t}" appears twice in the vocabulary`);
    seen.add(t);
  }
  assert.ok(PT.TRACK_RECORD_PROPERTY_TYPES.length >= 16, 'the vocabulary shrank unexpectedly');
  ok(`${PT.TRACK_RECORD_PROPERTY_TYPES.length} distinct types, no duplicates`);

  // The tool's original six spellings must survive verbatim — re-spelling one
  // strands every row already carrying it.
  for (const original of ['Single-family', '2-4 unit residential', '5+ unit multifamily',
    'Mixed-use', 'Commercial', 'Land / lot']) {
    assert.ok(PT.TRACK_RECORD_PROPERTY_TYPES.includes(original),
      `the tool's original spelling "${original}" was renamed — every stored row carrying it is now unlabelled`);
  }
  ok('every spelling the tool has stored since it shipped is still an option');
}

/* ─────────── B. the cross-system contract with CorrFirst ─────────── */
console.log('\nB. every type we offer still reaches a value CorrFirst’s own form has');
{
  // Their form has no generic "commercial" and no land at all. These two are the
  // WHOLE reason the commercial sub-types were added: an office building used to
  // go out as "Commercial" and therefore blank; it now goes out as "Office".
  const EXPECTED_BLANKS = ['Commercial', 'Land / lot'];

  const blanks = [];
  const judged = [];
  for (const label of PT.TRACK_RECORD_PROPERTY_TYPES) {
    const got = CF.corrfirstPropertyType({ property_type: label });
    if (!got.value) { blanks.push(label); continue; }
    assert.ok(CF.CORRFIRST_PROPERTY_TYPE_OPTIONS.includes(got.value),
      `"${label}" reaches "${got.value}", which is NOT a value CorrFirst's form offers`);
    if (!got.exact) judged.push(label);
  }

  assert.deepStrictEqual(blanks.sort(), EXPECTED_BLANKS.slice().sort(),
    'the set of types that ship a BLANK property-type cell to CorrFirst changed.\n'
    + 'Adding one means a real property type silently stopped mapping; removing one\n'
    + 'means CorrFirst gained an option and this list should say so.');
  ok(`exactly two types ship blank, and they are the documented pair (${EXPECTED_BLANKS.join(', ')})`);

  assert.deepStrictEqual(judged, ['Townhouse'],
    'the set of JUDGEMENT calls changed — every other type must land on CorrFirst’s own word for it');
  ok('Townhouse is the only judgement call (their form has no townhouse; SFR-Attached is the closest)');

  // The values that were ADDED for this exact reason must be exact, not judged.
  for (const [label, theirs] of [['Office', 'Office'], ['Retail', 'Retail'],
    ['Industrial', 'Industrial'], ['Warehouse', 'Warehouse'], ['Self storage', 'Self Storage'],
    ['Manufactured', 'Manufactured'], ['Modular', 'Modular'], ['Condo', 'Condo'],
    ['PUD', 'PUD'], ['Mixed-use', 'Mixed-Use']]) {
    const got = CF.corrfirstPropertyType({ property_type: label });
    assert.strictEqual(got.value, theirs, `"${label}" should reach CorrFirst's "${theirs}"`);
    assert.strictEqual(got.exact, true, `"${label}" should be exact, not a judgement call`);
  }
  ok('the commercial sub-types pass straight through in CorrFirst’s own spelling');

  // The retired spelling was the reason for the split: /condo/ is tested before
  // /town/, so every townhouse stored under it was read as a condominium.
  assert.strictEqual(CF.corrfirstPropertyType({ property_type: 'Condo / townhome' }).value, 'Condo');
  assert.strictEqual(CF.corrfirstPropertyType({ property_type: 'Townhouse' }).value, 'SFR-Attached');
  ok('splitting "Condo / townhome" is what lets a townhouse reach SFR-Attached instead of Condo');
}

/* ─────────── C. a stored answer is never silently erased ─────────── */
console.log('\nC. nothing a borrower already answered can go missing');
{
  assert.strictEqual(PT.trackRecordPropertyTypeLabel(''), null);
  assert.strictEqual(PT.trackRecordPropertyTypeLabel(null), null);
  assert.strictEqual(PT.trackRecordPropertyTypeLabel('   '), null);
  ok('blank is null — a picker shows "Not stated", never an empty-looking option');

  for (const spelling of ['single-family', 'SINGLE-FAMILY', ' Single Family ', 'singlefamily']) {
    assert.strictEqual(PT.trackRecordPropertyTypeLabel(spelling), 'Single-family',
      `"${spelling}" should render as the vocabulary's own spelling`);
  }
  assert.strictEqual(PT.trackRecordPropertyTypeLabel('self storage'), 'Self storage');
  assert.strictEqual(PT.trackRecordPropertyTypeLabel('pud'), 'PUD');
  ok('a stored spelling is canonicalised — casing and spacing are one thing on every screen');

  assert.strictEqual(PT.trackRecordPropertyTypeLabel('Condo / townhome'), 'Condo / townhome');
  ok('the retired spelling still renders — it is somebody’s answer, not a blank');

  // An unknown type is somebody's answer too. Rewriting it would invent a fact.
  assert.strictEqual(PT.trackRecordPropertyTypeLabel('Marina berth'), 'Marina berth');
  ok('an unrecognised type is shown exactly as it was stored, never rewritten');

  // THE PICKER. A <select> whose value is not among its options renders EMPTY,
  // which is how a form silently offers to erase an answer.
  const plain = PT.trackRecordPropertyTypeOptions('Office');
  assert.strictEqual(plain.length, PT.TRACK_RECORD_PROPERTY_GROUPS.length,
    'an on-list value must not add a group');
  ok('an on-list value adds no extra group');

  for (const off of ['Condo / townhome', 'Marina berth', 'marina berth']) {
    const groups = PT.trackRecordPropertyTypeOptions(off);
    assert.strictEqual(groups.length, PT.TRACK_RECORD_PROPERTY_GROUPS.length + 1,
      `"${off}" should be offered back in its own group`);
    const extra = groups[groups.length - 1];
    assert.strictEqual(extra.group, 'On this deal');
    assert.deepStrictEqual(extra.types, [PT.trackRecordPropertyTypeLabel(off)]);
  }
  ok('an off-list stored value is offered back to itself — it can never render as an empty box');

  assert.strictEqual(PT.trackRecordPropertyTypeOptions('').length, PT.TRACK_RECORD_PROPERTY_GROUPS.length);
  ok('no stored value adds no extra group');
}

/* ─────────── D. the write door ─────────── */
console.log('\nD. what the save door accepts and what it refuses');
{
  assert.strictEqual(PT.sanitizeTrackRecordPropertyType(''), null);
  assert.strictEqual(PT.sanitizeTrackRecordPropertyType(null), null);
  assert.strictEqual(PT.sanitizeTrackRecordPropertyType('  '), null);
  ok('blank clears the field');

  // The db/322 class: an appraisal FORM number is not a property type, and
  // track-record-from-file.js copies applications.property_type verbatim.
  for (const code of ['FNM1025', 'FNM 1025', 'fnma-1004', 'Form 1073', '1025', 'URAR']) {
    assert.strictEqual(PT.sanitizeTrackRecordPropertyType(code), null,
      `"${code}" is an appraisal form number and must never be stored as a property type`);
  }
  ok('an appraisal form code is refused — the same refusal the application doors run');

  assert.strictEqual(PT.sanitizeTrackRecordPropertyType(' single family '), 'Single-family');
  assert.strictEqual(PT.sanitizeTrackRecordPropertyType('OFFICE'), 'Office');
  ok('a recognised spelling is stored canonically, so every reader agrees');

  // The importer, ClickUp and Encompass all feed this column. A door that only
  // accepted this list would drop a real property type rather than store it.
  assert.strictEqual(PT.sanitizeTrackRecordPropertyType('Marina berth'), 'Marina berth');
  ok('an unrecognised type is still ACCEPTED — imports are not silently dropped');

  const long = 'x'.repeat(200);
  assert.strictEqual(PT.sanitizeTrackRecordPropertyType(long).length, 60,
    'the value must fit its 60-character column');
  ok('the value is capped to the column, so a paste can never 500 the save');
}

/* ─────────── E. the wiring is actually there ─────────── */
console.log('\nE. the field survives the round trip on every side');
{
  // THE ORIGINAL BUG: the borrower's list endpoint stored the answer and then
  // never sent it back, so the tool reloaded empty and overwrote it on the next
  // save. No behavioural test can see a missing SELECT column.
  const borrower = read('src', 'routes', 'borrower.js');
  const listAt = borrower.indexOf('SELECT t.id, t.borrower_id, t.llc_id, t.property_address, t.deal_type,');
  assert.ok(listAt > 0, 'could not find the borrower track-record list query');
  const listEnd = borrower.indexOf('ORDER BY t.sale_date', listAt);
  assert.ok(listEnd > listAt, 'could not find the end of the borrower track-record list query');
  const listSql = borrower.slice(listAt, listEnd);
  assert.ok(/\bt\.property_type\b/.test(listSql),
    'the borrower track-record list no longer selects t.property_type — the tool will reload '
    + 'with an empty picker and blank the stored answer on the next save');
  ok('the borrower list endpoint sends the property type back');

  const workspace = read('src', 'lib', 'track-record', 'workspace.js');
  assert.ok(/propertyType:\s*require\('\.\.\/property-type'\)\.trackRecordPropertyTypeLabel\(t\.property_type\)/
    .test(workspace),
    'workspace.loadLine no longer passes the property type on — the Track Record Center goes blank again');
  ok('the line loader passes the property type to the Track Record Center');

  // BOTH React surfaces must read the SHARED module, never a re-typed list.
  for (const f of ['RecordLedger.jsx', 'LineDetail.jsx']) {
    const src = read('app-v2', 'src', 'components', 'track-record', f);
    assert.ok(/from '\.\.\/\.\.\/lib\/trackRecordPropertyTypes\.js'/.test(src),
      `${f} does not read the shared property-type vocabulary`);
  }
  ok('both React surfaces read the one shared vocabulary');

  const detail = read('app-v2', 'src', 'components', 'track-record', 'LineDetail.jsx');
  assert.ok(/propertyType:\s*e\.propertyType/.test(detail),
    'the inline edit no longer SENDS the property type — the picker would be decorative');
  assert.ok(/<select className="input"/.test(detail),
    'the property-type picker must carry className="input" — styles.css dresses the CLASS, '
    + 'not the select TAG, so a bare control renders unstyled');
  ok('the inline edit sends the property type, and its control is actually dressed');

  // The save door must run the governed sanitizer, not a bare slice.
  assert.ok(/sanitizeTrackRecordPropertyType\(b\.propertyType\)/.test(borrower),
    'the track-record save door no longer runs the property-type sanitizer');
  ok('the save door runs the governed sanitizer');

  // The tool is cached hard — an edit that does not bump the query string ships
  // the OLD file to every borrower who has already opened the page.
  const html = read('web', 'v2', 'tools', 'track-record.html');
  const bust = /track-record\.js\?v=([^"']+)/.exec(html);
  assert.ok(bust, 'the tool page no longer cache-busts track-record.js');
  assert.notStrictEqual(bust[1], 'pilot8-ground',
    'track-record.js changed but its ?v= cache-buster was not bumped — borrowers keep the old file');
  ok(`the tool's cache-buster was bumped (?v=${bust[1]})`);
}

console.log(`\n${pass} checks passed — the property type is one vocabulary on every side.\n`);
