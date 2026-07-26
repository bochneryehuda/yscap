# Unified Investor-Guideline Review — design (owner-directed 2026-07-24)

## The directive

The investor-guideline checks must **not** be a second AI review with its own screen and its own
cost. They must run **as part of the ONE whole-loan document-review run** — the original AI
document reviewer — so:

- **One run, one cost** per file (not two separate AI passes).
- **Everything talks to each other** — the guideline checks read the SAME already-gathered file
  data (canonical values + appraisal + credit + experience) the rest of the run uses.
- **All findings in ONE place**, just **categorized `investor_guideline`** — not a separate
  "Investor Guidelines" section, not a per-micro-item condition. The standalone section folds in.
- The reviewer must **understand what is already on the file** — e.g. never open an "email
  address" condition when the email is already on the file; only flag an EMPTY slot.

## Architecture — how the findings sync into one place

The whole-loan run (`run.js`) already gathers findings from every desk (structure, program,
appraisal, document, assignment, system-reconciliation, liquidity) into one list, then
`finding-registry.consolidate()` dedupes them into the **ONE registry** the decision + UI read
(dedup key = code + subject; severity = MAX across sources; blocks_* OR together).

The investor-guideline desk (`src/lib/underwriting/investor-guideline-review.js`) emits findings
**in that exact registry shape** with `category:'investor_guideline'` and `source:'investor_guideline'`.
`run.js` folds them into the same `findings[]` before `consolidate()`. Result: investor-guideline
findings appear in the ONE registry alongside every other finding — filterable by the
`investor_guideline` category, no second AI call, no second screen.

- **Deterministic first.** Almost every note-buyer rule is a deterministic check against data
  already on the file (a NY loan, a loan over $1.5MM, an assignment, a transferred appraisal, a
  FICO that disagrees with the priced score, claimed experience over verified). Those need NO GPT
  and cost nothing. The grounded GPT verifier (`ai-guideline-verify.js`) stays as an OPTIONAL
  depth layer on top for satisfaction-quality nuance.
- **Advisory (never blocks).** Per the governing rule, a `fatal` investor-guideline finding is a
  super-admin-overridable HARD WARNING — it flags CTC/funding but never hard-blocks and never
  touches a frozen number.
- **Never fabricate.** A rule reads only fields on the file; insufficient data → no finding
  (e.g. no price-vs-value concern BEFORE the appraisal is in).

## The rule table (the owner's examples, generalized)

The engine is a **data table** (`RULES` in `investor-guideline-review.js`) — add a note buyer's
rule by adding a row, not by writing control flow. Each row names its audience (a note buyer or
`all`), a `when(x)` returning true/false/null, a severity, and an optional escalation target.

Shipped rules (this is the pattern to extend to every guideline):

| Rule | Audience | Severity | Reads |
|---|---|---|---|
| New York loan → escalate | Blue Lake | fatal + escalate | property_state |
| Assignment of contract → escalate | Blue Lake | fatal + escalate | is_assignment |
| Loan > $1.5MM → escalate | Blue Lake | fatal + escalate | loan_amount |
| Rehab budget > as-is value → escalate | Blue Lake | fatal + escalate | rehab_budget, as_is_value |
| Rehab budget > $250k → escalate | Blue Lake | fatal + escalate | rehab_budget |
| Ground-up deposit > $1MM → escalate | Blue Lake | fatal + escalate | ground_up_deposit |
| Cash-out proceeds > $250k → escalate | Blue Lake | fatal + escalate | cash_out_proceeds |
| Property conversion → escalate | Blue Lake | fatal + escalate | is_conversion |
| Mid-construction (from appraisal) → escalate (usually ineligible) | Blue Lake | fatal + escalate | appraisal.mid_construction |
| Transferred appraisal → NOT eligible | Blue Lake | fatal | appraisal.transferred |
| Transferred appraisal → transfer letter required | CorrFirst | fatal + escalate | appraisal.transferred, .transfer_letter |
| Comparables not close enough → appraisal review | CorrFirst | fatal + escalate | appraisal.comps_close |
| Rural property → escalate (read the appraisal, don't leave open) | all | fatal + escalate | appraisal.rural |
| FICO on file ≠ imported credit FICO → restructure | all | fatal | fico_file, fico_credit |
| Claimed experience > verified → verify first | all | fatal | claimed_exp, verified_exp |
| Exit older than 3 years → does not count | all | warning | has_stale_exit |
| Flood zone → flood-insurance condition required | all | fatal | in_flood_zone |
| Purchase price > value requirement (post-appraisal only) | all | fatal | appraisal_present, purchase_price, as_is_value |

## Data-source map (each rule → where the reviewer reads it)

- Canonical file values (`whole-loan-context`): loan_amount, is_assignment, rehab_budget,
  as_is_value, arv, program, property_type, units, fico.
- App row: property_state, note_buyer (`lender`), loan_purpose (cash-out / ground-up / conversion),
  ground-up deposit, cash-out net proceeds.
- Appraisal (XML + findings + desk): transferred (client / intended-user ≠ our company),
  transfer letter present, rural, mid-construction, comps-close (CorrFirst tolerance).
- Credit: imported representative FICO (vs the priced/registered FICO on the structure screen).
- Experience: claimed (`requested_exp_*`) vs verified (`verified_*`) + track-record exit dates
  (flip = sale date, hold = lease date, 3-year window).

## Build stages

1. **DONE (this PR):** the deterministic desk `investor-guideline-review.js` + this design +
   pure tests. Foundation — a new pure module, wired to nothing yet, cannot break anything.
2. **Next:** wire `review()` into `run.js` (build the input bag from the run's context + appraisal
   + credit + experience results; push its findings before `consolidate()`), so the findings land
   in the ONE registry, category `investor_guideline`.
3. **Then:** surface the `investor_guideline` category in the findings UI (a filter/label in the
   ONE list) and RETIRE the standalone ISG panel into that category.
4. **Then:** fix the email-condition bug (don't open a condition when the email is on file), and
   re-mine the CorrFirst Excel for MORE conditions (owner: CorrFirst should be bigger).
5. The GPT satisfaction verifier remains an optional depth layer — the core is deterministic + free.
