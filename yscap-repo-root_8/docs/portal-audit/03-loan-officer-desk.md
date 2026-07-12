# Section 3 — The Loan Officer's Desk: Pipeline & the Staff File

_Part of the [Portal Look-Back Audit](./00-MASTER-PLAN.md). We only write up
problems here — no code is being changed._

---

## What this section is about

Section 2 was "what the borrower sees." This is the flip side — **the staff
side**: the pipeline, the loan file as staff work it, and the guardrails
**between staff levels**. Your team isn't one blob: a **loan officer** sells and
shepherds the deal, a **processor/underwriter** does the checking and the
**sign-offs**, and **admins** run the shop. The whole design says a loan officer
can *look at* and *review* things, but the **completing, approving, and
funding** decisions belong to processors/underwriters/admins.

Three questions drove this section:

1. Can a loan officer reach a file, or do something on it, that's **above their
   level**? (self-approval, taking over deals)
2. Can one staffer see **another officer's** files or aggregate data?
3. What can staff see about **each other**, and can anyone **act as a borrower**?

Three AI agents dug in; one stalled, so I finished its part (the staff-to-staff
piece) by hand. I verified the biggest findings against the real code myself.

---

## The headline: the two-tier "who can sign off" control has real holes

**The good news** (see the solid list at the bottom): borrower isolation still
holds, the pipeline and dashboard numbers a loan officer sees are correctly
limited to their **own** files, internal team chat is properly walled so an
officer can't read notes on files they're not on, there's **no way for a staffer
to pose as a borrower**, and the main "Sign off" button is correctly locked.

**The bad news:** the lock is on the *front* door but not the *side* doors. A
loan officer — who is only supposed to **review** — can, through other buttons:

- **Clear (complete) a loan's underwriting/funding conditions** (S3-01, the big
  one),
- **Sign off the LLC condition** by "verifying" the entity (S3-03),
- **Undo a processor's sign-off** (S3-04),
- **Take over another officer's file** by reassigning it (S3-02),
- **Move the file to "approved" or "funded"** (S3-05).

Put together, that's enough for a single loan officer to walk their own deal
most of the way to the closing table without a second set of eyes — the exact
thing the two-tier design exists to prevent.

_(Also belongs here: **S1-10** from Section 1 — the full appraisal credit-card
reveal has no role check, so any assigned officer can see the whole card. It's
already logged; it's really a staff-side least-privilege gap like the ones
below.)_

---

## The scoreboard for this section

| 🔴 Critical | 🟠 High | 🟡 Medium | ⚪ Low | Total |
|:-:|:-:|:-:|:-:|:-:|
| 1 | 3 | 6 | 2 | **12** |

Start with **S3-01** (loan officer completing conditions) and **S3-02**
(taking over files). They're the ones that break lending controls.

---

## The findings

Format, same as always: **🐞 The Bug → 🔎 Troubleshooting → 🔧 The Fix.**

---

### 🔴 S3-01 — A loan officer can "Clear" (complete) a loan's conditions, including the ones that gate funding
**Severity: 🔴 Critical** · Where: `src/routes/staff.js:1253-1262`

**🐞 The Bug.** The newer "first-class" loan conditions (underwriting items and
prior-to-funding items) are finished with a **"Clear"** button. That Clear action
has **no permission check** — it only asks "are you on this file?" So a loan
officer, who's supposed to only *review*, can mark these conditions **done**.

**🔎 Troubleshooting.** The Clear route runs the file-access check and then sets
the condition to "cleared" — full stop, no capability check. Its twin, the
**Waive** button two lines below in the same file, correctly starts with "do you
have the waive permission?" — which makes it obvious the lock on **Clear** was
simply forgotten. And because a file can't reach "clear-to-close" or "funded"
until these conditions are cleared or waived, a loan officer can empty the
blocker list themselves and walk the file toward funding. (They still can't
*force* past an un-cleared blocker — but they don't need to, because they just
cleared it "legitimately.")

**🔧 The Fix.** Put the same permission check on **Clear** that **Waive** already
has — require the **sign-off** capability to clear a condition. A loan officer
should get a "reviewed" stamp instead, never "cleared." Also hide the Clear
button for non-sign-off roles the way Waive is already hidden.

---

### 🟠 S3-02 — A loan officer can reassign (take over) a file, including one that isn't theirs
**Severity: 🟠 High** · Where: `src/routes/staff.js:1486-1515`

**🐞 The Bug.** Deciding who owns a loan file is meant to be a manager job — the
code's own comment even says "assigning files is an admin/underwriter function."
But the reassign action checks nothing except "can you open this file." So any
officer who can open a file can change who the officer or processor on it is —
including handing it to themselves.

