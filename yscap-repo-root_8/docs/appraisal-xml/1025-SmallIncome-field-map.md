# Fannie Mae Form 1025 (Small Residential Income Property, 2–4 units) — MISMO XML Field-Extraction Spec

Scope: RTL / fix-and-flip appraisals delivered as MISMO 2.6 `VALUATION_RESPONSE`, form type `FNM1025`.
Basis: 10 real files in `appraisals/stripped/` (base64 image/PDF blobs stripped). Vendors observed:
ClickFORMS, ACI, a la mode – TOTAL, Appraise-It. **These reports carry BOTH an "As-Is" value AND an
"ARV" (After-Repair / subject-to-completion value).** The single most important disambiguation rule is in §D.

The 10 FNM1025 files:
`08108509` (ClickFORMS), `08821926` (a la mode), `09282104` (ACI), `09709435` (a la mode),
`10209004` (a la mode), `10391589` (a la mode), `10394133` (a la mode), `10421150` (a la mode),
`10636060` (ACI), `nan_Kaufman(NAN1602681854)-V5` (a la mode).

---

## A. Structure summary & how 1025 differs from 1004

Top-level shape is identical to 1004:

```
VALUATION_RESPONSE (MISMOVersionID="2.6")
└─ REPORT (AppraisalFormType="FNM1025", signed date, loan id, purpose)
   ├─ FORM*            ← one per report page/exhibit (cover, 1025 form, addenda, photos, maps, sketch)
   │   └─ IMAGE / EMBEDDED_FILE  (the full PDF + placeholders; real photos live inside the PDF)
   │   └─ MARKET / MARKET_INVENTORY   (1004MC market-conditions data)
   ├─ PARTIES
   │   ├─ APPRAISER (+ CONTACT_DETAIL, APPRAISER_LICENSE, INSPECTION)
   │   ├─ SUPERVISOR / REVIEW_APPRAISER / REAL_ESTATE_AGENT
   │   ├─ LENDER (+ CONTACT_DETAIL _Name = AMC)
   │   └─ BORROWER
   ├─ PROPERTY (address, occupancy, rights)
   │   ├─ _IDENTIFICATION (APN, census tract, map ref)
   │   ├─ _LEGAL_DESCRIPTION
   │   ├─ STRUCTURE (GLA/GBA, LivingUnitCount, year, rooms/beds/baths totals …)
   │   │   ├─ EXTERIOR_FEATURE / FOUNDATION / BASEMENT / INTERIOR_FEATURE / HEATING / COOLING …
   │   │   ├─ CAR_STORAGE / STRUCTURE_ANALYSIS (effective age, remaining life)
   │   │   └─ _UNIT_GROUP*   ★ PER-UNIT rooms/beds/baths/GLA (UnitOne..UnitFour)
   │   ├─ SITE (lot size, zoning, flood, utilities)
   │   ├─ NEIGHBORHOOD (_HOUSING, _PRESENT_LAND_USE)
   │   ├─ _TAX / LISTING_HISTORY / PROPERTY_ANALYSIS* / _OWNER
   │   └─ SALES_CONTRACT (contract price & date)
   ├─ VALUATION_METHODS
   │   ├─ COST_ANALYSIS (+ NEW_IMPROVEMENT*, DEPRECIATION)
   │   ├─ SALES_COMPARISON
   │   │   ├─ RESEARCH (comp counts / ranges)
   │   │   └─ COMPARABLE_SALE*  (seq 0 = SUBJECT; 1..N = comps; incl. ROOM_ADJUSTMENT*, SALE_PRICE_ADJUSTMENT*)
   │   └─ INCOME_ANALYSIS               ★ 1025-ONLY
   │       ├─ MULTIFAMILY_RENT_SCHEDULE ★ subject rent schedule
   │       │   ├─ UNIT_RENT_SCHEDULE*   ★ per-unit actual & market rent, lease dates/status
   │       │   └─ RENT_INCLUDES_UTILITY*★ which utilities are in rent
   │       └─ MULTIFAMILY_RENTALS       ★ rental comparables
   │           └─ MULTIFAMILY_RENTAL*   ★ seq 0 = subject; 1..3 = rent comps
   │               ├─ LOCATION
   │               ├─ RENTAL_UNIT*      ★ per-unit rooms/beds/baths/sqft (+rent on comps)
   │               └─ RENTAL_FEATURE*
   └─ VALUATION (PropertyAppraisedValueAmount, effective date)
       └─ _RECONCILIATION (_SummaryComment, _ConditionsComment)
           └─ _CONDITION_OF_APPRAISAL*  ★ AsIs / SubjectToRepairs / SubjectToCompletion
```

**What 1025 adds over 1004 (the multifamily payload — 1004 has none of this):**
- `STRUCTURE/_UNIT_GROUP` — per-unit room/bed/bath/GLA breakdown (UnitOne…UnitFour).
- Entire `INCOME_ANALYSIS` block: GRM, income-approach value, subject `UNIT_RENT_SCHEDULE`
  (per-unit actual & market rent, lease dates), `RENT_INCLUDES_UTILITY`, and up to 3 rental comps
  (`MULTIFAMILY_RENTAL` / `RENTAL_UNIT`).
