# Appraisal XML Industry Research Brief

**Purpose:** Inform a system that parses Fannie Mae appraisal XML (MISMO 2.6 `VALUATION_RESPONSE`)
for a private / residential-transition-loan (RTL) lender's loan-origination portal
(fix-and-flip / bridge / DSCR).

**Author context:** Research compiled 2026-07-19. Sources are cited inline with URLs and
consolidated at the end. This is a research brief, not legal or underwriting advice; verify
specific field paths against the actual XML your appraisal vendors deliver and against the
current GSE UAD specification before coding against them.

> **The single most important takeaway for this lender:** an appraisal reports a value
> **as of an effective date under a stated condition of appraisal**. That condition is one of
> "as is," "subject to completion per plans & specifications," "subject to repairs/alterations,"
> or "subject to inspection." **"As-Is value" and "After-Repair Value (ARV)" are two different
> numbers that can both appear in the same report, and the system must never conflate them.**
> ARV is almost always a *hypothetical-condition / subject-to* value; As-Is is the current-condition
> value. Sizing a loan against the wrong one is a direct loss event. See Section 2.

---

## 1. MISMO 2.6 VALUATION_RESPONSE / GSE UAD format

### 1.1 What the format is
Fannie Mae and Freddie Mac (the GSEs) jointly defined the **Uniform Appraisal Dataset (UAD)** under
the **Uniform Mortgage Data Program (UMDP)**. The electronic appraisal file is an XML document built
on the **MISMO (Mortgage Industry Standards Maintenance Organization) Property Valuation Response
Version 2.6 Schema, Errata 1**, extended with proprietary GSE "extensions" (custom data points that
either repurpose an existing element or add a new one).

- The root business object is the MISMO 2.6 **`VALUATION_RESPONSE`** container.
- For appraisals dated **on or after December 1, 2011**, lenders must deliver UAD-compliant electronic
  appraisal data through the **Uniform Collateral Data Portal (UCDP)** before loan delivery.
- The authoritative document is the **UAD Specification** (Freddie Mac hosts the canonical PDF), whose
  appendices carry the technical detail:
  - **Appendix A / D – GSE Appraisal Forms Mapping / Field-Specific Standardization Requirements:**
    every data point, its XML path, and its conditionality (**R = Required**, **CR = Conditionally
    Required** when a business condition exists).
  - **Appendix F – Property Information Valuation Response v2.6 GSE Extension Schema, Errata 1:** the
    actual XSD (best read in an XML editor).
- Sources:
  - UAD Specification (Freddie Mac): https://sf.freddiemac.com/docs/pdf/requirements/uad_specification.pdf
  - UAD overview (Fannie Mae): https://singlefamily.fanniemae.com/delivering/uniform-mortgage-data-program/uniform-appraisal-dataset
  - MISMO dataset specifications: https://www.mismo.org/standards-resources/residential-specifications/datasets
  - Fannie Mae MISMO Data XML job aid: https://singlefamily.fanniemae.com/job-aid/loan-delivery/topic/mismo_data_xml.htm

### 1.2 MISMO 2.x is architecturally different from MISMO 3.x — important for parsing
MISMO **2.x (including 2.6)** is a **DTD-derived, attribute-heavy** design: most data values live in
**XML attributes** on elements (e.g. `<PROPERTY _AttributeName="value"/>`), not in element text.
MISMO **3.x** (the reference model, current 3.4/3.6) is a hierarchical, element-based container model.
Because our target is the legacy **2.6** valuation schema, the parser must be written to read
**attributes**, not just child-element text nodes. (The MISMO XML Primer explicitly frames 2.x as the
"XML DTD implementation" era.)
- MISMO reference model / XML schema: https://www.mismo.org/standards-resources/residential-specifications/reference-model/xml-schema
- MISMO XML extensions primer: https://gridml.com/mismo-xml-extensions/

### 1.3 The forms: FNM1004 (URAR) vs FNM1025 (Small Residential Income)
The UAD covers a small set of appraisal report forms. The two relevant here:

| | **Form 1004 – Uniform Residential Appraisal Report (URAR)** | **Form 1025 – Small Residential Income Property Appraisal Report** |
|---|---|---|
| Property type | **1-unit** (detached SFR, some PUDs, townhomes) | **2–4 unit** (duplex / triplex / fourplex) income property |
| Primary approach | Sales Comparison; Cost as support | Sales Comparison **plus** a real **Income Approach (GRM)** |
| Income data | Optional (opinion of market rent only if income used) | **Rent schedule per unit** — actual rents, market rents, vacancy, operating data |
| Typical use | Owner-occ & 1-unit investor SFR | 2–4 unit rental / small multifamily |

Related forms you may also encounter in a file: **1073** (individual condo unit), **1075/2055**
(exterior-only "drive-by"), **2090/2095** (co-op), **1004C** (manufactured home), **1007** (single-unit
comparable rent schedule, often paired with a 1004 for a rental), **216** (operating income statement),
and **1004D** (appraisal update / **completion report** — see Section 2). UAD 3.6 (rolling out with a
redesigned single dynamic "URAR" replacing several legacy forms) is the future state; today's Fannie
Mae appraisal XML this lender receives is overwhelmingly **UAD 2.6 / MISMO 2.6**.

- Form types reference: https://mountainseed.my.site.com/knowledgebase/s/article/Appraisal-Form-Types
- 1004 guide: https://www.kolena.com/blog/fnma-form-1004-the-complete-guide-to-the-urar-appraisal/
- 1025 overview: https://www.appraisalcolorado.com/appraisal-services/residential-real-estate-appraisal/small-residential-income-property-appraisal-report/
- a la mode "which form": https://help.alamode.com/docs/4990

### 1.4 UAD standardized coding (condition, quality, abbreviations)
UAD forces standardized enumerations into a subset of key fields so data is machine-comparable:

- **Condition rating C1–C6** — physical state / maintenance. **C1 = new / like-new**, **C6 = substantial
  damage, deferred maintenance, or safety/soundness issues**. Ratings are **absolute**, not relative to
  the neighborhood.
- **Quality of construction Q1–Q6** — materials, craftsmanship, design. **Q1 = highest (architect-designed,
  premium)**, **Q6 = lowest / basic or substandard**. Quality ratings were developed proprietarily by the
  GSEs and are also absolute.
- **Standardized abbreviations** pack multi-attribute info into single fields, using a
  **Beneficial / Neutral / Adverse (B / N / A)** prefix. Example: **`A;BsyRd;Res`** = *Adverse; Busy Road;
  Residential*. View and Location fields use this pattern; e.g. `N;Res` = Neutral, Residential.
- Other standardized/abbreviated fields: **GLA** (gross living area, sq ft), condition-of-sale codes,
  financing-concession codes, and date formats. GLA and room counts follow strict UAD formatting.
- In **UAD 3.6** interior and exterior each get their own C/Q rating that reconcile to an overall — not
  relevant to 2.6 parsing but note for forward compatibility.

Sources:
- Condition/quality (C1–C6, Q1–Q6): https://www.mckissock.com/blog/appraisal/understanding-appraisal-condition-ratings-c1-to-c6/
- Quality ratings: https://www.mckissock.com/blog/appraisal/understanding-uad-quality-ratings/
- UAD abbreviations glossary: https://support.bradfordsoftware.com/docs/UAD_Glossary.pdf
- UAD quick reference: https://gmaronline.com/sites/default/files/resources/GMAR-UAD-Quick-Reference-Guide.pdf
- UAD FAQ (Fannie Mae): https://singlefamily.fanniemae.com/media/6921/display

---

## 2. As-Is value vs ARV / "subject-to-completion" — the critical distinction

### 2.1 The three (really four) conditions of appraisal
The URAR (and 1025) reconciliation section contains a **statement of the condition under which the
opinion of value is rendered**. The appraiser checks exactly one:

1. **"as is"** — value reflects the property **in its current, present condition**. No repairs,
   alterations, or inspections are assumed. → This is the **As-Is Value**.
