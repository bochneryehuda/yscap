# COMPARABLE XML COVERAGE AUDIT — how much of an appraisal do we actually read?

**Question asked (owner, verbatim in substance):** *"make sure our comparable is fetching the MAX
available details possible from the XML — unit count, property type, year built, price per square
foot, lot square footage, livable square footage, and FOR EACH UNIT how many bedrooms, how many
bathrooms, how much square footage — and a lot more information I believe we are still missing.
Every XML imported should automatically import all the comparables on it into our system, and every
XML imported directly into property research should fetch correctly."*

This is the answer, field by field, measured.

---

## 0. THE ONE-PARAGRAPH ANSWER

The comparable grid is read **well** — 42 of the 44 writable columns on `appraisal_comparables` are
populated by the parser and every one of them reaches `property_observations`. But three things are
wrong and they are not "missing data", they are **wrong data**: on a 2-4 unit (Form 1025) report the
comparable's bedroom/bath/room counts are the counts of **unit 1 only**, stored as if they described
the whole building, and they roll up into `properties`; **price per square foot is NULL on every 1025
comparable** because the parser only reads the 1004 spelling of the attribute; and the comparable's
**garage is never read at all** because the adjustment-type list does not contain the two type names
MISMO 2.6 actually uses. Beyond those, the report states roughly **a dozen more facts per comparable**
that nothing reads — price per unit, the comp's monthly rent and gross rent multiplier, the whole
rental-comparable grid on a 1025, and ACI's separate listing element. Both import doors do reach the
warehouse and no comparable was measurably lost between them.

---

## 1. SCOPE AND EVIDENCE BASE — what is and is not proven here

**There is no real MISMO appraisal XML in this repository.** `find /home/user/yscap -name '*.xml'`
returns 267 files; every one of them is a **credit report** (`<CREDIT_RESPONSE>`) under `uploads/`.
`grep -rl COMPARABLE_SALE --include=*.xml` returns nothing. `scripts/lib/research-xml-fixture.js`
says so in its own header, and `docs/research/RESEARCH-WAREHOUSE-HANDOFF.md` §3 repeats it: *"The real
appraisal corpus is not in the repository"*. The `appraisals/stripped/` corpus the field-map documents
were measured against is not present either.

So this audit rests on four evidence sources, and each claim below says which one it uses:

| Source | What it can prove | Confidence |
|---|---|---|
| **`docs/appraisal-xml/*.md`** — field maps measured on 33 real files (20× 1004, 13× 1025) from four vendors | which elements/attributes a real report carries, and how often | high — these are the repo's own prior measurements |
| **The code** (`extract.js`, `import.js`, `ingest.js`) read line by line | what we read, store and roll up | certain |
| **A full-fidelity synthetic 1025** built from the field-map spec and run through the real `extract()` → `comparableRowFrom()` → `importXml()` → Postgres | that a stated fact does or does not survive each hop | certain for the hop; the *frequency* in the wild comes from the docs |
| **The live database** (`postgres://…/ysmerge`, and `ystest`) | what is actually in the warehouse today | certain, but see the caveat below |

> **Caveat on the live database.** `ysmerge` holds 71 appraisals of which **64 have no subject address
> at all** and no parsed `fields` — they are test fixtures inserted straight into `appraisals`, never
> through `importAppraisal`. Only 5 appraisals carry comparables (10 rows). Fill-rate percentages
> from this database therefore describe the *test corpus*, not production. They are quoted below only
> where the signal is structural (a column that is **never** populated for a comparable, by design of
> the code, not by accident of the fixtures).

Probe scripts used are in the scratchpad
(`probe-1025.js`, `probe-coverage.js`, `probe-verify.js`, `probe-verify2.js`, `probe-e2e.js`).

---

## 2. FIELD-BY-FIELD MAP OF THE COMPARABLE GRID

Legend for the last three columns:
`✔` = read/stored · `✘` = not read/not stored · `~` = read but transformed or partial ·
**warehouse column** is `property_observations`; "rolls up" means it is in `ROLLUP_FACTS`
(`src/lib/research/ingest.js`) and therefore reaches `properties` and the search engine.

### 2a. Identity and location

| XML path (relative to `COMPARABLE_SALE`) | `extract.js` | `appraisal_comparables` | `property_observations` | rolls up |
|---|:--:|:--:|:--:|:--:|
| `@PropertySequenceIdentifier` | ✔ | `seq` | `comp_seq` | no (report fact) |
| `LOCATION/@PropertyStreetAddress` | ✔ | `address` | `address_as_stated` + the property key | — |
| `LOCATION/@PropertyStreetAddress2` | ~ | ✘ | ✘ | — |
| `LOCATION/@PropertyCity` / `@PropertyState` / `@PropertyPostalCode` | ✔ | `city`/`state`/`zip` | property key | — |
| `LOCATION/@ProximityToSubjectDescription` | ✔ | `proximity` | `proximity` | **no — correct** (report fact) |
| `LOCATION/@LatitudeNumber` / `@LongitudeNumber` | ✔ | `latitude`/`longitude` | `latitude`/`longitude` | **yes** |

`PropertyStreetAddress2` ("New Haven, CT 06519") is parsed **only** as a city/state/ZIP fallback when
the separate attributes are absent (`splitCityLine`, `extract.js:338`). That is the right use; the raw
line itself is correctly not stored twice.

### 2b. The transaction

