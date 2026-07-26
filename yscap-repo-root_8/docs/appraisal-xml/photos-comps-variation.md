# MISMO 2.6 Appraisal XML — Photos, Comparables & Cross-Vendor Variation

Scope: 21 Fannie Mae **1004** (URAR) and **1025** (Small Residential Income) appraisal XMLs, root
`<VALUATION_RESPONSE MISMOVersionID="2.6">`, produced by **four different appraisal software vendors**
(a la mode TOTAL, ACI, ClickFORMS, Appraise-It). Base64 image/PDF payloads have been stripped and replaced
with `[BASE64 N chars stripped]`, but all `<IMAGE>` / `<EMBEDDED_FILE>` metadata is intact.

**Headline reality check that overrides the task's stated assumptions:**
- Individual photos are **NOT embedded as base64** anywhere in this corpus. Every file contains **exactly one**
  `<EMBEDDED_FILE _Type="PDF">` — the full appraisal PDF — and that PDF is the *only* pixel payload.
- Per-photo `<IMAGE>` elements, where present, are **metadata-only placeholders** (`<IMAGE .../>` with no
  `<DOCUMENT>` child). They carry a slot identifier + caption + a `HasImage`/`NoImage` presence flag, but the
  actual image lives inside the PDF. Roughly 60% of files (all a la mode, some ACI) emit **no** per-photo
  metadata at all — only the PDF.
- `_Type` does **not** appear on `<IMAGE>`; the semantic label lives in `_Identifier` (on IMAGE) and in the
  parent `<FORM AppraisalReportContentType=...>`.

---

## (a) IMAGE / EMBEDDED_FILE catalog

### `<EMBEDDED_FILE>` — the PDF payload (present in all 21 files, exactly once each)
| Attribute | Value(s) observed | Meaning |
|---|---|---|
| `_Name` | `AppraisalReport` (a la mode/ACI/ClickFORMS) — **absent** in some files | Logical name of the blob |
| `_Type` | `PDF` (21/21) | Blob type |
| `_EncodingType` | `Base64` | Encoding |
| `MIMEType` | `application/pdf` | MIME |
| child | `<DOCUMENT>[BASE64 … stripped]</DOCUMENT>` | The bytes |

Parent varies: under `<IMAGE _Name="AppraisalForm">` (ClickFORMS, ACI-1025, Appraise-It, "blank"-vendor 1025s)
**or** directly under `<FORM>` with no IMAGE wrapper (a la mode, some ACI-1004). A parser must locate
`EMBEDDED_FILE` **globally**, not by a fixed path.

### `<IMAGE>` — attribute vocabulary
| Attribute | Values | Role |
|---|---|---|
| `_Name` | `HasImage` (102), `AppraisalForm` (10), `NoImage` (2) | Presence flag / PDF-wrapper marker. `NoImage` = empty slot. |
| `_SequenceIdentifier` | `1` | Only on the `AppraisalForm` PDF-wrapper IMAGE |
| `_Identifier` | see next table | Semantic photo-slot label |
| `_CaptionComment` | e.g. `"322 Howard Ave/New Haven, CT 06519"`, `"Unit 1 kitchen/"` | Caption; for comp/rental slots it is the **comp address** (`street/city, ST zip`), for interior shots it is a room description. |

### `_Identifier` catalog (per-photo slots) with classification
| `_Identifier` | Classification | Notes |
|---|---|---|
| `SubjectFront`, `SubjectRear`, `SubjectStreet` | **Subject** photo (URAR standard 3) | Caption = subject address |
| `SubjectPhoto1..3` | **Subject** extra photos | side/other views |
| `ComparablePhoto1..3` | **Comparable (sale)** photo | Caption = comp address. **Resets to 1 per FORM block** (see association rule) |
| `Sales Comp 1 - Photo` … `Sales Comp 8 - Photo` | **Comparable (sale)** photo (Appraise-It spelling) | Globally numbered, not reset |
| `RentalPhoto1..3`, `RentalPhotos` | **Rental comparable** photo (1025) | Caption = rental address |
| `Photo1..6`, `ExtraPhoto1..6` | **Interior / misc subject** photos | Caption = room ("Unit 2 bathroom/", "Mechanicals/") |
| `Sketch` | **Floor plan / sketch** | |
| `LocationMap`, `LocationMap1` | **Location / neighborhood map** | |
| `Exhibit` | **Exhibit** (license, E&O, Scope of Work, cert) | Disambiguate via parent FORM name |

