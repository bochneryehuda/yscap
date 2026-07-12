# Design: Borrower Change-Request "Sandbox"

_Part of the [Portal Look-Back Audit](../00-MASTER-PLAN.md). Findings S5-03 + S2-05.
This is a **design/research document** — the research-first step you asked for.
No sandbox code is built yet; the small **immediate fix** below is separate and
lands first._

---

## The problem (in plain words)

Right now, after a borrower submits their application and a product is priced,
the borrower can still **quietly change the deal's numbers** — the after-repair
value (ARV), rehab budget, purchase price — straight into the live loan record.
Two bad things follow:

1. Those numbers feed the automatic rules, so a borrower who **inflates the ARV**
   can make the loan look less risky and cause a "needs extra review" condition
   to **auto-delete itself** — a caution flag vanishes with nobody noticing
   (S5-03).
2. The change lands with **no approval and no record** — even on an approved or
   funded file (S2-05).

**What you asked for:** after the borrower submits (past products & pricing),
lock the borrower out of directly editing the deal. Let them **propose** changes
in a safe area; the change goes to the **loan officer + processor** for approval;
only once approved does it take effect. "A lot of reasoning, modern design."

---

## Part 1 — The immediate fix (lands now, separate from the sandbox)

Two small changes that stop the bleeding without the full sandbox:

1. **Never auto-delete a condition off a borrower edit.** When a borrower-editable
   number would remove or change an automatic condition, the engine instead
   **flags it and alerts the loan officer + processor** for a human look — the
   condition stays until a person clears it.
2. **A borrower number is "claimed, pending review," not truth.** A borrower's
   typed value is held as *claimed* and does not overwrite the underwriting basis
   until staff accept it; the registered/priced basis keeps using the accepted
   value.

This is the S5-03 "hold as claimed + alert" fix. It's the floor. The sandbox
below is the full solution.

---

## Part 2 — How the big lenders handle this (research)

Post-submission change control is a solved problem in mortgage/lending software.
The consistent pattern across the major loan-origination (LOS) and
point-of-sale (POS) platforms:

- **The application locks on submission.** After the borrower submits, the
  borrower-facing app becomes **read-only for deal terms**. The borrower can
  still upload documents and message, but cannot silently rewrite the numbers the
  loan was priced/underwritten on. (Encompass / Encompass Consumer Connect,
  nCino, Blend, SimpleNexus, Roostify all work this way.)
- **Changes are a *request*, not an *edit*.** To change a term after submission,
  the borrower (or the loan officer on their behalf) opens a **change request** —
  a proposed new value with a reason. The live record is untouched while the
  request is pending.
- **A human approves, and it's a two-key action for money terms.** A licensed
  person (loan officer / processor / underwriter) reviews the request. For terms
  that affect pricing or risk (loan amount, value, program), approval often
  requires the file to be **re-priced / re-disclosed**, not just a rubber stamp.
- **Everything is logged (change of circumstance).** Mortgage rules (TRID /
  "changed circumstance") require an **auditable trail**: who requested what, the
  old and new value, who approved, when, and why. This is exactly the audit-trail
  gap S2-05 found.
- **Re-trigger downstream work automatically.** An approved change to a priced
  input **re-opens** the products-&-pricing and any dependent conditions (this
  portal already has a DB trigger that reopens P&P on economics changes —
  `db/071`/`072` — so the plumbing exists; we just need the *change* to flow
  through an approval gate first).

**Takeaway for us:** lock the terms on submit; turn edits into approved change
requests; log old→new→who→why; let an approval re-fire the existing
reopen-conditions machinery. That's the modern, compliant shape.

---

## Part 3 — Proposed design for this portal