| XML path | `extract.js` | `appraisal_comparables` | `property_observations` | rolls up |
|---|:--:|:--:|:--:|:--:|
| `@PropertySalesAmount` | ✔ | `sale_price` | `sale_price` (+ a `property_sales` row) | via `last_sale_price` |
| `@AdjustedSalesPriceAmount` | ✔ | `adjusted_price` | `adjusted_price` | no (report fact) |
| `@SalePriceTotalAdjustmentAmount` + `@SalesPriceTotalAdjustmentPositiveIndicator` | ✔ (sign honoured) | `net_adjustment` | `net_adjustment` | no |
| `@SalePriceTotalAdjustmentNetPercent` | ✔ | `net_adj_pct` | `net_adj_pct` | no |
| `@SalesPriceTotalAdjustmentGrossPercent` | ✔ | `gross_adj_pct` | `gross_adj_pct` | no |
| `SALE_PRICE_ADJUSTMENT[_Type=DateOfSale]/@_Description` → settled month | ✔ | `sale_date` | `sale_date` + `sale_date_text` | via `last_sale_date` |
| …same line → **contract** month (`c09/25`) | ✔ (db/425) | `contract_date` | `contract_date` | no |
| `COMPARISON_DETAIL/@GSEListingStatusType` | ~ mapped | `sale_status` | `sale_status` | via `last_sale_status` |
| `COMPARISON_DETAIL/@GSESaleType` | ✔ | `sale_type` | `sale_type` | via `last_sale_type` |
| `COMPARISON_DETAIL/@GSEFinancingType` | ✔ | `financing_type` | `financing_type` | no |
| `COMPARISON_DETAIL/@GSEConcessionAmount` | ✔ | `concession_amount` | `concession_amount` | no |
| `COMPARISON_DETAIL/@GSEDaysOnMarketDescription` | ✔ | `days_on_market` | `days_on_market` | no |
| `COMPARISON_DETAIL/@GSEDataSourceDescription` | ✔ | `data_source` | `data_source` | no |
| **`@DataSourceDescription`** ("MLS#24094440 , DOM 15") | **✘ stored** (regex-scanned for listing status only) | ✘ | ✘ | — |
| **`@DataSourceVerificationDescription`** ("Public Records") | ✘ | ✘ | ✘ | — |
| `PRIOR_SALES/@PropertySalesAmount` / `@PropertySalesDate` | ✔ | `prior_sale_amount`/`prior_sale_date` | same (+ a `property_sales` row) | no |

> **FINDING C-1 — the non-UAD vendor loses its data source and its days on market.**
> `data_source`, `days_on_market`, `sale_type`, `concession_amount`, `financing_type`, `view_rating`,
> `location_rating`, `location_type`, `below_grade_sqft` and `below_grade_finished_sqft` **all** come
> from `COMPARISON_DETAIL`, which is a **UAD extension block present only on a la mode and ACI 1004s**
> (`photos-comps-variation.md` §d: *"UAD-only; absent on 1025/non-UAD"*). On a report without it, the
> plain `@DataSourceDescription` still states the MLS number and the DOM, and the repo's own fallback
> table already prescribes reading it (*"DOM → `DataSourceDescription` regex `DOM (\d+)`"*) — but that
> fallback was never implemented. **Measured:** removing `COMPARISON_DETAIL` from the probe file left
> `data_source=null, days_on_market=null` while the XML still said `"MLS#24094440 , DOM 15"`.

### 2c. Size, rooms and the physical description

| XML path | `extract.js` | `appraisal_comparables` | `property_observations` | rolls up |
|---|:--:|:--:|:--:|:--:|
| `SALE_PRICE_ADJUSTMENT[_Type=GrossLivingArea]/@_Description` | ✔ | `gla` + `gla_basis='gla'` | `gla`, `gla_basis` | **yes** |
| `SALE_PRICE_ADJUSTMENT[_Type=GrossBuildingArea]/@_Description` (1025) | ✔ | `gla` + `gla_basis='gba'` | same | **yes** |
| **`@SalesPricePerGrossLivingAreaAmount`** (1004) | ✔ | `price_per_gla` | `price_per_gla` | no (report fact — correct) |
| **`@SalesPricePerGrossBuildingAreaAmount`** (1025) | **✘** | **NULL** | **NULL** | — |
| **`@SalesPricePerUnitAmount`** (1025) | **✘** | ✘ | ✘ | — |
| **`@SalesPricePerRoomAmount`** (1025) | **✘** | ✘ | ✘ | — |
| `ROOM_ADJUSTMENT/@TotalRoomCount` | ~ **first row only** | `total_rooms` | `total_rooms` | **yes** |
| `ROOM_ADJUSTMENT/@TotalBedroomCount` | ~ **first row only** | `beds` | `beds` | **yes** |
| `ROOM_ADJUSTMENT/@TotalBathroomCount` | ~ **first row only** | `baths`/`baths_full`/`baths_half` | `baths_text`/`baths_full`/`baths_half` | **yes** |
| `ROOM_ADJUSTMENT/@RoomAdjustmentAmount` | ~ first row only | inside `adjustments` | inside `adjustments` | no |
| `ROOM_ADJUSTMENT/@UnitSequenceIdentifier` | ✘ | ✘ | ✘ | — |
| `SALE_PRICE_ADJUSTMENT[_Type=Age]/@_Description` | via `fromAdjustments` | — | `year_built` | **yes** |
| `SALE_PRICE_ADJUSTMENT[_Type=SiteArea]/@_Description` | via `fromAdjustments` | — | `lot_area` + `lot_sqft` | **yes** |
| `SALE_PRICE_ADJUSTMENT[_Type=DesignStyle]/@_Description` | via `fromAdjustments` | — | `design_style` | **yes** |
| `SALE_PRICE_ADJUSTMENT[_Type=Parking\|CarStorage]/@_Description` | **✘ never matches** | — | `garage_type` **always NULL** | — |
| `COMPARISON_DETAIL/@GSEBelowGradeTotalSquareFeetNumber` | ✔ | `below_grade_sqft` | `below_grade_sqft` | **yes** |
| `COMPARISON_DETAIL/@GSEBelowGradeFinishSquareFeetNumber` | ✔ | `below_grade_finished_sqft` | `below_grade_finished_sqft` | **yes** |
| `@RentControlStatusType` (1025) | **✘** | ✘ | ✘ | — |
| `@MonthlyRentAmount` (1025) | **✘** | ✘ | ✘ | — |
| `@GrossMonthlyRentMultiplierFactor` (1025) | **✘** | ✘ | ✘ | — |

