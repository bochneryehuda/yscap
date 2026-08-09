# UAD 3.6 → PILOT — the field map

Companion to `uad-3.6-research.md` (the industry research and the GSE artefact list) and to
`1004-URAR-field-map.md` / `1025-SmallIncome-field-map.md` (the same job for UAD 2.6).

**The paths in this document are CANDIDATES.** The normative source — Fannie/Freddie **Appendix
A-1**, the UAD dataset and its MISMO v3.6 xPath mapping — is on a host this environment's egress
policy blocks (403 at the proxy; see the research doc §Access). They were derived from MISMO v3
naming conventions, from the v3.4 reader this repo already ships in `src/lib/mismo/`, and from the
mechanical 2.6→3.6 spelling rules. **Correct them against A-1 and against a real report; the reader
is built to make that a small, guided job** (research doc §6).

The live map is `src/lib/appraisal/uad36-map.js`. This document explains it; that file is the truth.

---

## 1. The three shape changes that drive everything

| | UAD 2.6 | UAD 3.6 |
|---|---|---|
| **Where the value lives** | ATTRIBUTES — `<STRUCTURE GrossLivingAreaSquareFeetCount="1533"/>` | ELEMENT TEXT — `<GrossLivingAreaSquareFeetNumber>1533</…>` |
| **Container** | `VALUATION_RESPONSE` / `REPORT`, GSE-extended with `_`-prefixed and `GSE*`-named elements | `MESSAGE` on the 2009+ residential schema; MISMO 3.6 containers; relationships expressed with `xlink:label` / `RELATIONSHIP` arcs as well as by nesting |
| **Naming** | `…Count` on nearly everything; `_`-prefixed GSE extensions | v3 suffix discipline: `…Count` (integers), `…Number` (measures), `…Amount` (money), `…Indicator` (booleans, real `true`/`false`), `…Type` (enumerations), `…Description` / `…Text` (prose), `…Date` (ISO 8601) |

Two consequences worth stating because they caused real work:

- **The 2.6 reader cannot read a 3.6 file at all.** `src/lib/appraisal/xml.js` deliberately DROPS
  element text (so the multi-MB base64 `<DOCUMENT>` blob streams past cheaply), which on a 3.6 file
  means a tree of empty nodes. Hence `xml36.js`.
- **The normalizers are separate on purpose.** 2.6 packs compound values into one attribute — most
  visibly `TotalBathroomCount="2.1"`, UAD's "two full, one half" in one token — while 3.6 states
  them as separate typed data points, and 3.6 booleans are real `true`/`false` rather than 2.6's
  `Y`/`N`. Sharing one helper set would mean each one growing a "which version am I reading" branch,
  which is how a 2.6 bug fix silently changes a 3.6 answer.

---

## 2. Reading the map

Each canonical field carries an ordered list of locators, strongest first:

| Form | Meaning |
|---|---|
| `'A/B/C'` | an exact child path from the node |
| `'**' + '/NAME'` | the first descendant named `NAME`, anywhere below |
| `{ re: /…/ }` | **last resort** — the first descendant whose LOCAL NAME matches the pattern and whose text is non-empty |

The regex sweep is the safety net that makes a one-container path error survivable: a
`GrossLivingAreaSquareFeetNumber` sitting under a container we did not predict is still found by
name. **A field that resolves only through the sweep is a field whose mapped path is wrong** — the
survey script prints exactly those, and they are the first thing to correct.

Every resolution is recorded in `coverage.fields[key] = { resolved, via }`. That ledger is what
turns "the screen is empty" into "these 14 fields did not resolve, and here is the path each one
tried".

---

## 3. Subject property

Relative to the subject `PROPERTY` node — located, in order, by an explicit `SUBJECT_PROPERTY`
container, a `PROPERTY` carrying a subject indicator, or the first `PROPERTY` that is not inside a
comparable container. **The sweep is always scoped away from comparables**, so a subject field can
never be filled from another house's numbers — the worst failure this reader could have.

