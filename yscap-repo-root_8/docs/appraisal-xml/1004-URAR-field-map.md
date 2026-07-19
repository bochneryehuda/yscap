# Fannie Mae Form 1004 (URAR) MISMO 2.6 XML — Field-Extraction Specification

Scope: RTL / fix-and-flip appraisals that carry **both an "As-Is" value and an "ARV"**
(After-Repair Value = subject-to-completion market value). Derived from thorough reading
of the 11 FNM1004 sample files listed below and grep comparison across all of them.

**Files analyzed (N = 11):**

| # | File | Software (`AppraisalSoftwareProductName`) | Vendor family |
|---|------|-------------------------------------------|---------------|
| 1 | Completed_Product_(Data)_09405263.xml | Appraise-It 16.7.2 | **Appraise-It** |
| 2 | Completed_Product_(Data)_09432272.xml | a la mode - TOTAL 6.319 | a la mode |
| 3 | Completed_Product_(Data)_09769678.xml | a la mode - TOTAL 6.320 | a la mode |
| 4 | Completed_Product_(Data)_09770010.xml | a la mode - TOTAL | a la mode |
| 5 | Completed_Product_(Data)_10182152.xml | ACI 1.0.2.0 | **ACI** |
| 6 | Completed_Product_(Data)_10484851.xml | ACI 1.0.2.0 | ACI |
| 7 | Completed_Product_(Data)_10736314.xml | a la mode - TOTAL 6.321 | a la mode |
| 8 | Completed_Product_(Data)_10736526.xml | a la mode - TOTAL | a la mode |
| 9 | nan_Coto(NAN1602682113)-V1.xml | a la mode - TOTAL 6.326 | a la mode |
| 10 | nan_Lev(NAN1602681973)-V2.xml | ACI 1.0.2.0 | ACI |
| 11 | nan_Steiner(NAN1602680642)-V6.xml | a la mode - TOTAL 6.326 | a la mode |

The three vendor families matter: **attribute *names* are stable across all vendors** (they
are the MISMO 2.6 GSE dictionary), but **element grouping, date formats, and photo metadata
differ**. Where a vendor deviates it is called out below.

---

## (a) Document structure

```
<VALUATION_RESPONSE MISMOVersionID="2.6GSE">
  <REPORT AppraisalFormType="FNM1004" AppraiserReportSignedDate=... AppraisalPurposeType=...>
      <FORM .../>                         (page manifest; Appraise-It also nests <IMAGE> here)
      <FORM ...><MARKET .../></FORM>      (1004MC Market Conditions addendum)
      <EMBEDDED_FILE _Type="PDF">...</EMBEDDED_FILE>   (full report PDF, base64 — stripped)
  </REPORT>
  <PARTIES>
      <APPRAISER .../>                    (name, company, address, license, contact)
      <LENDER .../>                       (client)
      <BORROWER>...GSEBorrowerName...</BORROWER>
      <MANAGEMENT_COMPANY_EXTENSION>...GSEManagementCompanyName...  (AMC)
  </PARTIES>
  <PROPERTY _StreetAddress=... _City=... _County=... _RightsType=...>
      <_IDENTIFICATION CensusTractIdentifier=... MapReferenceIdentifier=...>
          ...<PARCEL_IDENTIFIER GSEAssessorsParcelIdentifier=.../>       (APN)
      <_LEGAL_DESCRIPTION _TextDescription=.../>
      <STRUCTURE PropertyStructureBuiltYear=... GrossLivingAreaSquareFeetCount=... .../>
          <BASEMENT .../> <HEATING/> <COOLING/> <CAR_STORAGE/> ...EFFECTIVE_AGE... 
      <SITE _AreaDescription=... _ZoningClassificationIdentifier=...>...<FLOOD_ZONE/>...
      <NEIGHBORHOOD .../>
      <INSPECTION AppraisalInspectionPropertyType="Subject" InspectionDate=.../>
      <SALES_CONTRACT _Date=... _Amount=.../>          (contract price + date)
  </PROPERTY>
  <VALUATION_METHODS>
      <COST_ANALYSIS SiteEstimatedValueAmount=... ValueIndicatedByCostApproachAmount=... .../>
      <SALES_COMPARISON ValueIndicatedBySalesComparisonApproachAmount=...
                        _CurrentSalesAgreementAnalysisComment="...As-Is text...">
          <RESEARCH .../>
          <COMPARABLE_SALE PropertySequenceIdentifier="0">   (subject-as-comp)
          <COMPARABLE_SALE PropertySequenceIdentifier="1"...> (comps)
      <INCOME_ANALYSIS ValueIndicatedByIncomeApproachAmount=.../>
  </VALUATION_METHODS>
  <VALUATION PropertyAppraisedValueAmount=... AppraisalEffectiveDate=...>   <!-- ARV -->
      <_RECONCILIATION _ConditionsComment="...As-Is text..." _SummaryComment=...>
          <_CONDITION_OF_APPRAISAL _Type="SubjectToRepairs"/>
      </_RECONCILIATION>
  </VALUATION>
</VALUATION_RESPONSE>
```