> **FINDING C-2 (HIGH) — price per square foot is NULL on every Form 1025 comparable.**
> `compGrid()` reads only `SalesPricePerGrossLivingAreaAmount` (`extract.js:277`). The string
> `SalesPricePerGrossBuildingAreaAmount` **does not appear anywhere in `extract.js`**. A 1025 states the
> GBA spelling — the repo's own 1025 field map lists `SalesPricePerGrossBuildingAreaAmount` as the
> per-comp *"Price/GBA"* row, present in the sample files. **Measured:** identical probe file, one
> attribute renamed — 1004 → `price_per_gla = 154.59`; 1025 → `price_per_gla = null`.
> This is one of the seven fields the owner named by name.
>
> **FINDING C-3 (HIGH) — the comparable's garage is never read.**
> `ADJ_TYPES.garage = ['garage','garagecarport','carport']` (`ingest.js:1278`). The MISMO 2.6
> adjustment `_Type` vocabulary for that grid line is **`Parking`** or **`CarStorage`**
> (`photos-comps-variation.md` §c). Neither normalizes into that list, so `garage_type` on a
> comparable is structurally always NULL. **Measured** against all four candidate spellings.
> `garage_spaces` is hard-coded `null` in the comparable branch (`ingest.js:1103`) even though
> the description routinely states a count ("4 Off Street", "2ga2dw").
>
> **FINDING C-4 (MEDIUM) — `year_built` is NULL on a UAD-conformant comparable.**
> The grid's `Age` line is the **age in years** on a UAD report ("115"), not a year.
> `fromAdjustments(…, 'age', K.yearBuilt)` only accepts a 4-digit year, so it returns null.
> **Measured:** `K.yearBuilt('115') = null`, `K.yearBuilt('1958') = 1958`. Some vendors do write the
> year, which is why the live corpus shows `year_built` filled on 69/83 comparable observations — but
> on any file using the UAD spelling the fact is simply dropped. The honest fix is to store the
> **stated age** as its own fact rather than to compute a year from it (see §6, rank 6).

### 2d. Condition, quality, view, location, site, utility, energy

| XML path | `extract.js` | `appraisal_comparables` | `property_observations` | rolls up |
|---|:--:|:--:|:--:|:--:|
| `SALE_PRICE_ADJUSTMENT[_Type=Condition]/@_Description` (UAD C1–C6) | ✔ | `condition_uad` | `condition_uad` | **yes** |
| …same, worded ("Good", "Avg-Good") | ✔ | `condition_text` | `condition_text` | **yes** |
| `SALE_PRICE_ADJUSTMENT[_Type=Quality]` (UAD / worded) | ✔ | `quality_uad` / `quality_text` | same | **yes** |
| `COMPARISON_DETAIL/@GSEOverallConditionType` / `@GSEQualityOfConstructionRatingType` | ✔ (fallback) | same | same | **yes** |
| `COMPARISON_VIEW_OVERALL_RATING/@GSEViewOverallRatingType` | ✔ | `view_rating` | `view_rating` | **yes** |
| `COMPARISON_LOCATION_OVERALL_RATING/@GSEOverallLocationRatingType` | ✔ | `location_rating` | `location_rating` | **yes** |
| `COMPARISON_LOCATION_DETAIL/@GSELocationType` | ✔ | `location_type` | `location_type` | **yes** |
| `SALE_PRICE_ADJUSTMENT[_Type=View]/@_Description` (UAD code "N;Res;") | jsonb only | `adjustments` | `adjustments` | no |
| `SALE_PRICE_ADJUSTMENT[_Type=Location]/@_Description` ("N;Res;") | jsonb only | `adjustments` | `adjustments` | no |
| `SALE_PRICE_ADJUSTMENT[_Type=FunctionalUtility]` | jsonb only | `adjustments` | `adjustments` | no |
| `SALE_PRICE_ADJUSTMENT[_Type=HeatingCooling]` | jsonb only | `adjustments` | `adjustments` | no |
| `SALE_PRICE_ADJUSTMENT[_Type=EnergyEfficient]` | jsonb only | `adjustments` | `adjustments` | no |
| `SALE_PRICE_ADJUSTMENT[_Type=BasementArea]` / `[BasementFinish]` | jsonb only | `adjustments` | `adjustments` | no (`basement_sqft` is subject-only) |
| `SALE_PRICE_ADJUSTMENT[_Type=PorchDeck]` | jsonb only | `adjustments` | `adjustments` | no |
| `SALE_PRICE_ADJUSTMENT[_Type=SalesConcessions]` / `[FinancingConcessions]` | jsonb only | `adjustments` | `adjustments` | no |
| `SALE_PRICE_ADJUSTMENT[_Type=Other]` (+ `@_TypeOtherDescription`) | jsonb only | `adjustments` | `adjustments` | no |
| `OTHER_FEATURE_ADJUSTMENT/@PropertyFeatureDescription` + `@…AdjustmentAmount` | ✔ | `adjustments` | `adjustments` | no |

**Every adjustment line is captured** as `{type, description, amount}` in the `adjustments` jsonb, on
both tables. Nothing on the grid is thrown away. What is *not* done is promoting the ones that state a
durable property fact into their own column — basement area, functional utility, heating/cooling and
the UAD view/location codes sit in jsonb where no filter can reach them. That is a design choice, not
a loss, and §6 ranks which ones are worth promoting.

**Never populated for a comparable, by design of the code** (measured across all 83 comparable
observations in `ysmerge`): `units`, `property_type`, `garage_type`, `stories`, `basement_sqft`,
`market_rent`, `unit_mix`, `hoa_fee_amount`, `occupancy_status`, `effective_age`, `heating_type`,
`cooling`, `foundation_type`, `attic`, `lot_shape`, `zoning_id`, `flood_zone`, `census_tract`,
`neighborhood`, `owner_of_record`, `property_rights`. Most are hard-coded `null` in the comparable
branch of `writeReport` (`ingest.js:1102-1112`) and correctly so — a MISMO grid does not state them per
comp. Three are recoverable and are ranked in §6.

### 2e. The two columns nothing writes

`db/409` §7 added `appraisal_comparables.property_type` and `.units` for *"the comparable's own type and
unit count, where the grid states them."* **`comparableRowFrom` never emits either key** — it returns
42 keys and neither is among them (measured: `row.units === undefined`). `writeReport` then reads
`c.units` / `c.property_type` and writes NULL to the observation. So both columns are dead today, and
`properties.units` / `properties.property_type` for a comparable-only property are always NULL.

This is **correct under the never-fabricate rule as the code stands** (handoff §4 rule 8: never inherit
them from the subject). But it is not true that the grid never states them — see §6 rank 1.

---

## 3. THE PER-UNIT DATA (Form 1025, 2-4 units)

### 3a. What the XML actually carries

There is **no real 1025 in this repository to point at**, so this section states what the spec allows
and what the repo's own 33-file measurement recorded, and proves the code's behaviour against a
synthetic file built to that spec.

**For the SUBJECT — three independent per-unit blocks** (`1025-SmallIncome-field-map.md` §C):

