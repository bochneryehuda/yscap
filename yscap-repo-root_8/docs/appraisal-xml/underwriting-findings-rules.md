# Appraisal-vs-Loan-File Match Engine — PILOT Findings Rules

**Purpose.** On import of a Fannie Mae appraisal XML (forms 1004 / 1025 / 1073), the match engine
compares each extracted field `{value, source, confidence}` against the registered loan file and raises
**PILOT findings** for an underwriter to resolve before **clear-to-close (CTC)**. This document is the
rule set: for each check — the trigger, severity, finding text, the actions an underwriter can take,
whether the action reprices, and whether the finding blocks CTC. It then defines the repricing chain,
the CTC blocking condition, the findings badge, and the never-auto-overwrite guarantee.

**Author context:** compiled 2026-07-19. Companion docs: `industry-research.md` (norms + citations),
`field-reliability.md` (what we can read and how often), `error-handling-and-confidence.md`
(confidence tiers + the As-Is officer condition). All thresholds below are **owner-tunable** — they are
config values, not hard-coded constants — with a recommended default and an industry citation.

---

## 0. Principles (read first)

1. **Never auto-overwrite the loan file.** The engine never writes `as_is_value`, `arv`,
   `purchase_price`, or `units`. Every change to a file value is an **explicit underwriter action** with
   a reason, recorded in `audit_log`. This mirrors the existing overwrite-shield pattern
   (`error-handling-and-confidence.md`: "Never overwrite a human-entered value with a lower-confidence
   import").
2. **Right value for the right test.** As-Is drives LTV/LTC (purchase-side); ARV drives LTARV
   (exit-side). Never swap them (`industry-research.md` §4.2). The engine reads
   `conditionOfAppraisal` + `valueType` on every value and refuses to treat a "subject-to" value as
   As-Is or vice-versa.
3. **Confidence gates severity.** A field we could not read with certainty
   (`missing` / `non_uad` / `estimate`) becomes a **verify finding**, never an auto-fail. We never
   decline a deal on a number we didn't actually read (`error-handling-and-confidence.md`).
4. **Findings are advisory to pricing, not silent.** A resolved action that changes a pricing input
   **reopens pricing** through the system's existing trigger (`db/071`/`db/072`) — the engine does not
   compute a new loan; it hands the corrected input to the frozen pricing engine and re-registers.
5. **Fatal findings block CTC.** An internal condition (`appraisal_review_cleared`) cannot be signed
   off while any fatal appraisal finding is open. CTC is gated on it, exactly like the existing
   `appraisal_as_is_verify` and SOW-budget gates.

---

## 1. Severity model

| Severity | Meaning | Effect on CTC |
|---|---|---|
| **fatal** | The loan as sized/registered is not supported, or collateral identity is wrong. Must be resolved. | **Blocks CTC** — holds `appraisal_review_cleared` open. |
| **warning** | Real discrepancy that needs an underwriter decision but can be dismissed with a documented reason (exception). | Does **not** block CTC once acknowledged/dismissed with reason; open warnings show in the badge as review items. |
| **info** | Favorable or immaterial difference; recorded for the file, no action required. | Never blocks. |

**Tolerance philosophy.** Money comparisons use a **two-part band**: an absolute floor **and** a
percentage, tolerance = `max($ floor, % of file value)`, so we don't fire on rounding noise on a big
loan nor miss a material gap on a small one. Defaults below.

---

## 2. Findings rules table

Legend — **Reprice?** = does the "replace file value" action write a pricing input and reopen pricing.
**Blocks CTC?** = does an open instance hold `appraisal_review_cleared`.

| # | Finding | Trigger (default threshold, owner-tunable) | Severity | Finding text (human-readable) | Actions | Reprice? | Blocks CTC? |
|---|---|---|---|---|---|---|---|
| **F1** | **ARV lower than file** | Appraisal ARV < file `arv` by more than tolerance = `max($5,000, 2%)` of file ARV. | **fatal** | "The appraisal's After-Repair Value ($X) is lower than the value on file ($Y) by $Z (n%). The loan was sized on the higher number, so the exit cushion (LTARV) may no longer hold." | Replace file ARV with appraisal ARV → **reprice**; Keep file value (requires reason + attach support, e.g. ROV pending); Request revised appraisal / ROV; Decline file. | **Yes** (Replace ARV) | **Yes** |
| **F2** | **ARV higher than file** | Appraisal ARV > file `arv` beyond same tolerance. | **info** | "The appraisal's ARV ($X) is higher than the file ($Y). No action required; the loan was sized conservatively. You may re-size up on request." | Acknowledge (default); Replace file ARV with appraisal ARV → **reprice** (only if borrower requests more proceeds). | Optional (only if replaced) | No |
| **F3** | **ARV within tolerance** | \|appraisal ARV − file ARV\| ≤ tolerance. | **info** | "ARV matches the file within tolerance." | Auto-pass (recorded, no task). | No | No |
| **F4** | **As-Is below purchase price** | Appraisal As-Is (definite) < file `purchase_price` by more than `max($5,000, 2%)` of price. | **fatal** | "The As-Is value ($X) is below the purchase price ($Y) by $Z. There is a collateral/equity shortfall — the purchase-side LTV/LTC was sized on a value the appraisal does not support." | Replace file `as_is_value` with appraisal As-Is → **reprice**; Reduce purchase price (renegotiation) → **reprice** `purchase_price`; Grant documented exception (warning downgrade, requires reason + approver role); Request revised appraisal / ROV; Decline file. | **Yes** (Replace As-Is or reduce price) | **Yes** |
| **F5** | **As-Is missing (PDF-only / estimate)** | No definite As-Is from XML (`error-handling-and-confidence.md`: 12/33 case). | **warning** (officer condition, not a match finding) | "We couldn't read the As-Is value from the appraisal data. Open the report and enter it." → opens internal condition **`appraisal_as_is_verify`**; comp-cluster estimate shown as a hint only. | Enter As-Is from report (satisfies condition, populates `as_is_value` → **reprice** if it changes economics); (no dismiss — value is required). | Yes (on entry) | **Yes** (via `appraisal_as_is_verify`) |
| **F6** | **Loan no longer supported at max LTARV** | Registered `loan_amount` ÷ appraisal ARV > program max LTARV. Default LTARV cap **70%** (Gold band 65–75%). | **fatal** | "At the appraised ARV ($X), the loan of $L is n% LTARV — above the program max of m%. The loan must be resized or the value re-supported." | Replace file ARV → **reprice** (engine resizes to the cap); Reduce loan amount → **reprice**; Request revised appraisal / ROV; Decline file. | **Yes** | **Yes** |
| **F7** | **Loan no longer supported at max As-Is LTV/LTC** | Purchase advance ÷ lower(PP, appraisal As-Is) > program max LTV, **or** loan ÷ (PP + rehab) > max LTC. Default As-Is LTV **≤75%**, LTC **≤90%**. | **fatal** | "At the appraised As-Is value ($X), the purchase-side leverage is above the program limit. The loan must be resized." | Replace file As-Is → **reprice**; Reduce loan / increase borrower equity → **reprice**; Exception (approver role); Decline. | **Yes** | **Yes** |
| **F8** | **Subject address mismatch** | Normalized appraisal address ≠ file address (house-number equality + exact suffix-normalized street tokens; same matcher discipline as `sharepoint-map.js`). | **fatal** | "The appraisal is for a different property address ($X) than the file ($Y). Confirm the correct subject before proceeding." | Correct file address (audited) → re-run match; Confirm appraisal is for this subject (override with reason); Request corrected appraisal; Decline. | No (address is not a pricing input) | **Yes** |
| **F9** | **Property type / units mismatch** | File `property_type`/`units` ≠ appraisal (e.g. file 3-unit, appraisal 1004 SFR 1-unit; form type vs units inconsistent). | **fatal** | "The file says [3-unit] but the appraisal is a [1004, 1-unit SFR]. Unit count and form type must agree — this changes value approach and pricing." | Correct file `units`/`property_type` → **reprice**; Confirm appraisal form is correct and fix file; Request correct form (e.g. 1025 for 2–4 unit); Decline. | **Yes** (units/type) | **Yes** |
| **F10** | **Borrower / LLC not on appraisal** | Appraisal party name matches neither file borrower nor vesting LLC (`field-reliability.md` matching rule). | **warning** | "The name on the appraisal ($X) doesn't match the borrower or the vesting LLC on file. Confirm this is the same deal." | Confirm/attach explanation (dismiss with reason); Correct file party; Request corrected appraisal. | No | No |
| **F10b** | **No party name at all** | Appraisal names no borrower and no entity. | **fatal** | "The appraisal has no borrower or entity name — cannot tie it to this file." | Request corrected appraisal; Decline. | No | **Yes** |
| **F11** | **Contract price ≠ file purchase price** | Appraisal `contract_price` present and ≠ file `purchase_price` by more than `max($2,500, 1%)`. | **warning** | "The contract price on the appraisal ($X) differs from the purchase price on file ($Y). Confirm which is correct — an assignment fee or a price change may explain it." | Replace file `purchase_price` → **reprice**; Keep file value with reason (e.g. assignment: appraisal shows seller's price, file shows effective price); Request corrected appraisal. | **Yes** (if replaced) | No |
| **F12** | **Effective date stale** | `today − effective_date` > **120 days** at projected close. (RTL window commonly 60–120d; conventional 4-month rule.) | **warning** → **fatal** if > 120d at actual note date. | "The appraisal's effective date ($D) is n days old. Over our 120-day limit it needs a 1004D update before closing." | Request 1004D update/recert; Extend with dated exception (approver); Order new appraisal; (auto-clears when a 1004D with a fresh date is imported). | No | **Yes** when > 120d at note date |
| **F13** | **Appraiser license expired / wrong state** | `license_exp` < effective date, or `license_state` ≠ subject state. | **fatal** | "The appraiser's license appears expired ($E) or not valid in [state]. The appraisal may be ineligible." | Attach proof of active license (dismiss); Request corrected appraisal; Decline. | No | **Yes** |
| **F14** | **Condition below program floor (C5/C6)** | Subject UAD condition = C5 or C6. | **warning** (fatal if program forbids C5/C6 as-is). | "The property is rated [C5], which is below the as-is condition floor. It typically requires the 'subject-to-repairs' path and a rehab plan." | Confirm subject-to path + rehab plan on file (dismiss with reason); Exception (approver); Decline. | No | Only if program floor makes it fatal |
| **F14b** | **Condition non-UAD (worded)** | Condition read as words ("Good"), not a C-code (`confidence: non_uad`). | **info/verify** | "The appraisal states condition in words, not a standard C-code — confirm the rating." | Confirm rating (verify); no block. | No | No |
| **F15** | **Comps too far / too old** | Any of 3 primary comps > **1 mile** (urban/suburban) or sale > **12 months** old, without appraiser commentary. | **warning** | "One or more comparable sales are outside our distance/recency guide (>1 mi or >12 mo) without explanation." | Accept with appraiser commentary (dismiss); Request additional comps / ROV. | No | No |
| **F16** | **Fewer than 3 closed comps** | `n_comps` < 3 closed sales. | **warning** | "The appraisal has fewer than three closed comparable sales." | Request additional comps; Accept with reason. | No | No |
| **F17** | **Subject-to needs completion evidence** | `condition_of_appraisal` ∈ {SubjectToCompletion, SubjectToRepairs} (ARV report). | **info** (becomes a funding condition) | "This ARV is 'subject-to-completion.' A Form 1004D Certificate of Completion is required at project completion before final draw/exit." | Opens/queues the 1004D-at-completion condition (funding-stage, not a CTC blocker). | No | No (funding-stage) |
| **F18** | **CU / SSR overvaluation (if available)** | CU risk score ≥ **2.5** or overvaluation flag; or delivered appraisal ≠ SSR. | **warning** (escalate; fatal ≥ 4.0 or hard SSR mismatch). | "Collateral Underwriter flagged elevated valuation risk (score X). Escalate for overvaluation review." | Escalate to review/second appraisal; Accept with senior sign-off (approver); Decline. | No | Only if escalation makes it fatal |
| **F19** | **DSCR rent below file assumption (1025)** | Appraiser market rent (or lower of actual/market) < file rent assumption by > `max($100, 5%)` monthly; or resulting DSCR < program floor (default **1.20**). | **warning** → **fatal** if DSCR falls below the program's hard floor (e.g. 1.0). | "The appraisal's market rent ($X/mo) is below the file's assumption ($Y/mo). Recomputed DSCR is n.nn, below the m.mm floor." | Replace file rent assumption → **reprice** (DSCR band drives pricing); Keep with documented leases; Request 1007/1025 clarification; Decline. | **Yes** (rent is a pricing input) | **Yes** if below hard DSCR floor |
| **F20** | **GRM sanity (1025)** | Income-approach value or GRM diverges materially from sales-comparison value (default > **15%**), or GRM outside plausible band for market. | **info/verify** | "The income-approach value diverges from the sales-comparison value by more than 15% — review the reconciliation." | Review/confirm (verify); Request appraiser clarification. | No | No |
| **F21** | **Confidence — field needs verify** | Any pricing-relevant field `confidence` ∈ {missing, non_uad, estimate}. | **warning (verify)** | "We couldn't read [field] with certainty — please confirm against the report before clearing." | Confirm value from report (verify → definite); the underlying value is NOT auto-used until confirmed. | Only when the confirmed value changes a pricing input | **Yes** for a **required** pricing field (ARV, As-Is, units) via its own condition; otherwise No |
| **F22** | **Value type ambiguous / condition unreadable** | A parsed value has no identifiable `conditionOfAppraisal` (`industry-research.md` §2.3 design rule). | **fatal** | "We couldn't tell whether this appraised value is As-Is or After-Repair. This must be resolved — using the wrong one mis-sizes the loan." | Officer labels the value from the report; Request corrected appraisal. | Possible (once labeled) | **Yes** |
| **F23** | **Rehab scope vs appraiser subject-to scope** | Appraiser's subject-to scope/plans materially diverge from file `rehab_budget`/SOW (default > **15%**). | **warning** | "The appraiser's assumed scope of work differs materially from the borrower's rehab budget on file. The ARV may be predicated on a different scope." | Reconcile SOW with appraiser scope; Accept with reason; Request appraiser clarification. | No (budget is frozen; reopens SOW condition if `rehab_budget` is later changed) | No |

---

## 3. Recommended default thresholds (all owner-tunable)

| Threshold | Recommended default | Basis / citation |
|---|---|---|
| ARV mismatch tolerance | `max($5,000, 2%)` of file ARV | Rounding-noise floor; ARV is "the most abused number" → tight band (`industry-research.md` §4.1). |
| As-Is vs purchase price tolerance | `max($5,000, 2%)` of price | Lender lends on lower of price/value; shortfall = reprice/renegotiate ([AmeriSave](https://www.amerisave.com/learn/low-home-appraisal-guide-steps-to-take-when-the-number-comes-in-below-your-purchase-price)). |
| Contract vs file price tolerance | `max($2,500, 1%)` | Tighter — a real price/assignment difference should surface. |
| Max **LTARV** | **70%** (band 65–75%) | Common F&F exit cap (`industry-research.md` §4.1). |
| Max **As-Is LTV** | **75%** | "lower of PP or as-is," ~70–75% (`industry-research.md` §4.1). |
| Max **LTC** | **90%** | ~85–90% typical (`industry-research.md` §4.1). |
| Effective-date window | **120 days** at note date (warn at 90) | 120-day / 4-month rule + 1004D ([VDMC cheat sheet](https://blog.vdmc.net/wp-content/uploads/2020/01/Appraisal-Expiration-Cheat-Sheet.1.16.20.pdf), [Freddie 5604.3](https://guide.freddiemac.com/app/guide/section/5604.3)). |
| Comp distance / recency | **1 mile** / **12 months** | GSE/MI review checklists (`industry-research.md` §4.2). |
| Min closed comps | **3** | Standard appraisal-review minimum (`industry-research.md` §4.2). |
| DSCR floor | **1.20** comfortable / **1.00** hard | Common DSCR bands (`industry-research.md` §5). |
| CU escalation | **≥ 2.5** warn / **≥ 4.0** fatal | 2.5 = Day-1-Certainty line; 4–5 = heightened review ([Fannie CU](https://singlefamily.fanniemae.com/applications-technology/collateral-underwriter), [JVM](https://www.jvmlending.com/blog/what-is-a-cu-score-on-an-appraisal/)). |
| Income-vs-sales / scope divergence | **15%** | Reconciliation review flag (`industry-research.md` §3, §4.2). |

---

## 4. The repricing chain

**Which resolved actions change a file value and therefore reopen pricing:**
`as_is_value`, `arv`, `purchase_price`, `units`, `property_type`, `rehab_budget` (SOW only), and the
DSCR **rent assumption**. These are exactly the pricing inputs the existing trigger
`trg_reopen_on_budget_change` (`db/071`/`db/072`) watches.

**The chain (example: F1 "Replace ARV"):**

1. Underwriter picks **Replace file value with appraisal value** on finding F1, enters a reason.
2. The engine writes `applications.arv = <appraisal ARV>` through the **normal audited update path**
   (audit_log row: who, old→new, finding id, reason) — **not** a silent overwrite. This is the only
   way a file value ever changes.
3. The DB trigger sees `arv IS DISTINCT FROM` old and **reopens the `product_pricing` condition**
   (→ `received`, sign-off cleared) — the registered loan was priced on a stale ARV.
4. Pricing reopens: the frozen pricing engine (`src/lib/pricing.js` → `standard-program.js`/
   `gold-standard.js`) **resizes** the loan at the new ARV against all caps (min of LTPP/LTC, LTARV,
   hard cap). The engine numbers are **frozen** — we feed a corrected input, we never change the math.
5. The structure is **re-registered**; the term sheet / LTARV/LTV/LTC recompute.
6. The finding is marked **resolved**; if the resized loan still fails a cap, the corresponding fatal
   (F6/F7) re-fires against the new numbers.

**Action → input written → reopens:**

| Action | Writes | Reopens |
|---|---|---|
| Replace ARV (F1/F2/F6) | `arv` | `product_pricing` |
| Replace/enter As-Is (F4/F5/F7) | `as_is_value` | `product_pricing` |
| Reduce purchase price / replace price (F4/F11) | `purchase_price` | `product_pricing` |
| Correct units / property type (F9) | `units` / `property_type` | `product_pricing` |
| Replace rent assumption (F19) | rent assumption | `product_pricing` |
| Reduce loan amount (F6/F7) | `loan_amount` | `product_pricing` |
| Correct address (F8) | `address` | — (re-runs match, not pricing) |

Actions that **do not** reprice: Keep file value, Dismiss with reason, Acknowledge, Request revised
appraisal / 1004D, Escalate, Confirm license, Decline (Decline closes the file, not a reprice).

---

## 5. The blocking condition (CTC gate)

**Internal condition `appraisal_review_cleared`** (staff-only, mirrors the existing internal-condition
pattern — `db/059`, and the `appraisal_as_is_verify` gate):

- **Definition:** "All appraisal/underwriting PILOT findings cleared."
- **Gate:** the condition **cannot be signed off / satisfied while ANY fatal appraisal finding is open**
  (F1, F4, F5-condition, F6, F7, F8, F9, F10b, F12>120d, F13, F14-when-fatal, F18-when-fatal, F19-below-
  floor, F22). Enforced in **two layers**, matching the SOW-budget gate precedent:
  1. **App layer** — `signOffGate` returns **422** if any fatal appraisal finding row is open when
     someone tries to satisfy `appraisal_review_cleared`.
  2. **DB layer** — a belt-and-suspenders trigger on `checklist_items` refuses to flip
     `appraisal_review_cleared` to `status='satisfied'` while an open fatal finding exists for the file
     (same shape as `db/069`'s `trg_sow_budget_guard`, `COALESCE`-guarded so it never blocks unrelated
     conditions).
- **Warnings** do not hold the gate, but each must be **acknowledged or dismissed with a reason** to
  leave the open-review count; an un-actioned warning shows in the badge but does not block CTC.
- **CTC** (clear-to-close) is blocked while `appraisal_review_cleared` is open — same mechanism as
  every other internal condition. `appraisal_as_is_verify` (F5) and any 1004D-stale (F12) condition
  gate CTC independently as well.
- **Reopen semantics:** a re-import of a revised appraisal **reopens** `appraisal_review_cleared` and
  re-runs every check (findings are recomputed against the new XML; resolved findings whose underlying
  discrepancy is gone auto-clear; still-present ones stay/re-fire).

**Backfill (previous AND future):** ship the condition + gate as an idempotent numbered migration that
`INSERT … SELECT … WHERE NOT EXISTS` onto every active/closed file (mirrors `db/041`/`db/066`), so
existing files pick up the appraisal-review gate on next boot — never new-files-only.

---

## 6. The findings badge

Show the LO/processor a compact badge on the file:

- **Primary number: open FATAL count** (`n` red) — "n appraisal issues must be resolved before
  clear-to-close." Zero fatals = green "Appraisal review clear."
- **Secondary: open warning/verify count** (amber) — review items that need acknowledgement but don't
  block.
- Info findings are not counted in the badge (available in the full findings list).
- The badge reads the same source of truth as the gate: **fatal count > 0 ⟺ `appraisal_review_cleared`
  cannot close ⟺ CTC blocked.** One number, one meaning, no drift (same discipline as the stale-build
  watchdog / SOW badge).

---

## 7. Never auto-overwrite — the audit guarantee

- The engine **reads** the appraisal and **compares**; it **proposes**. It never writes a file value on
  its own.
- Every value change is an underwriter action carrying: actor, finding id, old value, new value,
  reason, timestamp → one `audit_log` row (GLBA PII trail). The comp-cluster As-Is estimate and any
  `estimate`/`non_uad` value are shown as **hints beside the input**, never saved
  (`error-handling-and-confidence.md`).
- A human-entered value is never overwritten by a lower-confidence re-import (overwrite-shield). A
  re-import surfaces a **new finding** ("appraisal now shows a different ARV than the file") for the
  underwriter to action — it does not silently replace the human's number.

---

## 8. Notes for build

- **Route by `AppraisalFormType`** first (1004 vs 1025 vs 1073) — DSCR/rent findings (F19/F20) only
  apply to income files; unit/form findings (F9) are form-aware (`field-reliability.md`).
- **F5 already exists** as `appraisal_as_is_verify` — the match engine should *consume* it, not
  duplicate it: if that condition is open, F5 is its finding face; clearing it (officer enters As-Is)
  flows into the reprice chain.
- Thresholds live in one config object (owner-tunable), surfaced in an admin screen; each finding
  records which threshold/version fired it, so a tuning change is auditable.
- All money comparisons normalize formats first (strip commas, parse `full.half`) per the existing
  normalization rules before comparing.

---

## 9. Sources

- `industry-research.md`, `field-reliability.md`, `error-handling-and-confidence.md` (this repo).
- Appraisal shortfall / renegotiation options: https://www.amerisave.com/learn/low-home-appraisal-guide-steps-to-take-when-the-number-comes-in-below-your-purchase-price ; https://themortgagereports.com/12508/my-home-appraised-too-low-appraisal
- 120-day / 4-month validity + 1004D: https://blog.vdmc.net/wp-content/uploads/2020/01/Appraisal-Expiration-Cheat-Sheet.1.16.20.pdf ; https://guide.freddiemac.com/app/guide/section/5604.3
- Collateral Underwriter risk score (2.5 / 4–5): https://singlefamily.fanniemae.com/applications-technology/collateral-underwriter ; https://www.jvmlending.com/blog/what-is-a-cu-score-on-an-appraisal/
- LTV/LTC/LTARV, comp distance/recency, DSCR bands, value reconciliation: cited inline in `industry-research.md` §4–5.
