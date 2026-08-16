'use strict';
/**
 * LENDER PRICE searchRaw FIELD REGISTRY.
 *
 * A declarative map of scenario field -> exact upstream request path/token, applied onto the cloned
 * default-search model. This is the anti-"silent substitution" layer: a field is EITHER implemented
 * here (and its exact upstream path/token is applied) OR it is rejected by the route (422). Nothing
 * is silently ignored.
 *
 * TOKENS: the exact upstream tokens/paths below are from the field-implementation audit
 * (reverse-engineered from the company Quick Pricer bundle + its captured rule mappings). SMO ids
 * are deliberately NOT hardcoded — the request carries dynaToSmo:true, so Lender Price resolves the
 * special-mortgage-options from these raw dynamic fields against the company's live registry. Where
 * the audit flagged a token as version-inconsistent (reserves, income-doc, citizenship ITIN
 * variants, occupancy Primary/Second, non-Conventional mortgage types, ARM, non-standard loan
 * purposes), the field is left OUT of the registry (so the route rejects it) until a one-field
 * frontend capture confirms the current-tenant token — never guessed.
 *
 * Pure + offline. LT-only; no RTL imports.
 */

// STRICT numeric parse (audit — advanced numbers were too permissive): the old
// `replace(/[^0-9.\-]/g,'')` turned "12abc3" into 123 and priced it. Now a value that is not a plain
// number (after stripping only currency formatting) returns null → the caller records a warning → the
// route 422s it, instead of silently substituting a corrupted figure. Mirrors search-model.strictNum.
function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).trim();
  if (/^-?\d*\.?\d+$/.test(s)) return parseFloat(s);
  const cleaned = s.replace(/[$,%\s]/g, '');
  if (/^-?\d*\.?\d+$/.test(cleaned)) return parseFloat(cleaned);
  return null;
}
function setDyn(m, fieldId, value) {
  if (value === undefined) return;
  const dp = m.dynamicPropertiesMap || (m.dynamicPropertiesMap = {});
  if (dp[fieldId] && typeof dp[fieldId] === 'object') dp[fieldId].value = value;
  else dp[fieldId] = { fieldId, value };
}

