# Encompass Fix-and-Flip — Master Field Mapping (Live-Verified)

**Date:** 2026-07-26 · **Status:** RESEARCH / MASTER MAPPING — verified by **read-only** pulls against the live Encompass instance **BE11397907**. No write of any kind was made to Encompass; no loan JSON or borrower PII is stored in this repo (raw pulls stayed in an ephemeral scratchpad and were discarded). Example values below are deal economics with all borrower identifiers (names, addresses, loan numbers, exact credit scores) removed.

> **READ-ONLY, FOREVER — reaffirmed (owner-directed).** PILOT ↔ Encompass is one-way. PILOT never PATCHes a loan, advances a milestone, updates a field, uploads to eFolder, creates or deletes anything. This is already enforced structurally on `main` in `src/lib/integrations/encompass.js`: only READ helpers are exported, a path guard blocks the OAuth namespace on GETs, and `_fetchGuarded` refuses every non-GET verb except the two read-shaped POSTs (OAuth token + pipeline search). This document does not change that — it only maps what we can READ.

**Sibling docs:** `ENCOMPASS-DATA-MAPPING.md` (the shipped mapping proposal on `main`) · `ENCOMPASS-API-REFERENCE.md` (shipped API notes) · `src/lib/integrations/encompass-field-map.js` (the shipped 9-field registry this document verifies and expands) · research corpus in `encompass-research/` (incl. `analysis/encompass-live-customfield-catalog.md` — the full 855-field schema dump).

---

## 1. How a fix-and-flip file is identified

YS Capital runs several products out of one Encompass instance (fix-and-flip, BRRR/fix-to-rent, and DSCR rentals). **Loan Type is `Conventional` for all of them** — the product is *not* in the standard loan-type field. A file is a fix-and-flip when:

| Signal | Field | Fix-and-flip value |
|---|---|---|
| Program name | `loanProgramName` (standard) | **`Fix & Flip Purchase + reno`** |
| Deal type | `CX.DEALPROJECTTYPE` | **`Fix and Flip`** |
| Exit plan | `CX.EXITPLAN` | `Sale` (flip) · `Refinance: Rental` or `Rent` (BRRR / fix-to-rent) |
| Has a rehab | `CX.REHABBUDGET` > 0 | e.g. `120000` |

The cleanest programmatic filter is a **pipeline search** on `Fields.CX.REHABBUDGET > 0` (confirmed working live), then read each loan and branch on `CX.EXITPLAN` for flip vs. BRRR. Loans with `CX.REHABBUDGET = 0` and a `CX.DSCRLTV` / `CX.PPPTYPE` populated are the DSCR rentals — out of scope here.

---

## 2. How to READ Encompass (mechanics confirmed live)

Three access shapes, all read-only:

1. **Full loan** — `GET /encompass/v3/loans/{guid}`. Returns the loan **contract**: ~181 top-level standard entities (`applications[]`, `property`, `milestones[]`, `funding`, `rateLock`, scalar fields like `baseLoanAmount`) **plus a `customFields[]` array**. Custom-field values live under the key **`value`** with a **`format`** tag (`DECIMAL_2`, `DECIMAL_4`, `STRING`, `DROPDOWNLIST`, `DATE`, `YN`, `INTEGER`, `X`). ⚠️ They are **not** under `stringValue`/`numericValue` — reading the wrong key returns nothing.
2. **Find loans** — `POST /encompass/v3/loanPipeline` (read-shaped). A **single** filter term must use the *simple* form `{canonicalName, matchType, value}` (an `operator`+one-`term` list is rejected 400). **Custom fields in the pipeline require the `Fields.` prefix** (`Fields.CX.REHABBUDGET`) in both `filter` and `fields` — a bare `CX.REHABBUDGET` errors 409 "Invalid canonical name," and the pipeline does **not** return custom values without the prefix. `sortOrder` is top-level, `order` is PascalCase (`Descending`). Paginate with `?limit=N&start=M`.
3. **Field catalog** — `GET /encompass/v3/settings/loan/customFields` returned all **855** tenant custom fields (id + description). Used to build `analysis/encompass-live-customfield-catalog.md`.

