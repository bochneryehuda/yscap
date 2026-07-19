# MISMO 2.6 / GSE UAD — Authoritative Spec Reference

Ground-truth reference for the appraisal-XML parser (`src/lib/appraisal/xml.js` + `extract.js`).
Purpose: validate our field logic against the **official** GSE/MISMO standards instead of
inference. Assembled 2026-07-19.

> **Access note.** Every canonical GSE/MISMO PDF and HTML page (fanniemae.com, freddiemac.com,
> sf.freddiemac.com, mismo.org, selling-guide.fanniemae.com) is **blocked by this environment's
> egress policy** (the proxy returns HTTP 403 for those hosts; direct `curl` returns
> `CONNECT tunnel failed, response 403`). The URLs below are the **authoritative sources for a
> human to open directly.** Verbatim text was recovered from official-language search snippets and
> from industry reproductions of Fannie Mae Selling Guide **B4-1.3-06** / UAD **Appendix D**, then
> cross-checked against the **11 real appraisal XML files** in
> `docs/appraisal-xml/prototype/` + the scratchpad samples. Where a definition is reproduced rather
> than fetched from the GSE original, it is marked *(reproduced)*.

---

## 1. Authoritative sources (titled + URLs)

### UAD specification / field standardization (Appendix D)
- **Fannie Mae & Freddie Mac — UAD Specification (Appendix D: Field-Specific Standardization Requirements)** — the canonical enumerations/definitions for the C/Q ratings, view/location, dates, baths.
  - Freddie: https://sf.freddiemac.com/docs/pdf/requirements/uadreqs.pdf
  - Freddie (full spec): https://sf.freddiemac.com/docs/pdf/requirements/uad_specification.pdf
  - Fannie (Appendix D): https://singlefamily.fanniemae.com/media/document/pdf/uad-specification-appendix-d-field-specific-standardization-requirements
  - Fannie UAD hub: https://singlefamily.fanniemae.com/delivering/uniform-mortgage-data-program/uniform-appraisal-dataset
- **UAD Appendix A — GSE Appraisal Forms Mapping** (form field → data point → xPath): https://sf.freddiemac.com/docs/pdf/requirements/uad_appendix_a_gse_appraisal_forms_mapping.pdf
- **Fannie Mae Selling Guide B4-1.3-06** — Property Condition and Quality of Construction of the Improvements (the C1–C6 / Q1–Q6 definitions in policy form): https://selling-guide.fanniemae.com/sel/b4-1.3-06/property-condition-and-quality-construction-improvements
- **UAD 2.6 FAQ (Freddie)**: https://sf.freddiemac.com/faqs/uad-faq  •  **Fannie UAD FAQ**: https://singlefamily.fanniemae.com/media/6921/display
- **UAD Condition & Quality Ratings Definitions (Freddie one-pager)**: https://sf.freddiemac.com/docs/pdf/uad-condition-quality-ratings-definitions.pdf
- **UAD Definitions Addendum (industry reproductions, verbatim):** ClickFORMS/Bradford glossary https://support.bradfordsoftware.com/docs/UAD_Glossary.pdf • Tulsa Realtors https://tulsarealtors.com/wp-content/uploads/2022/12/appraisal.definitions.expanded.pdf • GMAR quick-ref https://gmaronline.com/sites/default/files/resources/GMAR-UAD-Quick-Reference-Guide.pdf

### MISMO 2.6 valuation XML structure
- **MISMO Residential Reference Model** (v2.6 Property Valuation Response is the appraisal container): https://www.mismo.org/standards-resources/residential-specifications/reference-model  •  XML schema: https://www.mismo.org/standards-resources/residential-specifications/reference-model/xml-schema
- Our XMLs are **MISMO Property Valuation Response v2.6, Schema Errata 1, "GSE Extended"** — MISMO base model plus proprietary GSE `_`-prefixed / `GSE*`-named extensions (this is the format UCDP calls "MISMO 2.6 Errata 1 GSE Extended," and the preferred UCDP upload format).
- **Fannie Loan Delivery — MISMO Data XML job aid**: https://singlefamily.fanniemae.com/job-aid/loan-delivery/topic/mismo_data_xml.htm