**🔎 Troubleshooting.** Unlike archive/waive/vendor actions, the assign route has
no admin or capability check. It also accepts **any** active staff id as the new
"loan officer" — it doesn't even confirm the person is a loan officer (the
processor side does check). And the audit record stores only the **new** owner,
not who the file was taken *from*, so a takeover leaves a weak trail. This gets
worse next to S3-10: if someone is given **shared view** of a colleague's files
(meant as read-only), this bug turns that into the power to **flip those files to
themselves.**

**🔧 The Fix.** Lock the reassign action to admins/underwriters (or a new "manage
assignments" permission). If line officers must self-claim their own brand-new
files, allow only claiming an **unassigned** file — never reassigning one another
officer already owns. Check the new person is actually a loan officer, and record
**both** the old and new owner in the audit.

---

### 🟠 S3-03 — A loan officer can sign off the LLC condition by "verifying" the entity
**Severity: 🟠 High** · Where: `src/routes/staff.js:1825-1846`, `src/lib/llc.js:183-197`

**🐞 The Bug.** Verifying a borrower's LLC automatically **completes and signs
off** the internal "LLC" condition on every open file that uses that entity — and
stamps the verifier's name on it. But the "Mark LLC verified" button is only
guarded by "can you see this borrower," **not** by the sign-off permission. So a
loan officer can perform that sign-off.

**🔎 Troubleshooting.** The verify route checks only borrower access, then calls
the routine that flips the condition to "satisfied / signed off." The LLC's
documents must all be uploaded first (so an officer can't verify a bogus entity),
but the officer is still doing the **sign-off act** — and their name lands in the
record as the person who signed it.

**🔧 The Fix.** Require the **sign-off** capability to verify an LLC (verifying is
a sign-off), **or** separate the two: let verifying record the entity as verified
but leave the *condition* for a processor/underwriter to complete. Gate the
button to match.

---

### 🟠 S3-04 — A loan officer can undo a processor's sign-off
**Severity: 🟠 High** · Where: `src/routes/staff.js:1427, 1452, 1464-1466`

**🐞 The Bug.** The sign-off lock only blocks *setting* a condition to
signed-off. It does **not** block *undoing* one. So a loan officer can send a
request that **clears a processor's completion** and knocks the condition back to
"outstanding," reopening something a processor already finished.

**🔎 Troubleshooting.** The check says "if you're trying to mark this satisfied
and you can't sign off → blocked." But the reverse path — "un-sign-off" and
"downgrade the status" — is never checked against the sign-off permission. The
normal screen hides the "Undo sign-off" button from loan officers (proof it's
meant to be theirs alone), but the server doesn't enforce it, so a direct request
gets through.

**🔧 The Fix.** Require the sign-off permission for the **un-sign-off** path too —
any request that clears a sign-off or moves an item *out of* "satisfied." Loan
officers shouldn't be able to downgrade a completed condition.

---

### 🟡 S3-05 — A loan officer can move the file to "approved," "declined," or "funded"
**Severity: 🟡 Medium** · Where: `src/routes/staff.js:2129-2173, 2179-2202`

**🐞 The Bug.** Advancing a loan's status has no role check. So a loan officer on
their own file can move it to underwriting, **approved**, **declined**,
**withdrawn**, and even **funded** (if the file happens to have no open blocking
conditions — which S3-01 lets them arrange).

**🔎 Troubleshooting.** The only guard is on *forcing past* open blockers, which
needs an admin. But an ordinary status move needs nothing beyond file access. The
detailed "internal status" workflow has no gate at all. Status changes drive
borrower notifications, production metrics, and post-closing setup — real
downstream effects.

**🔧 The Fix.** Restrict the decision-grade moves (approved, clear-to-close,
funded, declined) to underwriters/admins, while still letting officers move a
file through the early stages.

---

### 🟡 S3-06 — A loan officer can change the deal's value inputs (as-is value, ARV), which quietly moves the pricing
**Severity: 🟡 Medium** · Where: `src/routes/staff.js:1958-2020`

**🐞 The Bug.** The system correctly stops a loan officer from touching the
**admin-only pricing knobs** (leverage caps, rate caps, manual experience). But
the **underlying numbers** those knobs act on — as-is value, ARV, purchase price,
rehab budget, program — are all editable by any assigned officer. Raising the
as-is/ARV value achieves nearly the same leverage bump without ever touching a
locked knob.

**🔎 Troubleshooting.** The edit is clean in one sense (a strict field list, with
a before/after audit — no sloppy mass-assignment). The gap is **who** may change
**which** fields: the pricing engine reads these value inputs off the file, so an
officer moving them, then re-registering, can lift the loan amount. The cap
protection guards the ratios but not the inputs feeding them.

**🔧 The Fix.** Treat the internal value fields (as-is / ARV / appraised value) as
**underwriter-controlled**: either gate edits to those specific fields, or
automatically **flag the pricing for re-review** whenever a non-admin changes a
value input after a product is registered.

---

### 🟡 S3-07 — Accepting one document can complete a condition that requires two
**Severity: 🟡 Medium** · Where: `src/routes/staff.js:2688-2690` (skips the gate at `:1326-1350`)

**🐞 The Bug.** There's a good rule that some conditions can't be completed until
**all** their required documents are in — insurance needs a binder **and** an
invoice; the fraud/background condition needs a background report (plus a criminal
report on Gold Standard files). That rule runs on the "Sign off" button — but the
separate **"Accept document"** action skips it. Accepting **any one** document
flips the whole condition to complete.

**🔎 Troubleshooting.** The accept path just marks the condition satisfied without
re-checking the other required documents. This isn't a role bypass (accepting
still needs the sign-off permission), but it breaks the "only complete when every
required doc is in" integrity control the fraud/insurance/title conditions rely
on. So a file can look "clean" for closing with a mandatory report missing.

**🔧 The Fix.** When accepting a document would auto-complete its condition, run
the same **all-required-documents-present** check first — or don't auto-complete
multi-document conditions on accept; leave them at "received" so the final
sign-off still has to pass the gate.

---

### 🟡 S3-08 — The same person can create a condition and then sign it off (no second set of eyes)
**Severity: 🟡 Medium** (confirm the policy you want) · Where: create at `staff.js:1013, 1054, 1225`; complete at `:1258, 1461`

**🐞 The Bug.** Nothing checks that the person **completing** a condition is
different from the person who **created** it. So one staffer can be both the
requester and the approver of the same item.

**🔎 Troubleshooting.** The create routes record who made the condition, but the
sign-off/clear routes never compare that to who's completing it. Combined with
S3-01/S3-03, even a loan officer could create and clear their own item.

**🔧 The Fix.** Decide the policy: if you want "maker ≠ checker," block a person
from signing off a condition they created (or at least flag it in the audit). At
minimum, it should never be reachable by a loan officer (which S3-01/S3-03
currently allow).

---

### 🟡 S3-09 — The archived-files list isn't limited per officer (a latent leak that a single permission grant would open)
**Severity: 🟡 Medium** · Where: `src/routes/staff.js:2250-2260`

**🐞 The Bug.** Every other list in the staff app limits a scoped officer to their
own files. The **archived** list doesn't — it returns **all** archived files
company-wide (borrower names, emails, addresses, loan amounts). Today it's gated
by the "delete/restore files" permission, which by default only admins have (and
they see everything anyway) — so there's no leak right now.

**🔎 Troubleshooting.** The whole point of the permission system is that an admin
can grant a capability to a line role "without a code change." The moment
"delete/restore files" is handed to a loan officer or processor — say, to let
them tidy their own files — that person suddenly gets a **company-wide** archived
list of every officer's borrowers. The list simply forgot to apply the per-officer
limit the rest of the app uses.

**🔧 The Fix.** Apply the same **per-officer limit** to the archived list that the
live pipeline already uses (or add a separate "see all archived" permission), so
archived visibility follows the same boundary as everything else.

---

### 🟡 S3-10 — "Shared view" of another officer's files can be set too broadly, and turns into takeover via S3-02
**Severity: 🟡 Medium** · Where: `src/routes/admin.js:186-192`, consumed across `staff.js`

**🐞 The Bug.** There's a "let Bob see Alice's files" toggle. It's meant as
**read-only sharing**, but (a) it can be set to include **every** officer (no
limit, no check the ids are even loan officers), effectively "see everything" for
reads, and (b) because reassign is ungated (S3-02), read-access becomes the power
to **take those files over.**

**🔎 Troubleshooting.** The toggle only widens a **staffer's** view (it never
affects borrowers — good). But it's controlled by anyone with "manage team,"
which per Section 1's **S1-05** can be self-granted. So the sharing toggle
inherits that weakness, and S3-02 turns a convenience share into a takeover path.