**Access gaps observed (service persona `admin`):** `GET /settings/loan/folders` and `GET /settings/loan/milestones` returned **403** — the API service persona lacks those settings entitlements. Loan reads, pipeline, and `customFields` all worked (200). To pull the tenant's milestone list and folder list (needed to map lifecycle), the super-admin must grant those settings-read entitlements to the API user (see §9).

---

## 3. Standard-field map (the loan contract scalars)

These come straight off the V3 loan object (no custom fields). Illustrative values from a live flip file, identifiers removed:

| Portal concept | Encompass standard field | Example | Notes |
|---|---|---|---|
| Program | `loanProgramName` | `Fix & Flip Purchase + reno` | primary product signal |
| Loan amount (total) | `baseLoanAmount` / `borrowerRequestedLoanAmount` | `525450` | total facility incl. financed rehab |
| Purchase price (effective) | `purchasePriceAmount` | `450500` | the *effective* price; see assignment §5.6 |
| **ARV (dollars)** | `propertyAppraisedValueAmount` | `750000` | **the after-repair value in $** — see the ARV nuance §5.2 |
| Term | `loanAmortizationTermMonths` | `12` | RTL is short-term |
| Amortization | `loanAmortizationType` | `Fixed` | interest-only in practice |
| Note rate | `requestedInterestRatePercent` | `8.0` | |
| Maturity | `maturityDate` | `2027-06-22` | |
| Milestone (current) | `milestoneCurrentName` | `LO Prep` | tenant milestone name |
| Stage | `milestoneStage` | `PREQUAL` | |
| Occupancy | `occupancyType` | `NonOwnerOccupied` | always, for investor RTL |
| Channel | `channel` | `Brokered` | also `Correspondent` (Corr* folders) |
| Property | `property.streetAddress/city/state/postalCode` | — | PII — pull per governance §8 |
| Units | `property.financedNumberOfUnits` | `2` | |

---

## 4. Correcting the shipped 9-field registry

`src/lib/integrations/encompass-field-map.js` was authored before instance access; four of its entries need correction against the live data:

| Registry key | Shipped guess | **Live-verified** | Fix |
|---|---|---|---|
| `arv` | `CX.ARV` (verified:false) | **`CX.ARV` does not exist.** ARV$ = `propertyAppraisedValueAmount`; ARV-LTV% = `CX.ACTAULARV` | split into ARV-dollars (standard) + ARV-LTV-percent (custom) |
| `rehab_budget` | `CX.REHAB_BUDGET` (verified:false) | **`CX.REHABBUDGET`** (+ `CX.FINANCEDREHABBUDGET`) | rename to the real id |
| `fico` | `1420` / `CX.FICO` (verified:false) | **`CX.MIDDLESCORE`**, `CX.PAIR1.BORROWER.FICO`, `CX.MIDHIGHERSCOREBORRCOBORR` | tenant custom, not std 1420 |
| `as_is_value` | `356` "Appraised Value" (verified:true) | **`356`/`propertyAppraisedValueAmount` is the ARV**, not as-is. As-is value = **`CX.ASISVALUE`** | correct the semantics — 356 is after-repair here |
| `purchase_price` | `136` | live shows `purchasePriceAmount` = *effective* price; original contract = `CX.ORIGINALCONTRACTPURCHASEP` | disambiguate effective vs. contract |

The verified standard ids that hold up: `loan_amount` → `1109`/`baseLoanAmount`, `note_rate` → `requestedInterestRatePercent`, `ys_loan_number` → `364`/`loanNumber`. For `property_type` the shipped registry uses standard id **`1041`** (keep it); the tenant **also** carries a `CX.PROPERTYTYPE` custom field (e.g. `2-4 Family`) observed on flip files — prefer the standard `1041`, treat `CX.PROPERTYTYPE` as the tenant alternative/cross-check.

