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
  // The account's single client-on-report profile, auto-resolved by order-service.
  clientDisplayedId: '297', clientDisplayedName: 'YS Capital Group', clientDisplayedSource: 'catalog',
  property: { category: 'SFR', addressLine: '12 Oak St', city: 'Brooklyn', state: 'NY', postalCode: '11249', county: 'Kings', occupancy: 'Investment', purchasePriceAmount: 400000, salesContractAmount: 400000 },
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
  ok(spec.clientDisplayedId === '297', 'client-displayed-on-report id flows from the context');
  ok(spec.property.purchasePriceAmount === 400000, 'purchase price amount (purchase_amount) carried');
  ok(ob.missingRequired(spec).length === 0, 'complete spec has nothing missing');
}

// ---- primary contact + purchase amount (AppraisalScope requireds) ----
{
  const spec = ob.buildOrderSpec(ctx, { productCode: '5' });
  ok(spec.primaryContact && spec.primaryContact.fullName === 'Peter Parker', 'primary contact resolves to the borrower');
  ok(spec.primaryContact.phone === '555-1' && spec.primaryContact.email === 'p@x.com', 'primary contact carries a phone + email');
  ok(ob.missingRequired(spec).length === 0, 'complete spec (value + reachable contact) is not missing anything');

  // Co-Borrower best-contact resolves to the secondary borrower (who is reachable here,
  // so the reachable-fallback below does not fire).
  const co = ob.buildOrderSpec(
    { ...ctx, borrowers: [ctx.borrowers[0], { ...ctx.borrowers[1], cellPhone: '555-5' }] },
    { productCode: '5' }, { bestContact: 'Co-Borrower' });
  ok(co.primaryContact.fullName === 'Mary Jane', 'best-contact Co-Borrower resolves to the secondary borrower');
  ok(co.primaryContact.phone === '555-5', 'and carries the co-borrower’s own reach');

  // On a purchase (ctx is a purchase), a missing purchasePriceAmount — NAN's required
  // purchase_amount — is flagged, not silently sent. (salesContractAmount is separate/optional.)
  const noVal = ob.buildOrderSpec({ ...ctx, property: { ...ctx.property, purchasePriceAmount: null } }, { productCode: '5' });
  ok(ob.missingRequired(noVal).includes('purchase price'), 'a missing purchase price is flagged, not sent');

  // A main contact with no phone AND no email → the vendor cannot build primary_contact.
  const noReach = ob.buildOrderSpec({ ...ctx, borrowers: [{ firstName: 'A', lastName: 'B' }] }, { productCode: '5' });
  ok(ob.missingRequired(noReach).includes('a phone or email for the main contact'), 'an unreachable main contact is flagged, not sent');

  // If the DEFAULT contact has no reach but another borrower does, the reachable one is
  // used — the order is not blocked when someone on the file can be reached.
  const fallback = ob.buildOrderSpec({ ...ctx, borrowers: [
    { classification: 'Primary', firstName: 'No', lastName: 'Reach' },
    { classification: 'Secondary', firstName: 'Reach', lastName: 'Able', cellPhone: '555-9' },
  ] }, { productCode: '5' });
  ok(fallback.primaryContact.phone === '555-9', 'the reachable borrower is used when the default contact has no phone/email');
  ok(!ob.missingRequired(fallback).includes('a phone or email for the main contact'), 'a reachable co-borrower keeps the order placeable');
}

