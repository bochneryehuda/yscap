# Blue Lake Capital — "Required Documents List" → PILOT doc-intelligence mapping (Agent D)

Source: `Blue Lake RTL Required Loan Documents List` (1 page, © 2026 Blue Lake Capital, LLC).
Two sections — **Pre-close Review** (focus) and **Post-close Review** (deferred, separate list below).
Each row has a **Document** column and a **Naming Convention** column; footnotes **1–4** gate the
Construction / Heavy-Rehab conditional documents.

Repo evidence checked (read-only):
- Doc-type tokens: `src/lib/underwriting/classify.js` (`SIGNALS` + `FILENAME_HINTS`).
- Checklist templates: `db/005_rtl_workflow.sql`, `db/051`, `db/056`, `db/059`, `db/076`, `db/141`,
  `db/159`, `db/177`, `db/215`, `db/229`, `db/281`, `db/031`, `db/034`, `db/065`.

> **Convention note on the source:** "OFAC Entity" appears **TWICE** in the pre-close list (rows 4 and 13),
> with the identical naming convention `EntityOFAC_Entity Name_LoanID`. Treated as ONE requirement
> (de-duplicated) — 27 printed rows, **26 distinct pre-close documents**.

---

## PRE-CLOSE mapping table

| # | blue_lake_doc | naming_convention | conditional | pilot_doc_type | pilot_template_code | maps_to_condition (domain) | trigger (field-registry) | notes |
|---|---|---|---|---|---|---|---|---|
| 1 | Loan Application/Term Sheet | `Loan Application_LoanID` | always | `signed_application` (+ `signed_term_sheet`) | `rtl_cond_signed_app` (+ `rtl_cond_signedts`) | program_eligibility / closing_docs | `{}` always | Blue Lake bundles app + term sheet on ONE line; PILOT splits into two conditions (signed app + signed term sheet, both phase 1). Naming uses only `Loan Application_LoanID`. |
| 2 | Credit Report | `Credit Report_Name_LoanID` | always | `credit_report` | `rtl_cond_credit` | credit | `{}` always | Exact match. `rtl_cond_credit` = internal doc condition (db/076). |
| 3 | Background Report | `Background_Name_LoanID` | always | `background_report` | `rtl_cond_fraud` (slot `background`) | background_ofac | `{}` always | `rtl_cond_fraud` slots `background` (required) + `criminal` (optional, required on Gold). Individual background report. |
| 4 | OFAC Entity | `EntityOFAC_Entity Name_LoanID` | when entity (has_llc) | `background_report` (partial — no entity distinction) | **GAP: none** | background_ofac | `has_llc is_true` | **GAP.** `background_report` folds OFAC+background and does NOT distinguish an ENTITY OFAC screen; no template slot collects entity-level OFAC. `rtl_cond_fraud` is individual-only. |
| 5 | OFAC Member | `OFAC_Name_LoanID` | always | `background_report` (partial) | `rtl_cond_fraud` (slot `background`) | background_ofac | `{}` always | Individual/member OFAC. PILOT collapses member OFAC into the background report; Blue Lake wants OFAC as its own file. Doc-type OK, no distinct OFAC slot. |
| 6 | ID | `ID_Name_LoanID` | always | `government_id` | `rtl_p1_id` | identity | `{}` always | Exact match. |
| 7 | Track Record | `Track Record_#of#_Type_LoanID` | always (experience) | `experience_docs` | `rtl_p3_reo` | track_record | `{}` always (sized on `requested_exp_*`) | Match. Naming encodes `#of#` + deal `Type` — surface/enforce. |
| 8 | Bank Statements | `BankStatement_Acct#_Date_LoanID` | always | `bank_statement` | `rtl_p3_assets` | assets_liquidity | `{}` always | Match. Blue Lake = **2 months** — already wired (`src/lib/liquidity.js`; hint says "BlueLake file → TWO months"). |
| 9 | Articles of Incorporation | `AOI_Entity Name_LoanID` | when has_llc | `llc_formation` | `rtl_llc_formation` | entity_vesting | `has_llc is_true` | Match. PILOT calls it "Certificate of Formation"; same family. |
| 10 | Operating Agreement/Bylaws | `OA_Entity Name_LoanID` | when has_llc | `operating_agreement` | `rtl_llc_opagmt` | entity_vesting | `has_llc is_true` | Match. |
| 11 | Certificate of Good Standing | `COG_Entity Name_LoanID` | when has_llc | `good_standing` | `rtl_llc_goodstanding` | entity_vesting | `has_llc is_true` | Match. Template is OPTIONAL in PILOT (db/065) — Blue Lake REQUIRES it; consider promoting to required for a Blue Lake file. |
| 12 | W9/EIN | `W9/EIN_Entity Name_LoanID` | when has_llc | `ein_letter` (partial — no W9 form) | `rtl_llc_ein` | entity_vesting | `has_llc is_true` | Partial. PILOT collects the IRS EIN letter; the **W9 form itself is not a distinct doc-type** and not separately collected. |
| 13 | OFAC Entity *(duplicate of #4)* | `EntityOFAC_Entity Name_LoanID` | when has_llc | `background_report` (partial) | **GAP: none** | background_ofac | `has_llc is_true` | **Duplicate row** — same as #4. De-dupe to one requirement. |
| 14 | Entity Background Report | `EntityBackground_Name_LoanID` | when has_llc | `background_report` (partial) | **GAP: none** | background_ofac | `has_llc is_true` | **GAP.** No template collects an ENTITY-level background report; `rtl_cond_fraud` is individual-only. |
| 15 | Appraisal | `Appraisal_Address_LoanID` | always | `appraisal` | `rtl_cond_appraisaldocs` | appraisal | `{}` always | Match. Two slots (db/144). |
| 16 | Purchase Agreement (if purchase) | `PurchAgrmt_Address_LoanID` | if purchase | `purchase_contract` | `rtl_p1_contract` | property / closing_docs | `loan_purpose eq purchase` | Match. |
| 17 | Original HUD (if refinance) | `OrigHUD_Address_Loan ID` | if refinance | `settlement` | **GAP: none (pre-close template RETIRED)** | closing_docs / valuation | `loan_purpose eq refi` | **GAP.** Doc-type `settlement` exists, but `rtl_cond_settlement` was RETIRED for pre-close (db/229). No active pre-close template collects the original HUD on a refi. Source typo: `Loan ID` (space). |
| 18 | Hazard Insurance | `Hazard_Address_LoanID` | always | `insurance` | `rtl_cond_insurance` (slots `binder`+`invoice`) | insurance_hazard | `{}` always | Match. |
| 19 | Builders Risk Insurance (if applicable)¹ | `BuildersRisk_Address_LoanID` | **footnote 1** | `insurance` (partial — "builder's risk" signal) | **GAP: no dedicated slot/template** | insurance_hazard / construction_feasibility | `rehab_type in (construction, heavy)` AND envelope expansion | **CONDITIONAL + partial GAP.** Footnote 1 = "Construction and Heavy Rehab, when adding onto existing envelope." No template/slot separately collects Builders Risk. `rehab_type` + envelope flag NOT in registry → `trigger_note`. |
| 20 | General Liability Insurance (if applicable)² | `GL_Address_LoanID` | **footnote 2** | **GAP: none** (`insurance`=hazard) | **GAP: none** | insurance_hazard / construction_feasibility | `rehab_type in (construction, heavy)` | **CONDITIONAL + TRUE GAP.** No doc-type and no template for a GL policy. `rehab_type` not in registry → `trigger_note`. |
| 21 | Flood Cert | `Flood Cert_Address_LoanID` | always | `flood` | `rtl_cond_flood` | flood | `{}` always (rule-driven by note buyer) | Match. `rtl_cond_flood` (db/177) rule-driven on note buyer (db/281) — Blue Lake requires ALWAYS, not only in a flood zone. |
| 22 | Flood Insurance (if applicable) | `Flood Insurance_Address_LoanID` | if in flood zone | `insurance` (partial — no `flood_insurance`) | **GAP: no dedicated template** | flood / insurance_hazard | `in_flood_zone is_true` | **CONDITIONAL + partial GAP.** No dedicated `flood_insurance` doc-type/template; `rtl_cond_insurance` is the hazard binder/invoice. |
| 23 | Repair Budget *in Excel format* (if applicable) | `Repair Budget_Address_LoanID` | if rehab | `scope_of_work` | `rtl_p1_budget` (+ `rtl_p3_sow1`) | construction_feasibility | `rehab_budget gt 0` | Match. **Naming demands EXCEL format** — PILOT's SOW tool emits HTML/XML/PDF; needs a `.xlsx` export. |
| 24 | Plans and Permits (if applicable)³ | `Plans_Address_LoanID` | **footnote 3** | `plans_permits` | `rtl_p1_plans` (ground-up-only today) | construction_feasibility | `rehab_type in (construction, heavy)` | **CONDITIONAL + coverage GAP.** Footnote 3 = "Construction and Heavy Rehab. For purchase, permits may be obtained after closing, prior to first draw." `rtl_p1_plans` is ground-up ONLY (db/095, db/178) — does not fire on Heavy Rehab; no "permits deferred to first draw" lifecycle. |
| 25 | Feasibility Report (if applicable)⁴ | `Feasibility_Address_LoanID` | **footnote 4** | **GAP: none** | **GAP: none** | construction_feasibility | `rehab_type in (construction, heavy)` | **CONDITIONAL + TRUE GAP.** No doc-type and no template. Highest-value net-new build. |
| 26 | Title Commitment | `Title_Address_LoanID` | always | `title` | `rtl_cond_title` | title | `{}` always | Match. `rtl_cond_title` = "Title documents" (commitment, prelim, CPL, etc.). |
| 27 | Closing Protection Letter | `CPL_Address_LoanID` | always | `cpl` | `rtl_cond_title` (bundled, no dedicated CPL slot) | title | `{}` always | Doc-type `cpl` exists distinctly, but PILOT collects CPL INSIDE `rtl_cond_title` (hint names "CPL"). Consider a dedicated CPL slot to track Blue Lake's separately-named file. |

---

## (a) TRUE GAPS — Blue Lake requires it, PILOT has NO doc-type and/or NO template

| Blue Lake doc | doc-type today | template today | gap type | recommended build |
|---|---|---|---|---|
| **OFAC Entity** (rows 4 & 13) | `background_report` (undistinguished) | none | template gap (entity-level OFAC) | Entity-OFAC slot/condition, trigger `has_llc is_true`. |
| **Entity Background Report** (row 14) | `background_report` (undistinguished) | none | template gap (entity-level background) | Entity-background slot/condition, trigger `has_llc is_true`. |
| **General Liability Insurance** (row 20)² | none (`insurance`=hazard) | none | full gap (doc-type + template) | New `general_liability` doc-type + conditional template on Construction/Heavy Rehab. |
| **Feasibility Report** (row 25)⁴ | none | none | full gap (doc-type + template) | New `feasibility_report` doc-type + conditional template on Construction/Heavy Rehab. |
| **Flood Insurance** (row 22) | `insurance` (weak) | none dedicated | partial gap | Flood-insurance slot, trigger `in_flood_zone is_true`. |
| **Builders Risk Insurance** (row 19)¹ | `insurance` ("builder's risk") | none dedicated | partial gap | Builders-Risk slot on the insurance condition, trigger Construction/Heavy Rehab + envelope expansion. |
| **Original HUD on refi** (row 17) | `settlement` (exists) | none active (retired db/229) | template gap | Re-add refi-only original-HUD pre-close condition, trigger `loan_purpose eq refi`. |
| **Plans & Permits on HEAVY REHAB** (row 24)³ | `plans_permits` (exists) | `rtl_p1_plans` (ground-up-only) | coverage/trigger gap | Broaden `rtl_p1_plans` (or Blue Lake variant) to Heavy Rehab + "permits before first draw" lifecycle on purchase. |

Field-registry gap underlying the conditionals: **`rehab_type` is NOT in the field registry** (only
`rehab_budget`, `program_strategy`, `requested_exp_ground`). Footnotes 1–4 all need a `rehab_type`
(light/heavy/construction/ground-up) field, or a documented proxy + `trigger_note`. Footnote 1 also
needs an **"adding onto existing envelope"** flag — no field exists.

## (b) Naming conventions PILOT should ENFORCE / SURFACE

- Global: every file ends in `_LoanID` (PILOT `ys_loan_number`). Enforce loan-number presence.
- Person docs → `_Name_LoanID` (Credit, Background, OFAC Member, ID).
- Entity docs → `_Entity Name_LoanID` (Entity OFAC, AOI, OA, COG, W9/EIN) — must carry the LLC/entity name.
- Property docs → `_Address_LoanID` (Appraisal, PurchAgrmt, OrigHUD, Hazard, BuildersRisk, GL, Flood Cert,
  Flood Insurance, Repair Budget, Plans, Feasibility, Title, CPL).
- **Track Record → `Track Record_#of#_Type_LoanID`** — index + deal type; unusual, surface it.
- **Bank Statements → `BankStatement_Acct#_Date_LoanID`** — account # + statement date.
- **Repair Budget → EXCEL format** ("Repair Budget in Excel format") — format + name both required; PILOT SOW
  tool must offer an `.xlsx` export named `Repair Budget_Address_LoanID`.
- Source typo to tolerate: Original HUD shows `OrigHUD_Address_Loan ID` (space in "Loan ID").

## (c) CONDITIONAL documents (footnotes) + exact triggers

| Doc | Footnote text (verbatim) | Trigger (field-registry + trigger_note) |
|---|---|---|
| Builders Risk Insurance¹ | "Construction and Heavy Rehab, **when adding onto existing envelope of the property**" | `rehab_type in (construction, heavy)` AND envelope-expansion flag. Both absent → `trigger_note`. |
| General Liability Insurance² | "Construction and Heavy Rehab" | `rehab_type in (construction, heavy)`. `rehab_type` absent → `trigger_note`. |
| Plans and Permits³ | "Construction and Heavy Rehab. For purchase transactions, permits may be obtained after closing, prior to first draw" | `rehab_type in (construction, heavy)`; on `loan_purpose eq purchase` the permit portion defers to before first draw (first-draw lifecycle, not a hard pre-close gate). |
| Feasibility Report⁴ | "Construction and Heavy Rehab" | `rehab_type in (construction, heavy)`. `rehab_type` absent → `trigger_note`. |

All four are Construction & Heavy Rehab docs. Closest existing PILOT signal is `program_strategy`=ground-up /
`requested_exp_ground` + `rehab_budget` size — none cleanly expresses "heavy rehab," the core missing field.

---

## POST-CLOSE list (DEFERRED — kept separate, not mapped in depth)

| blue_lake_doc | naming_convention | closest pilot_doc_type | closest template | domain | notes |
|---|---|---|---|---|---|
| Final HUD | `HUD_LoanID` | `settlement` | `rtl_cond_settlement` (post-close/closing) | closing_docs | Final settlement statement. |
| Note | `Note_LoanID` | none | none | closing_docs | No doc-type today. |
| Mortgage/Deed of Trust | `Mortgage_LoanID` | none | none | closing_docs | No doc-type. |
| Personal Guaranty | `Guaranty_Name_LoanID` | none | none | closing_docs / entity_vesting | Ties to guaranty-waiver workflow; no doc-type. |
| Loan Agreement | `Loan Agreement_LoanID` | none | none | closing_docs | No doc-type. |
| Environmental Indemnity | `Environmental_LoanID` | none | none | closing_docs | No doc-type. |
| Title Policy | `TitlePolicy_Address_LoanID` | `title` (partial — commitment, not policy) | title family | title | Final policy vs. pre-close commitment; no distinct policy doc-type. |
| Business Purpose/Non-Owner occupancy | `BusinessPurpose_LoanID` | `signed_application` ("business purpose" signal) | `rtl_cond_disclosures` (retired/merged db/159) | occupancy / closing_docs | Business-purpose disclosure — collected at app/e-sign. |
| ACH Form | `ACH_LoanID` | `voided_check` (partial) | none | other | ACH authorization — closest is `voided_check`/wire instructions. |

Post-close is doc-type-poor in PILOT today (Note, Mortgage, Guaranty, Loan Agreement, Environmental
Indemnity, ACH have no doc-types) — logged only, per the owner's deferral.

---

### Summary counts
- **Pre-close printed rows:** 27 (incl. the duplicated "OFAC Entity") → **26 distinct documents**.
- **Clean/near matches (doc-type + active template):** 16 rows (CPL & OFAC-Member are bundled/partial).
- **GAPS (no PILOT doc-type OR no active template):** **8 distinct** — Entity OFAC, Entity Background
  Report, General Liability, Feasibility Report (4 hard) + Flood Insurance, Builders Risk,
  Original-HUD-on-refi, Plans-&-Permits-on-heavy-rehab (4 partial/coverage).
- **Most important gaps to build:** (1) Feasibility Report + (2) General Liability Insurance — true net-new
  (no doc-type + no template), both Construction/Heavy Rehab; (3) Entity OFAC + Entity Background Report —
  Blue Lake screens the ENTITY, PILOT only screens individuals; (4) the underlying `rehab_type` field
  (+ envelope-expansion flag) without which no footnote trigger can be expressed precisely.