---

## 5. The fix-and-flip custom-field master map

Grouped by domain. Format tag in brackets. Example values are illustrative deal economics (no identifiers). "Portal counterpart" points at where PILOT already holds the same concept.

### 5.1 Identity / program
| Field | Desc | Example | Portal counterpart |
|---|---|---|---|
| `CX.DEALPROJECTTYPE` [DROPDOWN] | Deal / project type | `Fix and Flip` | `applications.loan_type` (RTL) |
| `CX.EXITPLAN` [DROPDOWN] | Exit plan | `Sale` / `Refinance: Rental` / `Rent` | exit strategy |
| `CX.LOANTOBEVESTED` [DROPDOWN] | Vesting | `Entity` | `llcs` / vesting |
| `CX.PROPERTYTYPE` [DROPDOWN] | Property type | `2-4 Family` | `applications.property_type` |
| `CX.LOAN.FOLDER.CURRENT` [STRING] | Current folder | `Pipeline` | pipeline stage mirror |

### 5.2 Valuation (the ARV nuance)
`propertyAppraisedValueAmount` (standard) = **ARV in dollars**. `CX.ACTAULARV` = the **loan-to-ARV percent** the deal actually hits; `CX.MAXARV` = the **tier cap** on that percent. `CX.ASISVALUE` = current as-is value. Do not conflate the dollar ARV with the ARV-LTV percent — they are different fields.

| Field | Desc | Example |
|---|---|---|
| `propertyAppraisedValueAmount` (std) | **ARV — dollars** | `750000` |
| `CX.ASISVALUE` [DECIMAL_2] | As-is value | `500000` |
| `CX.LOWEROFASISVALUEANDPURCHA` [STRING] | Lower of as-is & purchase | `450500.00` |
| `CX.ACTAULARV` [DECIMAL_4] | **Actual ARV-LTV %** | `70.06` |
| `CX.MAXARV` [DECIMAL_4] | Max ARV-LTV % (tier cap) | `75.0` |
| `CX.TOTALVALUEINCREASE` [DECIMAL_2] | Target value (ARV) | `750000` |

### 5.3 Rehab / construction
| Field | Desc | Example |
|---|---|---|
| `CX.REHABBUDGET` [DECIMAL_2] | Rehab budget | `120000` |
| `CX.FINANCEDREHABBUDGET` [DECIMAL_2] | Financed rehab | `120000` |
| `CX.OUTOFPOCKETREHAB` [DECIMAL_2] | Out-of-pocket rehab | `0` |
| `CX.REHABTYPE` [DROPDOWN] | Rehab type | `Light Rehab` |
| `CX.PRE-REHABSQFT` / `CX.POST-REHABSQFT` [STRING] | Sq ft before/after | `1,056` |

### 5.4 Sizing / leverage (the caps engine)
| Field | Desc | Example |
|---|---|---|
| `CX.MAXTOTALLOAN` [DECIMAL_2] | Max total loan | `525450` |
| `CX.MAXINITIALLOAN` / `CX.FINALINITIALLOAN` [DECIMAL_2] | Max/final initial advance | `405450` |
| `CX.MAXLOANBYARVLTV` [DECIMAL_2] | Max loan by ARV-LTV | `562500` |
| `CX.MAXLOANBYLTC` [DECIMAL_2] | Max loan by LTC | `527712.5` |
| `CX.ACTUALINITIALLTV` / `CX.MAXINITIALLTV` [DECIMAL_4] | Initial LTV % (actual/cap) | `90.0` |
| `CX.ACTAULLTC` / `CX.MAXLTC` [DECIMAL_4] | LTC % (actual/cap) | `92.1034` / `92.5` |