- `COMPARABLE_SALE` carries per-unit `ROOM_ADJUSTMENT` rows and rent/GRM attributes (`MonthlyRentAmount`,
  `GrossMonthlyRentMultiplierFactor`, `SalesPricePerUnitAmount`) that a 1004 SFR comp does not.
- `SALES_COMPARISON` adds per-unit / per-room / per-bedroom value indicators.
- These fix-and-flip files carry **two comp sets** (ARV comps + As-Is comps) inside the same
  `SALES_COMPARISON`, and **two opinions of value** (As-Is + ARV). See §D and §E.

**Cross-vendor cautions (apply to every numeric field below):**
- **Number formatting differs by vendor.** ClickFORMS → plain integer `575000`; a la mode → thousands
  commas `575,000` / `5,600`; ACI → decimals `7400.00`. **Always strip `,` and trailing `.00`, and treat
  `""`, `N/A`, `Not Provided`, `Vacant`, `OWNER`, `FAMILY` as non-numeric.**
- **Date formatting differs.** ClickFORMS → ISO `2025-12-30`; all others → `MM/DD/YYYY`.
- a la mode/ACI emit **fixed-length placeholder rows** (empty `_UNIT_GROUP UnitThree/UnitFour`,
  empty trailing `UNIT_RENT_SCHEDULE`). Do not count elements to get unit count — use `LivingUnitCount`.

---

## B. Master field-mapping table

Legend for "Present": N/10 across the FNM1025 files. Paths are relative to `VALUATION_RESPONSE/REPORT`.

### B1. Subject identity
| Field | Element path | Attribute | Example | Present | Notes / Disambiguation |
|---|---|---|---|---|---|
| Street address | `PROPERTY` | `_StreetAddress` | `148 Plymouth St` | 10/10 | `_StreetAddress2` = "City, ST ZIP" combined |
| Unit # | `PROPERTY` | `_StreetAddress` (inline) | — | rare | No dedicated unit attr; part of street address if present |
| City | `PROPERTY` | `_City` | `New Haven` | 10/10 | |
| State | `PROPERTY` | `_State` | `CT` | 10/10 | |
| ZIP | `PROPERTY` | `_PostalCode` | `06519` | 10/10 | |
| County | `PROPERTY` | `_County` | `New Haven` | 10/10 | |
| Occupancy | `PROPERTY` | `_CurrentOccupancyType` | `TenantOccupied` | 10/10 | `Owner`/`Tenant`/`Vacant` |
| Property rights | `PROPERTY` | `_RightsType` | `FeeSimple` | 10/10 | |
| APN | `PROPERTY/_IDENTIFICATION` | `AssessorsParcelIdentifier` | `273-0021-02200` | 10/10 | |
| Census tract | `PROPERTY/_IDENTIFICATION` | `CensusTractIdentifier` | `1404.00` | 10/10 | |
| Map/SMSA ref | `PROPERTY/_IDENTIFICATION` | `MapReferenceIdentifier` | `35084` | 10/10 | |
| Legal description | `PROPERTY/_LEGAL_DESCRIPTION` | `_TextDescription` | `Volume 5540 Page 0132` | 10/10 | `_Type`/`_TypeOtherDescription` label it |
| Neighborhood name | `PROPERTY/NEIGHBORHOOD` | `_Name` | `South Hill` | 9/10 | |
| Neighborhood location | `PROPERTY/NEIGHBORHOOD` | `PropertyNeighborhoodLocationType` | `Suburban` | 10/10 | Urban/Suburban/Rural |
| Owner of record | `PROPERTY/_OWNER` | `_Name` | `ABCD Investments DE LLC` | 10/10 | |

