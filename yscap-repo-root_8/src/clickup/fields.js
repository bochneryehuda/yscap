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
  lender:            'a914ec5a-7419-480f-9c28-982f979e8702', // drop_down (note buyer; staff-only)
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
  iska: {
    fieldId: 'd6c23813-8041-4e8e-916e-89b9ee21e4cc',
    options: { requested:'972c4082-c062-4245-b597-afa42e3e2e35', received:'d1afcb06-e355-4379-aa88-54e3db062add', issue:'03316140-2180-492b-a5b2-71b51d4da6ef' },
  },
};

// ---- Sync-integration fields (created in the ClickUp UI for this build) ----
const SYNC = {
  sendToPortal:         'b5fca1d2-2d8b-436c-a3ea-67f7a159e036', // checkbox — emergency/force-resync trigger
  portalFileId:         '6bca11f0-47d5-460f-b915-30fc78c6e4c8', // short_text — binding stamp (our app UUID)
  portalFileLink:       '7b369ef5-452b-4448-8329-0683491e8917', // url
  syncStatus:           'c5bc086e-7f7f-446f-9571-b2e5089c9ff8', // short_text — sync health / last error
  borrowerPortalStatus: 'a47ce5e3-eea7-4f70-93ca-8062dee4d1b7', // drop_down — mirrors borrower-facing status
  rtlAsIsValue:         'b70b4451-c971-40ba-a4a6-48d919c6416d', // currency — portal as_is_value
  rehabType:            'fb8814d4-c457-4b8f-af42-671e1e1ad752', // drop_down — portal rehab_type
  rtlLoanProgram:       'aae034e4-633c-40db-85b4-7d8cfe33501b', // drop_down — Standard/Gold (push-only)
  // read-only appraised-value pulls
  approxAppraisedValue: '834d0ffb-38ac-4358-b1ea-13f5d345dd91', // currency
  actualAppraisedValue: '9356ceea-f3b2-4373-9271-d1354214db47', // currency
};

// Borrower Portal Status option ids (labels == our external status values).
const BORROWER_PORTAL_STATUS_OPT = {
  new:            'cb960fa4-550e-4a65-a476-2c792f120322',
  in_review:      '4e84f586-1953-443d-a5fd-9b7e8368639b',
  processing:     '0544e93c-e2cd-415c-9d69-1fc55355c3e2',
  underwriting:   'd4703d43-a247-48e2-a377-da4fa16c8a7a',
  approved:       '751a513c-40c1-48ca-87f6-477a79252c96',
  clear_to_close: 'cfbc4acd-a5e3-42ad-bb6e-cbdb96785714',
  funded:         '22e8563b-d705-4a20-97b7-30205ebc65f5',
  on_hold:        'e1247b8b-0092-48a9-b509-64a9b368e294',
  declined:       '0d5a9326-9d76-4153-ba4f-4cf64711385f',
  withdrawn:      'cbd1ad43-4491-4a40-b62c-9de7e8212ad2',
};