**🔧 The Fix.** (a) Fix S3-02 so shared visibility stays read-only. (b) Limit who
can set the share list and log changes to it. (c) As part of the S1-05 fix,
require a super-admin to grant the powerful capabilities.

---

### ⚪ S3-11 — The message @mention picker reveals a borrower's *other* files to an officer not on them
**Severity: ⚪ Low** · Where: `src/routes/staff.js:2309-2320`

**🐞 The Bug.** When composing a message, the name/file picker returns **all** of
a borrower's files — including ones owned by a different officer — with their
property addresses. A scoped officer on File 1 can see the address of that
borrower's File 2 (another officer's deal).

**🔎 Troubleshooting.** Opening File 2 would still be blocked, so this is a
metadata peek (the address and the fact it exists), not full access — but it's
inconsistent with the otherwise-tight per-file document rule, which deliberately
does *not* fall through to a borrower's other files.

**🔧 The Fix.** Limit the picker's file list the same way documents are limited —
to the current file (or only files this officer is assigned to).

---

### ⚪ S3-12 — The public roster hands staff cell numbers and emails to the open internet
**Severity: ⚪ Low** (confirm intent) · Where: `src/routes/roster.js:23-42`

**🐞 The Bug.** The public "select your loan officer" list is unauthenticated
(anyone on the internet can call it) and returns each listed staffer's **work
email, phone, and cell**. It's not rate-limited (only cached), so it's easy to
scrape.

