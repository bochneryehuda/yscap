'use strict';
/**
 * Class Valuation revision / cancellation reason codes. PURE.
 *
 * Their `reasons[].reasonType` is a CLOSED list (guide pp.40-42), shared by
 * `request-revision` and `request-cancel`. Transcribed here verbatim and in their
 * order, for the same reason every other Class enum is: so the screen offers exactly
 * what they accept and the builder can never send a value they will reject.
 *
 * NOT VERSION-SPECIFIC. Unlike ordering, the revision endpoint has no `/v2` variant —
 * one path, one reason list, both UAD versions. See db/491.
 *
 * ── THERE IS NO "ROV" ENDPOINT, AND THAT IS THE IMPORTANT THING HERE ────────────
 *
 * A reconsideration of value is not a separate call at Class. It is a REVISION whose
 * reason is one of the value-related codes — which is why `ROV` below is a subset of
 * the same list rather than a vocabulary of our own. Inventing an endpoint, or
 * inventing a reason code that reads better in English, would produce a request they
 * reject; picking a vaguely-related code so the call succeeds would produce a
 * revision that reads as something else entirely to the appraiser working it.
 */

// The full closed list, verbatim (guide pp.40-42). Order is theirs.
const REASON_TYPES = [
  'Other',
  'AdjustmentsExpandCommentary', 'AdjustmentsLackOfAdjustments', 'AdjustmentsWrongDirection',
  'CSError',
  'Docs203KBids', 'DocsArmsLengthNonArmsLength', 'DocsFHAConnectionSheet', 'DocsFloodCert',
  'DocsManufacturedHUDData', 'DocsParcelLegal', 'DocsPurchasePriceSellerConcessions',
  'DocsRETaxes', 'DocsSolarPanels', 'DocsSurvey', 'DocsTitleWork',
  'EffectOnMarketability', 'ExpandCommentaryGeneral', 'ExpandCommentaryUSPAPConcerns',
  'FHA203K', 'FHAAirportFreewayRailroadCommercialBuidlingsETC', 'FHAAppliances',
  'FHAAtticCrawlSpaceConcerns', 'FHAIntendedUser', 'FHAMeetsOrWillMeet40001Guidelines',
  'FHAUtilities', 'FHAWaterSewerConnectionOrWellSepticDistances',
  'HardstopConcernsSSRsEADBeingRejected',
  'HealthSafetyStateRequirementsCOSmokeDetectors', 'HealthSafetyStateRequirementsCostToCure',
  'HealthSafetyStateRequirementsDoubleStrappedWaterHeater',
  'HealthSafetyStateRequirementsFHAAndConventional',
  'HealthSafetyStateRequirementsIngressEgressConcerns',
  'HOANumberOfUnits', 'HOALitigation', 'HOAPrivateRoadsCommentary', 'HOAPUDRequests',
  'HOADuesMonthlyYearly',
  'LenderSpecificReviewClientsEngagementLetter', 'Maps',
  'MissingDataFromReportandMissingAMC2161007ETC',
  'MissingDatafromReportandMissingAMCAppraiserLicense',
  'MissingDataFromReportAndMissingAMCBlankPages',
  'MissingDatafromreportandMissingAMCSignaturePage',
  'OrderDetailsAssignmentTypeConcerns', 'OrderDetailsBorrowerName',
  'OrderDetailsEffectiveSignatureDateConcerns', 'OrderDetailsITPLenderUpdateRequest',
  'OrderDetailsMissingOrderedFormsRevisions', 'OrderDetailsPropertyAddress',
  'OrderDetailsWrongReport',
  'PerAppraisersRequest',
  'PhotosandMLSphotosFHAMLSphotos', 'PhotosandMLSphotosgeneric',
  'PhotosandMLSphotossketchcorrections',
  'ReconciliationConcerns203K', 'ReconciliationConcernsAddAdditionalClosedSaleListing',
  'ReconciliationConcernsAlternativeSales', 'ReconciliationConcernsCostApproach',
  'ReconciliationConcernsInspectionConcerns', 'ReconciliationConcernsRemainingEconomicLife',
  'ReconciliationConcernsSubjectToConcerns', 'ReconciliationConcernsValueRelatedConcerns',
  'SiteSubjectDetailConcernsAccessoryUnitConcerns', 'SiteSubjectDetailConcernsAdverseSiteConditions',
  'SiteSubjectDetailConcernsAttachDetach', 'SiteSubjectDetailConcernsDAIRConcerns',
  'SiteSubjectDetailConcernsDimensions', 'SiteSubjectDetailConcernsDoesNeighborhoodConform',
  'SiteSubjectDetailConcernsGLABedBathConcerns', 'SiteSubjectDetailConcernsHighestBestUse',
  'SiteSubjectDetailConcernsIncorrectOccupancy', 'SiteSubjectDetailConcernsMarketConditions',
  'SiteSubjectDetailConcernsNeighborhoodBoundaries', 'SiteSubjectDetailConcernsPredominateValue',
  'SiteSubjectDetailConcernsPresentLandUse', 'SiteSubjectDetailConcernsPropertyOfferedforSale',
  'SiteSubjectDetailConcernsPropertyRebuiltifDestroyed',
  'SiteSubjectDetailConcernsRETaxesandAssessments',
  'SiteSubjectDetailConcernsSubjectFloodInformation', 'SiteSubjectDetailConcernsVerifyUtilities',
  'SiteDetailConcernsYearBuiltConcerns', 'SiteSubjectDetailConcernsZoningConcerns',
  'VariationsPublicorCountyRecordsAccessoryUnit', 'VariationsPublicorCountyRecordsBedBathCount',
  'VariationsPublicorCountyRecordsConditionQualityRatings',
  'VariationsPublicorCountyRecordsGeocodes',
  'VariationsPublicorCountyRecordsPublicRecordsdifferfromreport',
  // The tail of their list is cancellation-shaped rather than revision-shaped. It is
  // the SAME enum — both endpoints take it — but offering "the borrower withdrew" as
  // a reason to revise a report would be nonsense, so `forKind` separates them below.
  'AssignedToAnotherProvider', 'BorrowerNotAvailable', 'BorrowerWithdrewLoanApplication',
  'ClientRequestedCancellation', 'SubjectPropertyRepairsAreIncomplete',
  'UnknownReasonForCancellation', 'UpgradedToAnotherService',
];
const VALID = new Set(REASON_TYPES);

