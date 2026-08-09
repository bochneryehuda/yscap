'use strict';
/**
 * AMC order desk — the form's NAME and the four role CONTACTS (owner-directed
 * 2026-08-09: "AppraisalScope / NAN — says only the form number, we need to see the
 * full form name in the order; also we need to add to AppraisalScope / NAN the
 * contacts same as we have with class").
 *
 * PURE — no database, no network. Every assertion here reproduces something that was
 * wrong on the reported screen (a bare "#56634", nobody but the borrower reaching the
 * appraiser) or guards a rule that would quietly send the order to the wrong place if
 * it were relaxed — above all: OUR loan officer may never occupy their LoanOfficer
 * slot, which on this tenant carries the NOTE BUYER.
 */
const assert = require('assert');
const ob = require('../src/amc/order-build');
const cdg = require('../src/amc/cdg');
const orderService = require('../src/amc/order-service');
const { personFrom, splitName } = require('../src/lib/appraisal-contacts');

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) { pass++; } else { fail++; console.error('  FAIL: ' + what); } };

// ---------------------------------------------------------------------------
// 1. The form NAME
// ---------------------------------------------------------------------------
const CATALOG = [
  { id: '56634', name: '1004 - Single Family Residence - Completed Subject to (w/As Is Value)' },
  { id: '55975', name: '1004 w/ 1007 - Single Family Residence' },
];
const RULES = [
  { id: 1, product_code: '56634', product_name: 'Owner’s label for 56634' },
  { id: 2, product_code: '99999', product_name: '1025 - Multi-Family (2-4 unit)' },
];

ok(orderService.formNameFor('56634', CATALOG, RULES)
  === '1004 - Single Family Residence - Completed Subject to (w/As Is Value)',
  'the vendor catalog names the form, and beats the rule label');
ok(orderService.formNameFor('99999', CATALOG, RULES) === '1025 - Multi-Family (2-4 unit)',
  'a form not in the catalog still gets the name the owner set on the rule');
ok(orderService.formNameFor('12345', CATALOG, RULES) === null,
  'a form we have no name for returns null — never an invented name');
ok(orderService.formNameFor(null, CATALOG, RULES) === null, 'no product code, no name');
ok(orderService.formNameFor('56634', null, null) === null, 'no catalog and no rules is not a crash');
// The whole point of the report: a code alone is not an answer.
ok(orderService.formNameFor(56634, CATALOG, RULES) === CATALOG[0].name,
  'a numeric product code matches the catalog’s string id');
// Tolerant reading of a vendor lookup whose field names differ from {id,name}.
ok(orderService.formNameFor('7', [{ jobTypeId: '7', jobTypeName: 'Desktop 1004' }], []) === 'Desktop 1004',
  'a lookup row spelled jobTypeId/jobTypeName is still read');

// ---------------------------------------------------------------------------
// 2. The four role contacts
// ---------------------------------------------------------------------------
const CONTACTS = {
  borrower: personFrom('Borrower', { firstName: 'Yakov', lastName: 'Weiss', email: 'y@x.com', mobile: '555-1' }),
  coBorrower: personFrom('Coborrower', { fullName: 'Sara Weiss', email: 's@x.com' }),
  propertyContact: personFrom('PropertyAccess', { fullName: 'Dana Realtor', company: 'Acme Realty', workPhone: '555-9' }),
  loanOfficer: personFrom('LoanOfficer', { fullName: 'Moshe Officer', email: 'lo@yscap.com', workPhone: '555-7' }),
};
const CTX = {
  loanNumber: 'YSCAP258134709', loanPurpose: 'Purchase', loanAmount: 2403236,
  property: { category: 'SFR', addressLine: '957 Willow Grove Rd', city: 'Westfield', state: 'NJ', postalCode: '07090' },
  borrowers: [{ classification: 'Primary', firstName: 'Yakov', lastName: 'Weiss', email: 'y@x.com', cellPhone: '555-1' }],
  contacts: CONTACTS,
  parties: {},
};

const spec = ob.buildOrderSpec(CTX, { productCode: '56634' });
const byRole = (r) => (spec.contacts || []).find((c) => c.role === r);

ok(spec.contacts.length === 4, 'all four roles are on the order');
ok(byRole('Borrower').name === 'Yakov Weiss' && byRole('Borrower').email === 'y@x.com', 'borrower contact');
ok(byRole('Coborrower').name === 'Sara Weiss', 'co-borrower contact');
ok(byRole('PropertyAccess').company === 'Acme Realty' && byRole('PropertyAccess').phone === '555-9',
  'the property-access contact carries their company and number');
ok(byRole('LoanOfficer').email === 'lo@yscap.com', 'our loan officer is on the order');
ok(byRole('Borrower').sentAs === 'borrower' && byRole('PropertyAccess').sentAs === 'party'
  && byRole('LoanOfficer').sentAs === 'notification',
  'each role records HOW it reaches the appraisal company');

