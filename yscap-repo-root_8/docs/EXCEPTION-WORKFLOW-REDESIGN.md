# Exception Workflow Redesign — Research + Blueprint (2026-07-24)

**Status: WAVE 1 SHIPPED** (this document is both the research record and the design of record).
Owner ask: *"enhance the entire exception design and workflow — full redesign."*

---

## 1. What "exception" meant in PILOT before this redesign (the fragmentation map)

Deep code research found **six parallel mechanisms** that each record "someone senior said yes
to a deviation," none of which could see the others:

| # | Mechanism | Table | Decision recorded as | Screen |
|---|---|---|---|---|
| 1 | Loan exceptions (guaranty waiver, esign-before-CTC) | `loan_exceptions` (db/268) | row + effect flag | `/internal/exceptions` |
| 2 | Manual-program escalations (+ counter-offer) | `manual_program_escalations` (db/207, db/230) | row + released terms email | `/internal/escalations` |
| 3 | **Pricing "Request an exception"** | **NONE** | audit line only | — (dead end) |
| 4 | Finding-level `grant_exception` (tiered authority) | `document_findings.resolution` | verb on the finding | file underwriting desk |
| 5 | Experience exception | 3 columns on `applications` (db/205) | column + audit | none (API-only) |
| 6 | Issuance-backstop override (R6.18) | none | audit line + `history.forced` | inline blocker |

Plus two orphans: `guideline_exceptions` (db/259 — fully specified, **zero writers, zero UI**,
but the only table that had `expires_at` + `compensating_factors`), and the
condition **waive** family (a task-completion verb, deliberately not a policy deviation).

### The worst finding
The studio button literally labeled **"Request an exception"** (staff `staff.js` + borrower
`borrower.js` `/pricing/request-exception`) created **no reviewable record at all** — only a
`workflow_items` hand-off and a notification whose deep link pointed at the Escalations page,
which **structurally cannot display it** (it lists only `manual_program_escalations`). The
super-admin landed on a queue that didn't contain the thing they were sent to review; the
request had no status, no decision, no history. Meanwhile the decision certificate's
"exceptions granted" list read **only** mechanism #4, so the file's own attestation was
materially incomplete.

Two live bugs found and fixed in the same pass:
- A comment on an **esign** exception audited as `guaranty_exception_comment` and emailed
  participants guaranty-waiver wording ("waive the co-borrower's personal guaranty") regardless
  of type.
- A requester could **"clear" their own still-open request** — burying a pending ask with no
  decision trail (audited as housekeeping), and freeing the one-open-per-file index.

## 2. Industry research (what the register must be able to answer)

Sources: OCC Comptroller's Handbook (Loan Portfolio Management / 2026 Lending booklet), FDIC
exam manual §3.2, Interagency Real-Estate Lending Standards (12 CFR 365 App. A — the LTV
exception-report model), 7 TAC §91.715, fair-lending exception guidance (Asurity/Ncontracts),
LOS implementations (nCino, Abrigo/Sageworks, Encompass conditions), investor exception desks
(Deephaven/NewRez/Arch/PennyMac forms, Fannie DUS Gateway), and RTL diligence practice
(Clayton/AMC TPR grades, "Exception Loan" whole-loan definitions, DBRS RTL primer).

The recurring expectations, distilled:
1. An exception is a **first-class object with a unique ID**, typed, quantified, linked to the
   loan — never a note in a hand-off queue.
2. **Compensating factors** are the justification unit ("what did we accept in exchange") —
   structured, reportable, in the permanent loan file.
3. **Time-boxed approvals**: validity windows; renewal = re-assessment, never auto-extension;
   **material change re-opens the question** (an approval must not silently ride a re-priced deal).
4. **Register + aggregate reporting**: counts and dollars by type/status/requester, approval
   rate, time-to-decision, aging — regulators and note buyers judge the *program*, not one file.
5. **SLA clocks** on open requests (competitive desks answer in 24–48h) with escalation.
6. Diligence-ready output: the loan file must show approver, authority, quantified variance,
   factors, and the written decision — that's the difference between a TPR grade-B
   ("outside guidelines WITH documented approval and compensating factors") and a kicked loan.
7. Separation kept: **documentation/condition exceptions stay a lighter, separate lifecycle**
   from credit-policy exceptions (merging them is the classic register-bloat mistake).

## 3. The redesign (what shipped in Wave 1)