// The codes that make an ask a RECONSIDERATION OF VALUE rather than a correction.
// Every one is from their list above; this is a lens on it, never a second list.
const ROV = [
  'ReconciliationConcernsValueRelatedConcerns',
  'ReconciliationConcernsAddAdditionalClosedSaleListing',
  'ReconciliationConcernsAlternativeSales',
  'ReconciliationConcernsCostApproach',
  'SiteSubjectDetailConcernsPredominateValue',
  'SiteSubjectDetailConcernsMarketConditions',
  'AdjustmentsLackOfAdjustments',
  'AdjustmentsWrongDirection',
  'AdjustmentsExpandCommentary',
];
const ROV_SET = new Set(ROV);

// The cancellation-shaped tail.
const CANCEL = [
  'ClientRequestedCancellation', 'BorrowerWithdrewLoanApplication', 'BorrowerNotAvailable',
  'SubjectPropertyRepairsAreIncomplete', 'AssignedToAnotherProvider', 'UpgradedToAnotherService',
  'UnknownReasonForCancellation', 'Other',
];
const CANCEL_SET = new Set(CANCEL);

// Plain English for the codes a lending desk actually reaches for. Anything without
// an entry falls back to its code split on capitals — readable, and honest about the
// fact that it is their word, not ours.
const LABELS = {
  ReconciliationConcernsValueRelatedConcerns: 'We disagree with the value',
  ReconciliationConcernsAddAdditionalClosedSaleListing: 'Please consider these additional sales',
  ReconciliationConcernsAlternativeSales: 'Please consider different comparable sales',
  ReconciliationConcernsCostApproach: 'Concerns with the cost approach',
  AdjustmentsLackOfAdjustments: 'Adjustments are missing',
  AdjustmentsWrongDirection: 'An adjustment goes the wrong way',
  AdjustmentsExpandCommentary: 'Please explain the adjustments',
  SiteSubjectDetailConcernsGLABedBathConcerns: 'Square footage / bed / bath looks wrong',
  SiteSubjectDetailConcernsIncorrectOccupancy: 'The occupancy is wrong',
  SiteSubjectDetailConcernsZoningConcerns: 'Zoning concerns',
  SiteSubjectDetailConcernsSubjectFloodInformation: 'Flood information',
  SiteDetailConcernsYearBuiltConcerns: 'The year built looks wrong',
  OrderDetailsPropertyAddress: 'The property address is wrong',
  OrderDetailsBorrowerName: 'The borrower name is wrong',
  OrderDetailsWrongReport: 'This is the wrong report',
  OrderDetailsMissingOrderedFormsRevisions: 'A form we ordered is missing',
  MissingDatafromreportandMissingAMCSignaturePage: 'The signature page is missing',
  MissingDataFromReportAndMissingAMCBlankPages: 'The report has blank pages',
  PhotosandMLSphotosgeneric: 'Photo problems',
  PhotosandMLSphotossketchcorrections: 'The sketch needs correcting',
  ExpandCommentaryGeneral: 'Please expand the commentary',
  ReconciliationConcernsSubjectToConcerns: 'Subject-to / as-repaired concerns',
  ReconciliationConcernsInspectionConcerns: 'Inspection concerns',
  ClientRequestedCancellation: 'We are cancelling this order',
  BorrowerWithdrewLoanApplication: 'The borrower withdrew',
  BorrowerNotAvailable: 'We could not reach the borrower',
  SubjectPropertyRepairsAreIncomplete: 'The repairs are not finished',
  Other: 'Something else (explain below)',
};

