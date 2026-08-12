'use strict';
/**
 * Pure test for the AMC order builder (src/amc/order-build.js) — the auto-fill mapping
 * from a loan file to a CreateAppraisal order. No DB, no network.
 *
 * Locks in: the deal-shape for form selection, the enum mappings (title category,
 * occupancy, loan purpose), the full spec build (defaults + overrides + borrowers +
 * contacts + entity), the missing-required check, and — end to end — that an auto-filled
 * spec produces a wire message carrying every required CreateAppraisal field.
 */
const ob = require('../src/amc/order-build');
const cdg = require('../src/amc/cdg');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// ---- enum mappings ----
ok(ob.titleCategoryFor('SFR') === 'Single Family', 'title category SFR');
ok(ob.titleCategoryFor('Multi 2-4') === '2-4 Family', 'title category multi 2-4');
ok(ob.titleCategoryFor('Condo') === 'Condominium', 'title category condo');
ok(ob.titleCategoryFor('Something New') === 'Something New', 'title category unknown passes through');
ok(ob.occupancyFor('Investment') === 'Tenant Occupied', 'occupancy investment → tenant occupied');
ok(ob.occupancyFor('Primary') === 'Owner Occupied', 'occupancy primary → owner occupied');
ok(ob.loanPurposeFor('Refi Cash-Out') === 'Refinance', 'purpose refi → Refinance');
ok(ob.loanPurposeFor('Purchase') === 'Purchase', 'purpose purchase → Purchase');

// ---- deal shape for form selection ----
{
  const shape = ob.dealShapeFor({ program: 'fix_and_flip', property: { category: 'SFR' }, loanPurpose: 'Purchase' });
  ok(shape.program === 'fix_and_flip' && shape.propertyCategory === 'SFR' && shape.loanPurpose === 'Purchase', 'dealShapeFor');
}

// ---- a full auto-filled spec ----
const ctx = {
  loanNumber: 'YSCAP-123', program: 'bridge', loanPurpose: 'Purchase',
  loanAmount: 300000, estimatedClosingDate: '2026-09-15',
  property: { category: 'SFR', addressLine: '12 Oak St', city: 'Brooklyn', state: 'NY', postalCode: '11249', county: 'Kings', occupancy: 'Investment', salesContractAmount: 400000 },
  borrowers: [
    { classification: 'Primary', firstName: 'Peter', lastName: 'Parker', fullName: 'Peter Parker', entityName: 'PP Holdings LLC', email: 'p@x.com', cellPhone: '555-1', workPhone: '555-2', residence: { addressLine: '1 A St', city: 'NYC', state: 'NY', postalCode: '10001' } },
    { firstName: 'Mary', lastName: 'Jane' },
  ],
  parties: { loanOfficerAmcId: '429' },
};

{
  const form = { productCode: '5', subproductCodes: ['7'], amcIdentifier: '426' };
  const spec = ob.buildOrderSpec(ctx, form);
  ok(spec.productCode === '5' && spec.subproductCodes[0] === '7' && spec.amcIdentifier === '426', 'form applied');
  ok(spec.clientOrderNumber === 'YSCAP-123', 'client order number from loan number');
  ok(spec.loan.loanNumber === 'YSCAP-123' && spec.loan.loanPurpose === 'Purchase', 'loan mapped');
  ok(spec.loan.mortgageType === 'Conventional', 'mortgage type default');
  ok(spec.loan.baseLoanAmount === 300000, 'base loan amount');
  ok(spec.property.titleCategory === 'Single Family', 'property title category');
  ok(spec.property.addressLine === '12 Oak St' && spec.property.state === 'NY' && spec.property.postalCode === '11249', 'property address');
  ok(spec.property.occupancy === 'Tenant Occupied', 'property occupancy mapped');
  ok(spec.property.salesContractAmount === 400000, 'sales contract amount');
  ok(spec.borrowers.length === 2, 'both borrowers');
  ok(spec.borrowers[0].classification === 'Primary' && spec.borrowers[1].classification === 'Secondary', 'borrower classifications defaulted');
  ok(spec.borrowers[0].legalEntityName === 'PP Holdings LLC', 'borrower entity name');
  ok(spec.borrowers[0].contacts && spec.borrowers[0].contacts.some((c) => c.email === 'p@x.com'), 'borrower contact email');
  ok(spec.borrowers[0].residence.city === 'NYC', 'borrower residence');
  ok(spec.parties.loanOfficerId === '429', 'loan officer amc id');
  ok(spec.parties.bestContact === 'Borrower', 'best contact defaults to Borrower');
  ok(ob.missingRequired(spec).length === 0, 'complete spec has nothing missing');
}