**🔎 Troubleshooting.** This is partly by design — it only includes staff who are
flagged "show on the site," and it correctly exposes **no** secrets (no password,
no MFA, no internal ids). The question is whether **cell** numbers are meant to be
public; a scraped list of officer emails/cells is a ready-made spam/phishing
target.

**🔧 The Fix.** Confirm whether cell numbers should be public. If not, drop
`cell` from the public roster (keep it on the internal team screen). Consider a
light rate-limit on the public roster like the other public endpoints have.

---

## Watch-items (not bugs today — keep an eye on them)

- **The "who can complete this" buttons in the staff screen use a hardcoded role
  list**, not the real permission. It matches today, but if an admin grants or
  revokes the sign-off permission per person, the buttons will drift from what the
  server actually allows. Cosmetic (the server is the real authority), but worth
  lining up.
- **Creating per-file conditions is open to any assigned staffer** (no permission
  needed). That's fine — creating a condition isn't completing one — but it's the
  other half of the separation-of-duties question in S3-08.
- **Re-registering a product auto-waives the prior product's conditions** with a
  canned reason. That's system housekeeping, not a person waiving — but if you
  want every waive to carry an accountable human name, flag it.

---

## What's already solid (don't re-worry about these)

- **The pipeline, dashboard numbers, search, and chat inbox a scoped officer sees
  are correctly limited to their own files** — counts, dollar totals, and
  "health" metrics do **not** include other officers' deals. This is done well.
- **No staffer can pose as a borrower.** There's no "act as / log in as borrower"
  path anywhere; staff messages are always stamped as staff.
- **Internal team chat is properly walled.** A scoped officer can't read the
  internal notes on a file they're not assigned to (unless they have "see all
  files").
- **The main "Sign off" button is correctly locked** to the sign-off permission,
  and "Mark reviewed" is the loan officer's lighter stamp. **Waive is locked** to
  the waive permission and requires a written reason.
- **The document-completion gate (binder+invoice, fraud background+criminal,
  title) is genuinely enforced on the server**, not just hidden in the UI — the
  hole is only the "accept one document" side door (S3-07).
- **The global Condition Center is fully locked** to the "manage conditions"
  permission — a lower role can't change the firm-wide condition library or rules.
- **Staff edits use strict field lists with before/after audit trails** — no
  sloppy "update whatever the client sent."
- **Team PII is limited to team managers.** A regular officer doesn't get other
  staff's cell/permissions/last-login, and raw passwords/MFA secrets are never
  returned to anyone.
- **SSN and borrower-PII reveals are gated and logged**; document access is tied
  strictly to the one file.

---

## Suggested order to fix (when we get to building)

1. **S3-01** — require the sign-off permission to "Clear" a condition (the
   critical self-approval hole).
2. **S3-02** — gate reassignment to managers (also defuses the takeover half of
   S3-10).
3. **S3-03 + S3-04** — require sign-off permission to verify an LLC and to undo a
   sign-off.
4. **S3-05 + S3-06** — role-gate decision-grade status moves and value-input
   edits.
5. **S3-07 + S3-08** — close the accept-one-document gate; decide the
   maker-≠-checker policy.
6. Then S3-09 → S3-12 (scoping the archived list, tightening shared view, the
   mention picker, and the public roster).

---

_Next section: **Section 4 — Documents & Uploads.** Who can open which document,
how files are stored and streamed, the upload contract, appraisal-card reuse, and
the OCR path._
