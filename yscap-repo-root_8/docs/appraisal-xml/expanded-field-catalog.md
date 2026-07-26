# Expanded Field Catalog — MISMO 2.6 Appraisal XML (the "long tail")

Scope: every **additional** extractable field beyond the already-mapped core set, enumerated
from all **33 stripped appraisal XMLs** (20× FNM1004 URAR, 13× FNM1025 Small Residential Income).
Root is `<VALUATION_RESPONSE MISMOVersionID="2.6">`; data lives in element **attributes** (MISMO
convention — almost nothing is element text; the two exceptions are `AppraisalAddendumText` and
`EMBEDDED_FILE/DOCUMENT`).

Reliability counts are **files-containing / 33**, measured by grepping the attribute/element across
every file. Paths below omit the `VALUATION_RESPONSE` root and the boilerplate
`*_EXTENSION/*_EXTENSION_SECTION/*_EXTENSION_SECTION_DATA` wrapper chain — GSE UAD fields are shown at
their leaf element with a `GSE…` attribute.

### Vendor / form landscape (drives most variation)
| Software (`REPORT@AppraisalSoftwareProductName`) | Files | Notes |
|---|---|---|
| a la mode - TOTAL | 14 (all FNM1004) | Full UAD; single `<FORM>` manifest (no photo pages) |
| ACI | 7 (4×1004, 3×1025) | Full UAD on its 1004s; ACI 1004s also carry rental grids |
| ClickFORMS | 3 (1×1004, 2×1025) | Rich `<FORM>` photo manifest + `AppraisalAddendumText` |
| Appraise-It | 1 (1004) | Full UAD |
| *(blank)* | 8 (all FNM1025) | No software name; no UAD comp extensions |

**Critical rule discovered:** the GSE UAD **comparable-grid extension** fields (`GSEDaysOnMarket`,
`GSEListingStatusType`, `GSESaleType`, `GSEFinancingType`, `GSEConcessionAmount`, `GSEBasementExitType`,
`GSEViewType`, `GSEShortDateDescription`, comp `GSEOverallConditionType`/`GSEQualityOfConstructionRatingType`)
appear in **exactly the 20 FNM1004 files and none of the 13 FNM1025**. It is form-driven, not vendor-driven.
On 1025s the same facts live only inside the plain `SALE_PRICE_ADJUSTMENT@_Description` strings.

---

## 1. Structure / construction detail

| Field | Element path | Attribute | Example | N/33 | Notes |
|---|---|---|---|---|---|
| Foundation type (structured) | `PROPERTY/STRUCTURE/FOUNDATION` | `_Type` / `_ExistsIndicator` | `Crawlspace`,`Basement`,`PartialBasement` / `Y` | 33 | Multiple rows; also `_ConditionDescription="Full/Partial"` |
| Foundation (exterior descr) | `…/STRUCTURE/EXTERIOR_FEATURE[_Type=Foundation]` | `_Description` | `Concrete/avg` | 33 | UAD "material/rating" slash form |
| Exterior walls | `EXTERIOR_FEATURE[_Type=Walls]` | `_Description` | `Brick/avg`, `Alum/Avg` | 33 | |
| Roof surface | `EXTERIOR_FEATURE[_Type=RoofSurface]` | `_Description` | `Asphalt shgl/av` | 33 | |
| Gutters/downspouts | `EXTERIOR_FEATURE[_Type=GuttersAndDownspouts]` | `_Description` | `Aluminum/avg` | 33 | |
| Window type | `EXTERIOR_FEATURE[_Type=WindowType]` | `_Description` | `Wood dh/avg` | 33 | |
| Storm sash / screens | `EXTERIOR_FEATURE[_Type=WindowStormSash / WindowScreens]` | `_Description` | `Avg/avg`, `Yes/avg` | 33 | |
| Basement sq ft | `…/STRUCTURE/BASEMENT` | `SquareFeetCount` | `240`, `1319` | 33 | |
| Basement finished % | `…/STRUCTURE/BASEMENT` | `_FinishedPercent` | `0` | 33 | Often 0 (unfinished) |
| Basement feature | `BASEMENT/BASEMENT_FEATURE` | `_Type`/`_ExistsIndicator` | `OutsideEntry`/`Y` | ~10 | Sparse (a la mode) |
| Heating type | `…/STRUCTURE/HEATING` | `_Type` | `ForcedWarmAir` | 33 | May be a 2nd `HEATING` row for fuel |
| Heating fuel | `…/STRUCTURE/HEATING` | `_FuelDescription` | `Gas` | 33 | |
| Cooling | `…/STRUCTURE/COOLING` | `_CentralizedIndicator` / `_OtherIndicator` / `_UnitDescription` | `Y` / `None` | 32 | |
| Attic | `…/STRUCTURE/ATTIC` (+ `ATTIC_FEATURE`) | `_ExistsIndicator` / feature `_Type` | `DropStair` | 33 | |
| Interior floors | `…/STRUCTURE/INTERIOR_FEATURE[_Type=Floors]` | `_ConditionDescription` | `Hdwd/avg` | 33 | Also Walls, TrimAndFinish, BathroomFloors, BathroomWainscot |
| Fireplace count | `…/STRUCTURE/AMENITY[_Type=Fireplace]` | `_Count` / `_ExistsIndicator` | `0` / `N` | 31 | |
| Woodstove | `AMENITY[_Type=WoodStove]` | `_Count` | `0` | 31 | |
| Pool | `AMENITY[_Type=Pool]` | `_ExistsIndicator`/`_DetailedDescription` | `N`/`None` | 31 | |
| Porch | `AMENITY[_Type=Porch]` | `_ExistsIndicator`/`_DetailedDescription` | `Y`/`Porch` | 32 | |
| Patio/Deck | `AMENITY[_Type=Patio]` / `[_Type=Deck]` | `_DetailedDescription` | `deck` | 28 / 8 | Vendors split "Patio" vs "Deck" inconsistently |
| Fence | `AMENITY[_Type=Fence]` | `_DetailedDescription` | `None` | 31 | |
| Other amenity | `AMENITY[_Type=Other]` | `_TypeOtherDescription` | `None` | ~31 | |
| Car storage container | `…/STRUCTURE/CAR_STORAGE` | `_AttachmentType` / `_ExistsIndicator` | `Attached` | 33 | Attach type only 18/33 |
| Garage / Driveway / Carport spaces | `CAR_STORAGE/CAR_STORAGE_LOCATION` | `_Type` + `ParkingSpacesCount` | `Garage`,`2` | 33 / 33 / 29 | One row per storage type |
| ADU exists indicator | `…/STRUCTURE` | `_AccessoryUnitExistsIndicator` | `N` | 23 | 1004-leaning |
| Stories count | `…/STRUCTURE` | `StoriesCount` | `1`,`3` | 33 | (core-adjacent) |
| Building count | `…/STRUCTURE` | `BuildingCount` | `1` | ~13 | Mostly 1025 |
| **Gross Building Area (1025)** | `…/STRUCTURE` | `GrossBuildingAreaSquareFeetCount` | `3152` | 13 | 1025 only |
| **Per-unit room/bed/bath/GLA (1025)** | `…/STRUCTURE/_UNIT_GROUP` | `UnitType`,`TotalRoomCount`,`TotalBedroomCount`,`TotalBathroomCount`,`GrossLivingAreaSquareFeetCount` | `UnitOne`,`5`,`3`,`1.00`,`1319` | 13 | 1025 only; one row per unit |
| Rent-control status (1025) | `…/STRUCTURE` | `RentControlStatusType` | `No` | 13 | 1025 only |