### 5.5 Cost & cash-to-close
| Field | Desc | Example |
|---|---|---|
| `CX.TOTALCOST` [DECIMAL_2] | Total project cost (purchase + rehab) | `570500` |
| `CX.RTLDOWNPAYMENT` [DECIMAL_2] | Down payment | `45050` |
| `CX.RTLCASHTOCLOSEESTIMAT` [DECIMAL_2] | Est. cash to close | `56654.5` |
| `CX.RTLRESERVEOFLOAN` / `CX.RTLRESERVEDOLLAR` [DECIMAL_2] | Interest reserve ($) | `26272.5` |
| `CX.RTLPERRESERVEOFLOAN` [DECIMAL_4] | Reserve % of loan | `5.0` |
| `CX.TOTALLIQUIDITY` [DECIMAL_2] | Liquidity | `82927` |
| `CX.PITIA` [DECIMAL] | PITIA | — |

### 5.6 Interest / accrual
| Field | Desc | Example |
|---|---|---|
| `CX.FIXANDFLIPINITIALMONTHLYI` [DECIMAL_2] | Initial monthly interest | `2703` |
| `CX.ACCRUALTYPE` [DROPDOWN] | Accrual basis | `Drawn` (interest on drawn balance) |
| `CX.PPPTYPE` / `CX.PPPTERM` [DROPDOWN] | Prepay penalty (DSCR/rental) | `Soft Declining` / `3 Year` |

### 5.7 Assignment fee — **direct cross-check with the portal's frozen engine**
The Encompass file computes the assignment fee on the **same rule PILOT froze**: financeable fee = lesser of **15%** of the **original (seller) contract price** and **$75,000**; the effective purchase price is seller price + financeable fee.

| Field | Desc | Example |
|---|---|---|
| `CX.ORIGINALCONTRACTPURCHASEP` [DECIMAL_2] | Seller/original contract price (the 15% basis) | `425000` |
| `CX.EFFECTIVEPURCHASE` [DECIMAL_2] | Effective purchase price | `450500` |
| `CX.ASSIGNMENTFEE` / `CX.ASSIGNMENTALLOWED` [DECIMAL_2] | Assignment fee / financeable | `25500` |
| `CX.MAXASSIGNMENT` [DECIMAL_4] | Cap % | `15.0` |
| `CX.MAXASSIGNMEN$` [DECIMAL_2] | Cap $ | `75000` |

This is a **high-value reconciliation surface**: PILOT's frozen pricing engine and the Encompass file should agree on effective price, financeable fee, LTC, ARV-LTV, reserve %, and initial LTV. A mismatch beyond a cent tolerance is a review signal (never an auto-adopt, never a hard block on its own — per the read-only doctrine).

### 5.8 Experience & credit
| Field | Desc | Example |
|---|---|---|
| `CX.NUMBEROFFIXANDFLIPS` [INT] | Flips done | `10` |
| `CX.BRRRS` [INT] | Fix-and-holds / BRRRs | `3` |
| `CX.TOTALEXPERIENCEDEALS` [INT] | Total deals | `10` |
| `CX.BORROWERINTERNALPROJECT` [STRING] | Internal projects exited | `5` |
| `CX.REPEATBORROWER` [DROPDOWN] | Repeat borrower | `YES` |
| `CX.MIDDLESCORE` / `CX.PAIR1.BORROWER.FICO` [INT/STRING] | Credit score (**PII**) | `7XX` |

These map onto PILOT's borrower track record / experience tier and the credit-report condition — a strong enrichment + cross-check source.

### 5.9 Capital partner — **INTERNAL ONLY, NEVER borrower-facing**
`CX.CAPITALPROVIDER`, `CX.WHICHINVESTOR`, `CX.INVESTORPROGRAMNAME`, `CX.SUBMITEDTOINVESTOR`, `CX.CONFIRMPITIMATCHINVEST` hold the **note-buyer / capital-partner identity**. Per the standing rule (CLAUDE.md), a capital-partner name must **never** appear on any borrower-facing surface. If pulled, these are staff-only, and borrower-facing copy stays "Gold Standard program." (Specific partner names are redacted from this doc.)

