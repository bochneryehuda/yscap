# Section 5 — Conditions & Checklist Engine

_Part of the [Portal Look-Back Audit](./00-MASTER-PLAN.md). We only write up
problems here — no code is being changed._

---

## What this section is about

The **conditions engine** is the brain of the loan file: it decides which
to-dos and requirements land on each file, auto-applies them from a rule library,
tracks documents against them, and gates the file from reaching "clear to close /
funded." Staff author the firm-wide list in the **Condition Studio**. Each
condition has a **borrower** version of its wording and an **internal** version,
plus an **audience** (borrower / staff / both).

Two AI agents dug in — one on the **rule engine's correctness** (does it apply,
satisfy, and remove conditions correctly, and can a rule be abused?), one on the
**Studio and the wording/audience model** (can a studio change leak internal text
or a partner name to a borrower?). I verified the biggest findings against the
code myself.

---

## The headline: the engine's *plumbing* is safe — the risks are the *wording* and the *inputs*

**Strong good news first.** The scary "can a rule run wild" questions all came
back clean:

- **A rule can't run code, hack the database, or loop forever.** Rules are a
  simple, checked walk over a list of allowed comparisons — no hidden code
  execution, capped in size and depth. A bad rule just evaluates to "no."
- **A borrower uploading a document never auto-completes a condition** — it goes
  to "received," waiting for staff.
- **Editing a condition in the Studio does not rewrite conditions already on live
  files** — existing files keep the wording they were created with.
- **The funding-readiness check reads both condition lists**, so a blocker in one
  place isn't hidden by the other.

**The real risks are two themes:**

1. **The wording "loaded guns"** (S5-01, S5-02) — the exact ammunition behind the
   Section 2 leak. The Studio lets an author (a) type a **capital-partner name**
   into a borrower field with no warning, and (b) leave the **borrower wording
   blank** on a borrower-visible condition. This section is where those guns are
   *loaded*; Section 2 is where they *fire*.
2. **Borrower-supplied inputs steering the engine** (S5-03, S5-04) — a borrower's
   typed numbers become the engine's "truth" and can even make a scrutiny
   condition disappear, and the two-document safety checks can be fooled by a
   single mislabeled file.

---

## The scoreboard for this section

| 🔴 Critical | 🟠 High | 🟡 Medium | ⚪ Low | Total |
|:-:|:-:|:-:|:-:|:-:|
| 0 | 3 | 5 | 2 | **10** |

Start with **S5-01 / S5-02** (the wording guns — they're the root cause of the
Section 2 leak) and **S5-03** (borrower numbers steering the engine).

---

## The findings

Format, same as always: **🐞 The Bug → 🔎 Troubleshooting → 🔧 The Fix.**

---

### 🟠 S5-01 — The Studio has no guardrail against typing a capital-partner name into borrower wording
**Severity: 🟠 High** · Where: `src/routes/admin-conditions.js:106-108`, custom fields `:188-193`

**🐞 The Bug.** When a staffer writes the "borrower-facing name" or "borrower-facing
instructions" for a condition, the system only trims spaces and cuts the length.
**Nothing** stops them from saving a forbidden note-buyer name (BlueLake, Temple
View, RCN, Churchill, Fidelis) into a field the borrower will read.

**🔎 Troubleshooting.** The only "protection" is faint grey placeholder text that
says "never mention capital partners" — a reminder, not a rule. Whatever the
author types is shown to the borrower word-for-word by the display code. So one
typo or one copy-paste from an internal note by any admin (or anyone granted the
Condition-Studio permission) puts a real partner name in front of borrowers — and
since the same person controls when it applies, it can reach many borrowers at
once.