### Form definitions (official Fannie Mae form pages)
- **1004 / Freddie 70 — Uniform Residential Appraisal Report (URAR)**: https://singlefamily.fanniemae.com/media/12371/display
- **1025 / Freddie 72 — Small Residential Income Property (2–4 units)**: form family listed on the UAD hub above; appraisal-review companion (Arch): https://mortgage.archgroup.com/wp-content/uploads/sites/4/MCUS-B0411I-Appraisal-Review-Checklist-NR.pdf
- **1073 / Freddie 465 — Individual Condominium Unit Appraisal Report**: https://singlefamily.fanniemae.com/media/14251/display
- **1004D / Freddie 442 — Appraisal Update and/or Completion Report**: referenced in B4-1.2-05 (Requirements for Verifying Completion): https://selling-guide.fanniemae.com/sel/b4-1.2-05/requirements-verifying-completion-and-postponed-improvements

### UCDP / SSR / EAD (validation edits we can mirror)
- **UCDP General User Guide**: https://sf.freddiemac.com/docs/pdf/step-by-step-guides/ucdp-general-user-guide.pdf
- **Freddie UCDP FAQ**: https://sf.freddiemac.com/faqs/ucdp-faq  •  **Fannie UCDP FAQ**: https://singlefamily.fanniemae.com/learning-center/applications/uniform-collateral-data-portal-learning-center/faqs-uniform-collateral-data-portal
- **Freddie UCDP Proprietary Messages** (the actual edit codes, e.g. FRE4387, FRE4645): https://sf.freddiemac.com/docs/pdf/update/ucdp_proprietary_messages.pdf
- **Submission Summary Report (SSR) Guide**: https://sf.freddiemac.com/docs/pdf/ssr-guide-uad-3.6.pdf
- **UCDP/EAD in Encompass**: https://help.icemortgagetechnology.com/DocumentationLibrary/360/UCDP.pdf

### Vendor / developer docs
- **a la mode / TOTAL — MISMO XML & AI-Ready supported forms**: https://help.alamode.com/docs/8803
- **SFREP / ClickFORMS — UAD 2.6 quality rankings KB**: https://support.sfrep.com/knowledgebase/?id=1232
- **MISMO Appraisal Procurement / Commercial Appraisal datasets**: https://www.mismo.org/standards-resources/mismo-product/appraisal-procurement-dataset-specification

> **UAD version note.** The GSEs are moving from **UAD 2.6** (the MISMO-2.6-based XML we parse today,
> with the four legacy forms 1004/1025/1073/etc.) to **UAD 3.6** (MISMO-**3.6**-based, single dynamic
> "URAR", mandatory production later in the redesign timeline). Definitions below are the **UAD 2.6 /
> current Selling Guide** ones our files use. If files start arriving in UAD 3.6, the XML paths change
> wholesale (MISMO 3.6 container structure) and this parser needs a separate mapping.

---

## 2. Condition ratings C1–C6 (official definitions)

Source: UAD Appendix D / Fannie Selling Guide B4-1.3-06 *(reproduced; verify verbatim at the B4-1.3-06 URL)*.
Ratings are **absolute** (how the property fits the definition), not relative to the market.

