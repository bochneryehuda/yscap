/**
 * UAD 3.6 / MISMO 3.6 reader — pure assertions, no database, no network.
 *
 * Covers the three modules that make a redesigned URAR readable:
 *   `xml36.js`       the MISMO 3.x tokenizer + navigation
 *   `uad36-map.js`   the normalizers, the enum crosswalk and the path resolver
 *   `extract36.js`   the canonical object, which must match what the 2.6 reader returns
 *
 * The last one is the point of the whole exercise: a dozen modules downstream of
 * `extract()` are not version-aware and must never become version-aware, so the shape
 * assertions below are the contract that lets them stay that way.
 */
'use strict';

const X = require('../src/lib/appraisal/xml36');
const M = require('../src/lib/appraisal/uad36-map');
const { extract36, detect36, COMP_CONTAINERS } = require('../src/lib/appraisal/extract36');
const { extract } = require('../src/lib/appraisal/extract');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const eq = (a, b, m) => assert(a === b, `${m}${a === b ? '' : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`}`);

// ── a synthetic UAD 3.6 report ────────────────────────────────────────────────
// SYNTHETIC, and labelled as such on purpose. The GSEs' published sample scenarios
// (Appendix D-1) are on a host this environment's egress policy blocks, so this file
// is built from the MISMO v3 naming conventions the field map targets. It exercises
// the READER and the SHAPE; it is not evidence that the paths match the normative
// xPaths. Replace it with a real sample the day one is in hand — see
// docs/appraisal-xml/uad-3.6-research.md §"What is still unverified".
const REPORT_36 = `<?xml version="1.0" encoding="UTF-8"?>
<MESSAGE xmlns="http://www.mismo.org/residential/2009/schemas"
         xmlns:xlink="http://www.w3.org/1999/xlink"
         MISMOReferenceModelIdentifier="3.6.0">
 <DEAL_SETS><DEAL_SET><DEALS><DEAL>
  <COLLATERALS><COLLATERAL>
   <SUBJECT_PROPERTY>
    <ADDRESS>
      <AddressLineText>123 Main St</AddressLineText>
      <CityName>Bridgeport</CityName><StateCode>CT</StateCode>
      <PostalCode>06604</PostalCode><CountyName>Fairfield</CountyName>
    </ADDRESS>
    <PARCEL_IDENTIFICATION><PARCEL_IDENTIFIERS><PARCEL_IDENTIFIER>
      <ParcelIdentifierValue>0123-456</ParcelIdentifierValue>
    </PARCEL_IDENTIFIER></PARCEL_IDENTIFIERS></PARCEL_IDENTIFICATION>
    <PROPERTY_DETAIL>
      <PropertyStructureBuiltYear>1962</PropertyStructureBuiltYear>
      <PropertyDwellingUnitCount>2</PropertyDwellingUnitCount>
      <PropertyConditionRatingType>C4</PropertyConditionRatingType>
      <PropertyQualityRatingType>Q4</PropertyQualityRatingType>
      <InteriorConditionRatingType>C3</InteriorConditionRatingType>
      <ExteriorConditionRatingType>C5</ExteriorConditionRatingType>
      <PropertyOccupancyStatusType>TenantOccupied</PropertyOccupancyStatusType>
    </PROPERTY_DETAIL>
    <STRUCTURE><STRUCTURE_DETAIL>
      <GrossLivingAreaSquareFeetNumber>1533</GrossLivingAreaSquareFeetNumber>
      <TotalBedroomCount>3</TotalBedroomCount>
      <TotalBathroomCount>2</TotalBathroomCount>
      <HalfBathroomCount>1</HalfBathroomCount>
      <TotalRoomCount>7</TotalRoomCount>
    </STRUCTURE_DETAIL></STRUCTURE>
    <SITE><SITE_ZONING>
      <ZoningClassificationIdentifier>R-3</ZoningClassificationIdentifier>
      <ZoningComplianceType>Legal</ZoningComplianceType>
    </SITE_ZONING></SITE>
   </SUBJECT_PROPERTY>
   <SALES_COMPARISON>
     <COMPARABLE_SALE>
       <ADDRESS><AddressLineText>10 Oak Ave</AddressLineText><CityName>Bridgeport</CityName>
         <StateCode>CT</StateCode><PostalCode>06604</PostalCode></ADDRESS>
       <SalesContractAmount>310000</SalesContractAmount>
       <ClosedDate>2026-03-14</ClosedDate>
       <GrossLivingAreaSquareFeetNumber>1500</GrossLivingAreaSquareFeetNumber>
       <TotalBedroomCount>3</TotalBedroomCount>
       <PropertyConditionRatingType>C4</PropertyConditionRatingType>
       <AdjustedSalesPriceAmount>305000</AdjustedSalesPriceAmount>
       <GLA_ADJUSTMENT><AdjustmentAmount>-1500</AdjustmentAmount>
         <AdjustmentDescription>gross living area</AdjustmentDescription></GLA_ADJUSTMENT>
     </COMPARABLE_SALE>
     <COMPARABLE_SALE>
       <ADDRESS><AddressLineText>22 Elm St</AddressLineText></ADDRESS>
       <SalesContractAmount>325000</SalesContractAmount>
       <ClosedDate>2026-04-02</ClosedDate>
       <GrossLivingAreaSquareFeetNumber>1600</GrossLivingAreaSquareFeetNumber>
     </COMPARABLE_SALE>
     <COMPARABLE_SALE>
       <ADDRESS><AddressLineText>7 Pine Rd</AddressLineText></ADDRESS>
       <SalesContractAmount>298000</SalesContractAmount>
       <ClosedDate>2026-02-20</ClosedDate>
       <GrossLivingAreaSquareFeetNumber>1450</GrossLivingAreaSquareFeetNumber>
     </COMPARABLE_SALE>
     <COMPARABLE_SALE><ADDRESS/></COMPARABLE_SALE>
   </SALES_COMPARISON>
   <VALUATION><PROPERTY_VALUATION_DETAIL>
     <PropertyAppraisedValueAmount>320000</PropertyAppraisedValueAmount>
     <PropertyValuationEffectiveDate>2026-05-01</PropertyValuationEffectiveDate>
     <AppraisalConditionType>AsIs</AppraisalConditionType>
     <PropertyInspectionType>InteriorAndExterior</PropertyInspectionType>
   </PROPERTY_VALUATION_DETAIL></VALUATION>
   <NEIGHBORHOOD>
     <NeighborhoodPropertyValueTrendType>Stable</NeighborhoodPropertyValueTrendType>
     <NeighborhoodDemandSupplyType>InBalance</NeighborhoodDemandSupplyType>
   </NEIGHBORHOOD>
  </COLLATERAL></COLLATERALS>
  <PARTIES>
   <PARTY xlink:label="APPRAISER1">
     <INDIVIDUAL><NAME><FullName>Jane Appraiser</FullName></NAME>
       <CONTACT_POINTS><CONTACT_POINT><CONTACT_POINT_EMAIL>
         <ContactPointEmailValue>jane@example.com</ContactPointEmailValue>
       </CONTACT_POINT_EMAIL></CONTACT_POINT></CONTACT_POINTS></INDIVIDUAL>
     <ROLES><ROLE>
       <ROLE_DETAIL><PartyRoleType>Appraiser</PartyRoleType></ROLE_DETAIL>
       <LICENSES><LICENSE>
         <LicenseIdentifier>RCA.0001234</LicenseIdentifier>
         <LicenseIssuingAuthorityStateCode>CT</LicenseIssuingAuthorityStateCode>
         <LicenseExpirationDate>2027-04-30</LicenseExpirationDate>
       </LICENSE></LICENSES>
     </ROLE></ROLES>
   </PARTY>
   <PARTY>
     <INDIVIDUAL><NAME><FullName>Maple Holdings LLC</FullName></NAME></INDIVIDUAL>
     <ROLES><ROLE><ROLE_DETAIL><PartyRoleType>Borrower</PartyRoleType></ROLE_DETAIL></ROLE></ROLES>
   </PARTY>
  </PARTIES>
 </DEAL></DEALS></DEAL_SET></DEAL_SETS>
