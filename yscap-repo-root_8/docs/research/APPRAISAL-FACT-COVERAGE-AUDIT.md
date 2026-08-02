# Appraisal → Property Warehouse: FACT COVERAGE AUDIT

**Question this document answers:** when the `db/409` ingest copies an appraisal into
`properties` / `property_observations` / `property_sales` / `property_photos`, **what does it drop
on the floor?**

**Method.** Every migration in `db/` that touches `appraisal_comparables` / `appraisals` /
`appraisal_units` / `appraisal_photos` was read in full (`137`, `149`, `150`, `156`, `157`, `158`,
`162`, `163`, `166`, `168`, `169`, `353`, `354`, `355`, `403`, `405`, `406`), plus the writer
(`src/lib/appraisal/import.js`), the parser (`src/lib/appraisal/extract.js`), the grid splitter
(`src/lib/appraisal/comp-grid.js`), the photo reader (`src/lib/appraisal/photo-meta.js`,
`src/lib/appraisal/photos.js`) and the storage path (`src/lib/appraisal/desk.js`). The corpus
research (`docs/appraisal-xml/photos-comps-variation.md`, `1004-URAR-field-map.md`,
`1025-SmallIncome-field-map.md`) is cited where it constrains what is knowable.

**Nothing outside this file was modified.**

---

## 0. VERDICT — the headline findings

| # | Finding | Severity |
|---|---|---|
| **F1** | **A comparable's PROPERTY TYPE and UNIT COUNT do not exist anywhere in our stored data.** `appraisal_comparables` has no `property_type`, no `property_category`, no `units` column, and the extractor never reads one. Two of the owner's five must-haves would be **permanently NULL** in `property_observations`. | **BLOCKER** |
| **F2** | **A comparable's CONDITION is UAD-only and silently dropped when the appraiser wrote a word.** `extract.js:261` accepts `condition_uad` only when it matches `^C[1-6]$`; a comp rated `"Good"`/`"Avg-Good"` stores **null**. The subject at least raises a `nonuad_cq` warning (`extract.js:1001`); a comp raises nothing. Condition is the owner's *"very important"* field. | **BLOCKER** |
| **F3** | **A comp's year built, lot size, design/style, garage, basement description, heating/cooling and functional utility ARE captured — but only inside the `adjustments` jsonb blob.** `property_observations` has first-class columns for every one of them (`year_built`, `lot_area`, `design_style`, `garage_type`, `garage_spaces`, `basement_sqft`). A naive column-to-column copy leaves them all NULL while the data sits three inches away. | **HIGH** |
| **F4** | **`property_observations.appraisal_id` and `.comparable_id` are `ON DELETE CASCADE` (db/409:230, :232).** Purging one loan file destroys that report's entire contribution to the cross-file warehouse — the exact thing the warehouse exists to outlive. `property_photos` (db/409:351-353) is worse: three cascading FKs. | **HIGH** |
| **F5** | **A comp with no city/state/zip cannot be keyed and will be silently skipped.** ~1/3 of files omit the separate `PropertyCity/State/PostalCode` attrs (`extract.js:332` fallback); `property-key.js` returns null without a locality. `property_ingest_log` has **no skipped-row counter**, so the loss is invisible. | **HIGH** |
| **F6** | **`comp_set` alone does not mean what a warehouse reader will think it means.** On a single-grid report *every* comp is stamped `'as_is'` or `'arv'` by default (`comp-grid.js:185-193`). The provenance that says whether the split was real (`appraisals.comp_split_confidence`, `comp_split_needs_review`) has **no column on `property_observations`**. | **HIGH** |
| **F7** | **A comparable PHOTO cannot currently be attached to a comparable ROW.** db/409 adds `appraisal_photos.identifier` / `.comp_seq` (db/409:369-370) but **no code writes them** — `desk.js:128-130` and `desk.js:105-111` both discard the identifier the labeller produced, and the INSERT at `desk.js:166-169` names neither column. | **HIGH** |
| **F8** | **On a subject-to (renovation) report, `appraisals.condition_uad` is the AFTER-REPAIR condition, not the property's condition today** (`docs/appraisal-xml/1025-SmallIncome-field-map.md:386-388`). Copying it into `properties.condition_uad` as "this property's condition" is a factual error. | **HIGH** |
| **F9** | **`appraisals.subject_unit` is never written** (`import.js:92-118` has no `subject_unit` key). For a condo the unit lives in `condo_unit_identifier`, which the warehouse must read instead or `properties.unit` is blank and every unit of a building folds into one property row. | **MEDIUM** |
| **F10** | Large blocks of *subject* facts that a property warehouse plainly wants have **no home in db/409**: property tax, owner of record, property rights (fee/leasehold), HOA fee, condo project/floor, effective age, heating/cooling, roof/foundation, attic/ADU, updates, amenities, utilities, listing history, neighborhood price range, FEMA SFHA. Full list in §5. | **MEDIUM** |

---

## 1. COMPLETE COLUMN INVENTORY

### 1.1 `appraisal_comparables` — 41 columns

Source migrations (grep `appraisal_comparables` over `db/`): `137`, `149`, `156`(comment only),
`157`, `158`, `166`, `169`, `406`.

