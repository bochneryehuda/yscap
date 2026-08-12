'use strict';
/**
 * Class Valuation order builder + client configuration — pure, no database, no network.
 *
 * Pins the three things that would send a wrong order, and the one that would
 * send an order nobody saw first:
 *   1. The V1 spelling `occupancy` is sent — NOT the V2 document's `ocupancy` typo.
 *   2. An enum we cannot map is REPORTED, never guessed into a neighbour.
 *   3. A value we derived is declared as an assumption, so the preview can show it.
 *   4. Writes are gated; reads are not.
 */
const ob = require('../src/class/order-build');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('PASS ' + l); } else { fail++; console.error('FAIL ' + l); } };

const BASE = {
  referenceNumber: 'YSCAP258134591',
  productId: 42,
  property: {
    addressLine: '195 Parrish St', city: 'Wilkes-Barre', state: 'PA', postalCode: '18702',
    county: 'Luzerne', category: 'sfr', occupancy: 'investment',
  },
  loan: { loanNumber: 'YSCAP258134591', loanAmount: 250000, purchaseAmount: 180000, loanType: 'fix_and_flip' },
  borrower: { firstName: 'Ada', lastName: 'Reyes', email: 'ada@example.com', mobile: '5551234567' },
  lender: { clientName: 'YS Capital Group' },
  contractPrice: 180000,
};

// ---------------------------------------------------------------------------
console.log('\n--- THE V1 FIELD NAME IS SENT, NOT THE V2 TYPO ---');
const r = ob.buildOrder(BASE);
ok(Object.prototype.hasOwnProperty.call(r.body, 'occupancy'),
   'the body carries `occupancy` — the V1 guide\'s spelling (rev 0.17, p.30)');
ok(!Object.prototype.hasOwnProperty.call(r.body, 'ocupancy'),
   'and does NOT carry the V2 document\'s `ocupancy` typo, which V1 would drop unrecognised');
// v1 `occupancy` binds to an undocumented live enum, so the body starts on the
// most-likely value and the sender cascades through the rest ONLY on the specific
// occupancy binding error. "Investment" was proven REJECTED by the live API, so it is
// no longer the head — an investment property leads with `Investor`, and the full
// ordered cascade is exposed for the sender to walk.
ok(r.body.occupancy === 'Investor', 'an RTL investment property leads with their Investor value (not the rejected "Investment")');
ok(Array.isArray(r.occupancyCandidates) && r.occupancyCandidates[0] === 'Investor'
   && r.occupancyCandidates.includes('Other'),
   'the full occupancy cascade is exposed, Investor-first, Other as the last-resort fallback');
ok(r.occupancyKey === 'investment', 'the classification the accepted value is remembered under is reported');
ok(!r.occupancyCandidates.slice(1).includes('Investor'),
   'the cascade never repeats a value');

// ---------------------------------------------------------------------------
console.log('\n--- the happy path is complete and placeable ---');
ok(r.canPlace === true, 'a complete file can be ordered');
ok(r.missing.length === 0, 'nothing is reported missing');
ok(r.body.propertyTypeEnum === 'SingleFamily', 'sfr -> SingleFamily');
ok(r.body.purpose === 'Bridge', 'a fix & flip carries purpose=Bridge (their list has no fix-and-flip)');
ok(r.body.referenceNumber === 'YSCAP258134591', 'our loan number is the reference number');
ok(r.body.contacts[0].Type === 'Borrower' && r.body.contacts[0].primaryContact === true,
   'the borrower is the primary contact');
ok(r.body.contacts[0].contactMethods.some((m) => m.type === 'Email' && m.value === 'ada@example.com'),
   'their email rides as a contact method');

// ---------------------------------------------------------------------------
console.log('\n--- a DERIVED value is declared, never silent ---');
const a = r.assumptions.map((x) => x.field);
ok(a.includes('loanInfo.loanType'),
   'loanType=Other is declared as an assumption (Class has no fix-and-flip value)');
ok(r.body.loanInfo.loanType === 'Other', 'and the value really is Other');
ok(r.assumptions.find((x) => x.field === 'loanInfo.loanType').why.includes('Bridge'),
   'the reason points at where the deal\'s real nature went instead');
ok(a.includes('contacts.PropertyAccess'),
   'no access contact is an assumption the reviewer sees, not a silent omission');

const pud = ob.buildOrder({ ...BASE, property: { ...BASE.property, category: 'pud' } });
ok(pud.body.propertyTypeEnum === 'SingleFamily', 'a PUD maps to SingleFamily (Class has no PUD)');
ok(pud.assumptions.some((x) => x.field === 'propertyTypeEnum'), '...and says so');