| Block | Per-unit facts | Present |
|---|---|---|
| `PROPERTY/STRUCTURE/_UNIT_GROUP` (`UnitOne`…`UnitFour`) | `TotalRoomCount`, `TotalBedroomCount`, `TotalBathroomCount`, `GrossLivingAreaSquareFeetCount` | 10/10 files |
| `INCOME_ANALYSIS/MULTIFAMILY_RENT_SCHEDULE/UNIT_RENT_SCHEDULE` | `UnitActualRentAmount`, `UnitMarketRentAmount`, `LeaseStartDate`, `LeaseExpirationDate` (lease dates double as a status token: `Vacant`, `OWNER`, `FAMILY`, `Not Provided`) | 10/10 |
| `MULTIFAMILY_RENTAL[seq=0]/RENTAL_UNIT` | rooms/beds/baths/`SquareFeetCount` — a cross-check of `_UNIT_GROUP` | 10/10 |

**For a COMPARABLE — one block:** `COMPARABLE_SALE/ROOM_ADJUSTMENT`, **repeated once per unit**, each
row carrying `UnitSequenceIdentifier`, `TotalRoomCount`, `TotalBedroomCount`, `TotalBathroomCount` and
its own `RoomAdjustmentAmount`. The 1025 field map states this explicitly: *"Per-unit rooms (grid) …
one row per unit"*. A comparable does **not** carry per-unit square footage or per-unit rent —
those exist only for the subject and for the separate rental comps.

**For a RENTAL COMPARABLE:** `INCOME_ANALYSIS/MULTIFAMILY_RENTALS/MULTIFAMILY_RENTAL[seq≥1]`, each with
`LOCATION`, `MonthlyRentAmount`, `RentPerGrossBuildingAreaAmount`, `GrossBuildingAreaSquareFeetCount`,
`DataSourceDescription`, `RENTAL_FEATURE` lines, and one `RENTAL_UNIT` per unit carrying
rooms/beds/baths/`SquareFeetCount`/`MonthlyRentAmount`.

### 3b. What we read — the subject

**Read and correct.** `extract.js:980-997` joins `_UNIT_GROUP` (by `UnitType`) to `UNIT_RENT_SCHEDULE`
(by `UnitSequenceIdentifier`) and emits `{seq, actualRent, marketRent, rooms, beds, baths, sqft,
leaseStatus}`. Padded empty rows are skipped. Measured on the probe: 3 real units out of 4 emitted
rows, each with correct rooms/beds/baths/sqft and a classified lease status.

Two small losses:

- **A real `$0` is indistinguishable from "not stated".** Unit 2 states
  `UnitActualRentAmount="0"` (a genuinely vacant unit earning nothing) and parses to `actualRent:
  null`. `leaseStatus:'vacant'` preserves the meaning, so nothing is *wrong*, but a rent-roll
  arithmetic will treat the unit as unknown rather than as zero.
- **The lease dates themselves are dropped.** Only the derived `leaseStatus` survives; the parsed unit
  keys are exactly `seq, actualRent, marketRent, rooms, beds, baths, sqft, leaseStatus`. "This lease
  expires in four months" is a real underwriting fact and it is thrown away.

### 3c. What we read — the comparable. **This is the sharpest finding in the audit.**

> **FINDING C-5 (CRITICAL) — a 2-4 unit comparable is stored with the room counts of unit 1,
> presented as the counts of the whole building, and that number rolls up into `properties`.**

`compGrid()` does `const ra = X.find(c, 'ROOM_ADJUSTMENT')` — **the first row only**
(`extract.js:303`), with the comment *"On a multi-unit file it may repeat per unit; take the first
(subject-comparison) row."* On a 1025 the first row is **unit 1**, not a subject-comparison total.

Measured end to end, through `importXml` into Postgres, on a 3-unit comparable whose grid states:

```
unit 1: rooms=5 beds=3 baths=1   adj=0
unit 2: rooms=5 beds=2 baths=1   adj=-2000
unit 3: rooms=4 beds=2 baths=1   adj=0
TRUE building total : rooms=14 beds=7 baths=3
STORED on the comp  : rooms=5  beds=3 baths=1.00
-> properties roll-up: beds=3
```

Consequences, in order of severity:

1. **The warehouse states a false fact.** `properties.beds = 3` for a 7-bedroom triplex. `beds`,
   `baths_full`, `baths_half`, `baths_total` (generated) and `total_rooms` are all in `ROLLUP_FACTS`,
   so this reaches `properties` and every search filter.
2. **It is worse than a NULL.** A NULL is honestly "we don't know" and `scoreComp` correctly drops an
   unknown out of the denominator (handoff §7.3). A wrong number scores as a confident match.
3. **It corrupts cross-form comparison.** The same address appearing as a 1004 subject would state
   7 beds; as a 1025 comparable it states 3. The roll-up's "most recent report that stated it wins"
   rule will flip the answer back and forth by import order.
4. **The per-unit adjustment amounts are lost too** — 1 of 3 `RoomCount` entries reaches `adjustments`,
   so a grid that adjusted −$2,000 for unit 2's missing bedroom does not reconcile.

**The unit mix of a comparable is never stored at all.** `unit_mix` is hard-coded `null` in the
comparable branch (`ingest.js:1107`); `subjectUnitMix` is subject-only by construction, reading either
`appraisal_units` (loan-file door) or `a._units` (upload door). So the answer to *"for each unit, how
many bedrooms, how many bathrooms"* is: **for the subject, yes; for a comparable, no — even though the
grid states beds and baths per unit.**

### 3d. `unit_mix` measured across the database

