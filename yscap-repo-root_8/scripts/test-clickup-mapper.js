/* Fixture tests for src/clickup/mapper.js. Run: node scripts/test-clickup-mapper.js */
const F = require('../src/clickup/fields');
const M = require('../src/clickup/mapper');

let pass = 0, fail = 0;
const eq = (name, got, exp) => {
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g === e) pass++; else { fail++; console.log(`FAIL ${name}: got ${g} expected ${e}`); }
};
const opt = (id, orderindex, name) => ({ id, orderindex, name });

// ---- buildTaskFields (push) ----
const options = {
  [F.PIPELINE.program]: [opt('PROG-FF', 0, 'Fix & Flip With Construction'), opt('PROG-BR', 1, 'bridge Without Construction')],
  [F.PIPELINE.loanType]: [opt('LT-PUR', 0, 'Purchase')],
  [F.PIPELINE.propertyType]: [opt('PT-SFR', 0, 'SFR')],
  [F.PIPELINE.vesting]: [opt('V-IND', 0, 'Individual'), opt('V-LLC', 1, 'LLC / Corp')],
  [F.PIPELINE.term]: [opt('T-12', 4, '12 Months')],
  [F.SYNC.rehabType]: [opt('RH-HEAVY', 2, 'Heavy')],
  [F.SYNC.borrowerPortalStatus]: [opt('BPS-PROC', 2, 'processing')],
  [F.EXTRA.maritalStatus]: [opt('M-YES', 0, 'YES'), opt('M-NO', 1, 'NO')],
};
const ctx = {
  app: { program: 'Fix & Flip w/ Construction', loan_type: 'Purchase', property_type: 'SFR (1 unit)',
    units: 1, loan_amount: 468750, purchase_price: 405000, as_is_value: 425000, arv: 625000, rehab_budget: 104250,
    rehab_type: 'Heavy / gut rehab', ltv: 90, rate_pct: 11.5, ys_loan_number: 'YSCAP1', internal_status: 'self procesing',
    property_address: { lat: 40.67, lng: -74.23, oneLine: '825 Bishop St, Union, NJ', line1: '825 Bishop St' } },
  borrower: { first_name: 'Dov', last_name: 'Steiner', email: 'dov@x.com', cell_phone: '9175381594',
    date_of_birth: '1998-07-31', fico: 763, ssn: '066889965', marital_status: 'Married' },
  llc: { llc_name: '825 BISHOP ST LLC', ein: '12-3456789' },
  registeredProgram: 'gold', externalStatus: 'processing', officerClickupId: 120151948, portalAppId: 'app-uuid',
};
const built = M.buildTaskFields(ctx, options);
const byId = {}; for (const c of built.customFields) byId[c.id] = c.value;

eq('build program->uuid', byId[F.PIPELINE.program], 'PROG-FF');
eq('build loan_type->uuid', byId[F.PIPELINE.loanType], 'LT-PUR');
eq('build proptype->uuid', byId[F.PIPELINE.propertyType], 'PT-SFR');
eq('build vesting=LLC', byId[F.PIPELINE.vesting], 'V-LLC');
eq('build rehab=Heavy', byId[F.SYNC.rehabType], 'RH-HEAVY');
eq('build loan amount str', byId[F.PIPELINE.loanAmount], '468750');
eq('build rtl as-is', byId[F.SYNC.rtlAsIsValue], '425000');
eq('build LTV pushed', byId[F.PIPELINE.ltv], '90');
eq('build rate pushed', byId[F.EXTRA.ratePct], '11.5');
eq('build name', byId[F.SHARED.borrowerName], 'Dov Steiner');
eq('build SSN', byId[F.SHARED.borrowerSSN], '066889965');
eq('build marital YES', byId[F.EXTRA.maritalStatus], 'M-YES');
eq('build borrower status mirror', byId[F.SYNC.borrowerPortalStatus], 'BPS-PROC');
eq('build officer users', byId[F.SHARED.loanOfficer], { add: [120151948] });
eq('build portal file id', byId[F.SYNC.portalFileId], 'app-uuid');
eq('build subject location', byId[F.PIPELINE.subjectAddress], { location: { lat: 40.67, lng: -74.23 }, formatted_address: '825 Bishop St, Union, NJ' });
eq('build statusName', built.statusName, 'self procesing');
eq('build name has address', /Dov Steiner - 825 Bishop St/.test(built.name), true);

// ---- readTaskFields (pull) ----
const task = { status: 'self procesing', custom_fields: [
  { id: F.PIPELINE.program, type: 'drop_down', type_config: { options: [opt('a', 0, 'Fix & Flip With Construction'), opt('b', 1, 'bridge Without Construction')] }, value: 0 },
  { id: F.PIPELINE.loanAmount, value: '468750' },
  { id: F.SHARED.borrowerName, value: 'Dov Steiner' },
  { id: F.SHARED.borrowerSSN, value: '066889965' },
  { id: F.PIPELINE.ltv, value: '90' },                                   // push-only -> NOT read
  { id: F.PIPELINE.lender, type: 'drop_down', type_config: { options: [opt('x', 8, 'Blue Lake')] }, value: 8 }, // free dropdown -> label
  { id: 'c80cd7aa-ec96-49b4-a313-be023178b125', name: 'Clear File Notes', value: 'note text' },  // unmapped -> extra
] };
const read = M.readTaskFields(task);
eq('read program->portal', read.app.program, 'Fix & Flip w/ Construction');
eq('read loan_amount num', read.app.loan_amount, 468750);
eq('read name split', [read.borrower.first_name, read.borrower.last_name], ['Dov', 'Steiner']);
eq('read ssn', read.borrower.ssn, '066889965');
eq('read LTV skipped (push-only)', read.app.ltv, undefined);
eq('read lender label', read.app.lender, 'Blue Lake');
eq('read extra capture', read.extra['Clear File Notes'], 'note text');
eq('read status', read.internalStatus, 'self procesing');

// ---- status returned as an OBJECT (real ClickUp v2 shape) must normalize ----
const objTask = { status: { status: 'ctc (4-email)', color: '#fff', orderindex: 5, type: 'custom' }, custom_fields: [
  { id: F.SHARED.loanOfficerEmail, type: 'email', value: 'Simcha@YSCapGroup.com' },
  { id: F.EXTRA.processorEmail, type: 'email', value: 'Malky@YSCapGroup.com' },
  { id: F.SYNC.portalFileId, type: 'short_text', value: '570e422e-8d51-44c0-b112-181edd8016be' },
  { id: F.SHARED.loanOfficer, type: 'users', value: [{ id: 87451319, username: 'Simcha' }] },
] };
const objRead = M.readTaskFields(objTask);
eq('object status -> name string', objRead.internalStatus, 'ctc (4-email)');
eq('read loan officer email (lowered)', objRead.loanOfficerEmail, 'simcha@yscapgroup.com');
eq('read processor email (lowered)', objRead.processorEmail, 'malky@yscapgroup.com');
eq('read portal file id stamp', objRead.portalFileId, '570e422e-8d51-44c0-b112-181edd8016be');
eq('read loan officer clickup id', objRead.loanOfficerClickupId, 87451319);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
