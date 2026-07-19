# Storage, Dual-Side Screen, Export & OCR-Assisted As-Is — design

How the imported appraisal is **stored** (every field lands somewhere), **shown** read-only to
both the loan officer and the borrower, **exported** (the PILOT report + the original PDF), and how
the **As-Is officer condition + OCR** works. Nothing here guesses — a value is stored only when a
strict rule says we know it (see `field-validation-rules.md`).

## 1. Storage — every field lands somewhere

New idempotent migration `db/137_appraisals.sql`. Core row + child tables + a JSONB catch-all so
even long-tail fields are persisted.

### `appraisals` (one row per imported appraisal; re-import supersedes)
- Keys: `id`, `application_id`, `source_xml_document_id`, `pdf_document_id`, `imported_by`, `imported_at`, `superseded` (bool).
- Form: `form_type` (`FNM1004|FNM1025|FNM1073`), `form_version`, `software_vendor`.
- Dates: `effective_date`, `report_signed_date`, `inspection_date`, `appraisal_purpose`.
- **Values (each with a confidence twin):** `appraised_value`, `condition_of_appraisal`,
  `as_is_value` + `as_is_confidence`, `arv_value` + `arv_confidence`,
  `value_sales_approach`, `value_cost_approach`, `value_income_approach`, `grm`, `site_value`,
  `contract_price`, `contract_date`.
- **Subject:** `address,unit,city,county,state,zip,apn,legal,census_tract,neighborhood,`
  `property_type,units,year_built,effective_age,gla,rooms,beds,baths,stories,design,`
  `lot_area,zoning_id,zoning_desc,zoning_compliance,condition_uad,quality_uad,flood_zone`.
- **Appraiser:** `appraiser_name,appraiser_company,license_id,license_state,license_type,`
  `license_exp,appraiser_phone,appraiser_email,supervisor_name,lender_name,amc_name`.
- **Condo (1073 only):** `project_name,project_type,unit_identifier,floor,hoa_fee_amount,hoa_fee_period`.
- **Catch-all:** `fields jsonb` — the FULL extracted set as `{ key: {value, source, confidence} }`
  (construction, utilities, cost-approach lines, market stats, etc. from `expanded-field-catalog.md`),
  so no field is ever dropped even if it has no dedicated column.
- **Quality:** `warnings jsonb` (tripwire/sanity flags), `confidence_summary` (counts of definite/verify/missing).

Every dedicated column is populated **only if the value passed its validation rule**; otherwise it
stays NULL and the field's status lives in `fields`/`warnings`. Confidence enum:
`definite | needs_verify | missing`.

