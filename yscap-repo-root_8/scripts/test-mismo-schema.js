/**
 * MISMO 3.4 XSD schema validation — validates a generated export against the
 * OFFICIAL MISMO v3.4.0 (Build 324) Reference Model schema using xmllint. This
 * is the definitive proof our file is structurally correct with correct data
 * types + enumerations, so any system in the industry can read it.
 *
 * The schema files are large (~10 MB) and are NOT committed to this repo. To run
 * this check, download the MISMO v3.4.0 B324 reference-model XSDs and point
 * MISMO_XSD_DIR at the folder containing MISMO_3.4.0_B324.xsd:
 *   MISMO_XSD_DIR=/path/to/ReferenceModel_v3.4.0_B324 node scripts/test-mismo-schema.js
 * Sources (free): Fannie Mae DU schema zip (Technology Integration page),
 * Freddie Mac LPA/ULAD schema, or mismo.org. If MISMO_XSD_DIR / xmllint are not
 * present the test SKIPS (exit 0) so it never blocks a machine without them.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { buildMismoXml } = require('../src/lib/mismo/build');

const xsdDir = process.env.MISMO_XSD_DIR;
const schema = xsdDir && path.join(xsdDir, 'MISMO_3.4.0_B324.xsd');

function haveXmllint() {
  try { execFileSync('xmllint', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

if (!schema || !fs.existsSync(schema)) {
  console.log('SKIP: set MISMO_XSD_DIR to the folder with MISMO_3.4.0_B324.xsd to run schema validation.');
  process.exit(0);
}
if (!haveXmllint()) {
  console.log('SKIP: xmllint not found on PATH.');
  process.exit(0);
}

// A fully-populated file that exercises every container/field the builder emits.
const file = {
  loanNumber: 'YS-10042', investorLoanNumber: 'INV-777', program: 'Fix & Flip',
  loanType: 'Refinance — Cash-Out', occupancy: 'Investment', loanAmount: 375000, rate: 10.75,
  term: '12 months', purchasePrice: 420000, asIsValue: 400000, arv: 560000, rehabBudget: 85000,
  rehabType: 'Heavy', dscr: 1.15, ltv: 0.75, ppp: '3-2-1', propertyType: 'Multi 2-4', units: 3,
  lender: 'YS Capital', channel: 'Wholesale', lienPriority: 'FirstLien',
  propertyTaxes: 6000, propertyInsurance: 2400, hoa: 0, rentalIncome: 3800,
  property: { line1: '392 Columbia Ave', line2: 'Unit 2', city: 'Brooklyn', state: 'NY', zip: '11223' },
  borrower: {
    firstName: 'Yuda', middleName: 'A', lastName: 'Elbaum', suffix: 'Jr', email: 'y@example.com',
    phone: '7185551212', ssn: '123456789', dob: '1985-06-14', citizenship: 'US Citizen',
    maritalStatus: 'Married', dependents: 2, currentAddress: { line1: '10 Main St', city: 'Lakewood', state: 'NJ', zip: '08701' },
    yearsAtResidence: 3, employer: 'Acme LLC', employmentType: 'Self employed', fico: 742,
  },
  coBorrower: { firstName: 'Sara', lastName: 'Elbaum', email: 's@example.com', citizenship: 'Permanent Resident', maritalStatus: 'Divorced' },
  llc: { name: 'Columbia Ave Holdings LLC', ein: '987654321', formationState: 'NY' },
  extras: { sqftPre: 1800, sqftPost: 2400, expFlips: 5, expHolds: 2, expGround: 0 },
  generatedAt: '2026-07-19T12:00:00.000Z',
};

const xml = buildMismoXml(file);
const tmp = path.join(os.tmpdir(), `mismo-schema-test-${process.pid}.xml`);
fs.writeFileSync(tmp, xml);
try {
  execFileSync('xmllint', ['--noout', '--nonet', '--schema', schema, tmp], { stdio: ['ignore', 'ignore', 'inherit'] });
  console.log('  ✓ generated MISMO 3.4 export VALIDATES against the official MISMO 3.4.0 B324 schema');
  console.log('\nMISMO schema validation passed.');
} catch (e) {
  console.error('\nSchema validation FAILED — the export does not conform to MISMO 3.4.0.');
  process.exit(1);
} finally {
  fs.unlinkSync(tmp);
}