// Full property-type enum map (audit §17.1 — exact upstream `property.propertyType` values from the
// bundle). Some types also set nonWarrantableProject / a condo-type dynamic / a default unit count.
const PROPERTY_TYPES = {
  SingleFamily: { propertyType: 'SingleFamily', attachmentType: 'Detached', units: 1 },
  PUD: { propertyType: 'PlannedUnitDevelopment', attachmentType: 'Attached', units: 1 },
  PlannedUnitDevelopment: { propertyType: 'PlannedUnitDevelopment', attachmentType: 'Attached', units: 1 },
  Unit2_4: { propertyType: 'UnitDwelling_2_4', attachmentType: 'Attached', units: 2 },
  UnitDwelling_2_4: { propertyType: 'UnitDwelling_2_4', attachmentType: 'Attached', units: 2 },
  // §33.1/§34.2 — the exact ON-SCREEN dropdown LABEL "2 - 4 Unit" (and its de-spaced form) must
  // normalize to UnitDwelling_2_4; the label was previously not an accepted alias, so a caller
  // echoing the UI label was 422'd. Adding it here also makes the units-conflict check (which routes
  // through resolvePropertyType) enforce the 2–4 range for the label.
  '2 - 4 Unit': { propertyType: 'UnitDwelling_2_4', attachmentType: 'Attached', units: 2 },
  '2-4 Unit': { propertyType: 'UnitDwelling_2_4', attachmentType: 'Attached', units: 2 },
  Modular: { propertyType: 'Modular', attachmentType: 'Detached', units: 1 },
  Townhouse: { propertyType: 'Townhouse', attachmentType: 'Attached', units: 1 },
  Condo: { propertyType: 'Condos', attachmentType: 'Attached', units: 1 },
  Condos: { propertyType: 'Condos', attachmentType: 'Attached', units: 1 },
  CondoWarr: { propertyType: 'Condos', attachmentType: 'Attached', units: 1 },
  CondoNonWarr: { propertyType: 'Condos', attachmentType: 'Attached', units: 1, nonWarrantableProject: true },
  DetachedCondominium: { propertyType: 'DetachedCondominium', attachmentType: 'Detached', units: 1 },
  HighRiseCondo: { propertyType: 'HighRiseCondo', attachmentType: 'Attached', units: 1 },
  SiteCondo: { propertyType: 'SiteCondo', attachmentType: 'Detached', units: 1 },
  // §33.1 — the current-tenant condo sub-types confirmed by live one-field capture. The exact
  // upstream property.propertyType token IS the label, and each auto-minimums to 1 unit. Attachment
  // is NOT captured per condo sub-type (it is an independent field — §34.2 P1); the confirmed live
  // behavior is that a property-only selection RETAINS the profile default Detached (§33.1/§34.4),
  // so these inherit Detached and stay overridable via sc.attachment. Do NOT copy the older condo
  // rows' guessed 'Attached' (flagged as a defect the live capture contradicts).
  CondoGarden: { propertyType: 'CondoGarden', attachmentType: 'Detached', units: 1 },
  MidRiseCondo: { propertyType: 'MidRiseCondo', attachmentType: 'Detached', units: 1 },
  // §33.1/§17.2 — selecting CondoTel in the live UI AUTOMATICALLY checks Non-Warrantable Condo and
  // adds its SMO, so the confirmed request carries nonWarrantableProject:true alongside the distinct
  // CondoTel property token (NOT a collapse to generic Condos+nonWarrantable). dynaToSmo resolves the
  // Non-Warrantable Condo SMO from that flag against the live registry.
  CondoTel: { propertyType: 'CondoTel', attachmentType: 'Detached', units: 1, nonWarrantableProject: true },
  Cooperative: { propertyType: 'Cooperative', attachmentType: 'Attached', units: 1 },
  MultiFamily: { propertyType: 'MultiFamily', attachmentType: 'Attached', units: 5 },
  ManufacturedHousing: { propertyType: 'ManufacturedHousing', attachmentType: 'Detached', units: 1 },
  ManufacturedHousingDoubleWide: { propertyType: 'ManufacturedHousingDoubleWide', attachmentType: 'Detached', units: 1 },
  ManufacturedHousingSingleWide: { propertyType: 'ManufacturedHousingSingleWide', attachmentType: 'Detached', units: 1 },
  ManufacturedHousingMultiWide: { propertyType: 'ManufacturedHousingMultiWide', attachmentType: 'Detached', units: 1 },
  // §33.1 — the plain ManufacturedHomeCondominium token (distinct from the longer …OrPUDOrCooperative
  // combined token), confirmed by live capture; auto-minimums to 1 unit.
  ManufacturedHomeCondominium: { propertyType: 'ManufacturedHomeCondominium', attachmentType: 'Detached', units: 1 },
  ManufacturedHomeCondominiumOrPUDOrCooperative: { propertyType: 'ManufacturedHomeCondominiumOrPUDOrCooperative', attachmentType: 'Attached', units: 1 },
};
function resolvePropertyType(t) { return PROPERTY_TYPES[t] || null; }