## 2. Interior features, appliances & update recency

| Field | Element path | Attribute | Example | N/33 | Notes |
|---|---|---|---|---|---|
| Range/oven | `KITCHEN_EQUIPMENT[_Type=RangeOven]` | `_ExistsIndicator` / `_Count` | `Y` / `3` | 32 | 1025 uses `_Count` (per unit) |
| Refrigerator | `KITCHEN_EQUIPMENT[_Type=Refrigerator]` | `_Count`/`_ExistsIndicator` | `3` | 27 | |
| Dishwasher / Disposal / Microwave | `KITCHEN_EQUIPMENT[_Type=…]` | `_ExistsIndicator` | `Y` | 19 | 1004-leaning (a la mode) |
| Kitchen update + recency | `…/CONDITION_DETAIL` (UAD ext) | `GSEImprovementAreaType`,`GSEImprovementDescriptionType`,`GSEEstimateYearOfImprovementType` | `Kitchen`,`Updated`,`LessThanOneYearAgo` | 19 | Structured remodel recency |
| Bath update + recency | same, `GSEImprovementAreaType=Bathrooms` | same | `Bathrooms`,`Updated`,`LessThanOneYearAgo` | 19 | |
| Updated-in-last-15-yr flag | `OVERALL_CONDITION_RATING` (UAD ext) | `GSEUpdateLastFifteenYearIndicator` | `Y` | ~19 | |

## 3. Site / lot

| Field | Element path | Attribute | Example | N/33 | Notes |
|---|---|---|---|---|---|
| Lot dimensions | `PROPERTY/SITE` | `_DimensionsDescription` | `92.5 x 145' x 120' x 152.4'` | 33 | Free text; sometimes `Subject to Survey` |
| Lot area | `PROPERTY/SITE` | `_AreaDescription` | `16117 sf` | 33 | (core-adjacent) |
| Lot shape | `SITE/SITE_FEATURE[_Type=Shape]` | `_Comment` | `Mostly Rectangular` | 33 | |
| View (grid string) | `SITE/SITE_FEATURE[_Type=View]` | `_Comment` | `N;Res;crn` | 33 | UAD coded: rating;type;factor |
| Driveway surface | `SITE/SITE_FEATURE[_Type=Driveway]` | `_Comment` | `Concrete` | 32 | |
| FEMA flood zone | `SITE/FLOOD_ZONE` | `NFIPFloodZoneIdentifier` | `X` | 33 | |
| FEMA map panel # | `SITE/FLOOD_ZONE` | `NFIPMapIdentifier` | `13089C0062K` | 32 | |
| FEMA map/panel date | `SITE/FLOOD_ZONE` | `NFIPMapPanelDate` | `2019-08-15` | 33 | |
| Special flood hazard ind | `SITE/FLOOD_ZONE` | `SpecialFloodHazardAreaIndicator` | `N` | 33 | |
| Utilities (public) | `SITE/SITE_UTILITY[_Type=Electricity/Gas/Water/SanitarySewer]` | `_PublicIndicator` | `Y` | 33 | One row/utility |
| Well/septic (non-public) | `SITE/SITE_UTILITY` | `_NonPublicIndicator`/`_NonPublicDescription` | `N` | 21 | Present when vendor emits both flags |
| Off-site improvements | `PROPERTY/_OFF_SITE_IMPROVEMENT[_Type=Street/Alley]` | `_Description`,`_OwnershipType`,`_ExistsIndicator` | `Asphalt`,`Public`,`Y` | 33 | Street + alley, public/private rows |
| Highest & best use | `PROPERTY/SITE` | `HighestBestUseIndicator` / `HighestBestUseDescription` | `Y` / (text) | 33 | Description text sparse |
| Zoning classification id | `PROPERTY/SITE` | `_ZoningClassificationIdentifier` | `R85`,`RM2` | 33 | |
| Zoning description | `PROPERTY/SITE` | `_ZoningClassificationDescription` | `Single family residential` | 33 | |
| Zoning compliance | `PROPERTY/SITE` | `_ZoningComplianceType` | `Legal` | 33 | + `_ZoningComplianceDescription` |