</MESSAGE>`;

// ── 1. the reader ─────────────────────────────────────────────────────────────
console.log('\n-- xml36: the MISMO 3.x reader --');
{
  const { root, damaged } = X.parse(REPORT_36);
  assert(!damaged, 'a well-formed report parses undamaged');
  eq(X.deepText(root, 'AddressLineText'), '123 Main St', 'element TEXT is kept (the 2.6 reader drops it)');
  eq(X.textAt(X.firstDeep(root, 'SUBJECT_PROPERTY'), ['ADDRESS', 'CityName']), 'Bridgeport', 'a child path resolves');
  eq(X.allDeep(root, 'COMPARABLE_SALE').length, 4, 'every comparable row is found, padded slots included');
  eq(X.attr(X.firstDeep(root, 'PARTY'), 'label'), 'APPRAISER1', 'a namespaced attribute is read by its LOCAL name');

  const arr = X.arrangement(root);
  assert(arr.byLabel.get('APPRAISER1') != null, 'the xlink label index finds the labelled party');

  // Namespace prefixes on ELEMENTS must be transparent too.
  const p = X.parse('<gse:MESSAGE xmlns:gse="x"><gse:PROPERTY><gse:CityName>Trenton</gse:CityName></gse:PROPERTY></gse:MESSAGE>');
  eq(X.deepText(p.root, 'CityName'), 'Trenton', 'a prefixed element matches on its local name');

  // Tolerance: a truncated document yields what parsed, flagged, never an exception.
  const t = X.parse('<MESSAGE><PROPERTY><CityName>Ne');
  assert(t.damaged === true, 'a truncated document is reported damaged');
  assert(t.root != null, 'and still returns a tree rather than throwing');

  // A stray close tag must not re-parent the following siblings.
  const s = X.parse('<A><B>1</WRONG><C>2</C></B></A>');
  eq(X.deepText(s.root, 'C'), '2', 'a stray close tag does not lose the next sibling');

  // Entity hardening, mirroring the 2.6 reader: an impossible code point is left literal.
  eq(X.decodeEntities('a&#x999999;b'), 'a&#x999999;b', 'an out-of-range numeric entity is left as text, never thrown');
  eq(X.decodeEntities('&amp;&lt;&gt;'), '&<>', 'the standard entities decode');
}

// ── 2. normalizers + enums ────────────────────────────────────────────────────
console.log('\n-- uad36-map: normalizers and the enum crosswalk --');
{
  eq(M.toNum('N/A'), null, 'a token with no digit is null, never 0');
  eq(M.count('0', 99), 0, 'a stated ZERO count is an answer, not an absence');
  eq(M.money('0'), null, 'a zero money amount is not a value');
  eq(M.bool('true'), true, 'a MISMO 3.x indicator reads as a real boolean');
  eq(M.bool('maybe'), null, 'an unreadable indicator is null — never a silent false');
  eq(M.ymd('2026-05-01T00:00:00Z'), '2026-05-01', 'an ISO datetime narrows to the calendar day');
  eq(M.ymd('13/40/2026'), null, 'an impossible date is refused');

  const b = M.bathsFrom('2', '1');
  eq(b.text, '2.1', 'baths are assembled into UAD full.half notation, never a decimal');
  eq(M.bathsFrom(null, null).text, null, 'no bath counts states nothing');

  eq(M.ratingCode('C4', 'C'), 'C4', 'a bare condition code passes through');
  eq(M.ratingCode('ConditionRatingC3', 'C'), 'C3', 'a typed enumeration spelling is decoded');
  eq(M.ratingCode('Good', 'C'), null, 'a worded rating is NOT invented into a code');
  eq(M.ratingCode('Q7', 'Q'), null, 'a code outside the UAD scale is refused');

  eq(M.conditionOfAppraisal('SubjectToRepairs'), 'SubjectToRepairs', 'the 2.6 condition vocabulary is preserved');
  eq(M.conditionOfAppraisal('subject to completion'), 'SubjectToCompletion', 'a worded completion condition maps onto it');
  eq(M.conditionOfAppraisal('As Is'), 'AsIs', 'a spaced as-is maps onto it');
  eq(M.inspectionScope('Exterior Only'), 'ExteriorOnly', 'the scope of work is normalized');

  // The redesigned URAR has NO form number; the equivalent legacy form is DERIVED.
  eq(M.deriveFormType({ units: 1 }).formType, 'FNM1004', 'one dwelling derives the 1004 equivalent');
  eq(M.deriveFormType({ units: 3 }).formType, 'FNM1025', 'a 2-4 unit count derives the 1025 equivalent');
  eq(M.deriveFormType({ propertyCategoryType: 'Condominium' }).formType, 'FNM1073', 'condominium ownership derives the 1073 equivalent');
  eq(M.deriveFormType({}).formType, null, 'a report stating neither derives NOTHING rather than defaulting to 1004');
  assert(!!M.deriveFormType({ units: 1 }).basis, 'and the derivation records its basis in words');
}

// ── 3. the canonical object ───────────────────────────────────────────────────
console.log('\n-- extract36: the canonical object --');
const A = extract36(REPORT_36);
{
  assert(A.ok === true, 'the report reads');
  eq(A.format.model, '3.6', 'the format is reported as 3.6');
  eq(A.format.uad36, true, 'and flagged UAD 3.6');
  eq(A.formType, 'FNM1025', 'a 2-unit property derives the 1025-equivalent path');

  eq(A.subject.address, '123 Main St', 'the subject street');
  eq(A.subject.city, 'Bridgeport', 'the subject city');
  eq(A.subject.state, 'CT', 'the subject state');
  eq(A.subject.zip, '06604', 'the subject zip');
  eq(A.subject.apn, '0123-456', 'the parcel identifier');
  eq(A.subject.yearBuilt, '1962', 'the year built, as a string like the 2.6 reader');
  eq(A.subject.gla, 1533, 'the gross living area');
  eq(A.subject.beds, 3, 'the bedroom count');
  eq(A.subject.baths, '2.1', 'the bath text in UAD notation');
  eq(A.subject.units, 2, 'the dwelling unit count');
  eq(A.subject.conditionUad, 'C4', 'the overall condition rating');
  eq(A.subject.qualityUad, 'Q4', 'the overall quality rating');
  eq(A.subject.zoningId, 'R-3', 'the zoning classification');

  // The 3.6-only facts ride on subject.* so `buildFieldsJson` persists them verbatim.
  eq(A.subject.conditionInterior, 'C3', 'the INTERIOR condition rating (new in 3.6)');
  eq(A.subject.conditionExterior, 'C5', 'the EXTERIOR condition rating (new in 3.6)');
  eq(A.subject.uadVersion, '3.6', 'the subject records which standard it was read from');

  eq(A.values.appraisedValue, 320000, 'the appraised value');
  eq(A.values.effectiveDate, '2026-05-01', 'the effective date');
  eq(A.values.conditionOfAppraisal, 'AsIs', 'the condition of appraisal');
  eq(A.values.basis, 'ASIS', "the basis is the 2.6 reader's own token, not a sentence");
  eq(A.values.asIs, 320000, 'an AsIs report puts the figure on the As-Is');
  eq(A.values.asIsConfidence, 'definite', 'and calls it definite');
  eq(A.values.arv, null, 'with no ARV invented');

  eq(A.comparables.length, 3, 'the padded empty comparable slot is dropped');
  eq(A.comparables[0].salePrice, 310000, "the first comparable's price");
  eq(A.comparables[0].saleDate, '2026-03-14', 'its closed date');
  eq(A.comparables[0].gla, 1500, 'its living area');
  eq(A.comparables[0].pricePerSqft, 206.67, 'its price per foot, computed the same way');
  eq(A.comparables[0].adjustedSalePrice, 305000, 'its adjusted price');
  assert(A.comparables[0].adjustments.some((x) => x.amount === -1500), 'and its adjustment line is read');

  eq(A.appraiser.name, 'Jane Appraiser', 'the appraiser is read from the party playing that role');
  eq(A.appraiser.licenseId, 'RCA.0001234', 'their licence identifier');
  eq(A.appraiser.licenseState, 'CT', 'their licence state');
  eq(A.appraiser.email, 'jane@example.com', 'their contact point, scoped to their own party');
  eq(A.borrower.name, 'Maple Holdings LLC', 'the borrower is read from the borrower role');
  eq(A.borrower.isLlc, true, 'and recognised as an entity');

  eq(A.enrich.occupancy_status, 'TenantOccupied', 'an enrichment column is filled');
  eq(A.enrich.nbhd_value_trend, 'Stable', 'a neighbourhood column is filled');

  assert(A.warnings.some((w) => w.code === 'cq_interior_exterior_gap'),
    'a two-step interior/exterior condition gap is surfaced — the reason 3.6 split the ratings');
  assert(A.coverage && A.coverage.total > 0, 'coverage is reported so the map can be corrected against a real sample');
  assert(Array.isArray(A.coverage.unresolved), 'and it names the fields that did not resolve');
}

// ── 4. the SHAPE contract with the 2.6 reader ────────────────────────────────
console.log('\n-- the shape contract: 3.6 must be indistinguishable downstream --');
{
  const twoSix = extract('<?xml version="1.0"?><VALUATION_RESPONSE MISMOVersionID="2.6">'
    + '<REPORT AppraisalFormType="FNM1004"><PROPERTY/></REPORT></VALUATION_RESPONSE>');
  assert(twoSix.ok === true, 'the 2.6 reference report still reads (the old path is untouched)');

  const TOP = ['ok', 'formType', 'subject', 'values', 'appraiser', 'enrich', 'borrower',
    'comparables', 'units', 'income', 'condo', 'photos', 'report', 'rentalComps', 'compSplit', 'warnings'];
  for (const k of TOP) assert(k in A, `the 3.6 object carries \`${k}\` like the 2.6 object`);

  const SUBJ = ['address', 'city', 'county', 'state', 'zip', 'apn', 'legal', 'censusTract', 'neighborhood',
    'attachmentType', 'propertyCategoryType', 'pudIndicator', 'projectDesignType', 'propertyType',
    'units', 'unitsBasis', 'yearBuilt', 'gla', 'beds', 'baths', 'bathsFull', 'bathsHalf', 'rooms',
    'stories', 'design', 'lotArea', 'zoningId', 'zoningDesc', 'zoningCompliance', 'floodZone',
    'conditionUad', 'qualityUad', 'conditionText', 'qualityText', 'priorSale',
    'propertyCategory', 'propertyCategoryConfidence', 'propertyCategoryBasis'];
  for (const k of SUBJ) assert(k in A.subject, `subject.${k} is present on the 3.6 read`);

  const VAL = ['appraisedValue', 'effectiveDate', 'conditionOfAppraisal', 'basis',
    'asIs', 'asIsConfidence', 'asIsSource', 'arv', 'arvConfidence', 'arvSource',
    'valueSalesApproach', 'valueCostApproach', 'valueIncomeApproach', 'grm', 'siteValue',
    'contractPrice', 'contractDate'];
  for (const k of VAL) assert(k in A.values, `values.${k} is present on the 3.6 read`);

  // `enrich` keys become INSERT columns (`Object.assign(cols, A.enrich)` in import.js),
  // so an invented key fails the whole import. This is the guard for that.
  const COLUMNS = new Set(['addendum_text', 'adverse_site_conditions', 'amenities', 'appraisal_purpose',
    'appraisal_purpose_other', 'appraiser_company_address', 'attic', 'basement_finished_pct', 'basement_sqft',
    'below_grade_finished_sqft', 'below_grade_sqft', 'building_status', 'comp_research', 'comps_have_prior_sales',
    'concession_amount', 'concession_description', 'concession_indicator', 'condition_comment',
    'condition_uad_as_is', 'conditions_comment', 'condo_commercial_space', 'condo_common_elements',
    'condo_concentrated_ownership', 'condo_developer_control', 'condo_management_type', 'condo_owner_occupied',
    'condo_parking_spaces', 'condo_total_phases', 'condo_units_completed', 'condo_units_for_sale',
    'condo_units_planned', 'condo_units_rented', 'condo_units_sold', 'contract_data_source',
    'contract_review_comment', 'contract_reviewed', 'cooling', 'cost_data_source', 'cost_new_total',
    'cost_quality_rating', 'depreciated_cost_improvements', 'depreciation_external', 'depreciation_functional',
    'depreciation_physical', 'depreciation_total', 'dwelling_cost_new', 'dwelling_price_per_sqft', 'dwelling_sqft',
    'effective_age', 'est_market_monthly_rent', 'fema_panel_date', 'fema_panel_id', 'foundation_type',
    'garage_spaces', 'garage_type', 'has_adu', 'heating_fuel', 'heating_type', 'inspection_type',
    'lender_address', 'listed_within_year', 'listing_history', 'lot_dimensions', 'lot_shape',
    'market_conditions_comment', 'market_reconciliation_comment', 'market_trends', 'mc_median_dom',
    'mc_months_supply', 'mc_price_trend', 'mc_sale_to_list_pct', 'nbhd_adverse_financing', 'nbhd_age_predominant',
    'nbhd_boundaries', 'nbhd_builtup', 'nbhd_demand_supply', 'nbhd_foreclosure_activity', 'nbhd_growth',
    'nbhd_location_type', 'nbhd_marketing_time', 'nbhd_price_high', 'nbhd_price_low', 'nbhd_price_predominant',
    'nbhd_value_trend', 'occupancy_status', 'off_site_improvements', 'owner_of_record', 'ownership',
    'physical_deficiency', 'physical_deficiency_note', 'present_land_use', 'property_rights',
    'property_tax_amount', 'property_tax_year', 'reconciliation_comment', 'remaining_economic_life',
    'rent_included_utilities', 'roof_description', 'sale_type', 'sales_agreement_analysis', 'seller_is_owner',
    'site_improvements_value', 'special_flood_hazard', 'supervisor_license_exp', 'supervisor_license_id',
    'supervisor_license_state', 'updated_last_15yr', 'updates', 'uspap_report_type', 'utilities',
    'zoning_compliance_note']);
  const stray = Object.keys(A.enrich).filter((k) => !COLUMNS.has(k));
  assert(stray.length === 0,
    `every enrich key is an existing appraisals column — an invented one would fail the INSERT${stray.length ? ` (stray: ${stray.join(', ')})` : ''}`);

  eq(A.compSplit.counts.as_is + A.compSplit.counts.arv + A.compSplit.counts.unknown, A.comparables.length,
    'the comp-split counts reconcile to the comparable count');
}