// ---------------------------------------------------------------------------
console.log('\n--- an unmappable value is REPORTED, never guessed ---');
const weird = ob.buildOrder({ ...BASE, property: { ...BASE.property, category: 'houseboat' } });
ok(weird.canPlace === false, 'an unknown property type blocks the order');
ok(weird.body.propertyTypeEnum === null, 'and is NOT guessed into a neighbouring value');
ok(weird.missing.some((m) => m.field === 'propertyTypeEnum' && /houseboat/.test(m.why)),
   'the refusal names the value it could not map');

const noType = ob.buildOrder({ ...BASE, loan: { ...BASE.loan, loanType: 'something new' } });
ok(noType.body.purpose === null && noType.canPlace === false, 'an unknown loan type blocks rather than defaulting');

// ---------------------------------------------------------------------------
console.log('\n--- every required field is checked ---');
for (const [key, patch] of [
  ['property.street', { property: { ...BASE.property, addressLine: '' } }],
  ['property.city', { property: { ...BASE.property, city: '' } }],
  ['property.state', { property: { ...BASE.property, state: '' } }],
  ['property.zip', { property: { ...BASE.property, postalCode: '' } }],
  ['referenceNumber', { referenceNumber: '' }],
  ['productId', { productId: null }],
  ['contacts.Borrower', { borrower: null }],
]) {
  const got = ob.buildOrder({ ...BASE, ...patch });
  ok(got.missing.some((m) => m.field === key) && got.canPlace === false, `missing ${key} blocks the order`);
}

// ---------------------------------------------------------------------------
console.log('\n--- a staff override always wins, and is recorded ---');
const ovr = ob.buildOrder(BASE, { propertyTypeEnum: 'Condominium', purpose: 'Purchase' });
ok(ovr.body.propertyTypeEnum === 'Condominium' && ovr.body.purpose === 'Purchase', 'the override is used');
ok(ovr.overridden.includes('propertyTypeEnum') && ovr.overridden.includes('purpose'),
   'and both are listed as overridden so the preview can show it');
const fixed = ob.buildOrder({ ...BASE, property: { ...BASE.property, category: 'houseboat' } }, { propertyTypeEnum: 'Other' });
ok(fixed.canPlace === true, 'an override rescues an otherwise unplaceable order');

// ---------------------------------------------------------------------------
// Class's notification list accepts EXACTLY ONE item, of type BorrowerInfo —
// their enum has no other type, and a list with more than one is rejected
// ("The Notification list should have exactly one item of type BorrowerInfo").
// One item per notify-email was the live rejection; the borrower's own email is
// that single item.
console.log('\n--- the notification list carries exactly ONE BorrowerInfo item (the borrower) ---');
const notif = ob.buildOrder({ ...BASE, notifyEmails: ['a@b.com', 'c@d.com'] });
ok(notif.body.notificationList.length === 1, 'exactly one notification item goes out, never one per recipient');
ok(notif.body.notificationList[0].Type === 'BorrowerInfo', 'their only documented notification type is used');
ok(notif.body.notificationList[0].Email === 'ada@example.com',
   'and it is the borrower\'s own email, not the LO/processor cc list');
// With no borrower email on file, the first valid notify-email fills the single
// slot (blanks/dupes dropped), so a borrower who never gave an email still
// leaves the list with exactly one valid recipient.
const notifNoB = ob.buildOrder({
  ...BASE, borrower: { firstName: 'Ada', lastName: 'Reyes' },
  notifyEmails: ['a@b.com', 'a@b.com', '', null, 'c@d.com'],
});
ok(notifNoB.body.notificationList.length === 1 && notifNoB.body.notificationList[0].Email === 'a@b.com',
   'no borrower email -> the first valid notify-email is the single BorrowerInfo item');
// Nothing to notify -> an empty list, never a fabricated recipient.
const notifNone = ob.buildOrder({ ...BASE, borrower: { firstName: 'Ada', lastName: 'Reyes' }, notifyEmails: [] });
ok(Array.isArray(notifNone.body.notificationList) && notifNone.body.notificationList.length === 0,
   'no email anywhere -> an empty notification list, never a made-up one');

// ---------------------------------------------------------------------------
// Class rejects a phone that is not a plain US 10-digit number ("Please enter
// valid work phone number"). A stored "+1 (570) 555-1234" / "570-555-9999" must
// go out as bare 10 digits, and an unparseable one is dropped, never sent.
console.log('\n--- phones are normalised to the 10 bare digits Class accepts ---');
const ph = ob.buildOrder({
  ...BASE,
  borrower: { firstName: 'Ada', lastName: 'Reyes', email: 'ada@example.com', mobile: '+1 (570) 555-1234' },
  loanOfficer: { firstName: 'Lee', lastName: 'Ng', email: 'lee@ys.com', workPhone: '570-555-9999' },
});
const roleOf = (c) => (c && (c.Type != null ? c.Type : c.type)) || null;
const bMethods = ph.body.contacts.find((c) => roleOf(c) === 'Borrower').contactMethods;
ok(bMethods.some((m) => m.type === 'MobilePhone' && m.value === '5705551234'),
   'a "+1 (570) 555-1234" mobile is sent as bare 10 digits — no +1 / parens / dashes');