Data lives in **element attributes**, MISMO 2.6 attribute-heavy style. GSE-dictionary values
(quality/condition ratings, effective age, APN, DOM, etc.) are wrapped in deeply-nested
`*_EXTENSION > *_EXTENSION_SECTION[ExtensionSectionOrganizationName="UNIFORM APPRAISAL DATASET"] > *_EXTENSION_SECTION_DATA > <XXX GSE...=.../>`
chains — parse by the leaf element + `GSE*` attribute name, not by absolute path depth.

---

## (b) Field-mapping table

Legend for "Present": count of the 11 files where the field was found in **structured
attributes** (not buried in free text / PDF).

### 1. Subject identity

| Field | Element path | Attribute | Example | Present | Notes / variation | Disambiguation |
|-------|--------------|-----------|---------|---------|-------------------|----------------|
| Street address | `PROPERTY` | `_StreetAddress` | `1307 STOCKTON STREET`; `46 Poplar St` | 11/11 | — | The `PROPERTY` element = subject. `COMPARABLE_SALE/LOCATION/@PropertyStreetAddress` is a comp, do not confuse. |
| Address line 2 / unit | `PROPERTY` | `_StreetAddress2` | `PITTSBURGH, PA 15218` | ~3/11 | Often holds city/state repeat, **not** a unit #. No dedicated unit attr seen. | Treat as free text; do not assume "unit". |
| City | `PROPERTY` | `_City` | `RAHWAY` | 11/11 | — | |
| County | `PROPERTY` | `_County` | `UNION`; `Mercer`; `ALLEGHENY` | 11/11 | case varies | |
| State | `PROPERTY` | `_State` | `NJ` | 11/11 | — | |
| Zip | `PROPERTY` | `_PostalCode` | `07065` | 11/11 | — | |
| Occupancy | `PROPERTY` | `_CurrentOccupancyType` | `OwnerOccupied`, `Vacant`, `Tenant` | 11/11 | — | |
| Property rights | `PROPERTY` | `_RightsType` | `FeeSimple` | 11/11 | — | |
| APN / parcel # | `PROPERTY/_IDENTIFICATION/.../PARCEL_IDENTIFIER` | `GSEAssessorsParcelIdentifier` | `13-00349-0000-00012-0000`; `0235-P-00061` | 11/11 | may contain `&amp;` joining 2 parcels | Nested in UAD extension, not a `PROPERTY` attr. |
| Legal description | `PROPERTY/_LEGAL_DESCRIPTION` | `_TextDescription` | `BLOCK 349 LOT 12`; `DEED BOOK-10684, PAGE-523` | 11/11 | `_Type="Other" _TypeOtherDescription="LongLegal"` on Appraise-It | |
| Census tract | `PROPERTY/_IDENTIFICATION` | `CensusTractIdentifier` | `0358.00`; `5151.00` | 11/11 | — | |
| Map reference | `PROPERTY/_IDENTIFICATION` | `MapReferenceIdentifier` | `MAPQUEST` | ~1/11 | Appraise-It only; often blank | |
| Neighborhood name | `PROPERTY/NEIGHBORHOOD` | `_Name` | `RAHWAY` | 11/11 | — | |
| Neighborhood desc | `PROPERTY/NEIGHBORHOOD` | `_Description` / `_BoundaryAndCharacteristicsDescription` | long text | 11/11 | — | |