| # | Column | Type | Meaning | Added by | Written at |
|---|---|---|---|---|---|
| 1 | `id` | uuid PK | row identity; the warehouse's `property_observations.comparable_id` target | db/137:107 | default |
| 2 | `appraisal_id` | uuid FK→appraisals | which report stated it | db/137:108 | import.js:148 |
| 3 | `seq` | text | `PropertySequenceIdentifier` — comp #1..N. **Text, and NOT contiguous** (Appraise-It skips 6) | db/137:109 | extract.js:325 |
| 4 | `is_subject` | boolean NOT NULL DEFAULT false | *intended* for the seq-0 subject column. **Always `false` in practice** — parser excludes seq 0 (`extract.js:326`) and the INSERT hard-codes `false` (`import.js:146`) | db/137:110 | hard-coded false |
| 5 | `address` | text | `LOCATION/@PropertyStreetAddress` | db/137:111 | extract.js:343 |
| 6 | `city` | text | `@PropertyCity`, **else** parsed from the `"City, ST ZIP"` line | db/137:112 | extract.js:344 / :293-297 |
| 7 | `state` | text | 2-letter, uppercased (`upState`) | db/137:113 | extract.js:345 |
| 8 | `zip` | text | 5-digit (ZIP+4 truncated by `zip()`) | db/137:114 | extract.js:346 |
| 9 | `proximity` | text | **free text** — "0.95 miles SE" | db/137:115 | extract.js:347 |
| 10 | `sale_price` | numeric(14,2) | `PropertySalesAmount`. **On an active/pending comp this is the ASKING price** | db/137:116 | extract.js:362 |
| 11 | `adjusted_price` | numeric(14,2) | `AdjustedSalesPriceAmount` — after grid adjustments | db/137:117 | extract.js:363 |
| 12 | `gla` | numeric(12,2) | from `SALE_PRICE_ADJUSTMENT[_Type=GrossLivingArea]/@_Description`; **falls back to `GrossBuildingArea` on a 1025** (`extract.js:258-259`) — the column mixes GLA and GBA | db/137:118 | extract.js:379 |
| 13 | `sale_date` | **text** | settled month as `'YYYY-MM-01'` — the DAY IS SYNTHETIC (`settledMonth`, extract.js:230-244) | db/137:119 | extract.js:379 |
| 14 | `net_adjustment` | numeric(14,2) | signed; sign restored from `SalesPriceTotalAdjustmentPositiveIndicator` (extract.js:369-376) | db/137:120 | ↑ |
| 15 | `net_adj_pct` | numeric(8,2) | signed percent | db/137:121 | extract.js:377 |
| 16 | `gross_adj_pct` | numeric(8,2) | percent | db/137:122 | extract.js:378 |
| 17 | `condition_uad` | text | **`C1`–`C6` ONLY**; a word rating is discarded (extract.js:261, :284) | db/137:123 | extract.js:379 |
| 18 | `quality_uad` | text | **`Q1`–`Q6` ONLY** (extract.js:262, :285) | db/137:124 | extract.js:379 |
| 19 | `days_on_market` | **text** | holds an integer string; `String(c.dom)` at import.js:149. Non-numeric DOM text ⇒ null (`toNum`, extract.js:286) | db/137:125 | import.js:149 |
| 20 | `data_source` | text | `COMPARISON_DETAIL/@GSEDataSourceDescription` — e.g. `"GSMLS#3933873"`. Declared in db/137 but **not populated until round 6** | db/137:126 (re-asserted db/166:21) | extract.js:388 |
| 21 | `comp_set` | text | `arv` \| `as_is` \| `unknown` — WHICH GRID. `c.comp_set \|\| 'unknown'` (import.js:150) | db/137:127 | comp-grid.js:167-259 |
| 22 | `adjustments` | jsonb NOT NULL `[]` | **every grid line**: `[{type,description,amount}]` — Site, Age, DesignStyle, BasementArea, BasementFinish, FunctionalUtility, HeatingCooling, EnergyEfficient, Parking/CarStorage, PorchDeck, Location, View, RoomCount, OtherFeature, Other | db/137:128 | extract.js:246-281 |
| 23 | `price_per_gla` | numeric(12,2) | `SalesPricePerGrossLivingAreaAmount` | db/149:18 | extract.js:249 |
| 24 | `sale_status` | text | `closed` \| `active` \| `pending`. **NULL on legacy rows and db/157:14 says NULL is read as `closed`** | db/157:16 | extract.js:361 |
| 25 | `beds` | integer | `ROOM_ADJUSTMENT/@TotalBedroomCount` | db/158:129 | extract.js:270 |
| 26 | `baths` | text | **UAD `full.half`** — `"2.1"` = 2 full + 1 half, NOT 2.1 baths | db/158:130 | extract.js:271 |
| 27 | `baths_full` | integer | parsed from ↑ | db/158:131 | extract.js:271 |
| 28 | `baths_half` | integer | parsed from ↑ | db/158:132 | extract.js:271 |
| 29 | `total_rooms` | integer | `@TotalRoomCount` | db/158:133 | extract.js:268 |
| 30 | `sale_type` | text | enum-whitelisted: `ArmsLengthSale`\|`REOSale`\|`EstateSale`\|`ShortSale`\|`Listing`\|`CourtOrderedSale` (extract.js:350) | db/158:134 | ↑ |
| 31 | `concession_amount` | numeric(14,2) | `GSEConcessionAmount`; 0 kept (extract.js:352) | db/158:135 | ↑ |
| 32 | `financing_type` | text | `GSEFinancingType` (free text) | db/158:136 | extract.js:351 |
| 33 | `prior_sale_amount` | numeric(14,2) | the comp's PREVIOUS transfer — flip signal | db/158:137 | extract.js:339 |
| 34 | `prior_sale_date` | **text** | full ISO `'YYYY-MM-DD'` (`isoDate`) — **a DIFFERENT text format from `sale_date`** | db/158:138 | extract.js:340 |
| 35 | `latitude` | numeric(9,6) | `LOCATION/@LatitudeNumber` (a la mode only) | db/158:139 | extract.js:348 |
| 36 | `longitude` | numeric(9,6) | ↑ | db/158:140 | extract.js:349 |
| 37 | `view_rating` | text | UAD enum `Beneficial`\|`Neutral`\|`Adverse` | db/166:17 | extract.js:383 |
| 38 | `location_rating` | text | UAD enum `Beneficial`\|`Neutral`\|`Adverse` | db/166:18 | extract.js:384 |
| 39 | `below_grade_sqft` | numeric(12,2) | `GSEBelowGradeTotalSquareFeetNumber` | db/166:19 | extract.js:386 |
| 40 | `below_grade_finished_sqft` | numeric(12,2) | `GSEBelowGradeFinishSquareFeetNumber` | db/166:20 | extract.js:387 |
| 41 | `location_type` | text | `GSELocationType` — `Residential`\|`BusyRoad`\|`Other` | db/169:16 | extract.js:385 |

**Every one of the 41 is written by `import.js:139-153`** (40 named columns + `id`). No comp column
is orphaned. The gaps are in what the TABLE lacks, not in what the writer skips — see §3.

**Extractor facts about a comp that reach NO column at all:**