- **C1** — The improvements have been **recently constructed and have not been previously occupied**. The entire structure and all components are new and the dwelling features **no physical depreciation**. *(New/never-occupied; also used after a property is completely rebuilt.)*
- **C2** — The improvements feature **no deferred maintenance, little or no physical depreciation, and require no repairs**. Virtually all building components are new or have been recently repaired, refinished, or rehabilitated. All outdated components and finishes have been updated and/or replaced with components that meet current standards. *(New-ish or renovated "to the studs" within ~36 months; no deferred maintenance.)*
- **C3** — The improvements are **well-maintained and feature limited physical depreciation due to normal wear and tear**. Some components (but not every major building component) may be updated or recently rehabilitated. The structure has been well-maintained. *(The current "average" for a typical marketable home.)*
- **C4** — The improvements feature **some minor deferred maintenance and physical deterioration due to normal wear and tear**. The dwelling has been adequately maintained and requires only minimal repairs to building components/mechanical systems and cosmetic repairs. All major building components have been adequately maintained and are functionally adequate.
- **C5** — The improvements feature **obvious deferred maintenance and are in need of some significant repairs**. Some building components need repairs, rehabilitation, or updating. The functional utility and overall livability are somewhat diminished due to condition, but the dwelling **remains useable and functional** as a residence.
- **C6** — The improvements have **substantial damage or deferred maintenance** with deficiencies or defects that are **severe enough to affect the safety, soundness, or structural integrity** of the improvements. The improvements are in need of substantial repairs and rehabilitation, including many or most major components. *(A **C6 is a non-overridable "hard stop"/fatal** at UCDP — see §7.)*

## 3. Quality of Construction Q1–Q6 (official definitions)

Source: UAD Appendix D / B4-1.3-06 *(reproduced)*.

- **Q1** — Architect-designed **unique** structures; exceptionally high workmanship and high-grade materials, components, refinements and ornamentation. Often built from detailed architectural plans.
- **Q2** — **Custom** designed for an owner's site or in a high-quality development; design, workmanship, materials, components and ornamentation are all high or very high quality.
- **Q3** — Higher quality in an above-standard development or on an owner's site; significant exterior ornamentation, interiors well finished; workmanship exceeds acceptable standards; materials and components upgraded from "stock" standards.
- **Q4** — **Standard** or modified building plans; adequate ornamentation with some interior refinements; materials, workmanship and components are mostly stock/builder-grade with a few upgrades; meet or exceed applicable building code. *(The typical tract-home rating.)*
- **Q5** — Dwellings feature **economy of construction and basic functionality** as main considerations; plain design, readily-available/basic floor plans, minimal fenestration, basic finishes, minimal exterior ornamentation and limited interior detail; meet minimum building codes; inexpensive stock materials with limited refinements/upgrades.
- **Q6** — Dwellings of **basic quality and lower cost**; some may not be suitable for year-round occupancy. Built with simple plans or without plans, often using the lowest-quality materials; often built/expanded by persons who are professionally unskilled or possess minimal construction skills; electrical, plumbing and other mechanical systems may be minimal or non-existent. *(A **Q6 is a non-overridable fatal** at UCDP — see §7.)*

---

## 4. Other UAD standardizations we rely on

### Bathroom count — `full.half` convention (NOT a decimal)
Official rule (UAD Appendix D / FAQ): *"The number of full and half baths … separated by a period.
The full-bath count is to the left of the period; the half-bath count is to the right."* So **`2.1` = 2
full + 1 half — it does NOT mean 2.5.** A **three-quarter bath counts as a full bath**; a **quarter bath
(toilet only) is not counted at all.**
- **Ground truth in our samples:** `TotalBathroomCount` appears as `2.1`, `1.1` (true UAD full.half)
  **and** as `1`, `2`, `1.0`, `1.00`, `2.00`, `3.0` (plain-integer / decimal forms the vendor software
  also emits), plus empty `""` on unfilled comp columns. **Both forms coexist in real files** — see the
  parser note in §8.

### Dates — settled/contract/listing prefixes
UAD standard date format is **`mm/dd/yyyy`** (or `mm/yyyy` when the day is unknown). In the UAD sale/date
fields the appraiser prefixes a **status letter**:
- **`s`** = **settled** (closed) sale, followed by the settlement date.
- **`c`** = **contract** date (required when the assignment is a purchase and a contract exists).
- Active/listing statuses use **`Active`/`Listing`/`Expired`/`Withdrawn`/`Pending`** style codes with the
  listing date; the subject's own listing (DOM/list price/date) is captured separately.