2. **"subject to completion per plans and specifications"** — a **hypothetical condition** that
   proposed or under-construction improvements will be **completed** per submitted plans/specs.
   Used for new construction and, in RTL, for gut rehabs / additions. → This value is effectively an
   **ARV** (value assuming the planned work is done).
3. **"subject to the following repairs or alterations"** — value assumes **listed repairs/alterations
   are completed** (property is livable/marketable once fixed). → Also an **ARV / as-repaired value**.
4. **"subject to the following required inspection"** — value assumes a specified inspection (e.g.
   pest, septic, roof, well) confirms no adverse condition.

"As is" specifically means there are **no repair, alteration, or inspection conditions** to be
addressed. Any "subject to" selection means the reported value is **contingent** — it is **not** the
current market value.

Sources:
- Conditions of appraisal (who decides as-is vs subject-to): https://appraisersforum.com/forums/threads/who-decides-if-appraisal-is-as-is-or-subject-to-completion-repairs.153961/
- 1004D / completion report use: https://societymortgage.com/mortgage-tips/what-is-a-1004d/
- URAR explained: https://realvals.com/1004-appraisal-form/

### 2.2 How As-Is and ARV appear together (RTL-specific)
For fix-and-flip / rehab lending, appraisers are frequently asked (via the engagement / scope of work)
to report **two values in one report**:

- an **"as-is" market value** as of the inspection date, **and**
- a **"subject-to-completion" (ARV) market value** as of a prospective date, assuming a specific
  scope of work (the borrower's rehab budget / plans & specs).

These are distinct opinions of value with (often) **different effective dates** (the ARV carries a
**prospective / future effective date**). The report may deliver them as separate reconciliation
statements, an addendum, or (commonly) a separate ARV appraisal or a "subject-to" URAR with an
attached scope/plans. **The completion of the "subject-to" work is later evidenced by a Form 1004D
Certificate of Completion.**

### 2.3 How this is encoded in the URAR form and MISMO XML
- **On the form:** the reconciliation block near the bottom of page 2 of the URAR carries the
  checkboxes ("This appraisal is made ☐ 'as is', ☐ subject to completion per plans and specifications…,
  ☐ subject to the following repairs or alterations…, ☐ subject to the following required inspection…"),
  followed by the **"Indicated Value by: Sales Comparison Approach $___ Cost Approach $___ Income
  Approach $___"** lines and the final **"My opinion of the market value … as of [effective date]
  is $___."**
- **In MISMO 2.6 XML:** the reconciliation "as is / subject to" selection maps to a
  **condition-of-appraisal / appraised-value-type enumeration** plus the **appraised value amount and
  its effective date**. Practically, the parser must locate:
  - the **appraised value amount** element/attribute,
  - the associated **appraisal effective date**, and
  - the **condition indicator** distinguishing "as is" from each "subject to" variant.

  Because 2.6 is attribute-heavy and GSE-extended, **do not assume a single canonical path** — the
  exact element/attribute names must be confirmed against Appendix A/D of the UAD Specification and
  against sample files from each appraisal vendor. Treat "which value is As-Is vs ARV" as a
  **first-class parsed field with an explicit `valueType` (as_is | subject_to_completion |
  subject_to_repairs | subject_to_inspection)** and a **required effective date**, and surface it
  prominently in the UI so an underwriter can never mistake one for the other.

- Reconciliation "as is / subject to" box in XML context: https://singlefamily.fanniemae.com/job-aid/loan-delivery/topic/mismo_data_xml.htm
- UAD Specification (field mapping): https://sf.freddiemac.com/docs/pdf/requirements/uad_specification.pdf

**Design rule:** In the data model, store `asIsValue`, `arvValue`, each with `effectiveDate` and
`conditionOfAppraisal`. Never store a single ambiguous "appraised value." If only one value is present,
capture which condition it was rendered under. A "subject-to" value with no corresponding as-is value
is a flag for underwriting review.

---

## 3. The three approaches to value

| Approach | What it produces | 1004 (URAR) | 1025 (2–4 unit income) |
|---|---|---|---|
| **Sales Comparison (Market)** | Value from recent sales of comparable properties, adjusted for differences | **Primary** driver of value | Present and important |
| **Cost Approach** | Land value + replacement/reproduction cost of improvements − depreciation | Optional / supporting; required for new construction & manufactured | Supporting |
| **Income Approach (GRM)** | Value from income-producing capacity. Residential small-income uses **Gross Rent Multiplier**: `Value = Gross Monthly Rent × GRM` (GRM derived from comparable rental sales) | Rarely used (only if it's a rental; may pair with Form 1007) | **Core** — the 1025 develops a real GRM-based income approach with a per-unit rent schedule |

- The URAR "Indicated Value by [each approach]" lines feed the appraiser's **reconciliation** to a
  single final opinion of value. The three numbers should be internally consistent; large divergence is
  a review flag.
- GRM is a **gross** multiplier (rent before expenses), distinct from cap-rate/NOI valuation used on
  larger commercial (5+ unit) properties.

Sources:
- Three approaches overview: https://neureto.com/study-guide/real-estate/valuation/appraisal-approaches-cost-income-sales-comparison
- GRM: https://www.crefcoa.com/gross-rent-multiplier.html , https://smartland.com/resources/how-to-calculate-gross-rent-multiplier/

---

## 4. RTL / fix-and-flip underwriting: sizing the loan & CTC appraisal checks

### 4.1 Core ratios and definitions
Private/RTL lenders size a rehab loan against **three or four ratios simultaneously and take the most
conservative (lowest) resulting loan amount**:

- **Purchase Price (PP)** — contract price paid for the property.
- **As-Is Value** — current-condition appraised value (Section 2).
- **ARV (After-Repair Value)** — "subject-to-completion" appraised value.
- **Rehab / Construction Budget** — scope-of-work cost to complete the project.
- **Total Cost / Total Project Cost** = **Purchase Price + Rehab Budget** (+ sometimes closing costs).

| Ratio | Formula | What it caps | Typical max |
|---|---|---|---|
| **LTV (Loan-to-Value)** | Loan ÷ (lower of PP or As-Is Value) | Leverage vs current value | ~70–75% of as-is (often "**lower of PP or as-is**") |
| **LTPP / LtPP (Loan-to-Purchase-Price)** | Initial advance ÷ PP | Down payment on the buy | ~80–90% of PP (10–20% down) |
| **LTC (Loan-to-Cost)** | Total loan ÷ (PP + Rehab) | Total leverage vs total project cost | **~85–90% LTC** (up to 90–95% for experienced) |
| **LTARV / ARV-LTV (Loan-to-After-Repair-Value)** | Total loan (incl. rehab) ÷ ARV | Exit leverage / equity cushion | **~65–75% of ARV** (commonly 70%) |
| **Rehab financing** | Rehab advanced (usually via **draws**) | | Often **up to 100% of rehab budget** |

**How they combine (typical structure):**
- The **purchase advance** is limited by LTPP / LTC (e.g. 90% of PP → borrower puts 10% down).
- The **rehab portion** is funded via **reimbursement draws** as work completes (up to 100% of budget).
- **Everything is then capped by LTARV** (e.g. total loan ≤ 70% × ARV) so a cushion remains for the exit.
- Final max loan = **min(** LTPP/LTC-based amount, LTARV-based amount, program hard cap **)**.

**Worked example (illustrative):** PP $200k, Rehab $50k (Total Cost $250k), As-Is $200k, ARV $325k.
- 90% LTC → $225k; 90% LTPP → $180k purchase advance + $50k rehab = $230k; 70% LTARV → **$227.5k**.
- Loan ≈ **min($225k, $230k, $227.5k) = $225k**, of which ~$175k at closing + $50k held for rehab draws.
- ARV is "the most important number in fix-and-flip underwriting and the number most abused" — treat a
  high ARV / thin comp support as a top risk.

Sources:
- LTV/LTC/LTARV: https://ahlend.com/docs/how-do-ltv-ltc-and-ltarv-affect-fix-and-flip-loan-amounts/
- LTC vs LTV vs LtPP: https://backflip.com/explaining-ltc-ltv-ltpp-loan-to-cost-in-hard-money/
- LTV & ARV (broker view): https://rcncapital.com/blog/understanding-ltv-and-arv-key-metrics-for-brokers-in-private-lending
- Loan metrics (LTC/LTV/LTPP/LTARV): https://blacklabelcapital.com/understanding-loan-metrics-in-hard-money-lending-ltc-ltv-ltpp-and-ltarv/
- Fix-and-flip guide: https://www.baselinesoftware.com/resources/articles/fix_and_flip_loans_complete_guide

### 4.2 "Appraisal matches the file" — CTC appraisal review checks
Before **clear-to-close (CTC)**, an underwriter confirms the appraisal is valid, sufficient, and
consistent with the rest of the loan file. Standard conventional review items (from GSE/MI appraisal
review checklists) plus RTL-specific ones:

- **Value adequacy:** appraised value (correct one!) **≥ purchase price**; if not, deal is repriced or
  killed. For RTL, **ARV supports the loan at max LTARV**, and **As-Is supports the purchase-side LTV/LTC**.
- **Correct value used:** As-Is used for as-is/LTV/LTC tests; ARV used only for the LTARV test — never
  swapped.
- **Subject property identity:** address / legal / APN match the contract, title, and application.
- **Comparables:** at least **3 closed comps**; sales within **~12 months** (recency), and within
  **reasonable distance** (commonly ≤ **1 mile** urban/suburban, wider rural with commentary); adjustments
  within guideline tolerances (net/gross adjustment limits).
- **Effective date recency:** appraisal signed/dated; **older than ~4 months requires an update (1004D)**;
  many RTL programs want an effective date within 60–120 days of close.
- **Condition/quality:** UAD **C-rating** consistent with loan program (e.g. C5/C6 usually requires the
  "subject-to-repairs" path); quality rating plausible for the value.
- **Appraiser eligibility:** appraiser (and AMC) **licensed/certified in the state**, license not expired,
  and **not on the lender's exclusionary / watch list** (nor GSE/HUD exclusion lists).
- **Independence / AIR:** appraisal ordered in compliance with Appraiser Independence Requirements
  (no coercion; borrower didn't select appraiser).
- **Completeness:** required **subject photos** (front/rear/street, kitchen, baths, and for "subject-to"
  the areas to be repaired), comp photos, location map, sketch/floor plan, and the signed cert page all present.
- **Internal consistency:** the three approaches reconcile sensibly; the "as is / subject to" checkbox
  matches the value(s) used; GLA/room count consistent across sections.
- **Data integrity vs UCDP/SSR & Collateral Underwriter:** delivered appraisal must match the SSR;
  Fannie **Collateral Underwriter (CU)** returns a **risk score 1.0–5.0** (5.0 = highest risk) with
  overvaluation flags — high CU scores warrant escalation. (RTL loans held on balance sheet may not run
  CU, but the same overvaluation logic applies.)
- **Rehab/scope match (RTL):** the appraiser's "subject-to" scope / plans & specs are **consistent with
  the borrower's rehab budget and SOW**; ARV is predicated on that same scope.

Sources:
- Appraisal review checklist (Enact MI): https://content.enactmi.com/2021-10/7788951.Appraisal.Review.Checklist.1021.pdf
- Arch MI URAR checklist: https://mortgage.archgroup.com/wp-content/uploads/sites/4/MCUS-B0411I-Appraisal-Review-Checklist-NR.pdf
- Truist appraisal standard: https://www.truistsellerguide.com/manual/cor/general/1.07Appraisals.pdf
- Collateral Underwriter: https://singlefamily.fanniemae.com/applications-technology/collateral-underwriter
- What happens after the appraisal: https://www.pennymac.com/blog/what-happens-after-appraisal

---

## 5. DSCR / 2–4 unit rental underwriting

DSCR (no-income-doc investor) loans qualify the **property's cash flow**, not the borrower's income:

- **Formula:** `DSCR = Gross Monthly Rent ÷ Monthly PITIA`
  - **PITIA** = **P**rincipal + **I**nterest + **T**axes + **I**nsurance + **A**ssociation (HOA) dues.
    Use full PITIA to avoid overstating DSCR. Some programs use interest-only payment for the "P&I" leg.
- **Rent source from the appraisal:**
  - **1-unit rental:** market rent from **Form 1007** (Single-Family Comparable Rent Schedule).
  - **2–4 unit:** **Form 1025** rent schedule — combine occupied units' rent; **vacant units use the
    appraiser's market rent**. Underwriting typically uses the **lower of actual lease rent or
    appraiser's market rent**.
- **Thresholds:** most lenders baseline at **DSCR ≥ 1.0–1.25**; **1.20–1.25** is a common comfortable
  floor; some programs go below 1.0 (e.g. 0.75) at higher rates / lower LTV. DSCR bands drive pricing.
- **Not standardized:** PITIA composition, vacancy treatment, IO vs amortizing, and rent-source rules
  vary by lender — the same property can yield different DSCRs.

For our parser: from a **1025** we need the **per-unit actual and market rents, vacancy, and the total
gross monthly rent**, plus the **GRM/income-approach value**, to feed a DSCR calc downstream.

Sources:
- DSCR calculation & PITIA: https://dscrauthority.com/learn/how-dscr-is-calculated/
- DSCR appraisal (1007/1025): https://www.lendmire.com/the-dscr-appraisal-1007-rent-schedules-comps-and-what-gets-ordered/
- DSCR examples/bands: https://www.fundedcapital.com/blog/how-to-calculate-dscr , https://www.lendmire.com/how-lenders-read-your-dscr-approval-bands-from-100-up/

---

## 6. Existing tooling & parsing pitfalls

### 6.1 Tooling landscape
- **No dominant open-source Fannie Mae appraisal-XML parser** exists as a turnkey library; parsing is
  typically **bespoke** against the MISMO 2.6 XSD + GSE extension schema (UAD Spec Appendix F).
- **LOS ingestion (e.g. ICE/Ellie Mae Encompass):** LOS platforms ingest the **UCDP appraisal XML/SSR**
  and map UAD fields into loan-file fields; integration is via the UCDP and vendor APIs rather than a
  public parser. Fannie Mae also exposes an **Appraisal File Retrieval API** for the full appraisal.
- **MISMO tooling:** commercial MISMO integration engines (e.g. PilotFish eiConsole for MISMO, Grid-ML
  schema tooling) exist for transformation/validation but are general MISMO, not RTL-specific.
- Appraisal File Retrieval API: https://singlefamily.fanniemae.com/media/23146/display
- UCDP FAQ: https://singlefamily.fanniemae.com/learning-center/applications/uniform-collateral-data-portal-learning-center/faqs-uniform-collateral-data-portal

### 6.2 Pitfalls / gotchas parsing MISMO 2.6 UAD files
1. **Attribute-heavy 2.6 schema:** values live in **XML attributes**, not element text. A naive
   element-text parser will silently miss most data. Bind to the XSD.
2. **GSE extensions:** proprietary extension elements/attributes and repurposed standard fields — you
   must handle the **GSE extension namespace**, not just base MISMO.
3. **As-Is vs ARV ambiguity:** the same schema can carry multiple values under different "conditions of
   appraisal." Parse the **condition/value-type + effective date** explicitly (Section 2) — the highest-risk
   parsing bug for this lender.
4. **Embedded base64 PDF & photos:** the UAD 2.6 package embeds the **human-readable report as a
   base64-encoded PDF** (and photos) inside the XML. These blobs are large; stream/lazy-load them, store
   the PDF separately, and never let a base64 blob break the XML text pipeline. (Note: **UAD 3.6 changes
   this** — the delivery becomes a **ZIP** of XML + PDF + a **separate images folder**, so photos are no
   longer only embedded.)
5. **SSR vs appraisal mismatch:** the **UCDP Submission Summary Report (SSR)** (with the **CU score**)
   is a separate artifact; GSEs require the delivered appraisal to **match** the SSR. If you ingest both,
   reconcile them.
6. **Enumeration/schema validation:** invalid enums or non-numeric data in numeric fields fail schema
   validation; UAD standardized fields (C/Q, dates, abbreviations) have strict formats — validate, and
   fail loud.
7. **Form-type branching:** 1004 vs 1025 vs 1073 etc. have different required sections (e.g. rent
   schedule only on 1025/1007). Detect form type first, then apply form-specific field maps.
8. **Version drift:** UAD **2.6 today, 3.6 transitioning** — isolate the schema/version behind an adapter
   so a 3.6 ZIP/JSON path can be added without rewriting consumers.
- MISMO XML primer (2.x DTD vs 3.x): https://www.mismo.org/docs/mismolibraries/uploadedfiles/documents/mismo/documents/mismo-xml-primercourse-overview-for-education-page.pdf
- UAD 3.6 packaging changes: https://www.clearcapital.com/what-is-uad-3-6-how-the-new-appraisal-standard-will-impact-lenders/

---

## 7. Recommended "appraisal-vs-file match" underwriting rules to automate

Rules the portal should run automatically once an appraisal XML is parsed. Group A = hard stops /
must-flag; Group B = review flags.

**A. Value & condition (highest priority)**
1. Parse and label **every value** with `{amount, effectiveDate, conditionOfAppraisal}`; require at
   least one, and require an **effective date** on each. Fail if a value has no identifiable condition.
2. **As-Is Value ≥ Purchase Price** (else flag "value shortfall" → reprice/deny).
3. **ARV present and rendered under a "subject-to" condition** whenever the deal relies on ARV; block
   using an "as is" value as ARV or vice-versa.
4. **LTARV check:** `Total Loan ÷ ARV ≤ program max` (e.g. 70%).
5. **LTC / LTPP check:** `Loan ÷ (PP + Rehab) ≤ max` and `Purchase advance ÷ PP ≤ max`.
6. **As-Is LTV check:** `Loan (or purchase advance) ÷ lower(PP, As-Is) ≤ max`.
7. **Final loan = min()** of all applicable ratio caps; show which ratio is binding.
8. **Rehab/scope consistency:** appraiser "subject-to" scope/plans ≈ borrower rehab budget/SOW
   (flag material divergence).

**B. File-match & quality (review flags)**
9. **Subject address / APN / legal** match contract, title, application.
10. **Effective date recency** within program window; **> 4 months → require 1004D update**.
11. **Comps:** ≥ 3 closed sales; each within **~12 months** and **~1 mile** (config by market); flag
    out-of-range with required commentary.
12. **Adjustment tolerances:** net/gross adjustment % within limits; flag over-adjusted comps.
13. **Condition/Quality:** C5/C6 → require "subject-to-repairs" path & a rehab plan; implausible Q vs value.
14. **Appraiser license valid** in subject state, not expired; **appraiser & AMC not on exclusionary list**.
15. **Photos/exhibits complete:** subject front/rear/street, interior, comp photos, map, sketch, signed cert.
16. **Form type correct** for property (2–4 unit → 1025 with rent schedule; DSCR → rent data present).
17. **Internal consistency:** three approaches reconcile; GLA/room count consistent; reconciliation
    checkbox matches the value(s) used.
18. **SSR / CU:** if available, appraisal matches SSR; **CU score ≥ 2.5–3.0 → escalate** for overvaluation.
19. **DSCR (rental):** compute `DSCR = min(actual, market monthly rent) ÷ PITIA`; flag below program floor.
20. **Data-integrity gate:** XML passes schema validation; required UAD fields present; base64 PDF/photos
    extracted and stored.

---

## 8. Consolidated sources
- UAD Specification (Freddie Mac): https://sf.freddiemac.com/docs/pdf/requirements/uad_specification.pdf
- UAD overview (Fannie Mae): https://singlefamily.fanniemae.com/delivering/uniform-mortgage-data-program/uniform-appraisal-dataset
- UAD 2.6 FAQ (Freddie Mac): https://sf.freddiemac.com/faqs/uad-faq
- UAD 3.6 FAQ / forms redesign: https://sf.freddiemac.com/faqs/uad-and-forms-redesign
- MISMO datasets: https://www.mismo.org/standards-resources/residential-specifications/datasets
- MISMO reference model / XML: https://www.mismo.org/standards-resources/residential-specifications/reference-model
- Fannie MISMO Data XML job aid: https://singlefamily.fanniemae.com/job-aid/loan-delivery/topic/mismo_data_xml.htm
- Collateral Underwriter: https://singlefamily.fanniemae.com/applications-technology/collateral-underwriter
- UCDP FAQ (Fannie): https://singlefamily.fanniemae.com/learning-center/applications/uniform-collateral-data-portal-learning-center/faqs-uniform-collateral-data-portal
- Appraisal File Retrieval API: https://singlefamily.fanniemae.com/media/23146/display
- Condition ratings C1–C6: https://www.mckissock.com/blog/appraisal/understanding-appraisal-condition-ratings-c1-to-c6/
- Quality ratings Q1–Q6: https://www.mckissock.com/blog/appraisal/understanding-uad-quality-ratings/
- UAD abbreviations glossary: https://support.bradfordsoftware.com/docs/UAD_Glossary.pdf
- Form 1004 guide: https://www.kolena.com/blog/fnma-form-1004-the-complete-guide-to-the-urar-appraisal/
- Form 1025 overview: https://www.appraisalcolorado.com/appraisal-services/residential-real-estate-appraisal/small-residential-income-property-appraisal-report/
- Appraisal form types: https://mountainseed.my.site.com/knowledgebase/s/article/Appraisal-Form-Types
- As-is vs subject-to (forum): https://appraisersforum.com/forums/threads/who-decides-if-appraisal-is-as-is-or-subject-to-completion-repairs.153961/
- 1004D completion report: https://societymortgage.com/mortgage-tips/what-is-a-1004d/
- Three approaches to value: https://neureto.com/study-guide/real-estate/valuation/appraisal-approaches-cost-income-sales-comparison
- GRM: https://www.crefcoa.com/gross-rent-multiplier.html
- LTV/LTC/LTARV: https://ahlend.com/docs/how-do-ltv-ltc-and-ltarv-affect-fix-and-flip-loan-amounts/
- LTC/LTV/LtPP: https://backflip.com/explaining-ltc-ltv-ltpp-loan-to-cost-in-hard-money/
- LTV & ARV: https://rcncapital.com/blog/understanding-ltv-and-arv-key-metrics-for-brokers-in-private-lending
- Loan metrics (hard money): https://blacklabelcapital.com/understanding-loan-metrics-in-hard-money-lending-ltc-ltv-ltpp-and-ltarv/
- Fix-and-flip guide: https://www.baselinesoftware.com/resources/articles/fix_and_flip_loans_complete_guide
- Appraisal review checklist (Enact MI): https://content.enactmi.com/2021-10/7788951.Appraisal.Review.Checklist.1021.pdf
- Arch MI URAR checklist: https://mortgage.archgroup.com/wp-content/uploads/sites/4/MCUS-B0411I-Appraisal-Review-Checklist-NR.pdf
- Truist appraisal standard: https://www.truistsellerguide.com/manual/cor/general/1.07Appraisals.pdf
- DSCR calculation: https://dscrauthority.com/learn/how-dscr-is-calculated/
- DSCR appraisal (1007/1025): https://www.lendmire.com/the-dscr-appraisal-1007-rent-schedules-comps-and-what-gets-ordered/
- UAD 3.6 packaging: https://www.clearcapital.com/what-is-uad-3-6-how-the-new-appraisal-standard-will-impact-lenders/
- MISMO XML primer (2.x vs 3.x): https://www.mismo.org/docs/mismolibraries/uploadedfiles/documents/mismo/documents/mismo-xml-primercourse-overview-for-education-page.pdf