### B2. Subject physical
| Field | Element path | Attribute | Example | Present | Notes |
|---|---|---|---|---|---|
| **# of units** | `PROPERTY/STRUCTURE` | `LivingUnitCount` | `3` | 10/10 | **Authoritative unit count (2/3/4).** Do not count `_UNIT_GROUP`/`UNIT_RENT_SCHEDULE` elements. |
| Design/style | `PROPERTY/STRUCTURE` | `_DesignDescription` | `3 Family` | 10/10 | |
| Property type/attach | `PROPERTY/STRUCTURE` | `AttachmentType` | `Detached` | 10/10 | also `PropertyCategoryType` |
| Building status | `PROPERTY/STRUCTURE` | `BuildingStatusType` | `Existing` | 10/10 | Existing/Proposed/UnderConstruction |
| Stories | `PROPERTY/STRUCTURE` | `StoriesCount` | `3` / `2.5` | 10/10 | |
| Year built | `PROPERTY/STRUCTURE` | `PropertyStructureBuiltYear` | `1910` | 10/10 | |
| GLA (sqft) | `PROPERTY/STRUCTURE` | `GrossLivingAreaSquareFeetCount` | `3152` | 10/10 | comma/decimal varies |
| GBA (sqft) | `PROPERTY/STRUCTURE` | `GrossBuildingAreaSquareFeetCount` | `3152` | 10/10 | For 1025, GBA is the headline area; often == GLA |
| Total rooms | `PROPERTY/STRUCTURE` | `TotalRoomCount` | `14` | 10/10 | building total |
| Total bedrooms | `PROPERTY/STRUCTURE` | `TotalBedroomCount` | `8` | 10/10 | |
| Total baths | `PROPERTY/STRUCTURE` | `TotalBathroomCount` | `3` | 10/10 | |
| Rent control | `PROPERTY/STRUCTURE` | `RentControlStatusType` | `No` | ~7/10 | |
| Effective age (yrs) | `PROPERTY/STRUCTURE/STRUCTURE_ANALYSIS` | `EffectiveAgeYearsCount` | `15` | 10/10 | |
| Remaining econ. life | `.../COST_ANALYSIS` | `EstimatedRemainingEconomicLifeYearsCount` | `60` | ~9/10 | on cost analysis, not structure |
| Basement sqft | `PROPERTY/STRUCTURE/BASEMENT` | `SquareFeetCount` | `1319` | 10/10 | `_FinishedPercent` too |
| Lot size (text) | `PROPERTY/SITE` | `_AreaDescription` | `4792 sf` | 10/10 | free text; parse number |
| Lot dimensions | `PROPERTY/SITE` | `_DimensionsDescription` | `Subject to Survey` | 10/10 | |
| Zoning code | `PROPERTY/SITE` | `_ZoningClassificationIdentifier` | `RM2` | 10/10 | |
| Zoning description | `PROPERTY/SITE` | `_ZoningClassificationDescription` | `Residential mixed use` | 10/10 | |
| Zoning compliance | `PROPERTY/SITE` | `_ZoningComplianceType` | `Legal` | 10/10 | Legal/LegalNonconforming/… |
| Flood zone | `PROPERTY/SITE/FLOOD_ZONE` | `NFIPFloodZoneIdentifier` | `X` | 10/10 | + `SpecialFloodHazardAreaIndicator`, panel id/date |
| Parking | `PROPERTY/STRUCTURE/CAR_STORAGE/CAR_STORAGE_LOCATION` | `_Type`, `ParkingSpacesCount` | `Driveway`, `4` | 10/10 | |
| **UAD Quality (subject)** | `.../SALES_COMPARISON/COMPARABLE_SALE[seq=0]/SALE_PRICE_ADJUSTMENT[_Type="Quality"]` | `_Description` | `Q4` | 10/10 | **No dedicated STRUCTURE quality attr.** Take from the subject column (seq 0). |
| **UAD Condition (subject)** | `.../COMPARABLE_SALE[seq=0]/SALE_PRICE_ADJUSTMENT[_Type="Condition"]` | `_Description` | `C3` | 10/10 | Reflects the **as-repaired/ARV** condition being appraised (see PropertyCondition note below). |
| Condition narrative | `PROPERTY/PROPERTY_ANALYSIS[_Type="PropertyCondition"]` | `_Comment` | `C4 ... as-is value. C3 for As repaired value ...` | ~9/10 | Often states BOTH the As-Is (C4/C5) and As-Repaired (C3) condition ratings. |

### B3. Values / approaches (see §D for As-Is vs ARV rule)
| Field | Element path | Attribute | Example | Present | Notes |
|---|---|---|---|---|---|
| **Reconciled opinion of value** | `VALUATION` | `PropertyAppraisedValueAmount` | `575000` | 10/10 | **This is the value for the reported condition** — usually the **ARV** (subject-to). Single value; the As-Is figure is NOT here. |
| Effective date | `VALUATION` | `AppraisalEffectiveDate` | `2025-12-28` | 10/10 | Inspection/valuation date |
| Condition of appraisal | `VALUATION/_RECONCILIATION/_CONDITION_OF_APPRAISAL` | `_Type` | `SubjectToRepairs` | 10/10 | Values: `AsIs`, `SubjectToRepairs`, `SubjectToCompletion`. **May appear more than once** (e.g. both `SubjectToRepairs` AND `AsIs` in 08108509). |
| Conditions comment | `VALUATION/_RECONCILIATION` | `_ConditionsComment` | `Subject to the work outlined in the attached repair bid...` | 10/10 | describes the "subject-to" scope |
| Reconciliation summary | `VALUATION/_RECONCILIATION` | `_SummaryComment` | `The sales comparison approach ...` | 10/10 | **In a la mode files this comment often literally states both dollar values** (see §D) |
| Value — Sales Comparison | `.../SALES_COMPARISON` | `ValueIndicatedBySalesComparisonApproachAmount` | `575000` | 10/10 | reflects ARV / reported condition |
| Value — Cost | `.../COST_ANALYSIS` | `ValueIndicatedByCostApproachAmount` | `608700` | 10/10 | |
| Value — Income | `.../INCOME_ANALYSIS` | `ValueIndicatedByIncomeApproachAmount` | `586500` | 9/10 | can be `N/A` (10421150) |
| Contract price | `PROPERTY/SALES_CONTRACT` | `_Amount` | `415000` | 10/10 | acquisition/purchase price |
| Contract date | `PROPERTY/SALES_CONTRACT` | `_Date` | `2025-12-23` | 10/10 | |
| Contract reviewed / arm's length | `PROPERTY/SALES_CONTRACT` | `_ReviewedIndicator`, `_ReviewComment`, `SellerIsOwnerIndicator`, `SalesConcessionIndicator` | `Y` | 10/10 | |
| Report signed date | `REPORT` | `AppraiserReportSignedDate` | `2025-12-30` | 10/10 | |
| Supervisor signed date | `REPORT` | `SupervisorReportSignedDate` | `""` | ~8/10 | blank when no supervisor |
| Loan number | `REPORT` | `AppraiserAdditionalFileIdentifier` (ClickFORMS) or `AppraiserFileIdentifier` | `YSCAP258134332` | 10/10 | attribute name is vendor-dependent |
| Appraisal purpose | `REPORT` | `AppraisalPurposeType` (+`...OtherDescription`) | `Purchase` (`Conventional Purchase - Rehab`) | 10/10 | |

