'use strict';
/**
 * A SYNTHETIC MISMO 2.6 APPRAISAL, built in code.
 *
 * The real appraisal corpus is not in the repository (real reports, real people),
 * so the suites that need one skip without `APPRAISAL_DIR`. That is the right call
 * for the parser's own tests — nothing synthetic proves how a vendor really writes
 * a file. But the research warehouse's UPLOAD door needs to be tested on every
 * deploy, and what it is being asked to prove is not "can we read a real vendor's
 * quirks" (the parser's job, tested elsewhere) but "does a report that came through
 * the upload door land in exactly the same shape as one that came through a loan
 * file". A hand-built report answers that, and answers it in CI.
 *
 * Only the elements the warehouse actually reads are here. Every caller can vary
 * the address, the date, the appraiser and the grid, which is what makes the
 * duplicate-report and idempotency cases testable.
 */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const DEFAULT_COMPS = [
  { seq: '1', address: '12 Elm St', city: 'Piscataway', state: 'NJ', zip: '08854',
    price: 415000, saleDate: '2026-04-10', gla: 1480, beds: 3, baths: '2.1',
    condition: 'C3', quality: 'Q4', proximity: '0.34 miles', adjusted: 421000 },
  { seq: '2', address: '18 Oak Ave', city: 'Piscataway', state: 'NJ', zip: '08854',
    price: 432500, saleDate: '2026-03-02', gla: 1610, beds: 4, baths: '2.0',
    condition: 'C4', quality: 'Q4', proximity: '0.61 miles', adjusted: 425500 },
  { seq: '3', address: '7 Birch Ln', city: 'Piscataway', state: 'NJ', zip: '08854',
    price: 398000, saleDate: '2026-02-18', gla: 1395, beds: 3, baths: '1.1',
    condition: 'C3', quality: 'Q3', proximity: '0.88 miles', adjusted: 410000 },
];

/**
 * @param {object} o overrides — every field has a sensible default so a caller only
 *                   states what its case is actually about.
 * @returns {string} the XML
 */
