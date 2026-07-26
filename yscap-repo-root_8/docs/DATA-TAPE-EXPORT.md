# Capital-provider data tapes

## What a "data tape" is

A **data tape** is a spreadsheet of loan-level data a capital provider (note
buyer) wants when they buy loans off us. Every provider has **their own tape**:
their own Excel workbook, their own columns, in their own order, sometimes with
their own pricing/eligibility formulas built in. Our job on export is to take one
of our loan files and drop its numbers into the provider's sheet **exactly** —
same layout, same formulas — just with our loan's figures filled in.

We start with **Fidelis**. Fidelis supplied a workbook ("Fidelis Pricing Matrix &
Data Tape") with:

- **Buy Rate** (visible tab A) — auto-prices the loan and checks guideline
  eligibility from the data row. We never touch it.
- **Data Tape** (visible tab B) — the data-entry grid: row 1 is 48 column headers
  (A–AV), row 2 is where one loan's data goes. **This is the only place we write.**
- **Definitions** (visible tab C) — the field dictionary. We never touch it.
- four hidden lookup engines (Pricing Matrix / Guideline Limits / Rate Assumptions
  / Rate Build-Up). We never touch them.

When Fidelis opens the exported file, the Buy Rate tab recalculates itself from
our Data Tape row and shows their price/eligibility for the loan.

## The rule (owner-directed)

A loan can **only** export the tape of the capital provider it is **currently
assigned to** (`applications.lender`). To export a different provider's tape, you
must first switch the loan's capital provider on its file. This is enforced in one
place — `src/lib/tapes/buyer-rule.js` — so every surface (per-file export, bulk
export) behaves identically. The match is on the normalized note-buyer key
(`normNoteBuyer`), the same key the conditions engine, investor-guideline desk,
and Sitewire links use, so `Fidelis` / `fidelis` all resolve to one key.

## How it stays byte-for-byte faithful

A `.xlsx` file is a ZIP of XML parts. To fill a tape we:

1. `unzip` the provider's template (`src/lib/zip.js`),
2. rewrite **only** the one worksheet part that holds the data row(s) — injecting
   our values as inline strings / numbers / date-serials, each carrying the style
   index the template already uses for that column (currency, date, text…),
3. flip `fullCalcOnLoad` on in `workbook.xml` so the formula tabs recompute on open,
4. `zip` it back up.

Every other part — the pricing tab, the definitions tab, the hidden engines,
shared strings, styles — round-trips **byte-for-byte identical**. The pure test
(`scripts/test-tape-fidelis-pure.js`) asserts exactly that: after a fill, the only
changed parts are the Data Tape sheet and the workbook calc flag.

## Code map (`src/lib/tapes/`)

| File | Role |
|------|------|
| `xlsx-template.js` | Generic template filler: inject row(s) into a sheet, set `fullCalcOnLoad`, re-zip. Provider-agnostic. |
| `templates/fidelis.xlsx` | The Fidelis workbook, kept byte-for-byte. |
| `fidelis.js` | The Fidelis tape definition: the 48-column A–AV map (value + Excel type + style), with valid-value coercion to the sheet's own dropdowns. |
| `assemble.js` | `assembleTapeLoan(appId, db)` — gathers one loan's facts (application row + pricing FICO, current registered `quote`, current appraisal, vesting entity, experience, repeat-borrower flag). Provider-agnostic. |
| `buyer-rule.js` | The capital-provider rule + typed errors + per-loan availability. DB-free (unit-testable). |
| `registry.js` | The list of known tapes. Adding a provider = registering one module here. |
| `index.js` | Public entry: `buildTape` (one loan), `buildBulkTape` (many loans, one workbook), `tapeAvailability`. |

## API

All under `/api/staff` (staff auth + file scoping):

- `GET /tapes` — list the tape types the system knows.
- `GET /applications/:id/tapes` — which tape(s) this loan can export, and why not
  for the rest (based on its current capital provider).
- `GET /applications/:id/export/tape/:tapeKey` — download one loan's tape (.xlsx).
  Enforces the buyer rule; audited; guarded by the same confirmed-fatal issuance
  backstop as the TPR/MISMO exports.
- `GET /tapes/:tapeKey/loans` — every loan assigned to that provider the staffer
  may see (the bulk picker).
- `POST /tapes/:tapeKey/export/bulk` — body `{ applicationIds: [...] }` → one
  workbook with a row per loan. Every loan must belong to the provider (the whole
  batch is rejected, listing any that don't); ids are narrowed to what the staffer
  may see.

## UI

- **On a file** → *Documents & exports* → **Capital-provider data tapes**: shows
  the loan's current provider and an Export button per tape (disabled, with a plain
  reason, for providers the loan isn't assigned to).
- **Left nav → Data tapes** (`/internal/tapes`): pick a provider, see its loans,
  export any single loan's tape or a bulk tape of the selected loans.

## Field-mapping notes (Fidelis)

- Column values are coerced to the sheet's **own data-validation dropdowns** (which
  are tighter than the Definitions tab): AC Purchase/Refinance; AL Single
  Family / 2-4 Unit / Multifamily / Condo / Townhouse; AM Fix and Flip / Bridge /
  New Construction; AO US Citizen / Permanent Resident / Non-Permanent Resident /
  Foreign National. Coercion reuses the shared normalizers in
  `src/lib/conditions/field-registry.js`.
- Economics prefer the **registered quote** (`product_registrations.quote.sizing`)
  and fall back to the application's own columns: loan amount, financed rehab
  (holdback), OOP rehab (= total − financed), financed interest reserve, initial
  advance (current balance at origination), purchase price, as-is, ARV, note rate
  (stored as a fraction for the percent cell).
- "Projects completed" (which drives the Fidelis borrower tier) uses the **same**
  experience basis we price on (claimed-of-record with a fall-back to verified
  ≤36-month exits), so the tape's tier matches our own pricing.
- Fields we don't yet track are intentionally left blank rather than guessed:
  internal projects exited (AE), years of experience (AF), multi-property /
  cross-collateralized flags (AP/AQ). These are the obvious next data sources.

## New-construction questionnaire (supplemental fields)

The New-Construction-only columns (asset purchased AR, entitlement status AS,
build status AT, lot purchase price AU, lot purchase date AV) can't be derived
from what we store. So for a **ground-up loan only**, clicking Export first asks
a short questionnaire for the ones not yet answered — dropdowns for AR/AS/AT, a
number for AU, a date for AV. The answers are:

- **validated** against each field's type (a dropdown value must be in its list;
  a number must be numeric; a date is a calendar day) — invalid/unknown dropped,