// §33.2 — INCOME DOCUMENTATION. The complete current-tenant IncomeDocType menu from the confirmed
// one-field capture: the on-screen LABEL on the left, the EXACT upstream token on the right. They
// disagree often enough that neither can be derived from the other ("WVOE" transmits as "VOEOnly";
// "12 Mo Alt Doc" as "AltDoc12Months"; "24Mo Tax Prepared PL" as "24MonthTaxPreparedPL" — Mo vs
// Month — while "24Mo CPA Prepared PL" stays "24MoCPAPreparedPL"). So this is a reviewed lookup, NOT
// a formatter: never generate one of these tokens from the label. A caller may pass either the label
// or the token; anything else is rejected (the route 422s) rather than priced as the DSCR default.
const INCOME_DOC_TYPES = {
  'Full Doc - 24M': 'Full Doc - 24M',
  'Full Doc - 12M': 'Full Doc - 12M',
  DSCR: 'DSCR',
  '24Mo Personal Bank Statements': '24MoPersonalBankStatements',
  '24Mo Business Bank Statements': '24MoBusinessBankStatements',
  '12MoPersonalBankStatements': '12MoPersonalBankStatements',
  '12Mo Business Bank Statements': '12MoBusinessBankStatements',
  'Community - No income/No employment/No DTI': 'Community - No income/No employment/No DTI',
  '24Mo CPA Prepared PL': '24MoCPAPreparedPL',
  '24Mo Tax Prepared PL': '24MonthTaxPreparedPL',
  '24MoCPAPreparedPLwBKStmt': '24MoCPAPreparedPLwBKStmt',
  '24Mo Tax Prepared PLwBkStmt': '24MonthTaxPreparedPLwBkStmt',
  '12Mo CPA Prepared PL': '12MoCPAPreparedPL',
  '12Mo Tax Prepared PL': '12MonthTaxPreparedPL',
  '12Mo CPA Prepared PLwBKStmt': '12MoCPAPreparedPLwBKStmt',
  '12Mo Tax Prepared PLwBKStmt': '12MonthTaxPreparedPLwBKStmt',
  '1YrTaxReturn': '1YrTaxReturn',
  '12 Mo Alt Doc': 'AltDoc12Months',
  '24 Mo Alt Doc': 'AltDoc24Months',
  'Asset Utilization': 'Asset Utilization',
  AssetQualifier: 'AssetQualifier',
  AssetDepletion: 'AssetDepletion',
  '1099 - 24M': '1099 - 24M',
  '1099 - 12M': '1099 - 12M',
  WVOE: 'VOEOnly',
};
// Accept the exact upstream TOKEN as well as the label (a caller replaying a captured request sends
// the token). Returns the token, or null when unrecognized — never a guess.
const INCOME_DOC_TOKENS = new Set(Object.values(INCOME_DOC_TYPES));
function mapIncomeDocType(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  if (Object.prototype.hasOwnProperty.call(INCOME_DOC_TYPES, s)) return INCOME_DOC_TYPES[s];
  return INCOME_DOC_TOKENS.has(s) ? s : null;
}

// §33.3 — PREPAYMENT STRUCTURE (dynamicPropertiesMap.PrePayment_Plan_Type). Confirmed one-field
// capture. NOTE "No Prepay" transmits a NULL plan value — which is NOT the same operation as
// selecting PrepayTerm "None" (that produces the No PPP SMO), so term and structure stay independent
// inputs. The DECLARED_NULL sentinel distinguishes "this structure is a real choice whose token is
// null" from "unrecognized" so a caller can select No Prepay explicitly.
const PREPAY_STRUCTURE_NULL = Symbol('prepay.noPrepay');
const PREPAY_STRUCTURES = {
  Standard: 'Standard',
  'No Prepay': PREPAY_STRUCTURE_NULL,
  'Fixed 5%': 'Fixed5',
  'Fixed 4%': 'Fixed4',
  'Fixed 3%': 'Fixed3',
  'Fixed 2%': 'Fixed2',
  'Fixed 1%': 'Fixed1',
  '5,4,3,3,3': '54333',
  '5,4,3,2,1': '54321',
  '5,4,3,3': '5433',
  '5,4,3,2': '5432',
  '4,3,2,1': '4321',
  '5,4,3': '543',
  '3,2,1': '321',
  '5,4': '54',
  '2,1': '21',
  '6 Months Interest': '6MosInt',
  'Step Down': 'StepDown',
  Other: 'Other',
};
const PREPAY_STRUCTURE_TOKENS = new Set(Object.values(PREPAY_STRUCTURES).filter((v) => typeof v === 'string'));
// Returns the token string, PREPAY_STRUCTURE_NULL for the explicit No-Prepay choice, or null when
// unrecognized. The caller must test against PREPAY_STRUCTURE_NULL before truthiness.
function mapPrepayStructure(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  if (Object.prototype.hasOwnProperty.call(PREPAY_STRUCTURES, s)) return PREPAY_STRUCTURES[s];
  return PREPAY_STRUCTURE_TOKENS.has(s) ? s : null;
}