| PILOT field | Candidate 3.6 data points | Notes |
|---|---|---|
| `address` / `city` / `state` / `zip` / `county` | `ADDRESS/AddressLineText`, `CityName`, `StateCode`, `PostalCode`, `CountyName` | The MISMO v3 address block this repo already reads in `mismo/parse.js`. |
| `apn` | `PARCEL_IDENTIFICATION/PARCEL_IDENTIFIERS/PARCEL_IDENTIFIER/ParcelIdentifierValue` | 2.6: `_IDENTIFICATION/@AssessorsParcelIdentifier`. |
| `censusTract`, `legal`, `neighborhood` | `CensusTractIdentifier`, `PropertyLegalDescriptionText`, `NeighborhoodName` | |
| `yearBuilt` | `PropertyStructureBuiltYear` | Same name as 2.6. Kept as a STRING to match the 2.6 reader's shape. |
| `effectiveYearBuilt` | `PropertyStructureEffectiveBuiltYear` | 3.6-only; rides on `subject.*`. |
| `gla` | `GrossLivingAreaSquareFeetNumber`, `LivingAreaSquareFeetNumber` | 3.6 assumes **ANSI** measurement for above-grade area; the data point is still a square-foot number. |
| `grossBuildingArea` | `GrossBuildingAreaSquareFeetNumber` | 3.6-only. On a 2–4 unit the building area and the living area are different facts (the 2.6 reader learned this the hard way — see `1025-SmallIncome-field-map.md`). |
| `beds`, `rooms`, `stories` | `TotalBedroomCount`, `TotalRoomCount`, `StoriesCount` | |
| `bathsFull` / `bathsHalf` → `baths` | `TotalBathroomCount` + `HalfBathroomCount` | **ASSEMBLED into `full.half`**, never divided. "2.1" is two full and one half. |
| `units` | `PropertyDwellingUnitCount`, `LivingUnitCount`, `FinancedUnitCount` | Half the answer to the property category; also decides the derived form. |
| `design`, `attachmentType`, `propertyCategoryType`, `pudIndicator`, `projectDesignType` | `ArchitecturalDesignType`, `AttachmentType`, `PropertyCategoryType`, `PUDIndicator`, `ProjectDesignType` | Fed to the shared `property-category.js`. **`AttachmentType` is NOT a property type** — its whole controlled list is Detached/Attached — and that rule is unchanged from 2.6 (db/405). |
| `lotAreaSqft` / `lotDimensions` / `lotShape` | `LotSquareFeetNumber`/`SiteAreaSquareFeetNumber`, `LotDimensionsText`, `LotShapeType` | |
| `zoningId` / `zoningDesc` / `zoningCompliance` | `ZoningClassificationIdentifier`, `ZoningClassificationDescription`, `ZoningComplianceType` | |
| `floodZone`, `femaPanel`, `specialFloodHazard` | `NFIPFloodZoneIdentifier`, `FEMAMapIdentifier`, `SpecialFloodHazardAreaIndicator` | Feeds the existing flood signal — the `in_flood_zone` rule field reads the stored appraisal, so this is unchanged downstream. |
| `conditionUad` / `qualityUad` | `PropertyConditionRatingType`, `PropertyQualityRatingType` | **C1–C6 / Q1–Q6 unchanged.** Three spellings accepted: `C3`, `ConditionRatingC3`, `C3ConditionRating`. |
| `conditionInterior` / `conditionExterior` / `qualityInterior` / `qualityExterior` | `Interior…`/`Exterior…RatingType` | **3.6-only.** A two-step interior/exterior gap raises a warning. |
| `occupancyStatus`, `propertyRights`, `ownerOfRecord`, `buildingStatus` | `PropertyOccupancyStatusType`, `PropertyRightsType`, `PropertyOwnerName`, `PropertyStructureBuildingStatusType` | Land in existing `enrich` columns, so the existing tripwires (tenant-occupied, not-existing structure) keep firing. |

