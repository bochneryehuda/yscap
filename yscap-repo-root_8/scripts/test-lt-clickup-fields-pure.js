'use strict';
/**
 * LONG-TERM → CLICKUP — the six card boxes that stayed blank (owner-reported
 * 2026-09-03 on a live Long-Term card): "Primary Housing ($)", "Citizenship",
 * "Number of Dependents", "Age of Dependents", "Desired Title Company" /
 * "Title Company Contact", "Insurance Company Name" / "Insurance Company
 * Contact Info".
 *
 * THE OWNER'S RULE FOR THE HOUSING PAYMENT, verbatim: *"if he is renting, it
 * should be filled with the amount of the rent that is listed … If he owns you
 * can look which mortgage is tied to his primary residence. If you can find it.
 * If not you can skip this field if he owns."* Every branch of that sentence is
 * a case below, INCLUDING the skip — and the two ways a guess could sneak in
 * (two candidate homes; a mortgage on a different property) are asserted to
 * answer nothing.
 *
 * PURE: the mapper reads only the bag the push assembles. No database, no
 * network. Each case reaches the REAL field row through FIELD_MAP rather than
 * re-typing its logic, so the test fails the moment a row's source changes.
 *
 * Proven to fail (mutations, each run once against this file before it was
 * trusted): (1) `housingPayment` returning FR0116 for a renter with no listed
 * rent and a mirror rent — the mirror branch went red; (2) `homes.length !== 1`
 * loosened to `>= 1` — the two-homes case went red; (3) `isMortgageLiability`
 * dropped — the car-loan case went red; (4) 'URLA.X1' removed from
 * EX_FIELD_IDS — the source guard went red; (5) `dependentsCountText` refusing
 * 0 — the "stated zero" case went red.
 */

const assert = require('assert');
const mapper = require('../src/longterm/clickup/mapper');

const I = mapper._internals;
let checks = 0;
const ok = (c, w) => { assert.ok(c, w); console.log('  ok  ', w); checks++; };
const eq = (a, b, w) => { assert.strictEqual(a, b, w); console.log('  ok  ', w); checks++; };
const row = (key) => {
  const r = mapper.FIELD_MAP.find((f) => f.key === key);
  assert.ok(r, `FIELD_MAP carries a '${key}' row`);
  return r;
};
const val = (key, bag) => row(key).src(bag);

// ── A. the housing basis, from Encompass or the mirror ────────────────────
console.log('\nA. rent / own / rent free — Encompass first, the mirror when Encompass is off');
eq(I.housingBasis('Rent', null), 'rent', 'FR0115 Rent → rent');
eq(I.housingBasis('Own', 'rent'), 'own', 'FR0115 Own wins over a stale mirror basis');
eq(I.housingBasis('LiveRentFree', null), 'rent_free', 'LiveRentFree → rent free');
eq(I.housingBasis('', 'rent'), 'rent', 'Encompass silent → the mirror basis answers');
eq(I.housingBasis('', 'no_primary_housing_expense'), 'rent_free', "the mirror's no-expense basis is rent free");
eq(I.housingBasis('', ''), null, 'nothing known → null, never a guess');
eq(I.housingBasis('Something Else', null), null, 'an unmeasured word is never guessed');

// ── B. the payment ────────────────────────────────────────────────────────
console.log('\nB. Primary Housing ($) — the owner\'s sentence, branch by branch');
const home = { id: 'reo-home', street: '12 Main St', zip: '10001', occupancy_type: 'PrimaryResidence',
  monthly_mortgage_payment: '1750.00' };
const rental = { id: 'reo-rental', street: '99 Other Ave', zip: '10002', occupancy_type: 'Investment',
  monthly_mortgage_payment: '2200.00' };
const mortgageOnHome = { reo_property_id: 'reo-home', liability_type: 'MortgageLoan', monthly_payment: '1,500.00', to_be_paid_off: false };
const helocOnHome = { reo_property_id: 'reo-home', liability_type: 'HELOC', monthly_payment: '300', to_be_paid_off: false };
const paidOffOnHome = { reo_property_id: 'reo-home', liability_type: 'MortgageLoan', monthly_payment: '900', to_be_paid_off: true };
const carLoanOnHome = { reo_property_id: 'reo-home', liability_type: 'Installment', monthly_payment: '450', to_be_paid_off: false };
const mortgageOnRental = { reo_property_id: 'reo-rental', liability_type: 'MortgageLoan', monthly_payment: '2,200.00', to_be_paid_off: false };

