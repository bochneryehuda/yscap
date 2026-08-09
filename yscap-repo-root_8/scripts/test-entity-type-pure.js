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
    // Whichever bracket the value actually opens with — the tables are a mix of
    // arrays and objects, and hard-coding one per name is how this silently
    // grabbed an empty array and "proved" the mirror was empty.
    const eq = src.indexOf('=', at);
    const oCurly = src.indexOf('{', eq); const oSquare = src.indexOf('[', eq);
    const open = (oCurly !== -1 && (oSquare === -1 || oCurly < oSquare)) ? oCurly : oSquare;
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

  const mirrorSubs = grab('ENTITY_SUBTYPES');
  for (const t of ET.KEYS) {
    const mine = ET.subtypesFor(t).map((x) => [x.key, x.label]);
    const theirs = (mirrorSubs[t] || []).map((x) => [x.key, x.label]);
    assert.deepStrictEqual(theirs, mine, `${t}: the portal offers different sub-kinds than the server accepts`);
  }
  ok('every sub-kind matches — a picker can never offer one the server would drop');

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

/* ─────────── G. the sub-kinds: partnership and trust ─────────── */
console.log('\nG. a partnership and a trust are not one thing each');
{
  assert.deepStrictEqual(ET.subtypesFor('partnership').map((x) => x.key), ['general', 'limited', 'llp']);
  assert.deepStrictEqual(ET.subtypesFor('trust').map((x) => x.key), ['revocable', 'irrevocable']);
  assert.deepStrictEqual(ET.subtypesFor('llc'), []);
  assert.strictEqual(ET.hasSubtypes('corporation'), false);
  ok('only a partnership and a trust have a kind at all');

  // NORMALIZED AGAINST THE TYPE. A sub-kind stored on the wrong type would
  // silently relax the wrong requirement, so it must not be storable at all.
  assert.strictEqual(ET.normalizeSubtype('partnership', 'revocable'), '');
  assert.strictEqual(ET.normalizeSubtype('llc', 'general'), '');
  assert.strictEqual(ET.normalizeSubtype('trust', 'revocable'), 'revocable');
  assert.strictEqual(ET.normalizeSubtype('partnership', 'LP'), 'limited');
  assert.strictEqual(ET.normalizeSubtype('partnership', 'Limited partnership (LP)'), 'limited');
  assert.strictEqual(ET.normalizeSubtype('partnership', 'nonsense'), '');
  assert.strictEqual(ET.normalizeSubtype('partnership', ''), '');
  ok("a kind is read against its own type — one from another type reads as nothing");

  /* THE POINT OF THE WHOLE THING. `missingForVerification` is a HARD gate, and a
     verified entity is what satisfies the vesting-entity condition, which gates
     clear to close. A revocable living trust uses the grantor's own Social
     Security number and is filed with no state; a general partnership is created
     by its agreement and is filed with no state either. Requiring those would
     make a perfectly ordinary family trust permanently unverifiable. */
  const req = (t, sk) => ET.requirements({ entity_type: t, entity_subtype: sk });
  assert.deepStrictEqual(req('llc'), { ein: true, formationState: true, formationDate: true, subtypeKnown: true });
  assert.deepStrictEqual(req('corporation'), { ein: true, formationState: true, formationDate: true, subtypeKnown: true });
  ok('an LLC and a corporation must still have all three — nothing was relaxed for them');

  assert.strictEqual(req('trust', 'revocable').ein, false, 'a revocable trust has no EIN of its own');
  assert.strictEqual(req('trust', 'revocable').formationState, false);
  assert.strictEqual(req('trust', 'irrevocable').ein, true, 'an irrevocable trust does have its own EIN');
  assert.strictEqual(req('trust', 'irrevocable').formationState, false, 'no trust is state-filed');
  assert.strictEqual(req('partnership', 'general').ein, true, 'a general partnership files a return, so it has an EIN');
  assert.strictEqual(req('partnership', 'general').formationState, false, 'but it is filed with no state');
  assert.strictEqual(req('partnership', 'limited').formationState, true, 'an LP files a certificate with the state');
  assert.strictEqual(req('partnership', 'llp').formationState, true);
  ok('each kind is asked only for what it can actually produce');

  // The DATE is never relaxed: a trust is legally identified by its name AND its
  // date, and a partnership agreement is dated.
  for (const [t, sk] of [['trust', 'revocable'], ['partnership', 'general'], ['llc', null]]) {
    assert.strictEqual(req(t, sk).formationDate, true, `${t} must still carry a date`);
  }
  ok('the date is always required — it is part of a trust\'s legal name');

  /* AN UNSTATED KIND RELAXES RATHER THAN BLOCKS, deliberately: the two mistakes
     do not cost the same. Demand an EIN a revocable trust does not have and the
     file dead-ends with nobody able to fix it; fail to demand an LP's state
     certificate and a reviewer simply asks for it. */
  assert.strictEqual(req('trust', null).ein, false);
  assert.strictEqual(req('partnership', null).formationState, false);
  assert.strictEqual(req('partnership', null).subtypeKnown, false, 'and it SAYS it does not know, so a screen can ask');
  assert.strictEqual(req('llc', null).subtypeKnown, true, 'a type with no kind is never "unknown"');
  ok('an unstated kind relaxes and flags itself, rather than dead-ending the file');
}