// Additional Pipeline fields referenced by the mapper (live-verified ids).
const EXTRA = {
  citizenship:        '045f993c-4c7a-4a03-b71d-44e3ed15aa07', // short_text
  maritalStatus:      'b91e06a6-ed47-4249-afa5-eaaedf7b4c3e', // drop_down YES/NO
  employmentType:     '33bf62d8-fa4f-45e5-9c91-a51ce78e5e32', // drop_down
  employment:         '04f7b699-7e55-49f3-b1a2-77f0ee0fc560', // short_text
  dependents:         '19ce13e0-bdcd-43c3-b365-7b07f1f3824e', // short_text
  yearsAtResidence:   'fabf5994-e218-43ee-9694-3b2e0caf2a12', // short_text
  priorAddress:       '616f218e-7bb3-4ee2-9f94-f9f96a054516', // location
  ratePct:            'ca47de7f-40b7-4a98-b540-2378c0e87954', // number (Desired Rate %)
  assignmentFee:      '6d62e510-9ef7-4d96-b81f-fa1251b11c26', // currency (LEGACY 'Assignment fee' — superseded by contractAssignFee)
  underlyingPrice:    '1a83ab87-bb06-4f20-8187-2bc0476d1f05', // currency (LEGACY 'Underlying purchase price' — superseded by contractAssignUnderlying)
  originalPurchase:   '253e80ff-9a76-432e-a2ac-366db5a2c3c5', // currency — 'Original Purchase Price? (Refi only)': the property's ORIGINAL acquisition price for a refinance, NOT the assignment underlying (owner-directed 2026-07-12)
  // Dedicated "Contract assignment" fields (owner-directed 2026-07-12): the
  // assignment data maps to these, NOT to originalPurchase. Checkbox = is an
  // assignment; flip fee = amount added ON TOP of the underlying seller price;
  // underlying = the seller's contract price. All bidirectional.
  contractAssignChecked:    '40dec3f5-6245-422b-a49b-983d3cfe9a43', // checkbox 'Contract assignment'
  contractAssignFee:        '273c41d1-10ee-4b02-aa74-7007f8023574', // currency 'Contract assignment/flip fee'
  contractAssignUnderlying: 'de81ad3e-572e-4e83-b9d9-c284400c9df1', // currency 'Contract assignment underlying purchase price'
  acquisitionDate:    'dd703e85-247e-4b3b-9664-f73c4877162c', // date
  card:               '684c900f-9e5a-4e73-9115-f2bebb9783b6', // short_text (appraisal card)
  depositReceived:    'b0e894cc-7551-4e2b-85ea-50aadc6a1de0', // drop_down
  loanOfficerPhone:   '94026464-bca6-4414-9a9c-f9e238d0533a', // phone
  processorEmail:     '4f7b2c03-44da-47a5-8d4c-c0aa823b1283', // email
  underwriterEmail:   '951c3a1d-05c5-4387-8203-1e2b8d0d329c', // email
  // Additional staff-workflow fields (pull-only, live-verified) — richer file data.
  actualRate:         'cf4fd648-efe9-47fc-b547-f166978d97de', // short_text (Actual Intrest Rate)
  desiredRate:        'bf47a4c9-3489-48b2-b4c3-531ca417ec3f', // short_text (Desired Intrest Rate)
  propertyTaxes:      '5e4ed4c7-6425-4f3b-974b-11df2252a45b', // currency
  propertyInsurance:  '941037c6-d0f4-437e-b339-fb7657214fdc', // currency
  propertyHoa:        '69d5d460-728a-4f25-9a58-571a4269b8e8', // currency
  rentalIncome:       '6d7bf524-c33d-4322-a9d7-47c3fc66a427', // currency
  prepaymentPenalty:  'a7a92ef5-0011-49bf-9009-625064e6007e', // drop_down (free label)
  titleCompany:       '2c734172-ea63-40b4-b151-aca9cab05969', // short_text (Desired Title Company)
  insuranceCompany:   'dc0b20e7-6b7b-462c-acaf-e9fecb8e84c9', // short_text
  firstLien:          '43d93738-5d9b-40ea-a2d0-db34ff97576b', // currency
  secondLien:         '2c156e2b-9b58-4145-9f3a-fac4642fd79f', // currency
  appraisedRentalValue:'b9cf2bbd-54be-4235-8d14-4387b16aa601',// currency (Actual Appraised Rental Value)
  approxAppraisedRentalValue:'90cb717f-13be-4a13-944b-21a3026c105f', // currency (Approximate Appraised Rental Value)
  cdaValue:           'c80b6083-7e47-4608-87a5-9c04126d3007', // currency
  appraiserName:      '53716901-832d-4e9a-a819-a2124800bb10', // short_text
  titleCompanyContact:'252cd875-adfa-4344-89e0-bdd1f0347d91', // email (Title Company Contact)
  insuranceCompanyContact:'0627751b-c206-4bbf-bd3e-943a99481fa8', // short_text (Insurance Company Contact Info)
  applicationSubmitted:'e1c2b5d7-14f4-47fe-98a5-13d733029f23', // drop_down (YES/NO/NOT YET)
};
// Deposit Received option: "Customer credit card used" (reusable card auto-fill).
const DEPOSIT_CARD_USED_OPT = 'f92f21c6-c5c3-4e85-986d-102a5e15ed71';

// New dropdown OPTION ids added to existing fields for this build.
const NEW_OPTIONS = {
  programGroundUp:      '137b2bb7-b81b-48cb-a03e-4df92945b106', // *Program
  propertyCondo:        '37837896-111e-42de-a208-00ce4ed678f4', // *Property Type
  propertyTownhouse:    '5a07ddd9-7d9d-4959-91b6-8392807be24f', // *Property Type
};

module.exports = {
  SPACES, SHARED, CRM, PIPELINE, CHECKLIST, SYNC, EXTRA,
  BORROWER_PORTAL_STATUS_OPT, NEW_OPTIONS, DEPOSIT_CARD_USED_OPT,
};
