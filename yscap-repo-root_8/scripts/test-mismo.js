/**
 * MISMO 3.4 engine tests — pure functions, NO database required.
 *  1) round-trip: a fully-populated loan file -> XML -> parsed back == same data
 *  2) XML writer omits empty leaves and escapes special characters
 *  3) importer tolerates a "foreign" file (different order, unknown containers)
 *  4) enum crosswalk maps both directions
 * Run: node scripts/test-mismo.js
 */
const assert = require('assert');
const { buildMismoXml } = require('../src/lib/mismo/build');
const { parseMismoXml } = require('../src/lib/mismo/parse');
const X = require('../src/lib/mismo/xml');
const E = require('../src/lib/mismo/enums');

let passed = 0;
const ok = (label) => { console.log('  ✓ ' + label); passed++; };

// ---------------------------------------------------------------- 1) round-trip
const file = {
  loanNumber: 'YS-10042',
  investorLoanNumber: 'INV-777',
  program: 'Fix & Flip',
  loanType: 'Refi Cash-Out',
  occupancy: 'Investment',
  loanAmount: 375000,
  rate: 10.75,
  term: '12 months',
  purchasePrice: 420000,
  asIsValue: 400000,
  arv: 560000,
  rehabBudget: 85000,
  rehabType: 'Heavy',
  dscr: 1.15,
  ltv: 0.75,
  ppp: '3-2-1',
  propertyType: 'Multi 2-4',
  units: 3,
  lender: 'YS Capital',
  channel: 'Wholesale',
  property: { line1: '392 Columbia Ave', line2: 'Unit 2', city: 'Brooklyn', state: 'NY', zip: '11223' },
  borrower: {
    firstName: 'Yuda', middleName: 'A', lastName: "O'Brien", suffix: 'Jr',
    email: 'yuda@example.com', phone: '(718) 555-1212', ssn: '123-45-6789',
    dob: '1985-06-14', citizenship: 'US Citizen', maritalStatus: 'Married', dependents: 2,
    currentAddress: { line1: '10 Main St', city: 'Lakewood', state: 'NJ', zip: '08701' },
    yearsAtResidence: 3, employer: 'Acme Holdings LLC', employmentType: 'Self employed', fico: 742,
  },
  coBorrower: {
    firstName: 'Sara', lastName: "O'Brien", email: 'sara@example.com',
    citizenship: 'Permanent Resident', maritalStatus: 'Married',
  },
  llc: { name: 'Columbia Ave Holdings LLC', ein: '98-7654321', formationState: 'NY' },
  extras: { sqftPre: 1800, sqftPost: 2400, expFlips: 5, expHolds: 2, expGround: 0 },
  generatedAt: '2026-07-19T12:00:00.000Z',
};

const xml = buildMismoXml(file);
assert(xml.startsWith('<?xml'), 'has XML declaration');
assert(xml.includes('MISMOReferenceModelIdentifier="3.4.0"'), 'has reference model id');
assert(xml.includes('xmlns="http://www.mismo.org/residential/2009/schemas"'), 'has MISMO namespace');
ok('builds a well-formed MISMO 3.4 document');

// The writer must not have emitted the SSN in dashed form nor any empty element.
assert(xml.includes('<TaxpayerIdentifierValue>123456789</TaxpayerIdentifierValue>'), 'SSN digits only');
assert(!/<\w+><\/\w+>/.test(xml), 'no empty element pairs');
assert(!xml.includes('SuffixName></'), 'no blank suffix leaked');
// XML escaping of the apostrophe in the last name.
assert(xml.includes("O&apos;Brien") || xml.includes("O'Brien"), 'last name present');
ok('omits empty data points and encodes values');

const parsed = parseMismoXml(xml);
assert.strictEqual(parsed.loan.loanNumber, 'YS-10042', 'loan number round-trips');
assert.strictEqual(parsed.loan.investorLoanNumber, 'INV-777', 'investor number round-trips');
assert.strictEqual(parsed.loan.loanAmount, 375000, 'loan amount round-trips');
assert.strictEqual(parsed.loan.rate, 10.75, 'rate round-trips');
assert.strictEqual(parsed.loan.loanType, 'Refi Cash-Out', 'cash-out loan type restored via detail');
assert.strictEqual(parsed.loan.term, '12 months', 'term round-trips');
assert.strictEqual(parsed.loan.occupancy, 'Investment', 'occupancy round-trips');
ok('loan fields round-trip');