### 5.10 Flags / misc
`CX.CROSSCOLLATERALIZEDFLAG`, `CX.MULTIPROPERTYFLAG`, `CX.TABLEFUNDER`, `CX.APPRAISALTYPE` (e.g. `1004`), `CX.ASSETS`, `CX.RESERVES`.

---

## 6. Milestones & lifecycle (partial — persona-limited)
Observed on live files: `milestoneCurrentName = "LO Prep"`, `milestoneStage = "PREQUAL"`. The full ordered milestone list needs `GET /settings/loan/milestones`, which **403'd** for the API persona. The loan object also carries `milestones[]`, `milestoneCurrentDate`, `milestoneNextName`, `milestoneCompletedDueDate`, `milestoneFundedDueDate` — readable per-loan even without the settings catalog. **Do not hardcode milestone names** (they are tenant-configured); map them from config once the settings entitlement is granted.

---

## 7. The reconciliation opportunity (what this unlocks, read-only)
Because the Encompass file runs the **same deal math PILOT already computes**, the highest-value Phase-1 uses are pure cross-checks (advisory, never a write, never an auto-clear):
1. **Economics reconciliation** — effective price, loan amount, ARV-LTV, LTC, reserve %, assignment fee: portal vs. Encompass, flag drift.
2. **Experience cross-check** — `CX.NUMBEROFFIXANDFLIPS`/`CX.BRRRS` vs. PILOT's verified track record.
3. **Lifecycle mirror** — milestone/stage surfaced next to the portal stage.
4. **Enrichment** — as-is/ARV/rehab/credit populate or corroborate the borrower + deal profile.
All consistent with the shipped `encompass-field-map.js` stance: `authoritative = 'pilot'`, `blocksCtc/blocksFunding = false` — Encompass is a **cross-check copy**, a mismatch is a review item, never a value PILOT silently adopts.

---

## 8. Data governance for the pull (fields to EXCLUDE)
- **Staff/user metadata — DO NOT pull:** `CX.CURRENTUSER.*` (the logged-in user's cell, email, NMLS, persona), `CX.KM.*` (HUD-counselor / knowledge-management system fields), `CX.TODAYS.DATE`, `CX.*TOUCHES*` (telemetry). These are not borrower data.
- **Capital-partner names — staff-only, never borrower-facing** (§5.9).
- **PII minimization** — credit scores and SSNs are sensitive; follow the existing no-SSN/DOB-at-launch stance and PILOT's PII guards. Store the minimum needed for cross-check; never render partner names or raw scores to borrowers.
- **Raw loan JSON stays out of the repo** — snapshots belong in the DB per the shipped `db/247_encompass_loan_snapshot.sql`, not in source.

---

## 9. Open items / next reads
1. **Grant the API persona settings entitlements** so `GET /settings/loan/folders` and `/milestones` succeed (currently 403) — needed to map the folder pipeline and the ordered milestone list.
2. **Enum/picklist values** for `CX.REHABTYPE`, `CX.EXITPLAN`, `CX.DEALPROJECTTYPE`, `CX.LOANTOBEVESTED`, `CX.ACCRUALTYPE` — pull `GET /settings/loan/enums` (persona permitting) to lock the allowed sets.
3. **Co-borrower / borrower-pair FICO fields** — confirm `CX.PAIR1.*` / `CX.PAIRS16` semantics across pairs.
4. **Reconcile this map into `encompass-field-map.js`** on a build turn (owner go-ahead) — apply the §4 corrections and add the §5 fix-and-flip fields, all `direction:'pull'`, `authoritative:'pilot'`, `blocksCtc/Funding:false`.
5. **Rotate the client secret** shared in chat before any production wiring — treat as burned.

---

*Read-only research. Verified against instance BE11397907 by GET/pipeline-search reads only; nothing was written to Encompass, and no borrower PII or raw loan file is stored in this repository.*
