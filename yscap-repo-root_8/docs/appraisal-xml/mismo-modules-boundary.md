# Two MISMO modules — boundary & reconciliation

The repo has **two** MISMO-related modules. They are **complementary, not competing** — different
MISMO version, different document, different direction. This note fixes the boundary so future work
doesn't confuse or duplicate them.

| | `src/lib/mismo/` (PR #337) | `src/lib/appraisal/` (this work) |
|---|---|---|
| **Standard** | MISMO **3.4** (modern DEAL/LOAN/COLLATERAL) | MISMO **2.6** GSE `VALUATION_RESPONSE` + UAD |
| **Document** | The **loan file** (1003/URLA-style: borrower, loan terms, property, LLC) | The **appraisal report** (Fannie forms 1004 / 1025 / 1073) |
| **Direction** | **Import _and_ export** (build XML to send to investors; parse an inbound loan file → create a borrower+application) | **Import only** (read the appraisal into a property profile + findings) |
| **Vocabulary** | Loan enums — LoanPurpose, Occupancy, Citizenship, Marital (`enums.js`) | Appraisal/UAD — condition C1–C6, quality Q1–Q6, condition-of-appraisal |
| **Writes** | Creates a NEW borrower + application (`createFromParsed`) | Fills an EXISTING file's blanks (`importAppraisal`) + `appraisals` tables |
| **Entry** | `loadFile`, `exportApplicationXml`, `previewImport`, `createFromParsed` | `extract`, `computeFindings`, `importAppraisal` |

## Where they touch — and why it's synergy, not conflict

They overlap on exactly three `applications` columns: **`as_is_value`**, **`arv`**, **`appraiser_name`**.

- My **appraisal import fills** those (from the appraisal, definite values only, blank-only shield).
- Their **MISMO 3.4 export includes** those (in the COLLATERAL section when exporting the loan).

So the appraisal import *feeds* the loan export. Both use the **same posture** — fill-blank-only,
never overwrite a human value (their `upsertBorrower` COALESCE / my overwrite-shield) — so they can
never fight over a field.

## Alignments made (so they can't drift)

1. **Property-type vocabulary shared.** The appraisal findings engine's `fileClass()` mirrors
   `mismo/enums.js` (`unitsHint`/`toMismoAttachment`) — same class keys (`sfr`/`multi24`/`multi5`/
   `condo`/`town`/`mixed`), so a property-type mismatch finding uses the portal's canonical vocabulary,
   not a private one.
2. **`appraiser_name` synergy.** `importAppraisal` fills `applications.appraiser_name` (blank-only) so
   the MISMO 3.4 export carries the real appraiser read off the appraisal.

## No conflicts to adjudicate

There is **no standards dispute** — they implement *different* standards (3.4 loan interchange vs
2.6/UAD appraisal), each correct for its document. No industry research was needed to pick a "winner."

## Future consolidation (optional, not required)

Both hand-roll a small XML reader (`mismo/xml.js`, `appraisal/xml.js`) and number/`norm` helpers. If a
third MISMO surface appears, consider a shared `src/lib/mismo-core/` for the tokenizer + normalizers.
Not worth doing for two callers today. **Do not merge the two modules** — they parse different schemas;
one parser for both would be more fragile, not less.

## Tests

Their engine tests (`scripts/test-mismo*.js`) are standalone (not in `npm test`); mine
(`test-appraisal-*.js`) are wired into the `npm test` chain and skip cleanly without a corpus/DB.