## 4. HOA / project / PUD

| Field | Element path | Attribute | Example | N/33 | Notes |
|---|---|---|---|---|---|
| PROJECT container | `PROPERTY/PROJECT` | — | — | 33 | Usually empty for these SFR/2-4-unit files |
| Project name | `PROPERTY/PROJECT` | `_Name` | `` (blank) | 22 | Attribute present but nearly always empty |
| PUD indicator | `PROPERTY/…/PROPERTY_TYPE` (UAD ext) | `GSE_PUDIndicator` | `N` | 20 | = all FNM1004; absent on 1025 |
| HOA / per-unit fee | `PROJECT/_PER_UNIT_FEE` | `_Amount` | `0` | 33 | Always `0` in this dataset (no condos) |
| Development stage / unit counts | `PROJECT/DEVELOPMENT_STAGE` | `CompletedUnitsCount`,`PlannedUnitsCount`,`UnitsSoldCount`,`UnitsRentedCount`,`UnitsForSaleCount`,`_TotalPhasesCount` | (all blank) | 22 | Element present, values empty (no PUD/condo) |
| Common elements | `PROJECT` | `_CommonElementsDescription`,`_CommonElementsStatusDescription` | (blank) | ~14 | Empty in dataset |

> No condo/PUD in the 33 samples, so these are structurally present but unpopulated. Reliable **absence** signal (all `PUD=N`, fee `0`).

## 5. Neighborhood & market

| Field | Element path | Attribute | Example | N/33 | Notes |
|---|---|---|---|---|---|
| Location type | `PROPERTY/NEIGHBORHOOD` | `PropertyNeighborhoodLocationType` | `Suburban` | 33 | Urban/Suburban/Rural |
| Built-up % | `NEIGHBORHOOD` | `_BuiltupRangeType` | `Over75Percent` | 33 | |
| Growth | `NEIGHBORHOOD` | `_GrowthPaceType` | `Stable` | 33 | |
| Property-value trend | `NEIGHBORHOOD` | `_PropertyValueTrendType` | `Stable` | 33 | |
| Demand/supply | `NEIGHBORHOOD` | `_DemandSupplyType` | `InBalance` | 33 | |
| Marketing time | `NEIGHBORHOOD` | `_TypicalMarketingTimeDurationType` | `UnderThreeMonths` | 33 | |
| Boundaries description | `NEIGHBORHOOD` | `_BoundaryAndCharacteristicsDescription` | (text) | 33 | Also duplicated in `NEIGHBORHOOD_BOUNDARIES/GSE…` (20) |
| Market-conditions narrative | `NEIGHBORHOOD` | `_MarketConditionsDescription` | (text) | 33 | Sometimes just "See attached MC1004." |
| 1-unit price range (low/high/pred) | `NEIGHBORHOOD/_HOUSING` | `_LowPriceAmount`,`_HighPriceAmount`,`_PredominantPriceAmount` | `244`,`2500`,`500` (×$1000) | 33 | Values in $thousands |
| Age range (old/new/pred) | `NEIGHBORHOOD/_HOUSING` | `_OldestYearsCount`,`_NewestYearsCount`,`_PredominantAgeYearsCount` | `120`,`0`,`50` | 33 | |
| Present land-use % | `NEIGHBORHOOD/_PRESENT_LAND_USE` | `_Type`+`_Percent` | `SingleFamily`,`90` | 33 | Rows sum to 100 |
| **1004MC container** | `REPORT/FORM/MARKET` | `MarketTrendsReconciliationComment`, `SalesConcessionDescription`, `MarketTrendsForeclosureActivityIndicator`, `MarketTrendsAdverseFinancingTrendType`, `NeighborhoodMarketabilityFactorsDescription`, `DataSourceDescription` | `Stable`,`N`,(text) | 29 | Absent in 4 files (1/vendor) |
| **Market inventory grid** | `MARKET/MARKET_INVENTORY` | `_Type` + (`_MonthRangeType`,`_Count`/`_Amount`/`_Rate`/`_TrendType`) | see below | 29 | ~36 rows/file |

`MARKET_INVENTORY` `_Type` values (each × `Prior7To12Months` / `Prior4To6Months` / `Last3Months` + a `_TrendType` row):
`TotalSales` (`_Count`), `AbsorptionRate` (`_Rate`, e.g. `2.00`), `TotalListings` (`_Count`), `Supply`
(`_Count` = months, e.g. `5.26`), `MedianSalesPrice` (`_Amount` `452500`), `MedianSalesDOM` (`_Count` `27`),
`MedianListPrice` (`_Amount`), `MedianListDOM` (`_Count`), `MedianSalesToListRatio` (`_Rate` `103.00`).
`_TrendType` = `Stable`/`Increasing`/`Declining`.

