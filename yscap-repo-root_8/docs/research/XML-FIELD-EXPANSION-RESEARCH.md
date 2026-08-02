# XML FIELD EXPANSION — what else the appraisal XML can teach the comparable database

**The question this answers (owner, 2026-08-02):** *"look through the entire XML database that we have
now, what other information can we add so it should save on the comparable database."*

**Scope.** Everything the MISMO 2.6 appraisal XML carries that we do **not** store as a first-class
column on `property_observations` or `properties` (db/409) — ranked by how much it would improve
(a) **finding better comparables** and (b) **building an internal AVM**.

**How this differs from the prior audit.** `docs/research/APPRAISAL-FACT-COVERAGE-AUDIT.md` asked a
narrower question: *when the ingest copies the per-file tables into the warehouse, what falls on the
floor between them?* Almost all of its findings have since been fixed — F1's `property_type`/`units`
columns, F2's `condition_text`/`quality_text`, F4's `ON DELETE SET NULL`, F5's `rows_skipped`,
F6's `comp_set_confidence`, F7's `appraisal_photos.identifier`/`comp_seq` (now written at
`src/lib/appraisal/desk.js:188-192`), F8's `condition_basis`, F9's `condo_unit_identifier` fallback,
T13's `gla_basis`, and `unit_mix` are all live in db/409 + the current parser. **This document does
not repeat any of that.** It asks the layer above: *what is in the XML that never reaches the
per-file tables either, or reaches them and then dies inside one loan file?*

---

## 0. METHOD, AND WHAT IS AND IS NOT VERIFIED

**Read in full:** `src/lib/appraisal/extract.js` (1,075 lines), `comp-grid.js`, `xml.js`,
`photo-meta.js`, `import.js`, `src/lib/research/ingest.js`, `src/lib/research/search.js`,
`db/409_property_research_database.sql`, `db/410_property_valuations.sql`, and the enrichment
migrations `db/158`, `162`, `163`, `168`, `169`.

**Corpus measurements are quoted, never invented.** Every frequency below is cited to the file that
measured it:

| Source | Corpus |
|---|---|
| `docs/appraisal-xml/expanded-field-catalog.md` | 33 files (20× FNM1004, 13× FNM1025), counts as `N/33` |
| `docs/appraisal-xml/field-reliability.md` | the same 33, tiered ALWAYS / USUALLY / SOMETIMES / RARELY |
| `docs/appraisal-xml/1004-URAR-field-map.md` | 11 FNM1004 files, counts as `N/11` |
| `docs/appraisal-xml/1025-SmallIncome-field-map.md` | 10 FNM1025 files, counts as `N/10` |
| `docs/appraisal-xml/1073-condo-notes.md` | 4 FNM1073 files, counts as `N/4` |
| `docs/appraisal-xml/photos-comps-variation.md` | 21 files, vendor-behaviour statements |
| `docs/appraisal-xml/per-file-extraction-proof.md` | 33 files, As-Is/ARV recovery proof |

**NO APPRAISAL XML EXISTS ON THIS MACHINE.** Verified: the only XML under `uploads/` is credit-report
`RESPONSE_GROUP/CREDIT_RESPONSE` data (checked by grepping every stored file for
`VALUATION_RESPONSE` — zero hits), and the only in-tree occurrences of `VALUATION_RESPONSE` are the
parser and five hand-written test fixtures. **Nothing here was re-measured against real files.** Any
claim not carrying a citation above is marked **`needs corpus verification`** and must not be treated
as a fact.

**Line-number citations were taken against the tree as of 2026-08-02.** `src/lib/research/ingest.js`
was substantially rewritten by a parallel session the same day (the standalone-XML-import feature,
`db/411`); `ROLLUP_FACTS` and `AS_IS_ONLY` are still at lines 61 and 91, but **prefer the function and
constant names over line numbers** when following any reference here.

**Where the docs are ambiguous, that is said out loud.** "Present in N/33 files" in the catalog means
the *attribute* was found — it does **not** always mean the attribute carried a value. The catalog
itself flags several cases where the element is present and empty (the whole PROJECT/PUD block, the
supervisory appraiser, DEVELOPMENT_STAGE counts). Those are marked below.

---

## 1. WHERE THE DATA ACTUALLY SITS TODAY — five fates

Understanding the gap requires knowing there are **five** different places a fact can end up, only
one of which the comparable database can query:

| Fate | Meaning | Searchable? |
|---|---|---|
| **A — warehouse column** | a first-class column on `property_observations` **and** rolled up onto `properties` | ✅ yes, indexed |
| **B — observation only** | a column on `property_observations` but **not** in `ingest.ROLLUP_FACTS`, so it never reaches `properties` | ⚠️ only by joining every observation — the search engine (`search.js`) queries `properties` alone |
| **C — `appraisals` only** | extracted and stored per file, never copied into the warehouse | ❌ answers "what did THIS report say", nothing cross-file |
| **D — jsonb only** | inside `appraisals.fields`, `property_observations.facts`, or `property_observations.adjustments` | ❌ not indexable, not filterable |
| **E — never extracted** | in the XML, read by nobody | ❌ |

**Fate B is the cheapest, most overlooked loss in the whole system.** These facts are already parsed,
already validated, already written onto the observation row, and are invisible to the search screen
purely because `ROLLUP_FACTS` (`ingest.js:61-78`) does not list them and `properties` has no column:

`sfha` · `fema_flood_zone` · `occupancy_status` · `property_rights` · `remaining_economic_life` ·
`heating_fuel` · `basement_finished_pct` · `attic` · `has_adu` · `lot_shape` · `lot_dimensions` ·
`listed_within_year` · `condo_floor` · `unit_mix` · `gla_basis` · `days_on_market` ·
`concession_amount` · `financing_type` · `data_source` · `proximity`

Nineteen facts, zero parser work, zero new extraction risk. See §5 item R0.

---

## 2. THE GAP TABLE

Every element/attribute the documented corpus shows as **present and populated** that is not a
first-class warehouse column. Grouped by section of the report.

Legend — **Use:** `FILT` comp-search filter · `RANK` comp similarity ranking · `AVM` model feature ·
`PROV` provenance/audit · `DISP` display only.

### 2.1 Neighborhood & market — the whole block is Fate C/D

| MISMO path · attribute | Plain English | Frequency | Fate | Use | Proposed column · type |
|---|---|---|---|---|---|
| `REPORT/FORM/MARKET/MARKET_INVENTORY` `@_Type` + `@_MonthRangeType` + `@_Count`/`@_Amount`/`@_Rate`/`@_TrendType` | **The 1004MC grid.** 9 metrics × 3 periods + a trend row ≈ 36 rows/file: median sale price, median list price, median sale DOM, median list DOM, total sales, total listings, months supply, absorption rate, sale-to-list ratio | **29/33** (catalog §5); "~36 rows/file" | **C+D** — `appraisals.market_trends` jsonb + 4 `mc_*` scalars (db/162) | **AVM (time adjustment), RANK** | **NEW TABLE** `market_series` — see §4 |
| `NEIGHBORHOOD/_HOUSING` `@_LowPriceAmount`, `@_HighPriceAmount`, `@_PredominantPriceAmount` | The market's price band and its predominant price. Values are in **$thousands** (`244` = $244,000) | **33/33** (catalog §5) | **D** — `appraisals.nbhd_price_*` → `observations.facts` | **FILT, AVM** | `market_observations.price_low/high/predominant numeric(14,2)` |
| `NEIGHBORHOOD/_HOUSING` `@_PredominantAgeYearsCount`, `@_OldestYearsCount`, `@_NewestYearsCount` | Predominant / oldest / newest housing age in the market | **33/33** (catalog §5) — only *predominant* is extracted today | **D** (predominant) / **E** (oldest, newest) | **RANK, AVM** | `market_observations.age_predominant/oldest/newest integer` |
| `NEIGHBORHOOD` `@_PropertyValueTrendType`, `@_DemandSupplyType`, `@_TypicalMarketingTimeDurationType`, `@_GrowthPaceType`, `@_BuiltupRangeType` | Increasing/Stable/Declining · Shortage/InBalance/OverSupply · <3mo / 3-6mo / >6mo · Rapid/Stable/Slow · built-up % | **33/33 each** (catalog §5) | **C** (`appraisals.nbhd_*`), partly **D** | **AVM (market temperature), RANK** | `market_observations.value_trend/demand_supply/marketing_time/growth/builtup text` |
| `NEIGHBORHOOD/_PRESENT_LAND_USE` `@_Type` + `@_Percent` | Land-use mix (SingleFamily 90 / Commercial 5 / …), rows sum to 100 | **33/33** (catalog §5) | **C** — `appraisals.present_land_use` jsonb (db/163) | **RANK, AVM** | `market_observations.land_use jsonb` |
| `NEIGHBORHOOD` `@_BoundaryAndCharacteristicsDescription` | The appraiser's own definition of *where this market is* | **33/33** (catalog §5) | **C** — `appraisals.nbhd_boundaries` (db/168) | **PROV** (essential — see §4) | `market_observations.boundaries text` |
| `NEIGHBORHOOD` `@_MarketConditionsDescription`; `MARKET` `@MarketTrendsReconciliationComment` | The market narrative and the appraiser's reconciliation of it | **33/33** / **29/33** (catalog §5) | **C** (db/169) | **PROV, DISP** | `market_observations.conditions_comment/reconciliation_comment text` |
| `MARKET` `@MarketTrendsForeclosureActivityIndicator`, `@MarketTrendsAdverseFinancingTrendType` | Is there foreclosure activity / adverse financing in this market | **29/33** (catalog §5) | **C** — `appraisals.nbhd_foreclosure_activity`, `nbhd_adverse_financing` | **AVM (risk feature)** | `market_observations.foreclosure_activity/adverse_financing boolean` |

### 2.2 Comp-grid facts not carried per comp