const loContact = ph.body.contacts.find((c) => roleOf(c) === 'LoanOfficer');
ok(loContact && loContact.contactMethods.some((m) => m.type === 'WorkPhone' && m.value === '5705559999'),
   'a "570-555-9999" work phone is sent as bare 10 digits (the live rejection)');
const phBad = ob.buildOrder({
  ...BASE,
  borrower: { firstName: 'Ada', lastName: 'Reyes', email: 'ada@example.com', mobile: '555-12' },
});
const bMethods2 = phBad.body.contacts.find((c) => roleOf(c) === 'Borrower').contactMethods;
ok(!bMethods2.some((m) => m.type === 'MobilePhone'),
   'a too-short phone is dropped rather than sent for Class to reject');
ok(bMethods2.some((m) => m.type === 'Email' && m.value === 'ada@example.com'),
   'but the email method still rides');

// ---------------------------------------------------------------------------
// EVERY VALUE WE EMIT MUST BE ON THEIR LIST. This is the guard that makes the
// "never guess an enum" rule enforceable: the maps and the published lists sit in
// one file, so a value added to a map that Class does not actually accept is
// caught here rather than by a rejected order.
console.log('\n--- every value we can emit is on Class\'s own list ---');
const ENUMS = ob.ENUMS;
ok(ENUMS.propertyTypeEnum.length > 5 && ENUMS.purpose.length > 5 && ENUMS.loanType.length > 5,
   'their three published value lists are carried');
const emitted = {
  propertyTypeEnum: [...Object.values(ob._internals.PROPERTY_TYPE),
                     ...Object.values(ob._internals.PROPERTY_TYPE_ASSUMED).map(([v]) => v)],
  purpose: Object.values(ob._internals.PURPOSE),
  loanType: [...Object.values(ob._internals.LOAN_TYPE), 'Other'],   // 'Other' is the declared fallback
};
for (const [list, values] of Object.entries(emitted)) {
  for (const v of values) {
    ok(ENUMS[list].includes(v), `${list}: "${v}" is a value Class publishes`);
  }
}
// The V1 list carries three values the V2 document does not — a cheap tell that
// these were transcribed from the right guide.
for (const v of ['ConstructionLoan', 'K203', 'HELOC']) {
  ok(ENUMS.loanType.includes(v), `loanType carries the V1-only value "${v}"`);
}
ok(!ENUMS.occupancy, 'there is NO published occupancy list on V1 — their enum members are undocumented, so we must not pretend a closed list');
ok(ob.OCCUPANCY_SUGGESTIONS.includes('Investor') && !ob.OCCUPANCY_SUGGESTIONS.includes('Investment'),
   'the screen suggests Investor (the head of the investment cascade), not the rejected "Investment"');