## 6. Tax & legal

| Field | Element path | Attribute | Example | N/33 | Notes |
|---|---|---|---|---|---|
| Tax year | `PROPERTY/_TAX` | `_YearIdentifier` | `2025` | 33 | |
| Annual tax amount | `PROPERTY/_TAX` | `_TotalTaxAmount` | `9,630` / `6266` | 32 | Comma formatting varies; GSE ext `GSEPropertyTaxTotalTaxAmount="9630"` is clean-numeric |
| Special assessments | `PROPERTY/_TAX` | `_TotalSpecialTaxAmount` | `0` | 33 | |
| Property rights | `PROPERTY` | `_RightsType` | `FeeSimple` | 33 | |
| Occupancy | `PROPERTY` | `_CurrentOccupancyType` | `Vacant`,`TenantOccupied` | 33 | |
| Current owner ("owner of record") | `PROPERTY/_OWNER` | `_Name` | `Shahram Famorzadeh` | 32 | Also GSE ext `GSEPropertyOwnerName` |
| Assessor parcel (GSE clean) | `…/PARCEL_IDENTIFIER` (UAD ext) | `GSEAssessorsParcelIdentifier` | `18-106-06-013` | 20 | 1004 only; core APN already mapped |

## 7. Cost-approach breakdown

| Field | Element path | Attribute | Example | N/33 | Notes |
|---|---|---|---|---|---|
| Site value | `VALUATION_METHODS/COST_ANALYSIS` | `SiteEstimatedValueAmount` | `325000` | 32 | |
| Site-value source/comment | `COST_ANALYSIS` | `SiteEstimatedValueComment` | (extraction-method text) | 32 | |
| Cost data source | `COST_ANALYSIS` | `DataSourceDescription` / `DataSourceEffectiveDate` | `DWELLINGCOST.COM`,`Marshall & Swift` | 32 | |
| Cost service quality rating | `COST_ANALYSIS` | `CostServiceQualityRatingDescription` | `5`,`Average` | 32 | |
| Dwelling cost line | `COST_ANALYSIS/NEW_IMPROVEMENT[_Type=Dwelling]` | `SquareFeetCount`,`PricePerSquareFootAmount`,`_CostAmount` | `2258`,`185.67`,`419243` | 33 | |
| Basement/other cost line | `NEW_IMPROVEMENT[_Type=Other]` | same (+`_TypeOtherDescription`) | `240`,`73.63`,`17671` | ~30 | |
| Additional (deck/appl) line | `NEW_IMPROVEMENT[_Type=Additional]` | `_CostDescription`,`_CostAmount` | `deck,appl`,`25000` | ~28 | |
| Garage cost line | `NEW_IMPROVEMENT[_Type=Garage]` | `SquareFeetCount`,`PricePerSquareFootAmount`,`_CostAmount` | `444`,`50.54`,`22440` | 33 | Often `0` |
| Total cost new | `COST_ANALYSIS` | `NewImprovementTotalCostAmount` | `484354` | 33 | |
| Depreciation (phys/func/ext) | `COST_ANALYSIS/DEPRECIATION` | `_PhysicalPercent`/`_PhysicalAmount`, `_FunctionalPercent`/`_FunctionalAmount`, `_ExteriorPercent`/`_ExteriorAmount`, `_TotalAmount` | `50.00`/`242177`; func & ext often blank | 33 | Func 26, Ext 26 (blank when 0) |
| Depreciated cost of improvements | `COST_ANALYSIS` | `NewImprovementDepreciatedCostAmount` | `242177` | 33 | |
| As-is value of site improvements | `COST_ANALYSIS` | `SiteOtherImprovementsAsIsAmount` | `40000` | 32 | |
| Total value by cost approach | `COST_ANALYSIS` | `ValueIndicatedByCostApproachAmount` | `607177` | 32 | (core-adjacent) |
| Remaining economic life | `COST_ANALYSIS` | `EstimatedRemainingEconomicLifeYearsCount` | `30`,`60` | 33 | |
| Effective age | `…/STRUCTURE/STRUCTURE_ANALYSIS` | `EffectiveAgeYearsCount` | `30`,`15` | 32 | Also GSE ext `GSEEffectiveAgeDescription` |

## 8. Sales-comparison full grid (per COMPARABLE_SALE)

Container: `VALUATION_METHODS/SALES_COMPARISON/COMPARABLE_SALE` (`PropertySequenceIdentifier=0` is the
**subject** column; 1..n are comps). 1004 files carry 4–6 comps; 1025 files 3–6 (comps 4-6 often the
"as-is" set). Every listed line = one `SALE_PRICE_ADJUSTMENT` row with `_Type`, `_Description`, and
(on comps) `_Amount`.