**🔧 The Fix.** Add a **server-side check** that refuses to save when any
borrower-facing field contains a name on a maintained capital-partner block-list,
with a plain error ("Borrower wording can't mention a capital partner — use 'Gold
Standard program'"). Show the same warning live in the Studio before saving. Apply
it to the per-file "add condition" route too (see S5-06).

---

### 🟠 S5-02 — The Studio never requires borrower wording on a borrower-visible condition (the "loaded gun")
**Severity: 🟠 High** · Where: `src/routes/admin-conditions.js:44-113`; seeded blanks in `db/005_rtl_workflow.sql:59-60`

**🐞 The Bug.** A condition can be marked **borrower-visible** while its
**borrower-facing name is left blank** — the system saves it happily. A blank
borrower name is exactly the empty slot the Section 2 alert/email code fills with
the **internal** wording (which is where partner names and underwriting notes
live).

**🔎 Troubleshooting.** On the borrower's *screen* this is safe (it shows a
generic "an item your loan team needs"). The danger is the alert path (S2-01). And
this ships in the seed data: two starter conditions (the purchase contract and the
photo ID) are borrower-visible with **no** borrower wording, and a later migration
even admits it had to patch another one for exactly this reason. The team has been
fixing these one at a time because **nothing enforces it at the source.**

**🔧 The Fix.** Make the Studio **and** the server **require** a borrower-facing
name (and instruction) whenever a condition is visible to the borrower — block the
save if either is empty. Backfill the two seeded blanks with plain borrower
wording. This single change shrinks the blast area for the Section 2 leak more
than anything else.

---

### 🟠 S5-03 — A borrower's typed numbers become the engine's "truth" and can make a scrutiny condition disappear
**Severity: 🟠 High** · Where: `src/lib/conditions/engine.js:291-332`, `:220-227`; `src/routes/borrower.js:583, 596`

**🐞 The Bug.** When a borrower answers an "information" condition, their typed
number is written **straight into the live loan record** — loan amount, ARV,
purchase price, rehab budget, claimed experience — with no staff review. The
engine then immediately re-runs and treats those self-reported numbers as **fact.**

**🔎 Troubleshooting.** The engine calculates the loan's leverage (loan-to-value,
loan-to-cost) from these fields. So a borrower who **inflates the ARV** lowers the
leverage the rules see — and if a rule was set to add an "extra review when
leverage is high" condition, the re-run can **auto-delete that condition** because
the rule no longer matches. There's no "hold this as *claimed* until staff accept
it" step for these dollar fields. (This is the engine-side cousin of Section 2's
S2-05, which found the same fields editable without an audit trail.)

**🔧 The Fix.** Don't let a borrower's answer overwrite money/leverage fields in
place. Stage borrower answers as **"claimed, pending staff acceptance"** and have
the rules key off the *accepted* value. And never auto-remove a condition just
because a borrower-editable number changed — require staff to clear it.

---

### 🟡 S5-04 — The "two documents required" safety check can be fooled by one mislabeled file
**Severity: 🟡 Medium** · Where: `src/routes/staff.js:1326-1350`

**🐞 The Bug.** Some conditions can't be signed off until **two** proofs are in —
insurance needs a **binder AND an invoice**; the fraud check needs a **background
report** (plus a **criminal report** on Gold Standard files). The system decides
which document is which by checking whether the file's label *contains the word*
"binder," "invoice," "background," etc. A single file labeled "binder invoice"
satisfies **both** at once.

**🔎 Troubleshooting.** The check just looks for those words anywhere in any
uploaded document's label — it never confirms **two separate files** exist. And
the label is free text typed by whoever uploads. So the "two proofs before we sign
off" safeguard on insurance and fraud can be defeated with one cleverly named
file, letting a sign-off attest to documents that aren't actually there. (Related
to S3-07 and S2-09, but a different trick — name spoofing.)

**🔧 The Fix.** Match uploaded documents to the condition's **defined document
slots**, not to words in a free-text label, and require a **separate current file
in each** required slot. Also reject borrower uploads into staff-only conditions.

---

### 🟡 S5-05 — One Studio edit can silently change conditions across the entire open pipeline
**Severity: 🟡 Medium** · Where: `src/routes/admin-conditions.js:287-289, 338-340`; `src/lib/conditions/engine.js:257-272`

**🐞 The Bug.** When an author saves a condition set to "every file" or
"rule-based" (with the default "apply now" box checked), the server **immediately
re-runs the rules over every open loan**, adds/removes conditions on all of them,
and sends each affected borrower a "new item added" alert — all inside that one
save click.

