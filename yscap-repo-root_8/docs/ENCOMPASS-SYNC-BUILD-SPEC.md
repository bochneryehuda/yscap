# Encompass Sync — Build Spec & Complete Field Mapping (Live-Verified)

**Date:** 2026-07-26 · **Status:** BUILD SPEC — the authoritative plan + complete field mapping for the per-file Encompass sync and the borrower-profile enrichment. Verified by **read-only** pulls against instance BE11397907. No write to Encompass, ever; no borrower PII or raw loan JSON stored in this repo (example values are deal economics with identifiers stripped).

> **READ-ONLY, FOREVER.** Everything here reads from Encompass only. The only writes are **into our own system** — (a) user-initiated field replacement in Part 1, and (b) borrower-profile enrichment in Part 2. Nothing is ever written back to Encompass. This rides the read-only client already frozen on `main` (`src/lib/integrations/encompass.js`).

Companion: `ENCOMPASS-FIXFLIP-MASTER-MAPPING.md` (field discovery) · `encompass-research/analysis/encompass-live-customfield-catalog.md` (855-field schema).

---

## 1. Two parts (owner-directed)

**Part 1 — Read-only file sync + term-sheet gate (matching, findings, user-approved replace).**
When a file has (or is given) a loan number, pull the matching Encompass loan read-only, compare identity + program fields, raise a **finding** per mismatch, and let a user **pull the Encompass value into our field** on demand. **A term sheet cannot be issued until the Encompass-sync findings tab is clear** (all compared fields match or are explicitly resolved). One-directional (Encompass → us), never automatic.

**Part 2 — Borrower-profile enrichment (the write part).** Independent of any one file: use *all* of a borrower's Encompass loans to build up the borrower **profile** — add prior deal **addresses** to their track record, and add every **LLC** they have used to their entity profile. This *adds information to the borrower profile, not files*, and is the part that actively writes into our DB (never to Encompass).

---

## 2. What already ships on `main` (build ON this — do not duplicate)

- **Read-only client** `src/lib/integrations/encompass.js` — GET + two read POSTs only (token, pipeline); `_fetchGuarded` refuses all other verbs.
- **Pull + match** `src/encompass/reader.js` `pullLoanForApplication` — matches by `ys_loan_number`, caches `Loan.Guid`, stores `encompass_extra` (SSN-scrubbed). Worker `src/sync/encompass-sync.js` orders by `encompass_last_pulled_at NULLS FIRST`.
- **Loan number** `applications.ys_loan_number` (`db/048`), set at `POST /applications/:id/loan-number` (`staff.js:6316`; fill-blank open to file-workers, CHANGE admin-only). → **Add** an immediate `pullLoanForApplication` here so a newly-numbered file syncs at once.
- **Dormant mismatch engine** — `encompass-field-map.extractFields()` + `system-reconciliation.reconcileEncompass()` already emit `encompass_<field>_mismatch` findings with `expected(ours)` / `actual(theirs)`. **Nothing calls them — Part 1 activates them.**
- **Findings/replace pattern to reuse** — `sync_review_queue` (`db/108/110/112`) + `sync-review.js` / `sync-file-review.js`; use the **one-sided inbound-apply** branch (write only our column), not two-sided winner logic.
- **UI** — add a `sec-encompass` `<Section>` + `EncompassSyncPanel.jsx` to `StaffApplication.jsx` (`SECTIONS`), staff routes `/api/staff/applications/:id/encompass/*` behind `VISIBLE_OFFICERS_SQL`; gate **replace** behind admin (`seesAll`); audit `encompass_field_replace`.

---

