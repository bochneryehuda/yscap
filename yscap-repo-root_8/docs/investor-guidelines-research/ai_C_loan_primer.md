# PILOT / YS Capital — CANONICAL LOAN FILE PRIMER

Grounding document to inject verbatim into EVERY AI/GPT call. It teaches the model our loan
structure, our file object graph, and the EXACT meaning of every loan field so it never
misreads a value (never confuses purchase price vs as-is value vs ARV, or loan amount vs cost
basis). All file:line references are to `yscap-repo-root_8/`.

Two parts:
- **PART A** — the injectable grounding block (plain, exact; drop into a system prompt).
- **PART B** — the field glossary table + confusion flags + the canonical per-file read.

---

## PART A — THE GROUNDING BLOCK (inject this text)

```
YS CAPITAL / PILOT — LOAN FILE GROUNDING (authoritative; read before reasoning about any value)

WHAT A LOAN FILE IS
- We originate business-purpose RESIDENTIAL TRANSITION LOANS (RTL): fix & flip, fix & hold
  (BRRRR), bridge, ground-up construction, and rental/DSCR. Never owner-occupied consumer loans.
- ONE loan file = ONE property = one `applications` row (a borrower can have many). The
  application id (a uuid) is the file's identity. Everything else hangs off it.
- Money is US dollars. A blank/absent number is MISSING (null) — never treat it as 0. "0" and
  "missing" are different and a decision must not assume a value that is not present.

THE MONEY FIELDS — MEMORIZE THESE DISTINCTIONS (this is where misreads happen)
- purchase_price = the CONTRACT price the borrower pays the seller on a PURCHASE. On a
  refinance this is usually blank; use original_purchase_price instead.
- original_purchase_price = what the borrower ORIGINALLY paid for a property they already own
  (refinance context only). Not the current value, not the loan.
- underlying_contract_price = on an ASSIGNMENT/wholesale deal, the SELLER'S original contract
  price (what the seller signed), BEFORE the assignment fee. This is the basis the financeable
  assignment fee is capped against (15% of THIS number).
- assignment_fee = the wholesaler's fee paid ON TOP OF underlying_contract_price. Real total
  price the borrower pays = underlying_contract_price + assignment_fee.
- effective_purchase_price (a.k.a. recognized price) = the price the loan is SIZED on when a
  fee is over cap = seller contract + the FINANCEABLE portion of the fee (fee capped at 15% of
  the seller contract price; Gold also caps the financeable fee at $75,000). Any fee above that
  cap is excess cash the borrower brings at closing (assignmentExcessOOP). ALWAYS: show the REAL
  total under "Purchase price"; the capped basis only under "Effective purchase price".
- as_is_value = the property's CURRENT market value today, before any renovation (from the
  appraisal / borrower estimate). This is NOT the price and NOT the ARV.
- arv = AFTER-REPAIR VALUE = the appraiser's projected value once the renovation is complete.
  Always >= as_is_value on a rehab deal. Leverage-to-ARV (LTARV) uses THIS.
- rehab_budget = total renovation/construction budget. It is FROZEN once set on the file /
  registered product; the Scope-of-Work tool never changes it.
- payoff_amount = the balance to pay off the borrower's EXISTING loan (refinances only).
- loan_amount = the TOTAL financed loan we are giving (initial advance + rehab holdback +
  financed interest reserve). This is NOT the cost basis and NOT the purchase price.

THE COST-BASIS / SIZING RELATIONSHIPS (how a loan is built)
- Total Cost Basis  = (purchase_price OR as_is_value, whichever the program uses) + rehab_budget
  [+ financed interest reserve, for programs where the reserve sits IN the cost basis].
  On an assignment the price term is the EFFECTIVE (recognized) price, not the real total.
- loan_amount = initial advance (a.k.a. acquisition advance) + rehab holdback + financed
  interest reserve. These three ALWAYS sum to loan_amount to the dollar (reported figures are
  floored to whole dollars and reconciled).
    * initial advance  = the day-one wire toward acquisition (capped by as-is / purchase LTV).
    * rehab holdback   = the renovation money, released in draws as work completes.
    * financed interest reserve = pre-funded interest, financed into the loan (may be 0).
- LEVERAGE, all as loan-to-X percentages (0-100):
    * ltv  = loan-to-value as registered on the file.
    * loan_to_cost (LTC)  = loan_amount / (purchase_price + rehab_budget).
    * loan_to_arv (LTARV) = loan_amount / arv.
  Each program caps maxAcqLTV (initial advance vs as-is/purchase), maxLTC, and maxARLTV. The
  loan is sized to the TIGHTEST binding cap; the `binding` field names which cap bound it.
- Interest reserve can be requested as MONTHS (requested_ir_months, 0-24) OR an exact dollar
  amount (requested_ir_amount); the dollar amount, if > 0, wins. It is always capped at the
  full-term interest.

PROGRAM / STRUCTURE
- registered_program: 'standard' (Standard Program), 'gold' (Gold Standard Program),
  'manual' (a manual override of the structure), or 'none' (not registered yet). This is the
  product REGISTERED in the Term Sheet Studio — the authoritative structure.
- The frozen pricing engines (Standard = window.YSP, Gold = window.GSP) are the SOLE authority
  for every number (rates, caps, sizing, fees, reserves). AI NEVER recomputes, re-prices,
  invents, or overrides an engine number. A missing engine number stays missing.
- program_strategy: fix_flip | fix_hold | bridge | ground_up | rental_dscr | other.
- loan_purpose: purchase | refinance_rate_term | refinance_cash_out | other.
- Gold Standard finances NO interest reserve on renovation (reserve resolves to 0); Gold
  ground-up keeps a 75%-of-term reserve; Standard is full-term. Never assume a reserve exists.

BORROWER / ENTITY / EXPERIENCE
- fico = borrower mid credit score (300-850), on the BORROWER profile, not the file.
- tier = count of VERIFIED track-record deals on the borrower (drives leverage bracket).
- verified_flips / verified_holds / verified_ground = counts PROVEN by the track record.
- requested_exp_flips / _holds / _ground = the borrower's CLAIMED (attested) experience. The
  loan SIZES on the claimed numbers (fallback to verified); funding is gated by an experience
  condition that must VERIFY the claim. Claimed >= verified is normal, not a discrepancy.
- has_llc / llc_verified / llc_state = the vesting entity (LLC) linked to the file and whether
  it is verified; loans typically vest in the borrower's LLC.
- has_co_borrower = a second borrower is on the file; both are guarantors by default.

LOCATION & IDENTIFIERS
- property_state / property_city / property_zip = the SUBJECT property location.
- borrower_state = where the borrower LIVES (may differ from the property state).
- ys_loan_number = our loan number, starts with "YSCAP". Blank = not yet assigned.
- status: file_intake < new(Submitted) < in_review < processing < underwriting < approved <
  clear_to_close < funded; terminal declined / withdrawn.

NOTE BUYER — STAFF ONLY, NEVER SHOWN TO A BORROWER
- note_buyer (stored as applications.lender) = the capital partner the loan is sold to
  (bluelake = Blue Lake, corrfirst = CorrFirst, fidelis = Fidelis, ...). This name is STAFF-ONLY.
  NEVER expose a note buyer / capital partner name in any borrower-facing text, email, or PDF —
  borrower-facing copy calls it "the Gold Standard program". It drives internal rules (e.g.
  CorrFirst opens a borrower EMD condition; Blue Lake / CorrFirst require a flood certificate).

SOURCES & CONFLICTS
- Every value can come from multiple sources (the application row, the frozen engine's stored
  inputs, the registered product snapshot, the appraisal, or an extracted document). When two
  present sources disagree, that is a DISCREPANCY to surface for a human — never silently pick
  one, never average. Cite your source (application / registration / pricing_engine / appraisal /
  document type) and, for a document-derived fact, its confidence/status (observed, corroborated,
  verified, disputed, human_confirmed). A human_confirmed value outranks everything.
- Treat missing required facts (program, loan_amount) as NOT_READY, never fabricated.
```

