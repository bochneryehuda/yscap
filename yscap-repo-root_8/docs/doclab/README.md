# DocLab — PILOT drafts the loan documents

DocLab is the loan-document platform of **Private Lender Law**. You give it the facts of a loan; it
merges them into its legal templates and returns a drafted loan package — note, mortgage or deed of
trust, loan agreement, guaranty, entity resolutions.

**We already work with this firm at exactly this step.** `src/lib/closing-prep.js` emails the closing
package to `TeamAG@privatelenderlaw.com` and a person there drafts from it. DocLab is the same firm
and the same step with a structured payload instead of an attachment.

**Scope: RTL only.** Bridge, holdback, ground-up construction, NY building loan, CEMA, commercial. No
DSCR, no prepayment penalties — owner-directed, and enforced in the transport rather than by
convention.

---

## Start here

| If you want to… | Read |
|---|---|
| Understand the whole thing and what happens next | **`DOCLAB-INTEGRATION-BLUEPRINT.md`** |
| Know what to change in PILOT's own data model | **`DOCLAB-DATA-MODEL-GAPS.md`** |
| Call the API | `DOCLAB-API-REFERENCE-V3.1.md` |
| Know what a template needs and where it comes from | `DOCLAB-DATA-DICTIONARY.md` + `src/doclab/field-map.js` |
| Know why DSCR is refused | `DOCLAB-RTL-SCOPE.md` |

## What exists in the code

| Path | What it is |
|---|---|
| `src/doclab/catalog.js` | What DocLab publishes about itself, as data |
| `src/doclab/scope.js` | The RTL gate — refuses DSCR structurally |
| `src/doclab/field-map.js` | Where every variable comes from, and what is missing |
| `src/doclab/payload.js` | Builds the request. Pure. Never fabricates |
| `src/doclab/client.js` | The guarded transport |
| `db/493_doclab.sql` | Requests, their history, the cached catalogues |
| `scripts/test-doclab-*.js` | 59 checks, in `npm test` |

**Status: foundations only.** Nothing is wired to a screen and nothing can reach DocLab — there are
no credentials yet. All three switches default off.

## The reference files are the source of truth

`reference/` holds the untouched files PLL gave us plus machine-readable extracts. The catalog is a
transcription of them, and `test-doclab-catalog-pure.js` re-reads the CSVs and fails if the two have
drifted.

**When PLL ships a new dictionary:** replace the CSV, run `node scripts/test-doclab-catalog-pure.js`,
and it will tell you exactly what moved.

## The four things worth knowing before you touch any of it

1. **DocLab requires only three fields** — lender name, loan category, state. Everything else is
   optional, so a missing value does not bounce; it produces a document with a blank in it. That is
   why the per-template matrix is encoded and why `payload.js` reports what is missing.
2. **"Lender" means three different things**, and one of them is secret. `template.lender_name` is a
   routing key; `variables.lender_name` is the entity on the note; `applications.lender` is the
   **note buyer** and must never reach a loan document. A test enforces the last one.
3. **`Approved` does not mean the documents exist.** Only `Completed` does. And `Error` is
   recoverable, so a poller must keep watching it.
4. **Sandbox and production share a base URL** — the credential is the only difference. Every stored
   request records which environment it was drafted in.
