#!/usr/bin/env node
'use strict';
/**
 * WHAT KIND OF COMPANY THIS IS — pure. No database, no network.
 *
 * The three things worth guarding here are the three that would be expensive on a
 * recorded document:
 *
 *   A. THE MIRROR CANNOT DRIFT. `app-v2/src/lib/entityType.js` is the browser copy
 *      of `src/lib/entity-type.js` (the portal cannot require server code), so it
 *      is read here and compared key for key. A screen offering a title the server
 *      then refuses is a dead end a user cannot get out of.
 *   B. A TITLE IS FROM A LIST, and the list is per type. This value prints under a
 *      signature line and DocLab merges it verbatim.
 *   C. THE TYPE DECIDES SIX DOCLAB VARIABLES, and the payload never guesses one.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ET = require('../src/lib/entity-type');
const payload = require('../src/doclab/payload');

let pass = 0;
function ok(what) { pass++; console.log('  ✓', what); }

/* ─────────── A. the browser mirror is the same rules ─────────── */
console.log('\nA. the portal mirror cannot drift from the server');
{
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'app-v2', 'src', 'lib', 'entityType.js'), 'utf8');

  // The mirror is an ES module and this test is CommonJS, so it is read as text
  // and its two tables are lifted out. Crude on purpose: a real import would need
  // a build step, and what matters is that the VALUES agree, not how they load.
  const grab = (name) => {
    const at = src.indexOf(`export const ${name} =`);
    assert.ok(at >= 0, `${name} missing from the portal mirror`);
    const open = src.indexOf(name === 'ENTITY_TITLES' ? '{' : '[', at + name.length + 10);
    let depth = 0, end = -1;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert.ok(end > open, `could not read ${name} out of the portal mirror`);
    // The mirror names its catch-all title through a const, so the const is
    // declared for the evaluation. It is asserted against the server's own value
    // below, so this cannot paper over a drift in that one string.
    const consts = `const AUTHORIZED_SIGNATORY = ${JSON.stringify(mirrorSignatory(src))};`;
    // eslint-disable-next-line no-new-func
    return new Function(`${consts} return (${src.slice(open, end + 1)});`)();
  };
  const mirrorSignatory = (text) => {
    const m = /const AUTHORIZED_SIGNATORY = '([^']*)'/.exec(text);
    assert.ok(m, 'the portal mirror no longer declares AUTHORIZED_SIGNATORY');
    return m[1];
  };
  assert.strictEqual(mirrorSignatory(src), ET.AUTHORIZED_SIGNATORY,
    'the catch-all title differs between the server and the portal');

  const mirrorTypes = grab('ENTITY_TYPES');
  assert.deepStrictEqual(mirrorTypes.map((t) => t.key), ET.KEYS,
    'the portal offers a different set of entity types than the server accepts');
  ok('the four types, in the same order, on both sides');

  for (const t of ET.TYPES) {
    const m = mirrorTypes.find((x) => x.key === t.key);
    assert.strictEqual(m.label, t.label, `${t.key}: label differs`);
    assert.strictEqual(m.longLabel, t.longLabel, `${t.key}: longLabel differs`);
    assert.strictEqual(m.governingDocWord, t.governingDocWord, `${t.key}: governing document differs`);
    assert.strictEqual(m.ownerNoun, t.ownerNoun, `${t.key}: owner noun differs`);
    assert.strictEqual(!!m.usesShares, !!t.usesShares, `${t.key}: usesShares differs`);
  }
  ok('every label, governing document and owner noun matches');

  const mirrorTitles = grab('ENTITY_TITLES');
  for (const k of ET.KEYS) {
    assert.deepStrictEqual(mirrorTitles[k], Array.from(ET.TITLES[k]),
      `${k}: the portal offers different titles than the server accepts`);
  }
  ok('every title list matches — the picker can never offer one the server refuses');
}

/* ─────────── B. reading a type, and refusing a guess ─────────── */
console.log('\nB. reading what a door was told');
{
  assert.strictEqual(ET.normalizeKey('Corporation (Inc / S-Corp)'), 'corporation');
  assert.strictEqual(ET.normalizeKey('LLC'), 'llc');
  assert.strictEqual(ET.normalizeKey('l.l.c.'), 'llc');
  assert.strictEqual(ET.normalizeKey('Limited Partnership'), 'partnership');
  assert.strictEqual(ET.normalizeKey('  TRUST '), 'trust');
  ok('the spellings our own forms use all read correctly');

  // Blank means "not answered" and falls back; junk means "we did not understand"
  // and must NOT read as an answer — that is the difference `isRecognized` exists
  // to state, and the create doors depend on it to keep a typo out of the column.
  assert.strictEqual(ET.normalizeKey(''), ET.DEFAULT_TYPE);
  assert.strictEqual(ET.isRecognized(''), false);
  assert.strictEqual(ET.normalizeKey('sole proprietorship'), '');
  assert.strictEqual(ET.isRecognized('sole proprietorship'), false);
  assert.strictEqual(ET.isRecognized(null), false);
  assert.strictEqual(ET.isRecognized('corporation'), true);
  ok('blank and junk both read as NOT stated, so neither is filed as a choice');

  assert.strictEqual(ET.typeOf('nonsense').key, 'llc');
  ok('an unreadable value still behaves as an LLC everywhere, as the back book does');
}