**🔎 Troubleshooting.** A change meant as a small wording tweak can instantly touch
hundreds of live files and ping their borrowers, with no "this will affect N
files — continue?" confirmation. Combined with S5-01/S5-02, one careless save
(audience flipped to borrower-visible with a partner name in the borrower field)
could push that name to every matching borrower in a single click. It's also a
speed/timeout risk (hundreds of files in one web request).

**🔧 The Fix.** Before a mass apply, **show the count** of files and borrowers that
will be affected and require an explicit confirm (the preview count already
exists). Run the actual sweep as a **background job**, and don't fire borrower
alerts for bulk engine re-runs unless the author asked for it.

---

### 🟡 S5-06 — The per-file "add a condition" button has the same no-screening gap, and isn't limited to Studio staff
**Severity: 🟡 Medium** · Where: `src/routes/staff.js:1054-1108, 1225-1252`

**🐞 The Bug.** Separate from the global Studio, any staffer on a file can add a
borrower-visible condition to it and type free-text borrower wording. That path
does **no partner-name screening** either — and unlike the Studio, it's **not**
limited to the Condition-Studio permission, so a loan officer or processor can use
it.

**🔎 Troubleshooting.** This route correctly avoids leaking the *internal* label
into the borrower alert, so the display side is safe — but the free-text borrower
fields are unscreened, and it's open to a larger group of staff than the Studio.
So the partner-name guardrail from S5-01 must cover **this** door too, or the fix
only locks the admin door.

**🔧 The Fix.** Apply the same partner-name block-list here, and decide whether
authoring a per-file borrower condition should require a permission rather than
just file access.

---

### 🟡 S5-07 — A file can reach "clear to fund" without anyone verifying the borrower's experience
**Severity: 🟡 Medium** (confirm your programs' rules) · Where: `src/lib/experience.js:53-114`, `src/routes/staff.js:1918`

**🐞 The Bug.** The track-record / experience requirement is stored as a "task,"
and the funding-readiness gate **never blocks on tasks.** On top of that, when the
file's *claimed* experience is zero, the engine quietly marks the requirement
**satisfied** and it drops off the list.

**🔎 Troubleshooting.** So experience can pass in two ways that skip a real check:
it's treated as workflow (not a funding blocker), and it auto-satisfies when
nothing is claimed. The intermediate check even counts **unverified** track
records before flipping the item along. A file could reach "clear to fund" with no
one having verified the borrower's experience.

**🔧 The Fix.** Confirm whether experience must gate funding for your programs. If
so, make the experience requirement a **real blocker** and stop auto-satisfying it
from claimed numbers — require a staff sign-off backed by **verified** track
records.

---

### 🟡 S5-08 — Verifying an LLC once auto-signs-off the entity condition on every file — including new ones nobody looked at
**Severity: 🟡 Medium** · Where: `src/lib/llc.js:158-198`; triggered from `borrower.js:2056-2058`, `staff.js:1836-1838`

**🐞 The Bug.** When an LLC is marked verified, the system stamps the entity
condition as **signed off** — with a staff member's name and the current time — on
**every** open file that uses that entity. When a brand-new file later links that
already-verified LLC, its entity condition is **auto-signed-off immediately**,
credited to whoever verified the LLC originally, who may never have seen this new
file.

**🔎 Troubleshooting.** The entity's documents do exist (from the original
verification), so this isn't a fake clearance — but your **audit trail** shows a
staffer "signed off" a file they never touched, and a new loan inherits the
clearance with no fresh look (a Certificate of Good Standing could be stale, which
today is only a soft note). This is the cross-file cousin of S3-03. 

**🔧 The Fix.** Confirm your entity-reuse policy. If auto-clearing on reuse is
intended, **credit it to "system (entity previously verified)"** instead of a named
staffer, and make the good-standing freshness a real per-file check rather than an
advisory.

---