### Parent `<FORM AppraisalReportContentType>` catalog (the authoritative photo-group label)
| `AppraisalReportContentType` | + `TypeOtherDescription` | Classification |
|---|---|---|
| `AppraisalForm` | | The URAR/1025 form itself; wraps the PDF |
| `CoverPage` | | Cover page (has a HasImage) |
| `SubjectPhotos` | | Subject photo group |
| `SalePhotos` | | Comparable-**sale** photo group |
| `RentalPhotos` | | Rental-comparable photo group (1025) |
| `LocationMap` | | Location map |
| `Sketch` | | Floor plan / sketch |
| `Exhibit` | | License, E&O, SOW, certificate |
| `Addendum` / `CommentAddendum` | | Text addenda (1004MC market conditions, comments) |
| `Certification`, `Transmittal` | | Boilerplate |
| `Other` | `Photo` / `Map` / `Misc` | Overflow bucket — interior photos, extra maps, UAD glossary |

FORM also carries `AppraisalReportContentSequenceIdentifier` (page order), `AppraisalReportContentName`
(human label, e.g. `"Photo Comparables 4-5-6"`, `"URAR Sales Comparables 7-9 (09/11)"`) and
`AppraisalReportContentIdentifier`.

---

## (b) Rules: subject vs comp vs map/sketch, and photo→comp association

**Classification rule (most robust first):**
1. Prefer the **parent `FORM/@AppraisalReportContentType`** (`SubjectPhotos` | `SalePhotos` | `RentalPhotos`
   | `LocationMap` | `Sketch` | `Exhibit`). This is present in every vendor that emits photo metadata.
2. Fall back to the IMAGE **`_Identifier` prefix** (`Subject*` | `Comparable*` / `Sales Comp *` | `Rental*` |
   `Sketch` | `LocationMap` | `Exhibit` | `Photo*` = interior/misc).
3. `_Name="NoImage"` → empty slot, skip. `_Name="AppraisalForm"` → PDF wrapper, not a photo.

**Photo → comp association:** there is **no nesting** of photos under comp elements and **no shared key**.
Association is **positional by the comp index encoded in the label**:
- `ComparablePhoto1/2/3` resets to 1 in each `SalePhotos` FORM; the FORM name disambiguates the block
  (`"Photo Comparables 1-2-3"`, then `"Photo Comparables 4-5-6"`, then `7-8-9`). So global comp # =
  (block offset from FORM name) + (Identifier ordinal). Appraise-It instead numbers globally
  (`Sales Comp 7 - Photo`).
- The **only reliable cross-check** is matching the IMAGE `_CaptionComment` address to the
  `COMPARABLE_SALE/LOCATION/@PropertyStreetAddress`. **Use the caption address as the join key**, not the ordinal.
- Because ~60% of files carry no photo metadata, comp photos frequently exist **only inside the PDF**; a parser
  must treat per-comp photo metadata as best-effort, never guaranteed.

**Caption availability:** captions exist only via `_CaptionComment` and only on vendors that emit photo
metadata. Map/sketch/exhibit slots usually have no caption. There is no per-image description otherwise.

---

## (c) COMPARABLE_SALE structure + the As-Is/ARV split signal

### Structure
`<COMPARABLE_SALE>` (in a `<SALES_COMPARISON>` grid). **The subject occupies the grid too, as
`PropertySequenceIdentifier="0"`.** Actual comps are `PropertySequenceIdentifier="1..N"`.

Key attributes (on the element): `PropertySalesAmount`, `SalesPricePerGrossLivingAreaAmount` (1004) /
`SalesPricePerGrossBuildingAreaAmount` (1025), `AdjustedSalesPriceAmount`, `SalePriceTotalAdjustmentAmount`,
`SalesPriceTotalAdjustmentPositiveIndicator`, `SalePriceTotalAdjustmentNetPercent`,
`SalesPriceTotalAdjustmentGrossPercent`, `DataSourceDescription` (e.g. `"MLS# NJME2063792;DOM 51"`),
`DataSourceVerificationDescription`. 1025 adds `MonthlyRentAmount`, `GrossMonthlyRentMultiplierFactor`,
`SalesPricePerUnitAmount`, `SalesPricePerRoomAmount`, `RentControlStatusType`.