| MISMO path · attribute | Plain English | Frequency | Fate | Use | Proposed column · type |
|---|---|---|---|---|---|
| `COMPARABLE_SALE/.../OFFERING_DISPOSITION` `@GSEShortDateDescription` (two rows: settled + contract); also the `s03/25;c07/25` string in `SALE_PRICE_ADJUSTMENT[_Type=DateOfSale]/@_Description` | **The comp's CONTRACT date**, distinct from its settlement date | structured **20/33** (1004 only, catalog §8); the `s../c..` string **33/33** (catalog §8) | **E** — `settledMonth()` (`extract.js:230-244`) parses **only** the `s` date and drops the `c` date entirely | **AVM (this is the correct date for a time adjustment)** | `property_observations.contract_sale_date date` + `contract_sale_date_text text` |
| `COMPARABLE_SALE` `@DataSourceDescription` — e.g. `"FMLS#7676859;DOM 51"`, `"MLS# NJME2063792;DOM 51"` | The **MLS number**, embedded in a string we store whole as `data_source` | **33/33** (catalog §8) | **B** (whole string on the observation, never parsed) | **FILT, PROV (dedupe key)** | `property_observations.mls_number text`, `property_sales.mls_number text` |
| `COMPARABLE_SALE` `@DataSourceVerificationDescription` — `"CoreLogic Public Records"` | How the appraiser *verified* the sale (public record vs MLS vs agent) | **33/33** (catalog §8) | **E** | **RANK (a deed-verified comp is stronger), PROV** | `property_observations.verification_source text` |
| `COMPARISON_DETAIL` `@GSEBasementExitType` — `WalkOut` | Walk-out vs walk-up vs none | **20/33** (1004 only, catalog §8) | **E** | **RANK, AVM** (a walk-out basement is a real price driver) | `property_observations.basement_exit text` |
| `COMPARISON_VIEW_DETAIL` `@GSEViewType`, `COMPARISON_LOCATION_DETAIL` `@GSELocationType` | The view/location **type** codes (`ResidentialView`, `BusyRoad`) as distinct from the Beneficial/Neutral/Adverse **rating** | **20/33** (1004 only, catalog §8) — `GSELocationType` **is** extracted (`location_type`), `GSEViewType` is **not** | **E** (view type) | **RANK** | `property_observations.view_type text` |
| `SALE_PRICE_ADJUSTMENT[_Type=EnergyEfficient]` `@_Description`, `@_Amount` | **The only green/energy field in MISMO 2.6.** The appraiser's energy-efficiency line and the dollars they moved for it | **33/33** as a grid row (catalog §8) — value usually `Average` | **D** — inside `adjustments` jsonb | **RANK, AVM** | `property_observations.energy_note text`, `energy_adj numeric(14,2)` |
| `SALE_PRICE_ADJUSTMENT[_Type=FunctionalUtility \| HeatingCooling]` `@_Description` | Functional utility rating; heat/cool config (`FWA;CAC`) | **33/33** (catalog §8) | **D** — `adjustments` jsonb | **RANK** | `property_observations.functional_utility text`, `hvac_desc text` |
| `SALE_PRICE_ADJUSTMENT[_Type=SalesConcessions \| FinancingConcessions]` `@_Description` — `ArmLth`, `Conv;15000` | Concession/financing **as written on the grid** — the 1025's only source, since `GSEConcessionAmount` is 1004-only | **33/33 / 32/33** (catalog §8) vs `GSEConcessionAmount` **20/33** | **D** — `adjustments` jsonb | **AVM (concessions must be netted before ANY regression)** | `property_observations.concession_text text`, `financing_text text` |
| `SALES_COMPARISON/RESEARCH` `@ComparableSalesResearchedCount`, `@ComparableListingsResearchedCount`, `@Comparable*PriceRangeLow/HighAmount` | **The appraiser's own search scope** — how many sales/listings they looked at and the price range they found | **33/33** (catalog §8) | **C** — `appraisals.comp_research` jsonb (db/168) | **AVM (an independent value bracket), PROV** | `market_observations.pool_sales_count/listings_count/sales_low/sales_high/list_low/list_high` |
| `COMPARABLE_SALE` (1025) `@MonthlyRentAmount`, `@GrossMonthlyRentMultiplierFactor`, `@SalesPricePerUnitAmount`, `@SalesPricePerRoomAmount`, `@SalesPricePerBedroomAmount`, `@SalesPricePerGrossBuildingAreaAmount` | **A 2-4 unit comp's rent, GRM and per-unit/per-room/per-bed price** | **13/33** (catalog §8 "1025-only per-unit sale metrics") | **E — never read by `extract.js`** | **FILT, RANK, AVM (rental AVM)** | `property_observations.monthly_rent numeric(12,2)`, `grm numeric(10,2)`, `price_per_unit numeric(14,2)`, `price_per_room numeric(14,2)`, `price_per_gba numeric(12,2)` |
| `COMPARABLE_SALE` (1025) `@RentControlStatusType` | Is the comp rent-controlled | **13/33** subject-side ~7/10 (catalog §1, 1025 map B2) | **E** | **FILT (a rent-controlled comp is not comparable)** | `property_observations.rent_control text` |

### 2.3 Rental comparables — an entire second grid, never stored