function labelFor(code) {
  if (LABELS[code]) return LABELS[code];
  // TWO rules, not one. Splitting only on lower→UPPER leaves their many acronym
  // prefixes glued to the next word ("HOAPrivate Roads"), so a run of capitals
  // followed by a capitalised word is split first — HOA / FHA / GLA / USPAP all read
  // correctly, and the acronym itself is never broken up.
  return String(code || '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ').trim() || String(code || '');
}

/**
 * The reasons worth OFFERING for a given kind of ask. Their list is ~90 codes long
 * and mostly FHA/GSE-specific — a business-purpose RTL desk will never use most of
 * it. So the screen leads with the ones that fit, and `all` is still there for the
 * case nobody anticipated. It is a presentation choice, never a restriction: the
 * validator below accepts any code on their real list.
 */
function forKind(kind) {
  if (kind === 'cancel') return { common: CANCEL, all: REASON_TYPES };
  if (kind === 'rov') return { common: ROV, all: REASON_TYPES };
  const common = [
    'ReconciliationConcernsValueRelatedConcerns',
    'SiteSubjectDetailConcernsGLABedBathConcerns',
    'SiteDetailConcernsYearBuiltConcerns',
    'OrderDetailsPropertyAddress',
    'OrderDetailsBorrowerName',
    'OrderDetailsWrongReport',
    'OrderDetailsMissingOrderedFormsRevisions',
    'MissingDatafromreportandMissingAMCSignaturePage',
    'MissingDataFromReportAndMissingAMCBlankPages',
    'PhotosandMLSphotosgeneric',
    'PhotosandMLSphotossketchcorrections',
    'ExpandCommentaryGeneral',
    'ReconciliationConcernsSubjectToConcerns',
    'ReconciliationConcernsInspectionConcerns',
    'SiteSubjectDetailConcernsIncorrectOccupancy',
    'SiteSubjectDetailConcernsZoningConcerns',
    'Other',
  ];
  // A cancellation reason on a revision would be nonsense — see the note above.
  return { common: common.filter((c) => !CANCEL_SET.has(c) || c === 'Other'), all: REASON_TYPES };
}

/**
 * Validate what the screen sent. Returns `{ reasons, problems }` — never throws, and
 * NEVER silently repairs: a code they do not publish is reported so the person can
 * pick a real one, because the alternative (dropping it, or nudging it to `Other`)
 * sends the appraiser an ask that is not the one anybody typed.
 */
function normalizeReasons(input, { kind = 'revision' } = {}) {
  const list = Array.isArray(input) ? input : (input ? [input] : []);
  const reasons = [];
  const problems = [];
  for (const raw of list) {
    const r = (raw && typeof raw === 'object') ? raw : { reasonType: raw };
    const code = String(r.reasonType == null ? '' : r.reasonType).trim();
    const text = String(r.reason == null ? '' : r.reason).trim();
    if (!code) { problems.push('A reason was sent with no code.'); continue; }
    if (!VALID.has(code)) { problems.push(`"${code}" is not a reason Class accepts.`); continue; }
    // Their `Other` means nothing on its own — the free text IS the reason.
    if (code === 'Other' && !text) { problems.push('Choosing "something else" needs an explanation.'); continue; }
    reasons.push({ reasonType: code, reason: text || labelFor(code) });
  }
  if (!reasons.length && !problems.length) problems.push('Pick at least one reason.');
  if (kind === 'rov' && reasons.length && !reasons.some((r) => ROV_SET.has(r.reasonType))) {
    problems.push('A reconsideration of value needs at least one value-related reason — otherwise it reads to the appraiser as an ordinary correction.');
  }
  return { reasons, problems };
}

// Does this set of reasons make the ask an ROV? Used to LABEL a revision that was
// filed with value reasons, so the two never have to be told apart by eye.
const looksLikeRov = (reasons) => (reasons || []).some((r) => ROV_SET.has(r && r.reasonType));

module.exports = {
  REASON_TYPES, ROV, CANCEL, LABELS,
  labelFor, forKind, normalizeReasons, looksLikeRov,
  isValid: (c) => VALID.has(String(c || '')),
};