### B4. Cost approach detail
| Field | Path | Attribute | Example |
|---|---|---|---|
| Site value | `.../COST_ANALYSIS` | `SiteEstimatedValueAmount` | `65000` |
| Dwelling cost | `.../COST_ANALYSIS/NEW_IMPROVEMENT[_Type="Dwelling"]` | `SquareFeetCount`,`PricePerSquareFootAmount`,`_CostAmount` | `3152`,`200.00`,`630400` |
| Depreciation | `.../COST_ANALYSIS/DEPRECIATION` | `_PhysicalPercent`,`_TotalAmount` | `20.00`,`134675` |
| Total new cost | `.../COST_ANALYSIS` | `NewImprovementTotalCostAmount` | `673375` |

### B5. Appraiser / company / parties
| Field | Element path | Attribute | Example | Present | Notes |
|---|---|---|---|---|---|
| Appraiser name | `PARTIES/APPRAISER` | `_Name` | `Louis J Mihalakos` | 10/10 | |
| Company | `PARTIES/APPRAISER` | `_CompanyName` | `Spartan Property` | 10/10 | |
| Company address | `PARTIES/APPRAISER` | `_StreetAddress`,`_StreetAddress2`,`_City`,`_State`,`_PostalCode` | | 10/10 | ClickFORMS packs city/ST/ZIP into `_StreetAddress2` |
| Phone | `PARTIES/APPRAISER/CONTACT_DETAIL/CONTACT_POINT[_Type="Phone"]` | `_Value` | `2032156033` | 10/10 | format varies |
| Email | `.../CONTACT_POINT[_Type="Email"]` | `_Value` | `spartanproperty@yahoo.com` | 10/10 | |
| License # | `PARTIES/APPRAISER/APPRAISER_LICENSE` | `_Identifier` | `RCR.0001900` | 10/10 | |
| License type | `PARTIES/APPRAISER/APPRAISER_LICENSE` | `_Type` | `Certificate` / `License` | 10/10 | |
| License state | `PARTIES/APPRAISER/APPRAISER_LICENSE` | `_State` | `CT` | 10/10 | |
| License expiration | `PARTIES/APPRAISER/APPRAISER_LICENSE` | `_ExpirationDate` | `2026-04-30` | 10/10 | |
| Inspection date | `PARTIES/APPRAISER/INSPECTION` | `InspectionDate` | `01/27/2026` | ~8/10 | a la mode/ACI; ClickFORMS omits |
| Supervisory appraiser | `PARTIES/SUPERVISOR` | `_Name`,`_CompanyName`,`APPRAISER_LICENSE/*` | usually blank | 9/10 | **Element is present but empty** when none. ClickFORMS instead emits a second empty `APPRAISER_LICENSE` inside `APPRAISER`. |
| Lender / client | `PARTIES/LENDER` | `_UnparsedName` | `YS Capital Group` | 10/10 | |
| Lender address | `PARTIES/LENDER` | `_StreetAddress`,`AppraisalFormsUnparsedAddress` | | 10/10 | |
| **AMC** | `PARTIES/LENDER/CONTACT_DETAIL` | `_Name` | `Class Valuation` | 10/10 | AMC name lives here |
| Borrower | `PARTIES/BORROWER` | `_UnparsedName` | `Ben Kleinman and Breindy Kleinman` | 10/10 | |

---

## C. MULTIFAMILY units & income-approach section (the 1004-lacks payload)

There are **three** places that describe the subject's individual units. Join them by unit index —
`_UNIT_GROUP UnitType` (UnitOne=1, UnitTwo=2, …) ↔ `UNIT_RENT_SCHEDULE/@UnitSequenceIdentifier` ↔
`RENTAL_UNIT/@UnitSequenceIdentifier`.