// A role with nobody in it is simply absent — never an empty shell claiming
// somebody is reachable.
const bare = ob.buildOrderSpec({ ...CTX, contacts: { borrower: CONTACTS.borrower } }, { productCode: '1' });
ok(bare.contacts.length === 1 && bare.contacts[0].role === 'Borrower', 'missing roles are absent, not blank');
ok(personFrom('PropertyAccess', { email: null, fullName: null }) === null,
  'a person with no name and no way to reach them is not a contact');
ok(personFrom('Borrower', null) === null, 'no source, no person');

// Our loan officer is NOTIFIED, because their LoanOfficer slot is the note buyer's.
ok(spec.notifyEmails.includes('lo@yscap.com'), 'the loan officer is copied on the order');
const dupe = ob.buildOrderSpec(CTX, { productCode: '1' }, { notifyEmails: ['LO@YSCAP.com'] });
ok(dupe.notifyEmails.length === 1, 'an officer somebody already typed in is not notified twice');

// Best-person-to-contact follows who can actually open the door.
ok(spec.parties.bestContact === 'Agent', 'with a property-access contact the appraiser calls them');
ok(bare.parties.bestContact === 'Borrower', 'with nobody else it is the borrower — the long-standing default');
ok(ob.buildOrderSpec(CTX, { productCode: '1' }, { bestContact: 'Owner' }).parties.bestContact === 'Owner',
  'a staff override still wins');

// ---------------------------------------------------------------------------
// 3. The wire message — and the one rule that must never be relaxed
// ---------------------------------------------------------------------------
const built = cdg.buildCreateAppraisal(spec, { apiKey: 'k', subdomain: 'nan', lenderIdentifier: 'GG1', sourceClientId: '9' });
const parties = built.message.deals[0].parties || [];
const roleTypes = parties.map((p) => p.partyRoleType);

ok(roleTypes.includes('PropertyAccess'), 'the property-access contact is sent as a named party');
const pa = parties.find((p) => p.partyRoleType === 'PropertyAccess');
ok(pa.fullName === 'Dana Realtor' && pa.legalEntityName === 'Acme Realty', 'their name and company travel');
ok(pa.contacts.some((c) => c.contactPhone === '555-9'), 'their phone number travels');

// THE HARD ONE. Their "LoanOfficer" slot carries the NOTE BUYER on this tenant
// (db/481 / src/amc/party-map.js). Sending our employee there routes the appraisal —
// and its invoice — to the wrong capital partner.
ok(!parties.some((p) => p.partyRoleType === 'LoanOfficer'),
  'OUR loan officer is NEVER sent as their loan officer');
ok(!parties.some((p) => p.partyRoleType === 'Borrower' || p.partyRoleType === 'Coborrower'),
  'the borrower and co-borrower are not duplicated as parties — they ride borrowers[]');
ok(built.message.deals[0].borrowers[0].contacts.some((c) => c.contactEmail === 'y@x.com'),
  'the borrower’s own email still rides the borrower record');

// A party map that DOES resolve still fills the slot — the guard above is about our
// employee, not about the slot being unusable.
const routed = cdg.buildCreateAppraisal(
  ob.buildOrderSpec({ ...CTX, parties: { loanOfficerAmcId: '201564' } }, { productCode: '1' }),
  { apiKey: 'k', subdomain: 'nan' });
ok((routed.message.deals[0].parties || []).some(
  (p) => p.partyRoleType === 'LoanOfficer' && p.partyRoleTypeIdentifier === '201564'),
  'the note buyer’s confirmed id still fills their LoanOfficer slot');

// namedParties drops what it cannot describe.
ok(cdg._internals.namedParties([{ role: 'PropertyAccess' }]).length === 0,
  'a property-access row with no name and no number is not sent');
ok(cdg._internals.namedParties(null).length === 0, 'no contacts, no parties');

// ---------------------------------------------------------------------------
// 4. What the order screen says
// ---------------------------------------------------------------------------
ok(ob.contactNotes(bare).some((n) => /property-access/i.test(n)),
  'with no property-access contact the screen says the appraiser will call the borrower');
ok(ob.contactNotes(bare).some((n) => /loan-officer/i.test(n)),
  'with no officer email the screen says nobody here will be copied');
ok(ob.contactNotes(spec).length === 0, 'a fully contacted order has nothing to warn about');

// ---------------------------------------------------------------------------
// 5. Somebody has to let the appraiser in
// ---------------------------------------------------------------------------
const noReach = ob.buildOrderSpec({
  ...CTX,
  borrowers: [{ classification: 'Primary', firstName: 'Yakov', lastName: 'Weiss' }],
  contacts: {},
}, { productCode: '56634' });
ok(ob.missingRequired(noReach).some((m) => /email or phone/i.test(m)),
  'an order with nobody to call is refused');
