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
ok(r.body.occupancy === 'Investment', 'an RTL investment property maps to their Investment value');

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
console.log('\n--- notification emails are cleaned ---');
const notif = ob.buildOrder({ ...BASE, notifyEmails: ['a@b.com', 'a@b.com', '', null, 'c@d.com'] });
ok(notif.body.notificationList.length === 2, 'blanks dropped and duplicates collapsed');
ok(notif.body.notificationList[0].Type === 'BorrowerInfo', 'their only documented notification type is used');

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
ok(h.tokenConfirmed === false,
   'the UAT identity host is reported UNCONFIRMED — their guide only ever prints the test one');
ok(client._internals.HOSTS.test.tokenConfirmed === true, 'the test identity host IS confirmed by the guide');

const masked = client._internals.maskSafe({ client_secret: 'abc', password: 'p', nested: { access_token: 't', keep: 'ok' } });
ok(masked.client_secret === '***' && masked.password === '***' && masked.nested.access_token === '***',
   'every credential shape is masked before it can reach a log');
ok(masked.nested.keep === 'ok', 'ordinary values survive masking');

// A non-JSON body must be PRESERVED — this is the AMC firewall lesson.
const raw = client._internals.readBody(Buffer.from('<html>Blocked by proxy</html>'));
ok(raw.raw && /Blocked by proxy/.test(raw.raw),
   'a non-JSON reply is kept, so a blocked firewall never reads as a bad credential');

console.log(`\ntest-class-order-build-pure: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