---

## PART B — FIELD GLOSSARY, CONFUSION FLAGS, AND THE CANONICAL READ

### B1. The field registry (source of truth)

The single field registry is **`src/lib/conditions/field-registry.js`** (`FIELDS` array, lines
126-264; exported `BY_KEY`, `WRITE_TARGETS`). Every key an AI or a rule can reference is here,
with `type`, enum `options`, and (for writable info-fields) the borrower wording. Raw DB values
are normalized to canonical enum keys by the `norm*` functions (e.g. "Refi Cash-Out" →
`refinance_cash_out`) so a value always reads the same regardless of how it was typed.

The runtime flat value map for a file is produced by **`engine.loadRuleContext(appId)`**
(`src/lib/conditions/engine.js:49-162`) → `{ ctx, app }`, where `ctx[key]` is the normalized
current value of every registry field for that application. That `ctx` is the exact per-field
picture to hand an AI. Money/percent nulls stay null (`num()`, engine.js:35-41).

### B2. Field glossary table

Group and money-meaning are load-bearing. "Src" = where the value originates.

| key | type / enum | MEANS | Src (col / derivation) |
|---|---|---|---|
| registered_program | enum: standard, gold, manual, none | The product registered in Term Sheet Studio; `manual` = hand override of LTV/LTC/ARV | product_registrations.program (JOIN pr_program) |
| program_strategy | enum: fix_flip, fix_hold, bridge, ground_up, rental_dscr, other | Deal strategy, normalized from program text | normStrategy(program+loan_type+rehab_type) |
| loan_purpose | enum: purchase, refinance_rate_term, refinance_cash_out, other | Purchase vs refi (R&T / cash-out) | normLoanPurpose(applications.loan_type) |
| **loan_amount** | money (writable) | TOTAL financed loan = initial + holdback + financed reserve. NOT cost basis, NOT price | applications.loan_amount |
| ltv | percent | Loan-to-value as registered on the file (0-100) | applications.ltv |
| loan_to_arv | percent (computed) | loan_amount / arv ×100 | computed live in ctx |
| loan_to_cost | percent (computed) | loan_amount / (purchase_price + rehab_budget) ×100 | computed live in ctx |
| rate_pct | percent | Borrower note rate | applications.rate_pct |
| requested_ir_months | number (writable, 0-24) | Interest reserve requested in MONTHS | applications.requested_ir_months |
| requested_ir_amount | money (writable) | Interest reserve requested as an EXACT $; wins over months when > 0 | applications.requested_ir_amount |
| is_assignment | boolean | This is an assignment/wholesale purchase | applications.is_assignment |
| note_buyer | enum: bluelake, corrfirst, fidelis (STAFF-ONLY) | Capital partner the note is sold to; NEVER borrower-facing | normNoteBuyer(applications.lender) |
| ys_loan_number | text | Our loan number (starts YSCAP); blank triggers "loan number missing" | applications.ys_loan_number |
| status | enum (file_intake…funded, declined, withdrawn) | File lifecycle stage | applications.status |
| property_state / _city / _zip | enum(state) / text / text | SUBJECT property location | applications.property_address jsonb |
| property_type | enum: sfr, multi_2_4, multi_5_plus, condo, townhouse, pud, mixed_use, other | Property type | normPropertyType(applications.property_type) |
| units | number (writable) | Number of units | applications.units |
| occupancy | enum: investment, primary, secondary, other | Occupancy (RTL is investment) | applications.occupancy |
| in_flood_zone | boolean | Current appraisal places it in a FEMA SFHA (zone A*/V*) | derived from appraisals row |
| **purchase_price** | money (writable) | CONTRACT purchase price on a PURCHASE (blank on refi) | applications.purchase_price |
| **as_is_value** | money (writable) | CURRENT value today, pre-rehab (NOT price, NOT ARV) | applications.as_is_value |
| **arv** | money (writable) | AFTER-repair value, post-rehab projection; drives LTARV | applications.arv |
| **rehab_budget** | money (writable) | Total renovation budget; FROZEN once set | applications.rehab_budget |
| rehab_type | enum: cosmetic, moderate, heavy, adding_sf, ground_up, other | Scope of the rehab | normRehabType(applications.rehab_type) |
| **payoff_amount** | money (writable) | Payoff on the borrower's EXISTING loan (refi) | applications.payoff_amount |
| **original_purchase_price** | money (writable) | What borrower ORIGINALLY paid (refi) | applications.original_purchase_price |
| acquisition_date | date (writable) | When borrower bought the property (refi) | applications.acquisition_date |
| **underlying_contract_price** | money (writable) | SELLER'S original contract price on an assignment (fee cap basis) | applications.underlying_contract_price |
| **assignment_fee** | money (writable) | Wholesaler fee ON TOP of underlying contract price | applications.assignment_fee |
| sqft_pre / sqft_post | number (writable) | Square footage now / after renovation | applications.sqft_pre/_post |
| liquidity_required | money | Assets the registered product requires (cash to close + reserves) | registration quote.liquidityRequired |
| fico | number (writable, 300-850) | Borrower mid credit score | borrowers.fico (writes to borrowers) |
| citizenship | enum: us_citizen, permanent_resident, foreign_national, other | Borrower citizenship | normCitizenship(borrowers.citizenship) |
| borrower_state | enum(state) | Where the borrower LIVES (≠ property_state) | borrowers.current_address.state |
| tier | number | Count of VERIFIED track-record deals (leverage bracket) | borrowers.tier |
| verified_flips / _holds / _ground | number | Experience PROVEN by verified track records | countBorrowersExperience(verifiedOnly) |
| requested_exp_flips / _holds / _ground | number (writable) | Borrower's CLAIMED experience; loan sizes on this | applications.requested_exp_* |
| has_co_borrower | boolean | A second borrower is on the file | applications.co_borrower_id present |
| has_llc | boolean | A vesting LLC is linked | applications.llc_id present |
| llc_verified | boolean | The linked LLC is verified | llcs.is_verified |
| llc_state | enum(state) | LLC formation state | llcs.formation_state |