// ---- primary contact + purchase amount (AppraisalScope requireds) ----
{
  const spec = ob.buildOrderSpec(ctx, { productCode: '5' });
  ok(spec.primaryContact && spec.primaryContact.fullName === 'Peter Parker', 'primary contact resolves to the borrower');
  ok(spec.primaryContact.phone === '555-1' && spec.primaryContact.email === 'p@x.com', 'primary contact carries a phone + email');
  ok(ob.missingRequired(spec).length === 0, 'complete spec (value + reachable contact) is not missing anything');

  // Co-Borrower best-contact resolves to the secondary borrower.
  const co = ob.buildOrderSpec(ctx, { productCode: '5' }, { bestContact: 'Co-Borrower' });
  ok(co.primaryContact.fullName === 'Mary Jane', 'best-contact Co-Borrower resolves to the secondary borrower');

  // No property value (a refinance with nothing on file, or a blank price) → flagged.
  const noVal = ob.buildOrderSpec({ ...ctx, property: { ...ctx.property, salesContractAmount: null } }, { productCode: '5' });
  ok(ob.missingRequired(noVal).includes('purchase price or property value'), 'a missing purchase/property value is flagged, not sent');

  // A main contact with no phone AND no email → the vendor cannot build primary_contact.
  const noReach = ob.buildOrderSpec({ ...ctx, borrowers: [{ firstName: 'A', lastName: 'B' }] }, { productCode: '5' });
  ok(ob.missingRequired(noReach).includes('a phone or email for the main contact'), 'an unreachable main contact is flagged, not sent');
}

// ---- overrides ----
{
  const spec = ob.buildOrderSpec(ctx, { productCode: '5' }, { productCode: '9', mortgageType: 'Other', bestContact: 'Owner', rush: true, needByDate: '2026-10-01', requestComment: 'please rush' });
  ok(spec.productCode === '9', 'productCode override wins');
  ok(spec.loan.mortgageType === 'Other', 'mortgage type override');
  ok(spec.parties.bestContact === 'Owner', 'best contact override');
  ok(spec.rush === true && spec.needByDate === '2026-10-01' && spec.requestComment === 'please rush', 'rush/needby/comment overrides');
}

// ---- missing required ----
{
  const bare = ob.buildOrderSpec({ borrowers: [{}] }, null);
  const miss = ob.missingRequired(bare);
  ok(miss.includes('appraisal form') && miss.includes('loan number') && miss.includes('property street address') && miss.includes('property ZIP'), 'missingRequired lists gaps');
  // entity-only borrower satisfies the name requirement
  const ent = ob.buildOrderSpec({ loanNumber: 'L', property: { category: 'SFR', addressLine: 'a', city: 'c', state: 'NY', postalCode: '1' }, borrowers: [{ entityName: 'Acme LLC' }] }, { productCode: '5' });
  const em = ob.missingRequired(ent);
  ok(!em.includes('borrower first name') && !em.includes('borrower last name'), 'entity-only borrower satisfies name requirement');
}

// ---- end to end: auto-filled spec → valid CreateAppraisal wire message ----
{
  const spec = ob.buildOrderSpec(ctx, { productCode: '5', amcIdentifier: '426' });
  const msg = cdg.buildCreateAppraisal(spec, { apiKey: 'K', subdomain: 'integrations.uat', lenderIdentifier: 'GG1', sourceClientId: '267' }).message;
  ok(msg.products[0].productCode === '5', 'e2e: form on the wire');
  ok(msg.deals[0].loans[0].loanIdentifiers.lenderLoanIdentifier === 'YSCAP-123', 'e2e: loan number on the wire');
  ok(msg.deals[0].loans[0].mortgageType === 'Conventional', 'e2e: mortgage type on the wire');
  ok(msg.deals[0].properties[0].titleCategoryType === 'Single Family', 'e2e: title category on the wire');
  ok(msg.deals[0].properties[0].address.stateCode === 'NY', 'e2e: property address on the wire');
  ok(msg.deals[0].borrowers[0].firstName === 'Peter', 'e2e: borrower on the wire');
  ok(msg.deals[0].appraisers[0].identifier === '426', 'e2e: preferred AMC on the wire');
  ok(msg.deals[0].parties.some((p) => p.partyRoleType === 'BestContact' && p.partyRoleTypeIdentifier === 'Borrower'), 'e2e: best contact on the wire');
}

console.log(`\n[test-amc-order-build-pure] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