// §33.4 — BORROWER TYPE (dynamicPropertiesMap.GLOBAL_BorrowerType). The exact six-value tenant enum.
// This was previously passed through UNVALIDATED, so an arbitrary string travelled upstream as a
// vesting type (audit §34.2 P1). The DSCR profile default is LLC.
const BORROWER_TYPES = new Set(['Individual', 'Corporation', 'Partnership', 'Trust', 'Non-Profit', 'LLC']);

// Adverse-credit / borrower dynamic fields — exact upstream keys + tokens from the audit
// (§13–§16). Values are validated against the audit's token sets; dynaToSmo resolves the SMOs.
// §33.4 — CITIZENSHIP. The complete seven-value tenant menu from the confirmed capture. The two
// combined foreign-national values carry a TRAILING ")" with no opening bracket — a real, current
// vendor spelling, NOT a typo of ours. Do NOT "clean" them: a lender rule matches the stored token,
// so a tidier spelling would silently fail to match. They are transmitted verbatim.
const CITIZENSHIP = new Set(['US Citizen', 'Perm Resident', 'Non-Perm Resident', 'Foreign National',
  'ForeignNationalwithITIN)', 'ForeignNationalnoITIN)', 'ITIN']);
const TRADELINES = new Set(['Limited', '2 for 24+ Months', '3 for 12+ Months']);
const BK_CHAPTER = new Set(['Chapter 7', 'Chapter 11', 'Chapter 13']);
const BK_STATUS = new Set(['Open', 'Discharged', 'Dismissed']);
const BK_SEASONING = new Set(['Never', 'Settled', '< 2 Years', '2-4 Years', '< 3 years', '< 4 Years', '4-7 Years', '7+ Years']);
const FORECLOSURE = new Set(['FC_Settle', 'FC_1yr', 'FC_2yr', 'FC_3yr', 'FC_4yr', 'FC_5yr', 'FC_7yr']);
const SHORTSALE = new Set(['SS_Set', 'SS_1yr', 'SS_2yr', 'SS_3yr', 'SS_4yr', 'SS_5yr', 'SS_7yr']);
const DEEDINLIEU = new Set(['DIL_Set', 'DIL_1yr', 'DIL_2yr', 'DIL_3yr', 'DIL_4yr', 'DIL_5yr', 'DIL_7yr']);
const CHARGEOFF = new Set(['MLCO2yr', 'MLCO4yr', 'MLCOSet']);
const FORBEARANCE = new Set(['Forbear3mo', 'Forbear6mo', 'ForbearOver18mo']);
const LATE_COUNT = new Set(['0', '1', '2', '3', '4+']);
const COMP_TYPE = { BorrowerPaid: 'BorrowerCompPlan', LenderPaid: 'LenderCompPlan', BorrowerCompPlan: 'BorrowerCompPlan', LenderCompPlan: 'LenderCompPlan' };