- In the **structured XML** these usually surface as separate `_Date`/`_Type`/amount attributes rather
  than one prefixed string, but the underlying convention above is what the PDF shows.

### Condition of the appraisal — "as is" vs "subject to" (Selling Guide B4-1.2 / B4-1.3)
The appraiser's reconciliation encodes the **basis of value**:
- **As Is** — value reflects the property in its current condition (minor conditions that don't affect
  safety/soundness/structural integrity are acceptable "as is").
- **Subject To Completion Per Plans & Specifications** — new/proposed construction; value assumes the
  home is finished per plans.
- **Subject To The Following Repairs or Alterations** — value assumes identified repairs are completed;
  the C/Q ratings are reported on the **hypothetical condition** that the repairs are done.
- **Subject To … Required Inspection** — appraiser not qualified to judge a deficiency; value is subject
  to a satisfactory professional inspection.
- Completion of a "subject to" is later confirmed on **Form 1004D** (Appraisal Update and/or Completion
  Report). Under UAD 3.6 the reconciliation explicitly carries both an **"As Is" overall condition** and,
  when needed, a **"Condition Subject to Repair"** rating.

### View & Location ratings (UAD abbreviation lists)
Location and View each carry a **rating** (`N` Neutral, `B` Beneficial, `A` Adverse) plus **standardized
type abbreviations**, e.g. location `Res` (residential), `Ind` (industrial), `Comm` (commercial), `BsyRd`
(busy road), `WtrFr` (waterfront); view `Wtr` (water), `Pstrl` (pastoral), `Woods`, `Prk` (park), `Golf`,
`CtySky`/`CtyStr` (city skyline/street), `Mtn` (mountain), `Res` (residential), `Ind`, `PwrLn` (power
lines), `LtdSght` (limited sight). Full canonical list is in Appendix D. *(We do not currently parse
view/location; noted for completeness.)*

---

## 5. MISMO 2.6 GSE XML structure (key containers)

Our XMLs are attribute-heavy, namespace-free on the read elements, one `VALUATION_RESPONSE`/`REPORT`
per file with one embedded first-generation PDF. Confirmed element/attribute meanings (verified against
the real sample files):

