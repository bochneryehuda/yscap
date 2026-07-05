/**
 * Translators: portal/site values -> ClickUp custom-field payload entries.
 * Dropdown fields need the OPTION id, not the label — these maps resolve them.
 * Values are matched against the live option lists pulled from the workspace.
 */
const F = require('./fields');

// --- dropdown option-id maps (label -> optionId), from live pull ---
const PROGRAM = {
  'Fix & Flip With Construction': '31e3b89d-34a4-40a9-9bb9-cbcbd1130060',
  'bridge Without Construction':  'e8ff7301-6a64-4d5c-b4d4-48c8dd707eaa',
  'Non-QM - DSCR Ratio':          'be62fcc8-df9f-4a4f-b2b5-b22b87570e0e',
  'Private hard money':           '3222c2ec-a6be-419e-99d7-4471f466a9d7',
};
const LOAN_TYPE = {
  'Purchase':                     '5eabaafc-1600-49f8-9c1f-d0d95f4f7c39',
  'Refi Rate & Term':             '64a66c30-f3d4-4e86-8a48-4608ee317a9f',
  'Refi Cash-Out':                '7b12269e-7376-41a6-b280-a3146c360d62',
  'Delayed Purchase Financing':   '163ad351-4101-4428-96bf-f962ed3b9d37',
  'Ground up':                    '8a1137a5-b523-498b-8060-0647e7114e64',
};
const PROPERTY_TYPE = {
  'SFR':'42070628-e270-4408-bd85-768d49f19292', 'Multi 2-4':'95ef80f0-6471-459d-a16b-61e3a54e435c',
  'Multi 5+':'64378328-9367-4afe-b7dc-4278dff13e8a', 'Mixed Use':'93eb74bd-4903-4d9a-a8e9-658d46b7ec33',
  'New Construction':'a09b3a6b-b674-4dd1-8127-51335e62924b',
};
const OCCUPANCY = {
  'Primary':'5472309f-d9a1-465e-8d01-8e7a69911aed', 'Investment':'e3f10e41-b022-4dfa-bbb3-aececdb480d8',
  'Secondary':'ce9aed84-ab3d-45a4-979e-fdf3d43e7fa3',
};
const VESTING = {
  'Individual':'7bc896de-1e68-4e3d-9c89-3faceaf7a7ae', 'LLC / Corp':'e3d7a04a-180d-4544-95f4-92e4daa5fe8d',
  'Trust':'e579f9bf-94c7-48ab-99ef-1f525795b244',
};

function optionOrNull(map, label) {
  if (!label) return null;
  return map[label] || null;
}

/**
 * Build the custom_fields array for a NEW Pipeline (loan file) task from a
 * normalized intake object. Only sets fields we actually have values for.
 * Pricing/LTV/DSCR are pass-through snapshots — computed by the FROZEN engine.
 */
function pipelineCustomFields(intake) {
  const cf = [];
  const push = (id, value) => { if (value !== undefined && value !== null && value !== '') cf.push({ id, value }); };
  const pushOpt = (id, optId) => { if (optId) cf.push({ id, value: optId }); };

  // Borrower PII (same ids apply on the CRM contact)
  push(F.SHARED.borrowerName, intake.borrowerName);
  push(F.SHARED.borrowerEmail, intake.borrowerEmail);
  push(F.SHARED.borrowerSSN, intake.ssn);            // treated as sensitive upstream
  push(F.SHARED.borrowerCell, intake.cell);
  push(F.SHARED.borrowerFICO, intake.fico);
  push(F.SHARED.loanOfficerEmail, intake.officerEmail);

  // Product
  pushOpt(F.PIPELINE.program, optionOrNull(PROGRAM, intake.program));
  pushOpt(F.PIPELINE.loanType, optionOrNull(LOAN_TYPE, intake.loanType));
  pushOpt(F.PIPELINE.propertyType, optionOrNull(PROPERTY_TYPE, intake.propertyType));
  pushOpt(F.PIPELINE.occupancy, optionOrNull(OCCUPANCY, intake.occupancy));
  pushOpt(F.PIPELINE.vesting, optionOrNull(VESTING, intake.vesting));

  // Economics (snapshots)
  push(F.PIPELINE.purchasePrice, intake.purchasePrice);
  push(F.PIPELINE.arv, intake.arv);
  push(F.PIPELINE.constructionBudget, intake.rehabBudget);
  push(F.PIPELINE.loanAmount, intake.loanAmount);
  push(F.PIPELINE.units, intake.units);
  push(F.PIPELINE.llcName, intake.llcName);
  push(F.PIPELINE.ein, intake.ein);
  push(F.PIPELINE.pppType, intake.ppp);

  return cf;
}

/** Borrower PII payload for the CRM contact task (shared field ids). */
function crmCustomFields(intake) {
  const cf = [];
  const push = (id, value) => { if (value !== undefined && value !== null && value !== '') cf.push({ id, value }); };
  push(F.SHARED.borrowerName, intake.borrowerName);
  push(F.SHARED.borrowerEmail, intake.borrowerEmail);
  push(F.SHARED.borrowerSSN, intake.ssn);
  push(F.SHARED.borrowerFICO, intake.fico);
  push(F.CRM.phoneNumber, intake.cell);
  return cf;
}

module.exports = {
  PROGRAM, LOAN_TYPE, PROPERTY_TYPE, OCCUPANCY, VESTING,
  optionOrNull, pipelineCustomFields, crmCustomFields,
};