### 2. Subject physical

| Field | Element path | Attribute | Example | Present | Notes / variation | Disambiguation |
|-------|--------------|-----------|---------|---------|-------------------|----------------|
| Property type / attachment | `PROPERTY/STRUCTURE` | `AttachmentType` | `Detached`, `Attached` | 11/11 | a la mode/ACI merge all into one `<STRUCTURE>`; Appraise-It splits into 3 `<STRUCTURE>` siblings (main + `BuildingStatusType` + `LivingUnitCount`). | Read attrs by name across all `STRUCTURE` siblings, not positionally. |
| Living units | `PROPERTY/STRUCTURE` | `LivingUnitCount` | `1` | 11/11 | — | |
| Year built | `PROPERTY/STRUCTURE` | `PropertyStructureBuiltYear` | `1963`, `1896` | 11/11 | — | |
| Effective age | `.../EFFECTIVE_AGE` (UAD ext) | `GSEEffectiveAgeDescription` | `5`, `15`, `10` | 11/11 | string, may be a range | Distinct from actual age (`AGE` adjustment desc on comps). |
| GLA (sq ft) | `PROPERTY/STRUCTURE` | `GrossLivingAreaSquareFeetCount` | `1533`, `1578` | 11/11 | — | Subject GLA. Comp GLA is `SALE_PRICE_ADJUSTMENT[_Type=GrossLivingArea]/@_Description`. |
| Total rooms | `PROPERTY/STRUCTURE` | `TotalRoomCount` | `8` | 11/11 | — | |
| Bedrooms | `PROPERTY/STRUCTURE` | `TotalBedroomCount` | `4` | 11/11 | — | |
| Bathrooms | `PROPERTY/STRUCTURE` | `TotalBathroomCount` | `2.0`, `1.1` | 11/11 | UAD `full.half` decimal (`2.1` = 2 full 1 half) | Not a true number; parse as `full.half`. |
| Stories | `PROPERTY/STRUCTURE` | `StoriesCount` | `2` | 11/11 | also `GSEStoriesCount` in ext | |
| Design / style | `PROPERTY/STRUCTURE` | `_DesignDescription` | `BI LEVEL`, `Row House` | 11/11 | free text | |
| Lot size (text) | `PROPERTY/SITE` | `_AreaDescription` | `9300 sf`, `12197 sf` | ~10/11 | **"sf" string, parse the number**; ACI sometimes only in `_DimensionsDescription` (`4,120 SQ FT`). | Sq ft, not acres. No separate acres attr; convert. |
| Lot dimensions | `PROPERTY/SITE` | `_DimensionsDescription` | `46.5Fx200LSx46.5Rx200RS` | 11/11 | — | |
| Site shape | `PROPERTY/SITE/SITE_FEATURE[_Type=Shape]` | `_Comment` | `RECTANGULAR` | Appraise-It | others put shape in PDF | |
| Zoning class | `PROPERTY/SITE` | `_ZoningClassificationIdentifier` | `R-2`, `R33 Residential` | 11/11 | — | |
| Zoning desc | `PROPERTY/SITE` | `_ZoningClassificationDescription` | `MEDIUM DENSITY RESIDENTIAL` | 11/11 | — | |
| Zoning compliance | `PROPERTY/SITE` | `_ZoningComplianceType` | `Legal`, `Nonconforming` | 11/11 | — | |
| View (subject) | `PROPERTY/SITE/SITE_FEATURE[_Type=View]` | `_Comment` | `B;Res;Park` | Appraise-It | UAD coded `rating;type;type`; a la mode/ACI carry view only on comps + PDF | |
| Quality rating (Q1-Q6) | `.../COMPARISON_DETAIL` on subject comp (seq 0) | `GSEQualityOfConstructionRatingType` | `Q3`, `Q4` | 11/11 | Subject rating = the seq-0 comp's value | Subject value is on `COMPARABLE_SALE[PropertySequenceIdentifier=0]`, NOT on `STRUCTURE`. |
| Condition rating (C1-C6) | same (seq-0 comp) | `GSEOverallConditionType` | `C2`,`C3`,`C4` | 11/11 | see As-Is/ARV note — subject condition is the **as-repaired** rating | |
| Foundation | `PROPERTY/STRUCTURE/FOUNDATION` | `_Type` / `_ExistsIndicator` | `Slab` | 11/11 | also `EXTERIOR_FEATURE[_Type=Foundation]/@_Description` | |
| Basement sq ft | `PROPERTY/STRUCTURE/BASEMENT` | `SquareFeetCount` | `864`, `0` | 11/11 | `0` = no/slab | |
| Basement finish % | `PROPERTY/STRUCTURE/BASEMENT` | `_FinishedPercent` | `0` | 11/11 | — | |
| Heating | `PROPERTY/STRUCTURE/HEATING` | `_Type` / `_FuelDescription` | `ForcedWarmAir` / `GAS` | 11/11 | — | |
| Cooling | `PROPERTY/STRUCTURE/COOLING` | `_CentralizedIndicator` | `Y` | 11/11 | — | |
| Garage / car storage | `PROPERTY/STRUCTURE/CAR_STORAGE/CAR_STORAGE_LOCATION` | `_Type`,`ParkingSpacesCount` | `Garage`/`1`, `Driveway`/`3` | 11/11 | one row per storage type; `_AttachmentType` on parent | |