| Container | Holds | Key attributes we read |
|---|---|---|
| `REPORT` | report-level metadata | `AppraisalFormType` (`FNM1004`/`FNM1025`/`FNM1073`), `AppraiserReportSignedDate` |
| `VALUATION` | the reconciled value | **`PropertyAppraisedValueAmount`** (the final opinion of value), `AppraisalEffectiveDate` |
| `_CONDITION_OF_APPRAISAL` | basis of value (GSE ext.) | **`_Type`** = `AsIs` / `SubjectToRepairs` / `SubjectToCompletion` (confirmed tokens, §6) |
| `PROPERTY` | subject identity | `_StreetAddress`, `_City`, `_County`, `_State`, `_PostalCode` |
| `STRUCTURE` | subject improvements | **`GrossLivingAreaSquareFeetCount`**, **`LivingUnitCount`**, **`TotalBathroomCount`** (full.half), `TotalBedroomCount`, `TotalRoomCount`, `StoriesCount`, `_DesignDescription`, `AttachmentType` (`Detached`/`Attached`), `PropertyStructureBuiltYear`, `BuildingStatusType` |
| `SITE` | lot/zoning | `_AreaDescription`, `_ZoningClassificationIdentifier/Description`, `_ZoningComplianceType` |
| `SALES_COMPARISON` | sales-comparison approach | `ValueIndicatedBySalesComparisonApproachAmount` |
| `COMPARABLE_SALE` | subject (seq 0) + each comp | **`PropertySequenceIdentifier`** (`0`=subject, `1..N`=comps), `PropertySalesAmount`, `AdjustedSalesPriceAmount`, `SalePriceTotalAdjustmentAmount`, net/gross adj %; child `LOCATION`, `COMPARISON_DETAIL`, `SALE_PRICE_ADJUSTMENT` |
| `COMPARISON_DETAIL` | per-property C/Q (GSE ext.) | **`GSEOverallConditionType`** (`C1`–`C6`), **`GSEQualityOfConstructionRatingType`** (`Q1`–`Q6`) |
| `SALE_PRICE_ADJUSTMENT` | grid adjustment lines | `_Type` (`Condition`/`Quality`/…), `_Description` (carries `C3`/`Q4` as a fallback for C/Q) |
| `COST_ANALYSIS` | cost approach | `ValueIndicatedByCostApproachAmount`, `SiteEstimatedValueAmount` |
| `INCOME_ANALYSIS` | income approach | `ValueIndicatedByIncomeApproachAmount`, **`GrossRentMultiplierFactor`** |
| `SALES_CONTRACT` | subject purchase | `_Amount`, `_Date` |
| `_UNIT_GROUP` | per-unit / comp detail | its own `GrossLivingAreaSquareFeetCount` (do NOT confuse with subject STRUCTURE GLA) |
| `UNIT_RENT_SCHEDULE` / `MULTIFAMILY_RENT_SCHEDULE` | 1025 rents | actual/market rent amounts |
| `PROJECT` / `_UNIT` / `_PER_UNIT_FEE` | 1073 condo | project name/type, elevator count, unit id/floor, **`_PER_UNIT_FEE/_Amount`** + `_PeriodType` (HOA) |
| `EMBEDDED_FILE` | the first-gen PDF | `_Type="PDF"` → `<DOCUMENT>` base64 |

There is no published open XPath dictionary we could fetch (the MISMO Logical Data Dictionary and the
UAD Appendix A forms-mapping are the closest, both behind the 403 wall). The table above is verified
directly against our real files.

---

## 6. Ground truth pulled from real sample XMLs

Grepped across the 11 real appraisal XMLs (`docs/appraisal-xml/prototype/` + scratchpad `pp_*.xml`,
`fnm10*_pretty.xml`):

- **`_CONDITION_OF_APPRAISAL/@_Type`** observed values: **`AsIs`, `SubjectToRepairs`, `SubjectToCompletion`** — the parser's three tokens are exactly right (these are GSE-extension enums, camel-case, no spaces — *not* the long MISMO base-model strings like "Subject To Completion Per Plans And Specifications").
- **`PropertySequenceIdentifier`**: `0` appears **once per file** alongside `1,2,3,…`; **seq 0 is the subject property row** in the comparison grid — confirmed. Comps are `1..N`.
- **`GSEOverallConditionType`** = `C3`,`C4`; **`GSEQualityOfConstructionRatingType`** = `Q4` — live UAD codes, on the subject's `COMPARISON_DETAIL`. Fallback `SALE_PRICE_ADJUSTMENT _Type="Condition/Quality" _Description="C3"/"Q4"` also present — the parser's two-path read matches reality.
- **`PropertyAppraisedValueAmount`**: mostly plain ints (`610000`) **but also comma-formatted (`650,000`)** — comma-stripping is required (parser does it).
- **`AppraisalEffectiveDate`**: **mixed** ISO (`2026-05-06`) and US (`02/10/2026`) — both must be handled (parser does).
- **`GrossLivingAreaSquareFeetCount`** lives on **`STRUCTURE`** (subject) and separately on **`_UNIT_GROUP`**; values include commas (`2,408`) and empties (`""`).
- **`TotalBathroomCount`**: `2.1`,`1.1` (UAD) **and** `1`,`1.0`,`1.00`,`2.00`,`3.0` (decimal/int) **and** `""` — mixed serialization is real.
- **`LivingUnitCount`**: `1`,`2`,`3` on STRUCTURE.
- **`GrossRentMultiplierFactor`**: `115.00`,`157`,`302`,`""`.
- **`_PER_UNIT_FEE/_Amount`**: **`0`** in the condo samples — see §8 HOA note.