| Measure | `ysmerge` |
|---|---|
| `property_observations` rows | 126 |
| …with a non-null `unit_mix` | **5** |
| …that are comparables with a `unit_mix` | **0** (structurally impossible) |
| `appraisal_units` rows (the loan-file door's source) | **0** |

`appraisal_units` being empty means **no loan-file import in this database has ever produced a unit
mix**; the 5 that exist came through the standalone upload door, which carries `_units` in memory.
Given 64 of 71 appraisals are addressless fixtures this is expected of the test corpus, but it also
means the loan-file → `appraisal_units` → `unit_mix` path has no live evidence behind it here.

What is *in* a `unit_mix` when present: `{unit_seq, rooms, beds, baths, sqft, actual_rent,
market_rent, lease_status}` per unit, numerically normalized by `numericUnit` so both doors produce the
same shape. What is missing from it: the lease dates, and the utilities included in rent
(`RENT_INCLUDES_UTILITY`, which is read at report level into `rent_included_utilities` but not per unit).

---

## 4. THE AS-IS-ONLY REPORT

**The split lives in `src/lib/appraisal/comp-grid.js`** (`splitComps`) — there is no `comp-split.js`.
It is called once, from `extract.js:874`, and the per-comp answer is stamped onto
`appraisal_comparables.comp_set` and copied to `property_observations.comp_set` with its
`comp_set_confidence`.

### 4a. Does an as-is-only report split correctly today? **Yes.**

`splitComps` computes `isReno = (basis === 'ARV')`. On an as-is-only report `basis === 'ASIS'`, so
`twoGridCandidate` is false and the very first branch assigns **every comp `as_is`** with
`confidence = 'single_grid'` and `needsReview = false`. It does **not** land as `unknown`.

Measured on the probe file, three ways:

| Variant | `basis` | `compSplit.confidence` | comp sets |
|---|---|---|---|
| `_CONDITION_OF_APPRAISAL/@_Type = "AsIs"`, no split narrative | `ASIS` | `single_grid` | `as_is` ×6 |
| **no `_CONDITION_OF_APPRAISAL` element at all** | `ASIS` | `single_grid` | `as_is` ×6 |
| `SubjectToRepairs` + a narrative naming both grids (control) | `ARV` | `narrative` | 3× `arv`, 3× `as_is` |

Live database agrees: `comp_set = 'as_is'` with `comp_set_confidence = 'single_grid'` on 67 of 77
pre-existing comparable observations, and `appraisal_comparables.comp_set` is `as_is` on 10/10.

**So no fix is required for the ordinary case, and the owner can upload strictly-as-is reports today.**

### 4b. The one real trap, and the minimal fix

> **FINDING C-6 (HIGH) — an as-is report that mentions completed repairs is filed as an ARV report,
> its value is written into `arv` instead of `as_is`, and every comparable is stamped `arv`.**

`valuation()` (`extract.js:174-180`) lets a narrative regex override an **explicit** `AsIs` enum:

```js
else if (cond === 'AsIs' && hasHypo) { basis = 'ARV'; … }
```

`HYPO_RE` has two arms (`extract.js:151`):

```js
/hypothetical condition.{0,80}(?:repair|budget|complet|renovat)      // arm 1 — precise
 |(?:repair|budget|renovat).{0,40}(?:have been |been )?complet/i     // arm 2 — over-broad
```

Arm 1 is right and is the case the repo measured (file `CP_09709435`, documented in
`as-is-value-sources.md` §2a). **Arm 2 does not require the word "hypothetical" at all.** Measured:

| Narrative on an explicit `AsIs` report | resulting `basis` | `as_is` | `arv` | comp sets |
|---|---|---|---|---|
| "The sales comparison approach was given most weight." | `ASIS` | 575,000 | null | `as_is` |
| "Value assumes the **hypothetical condition** that all repairs have been completed." | `ARV` | null | 575,000 | `arv` |
| **"The renovation has been completed and the property is now rent ready."** | **`ARV`** | **null** | **575,000** | **`arv`** |
| **"All repairs were completed in 2024."** | **`ARV`** | **null** | **575,000** | **`arv`** |
| "The seller completed the budget prior to our inspection." | `ASIS` | 575,000 | null | `as_is` |
| "No repairs are required." | `ASIS` | 575,000 | null | `as_is` |

Rows 3 and 4 are **exactly how a post-renovation as-is appraisal reads** — the refinance-out appraisal
on a finished flip, which is a core RTL document. The report is genuinely as-is (the work *is* done);
the parser calls it an ARV report, files the number in `arv_value`, leaves `as_is_value` NULL, and
stamps every comparable `arv`. Downstream: `decideAsIsApply` sees no As-Is, the
`appraisal_as_is_verify` condition opens asking a human to type in a value that is sitting right
there, and the warehouse's as-is comp pool loses the whole grid.

**The minimal fix** (two lines, no new parsing, no schema change):

> When the report **explicitly states `_CONDITION_OF_APPRAISAL/@_Type = "AsIs"`**, only the
> *hypothetical* arm of `HYPO_RE` may override it. Past-tense "the repairs were completed" describes
> history, not a hypothetical condition, and cannot turn a stated as-is opinion into an after-repair
> one. Keep the full `HYPO_RE` for the `else` branch (`extract.js:180`), where there is no enum to
> trust and the inference is all we have.

Split `HYPO_RE` into `HYPO_STRICT_RE` (arm 1) and `HYPO_RE` (both arms); use the strict one in the
`cond === 'AsIs'` test only. Everything else — including the measured `CP_09709435` case, which says
"hypothetical condition" — behaves identically.

### 4c. Two smaller as-is-only observations

- **A report with no `_CONDITION_OF_APPRAISAL` at all falls to `basis = 'ASIS'`** and splits every comp
  `as_is` (measured). That is the right default, but note it is an *inference* (`basisNote:'inferred'`)
  that produces the same `single_grid` confidence as an explicit statement. The confidence value does
  not distinguish "the report said as-is" from "we assumed as-is". Worth carrying `basisNote` onto the
  observation so a search can tell.
- **`X.find(root, '_CONDITION_OF_APPRAISAL')` takes the first element only.** The 1025 field map notes
  the element *"may appear more than once (e.g. both `SubjectToRepairs` AND `AsIs` in 08108509)"*. On a
  file that lists `AsIs` first and `SubjectToRepairs` second, `basis` becomes `ASIS` and the ARV is
  filed as the as-is value — the mirror image of C-6. A "any subject-to wins over AsIs" scan of all
  such elements is the correct reading and matches the field map's own rule.

### 4d. `backfillAppraisalCompSplitOnce`

`src/lib/appraisal/desk.js:484`. Boot pass (`src/server.js:620`), 200 appraisals per run, re-parses the
stored XML, rewrites `comp_set` on `appraisal_comparables`, and — importantly — calls
`fireResearchIngest(r.id, 'comp-split backfill')` so the warehouse is re-ingested with the new answer.
Because an as-is-only report already splits correctly, this pass will not change anything for the
owner's new uploads; it is the delivery mechanism for the C-6 fix once made, and it will correct
existing files on the next boot with no migration.

---

## 5. DOES EVERY IMPORT REACH THE WAREHOUSE?

### 5a. The two doors

```
                ┌─ loan file:  routes/appraisal.js → desk.runAppraisalImport
                │              → import.importAppraisal → appraisals + appraisal_comparables
                │              → desk.fireResearchIngest → ingest.ingestAppraisal ─┐
XML ────────────┤                                                                  ├→ ingest.writeReport → warehouse
                └─ standalone: POST /api/research/imports (routes/research.js:1207)│
                               → research/xml-import.importXml → research_imports ─┘
```

Both doors shape their rows with the **same** `appraisalRowFrom` / `comparableRowFrom` out of
`src/lib/appraisal/import.js`, and both write through the **same** `ingest.writeReport`. Verified by
reading `xml-import.js:40` (`const { appraisalRowFrom, comparableRowFrom } = require('../appraisal/import')`)
and `:238` (`await ingest.writeReport(client, { a, comps, link: { importId }, out: w })`). **There is
no second mapping** and no fact is filed differently by door. The upload door additionally stands down
when a loan file already holds the report (`existingFileCopy`), and a loan-file ingest retires an
earlier upload (`retireDuplicateImports`).

The loan-file door fires the ingest **three** times — after import, after photo extraction, and after
the comp-split backfill (`desk.js:252, 268, 338, 528`) — so a later-arriving fact re-reaches the
warehouse.

### 5b. Measured (`ysmerge`, 2026-08-03)

| Measure | Count |
|---|---:|
| `appraisals` | 71 |
| …with a `property_ingest_log` row | **71 (100%)** |
| …ledger status `ok` / `error` / `skipped` | 71 / 0 / 0 |
| `appraisal_comparables` rows | 10 |
| comparable observations carrying a `comparable_id` | **10** |
| **loan-file comparables lost between the tables** | **0** |
| `research_imports` rows (`ok` / `skipped` / `error`) | 51 / 10 / 2 |
| comparable observations with `appraisal_id IS NULL` (upload door) | 73 |
| comparable observations, total | 83 |
| `property_observations` total / `properties` / `property_sales` | 126 / 93 / 49 |
| `ystest` (second database) | 100 appraisals · 28 comparables · 304 observations · 224 properties |

> **The database moved while this was being measured** — another session was writing to `ysmerge`
> concurrently (`appraisals` 71 → 72, `research_imports` 63 → 73 within the audit). The *counts* above
> are a snapshot; the *structural* results below were re-checked afterwards and are unaffected:
> appraisals ↔ ledger rows still 1:1 (72 / 72), `appraisal_comparables` ↔ comparable observations
> carrying a `comparable_id` still 1:1 (12 / 12), and `units`, `unit_mix` and `garage_type` are still
> populated on **zero** comparable observations. The probe rows this audit wrote were removed
> afterwards; the database is as it was found.

**Comparables from BOTH doors land in `property_observations` with `role='comparable'`.** Confirmed
directly: 10 loan-file comparables ↔ 10 comparable observations with a `comparable_id` (one-to-one, no
loss), and 73 upload-door comparable observations with a null `appraisal_id`. My own end-to-end probe
through `importXml` produced `{properties: 7, observations: 7, sales: 13, skipped: 0}` — a subject plus
6 comparables, all present and queryable.

**The apparent gap is a test-data artifact, not a bug.** 64 of 71 appraisals wrote **zero**
observations. All 64 have `subject_address IS NULL AND subject_state IS NULL AND subject_city IS NULL
AND subject_zip IS NULL` and an empty `fields` jsonb — they were inserted straight into `appraisals`
by test fixtures and never went through `importAppraisal`, so there is nothing to file. 59 of them
do carry a `form_type`, which is what makes them look like real imports at a glance.

### 5c. The one real gap this measurement exposed

> **FINDING C-7 (LOW, but it is the ledger's whole purpose) — a subject the warehouse cannot key is
> dropped silently, while a comparable is counted.**

`writeReport` wraps the subject in `if (subjectId) { … }` (`ingest.js:839`) with **no `else`**. The
comparable loop, by contrast, pushes a named skip reason and increments `rows_skipped`
(`ingest.js:1059-1063`). So all 64 addressless appraisals logged `status:'ok', rows_skipped:0,
skip_reasons:[]` — indistinguishable from a report that was filed perfectly. `db/409` §6 states the
intent plainly: *"a silent skip is indistinguishable from a report that simply had no comps. Counting
them, with the reason and the address as stated, is what turns 'we might be dropping data' into a
number somebody can look at."* The subject deserves the same `out.skipped.push(...)`.

---

## 6. RANKED LIST OF FACTS WE SHOULD START READING

Ranked by value to comparing properties. **"How often populated"** is from the repo's own 33-file
measurements where the docs state it, and marked *(unmeasured)* where no corpus is available — I will
not invent a frequency. **P** = property fact (add to `ROLLUP_FACTS`, bump `ROLLUP_VERSION`);
**R** = report fact (observation only, never rolls up), per the handoff §2 rule.

| # | Fact | XML path | Plain English | Why it matters | How often | P/R |
|---|---|---|---|---|---|---|
| 1 | **Per-unit room/bed/bath, and the unit COUNT, for a 2-4 unit comparable** | `COMPARABLE_SALE/ROOM_ADJUSTMENT` × N (`@UnitSequenceIdentifier`, `@TotalRoomCount`, `@TotalBedroomCount`, `@TotalBathroomCount`, `@RoomAdjustmentAmount`) | The grid states one room line **per unit**. N rows = the appraiser stating this comp has N units. | Fixes C-5, the only place we store a *wrong* number. Gives a comparable the same `unit_mix` the subject has, and gives the comparable a **stated** unit count. | 1025 only; the 1025 field map lists it as a standard per-comp row | **P** (both `unit_mix` and `units` already roll up) |
| 2 | **Price per square foot on a 1025** | `COMPARABLE_SALE/@SalesPricePerGrossBuildingAreaAmount` | What the comp sold for per foot of building. | Owner-named field; today NULL on every 2-4 unit comp. One-line fix beside the existing GLA read. | 1025 field map: standard per-comp attribute | **R** (`price_per_gla` is correctly observation-only) |
| 3 | **Price per unit** | `COMPARABLE_SALE/@SalesPricePerUnitAmount` | Dollars per apartment. | The headline metric for 2-4 unit comparison — how small-income property is actually priced. Also the cross-check on rank 1's unit count. | 1025 field map: listed with an example | **R** |
| 4 | **Comparable's garage / parking** | `SALE_PRICE_ADJUSTMENT[_Type=Parking\|CarStorage]/@_Description` ("4 Off Street", "2ga2dw") | Whether the comp has a garage and how many spaces. | Fixes C-3 — always NULL today. Parking is a first-order value driver and already has a column waiting. | Listed in the `_Type` vocabulary measured across all four vendors | **P** (`garage_type`, `garage_spaces` roll up) |
| 5 | **Comparable's monthly rent and GRM** | `COMPARABLE_SALE/@MonthlyRentAmount`, `@GrossMonthlyRentMultiplierFactor` | What the comp was renting for, and the price÷rent multiple. | The income side of a 2-4 unit comparison; lets a rent-based value indication be computed from our own data. | 1025 field map: both listed, `N/A` common | **R** (rent at the date of that sale; a durable "market rent" is a different fact) |
| 6 | **Comparable's stated AGE (years)** | `SALE_PRICE_ADJUSTMENT[_Type=Age]/@_Description` when it is an age, not a year | "115" = 115 years old at the effective date. | Fixes C-4. Store the **age as stated** in its own column — do **not** compute a year built from it (that is arithmetic on top of a rounded number, and the warehouse never fabricates). A year built stays NULL unless the line states a 4-digit year, exactly as today. | Every UAD grid states this line | **P** (a new `age_years`; `effective_age` already exists for the subject) |
| 7 | **Data source + DOM fallback for non-UAD vendors** | `COMPARABLE_SALE/@DataSourceDescription`, `@DataSourceVerificationDescription` | "MLS#24094440 , DOM 15" — the MLS number and days on market. | Fixes C-1. On any report without the UAD `COMPARISON_DETAIL` block these are the *only* source and DOM available, and the repo's own fallback table already prescribes the regex. | The docs record `COMPARISON_DETAIL` as absent on 1025 / non-UAD files | **R** |
| 8 | **The rental-comparable grid (1025)** | `INCOME_ANALYSIS/MULTIFAMILY_RENTALS/MULTIFAMILY_RENTAL[seq≥1]` + `RENTAL_UNIT` + `RENTAL_FEATURE` | Up to 3 rent comps, each with address, proximity, total rent, rent/sqft, GBA, and per-unit rooms/beds/baths/sqft/rent. | Entirely unread today — `extract()` emits only `report.rentalGrids`, a **count**. These are real addresses with real stated rents: new properties for the warehouse and the only rent evidence we would own. Needs a third `role` (`rental_comparable`). | 1025: *"always 4 elements → 3 comps"* | **P** for the physical facts + **R** for the rent |
| 9 | **Listing comparables (ACI's separate element)** | `COMPARABLE_LISTING`, `RESIDENTIAL_RENTAL` | ACI emits active listings as their own element rather than as a `COMPARABLE_SALE`. | Neither string appears in `extract.js`. On an ACI file every listing comp is invisible — and a listing is how the warehouse learns `last_list_price`. | ACI files (5 of 21 in the photos/comps corpus) | **P** (`last_list_price`) + **R** |
| 10 | **Basement area / finish from the grid line** | `SALE_PRICE_ADJUSTMENT[_Type=BasementArea\|BasementFinish]/@_Description` | "900sf" / "300sf" — the comp's basement and how much is finished. | Sits in `adjustments` jsonb where no filter reaches it, while `basement_sqft` / `basement_finished_pct` columns exist and roll up. Non-UAD files have no `GSEBelowGrade*` attributes, so this is the only source. | Standard `_Type` on every vendor | **P** |
| 11 | **Per-unit lease dates on the subject** | `UNIT_RENT_SCHEDULE/@LeaseStartDate`, `@LeaseExpirationDate` | When each tenancy started and ends. | Read today only to derive `leaseStatus`, then discarded. "Three of four leases expire within six months" is a real exit risk on a rental take-out. | 10/10 on 1025 | **P** (inside `unit_mix`) |
| 12 | **Functional utility, heating/cooling, energy items per comp** | `SALE_PRICE_ADJUSTMENT[_Type=FunctionalUtility\|HeatingCooling\|EnergyEfficient]` | "Average", "FWA/None", "Typical" + their dollar adjustments. | In `adjustments` jsonb only. `heating_type`/`cooling` columns exist and roll up; a comp with no heat is a materially different property. | Standard `_Type` on every vendor | **P** |
| 13 | **UAD view and location CODES per comp** | `SALE_PRICE_ADJUSTMENT[_Type=View\|Location]/@_Description` ("N;Res;", "B;Wtr;") | The coded view/location: neutral, residential; beneficial, water. | We store the coarse overall rating (`Beneficial/Neutral/Adverse`) from the UAD block but drop the *kind* — water view, busy road, commercial adjacency. Non-UAD files have no overall rating at all, so this is the only source. | Standard `_Type`; the overall-rating blocks are UAD-only | **P** |
| 14 | **Concession and financing detail per comp** | `SALE_PRICE_ADJUSTMENT[_Type=SalesConcessions\|FinancingConcessions]/@_Description` ("ArmLth;0", "Conv;0") | UAD-coded sale type and financing with the concession amount. | Fallback for `sale_type`/`financing_type`/`concession_amount` when `COMPARISON_DETAIL` is absent. A concession-inflated price is a false comp. | Standard `_Type` | **R** (this transaction) |
| 15 | **Porch/deck and other feature lines** | `SALE_PRICE_ADJUSTMENT[_Type=PorchDeck]`, `OTHER_FEATURE_ADJUSTMENT` | Deck, pool, fireplace and their adjustments. | Captured in jsonb; no column. Lower value than the above but completes the grid. | Standard | **P** |
| 16 | **Rent control status** | `COMPARABLE_SALE/@RentControlStatusType` | Whether the comp is rent-controlled. | A rent-controlled comp is not comparable to a free-market building — it is a different asset. Cheap to read. | 1025; ~7/10 on the subject | **P** |
| 17 | **Price per room** | `COMPARABLE_SALE/@SalesPricePerRoomAmount` | Dollars per room. | A secondary 1025 metric; useful mainly as a cross-check on rank 3. | 1025 field map | **R** |
| 18 | **Comp research counts** | `SALES_COMPARISON/RESEARCH/@ComparableSalesResearchedCount`, `@ComparableListingsResearchedCount`, price ranges | How many sales the appraiser looked at before choosing these. | Already read into the subject's `comp_research`; it is a quality signal about the *report* (22 researched vs 3 used). Not per comp. | 10/10 | **R** |
| 19 | **Per-unit utilities included in rent** | `MULTIFAMILY_RENT_SCHEDULE/RENT_INCLUDES_UTILITY` | Which utilities the landlord pays. | Read at report level (`rent_included_utilities`); folding it into `unit_mix` makes a rent genuinely comparable (a $1,800 heat-included rent ≠ $1,800 net). | 1025 | **P** |
| 20 | **The comp's `basisNote` / split provenance** | derived, not an XML path | Whether "as-is" was *stated* by the report or *inferred* by us. | `comp_set_confidence` distinguishes narrative/proximity/single_grid but a `single_grid` answer does not say whether the basis came from an explicit enum or an inference (§4c). One extra column makes an honest search possible. | — | **R** |

### Facts I deliberately do NOT recommend reading

- **A comparable's property TYPE.** No MISMO 2.6 element states it per comp. The `DesignStyle`
  adjustment ("3 Family", "Colonial") is *stated* and is already stored in `design_style`, but turning
  it into a category is an **inference**, and the warehouse's own rule (handoff §4 rule 8) says the
  right answer comes from that address appearing as some other report's subject. Leave
  `appraisal_comparables.property_type` NULL. If it is ever filled, the value must come from
  `derivePropertyCategory` reading that property's own subject report — never from this grid.
- **A comparable's unit count from `SalesPricePerUnitAmount ÷ PropertySalesAmount`.** It divides to 3.0
  cleanly on the probe, but that is arithmetic on two rounded figures and will produce 2.97 or 3.04 on
  real data. Use it **only as a cross-check** on rank 1, never as the source. The `ROOM_ADJUSTMENT` row
  count is a genuine statement; this is a calculation.
- **Anything inherited from the subject.** Rank 1 gives a comparable a *stated* unit count. Nothing
  below that threshold should fill `units` or `property_type`.
- **The 1004MC market grid**, for the property tables. `db/448`'s header already ruled on this and it
  is right: a market statistic on a property row gives every house its own private copy of the town's
  numbers. It needs a geography-and-period table, which `src/lib/research/market.js` has begun.

### One caution on rank 1

`_UNIT_GROUP` pads to four rows on a la mode and ACI files, with the trailing ones blank
(`1025-SmallIncome-field-map.md` §F4). If `ROOM_ADJUSTMENT` pads the same way, counting rows blindly
would report a 2-unit comp as 4 units. **Count only rows that carry a non-empty room, bed or bath
value** — the same defence `extract.js:994` already applies to the subject's rent schedule. Where the
comp's own `LivingUnitCount` is absent (it always is), a padded-and-filtered row count is the stated
answer; if every row is blank, store NULL.

---

## 7. THE DEFECT LIST, IN PRIORITY ORDER

| # | Severity | Defect | Where | Proven by |
|---|---|---|---|---|
| C-5 | **Critical** | 1025 comparable stores unit 1's beds/baths/rooms as the whole building's, and it rolls up to `properties` | `extract.js:303` (`X.find`, not `findAll`) | end-to-end probe: stored `beds=3` for a 7-bed triplex |
| C-2 | High | `price_per_gla` NULL on every 1025 comparable | `extract.js:277` reads only the `…GrossLivingArea…` spelling | same file, one attribute renamed: 1004 → 154.59, 1025 → null |
| C-6 | High | An as-is report saying "the repairs were completed" is filed as ARV; `as_is_value` NULL, all comps `arv` | `HYPO_RE` arm 2, `extract.js:151` + `:178` | 6-phrase truth table |
| C-3 | High | Comparable garage never read — the type list omits `Parking`/`CarStorage` | `ingest.js:1278` | all four spellings tested against the normalizer |
| C-1 | Medium | Non-UAD vendor loses data source, DOM, sale type, concessions, view/location, below-grade | `COMPARISON_DETAIL`-only reads | `COMPARISON_DETAIL` removed → 13 columns NULL |
| C-4 | Medium | `year_built` NULL when the Age line states an age in years | `fromAdjustments(…, 'age', K.yearBuilt)` | `K.yearBuilt('115') = null` |
| C-8 | Medium | `appraisal_comparables.property_type` / `.units` (db/409 §7) are written by nothing | `comparableRowFrom` emits neither key | `row.units === undefined`; 0/83 observations populated |
| C-9 | Medium | Multiple `_CONDITION_OF_APPRAISAL` elements — only the first is read | `extract.js:169` | field map §B3 records files carrying both |
| C-7 | Low | A subject that cannot be keyed is dropped without a skip reason, while a comparable is counted | `ingest.js:839`, no `else` | 64 ledger rows `ok / rows_skipped:0` with no address |
| C-10 | Low | A vacant unit's stated `$0` rent becomes NULL — "earning nothing" reads as "not stated" | `bounded()` on `UnitActualRentAmount` | probe unit 2 |
| C-11 | Low | Per-unit lease dates discarded after deriving `leaseStatus` | `extract.js:995` | parsed unit keys |

---

## 8. THE DISCIPLINE THIS AUDIT HELD TO

Every recommendation above names the element or attribute the value is **read from**, and where a fact
is genuinely absent from MISMO 2.6 the recommendation is to **leave it NULL**, not to fill it.

Specifically, on the two facts the owner named that a grid does not state:

- **Unit count** — recommended (rank 1) **only** from the `ROOM_ADJUSTMENT` rows the appraiser wrote,
  with padded rows filtered out. That is the report stating "here is unit 1, here is unit 2, here is
  unit 3". It is not inferred from the subject, not divided out of a price-per-unit, and not defaulted
  to 1.
- **Property type** — **not** recommended. It is absent, `design_style` is the closest stated fact and
  is already stored, and the warehouse's answer remains the same address turning up as another
  report's subject.

C-5, C-2, C-3 and C-4 are not requests for new data. They are facts the report already states, that we
already have in hand, and that are being dropped or — in C-5's case — replaced with a wrong number
on the way to the warehouse.