| Field | Element path / `_Type` | Attribute | Example | N/33 | Notes |
|---|---|---|---|---|---|
| Comp address | `COMPARABLE_SALE/LOCATION` | `PropertyStreetAddress`,`PropertyCity`,`PropertyState`,`PropertyPostalCode` | `1158 Shepherds Ln NE` | 33 | |
| Comp lat/long | `COMPARABLE_SALE/LOCATION` | `LatitudeNumber`,`LongitudeNumber` | `33.8128013`,`-84.3405083` | 23 | a la mode/ACI; not ClickFORMS |
| Proximity | `LOCATION` | `ProximityToSubjectDescription` | `0.49 miles W` | 33 | |
| Sale price | `COMPARABLE_SALE` | `PropertySalesAmount` | `565000` | 33 | |
| Sale $/GLA | `COMPARABLE_SALE` | `SalesPricePerGrossLivingAreaAmount` | `336.51` | 22 | 1025 uses `SalesPricePerGrossBuildingAreaAmount` |
| Adjusted sale price | `COMPARABLE_SALE` | `AdjustedSalesPriceAmount` | `595410` | 33 | |
| Total net adj $ / positive flag | `COMPARABLE_SALE` | `SalePriceTotalAdjustmentAmount`,`SalesPriceTotalAdjustmentPositiveIndicator` | `30410`,`Y` | 33 | |
| **Gross adj %** | `COMPARABLE_SALE` | `SalesPriceTotalAdjustmentGrossPercent` | `28.9` | 33 | ⚠ "**Sales**Price…" spelling |
| **Net adj %** | `COMPARABLE_SALE` | `SalePriceTotalAdjustmentNetPercent` | `5.4` | 33 | ⚠ "**Sale**Price…" spelling (differs from gross!) |
| Data source / MLS# + DOM | `COMPARABLE_SALE` | `DataSourceDescription` | `FMLS#7676859;DOM 51` | 33 | DOM embedded in string |
| Verification source | `COMPARABLE_SALE` | `DataSourceVerificationDescription` | `CoreLogic Public Records` | 33 | |
| Room/bed/bath (+room adj $) | `COMPARABLE_SALE/ROOM_ADJUSTMENT` | `TotalRoomCount`,`TotalBedroomCount`,`TotalBathroomCount`,`RoomAdjustmentAmount` | `5`,`3`,`2.0`,`+5000` | 33 | 1025 has one ROOM_ADJUSTMENT per unit (`UnitSequenceIdentifier`) |
| Sales/financing concessions | `_Type=SalesConcessions` / `FinancingConcessions` | `_Description` | `ArmLth`, `Conv;15000` | 33 / 32 | |
| Date of sale (coded) | `_Type=DateOfSale` | `_Description`,`_Amount` | `s01/26;c12/25`,`0` | 33 | s=settled, c=contract |
| Location / rights / site / view | `_Type=Location/PropertyRights/SiteArea/View` | `_Description`,`_Amount` | `N;Res;`,`Fee simple`,`12632 sf`,`N;Res;traff` | 33 | |
| Design / quality / age / condition | `_Type=DesignStyle/Quality/Age/Condition` | `_Description`,`_Amount` | `DT1;Ranch`,`Q4`,`75`,`C3` | 33 | |
| GLA / basement area / basement finish | `_Type=GrossLivingArea/BasementArea/BasementFinish` | `_Description`,`_Amount` | `1679`,`0sf`,``,`+52110` | 33 | 1025 uses `_Type=GrossBuildingArea` |
| Functional / heat-cool / energy | `_Type=FunctionalUtility/HeatingCooling/EnergyEfficient` | `_Description`,`_Amount` | `Average`,`FWA;CAC`,`Average` | 33 | |
| Car storage / parking | `_Type=CarStorage` (1004) / `Parking` (1025) | `_Description`,`_Amount` | `2ga2dw`,`+20000` | 33 | |
| Porch/patio/deck | `_Type=PorchDeck` | `_Description`,`_Amount` | `deck`,`` | 33 | |
| "Other" line adjustments | `_Type=Other` | `_TypeOtherDescription`,`_Description`,`_Amount` | `HPI (Time adjs made above)`,`246.12` | 33 | Repeatable |
| Extra feature adj (fireplace/ADU/shed/fence) | `COMPARABLE_SALE/OTHER_FEATURE_ADJUSTMENT` | `PropertyFeatureDescription`,`PropertyFeatureAdjustmentAmount` | `1bd1baADU`,`-65000` | 33 | Free-form; up to 3 rows |
| **Comp DOM (structured)** | `…/COMPARISON_DETAIL` (UAD ext) | `GSEDaysOnMarketDescription` | `51` | 20 | 1004 only |
| **Comp listing status** | `COMPARISON_DETAIL` | `GSEListingStatusType` | `SettledSale`,`ActiveListing` | 20 | 1004 only |
| **Comp sale type** | `COMPARISON_DETAIL` | `GSESaleType` | `ArmsLengthSale` | 20 | 1004 only |
| **Comp financing + concession $** | `COMPARISON_DETAIL` | `GSEFinancingType`,`GSEConcessionAmount` | `Conventional`,`15000` | 20 | 1004 only |
| **Comp below-grade sqft/finish/exit** | `COMPARISON_DETAIL` | `GSEBelowGradeTotalSquareFeetNumber`,`GSEBelowGradeFinishSquareFeetNumber`,`GSEBasementExitType` | `1433`,`0`,`WalkOut` | 20 | 1004 only |
| **Comp settled/contract short dates** | `…/OFFERING_DISPOSITION` (UAD ext) | `GSEShortDateDescription` | `01/26` (settled), `12/25` (contract) | 20 | 1004 only; two rows |
| **Comp condition/quality (coded)** | `COMPARISON_DETAIL` | `GSEOverallConditionType`,`GSEQualityOfConstructionRatingType` | `C3`,`Q4` | 20 | 1004 only |
| **Comp view/location (coded)** | `COMPARISON_VIEW_DETAIL` / `COMPARISON_LOCATION_DETAIL` (+overall-rating) | `GSEViewType`,`GSEViewOverallRatingType`,`GSELocationType`,`GSEOverallLocationRatingType` | `ResidentialView`,`Neutral`,`Residential`,`Neutral` | 20 | 1004 only |
| Research counts (comp pool) | `SALES_COMPARISON/RESEARCH` | `ComparableSalesResearchedCount`,`ComparableListingsResearchedCount`,`*PriceRangeLow/HighAmount` | `12`,`8`,`450000`,`630000` | 33 | Size of the search |

