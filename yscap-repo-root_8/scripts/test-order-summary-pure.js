'use strict';
/**
 * Pure test for the "what was ordered" order summaries (NAN + Class) — the plain,
 * human list of what was sent to the vendor, built from the STORED sent body so the
 * desk can see what was in an order after it is placed. No DB, no network (the summary
 * functions read a plain object; the modules connect nothing at import).
 */
const amc = require('../src/amc/order-service');
const classBuild = require('../src/class/order-build');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };
const valOf = (rows, label) => (rows.find((r) => r.label === label) || {}).value;

// ---- NAN order summary (from the masked CDG envelope) ----
{
  const order = {
    form_description: 'Single-family Appraisal (1004)', product_code: '5',
    client_order_number: 'YSCAP-123', status: 'ordered',
    request_payload: { message: {
      products: [{ productCode: '5', notifications: [{ contactEmail: 'lo@x.com' }, { contactEmail: 'p@x.com' }] }],
      deals: [{
        loans: [{ loanIdentifiers: { lenderLoanIdentifier: 'YSCAP-123' }, loanPurposeType: 'Purchase', baseLoanAmount: '300000.00' }],
        properties: [{ titleCategoryType: 'Single Family', propertyCurrentOccupancyType: 'Tenant Occupied', salesContractAmount: '400000.00',
          address: { addressLine: '12 Oak St', cityName: 'Brooklyn', stateCode: 'NY', postalCode: '11249', countyName: 'Kings' } }],
        borrowers: [{ firstName: 'Peter', lastName: 'Parker' }, { firstName: 'Mary', lastName: 'Jane' }],
        parties: [{ partyRoleType: 'BestContact', fullName: 'Peter Parker', contacts: [{ contactPhone: '555-1', contactEmail: 'p@x.com' }] }],
      }],
    } },
  };
  const s = amc.orderSummary(order);
  ok(valOf(s, 'Form ordered') === 'Single-family Appraisal (1004)', 'NAN form ordered');
  ok(valOf(s, 'Loan number') === 'YSCAP-123', 'NAN loan number');
  ok(valOf(s, 'Property') === '12 Oak St, Brooklyn, NY, 11249', 'NAN property line');
  ok(valOf(s, 'County') === 'Kings', 'NAN county');
  ok(valOf(s, 'Property type') === 'Single Family', 'NAN property type');
  ok(valOf(s, 'Occupancy') === 'Tenant Occupied', 'NAN occupancy');
  ok(valOf(s, 'Loan purpose') === 'Purchase', 'NAN loan purpose');
  ok(valOf(s, 'Purchase / property value') === '$400,000', 'NAN value formatted with $');
  ok(valOf(s, 'Loan amount') === '$300,000', 'NAN loan amount formatted');
  ok(valOf(s, 'Borrowers') === 'Peter Parker, Mary Jane', 'NAN both borrowers');
  ok(valOf(s, 'Main contact') === 'Peter Parker · 555-1 · p@x.com', 'NAN main contact name + reach');
  ok(valOf(s, 'Update emails to') === 'lo@x.com, p@x.com', 'NAN notify emails');

  // A draft with no stored envelope still names the loan number, never crashes.
  const bare = amc.orderSummary({ form_description: 'Form', client_order_number: 'L1' });
  ok(valOf(bare, 'Loan number') === 'L1', 'NAN summary degrades gracefully with no envelope');
}

// ---- Class order summary (from the sent order body) ----
{
  const order = {
    product_title: 'Single Family (1004)', product_id: '10', reference_number: 'YSCAP-123', status: 'completed',
    request_body: {
      referenceNumber: 'YSCAP-123',
      property: { street: '12 Oak St', line2: 'Unit 3', city: 'Brooklyn', state: 'NY', zip: '11249', county: 'Kings' },
      loanInfo: { loanNumber: 'LN-9', loanAmount: '300000', purchaseAmount: 400000 },
      purpose: 'Purchase', occupancy: 'Investment', propertyType: 'SingleFamily',
      contacts: [{ firstName: 'Peter', lastName: 'Parker' }],
      notificationList: [{ borrowerInfoType: 'BorrowerInfo', borrowerEmail: 'p@x.com' }],
    },
  };
  const s = classBuild.orderSummary(order);
  ok(valOf(s, 'Report ordered') === 'Single Family (1004)', 'Class report ordered');
  ok(valOf(s, 'Loan number') === 'LN-9', 'Class loan number (body wins over reference)');
  ok(valOf(s, 'Property') === '12 Oak St, Unit 3, Brooklyn, NY, 11249', 'Class property line');
  ok(valOf(s, 'County') === 'Kings', 'Class county');
  ok(valOf(s, 'Property type') === 'SingleFamily', 'Class property type');
  ok(valOf(s, 'Occupancy') === 'Investment', 'Class occupancy');
  ok(valOf(s, 'Purpose') === 'Purchase', 'Class purpose');
  ok(valOf(s, 'Loan amount') === '$300,000', 'Class loan amount formatted');
  ok(valOf(s, 'Purchase / property value') === '$400,000', 'Class value formatted');
  ok(valOf(s, 'Contact') === 'Peter Parker', 'Class contact');
  ok(valOf(s, 'Update emails to') === 'p@x.com', 'Class notify email scanned out of the notification list');

  // The 3.6 property-type key (propertyTypeEnum) is read too.
  const v36 = classBuild.orderSummary({ product_title: 'X', request_body: { propertyTypeEnum: 'Condo' } });
  ok(valOf(v36, 'Property type') === 'Condo', 'Class reads the 3.6 propertyTypeEnum key');
}

console.log(`\n[test-order-summary-pure] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