Children:
- `<LOCATION PropertyStreetAddress PropertyStreetAddress2 ProximityToSubjectDescription>` — address +
  **proximity is free text** ("0.95 miles SE"). a la mode adds `LatitudeNumber`/`LongitudeNumber`,
  `PropertyCity/State/PostalCode`.
- `<ROOM_ADJUSTMENT TotalRoomCount TotalBedroomCount TotalBathroomCount>` — one per unit on 1025
  (`UnitSequenceIdentifier`), one total on 1004.
- `<SALE_PRICE_ADJUSTMENT _Type="…" _Description="…" _Amount="…">` — the grid rows. `_Type` vocabulary:
  `DateOfSale`, `SalesConcessions`, `FinancingConcessions`, `Location`, `View`, `SiteArea`, `Quality`,
  `Condition`, `Age`, `DesignStyle`, `GrossLivingArea`/`GrossBuildingArea`, `BasementArea`, `BasementFinish`,
  `FunctionalUtility`, `HeatingCooling`, `EnergyEfficient`, `Parking`/`CarStorage`, `PorchDeck`, `Other`.
- **Sale date lives in `SALE_PRICE_ADJUSTMENT[_Type="DateOfSale"]/@_Description`** — format varies:
  UAD-coded `"s10/25;c09/25"` (settled/contract, a la mode 1004) vs plain `"05/22/2025"` (ACI/1025).
- UAD extension blocks (a la mode/ACI 1004): `COMPARISON_DETAIL` (`GSEDaysOnMarketDescription`,
  `GSEListingStatusType`, `GSESaleType`, `GSEOverallConditionType`, `GSEQualityOfConstructionRatingType`,
  `GSEConcessionAmount`), `PRIOR_SALE`, `COMPARISON_LOCATION_*`.

**Count:** 3–9 real comps per file (grid holds subject + 3..9). Range in corpus: `<COMPARABLE_SALE>` count
4–10 including subject.

**Sales vs listings vs closed:**
- UAD vendors: `COMPARISON_DETAIL/@GSEListingStatusType` = `SettledSale` | `Contract` | `Active`.
- ACI additionally emits a separate `<COMPARABLE_LISTING>` element (and `<RESIDENTIAL_RENTAL>`) for listings.
- Non-UAD/1025: infer from `DataSourceDescription` (contains "DOM", "Active", "Pending", "Listing", or `s/c` date).
- **Rental comps are a different element, not COMPARABLE_SALE:** 1025 uses
  `<MULTIFAMILY_RENTALS>/<MULTIFAMILY_RENTAL PropertySequenceIdentifier="0..">` with `<RENTAL_UNIT>` children
  (subject rental = seq 0). ACI also emits `<RESIDENTIAL_RENTAL>`.

### The As-Is / ARV (subject-to) comp-split signal — **there is no structured flag**
RTL appraisals report two values (As-Is and After-Repair/Subject-To) from **one grid**, splitting the comps
into two subsets. **The split is only ever stated in free-text prose**, and both the *wording* and the
*location* vary by vendor. There is **no attribute, no separate grid, no per-comp flag**. Observed signal
locations:

| Vendor | Where the split sentence lives | Example |
|---|---|---|
| ClickFORMS | `FORM[ContentType=CommentAddendum]/@AppraisalAddendumText` | "Comparables 1-3 are used for the 'ARV' value and comparable 4-6 are used for the 'as-is' value." |
| ACI | `FORM/@AppraisalAddendumText` (one giant blob) | "Comps 7-9 represent the as is value … Comps 1-6 represent the subject's subject to value." |
| a la mode | `PRIOR_SALE/@GSEPriorSaleComment`, `SALES_CONTRACT/@CurrentSalesAgreementAnalysisComment`, and reconciliation `@SummaryComment`/`@ConditionsComment`/`@Comment` | "Comparables #1-3 are for the After Repairs Value" + "Comparables #4-6 are for the current As Is value." |
| a la mode (alt) | Sales-comparison `@Comment` | "Sales #1 #2 & #3 … 'As Repaired' … Sales #5, #6 #7 … current C4 condition." |
| Appraise-It | Structural hint: `FORM/@AppraisalReportContentName` = "URAR Sales Comparables 4-6", "…7-9" | ordering of grid blocks |