/* ─────────── C. the titles ─────────── */
console.log('\nC. a title is from a list, per type');
{
  assert.ok(ET.titlesFor('corporation').includes('President'));
  assert.ok(!ET.titlesFor('corporation').includes('Managing Member'),
    'a corporation must not be offered an LLC title');
  assert.ok(ET.titlesFor('llc').includes('Managing Member'));
  assert.ok(ET.titlesFor('trust').includes('Trustee'));
  ok('each type offers its own titles');

  for (const k of ET.KEYS) {
    assert.ok(ET.titlesFor(k).includes(ET.AUTHORIZED_SIGNATORY),
      `${k} must always offer the catch-all, or the list becomes a dead end`);
  }
  ok('every list carries Authorized Signatory, so the picker is never a dead end');

  // A title that is on NO list is what must never reach a signature block.
  assert.ok(ET.titleProblem('Chief Vibes Officer', 'llc'));
  assert.ok(/Managing Member/.test(ET.titleProblem('Chief Vibes Officer', 'llc')),
    'the refusal must say what IS acceptable');
  ok('a title on no list is refused, and the refusal names the ones that work');

  // Deliberately tolerant of ANOTHER type's title: an entity's type can be
  // corrected after its owners are recorded, and refusing the stored title at
  // that moment would either wipe it or block the correction.
  assert.strictEqual(ET.titleProblem('President', 'llc'), null);
  assert.strictEqual(ET.titleProblem('Managing Member', 'corporation'), null);
  ok('correcting the type never invalidates a title already recorded');

  assert.strictEqual(ET.titleProblem('', 'llc'), null);
  assert.strictEqual(ET.titleProblem(null, 'corporation'), null);
  ok('blank is allowed — not-yet-answered is a real state');
}

/* ─────────── D. what a screen should say ─────────── */
console.log('\nD. describing one entity');
{
  const corp = ET.describe({ entity_type: 'corporation', entity_type_confirmed: true });
  assert.strictEqual(corp.ownerNoun, 'shareholder');
  assert.strictEqual(corp.usesShares, true);
  assert.strictEqual(corp.ownershipLabel, 'Shares');
  assert.strictEqual(corp.confirmed, true);

  const llc = ET.describe({ entity_type: 'llc' });
  assert.strictEqual(llc.ownerNoun, 'member');
  assert.strictEqual(llc.ownershipLabel, 'Ownership %');
  ok('a corporation is described with shareholders and shares, an LLC with members and a percentage');

  // The whole back book was stamped by the migration with nobody choosing.
  assert.strictEqual(ET.needsConfirmation({ entity_type: 'llc', entity_type_confirmed: false }), true);
  assert.strictEqual(ET.needsConfirmation({ entity_type: 'llc', entity_type_confirmed: true }), false);
  assert.strictEqual(ET.needsConfirmation(null), true);
  ok('"we assumed" and "a person chose" are told apart');
}

/* ─────────── E. the document slots ─────────── */
console.log('\nE. which document each type is asked for');
{
  assert.strictEqual(ET.slotWording('rtl_llc_opagmt', 'llc').label, 'Operating Agreement');
  assert.strictEqual(ET.slotWording('rtl_llc_opagmt', 'corporation').label, 'Bylaws and stock certificate');
  assert.strictEqual(ET.slotWording('rtl_llc_opagmt', 'partnership').label, 'Partnership agreement');
  assert.strictEqual(ET.slotWording('rtl_llc_opagmt', 'trust').label, 'Trust agreement');
  ok('the governing-document slot is named for the document that actually exists');

  assert.strictEqual(ET.slotWording('rtl_llc_goodstanding', 'corporation'), null,
    'a certificate of good standing is called the same thing for every type — inventing four wordings would be noise');
  ok('a slot that does not vary reports null rather than a guess');

  for (const code of ET.TYPED_SLOT_CODES) {
    for (const k of ET.KEYS) {
      const w = ET.slotWording(code, k);
      assert.ok(w && w.label && w.borrowerLabel && w.hint, `${code}/${k} is missing wording`);
    }
  }
  ok('every typed slot has complete wording for all four types');
}