## 4. Valuation

| PILOT field | Candidate 3.6 data points |
|---|---|
| `appraisedValue` | `PropertyAppraisedValueAmount`, `PropertyValuationAmount` |
| `effectiveDate` | `PropertyValuationEffectiveDate`, `AppraisalEffectiveDate` |
| `conditionOfAppraisal` | `AppraisalConditionType`, `PropertyValuationConditionType` |
| `hypotheticalCondition` | `HypotheticalConditionDescription` / `…Indicator` — **new in 3.6** |
| `extraordinaryAssumption` | `ExtraordinaryAssumptionDescription` / `…Indicator` — **new in 3.6** |
| `valueSalesApproach` / `valueCostApproach` / `valueIncomeApproach` | `SalesComparisonApproachValueAmount`, `CostApproachValueAmount`, `IncomeApproachValueAmount` |
| `grm`, `siteValue` | `GrossRentMultiplierFactor`, `SiteValueAmount` |
| `contractPrice` / `contractDate` | `SalesContractAmount`, `SalesContractDate` |
| scope of work | `PropertyInspectionType`, `AppraisalScopeOfWorkType` → normalized to InteriorAndExterior / ExteriorOnly / Desktop / Hybrid / None |

### The As-Is / after-repair decision

Unchanged in **output**, improved in **input**. `extract36.decideValues` emits exactly the 2.6
vocabulary — `basis` of `'ARV'` or `'ASIS'`, `basisNote`, `asIs`/`arv` with `definite`/`missing`
confidences and a source sentence — so `comp-grid.splitComps`, the officer condition, the tie-out
and `importAppraisal`'s `as_is_confidence` / `arv_confidence` columns are untouched.

The ladder:

1. **The stated condition of appraisal.** `SubjectToRepairs` / `SubjectToCompletion` /
   `SubjectToInspection` → the figure is the **ARV**. `AsIs` → the **As-Is**.
2. **The structured hypothetical condition overrules an `AsIs` enum** when it describes repairs or
   completion. This is the 2.6 trap (file 09709435) that a narrative scan had to catch; in 3.6 it is
   a data point.
3. **The narrative sweep, as a backstop only**, for producers still writing the disclosure as prose.

**Never estimate-store.** On an after-repair report with no stated As-Is, `asIs` stays `null` and the
source says "not definite — open officer condition" — which is what opens the officer confirmation
rather than putting a guessed number on a loan file. Same rule, verbatim, as 2.6.

## 5. Comparables

Rows are found by `COMPARABLE_SALE`, `COMPARABLE_PROPERTY`, `COMPARABLE` or
`SALES_COMPARISON_PROPERTY` (first family that matches; container elements of the same family are
not counted as rows). A row stating **no address, no price and no size** is a padded grid slot and is
dropped — the same rule the 2.6 reader applies.

| PILOT field | Candidate 3.6 data points |
|---|---|
| `address` / `city` / `state` / `zip` | the `ADDRESS` block |
| `salePrice`, `saleDate`, `contractDate` | `SalesContractAmount`, `ClosedDate`, `SalesContractDate` |
| `adjustedSalePrice`, `netAdjustment`, `grossAdjustment` | `AdjustedSalesPriceAmount`, `TotalNetAdjustmentAmount`, `TotalGrossAdjustmentAmount` |
| `gla`, `beds`, `bathsFull`/`bathsHalf`, `totalRooms`, `yearBuilt`, `units` | as for the subject |
| `conditionUad` / `qualityUad` | `PropertyConditionRatingType`, `PropertyQualityRatingType` |
| `viewRating` / `locationRating` | `ViewOverallRatingType`, `LocationOverallRatingType` → Beneficial / Neutral / Adverse (unchanged) |
| `viewType` / `locationType` | `ViewType`, `LocationType` |
| `dom` | `DaysOnMarketCount` — **a real data point in 3.6.** In 2.6 it is mined out of the appraiser's MLS text (`DOM 97`). |
| `compDataSource` | `DataSourceDescription` |
| `belowGradeSqft` / `belowGradeFinishedSqft` | `BelowGradeAreaSquareFeetNumber`, `BelowGradeFinishedAreaSquareFeetNumber` |
| `weighting` | `ComparableWeightingDescription` — **new in 3.6**: the appraiser must state the weighting in the grid |
| `listingStatus` / `listPrice` | `PropertyListingStatusType`, `ListPriceAmount` — a comparable may be a closed sale, a pending contract or an active listing |
| `adjustments[]` | any `*_ADJUSTMENT` element below the comparable → `{ type, description, amount }` |