eq(val('primary_housing_payment', { ex: { FR0115: 'Rent', FR0116: '1,900.00' } }), 1900,
  'RENTING: the rent Encompass lists (FR0116) is written');
eq(val('primary_housing_payment', { ex: { FR0115: 'Rent', FR0116: '' }, residence: { residency_basis: 'rent', monthly_rent: '2100.00' } }), 2100,
  'RENTING, Encompass silent on the amount: the mirror\'s rent answers');
eq(val('primary_housing_payment', { ex: {}, residence: { residency_basis: 'rent', monthly_rent: '2100.00' } }), 2100,
  'RENTING with Encompass OFF: basis and rent both from the mirror');
eq(val('primary_housing_payment', { ex: { FR0115: 'Rent', FR0116: '' }, residence: { residency_basis: 'rent', monthly_rent: null } }), null,
  'RENTING with no rent listed anywhere → nothing written (never 0)');
eq(val('primary_housing_payment', { ex: { FR0115: 'Own', FR0116: '2,400' } }), 2400,
  'OWNING with a payment Encompass lists on the address → that payment');
eq(val('primary_housing_payment', {
  ex: { FR0115: 'Own', FR0116: '' }, residence: { street: '12 Main St', zip: '10001' },
  reos: [home, rental], liabilities: [mortgageOnHome, helocOnHome, paidOffOnHome, carLoanOnHome, mortgageOnRental],
}), 1800, 'OWNING: the mortgage + HELOC tied to the PRIMARY home (1,500 + 300) — not the paid-off one, not the car loan, not the rental\'s mortgage');
eq(val('primary_housing_payment', {
  ex: { FR0115: 'Own' }, reos: [home, rental], liabilities: [mortgageOnRental],
}), 1750, 'OWNING with no liability linked to the home → the home REO\'s own mortgage payment');
eq(val('primary_housing_payment', {
  ex: { FR0115: 'Own' }, residence: { street: '12 MAIN ST.', zip: '10001-1234' },
  reos: [{ ...home, occupancy_type: null }, rental], liabilities: [mortgageOnHome],
}), 1500, 'OWNING, REO occupancy blank: the home is found by the present address\'s street + zip');
eq(val('primary_housing_payment', {
  ex: { FR0115: 'Own' }, reos: [home, { ...home, id: 'reo-home-2' }], liabilities: [mortgageOnHome],
}), null, 'OWNING with TWO candidate homes → SKIPPED (a guess either way)');
eq(val('primary_housing_payment', { ex: { FR0115: 'Own' }, reos: [rental], liabilities: [mortgageOnRental] }), null,
  'OWNING with no primary-residence REO → SKIPPED, as the owner said ("if not you can skip")');
eq(val('primary_housing_payment', { ex: { FR0115: 'Own' }, reos: [{ ...home, monthly_mortgage_payment: null }], liabilities: [] }), null,
  'OWNING, home found, no payment anywhere → nothing (never 0)');
eq(val('primary_housing_payment', { ex: { FR0115: 'Own' } }), null,
  'OWNING with the REO/liability tables unread (undefined) → nothing, no crash');
eq(val('primary_housing_payment', { ex: { FR0115: 'LiveRentFree', FR0116: '900' } }), null,
  'RENT FREE writes nothing, whatever FR0116 says');
{
  const bag = { ex: { FR0115: 'Own' }, residence: { street: '12 Main St', zip: '10001' }, reos: [home], liabilities: [mortgageOnHome, helocOnHome] };
  const fields = mapper.buildTaskFields(bag, {});
  const f = fields.find((x) => x.key === 'primary_housing_payment');
  eq(f && f.value, '1800', 'through buildTaskFields the currency writes as "1800"');
  eq(f && f.id, mapper.CU.primaryHousingPayment, '…onto the currency "Primary Housing" field, not the dropdown');
}

