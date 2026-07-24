# Gap Audit B — DATA VALIDATION (loan data accepted without being validated / cross-checked / grounded)

Scope: `/home/user/yscap/yscap-repo-root_8`. READ-ONLY. Builds on the existing
`completeness.js` / `context-completeness.js` / `tieout.js` / `facts.js` / `grounding.js` /
`cross-document.js` / `identity-chain.js` / `reasonability.js` / `whole-loan-context.js` /
`source-priority.js` / `appraisal-underwriter.js` / `metrics.js` modules.

The theme of the real gaps here is NOT that the checks are missing — most are written well —
it is that **the strongest checks are not wired into the live gate, and the value that drives
a decision is not the value that was grounded/reconciled.** A false CLEAR (or a false FATAL)
comes from a raw, unvalidated value reaching the decision surface.

---

## SUMMARY (6 lines)
1. The grounding QUARANTINE protects only the per-document checker; the FATAL tie-out reads the raw, un-quarantined stored `fields`, so an ungrounded/hallucinated value drives a CTC decision.
2. The appraised-value-vs-sizing reconciliation (`underwriteAppraisal`, which raises the FATAL "appraisal below the value the loan sized on") is ORPHANED — it is never called in production; live, an under-value appraisal is only a soft tie-out WARNING.
3. The whole-loan RUN pipeline (`runWholeLoan` → structure LTC/LTV ledger + `decision.js` + assignment analysis) is never invoked, so the "grounded decision" backbone computes nothing live.
4. Field-level range/enum validation exists ONLY on the borrower info-condition write; staff completeApp, ClickUp inbound, registration, and intake write columns with no range guard (loan_amount 0, FICO 200, negative rehab).
5. Cross-field consistency is thin: no purchase>ARV check, no `is_assignment`-implies-fields check, no SOW-units tie-out, no program-vs-purpose check; reasonability's own red flags are all WARNING/INFO and never gate.
6. Identity mismatches (two SSNs / two DOBs across docs) are advisory `ai_suggestions` only — even a "fatal" SSN mismatch never blocks clear-to-close.

---

## PRIORITIZED TOP-15 VALIDATION GAPS

### 1. [CRITICAL] Grounding quarantine does not protect the tie-out — ungrounded values drive the FATAL gate
`engine.analyzeDocument` grounds the extraction and quarantines the unconfirmed CRITICAL fields,
but it does so **only for the per-doc `entry.check()`** and then **stores the FULL raw `ext.data`**:
- `src/lib/underwriting/engine.js:206` — `q = quarantineUngrounded(ext.data, grounding)`
- `src/lib/underwriting/engine.js:207` — `entry.check(q.verified, …)` (checker sees verified-only)
- `src/lib/underwriting/engine.js:212` — `fields: ext.data` (raw, UN-quarantined, is what persists)

The tie-out then reads the raw stored `fields`:
- `src/lib/underwriting/file-review.js:20-26` — `SELECT … fields FROM document_extractions` → `buildTieout`
- `tieout.js` discrepancies are FATAL and CTC-blocking (`tieout.js:31-35`, `facts.js:61-73` severity `fatal`).