### C1. Per-unit room/size breakdown — `STRUCTURE/_UNIT_GROUP` and subject `RENTAL_UNIT`
```
<_UNIT_GROUP UnitType="UnitOne"  TotalRoomCount="5" TotalBedroomCount="3" TotalBathroomCount="1.00" GrossLivingAreaSquareFeetCount="1319"/>
<_UNIT_GROUP UnitType="UnitTwo"  TotalRoomCount="5" TotalBedroomCount="3" TotalBathroomCount="1.00" GrossLivingAreaSquareFeetCount="1111"/>
<_UNIT_GROUP UnitType="UnitThree" TotalRoomCount="4" TotalBedroomCount="2" TotalBathroomCount="1.00" GrossLivingAreaSquareFeetCount="722"/>
```
| Per-unit field | Element | Attribute |
|---|---|---|
| Unit label | `STRUCTURE/_UNIT_GROUP` | `UnitType` (`UnitOne`…`UnitFour`) |
| # rooms | `STRUCTURE/_UNIT_GROUP` | `TotalRoomCount` |
| # bedrooms | `STRUCTURE/_UNIT_GROUP` | `TotalBedroomCount` |
| # baths | `STRUCTURE/_UNIT_GROUP` | `TotalBathroomCount` |
| Unit GLA sqft | `STRUCTURE/_UNIT_GROUP` | `GrossLivingAreaSquareFeetCount` |

`_UNIT_GROUP` has **no rent**. Per-unit **sqft is also** in the subject rental block
`INCOME_ANALYSIS/MULTIFAMILY_RENTALS/MULTIFAMILY_RENTAL[PropertySequenceIdentifier="0"]/RENTAL_UNIT`
(`TotalRoomCount`, `TotalBedroomCount`, `TotalBathroomCount`, `SquareFeetCount`). Use `_UNIT_GROUP` as primary;
`RENTAL_UNIT` (seq 0) as fallback/cross-check.
**Caution:** a la mode/ACI emit 4 `_UNIT_GROUP` rows always, with `UnitThree`/`UnitFour` blank for a 2-unit
property. Keep only rows with non-empty `TotalRoomCount`, or cap at `LivingUnitCount`.

### C2. Per-unit actual & market rent — `INCOME_ANALYSIS/MULTIFAMILY_RENT_SCHEDULE/UNIT_RENT_SCHEDULE`
```
<UNIT_RENT_SCHEDULE UnitSequenceIdentifier="1" LeaseStartDate="2024-09-01" LeaseExpirationDate="2026-08-31"
   UnitUnfurnishedActualRentAmount="1550" UnitActualRentAmount="1550"
   UnitUnfurnishedMarketRentAmount="1800" UnitMarketRentAmount="1800"/>
```
| Per-unit field | Element | Attribute | Notes |
|---|---|---|---|
| Unit index | `UNIT_RENT_SCHEDULE` | `UnitSequenceIdentifier` | 1..4 |
| Actual monthly rent | `UNIT_RENT_SCHEDULE` | `UnitActualRentAmount` | mirror of `UnitUnfurnishedActualRentAmount` |
| Market monthly rent | `UNIT_RENT_SCHEDULE` | `UnitMarketRentAmount` | mirror of `UnitUnfurnishedMarketRentAmount` |
| Lease start | `UNIT_RENT_SCHEDULE` | `LeaseStartDate` | **may hold a status token** |
| Lease expiration | `UNIT_RENT_SCHEDULE` | `LeaseExpirationDate` | |
| **Lease status** | `UNIT_RENT_SCHEDULE` | `LeaseStartDate`/`LeaseExpirationDate` (overloaded) | Non-date tokens seen: `Vacant`, `Not Provided`, `OWNER`, `FAMILY`. There is **no separate status attribute** — infer status from these tokens + whether `UnitActualRentAmount` is 0/blank. |

**Caution:** a la mode always emits `UnitSequenceIdentifier="1..4"`; unused rows are entirely blank.
Count real units by `LivingUnitCount`, not by row count. Furnished variants
(`UnitFurnishedActualRentAmount`, `UnitFurnishedMarketRentAmount`) are present but almost always empty.

### C3. Subject rent totals & income approach
| Field | Element | Attribute | Example |
|---|---|---|---|
| **Total actual gross monthly rent** | `INCOME_ANALYSIS/MULTIFAMILY_RENT_SCHEDULE` | `RentalActualGrossMonthlyRentAmount` | `4250` |
| Total actual income (incl. other) | same | `RentalActualTotalMonthlyIncomeAmount` | `4250` |
| Other/additional actual income | same | `RentalActualAdditionalMonthlyIncomeAmount` | `0` |
| **Total market gross monthly rent** | same | `RentalEstimatedGrossMonthlyRentAmount` | `5100` |
| Total market income (incl. other) | same | `RentalEstimatedTotalMonthlyIncomeAmount` | `5100` |
| Rent-schedule comment | same | `RentalDataAnalysisComment`, `MarketRentalDataComment` | `All units are tenant occupied with yearly leases.` |
| **Estimated market monthly rent (used)** | `INCOME_ANALYSIS` | `EstimatedMarketMonthlyRentAmount` | `5100` |
| **GRM (Gross Rent Multiplier)** | `INCOME_ANALYSIS` | `GrossRentMultiplierFactor` | `115.00` | (can be `N/A`) |
| **Indicated value by income approach** | `INCOME_ANALYSIS` | `ValueIndicatedByIncomeApproachAmount` | `586500` | (can be `N/A`) |
| Income comment | `INCOME_ANALYSIS` | `_Comment` | `The rents, GRM and expenses obtained from sales data...` |
| Utilities included in rent | `INCOME_ANALYSIS/MULTIFAMILY_RENT_SCHEDULE/RENT_INCLUDES_UTILITY` | `_Type`, `_Indicator` | `Water`/`Y`, `Electric`/`N` | Types: Electric, Gas, Oil, Water, Sewer, Trash, Cable, Other |