ok(!ob.missingRequired(spec).some((m) => /email or phone/i.test(m)),
  'the borrower’s own email satisfies it');
const accessOnly = ob.buildOrderSpec({
  ...CTX,
  borrowers: [{ classification: 'Primary', firstName: 'Yakov', lastName: 'Weiss' }],
  contacts: { propertyContact: CONTACTS.propertyContact },
}, { productCode: '56634' });
ok(!ob.missingRequired(accessOnly).some((m) => /email or phone/i.test(m)),
  'a realtor with the lockbox answers the question just as well');

// ---------------------------------------------------------------------------
// 6. REACHABLE, NOT MERELY PRESENT — the pre-merge audit's findings
// ---------------------------------------------------------------------------
const { reachable, usableEmail } = require('../src/lib/appraisal-contacts');

// (a) A MANUFACTURED ADDRESS IS NOT A CONTACT DETAIL. The ClickUp sync writes
// `noemail+<taskId>@clickup.local` for a borrower with NO email, and sending that to
// the appraisal company reads as a real address to everyone downstream.
ok(usableEmail('noemail+abc123@clickup.local') === null, 'the ClickUp placeholder address is not usable');
ok(usableEmail('NoEmail+X@ClickUp.Local') === null, '…in any casing');
ok(usableEmail('  y@x.com ') === 'y@x.com', 'a real address is, trimmed');
ok(reachable({ email: 'noemail+1@clickup.local' }) === false, 'a borrower with only that address is not reachable');
ok(reachable({ email: 'noemail+1@clickup.local', mobile: '555-1' }) === true, '…but a phone number still reaches them');
ok(reachable(null) === false && reachable({}) === false, 'nobody is not reachable');

const placeholderCtx = {
  ...CTX,
  borrowers: [{ classification: 'Primary', firstName: 'Y', lastName: 'W', email: 'noemail+t1@clickup.local' }],
  contacts: { borrower: personFrom('Borrower', { firstName: 'Y', lastName: 'W', email: 'noemail+t1@clickup.local' }),
    loanOfficer: personFrom('LoanOfficer', { fullName: 'LO', email: 'noemail+lo@clickup.local' }) },
};
const ph = ob.buildOrderSpec(placeholderCtx, { productCode: '1' });
ok(!JSON.stringify(ph).includes('clickup.local'), 'the placeholder never reaches the order at all');
ok(ob.missingRequired(ph).some((m) => /email or phone/i.test(m)),
   'and the order is refused, because there really is nobody to call');

// (b) A COMPANY IS NOT A PERSON. "Keystone Realty" was being split into a first name
// "Keystone" and a surname "Realty" — a person who does not exist.
const co = personFrom('PropertyAccess', { company: 'Keystone Realty', workPhone: '555-9' });
ok(co && co.firstName === null && co.lastName === null, 'a company is never split into a fake first and last name');
// NOTE the field is `workPhone`, not `phone` — an earlier cut asserted `co.phone ===
// undefined`, which is unconditionally true (personFrom never emits that key) and so
// pinned nothing. A test that cannot fail is worse than no test.
ok(co.company === 'Keystone Realty' && co.workPhone === '555-9',
   'the company travels as the company, with its number');

// (c) THE THREE ANSWERS MUST AGREE. A property contact with a company name and no way
// to reach them used to set bestContact to 'Agent' while the screen said nobody was on
// file — the appraiser was told to call an agent and given no number for one.
const unreachableAccess = {
  ...CTX,
  contacts: { borrower: CONTACTS.borrower, propertyContact: personFrom('PropertyAccess', { company: 'Keystone Realty' }) },
};
const ua = ob.buildOrderSpec(unreachableAccess, { productCode: '1' });
ok(ua.parties.bestContact === 'Borrower',
   'an unreachable property contact does NOT become the best person to contact');
ok(ob.contactNotes(ua).some((n) => /property-access/i.test(n)),
   'and the screen still says the appraiser will call the borrower — the two agree');
const uaWire = cdg.buildCreateAppraisal(ua, { apiKey: 'k', subdomain: 'nan' });
ok(!(uaWire.message.deals[0].parties || []).some((p) => p.partyRoleTypeIdentifier === 'Agent'),
   'and the wire never says "call the agent"');
// A reachable one still does all three.
ok(spec.parties.bestContact === 'Agent' && ob.contactNotes(spec).length === 0,
   'a reachable property contact still becomes the best contact, with nothing to warn about');

// ---------------------------------------------------------------------------
// 7. Name splitting goes through the repo's ONE splitter
// ---------------------------------------------------------------------------
ok(splitName('Dana Realtor').firstName === 'Dana' && splitName('Dana Realtor').lastName === 'Realtor',
  'two words split in half');