/* ─────────── H. what the documents call it ─────────── */
console.log('\nH. the kind is printed on the instrument');
{
  const org = (t, sk) => ET.docLabVariables({ entity_type: t, entity_subtype: sk }).type_of_organization;
  assert.strictEqual(org('partnership', 'general'), 'general partnership');
  assert.strictEqual(org('partnership', 'limited'), 'limited partnership');
  assert.strictEqual(org('partnership', 'llp'), 'limited liability partnership');
  assert.strictEqual(org('partnership', null), 'partnership');
  ok('a partnership is named exactly — they are different legal entities with different liability');

  // Deliberately NOT refined. "trust" is never wrong; the trust's own name
  // carries the rest ("The Smith Family Trust, dated March 3, 2019"), and a
  // wrong word on a recorded instrument is expensive.
  assert.strictEqual(org('trust', 'revocable'), 'trust');
  assert.strictEqual(org('trust', 'irrevocable'), 'trust');
  ok('a trust stays "trust" — the safe word, with the name carrying the detail');

  // The governing document and the acknowledgement do not move with the kind.
  const v = ET.docLabVariables({ entity_type: 'partnership', entity_subtype: 'limited' });
  assert.strictEqual(v.bylaws_operating_agreement, 'partnership agreement');
  assert.strictEqual(v.acknowledgement_corporate_status, 'partnership agreement and its partners');
  ok('the governing-document wording is the type\'s, not the kind\'s');

  const base = {
    loanCategory: '12 Month', propertyAddress: { state: 'NY' }, lenderName: 'YS Capital',
    entityName: 'Hudson Partners LP', borrowerName: 'Jane Doe',
  };
  const lp = payload.buildPayload({ ...base, entityType: 'partnership', entitySubtype: 'limited', membershipInterestPct: 100 },
    { name: 'YS Capital' }, { prepaymentAllowed: ['RTL-No'] });
  assert.strictEqual(lp.payload.variables.type_of_organization, 'limited partnership');
  assert.strictEqual(lp.payload.variables.membership_interest_percentage, '100');
  assert.strictEqual(lp.payload.variables.number_of_shares, undefined,
    'a partnership holds percentages, never shares');
  ok('a partnership goes out through the percentage path, named for its kind');

  const warn = (o, code) => (o.warnings || []).some((w) => w.code === code);
  const vague = payload.buildPayload({ ...base, entityType: 'partnership' },
    { name: 'YS Capital' }, { prepaymentAllowed: ['RTL-No'] });
  assert.strictEqual(warn(vague, 'entity_subtype_unstated'), true);
  assert.strictEqual(warn(lp, 'entity_subtype_unstated'), false);
  const anLlc = payload.buildPayload({ ...base, entityName: 'Acme LLC', entityType: 'llc' },
    { name: 'YS Capital' }, { prepaymentAllowed: ['RTL-No'] });
  assert.strictEqual(warn(anLlc, 'entity_subtype_unstated'), false,
    'an LLC has no kind, so it must never be nagged for one');
  ok('an unstated kind warns, and a type that has none never does');
}

/* ─────────── I. the slots ask for a document that exists ─────────── */
console.log('\nI. the slots follow the kind');
{
  const gp = ET.slotWording('rtl_llc_formation', 'partnership', 'general');
  assert.ok(/not filed with any state|if the partnership has one/i.test(gp.label + ' ' + gp.hint),
    'a general partnership must not be asked for a certificate it never had');
  const lp = ET.slotWording('rtl_llc_formation', 'partnership', 'limited');
  assert.ok(/Certificate of Limited Partnership/i.test(lp.label));
  assert.strictEqual(ET.slotWording('rtl_llc_formation', 'partnership', 'llp').label,
    'LLP registration (formation state)');
  ok('each kind of partnership is asked for its own filing, or told there is none');

  // An unstated kind falls back to the TYPE's wording rather than a guess.
  assert.strictEqual(ET.slotWording('rtl_llc_formation', 'partnership', '').label,
    'Certificate of Partnership (formation state)');
  assert.strictEqual(ET.slotWording('rtl_llc_formation', 'partnership').label,
    'Certificate of Partnership (formation state)');
  ok('no kind falls back to the type, and the old two-argument call still works');

  // slotWordings must list every variant, or applyEntitySlotWording would refuse
  // to re-word a slot when the kind changes.
  const all = ET.slotWordings('rtl_llc_formation').map((w) => w.label);
  for (const sk of ['general', 'limited', 'llp']) {
    assert.ok(all.includes(ET.slotWording('rtl_llc_formation', 'partnership', sk).label),
      `the ${sk} wording must be in the known set`);
  }
  ok('every kind\'s wording is in the known set the re-word guard uses');

  const t = ET.describe({ entity_type: 'trust', entity_subtype: 'revocable' });
  assert.strictEqual(t.dateLabel, 'Trust date');
  assert.strictEqual(t.subtypeLabel, 'Revocable (living) trust');
  assert.strictEqual(t.requirements.ein, false);
  assert.strictEqual(ET.describe({ entity_type: 'llc' }).dateLabel, 'Formation date');
  assert.strictEqual(ET.describe({ entity_type: 'partnership' }).dateLabel, 'Partnership agreement date');
  ok('the date box asks the right question — a trust has a trust date, not a formation date');
}

console.log(`\nAll ${pass} entity-type checks passed.\n`);