### `appraisal_comparables`
`appraisal_id, seq, is_subject(bool), address,city,state,zip, proximity, sale_price, adjusted_price,`
`gla, sale_date, net_adjustment, gross_adj_pct, net_adj_pct, condition_uad, quality_uad, days_on_market,`
`data_source, adjustments jsonb (every SALE_PRICE_ADJUSTMENT line), comp_set (arv|as_is|unknown)`.
Seq-0 subject row kept with `is_subject=true` (drives the subject's UAD condition/quality), excluded from comp counts.

### `appraisal_units` (1025)
`appraisal_id, unit_seq, rooms, beds, baths, sqft, actual_rent, market_rent, lease_status`.

### `appraisal_photos`
`appraisal_id, document_id (stored image) OR pdf_page, category (subject_front|subject_rear|subject_street|interior|comparable|sketch|map|exhibit), caption, sequence, width, height`.
Photos are extracted from the embedded PDF (see §4). Until extraction is wired, rows carry the
**manifest** (category + presence) and the report shows the PDF.

### Link back to the file (feeds pricing/underwriting)
On import, `applications.as_is_value` and `applications.arv` are populated **only** from
`definite` values, and **never overwrite a human-entered value** (mirrors the existing PII/DOB
overwrite-shield). A changed value flows through the existing pricing-reopen trigger (`db/126`/`072`).

## 2. Import flow (server-side, one chokepoint)

1. Upload XML as a `documents` row (`doc_kind='appraisal_xml'`) via `lib/upload-bytes.decodeUploadBase64`.
2. **Route by `AppraisalFormType`** → 1004/1073 single-dwelling path, or 1025 multi-unit path.
3. Extract every field, **run its validation rule** (`field-validation-rules.md`); stamp `{value,source,confidence}`.
4. Run cross-field sanity checks → `warnings`; run **tripwires** (e.g. "1004 with 0 comps", "appraised value missing", "an ALWAYS field came back blank") → surface, don't silently pass.
5. Write `appraisals` + `appraisal_comparables` + `appraisal_units` + `appraisal_photos`.
6. Decode the embedded PDF → store as `documents` (`doc_kind='appraisal_pdf'`); extract photos (§4).
7. Populate `applications.as_is_value`/`arv` from definite values (overwrite-shield).
8. **If As-Is is not definite → open the officer condition + run OCR (§3).**

## 3. As-Is officer condition + OCR (no guessing, no estimate)

When step 7 has **no definite As-Is** (~1 in 3 files):

- **Open an internal condition** `appraisal_as_is_verify` (a `checklist_templates` row, `audience='staff'`,
  `item_kind='condition'`, idempotent + backfilled — same pattern as `db/059`). Text: *"We could not read
  the As-Is value from the appraisal data. Please open the report and enter the As-Is value."* It carries a
  number input; entering it sets `as_is_value` (confidence `definite`, source `officer`) and satisfies the condition.
- **Attempt OCR (advisory only)** using the **existing OCR.space integration** (`src/lib/integrations/card-ocr.js`
  pattern; OCR.space accepts PDFs). Send the stored appraisal PDF, get the text, search for an As-Is figure near
  phrases like *"as is value"*, *"as-is"*, *"opinion of ... as is"*. **Cross-check** any candidate for plausibility:
  it should be **below the ARV**, in a sane band around the **purchase price**, and match the low comp cluster —
  only then is it "worth showing." Write the finding into the condition note:
  *"OCR read the report and found a likely As-Is of **$X** (near 'as-is value', page N). Please confirm against the report."*
  If OCR finds nothing trustworthy, the note says so.
- **Never auto-store the OCR value.** It is a hint inside the officer's task, not a saved field. **Audit-log**
  every OCR attempt + result (`audit_log`). Once we have a track record that OCR is reliable (the audit log
  proves it), a later phase can raise OCR to auto-fill with review — not now.
- **No comp-estimate suggestion** (dropped per owner: a statistical guess is not shown).

## 4. Photos from the PDF

The embedded PDF (always present) is the only pixel source (no file embeds individual images). Photos
ARE extractable from it (proven). Because the backend is Node with a strict zero-native-deps rule, PDF
image extraction is a deliberate design choice — a Node PDF-image approach or a small isolated worker —
not a bare native `npm install`. Each extracted image is stored as a `documents`/storage item and an
`appraisal_photos` row with its category. Until wired, the report shows the manifest + the full PDF.

## 5. Dual-side read-only screen

A new **Appraisal / Property Profile** screen, **read-only for everyone** (no editing anywhere), rendered
from the stored `appraisals` data — the PILOT report look (see the mockup). Two audiences, one report:

| Section | Loan officer (staff) | Borrower |
|---|---|---|
| Hero, address, photos, subject details | ✅ | ✅ |
| Values: As-Is, ARV, purchase, approaches, GRM | ✅ | ✅ |
| Comparable sales (+ adjustments) | ✅ | ✅ (adjustments collapsible) |
| Neighborhood / market stats | ✅ | ✅ |
| Appraiser, license, effective date, trust checks | ✅ | ✅ |
| Condo card (project, unit, HOA) — 1073 | ✅ | ✅ |
| Original appraisal PDF | ✅ | ✅ (or per policy) |
| Confidence flags / "needs verify" badges | ✅ | hidden or softened |
| **Underwriting internals** (LTV/LTC/LTARV, exclusionary-list, note-buyer names, officer conditions) | ✅ | ❌ never |

Staff reach it from the file (a `<Section>` in `StaffApplication.jsx`, the existing "Phase 4 · Appraisal
& Numbers"); borrower reaches it from their application view. Same renderer, a `viewerRole` prop drives
the split. (Final section-by-section split comes from `report-enhancement-research.md`.)

## 6. Export

- **Export PILOT Report** — a branded print/PDF of the on-screen report: cover page with the PILOT lockup +
  address + headline values, page-broken sections, header/footer lockup, "prepared from the appraisal by
  [appraiser]" line, and a disclaimer. Print stylesheet keeps it premium on paper (brand fonts embedded in
  the app build).
- **Download original appraisal** — the stored source PDF, one click.

## 7. Never-guess guarantees (summary)

- A dedicated column is filled **only** when the field passes its validation rule; else NULL + status in `fields`.
- As-Is/ARV follow the strict value rules (condition-type + hypothetical gate; As-Is definite-only).
- OCR output is advisory inside a condition, audit-logged, never stored automatically.
- Tripwires catch parser regressions / odd vendors on future files instead of silently storing blanks.
