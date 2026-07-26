# Extraction Confidence & Error Handling

How the appraisal import protects our own data: what we trust, what we flag, and what
becomes an officer task. Owner-directed rules (2026-07-19):

- **ARV is mandatory** — every imported appraisal must yield an ARV.
- **As-Is: take only a DEFINITE value** — no OCR and no estimate-as-truth for now. When the
  As-Is cannot be found definitively, **open an internal condition** for the officer to read
  it off the report and enter it.

## Confidence levels (stamped on every extracted field)

| Level | Meaning | UI treatment |
|-------|---------|--------------|
| `definite` | Read from a structured attribute, or an exact figure in the report narrative | Show as a normal value |
| `estimate` | Derived (e.g. As-Is from comparable-sale clustering) | Show **only as a hint**, never as the saved value; officer confirms |
| `non_uad` | Present but not in the standard code (e.g. condition written "Good"/"BRICK" instead of C4) | Show with a "verify" badge |
| `missing` | Not in the XML (may be in the PDF) | Blank + "could not read" note; may open a condition |

Every field the parser returns carries `{ value, source, confidence }` so the UI and the
underwriting checks always know how much to trust it. A field is never silently blank.

## ARV — mandatory, with a safety net

Resolution order (all 33 sample files resolve at the first or second step):
1. `VALUATION/@PropertyAppraisedValueAmount`, **when** the report is a subject-to / ARV report —
   determined by `_CONDITION_OF_APPRAISAL/@_Type` ∈ {SubjectToRepairs, SubjectToCompletion}
   **OR** hypothetical-condition / as-repaired language in the narrative (the enum can mislabel;
   never trust it alone). Corroborated by the sales- and cost-approach values.
2. An "as-repaired / after-repair value $X" figure mined from the narrative.
3. **If neither yields a value → CRITICAL.** Do not import silently: raise a blocking flag on the
   file ("ARV could not be read from the appraisal") and open an officer condition to enter it.
   ARV is required for pricing (LTARV) so a missing ARV must never pass to clear-to-close.

Across the 33 samples: **ARV resolved 33/33** at step 1/2. Step 3 is the safety net.

## As-Is — definite-only, else an officer condition

1. **Definite** = the structured value when `_CONDITION_OF_APPRAISAL/@_Type = AsIs` **and no**
   hypothetical language, **or** an exact As-Is figure found in the narrative (the priority sweep:
   `_ConditionsComment`, `_SummaryComment`, `_CurrentSalesAgreementAnalysisComment`, `_Comment`,
   `_AdditionalDescription`, `FORM/@AppraisalAddendumText`), **excluding** the cost-approach decoy
   `SiteOtherImprovementsAsIsAmount`.
2. If a definite As-Is is found → save it (`confidence: definite`).
3. **If NOT definite** (only a comp-cluster estimate, or only in the PDF) → **do not save a value.**
   Open the internal condition **`appraisal_as_is_verify`** on the file:
   *"We couldn't read the As-Is value from the appraisal XML — please open the report and enter
   the As-Is value."* The comp-cluster estimate is shown **next to the input as a suggestion**
   ("looks around $X based on the as-is comps — confirm against the report"), never auto-saved.

Across the 33 samples: **As-Is definite on 21/33**; the other **12** would each open the officer
condition (7 have a comp estimate to suggest, 5 are PDF-only). This is by design — the officer
enters the real number rather than us guessing.

### The new internal condition

A staff-only condition `appraisal_as_is_verify`, created when import cannot determine a definite
As-Is (mirrors the existing internal-condition pattern — see `db/059_appraisal_docs_internal_condition.sql`).
It carries a text/number input, is satisfied when the officer enters the value (which then populates
`applications.as_is_value`), and gates clear-to-close like other internal conditions. Reopens if a
re-import still can't find it.

## The embedded PDF — always captured

Every file (33/33) embeds exactly one `<EMBEDDED_FILE _Type="PDF">` — the full appraisal report
(verified: valid `%PDF`, ~3–7 MB). On import we decode it (via the existing
`lib/upload-bytes.decodeUploadBase64` chokepoint), store it as a `documents` row
(`doc_kind='appraisal_pdf'`), and offer it in the property profile as a viewer + part of the export.
This is the guaranteed fallback for anything we can't read from the data.

## Property photos — from the PDF (proven)

No file embeds individual photo files (0/33) — the photos live **inside the PDF**. They ARE
extractable as real images (verified: pulled the subject-property front photo and others from a
sample PDF). Plan: extract subject/comp/interior photos from the stored PDF for the gallery.
**Architecture note:** PDF image extraction needs a library; the backend is Node with a strict
zero-native-deps rule, so this is a deliberate design choice (a Node PDF-image library, a small
isolated service, or a build step) — not a bare `npm install` of a native module. Until wired,
the profile shows the photo **manifest** (which photos exist, from `IMAGE` metadata +
`FORM/@AppraisalReportContentType`) and the full PDF.

## General error-handling principles

- **Route by `AppraisalFormType`** (1004 vs 1025) — never assume; the two forms populate different
  elements (1025 adds units, per-unit rents, income/GRM).
- **Multi-source fields try every known location** (see `placement-variability.md`): As-Is, APN,
  subject condition/quality, GLA. First definite hit wins; record which source.
- **Normalize formats** before saving: strip commas from money, parse `full.half` baths, accept both
  ISO and `MM/DD/YYYY` dates, validate UAD codes (`C1–C6`/`Q1–Q6`) — anything else → `non_uad` flag.
- **Never overwrite a human-entered value** with a lower-confidence import (mirrors the ClickUp/DOB
  overwrite-shield pattern already in the codebase).
- **A missing ALWAYS/USUALLY field on a new file** surfaces a visible "could not read X" note, so a
  parser regression or an odd new vendor is caught, not silently blanked.
- **Sanity cross-checks** (soft flags, not blocks): As-Is ≤ ARV; appraised value ≈ sales-comparison
  value; contract price present; effective date not stale.
