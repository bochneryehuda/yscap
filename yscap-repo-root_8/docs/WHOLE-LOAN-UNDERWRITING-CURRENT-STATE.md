# Whole-Loan Underwriting — Current-State Architecture Inventory

**Purpose.** Document the CURRENT loan-structure data flow so a "Whole-Loan Underwriting Context"
engine can be built ON TOP (consolidating program + structure + appraisal + documents + external
systems into one authoritative, versioned, provenance-tagged underwriting decision) **without
duplicating or breaking anything**.

**Hard rule carried into this doc:** the pricing/guideline engines
(`web/tools/standard-program.js`, `web/tools/gold-standard.js`, `web/tools/title-cost.js`,
`web/tools/termsheet.js`, `src/lib/pricing.js`, `src/lib/rehab-budget.js`, `src/lib/liquidity.js`)
are FROZEN. This inventory is read-only; nothing here changes a frozen number. Read-only
investigation, dated 2026-07-22.

---

## 0. TL;DR — the biggest gaps

1. **MANUAL is signable (CRITICAL).** The term-sheet / Iska DocuSign package send is gated ONLY by
   `esignSendGate` (`src/lib/esign/gate.js:24`), invoked server-side from
   `src/lib/esign/orchestrate.js:877`. That gate checks appraisal-back + appraisal-review + P&P
   condition re-signed-after-appraisal. It **never consults the registered product's `status`
   (`MANUAL`) nor an open `manual_program_escalations` row**. A `MANUAL` / Manual-Program
   registration whose `rtl_p1_product` condition is signed off after the appraisal will pass the
   gate and issue a signable term sheet — even while its super-admin escalation is still pending.
   The **borrower "terms ready" email** IS correctly withheld (`needsSuperAdminApproval`,
   `staff.js:1766/1970`; released on approval only at `admin-manual-programs.js:97`), but the
   **binding e-sign package is not**.

2. **No single "issuability" predicate exists.** Issuability is decided by whichever surface is
   exporting: the e-sign gate (above), and the register routes' `quote.eligible`
   (`ev.status !== 'INELIGIBLE'`, `pricing.js:313`). There is no shared "is this file ready to issue
   binding terms?" function that a new engine could call, and none of the export paths join
   `product_registrations.status` / `.stale` / `manual_program_escalations`.

3. **`file-view.js` loads a thin slice.** It loads ~16 application columns + the current
   registration's sizing/caps, and deliberately omits the entire loan-structure/underwriting context
   list (loan purpose/refi type, payoff, existing debt, cash-out proceeds, rate/term,
   interest-reserve amount+months, heavy-rehab triggers, sqft addition, costs paid, verified hard
   costs, closing-cost treatment, program status/manual approval, registration stale, term-sheet
   version, note buyer, exception approvals). Full gap list in §7.

---

## 1. Sources of loan-structure data

| File | Role | Owns / produces |
|---|---|---|
| `src/lib/pricing.js` | Server wrapper over the FROZEN engines. `buildInputs()` maps an `applications` row → engine input; `quoteProgram/quoteAll` run YSP/GSP; `normalize()` shapes the quote; `econVersionFor()` fingerprints the file-owned pricing basis for optimistic concurrency. | The canonical **engine input set** and the **normalized quote** (sizing, caps, closing costs, reserves, liquidity). |
| `web/tools/standard-program.js` (`YSP`) | FROZEN Standard/Fidelis engine. `evaluate(input)` → `{status, reasons, tier, noteRate, sizing, caps, assignment, …}`; `sizeLoan` waterfall; `priceLadder`. | Authoritative Standard + **Manual-program** numbers (manual prices on this engine). |
| `web/tools/gold-standard.js` (`GSP`) | FROZEN Gold engine, same shape. Gold reno reserve = 0 (frozen). | Authoritative Gold numbers. |
| `src/lib/manual-program.js` | NON-frozen. Detects a structural override (`STRUCTURAL_OVERRIDE_KEYS` = `ovrAcqLTV/ovrARLTV/ovrLTC` ±Pct), resolves program → `'manual'`, defines `needsSuperAdminApproval`, owns `manual_program_settings` + the `manual_program_escalations` queue. | Program classification + escalation/approval workflow. |
| `src/lib/product-registration.js` | Persists a registration (`persistProductRegistration`), writes back to `applications`, builds the borrower terms email, computes `borrowerTermsKey` (economics-changed detector). | The **registration row + write-back**. |
| `src/lib/liquidity.js` | Writes the cash-to-close + reserve breakdown into the dynamic `rtl_p3_assets` condition; reopens it when required liquidity increases. Bank-statement months: Standard 1 / Gold 2 / Manual = stated. | Liquidity condition + reopen trigger. |