**The subset assignment is NOT positionally consistent** — observed conventions include 1-3=ARV/4-6=AsIs,
1-6=SubjectTo/7-9=AsIs, and 1-3=ARV/5-7=AsIs (with a skipped comp). **A parser must extract the two dollar
values and the comp-number ranges from the prose** (regex over the comment fields above, capturing
`comparable[s]?\s*#?\d\s*(-|to|through|and)\s*#?\d` near `ARV|as[- ]?is|as repaired|subject[- ]?to`), and
must never assume a fixed 1-3/4-6 split. The two headline values also appear as prose
("As Repaired Value … $575,000", "As-Is value … $430,000"), sometimes in `@SummaryComment`/`@AdditionalDescription`.

---

## (d) Vendor catalog + per-field robustness table

### Vendors (from `REPORT/@AppraisalSoftwareProductName`, form-name style, structural fingerprints)
| Vendor | Files | Fingerprints |
|---|---|---|
| **a la mode - TOTAL** | 09432272, 09769678, 09770010, 10736314, 10736526, nan_Coto, nan_Steiner (+ the "blank software" 1025s: 08821926, 09709435, 10209004, 10391589, 10394133, 10421150, nan_Kaufman) | Bracketed FORM names `"URAR [Form 1004][03/05][UAD Version]"`, `"Small Income [Form 1025][03/05]"`; self-closing `/>` tags; ISO dates; EMBEDDED_FILE directly under FORM (no IMAGE wrapper); rich UAD extension blocks; **no per-photo IMAGE metadata**. NB: several a la mode files leave `@AppraisalSoftwareProductName` **empty**. |
| **ACI** | 09282104, 10182152, 10484851, 10636060, nan_Lev | `AppraisalSoftwareProductName="ACI"`; emits `<COMPARABLE_LISTING>` and `<RESIDENTIAL_RENTAL>`; huge single `@AppraisalAddendumText` blobs prefixed `-::-  -:EXTRA COMMENTS:-`; MM/DD/YYYY dates; per-photo metadata present in some files, absent in others. |
| **ClickFORMS** | 08108509 | `AppraisalSoftwareProductName="ClickFORMS"`; richest per-photo metadata (FORM+IMAGE per slot); MM/DD/YYYY-ish; `AppraisalReportContentType` well-populated. |
| **Appraise-It** | 09405263 | `AppraisalSoftwareProductName="Appraise-It"`; `_Identifier="Sales Comp N - Photo"`; FORM names `"URAR Sales Comparables 4-6 (09/11)"`; **non-contiguous** comp sequence (0,1,2,3,4,5,7,8 — comp 6 skipped). |

The two naming conventions in filenames (`Completed_Product_(Data)_*` vs `nan_*`) are **delivery/export
labels, not vendors** — both contain all four software vendors.