### 3. Values (see section (c) for the disambiguation rule)

| Field | Element path | Attribute | Example | Present | Notes | Disambiguation |
|-------|--------------|-----------|---------|---------|-------|----------------|
| **Reconciled opinion of value (= ARV here)** | `VALUATION` | `PropertyAppraisedValueAmount` | `640000`, `277000` | 11/11 | This is the headline reconciled figure. | In these RTL reports it is the **subject-to-completion / ARV** value because `_CONDITION_OF_APPRAISAL/@_Type` = SubjectToRepairs/SubjectToCompletion (11/11). NOT the as-is value. |
| Condition the value is stated under | `VALUATION/_RECONCILIATION/_CONDITION_OF_APPRAISAL` | `_Type` | `SubjectToRepairs` (9), `SubjectToCompletion` (2) | 11/11 | Never `AsIs` in this sample. | If `_Type` ∈ {SubjectToRepairs, SubjectToCompletion} then `PropertyAppraisedValueAmount` = ARV. |
| **As-Is value** | free text — see (c) | `_ConditionsComment` (`_RECONCILIATION`) and/or `_CurrentSalesAgreementAnalysisComment` (`SALES_COMPARISON`) | `"AS IS" VALUE $420,000`; `The estimated As Is value is $170,000` | ~9/11 in text; **0/11 as a clean numeric attribute** | 2 files only say "as-is value is also present in text addendum" (→ it is inside the PDF, not the XML). | Must regex the dollar amount out of free text; there is no dedicated attribute. |
| Cost approach value | `VALUATION_METHODS/COST_ANALYSIS` | `ValueIndicatedByCostApproachAmount` | `640361`, `298094` | 11/11 | Tracks the **as-repaired/ARV** figure. | |
| Site (land) value | `COST_ANALYSIS` | `SiteEstimatedValueAmount` | `325000`, `5600`, `22400` | 11/11 | raw land only | Do not confuse with as-is value. |
| Remaining economic life | `COST_ANALYSIS` | `EstimatedRemainingEconomicLifeYearsCount` | `55`, `45`, `85` | 11/11 | — | |
| Sales-comparison value | `VALUATION_METHODS/SALES_COMPARISON` | `ValueIndicatedBySalesComparisonApproachAmount` | `640000`, `277000` | 11/11 | ≈ `PropertyAppraisedValueAmount` (the ARV). | This is the **as-repaired** SCA value (comps 1-3 / 1-6 set). |
| Income approach value | `INCOME_ANALYSIS` | `ValueIndicatedByIncomeApproachAmount` | `0` | 11/11 | usually 0 / N/A | |
| Contract / sale price | `PROPERTY/SALES_CONTRACT` | `_Amount` | `412000`, `172000`, `61000` | 11/11 | This is the **purchase** price (typically ≈ or below as-is). | Distinct from any opinion of value. |
| Contract date | `PROPERTY/SALES_CONTRACT` | `_Date` | `2026-02-01` | 11/11 | ISO | |
| Effective date of appraisal | `VALUATION` | `AppraisalEffectiveDate` | `2026-02-13` | 11/11 | ISO. Equals inspection date. | |
| Inspection date | `PROPERTY/INSPECTION` | `InspectionDate` (with `AppraisalInspectionPropertyType="Subject"`) | `2026-02-16` | 11/11 | — | |
| Report signed date | `REPORT` | `AppraiserReportSignedDate` | `02/17/2026` (Appraise-It) / `2026-02-27` (a la mode/ACI) | 11/11 | **Format differs by vendor** (US vs ISO). | Normalize both formats. |
| Supervisor signed date | `REPORT` | `SupervisorReportSignedDate` | `""` | present but empty 11/11 | no supervisory appraiser in sample | |