### 3.1 One register, generic engine
`loan_exceptions` is now THE policy-exception register, driven by a **type registry**
(`EXCEPTION_TYPES` in `src/lib/loan-exceptions.js`): per-type label, reason-code map, subject
shape, expirability, review SLA, record-only flag. `reasonCodesFor()` is registry-driven (the
old per-type ternary is gone). Adding a type = one registry entry + one migration widening the
DB CHECK + one `TYPE_META` entry in the UI card.

Types after Wave 1:
- `guaranty_waiver` (unchanged semantics; approval still flips `co_borrower_pg_waived`).
- `esign_before_ctc` (unchanged semantics; per-requirement waivers + live-gate validation intact).
- **`pricing_exception` (NEW)** — the studio's "Request an exception" now writes a real
  register row (structured reason + compensating factors + deal snapshot), **and still** opens
  the workflow escalation + admin notification (both surfaces survive). The borrower-portal ask
  is recorded too (`requested_by_kind='borrower'`). The notification deep link now points at
  the Exceptions box (`?app=`), which can actually show it; the Escalations page shows a
  cross-link banner when a deep link misses (the old dead end).
  **The GRANT is unchanged**: approval records the *decision*; a super-admin still applies the
  approved terms in the Term Sheet Studio (admin override, e.g. `ovrEffPrice`) and re-registers.
  Nothing touches a frozen engine number.
- **`issuance_override` (NEW, record-only)** — every R6.18 super-admin override past a fatal
  hard-warning (both status doors + TPR/MISMO exports) now also lands in the register as a
  born-approved record (best-effort — can never block the status change it documents).

### 3.2 Governance columns (db/306 — additive, idempotent, NULL = legacy behavior)
- `compensating_factors jsonb` — structured `[{code, note}]` from the shared
  `COMPENSATING_FACTORS` taxonomy (FICO strength, liquidity, low leverage, experience,
  guarantor strength, rate premium, paydown, repeat sponsor).
- `deal_snapshot jsonb` — the deal economics at REQUEST time (loan amount, prices, budget,
  ARV, program, assignment shape, claimed experience), so the reviewer sees what the requester
  saw. **`deal_drift`** (computed on read) flags when the live file has moved since —
  advisory only; a granted waiver only ever changes by human decision.
- `expires_at` / `expired_at` + status **`expired`** — approval validity on **expirable types
  only** (esign, pricing; guaranty is engine-refused — a term-sheet flag is never clock-driven).
  The sweep flips lapsed approvals to `expired`, which **fails closed by construction** (the
  e-sign gate and every consumer honor only `status='approved'`).
- `due_at` — review SLA per type (esign 24h, guaranty/pricing 48h).
- `re_request_of` — the re-request chain (a fresh ask after deny/withdraw/expiry links back).
- `withdrawn_by/withdrawn_at` — withdraw no longer overloads `decided_by` (legacy rows keep
  their old stamps; readers COALESCE).
- `requested_by_kind` (`staff|borrower|system`) + `requested_by_borrower_id`.
- `exception_seq` → the **EX-n reference** used on cards, exports, certificates.
- `severity` (advisory/standard/material — display + reporting only, never a gate).
- `updated_at` trigger (no more hand-maintained drift).

### 3.3 Lifecycle tightenings (bug fixes)
- **An OPEN request can no longer be cleared** — withdraw or decide first (server + engine +
  UI). A new request still supersedes an open one, so a file is never stuck.
- **Withdraw is requester-or-admin only** (was: any staffer with file access).
- Comment audit action + notification copy are **type-aware** (the esign/pricing comment no
  longer masquerades as a guaranty event).
- The decision-note textarea no longer silently doubles as the clear note (clear prompts for
  its own note).

### 3.4 The decision desk (UI)
`/internal/exceptions`: register-report strip (open, past-target, oldest, approval rate,
decided-weighted typical decision time), **type filter chips**, status chips incl. Expired, **Export
register** (xlsx — the diligence artifact: EX-n, type, quantified picture, factors, decision
trail, drift), aging chips (overdue in red), per-type decide flows (esign keeps its live-gate
waive pickers; approvals on expirable types get an optional **"valid until"** date).
`ExceptionCard` renders EX-n, type chip, severity, aging, compensating factors, re-request
chain, deal-drift warning, expiry state, and a corrected lifecycle trail (withdrawn-by).

**On the file**: a new **"Exceptions (policy register)"** section (`sec-exceptions`,
`ExceptionRegisterCard`) shows the loan's full deviation history at a glance — the
"what exceptions does this loan carry" answer, with EX-n references.