ok(splitName('John Michael Smith Jr').lastName === 'Smith', 'a middle name and a suffix are handled');
ok(splitName('').firstName === null, 'a blank name splits to nothing');

// ---------------------------------------------------------------------------
// 8. THE SCREEN MUST NOT UNDO THE SERVER'S CARE
// ---------------------------------------------------------------------------
// `preview.formName` names the form that would ACTUALLY be ordered; `chosenForm
// .formName` names the AUTO-PICKED one, and on a staff override those are two
// different forms. The panel used to fall back from the first to the second, which
// printed the auto-picked form's NAME above the overridden form's NUMBER — the exact
// "confidently describes the wrong report" failure, moved from the wire to the screen.
// A source check, because this is a rule about which value a component may read.
{
  const fs = require('fs');
  const panel = fs.readFileSync(require('path').join(__dirname, '..', 'app-v2/src/components/AmcAppraisalPanel.jsx'), 'utf8');
  ok(!/preview\.formName\s*\|\|\s*form\.formName/.test(panel),
     'the order screen never falls back from the ordered form’s name to the auto-picked one');
  ok(/formLabel\(formName, code\)/.test(panel),
     'and it renders the pair through formLabel, which shows "Form #<code>" when there is no name');
}

// ---------------------------------------------------------------------------
// 9. BOTH APPRAISAL DESKS ANSWER THE SAME QUESTION THE SAME WAY
// ---------------------------------------------------------------------------
// The placeholder rule was written into the SHARED module for both vendors and then
// wired into one of them. The Class desk kept sending `noemail+…@clickup.local` as
// the borrower's contact — and it satisfied Class's own borrower-contact gate, so an
// order was placeable whose only way to reach the borrower goes nowhere.
{
  const classBuild = require('../src/class/order-build');
  const ctx = {
    referenceNumber: 'YSCAP1', productId: 42,
    property: { addressLine: '1 A St', city: 'Town', state: 'NJ', postalCode: '07090', category: 'sfr', occupancy: 'investment' },
    loan: { loanNumber: 'YSCAP1' },
    borrower: { firstName: 'Yakov', lastName: 'Weiss', email: 'noemail+t9@clickup.local' },
    lender: { clientName: 'YS Capital Group' },
  };
  const out = classBuild.buildOrder(ctx);
  ok(!JSON.stringify(out.body).includes('clickup.local'),
     'the Class order never carries the manufactured address either');
  ok(out.missing.some((m) => m.field === 'contacts.reachable'),
     'and Class refuses the order for the same reason the AMC does — a name is not a way to reach somebody');
  // AND OUR LOAN OFFICER DOES NOT SATISFY IT. The first cut asked "does ANY contact
  // carry a method", and the officer's email and phone come off `staff_users` for
  // every file with one assigned — so the rule fired on essentially no real file while
  // the AMC desk refused the identical one. The appraiser calls the borrower or the
  // person with the keys, never us.
  const withOfficer = classBuild.buildOrder({ ...ctx,
    loanOfficer: { firstName: 'Moshe', lastName: 'Officer', email: 'lo@yscap.com', workPhone: '555-7' } });
  ok(withOfficer.missing.some((m) => m.field === 'contacts.reachable'),
     'an assigned loan officer does NOT make the borrower reachable');
  // …while anyone who can actually open the door does.
  const withRealtor = classBuild.buildOrder({ ...ctx,
    propertyContact: { company: 'Keystone Realty', workPhone: '570-555-0101' } });
  ok(!withRealtor.missing.some((m) => m.field === 'contacts.reachable'),
     'a realtor with a phone number does — the same answer the AMC gives');
  const pa = (withRealtor.body.contacts || []).find((c) => (c.Type || c.type) === 'PropertyAccess');
  ok(pa && pa.lastName === 'Keystone Realty',
     'and a company-only contact reaches Class by NAME, not as a nameless phone number');
  const withCo = classBuild.buildOrder({ ...ctx, coBorrower: { firstName: 'Sara', lastName: 'Weiss', mobile: '555-2' } });
  ok(!withCo.missing.some((m) => m.field === 'contacts.reachable'), 'so does a co-borrower with a phone');

  // A real address still travels, on both desks.
  const real = classBuild.buildOrder({ ...ctx, borrower: { ...ctx.borrower, email: 'y@x.com' } });
  ok(JSON.stringify(real.body).includes('y@x.com'), 'a real address still reaches Class');
  ok(!real.missing.some((m) => /^contacts\./.test(m.field)), 'and that order is not refused');
}

console.log(`\n[test-amc-contacts-and-form-name-pure] ${pass} passed, ${fail} failed`);
assert.strictEqual(fail, 0, 'AMC contacts / form-name assertions failed');
