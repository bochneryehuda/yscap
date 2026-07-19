# Appraisal XML Extraction — Research & Extraction Spec

Goal: import a Fannie Mae appraisal XML (MISMO 2.6 `VALUATION_RESPONSE`) into a file and
build a full **Appraisal screen** — every subject detail, all comps, the photos manifest,
the appraiser/company/license, and (critically) the **As-Is** and **ARV** values — then use
that data to check the appraisal against the file before clear-to-close (CTC).

This folder is the research output from analyzing **all 21 uploaded appraisals**
(11× Form **1004** single-family / URAR, 10× Form **1025** 2–4-unit / Small Income),
produced by four parallel research passes plus a working prototype parser run against every file.

## Documents in this folder

| File | What it covers |
|------|----------------|
| `1004-URAR-field-map.md` | Complete field map for **Form 1004 (SFR)** — every element/attribute, per-vendor variation, disambiguation rules. |
| `1025-SmallIncome-field-map.md` | Complete field map for **Form 1025 (2–4 unit)** — adds units, per-unit rent schedule, income/GRM approach. |
| `industry-research.md` | MISMO 2.6 / UAD standards, As-Is vs ARV encoding, RTL underwriting ratios, DSCR, parsing pitfalls, 20 CTC match rules. |
| `photos-comps-variation.md` | Image/photo taxonomy, comparable structure, comp As-Is/ARV split signal, cross-vendor gotchas + primary/fallback strategy. |
| `per-file-extraction-proof.md` | The prototype parser's output for **every one of the 21 files** — evidence placement was verified per file. |
| `prototype/` | Runnable prototype scripts (`strip.py`, `extract2.py`, `asis_miner.py`, `value_engine.py`). |

## The two logics (why the form split matters)

Single-family (1004) and 2–4-unit (1025) are genuinely different forms and need **two
extraction paths**, routed by `REPORT/@AppraisalFormType` (`FNM1004` vs `FNM1025`):

- **1004 / SFR** — value is driven by the **sales-comparison** approach; one dwelling; no rent schedule.
- **1025 / 2–4 unit** — adds the **income approach** (GRM), a **per-unit rent schedule**
  (actual vs market rent), a unit mix, and rental comparables — all absent from a 1004.
  The subject GLA/bath may be blank at the top level because they live per-unit.

Same MISMO attribute *names* across both; different *elements are populated*.

## The critical fields: As-Is value and ARV

This is the highest-risk part and was verified against all 21 files. **Never trust a single
attribute or the condition-type enum alone.**

### ARV (After-Repair Value) — 21/21 recovered

1. Start with the one structured figure: `VALUATION/@PropertyAppraisedValueAmount`
   (present in every file; also mirrored by `SALES_COMPARISON/@ValueIndicatedBySalesComparisonApproachAmount`
   and `COST_ANALYSIS/@ValueIndicatedByCostApproachAmount`).