---

## 7. GSE validation edits we can mirror (UCDP / SSR)

The GSEs run three edit tiers at UCDP: **UAD Compliance** (schema/enumeration conformance), **Basic Edit
Checks** (completeness/format), and **Proprietary Edit Findings** (policy). Useful ones to mirror as our
own tripwires:

- **C6 / Q6 = non-overridable fatal.** Freddie **FRE4645** fires (fatal, cannot be overridden) when the
  property is rated **C6 or Q6** — the collateral fails Guide requirements as-is. → We should **surface
  a hard flag** whenever subject `conditionUad === 'C6'` or `qualityUad === 'Q6'` (we currently store them
  but don't warn).
- **Missing appraiser name = hard stop** (Freddie **FRE4387**). → We already warn on missing party; a
  missing **appraiser** name specifically is worth its own flag.
- **Enumeration conformance:** C/Q must be exactly `C1–C6`/`Q1–Q6`; a non-UAD value is a compliance
  finding. → We already flag `nonuad_cq` — good, mirrors the edit.
- **Value/approach consistency:** the reconciled `PropertyAppraisedValueAmount` should reconcile against
  the approaches present. → We already corroborate sales/cost/income; keep.
- **Subject-is-C6/Q6, and "subject to" basis** interplay: a "subject to repairs/completion" appraisal
  whose *as-is* condition is C5/C6 is exactly the RTL/rehab case — good signal to keep.

---

## 8. Our-parser-vs-spec: confirmation & correction list

Legend: ✅ correct · ⚠️ correct-but-harden · ❗ potential bug/gap.

1. **`VALUATION/@PropertyAppraisedValueAmount`** ✅ — correct element/attribute; it is the single
   reconciled opinion of value. Comma-stripping + reject-non-positive is right. `money()` correctly turns
   the decoy `0`/blank into null.

2. **`_CONDITION_OF_APPRAISAL/@_Type` = `AsIs`/`SubjectToRepairs`/`SubjectToCompletion`** ✅ — tokens
   confirmed verbatim in real files. Mapping `SubjectToRepairs|SubjectToCompletion → ARV` and `AsIs → ASIS`
   is sound. ⚠️ **Gap: `SubjectToInspection` exists in the spec** (appraiser not qualified → subject to a
   professional inspection). It isn't in our sample set, but if it appears it currently falls through to
   the `else` "inferred" branch. Recommend handling it explicitly (treat as *not clean As-Is* → open the
   officer condition, likely ARV-leaning), so a real "subject to inspection" file isn't silently called
   As-Is.

3. **`STRUCTURE/@GrossLivingAreaSquareFeetCount`** ✅ — correct: subject GLA lives on `STRUCTURE`, and
   `find(root,'STRUCTURE')` returns the first (subject) one. ⚠️ Note `_UNIT_GROUP` also carries a GLA
   attribute of the same name; because we anchor to `STRUCTURE` we avoid it — keep it that way (don't ever
   switch GLA to a doc-wide attribute search). `money()` here rejects a legitimately-unusual `0`, which is
   fine (GLA can't be 0).

4. **`STRUCTURE/@LivingUnitCount`** ✅ — correct; observed `1/2/3`. Form-implied fallback to `1` for
   1004/1073 is reasonable. ⚠️ minor: `toNum` (not `money`) is right here since it's a count.

5. **`STRUCTURE/@TotalBathroomCount` (full.half)** ⚠️ **Correct to keep as a raw string, but the format is
   genuinely mixed in real files** (`2.1` UAD full.half **and** `1.00`/`2.00`/`3.0` decimal). Risk: any
   downstream consumer that does numeric math on the string will read `2.1` as *two-point-one* when it
   means **2 full + 1 half (= 2.5)**. Hardening: parse into `{fullBaths, halfBaths}` when it matches
   `^\d+\.\d$` (UAD), and treat `^\d+(\.0+)$` as `{full: N, half: 0}`; keep the raw string too. Add a
   sanity flag if the half-digit is `>4`. This prevents a silent 2.1-vs-2.5 error the moment anyone sums
   baths.

6. **`COMPARABLE_SALE/@PropertySequenceIdentifier` — is seq 0 the subject?** ✅ **Confirmed true.** Seq `0`
   appears once per file as the subject row; comps are `1..N`. Excluding seq 0 and de-duping seq≥1 is
   correct. ⚠️ Belt-and-suspenders: also skip any `COMPARABLE_SALE` that has no `PropertySalesAmount` and
   no `LOCATION` (a rare empty/placeholder column) so a blank grid slot never counts as a comp.

7. **`COMPARISON_DETAIL/@GSEOverallConditionType` / `@GSEQualityOfConstructionRatingType`** ✅ — correct
   path and attribute names; values are the `C#`/`Q#` codes. The `SALE_PRICE_ADJUSTMENT _Type/_Description`
   fallback is real and correctly used. ❗ **Missing edit: no C6/Q6 hard flag.** Per UCDP **FRE4645** a
   C6 or Q6 is a non-overridable fatal — we store the code but don't warn. **Add a warning** (e.g.
   `severe_cq`) when `conditionUad==='C6' || qualityUad==='Q6'`; for an RTL/rehab lender this is a
   first-class signal, not just metadata.

8. **`_PER_UNIT_FEE/_Amount` (HOA)** ⚠️ **Correct element, but `money()` collapses a real `$0` HOA into
   `null`.** All condo samples carry `_Amount="0"`. `money()` (which requires `> 0`) can't distinguish
   "no HOA fee / $0" from "fee missing". For an HOA that's a meaningful difference (a genuinely $0 or
   fee-included condo vs an unreported fee). Recommend reading HOA with `toNum` (accept `0`) and pairing it
   with `_PeriodType`, so a $0 fee is reported as `0`, not dropped. Low severity, but it's a real
   information-loss on every condo file in the sample set.