| Fact | Produced at | Fate |
|---|---|---|
| `priorSaleNominal` (the ≤$1,000 quitclaim flag) | extract.js:353 (`isNominal`, :121) | **DROPPED** — not in the INSERT, not in `fields` jsonb. A $1 intra-family transfer becomes an indistinguishable "prior sale" in `property_sales`. |
| 1025 comp attrs `MonthlyRentAmount`, `GrossMonthlyRentMultiplierFactor`, `SalesPricePerUnitAmount`, `SalesPricePerRoomAmount`, `RentControlStatusType` | never read | **NEVER EXTRACTED** (`photos-comps-variation.md:112-113`) |
| `<MULTIFAMILY_RENTAL>` rental comps (1025) | counted only — `report.rentalGrids`, extract.js:993 | **NEVER STORED AS ROWS**. Rental comps are real properties with real addresses. |
| `<COMPARABLE_LISTING>` (ACI's separate listing element) | never read | **NEVER EXTRACTED** (`photos-comps-variation.md:135`) |

### 1.2 `appraisals` — ~217 columns

| Migration | Count | What it added |
|---|---|---|
| db/137:19-102 | 75 | base: provenance, form, the value block, subject identity + physical, appraiser + licence, parties, condo card, `fields` jsonb, `warnings` jsonb, `superseded` |
| db/149:20-22 | 3 | `prior_sale_amount`, `prior_sale_date` (date), `has_prior_sale` |
| db/150:13-17 | 5 | `fema_flood_zone`, `fema_flood_sfha`, `fema_flood_agrees`, `fema_flood_note`, `fema_flood_checked_at` |
| db/156:22-23 | 2 | `comp_split_confidence`, `comp_split_needs_review` |
| db/158 | 93 | the enrichment sweep — neighborhood/market (12), site/occupancy (14), structure/systems (18), contract/concessions (10), cost approach (12), income (2), reconciliation (5), appraiser/parties (6), condo project (13), `comps_have_prior_sales` (1) |
| db/162:19-26 | 5 | `market_trends` jsonb + the 1004MC `mc_*` point metrics |
| db/163:16-17 | 2 | `present_land_use`, `off_site_improvements` |
| db/168:18-23 | 6 | `property_tax_amount`, `property_tax_year`, `comp_research`, `building_status`, `nbhd_boundaries`, `sales_agreement_analysis` |
| db/169:17-18 | 2 | `market_conditions_comment`, `market_reconciliation_comment` |
| db/353:38-55 | 14 | the As-Is READ ladder (`as_is_read_*`), APPLIED (`as_is_applied*`), CONFIRMED (`as_is_confirmed_*`) |
| db/354:33-36 | 4 | `arv_applied`, `arv_applied_value`, `arv_file_value_before`, `arv_skip_reason` |
| db/355:13-15 | 3 | `arv_confirmed_value/_by/_at` |
| db/405:25-26 | 2 | `property_category` (canonical key), `attachment_type` (the MISMO style, evicted from `property_type`) |
| db/409:134 | 1 | `appraiser_id` FK |

The subject-describing subset is enumerated with its warehouse mapping in **§5**.

### 1.3 `appraisal_units` (db/137:132-143) — has NO home in db/409

`unit_seq` text, `rooms` int, `beds` int, `baths` text, `sqft` numeric(12,2), `actual_rent`
numeric(12,2), `market_rent` numeric(12,2), `lease_status` text (`vacant`\|`month_to_month`\|
`owner_occupied`\|`family_occupied`\|`leased`\|null — `extract.js:758-767`).

**db/409 has no per-unit table and no per-unit jsonb.** A 4-family's unit mix and per-unit rents —
the whole point of a 1025 — collapse into a single `property_observations.market_rent` scalar. See
§5 and §8.

### 1.4 `appraisal_photos` (db/137:146-155 + db/409:369-370)

`id`, `appraisal_id`, `document_id`, `category`, `caption`, `sequence`, `width`, `height`,
**`identifier`** (db/409:369, *never written*), **`comp_seq`** (db/409:370, *never written*).

**`category` carries a mixed vocabulary today** — db/137:150 documents
`subject_front|subject_rear|subject_street|interior|comparable|sketch|map|exhibit`, but the code
actually writes: `'photo'` / `'graphic'` (the pixel classification fallback, `desk.js:169`),
`'subject_front'` / `'subject'` / `'comparable'` / `'rental'` / `'interior'` / `'map'` / `'sketch'`
/ `'exhibit'` / `'cover'` / `'other'` (`photo-meta.js:83-87` + `:42-46`), plus the two sentinels
`'exhibit'` for the PDF-manifest row (`import.js:170`), `'backfill_none'` (`desk.js:349`) and
`'unclassified'` (`desk.js:390`). **`property_photos.category` (db/409:355) copying this verbatim
inherits all of it, sentinels included.**

---

## 2. FACTS THE EXTRACTOR PRODUCES THAT ARE **NOT** FIRST-CLASS COLUMNS

`buildFieldsJson` (`import.js:317-339`) flattens `subject.*`, `value.*`, `appraiser.*`, `condo.*`,
`income.*` and `report.*` into `appraisals.fields` as `{key:{value,source,confidence}}`.

### 2.1 Subject facts that live ONLY in `fields` jsonb

| jsonb key | Produced at | Why the warehouse wants it |
|---|---|---|
| `subject.baths` | extract.js:860 (`bathsParsed.text`) | **The subject's UAD baths string (`"2.1"`).** `appraisals` has `baths_full`/`baths_half` but **NO `baths` text column** — yet `property_observations.baths_text` (db/409:257) exists and expects one. **Its only source is this jsonb key.** |
| `subject.propertyCategoryType` | extract.js:852 | the raw MISMO `PropertyCategoryType` behind the derived category |
| `subject.pudIndicator` | extract.js:853 | `GSE_PUDIndicator` — PUD vs condo vs SFR |
| `subject.projectDesignType` | extract.js:854 | condo/PUD project design |
| `subject.propertyCategoryConfidence` | extract.js:901 | `definite` \| `likely` — **whether the category was inferred or stated** |
| `subject.propertyCategoryBasis` | extract.js:903 | the human-readable reason the category was chosen |
| `subject.priorSale` (object) | extract.js:871 | duplicated into columns — fine |
| `income.actualGrossRent`, `income.marketGrossRent` | extract.js:952 | **the 1025 whole-property gross monthly rent.** No column on `appraisals`; `property_observations.market_rent` would otherwise only see `est_market_monthly_rent`. |
| `condo.elevatorCount` | extract.js:967 | project amenity |
| `report.forms[]`, `report.images[]`, `report.rentalGrids` | extract.js:984-993 | **`report.images[]` is `{id, caption}` per photo slot** — the SAME data `photo-meta.photoSlots` re-derives. A ready-made comp-photo join key already persisted (§6). |

### 2.2 Facts the extractor computes and then loses **entirely** (not a column, not jsonb)

| Fact | Produced at | Consequence |
|---|---|---|
| `values.basis` (`'ARV'` \| `'ASIS'`) | extract.js:180-183 | **Whether the appraised value is an after-repair or as-is figure.** `condition_of_appraisal` recovers most of it, but NOT the hypothetical-language inference (`extract.js:178`, `:180`). Without it the warehouse cannot tell whether `appraised_value` describes the property today. Directly feeds F8. |
| `values.asIsSource` / `values.arvSource` | extract.js:188-196 | provenance ("structured" vs "narrative (as-is text)") — a narrative-mined As-Is is materially weaker evidence |
| `compSplit.counts` / `compSplit.note` | extract.js:1048-1050 | only `confidence` + `needsReview` are stored (import.js:114-115) |
| `photos.embeddedPdf` / `photos.imageMeta` | extract.js:975 | reduced to a caption string on one `appraisal_photos` row (import.js:170-171) |
| comp `priorSaleNominal` | extract.js:353 | see §1.1 |

---

## 3. MAPPING TABLE — `appraisal_comparables` → `property_observations`

Legend: **✅** = clean 1:1 · **⚠️** = lands, but with a trap (§7) · **❌** = NOT COVERED.

| Source column | → `property_observations` | Notes |
|---|---|---|
| `id` | `comparable_id` | ✅ but see **F4** (CASCADE) |
| `appraisal_id` | `appraisal_id` | ✅ |
| `seq` | `comp_seq` (text) | ✅ types match |
| `is_subject` | `role` = `'comparable'` | ⚠️ always false — the subject observation comes from `appraisals`, never from this table |
| `address`, `city`, `state`, `zip` | *(→ `properties.street/city/state/zip` + `address_key`)* | ❌ **NOT COVERED as stated.** `property_observations` has NO address column. The report's own spelling is only reachable through `comparable_id`, which cascades away (F4). **Needs `address_as_stated text`.** |
| `proximity` | `proximity` | ✅ free text |
| `sale_price` | `sale_price` | ⚠️ **asking price when `sale_status` ≠ `closed`** — must route to `properties.last_list_price`, not `last_sale_price` |
| `adjusted_price` | `adjusted_price` | ✅ |
| `gla` | `gla` | ⚠️ **mixes GLA and GBA on 1025s.** Needs `gla_basis text` (`'gla'`\|`'gba'`) |
| `sale_date` (text `YYYY-MM-01`) | `sale_date` (date) **+** `sale_date_text` | ⚠️ cast is safe; **the day is synthetic**. `sale_date_text` should keep the raw column verbatim. |
| `net_adjustment` | `net_adjustment` | ✅ signed |
| `net_adj_pct` | `net_adj_pct` | ✅ |
| `gross_adj_pct` | `gross_adj_pct` | ✅ |
| **`condition_uad`** | **`condition_uad`** | ✅ column-to-column — **but see F2: null whenever the appraiser wrote a word.** Needs `condition_text`. |
| `quality_uad` | `quality_uad` | ✅ same caveat → `quality_text` |
| `days_on_market` (text) | `days_on_market` (text) | ✅ text→text. No numeric column ⇒ no range search. |
| `data_source` | `data_source` | ✅ |
| **`comp_set`** | **`comp_set`** | ⚠️ ✅ column exists — **but F6: the confidence does not.** Needs `comp_set_confidence text` + `comp_set_needs_review boolean` sourced from `appraisals.comp_split_*`. |
| `adjustments` (jsonb) | `adjustments` (jsonb) | ✅ blob preserved — **but F3: the facts inside it never reach their own columns.** |
| `price_per_gla` | `price_per_gla` | ✅ |
| `sale_status` | `sale_status` | ⚠️ **NULL means `closed`** (db/157:14). The ingest must apply `COALESCE(sale_status,'closed')` or legacy comps land as unknown-status. |
| `beds` | `beds` | ✅ |
| `baths` (UAD text) | `baths_text` | ✅ — never `::numeric` it |
| `baths_full` | `baths_full` | ✅ |
| `baths_half` | `baths_half` | ✅ |
| `total_rooms` | `total_rooms` | ✅ |
| `sale_type` | `sale_type` | ✅ enum-whitelisted upstream; no CHECK downstream |
| `concession_amount` | `concession_amount` | ✅ |
| `financing_type` | `financing_type` | ✅ |
| `prior_sale_amount` | `prior_sale_amount` | ✅ → also a `property_sales` row, source `'comp_prior_sale'` |
| `prior_sale_date` (text `YYYY-MM-DD`) | `prior_sale_date` (date) | ⚠️ **different text format from `sale_date`** — do not share one parser |
| `latitude` / `longitude` | `latitude` / `longitude` | ✅ |
| `view_rating` | `view_rating` | ⚠️ **vocabulary collision**: comps use the UAD enum `Beneficial/Neutral/Adverse`; the SUBJECT's `appraisals.view_rating` is FREE TEXT from `SITE_FEATURE/@_Comment` (extract.js:550). One warehouse column, two vocabularies. |
| `location_rating` | `location_rating` | ✅ |
| `below_grade_sqft` | `below_grade_sqft` | ✅ |
| `below_grade_finished_sqft` | `below_grade_finished_sqft` | ✅ |
| `location_type` | `location_type` | ✅ |

### 3.1 `property_observations` columns that CANNOT be filled for a comparable

These columns exist in db/409 and have **no source column on `appraisal_comparables`**:

| Warehouse column | Recoverable? | How |
|---|---|---|
| **`property_type`** (db/409:266) | **NO — F1** | no source column, no extractor read |
| **`property_category`** (db/409:267) | **NO — F1** | ↑ |
| **`units`** (db/409:263) | **NO — F1** | ↑ |
| `year_built` (db/409:261) | **YES, from `adjustments`** | `_Type='Age'` row's `_Description` (an AGE, not a year — needs the report's effective year to convert, and UAD writes it as `"25"` or `"Actual 25"`) |
| `lot_area` (db/409:262) | **YES, from `adjustments`** | `_Type='SiteArea'` `_Description` |
| `design_style` (db/409:265) | **YES, from `adjustments`** | `_Type='DesignStyle'` `_Description` |
| `stories` (db/409:264) | NO | not a grid row |
| `garage_type` / `garage_spaces` (db/409:276-277) | **PARTIAL, from `adjustments`** | `_Type='Parking'`/`'CarStorage'` `_Description` — UAD-coded (`"2ga2dw"`, see `expanded-field-catalog.md:339`); needs a decoder |
| `basement_sqft` (db/409:275) | **YES, from `adjustments`** | `_Type='BasementArea'` / `'BasementFinish'` |
| `neighborhood`, `census_tract`, `flood_zone`, `zoning_id`, `zoning_desc` (db/409:280-284) | NO | never stated per comp |
| `occupancy_status` (db/409:285) | NO | never stated per comp |
| `market_rent` (db/409:286) | **NOT WITH TODAY'S PARSER** | 1025 comps carry `MonthlyRentAmount` — never extracted (§1.1) |
| `appraised_value`, `as_is_value`, `arv_value`, `contract_price` (db/409:295-298) | N/A | subject-only block, correctly null on a comp |