2. Decide what that figure *means* using **two** signals, not one:
   - `VALUATION/_RECONCILIATION/_CONDITION_OF_APPRAISAL/@_Type`
     (`SubjectToRepairs` / `SubjectToCompletion` → the figure is the **ARV**; `AsIs` → it's the As-Is), **AND**
   - a **narrative scan for hypothetical-condition / as-repaired language**
     ("hypothetical condition that all repairs… have been completed", "as repaired", "subject to completion").
     If present, the figure is the **ARV even when the enum says `AsIs`** — this exact case
     (file 09709435) is why the enum cannot be trusted alone.
3. If the report is genuinely an As-Is report, the ARV may only be in narrative
   (`as-repaired value $X`) or estimated from the ARV comp cluster (flagged).

### As-Is value — 14/21 exact, 4 estimated, 3 PDF-only

There is **no dedicated As-Is attribute** in these XMLs. Mine it in priority order:

1. If `_CONDITION_OF_APPRAISAL/@_Type = AsIs` **and no** hypothetical language → the structured
   `PropertyAppraisedValueAmount` **is** the As-Is.
2. Otherwise sweep **all** narrative attributes for an As-Is dollar figure — the value hides in
   different places per vendor: `_RECONCILIATION/@_ConditionsComment`, `@_SummaryComment`,
   `SALES_COMPARISON/@_CurrentSalesAgreementAnalysisComment`, `@_Comment`,
   `VALUATION_METHODS/@_AdditionalDescription`, and **`FORM/@AppraisalAddendumText`**.
   Handle paired "As-Repaired … As-Is …" phrasing (grab the As-Is, not the As-Repaired),
   support millions (`$1,700,000`), and **exclude the decoy** `COST_ANALYSIS/@SiteOtherImprovementsAsIsAmount`
   (that is a cost-approach *site* figure, not the market As-Is).
3. Fallback: cluster the real comps' `AdjustedSalesPriceAmount`; the lower cluster ≈ As-Is
   (flag as an estimate to confirm in the PDF).
4. If none of the above → flag **"As-Is only in PDF — needs manual entry / OCR"**. Never guess silently.

Files where As-Is is genuinely only in the PDF: **10182152, 10394133, 10484851**.

## Other high-value traps (verified across files)

- **Subject UAD condition (C1–C6) & quality (Q1–Q6)** are **not** on `STRUCTURE`. The subject is
  rendered as the `COMPARABLE_SALE` with `PropertySequenceIdentifier="0"`; its rating lives there
  (`COMPARISON_DETAIL/@GSEOverallConditionType` / `@GSEQualityOfConstructionRatingType`, or the
  seq-0 `SALE_PRICE_ADJUSTMENT[_Type="Condition"/"Quality"]/@_Description`).
  `<_CONDITION>/@_Type` is the *"evidence of Infestation/Dampness/Settlement"* checkbox — a decoy.
- **Comp count**: exclude seq-0 (it's the subject). Sequence numbers aren't always contiguous.
- **The As-Is vs ARV comp split** (e.g. comps 1-3 = ARV, 4-6 = As-Is) has **no attribute** — it's
  stated in prose and confirmed by adjusted-price clustering. Conventions vary by vendor.
- **Number formats vary** (commas / `.00` / plain); **dates vary** (ISO vs `MM/DD/YYYY`);
  `TotalBathroomCount` is UAD `full.half` (`2.1` = 2 full + 1 half); lot size is a string with a unit suffix.
- **Vendors**: a la mode TOTAL, ACI, ClickFORMS, Appraise-It. `AppraisalSoftwareProductName` is often
  blank (that itself fingerprints a la mode). The `Completed_Product_(Data)_*` vs `nan_*` filename
  split is a delivery label, not a vendor.
- **Photos are not individually embedded** — every file carries one `<EMBEDDED_FILE _Type="PDF">`
  (the whole report). Only some vendors emit per-photo `<IMAGE>` metadata; otherwise classify pages
  via `FORM/@AppraisalReportContentType` (`SubjectPhotos`, `SalePhotos`, `RentalPhotos`, `Sketch`,
  `LocationMap`, …). The pixels live inside the PDF.

## How this feeds the existing system (integration notes)

- The `applications` table **already has `as_is_value` and `arv` columns** (pricing reopens on any
  change to them — see `db/126`/`072`). Extracted values should populate/verify these, not duplicate them.
- Import follows the existing document flow: base64 upload → `lib/upload-bytes.decodeUploadBase64`
  → storage → `documents` row (`doc_kind='appraisal_xml'`), then parse server-side.
- The UI belongs in **`app-v2/`** (V2/PILOT is canonical) as a new `<Section>` in `StaffApplication.jsx`
  (a natural fit for the existing "Phase 4 · Appraisal & Numbers").
- Underwriting match rules (appraisal vs file) — the CTC checks: appraised/As-Is ≥ purchase price,
  ARV supports the loan (LTARV), all leverage caps = min(LTV, LTPP, LTC, LTARV), comps within
  ~12 months / ~1 mile, effective date recent, appraiser licensed & not excluded, subject photos
  present. Full list in `industry-research.md`.

## Status

Research + a working prototype parser (proven on all 21 files) are complete. **Next step is a
review with the owner to prioritize which fields matter most**, then build: DB schema → parser
module (Node) → XML import → Appraisal screen (app-v2) → underwriting match rules.