**1025-only per-unit sale metrics** (on `COMPARABLE_SALE`): `SalesPricePerUnitAmount`,
`SalesPricePerRoomAmount`, `SalesPricePerBedroomAmount`, `SalesPricePerGrossBuildingAreaAmount`,
`MonthlyRentAmount`, `GrossMonthlyRentMultiplierFactor`, and their `AdjustedSalesPrice*` siblings — 13/33.

## 9. Prior sales / transfer history

| Field | Element path | Attribute | Example | N/33 | Notes |
|---|---|---|---|---|---|
| Subject has-prior-sale flag + source | `SALES_COMPARISON/RESEARCH/SUBJECT` | `_HasPriorSalesIndicator`,`DataSourceDescription` | `N`,`Corelogic Public Records` | 33 | |
| Comp has-prior-sale flag + source | `RESEARCH/COMPARABLE` | `_HasPriorSalesIndicator`,`DataSourceDescription` | `N`,`Mls,fmls,deeds` | 33 | |
| Subject transfer-history narrative | `SALES_COMPARISON` | `_CurrentSalesAgreementAnalysisComment` | (last-transfer text) | 32 | Often has date/price/deed |
| Per-comp prior sale (date/price/src) | `COMPARABLE_SALE/PRIOR_SALES` | `PropertySalesDate`,`PropertySalesAmount`,`DataSourceDescription`,`DataSourceEffectiveDate` | `08/14/2009`,`278000`,`Pub records`,`2026-05-07` | 33 | Empty when no prior sale; GSE ext `GSEPriorSaleDate`/`GSEPriorSaleComment` (1004) |
| Subject listing history | `PROPERTY/LISTING_HISTORY` | `ListedWithinPreviousYearIndicator`,`ListedWithinPreviousYearDescription` | `Y`, `DOM 16;…listed 04/25/2026 for $545,000 fmls#7750008` | 33 | List date/price/DOM/status packed in text |

## 10. Reconciliation & conditions

| Field | Element path | Attribute | Example | N/33 | Notes |
|---|---|---|---|---|---|
| Approaches-used / weighting summary | `VALUATION/_RECONCILIATION` | `_SummaryComment` | "Most emphasis…sales comparison…" | 33 | |
| Conditions of appraisal | `_RECONCILIATION` | `_ConditionsComment` | "subject to completion…as-is value is $500,000" | 33 | Often carries the 2nd (as-is) value |
| Condition-of-appraisal type(s) | `_RECONCILIATION/_CONDITION_OF_APPRAISAL` | `_Type` | `SubjectToCompletion`,`SubjectToRepairs`,`AsIs` | 33 | 1+ rows; encodes as-is vs ARV subject-to |
| Additional scope/definition note | `VALUATION_METHODS` | `_AdditionalDescription` | (exposure/USPAP text) | ~30 | Exposure time lives here as prose, no discrete attribute |
| Repairs / subject-to narrative | `PROPERTY/PROPERTY_ANALYSIS[_Type=PropertyCondition / QualityAndAppearance]` | `_Comment` | "subject to rehab…$50,000…C4 to C3" | 33 | Rich rehab scope + cost |
| Physical-deficiency flag | `PROPERTY_ANALYSIS[_Type=PhysicalDeficiency]` | `_ExistsIndicator`,`_Comment` | `N` | ~31 | |
| Conforms-to-neighborhood | `PROPERTY_ANALYSIS[_Type=ConformsToNeighborhood]` | `_ExistsIndicator` | `Y` | ~31 | |
| Additional-features note | `PROPERTY_ANALYSIS[_Type=AdditionalFeatures]` | `_Comment` | "Newer roof…<5 years" | ~31 | |

> **Exposure time**: no dedicated attribute (0/33). Present only as prose inside
> `_AdditionalDescription` / comment fields — extract via text, low reliability.

## 11. Income approach detail (1025 — and ACI 1004s)

Container `VALUATION_METHODS/INCOME_ANALYSIS`. Present with structured rent schedule mainly on 1025;
ACI's 1004s also emit rental grids (17/33 have `<MULTIFAMILY_RENTAL>`).