> **F1 is the one that needs a decision, not just code.** A corpus sweep is required to establish
> whether the MISMO 2.6 comp grid carries a unit count / property type at all (the documented
> `_Type` vocabulary at `photos-comps-variation.md:121-124` does **not** list one). Two honest
> options, both of which must be marked as derived and never as *stated*:
> (a) add `appraisal_comparables.property_type` / `.units` and extract them if the sweep finds a
> source; (b) if the sweep finds none, record the **form-implied class** (`FNM1004` ⇒ 1 unit,
> `FNM1025` ⇒ 2–4, `FNM1073` ⇒ condo) in a column named so nobody mistakes it for a fact —
> `property_type_inferred` + `property_type_basis` — reusing `lib/appraisal/property-category.js`
> so the subject and the comps speak one vocabulary. **Do not silently reuse the subject's
> `property_type` for its comps.**

---

## 4. THE FIVE OWNER MUST-HAVES — verified one by one

| # | Must-have | Source column | Warehouse column | Verdict |
|---|---|---|---|---|
| 1 | **Property type** | **NONE** | `property_observations.property_type` / `.property_category` (db/409:266-267) | ❌ **NOT COVERED — no source exists.** See F1. |
| 2 | **Unit count** | **NONE** | `property_observations.units` (db/409:263) | ❌ **NOT COVERED — no source exists.** See F1. |
| 3 | **CONDITION** *(the owner's "very important")* | `appraisal_comparables.condition_uad` (db/137:123) — written `extract.js:379` from `SALE_PRICE_ADJUSTMENT[_Type=Condition]` (extract.js:261) or `COMPARISON_DETAIL/@GSEOverallConditionType` (extract.js:284) | `property_observations.condition_uad` (db/409:268) | ⚠️ **Column-to-column YES, but lossy.** Only `C1`–`C6` survives; a worded rating (`"Good"`, `"Avg-Good"` — real corpus values per `field-validation-rules.md:73`) is **discarded with no warning for a comp**. **Add `condition_text text` + carry the raw string.** |
| 4 | **As-Is grid vs ARV grid** | `appraisal_comparables.comp_set` (db/137:127) — assigned by `comp-grid.js:167-259`, provenance in `appraisals.comp_split_confidence` / `comp_split_needs_review` (db/156:22-23) | `property_observations.comp_set` (db/409:236) | ⚠️ **Value carried, provenance NOT.** On a single-grid report every comp is stamped by default (`comp-grid.js:185-193`) and `'unknown'` is a real, meaningful value (`comp-grid.js:254`). **Add `comp_set_confidence` + `comp_set_needs_review`.** See F6. |
| 5 | **Sale dates** | `appraisal_comparables.sale_date` **(text `YYYY-MM-01`)** + `prior_sale_date` **(text `YYYY-MM-DD`)** | `property_observations.sale_date` (date) + `sale_date_text` + `prior_sale_date` (date); `property_sales.sale_date` (date NOT NULL) | ⚠️ **Carried, with a precision caveat.** The day is always `01` — `settledMonth()` (extract.js:230-244) discards it even when the XML gave `MM/DD/YYYY`. `uq_property_sale` (db/409:337-338) is month-resolution and therefore consistent, but **any "sold on the 14th" claim would be fabricated.** A listing has NO sale date and must not produce a `property_sales` row. |
| 6 | **Photos** | `appraisal_photos` (db/137:146) + the unwritten `identifier`/`comp_seq` (db/409:369-370) | `property_photos` (db/409:348) | ❌ **NOT COVERED for comparables today.** See §6 and F7. |

---

## 5. MAPPING TABLE — property-describing `appraisals` columns → warehouse

### 5.1 Covered

| `appraisals` column | → | Note |
|---|---|---|
| `subject_address`/`_city`/`_state`/`_zip`/`_county` | `properties.street/city/state/zip/county` + `address_key` | ✅ |
| `apn` | `properties.apn` | ✅ |
| `census_tract` | `property_observations.census_tract` / `properties.census_tract` | ✅ |
| `neighborhood` | `.neighborhood` | ✅ |
| `property_type` | `.property_type` | ✅ — **post-db/405 this is the real category**; pre-405 rows still hold `Detached`/`Attached` until `property-category-heal.js` drains |
| `property_category` | `.property_category` | ✅ (db/405) |
| `units` | `.units` | ✅ |
| `year_built` **(text)** | `.year_built` **(integer)** | ⚠️ TEXT→INT — reuse db/403's `~ '^\d{4}$'` guard |
| `gla` | `.gla` | ✅ |
| `rooms` | `.total_rooms` | ✅ name change |
| `beds`, `baths_full`, `baths_half` | same | ✅ |
| *(`fields->'subject.baths'`)* | `.baths_text` | ⚠️ **jsonb-only source** (§2.1) |
| `stories`, `design_style`, `lot_area` | same | ✅ (all text) |
| `zoning_id`, `zoning_desc` | same | ✅ |
| `condition_uad`, `quality_uad` | same | ⚠️ **F8 — after-repair condition on a subject-to report** |
| `flood_zone` | `.flood_zone` | ✅ appraiser's stated zone |
| `occupancy_status` | `.occupancy_status` | ✅ — and note db/403's rule: this is the **seller's** use, never the borrower's |
| `basement_sqft`, `below_grade_sqft`, `below_grade_finished_sqft` | same | ✅ |
| `garage_type`, `garage_spaces` | same | ✅ |
| `view_rating` | `.view_rating` | ⚠️ **free text here, enum on comps** (§3) |
| `est_market_monthly_rent` | `.market_rent` | ✅ (`import.js:266-275` documents the one resolution) |
| `sale_type`, `concession_amount` | same | ✅ (subject's contract) |
| `contract_price` | `.contract_price` | ✅ |
| `prior_sale_amount`, `prior_sale_date` (date) | same | ✅ → `property_sales` source `'subject_prior_sale'` |
| `appraised_value`, `as_is_value`, `arv_value` | same | ✅ |
| `effective_date` | `.observed_on` | ✅ |
| `form_type` | `.form_type` | ✅ |
| `appraiser_*`, `license_*`, `supervisor_name`, `appraiser_company_address` | `appraisers` / `appraiser_licenses` / `appraiser_contacts` | ✅ fully modelled |

### 5.2 NOT COVERED — subject facts with nowhere to land

Grouped by how much a property/comparable warehouse actually needs them.

**Tier 1 — a property warehouse is materially weaker without these:**

| `appraisals` column | Added by | Proposed |
|---|---|---|
| `property_tax_amount`, `property_tax_year` | db/168:18-19 | `properties.tax_amount numeric(14,2)`, `tax_year integer`; observation twins |
| `owner_of_record` | db/158:42 | `property_observations.owner_of_record text` (already the file's `seller_name` source, db/403) |
| `property_rights` (`FeeSimple`/`Leasehold`) | db/158:41 | `property_observations.property_rights text` — a leasehold comp is not comparable to a fee-simple subject |
| `hoa_fee_amount`, `hoa_fee_period` | db/137:93-94 | `property_observations.hoa_fee_amount numeric(12,2)`, `hoa_fee_period text` |
| `condo_project_name`, `condo_project_type`, `condo_unit_identifier`, `condo_floor` | db/137:89-92 | `properties.project_name text`, `property_observations.condo_floor text`; **`condo_unit_identifier` is the only source for `properties.unit`** — see F9 |
| `special_flood_hazard`, `fema_flood_zone`, `fema_flood_sfha` | db/158:40, db/150:13-14 | `property_observations.sfha boolean`, `fema_flood_zone text` — the FEMA-verified answer beats the appraiser's typed one and the warehouse only keeps the latter |
| `effective_age`, `remaining_economic_life` | db/158:46-47 | `property_observations.effective_age integer`, `remaining_economic_life integer` |
| `updates` (jsonb — kitchen/bath remodel + timeframe) | db/158:62 | `property_observations.updates jsonb` — **explicitly on the owner's list** |
| `amenities` (jsonb) | db/158:63 | `property_observations.amenities jsonb` — **explicitly on the owner's list** |
| `heating_type`, `heating_fuel`, `cooling` | db/158:49-51 | `property_observations.heating_type/heating_fuel/cooling text` — **explicitly on the owner's list** |
| `nbhd_price_low`, `nbhd_price_high`, `nbhd_price_predominant` | db/158:22-24 | **explicitly on the owner's list** ("neighborhood price range") — `property_observations.nbhd_price_low/high/predominant numeric(14,2)` |
| `lot_shape`, `lot_dimensions` | db/158:35-36 | **explicitly on the owner's list** ("site/lot") — `property_observations.lot_shape/lot_dimensions text` |
| `basement_finished_pct`, `foundation_type`, `attic`, `has_adu` | db/158:55, :53, :60, :61 | **basement is on the owner's list** — `basement_finished_pct integer`, `foundation_type text`, `attic boolean`, `has_adu boolean` |
| `listed_within_year`, `listing_history` | db/158:74-75 | `property_observations.listed_within_year boolean`, `listing_history text` — prior-listing history is core MLS-shaped data |
| **`appraisal_units.*`** (§1.3) | db/137:132 | **a `property_units` child table, or `property_observations.unit_mix jsonb`** — currently a 4-family's entire rent roll is discarded |
| *(none)* subject latitude/longitude | — | `appraisals` has **no** subject lat/long and `extract.js` never reads one; `properties.latitude/longitude` (db/409:156-157) can only ever be filled for a property that was once a COMP, or by geocoding |

**Tier 2 — worth keeping, lower urgency:** `legal_description`, `zoning_compliance`,
`zoning_compliance_note`, `attachment_type` (db/405 — the style is a real fact and has no warehouse
column), `roof_description`, `utilities` jsonb, `rent_included_utilities` jsonb, `updated_last_15yr`,
`building_status`, `site_value`, `value_sales_approach`/`_cost_approach`/`_income_approach`, `grm`,
`concession_indicator`, `concession_description`, `seller_is_owner`, `contract_reviewed`,
`contract_data_source`, `contract_date` (the observation has `contract_price` but **no
`contract_date`** — yet `property_sales.sale_date` is `NOT NULL`, so the `'subject_contract'` sale
row *must* read it off `appraisals`), the 12 remaining `nbhd_*`, the `mc_*` / `market_trends` 1004MC
block, `present_land_use`, `off_site_improvements`, `comp_research`, the whole cost-approach block,
`nbhd_boundaries`, `sales_agreement_analysis`, all 13 remaining `condo_*` project columns.

---

## 6. PHOTOS — what identifies a COMPARABLE photo, and can the comp NUMBER be recovered?

### 6.1 What identifies a photo as a comparable's

Two signals, in the order `photo-meta.js` applies them (`slotFrom`, **photo-meta.js:118-130**):

**(1) The parent `<FORM AppraisalReportContentType>` — authoritative.**
```
photo-meta.js:49-53
const FORM_GROUP = Object.freeze({
  subjectphotos: 'subject', salephotos: 'comparable', comparablephotos: 'comparable',
  rentalphotos: 'rental', locationmap: 'map', map: 'map', sketch: 'sketch', floorplan: 'sketch',
  exhibit: 'exhibit', coverpage: 'cover',
});
```
`SalePhotos` / `ComparablePhotos` ⇒ group `'comparable'`. Confirmed as rule 1 by
`docs/appraisal-xml/photos-comps-variation.md:79-82`.

**(2) The `IMAGE/@_Identifier` prefix — the fallback.**
```
photo-meta.js:65
  if (id.startsWith('comparable') || id.startsWith('salescomp') || id.startsWith('salecomp')) return 'comparable';
```
(`norm()` at photo-meta.js:55 lowercases and strips non-alphanumerics, so `"Sales Comp 7 - Photo"`
becomes `salescomp7photo` and matches `salescomp`.)

The group is then flattened to a storable string by `categoryFor` (**photo-meta.js:83-87**) — a comp
photo stores `category = 'comparable'` — and written by `desk.js:166-169`.

**Coverage reality:** `photos-comps-variation.md:12-14` — *"Roughly 60% of files (all a la mode,
some ACI) emit **no** per-photo metadata at all — only the PDF."* On those files **nothing**
identifies a photo as a comp's, because the classification falls back to the pixel heuristic
(`photos.js:151-162`), which only answers photograph-vs-artwork.

### 6.2 Can a comparable NUMBER be recovered?

**Yes — for the subset of files that carry photo metadata, and with two distinct numbering schemes.**
The number is present in `_Identifier` today; it is **read, then thrown away**.

Corpus evidence (`docs/appraisal-xml/photos-comps-variation.md:43-53`):

| `_Identifier` | Numbering |
|---|---|
| `ComparablePhoto1..3` | **resets to 1 in every `SalePhotos` FORM block** — the block is disambiguated by `FORM/@AppraisalReportContentName` (`"Photo Comparables 1-2-3"`, `"…4-5-6"`, `"URAR Sales Comparables 7-9 (09/11)"`) |
| `Sales Comp 1 - Photo` … `Sales Comp 8 - Photo` | **globally numbered, never reset** (Appraise-It) |

> `photos-comps-variation.md:86-93`:
> *"Association is **positional by the comp index encoded in the label**: `ComparablePhoto1/2/3`
> resets to 1 in each `SalePhotos` FORM … So global comp # = (block offset from FORM name) +
> (Identifier ordinal). Appraise-It instead numbers globally … The **only reliable cross-check** is
> matching the IMAGE `_CaptionComment` address to the `COMPARABLE_SALE/LOCATION/@PropertyStreetAddress`.
> **Use the caption address as the join key**, not the ordinal."*

And the caption IS already captured: `_CaptionComment` for a comp slot is the comp's address in the
form `"322 Howard Ave/New Haven, CT 06519"` (`photos-comps-variation.md:41`), read at
**photo-meta.js:120** and carried through `labelPhotos` at **photo-meta.js:232**.

**Where the number is lost — exactly three lines.**

1. `slotFrom` never reads the FORM's block name:
```
photo-meta.js:118-122
function slotFrom(formText, imageText) {
  const identifier = attrOf(imageText, '_Identifier');
  const caption = attrOf(imageText, '_CaptionComment');
  const contentType = attrOf(formText, 'AppraisalReportContentType');
  const otherDesc = attrOf(formText, 'TypeOtherDescription');
```
→ `AppraisalReportContentName` (which carries `"…Comparables 4-5-6"`) is never fetched, so the block
offset needed to de-reset `ComparablePhoto1..3` is unavailable.

2. The PDF path in `desk.js` **discards `identifier`** even when `labelPhotos` produced it:
```
desk.js:128-130
    photos = list.map((ph) => ({ bytes: ph.png, contentType: 'image/png', ext: 'png',
      kind: ph.kind, category: ph.category || null, caption: ph.caption || null,
      width: ph.width, height: ph.height }));
```
(`labelPhotos` DOES set it — `photo-meta.js:233`: `identifier: slot.identifier || null`.)

3. The XML-embedded path discards it too:
```
desk.js:105-111
        photos = imgs.map((im) => {
          const buf = Buffer.from(im.base64, 'base64');
          const mime = photoMeta.sniffImageMime(buf) || im.mime;   // magic bytes beat the attribute
          return { bytes: buf, contentType: mime, ext: (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg'),
            kind: im.photo ? 'photo' : 'graphic', category: photoMeta.categoryFor(im),
            caption: im.caption || null, width: null, height: null };
        });
```

4. And the INSERT names neither new column:
```
desk.js:166-169
      await db.query(
        `INSERT INTO appraisal_photos (appraisal_id, document_id, sequence, width, height, category, caption) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [appraisalId, doc.rows[0].id, ph.seq, ph.width, ph.height,
          ph.category || (ph.kind === 'graphic' ? 'graphic' : 'photo'), ph.caption || null]);
```
→ **`appraisal_photos.identifier` and `.comp_seq` (db/409:369-370) are dead columns.**

### 6.3 Exactly what has to change

**(a) `photo-meta.js` — surface the block name and derive the comp number (pure, testable).**
- In `slotFrom` (photo-meta.js:118), also read `attrOf(formText, 'AppraisalReportContentName')` and
  return it as `formName`.
- Add `compSeqFromSlot(slot)`:
  - `salescomp(\d+)photo` / a global-style identifier ⇒ that number, directly.
  - `comparablephoto(\d+)` ⇒ ordinal within the block; global # = `firstNumberIn(formName) + ordinal − 1`
    (e.g. `"Photo Comparables 4-5-6"` + `ComparablePhoto2` ⇒ 5).
  - **Return `null`** when the identifier is block-relative and `formName` carries no number **and**
    the report has more than one `SalePhotos` block — an ambiguous ordinal must never be guessed
    (this is the same never-guess discipline `labelPhotos` already enforces at photo-meta.js:223-225).
- Add `compSeqFromCaption(caption, comps)` — the join the research calls the *only reliable*
  cross-check: normalise the caption's street portion (split on `/`) and match it against each
  `appraisal_comparables.address` (reuse `lib/research/property-key.js`'s tokeniser so the
  warehouse and the photo join agree on what "the same address" means). **This should be tried
  FIRST and the ordinal used only as a fallback.**

**(b) `desk.js` — stop discarding it.**
- desk.js:128-130 → add `identifier: ph.identifier || null`.
- desk.js:105-111 → add `identifier: im.identifier || null` (`embeddedImages` already carries it via
  the `slotFrom` spread at photo-meta.js:198).
- desk.js:166-169 → widen the INSERT to
  `(appraisal_id, document_id, sequence, width, height, category, caption, identifier, comp_seq)`
  and pass `ph.identifier`, `ph.compSeq`.
- `extractAndStorePhotos` already receives the `appraisalId`, so the caption→comp join can run in
  the same function with one `SELECT seq, address FROM appraisal_comparables WHERE appraisal_id=$1`.

**(c) The warehouse ingest** then links `property_photos` (db/409:348) by
`appraisal_photos.comp_seq = appraisal_comparables.seq` → that comp's `property_id` /
`observation_id`; everything with `category IN ('subject','subject_front','interior')` links to the
subject observation; `'map'`/`'sketch'`/`'exhibit'`/`'cover'`/`'graphic'` links to **nothing**.

**(d) Two limits to state up front, not discover later.**
- **`labelPhotos` is all-or-nothing.** photo-meta.js:223-225 refuses to label unless
  `slots.length === photographs.length`. The PDF miner de-duplicates and caps at
  `MAX_PHOTOS = 24` (`photos.js:38`), so equality is not guaranteed even on a metadata-rich file.
  When it does not apply, **no photo gets an identifier or a comp number** — by design.
- **~60% of files carry no photo metadata at all.** Comp-photo attachment will therefore be sparse
  and must be treated as best-effort, exactly as `photos-comps-variation.md:94-96` warns.
- A cheaper immediate win: `appraisals.fields->'report.images'` (extract.js:989-992) already stores
  `[{id, caption}]` **per report, persisted, today** — the join can be built off stored data for
  every appraisal already imported, without re-reading a single XML.

---

## 7. TRAPS — where naive copying corrupts data

**T1 — `appraisal_comparables.sale_date` is TEXT and the DAY IS FAKE.** `settledMonth()`
(extract.js:230-244) always returns `YYYY-MM-01`, even when the XML gave a full `MM/DD/YYYY`.
`property_sales`'s month-resolution unique key (db/409:337-338) is consistent with this, but any UI
that renders "sold 1 Mar 2025" is inventing a day.

**T2 — `prior_sale_date` is TEXT in a DIFFERENT format** (`YYYY-MM-DD`, `isoDate`, extract.js:340).
Do not share a parser with T1.

**T3 — `days_on_market` is TEXT holding an integer** (`String(c.dom)`, import.js:149), and a
non-numeric `GSEDaysOnMarketDescription` is silently nulled (`toNum`, extract.js:286). Keeping it
text in `property_observations` (db/409:249) is correct but forecloses range search.

**T4 — `appraisals.year_built` is TEXT** (db/137:59) into an INTEGER warehouse column. `year()`
(extract.js:772) validates 1700..2026, so a cast is safe **for rows this parser wrote** — but reuse
db/403's explicit `~ '^\d{4}$'` guard rather than trusting it.

**T5 — a LISTING is not a SALE.** `sale_status ∈ {closed, active, pending}` (db/157) and on an
active/pending comp `sale_price` is the **asking** price (extract.js:355-360). Rules:
`property_sales` rows only for `closed`; `properties.last_list_price` (db/409:195) for the rest;
`properties.last_sale_price` must never be fed a listing.

**T6 — `sale_status IS NULL` means CLOSED**, not unknown. db/157:13-14: *"Default NULL is read as
'closed' by the app (previously imported rows keep counting as closed)."* Every legacy comp row is
NULL. `COALESCE(sale_status,'closed')` — and mirror `scoring.js:146`, which already does exactly
that.

**T7 — `comp_set = 'unknown'` is a REAL answer, not missing data** (comp-grid.js:254 —
*"`unknown` always beats a wrong assignment"*). Never default it to `as_is`.

**T8 — `comp_set` on a single-grid report is a DEFAULT, not a determination.** comp-grid.js:185-193
stamps every comp `'arv'` or `'as_is'` when there is only one grid. Without
`appraisals.comp_split_confidence` travelling alongside, a warehouse query for "As-Is comps" silently
includes comps that were never distinguished. **F6.**

**T9 — `comp_set` MUTATES AFTER INGEST.** `desk.backfillAppraisalCompSplitOnce` (desk.js:427-460)
re-extracts old appraisals at boot and `UPDATE`s `appraisal_comparables.comp_set` (desk.js:452-454).
`property_ingest_log` is keyed on `appraisal_id` (db/409:379) with an `ingest_version`; an appraisal
already logged `ok` will **not** be revisited and its warehouse copy goes stale. Either re-open the
ledger row when the backfill touches an appraisal, or key freshness on
`appraisals.comp_split_confidence IS NOT NULL`.

**T10 — UAD baths `"2.1"` is 2 full + 1 half, not 2.1.** `parseBaths` (extract.js:60-70) already
warns. `property_observations.baths_text` (db/409:257) is text — never cast it.

**T11 — enum whitelists silently null everything else.** `condition_uad`/`quality_uad` accept only
`^C[1-6]$`/`^Q[1-6]$` (extract.js:58); `view_rating`/`location_rating` accept only
`Beneficial|Neutral|Adverse` (extract.js:383-384); `sale_type` accepts a fixed six (extract.js:350);
subject enums at extract.js:453-458, :535, :599, :639. **A rejected value is not recorded anywhere**
— for the subject some raise a warning (extract.js:1001), for a comp nothing does. **F2.**

**T12 — one column name, two vocabularies.** `view_rating`: UAD enum on comps (extract.js:383) vs
free text on the subject (extract.js:550). If both flow into
`property_observations.view_rating` (db/409:270) the column becomes unqueryable. Split it or
normalise on the way in.

**T13 — comp `gla` is GBA on 1025s.** extract.js:258-259 falls back from `GrossLivingArea` to
`GrossBuildingArea` into the same field. `price_per_gla` is `SalesPricePerGrossLivingAreaAmount`
regardless. Cross-form $/sqft comparisons are apples-to-oranges without a `gla_basis` flag.

**T14 — the subject's condition on a subject-to report is the AFTER-REPAIR condition.**
`docs/appraisal-xml/1025-SmallIncome-field-map.md:386-388`: *"The condition shown reflects the
as-repaired state; the As-Is condition rating is usually only in the `PropertyCondition` narrative."*
`properties.condition_uad` (db/409:178) is a roll-up billed as "the best-known current answer" —
which would be **false** for every renovation file. Gate the roll-up on
`appraisals.condition_of_appraisal = 'AsIs'`, or carry a `condition_basis` alongside. **F8.**

**T15 — `values.basis` is not stored** (§2.2), so T14 cannot be evaluated for the sub-case where the
basis was inferred from hypothetical-completion language rather than the enum (extract.js:178).

**T16 — `is_subject` is always false** (extract.js:326, import.js:146). Any ingest that tries to
find the subject row via `appraisal_comparables.is_subject = true` finds nothing. The db/409
uniqueness design is already correct here (`uq_prop_obs_subject` keys on `appraisal_id` where
`role='subject'`, db/409:311-312) — just do not join the other way.

**T17 — `appraisals.subject_unit` is never written.** `import.js:92-118` has no `subject_unit` key;
the unit designator only exists as `condo_unit_identifier` (import.js:110). Since
`property-key.js` deliberately never drops the unit, **every unit of one condo building will fold
into a single `properties` row** unless the ingest reads `condo_unit_identifier`. **F9.**

**T18 — a comp with no locality is unkeyable and will vanish silently.** `extract.js:332` only
back-fills city/state/zip from the `"City, ST ZIP"` line when `PropertyCity` is blank, and
`photos-comps-variation.md:116-118` notes a la mode is the only vendor emitting the separate attrs.
`property-key.js` returns null without a locality. **`property_ingest_log` (db/409:378-388) has no
skipped counter** — add `rows_skipped integer` + `skip_reasons jsonb` or the loss is unmeasurable.
**F5.**

**T19 — the warehouse dies with the loan file.** db/409:230 `appraisal_id … ON DELETE CASCADE`,
db/409:232 `comparable_id … ON DELETE CASCADE`; `appraisals.application_id` is itself
`ON DELETE CASCADE` (db/137:21). So deleting one application **cascades all the way through to
`property_observations`**, and `property_photos` (db/409:351-353) cascades on three separate FKs.
A cross-file warehouse whose ledger is deleted by a per-file purge is not a warehouse.
**Recommend `ON DELETE SET NULL` on `comparable_id`/`appraisal_id`/`photo_id`/`document_id`,
`appraisal_id` nullable, and denormalising `address_as_stated` + `observed_on` onto the
observation so a detached row is still meaningful.** **F4.**

**T20 — `uq_property_photo (property_id, document_id)` (db/409:361) does not dedupe when
`document_id` is NULL** — NULLs are distinct in a unique index. `property_photos.document_id` is
nullable (db/409:353), so a re-run can duplicate rows.

**T21 — `property_photos.category` inherits a mixed vocabulary including sentinels** —
`'backfill_none'` (desk.js:349) and `'unclassified'` (desk.js:390) are bookkeeping markers, not
photo categories, and `'photo'`/`'graphic'` are the pixel classifier's answer while
`'subject_front'`/`'comparable'`/… are the appraiser's. Filter the sentinels; normalise the rest.

**T22 — superseded appraisals.** `property_ingest_log`'s PK is `appraisal_id`, so every appraisal
row — including `superseded = true` — is ingestible exactly once. Two imports of the *same* report
therefore produce two subject observations and double `properties.comp_count` /
`observation_count` (db/409:200-201). Decide explicitly: skip `superseded = true` (and log it as
`status='skipped'`), or count only non-superseded rows in the roll-ups.

**T23 — `properties` roll-up columns are "most recent report wins" (db/409:34-36), which conflicts
with `condition_uad`/`quality_uad`/`occupancy_status`.** A property observed as a comp in 2024 (C3)
and again in 2026 (C5) rolls up to C5 — correct. But a subject-to report's C-code (T14) is a
*future* condition and would win by recency. Order the roll-up on `observed_on`, exclude
after-repair statements, and record which observation each roll-up value came from.

**T24 — `property-key.js` is committed but `src/lib/research/identity.js` is not.** db/409:62
references it for the appraiser dedupe key, and db/409:22 references
`docs/PROPERTY-COMP-DATABASE-RESEARCH.md` — neither exists in the tree. Not a data-loss issue;
flagged so the ingest work is not assumed to be further along than it is.

---

## 8. RECOMMENDED SCHEMA ADDITIONS (consolidated)

A single follow-up migration `db/409_property_observation_gaps.sql` would close everything above.
Sketched, not applied:

```sql
-- ---- the owner's must-haves that have no source column -----------------------
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS property_type   text;   -- F1 (needs an extractor sweep)
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS property_category text; -- F1
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS units           integer;-- F1
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS condition_text  text;   -- F2 the non-UAD word rating
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS quality_text    text;   -- F2
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS gla_basis       text;   -- T13 'gla' | 'gba'
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS prior_sale_nominal boolean; -- §1.1

-- ---- the observation must survive the file -----------------------------------
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS address_as_stated text;      -- F4/T19
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS comp_set_confidence text;    -- F6
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS comp_set_needs_review boolean;-- F6
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS condition_text  text;        -- F2
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS quality_text    text;        -- F2
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS condition_basis text;        -- F8 'as_is' | 'as_repaired'
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS gla_basis       text;        -- T13
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS contract_date   date;        -- §5.2 (property_sales needs it)

-- ---- tier-1 subject facts with nowhere to land (§5.2) ------------------------
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS owner_of_record text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS property_rights text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS tax_amount      numeric(14,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS tax_year        integer;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS hoa_fee_amount  numeric(12,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS hoa_fee_period  text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS condo_floor     text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS sfha            boolean;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS fema_flood_zone text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS effective_age   integer;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS remaining_economic_life integer;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS heating_type    text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS heating_fuel    text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS cooling         text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS foundation_type text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS basement_finished_pct integer;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS attic           boolean;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS has_adu         boolean;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS lot_shape       text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS lot_dimensions  text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS updates         jsonb;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS amenities       jsonb;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS utilities       jsonb;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS unit_mix        jsonb;  -- §1.3 appraisal_units
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS listed_within_year boolean;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS listing_history text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS nbhd_price_low  numeric(14,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS nbhd_price_high numeric(14,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS nbhd_price_predominant numeric(14,2);

-- ---- make the loss measurable ------------------------------------------------
ALTER TABLE property_ingest_log ADD COLUMN IF NOT EXISTS rows_skipped integer NOT NULL DEFAULT 0;  -- F5/T18
ALTER TABLE property_ingest_log ADD COLUMN IF NOT EXISTS skip_reasons jsonb   NOT NULL DEFAULT '{}'::jsonb;
```

Plus the FK-durability change (T19) and the parser/photo changes in §6.3.

---

## 9. ORDER OF WORK

1. **F7 / §6.3** — write `identifier` + `comp_seq`; ~6 lines in `desk.js` plus one pure helper in
   `photo-meta.js`. Unblocks the owner's "photos" must-have and needs no schema change (db/409
   already added the columns).
2. **F2** — carry the raw condition/quality string. One extractor change, two columns; without it
   the owner's "very important" field is null on every non-UAD vendor.
3. **F6 / T8** — copy `comp_split_confidence` / `comp_split_needs_review` onto the observation.
   Two columns, no parsing.
4. **F4 / T19** — the FK durability fix. Cheapest now, effectively unfixable once rows exist.
5. **F5 / T18** — the skipped-row counter, so every later decision is measured.
6. **F3** — mine `adjustments` for `year_built` / `lot_area` / `design_style` / basement / garage.
7. **F1** — the corpus sweep for a comp's property type + unit count, then either extract it or
   record an explicitly-labelled inference.
8. Tier-1 subject facts (§5.2) and `appraisal_units` (§1.3).