Property-type normalization (`normPropertyType`, `pricing.js:75`) and strategy normalization
(`engineStrategy`, `pricing.js:59`) sit in `pricing.js` and guard the frozen engines from
mis-classification — a new engine must reuse them, not re-implement.

---

## 2. Every field consumed by Standard + Gold pricing

`buildInputs(app, experience, overrides)` (`pricing.js:109`) is the single input builder for both
engines. The engine input object (verified against `standard-program.js:405-573` and
`sizeLoan`/`evaluate`) consumes:

**From `applications` (+ joined `borrowers.fico`, `property_address` jsonb):**
- `loan_type` → `loanType` (Purchase/Refinance) + `cashOut` (loan_type contains "cash")
- `program` / `loan_type` → `strategy` (Fix&Flip / Fix&Hold BRRRR / Ground-up / Bridge)
- `property_address.state/city/line1` → `state`, `city`, `address`
- `property_type` → `propertyType` (normalized; ineligible-type guard `pricing.js:198`)
- `units`
- `purchase_price` → `purchasePrice` (on assignment: `underlying_contract_price + assignment_fee`)
- `is_assignment`, `underlying_contract_price` → `isAssignment`, `sellerPrice`
- `assignment_fee` (feeds `purchasePrice` on assignment)
- `as_is_value` → `asIsValue` (**defaults to purchase price when blank**, `pricing.js:136`)
- `arv`
- `rehab_budget` → `rehabBudget`
- `fico` (computed onto `f.app` by `loadFileForPricing`; = borrower FICO)
- `requested_exp_flips/holds/ground` → `expFlips/expHolds/expGround` (CLAIMED experience of record)
- `term` (parsed to months, `parseTermMonths`)
- `requested_ir_months` → `irMonths`
- `requested_ir_amount` → `irAmount` (exact-dollar reserve; > 0 wins over months)
- `rehab_type` → `heavyRehab` (`/heavy|gut|ground/`), `sqftAddition` (`/square|sf|addition|ground/`)
- `sqft_pre`, `sqft_post` → `sqftAddition` (post > pre)
- `file_markup_std_pct`, `file_markup_gold_pct` → sticky per-file markup

**Staff/admin overrides (`pricing.js` NUMK/STRK/BOOLK, lines 169-176)** — win last:
`ovrAcqLTV(Pct)`, `ovrARLTV(Pct)`, `ovrLTC(Pct)`, `ovrRate(Pct)`, `ovrIrMonths`, `ovrEffPrice`
(assignment effective-price exception), `markupStdPct/GoldPct`, `origStdPct/GoldPct`,
`lenderFee/creditFee/appraisalFee/titleFee`, `targetLTC`, `forcePrice/manualPricing`, plus any
STRK/NUMK field re-typed in the studio.

**Deliberately NOT written back after register** (owner-owned): `purchase_price`, `as_is_value`
(`product-registration.js:141-147`).