/* ─────────── F. the DocLab handoff ─────────── */
console.log('\nF. the type is what the loan documents read');
{
  const v = ET.docLabVariables({ entity_type: 'corporation' });
  assert.strictEqual(v.type_of_organization, 'corporation');
  assert.strictEqual(v.acknowledgement_corporate_status, 'bylaws and its shareholders');
  assert.strictEqual(v.bylaws_operating_agreement, 'bylaws');
  assert.strictEqual(v.operating_agreement_or_bylaws, 'bylaws');
  const l = ET.docLabVariables({ entity_type: 'llc' });
  assert.strictEqual(l.acknowledgement_corporate_status, 'operating agreement and its members');
  assert.strictEqual(l.bylaws_operating_agreement, 'operating agreement');
  ok('all four DocLab wordings come off the one answer');

  const base = {
    loanCategory: '12 Month', propertyAddress: { state: 'NY' }, lenderName: 'YS Capital',
    entityName: 'Acme Holdings Inc', borrowerName: 'Jane Doe',
  };
  const corp = payload.buildPayload({ ...base, entityType: 'corporation', entityShares: 1000, entityCertificateNumber: '3' },
    { name: 'YS Capital' }, { prepaymentAllowed: ['RTL-No'] });
  assert.strictEqual(corp.payload.variables.type_of_organization, 'corporation');
  assert.strictEqual(corp.payload.variables.number_of_shares, '1,000');
  assert.strictEqual(corp.payload.variables.certificate_number, '3');
  assert.strictEqual(corp.payload.variables.membership_interest_percentage, undefined,
    'a corporation must never be sent a membership percentage — the merge would print it as a fact');
  ok('a corporation is sent shares and its certificate, and no membership percentage');

  const llcOut = payload.buildPayload({ ...base, entityName: 'Acme Holdings LLC', entityType: 'llc', membershipInterestPct: 100 },
    { name: 'YS Capital' }, { prepaymentAllowed: ['RTL-No'] });
  assert.strictEqual(llcOut.payload.variables.membership_interest_percentage, '100');
  assert.strictEqual(llcOut.payload.variables.number_of_shares, undefined,
    'an LLC has no share count — sending one would put a number on a pledge that does not exist');
  assert.strictEqual(llcOut.payload.variables.certificate_number, undefined);
  ok('an LLC is sent a percentage, and never a share count or a certificate');

  // A stated type is a fact; an unstated one is our assumption, and the payload
  // must say which it is holding rather than quietly print "limited liability
  // company" on a corporation's mortgage.
  const warn = (o) => (o.warnings || []).some((w) => w.code === 'entity_type_assumed');
  assert.strictEqual(warn(llcOut), false, 'a type somebody stated must not be reported as an assumption');
  const assumed = payload.buildPayload({ ...base, entityName: 'Acme Holdings LLC' },
    { name: 'YS Capital' }, { prepaymentAllowed: ['RTL-No'] });
  assert.strictEqual(warn(assumed), true, 'an unstated type must warn');
  assert.ok(/Acme Holdings LLC/.test(assumed.warnings.find((w) => w.code === 'entity_type_assumed').message),
    'the warning must name the entity, or nobody knows which file to go and fix');
  assert.strictEqual(assumed.payload.variables.type_of_organization, 'limited liability company',
    'it still goes out — a blank on a mortgage is not better than the overwhelmingly likely answer');
  ok('an entity whose type nobody stated still goes out — with a warning naming it');

  // With NO entity at all there is nothing to assume about, so no warning: a
  // personal-name purchase must not be nagged about an entity it does not have.
  const person = payload.buildPayload({ ...base, entityName: '', vestsIndividually: true },
    { name: 'YS Capital' }, { prepaymentAllowed: ['RTL-No'] });
  assert.strictEqual(warn(person), false, 'a personal-name purchase has no entity to confirm');
  ok('a personal-name purchase is never asked to confirm an entity type');

  // A share count is a COUNT. A fraction or a zero is not one, and printing
  // "0 shares" onto a pledge is worse than printing nothing.
  for (const bad of [0, -5, 12.5, '', null, 'lots']) {
    const o = payload.buildPayload({ ...base, entityType: 'corporation', entityShares: bad },
      { name: 'YS Capital' }, { prepaymentAllowed: ['RTL-No'] });
    assert.strictEqual(o.payload.variables.number_of_shares, undefined, `a share count of ${JSON.stringify(bad)} must be refused`);
  }
  ok('a fractional, negative, zero or unreadable share count is absent, never rounded into something plausible');
}

console.log(`\nAll ${pass} entity-type checks passed.\n`);