**Operating expenses:** NOT present as structured fields in any of the 10 files (0/10). The 1025 form's
operating-expense/net-income lines, if filled, live only in the embedded PDF / narrative addenda — treat as
unavailable in structured MISMO. Only utility-inclusion flags (`RENT_INCLUDES_UTILITY`) are structured.

### C4. Rental comparables — `INCOME_ANALYSIS/MULTIFAMILY_RENTALS/MULTIFAMILY_RENTAL`
`PropertySequenceIdentifier="0"` is the SUBJECT; `1`,`2`,`3` are rent comps (always 4 elements → 3 comps).
```
<MULTIFAMILY_RENTAL PropertySequenceIdentifier="1" MonthlyRentAmount="3600" RentPerGrossBuildingAreaAmount="1.19"
     DataSourceDescription="MLS#24140844" GrossBuildingAreaSquareFeetCount="3021">
   <LOCATION PropertyStreetAddress="32 Lamberton St" ProximityToSubjectDescription="0.22 miles E"/>
   <RENTAL_UNIT UnitSequenceIdentifier="1" TotalRoomCount="5" TotalBedroomCount="2" TotalBathroomCount="1.00" SquareFeetCount="1007" MonthlyRentAmount="1800"/>
   ...
   <RENTAL_FEATURE _Type="Age" _Description="120 yrs"/>
</MULTIFAMILY_RENTAL>
```
| Field | Element | Attribute |
|---|---|---|
| Rental comp total rent | `MULTIFAMILY_RENTAL` | `MonthlyRentAmount` |
| Rent per GBA | `MULTIFAMILY_RENTAL` | `RentPerGrossBuildingAreaAmount` |
| Rental comp GBA | `MULTIFAMILY_RENTAL` | `GrossBuildingAreaSquareFeetCount` |
| Address / proximity | `MULTIFAMILY_RENTAL/LOCATION` | `PropertyStreetAddress`, `ProximityToSubjectDescription` |
| Per-unit rent (comp) | `MULTIFAMILY_RENTAL/RENTAL_UNIT` | `MonthlyRentAmount` | (subject seq 0 has no per-unit rent here — get it from `UNIT_RENT_SCHEDULE`) |
| Per-unit rooms/beds/baths/sqft | `MULTIFAMILY_RENTAL/RENTAL_UNIT` | `TotalRoomCount`,`TotalBedroomCount`,`TotalBathroomCount`,`SquareFeetCount` |
| Feature lines | `MULTIFAMILY_RENTAL/RENTAL_FEATURE` | `_Type`(`Lease`/`Location`/`Age`/`Condition`), `_Description` |

**Unit-mix summary:** there is no single "unit mix" element. Derive it from `_UNIT_GROUP`
(e.g. "2× 3BR/1BA + 1× 2BR/1BA") using rooms/beds/baths per `_UNIT_GROUP`.

---

## D. As-Is vs ARV — the disambiguation rule (CRITICAL)

**Structured MISMO stores only ONE opinion of value** — `VALUATION/@PropertyAppraisedValueAmount` — plus the
three approach values (`ValueIndicatedBy{Cost,SalesComparison,Income}ApproachAmount`). **All of these correspond
to the *reported condition of appraisal*, not to "As-Is".** The second (As-Is) figure is **only in narrative
comment text**, and its location is vendor-dependent.

**Rule to interpret the structured value:**
1. Read `VALUATION/_RECONCILIATION/_CONDITION_OF_APPRAISAL/@_Type` (may appear multiple times):
   - `AsIs` → `PropertyAppraisedValueAmount` **is the As-Is value** (e.g. 09709435 = `650,000`, AsIs).
   - `SubjectToRepairs` or `SubjectToCompletion` → `PropertyAppraisedValueAmount` **is the ARV / subject-to
     (After-Repair) value** (8 of 10 files). The As-Is value is elsewhere (step 2).
   - If **both** `SubjectToRepairs` and `AsIs` are present (08108509), the structured value is the ARV and the
     As-Is value must be pulled from narrative (step 2).