**Quote output** (`normalize`, `pricing.js:239`): `status`, `eligible (status!==INELIGIBLE)`,
`reasons[{level,msg}]`, `tier/tierLabel`, `noteRate`, `sizing{totalLoan, initialAdvance,
rehabHoldback, financedReserve, downPayment, assignmentExcessOOP, monthlyPayment, ltcPct, acqLtvPct,
arvPct, costBasis, binding}`, `caps{maxLoan,minFico,maxAcqLtv,maxArvLtv,maxLtc}`, `title`,
`closingCosts{origination,lenderFee,creditFee,titleAndSettlement,extraFees,dueAtClosing,appraisalPoc}`,
`cashToClose`, `reserveRequirement/reserveBasis/reserveMonths`, `liquidityRequired`, `assignment`,
`ladder`, `guidelines`, `adminPricing`. Reported loan floored to whole dollars and reconciled to
the penny (`pricing.js:256-261`, frozen policy).

---

## 3. Every value persisted in a product registration

`persistProductRegistration` (`product-registration.js:99`).

**`product_registrations` columns** (INSERT `product-registration.js:113`):
`application_id, program, product_label, status, note_rate, total_loan, target_ltc, inputs (jsonb),
quote (jsonb), is_current, registered_by, is_manual, asset_months`. Plus `stale`, `stale_reason`
(db/096; cleared on the fresh row at `product-registration.js:204`). Manual escalations carry
`asset_months`.

- `inputs` jsonb = the full `buildInputs` output + studio overrides (idempotent write-back basis).
- `quote` jsonb = the full normalized quote (sizing, caps, closing costs, reserves — `file-view.js`
  reads `quote.sizing` + `quote.caps`).

**Prior current registration is superseded** (`is_current=false`, `product-registration.js:112`);
`borrowerTermsKey` (`:81`) compares old vs new headline numbers → `economicsChanged`.

---

## 4. Every value written back to `applications`

Central write-back is the single `UPDATE applications` at `product-registration.js:150-195`:
`loan_amount, rate_pct, ltv, requested_exp_flips/holds/ground (GREATEST — never lowers the claim),
rehab_budget, term, requested_ir_months, arv, is_assignment,
underlying_contract_price/assignment_fee (only when assignment), desired_rate (text mirror of rate),
requested_ir_amount`. NOT written: `purchase_price`, `as_is_value`.

Other `UPDATE applications` write-back paths (grep results):
- `staff.js:1826/1828` — sticky per-file markup (`file_markup_std_pct/gold_pct`).
- `appraisal/import.js:186/189/194` — blank-fill only: `as_is_value`, `arv`, `appraiser_name`
  (`WHERE ... IS NULL`, DEFINITE values only).
- `appraisal/desk.js:350/357-359` — undo of an import (revert as_is/arv/appraiser_name).
- `clickup/ingest.js`, `clickup/orchestrator.js`, `clickup/relink.js` — inbound ClickUp sync writes
  (COALESCE, never clears), guarded by DOB/sync-review machinery.
- `vesting.js` (llc_id), `status-notify.js` / `change-requests.js` / `conditions/engine.js`
  (status/condition columns).

The register write-back trips db/096's `trg_reopen_on_budget_change` (economics), which is why
`persistProductRegistration` clears `stale` on the fresh row LAST (`:204`).

---

## 5. Program status + approval workflow

**Engine status** (`quote.status`): `ELIGIBLE` | `MANUAL` | `INELIGIBLE`
(`quote.eligible = status !== 'INELIGIBLE'`, `pricing.js:313`).

**Register decision** (`staff.js:1740-1817`, mirrored `borrower.js:901`):
- `INELIGIBLE` → cannot register (engine refuses via `forcePrice` classification).
- `MANUAL` + not manual product + not `submitException` → **422 `exception_required`**
  (`staff.js:1751`). Studio must submit an exception request.
- `MANUAL` (exception submitted) OR structural override (`manual` program) → registers immediately
  but `needsEscalation = needsSuperAdminApproval({program,status})` (`manual-program.js:77`) is true
  → `openEscalation` opens a `manual_program_escalations` row (`manual-program.js:179`); borrower
  terms email withheld.
- Clean `ELIGIBLE` Standard/Gold → confirms immediately (`sendBorrowerTerms`, `staff.js:1970`).

**Escalation queue** (`manual_program_escalations`, db/207): states `pending | countered | approved |
declined`. Super-admin decides via `admin-manual-programs.js` (`decideEscalation`) or `counter`.
**On approval only** the borrower terms email is released (`admin-manual-programs.js:97-111`).
Re-registering as non-manual closes the pending row (`closePendingForApp`).

