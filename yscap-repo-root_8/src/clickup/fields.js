/**
 * ClickUp custom-field registry — REAL field IDs + option IDs.
 * Pulled live from the workspace (CRM & SALES space 90113224042,
 * Loan Pipeline space 90113223301). Keep this file as the single source
 * of truth for every field id the sync layer touches.
 *
 * SHARED = identical field id in BOTH the CRM list and the Pipeline list,
 *          so borrower PII written once applies to a contact and a file.
 */

const SPACES = {
  CRM: '90113224042',
  PIPELINE: '90113223301',
};

// ---- Fields that share the SAME id across CRM + Pipeline (dual-write) ----
const SHARED = {
  borrowerName:      '474a54a3-a430-4e1f-a3ca-b94d375bece8', // short_text
  borrowerEmail:     '743c16d3-68f8-4ea2-bda2-e22bf30bbe3b', // email
  borrowerSSN:       '51e0826e-0293-4d13-ba73-04e4547de520', // short_text (PII)
  borrowerDOB:       'd4e72161-3688-4653-9d35-bd73e04066f7', // date
  borrowerFICO:      'a67357ca-69f0-497b-afd4-39581af60a30', // number
  borrowerAddress:   '0b469d1b-a9b0-41de-aac3-b1c3c954d9b4', // location
  borrowerCell:      'd60cf254-0914-4da9-91cb-c314a64eaa73', // short_text (Pipeline label has phone glyph)
  loanOfficer:       '14839ebf-b214-4841-af35-ca10703397f3', // users (single)
  loanOfficerEmail:  '9f6cc87f-b93d-4dce-a13e-66de8f47616a', // email
  companyLead:       'ef5c471b-4289-4280-8379-9e5446a74b30', // checkbox
  primaryHousingAmt: '51a91012-5665-4f22-b0c6-3048ed862e3b', // currency
  primaryHousingType:'6ae80836-6835-4c91-a3ef-209923f89e30', // drop_down
};

// ---- CRM-only (contact relationship + call tracking) ----
const CRM = {
  pipelineLink:      '4952e019-c90f-4003-904b-3ae471263ab7', // tasks relation -> loan files
  contactType:       '44120431-132f-4509-a086-e2dea10c3a72', // INVESTOR/PRIMARY/FIRST TIME INVESTOR
  leadSource:        'fce6283c-c075-4908-84e8-506cdd4f7c51', // drop_down
  nextFollowUp:      '793869cf-8f76-4864-9cb8-c6a31504d2e9', // date
  phoneNumber:       'db6ff972-fc74-49ae-a59a-be684f3e7e81', // short_text
};

// ---- Pipeline-only (the loan file) ----
const PIPELINE = {
  crmLink:           '612eed39-0f26-4378-8eda-6346ef9866e8', // tasks relation -> contact
  ysLoanNumber:      'a6da91bc-9eae-4f9d-b788-353afd4d2858', // short_text (natural key)
  investorLoanNo:    '8ff507cc-24f8-4aea-beec-349c7d575980',
  program:           '50eb857a-d8b1-4c48-9ffe-20b15cdf1338', // drop_down
  loanType:          'ee1b564f-13cb-4841-af4c-e0f762cbcf52', // drop_down
  lender:            'a914ec5a-7419-480f-9c28-882f979e8702', // drop_down
  channel:           '6eb27010-b23a-46a7-9040-40d68d930e9d', // Wholesale/correspondent
  occupancy:         'df9d81b5-0b5d-4e09-a44a-4bbfb3b0291c', // drop_down
  propertyType:      '541524d9-255f-4484-ac6d-1011ac60e87b', // drop_down
  units:             '81fc839f-23f5-4780-a5f1-8298121cce2b', // number
  subjectAddress:    'ef691991-2d07-4d61-aefe-e34a332d61de', // location
  purchasePrice:     '0fc6370c-60b7-4e20-8b5c-0facb90729cf', // currency
  approxValue:       '834d0ffb-38ac-4358-b1ea-13f5d345dd91', // currency
  arv:               '5644fe6e-50bc-449b-91b2-f48aa6aaea55', // currency (RTL)
  constructionBudget:'2d27cb55-9f53-4fb1-8a93-eb523ae40660', // currency
  loanAmount:        'e393e64a-63e3-46cc-ae03-402520614f28', // currency
  ltv:               '3f5cd2e2-9238-4eff-9762-ca888c14201d', // short_text
  dscrRatio:         '7157db7c-b102-4725-9dbe-2e88a83e5d55', // number
  term:              'b67dd5fd-c753-47e9-b3dd-aa576d742abd', // drop_down
  pppType:           '82269a33-79e8-4495-9d74-320edf4e41b6', // short_text
  vesting:           '173dc79a-a12d-4233-a6a6-9f4101770ca9', // drop_down
  llcName:           '8bb530c0-a903-487d-bfcd-17810ecffddd', // text
  ein:               '0ed80e37-17c1-4a36-9b23-33b75a27e385', // short_text
  coBorrowerFlag:    'a62d4e6a-5699-4682-8ac1-144b5119f523', // YES/NO
  coBorrowerName:    '5e4d2128-886c-4705-afce-a22ad311a1a9', // short_text
  secondBorrowerEmail:'a5e70ced-f60a-4832-92ba-0d7bee087eb1',
  secondBorrowerCell:'37837aab-8e6c-4550-b626-01b35e6f5bf0',
  processor:         '926bad3b-d1a2-432b-8bb4-867c9f7d9a5b', // users
  underwriter:       'ce85aa3a-ddd4-41b5-8c03-410532077024', // users
  expectedClosing:   'de57d9fb-4c9e-4881-b6bf-fcf6268e44a6', // date
  dateSubmitted:     '51ef2193-6f42-4b6a-ab8e-d4bc13f0bd0c', // date
  encompassStatus:   '6961b76e-3aa4-4d5a-87ed-b2c704e7cc05', // drop_down
  sharePointFlag:    '3d35b577-bc9f-48cc-8fc5-4124edd744ba', // checkbox
  scopeOfWork:       '5991f10c-f59f-4b2b-ab25-39da42b35b96', // text
  rawIntakeNotes:    'c80cd7aa-ec96-49b4-a313-be023178b125', // Clear File Notes (text)
};