| Field | Element path | Attribute | Example | N/33 | Notes |
|---|---|---|---|---|---|
| GRM | `INCOME_ANALYSIS` | `GrossRentMultiplierFactor` | `115.00` | 27 | 14 of these are 1004 (ACI), 13 are 1025 |
| Est. market monthly rent | `INCOME_ANALYSIS` | `EstimatedMarketMonthlyRentAmount` | `5100` | 32 | Blank on many 1004 |
| Value by income approach | `INCOME_ANALYSIS` | `ValueIndicatedByIncomeApproachAmount` | `586500` | 32 | Often blank on 1004 |
| Subject rent totals (actual/market) | `INCOME_ANALYSIS/MULTIFAMILY_RENT_SCHEDULE` | `RentalActualGrossMonthlyRentAmount`,`RentalEstimatedGrossMonthlyRentAmount`,`RentalActualTotalMonthlyIncomeAmount`,`RentalEstimatedTotalMonthlyIncomeAmount` | `4250`,`5100` | 13 | 1025 |
| Per-unit rent (actual/market, furnished/unfurnished) | `MULTIFAMILY_RENT_SCHEDULE/UNIT_RENT_SCHEDULE` | `UnitActualRentAmount`,`UnitMarketRentAmount`,`UnitUnfurnishedActualRentAmount`,`UnitUnfurnishedMarketRentAmount` | `1550`,`1800` | 13 | one row/unit |
| Lease dates | `UNIT_RENT_SCHEDULE` | `LeaseStartDate`,`LeaseExpirationDate` | `2024-09-01`,`2026-08-31` | 15 | |
| Rent-included utilities | `MULTIFAMILY_RENT_SCHEDULE/RENT_INCLUDES_UTILITY` | `_Type`,`_Indicator` | `Water`,`Y` | 13 | Water/Sewer/Cable/Trash rows |
| Rental comparables | `INCOME_ANALYSIS/MULTIFAMILY_RENTALS/MULTIFAMILY_RENTAL` | `MonthlyRentAmount`,`RentPerGrossBuildingAreaAmount`,`GrossBuildingAreaSquareFeetCount`,`DataSourceDescription`,`RentControlStatusType` | `3600`,`1.19`,`3021`,`MLS#24140844` | 17 | + `LOCATION`, per-unit `RENTAL_UNIT`, `RENTAL_FEATURE` |
| Rental-comp per-unit detail | `MULTIFAMILY_RENTAL/RENTAL_UNIT` | `TotalRoomCount`,`TotalBedroomCount`,`TotalBathroomCount`,`SquareFeetCount`,`MonthlyRentAmount` | `5`,`3`,`1.00`,`1319`,`1800` | 17 | |
| Rental-comp features | `MULTIFAMILY_RENTAL/RENTAL_FEATURE` | `_Type`,`_Description` | `Location`,`Suburban` | 17 | Location/Age/Condition/Lease |

## 12. Report metadata / manifest

| Field | Element path | Attribute | Example | N/33 | Notes |
|---|---|---|---|---|---|
| Form type | `REPORT` | `AppraisalFormType` | `FNM1004`,`FNM1025` | 33 | |
| Form version | `REPORT` | `AppraisalFormVersionIdentifier` | `2005` | 22 | |
| Software product + version | `REPORT` | `AppraisalSoftwareProductName`,`AppraisalSoftwareProductVersionIdentifier` | `a la mode - TOTAL`,`6.322` | 25 | Blank on 8 (no-vendor 1025s) |
| Appraiser file / case # | `REPORT` | `AppraiserFileIdentifier` | `26050185` | 31 | + `AppraiserAdditionalFileIdentifier` (loan/order #) 33 |
| Additional-file label + value | `REPORT` | `AppraiserAdditionalFileIdentifierName`,`AppraiserAdditionalFileIdentifier` | `Loan No.`,`YSCAP258134332` | 33 | Carries the YSCAP loan id |
| Appraisal purpose | `REPORT` | `AppraisalPurposeType` (+`…OtherDescription`) | `Purchase` | 33 | |
| Report signed date | `REPORT` | `AppraiserReportSignedDate` | `2026-05-11` (or `01/28/2026`) | 33 | Date format varies by vendor |
| USPAP report description/type | `REPORT` | `USPAPReportDescription` | `Summary Report` / subject address | 22 | |
| Effective date of appraisal | `VALUATION` | `AppraisalEffectiveDate` | `2026-05-06` | 33 | |
| Inspection date + type | `PARTIES/APPRAISER/INSPECTION` | `InspectionDate`,`AppraisalInspectionPropertyType` | `2026-05-06`,`Subject` | 29 | |
| Appraiser license detail | `APPRAISER/APPRAISER_LICENSE` | `_Type`,`_Identifier`,`_State`,`_ExpirationDate` | `Certificate`,`CR4024`,`GA`,`2027-06-30` | 33 | License #/state/expiry beyond core name |
| Supervisory appraiser | `PARTIES/SUPERVISOR` | `_Name` + license/contact | (usually blank) | 22 | Element present, mostly empty |
| Review appraiser | `PARTIES/REVIEW_APPRAISER` | — | (empty) | ~20 | Present but unpopulated |
| AMC / management company | `PARTIES/…/MANAGEMENT_COMPANY` (UAD ext) | `GSEManagementCompanyName` | `Nationwide Appraisal Network` | 20 | 1004; core AMC already mapped |
| Exhibits / forms manifest | `REPORT/FORM` | `AppraisalReportContentType`,`AppraisalReportContentName`,`AppraisalReportContentIdentifier`,`…SequenceIdentifier` | `SubjectPhotos`,`Photo Comparables 1-2-3` | 7 (full) / 33 (≥1) | ClickFORMS/ACI list every page + photo `_CaptionComment`; a la mode emits 1 FORM only |
| Photo captions | `REPORT/FORM/IMAGE` | `_CaptionComment`,`_Identifier` | `Unit 1 kitchen/` | 7 | Rich room-by-room labels where manifest exists |
| Free-text addendum | `REPORT/FORM` | `AppraisalAddendumText` | (long narrative) | 10 | ClickFORMS + some; scope-of-work, intended-use, market commentary |
| Embedded PDF/photos (stripped) | `REPORT/…/EMBEDDED_FILE/DOCUMENT` | `MIMEType`,`_Type` | `application/pdf` | 33 | Payload stripped to placeholder |