// ---- client-displayed-on-report (AppraisalScope required client_displayed_id) ----
{
  // Auto-resolved to an id (from ctx) → carried, and surfaced as an assumption so the desk sees it.
  const spec = ob.buildOrderSpec(ctx, { productCode: '5' });
  ok(spec.clientDisplayedId === '297', 'client-displayed id auto-selected from the account profile');
  ok(spec.clientDisplayedName === 'YS Capital Group', 'client-displayed name carried alongside the id');
  const assumptions = ob.orderAssumptions(ctx, { productCode: '5' }, {}, spec);
  ok(assumptions.some((a) => a.field === 'clientDisplayedId' && /YS Capital Group/.test(a.value)),
    'the client shown on the report is listed as an auto-filled assumption');

  // A staffer can pin a specific one (opts wins over the auto-resolved account profile).
  const pinned = ob.buildOrderSpec(ctx, { productCode: '5' }, { clientDisplayedId: '512' });
  ok(pinned.clientDisplayedId === '512', 'an explicitly chosen client-displayed id wins');
  // A pinned id NEVER rides the stale default name of a DIFFERENT (auto-resolved) profile.
  ok(pinned.clientDisplayedName === null, 'a pinned id with no matching option carries no stale name');
  // When the pinned id IS one of the resolved options (the picker case), its own name is used.
  const picked = ob.buildOrderSpec(
    { ...ctx, clientDisplayedId: null, clientDisplayedName: null, clientDisplayedSource: 'multiple',
      clientDisplayedOptions: [{ id: '512', name: 'YS Capital Group LLC' }, { id: '640', name: 'YS Capital Group' }] },
    { productCode: '5' }, { clientDisplayedId: '512' });
  ok(picked.clientDisplayedId === '512' && picked.clientDisplayedName === 'YS Capital Group LLC',
    'a pinned id from the picker carries that profile’s own name');

  // NAME-DEFAULT: the account's list can't be read, so only the default NAME is known and no id
  // resolved. The gateway REQUIRES a numeric client_displayed_id, so a name alone cannot satisfy
  // it — the order is BLOCKED with a plain message (fix the account / pin AMC_CLIENT_DISPLAYED_ID)
  // rather than sent to fail at the vendor. It is NOT shown as a satisfied assumption.
  const nameOnly = ob.buildOrderSpec(
    { ...ctx, clientDisplayedId: null, clientDisplayedName: 'YS Capital Group', clientDisplayedSource: 'name_default' },
    { productCode: '5' });
  ok(ob.missingRequired(nameOnly).includes('the client shown on the appraisal report'),
    'a name-only client-displayed (no id) is BLOCKED — the gateway requires the numeric id');
  const nameAssumptions = ob.orderAssumptions(
    { ...ctx, clientDisplayedId: null, clientDisplayedName: 'YS Capital Group', clientDisplayedSource: 'name_default' },
    { productCode: '5' }, {}, nameOnly);
  ok(!nameAssumptions.some((a) => a.field === 'clientDisplayedId'),
    'a name-only client-displayed is NOT shown as a satisfied assumption (no id resolved)');

  // MULTIPLE with no default match: neither an id nor a name is resolvable (the picker
  // chooses) → blocked, so the wrong company can never print on the report.
  const unresolved = ob.buildOrderSpec(
    { ...ctx, clientDisplayedId: null, clientDisplayedName: null, clientDisplayedSource: 'multiple' },
    { productCode: '5' });
  ok(ob.missingRequired(unresolved).includes('the client shown on the appraisal report'),
    'a client-displayed with several profiles and none picked is flagged, not sent');
  ok(!ob.missingRequired(spec).includes('the client shown on the appraisal report'),
    'a resolved client-displayed-on-report is not flagged');
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

// ---- estimated closing date: OPTIONAL, but omit a past/blank value (never fabricate) ----
// AppraisalScope rejects a PAST estimatedClosingDate but the field is optional, so we send it
// only when it is today-or-later and OMIT it otherwise. today injected for determinism.
{
  const T = '2026-08-13';
  // orderClosingDate → the value to SEND (or null to omit)
  ok(ob.orderClosingDate('2026-09-15', { today: T }) === '2026-09-15', 'closing: future date sent as-is');
  ok(ob.orderClosingDate('2026-08-13', { today: T }) === '2026-08-13', 'closing: exactly-today sent (>= current date)');
  ok(ob.orderClosingDate('2026-08-01', { today: T }) === null, 'closing: PAST date omitted (null), never fabricated');
  ok(ob.orderClosingDate(null, { today: T }) === null, 'closing: null → omitted');
  ok(ob.orderClosingDate('', { today: T }) === null, 'closing: empty → omitted');
  ok(ob.orderClosingDate('not-a-date', { today: T }) === null, 'closing: garbage → omitted');
  ok(ob.orderClosingDate(20260901, { today: T }) === null, 'closing: non-string → omitted');

  // closingDateStatus → how the preview classifies the file's date
  ok(ob.closingDateStatus('2026-09-15', { today: T }) === 'ok', 'status: future → ok');
  ok(ob.closingDateStatus('2026-08-13', { today: T }) === 'ok', 'status: today → ok');
  ok(ob.closingDateStatus('2026-08-01', { today: T }) === 'stale', 'status: past → stale');
  ok(ob.closingDateStatus(null, { today: T }) === 'none', 'status: null → none');
  ok(ob.closingDateStatus('', { today: T }) === 'none', 'status: empty → none');
  ok(ob.closingDateStatus('not-a-date', { today: T }) === 'none', 'status: garbage → none');

  // buildOrderSpec applies it at the one chokepoint. NOTE the signature is
  // buildOrderSpec(ctx, form, opts) — `today` is injected via opts (3rd arg) for determinism.
  const base = { loanNumber: 'L', loanPurpose: 'Purchase', property: { category: 'SFR', addressLine: 'a', city: 'c', state: 'NY', postalCode: '1', purchasePriceAmount: 400000 }, borrowers: [{ firstName: 'A', lastName: 'B' }] };
  const F = { productCode: '5' };
  ok(ob.buildOrderSpec({ ...base, estimatedClosingDate: '2026-08-01' }, F, { today: T }).loan.estimatedClosingDate === null, 'spec: past file date omitted');
  ok(ob.buildOrderSpec({ ...base, estimatedClosingDate: '2026-09-15' }, F, { today: T }).loan.estimatedClosingDate === '2026-09-15', 'spec: future file date kept');
  ok(ob.buildOrderSpec({ ...base, estimatedClosingDate: null }, F, { today: T }).loan.estimatedClosingDate === null, 'spec: missing file date → null (omit)');
  // a staff-pinned future date wins; a staff-pinned past date is omitted too
  ok(ob.buildOrderSpec({ ...base, estimatedClosingDate: '2026-08-01' }, F, { today: T, estimatedClosingDate: '2026-10-01' }).loan.estimatedClosingDate === '2026-10-01', 'spec: staff override (future) wins');
  ok(ob.buildOrderSpec({ ...base, estimatedClosingDate: '2026-09-15' }, F, { today: T, estimatedClosingDate: '2020-01-01' }).loan.estimatedClosingDate === null, 'spec: staff override (past) omitted');

  // the wire message OMITS the field entirely when there is no valid future date...
  const wmNone = cdg.buildCreateAppraisal(ob.buildOrderSpec({ ...base, estimatedClosingDate: '2026-08-01' }, F, { today: T }), { apiKey: 'K', subdomain: 's', lenderIdentifier: 'G' }).message;
  ok(!('estimatedClosingDate' in wmNone.deals[0].loans[0]), 'e2e: past date → estimatedClosingDate absent from the loan block');
  // ...and carries it when the file has a valid future date
  const wmOk = cdg.buildCreateAppraisal(ob.buildOrderSpec({ ...base, estimatedClosingDate: '2026-09-15' }, F, { today: T }), { apiKey: 'K', subdomain: 's', lenderIdentifier: 'G' }).message;
  ok(wmOk.deals[0].loans[0].estimatedClosingDate === '2026-09-15', 'e2e: future date on the wire');

  // the preview WARNS on a stale closing date (owner-directed), stays quiet on a missing one
  const ctxStale = { ...base, estimatedClosingDate: '2026-07-27', propertyCategory: 'SFR' };
  const aStale = ob.orderAssumptions(ctxStale, F, { today: T });
  const warn = aStale.find((x) => x.field === 'estimatedClosingDate');
  ok(warn && warn.warn === true && warn.value === '2026-07-27', 'preview: stale closing date raises a visible warning');
  const aFuture = ob.orderAssumptions({ ...base, estimatedClosingDate: '2026-09-15' }, F, { today: T });
  ok(!aFuture.some((x) => x.field === 'estimatedClosingDate'), 'preview: a valid future date raises no warning');
  const aNone = ob.orderAssumptions({ ...base, estimatedClosingDate: null }, F, { today: T });
  ok(!aNone.some((x) => x.field === 'estimatedClosingDate'), 'preview: a missing date is silently omitted (no warning)');
}

// ---- purchase preflight requires purchasePriceAmount (NAN's purchase_amount), not sales price ----
{
  const F = { productCode: '5' };
  const buyBase = { loanNumber: 'L', loanPurpose: 'Purchase', property: { category: 'SFR', titleCategory: 'Single Family', addressLine: 'a', city: 'c', state: 'NY', postalCode: '1' }, borrowers: [{ firstName: 'A', lastName: 'B' }], clientDisplayedId: '199384', parties: { bestContact: 'Borrower' }, primaryContact: { phone: '5551212' } };
  // a PURCHASE missing purchasePriceAmount is flagged — even if salesContractAmount is present
  const missNoPP = ob.missingRequired(ob.buildOrderSpec({ ...buyBase, property: { ...buyBase.property, salesContractAmount: 400000 } }, F, {}));
  ok(missNoPP.includes('purchase price'), 'preflight: purchase w/ salesContractAmount but no purchasePriceAmount is still flagged');
  // a PURCHASE with purchasePriceAmount is satisfied
  const missOk = ob.missingRequired(ob.buildOrderSpec({ ...buyBase, property: { ...buyBase.property, purchasePriceAmount: 400000 } }, F, {}));
  ok(!missOk.includes('purchase price'), 'preflight: purchase w/ purchasePriceAmount passes');
  // a REFINANCE does NOT require purchase_amount
  const missRefi = ob.missingRequired(ob.buildOrderSpec({ ...buyBase, loanPurpose: 'Refinance', property: { ...buyBase.property, purchasePriceAmount: null } }, F, {}));
  ok(!missRefi.includes('purchase price'), 'preflight: refinance does not require purchase price');
  // a BLANK/unknown loan purpose is treated as a purchase (mirrors loadContext isPurchase), so
  // a missing purchase price is still flagged — closing the gap where a blank loan_type slips through.
  const missBlank = ob.missingRequired(ob.buildOrderSpec({ ...buyBase, loanPurpose: null, property: { ...buyBase.property, purchasePriceAmount: null } }, F, {}));
  ok(missBlank.includes('purchase price'), 'preflight: blank loan purpose (treated as purchase) still requires purchase price');
  const missBlankOk = ob.missingRequired(ob.buildOrderSpec({ ...buyBase, loanPurpose: null, property: { ...buyBase.property, purchasePriceAmount: 400000 } }, F, {}));
  ok(!missBlankOk.includes('purchase price'), 'preflight: blank loan purpose with a purchase price passes');
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
  ok(msg.deals[0].parties.some((p) => p.partyRoleType === 'BestContact' && p.partyRoleTypeOtherDescription === 'Borrower'), 'e2e: best contact (primary_contact) on the wire');
  ok(msg.clientSystem.sourceInformation.sourceClientIdentifier === '297', 'e2e: client_displayed_id on the wire via sourceClientIdentifier (resolved id wins over config)');
  ok(msg.deals[0].parties.some((p) => p.partyRoleType === 'Lender' && p.partyRoleIdentifier === '297'), 'e2e: client_displayed_id ALSO on a Lender party (belt-and-suspenders, same value)');
  ok(msg.deals[0].properties[0].purchasePriceAmount === '400000.00', 'e2e: purchase price amount (purchase_amount) on the wire');
}

console.log(`\n[test-amc-order-build-pure] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