- **saved on the loan** (`applications.tape_supplemental` jsonb, `db/309`) so a
  later export doesn't ask again — only still-missing fields are ever asked,
- **used to fill** columns AR–AV.

Any non-new-construction loan asks nothing and leaves AR–AV blank.

Mechanics: a tape declares `SUPPLEMENTAL_FIELDS` + `isNewConstruction` /
`missingSupplemental` / `sanitizeSupplemental` (see `fidelis.js`). The high-level
`tapeQuestions(appId, tapeKey, db)` returns the unanswered fields;
`persistSupplemental(appId, tapeKey, answers, db)` validates + merges them.
Routes: `GET …/export/tape/:tapeKey/questions` (what to ask) and the export route
persists any answer query params before building. UI: `TapeQuestionsModal` pops
before the download on both the file screen and the bulk screen's per-row export.
A future provider's tape gets the same behavior by declaring its own supplemental
fields.

## Adding a new provider's tape

1. Drop the provider's workbook at `src/lib/tapes/templates/<provider>.xlsx`.
2. Identify the data-entry sheet's ZIP part and its data row (unzip + inspect, as
   we did for Fidelis: Data Tape = `xl/worksheets/sheet5.xml`, row 2).
3. Write `src/lib/tapes/<provider>.js` mirroring `fidelis.js`: a `buildRow(loan)`
   that maps our assembled loan onto that sheet's columns (value + Excel type +
   the style index the template uses for the column), plus `key`, `buyerKey`
   (the `normNoteBuyer` form of their name), `name`, `fullName`, `sheetPart`,
   `firstRow`, `lastCol`.
4. Register it in `registry.js`.

Nothing else changes — the routes, the UI, the buyer rule, and the bulk export all
pick it up automatically. A future enhancement is a database-backed, admin-editable
tape builder (define columns + mapping in the UI); the registry is shaped so that
can be layered on without disturbing the code-defined tapes.