### ⚪ S5-09 — Removed conditions can leave borrowers with phantom alerts, and deleting a condition can orphan uploaded files
**Severity: ⚪ Low** · Where: `src/lib/conditions/engine.js:225, 241-252`; `src/routes/admin-conditions.js:362-370`

**🐞 The Bug.** The engine can tell a borrower "a new item was added," then later
**silently delete** that item if it's still untouched — leaving the borrower with
an alert for something that's gone. Separately, the admin "delete and remove from
files" action (and the dedup cleanups) can delete a condition whose **uploaded
documents then become detached** from any condition (the files survive but aren't
linked to anything).

**🔎 Troubleshooting.** The engine's own auto-removal is careful (it won't delete
anything with a document or human work attached), so the orphaning is mainly the
manual delete / dedup path. The phantom-alert issue erodes borrower trust and can
hide a real ask that vanished.

**🔧 The Fix.** Don't hard-delete a borrower-facing item the borrower was already
told about — mark it **withdrawn** instead. Before deleting a condition, **re-home
or flag** any documents attached to it so nothing uploaded is silently lost.

---

### ⚪ S5-10 — The starter data still literally contains "BlueLake" (scrubbed at every startup)
**Severity: ⚪ Low** · Where: `db/005_rtl_workflow.sql:89` (scrubbed by `db/012_profile_and_checklist_copy.sql:38-45`)

**🐞 The Bug.** The original starter data for one condition still contains the
literal note-buyer name "BlueLake" in an internal hint. A later startup step
overwrites it with clean "Gold Standard program" wording every time the server
boots, so the **running database is clean** — but the name still sits in the
source.

**🔎 Troubleshooting.** This is safe in normal operation (the scrub always runs
after), but it's load-bearing: if the startup steps were ever applied partially,
that name would be live on a borrower-visible condition's internal hint (and the
S2 fallback would surface it). Same item Section 2 flagged as a watch.

**🔧 The Fix.** Edit the starter data to write the clean "Gold Standard" wording
directly, so no startup ordering is ever load-bearing for keeping a partner name
hidden.

---

## What's already solid (don't re-worry about these)

- **Rules can't run code, hack the database, or loop forever.** They're a checked
  walk over a fixed list of allowed comparisons, size- and depth-capped; a broken
  rule just means "no."
- **The Studio is fully locked** to the "manage conditions" permission — every
  author/edit/delete/rule/custom-field route is covered.
- **The borrower's screens never fall back to internal wording** — they show a
  generic placeholder and only ever send the borrower fields. (The gap is only the
  *alert/email* path from Section 2.)
- **Editing a condition doesn't rewrite conditions already on live files** —
  existing files keep their original wording; only new placements pick up changes.
- **A borrower's upload never auto-completes a condition**, and a borrower can't
  self-accept a document.
- **The manual document-gate is real** (it blocks signing off a document condition
  with no documents) — the only weaknesses are the label-spoofing trick (S5-04)
  and the "accept one document" path (S3-07).
- **The funding-readiness check reads both condition lists**, so a real blocker in
  either place still counts (except task-type items — S5-07).
- **The engine's automatic removal is conservative** — it never deletes anything a
  human touched or that has a document attached.
- **The engine's "verified experience" really is verified** — it counts only
  staff-verified track records.

---

## Suggested order to fix (when we get to building)

1. **S5-01 + S5-02 + S5-06** — the wording guardrails: block partner names in
   borrower fields, require borrower wording on borrower-visible conditions, on
   both the Studio and per-file routes. (These are the root cause of the Section 2
   leak — fix here and there together.)
2. **S5-03** — stop borrower-typed numbers from silently becoming underwriting
   truth and auto-removing conditions.
3. **S5-04** — make the two-document gate check real, distinct files.
4. **S5-05** — add a confirm + background job to the "apply to every file" sweep.
5. **S5-07 + S5-08** — decide whether experience gates funding; fix the LLC
   cross-file auto-sign-off attribution.
6. Then the Lows (S5-09, S5-10).

---

_Next section: **Section 6 — Messaging & Chat.** Borrower↔staff chat, internal
staff chat, mentions, the PII guard, attachments, read receipts/presence, and the
live stream._