// Apply the registry-backed fields onto the model `m`. Returns { warnings } — a field with an
// invalid enum value is recorded as a warning and NOT applied (the route can surface it); the
// core builder already handled the base fields, so this only adds the registry extensions.
function applyRegistry(m, sc) {
  const warnings = [];
  const c = m.criteria || (m.criteria = {});
  const bad = (field, value, allowed) => warnings.push({ field, value, message: `invalid ${field} — expected one of: ${Array.from(allowed).join(', ')}` });
  // A present-but-unparseable numeric must NOT be silently dropped (that is the silent-substitution
  // class): warn so the route 422s it. A missing/blank value is simply not applied (no warning).
  const numField = (field, raw, apply, opts = {}) => {
    if (raw == null || raw === '') return;
    const v = num(raw);
    if (v == null) { warnings.push({ field, value: raw, message: `invalid ${field} — expected a number` }); return; }
    if (opts.integer && !Number.isInteger(v)) { warnings.push({ field, value: raw, message: `invalid ${field} — expected a whole number` }); return; }
    if (opts.min != null && v < opts.min) { warnings.push({ field, value: raw, message: `invalid ${field} — must be at least ${opts.min}` }); return; }
    if (opts.max != null && v > opts.max) { warnings.push({ field, value: raw, message: `invalid ${field} — must be at most ${opts.max}` }); return; }
    apply(v);
  };
  // Reject unknown sub-keys of a nested object rather than silently ignore them.
  const checkKeys = (field, obj, allowed) => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) if (!allowed.has(k)) warnings.push({ field: `${field}.${k}`, value: obj[k], message: `unknown ${field} field "${k}" — allowed: ${Array.from(allowed).join(', ')}` });
  };

  // --- borrower (criteria paths) ---
  if (sc.selfEmployed != null) c.selfEmployed = !!sc.selfEmployed;
  // Advanced numerics now carry integer/range validation (audit): a malformed or out-of-range figure
  // is a warning → the route 422s it, rather than being coerced and priced.
  numField('financedProperties', sc.financedProperties, (v) => { c.ownProperties = String(v); }, { integer: true, min: 0, max: 100 });
  numField('numberOfBorrowers', sc.numberOfBorrowers, (v) => { c.numberOfBorrower = v; }, { integer: true, min: 1, max: 10 });
  numField('monthlyIncome', sc.monthlyIncome, (v) => { c.monthlyIncome = v; }, { min: 0, max: 1e9 });
  numField('monthlyDebt', sc.monthlyDebt, (v) => { c.monthlyDebt = v; }, { min: 0, max: 1e9 });
  numField('dti', sc.dti, (v) => { c.clientDti = v > 1 ? v / 100 : v; }, { min: 0, max: 100 });
  if (sc.compensationType != null) { const t = COMP_TYPE[sc.compensationType]; if (t) c.compensationType = t; else bad('compensationType', sc.compensationType, Object.keys(COMP_TYPE)); }
  if (sc.waiveLenderFee != null) c.lenderFeeWaiver = !!sc.waiveLenderFee;

  // --- property / collateral ---
  if (sc.rural != null) c.rural = !!sc.rural;
  // EXPLICIT-FALSE four-state (audit): omitted → inherit the live default; true → on; false → OFF.
  // Previously we only wrote the field when TRUE, so a live default of `true` survived an explicit
  // `false`. These are strict booleans (search-model BOOLEAN_FIELDS), so the value is a real boolean.
  // NOTE: `false` is sent as the off value; if a future capture shows the vendor's off token is
  // something else, change the representation here (one place).
  if (sc.mixedUse != null) setDyn(m, 'GLOBAL_MixedUse', !!sc.mixedUse);
  // Confirmed-token dynamic flags. Unlike GLOBAL_MixedUse (a JSON boolean value), these vendor flags
  // carry a STRING "true"/"false" value — a confirmed live quirk, so do NOT copy the boolean shape.
  // We ONLY ever send a token confirmed from a live capture (never a guessed off-token):
  //   • cross-collateral — BOTH "true" and "false" confirmed (§31.3), so a full tri-state: explicit
  //     true→"true", false→"false", omitted→inherit the live default.
  //   • first-time investor + living-rent-free — only "true" is confirmed (§31.7); the off-token was
  //     never captured, so an explicit `false` DOES NOT write a guessed token — it inherits the live
  //     default exactly like omission (a checkbox: checked→send confirmed "true", else inherit). When
  //     a capture confirms the off-token, add the `: 'false'` here in ONE place.
  // All three are strict booleans (search-model BOOLEAN_FIELDS), so a string like "false" is 422'd
  // upstream and never reaches here.
  if (sc.crossCollateral != null) setDyn(m, 'GLOBAL_Cross_Collateralization_Product', sc.crossCollateral ? 'true' : 'false');
  if (sc.firstTimeInvestor === true) setDyn(m, 'FirstTimeInvestor', 'true');
  if (sc.livingRentFree === true) setDyn(m, 'Global_Living_Rent_Free', 'true');
  // §31.3 — DSCR WITH ASSET DEPLETION. The ON value is the confirmed live token "Yes" (NOT the string
  // "true" the sibling flags use — copying their shape here would be a guess). The OFF token was
  // never captured ("blank later serialized null/absence depending on UI state"), so an explicit
  // false INHERITS the live default exactly like omission, same as firstTimeInvestor above. When a
  // capture confirms the off value, add the else-branch in this ONE place.
  if (sc.dscrAssetDepletion === true) setDyn(m, 'Global_DSCR_Asset_Depletion', 'Yes');
  // §31.7 — the PARENT "late in the last 12 months" toggle, which the live UI sends ALONGSIDE the
  // per-bucket MORT*LATESLAST12M counts. Confirmed ON token "true"; the off token was not captured,
  // so an explicit false inherits. NOTE the 13-24 month parent toggle's field name was never
  // captured, so it is deliberately NOT wired — only its per-bucket counts are.
  if (sc.lateInLast12Months === true) setDyn(m, 'Lateinlast12months', 'true');

  // --- citizenship / tradelines ---
  if (sc.citizenship != null) { if (CITIZENSHIP.has(sc.citizenship)) setDyn(m, 'Citizenship', sc.citizenship); else bad('citizenship', sc.citizenship, CITIZENSHIP); }
  if (sc.tradelines != null && sc.tradelines !== '') { if (TRADELINES.has(sc.tradelines)) setDyn(m, 'Tradelines', sc.tradelines); else bad('tradelines', sc.tradelines, TRADELINES); }
  if (sc.noMortgageHistory != null) setDyn(m, 'GLOBAL_NoMortgageHistory', !!sc.noMortgageHistory);

  // --- bankruptcy (chapter/status/seasoning) ---
  // A present-but-WRONG-shape nested field is REJECTED, not silently ignored (audit): pricing without
  // a requested derogatory-credit history is dangerous.
  if (sc.bankruptcy && typeof sc.bankruptcy === 'object' && !Array.isArray(sc.bankruptcy)) {
    const b = sc.bankruptcy;
    checkKeys('bankruptcy', b, new Set(['chapter', 'status', 'seasoning']));
    if (b.chapter != null) { if (BK_CHAPTER.has(b.chapter)) setDyn(m, 'BankruptcyChapter', b.chapter); else bad('bankruptcy.chapter', b.chapter, BK_CHAPTER); }
    if (b.status != null) { if (BK_STATUS.has(b.status)) setDyn(m, 'BankruptcyStatus', b.status); else bad('bankruptcy.status', b.status, BK_STATUS); }
    if (b.seasoning != null) { if (BK_SEASONING.has(b.seasoning)) setDyn(m, 'BankruptcySeasoning', b.seasoning); else bad('bankruptcy.seasoning', b.seasoning, BK_SEASONING); }
  } else if (sc.bankruptcy != null && sc.bankruptcy !== '') {
    warnings.push({ field: 'bankruptcy', value: sc.bankruptcy, message: 'bankruptcy must be an object { chapter, status, seasoning } — a string or other shape is rejected, not ignored, because pricing without the requested bankruptcy history is dangerous' });
  }

  // --- mortgage lates (8 buckets: 30/60/90/120 × last-12 / months-13–24) ---
  if (sc.mortgageLates && typeof sc.mortgageLates === 'object' && !Array.isArray(sc.mortgageLates)) {
    checkKeys('mortgageLates', sc.mortgageLates, new Set(['last12', 'months13To24']));
    const applyBucket = (obj, window, suffix) => {
      if (!obj || typeof obj !== 'object') return;
      checkKeys(`mortgageLates.${window}`, obj, new Set(['30', '60', '90', '120']));
      for (const sev of ['30', '60', '90', '120']) {
        if (obj[sev] == null) continue;
        const v = String(obj[sev]);
        if (LATE_COUNT.has(v)) setDyn(m, `MORT${sev}LATESLAST${suffix}`, v);
        else bad(`mortgageLates.${window}.${sev}`, v, LATE_COUNT);
      }
    };
    applyBucket(sc.mortgageLates.last12, 'last12', '12M');
    applyBucket(sc.mortgageLates.months13To24, 'months13To24', '24M');
  } else if (sc.mortgageLates != null && sc.mortgageLates !== '') {
    warnings.push({ field: 'mortgageLates', value: sc.mortgageLates, message: 'mortgageLates must be an object { last12, months13To24 } — a string or other shape is rejected, not ignored' });
  }

  // --- derogatory-event seasoning (foreclosure / short sale / deed-in-lieu / charge-off / forbearance) ---
  if (sc.foreclosure != null && sc.foreclosure !== '') { if (FORECLOSURE.has(sc.foreclosure)) setDyn(m, 'Global_FORECLOSURES', sc.foreclosure); else bad('foreclosure', sc.foreclosure, FORECLOSURE); }
  if (sc.shortSale != null && sc.shortSale !== '') { if (SHORTSALE.has(sc.shortSale)) setDyn(m, 'Global_SHORTSALES', sc.shortSale); else bad('shortSale', sc.shortSale, SHORTSALE); }
  if (sc.deedInLieu != null && sc.deedInLieu !== '') { if (DEEDINLIEU.has(sc.deedInLieu)) setDyn(m, 'Global_DEEDINLIEU', sc.deedInLieu); else bad('deedInLieu', sc.deedInLieu, DEEDINLIEU); }
  if (sc.chargeOff != null && sc.chargeOff !== '') { if (CHARGEOFF.has(sc.chargeOff)) setDyn(m, 'GLOBAL_MortgageLoanChargeOffs', sc.chargeOff); else bad('chargeOff', sc.chargeOff, CHARGEOFF); }
  if (sc.forbearance != null && sc.forbearance !== '') { if (FORBEARANCE.has(sc.forbearance)) setDyn(m, 'GLOBAL_Forbearances', sc.forbearance); else bad('forbearance', sc.forbearance, FORBEARANCE); }

  return { warnings };
}