function appraisalXml(o = {}) {
  const s = Object.assign({
    formType: 'FNM1004',
    street: '26 S 10th St', city: 'Piscataway', state: 'NJ', zip: '08854', county: 'Middlesex',
    apn: '12-00345-0000-00021',
    effectiveDate: '2026-05-14', signedDate: '2026-05-16', inspectionDate: '2026-05-12',
    appraisedValue: 430000,
    units: 1, yearBuilt: 1962, gla: 1520, beds: 3, baths: '2.1', rooms: 7,
    conditionUad: 'C3', qualityUad: 'Q4', design: 'Colonial', lotArea: '7,405 sf',
    appraiserName: 'John Q Kessler', appraiserCompany: 'Acme Appraisal LLC',
    licenseId: '42RG00123400', licenseState: 'NJ',
    appraiserPhone: '(973) 555-1212', appraiserEmail: 'john@acme.test',
    comps: DEFAULT_COMPS,
  }, o);

  const comps = (s.comps || []).map((c, i) => `
    <COMPARABLE_SALE PropertySequenceIdentifier="${esc(c.seq || String(i + 1))}"
                     PropertySalesAmount="${esc(c.price)}"
                     AdjustedSalesPriceAmount="${esc(c.adjusted == null ? c.price : c.adjusted)}"
                     SalePriceTotalAdjustmentAmount="${esc((c.adjusted == null ? c.price : c.adjusted) - c.price)}"
                     SalePriceTotalAdjustmentNetPercent="${esc(c.netPct == null ? 1.5 : c.netPct)}"
                     SalesPriceTotalAdjustmentGrossPercent="${esc(c.grossPct == null ? 6.2 : c.grossPct)}"
                     SalesPricePerGrossLivingAreaAmount="${esc(Math.round(c.price / c.gla))}">
      <LOCATION PropertyStreetAddress="${esc(c.address)}" PropertyCity="${esc(c.city)}"
                PropertyState="${esc(c.state)}" PropertyPostalCode="${esc(c.zip || '')}"
                ProximityToSubjectDescription="${esc(c.proximity || '')}"/>
      <COMPARISON_DETAIL GSEListingStatusType="SettledSale"
                         GSEDataSourceDescription="${esc(c.dataSource || 'MLS #1234')}"
                         GSEDaysOnMarketDescription="${esc(c.dom == null ? 21 : c.dom)}"
                         GSESaleType="ArmsLengthSale"/>
      <ROOM_ADJUSTMENT TotalRoomCount="${esc(c.rooms || 7)}" TotalBedroomCount="${esc(c.beds)}"
                       TotalBathroomCount="${esc(c.baths)}"/>
      <SALE_PRICE_ADJUSTMENT _Type="DateOfSale" _Description="s${esc(String(c.saleDate || '').slice(5, 7))}/${esc(String(c.saleDate || '').slice(2, 4))}" _Amount="0"/>
      <SALE_PRICE_ADJUSTMENT _Type="GrossLivingArea" _Description="${esc(c.gla)}" _Amount="0"/>
      <SALE_PRICE_ADJUSTMENT _Type="Condition" _Description="${esc(c.condition || '')}" _Amount="0"/>
      <SALE_PRICE_ADJUSTMENT _Type="Quality" _Description="${esc(c.quality || '')}" _Amount="0"/>
      <SALE_PRICE_ADJUSTMENT _Type="Age" _Description="${esc(c.yearBuilt || 1958)}" _Amount="0"/>
      <SALE_PRICE_ADJUSTMENT _Type="Design" _Description="${esc(c.design || 'Colonial')}" _Amount="0"/>
      <SALE_PRICE_ADJUSTMENT _Type="Site" _Description="${esc(c.lotArea || '7,000 sf')}" _Amount="0"/>
    </COMPARABLE_SALE>`).join('');

  return `<?xml version="1.0"?>
<VALUATION_RESPONSE MISMOVersionID="2.6">
  <REPORT AppraisalFormType="${esc(s.formType)}" AppraiserReportSignedDate="${esc(s.signedDate)}">
    <PROPERTY _StreetAddress="${esc(s.street)}" _City="${esc(s.city)}" _County="${esc(s.county)}"
              _State="${esc(s.state)}" _PostalCode="${esc(s.zip)}"
              _RightsType="${esc(s.propertyRights || 'FeeSimple')}">
      <_IDENTIFICATION AssessorsParcelIdentifier="${esc(s.apn)}" CensusTractIdentifier="0405.02"/>
      <STRUCTURE AttachmentType="Detached" LivingUnitCount="${esc(s.units)}"
                 PropertyStructureBuiltYear="${esc(s.yearBuilt)}"
                 GrossLivingAreaSquareFeetCount="${esc(s.gla)}"
                 TotalBedroomCount="${esc(s.beds)}" TotalBathroomCount="${esc(s.baths)}"
                 TotalRoomCount="${esc(s.rooms)}" StoriesCount="2"
                 _DesignDescription="${esc(s.design)}"/>
      <SITE _AreaDescription="${esc(s.lotArea)}" _ZoningClassificationIdentifier="R-1"
            _ZoningClassificationDescription="Residential" _ZoningComplianceType="Legal"
            _DimensionsDescription="${esc(s.lotDimensions || '60 x 123')}">
        <SITE_FEATURE _Type="View" _Comment="${esc(s.viewCode || 'N;Res;')}"/>
        <SITE_FEATURE _Type="Shape" _Comment="${esc(s.lotShape || 'Rectangular')}"/>
      </SITE>
      <FLOOD_ZONE NFIPFloodZoneIdentifier="${esc(s.floodZone || 'X')}"
                  SpecialFloodHazardAreaIndicator="${esc(s.sfha || 'N')}"
                  NFIPMapIdentifier="34023C0123F"/>
    </PROPERTY>
    <NEIGHBORHOOD _Name="North Piscataway"/>
    <COMPARABLE_SALE PropertySequenceIdentifier="0">
      <COMPARISON_DETAIL GSEOverallConditionType="${esc(s.conditionUad)}"
                         GSEQualityOfConstructionRatingType="${esc(s.qualityUad)}"/>
    </COMPARABLE_SALE>${comps}
    <VALUATION PropertyAppraisedValueAmount="${esc(s.appraisedValue)}"
               AppraisalEffectiveDate="${esc(s.effectiveDate)}"/>
    <_CONDITION_OF_APPRAISAL _Type="${esc(s.conditionOfAppraisal || 'AsIs')}"/>
    <INSPECTION InspectionDate="${esc(s.inspectionDate)}"/>
    <APPRAISER _Name="${esc(s.appraiserName)}" _CompanyName="${esc(s.appraiserCompany)}">
      <APPRAISER_LICENSE _Identifier="${esc(s.licenseId)}" _State="${esc(s.licenseState)}" _Type="Certified Residential"/>
      <CONTACT_POINT _Type="Phone" _Value="${esc(s.appraiserPhone)}"/>
      <CONTACT_POINT _Type="Email" _Value="${esc(s.appraiserEmail)}"/>
    </APPRAISER>
  </REPORT>
</VALUATION_RESPONSE>`;
}

module.exports = { appraisalXml, DEFAULT_COMPS };