### 4. Sales comparison / comps

| Field | Element path | Attribute | Example | Notes |
|-------|--------------|-----------|---------|-------|
| Comp container | `SALES_COMPARISON/COMPARABLE_SALE` | `PropertySequenceIdentifier` | `0`,`1`,`2`... | **Seq `0` = the subject rendered as a comp column** (its address = subject). Real comps start at `1`. Appraise-It may skip numbers (saw 1-5, 7-8; 6 omitted). |
| # comps researched | `SALES_COMPARISON/RESEARCH` | `ComparableSalesResearchedCount`, `ComparableListingsResearchedCount` | `4`,`3` | plus price-range low/high attrs |
| Comp address | `COMPARABLE_SALE/LOCATION` | `PropertyStreetAddress`,`PropertyCity`,`PropertyState`,`PropertyPostalCode` | `1366 STOCKTON STREET` | lat/long also present |
| Proximity | `COMPARABLE_SALE/LOCATION` | `ProximityToSubjectDescription` | `0.12 miles NW` | absent on seq-0 subject |
| Sale price | `COMPARABLE_SALE` | `PropertySalesAmount` | `715000` | |
| Price / GLA | `COMPARABLE_SALE` | `SalesPricePerGrossLivingAreaAmount` | `323.24` | |
| GLA | `COMPARABLE_SALE/SALE_PRICE_ADJUSTMENT[_Type=GrossLivingArea]` | `_Description` | `2212` | |
| Sale date | `COMPARABLE_SALE/SALE_PRICE_ADJUSTMENT[_Type=DateOfSale]` | `_Description` | `s03/25;c07/25` | `s`=settled `c`=contract; also `.../OFFERING_DISPOSITION/@GSEShortDateDescription` |
| Total net adjustment | `COMPARABLE_SALE` | `SalePriceTotalAdjustmentAmount` (+ `SalesPriceTotalAdjustmentPositiveIndicator`) | `-75300`, `Y/N` | sign carried in the boolean, amount often unsigned-positive text with `PositiveIndicator=N` |
| Net adj % / Gross adj % | `COMPARABLE_SALE` | `SalePriceTotalAdjustmentNetPercent`, `SalesPriceTotalAdjustmentGrossPercent` | `10.53`, `14.84` | |
| Adjusted price | `COMPARABLE_SALE` | `AdjustedSalesPriceAmount` | `639700` | **Key signal for As-Is vs ARV comp split** (see (c)). |
| Data source | `COMPARABLE_SALE` | `DataSourceDescription` / `DataSourceVerificationDescription` + `.../COMPARISON_DETAIL/@GSEDataSourceDescription` | `MLS# NJME2063792;DOM 51`; `GSMLS#3933873` | |
| DOM | `.../COMPARISON_DETAIL` | `GSEDaysOnMarketDescription` | `64` | |
| Per-line adjustments | `COMPARABLE_SALE/SALE_PRICE_ADJUSTMENT` | `_Type`,`_Description`,`_Amount` | `Condition`/`C2`/`-35750` | one element per adjustment line |