`pricePerSqft`, `ageYears`, `addressFull` and `comp_set` are computed exactly as on the 2.6 path.

## 6. Parties, market, and the report

- **Appraiser** — read from the `PARTY` whose `PartyRoleType` is Appraiser (never a document-wide
  sweep; that would grab the AMC's or the lender's phone, an audited 2.6 bug): `FullName`,
  `LicenseIdentifier`, `LicenseIssuingAuthorityStateCode`, `LicenseExpirationDate`,
  `ContactPointTelephoneValue`, `ContactPointEmailValue`.
- **Borrower** — the `PARTY` playing the Borrower role; the LLC test is unchanged.
- **Market / neighborhood** — `NeighborhoodPropertyValueTrendType`, `NeighborhoodDemandSupplyType`,
  `NeighborhoodMarketingTimeType`, the price band, `HousingSupplyMonthsCount`,
  `MedianDaysOnMarketCount`, `MedianSaleToListPricePercent` → the existing `nbhd_*` and `mc_*`
  columns, so the declining-market, over-supply and weak-pricing tripwires keep firing.
- **Images** — the XML carries a **manifest** (`ImageIdentifier`, `ImageCaptionText`,
  `ImageFileName`, `ImageType`), not pixels. `report.imageManifest` carries the filenames, which is
  how the ZIP's `Images/` folder is matched to the report. `photos.embeddedPdf` is `0` on a 3.6
  report — there is no embedded PDF, by design.

## 7. The derived form type

3.6 states no form number. `deriveFormType` answers with the equivalent legacy form and its basis:

| Evidence | Derived | Basis recorded |
|---|---|---|
| condominium ownership (`PropertyCategoryType` / `ProjectDesignType`) | `FNM1073` | "condominium ownership stated on the UAD 3.6 report" |
| 2–4 dwelling units | `FNM1025` | "N dwelling units stated on the UAD 3.6 report" |
| 1 dwelling unit | `FNM1004` | "one dwelling unit stated on the UAD 3.6 report" |
| a single-family property type with no unit count | `FNM1004` | "single-family property type stated on the UAD 3.6 report" |
| none of the above | `null` + a `form_not_derivable` warning | — |

`subject.formTypeBasis` carries the sentence, so a screen can say "derived from a UAD 3.6 report"
rather than implying the appraiser filled out a 1004.

## 8. What does NOT go on `enrich`

`importAppraisal` does `Object.assign(cols, A.enrich)` and builds an INSERT from those keys, so an
`enrich` key that is not an existing `appraisals` column **fails the whole import**. Every 3.6-only
fact therefore rides on `subject.*`, which `buildFieldsJson` persists verbatim into the fields jsonb:
`uadVersion`, `conditionInterior`, `conditionExterior`, `qualityInterior`, `qualityExterior`,
`grossBuildingArea`, `effectiveYearBuilt`, `projectName`, `formTypeBasis`. A regression test asserts
that every key on `enrich` is a known column. Promoting one of these to a real column is a migration
and a deliberate decision — not a side effect of a reader.