**Manual Program** = a structural LTV/LTC/ARV override only (`isManualProduct`,
`manual-program.js:58`). Rate/IR/markup/fees/`ovrEffPrice` are PRICING, never flip to manual.
Always requires super-admin approval; always requires the flood cert (db/207); requires a stated
liquidity month count (`asset_months`).

---

## 6. Underwriting calculations (`src/lib/underwriting/**`)

The frozen engines own LTV/LTC/ARV/reserve/cash-to-close **sizing**. The `underwriting/**` modules
are the document-review / risk layer that **compares documents against the priced file view** — they
do not re-price. Relevant to loan structure:

- `file-view.js` — builds the subject each doc-check compares against (see §7).
- `reasonability.js`, `risk-score.js`, `metrics.js` — leverage/exposure sanity vs. the registered
  caps (`file-view` exposes `registration.caps` + `initialAdvance` precisely so metrics check against
  the file's OWN sized caps, `file-view.js:41-67`).
- `experience.js` (+ `src/lib/experience.js`) — verified vs. claimed experience tiers; a verified
  drop below the priced tier trips the registration-fatal path from the app layer (db/096 note).
- `staleness.js`, `condition-reopen.js`, `evidence-invalidation.js` — condition lifecycle.
- `facts.js`, `tieout.js`, `reasonability.js` — cross-doc number tie-out (price, ARV, as-is).
- `structuring.js`, `verdict.js`, `certificate.js` — decision assembly (closest existing analog to
  the target "authoritative decision", but doc-review-scoped, not whole-loan).

Cash-to-close / liquidity are computed ONLY in `pricing.js normalize` + `liquidity.js` — not
duplicated in `underwriting/**`.

---

## 7. `file-view.js` — EXACTLY what it loads vs. the gap list

`loadContext(client, appId)` (`file-view.js:21`). This is the authoritative "file view" the doc
checks compare against — the natural seam a whole-loan context would extend.

**LOADS TODAY:**
- `applications`: `id, borrower_id, llc_id, property_address, purchase_price, loan_amount,
  as_is_value, arv, rehab_budget, program, property_type, units, ys_loan_number, is_assignment,
  assignment_fee, underlying_contract_price` (`file-view.js:23`).
- `borrowers`: `id, first_name, last_name, date_of_birth, current_address, prior_address, fico`
  (`:30`).
- `llcs` (vesting): `llc_name, ein`; plus all borrower LLC names for the assets view (`:35-38`).
- `product_registrations` (current): `program, total_loan, quote` → derives `initialAdvance,
  rehabHoldback, financedReserve` from `quote.sizing`, and `caps{maxAcqLtv,maxArvLtv,maxLtc}` from
  `quote.caps` (`:46-68`).

Per-doc subjects add only: `loan_type` (payoff/plans_permits/subjects), `loan_number`,
`rehab_budget`, `registered_fico`, assignment split. (`subjectFor`, `:85-152`.)

**DOES NOT LOAD (the audit gap list — confirmed absent from `loadContext` + `subjectFor`):**
- Loan purpose / refi type (only raw `loan_type` string in a few subjects; no purpose/refi
  classification, no `cashOut`)
- Payoff amount / existing debt (`first_lien`, `second_lien`, payoff statement figures)
- Cash-out proceeds
- Rate / term (`rate_pct`, `term`, `note_rate`)
- Interest-reserve amount + months (`requested_ir_amount`, `requested_ir_months`)
- Heavy-rehab triggers (`rehab_type`), sqft addition (`sqft_pre`, `sqft_post`)
- Costs already paid / verified hard costs
- Closing-cost treatment (`quote.closingCosts`, `cashToClose`, `liquidityRequired` — present in the
  registration quote but NOT surfaced by `file-view`)
- Program status / manual approval (`product_registrations.status`, `is_manual`,
  `manual_program_escalations`)
- Registration stale (`product_registrations.stale`, `stale_reason`)
- Term-sheet version (`esign_envelopes.product_version`, signed-TS condition state)
- Note buyer (`applications.lender`)
- Exception approvals (escalation decisions)

A whole-loan context should be a **superset** of `loadContext` (reuse it, add the missing columns +
the registration status/stale/escalation joins) rather than a parallel loader.

---

## 8. Appraisal fields extracted from MISMO / appraisal XML

**`src/lib/mismo/parse.js`** (inbound MISMO 3.4 → portal fields). Core loan/property:
`property_address`, `units` (`FinancedUnitCount`), `loanAmount` (`BaseLoanAmount/NoteAmount`),
`loanType` (from LoanPurpose+cashOut), borrower/co-borrower + vesting entity, and the YSCAP lender
**extension** (`parse.js:248-282`): `program, arv (AfterRepairValue), rehabBudget, rehabType, dscr,
ltv, ppp, fico, lender, channel, propertyType, sqftPre, sqftPost,
expFlips/expHolds/expGround, isAssignment, underlyingContractPrice, assignmentFee,
interestReserveMonths, interestReserveAmount, appraisedRentalValue, cdaValue, propertyTaxes,
propertyInsurance, propertyHoa, firstLien, secondLien, titleCompany, insuranceCompany, appraiserName,
actualClosingDate`.

**`src/lib/appraisal/extract.js`** (appraisal report XML/PDF → underwriting values). Returns
(`extract.js:974`): `subject{address, propertyType, yearBuilt (…:835), gla/site…}`,
`values{appraisedValue, effectiveDate, contractPrice (…:207), asIs, arv, basis,
asIsConfidence/arvConfidence/source}`, `appraiser{name, licenseExp, reportSignedDate}`, `enrich{…
occupancy_status, condo, 1004MC market-conditions, off_site, building_status}`, `comparables[]`
(each `salePrice`, `comp_set` as_is/arv), `units, income, condo, photos`, `compSplit{asIsValue,
arvValue, confidence, needsReview}`, `warnings[]`.

**Appraisal write-back** (`appraisal/import.js:186-194`): blank-fill `applications.as_is_value`,
`arv`, `appraiser_name` ONLY when currently NULL and value is DEFINITE. `desk.js` reverts on undo.
`findings.js` raises fatal `asis_mismatch` / `asis_below_price` when the appraisal disagrees with the
file. Note: `approx_appraised_value` / `actual_appraised_value` are **ClickUp pull-only** (§9), NOT
written by the appraisal importer.

---

## 9. ClickUp field registry + directions (`src/clickup/mapper.js`)

Legend (`mapper.js:8`): `both ⇄` · `push` portal→CU · `pull` CU→portal. Loan-structure-relevant
fields (`mapper.js:58-140`):

| Portal col | Dir | Notes |
|---|---|---|
| `program`, `loan_type`, `property_type`, `term`, `units` | both | |
| `occupancy`, `channel` | pull | backend-only |
| `lender` (note buyer) | **both** | was pull-only; now pushes up (`mapper.js:83`); staff-only display |
| `ltv`, `rate_pct`, `desired_rate` | **push** | portal owns pricing (§7.1); register mirrors registered rate |
| `loan_amount`, `purchase_price`, `as_is_value`, `arv`, `rehab_budget`, `rehab_type`, `dscr_ratio` | both | |
| `is_assignment`, `assignment_fee`, `underlying_contract_price` | both | |
| `original_purchase_price`, `acquisition_date` | both | |
| `approx_appraised_value`, `actual_appraised_value` | pull | informational (CU owns) |
| `actual_rate`, `property_taxes/insurance/hoa`, `rental_income`, `prepayment_penalty`, `title_company(_contact)`, `insurance_company(_contact)`, `first_lien`, `second_lien`, `appraised_rental_value`, `cda_value`, `appraiser_name`, `encompass_status`, `application_submitted`, `investor_loan_number`, `actual_closing` | pull | ClickUp owns; never echoed back |
| `ys_loan_number`, `expected_closing` | both | |
| `submitted_at` | push | |

**Source-of-truth policy:** portal owns pricing outputs (push-only ltv/rate/desired_rate); ClickUp
owns servicing/title/insurance/lien detail (pull-only); economics fields are bidirectional but
guarded — the push skips empties (never clears CU), the pull uses COALESCE (never clears portal),
dates go through `dateOnlyToClickUpEpoch`, suspicious/PII changes park in `sync_review_queue`, and a
volume circuit breaker caps writes. Full policy in CLAUDE.md ClickUp sections + `docs/CLICKUP-*`.

---

## 10. SharePoint mirror + version-control (`src/lib/sharepoint*.js`)

One-way portal→SharePoint mirror. `sharepoint.js` (Graph client, no-delete except the guarded
`deleteReplacedCorruptMirror`), `sharepoint-map.js` (fuzzy folder resolver), `sharepoint-backup.js`
(reconciler + integrity audit `verifyOnce/drainVerify` + **Version-N** shuffle,
`sharepoint-backup.js:16-20`), `sp-mirror-queue.js` / `sp-mirror-state.js` (queue/state). Integrity:
`decodeUploadBase64` chokepoint, per-upload size/QuickXorHash verify, corrupt-mirror re-sync to
`(fixed copy)`, regen-kind autosaves settle without Version-N. Term sheets mirror to
`Term Sheet/Unsigned`; a `Signed` sibling arrives with DocuSign. **Relevance to whole-loan context:**
SharePoint is a document mirror only — it holds no authoritative structure numbers and should not be
a source of truth for the new engine.

---

## 11. Encompass integration scope (`src/lib/integrations/encompass.js`)

**Confirmed GET-only + a 2-endpoint read-shaped POST allowlist.** Exports only
`{name, configured, ping, apiGet, pipelineSearch, READ_ONLY}` (`encompass.js:209`). `_fetchGuarded`
(`:57`) refuses any non-GET except the `POST_ALLOWLIST` (`:44`) = exactly `/oauth2/v1/token` +
`/encompass/v3/loanPipeline` (both return data, mutate nothing). `assertReadOnlyPath` blocks GETs
into the OAuth namespace. No `apiPost/Put/Patch/Delete`, no `updateLoan`. `encompass_status` etc.
flow **pull-only** into the portal (§9). The new engine may READ Encompass but must never treat it as
a write target.

---

## 12. Term-sheet / structure export paths + issuability conditions

| Export path | File:line | Issuability condition used | MANUAL/STALE risk |
|---|---|---|---|
| **DocuSign term-sheet / Iska package SEND** | route `staff.js:9145` → `esignOrchestrate.sendPackage` `orchestrate.js:860` → gate `orchestrate.js:877` → `esignSendGate` `gate.js:24` | appraisal-back **AND** appraisal-review **AND** `rtl_p1_product` satisfied + signed-off ≥ appraisal-back time. **NO status/escalation/stale check.** | **YES — MANUAL & pending-escalation & stale registrations pass.** THE gate to fix. |
| Borrower "terms ready" email | `staff.js:1970`, `borrower.js:1018`, released `admin-manual-programs.js:106` | `economicsChanged && !needsEscalation` (withheld for MANUAL until super-admin approval) | Correct — MANUAL blocked |
| Register (both routes) | `staff.js:1751`, `borrower.js:901` | `quote.status==='MANUAL'` → 422 unless exception submitted; `INELIGIBLE` refused by engine | Correct at register time |
| Registered term-sheet PDF saved as doc | `staff.js:7411/7432`, `borrower.js:2470/2495` | none — supersedes prior `term_sheet` doc; no status gate (it's a record of whatever was registered) | Saves a MANUAL sheet as a doc (record only, not "issued") |
| TPR / investor file export (XLSX/ZIP) | `src/lib/tpr-export.js` | none tied to program status; packages current docs + registered terms; `visibility='internal'` excludes buyer packages | Would include a MANUAL/stale registration's terms if present |
| Pipeline XLSX | `staff.js:263` | none (list export) | n/a |
| Sitewire draw XLSX exports | `sitewire.js:1210/1812/1833/2350` | post-funding, draw-scoped | n/a to term issuance |

**Investor-structure / term-sheet issuability is decided ENTIRELY by `esignSendGate`, and that gate
does not know about `MANUAL`.** No export path joins `product_registrations.status`, `.stale`, or an
open `manual_program_escalations` row. There is no `status !== 'INELIGIBLE'` gate on the e-sign send
path — that check lives only in the quote (`pricing.js:313`) and the register routes, neither of
which is re-checked at send time.

**Recommended fix location (for the main session):** extend `esignSendGate`
(`src/lib/esign/gate.js:24-63`) — the single server-side re-checked chokepoint at
`orchestrate.js:877` — to additionally require the current `product_registrations` row to be
`status <> 'MANUAL'` AND `NOT stale` AND have no OPEN `manual_program_escalations` row (reuse
`manual-program.needsSuperAdminApproval` + `pendingForApp`). This is a NON-frozen file; no pricing
number changes. Add the same status/stale/escalation check to `tpr-export.js` selection before a
registered term is packaged.

---

## 13. Registration-stale / condition-reopen triggers

| Trigger | Where | Fires when | Effect |
|---|---|---|---|
| `trg_reopen_on_budget_change` (fn `reopen_conditions_on_budget_change`) | db/071 → broadened db/072 → db/096 → db/126 (fico/full-inputs). AFTER UPDATE on `applications`. | Any pricing input `IS DISTINCT FROM` old: `loan_amount, purchase_price, as_is_value, arv, loan_type, program, property_type, units, requested_ir_months, requested_ir_amount, is_assignment, underlying_contract_price, assignment_fee, requested_exp_*, rehab_budget` (+ fico/full inputs in db/126) | (1) current `product_registrations.stale=true`, `stale_reason` (db/096:49); (2) `product_pricing` condition → `received`, sign-off cleared; (3) `rtl_cond_signedts` signed-TS → `outstanding`, cleared (db/096:68); (4) on budget change only, `rehab_budget`/SOW condition → `issue` |
| Register clears stale on the fresh row | `product-registration.js:204` | end of `persistProductRegistration` | Fresh registration not flagged by its own write-back |
| Register reopens P&P condition | `staff.js:1909-1915` | every (re-)register | `product_pricing` → `received`, cleared |
| Experience-drop fatality | `src/lib/experience.js` (app layer; table change can't fire the SQL trigger) | verified experience drops below what the registration priced | flags registration stale/fatal |
| Liquidity reopen | `liquidity.js:130` (`syncLiquidityCondition`) | first concrete requirement OR required liquidity increased >$0.50 vs last | `rtl_p3_assets` → `outstanding`, sign-off cleared |
| Gold/Blue-Lake 5% SOW contingency reopen | `rehab-budget.js` `enforceSowContingency`, called `staff.js:1927` | register Gold/Blue-Lake without 5% contingency | `rehab_budget` condition reopened FATAL |
| Appraisal-fatal reopen | db/155 | appraisal review fatal | reopens appraisal review condition |
| SOW budget guard (belt-and-suspenders) | db/069 (`trg_sow_budget_guard`), db/192 | write flipping budget condition to satisfied without start=lineitem=budget | refuses the write |

Stale flags: `product_registrations.stale` / `.stale_reason` (db/096). `is_current AND NOT stale` is
the correct "live registration" predicate the new engine should use (the experience-drop guard
already relies on it — see `product-registration.js:200-203`).

---

## 14. Source-of-truth matrix (loan-structure fields)

`APP` = `applications` form, `ENG` = frozen engine (derived), `REG` = `product_registrations`,
`CU` = ClickUp, `APPR` = appraisal, `ENC` = Encompass (read-only).

| Field | Held in | Should govern (proposed) |
|---|---|---|
| Purchase price | APP; CU(both); (ENG derives effective on assignment) | APP (owner-entered; never written back) |
| As-is value | APP (defaults to purchase when blank); CU(both); APPR(blank-fill) | APP, appraisal-verified at review |
| ARV | APP; CU(both); APPR(blank-fill) | APP, appraisal-verified |
| Rehab budget | APP; REG(write-back); CU(both); SOW condition | APP = frozen budget; SOW must equal exactly |
| Loan amount | ENG(sized) → REG.total_loan → APP.loan_amount(write-back); CU(both) | ENG/REG (authoritative sized figure) |
| Note rate | ENG → REG.note_rate → APP.rate_pct/desired_rate(push) | ENG/REG |
| Program | APP; REG; resolved to `manual` by override; CU(both) | REG (registered program), then APP |
| Program status (ELIGIBLE/MANUAL) | ENG quote.status → REG.status | REG.status + escalation decision |
| Term | APP.term; REG; CU(both) | APP → REG on register |
| Interest reserve (months/amount) | APP.requested_ir_months/amount → REG; CU(months pull informational) | APP → REG |
| Experience (claimed) | APP.requested_exp_* → REG (GREATEST); CU | APP claim; verified via condition |
| Assignment split | APP.is_assignment/underlying/fee → REG; CU(both) | APP → REG |
| LTV/LTC/ARV caps | ENG quote.caps → REG.quote.caps | ENG/REG (frozen) |
| Cash-to-close / liquidity | ENG normalize → REG.quote; liquidity.js condition | ENG/REG |
| Note buyer (lender) | APP.lender; CU(both, staff-only) | APP/CU (staff-only, never borrower-facing) |
| Registration stale | REG.stale (db/096) | REG |
| Term-sheet version | esign_envelopes.product_version; signed-TS condition | esign layer |
| Appraised value | APPR(extract); CU approx/actual_appraised_value(pull) | APPR at review; CU informational |
| Servicing/title/insurance/lien | CU(pull-only) | CU |
| Encompass milestone/status | ENC(read-only)→APP.encompass_status | ENC (read-only mirror) |

---

## 15. Prioritized gap list (for the new engine)

1. **[CRITICAL] MANUAL is signable.** `esignSendGate` (`gate.js:24`, called `orchestrate.js:877`)
   ignores registration status/stale/escalation. Fix: add `status<>'MANUAL' AND NOT stale AND no
   open escalation` there (and to `tpr-export.js` term packaging). Non-frozen; no pricing change.
2. **[HIGH] No shared issuability predicate.** Introduce ONE `canIssueBindingTerms(appId)`
   (reusing `needsSuperAdminApproval` + `pendingForApp` + `is_current AND NOT stale`) and route the
   e-sign gate, TPR export, and any future investor-structure export through it.
3. **[HIGH] `file-view.js` loads a thin slice.** Extend `loadContext` (don't fork it) to add the §7
   gap fields + a `registration{status, is_manual, stale, escalationState, product_version}` block
   and the closing-cost/liquidity numbers already sitting in `quote`.
4. **[MED] Provenance/version is scattered.** Structure numbers live across APP columns, `REG.inputs`,
   `REG.quote`, CU fields, appraisal facts — no single provenance-tagged, versioned record. The
   registration (`inputs`+`quote` jsonb, `is_current`, `stale`) is the closest existing versioned
   snapshot; build the authoritative context on top of it rather than re-deriving.
5. **[MED] Appraised value not reconciled into the context.** Appraisal extract writes as-is/arv
   blank-fill only; `approx/actual_appraised_value` are CU-pull informational. The new engine should
   consume the appraisal facts (`facts.js`/`findings.js`) as a provenance-tagged input, not overwrite
   APP.
6. **[LOW] Reopen triggers are DB-side and app-side split** (db/096 vs `experience.js`); the new
   engine must treat `REG.stale` OR an experience-drop as "must re-register" uniformly.

---

### Frozen-surface reminder
Everything above is descriptive. The engines and the frozen files in §0 must not change. All
recommended fixes land in NON-frozen files (`esign/gate.js`, `manual-program.js`, `tpr-export.js`,
`file-view.js`, new context module) and consume engine output without altering any number.