2. **Extract the As-Is dollar figure from narrative.** It is not in any numeric attribute. Search these comment
   fields (in priority order) for phrases like `As-Is Value ... $NNN,NNN` / `As Repaired ... $NNN,NNN`:
   - `VALUATION/_RECONCILIATION/@_SummaryComment` (a la mode — e.g. 08821926: *"As-Repaired Value ... $850,000 /
     As-Is Value ... $615,000"*).
   - `.../SALES_COMPARISON/@_Comment` (a la mode 10209004/10391589: *"Estimated Indicated As-Repaired Value ...
     $530,000. ... As-Is Value ... $475,000. Comparable 7,8,9 reflect the As-Is Value..."*).
   - `REPORT/.../@AppraisalAddendumText` (ClickFORMS 08108509: *"The As Repaired Value is noted to be $575,000 /
     The As-Is value is noted to be $430,000"*; ACI 10636060: *"AS IS = $1,700,000"*).
   Recommended regex family: `(as[\s-]?is|as[\s-]?repaired|ARV)\D{0,40}\$?\s?([\d,]{4,})`.
3. **Cross-checks:** the ARV normally equals `ValueIndicatedBySalesComparisonApproachAmount` and
   `PropertyAppraisedValueAmount`; the As-Is value is typically near the contract price
   (`SALES_CONTRACT/@_Amount`) and is supported by the As-Is comp subset (see §E). The
   `PROPERTY_ANALYSIS[_Type="PropertyCondition"]/@_Comment` usually names both condition ratings
   (e.g. *"C4 ... as-is value. C3 ... As repaired value"*).

**Worked examples (structured value = ARV unless condition=AsIs):**
| File | Condition type(s) | PropertyAppraisedValue (=ARV) | As-Is (narrative) | Contract |
|---|---|---|---|---|
| 08108509 | SubjectToRepairs + AsIs | 575000 | 430000 | 415000 |
| 08821926 | SubjectToCompletion | 850,000 | 615,000 | 545,000 |
| 09709435 | **AsIs** | 650,000 (**is the As-Is**) | n/a (as-is report) | 426,000 |
| 10209004 | SubjectToRepairs | 530,000 | 475,000 | — |
| 10391589 | SubjectToRepairs | 800,000 | 640,000 | 515,000 |
| 10636060 | SubjectToRepairs | 2230000 | 1,700,000 | 1,690,000 |

---

## E. Comps & photos labeling

### E1. Sales comparables — `SALES_COMPARISON/COMPARABLE_SALE`
- **`PropertySequenceIdentifier="0"` is the SUBJECT column** (carries subject's UAD Quality/Condition, GLA, rent,
  GRM). Comps are seq `1..N`. So actual comp count = (number of `COMPARABLE_SALE`) − 1. Observed 6–9 comps/file.
- **The comp set is split As-Is vs ARV positionally, not by any attribute.** Convention across these files:
  the first block (comps **1–3**, sometimes 1–6) are the **ARV / EMV** comps; the trailing block (comps **4–6**
  or **7–9**) are the **As-Is** comps. Confirmed by narrative (*"Comparables 1-3 are used for the ARV value and
  comparable 4-6 are used for the as-is value"* / *"Comparable 7,8,9 reflect the As-Is Value and have not been
  calculated in EMV"*) and by the form pages "Extra Comps 4-5-6" / "Extra Comps 7-8-9". **There is no
  As-Is/ARV flag on the `COMPARABLE_SALE` element** — you must read the split from the `SALES_COMPARISON/@_Comment`
  (or addendum) and/or infer from price clustering (ARV comps price higher, As-Is comps cluster near contract).

Per-comp fields:
| Field | Element | Attribute | Example |
|---|---|---|---|
| Address | `COMPARABLE_SALE/LOCATION` | `PropertyStreetAddress` | `322 Howard Ave` |
| Proximity | `COMPARABLE_SALE/LOCATION` | `ProximityToSubjectDescription` | `0.16 miles E` |
| Sale price | `COMPARABLE_SALE` | `PropertySalesAmount` | `655000` |
| Price/GBA | `COMPARABLE_SALE` | `SalesPricePerGrossBuildingAreaAmount` | `154.59` |
| Price/unit | `COMPARABLE_SALE` | `SalesPricePerUnitAmount` | `218333` |
| Gross monthly rent | `COMPARABLE_SALE` | `MonthlyRentAmount` | `5100` / `N/A` |
| GRM | `COMPARABLE_SALE` | `GrossMonthlyRentMultiplierFactor` | `115.00` / `N/A` |
| Data source / MLS# / DOM | `COMPARABLE_SALE` | `DataSourceDescription` | `MLS#24094440 , DOM 15` |
| Adjusted price | `COMPARABLE_SALE` | `AdjustedSalesPriceAmount` | `628725` |
| Net adj $ / sign | `COMPARABLE_SALE` | `SalePriceTotalAdjustmentAmount`, `SalesPriceTotalAdjustmentPositiveIndicator` | `-26275`, `N` |
| Net adj % / gross adj % | `COMPARABLE_SALE` | `SalePriceTotalAdjustmentNetPercent`, `SalesPriceTotalAdjustmentGrossPercent` | `-4`, `4` |
| Per-unit rooms (grid) | `COMPARABLE_SALE/ROOM_ADJUSTMENT` | `UnitSequenceIdentifier`,`TotalRoomCount`,`TotalBedroomCount`,`TotalBathroomCount`,`RoomAdjustmentAmount` | one row per unit |
| Line adjustments | `COMPARABLE_SALE/SALE_PRICE_ADJUSTMENT` | `_Type`,`_Description`,`_AdjustmentAmount` | `Quality`/`Q4`, `Condition`/`C3`, `GrossBuildingArea`/`3152`, `Parking`/`4 Off Street`, … |
| Comp search counts | `SALES_COMPARISON/RESEARCH` | `ComparableSalesResearchedCount`, `ComparableListingsResearchedCount`, price-range lo/hi | `22`, `7` |
| Subject/comp prior sales | `SALES_COMPARISON/RESEARCH/SUBJECT` & `/COMPARABLE` | `_HasPriorSalesIndicator`, `DataSourceDescription` | `N` |

Note the subject column (seq 0) `PropertySalesAmount` = contract price (e.g. `415000`).

### E2. Photos / images
- **Real photos are embedded inside the report PDF** (`FORM[AppraisalReportContentIdentifier="FNM1025"]/IMAGE/
  EMBEDDED_FILE[_Name="AppraisalReport", _Type="PDF"]`, base64 stripped here). Individual JPEGs are **not**
  separately extractable from this data XML.
- Photo/exhibit pages are identified at the **`FORM`** level, not per image. Use
  `FORM/@AppraisalReportContentType` (stable enum) and `@AppraisalReportContentName` (free label).
- `IMAGE/@_Name` only ever takes `HasImage` (page has an image), `NoImage`, or `AppraisalForm` (the PDF payload) —
  it is a presence flag, not a photo label.

**`AppraisalReportContentType` enum observed (use this to classify pages):**
`SubjectPhotos`, `SalePhotos`, `RentalPhotos`, `ExtraSales`, `LocationMap`, `Sketch`, `Exhibit`,
`Addendum`, `CommentAddendum`, `AppraisalForm`, `Certification`, `CoverPage`, `Other`.

**Distinct `AppraisalReportContentName` labels (free-text; vendor-varying):**
Subject: `Photo Subject`, `Photo Subject - 2 Photos`.
Comp photos: `Photo Comparables 1-2-3`, `Photo Comparables 4-5-6`, `Photo Comparables 7-8-9`, `Photos (6)`.
Rental/interior: `Rental Photos`, `Photo Rentals 1-2-3`.
Comp grids: `Extra Comps 4-5-6`, `Extra Comps 7-8-9`, `URAR Sales Comparables 4-6 (09/11)`,
`URAR Sales Comparables 7-9 (09/11)`, `Sales Comparables 7-9 for 3x5 Photos`.
Maps/sketch: `Location Map`, `Neighborhood Map`, `Site Plan`, `Sketch`, `Generic Map Page-1/2`.
Other: `Scope Of Work`, `Transmittal Letter`, `Generic Supplemental Addendum`, `UAD Definition of Terms`,
`Market Conditions Addendum`, `General 3x5 Photo Page#3..7`, `Extra Photos`.
(The `Extra Comps / Comparables 4-6 & 7-9` pages correspond to the **As-Is comp subset** — see §E1.)

---

## F. Open questions / risky fields

1. **As-Is value is unstructured.** Its dollar amount is only in narrative comments and its host attribute varies
   by vendor (`_SummaryComment` | `SALES_COMPARISON/@_Comment` | `AppraisalAddendumText`). Regex extraction needed;
   confidence < structured fields. Always fall back to contract price / As-Is comp cluster for sanity.
2. **ARV vs As-Is comp partition has no structured marker.** Only inferable from narrative wording and page labels
   ("Extra Comps 4-6/7-9") or price clustering. Risk of mis-partitioning when the appraiser deviates from the
   1-3/4-6 convention.
3. **Number & date normalization is mandatory** (commas, `.00`, ISO vs MM/DD/YYYY). Non-numeric tokens
   (`N/A`, `Vacant`, `Not Provided`, `OWNER`, `FAMILY`, `owner`) appear in rent/lease/GRM fields — must be guarded.
4. **Placeholder rows.** a la mode/ACI always emit 4 `_UNIT_GROUP` and 4 `UNIT_RENT_SCHEDULE` rows; trailing rows
   are blank for 2–3 unit properties. Use `STRUCTURE/@LivingUnitCount` as the authoritative unit count.
5. **Lease status is overloaded** onto `LeaseStartDate`/`LeaseExpirationDate` (no dedicated status attr).
6. **UAD Quality/Condition** are not on `STRUCTURE`; they live in the subject `COMPARABLE_SALE[seq=0]`
   `SALE_PRICE_ADJUSTMENT` rows (`_Type="Quality"`/`"Condition"`). The condition shown reflects the *as-repaired*
   state; the As-Is condition rating is usually only in the `PropertyCondition` narrative.
7. **Operating expenses / net operating income are not in structured MISMO** (0/10) — PDF/narrative only.
8. **Loan-number attribute name differs** (`AppraiserAdditionalFileIdentifier` vs `AppraiserFileIdentifier`);
   check both.
9. **Supervisory appraiser element is always present but usually empty** — presence ≠ existence; test `_Name`.
10. `ROOM_TYPE_SUMMARY` elements appear but are **empty/self-closing** in all sampled files — not a usable source.
11. Effective date (`AppraisalEffectiveDate`) and signed date (`AppraiserReportSignedDate`) can differ by days;
    do not conflate. Contract date (`SALES_CONTRACT/@_Date`) is a third distinct date.
