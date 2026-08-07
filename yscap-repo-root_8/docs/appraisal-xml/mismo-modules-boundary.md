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

## The THIRD surface — UAD 3.6 (2026-08-07), and why it did NOT become a shared core

A third MISMO surface has now appeared: **UAD 3.6 / MISMO 3.6**, the redesigned URAR, mandatory for
GSE delivery from 2 November 2026. It lives in the **appraisal** module — `src/lib/appraisal/xml36.js`
+ `uad36-map.js` + `extract36.js` + `package36.js` — because it is the same DOCUMENT this module
already owns (the appraisal report), read for the same PURPOSE (a property profile + findings), in
the same DIRECTION (import only), with the same VOCABULARY (C1–C6, Q1–Q6, condition of appraisal).

| | `src/lib/mismo/` | `src/lib/appraisal/` (2.6) | `src/lib/appraisal/` (3.6) |
|---|---|---|---|
| **Standard** | MISMO 3.4 | MISMO 2.6 GSE `VALUATION_RESPONSE` + UAD | MISMO **3.6** `MESSAGE` + UAD 3.6 |
| **Document** | the loan file (URLA-style) | the appraisal (forms 1004/1025/1073) | the appraisal (**one dynamic URAR**, no form number) |
| **Direction** | import **and** export | import only | import only |
| **Entry** | `loadFile`, `exportApplicationXml` | `extract` | `extract` → `extract36` (routed by detected version) |

**The 3.4 reader was NOT reused, and that was deliberate.** `src/lib/mismo/xml.js` is the right
SHAPE — namespace-agnostic, text-bearing, local-name matching — but wiring the appraisal module into
the loan-interchange module would cross the boundary this document exists to hold, and it has two
properties an appraisal reader must not have: it PARSES RECURSIVELY (a deep report can exhaust the
call stack and abort an import) and it THROWS on malformed input (an appraisal that is 99% readable
must still import 99%, with the damage reported — never a 500). `xml36.js` is iterative and tolerant
for exactly those two reasons.

**One rule DID move across, on purpose:** `extract.js#detectMismo`'s comparable-grid test is now
built from the 3.6 reader's container list, so "is there an appraisal in this file?" has ONE answer —
the research warehouse's catch (`lib/research/xml-catch.js`) reuses that function as its own
definition, and a container spelling only one of the two knew about would mean a report the reader
can read being ignored by the warehouse, or the reverse.

## Future consolidation (still optional, still not required)

All three hand-roll a small XML reader and number/`norm` helpers. A shared `src/lib/mismo-core/` for
the tokenizer is now arguably worth considering, but the normalizers are NOT shareable: 2.6 packs
compound values into one attribute (`TotalBathroomCount="2.1"`) where 3.6 states them as separate
typed data points, so a shared helper would need a "which version am I reading" branch — which is how
a 2.6 bug fix silently changes a 3.6 answer. **Do not merge the modules** — they parse different
schemas; one parser for all three would be more fragile, not less.

## Tests

Their engine tests (`scripts/test-mismo*.js`) are standalone (not in `npm test`); mine
(`test-appraisal-*.js`) are wired into the `npm test` chain and skip cleanly without a corpus/DB.