// ── 5. the as-is / after-repair decision ─────────────────────────────────────
console.log('\n-- the value decision (the highest-risk read) --');
{
  const reno = REPORT_36.replace('<AppraisalConditionType>AsIs</AppraisalConditionType>',
    '<AppraisalConditionType>SubjectToRepairs</AppraisalConditionType>');
  const R = extract36(reno);
  eq(R.values.basis, 'ARV', 'a subject-to-repairs report puts the figure on the ARV');
  eq(R.values.arv, 320000, 'the after-repair value is the reported figure');
  eq(R.values.asIs, null, 'and the As-Is is NOT estimated from it');
  assert(/officer condition/i.test(R.values.asIsSource || ''), 'the source says a human has to supply the As-Is');

  // 3.6 states the disclosure as its own data point. It must overrule an `AsIs` enum,
  // which is the exact trap the 2.6 reader had to scan prose to catch.
  const hypo = REPORT_36.replace('</PROPERTY_VALUATION_DETAIL>',
    '<HypotheticalConditionDescription>Valued subject to completion of the proposed repairs.'
    + '</HypotheticalConditionDescription></PROPERTY_VALUATION_DETAIL>');
  const H = extract36(hypo);
  eq(H.values.basis, 'ARV', 'a structured hypothetical condition overrules an AsIs enum');
  assert(/HYPOTHETICAL/i.test(H.values.basisNote || ''), 'and the reason is recorded in words');

  // A narrative as-is figure on an after-repair report is taken; a bare number is not.
  const both = REPORT_36
    .replace('<AppraisalConditionType>AsIs</AppraisalConditionType>',
      '<AppraisalConditionType>SubjectToCompletion</AppraisalConditionType>')
    .replace('</NEIGHBORHOOD>',
      '<NeighborhoodBoundariesDescription>The as-is value of the subject is $245,000 in its current state.'
      + '</NeighborhoodBoundariesDescription></NEIGHBORHOOD>');
  const B = extract36(both);
  eq(B.values.asIs, 245000, 'a LABELLED as-is figure in the narrative is recovered');
  eq(B.values.asIsConfidence, 'definite', 'and is definite because the words named it');
}