// ── C. citizenship ────────────────────────────────────────────────────────
console.log('\nC. Citizenship — the live URLA.X1 vocabulary, spelled for the team');
eq(I.citizenshipLabel('USCitizen'), 'US Citizen', 'USCitizen → US Citizen');
eq(I.citizenshipLabel('US Citizen'), 'US Citizen', 'an already-spelled label passes');
eq(I.citizenshipLabel('PermanentResidentAlien'), 'Permanent Resident Alien', 'PermanentResidentAlien');
eq(I.citizenshipLabel('NonPermanentResidentAlien'), 'Non-Permanent Resident Alien', 'NonPermanentResidentAlien');
eq(I.citizenshipLabel('Martian'), null, 'an unmeasured word is never guessed');
eq(I.citizenshipLabel(''), null, 'blank → nothing');
eq(val('citizenship', { ex: { 'URLA.X1': 'USCitizen' }, borrower: { citizenship: 'PermanentResidentAlien' } }), 'US Citizen',
  'live Encompass wins over the mirror');
eq(val('citizenship', { ex: {}, borrower: { citizenship: 'USCitizen' } }), 'US Citizen',
  'Encompass off → the mirror\'s citizenship answers');
eq(val('citizenship', { ex: {}, borrower: null }), null, 'no borrower read → nothing');

// ── D. dependants ─────────────────────────────────────────────────────────
console.log('\nD. Number of Dependents / Age of Dependents');
eq(I.dependentsCountText('2', null), '2', 'field 53 "2" → "2"');
eq(I.dependentsCountText('0', 3), '0', 'a STATED zero is an answer and beats the mirror');
eq(I.dependentsCountText('', 3), '3', 'Encompass silent → the mirror count');
eq(I.dependentsCountText('abc', null), null, 'junk → nothing');
eq(I.dependentsCountText('-1', null), null, 'a negative count is not a count');
eq(I.dependentsCountText('2.5', null), null, 'half a dependant is not a count');
eq(I.dependentsCountText('', null), null, 'nothing known → nothing (never "0")');
eq(val('dependents', { ex: { 53: '2' }, borrower: { dependent_count: 1 } }), '2', 'the row reads 53 first');
eq(val('dependents_ages', { ex: { 54: '10/8' }, borrower: { dependents_ages: '9/7' } }), '10/8',
  'the ages line is written VERBATIM from field 54 ("10/8")');
eq(val('dependents_ages', { ex: {}, borrower: { dependents_ages: '9/7' } }), '9/7',
  'Encompass off → the mirror\'s ages line (db/690)');
eq(val('dependents_ages', { ex: { 54: '' }, borrower: {} }), null, 'no ages anywhere → nothing');

// ── E. the vendor contacts ───────────────────────────────────────────────
console.log('\nE. title & insurance — Encompass File Contacts first, the file\'s own contacts desk after');
const titleCard = { company_name: 'Acme Title Agency', contact_name: 'Pat Closer', email: 'pat@acmetitle.example', phone: '212-555-0100' };
const hazardCard = { company_name: 'Shield Insurance', contact_name: 'Sam Agent', emails: ['sam@shield.example'], phones: ['718-555-0199'] };
const desk = { vendors: { title: titleCard, hazard_insurance: hazardCard } };

eq(val('title_company', { ex: { 411: 'Stewart Title' }, ...desk }), 'Stewart Title', 'Desired Title Company: Encompass 411 first');
eq(val('title_company', { ex: {}, ...desk }), 'Acme Title Agency', '…the desk\'s title card when Encompass holds none');
eq(val('title_company', { ex: {}, vendors: {} }), null, 'no title card on the desk → nothing');
eq(val('title_company', { ex: {} }), null, 'desk unread (undefined) → nothing, no crash');
eq(val('title_contact', { ex: { 'CX.TITLECONTACT': 'Jo Smith jo@stewart.example 555' , 88: 'other@x.example' }, ...desk }), 'jo@stewart.example',
  'Title Company Contact: the email out of the CX contact box first');
eq(val('title_contact', { ex: { 'CX.TITLECONTACT': 'Jo Smith 555-0100', 88: 'other@stewart.example' }, ...desk }), 'other@stewart.example',
  '…a CX box with no email falls to File Contacts 88');