// ---------------------------------------------------------------------------
// The order SCREEN decides which rows get an input box; the ROUTE decides what it
// will actually accept. If those two lists drift, a staffer types into a box whose
// value is silently dropped on the way in — nothing errors, the order just goes
// out with the old value. So they are compared directly.
console.log('\n--- the screen\'s editable fields match what the server accepts ---');
{
  const fs = require('fs');
  const path = require('path');
  const grab = (file, marker) => {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const at = src.indexOf(marker);
    if (at < 0) return null;
    const open = src.indexOf('[', at);
    const close = src.indexOf(']', open);
    if (open < 0 || close < 0) return null;
    return src.slice(open + 1, close).match(/'([a-zA-Z]+)'/g).map((s) => s.replace(/'/g, '')).sort();
  };
  const server = grab('src/routes/class.js', 'const OVERRIDE_KEYS');
  const screen = grab('app-v2/src/components/ClassAppraisalPanel.jsx', 'const EDITABLE');
  ok(server && server.length, 'the server\'s override allowlist was found');
  ok(screen && screen.length, 'the screen\'s editable list was found');
  ok(JSON.stringify(server) === JSON.stringify(screen),
     `the two lists are identical (server: ${server}, screen: ${screen})`);
}

// ===========================================================================
// UAD 2.6 AND UAD 3.6 — BOTH BUILT, 2.6 THE DEFAULT.
//
// Every difference between the two versions fails SILENTLY if it is got wrong: a
// renamed field, a re-cased key and a value list that gained and lost members are
// all "unrecognised field, dropped, no error" on the other version. So each one is
// asserted in BOTH directions — the right name present AND the wrong name absent.
// ===========================================================================
console.log('\n--- the two versions are both built, and 2.6 is the default ---');
ok(ob.DEFAULT_VERSION === 'v1', 'the default is v1 / UAD 2.6 — the owner\'s choice until the industry shifts');
ok(ob.VERSIONS.length === 2 && ob.VERSIONS.map((v) => v.uad).join(',') === '2.6,3.6',
   'both versions are offered');
const v26 = ob.buildOrder(BASE);
const v36 = ob.buildOrder(BASE, {}, { version: 'v2' });
ok(v26.uad === '2.6' && v26.path === '/orders', 'with no version asked for, the order is a 2.6 order on /orders');
ok(v36.uad === '3.6' && v36.path === '/v2/orders', 'asking for v2 builds a 3.6 order on /v2/orders');
for (const [spelling, want] of [['1', 'v1'], ['2', 'v2'], ['2.6', 'v1'], ['3.6', 'v2'], ['V2', 'v2'],
                                ['', 'v1'], [null, 'v1'], ['nonsense', 'v1']]) {
  ok(ob.profileFor(spelling).version === want,
     `"${spelling}" reads as ${want} (a typo falls back to the default, never throws)`);
}

console.log('\n--- the property type is RENAMED between them, not just re-valued ---');
ok(v26.body.propertyTypeEnum === 'SingleFamily' && v26.body.propertyType === undefined,
   '2.6 sends `propertyTypeEnum` and nothing called `propertyType`');
ok(v36.body.propertyType === 'SingleFamily' && v36.body.propertyTypeEnum === undefined,
   '3.6 sends `propertyType` and nothing called `propertyTypeEnum`');

console.log('\n--- PUD: an assumption on 2.6, a real value on 3.6 ---');
const pud26 = ob.buildOrder({ ...BASE, property: { ...BASE.property, category: 'pud' } });
const pud36 = ob.buildOrder({ ...BASE, property: { ...BASE.property, category: 'pud' } }, {}, { version: 'v2' });
ok(pud26.body.propertyTypeEnum === 'SingleFamily' && pud26.assumptions.some((a) => a.field === 'propertyTypeEnum'),
   '2.6 has no PUD, so it files as single family AND says so');
ok(pud36.body.propertyType === 'PUD', '3.6 carries PUD properly');
ok(!pud36.assumptions.some((a) => a.field === 'propertyType'),
   '...so on 3.6 it is NOT an assumption — nothing was decided on the file\'s behalf');

console.log('\n--- a value one version has and the other does not ---');
const big26 = ob.buildOrder({ ...BASE, property: { ...BASE.property, category: 'multi_5_plus' } });
const big36 = ob.buildOrder({ ...BASE, property: { ...BASE.property, category: 'multi_5_plus' } }, {}, { version: 'v2' });
ok(big26.body.propertyTypeEnum === 'MultiFamily' && big26.canPlace === true, '2.6 has MultiFamily for a 5+ unit building');
ok(big36.body.propertyType === null && big36.canPlace === false,
   '3.6 has no 5+ value, so it BLOCKS rather than squeezing the building into the 2-4 bucket');
ok(big36.missing.some((m) => m.field === 'propertyType' && /3\.6/.test(m.why)),
   'and the refusal names the version that cannot carry it');
const town36 = ob.buildOrder({ ...BASE, property: { ...BASE.property, category: 'townhouse' } }, {}, { version: 'v2' });
ok(town36.body.propertyType === 'PUD' && town36.assumptions.some((a) => a.field === 'propertyType'),
   'a townhouse has no 3.6 value either, so it is filed as a PUD as a DECLARED assumption');

console.log('\n--- the contact key is re-cased, and the wrong case is a dropped field ---');
ok(v26.body.contacts[0].Type === 'Borrower' && v26.body.contacts[0].type === undefined,
   '2.6 contacts carry `Type`');
ok(v36.body.contacts[0].type === 'Borrower' && v36.body.contacts[0].Type === undefined,
   '3.6 contacts carry `type`');
ok(v36.missing.length === v26.missing.length,
   'and the borrower-contact check still finds the contact whichever way it is spelled');
const noBorrower36 = ob.buildOrder({ ...BASE, borrower: null }, {}, { version: 'v2' });
ok(noBorrower36.missing.some((m) => m.field === 'contacts.Borrower'),
   'a missing borrower is still caught on 3.6 — the check reads the role, not one spelling');

console.log('\n--- the notification list re-cases BOTH of its keys ---');
const n26 = ob.buildOrder({ ...BASE, notifyEmails: ['a@b.com'] });
const n36 = ob.buildOrder({ ...BASE, notifyEmails: ['a@b.com'] }, {}, { version: 'v2' });
ok(n26.body.notificationList[0].Type === 'BorrowerInfo' && n26.body.notificationList[0].Email === 'ada@example.com',
   '2.6 uses Type/Email, carrying the borrower\'s own email');
ok(n36.body.notificationList[0].type === 'BorrowerInfo' && n36.body.notificationList[0].email === 'ada@example.com',
   '3.6 uses type/email');
ok(n36.body.notificationList[0].Type === undefined && n36.body.notificationList[0].Email === undefined,
   'and 3.6 carries neither of the 2.6 spellings');

console.log('\n--- occupancy: a live-enum cascade on 2.6, a closed list on 3.6 ---');
ok(v26.body.occupancy === 'Investor' && v36.body.occupancy === 'Investment',
   'an investment property leads with Investor on 2.6 (undocumented enum) and says Investment on 3.6 (their published list)');
const prim36 = ob.buildOrder({ ...BASE, property: { ...BASE.property, occupancy: 'primary' } }, {}, { version: 'v2' });
ok(prim36.body.occupancy === 'PrimaryResidence', '3.6 uses their enum name, not our word');
const prim26 = ob.buildOrder({ ...BASE, property: { ...BASE.property, occupancy: 'primary' } });
ok(prim26.body.occupancy === 'PrimaryResidence' && prim26.occupancyCandidates.includes('Owner'),
   '2.6 leads a primary residence with PrimaryResidence and keeps Owner as a fallback (both spellings tried)');
const vac26 = ob.buildOrder({ ...BASE, property: { ...BASE.property, occupancy: 'vacant' } });
const vac36 = ob.buildOrder({ ...BASE, property: { ...BASE.property, occupancy: 'vacant' } }, {}, { version: 'v2' });
ok(vac26.body.occupancy === 'Vacant', '2.6 leads a vacant property with Vacant');
ok(vac36.body.occupancy === 'Other' && vac36.assumptions.some((a) => a.field === 'occupancy'),
   '3.6 has no vacant value, so it says Other and DECLARES it rather than inventing a word');
const odd36 = ob.buildOrder({ ...BASE, property: { ...BASE.property, occupancy: 'squatters' } }, {}, { version: 'v2' });
ok(odd36.body.occupancy === null && odd36.canPlace === false,
   'an occupancy 3.6 cannot express BLOCKS rather than being guessed');
const odd26 = ob.buildOrder({ ...BASE, property: { ...BASE.property, occupancy: 'squatters' } });
ok(odd26.canPlace === true && odd26.body.occupancy === 'Other',
   'an unrecognised 2.6 occupancy still places, on their near-certain "Other" fallback — the appraiser determines the real one');

console.log('\n--- the GSE reference numbers are renamed on 3.6 ---');
const gse26 = ob.buildOrder({ ...BASE, caseFileId: 'DU-1', lpaKey: 'LPA-1' });
const gse36 = ob.buildOrder({ ...BASE, caseFileId: 'DU-1', lpaKey: 'LPA-1' }, {}, { version: 'v2' });
ok(gse26.body.caseFileId === 'DU-1' && gse26.body.lpaKey === 'LPA-1', '2.6 keeps caseFileId / lpaKey');
ok(gse36.body.duReferenceNumber === 'DU-1' && gse36.body.lpaKeyReferenceIdentifier === 'LPA-1',
   '3.6 renames them to duReferenceNumber / lpaKeyReferenceIdentifier');
ok(gse36.body.caseFileId === undefined && gse36.body.lpaKey === undefined, 'and does not send the old names too');
ok(v26.body.caseFileId === undefined && v36.body.duReferenceNumber === undefined,
   'a file with neither sends neither — an RTL deal has no GSE case number');

console.log('\n--- a staffer can send ONE order on the other version ---');
const chosen = ob.buildOrder(BASE, { apiVersion: 'v2' });
ok(chosen.uad === '3.6' && chosen.overridden.includes('apiVersion'),
   'the version can be chosen per order, and the choice is recorded like any other override');
ok(ob.buildOrder(BASE, { apiVersion: 'v2' }, { version: 'v1' }).uad === '3.6',
   'and that choice beats the system default rather than the other way round');

console.log('\n--- every value each version can emit is on THAT version\'s list ---');
for (const [ver, key] of [['v1', 'propertyTypeEnum'], ['v2', 'propertyType']]) {
  const prof = ob.profileFor(ver);
  const emit = [...Object.values(prof.propertyType), ...Object.values(prof.propertyTypeAssumed).map(([v]) => v)];
  for (const v of emit) ok(prof.enums[key].includes(v), `${ver}: property type "${v}" is on their ${prof.uad} list`);
  for (const v of Object.values(prof.purpose || {})) { /* purpose is shared */ }
  if (prof.occupancyIsEnum) {
    const occ = [...Object.values(prof.occupancy), ...Object.values(prof.occupancyAssumed).map(([v]) => v)];
    for (const v of occ) ok(prof.enums.occupancy.includes(v), `${ver}: occupancy "${v}" is on their ${prof.uad} list`);
  }
}

console.log('\n--- the screen is told which shape each version\'s fields are ---');
const o26 = ob.screenOptions('v1'), o36 = ob.screenOptions('v2');
ok(o26.occupancyIsEnum === false && o36.occupancyIsEnum === true,
   'so the screen shows a type-ahead on 2.6 and a dropdown on 3.6 — never a free field dressed as a choice');
ok(o26.propertyTypeField === 'propertyTypeEnum' && o36.propertyTypeField === 'propertyType',
   'and knows which field name this version uses');
ok(o36.enums.propertyType.includes('PUD') && !o26.enums.propertyTypeEnum.includes('PUD'),
   'the two property-type lists really are different lists, not one superset');

// ---------------------------------------------------------------------------
console.log('\n--- the client: writes gated, reads not, secrets masked ---');
process.env.CLASS_ENABLED = '0';
delete require.cache[require.resolve('../src/config')];
const client = require('../src/class/client');
const cfgd = client.configured();
ok(cfgd.enabled === false, 'the master switch is off by default');
ok(cfgd.outbound === false, 'ordering is off by default');
ok(cfgd.ready === false, 'with no credentials it is not ready');

const h = client.hosts();
ok(/classvaluation\.com/.test(h.ordersUrl) && /classvaluation\.com/.test(h.tokenUrl), 'both hosts resolve');
// The V1 guide prints `https://api.uat.classvaluation.com/orders` verbatim (p.13).
// The V2 document's `orders-external.*` hosts are a DIFFERENT API — pinned so a
// regression back to them is caught here rather than by a 404 in production.
ok(h.ordersUrl === 'https://api.uat.classvaluation.com', 'the UAT order host is the V1 one');
ok(!/orders-external/.test(h.ordersUrl), 'and is NOT the V2 document\'s orders-external host');
ok(client._internals.HOSTS.production.orders === 'https://api.classvaluation.com', 'production likewise');
ok(client._internals.HOSTS.test.orders === 'https://api.test.classvaluation.com', 'test likewise');
ok(h.environment === 'uat', 'UAT is the default environment, never production');
ok(h.tokenConfirmed === true,
   'the UAT identity host is now vendor-CONFIRMED (ids.uat.classvaluation.com)');
ok(client._internals.HOSTS.test.tokenConfirmed === true, 'the test identity host IS confirmed by the guide');
ok(client._internals.HOSTS.production.tokenConfirmed === false,
   'production identity is STILL inferred — confirm it before switching production on');
// The data prefix the live API hangs every route off — reported so a preflight can
// print exactly where an order call goes (not just the host).
ok(h.apiPrefix === '/intg' && h.apiBase === 'https://api.uat.classvaluation.com/intg',
   'hosts() reports the /intg data prefix and the full data base');

const masked = client._internals.maskSafe({ client_secret: 'abc', password: 'p', nested: { access_token: 't', keep: 'ok' } });
ok(masked.client_secret === '***' && masked.password === '***' && masked.nested.access_token === '***',
   'every credential shape is masked before it can reach a log');
ok(masked.nested.keep === 'ok', 'ordinary values survive masking');

// A non-JSON body must be PRESERVED — this is the AMC firewall lesson.
const raw = client._internals.readBody(Buffer.from('<html>Blocked by proxy</html>'));
ok(raw.raw && /Blocked by proxy/.test(raw.raw),
   'a non-JSON reply is kept, so a blocked firewall never reads as a bad credential');

// =========================================================================
// A TYPED VALUE IS CHECKED AGAINST THE VERSION ACTUALLY BEING SENT.
//
// Found by the pre-merge correctness audit. The two vocabularies overlap in shape
// and not in content, and the order screen MERGES overrides when the version toggle
// is pressed — so a value picked under 2.6 rode straight into a 3.6 order, with
// canPlace:true and nothing said. Class drops an unrecognised value with no error,
// so the appraiser would have been dispatched with no property type at all. Every
// assertion below fails on the code as it was written.
console.log('\n--- a value from the other version is refused, not sent ---');

const encCtx = {
  referenceNumber: 'YSCAP-ENUM', productId: 4,
  property: { category: 'sfr', occupancy: 'investment' },
  loan: { loanType: 'fix_and_flip' },
};
const fieldsOf = (b) => b.missing.map((m) => m.field);

// The exact click sequence: pick 2.6 values, then flip the toggle to 3.6.
const carried = ob.buildOrder(encCtx,
  { propertyTypeEnum: 'TownhouseorRowhouse', occupancy: 'Vacant', apiVersion: 'v2' }, {});
ok(carried.apiVersion === 'v2' && carried.path === '/v2/orders', 'the 3.6 toggle still selects the 3.6 endpoint');
ok(carried.body.propertyType == null,
   'a UAD 2.6 property type is NOT sent to the 3.6 endpoint — Class would drop it in silence');
ok(carried.body.occupancy == null, 'nor is a 2.6 occupancy value');
ok(carried.canPlace === false, 'and the order cannot be placed while it carries them');
ok(fieldsOf(carried).includes('propertyType') && fieldsOf(carried).includes('occupancy'),
   'both are named on the screen, by the field name THIS version uses');
ok(fieldsOf(carried).filter((f) => f === 'propertyType').length === 1,
   'and each is reported exactly once — the specific reason, not a vaguer duplicate');
ok(/UAD 3\.6/.test(carried.missing.find((m) => m.field === 'propertyType').why),
   'the reason names the version, because the value was legal on the list they picked it from');

// The same guard on 2.6, whose property-type list lives under a different key —
// getting that key wrong silently disabled validation on the default version.
const junk26 = ob.buildOrder(encCtx, { propertyTypeEnum: 'NotAThing', purpose: 'Nope' }, { version: 'v1' });
ok(junk26.body.propertyTypeEnum == null && junk26.body.purpose == null,
   'invented values are refused on 2.6 as well, not only on 3.6');
ok(junk26.canPlace === false, 'and they block the order');

// A repeated query parameter arrives as an array; an array is not a value from a list.
const arrayed = ob.buildOrder(encCtx, { propertyTypeEnum: ['SingleFamily', 'Condominium'] }, {});
ok(arrayed.canPlace === false && arrayed.body.propertyTypeEnum == null,
   'a repeated parameter (an array) is refused rather than sent as JSON');

// ...and the legitimate case is untouched on BOTH versions, or the guard would be
// worse than the bug — nobody could correct a field by hand.
for (const [v, ovr, key] of [
  ['v1', { propertyTypeEnum: 'Condominium' }, 'propertyTypeEnum'],
  ['v2', { propertyTypeEnum: 'Condominium', occupancy: 'Investment' }, 'propertyType'],
]) {
  const good = ob.buildOrder(encCtx, ovr, { version: v });
  const enumFields = ['propertyType', 'propertyTypeEnum', 'occupancy', 'purpose', 'loanInfo.loanType'];
  ok(good.body[key] === 'Condominium' && !fieldsOf(good).some((f) => enumFields.includes(f)),
     `a valid ${v === 'v1' ? '2.6' : '3.6'} value typed by a human is still accepted and still sent`);
  ok(good.overridden.includes('propertyTypeEnum'), `and is still reported as overridden on ${v}`);
}

// A 2.6 occupancy a staffer TYPES is not validated (their enum is undocumented) — it is
// tried FIRST, then the classification's auto candidates fall in behind it, so a typo can
// never block the order: the cascade recovers on a value Class actually accepts.
const typed = ob.buildOrder(encCtx, { occupancy: 'Tenant occupied, rent roll attached' }, { version: 'v1' });
ok(typed.body.occupancy === 'Tenant occupied, rent roll attached',
   'UAD 2.6 tries the typed occupancy first — sent verbatim as the head of the cascade');
ok(typed.occupancyCandidates.length > 1 && typed.occupancyCandidates[0] === 'Tenant occupied, rent roll attached',
   'and keeps auto fallbacks behind it, so a typed value the live enum refuses still recovers');

// ---------------------------------------------------------------------------
console.log('\n--- isOccupancyEnumError: the ONE error the sender may cascade past ---');
// Shape A — Class's OWN error envelope, verbatim from the owner's failure (the shape
// actually observed on the wire).
const enumErr = Object.assign(new Error('Class createOrder failed: HTTP 400'), {
  status: 400,
  body: { success: false, code: '400', error: 'The JSON value could not be converted to CV.OrdersExternal.Common.Orders.OccupancyTypeEnum. Path: $.occupancy | LineNumber: 0 | BytePositionInLine: 987.' },
});
ok(ob.isOccupancyEnumError(enumErr) === true, 'the live vendor occupancy binding 400 is recognised (verbatim from the owner\'s failure)');
// Shape B — ASP.NET Core's DEFAULT ValidationProblemDetails, where the failing field
// is a KEY under `errors`, not a substring of `error`. The detector must find it here
// too, or the cascade silently never fires against a framework that returns this shape.
const problemDetails = Object.assign(new Error('Class createOrder failed: HTTP 400'), {
  status: 400,
  body: { type: 'https://tools.ietf.org/html/rfc9110', title: 'One or more validation errors occurred.', status: 400,
    errors: { '$.occupancy': ['The JSON value could not be converted to CV.OrdersExternal.Common.Orders.OccupancyTypeEnum.'] } },
});
ok(ob.isOccupancyEnumError(problemDetails) === true, 'the ASP.NET Core ValidationProblemDetails errors{} shape is recognised too (the field is a KEY there)');
// Multi-field ValidationProblemDetails naming occupancy AND another field: occupancy is
// among the bad ones, so we still cascade it (once it binds, the path/type is gone).
const multi = Object.assign(new Error('x'), { status: 400, body: { errors: {
  '$.occupancy': ['could not be converted to OccupancyTypeEnum'],
  '$.propertyTypeEnum': ['could not be converted to PropertyType'] } } });
ok(ob.isOccupancyEnumError(multi) === true, 'a multi-field error that INCLUDES occupancy still cascades occupancy');
// A DIFFERENT field alone — even in the errors{} shape — must NOT cascade.
const otherEnum = Object.assign(new Error('x'), { status: 400, body: { errors: { '$.propertyTypeEnum': ['could not be converted to PropertyTypeEnum'] } } });
ok(ob.isOccupancyEnumError(otherEnum) === false, 'a DIFFERENT field\'s binding error is NOT cascaded — it stops and surfaces as itself');
const otherEnvelope = Object.assign(new Error('x'), { status: 400, body: { success: false, error: 'could not be converted to PropertyTypeEnum. Path: $.propertyTypeEnum' } });
ok(ob.isOccupancyEnumError(otherEnvelope) === false, 'nor does the envelope shape false-match a different field');
ok(ob.isOccupancyEnumError(Object.assign(new Error('boom'), { status: 500 })) === false, 'a 500 is never treated as an occupancy cascade');
ok(ob.isOccupancyEnumError(null) === false && ob.isOccupancyEnumError(undefined) === false, 'a missing error never cascades');
ok(ob.isOccupancyEnumError(Object.assign(new Error('gate off'), { code: 'CLASS_OUTBOUND_DISABLED' })) === false,
   'the write-gate refusal is not a 400 and never cascades');

console.log('\n--- describeOrderError: the reason we STORE and LOG is never just "HTTP 400" ---');
// The real occupancy failure (envelope shape A): our message + the vendor's own text,
// so last_error carries the actual cause a person can read.
const dA = ob.describeOrderError(enumErr);
ok(/HTTP 400/.test(dA) && /OccupancyTypeEnum/.test(dA),
   'the stored reason combines our message with the vendor body text (not just "HTTP 400")');
// ASP.NET ValidationProblemDetails: the field is a KEY, and it is surfaced by name.
const dB = ob.describeOrderError(problemDetails);
ok(/\$\.occupancy/.test(dB) && /OccupancyTypeEnum/.test(dB),
   'the ASP.NET errors{} shape is flattened into the reason, naming the field');
// A raw (non-JSON) body kept verbatim by readBody under `raw`.
const rawErr = Object.assign(new Error('Class createOrder failed: HTTP 502'), { status: 502, body: { raw: 'Bad Gateway (nginx)' } });
ok(/HTTP 502/.test(ob.describeOrderError(rawErr)) && /Bad Gateway/.test(ob.describeOrderError(rawErr)),
   'a raw non-JSON body is surfaced too');
// A plain string body.
ok(/upstream timeout/.test(ob.describeOrderError(Object.assign(new Error('x'), { body: 'upstream timeout' }))),
   'a plain string vendor body is surfaced');
// No body — just our message.
ok(ob.describeOrderError(Object.assign(new Error('the connection dropped'), {})) === 'the connection dropped',
   'with no vendor body the reason is simply our message');
// The vendor text is not repeated when our message already carries it (the {success:false} path).
const refused = Object.assign(new Error('Class createOrder refused: occupancy invalid'), { body: { success: false, message: 'occupancy invalid' } });
ok(ob.describeOrderError(refused) === 'Class createOrder refused: occupancy invalid',
   'the vendor text is not appended twice when our message already contains it');
// Never blank, never throws on junk.
ok(ob.describeOrderError(null) === 'unknown error', 'a missing error yields a readable fallback');
ok(typeof ob.describeOrderError(Object.assign(new Error(''), { body: {} })) === 'string'
   && ob.describeOrderError(Object.assign(new Error(''), { body: {} })).length > 0,
   'an empty error still yields a non-empty reason');
// Bounded so it can never overflow the last_error column.
const huge = Object.assign(new Error('x'.repeat(400)), { body: { error: 'y'.repeat(400) } });
ok(ob.describeOrderError(huge).length <= 500, 'the stored reason is capped at 500 characters');
// vendorErrorText directly on the three shapes.
ok(ob._internals.vendorErrorText({ error: 'boom' }) === 'boom', 'envelope error text');
ok(ob._internals.vendorErrorText({ errors: { '$.x': ['a', 'b'] } }) === '$.x: a; b', 'errors{} flattened with the key');
ok(ob._internals.vendorErrorText(null) === '' && ob._internals.vendorErrorText(undefined) === '', 'no body -> empty');

console.log(`\ntest-class-order-build-pure: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