assert.strictEqual(parsed.property.address.line1, '392 Columbia Ave', 'property street');
assert.strictEqual(parsed.property.address.city, 'Brooklyn', 'property city');
assert.strictEqual(parsed.property.address.zip, '11223', 'property zip');
assert.strictEqual(parsed.property.units, 3, 'units');
assert.strictEqual(parsed.property.purchasePrice, 420000, 'purchase price');
assert.strictEqual(parsed.property.asIsValue, 400000, 'as-is value');
ok('property fields round-trip');

assert.strictEqual(parsed.borrower.firstName, 'Yuda', 'borrower first');
assert.strictEqual(parsed.borrower.lastName, "O'Brien", 'borrower last (unescaped)');
assert.strictEqual(parsed.borrower.suffix, 'Jr', 'borrower suffix');
assert.strictEqual(parsed.borrower.email, 'yuda@example.com', 'borrower email');
assert.strictEqual(parsed.borrower.ssn, '123456789', 'borrower ssn digits');
assert.strictEqual(parsed.borrower.dob, '1985-06-14', 'borrower dob');
assert.strictEqual(parsed.borrower.citizenship, 'US Citizen', 'borrower citizenship');
assert.strictEqual(parsed.borrower.maritalStatus, 'Married', 'borrower marital');
assert.strictEqual(parsed.borrower.dependents, 2, 'dependents');
assert.strictEqual(parsed.borrower.currentAddress.city, 'Lakewood', 'current residence city');
assert.strictEqual(parsed.borrower.yearsAtResidence, 3, 'years at residence');
assert.strictEqual(parsed.borrower.employer, 'Acme Holdings LLC', 'employer');
ok('borrower fields round-trip');

assert(parsed.coBorrower, 'co-borrower present');
assert.strictEqual(parsed.coBorrower.firstName, 'Sara', 'co-borrower first');
assert.strictEqual(parsed.coBorrower.citizenship, 'Permanent Resident', 'co-borrower citizenship');
ok('co-borrower fields round-trip');

assert(parsed.llc, 'llc present');
assert.strictEqual(parsed.llc.name, 'Columbia Ave Holdings LLC', 'llc name');
assert.strictEqual(parsed.llc.ein, '987654321', 'llc ein digits');
ok('vesting entity round-trips');

assert.strictEqual(parsed.extras.arv, 560000, 'ARV from extension');
assert.strictEqual(parsed.extras.rehabBudget, 85000, 'rehab budget from extension');
assert.strictEqual(parsed.extras.program, 'Fix & Flip', 'program from extension');
assert.strictEqual(parsed.extras.expFlips, 5, 'experience flips from extension');
assert.strictEqual(parsed.extras.fico, 742, 'fico from extension');
ok('RTL extras round-trip via lender extension');

// ---------------------------------------------------- 2) minimal / empty file
const tiny = buildMismoXml({ borrower: { firstName: 'A', lastName: 'B' }, property: {}, generatedAt: '2026-01-01T00:00:00Z' });
const tp = parseMismoXml(tiny);
assert.strictEqual(tp.borrower.firstName, 'A', 'minimal borrower parses');
assert.strictEqual(tp.borrower.email, null, 'missing email is null, not crash');
ok('minimal file builds and parses without error');