// The scenario keys the registry implements (added to the route's supported set). Nested-object
// fields (bankruptcy, mortgageLates) are validated by shape inside applyRegistry.
const REGISTRY_FIELDS = [
  'selfEmployed', 'financedProperties', 'numberOfBorrowers', 'monthlyIncome', 'monthlyDebt', 'dti',
  'compensationType', 'waiveLenderFee', 'rural', 'mixedUse', 'citizenship', 'tradelines',
  'noMortgageHistory', 'bankruptcy', 'mortgageLates', 'foreclosure', 'shortSale', 'deedInLieu',
  'chargeOff', 'forbearance', 'crossCollateral', 'firstTimeInvestor', 'livingRentFree',
  'dscrAssetDepletion', 'lateInLast12Months',
];

module.exports = { applyRegistry, resolvePropertyType, PROPERTY_TYPES, REGISTRY_FIELDS,
  mapIncomeDocType, INCOME_DOC_TYPES,
  mapPrepayStructure, PREPAY_STRUCTURES, PREPAY_STRUCTURE_NULL,
  BORROWER_TYPES,
  _tokens: { CITIZENSHIP, TRADELINES, BK_CHAPTER, BK_STATUS, BK_SEASONING, FORECLOSURE, SHORTSALE, DEEDINLIEU, CHARGEOFF, FORBEARANCE, LATE_COUNT, COMP_TYPE } };