## 3. Read mechanics (verified live)
- Custom-field values are on the full loan's `customFields[]` under **`value`** + **`format`** (not `stringValue`).
- **The pipeline cannot return several computed CX fields** (`CX.MAXTOTALLOAN`, `CX.FINALINITIALLOAN`, `CX.EFFECTIVEPURCHASE`, `CX.ORIGINALCONTRACTPURCHASEP`, `CX.TOTALCOST`, `CX.MAXLTC`) — they came back null in pipeline but are populated in the full `GET /loans/{guid}`. **Read the full loan for the compare; pipeline is only for discovery.**
- Money is `DECIMAL_2` strings like `"525450.0000"`; percents are `DECIMAL_4` (`92.1034` = 92.1034%); origination fee (field 388) is a percent (`1.0` = 1%). **Normalize both sides to numbers and compare with a tolerance** (money to the cent; percent to 4 dp) — the owner's note: dollar signs / cents / dropdown wording differ, so compare *values*, not strings.

---

## 4. Identity mapping (borrower + co-borrower)

Our borrower identity: one `borrowers` table; the file (`applications`) links `borrower_id` (primary) and `co_borrower_id` (optional second). Encompass: `applications[].borrower` and `applications[].coBorrower`.

| Concept | Our column (primary → co-borrower) | Encompass field | Match method |
|---|---|---|---|
| First name | `borrowers.first_name` | `applications[].borrower.firstName` (std `4000`; co `4004`) | case/space-insensitive equals (**two fields both sides — direct**) |
| Last name | `borrowers.last_name` | `.lastName` (std `4002`; co `4006`) | case/space-insensitive equals |
| Middle/suffix | *(no column)* | `.middleName` / `.suffixToName` | **finding only** — we have no home for these (drop/append) |
| DOB | `borrowers.date_of_birth` (`YYYY-MM-DD`) | `.birthDate` (std `1402`/`1403`) | date equals; respect `sanitizeDob` + the DOB-review rules |
| SSN | `ssn_hash` / `ssn_last4` (never plaintext) | `.taxIdentificationIdentifier` (std `65`/`97`) | **compare by HMAC hash / last-4 only**; never fetch-print-store plaintext; reveal stays behind the audited `view_ssn` gate |
| Primary address | `borrowers.current_address` (jsonb) | `.residences[]` (current) / mailing | canonicalize with `address-canon.samePlace` |
| Phone | `borrowers.cell_phone` | `.mobilePhone` / `.homePhoneNumber` | digits-only equals |
| Email | `borrowers.email` | `.emailAddressText` | lowercase equals |

Each mismatch → a finding with `ours` vs `theirs` + a **"replace ours"** action (writes only the PILOT column, audited). SSN/DOB replacements ride the existing sanitize + audit chokepoints.

---

## 5. Program / economics mapping (complete)

**Critical architecture:** our INPUTS are `applications` columns; our sized OUTPUTS (effective purchase, total cost, initial advance, financed-reserve $, actual LTC/ARV, MAX caps) are **not columns** — they live in `product_registrations.quote` JSONB (computed by the frozen engines). The compare reads the latest registration's `quote` for those.