| MISMO path · attribute | Plain English | Frequency | Fate | Use | Proposed |
|---|---|---|---|---|---|
| `INCOME_ANALYSIS/MULTIFAMILY_RENTALS/MULTIFAMILY_RENTAL` (seq ≠ 0) + `/LOCATION` + `/RENTAL_UNIT` + `/RENTAL_FEATURE` | **Up to 3 rental comps per report**, each a real address with `MonthlyRentAmount`, `RentPerGrossBuildingAreaAmount`, `GrossBuildingAreaSquareFeetCount`, `DataSourceDescription` (MLS#), proximity, and per-unit rooms/beds/baths/sqft/rent | **17/33** (catalog §11 — 13 FNM1025 + 4 ACI 1004s) | **E** — `extract.js:1013` **counts** them (`report.rentalGrids`) and stores nothing | **FILT, AVM (a rent AVM)** | **NEW TABLE** `property_rents` — see §5 R6 |
| `MULTIFAMILY_RENT_SCHEDULE` `@RentalActualGrossMonthlyRentAmount`, `@RentalEstimatedGrossMonthlyRentAmount` | The subject's whole-property **actual** vs **market** gross monthly rent | **13/33** (catalog §11) | **D** — extracted into `A.income` → `appraisals.fields` jsonb only; **no column on `appraisals`** | **AVM (rent AVM), FILT** | `property_observations.rent_actual_gross/rent_market_gross numeric(12,2)` |
| `MULTIFAMILY_RENT_SCHEDULE/RENT_INCLUDES_UTILITY` `@_Type` + `@_Indicator` | Which utilities the rent includes (Water/Sewer/Trash/Cable) | **13/33** (catalog §11) | **C** — `appraisals.rent_included_utilities` jsonb | **RANK** (gross vs net rent is not comparable) | `property_observations.rent_includes jsonb` |
| `MULTIFAMILY_RENTAL/RENTAL_FEATURE` `@_Type` + `@_Description` | Rental comp's age/condition/location/lease line | **17/33** (catalog §11) | **E** | **RANK** | `property_rents.features jsonb` |

### 2.4 Subject facts extracted but stranded on `appraisals`

| `appraisals` column (source attribute) | Plain English | Frequency | Fate | Use | Proposed warehouse column |
|---|---|---|---|---|---|
| `property_tax_amount`, `property_tax_year` (`_TAX/@_TotalTaxAmount`, `@_YearIdentifier`) | Annual property tax and its year | **32/33 / 33/33** (catalog §6) | **C** | **FILT, AVM** (carrying cost; the closest thing to an assessment) | `property_observations.tax_amount numeric(14,2)`, `tax_year integer` + roll-up |
| `site_value` (`COST_ANALYSIS/@SiteEstimatedValueAmount`) | **The land value.** Land share of total value varies enormously between markets | **32/33** (catalog §7, field-reliability) | **D** — kept in `observations.facts` only | **AVM (a strong feature)** | `property_observations.site_value numeric(14,2)` |
| `depreciation_physical`, `depreciation_total`, `cost_new_total`, `depreciated_cost_improvements` | The cost approach's depreciation block | **33/33** (catalog §7; functional/external blank when zero, 26/33) | **C** | **AVM (a continuous effective-age proxy that beats the 1-6 condition code)** | `property_observations.cost_new_total`, `depreciation_total numeric(14,2)` |
| `dwelling_cost_new`, `dwelling_sqft`, `dwelling_price_per_sqft` | Replacement cost per square foot **in this market** | **33/33** (catalog §7) | **C** | **AVM (a market-level construction-cost index for free)** | `market_observations.cost_new_per_sqft numeric(12,2)` |
| `remaining_economic_life` | Years of economic life left | **33/33** (catalog §7) | **B** — on the observation, not rolled up | **RANK, AVM** | roll up to `properties` |
| `listing_history` (`LISTING_HISTORY/@ListedWithinPreviousYearDescription`) | **Prior listing:** DOM, list date, list price and MLS# packed into one string — e.g. `"DOM 16;…listed 04/25/2026 for $545,000 fmls#7750008"` | **33/33** (catalog §9) | **C** | **AVM (list-to-sale ratio, true DOM), FILT** | `property_observations.listing_history text` + parsed `list_price numeric(14,2)`, `list_date date`, `subject_dom integer` |
| `sales_agreement_analysis` (`SALES_COMPARISON/@_CurrentSalesAgreementAnalysisComment`) | The subject's transfer-history narrative (often date/price/deed of the last transfer) | **32/33** (catalog §9) | **C** | **PROV, AVM (a second prior-sale source)** | `property_observations.transfer_narrative text` |
| `reconciliation_comment`, `conditions_comment` (`_RECONCILIATION/@_SummaryComment`, `@_ConditionsComment`) | **The reconciliation narrative** — which approach was weighted and why; and the subject-to scope | **33/33 each** (catalog §10) | **C** | **PROV, DISP; the mining source for the as-is condition (below)** | `property_observations.reconciliation_note text`, `conditions_note text` |
| `addendum_text` (`VALUATION_METHODS/@_AdditionalDescription`); `FORM/@AppraisalAddendumText` | Scope of work, intended use, exposure-time prose, market commentary | **~30/33** / **10/33** (catalog §10, §12) | **C** (first) / **E** (second — the FORM-level blob is never read) | **PROV** | `property_observations.addendum_note text` |
| **`PROPERTY_ANALYSIS[_Type=PropertyCondition \| QualityAndAppearance]/@_Comment`** | **The rehab-scope narrative** — *"subject to rehab…$50,000…C4 to C3"*. Per the 1025 map (B2, ~9/10): *"Often states BOTH the As-Is (C4/C5) and As-Repaired (C3) condition ratings."* | **33/33** (catalog §10); the both-ratings behaviour **~9/10** (1025 map B2) | **E — only `PhysicalDeficiency` and `AdverseSiteConditions` are read** (`extract.js:563-567`) | **RANK — this is the single most valuable missing field, see §3** | `property_observations.condition_narrative text`, `condition_as_is_uad text`, `condition_as_is_source text` |
| `view_rating` (`SITE_FEATURE[_Type=View]/@_Comment`, coded `"N;Res;crn"`) | The subject's **UAD view triple**: rating ; type ; factor | **33/33** (catalog §3) | **C then DISCARDED** — `ingest.uadView()` (`ingest.js:692-696`) keeps only `Beneficial/Neutral/Adverse`, so the coded string is dropped for the subject | **RANK** | decode into `view_rating` (existing) + `view_type text` + `view_factor text` |
| `off_site_improvements` (`_OFF_SITE_IMPROVEMENT/@_OwnershipType`) | Public vs **private** street/alley | **33/33** (catalog §3) | **C** | **FILT** (a private road is a real value and financeability issue) | `property_observations.private_road boolean` |
| `occupancy_status`, `property_rights`, `sfha`, `fema_flood_zone`, `attic`, `has_adu`, `lot_shape`, `lot_dimensions`, `listed_within_year`, `heating_fuel`, `basement_finished_pct`, `unit_mix`, `gla_basis`, `condo_floor` | already parsed, already on the observation | ALWAYS/USUALLY (field-reliability) | **B** | **FILT** | roll up to `properties` — §5 R0 |
| `building_status` (`STRUCTURE/@BuildingStatusType`) | Existing / Proposed / UnderConstruction | **33/33** (catalog §1, 1025 map 10/10) | **C** | **FILT** (a proposed building is not a comp for an existing one) | `property_observations.building_status text` |
| `seller_is_owner`, `contract_reviewed`, `concession_indicator`, `concession_description` | Is the contract seller the owner of record; did the appraiser analyse the contract; concession detail | **10/10** on 1025s (1025 map B3); catalog does not give a /33 count | **C** | **PROV, AVM (arm's-length screen)** | `property_observations.seller_is_owner boolean`, `concession_text text` |
| `GrossBuildingAreaSquareFeetCount` (1025 subject) | Gross **building** area, distinct from GLA | **13/33** (catalog §1) | **E** as its own field — the subject stores GLA only | **RANK, AVM** (a 1025's headline area) | `property_observations.gba numeric(12,2)` |
| `_TAX/@_TotalSpecialTaxAmount` | Special assessments | **33/33 present** (catalog §6) — example value is `0`, so **present ≠ populated**; `needs corpus verification` | **E** | **FILT** | `property_observations.special_assessment numeric(14,2)` |
| `SITE/@HighestBestUseIndicator`, `@HighestBestUseDescription` | Is the current use the highest and best use | flag **33/33**; the description is *"sparse"* (catalog §3) — `needs corpus verification` | **E** | **FILT** | `property_observations.highest_best_use boolean` |

### 2.5 Building fabric — present on every file, never read

All of these are **33/33** in the catalog (§1, §2) and all are **Fate E**. Individually small; together
they are the difference between "3 bed / 2 bath / 1,500 sqft" and a real property profile.

| MISMO path | What it says | Frequency | Use |
|---|---|---|---|
| `EXTERIOR_FEATURE[_Type=Walls \| WindowType \| GuttersAndDownspouts \| WindowStormSash \| WindowScreens]` `@_Description` | Exterior walls (`Brick/avg`), window type, gutters — UAD `material/rating` form | 33/33 | RANK |
| `INTERIOR_FEATURE[_Type=Floors \| Walls \| TrimAndFinish \| BathroomFloors \| BathroomWainscot]` `@_ConditionDescription` | Interior finishes (`Hdwd/avg`) | 33/33 | RANK |
| `KITCHEN_EQUIPMENT[_Type=RangeOven \| Refrigerator \| Dishwasher \| Disposal \| Microwave]` | Appliances | 32 / 27 / 19 of 33 | RANK |
| `SITE_FEATURE[_Type=Driveway]` `@_Comment` | Driveway surface | 32/33 | RANK |
| `AMENITY[_Type=Fireplace \| Pool \| Porch \| Patio \| Deck \| Fence \| WoodStove]` | Amenities — **extracted** into `appraisals.amenities` jsonb, then only into `observations.facts` | 28–32/33 | RANK, AVM |
| `CONDITION_DETAIL` `@GSEImprovementAreaType/DescriptionType/EstimateYearOfImprovementType` | **Kitchen/bath remodel + how recently** (`Kitchen`,`Updated`,`LessThanOneYearAgo`) — extracted into `appraisals.updates` jsonb → `facts` | 19/33 (catalog §2) | **RANK, AVM — a directly renovation-relevant signal for this lender's book** |
| `OVERALL_CONDITION_RATING` `@GSEUpdateLastFifteenYearIndicator` | Updated in the last 15 years | ~19/33 | RANK |
| `SITE_UTILITY` `@_PublicIndicator`, `@_NonPublicDescription` | Public water/sewer vs well/septic | 33/33 (well/septic detail 21/33) | **FILT** — well & septic is a hard comparability boundary |

### 2.6 Condo / project block (FNM1073)

| MISMO path | Plain English | Frequency | Fate | Use |
|---|---|---|---|---|
| `PROJECT` `@_Name`, `@_DesignType`, `@ElevatorCount`, `@_PhaseIdentifier`, `@_PrimaryOccupancyType`; `_UNIT` `@UnitIdentifier`, `@FloorIdentifier`, `@LevelCount`; `_PER_UNIT_FEE` `@_Amount`+`@_PeriodType` | Project name/type, elevators, phase, unit + floor + levels, HOA fee | **4/4** on the condo corpus (1073 notes) | project name **C**, floor/fee **B** | **FILT — unit-in-the-same-project is the single strongest condo comp filter there is** |
| `PROJECT/DEVELOPMENT_STAGE` `@PlannedUnitsCount`, `@CompletedUnitsCount`, `@UnitsSoldCount`, `@UnitsRentedCount`, `@OwnerOccupiedUnitCount` | Project sell-out and owner-occupancy | catalog: **22/33 present but "values empty"** — that corpus has no condos. The 1073 notes do **not** measure them. **`needs corpus verification`** | **C** (extracted by `extract.js:725-731`) | FILT |
| `PROJECT` `@_CommonElementsDescription`, `@_CommercialSpaceIndicator`, `@_ManagementType`, `@_ConcentratedOwnershipIndicator` | Common elements, commercial space, management, concentrated ownership | same caveat — **`needs corpus verification`** | **C** | FILT |

### 2.7 Report metadata

| MISMO path | Plain English | Frequency | Fate | Use |
|---|---|---|---|---|
| `REPORT` `@AppraisalSoftwareProductName` + version | The vendor that produced the file — which **determines which fields exist at all** (catalog: the GSE UAD comp extensions appear in exactly the 20 FNM1004 files) | **25/33** (blank on 8; per `photos-comps-variation.md` the blanks are all a la mode) | **E** | **PROV — a per-observation data-quality tier** |
| `REPORT` `@AppraiserFileIdentifier`, `@AppraiserAdditionalFileIdentifier` (+ its `…Name` label) | The appraiser's own file number and the client's loan number (`YSCAP…`) | **31/33 / 33/33** (catalog §12) | **E** | PROV |
| `REPORT` `@AppraisalPurposeType`, `@USPAPReportDescription`, `@AppraisalFormVersionIdentifier` | Purchase/Refinance; report type; form version | 33/33 · 22/33 · 22/33 | **C** | PROV |
| `INSPECTION` `@AppraisalInspectionType` | Interior/exterior/desktop — **how much the appraiser actually saw** | 29/33 (catalog §12) | **C** | **RANK — a drive-by comp opinion is weaker evidence than an interior one** |
| `PARTIES/LENDER`, `MANAGEMENT_COMPANY/@GSEManagementCompanyName` | Client lender and AMC | 33/33 · 20/33 | **C** | PROV |

---

## 3. THE RANKED TOP 15 — what to add, and exactly why

Ranked by value to the two goals, **not** by ease. Where an item is expensive, that is said.

---

### #1 — The 1004MC market grid → a real time adjustment
`MARKET/MARKET_INVENTORY` · **29/33** · Fate C+D → **new `market_series` table**

**Why it is first.** Every AVM and every comp grid needs to answer *"this comp sold 9 months ago —
what is it worth today?"*, and today we answer it with an older-half-vs-newer-half read of median
price per foot (`docs/PROPERTY-COMP-DATABASE-RESEARCH.md` §11.3 calls this "honest but crude").
The 1004MC grid hands us, **per report**, three consecutive periods of median sale price, median DOM,
months of supply, absorption rate and sale-to-list ratio for that report's market. Twenty reports in
one county over two years is a **measured price path** built from appraiser-verified medians, not from
our own thin comp sample. That converts the time adjustment from a guess into a citable number and
gives the AVM four market-temperature features (DOM, supply, absorption, sale-to-list) that nothing
else in the file provides.

**Concretely:** a comp that settled in Q3 2025 in a market whose 1004MC median moved from $452,500 to
$471,000 over the same window carries a defensible **+4.1% time adjustment** with a stated source —
instead of a $0 adjustment, which FHFA found on 87% of purchase appraisals 2018-2021
(`COMP-DATABASE-INDUSTRY-RESEARCH.md` §3.4) and which Fannie now treats as an *unacceptable appraisal
practice*.

**The honest caveat, stated up front:** Fannie removed the requirement to complete Form 1004MC in
2018 (`COMP-DATABASE-INDUSTRY-RESEARCH.md` §3.4 — *"do not build the pipeline assuming it"*). Our own
corpus is 29/33, which is high, but that reflects **our** vendors and may thin over time. Build the
table so that a market with too few observations reports "not enough data" rather than a number.

---

### #2 — The neighborhood price band and predominant age
`NEIGHBORHOOD/_HOUSING` low/high/predominant + predominant/oldest/newest age · **33/33** · Fate D → **`market_observations`**

**Comp finding.** The single cheapest sanity filter there is: *is this comp inside its own market's
stated price range?* A comp at $900,000 in a market the appraiser said runs $244k–$500k is either a
different market or a data error, and today nothing catches it. Same for age — a 1998 comp in a market
whose predominant age is 120 years is not comparable, however close it is.

**AVM.** The price band is a free, per-market prior that constrains the model's output before a single
comp is weighted, and the predominant age is a market-level depreciation anchor.

**Watch the units:** these are in **$thousands** (`244` = $244,000). `extract.js:82` (`thousands()`)
already handles this with a magnitude guard; the warehouse column must store dollars.

---

### #3 — The as-is condition, mined out of the PropertyCondition narrative
`PROPERTY_ANALYSIS[_Type=PropertyCondition]/@_Comment` · **33/33** · Fate E → `condition_as_is_uad`

**This is the most valuable single missing field, and it is a direct fix to a known hole.** The owner
called condition *"the single most important comparable fact"*. On a renovation report the subject's
`condition_uad` is the **after-repair** rating, and db/409 is correct to refuse to roll that up as the
property's condition today (`AS_IS_ONLY`, `ingest.js:91`). The consequence is that **every renovation
file we own — which is most of them — contributes a subject property with `condition_uad = NULL` in
the warehouse.** We deliberately store nothing rather than store a future state.

The 1025 field map (B2, observed ~9/10 files) records that this narrative *"often states BOTH the
As-Is (C4/C5) and As-Repaired (C3) condition ratings"* — literally *"C4 … as-is value. C3 for As
repaired value"*. That is the missing rating, in a field that is present on 33/33 files and that
nobody reads.

**Mine it under the repo's existing discipline:** accept only a `C1`–`C6` token that sits within an
as-is-labelled clause (reuse `comp-grid.js`'s `LABEL_ASIS`/`NOT_A_VALUE` regex family, which already
knows that *"as-is condition"* and *"as-is value"* are different statements), record
`condition_as_is_source = 'narrative'` beside it, and leave it null on anything ambiguous. Never let a
mined value overwrite a stated `AsIs`-basis rating.

**Payoff:** the warehouse's most important comp filter becomes populated on the properties we actually
lend against, instead of only on straight as-is purchases.

---

### #4 — The comp's CONTRACT date
`OFFERING_DISPOSITION/@GSEShortDateDescription` (20/33) and the `s../c..` string (33/33) · Fate E

**Time adjustment must run off the date the price was AGREED, not the date the deed recorded.** The
gap between contract and settlement is routinely 30–90 days, and in a moving market that is the whole
adjustment. `settledMonth()` (`extract.js:230-244`) already parses the UAD `s03/25;c07/25` string —
and reads **only the `s`**, discarding the `c` on the same line. This is a handful of lines in a
function that already runs, applied to a string that is present on **33/33** files.

**Also fixes a real precision problem:** T1 in the prior audit noted that `sale_date`'s day is always
synthetic (`YYYY-MM-01`). The contract date has the same month resolution, which is fine — but two
dates give you the **contract-to-close lag**, which is itself an excellent market-liquidity feature
for the AVM and is available for free.

---

### #5 — The MLS number, parsed out of `DataSourceDescription`
`"FMLS#7676859;DOM 51"` · **33/33** · Fate B (whole string) → `mls_number`

**Comp finding.** We currently dedupe properties on a normalized address (`property-key.js`), which is
correct and offline — but two reports spelling one address differently, or a unit designator appearing
on one and not the other, still splits a property in two. The MLS number is a **vendor-independent,
transaction-level identity** that is present on every file. Matching on it gives:

- a second dedupe key that catches what the address key misses;
- **conflict detection** — the same MLS sale reported at two different prices by two appraisers is a
  review signal nobody else in the market can compute (`PROPERTY-COMP-DATABASE-RESEARCH.md` §11.2);
- a join key to any future MLS feed, the day one exists.

`property_sales` should carry it too — a sale is the thing the MLS number identifies.

---

### #6 — The 1025 comp's rent, GRM and per-unit price
`MonthlyRentAmount`, `GrossMonthlyRentMultiplierFactor`, `SalesPricePerUnitAmount`,
`SalesPricePerRoomAmount`, `SalesPricePerGrossBuildingAreaAmount` · **13/33** · Fate E

**2-4 unit property is a large share of this lender's book, and for that book price-per-unit and GRM
are the metrics the market actually trades on** — not price per square foot. These attributes sit on
the `COMPARABLE_SALE` element itself (no parsing, no narrative mining, no adjustment-line archaeology)
and `extract.js` simply never reads them.

**Comp finding:** "3-family, $180k–$220k per unit, GRM under 120" is the query a small-income
investor actually asks, and it is unanswerable today.
**AVM:** GRM and price-per-unit give the small-income model two independent value indications the
single-family model does not have.

---

### #7 — The appraiser's own search scope
`SALES_COMPARISON/RESEARCH` counts + price ranges · **33/33** · Fate C (`comp_research` jsonb)

The appraiser looked at 12 sales and 8 listings and found them between $450,000 and $630,000. That is
**an independent value bracket for the subject, stated by a licensed professional, on every single
file**, and it never reaches the warehouse.

**AVM:** the strongest cheap sanity check available — if our model's answer sits outside the range the
appraiser's own market search found, say so loudly rather than printing the number.
**Comp finding:** it also measures **our own coverage**. If the appraiser researched 22 sales in a
market where our warehouse holds 4, we know exactly how thin we are there — and that measure belongs
in the market table, not in one loan file.

---

### #8 — Site (land) value and the depreciation block
`SiteEstimatedValueAmount` (32/33), `DEPRECIATION/@_PhysicalAmount`/`@_TotalAmount`,
`NewImprovementTotalCostAmount` (33/33) · Fate C/D

**AVM.** Two genuinely strong features hiding in the cost approach:

1. **Land value.** The land share of total value is one of the largest sources of variation between
   markets, and it is the reason a 1,200 sqft house in one town is worth double the same house four
   towns over. `site_value / appraised_value` is a per-property, per-market feature nothing else in
   the file supplies. (Note the near-collision guarded at `extract.js:136`:
   `SiteOtherImprovementsAsIsAmount` is the value of the **driveway and landscaping**, not the land
   and never the property's as-is value.)
2. **Depreciation as a continuous effective-age.** `depreciation_total / cost_new_total` is a smooth
   0–1 measure of how used-up the improvements are. The C1–C6 code is a six-bucket ordinal; this is
   the same idea with real resolution, and appraisers compute it on 33/33 files.

Dwelling cost-new per square foot (33/33) additionally gives a **per-market construction-cost index**
for free — directly relevant to a renovation lender's ARV work.

---

### #9 — Property tax amount and year
`_TAX/@_TotalTaxAmount` (32/33), `@_YearIdentifier` (33/33) · Fate C

**The appraisal does not carry an assessed value** (see §6), but it does carry the tax bill. For an
investor-property warehouse this is a first-class fact: it is a carrying cost that goes straight into
a DSCR calculation, it is a rough proxy for the assessment where local ratios are known, and
"tax under $8k" is a real comp filter in high-tax states. It is also a **cross-check on identity** —
two reports on one address with wildly different tax bills are probably not the same parcel.

Prefer the GSE-extension value where it exists: the catalog (§6) notes `_TotalTaxAmount` carries
commas (`"9,630"`) while `GSEPropertyTaxTotalTaxAmount` is clean-numeric (`"9630"`).

---

### #10 — Rental comparables as real rows
`MULTIFAMILY_RENTALS/MULTIFAMILY_RENTAL` · **17/33** · Fate E (counted only)

Up to three per report, each with a **street address, a monthly rent, rent per square foot, gross
building area, an MLS number, proximity and a per-unit breakdown** — and `extract.js:1013` does
nothing with them but count them. These are properties. They belong in `properties` like everything
else.

**Why it matters:** it is the only path to a **rent AVM**, which for a fix-and-hold or DSCR book is as
important as the sale AVM. It also grows the warehouse's property count from a source that costs
nothing new — 17 of 33 files × up to 3 addresses each.

**Do not fold them into `property_observations` as `role='comparable'`.** A rental comp has no sale
price, and every existing query that filters `role='comparable'` would silently start counting them.
Give rents their own table (§5 R6).

---

### #11 — The reconciliation and rehab-scope narratives
`_RECONCILIATION/@_SummaryComment`, `@_ConditionsComment` (33/33 each),
`PROPERTY_ANALYSIS` comments (33/33), `VALUATION_METHODS/@_AdditionalDescription` (~30/33) · Fate C

Not a model feature — a **provenance and mining** layer, and the reason #3 is possible at all.

- The reconciliation summary states which approach carried the weight ("most emphasis … sales
  comparison"), which tells the AVM how much to trust that report's number as a training label.
- The conditions comment is the subject-to scope, and it very frequently carries the **second dollar
  value** — the per-file extraction proof shows the As-Is was recovered from narrative on **21 of 33**
  files, so this is a proven-productive text field, not a hope.
- The `PropertyCondition` narrative is where #3's as-is rating lives, and often a **rehab cost
  estimate** in the appraiser's own words (*"subject to rehab…$50,000…C4 to C3"*).

Store them on the observation so a property's page can show *what the appraiser actually said* without
a join back into a loan file that may have been purged.

---

### #12 — Subject listing history
`LISTING_HISTORY/@ListedWithinPreviousYearIndicator` + `@…Description` · **33/33** · Fate C

`"DOM 16;…listed 04/25/2026 for $545,000 fmls#7750008"` — one string holding the **list price, the
list date, the days on market and the MLS number**. This is the only MLS-shaped listing history in the
whole document, it is on every file, and today we keep only the boolean *"was it listed"* on the
observation (`listed_within_year`) and the raw string on `appraisals`.

**AVM:** list-to-sale ratio and true DOM are two of the most predictive short-horizon features in any
residential model, and they are the property-level twin of the 1004MC market-level metrics in #1.
**Comp finding:** "listed and withdrawn twice in a year" is a distress signal worth surfacing.

Parse conservatively: take a price only when it sits next to a `$`, a date only when it is a full
calendar date, DOM only when it follows the literal token `DOM`. Everything else stays as text.

---

### #13 — The UAD view triple and the view/location TYPE codes
`SITE_FEATURE[_Type=View]/@_Comment` (`"N;Res;crn"`, 33/33) · `GSEViewType` (20/33) · Fate C-then-discarded / E

**A real, quiet bug worth naming:** `ingest.uadView()` accepts only
`Beneficial|Neutral|Adverse` — and the SUBJECT's view is not that vocabulary, it is the coded triple
`rating;type;factor`. So on **every single subject** the view is currently dropped on the way into the
warehouse. That is documented as intentional (one column, two vocabularies — prior audit T12), and the
right fix is not to relax the column but to **decode**: `N;Res;crn` is rating `N`(eutral), type
`Res`(idential), factor `crn` (corner lot). Rating maps cleanly onto the comps' enum; type and factor
get their own columns.

**Comp finding:** view and location are two of the largest single adjustment lines on any grid. Being
able to say *"exclude comps on a busy road"* (`GSELocationType = BusyRoad`) is a filter with immediate
value, and `location_type` is already extracted — `view_type` is the missing half.

---

### #14 — Energy-efficiency, basement exit, functional utility and HVAC
`SALE_PRICE_ADJUSTMENT[_Type=EnergyEfficient|FunctionalUtility|HeatingCooling]` (33/33, Fate D) ·
`GSEBasementExitType` (20/33, Fate E)

**On the owner's "green items" question, the honest answer is: MISMO 2.6 has almost nothing.** There
is no solar field, no HERS score, no energy-rating element anywhere in the documented corpus. The
**only** energy signal is the `EnergyEfficient` grid line — present on 33/33 files, usually reading
`Average`, occasionally carrying a dollar adjustment. That is worth capturing precisely *because* it
is all there is: the day an appraiser writes something other than `Average` there, we should be able
to find it.

Bundled here because they share a mechanism (all four are grid lines or 1004-only extension
attributes) and none individually justifies its own rank:

- **`GSEBasementExitType = WalkOut`** — a walk-out basement is a genuine value driver and a hard
  comparability boundary for a below-grade GLA comparison.
- **`FunctionalUtility`** — the appraiser's judgement on layout; a `Poor` here explains a large
  negative adjustment the AVM would otherwise model as noise.
- **`HeatingCooling` (`FWA;CAC`)** — central air vs none is one of the most consistently adjusted
  features on the grid, and the subject's `cooling` column already exists while the comps' equivalent
  is buried in jsonb.

**The dollars matter as much as the descriptions.** Every one of these lines carries an `_Amount` —
**what an appraiser in this market actually paid for that feature.** Which leads directly to:

---

### #15 — Normalize the adjustment lines out of jsonb into rows
`property_observations.adjustments` jsonb · every line, 33/33 · Fate D

Already named as the top follow-up in `PROPERTY-COMP-DATABASE-RESEARCH.md` §11.1, and it belongs in
this list because it is the **only** item here that turns the warehouse into something no data vendor
sells: *a corpus of real appraiser adjustments in our own markets*.

As rows keyed by line type it becomes one `GROUP BY`: **"what are appraisers actually paying per
bathroom in Paterson? per square foot in Lakewood? for a garage in New Haven?"** — which is precisely
what the valuation tool's `suggest` pass (`src/lib/research/valuation.js`) currently has to derive
from a median-of-ratios read over a handful of comps, and which it refuses to answer at all when the
sample is too small or points the wrong way.

It is ranked last of the fifteen only because it is the most work and touches the most existing code,
not because it is worth least. On value alone it is top three.

**Two disciplines to carry over:** the sign of an adjustment is not always in the amount
(`SalesPriceTotalAdjustmentPositiveIndicator`, handled at `extract.js:387-394` for the total — the
per-line rows need the same care), and an adjustment of `0` is a **statement** ("no difference"),
not missing data.

---

### Below the line — worth doing, not worth arguing for

`INSPECTION/@AppraisalInspectionType` (29/33 — a desktop comp opinion is weaker evidence than an
interior one, and it is a natural weight in any comp ranking) · `SITE_UTILITY` well/septic flags
(33/33 — a hard comparability boundary) · `CONDITION_DETAIL` kitchen/bath remodel recency (19/33 —
directly relevant to a renovation lender) · `building_status` (33/33) · `RentControlStatusType`
(13/33) · `private_road` from `_OFF_SITE_IMPROVEMENT` (33/33) · exterior/interior/appliance fabric
(§2.5) · `AppraisalSoftwareProductName` as a per-observation data-quality tier (25/33) ·
`DataSourceVerificationDescription` (33/33) · `HighestBestUseIndicator` (33/33) ·
`GrossBuildingAreaSquareFeetCount` for 1025 subjects (13/33).

---

## 4. MARKET-LEVEL AND TIME-SERIES FACTS — they need their own home

**The warehouse has no home for "what was the market doing in this ZIP in Q2 2025."** Every table in
db/409 is keyed on a property. The 1004MC grid, the neighborhood price band, the demand/supply
reading, the marketing time, the land-use mix and the appraiser's search-pool counts are **not facts
about a property** — they are facts about a *market at a point in time*, and forcing them onto
`property_observations` would duplicate the same 36 numbers onto every comp in the report and make
"the market's median price" a property attribute, which it is not.

### 4.1 What is market-level, not property-level

| Fact | Frequency | Shape |
|---|---|---|
| 1004MC: median sale price, median list price, median sale DOM, median list DOM, total sales, total listings, months supply, absorption rate, sale-to-list ratio | **29/33** | **TIME SERIES** — 3 periods each + a trend row |
| Neighborhood price low / high / predominant | 33/33 | point-in-time |
| Predominant / oldest / newest age | 33/33 | point-in-time |
| Value trend, demand/supply, marketing time, growth, built-up % | 33/33 | point-in-time |
| Present land-use mix | 33/33 | point-in-time |
| Foreclosure activity, adverse financing | 29/33 | point-in-time |
| Appraiser's search pool: sales/listings researched + price ranges | 33/33 | point-in-time |
| Dwelling cost-new per square foot | 33/33 | point-in-time (a construction-cost index) |

### 4.2 The proposal — two tables, keyed by geography + period

**`market_observations`** — one row per (report × market). The point-in-time snapshot.
**`market_series`** — one row per (report × metric × period). The 1004MC time series proper.

Both hang off the appraisal that stated them (`ON DELETE SET NULL`, same durability rule as
`property_observations` — a market reading does not stop being true because a loan file was purged)
and off the subject property, so "show me every market reading near this address" is one join.

### 4.3 THE HARD PART — what geography is a "market"?

**The 1004MC grid describes the appraiser's own defined neighborhood, not a ZIP.** Two reports on the
same street can define different market areas, and the report tells you so only in prose
(`_BoundaryAndCharacteristicsDescription`, 33/33). So the honest design is:

1. **Store every geography key the report actually states** — state, county, city, ZIP, census tract,
   neighborhood name — copied from the subject, plus the **boundary text verbatim**. Never invent a
   market id.
2. **Aggregate at query time, never at write time**, and always state the aggregation level. A "ZIP
   median" is *"the median of what N appraisers said about markets whose subject was in this ZIP"* —
   which is a defensible statistic if you say that, and a fabrication if you call it "the ZIP's median
   price."
3. **Refuse below a threshold.** With fewer than N observations in a geography/period, the answer is
   "not enough data", not a number. This is the same discipline `valuation.js` already applies to
   derived adjustment rates (it refuses a rate on too small a sample, and refuses one that points the
   wrong way).
4. **Period dates are DERIVED, and must be labelled as such.** The 1004MC periods are relative to the
   report's effective date: `Last3Months` = effective − 3mo → effective; `Prior4To6Months` =
   effective − 6mo → effective − 4mo; `Prior7To12Months` = effective − 12mo → effective − 7mo. That
   derivation is deterministic and safe, but the columns must be named so nobody mistakes them for
   dates the report stated.

### 4.4 What it unlocks

- **A defensible time adjustment** (#1) — the market's own median price path, per period, with a
  source, instead of an older-half/newer-half read of our own thin sample.
- **Market-temperature AVM features** — DOM, months of supply, absorption rate and sale-to-list ratio
  as continuous inputs, none of which exist anywhere else in our data.
- **A market-conditions flag on every comp** — "this comp sold in a market the appraiser called
  *Declining* with 8 months of supply" is a ranking signal and a review finding.
- **A coverage map** — comparing `pool_sales_count` (what the appraiser found) against our own
  property count in the same geography tells us, per market, exactly how thin the warehouse is.
- **Cross-appraiser conflict detection** — two reports in the same market and period reporting
  different medians is a real review signal.
- **A construction-cost index** — dwelling cost-new per square foot by market and period, which for a
  renovation lender is directly useful when sanity-checking a rehab budget against an ARV.

---

## 5. RECOMMENDED WORK, ORDERED

**R0 — Roll up what we already have (no parser change at all).** Nineteen facts sit on
`property_observations` and never reach `properties`, so the search screen cannot filter on them
(§1, Fate B). Add the columns and the `ROLLUP_FACTS` entries. Highest value per unit of risk in this
entire document.

**R1 — The market tables** (§4). New tables only; nothing existing changes. The extractor already
produces the whole 1004MC grid (`extract.js:503-541`) and every neighborhood field — this is almost
entirely a *writing* change in `ingest.js`, not a parsing one.

**R2 — Contract date + MLS number + verification source** (#4, #5). Small, surgical parser changes to
strings we already read.

**R3 — The as-is condition narrative** (#3). The highest-value single field, but it is narrative
mining and must be built to the repo's never-guess standard, with a `_source` column and a bias
toward returning null.

**R4 — Tax, site value, depreciation, listing history, cost-new** (#8, #9, #12). Pure plumbing:
already-extracted `appraisals` columns that need warehouse twins.

**R5 — The 1025 comp rent/GRM/per-unit block** (#6). New attribute reads on an element already
iterated.

**R6 — Rental comps as rows** (#10). New table + new extraction.

**R7 — Adjustment lines as rows** (#15). The biggest, and the one that changes what the database *is*.

---

## 6. WHAT IS **NOT** IN AN APPRAISAL XML — stop looking

Every one of these has been checked against the corpus documentation. Nobody should spend a day
hunting for them.

| Fact | Status | What a future source would have to supply |
|---|---|---|
| **A comparable's property type / unit count** | **NOT PRESENT.** The documented `SALE_PRICE_ADJUSTMENT/@_Type` vocabulary (`photos-comps-variation.md` §c) contains no unit-count or property-type row, and the prior audit's F1 reached the same conclusion. db/409 §7 records the resolution: the warehouse answers it when that same address turns up as some **other** report's subject — and never inherits it from the report the comp is on | MLS property-type field, or an assessor/public-record parcel feed |
| **A comparable's lot size as a number** | **PARTIAL.** Only as the `SiteArea` adjustment line's free-text description (`"12632 sf"`), which `ingest.fromAdjustments` already mines into `lot_area`/`lot_sqft`. It is a description, not a measured field, and it is absent whenever the appraiser wrote no site line | assessor parcel record |
| **A comparable's APN, owner name, or seller** | **NOT PRESENT.** `PRIOR_SALES` gives a comp's previous sale date/price and nothing about the parties | deed/public record |
| **School district, school ratings, attendance zone** | **NOT PRESENT — anywhere, on any form** | a schools data vendor (GreatSchools, NCES) joined on geography |
| **Assessed value / assessment ratio** | **NOT PRESENT.** The report carries the tax **bill** (`_TotalTaxAmount`, 32/33) and the tax year, never the assessment | county assessor feed |
| **Parcel geometry / lot polygon / frontage coordinates** | **NOT PRESENT.** Only `_DimensionsDescription` free text (`"92.5 x 145' x 120' x 152.4'"`) and the APN | parcel GIS (Regrid, county GIS) |
| **The SUBJECT's latitude/longitude** | **NOT PRESENT.** `LatitudeNumber`/`LongitudeNumber` appear only on `COMPARABLE_SALE/LOCATION`, 23/33 (catalog §8). The subject has no coordinates on any form. A subject only gains them by being someone else's comp, or by geocoding | geocoder (the repo already has `lib/address-canon`, deliberately not used by the warehouse's offline key) |
| **Per-photo image pixels** | **NOT PRESENT.** `photos-comps-variation.md`: `<IMAGE>` elements are metadata-only placeholders; the sole pixel payload is the one embedded report PDF, and **~60% of files carry no per-photo metadata at all** | the PDF (which is what `photos.js` already mines) |
| **Operating expenses / NOI on a 1025** | **NOT PRESENT — 0/10** (1025 map §F.7). Only the utility-inclusion flags are structured; the form's expense lines live in the PDF | rent roll / T-12 from the borrower |
| **Exposure time** | **NOT PRESENT — 0/33** as a dedicated attribute (catalog §10). Prose only, inside `_AdditionalDescription` | — |
| **A full transaction history** | **NOT PRESENT.** Exactly **one** `PRIOR_SALES` per comp and one per subject. There is no chain of transfers | deed history feed |
| **HOA fee on a non-condo property** | **STRUCTURALLY PRESENT, EMPTY.** `_PER_UNIT_FEE/@_Amount` is on 33/33 files and is `0` in all of them because that corpus has no condos (catalog §4). Real fees appear on the 1073s (4/4) | — |
| **Condo project sell-out / owner-occupancy counts** | **UNVERIFIED.** `DEVELOPMENT_STAGE` is present-but-empty on 22/33 of the SFR/2-4 corpus, and the 4-file condo corpus was never measured for it. **`needs corpus verification`** before relying on it | — |
| **Energy rating / solar / HERS / green certification** | **NOT PRESENT.** The only energy field in the whole schema is the `EnergyEfficient` grid line (#14) | a green-certification registry |
| **Permits, liens, mortgages, crime, walkability, flood-insurance premium, days-to-close** | **NOT PRESENT** | third-party data vendors |
| **A comp's DOM as a number on a 1025** | **NOT PRESENT.** `GSEDaysOnMarketDescription` is 1004-only (20/33). On a 1025 the DOM is embedded in the `DataSourceDescription` string, if at all | parse the string (recoverable), or MLS |

---

## 7. ITEMS MARKED "NEEDS CORPUS VERIFICATION"

Do not build on any of these until a real file has been checked.

1. **`_TAX/@_TotalSpecialTaxAmount`** — 33/33 *present*, example value `0`. Present ≠ populated.
2. **`SITE/@HighestBestUseDescription`** — the catalog says the flag is 33/33 and the description text
   is *"sparse"*, with no count given.
3. **`PROJECT/DEVELOPMENT_STAGE` counts and the `PROJECT` sub-fields** on real FNM1073 files — the
   1073 notes list ten condo fields and do not include these.
4. **`SalesPricePerBedroomAmount`** — named in the 1025 spec; the catalog counts the per-unit metric
   family as 13/33 without breaking it out.
5. **`COMPARABLE_LISTING` and `RESIDENTIAL_RENTAL`** (ACI only, ~5 files) — noted as emitted, never
   measured for populated content. If they carry real listings, that is a second listing source.
6. **`FORM/@AppraisalAddendumText`** (10/33) — described as carrying "scope-of-work, intended-use,
   market commentary". Whether it reliably contains a **comp search-criteria / scope statement** (as
   opposed to boilerplate) has not been measured. The owner asked specifically about the appraiser's
   search criteria; the *structured* answer to that question is `SALES_COMPARISON/RESEARCH` (#7), and
   the prose version is unverified.
7. **`GSEViewType` / `GSEBasementExitType`** — 20/33 measured as *present*; not measured for how often
   they carry a non-default value.
8. **The 1004MC period-to-date derivation** (§4.3.4) is arithmetic on the effective date. It matches
   the form's own definitions but has not been checked against a real file's stated periods.

---

## 8. RECOMMENDED NEXT MIGRATION

`db/411_market_and_property_facts.sql` — **sketched, not applied. Nothing in this repo was modified
other than this document.** Additive and idempotent throughout, per the repo's migration rule. Column
comments are deliberately verbose in the house style.

> **Numbering:** `db/411_research_xml_imports.sql` was claimed by a parallel session while this
> research was being written (it adds `property_observations.import_id` for standalone XML uploads
> that are not on a loan file). Every `ALTER` below is `IF NOT EXISTS` on a **different** column, so
> the two compose cleanly — but take the next free number at the moment you write the file, and
> re-check for a collision, per the repo's merge rule.

Ordered so that the cheapest, lowest-risk half (§8.1) can ship on its own.

### 8.1 R0 — make what we already store searchable

```sql
-- Nineteen facts already parsed, already validated, already written onto
-- property_observations — and invisible to the search screen because `properties`
-- has no column and ingest.ROLLUP_FACTS does not list them. No parser change.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS occupancy_status        text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS property_rights         text;   -- FeeSimple | Leasehold
ALTER TABLE properties ADD COLUMN IF NOT EXISTS sfha                    boolean;-- the FEMA answer, not the appraiser's typed zone
ALTER TABLE properties ADD COLUMN IF NOT EXISTS fema_flood_zone         text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS remaining_economic_life integer;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS heating_fuel            text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS basement_finished_pct   integer;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS attic                   boolean;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS has_adu                 boolean;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS lot_shape               text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS lot_dimensions          text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS listed_within_year      boolean;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS condo_floor             text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS unit_mix                jsonb;
-- WHICH AREA `gla` ACTUALLY IS. A 1025 grid falls back from living area to gross
-- BUILDING area under the same element, so a cross-form $/sqft comparison is
-- apples to oranges unless the basis travels with the number. It already travels
-- on the observation; it must travel on the roll-up too or the search screen's
-- price-per-foot facet is quietly wrong on every 2-4 unit property.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS gla_basis               text;   -- 'gla' | 'gba'

CREATE INDEX IF NOT EXISTS idx_properties_occupancy ON properties(occupancy_status);
CREATE INDEX IF NOT EXISTS idx_properties_sfha      ON properties(sfha) WHERE sfha IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_properties_rights    ON properties(property_rights);
```

> **Also required (not DDL):** add each of these to `ROLLUP_FACTS` in
> `src/lib/research/ingest.js:61-78`, and re-run `backfill(db, {force:true})` so existing observations
> re-roll. Nothing else changes — `rollupProperty` already handles any column listed there.

### 8.2 The market tables

```sql
-- ---------------------------------------------------------------------------
-- MARKET OBSERVATIONS — what ONE report said about ONE MARKET on one date.
--
-- WHY THIS IS NOT A PROPERTY COLUMN. The neighborhood price band, the demand /
-- supply reading and the 1004MC grid are facts about a MARKET, not about a
-- house. Hanging them off `property_observations` would stamp the same 36
-- numbers onto every comp in the report and make "the market's median price"
-- look like an attribute of a building. It is not.
--
-- WHAT A "MARKET" IS HERE, HONESTLY: the appraiser's own defined neighborhood.
-- Two reports on the same street can define it differently, and the only place
-- the definition exists is prose. So this table stores EVERY geography key the
-- report actually stated, plus the boundary text VERBATIM, and invents no
-- market id. Aggregation happens at QUERY time and must always say what it
-- aggregated ("the median of what N appraisers said about markets whose subject
-- was in this ZIP") — never "the ZIP's median price".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS market_observations (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- SET NULL, never CASCADE — same rule as property_observations. A market
    -- reading does not stop being true because a loan file was purged, and the
    -- geography columns below keep a detached row meaningful.
    appraisal_id      uuid REFERENCES appraisals(id) ON DELETE SET NULL,
    application_id    uuid REFERENCES applications(id) ON DELETE SET NULL,
    appraiser_id      uuid REFERENCES appraisers(id) ON DELETE SET NULL,
    property_id       uuid REFERENCES properties(id) ON DELETE SET NULL,   -- the subject it was stated for
    observed_on       date,                    -- the report's effective date
    form_type         text,

    -- ---- the geography, exactly as the report stated it --------------------
    geo_state         text,
    geo_county        text,
    geo_city          text,
    geo_zip           text,
    geo_census_tract  text,
    neighborhood_name text,
    -- The appraiser's OWN definition of where this market is. Never parsed,
    -- never normalized — it is the provenance that makes any aggregate above
    -- honest. NEIGHBORHOOD/@_BoundaryAndCharacteristicsDescription (33/33).
    boundaries        text,

    -- ---- point-in-time market character (all 33/33) ------------------------
    value_trend       text,       -- Increasing | Stable | Declining
    demand_supply     text,       -- Shortage | InBalance | OverSupply
    marketing_time    text,       -- UnderThreeMonths | ThreeToSixMonths | OverSixMonths
    growth_pace       text,       -- Rapid | Stable | Slow
    builtup_range     text,       -- Over75Percent | 25To75Percent | Under25Percent
    location_type     text,       -- Urban | Suburban | Rural

    -- ---- the price band. STORED IN DOLLARS. -------------------------------
    -- The XML carries these in $THOUSANDS (`244` = $244,000); extract.thousands()
    -- already converts with a magnitude guard. Storing the raw number here would
    -- mis-scale every comparison by 1000×.
    price_low         numeric(14,2),
    price_high        numeric(14,2),
    price_predominant numeric(14,2),
    age_predominant   integer,
    age_oldest        integer,
    age_newest        integer,

    -- ---- risk + mix --------------------------------------------------------
    foreclosure_activity boolean,
    adverse_financing    boolean,
    land_use             jsonb,   -- [{type,percent}] verbatim, NOT normalized to 100

    -- ---- THE APPRAISER'S OWN SEARCH SCOPE (33/33) --------------------------
    -- How big the real comp pool was and what it cost. An independent value
    -- bracket on every file, and — compared against our own property count in
    -- the same geography — a direct measure of how thin the warehouse is here.
    pool_sales_count      integer,
    pool_listings_count   integer,
    pool_sales_low        numeric(14,2),
    pool_sales_high       numeric(14,2),
    pool_listings_low     numeric(14,2),
    pool_listings_high    numeric(14,2),

    -- ---- a construction-cost index, free (33/33) ---------------------------
    cost_new_per_sqft   numeric(12,2),   -- COST_ANALYSIS/NEW_IMPROVEMENT[Dwelling]/@PricePerSquareFootAmount
    cost_data_source    text,            -- Marshall & Swift | DWELLINGCOST.COM | …

    -- ---- narratives (provenance, never a model input) ----------------------
    conditions_comment       text,
    reconciliation_comment   text,

    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
-- IDEMPOTENCE: one market reading per report. Re-ingesting UPDATES it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_market_obs_appraisal ON market_observations(appraisal_id)
    WHERE appraisal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_market_obs_zip    ON market_observations(geo_zip, observed_on DESC);
CREATE INDEX IF NOT EXISTS idx_market_obs_county ON market_observations(geo_state, geo_county, observed_on DESC);
CREATE INDEX IF NOT EXISTS idx_market_obs_tract  ON market_observations(geo_census_tract, observed_on DESC);
CREATE INDEX IF NOT EXISTS idx_market_obs_prop   ON market_observations(property_id);

-- ---------------------------------------------------------------------------
-- MARKET SERIES — the 1004MC grid, as a TIME SERIES.
--
-- One row per (report × metric × period). 9 metrics × 3 periods ≈ 27 value rows
-- plus the per-metric trend, on the 29/33 of files that carry the grid. This is
-- the table that makes a defensible time adjustment possible: several reports in
-- one county over two years give a measured median-price path, sourced to
-- licensed appraisers, instead of an older-half-vs-newer-half read of our own
-- thin comp sample.
--
-- THE PERIOD DATES ARE DERIVED, AND ARE NAMED SO NOBODY MISTAKES THEM FOR
-- STATED ONES. The form defines its periods relative to the effective date:
--   last3     = effective-3mo  → effective
--   prior46   = effective-6mo  → effective-4mo
--   prior712  = effective-12mo → effective-7mo
-- Deterministic, but a derivation. `period` keeps the report's own tag.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS market_series (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    market_observation_id uuid NOT NULL REFERENCES market_observations(id) ON DELETE CASCADE,
    appraisal_id      uuid REFERENCES appraisals(id) ON DELETE SET NULL,
    observed_on       date,
    geo_state         text,
    geo_county        text,
    geo_city          text,
    geo_zip           text,
    geo_census_tract  text,

    -- MARKET_INVENTORY/@_Type, verbatim: TotalSales | TotalListings |
    -- MedianSalesDOM | MedianListDOM | Supply | AbsorptionRate |
    -- MedianSalesToListRatio | MedianSalesPrice | MedianListPrice
    metric            text NOT NULL,
    -- The report's own period tag: 'last3' | 'prior46' | 'prior712'.
    period            text NOT NULL,
    derived_period_start date,
    derived_period_end   date,

    -- AMOUNTS ARE FULL DOLLARS ("452500"), NOT thousands — unlike the
    -- NEIGHBORHOOD/_HOUSING band above. extract.mcNum() already reads them that
    -- way; the two must never share a reader.
    value             numeric(16,4),
    -- The metric's own trend row (no period): Increasing | Stable | Declining.
    trend             text,

    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_market_series
    ON market_series(market_observation_id, metric, period);
CREATE INDEX IF NOT EXISTS idx_market_series_zip
    ON market_series(geo_zip, metric, derived_period_end DESC);
CREATE INDEX IF NOT EXISTS idx_market_series_county
    ON market_series(geo_state, geo_county, metric, derived_period_end DESC);
```

### 8.3 New first-class observation columns

```sql
-- ---- the time-adjustment inputs (#4) --------------------------------------
-- The CONTRACT date, distinct from the settled date. Time adjustment must run
-- off the date the price was AGREED; the contract→settle gap is routinely
-- 30–90 days and in a moving market that gap IS the adjustment. extract's
-- settledMonth() already parses "s03/25;c07/25" and currently discards the `c`.
-- Month resolution, exactly like sale_date — the day is synthetic, never render one.
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS contract_sale_date      date;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS contract_sale_date_text text;

-- ---- transaction identity + evidence quality (#5) -------------------------
-- The MLS number, parsed out of DataSourceDescription ("FMLS#7676859;DOM 51").
-- A vendor-independent transaction key: a second dedupe signal the address key
-- cannot give, and the join key to any future MLS feed.
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS mls_number          text;
ALTER TABLE property_sales        ADD COLUMN IF NOT EXISTS mls_number          text;
-- How the appraiser VERIFIED the sale ("CoreLogic Public Records"). A
-- deed-verified comp is stronger evidence than an agent-reported one.
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS verification_source text;
-- Interior | Exterior | None (desktop). A drive-by opinion is weaker evidence
-- than an interior inspection, and that belongs on the observation that carries
-- the opinion — not on the loan file.
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS inspection_type     text;

-- ---- the as-is condition on a renovation report (#3) ----------------------
-- The rehab-scope narrative, and the AS-IS rating mined out of it. On a
-- subject-to report `condition_uad` is the AFTER-repair rating and the roll-up
-- correctly refuses it (ingest.AS_IS_ONLY) — which leaves the condition NULL on
-- every renovation subject we own. The 1025 field map records that this
-- narrative usually states BOTH ratings ("C4 … as-is value. C3 … As repaired").
-- NEVER GUESSED: only a C1..C6 token inside an as-is-labelled clause, and the
-- source travels with it so a mined rating is never mistaken for a stated one.
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS condition_narrative  text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS condition_as_is_uad  text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS condition_as_is_source text;  -- 'narrative' | 'stated'

-- ---- money facts already extracted, with no warehouse home (#8, #9) -------
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS tax_amount           numeric(14,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS tax_year             integer;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS special_assessment   numeric(14,2);
-- THE LAND VALUE. Land share of total value is one of the largest sources of
-- variation between markets, and site_value/appraised_value is a feature nothing
-- else in the file supplies. NOT to be confused with SiteOtherImprovementsAsIsAmount,
-- which is the driveway and the landscaping (extract.js:136 guards that decoy).
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS site_value           numeric(14,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS cost_new_total       numeric(14,2);
-- depreciation_total / cost_new_total is a CONTINUOUS effective-age measure —
-- the same idea as the C1..C6 code with real resolution, computed on 33/33 files.
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS depreciation_total   numeric(14,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS depreciation_physical numeric(14,2);

-- ---- listing history (#12) ------------------------------------------------
-- One string carries list price, list date, DOM and MLS# ("DOM 16;…listed
-- 04/25/2026 for $545,000 fmls#7750008"). Keep the raw text AND the parsed
-- parts; parse conservatively (a price only next to a `$`, a date only when it
-- is a full calendar date, DOM only after the literal token) and leave a part
-- null rather than guess it.
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS listing_history  text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS list_price       numeric(14,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS list_date        date;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS days_on_market_num integer;  -- days_on_market is TEXT; this is the range-searchable twin

-- ---- narratives (provenance + the mining source for the as-is rating) -----
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS reconciliation_note text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS conditions_note     text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS transfer_narrative  text;

-- ---- the UAD view triple (#13) -------------------------------------------
-- The SUBJECT's view is the coded triple "N;Res;crn" (rating;type;factor) while
-- a COMP's is the enum Beneficial|Neutral|Adverse — one column, two vocabularies,
-- so ingest.uadView() currently DROPS the subject's view entirely. Decode instead:
-- the rating maps onto the comps' enum and goes in the existing view_rating;
-- type and factor get their own columns. view_type also carries the comps'
-- GSEViewType (20/33), whose sibling GSELocationType is already stored.
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS view_type   text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS view_factor text;

-- ---- grid facts that deserve columns (#14) -------------------------------
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS basement_exit      text;   -- WalkOut | WalkUp | None
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS functional_utility text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS hvac_desc          text;   -- "FWA;CAC"
-- THE ONLY GREEN FIELD IN MISMO 2.6. Usually reads "Average"; captured precisely
-- BECAUSE it is all there is — the day an appraiser writes something else there,
-- we should be able to find it.
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS energy_note        text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS energy_adj         numeric(14,2);
-- The 1025's only concession source: GSEConcessionAmount is 1004-only (20/33),
-- while the grid's SalesConcessions/FinancingConcessions descriptions are 33/33.
-- Concessions must be netted out BEFORE any regression or time adjustment.
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS concession_text    text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS financing_text     text;

-- ---- small-income economics (#6) -----------------------------------------
-- 2-4 unit property trades on price-per-unit and GRM, not price per square foot.
-- These sit on the COMPARABLE_SALE element itself — no narrative mining, no
-- adjustment-line archaeology — and extract.js simply never reads them.
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS monthly_rent   numeric(12,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS grm            numeric(10,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS price_per_unit numeric(14,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS price_per_room numeric(14,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS price_per_gba  numeric(12,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS gba            numeric(12,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS rent_control   text;
-- The subject's whole-property actual vs market gross rent (13/33). Extracted
-- today into the `fields` jsonb and NOWHERE else — there is not even a column
-- on `appraisals` for it.
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS rent_actual_gross numeric(12,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS rent_market_gross numeric(12,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS rent_includes     jsonb;

-- ---- comparability boundaries --------------------------------------------
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS building_status  text;    -- Existing | Proposed | UnderConstruction
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS private_road     boolean; -- a private street is a real value + financeability issue
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS public_water     boolean;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS public_sewer     boolean;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS seller_is_owner  boolean;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS highest_best_use boolean;
-- WHICH VENDOR WROTE THIS FILE. Not trivia: the GSE UAD comparable-grid
-- extensions appear in exactly the FNM1004 files and none of the FNM1025s, so
-- the vendor/form pair IS the data-quality tier of every fact on this row.
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS software_vendor  text;

-- ---- the roll-up twins for the facts that describe the PROPERTY ----------
ALTER TABLE properties ADD COLUMN IF NOT EXISTS tax_amount        numeric(14,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS tax_year          integer;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS site_value        numeric(14,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS gba               numeric(12,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS monthly_rent      numeric(12,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS grm               numeric(10,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS view_type         text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS basement_exit     text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS building_status   text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS private_road      boolean;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS public_water      boolean;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS public_sewer      boolean;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS rent_control      text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS project_name      text;   -- the condo project: the single strongest condo comp filter
-- THE AS-IS CONDITION, AT LAST. `condition_uad` stays what it is (the rating the
-- report stated, skipped by the roll-up when it is an after-repair one). This
-- column is the mined as-is rating, so a renovation subject finally carries a
-- condition somebody can search on — and its rank twin makes "C3 or better"
-- an indexed comparison instead of a string compare that means the opposite.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS condition_as_is_uad text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS condition_as_is_rank smallint
  GENERATED ALWAYS AS (NULLIF(regexp_replace(COALESCE(condition_as_is_uad,''), '\D', '', 'g'), '')::smallint) STORED;

CREATE INDEX IF NOT EXISTS idx_properties_asis_condition ON properties(condition_as_is_rank);
CREATE INDEX IF NOT EXISTS idx_properties_project        ON properties(lower(project_name));
CREATE INDEX IF NOT EXISTS idx_properties_ppu            ON properties(monthly_rent);
CREATE INDEX IF NOT EXISTS idx_prop_obs_mls              ON property_observations(mls_number) WHERE mls_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prop_sales_mls            ON property_sales(mls_number) WHERE mls_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prop_obs_contract_date    ON property_observations(contract_sale_date DESC NULLS LAST);
```

### 8.4 Rental comparables — their own table

```sql
-- ---------------------------------------------------------------------------
-- PROPERTY RENTS — the rent grid, which today is COUNTED and thrown away.
--
-- A 1025 (and an ACI 1004) carries up to three rental comparables, each with a
-- real street address, a monthly rent, rent per square foot, gross building
-- area, an MLS number, proximity and a per-unit breakdown. extract.js:1013
-- counts them (`report.rentalGrids`) and stores none of them. They are
-- properties; they belong in `properties` like everything else — and their
-- RENTS belong here.
--
-- WHY NOT `property_observations` WITH role='rental_comp': a rental comp has no
-- sale price, and every existing query that filters role='comparable' would
-- silently start counting them. A separate table costs one join and cannot
-- corrupt an existing answer.
--
-- unit_seq NULL = the whole property; 1..4 = that unit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS property_rents (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id      uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    appraisal_id     uuid REFERENCES appraisals(id) ON DELETE SET NULL,
    application_id   uuid REFERENCES applications(id) ON DELETE SET NULL,
    observation_id   uuid REFERENCES property_observations(id) ON DELETE SET NULL,
    -- 'subject' (the rent schedule) | 'rental_comp' (the rent grid)
    role             text NOT NULL,
    rental_seq       text,                  -- MULTIFAMILY_RENTAL/@PropertySequenceIdentifier
    unit_seq         text,                  -- NULL = the whole property
    observed_on      date,
    address_as_stated text,

    actual_rent      numeric(12,2),
    market_rent      numeric(12,2),
    rent_per_sqft    numeric(12,2),         -- RentPerGrossBuildingAreaAmount
    gba              numeric(12,2),
    sqft             numeric(12,2),
    rooms            integer,
    beds             integer,
    baths_text       text,                  -- UAD full.half — NEVER cast to numeric
    -- Overloaded onto LeaseStartDate/LeaseExpirationDate in the XML, which also
    -- hold the tokens Vacant / MTM / OWNER / FAMILY / Not Provided. Classified,
    -- never date-parsed (extract.leaseStatus already does exactly this).
    lease_status     text,
    rent_includes    jsonb,
    features         jsonb,                 -- RENTAL_FEATURE rows: age/condition/location/lease
    data_source      text,
    mls_number       text,
    proximity        text,

    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
-- IDEMPOTENCE: re-running the ingest UPDATES, never duplicates. COALESCE in the
-- key so a whole-property row (unit_seq NULL) dedupes instead of inserting a
-- fresh row on every import — a unique index treats NULLs as distinct.
CREATE UNIQUE INDEX IF NOT EXISTS uq_property_rent
    ON property_rents(COALESCE(appraisal_id::text,''), property_id, role,
                      COALESCE(rental_seq,''), COALESCE(unit_seq,''));
CREATE INDEX IF NOT EXISTS idx_property_rents_property ON property_rents(property_id, observed_on DESC);
CREATE INDEX IF NOT EXISTS idx_property_rents_appraisal ON property_rents(appraisal_id);
```

### 8.5 Adjustment lines as rows (R7 — the big one)

```sql
-- ---------------------------------------------------------------------------
-- PROPERTY ADJUSTMENTS — every grid line, as a row.
--
-- `property_observations.adjustments` jsonb already holds a corpus of REAL
-- APPRAISER ADJUSTMENTS IN OUR OWN MARKETS — something no data vendor sells. As
-- rows keyed by line type it becomes one GROUP BY: "what are appraisers actually
-- paying per bathroom in Paterson? per square foot in Lakewood? for a garage in
-- New Haven?" That is exactly what valuation.js's suggest pass has to derive
-- today from a median-of-ratios read over a handful of comps, and which it
-- refuses to answer when the sample is too small or points the wrong way.
--
-- TWO DISCIPLINES CARRIED OVER FROM THE PARSER:
--  * an amount of 0 is a STATEMENT ("no difference"), not missing data — so
--    `amount` is nullable and 0 is kept;
--  * the sign of the TOTAL adjustment is carried in a separate Y/N indicator
--    (extract.js:387-394). Per-line amounts must be checked for the same trap
--    before this table is trusted for a rate.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS property_adjustments (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    observation_id uuid NOT NULL REFERENCES property_observations(id) ON DELETE CASCADE,
    property_id    uuid REFERENCES properties(id) ON DELETE SET NULL,
    appraisal_id   uuid REFERENCES appraisals(id) ON DELETE SET NULL,
    appraiser_id   uuid REFERENCES appraisers(id) ON DELETE SET NULL,
    observed_on    date,
    -- The geography the rate belongs to, denormalized so a rate query is one
    -- table. A "per-bathroom rate in Paterson" is a market fact.
    geo_state      text,
    geo_county     text,
    geo_city       text,
    geo_zip        text,
    -- SALE_PRICE_ADJUSTMENT/@_Type verbatim: DateOfSale | SalesConcessions |
    -- FinancingConcessions | Location | View | SiteArea | Quality | Condition |
    -- Age | DesignStyle | GrossLivingArea | GrossBuildingArea | BasementArea |
    -- BasementFinish | FunctionalUtility | HeatingCooling | EnergyEfficient |
    -- Parking | CarStorage | PorchDeck | RoomCount | OtherFeature | Other
    line_type      text NOT NULL,
    line_label     text,          -- _TypeOtherDescription, for the "Other" rows
    description    text,          -- the COMP's own value on that line
    amount         numeric(14,2), -- 0 is meaningful; NULL is "not stated"
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_property_adjustment
    ON property_adjustments(observation_id, line_type, COALESCE(line_label,''), COALESCE(description,''));
CREATE INDEX IF NOT EXISTS idx_prop_adj_type_geo ON property_adjustments(line_type, geo_state, geo_zip, observed_on DESC);
CREATE INDEX IF NOT EXISTS idx_prop_adj_obs      ON property_adjustments(observation_id);
```

---

## 9. WHAT SHIPPING THIS ACTUALLY BUYS

**Comp finding** gains: a market price-band and age sanity filter (33/33 coverage), an MLS-number
identity key (33/33), an as-is condition on renovation subjects where there is none today (33/33
source), price-per-unit and GRM filters for 2-4 unit property (13/33), rent comps as searchable
properties (17/33), a same-condo-project filter, walk-out basement, busy-road exclusion, well/septic,
private-road and rent-control boundaries, and nineteen already-parsed facts that simply become
searchable for free.

**AVM** gains: a defensible, sourced time adjustment from a measured market price path (29/33) instead
of a crude read of our own sample; contract dates so the adjustment runs off the right date (33/33);
four market-temperature features (DOM, months supply, absorption, sale-to-list); land value and a
continuous depreciation-based effective age (32-33/33); property tax (32/33); list-to-sale ratio and
true DOM (33/33); an independent value bracket from the appraiser's own search pool on every single
file (33/33); a per-market construction-cost index (33/33); and — with R7 — real, local,
appraiser-authored adjustment rates instead of derived ones.

**Nothing here changes a frozen number, touches pricing, or requires a data vendor.** Every fact named
is already inside files we have been handed and are storing today.