// ── 6. refusals ──────────────────────────────────────────────────────────────
console.log('\n-- refusals: never a screen full of silent nulls --');
{
  const ilad = extract36('<?xml version="1.0"?><MESSAGE MISMOReferenceModelIdentifier="3.6.0">'
    + '<ABOUT_VERSIONS><ABOUT_VERSION><DataVersionIdentifier>ILAD 1.0</DataVersionIdentifier>'
    + '</ABOUT_VERSION></ABOUT_VERSIONS><DEAL_SETS/></MESSAGE>');
  assert(ilad.ok === false, 'a loan-application export does not import');
  assert(/loan-application|iLAD/i.test(ilad.error), 'and is named as one, not as a version problem');

  const bare = extract36('<?xml version="1.0"?><MESSAGE MISMOReferenceModelIdentifier="3.6.0"><DEAL_SETS/></MESSAGE>');
  assert(bare.ok === false, 'a 3.6 envelope with no comparable grid does not import');
  assert(/comparable sales grid/i.test(bare.error), 'and says why in words an officer can act on');

  const d = detect36(REPORT_36);
  eq(d.model, '3.x', 'the detector recognises the reference model');
  eq(d.uad36, true, 'and flags 3.6');
  eq(d.hasGrid, true, 'and finds the grid');
  assert(COMP_CONTAINERS.includes('SALES_COMPARISON'), 'the shared container list carries the 2.6 spelling too');
}

// ── 7. the dispatch: extract() must route a 3.6 file without any caller change ─
console.log('\n-- extract() routes both standards through one door --');
{
  const viaExtract = extract(REPORT_36);
  assert(viaExtract.ok === true, 'extract() imports a UAD 3.6 report');
  eq(viaExtract.format.model, '3.6', 'and reports which standard it read');
  eq(viaExtract.subject.address, '123 Main St', 'with the same subject the 3.6 reader produced');
  eq(viaExtract.comparables.length, 3, 'and the same comparables');
}

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'ALL UAD 3.6 reader assertions passed'}`);
process.exit(failures ? 1 : 0);