### Per-field primary → fallback map
| Field | Primary source | Fallback(s) | Bad/empty detection |
|---|---|---|---|
| Form type | `REPORT/@AppraisalFormType` (`FNM1004`/`FNM1025`) | `FORM[IsPrimaryFormIndicator=Y]/@AppraisalReportContentIdentifier` | must be non-empty and in known set |
| Vendor | `REPORT/@AppraisalSoftwareProductName` | FORM-name bracket style; presence of `COMPARABLE_LISTING`/UAD ext | empty string is common (a la mode) → use fingerprints |
| The PDF | any `EMBEDDED_FILE[_Type=PDF]/DOCUMENT` (global search) | — | exactly 1 expected; 0 = broken |
| Comp list | `COMPARABLE_SALE` where `@PropertySequenceIdentifier != "0"` | — | **exclude seq 0 (subject)**; do not assume contiguous seq (Appraise-It gaps) |
| Comp address | `COMPARABLE_SALE/LOCATION/@PropertyStreetAddress` (+`…2`) | `PropertyCity/State/PostalCode` (a la mode) | empty street = placeholder/unused column |
| Comp sale price | `@PropertySalesAmount` | grid `@AdjustedSalesPriceAmount` for adjusted | `""`, `"N/A"`, `0` all seen → treat as null |
| Adjusted price | `@AdjustedSalesPriceAmount` | subject column has none | absent on subject (seq 0) |
| GLA / GBA | `SALE_PRICE_ADJUSTMENT[_Type=GrossLivingArea\|GrossBuildingArea]/@_Description` | `SalesPricePer…AreaAmount` back-calc | 1004→GLA, 1025→GBA; pick by form type |
| Sale/contract date | `SALE_PRICE_ADJUSTMENT[_Type=DateOfSale]/@_Description` | UAD `GSE…`/`s..;c..` decode; `PRIOR_SALES/@…Date` | two formats (`s10/25;c09/25` vs `05/22/2025`); `""` = listing |
| Proximity | `LOCATION/@ProximityToSubjectDescription` | — | free text, may be `""` |
| Listing status | `COMPARISON_DETAIL/@GSEListingStatusType` | `<COMPARABLE_LISTING>` (ACI); parse `DataSourceDescription` for "DOM/Active/Pending" | UAD-only; absent on 1025/non-UAD |
| DOM | `COMPARISON_DETAIL/@GSEDaysOnMarketDescription` | `DataSourceDescription` regex `DOM (\d+)` | — |
| Rental comps (1025) | `MULTIFAMILY_RENTAL` (seq≠0) | `RESIDENTIAL_RENTAL` (ACI) | separate from COMPARABLE_SALE |
| As-Is/ARV split | prose in comment fields (see table above) | headline `$` values in `@SummaryComment`/`@AdditionalDescription` | **no structured flag**; if no prose match, flag "split unknown" |
| Photo→comp link | IMAGE `_CaptionComment` address == comp address | positional `_Identifier` ordinal + FORM block | metadata absent in ~60% of files → PDF-only |

---

## (e) Parser gotchas

1. **Subject is a comp column.** `COMPARABLE_SALE`/`MULTIFAMILY_RENTAL` with `PropertySequenceIdentifier="0"`
   is the subject, not a comparable. Filter it out everywhere.
2. **Comp sequences are not contiguous.** Appraise-It skips indices (0,1,2,3,4,5,7,8). Never derive comp count
   from max sequence; count non-zero elements.
3. **No per-photo pixels; ~60% of files have no per-photo metadata.** Only the single PDF is guaranteed.
   Do not build a pipeline that requires enumerated per-comp images.
4. **`EMBEDDED_FILE` parent path is inconsistent** — under `<IMAGE _Name="AppraisalForm">` (ClickFORMS/ACI/
   Appraise-It) or directly under `<FORM>` (a la mode). Search for it globally.
5. **The As-Is/ARV split is unstructured prose in vendor-specific fields**, with inconsistent subset
   conventions (1-3/4-6 vs 1-6/7-9 vs 1-3/5-7). Regex the comment fields; never hardcode a positional split.
6. **`_Type` is not on IMAGE; `_Name` is only a presence flag** (`HasImage`/`NoImage`/`AppraisalForm`).
   Semantic label = `FORM/@AppraisalReportContentType` or IMAGE `_Identifier`.
7. **`AppraisalSoftwareProductName` is frequently empty** (all "blank" files are actually a la mode). Detect
   vendor by fingerprints (bracket FORM names, `COMPARABLE_LISTING`, UAD extension blocks) as a fallback.
8. **Mixed date formats & sentinels.** ISO `YYYY-MM-DD` (a la mode/ClickFORMS) vs `MM/DD/YYYY` (ACI/Appraise-It)
   vs UAD `s10/25;c09/25`. Empty/`"N/A"`/`0`/`""` all mean "no value" across different attributes.
9. **1004 vs 1025 change the field names**: `GrossLivingArea`↔`GrossBuildingArea`, single `ROOM_ADJUSTMENT`↔
   per-unit, and 1025 adds rent/GRM attributes and the separate `MULTIFAMILY_RENTAL` grid. Branch on
   `@AppraisalFormType`.
10. **Caption address is the only reliable photo↔comp join key** — ordinals reset per FORM block and differ by
    vendor. Match `IMAGE/@_CaptionComment` to `COMPARABLE_SALE/LOCATION/@PropertyStreetAddress`.