### 5. Appraiser & company

| Field | Element path | Attribute | Example | Notes |
|-------|--------------|-----------|---------|-------|
| Appraiser name | `PARTIES/APPRAISER` | `_Name` | `Glenn A. Thomson` | |
| Company / firm | `PARTIES/APPRAISER` | `_CompanyName` | `Market Evaluators`, `LMS Appraisal` | |
| Company address | `PARTIES/APPRAISER` | `_StreetAddress`,`_City`,`_State`,`_PostalCode` | `500 Port Au Peck Avenue` | |
| License number | `APPRAISER/APPRAISER_LICENSE` | `_Identifier` | `42RA00210900`, `RL139206` | |
| License state | `APPRAISER/APPRAISER_LICENSE` | `_State` | `NJ`, `PA`, `CT` | |
| License type | `APPRAISER/APPRAISER_LICENSE` | `_Type` | `License`, `Certificate` | |
| License expiration | `APPRAISER/APPRAISER_LICENSE` | `_ExpirationDate` | `2027-12-31` | ISO |
| Phone | `APPRAISER/CONTACT_DETAIL/CONTACT_POINT[_Type=Phone]` | `_Value` | `7328902731` | |
| Email | `APPRAISER/CONTACT_DETAIL/CONTACT_POINT[_Type=Email]` | `_Value` | `mkteval@comcast.net` | |
| Supervisory appraiser | second `APPRAISER_LICENSE` (empty) / no `SUPERVISORY_APPRAISER` | — | empty | None populated in sample; a la mode emits a blank 2nd `APPRAISER_LICENSE`. |
| Lender / client | `PARTIES/LENDER` | `_UnparsedName` | `YS Capital Group` | client = lender here |
| AMC | `PARTIES/MANAGEMENT_COMPANY_EXTENSION/.../MANAGEMENT_COMPANY` | `GSEManagementCompanyName` | `CLASS VALUATION`, `Nationwide Appraisal Network` | case varies |
| Borrower | `PARTIES/BORROWER/.../BORROWER_NAME` | `GSEBorrowerName` | `Dovid Waldman` | |
| Report/file id | `REPORT` | `AppraiserFileIdentifier`, `AppraiserAdditionalFileIdentifier` | `YSCAP258134415` | client case # often in the "Additional" field |

### 6. Photos / images

Only the **Appraise-It** file exposes per-image metadata (10 `<IMAGE>` elements). a la mode
and ACI emit **zero** `<IMAGE>` elements — every photo/sketch/map lives inside the single
`<EMBEDDED_FILE _Type="PDF">` payload (stripped here), so labels are not recoverable from XML.

`<IMAGE>` distinct `_Identifier` values seen (Appraise-It, nested under page `<FORM>`s):

| `_Identifier` | Represents | `_CaptionComment` |
|---------------|-----------|-------------------|
| `SubjectFront` | subject front photo | `Front View` |
| `SubjectRear` | subject rear photo | `Rear View` |
| `SubjectStreet` | subject street scene | `Street View` |
| `Sales Comp 1 - Photo` … `Sales Comp 8 - Photo` | comparable photos | (none) |