| Encompass field | Meaning | Our side | Notes / format |
|---|---|---|---|
| `1109` **and** `CX.MAXTOTALLOAN` | Total loan amount | `applications.loan_amount` | both must equal our total; money |
| `CX.FINALINITIALLOAN` | Initial advance | `quote` initial advance = `loan_amount − financed_rehab − financed_reserve` | compute-only in our system |
| `CX.REHABBUDGET` | Rehab / construction budget | `applications.rehab_budget` (+ SOW total) | money |
| `CX.FINANCEDREHABBUDGET` | **Financed** portion of rehab | financed-rehab = `rehab_budget` today (**model as its own value** — future programs may have out-of-pocket rehab) | money; keep the field distinct from rehab_budget |
| `136` | Real final purchase price | `applications.purchase_price` | money |
| `CX.EFFECTIVEPURCHASE` | Effective purchase (LTC basis) | `quote` `assignment.recognizedPrice` (seller price + financeable fee) | money; compute-only |
| `CX.ORIGINALCONTRACTPURCHASEP` | Seller/underlying contract price (assignment); else = real price | `applications.underlying_contract_price` (falls back to `purchase_price` when no assignment) | money |
| `CX.ASSIGNMENTFEE` | Assignment fee | `applications.assignment_fee` | money |
| `CX.FINANCEDINTERESTRESERVE` | Financed interest reserve $ | `quote` financed-reserve dollars (from `requested_ir_months`/`requested_ir_amount`) | money; compute-only; can be 0 |
| `4` | Term (months) | `applications.term` (text → int) | integer months |
| `78` | Maturity date | `applications.maturity_date` | date; **read from full loan (`maturityDate`)**, not pipeline |
| `388` | Origination fee % | `quote` origination % (e.g. `1.25`) | percent |
| `3` | Interest rate | `applications.rate_pct` | percent |
| `CX.TOTALCOST` | Total cost (LTC basis) | compute = effective purchase + rehab + financed reserve (+ program extras) | **no column — derive**; compute-only |
| `CX.ASISVALUE` | As-is value | `applications.as_is_value` | money |
| `356` | ARV (dollars) | `applications.arv` | money |
| `CX.ACTAULARV` | Actual ARV-LTV % (final loan ÷ ARV) | `quote` actual ARV-LTV | percent; compute-only |
| `CX.ACTAULLTC` | Actual LTC % | `quote` actual LTC | percent; compute-only |
| `CX.ACTUALINITIALLTV` | Actual initial LTV % | `applications.ltv` (stores actual acq/initial LTV) | percent |
| `CX.MAXINITIALLTV` | Program MAX initial LTV | `quote.guidelines.caps` | percent; compute-only |
| `CX.MAXARV` | Program MAX ARV-LTV | `quote.guidelines.caps` | percent; compute-only |
| `CX.MAXLTC` | Program MAX LTC | `quote.guidelines.caps` | percent; compute-only |
| `CX.TOTALEXPERIENCEDEALS` | Verified experience count used to qualify | `requested_exp_flips/holds/ground` (claimed of record) + verified track record | integer |
| `CX.DEALPROJECTTYPE` | Deal type | `applications.loan_type` / `program` | **value map — §6** |
| `CX.EXITPLAN` | Exit plan | *(no column — infer from loan_type/program; consider adding `exit_plan`)* | **value map — §6**; open item |
| `CX.REHABTYPE` | Rehab type | `applications.loan_type` (Light/Heavy Reno) / rehab-scale | **value map — §6** |
| `CX.ACCRUALTYPE` | Interest accrual basis | *(no column today)* | **value map — §6**; open item (enum needs full confirmation) |

---

## 6. Dropdown value maps (AI-reasoning: same meaning, different wording)

Encompass values observed live → our meaning. The comparison must map values, not strings.