// ---------------------------------------------------- 3) foreign-file tolerance
// Different container order, an unknown container, a prefixed default namespace,
// and no extension block — a stand-in for another vendor's MISMO 3.4 output.
const foreign = `<?xml version="1.0"?>
<MESSAGE xmlns="http://www.mismo.org/residential/2009/schemas" xmlns:xlink="http://www.w3.org/1999/xlink">
  <DEAL_SETS><DEAL_SET><DEALS><DEAL>
    <UNKNOWN_FUTURE_CONTAINER><Foo>bar</Foo></UNKNOWN_FUTURE_CONTAINER>
    <PARTIES>
      <PARTY xlink:label="P1">
        <INDIVIDUAL><NAME><FirstName>Dana</FirstName><LastName>Stone</LastName></NAME>
          <CONTACT_POINTS><CONTACT_POINT><CONTACT_POINT_EMAIL><ContactPointEmailValue>dana@x.com</ContactPointEmailValue></CONTACT_POINT_EMAIL></CONTACT_POINT></CONTACT_POINTS>
        </INDIVIDUAL>
        <ROLES><ROLE><ROLE_DETAIL><PartyRoleType>Borrower</PartyRoleType></ROLE_DETAIL></ROLE></ROLES>
        <TAXPAYER_IDENTIFIERS><TAXPAYER_IDENTIFIER><TaxpayerIdentifierType>SocialSecurityNumber</TaxpayerIdentifierType><TaxpayerIdentifierValue>555-00-1234</TaxpayerIdentifierValue></TAXPAYER_IDENTIFIER></TAXPAYER_IDENTIFIERS>
      </PARTY>
    </PARTIES>
    <LOANS><LOAN LoanRoleType="SubjectLoan"><TERMS_OF_LOAN><BaseLoanAmount>250000</BaseLoanAmount><LoanPurposeType>Purchase</LoanPurposeType><NoteRatePercent>9.5</NoteRatePercent></TERMS_OF_LOAN></LOAN></LOANS>
    <COLLATERALS><COLLATERAL><SUBJECT_PROPERTY><ADDRESS><AddressLineText>1 Foreign Way</AddressLineText><CityName>Austin</CityName><StateCode>TX</StateCode><PostalCode>78701</PostalCode></ADDRESS></SUBJECT_PROPERTY></COLLATERAL></COLLATERALS>
  </DEAL></DEALS></DEAL_SET></DEAL_SETS>
</MESSAGE>`;
const fp = parseMismoXml(foreign);
assert.strictEqual(fp.borrower.firstName, 'Dana', 'foreign borrower name');
assert.strictEqual(fp.borrower.email, 'dana@x.com', 'foreign borrower email');
assert.strictEqual(fp.borrower.ssn, '555001234', 'foreign borrower ssn digits');
assert.strictEqual(fp.loan.loanAmount, 250000, 'foreign loan amount');
assert.strictEqual(fp.loan.loanType, 'Purchase', 'foreign loan purpose');
assert.strictEqual(fp.property.address.city, 'Austin', 'foreign property city');
ok('parses a foreign-shaped MISMO file (different order + unknown container)');

// ---------------------------------------------------- 4) enum crosswalk
assert.strictEqual(E.toMismoOccupancy('Primary'), 'PrimaryResidence', 'occupancy forward');
assert.strictEqual(E.fromMismoOccupancy('PrimaryResidence'), 'Primary', 'occupancy reverse');
assert.strictEqual(E.toMismoCitizenship('Foreign National'), 'NonPermanentResidentAlien', 'citizenship forward');
assert.strictEqual(E.fromMismoCitizenship('NonPermanentResidentAlien'), 'Foreign National', 'citizenship reverse');
assert.strictEqual(E.toMismoMarital('Divorced'), 'Unmarried', 'marital bucket forward');
assert.strictEqual(E.fromMismoLoanPurpose('Refinance', 'CashOut'), 'Refi Cash-Out', 'loan purpose reverse w/ cashout');
assert.strictEqual(E.fromMismoLoanPurpose('Construction'), 'Ground up', 'construction reverse');
ok('enum crosswalk maps both directions');

// XML parser hostile-input sanity: malformed XML must throw a clean error.
let threw = false;
try { parseMismoXml('<MESSAGE><DEAL_SETS></MESSAGE>'); } catch (e) { threw = true; }
assert(threw, 'malformed XML throws');
ok('malformed XML is rejected cleanly');

console.log(`\nAll MISMO engine checks passed (${passed} groups).`);