**My exceptions**: always in the nav now (the old link vanished when nothing was open, making
history unreachable), withdrawn/expired filters added, re-request hint on denied/expired rows.

**Studio**: the request box now files a tracked record — structured reason picker +
compensating-factor checkboxes (staff), and an inline banner showing the file's current
pricing-exception state so nobody double-files.

### 3.5 Notifications & clocks
New registered types: `pricing_exception`, `pricing_exception_decided`, `exception_comment`,
`exception_aging`, `exception_expired` (all action-bearing staff events → email + in-app,
consistent with the guaranty/esign set). Two self-gated digest jobs
(`notification-digests.js`): **exceptionAgingOnce** (open requests past `due_at` → super-admins,
once/day) and **exceptionExpirySweepOnce** (flips lapsed approvals through the business day +
tells the file team; audited `loan_exception_expired`).

### 3.6 Cross-system completeness
The **decision certificate** now aggregates `policy_exceptions` (approved register rows —
ref, type, decider, validity, waived codes) alongside the finding-level exceptions, so the
attestation's "exceptions granted" promise is finally true.

## 4. What deliberately did NOT change (policy boundaries)

- **Decide = `manage_pricing` (admins + super-admins), requester ≠ approver.** Originally
  super-admin-only; **widened to any Admin by owner direction 2026-07-26** ("let any Admin
  approve"). The requester≠approver control is independent and STILL enforced (you can never
  approve your own request). The registry has room for finer per-type authority; further
  changes to WHO decides remain an owner decision.
- **Frozen pricing engines untouched.** A pricing-exception approval records a decision; the
  numbers only ever change through the existing authorized studio override + re-register path.
- **Manual-program escalations stay separate** (register + counter-offer flow serving the
  register-driven MANUAL product pipeline). Near-isomorphic to `loan_exceptions` — a future
  unification candidate, but it drives live borrower-email semantics and was not worth the
  regression risk in Wave 1. Same for `finding_escalations` (peer-help channel, not a policy
  deviation), condition waives (task completion), and the experience exception's
  `waive_conditions` authority (its rows surface in the register view read-only via the file
  panel in a later wave).
- **Borrowers see nothing new.** The register is staff-only; the borrower pricing ask gets the
  same simple confirmation as before. No note-buyer name can reach a borrower surface from any
  of this.

## 5. Roadmap (future waves, in leverage order)

1. **Investor/note-buyer exception leg** — per-buyer "fail-but-exceptionable" detection off the
   ISG desk, generated buyer-specific request packages, tracked buyer decisions with the
   written approval artifact filed to the loan (the DUS-Gateway pattern; grade-B vs kicked).
2. **Quantified variance fields** — `guideline value vs actual vs approved` per request
   (the Deephaven/Arch form unit), feeding exception-density and repeat-exception analytics.
3. **Fold `manual_program_escalations` into the register** as a type (absorbing counter-offer
   as a first-class state) — collapses two queues/badges/screens into one.
4. **Exception-cohort performance loop** (OCC feedback loop): tag funded exception loans,
   compare draw/extension/payoff behavior vs clean cohort by type.
5. **Authority matrix / dual sign-off** — per-type decision capability + four-eyes above
   thresholds, when the owner wants to delegate below super-admin.
6. Retire the orphaned `guideline_exceptions` table (db/259) onto the register; port
   `guideline-intelligence.activeExceptions` to read approved register rows.

## 6. Verification

- `db/306` applied twice (idempotent) on a fresh chain of all migrations (renumbered 295 → 296 → 303 → 305 → 306 as parallel sessions kept landing migrations on main; the number is claimed at merge time per the house renumber rule).
- `scripts/test-exception-register-db.js` (NEW, in `npm test`): 63 assertions — registry,
  SLA/due_at, factors sanitize, drift, request/deny/re-request chain, withdraw stamps,
  clear-of-open refusal, expiry validation + sweep semantics (guaranty immune) + read-time
  fail-closed presentation, borrower-kind requests, issuance-override never-throws,
  register/list filters/metrics/aging, updated_at trigger.
- `scripts/test-loan-exceptions.js` updated for the tightened clear semantics (59 assertions).
- `test-esign-before-ctc-pure.js` (48), `test-esign-gate.js` (27, DB),
  `test-pricing-exception-escalation.js` — all green, proving the esign gate and frozen
  pricing semantics are untouched.
- Server boots clean against a fresh Postgres (module graph + migrations); V2 portal rebuilt;
  eslint `no-undef` clean on every changed JSX file.