All carry `_Name="HasImage"` (a boolean-style presence flag, not a filename). Page-level
`<FORM AppraisalReportContentType=...>` also enumerates `SubjectPhotos`, `Sketch`,
`LocationMap`, `PlatMap`/`Site Plan`, `Comparable Photos` pages — useful as a manifest even
when the individual images are only in the PDF. `<EMBEDDED_FILE>` attributes:
`_Name="AppraisalReport" _Type="PDF" MIMEType="application/pdf" _EncodingType="Base64"`.

---

## (c) As-Is vs ARV disambiguation — the rule to code

**The single most dangerous field.** In every one of these 11 RTL reports the headline
structured value is the **ARV (subject-to-completion)**, and the **As-Is value is only in
free text** (or only in the PDF). A naive parser that grabs `PropertyAppraisedValueAmount`
and calls it "the value" will silently return the ARV every time.

**Rule:**

1. **ARV (after-repair / subject-to-completion) value**
   = `VALUATION/@PropertyAppraisedValueAmount`
   — **valid as ARV only when** `VALUATION/_RECONCILIATION/_CONDITION_OF_APPRAISAL/@_Type`
   ∈ {`SubjectToRepairs`, `SubjectToCompletion`} (true for all 11). It is corroborated by
   `SALES_COMPARISON/@ValueIndicatedBySalesComparisonApproachAmount` and
   `COST_ANALYSIS/@ValueIndicatedByCostApproachAmount`, which both track this figure.
   - If `_Type` were `AsIs`/absent (a plain 1004, not seen here), then
     `PropertyAppraisedValueAmount` would instead be the as-is value — so **always gate on
     `_CONDITION_OF_APPRAISAL/@_Type`**.

2. **As-Is value** — no dedicated attribute. Extract by regex, in priority order:
   1. `VALUATION/_RECONCILIATION/@_ConditionsComment` — e.g. `..."AS IS" VALUE $420,000`.
   2. `SALES_COMPARISON/@_CurrentSalesAgreementAnalysisComment` — e.g.
      `Comparables #4-6 are for the current As Is value. The estimated As Is value is $170,000`
      (a la mode / nan files).
   3. `VALUATION_METHODS/@_AdditionalDescription` or the SCA `_Comment` (Appraise-It sometimes).
   4. If the comment literally says *"an as-is value is also present in text addendum"*
      (files 10736314 / 10736526), the number is **only in the PDF** → flag as
      "As-Is present but not machine-readable"; do not guess.
   - Regex suggestion: `(?i)as[\s-]*is[^$\d]{0,40}\$?\s*([\d]{2,3},?\d{3})`.
   - Observed As-Is values: 09405263 $420,000 (ARV 640k); 09432272 $235,000 (355k);
     09769678 $170,000 (277k); 09770010 $190,000 (245k); nan_Steiner $430,000 (625k);
     nan_Coto $410,000 (435k); nan_Lev $76,000 (216k).

3. **Comp-set split (which comps price the As-Is vs the ARV).** Two vendor conventions,
   both described in the SCA free-text comment, both verifiable by clustering
   `AdjustedSalesPriceAmount`:
   - **a la mode / ACI / nan family:** comps **1-3 → ARV**, comps **4-6 → As-Is**
     (text: "Comparables #4-6 are for the current As Is value").
   - **Appraise-It family (and 09282104-style):** comps **1-6 → ARV**, comps **7-9 → As-Is**
     (text: "for comps 7-9 the subject was reported in its as-is … condition").
   - There is **no attribute** flagging a comp as As-Is vs ARV. The reliable signal is:
     (a) parse the split sentence from `_CurrentSalesAgreementAnalysisComment` /
     SCA `_Comment`, and cross-check by (b) **clustering `AdjustedSalesPriceAmount`** — the
     ARV cluster ≈ `PropertyAppraisedValueAmount`, the lower cluster ≈ the As-Is value.
     Example (09769678, ARV 277k / As-Is 170k): comps 1-3 adj = 266100/276000/312900;
     comps 4-6 adj = 190950/204800/163100.