eq(val('title_contact', { ex: {}, ...desk }), 'pat@acmetitle.example', '…then the desk card\'s email');
eq(val('insurance_company', { ex: { L252: 'State Farm' }, ...desk }), 'State Farm', 'Insurance Company Name: the hazard fee\'s paid-to name (L252) first');
eq(val('insurance_company', { ex: {}, ...desk }), 'Shield Insurance', '…the desk\'s hazard card when Encompass holds none');
eq(val('insurance_contact', { ex: { 'CX.INSURANCECONTACT': 'Lee 555-0101' }, ...desk }), 'Lee 555-0101', 'Insurance Company Contact Info: the CX box first');
eq(val('insurance_contact', { ex: {}, ...desk }), 'Sam Agent · sam@shield.example · 718-555-0199',
  '…the desk card, as who · email · phone (array emails/phones read)');
eq(val('insurance_contact', { ex: {}, vendors: { hazard_insurance: { company_name: 'Shield' } } }), null,
  'a card with a company but no person, email or phone writes no contact info');

// ── F. the wiring — ids, live reads, and the one box that has no source ──
console.log('\nF. wiring');
for (const id of ['URLA.X1', '53', '54', '411', '88', 'L252']) {
  ok(mapper.EX_FIELD_IDS.includes(id), `live Encompass read asks for ${id}`);
}
const LIVE_CATALOG_2026_09_03 = {
  citizenship: '045f993c-4c7a-4a03-b71d-44e3ed15aa07',
  dependents: '19ce13e0-bdcd-43c3-b365-7b07f1f3824e',
  dependentsAges: '2618c971-841e-40db-b4c9-46b20bb8ce1d',
  titleCompany: '2c734172-ea63-40b4-b151-aca9cab05969',
  insuranceCompany: 'dc0b20e7-6b7b-462c-acaf-e9fecb8e84c9',
  primaryHousingPayment: '51a91012-5665-4f22-b0c6-3048ed862e3b',
};
for (const [k, id] of Object.entries(LIVE_CATALOG_2026_09_03)) {
  eq(mapper.CU[k], id, `CU.${k} is the id read off the live Loan Pipeline catalog (2026-09-03)`);
}
for (const key of ['citizenship', 'dependents', 'dependents_ages', 'title_company', 'title_contact', 'insurance_company', 'insurance_contact', 'primary_housing_payment']) {
  ok(mapper.FIELD_BY_KEY.has(key), `FIELD_MAP carries '${key}'`);
}
ok(!mapper.FIELD_MAP.some((f) => f.cu === '2d566b9c-e4bc-4be2-85df-1a82930e9cee'),
  '"1031 Agent Information" is NOT mapped — Encompass has no field to fill it from, so nothing is invented');
for (const key of ['citizenship', 'dependents', 'dependents_ages', 'title_company', 'insurance_company']) {
  eq(row(key).type, 'text', `'${key}' writes as text (the catalog says short_text / text)`);
}
{
  // The whole bag, end to end: every new box lands, none of the old ones move.
  const bag = {
    loan: {}, prop: {}, borrower: { citizenship: 'USCitizen', dependent_count: 2, dependents_ages: '10/8' },
    coborrower: null, residence: { residency_basis: 'rent', monthly_rent: '2,050' }, ex: {}, ...desk,
  };
  const by = Object.fromEntries(mapper.buildTaskFields(bag, {}).map((f) => [f.key, f.value]));
  eq(by.primary_housing_payment, '2050', 'end to end: the renter\'s mirror rent');
  eq(by.citizenship, 'US Citizen', 'end to end: citizenship');
  eq(by.dependents, '2', 'end to end: the count');
  eq(by.dependents_ages, '10/8', 'end to end: the ages');
  eq(by.title_company, 'Acme Title Agency', 'end to end: the title company');
  eq(by.title_contact, 'pat@acmetitle.example', 'end to end: the title email');
  eq(by.insurance_company, 'Shield Insurance', 'end to end: the insurer');
  eq(by.insurance_contact, 'Sam Agent · sam@shield.example · 718-555-0199', 'end to end: the insurer contact');
}

console.log(`\ntest-lt-clickup-fields-pure: ${checks} assertions passed — the six blank boxes are answered from Encompass, then the mirror, then the desk; an owner's mortgage is found only when it is tied to the home, and skipped otherwise.`);