Writable info-field targets (where a borrower's answer persists) are in `WRITE_TARGETS`
(field-registry.js:270-290): most write `applications.<col>`; `fico` writes `borrowers.fico`.
Admin custom fields (keys prefixed `cf_`) live in `application_field_values` and extend the
registry at runtime (field-registry.js:299-344).

### B3. Fields that are commonly CONFUSED or AMBIGUOUS — flag these

1. **purchase_price vs as_is_value vs arv** — three different dollars. Price = what is paid;
   as-is = current value; ARV = future post-rehab value. On a purchase, price and as-is are
   often close but distinct; ARV is higher. AI must never substitute one for another.
2. **loan_amount vs cost basis vs purchase_price** — loan_amount is what WE lend (a subset of
   cost). Cost basis = price + rehab (+reserve). Purchase price is only the acquisition leg.
   Loan/cost = LTC; loan/price is NOT a headline metric.
3. **purchase_price (real total) vs effective/recognized purchase price** — on an assignment,
   "Purchase price" must display seller + FULL fee (the real total). The loan SIZES on the
   effective price (seller + financeable fee capped at 15% of seller price). Do not size on the
   real total; do not label the effective price as the purchase price.
4. **underlying_contract_price vs purchase_price vs assignment_fee** — on an assignment,
   underlying_contract_price is the seller's price, assignment_fee is added on top, and
   applications.purchase_price may hold the combined total. Read the assignment fields, not just
   purchase_price.
5. **requested_exp_* (claimed) vs verified_* / tier (proven)** — claimed ≥ verified is EXPECTED
   and not a data conflict; the loan sizes on claimed and a condition verifies it. Never flag
   "borrower over-claimed" as a discrepancy on its own.
6. **requested_ir_months vs requested_ir_amount** — both can be present; the dollar amount wins
   when > 0. On Gold renovation the financed reserve is ALWAYS 0 regardless of the request.
7. **program (applications.program) vs registered_program** — applications.program is free STRATEGY
   text ("Fix & Flip w/ Construction"); registered_program is the structured product
   ('standard'/'gold'/'manual'). Comparing the two as if equal creates a FALSE program
   discrepancy (this was a real bug — whole-loan-context.js:275-283). Use registered_program.
8. **note_buyer / lender (applications.lender)** — this is the CAPITAL PARTNER, not a bank the
   borrower deals with, and is STAFF-ONLY. Never surface it to a borrower.
9. **borrower_state vs property_state** — the borrower's home state ≠ the subject property state.
10. **original_purchase_price vs purchase_price** — refi files use original_purchase_price;
    purchase files use purchase_price. Don't cross them.

### B4. The file object graph (FKs)

- `applications` (one row per PROPERTY; the file) — schema.sql:155. FKs: borrower_id →
  `borrowers`, co_borrower_id → `borrowers`, llc_id → `llcs` (vesting entity), loan_officer_id /
  processor_id → `staff_users`.
- `borrowers` (PII) — schema.sql:49 — separate from `borrower_auth` (login) — schema.sql:85.
- `llcs` / entities — schema.sql:102 (borrower_id FK). `track_records` — schema.sql:123
  (borrower_id, optional llc_id) — PER BORROWER, drive tier/experience.
- `checklist_templates` (definitions) — schema.sql:220 — and `checklist_items` (the CONDITIONS
  on a file) — schema.sql:233 (application_id / borrower_id / llc_id, exactly one owner). The
  rule engine issues/retracts them (`engine.evaluateApplication`, engine.js:200).
- `documents` — schema.sql:263 (checklist_item_id + denormalized application_id/borrower_id/llc_id).
- `product_registrations` — db/025_product_registration.sql:9 — the REGISTERED STRUCTURE: program,
  note_rate, total_loan, target_ltc, `inputs` jsonb (engine inputs), `quote` jsonb (normalized
  sized quote), is_current. This is where a file's registered structure LIVES.
- `application_assignees` — db/103 — the file's team (primary LO/processor + assistants).
- The **digital twin**: `loan_facts` (canonical facts), `fact_observations` (append-only per
  source), `fact_events` (ledger) — db/232_loan_digital_twin.sql. Model in
  `src/lib/underwriting/twin.js` (FACT_KEYS, twin.js:46-88; SOURCE_HIERARCHY, twin.js:101).

### B5. The registered STRUCTURE / pricing output shape (read-only)

A file's sized structure is the normalized quote in `product_registrations.quote`
(shape defined by `pricing.normalize`, `src/lib/pricing.js:239-386`). Key output fields:
- `sizing.totalLoan` (= loan_amount, whole dollars), `sizing.initialAdvance`,
  `sizing.rehabHoldback`, `sizing.financedReserve` — these three reconcile to totalLoan
  (pricing.js:256-261).
- `sizing.costBasis`, `sizing.ltcPct`, `sizing.acqLtvPct`, `sizing.arvPct`, `sizing.binding`
  (which cap bound the loan), `sizing.downPayment`, `sizing.assignmentExcessOOP`.
- `assignment.recognizedPrice` = effective purchase price; `assignment.excessOOP` = fee over cap.
- `cashToClose`, `reserveRequirement`, `liquidityRequired`, `caps{maxLoan,minFico,maxAcqLtv,
  maxArvLtv,maxLtc}`, `noteRate`.
The frozen engine `sizeLoan` return (web/tools/standard-program.js:377-390) is the raw source of
these figures (`totalLoan`, `acquisition`, `rehabLoan`, `financedIR`, `costBasis`, `ltcPct`,
`acqLtvPct`, `arvPct`, `binding`). AI consumes these; it never recomputes them.

### B6. THE CANONICAL READ — assembling the grounding context for a file

There is no single existing "AI grounding" assembler; the correct, complete picture is the
UNION of three canonical read-only loaders (all keyed on the application id):

1. **`require('./lib/conditions/engine').loadRuleContext(appId)`** → `{ ctx, app }`
   (`src/lib/conditions/engine.js:49`). Gives the flat, normalized value of EVERY registry field
   (Part B2). This is the field-level truth to inject.
2. **`require('./lib/underwriting/whole-loan-context').buildWholeLoanContext(appId, db)`**
   (`src/lib/underwriting/whole-loan-context.js:268`). Gives the provenance-resolved STRUCTURE:
   `values{}`, per-field `governingSource`/`confidence`, `discrepancies[]`, `missingRequired[]`,
   `registration{present,status,isManual,stale}`, `liquidity`, `sourceHash`, `ready`. This is the
   money/structure truth WITH source attribution and conflict detection.
3. **`require('./lib/underwriting/twin').factsForFile(appId, db)`**
   (`src/lib/underwriting/twin.js:589`). Gives the document-VERIFIED canonical facts with
   `status` (observed / corroborated / verified / disputed / human_confirmed) and consensus.

Precedent that already fuses all three: `investor-guidelines/desk.js:runInvestorGuidelineDesk`
(desk.js:332) combines `loadRuleContext` + `factsForFile` (+ registration), and
`underwriting/run.js:266` builds the whole-loan context for the deterministic decision, which the
AI EXPLAINER (`underwriter-prompt.js`) is then grounded on.

RECOMMENDED module.fn to assemble the per-file grounding context (thin wrapper over the three
canonical loaders — one call for callers to inject):

```js
// src/lib/underwriting/loan-primer.js  (proposed — read-only, no AI, no writes)
async function assembleLoanPrimer(appId, db) {
  const [{ ctx } = {}, whole, facts] = await Promise.all([
    require('../conditions/engine').loadRuleContext(appId).catch(() => ({})),
    require('./whole-loan-context').buildWholeLoanContext(appId, db).catch(() => null),
    require('./twin').factsForFile(appId, db).catch(() => []),
  ]);
  return { applicationId: appId, fields: ctx || null, structure: whole, facts };
  // Inject alongside PART A (the static grounding block). Scrub note_buyer/lender
  // for any borrower-facing surface via lib/borrower-safe.scrubText.
}
```

If a caller wants ONE existing call today, use **`buildWholeLoanContext(appId, db)`** — it is the
purpose-built, provenance-tagged, conflict-aware whole-loan view and is already the read every
underwriting decision uses. Supplement it with `loadRuleContext` for the full flat field set.

---

## 6-LINE SUMMARY

1. The complete field registry is `src/lib/conditions/field-registry.js` (`FIELDS`, lines 126-264); the live per-file values come from `engine.loadRuleContext(appId)` (`src/lib/conditions/engine.js:49`).
2. Money meanings are distinct and must never be crossed: loan_amount = initial + rehab holdback + financed reserve; cost basis = price + rehab (+reserve); purchase_price / as_is_value / arv / underlying_contract_price+assignment_fee / effective(recognized) price are all different dollars.
3. The registered STRUCTURE lives in `product_registrations` (program, total_loan, note_rate, `inputs`/`quote` jsonb; db/025); the frozen YSP/GSP engines are the sole authority for every number — AI never recomputes.
4. The file graph: `applications` (one per property) ← borrowers/borrower_auth, llcs, track_records, checklist_items/templates (conditions), documents, product_registrations, application_assignees, and the digital twin loan_facts/fact_observations/fact_events (db/232, `src/lib/underwriting/twin.js`).
5. The complete correct loan picture = the union of three read-only loaders: `loadRuleContext` (flat fields) + `buildWholeLoanContext` (provenance-resolved structure + discrepancies + readiness) + `twin.factsForFile` (document-verified facts with source authority).
6. Flag the confusables (purchase vs as-is vs ARV; loan_amount vs cost basis; real vs effective purchase price; claimed vs verified experience; program text vs registered_program) and NEVER expose note_buyer/lender to a borrower.

## RECOMMENDED module.fn
`underwriting/whole-loan-context.buildWholeLoanContext(appId, db)` for the structure picture,
combined with `conditions/engine.loadRuleContext(appId)` and `underwriting/twin.factsForFile(appId, db)`;
package them as the proposed **`underwriting/loan-primer.assembleLoanPrimer(appId, db)`** (§B6) to
emit the per-file grounding context injected alongside PART A.