---

## Reliability tiers (ADDITIONAL fields only — core set excluded)

### ALWAYS present (33/33 or 32/33 — safe to rely on for every property profile)
- **Structure:** foundation type, exterior walls/roof/windows/gutters, basement sqft & finished %,
  heating type + fuel, cooling, attic, car-storage (garage/driveway spaces + counts), interior
  floor/wall/trim/bath finishes.
- **Site:** lot dimensions & area, lot shape, view (coded), driveway surface, FEMA flood zone/map
  panel/date/special-hazard flag, all four utilities (public flags), off-site improvements, zoning
  id/description/compliance, highest-&-best-use flag.
- **Neighborhood:** location type, built-up %, growth, value trend, demand/supply, marketing time,
  boundaries text, market-conditions text, 1-unit price & age ranges, present-land-use %s.
- **Tax/legal:** tax year, annual tax, special assessments, property rights, occupancy, owner of record.
- **Cost approach:** dwelling & garage cost lines, total cost new, physical depreciation,
  depreciated cost, as-is site improvements, remaining economic life, effective age, site value.
- **Comp grid (all vendors, from `SALE_PRICE_ADJUSTMENT` strings):** address, proximity, sale price,
  adjusted price, **gross & net adj %**, every adjustment line (location/site/view/design/quality/age/
  condition/GLA/basement/functional/heat-cool/energy/car-storage/porch), data & verification source,
  room/bed/bath, other-feature adjustments, research/search counts.
- **Prior sales:** subject & comp has-prior-sale flags + sources, per-comp prior sale date/price,
  subject listing history, subject transfer narrative.
- **Reconciliation:** approach-weighting summary, conditions comment, condition-of-appraisal type(s),
  rehab/subject-to narrative.
- **Metadata:** form type, appraisal purpose, report signed date, effective date, license #/state/expiry,
  additional-file (loan) id.

### USUALLY present (25–31/33 — reliable with a fallback)
- Cooling detail, patio/porch/fence/pool/fireplace amenities, kitchen appliances (range/fridge),
  well/septic non-public flags, non-public utility detail, cost data source & service-quality,
  functional/external depreciation (blank when zero), inspection date/type, software product+version,
  appraiser file #, income-approach GRM/value (27–32, incl. ACI 1004s), USPAP report desc, form version,
  supervisory appraiser element (present but often empty).

### SOMETIMES present (13–23/33 — form- or vendor-conditional)
- **All GSE UAD comparable-grid extensions** (comp DOM, listing status, sale type, financing,
  concession $, below-grade sqft/finish/exit, coded view/location/condition/quality, settled/contract
  short dates), PUD indicator, GSE clean APN/owner/tax/AMC values → **exactly the 20 FNM1004 files**.
- **All 1025 income & multi-unit structures** (per-unit `_UNIT_GROUP`, gross building area, subject
  rent schedule, per-unit rents, lease dates, rent-included utilities, rental comparables) →
  **the 13 FNM1025** (rental comps 17/33 because ACI's 1004s add them).
- ADU indicator (23), garage attachment type (18), condition-detail update recency (19),
  kitchen/bath remodel recency (19), comp lat/long (23).

### RARELY present / structurally-empty (≤10/33 — do not rely on)
- Full multi-page **FORM/photo manifest** with captions (7 — ClickFORMS/ACI only; a la mode emits one FORM).
- `AppraisalAddendumText` free-text narrative (10 — ClickFORMS-leaning).
- Deck-typed amenity (8 — vendors otherwise fold it into Patio).
- Basement features, project/PUD sub-fields (name, development-stage counts, common elements) — present
  as empty containers (no condo/PUD in the dataset; reliable as a "not a PUD" signal, `PUD=N`/fee `0`).
- **Exposure time** — 0 dedicated attribute; prose only.

### Cross-cutting gotchas
- **Attribute-name inconsistency:** gross adj % is `SalesPriceTotalAdjustmentGrossPercent` but net adj %
  is `SalePriceTotalAdjustmentNetPercent` (Sales vs Sale). Same pattern on `SalePriceTotalAdjustmentAmount`
  vs `SalesPriceTotalAdjustment*Percent`.
- **Date formats vary by vendor:** ISO `2026-05-11` (a la mode/ACI) vs `01/28/2026` (blank-vendor 1025s);
  GSE extension dates are always ISO and cleaner — prefer them on 1004s.
- **Numbers with commas:** `_TotalTaxAmount="9,630"`; the parallel GSE ext value
  (`GSEPropertyTaxTotalTaxAmount="9630"`) is clean-numeric — prefer it where available.
- **Coded UAD strings** in `SITE_FEATURE`/`SALE_PRICE_ADJUSTMENT` descriptions (`N;Res;crn`, `2ga2dw`,
  `s01/26;c12/25`, `240sf0sfwu`) need decoding; the 1004 GSE extensions give the same facts pre-parsed.
- Subject appears as `COMPARABLE_SALE` with `PropertySequenceIdentifier="0"` — exclude it from comp stats.