4. **Contract price ≠ either opinion of value.** `SALES_CONTRACT/@_Amount` is the purchase
   price (e.g. 172000 while As-Is 170k, ARV 277k). Keep it separate.

**Pseudo-logic:**
```
arv = VALUATION.@PropertyAppraisedValueAmount
cond = _CONDITION_OF_APPRAISAL.@_Type
is_arv_report = cond in ("SubjectToRepairs","SubjectToCompletion")
as_is = regex_money(_ConditionsComment)
     or regex_money(_CurrentSalesAgreementAnalysisComment)
     or regex_money(_AdditionalDescription / SCA _Comment)
     or FLAG("as-is only in PDF")   # when comment says "in text addendum"
# sanity: arv should be the larger of the two; as_is should roughly match the
# lower AdjustedSalesPriceAmount cluster.
```

---

## (d) Photos & comps labeling — summary

- **Comps:** iterate `SALES_COMPARISON/COMPARABLE_SALE`. **Drop `PropertySequenceIdentifier="0"`**
  (it is the subject column, not a comp). Sequence numbers are not guaranteed dense
  (Appraise-It skips). Real comp count = distinct non-zero sequence ids. Split them into
  As-Is vs ARV sets using the section-(c) rule (comment sentence + adjusted-price clustering).
- **Photos:** only Appraise-It gives labeled `<IMAGE _Identifier=...>` (`SubjectFront`,
  `SubjectRear`, `SubjectStreet`, `Sales Comp N - Photo`). For a la mode/ACI, rely on the
  page `<FORM>` manifest for *presence* of subject/comp/sketch/map pages, but the actual
  images are inside the embedded PDF only.

---

## (e) Open questions / risky fields (where a naive parser grabs the wrong value)

1. **`PropertyAppraisedValueAmount` is the ARV, not the as-is value.** Highest-risk trap.
   Always gate on `_CONDITION_OF_APPRAISAL/@_Type` and extract As-Is separately from text.
2. **As-Is value has no attribute** and in 2/11 files is *not in the XML at all* (PDF only).
   Any pipeline needing a guaranteed structured As-Is number cannot get it from these XMLs.
3. **Subject Q/C rating lives on the seq-0 comp**, not on `STRUCTURE`. Grabbing the first
   `GSEQualityOfConstructionRatingType` in document order works only because seq-0 is first —
   but note the subject's *condition* rating reflects the **as-repaired** state (the ARV
   scenario), so it is not the as-is condition.
4. **Comp seq `0` is the subject.** Counting `COMPARABLE_SALE` elements over-counts comps by 1.
5. **Date-format split:** Appraise-It uses `MM/DD/YYYY` for `AppraiserReportSignedDate`;
   a la mode/ACI use ISO `YYYY-MM-DD`. `AppraisalEffectiveDate`, `InspectionDate`,
   `SALES_CONTRACT/@_Date`, and license dates are ISO across all. Normalize both.
6. **`TotalBathroomCount` is `full.half`** (e.g. `2.1` = 2 full + 1 half), not a decimal count.
7. **Lot size** is a string with a unit suffix (`9300 sf`), and on ACI can appear only inside
   `_DimensionsDescription` (`4,120 SQ FT`) with no `_AreaDescription`. No acres attribute.
8. **`STRUCTURE` is split across up to 3 sibling elements in Appraise-It** — read attributes by
   name across all siblings, never positionally.
9. **APN may join two parcels** with `&amp;`; legal description formats vary widely (block/lot
   vs deed book/page).
10. **Total adjustment sign** is encoded in `SalesPriceTotalAdjustmentPositiveIndicator` (Y/N)
    alongside a magnitude in `SalePriceTotalAdjustmentAmount`; don't assume the amount's sign.
11. **`AppraisalPurposeType`** is usually `Purchase` but one file (nan_Lev) is `Other` — do not
    assume purchase.
12. **View / site shape / additional-feature** fields are only structured in Appraise-It;
    a la mode/ACI carry them on comps and in the PDF, so subject-level values may be missing.