So a hallucinated seller/price/address/entity value that grounding flagged as *unconfirmed* is
still compared in the tie-out — it can create a **false FATAL block** (value the doc doesn't contain
disagrees with the file) OR a **false CLEAR** (it happens to "agree" with a matching-but-wrong file value).
The grounding-quarantine invariant (#212, "an ungrounded value must never drive a decision") is
enforced for one consumer and bypassed for the highest-severity one.
**Fix:** persist BOTH the raw read and the grounded/quarantined view (e.g. `fields_verified`), and
have `file-review.tieoutForFile` build the tie-out from the quarantined copy (or attach each
extraction's `grounding.quarantined` list and skip quarantined fact-cells in `buildTieout`). Emit the
existing `groundingFinding` advisory for any fact held out of the tie-out.

### 2. [CRITICAL] Appraised-value reconciliation is orphaned — under-value appraisal is only a WARNING live
`appraisal-underwriter.underwriteAppraisal` is the module that raises the FATAL, CTC-/funding-blocking
`appraisal_as_is_below_sizing` and `appraisal_arv_below_sizing`, plus units / property-type /
contract-price mismatches (`appraisal-underwriter.js:87-138`). It is **called from no route and no
live gate** — only `scripts/test-*` and (indirectly) `run.js` via `extraFindings`, and `runWholeLoan`
is itself never invoked (see gap 3). The live desk path builds the tie-out instead
(`underwriting.js:380-381`), where the appraisal's `as_is_value`/`arv` are severity **`warning`**
(`facts.js:75-76`). Net effect: an appraisal that comes in BELOW the value the loan was sized on —
the single most important collateral cross-check, and the exact defense against an inflated ARV — is
a soft warning in production, never the dealbreaker it is coded to be.
**Fix:** call `underwriteAppraisal` inside `file-review` (or the underwriting route) with the file
sizing basis, and fold its `blocks_ctc` findings into `fileFatalCount` (`file-review.js:60-79`) the
same way tie-out and experience fatals are counted.

### 3. [HIGH] The whole-loan RUN pipeline never executes — structure LTC/LTV ledger + decision.js are dead live
`runWholeLoan` (`run.js:262`) assembles `whole-loan-context` + `structure-underwriter` (LTC/LTV/ARV
ledger, `structure-underwriter.js`) + `assignment-analysis` + `decision.js` into the persisted,
provenance-hashed decision record that `run-cockpit.loadRunCockpit`/`loadCurrentDecision` read
(`underwriting.js:1089,1107,1131`). Grep confirms **`runWholeLoan` is invoked nowhere** in `src/`,
`scripts/`, `src/sync`, or `server.js` (only referenced in a `run-trigger.js` comment). So the
grounded, source-priority-resolved LTC/LTV ledger and the composed `decision.js` gate are not being
computed for live files; the cockpit surfaces whatever (if anything) was persisted.
**Fix:** wire `runWholeLoan` to a trigger (registration change / doc analyzed / status move via the
already-built `run-trigger.js`) so the decision record is actually produced, and have it pass the
appraisal desk (gap 2) + verification findings as `extraFindings`.

### 4. [HIGH] Range / enum validation exists only on the borrower info-condition write — every other write path is unguarded
`engine.writeFieldValue` is the ONLY place range/format is enforced (negative reject, FICO 300-850,
IR 0-24, enum membership, real calendar date): `src/lib/conditions/engine.js:342-361`. Values that
arrive via **staff completeApp (`COMPLETE_APP_FIELDS`), ClickUp inbound sync (COALESCE pull),
product registration, or the public application intake** write the `applications`/`borrowers` columns
directly with no equivalent guard. So `loan_amount = 0`, `units = 0`, `fico = 200`, a negative
`rehab_budget`, an ARV below the as-is value, or a date out of range can land on the file from those
doors. `reasonability.js` catches SOME of these (non-positive price `:99`, negative amounts `:107-117`)
but only as WARNING and only for the economics it is handed; `context-completeness.js` checks PRESENCE
only (`:28-34`, `:60-124`), never range.
**Fix:** extract the `writeFieldValue` per-type validation into a shared `validateFieldValue(key,val)`
in `field-registry.js` and call it from EVERY column-write door (completeApp, registration
`buildInputs`, intake). Enum values already have canonicalizers in the registry — reuse them.

### 5. [HIGH] `is_assignment = true` with missing underlying price / assignment fee is never flagged
`reasonability.js` reconciles assignment math ONLY when all three of underlying + fee + price are
present (`reasonability.js:142` — `if (fee != null && … && underlying != null && … && price != null)`).
`completeness.js` requires the assignment DOCUMENT when `if_assignment` (`completeness.js:51`) but not
the assignment FIELDS. So a file flagged as an assignment with a blank `underlying_contract_price` /
`assignment_fee` produces no finding at all — the 15%-of-seller-price financeable cap (a frozen HARD
rule) is silently un-enforceable because its inputs are absent, and the loan sizes on whatever the
purchase price is.
**Fix:** add a completeness/reasonability rule: `is_assignment` ⇒ `underlying_contract_price` and
`assignment_fee` REQUIRED (a fatal/blocking missing-field finding), mirroring the existing document
requirement.

### 6. [HIGH] No cross-field value-ordering beyond as-is>ARV — purchase>ARV and loan>cost basis are unguarded at file level
`reasonability.js` checks `as_is > arv` (`:129`) and `rehab > arv` (`:120`), but NOT:
- `purchase_price > arv` (buying above the after-repair value — an obvious over-pay / inflated-basis red flag),
- `loan_amount > purchase_price + rehab` (loan exceeds total cost basis) at the file level.
`metrics.js` computes LTC/ARV-LTV but is WARNING-only and REQUIRES a registration with persisted caps
(`metrics.js:32-57, underwriting.js:448-452`); an unregistered file gets no leverage sanity at all.
**Fix:** add file-level ordering assertions to `reasonability.js` (`purchase_price ≤ arv`,
`loan_amount ≤ purchase + rehab`) as blocking-eligible findings; they need no program/registration.

### 7. [MEDIUM] SOW / file / appraisal UNIT COUNT is not tied out in underwriting
`facts.js` `DOC_CLAIMS.scope_of_work` carries only `property_address` + `rehab_budget`
(`facts.js:122`), and `units` is an appraisal-vs-file fact only (`facts.js:82`, severity warning). A
Scope of Work built for a different unit count than the file/appraisal is never cross-checked in the
tie-out. (The Sitewire "G-UNITS" advisory exists but is a draw-desk push concern, not underwriting.)
**Fix:** add `units` to the SOW claim set (or a dedicated file-vs-SOW unit reconciliation) so a
unit mismatch surfaces in the tie-out matrix.

### 8. [MEDIUM] Identity mismatches (two SSNs / two DOBs across docs) are advisory only — never gate
`identity-chain.analyze` labels a two-SSN conflict `severity: 'fatal'` (`identity-chain.js:88`) and a
two-DOB conflict `warning` (`:102`), but `analyzeAndRecord` records them as `ai_suggestions`
(`identity-chain.js:141-157`) — they never enter `fileFatalCount`/`document_findings` and cannot block
clear-to-close. A hard identity-fraud signal (same borrower, two SSNs) is a suggestion a human may
never open.
**Fix:** promote `identity_ssn_mismatch` (and DOB mismatch) into the blocking finding set (like the
tie-out fatals) or at minimum open a real condition, not just a suggestion.

### 9. [MEDIUM] The FILE FICO that drives pricing is range-validated nowhere outside the info-condition
`reasonability.js:248-255` validates the FICO on the credit-report DOCUMENT (300-850), but the FILE
value `borrowers.fico` — the one `whole-loan-context`/pricing actually consume
(`whole-loan-context.js:153-154`) — is only range-checked when set via `writeFieldValue`
(`engine.js:346`). A FICO written via ClickUp pull or completeApp is never bounded, and
`context-completeness.js` reports only presence/source (`context-completeness.js:97-100`).
**Fix:** part of the shared `validateFieldValue` (gap 4); additionally add a reasonability check on the
file's own FICO, not just the credit-report doc.

### 10. [MEDIUM] Source-priority can let a weaker source override a stronger one
`source-priority.ORDER` ranks `application` (staff/borrower-typed) ABOVE `appraisal` and `document`
(`source-priority.js:26-29`). So a staff-typed application `as_is_value` governs over the appraisal's
value and over the title/contract document value; the appraisal only wins as the tie-breaker when the
application is absent. Combined with `tieout.js:98` (`truth = fileHas ? fileVal`), a wrong FILE/
application value with no corroborating document is treated as truth and never challenged.
**Fix:** for collateral-value facts (`as_is_value`, `arv`) the appraisal should be the governing
source; re-order or make those fields document-governed in `candidatesFor`/`source-priority`.

### 11. [MEDIUM] `program` vs `loan_purpose` / `rehab_type` / `payoff` cross-consistency is never checked
There is no rule that a `purchase` loan_purpose shouldn't carry a `payoff_amount`/`acquisition_date`
(refi-only fields), that a `refinance` shouldn't require a `purchase_contract`, or that a
`ground_up` rehab_type has a non-zero `rehab_budget`. `field-registry.js` normalizes these enums
(`:47-107`) but nothing cross-validates them. A mis-typed purpose silently changes which documents
are required (`completeness.js` conditional matrix) and how the file prices.
**Fix:** add a small cross-field rule set (purpose⇔required-fields) in `reasonability.js` or a new
`context-consistency` module built on the registry enums.

### 12. [MEDIUM] Reasonability's own red flags are all WARNING/INFO — a $0 price / underage DOB / out-of-range FICO cannot stop a clear
By explicit design every `reasonability.js` finding is `warning`/`info` (`reasonability.js:22-24,
72-73`). That preserves the "only per-doc + tie-out raise fatals" invariant, but it means a genuinely
impossible value (purchase price ≤ 0 `:99`, FICO out of range `:250`, borrower under 18 `:213`,
inverted ID dates `:174`) informs the roll-up and never blocks. A data-integrity impossibility should
not be clearable.
**Fix:** carve out a narrow "impossible value" subset (non-positive price, FICO out of band, underage,
inverted dates) that blocks CTC via `fileFatalCount`, leaving the plausibility warnings advisory.

### 13. [MEDIUM] Grounding abstains on low-OCR docs and never grades derived/classification keys
`groundFields` returns "unchecked" when the OCR has < 24 non-space chars (`grounding.js:112`) and
skips DERIVED keys (`type`/`pct`/`role`, `grounding.js:47`) and structural keys
(`grounding.js:38`). Reasonable individually, but it means a poorly-scanned image, or any value the
model *classified* rather than transcribed (property type, occupancy, ownership %), is never grounded —
so an ungrounded value in those slots silently passes into the tie-out (compounding gap 1).
**Fix:** when grounding abstains (illegible) or skips a critical classified field, raise a "could not
verify — confirm by hand" advisory rather than treating absence-of-check as confirmation.

### 14. [MEDIUM] Whole-loan context is "ready"/complete with no valuation at all
`whole-loan-context` marks only `program` + `loan_amount` REQUIRED
(`whole-loan-context.js:33-52`); `as_is_value`, `arv`, `purchase_price`, `fico` are optional. So a
context is `ready:true` (and `context-completeness` can read `complete`) with no as-is/ARV/FICO. The
`CRITICAL_KEYS` gaps for those (`context-completeness.js:28-34`) only downgrade to `partial` and are
ADVISORY, gating nothing (`context-completeness.js:22-24`).
**Fix:** for a rehab/purchase file make `as_is_value`+`arv` (and FICO) required in the context, so a
missing valuation makes the context NOT_READY instead of silently "ready".

### 15. [LOW] The num(null)→0 class is well-guarded in the 7 tested modules but the direct column-write doors reintroduce it
`test-num-guards-pure.js` proves the fix across `structure-underwriter`, `assignment-analysis`,
`system-reconciliation`, `compare`, `rehab-budget`, `bank-statement-checks`, `appraisal-underwriter`,
and the live tie-out path routes numbers through the guarded `compare.num`. Remaining exposure is not
a coercion bug but the un-validated write doors (gap 4): a literal `0`/blank persisted to a column is
consumed as a real 0 by `metrics`/`whole-loan-context` (both correctly treat it as present-and-zero,
not null). `risk-score.js:91` (`Number(String(v)…)`) yields NaN not 0 — safe.
**Fix:** the shared `validateFieldValue` guard (gap 4) closes the residual door; no further
coercion-site changes needed in the audited live modules.

---

## Coverage map (what already exists vs the gap)
- **Field-level range:** GOOD on info-condition write (`engine.js:342-361`); MISSING on all other write doors (gap 4/9/15).
- **Cross-field consistency:** PARTIAL — asis>arv, rehab>arv, assignment math when-complete (`reasonability.js`); MISSING purchase>arv, loan>cost, is_assignment-implies-fields, SOW units, program⇔purpose (gaps 5,6,7,11).
- **Cross-doc vs file tie-out:** STRONG matrix (`tieout.js`/`facts.js`) — seller/price/address/entity/DOB fatal, appraisal physicals; but appraisal-value-below-sizing is only WARNING here and its FATAL owner is orphaned (gap 2), and identity SSN/DOB is advisory (gap 8).
- **Grounding:** built (`grounding.js` quarantine + advisory) but only wired to the per-doc checker, NOT the tie-out (gap 1) and abstains silently on low-OCR/derived (gap 13).
- **Provenance/source-priority:** resolver exists (`source-priority.js`) but ranks typed application above appraisal/document for collateral value (gap 10); tie-out treats file as truth (gap 1/10).
