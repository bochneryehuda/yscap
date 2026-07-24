# Investor-Guidelines Research — Blue Lake ISG deep dive (preserved 2026-07-24)

This folder is the **preserved output of the big multi-agent investor-guideline research run**
(the "angles" + "playbook" work). It was produced in a working scratchpad and committed here so it
is never lost. It is **research / reference only** — advisory notes an engineer or underwriter reads;
nothing here is executed code. Note-buyer names appear (this is a STAFF-internal doc — never a
borrower surface).

## What each file is

### The "playbook" — what a sharp underwriter checks that PILOT does not (gap audits)
- **`gap_A_doc_underwriting.md`** — the document-underwriting playbook. A severity-ranked TOP-15 of
  gaps by document type (credit, insurance, title, appraisal, entity, bank, contract, track record,
  ID) with, for each: what the system does today, the concrete gap, how a human catches it, and the
  exact build-on enhancement (with `file:line` pointers). **This is the "what to look for on each
  document" master list.**
- **`gap_B_data_validation.md`** — data-integrity / cross-document validation gaps (the numbers that
  should agree across documents but aren't checked).
- **`gap_C_condition_clearing.md`** — condition-clearing / sign-off logic gaps (where a condition can
  clear on weak or wrong evidence).

### The "angles" — how to build the AI document-understanding layer
- **`ai_A_llm_infra.md`** — LLM/infra angle (models, routing, cost, tracing).
- **`ai_B_docunderstanding.md`** — document-understanding angle (OCR → structure → checks).
- **`ai_C_loan_primer.md`** — the Loan File Primer angle (grounding the AI on the canonical file).
- **`ai_D_unified_backbone.md`** — the synthesis: one unified AI underwriting backbone.

### The Blue Lake guideline extraction (page-by-page findings)
- **`findings_A_pp1-10.md`**, **`findings_B_pp11-20.md`**, **`findings_C_pp21-28_and_deck.md`** — the
  Blue Lake guideline document read page by page (program, eligibility, leverage, overlays).
- **`findings_D_doclist.md`** — the Blue Lake Required Documents List mapped to PILOT doc types.
- **`guidelines_ALL.txt`**, **`doclist_ALL.txt`** — the raw extracted source text (system of record).

### The reframe (backend overlay + per-condition data sources)
- **`reframe_R1_datasources.md`** — the per-condition **data-source map**: each condition → the PILOT
  field / extractor that already feeds it (and the gaps that need vendor data). Basis for wiring the
  investor-guideline desk to real data.
- **`reframe_R2_bug_and_lifecycle.md`** — bug fixes + condition lifecycle (pre-close vs post-close).

### `_REFERENCE.md`
The shared instruction sheet the extraction agents worked from — the exact spec shape, allowed enum
values, available loan-file field keys, and the PILOT template-code + doc-type vocabularies. Useful
when adding a NEW note buyer's spec (match these shapes so it compiles into the existing framework).

## How this connects to shipped code

The structured, machine-readable result of this research already lives in code as the note-buyer
condition specs — `src/lib/underwriting/investor-guidelines/corrfirst-fnf-spec.js` (CorrFirst, 47
conditions) and `bluelake-rtl-spec.js` (Blue Lake, 64 conditions), each condition carrying its
`required_evidence` + `checks`. `src/lib/underwriting/document-review-guide.js` projects those checks
onto the document type they clear, so the document reviewer sees "what to look for on this document"
for the file's note buyer. The `gap_*` files are the roadmap for deepening each per-document check
beyond what ships today.