/**
 * CHECKLIST status dropdowns. Each maps a portal checklist item to a ClickUp
 * dropdown; option ids let us push the exact status the borrower/staff set.
 * Statuses normalized to: outstanding | requested | received | satisfied | issue
 */
const CHECKLIST = {
  title: {
    fieldId: '96799e30-0f72-47e5-9136-5d59203d27b7',
    options: { requested:'1f60b8a1-5d28-4328-a1d7-e78d9b9549e2', received:'3cb81261-65f3-4752-a8b3-654cdd5c2b09', satisfied:'13d88676-2a1d-4cf5-a3a5-77f05ce8185c', issue:'a3000a90-44c8-4234-823c-85c2e527b4a1', outstanding:'6b863c52-db0b-4d38-95fe-f49397843781' },
  },
  insurance: {
    fieldId: '2cfc1e61-6be7-484f-929e-c2de9c7a2e40',
    options: { requested:'ab91f4ab-5f20-4c08-ba57-a584ae23c1bc', received:'91e491a9-8d2f-4c1c-8995-a41767aea53c', satisfied:'7ca445ff-fda7-4f7d-8336-d57783d6f0f7', issue:'06081f78-cb2c-4ac1-a26b-31de8ef0d9ef', outstanding:'acad4672-0969-45ee-a7fb-96171ab3e795' },
  },
  contract: {
    fieldId: '85866d28-7135-490d-be71-471a34669629',
    options: { requested:'90bda796-46e6-477c-9a98-77722638aaa5', received:'ff08a602-b342-4fac-ae48-4290439a7859', satisfied:'32ae6d40-170e-4543-a14e-ade3d83dc952', issue:'6d41cd20-0102-4f7e-bd83-77d216b04a53', outstanding:'0533f41a-4803-437e-a6e6-89e20303e58d' },
  },
  assignment: {
    fieldId: 'a22694cb-7fcf-49d0-83b5-163cd07b26b0',
    options: { requested:'a597c34f-0cb5-4ed4-886a-0627c83ddd68', received:'7d2931f3-0c61-4b55-b20e-9e602e3adeff', satisfied:'40ae01b7-68e8-444a-8fcf-5a5e5800a23b', issue:'33edc1ed-8211-44ff-835b-2bc0561be710', outstanding:'0da17775-f8c6-4f2b-b8fb-83509e59b79d' },
  },
  rehabBudget: {
    fieldId: 'b1cdb8b1-5f74-40bb-8d57-76ec0b0d629f',
    options: { requested:'1d98cb27-bce4-4864-9b33-93f980c83c01', received:'3cfbd029-c902-44fc-9e2f-022023b57428', issue:'a06b9e85-6cb7-48b1-8c0c-2fb1730da31c', receivedUploaded:'31211215-f916-4bb2-b1f4-05e50b2a5ec2' },
  },
  reo: {
    fieldId: 'fa211bd9-d464-44cb-a54c-8485f2d9ec8d',
    options: { requested:'d6de8cf5-19c4-4b3b-b390-158ab3a4c97a', received:'591b2658-948d-4e30-b36c-cb64d0c52c94', satisfied:'69d57cb2-938c-4b05-a685-a51135b1b655', issue:'79a1025d-f0cc-4a19-9003-09058f6ccd2b', outstanding:'071eb5c0-2964-4a61-af56-bdc3f1401e1b' },
  },
  assets: {
    fieldId: '1b813089-5605-4da9-b77b-49a7e105965b',
    options: { requested:'6f5bd705-9637-4ac0-b219-13a988d6055c', received:'62969431-d633-483d-af9a-10cd92545d49', satisfied:'a2b1a7fd-d400-4e4d-8125-a2b7dd8b7416', issue:'abed50e6-8ba2-4af4-9eaa-c9ad66203572', outstanding:'15a01a02-e198-40b8-98e9-a67fd6d32856' },
  },
  signedTermSheet: {
    fieldId: 'd60eef93-d13a-404b-9523-72826e2e37b0',
    options: { requested:'3d0970ce-4e0c-43cf-94d4-cf8cd0f7d951', received:'d8c18154-403d-488c-8dde-bcf734dcfdba', issue:'6953e927-d1ae-49ad-a5f2-86c3499ae421' },
  },
};

module.exports = { SPACES, SHARED, CRM, PIPELINE, CHECKLIST };