### 3.1 The lock
When a file is past the **submitted / priced** stage (define precisely: once a
product is registered, or status has left early intake — reuse the existing
`file-lock.js` `structuralLockReason` used by `/pricing/register`), the borrower
endpoints that write deal economics (`complete-fields`, the info-field write
path, the rehab-budget tool's budget sync) **stop writing the live record** and
instead **open a change request**.

### 3.2 New data: `change_requests`
A new table (new numbered idempotent migration):

| column | meaning |
|---|---|
| id, application_id | which file |
| requested_by_kind/id | borrower or staff (on borrower's behalf) |
| field / field_label | which term (arv, rehab_budget, purchase_price, program, …) |
| old_value, new_value | for the audit trail (old = value at request time) |
| reason | borrower's note (why) |
| status | `pending` → `approved` / `rejected` / `superseded` |
| decided_by, decided_at, decision_note | the LO/processor who ruled |
| created_at, updated_at |

Only a **whitelisted** set of deal-economics fields can be change-requested
(the same list S2-05 flagged: arv, as_is_value, purchase_price, rehab_budget,
program, loan_type, property_type, units, and the interest-reserve/experience
inputs). Personal fields (phone, DOB) stay directly editable by the person who
owns them — those aren't the risk.

### 3.3 The flow
1. **Borrower proposes** a change in the sandbox (a clearly-labeled "Request a
   change to your loan" panel). The live record does **not** change. A
   `change_requests` row is created `pending`, and the **loan officer +
   processor are notified**.
2. **Staff review** on the file: they see old → requested value + the borrower's
   reason, and **Approve** or **Reject** (with a note). Approving is the
   authoritative action — gate it to the right role (processor/underwriter/admin,
   mirroring the sign-off capability), not the borrower.
3. **On approve:** apply the new value to the live record **inside an audited
   write** (old→new→who→why into `audit_log`), and let the **existing** economics
   trigger (`db/071`/`072`) reopen products-&-pricing / SOW as it already does.
   Re-price/re-register as needed.
4. **On reject:** the request closes; the live record never changed; the borrower
   is told (with the note).
5. **Superseded:** if the same field is change-requested again, the older pending
   request is marked `superseded` so the queue stays clean.

### 3.4 Guardrails / edge cases
- **Race / stale value:** store `old_value` at request time; if the live value
  changed before approval, surface that to the approver ("value changed since
  this was requested").
- **Funded files:** on a funded file, allow change requests but require an
  **admin/underwriter** approval and flag prominently (post-closing changes are
  sensitive).
- **Co-borrower:** either party may request; the audit records which one.
- **No silent condition deletion, ever:** the engine's auto-remove stays disabled
  for borrower-driven changes (Part 1) — approvals go through the reopen trigger,
  not auto-delete.
- **Staff-on-behalf:** a loan officer can file the request for a borrower (phone
  applications); it still needs the second-person approval for money terms
  (separation of duty).

### 3.5 What we reuse (so this isn't from scratch)
- `src/lib/file-lock.js` — already computes a "structural lock" reason; extend it
  to gate the borrower economics writes.
- `db/071`/`072` economics-reopen triggers — already reopen P&P/SOW on a real
  economics change; an approved request becomes that "real change."
- `notify.notifyStaff` / the conditions engine — already in place for the alerts
  and re-evaluation.
- The audit-log pattern used by the staff `edit_application` (before/after diff).

---

## Part 4 — Phased build plan (when approved)

1. **Phase 0 (now, tiny):** Part 1 immediate fix — never auto-delete on a
   borrower edit; hold borrower numbers as claimed + alert LO/processor.
2. **Phase 1 (lock):** stop the borrower economics writes from touching the live
   record post-submit; return "submit a change request" instead. (No borrower can
   silently change terms — closes S2-05 hard.)
3. **Phase 2 (requests):** `change_requests` table + borrower "request a change"
   panel + staff review/approve/reject on the file + audited apply-on-approve.
4. **Phase 3 (polish):** stale-value warnings, funded-file admin gate,
   supersede handling, and a small "pending changes" badge in the pipeline.

Each phase is independently shippable and audited like every other fix.

---

## Open questions for you (before Phase 1)
1. **Where exactly is the lock line?** My recommendation: **once a product is
   registered** (that's when terms become authoritative). Before that, the
   borrower can still edit freely. Agree, or lock earlier (at submit)?
2. **Who approves a change request?** My recommendation: the **processor /
   underwriter / admin** (the same people who sign off conditions) — not the loan
   officer alone, to keep two-key control on money terms. Agree, or is loan-officer
   approval enough for non-funded files?
3. **Should the borrower be able to open a request at all, or only the loan
   officer on their behalf?** (Some lenders keep it staff-only.)

Tell me the answers and I'll build Phase 0 + Phase 1 first, then the rest.