- **`CX.DEALPROJECTTYPE`**: `Fix and Flip` → fix-and-flip; `Fix and Hold` → fix-and-hold/BRRR; `New Construction` → ground-up; `Rehab` → rehab/bridge-with-reno; (`Bridge` → bridge). Map onto our `loan_type` (RTL / ground-up / bridge).
- **`CX.EXITPLAN`**: `Sale` → sell (flip); `Refinance: Rental` / `Rent` → hold (refi/rental).
- **`CX.REHABTYPE`**: `Light Rehab` → Light Reno; `Heavy Rehab` → Heavy Reno; `Expansion` → square-footage expansion; `` (blank) → none.
- **`CX.ACCRUALTYPE`**: observed `Drawn` (interest on drawn balance). Owner states the set also includes **Note vs Drawn** and **Dutch vs non-Dutch** — **OPEN: enumerate the full picklist** (settings/enums 403'd for the API persona; owner can confirm the value list).
- **`CX.LOANTOBEVESTED`**: `Entity` → LLC/entity vesting; `Individual` → individual.

---

## 7. Part 2 — Borrower profile enrichment (the write-to-us part)

Pull *all* Encompass loans for a borrower (match the borrower across loans by name + DOB + SSN-hash), and enrich the **profile** (never a file):
- **Track record (prior deal addresses):** each Encompass loan's subject `property` address → add as a track-record / REO entry on the borrower profile (dedupe by canonical address). Enriches experience without creating a portal file.
- **LLCs used:** **`CX.LLCNAME`** (LLC name — the field the owner asked about, **found**), with `CX.LLCSTATE` (state), `CX.LLCCORP` (LLC/Corp type), `CX.LAYEREDENTITY` (layered entity → our `db/094` layered entities), `CX.LOANTOBEVESTED` (entity vs individual). Add every LLC a borrower has ever used to their entity profile (dedupe by name+state), linked via `llc_borrowers`.
- Writes ride our existing borrower/track-record/LLC write paths + audit; all additive, deduped, and reversible; never touches Encompass.

---

## 8. Findings / open questions for the owner
1. **`CX.ACCRUALTYPE` full picklist** — only `Drawn` seen live; owner says Note/Drawn + Dutch/non-Dutch. Confirm the exact values (or grant settings/enums entitlement) so we map them.
2. **Exit plan** has **no column** in our system today (inferred from program/loan_type). Add an `exit_plan` column, or keep it inferred? (Recommend a column so the compare is exact.)
3. **`CX.ACCRUALTYPE`** likewise has no column — add one if we want to compare/store it.
4. Middle name / suffix have no home in our schema — drop, or add columns?
5. **Computed outputs live in `product_registrations.quote` JSONB**, so several compares require a current registration to exist. Un-registered files can only compare inputs — is that acceptable (compare what we can, flag the rest as "not yet priced")?
6. Fields present in Encompass with **no clear match** in our system (candidate "unmatched" findings): `CX.PITIA`, `CX.RTLCASHTOCLOSEESTIMAT`, `CX.RTLDOWNPAYMENT`, `CX.MIDDLESCORE` (credit — PII), `CX.TABLEFUNDER`, `CX.CROSSCOLLATERALIZEDFLAG`, `CX.MULTIPROPERTYFLAG` — flag for owner triage.

---

## 9. Phased build plan (each work order behind the two-audit gate)

**Part 1 — read-only file sync + term-sheet gate**
- **WO-A** Expand `encompass-field-map.js` into the full registry above (identity + economics), each `direction:'pull'`, with the §6 value maps and per-field format/tolerance. (Pure data map — no network, low risk.)
- **WO-B** Reconcile service: activate `reconcileEncompass()` over the pulled loan + the file's inputs and current `quote`; produce a **findings set** (ours/theirs/severity) persisted per application; add the immediate pull at `loan-number` set.
- **WO-C** Endpoints `/api/staff/applications/:id/encompass/{status,findings,refresh,replace}` — read-only pull + findings; `replace` writes only our column (admin-gated, audited, SSN/DOB via chokepoints).
- **WO-D** `EncompassSyncPanel.jsx` + `sec-encompass` Section in `StaffApplication.jsx` — loan-number entry, per-field ours/theirs, "replace" buttons, a clear/blocked findings summary.
- **WO-E** Term-sheet gate: block term-sheet issuance while Encompass findings are open (a new gate in the term-sheet path, mirroring `signOffGate`), with an admin override + audit.

**Part 2 — borrower-profile enrichment**
- **WO-F** Per-borrower Encompass loan discovery (pipeline by borrower identity) + track-record address enrichment (deduped, additive, audited).
- **WO-G** LLC enrichment from `CX.LLCNAME`/`CX.LLCSTATE`/`CX.LLCCORP`/`CX.LAYEREDENTITY` into the entity profile (`llcs`/`llc_borrowers`, deduped).

Sequence: WO-A → B → C → D → E, then F → G. Ship and audit one at a time.

---

*Read-only research/spec. Verified by GET/pipeline reads only; nothing written to Encompass; no borrower PII or raw loan JSON in this repository.*