9. **`INCOME_ANALYSIS/@GrossRentMultiplierFactor`** ✅ — correct attribute; `toNum` (accepts decimals like
   `115.00`, and non-positive is impossible in practice) is right. ⚠️ Optional sanity flag: residential
   **monthly** GRM typically ~50–250; a value like `302` may be an annual GRM or an outlier — a soft
   range check (not a hard reject) would catch data-entry oddities without discarding valid values.

### Additional hardening not in the cross-check list
- **View/Location ratings** are standardized (`N/B/A` + type abbreviations) and present in the XML; we
  don't parse them. If the property report ever needs "adverse view/location," that's an available signal.
- **`SubjectToInspection`** (see #2) and **1004D** completion status aren't modeled — fine for now, but
  note them if we start ingesting update/completion reports.
- **UAD 3.6 / MISMO 3.6**: none of the above paths survive the redesign. Add a version guard on
  `AppraisalFormType` / root schema so a UAD 3.6 file fails loudly (a tripwire) instead of silently
  extracting nulls.

---

## 9. Bottom line

The parser's core assumptions are **verified against both the official standards and real files**:
seq-0-is-subject ✅, the three `_CONDITION_OF_APPRAISAL` tokens ✅, `PropertyAppraisedValueAmount` as the
reconciled value ✅, `GSEOverall*`/`GSEQuality*` = `C#`/`Q#` ✅, baths as full.half string ✅ (keep as
string). The **three worth acting on**: (a) add a **C6/Q6 hard flag** (mirrors UCDP fatal FRE4645);
(b) stop dropping a **$0 HOA** (`_PER_UNIT_FEE` with `toNum`, not `money`); (c) **parse the bath
full.half** into `{full, half}` so nobody ever misreads `2.1` as `2.5`. Plus a **`SubjectToInspection`**
branch and a **UAD-version guard** for the coming 3.6 migration.
