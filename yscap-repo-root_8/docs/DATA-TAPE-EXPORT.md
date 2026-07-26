# Capital-provider data tapes

## What a "data tape" is

A **data tape** is a spreadsheet of loan-level data a capital provider (note
buyer) wants when they buy loans off us. Every provider has **their own tape**:
their own Excel workbook, their own columns, in their own order, sometimes with
their own pricing/eligibility formulas built in. Our job on export is to take one
of our loan files and drop its numbers into the provider's sheet **exactly** —
same layout, same formulas — just with our loan's figures filled in.

Three providers are wired today: **Fidelis**, **Blue Lake Capital**, and **EMCAP**.

### Fidelis

Fidelis supplied a workbook ("Fidelis Pricing Matrix &
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

### Blue Lake Capital

Blue Lake supplied their "RTL Sample Tape" (the **Bid Tape**). Its data grid has
headers on row 2 and one loan per row starting at **row 3** (a sample loan ships
in row 3). We fill row 3 (rows 3..N for bulk). Five columns are **per-row
formulas** (Completion %, Total Project Costs, LTAIV, LTC, LTARV) — we re-emit
them as formulas (row-number substituted) so they compute for our loan, exactly
like the sample. The workbook's Data Dictionary tab, hidden calc tabs (Settlement
Statement / Pricing Confirm / Rate Sheet, which reference the Bid Tape row), logo
and dropdowns are all preserved byte-for-byte. Every column's format is inherited
from the sample row (`inheritStyles`), so the ~70-column sheet keeps its
currency/date/percent formatting without hardcoding a style per column.

Blue Lake's buyer key is `bluelake` (display "Blue Lake", full "Blue Lake
Capital"). It has no questionnaire — every column is derived or defaulted.
Owner-directed field decisions: **Seller** = our company name ("YS Capital
Group"); **Total Points** = the loan's origination fee % (`quote.origPct`);
**Borrower Liquidity** = left blank. Two columns stay blank because the Data
Dictionary marks them "to be completed by Blue Lake" (Purchase Rate, Lender
Retained Spread).

### EMCAP

EMCAP supplied a one-sheet "Format Submission Tape" (no definitions or calc tabs):
row 1 is 38 headers (A–AL), row 2 is the data row we fill (rows 2..N for bulk).
`src/lib/tapes/emcap.js` maps our loan onto it, reusing the same facts the other
tapes use plus the **seasoning** snapshot (Current Rehab Amount L, Current Balance
O) and the estimated **monthly rental income** ("Proj. Rental", U). Per-column
Excel styles are taken from the template's own row-2 cells. Owner-directed field
decisions (2026-07-26): **Acquisition Loan (N)** = the purchase-money portion (the
day-1 acquisition advance); **Interest Reserve (M)** = the original financed
reserve; **County (E)** = blank (not stored). Buyer key `emcap`.

EMCAP is a **rental-focused** buyer, so three things hang off it beyond the tape:

1. **Application completeness** — a **fix-and-hold** loan sold to EMCAP must carry
   an **estimated monthly rental income** before it's complete
   (`applications.estimated_rental_income`, db/313; enforced in
   `src/routes/staff.js` `applicationCompleteness`, and shown as an inline field on
   the staff completeness panel). Only EMCAP + fix-and-hold adds the requirement.
2. **A 1007 rent schedule (warn)** — after the appraisal is in, an EMCAP
   fix-and-hold loan whose appraisal is **not a 1025** (a 1025 already *includes*
   the rent schedule) and carries no market rent raises an advisory warning to
   obtain a 1007. Never blocks (owner-directed).
3. **Rent match (warn, exact)** — the appraiser's estimated market rent must
   **exactly** equal the loan's estimated rental income; any difference raises an
   advisory warning to reconcile before submitting to EMCAP.

Both findings are rows in the note-buyer rule table
(`src/lib/underwriting/investor-guideline-review.js`, audience `emcap`), fed by
signals gathered in `src/lib/underwriting/run.js` `gatherInvestorInputs`
(strategy, `estimated_rental_income`, appraisal `form_type`, and the appraiser's
`est_market_monthly_rent` — falling back to the summed per-unit rents of a 1025's
rent schedule). They fire only for EMCAP, only once the appraisal is in, and never
fabricate a finding on missing data.

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

## Seasoned loans — the "current state" snapshot

A tape normally shows a loan's ORIGINATION numbers. But when we sell a loan that
has already funded and is partway through its rehab (a **seasoned** loan), the
tape must show where the loan stands **today**. `src/lib/tapes/seasoning.js`
computes that current snapshot (pure, no DB); `assemble.js` gathers the released
rehab draws from our own money ledger; `index.js` attaches the snapshot to the
loan before the column getters read it.

What moves for a seasoned loan (everything else stays at origination):

- **Current balance** = day-1 advance **+** rehab draws released so far **+**
  interest reserve used so far. (Fidelis **K**, Blue Lake **AD**/UPB + **AB**.)
- **Current rehab (holdback still available)** = original holdback **−** draws
  released; the *original* rehab is unchanged. (Fidelis **J**, Blue Lake **Y**;
  disbursed holdback in Blue Lake **X**.)
- **Current interest reserve** = financed reserve **−** reserve used; the original
  financed reserve is unchanged. (Fidelis **M**, Blue Lake **AA**; disbursed in **Z**.)
- **Next payment due** — the next scheduled monthly payment on/after today, not the
  first payment. (Fidelis **Y**, Blue Lake **AW**; the first-payment date stays.)
- **Interest-bearing balance** — the whole note under **Dutch**; only the advanced
  balance under **as-drawn** (non-Dutch). (Blue Lake **AC**; Dutch escrow holdback **J**.)

Draws come from `draw_disbursements` (our wire ledger): rows with
`kind='draw'` and `funded_status='released'`, summing the gross `approved_cents`
(what converts holdback → outstanding principal), dated by `release_date`
(falling back to when the wire was recorded). A draw that's approved in Sitewire
but not yet wired is **not** counted.

**Interest reserve used** is not stored anywhere, so we ESTIMATE it as the
interest paid to date. Reserve is only drawn down once payments begin (nothing
before the first payment date), and the interest depends on the accrual method
(`applications.accrual_type`): **Dutch** accrues on the whole note; **as-drawn**
accrues on the day-1 advance and steps up on each draw's release date (US 30/360).

Because the reserve figure is an estimate and a seasoned sale is money-sensitive,
a seasoned single export **asks a human to confirm** the current balance, next
due date and interest reserve before the file leaves — pre-filled with the
computed values (`TapeQuestionsModal`'s seasoned section). The confirmed values
ride the export as query params and apply to **that export only** (never
persisted — the live figures re-compute from the draws each time). A bulk export
uses the computed values without a per-loan prompt. A fresh loan (before its
first payment, no draws) is not seasoned and its tape is unchanged.

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
