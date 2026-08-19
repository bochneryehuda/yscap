# The RTL Workflow & Gates — Full Research and Fix Plan

_Owner-directed 2026-08-19: "Research on the entire RTL workload… I feel that it's built
very low-level, which means for some things you need to go around the bush again and
again. Certain gates are making everybody so nervous, but the gates are important. In
professional LoS systems they also have these gates, but somehow they have the gates in
a much smarter way. The entire workflow is not a straightforward workflow where
everybody can know what they're doing next… everything is in a different place… it's
very hard to know the next step in the process… it's not to the level of a Microsoft
LoS, a Google LoS, an Apple LoS, Encompass LoS, or military-grade systems. Do a whole
research on our system RTL side. Research on industry standards. Do a full plan layout."_

**This document changes no code.** It is the research and the plan. RTL only — the
Long-Term product is untouched by everything here.

How it was built: six full research passes over this codebase (the status model, the
conditions system, every gate, every "what's next" screen, and every internal design
document we have already written), plus an outside benchmark of how Encompass, the
modern lending platforms, and NASA/military-style review processes actually run their
gates. Every number below was counted in the code, with the file recorded. Where a
number is an estimate, it says so.

---

## 1. The short version

**Your feeling is correct, and it is now measured.** Three sentences cover it:

1. **The system is not missing power.** PILOT has MORE workflow machinery than most
   commercial loan systems: ~80 live RTL condition templates, a rules engine an admin
   can drive without a developer, real DocuSign-verified gates, an exception register,
   per-file readiness computation, hand-off SLAs. The engine room is genuinely
   high-end.

2. **What it is missing is a spine and a door.** The loan's journey — the 5-phase
   process this whole system was seeded from — is stored in the database and **shown on
   no screen**. So the process is invisible: people meet it only as refusals. We
   counted **24 separate gate mechanisms** and **9 unrelated ways to get past them**
   ("unlock", "clear the package", "override", "exception", "escalation", "waive",
   "force"…), each with its own screen and its own rules. And a staffer's work is
   spread over **roughly 12–20 places** (queues, tabs, badges, and emails).

3. **The professional systems are not smarter because they have fewer requirements —
   they have more.** Encompass runs ~13 milestones, each owned by exactly one role,
   with the gate's checklist **visible from day one** on a stage worksheet, "ready" as
   a simple count (zero open prior-to-docs conditions), one named person who passes
   each gate, and one standard way to grant an exception. The gate is a confirmation,
   never a surprise. That — not fewer rules — is the whole difference.

**The plan, in one breath:** give every loan a visible milestone bar with "you are
here, [name] owns it, here is exactly what the next gate needs" (built from readiness
checks we already compute); make every gate show its checklist *before* anyone presses
the button; fold the nine override paths into the one exception register we already
built; give every person one "My Day" list; speak one status language everywhere; and
then retire the double-work (the manual tick-boxes that duplicate signals the system
now verifies for real). Most of it is **switching on machinery we already paid for** —
the same pattern as the file-screen cleanup that worked in July.

---

## 2. Part 1 — What we have today (the as-is map)

### 2.1 The size of it

| Measure | Count | Where counted |
|---|---|---|
| Database migrations | 589 | `db/*.sql` |
| Database tables/models | 342 | `docs/schema/schema.prisma` |
| Back-end code | ~310,000 lines | `src/**/*.js` |
| Portal code | ~100,000 lines | `app-v2/src` |
| The one staff route file | 19,886 lines, 370 endpoints | `src/routes/staff.js` |
| The one loan-file screen | 7,030 lines, ~50 components | `app-v2/src/screens/StaffApplication.jsx` |
| Portal screens (63 staff + 30 borrower/public) | 93 | `app-v2/src/screens` |
| Routes in the portal | ~110 | `app-v2/src/App.jsx` |
| Test scripts | 1,125 | `scripts/test-*` |
| Live RTL condition templates | ~80 (seeded across 27 migrations) | `db/005` + 26 later files |
| Condition-adjacent tables | 32 | `grep CREATE TABLE db/*.sql` |
| Distinct gate mechanisms | 24 | §2.4 / Appendix A |
| Distinct override mechanisms | 9 classes | §2.5 |
| Status vocabularies for "where is this loan" | ≥12 | Appendix B |
| Places a staffer's work can live | ~12–20 | §2.6 |
| "dead end" mentions in code comments | 73 | `grep -rE "dead[- ]end" src/ app-v2/src/` |
| `[auto]` note markers used as workflow state | ~338 | `grep -rn "\[auto\]" src/ db/` |

"Mega, massive" is right. This is a serious system. The question is only how it is
arranged.

### 2.2 Where the process lives (in pieces)

The RTL process actually exists in the system — **five times, in five different
shapes, none of them shown as a journey:**

1. **The original 5-phase workflow** (`db/005_rtl_workflow.sql`) — seeded from the
   written "RTL / Fix & Flip Loan Processing Guide": Phase 1 Borrower Intake, Phase 2
   File Setup, Phase 3 Verifications & Orders, Phase 4 Appraisal Back / Check the
   Numbers, Phase 5 Attorney & Final Review. Every condition template carries a
   `phase`, a suggested role, a sort order, and `is_gate` / `is_milestone` flags. **No
   screen shows the phases.** The portal even has a phase-label dictionary — and it is
   dead code: it is keyed `p1_intake…p5_closing` while the database stores `'1'…'5'`,
   so the label lookup has never matched once
   (`app-v2/src/screens/StaffApplication.jsx:1001-1006`).

2. **The 11 borrower-facing statuses** (`file_intake → new → in_review → processing →
   underwriting → approved → clear_to_close → funded`, plus on_hold / declined /
   withdrawn) — defined in `src/routes/staff.js:12540` and mirrored in
   `src/clickup/status.js`.

3. **The 39 internal ClickUp statuses** — the ladder the team actually runs on,
   mirrored verbatim into `applications.internal_status` and bucketed into the 11
   external ones (`src/clickup/status.js:28-71`). (Every doc says "38"; the live map
   has 39 — the docs are a hand-kept copy that drifted.)

4. **The hand-off chain** (`src/lib/workflow.js:29-85`) — 11 submission types, each
   with an owning role, an SLA, and the internal status it drives: `loan_setup →
   processing → condition_clearing → clear_to_close → closing → draw_setup →
   post_closing` (+ TrustPoint/Trinity/exception/escalation). This IS a milestone
   model — nobody can see it as one.

5. **Two later sub-lifecycles** that were designed properly: the closing stage machine
   (`closing_workflow`: estimated → ready_for_docs → wire_sent → fully_closed →
   fully_reconciled) and the draw ladder (`src/sitewire/approval.js` — with
   borrower-facing AND internal labels per stage).

So the spine exists. It has just never been assembled into one picture — which is
exactly what our own draw research concluded in August: _"All the states already
exist — scattered across six tables plus one computed module."_ The owner's own words
then: **"You already have all the logic and all the statuses; now structure it into a
workflow."** That instruction, applied to the whole loan, is this plan.

### 2.3 The conditions machine (the strong core)

- **One library, ~80 live RTL templates**, each with internal + borrower wording,
  audience (staff / borrower / both), a kind (document / task / condition / tool /
  info-field / e-sign), and optionally a **rule** ("attach this condition when the
  note buyer is CorrFirst") that an admin edits in the Condition Studio with a live
  "matches N of M open files" preview — no developer needed. (`docs/condition-center.md`)
- **An engine** that attaches and retracts rule-driven conditions on ~30 triggers
  (every save, status change, registration, ClickUp pull…), with snapshot semantics
  (editing a template never rewrites conditions already on files) and a per-file lock
  against duplicates. (`src/lib/conditions/engine.js`)
- **A sign-off gate** that refuses to clear a condition until its real evidence exists
  — 20 hand-built branches: the executed DocuSign package for the signed-term-sheet
  condition, an imported credit report (not just a PDF), both insurance slots, the
  cent-exact budget match, verified experience versus the registered product, and so
  on. Refusals are written in plain English with the next action. (`src/routes/staff.js:8603-9202`)
- **Real, un-tickable gates** where it matters most: clear-to-close requires the
  actually-executed term-sheet package read from DocuSign itself
  (`src/lib/esign/ctc-gate.js`), and the status door computes readiness live
  (`advancementBlockers`, `staff.js:12755`).

This is the part that is genuinely at or above the commercial systems. Encompass's
condition sets and business rules do the same job with less flexibility.

### 2.4 The gates (24 mechanisms)

The full inventory with file references is **Appendix A**. The shape of it:

- **2 freezes** — the status freeze (clear-to-close/funded/declined/withdrawn locks
  the loan's structure) and the term-sheet-sent freeze (a sent DocuSign package
  freezes the figures for everyone, including super-admins).
- **8 send/issue gates** — the e-sign send gate (7 different blocker codes), the
  term-sheet FINAL stamp, term-sheet freshness, missing documents, the send
  capability, the Encompass agreement gate, the Encompass tape gate, the buyer/program
  tape gate.
- **5 status gates** — readiness for clear-to-close and funded (two doors), the
  ClickUp-inbound clear-to-close confirmation, the issuance backstop, and the
  executed-package gate.
- **~30 per-condition refusal branches** inside the sign-off gate, plus two universal
  pre-checks (no pending documents; every ad-hoc slot filled).
- **Database-level guards** (the cent-exact budget trigger) and **reopen triggers**
  (any economics change reopens Products & Pricing; a new fatal appraisal finding
  un-signs the appraisal review) — gates that act after the fact by un-clearing work.
- **Registration/approval holds** — manual programs and any admin-zone pricing change
  go to an approval box; the borrower's terms email is withheld meanwhile.
- Plus the sync-safety guards (PII shield, DOB gate, circuit breakers) and two
  build-time CI gates — right and untouchable, but part of the felt weight.

**Each of these is individually defensible. Almost every one was built as a reaction
to a real incident.** That is precisely the "built low-level" feeling: 24 gates grown
one at a time, each with its own wording, its own screen, and its own way out.

### 2.5 The ways past a gate (9 unrelated systems)

1. Super-admin **structural unlock** (typed reason, audited).
2. **Clear/void the DocuSign package** (the only self-service way past the term-sheet freeze).
3. **Data carve-outs** anyone can use (a budget-neutral Scope-of-Work edit, a
   payoff-contact-only edit, a flip↔hold experience reallocation) — each hand-built
   after somebody got stuck.
4. Super-admin **request-flag overrides** with a double warning (as-is/ARV, details,
   terms-neutral re-register).
5. The **exception register** (`loan_exceptions`, 12 types, EX-numbers, request →
   approve, expiry, SLA) — the good one, built July 24.
6. The **escalation box** (`manual_program_escalations` — approve / counter) — a second
   approval queue that predates the register and was never folded in.
7. Admin **"force"** on the two status doors and the ClickUp CTC confirmation.
8. Per-field **Encompass exceptions** (auto-void when the data moves).
9. Super-admin **condition override** (db/344 — gate still runs, what-was-missing is
   stamped on the file).

Nine vocabularies for one idea: _someone with authority said yes, on the record._
Which one applies where is tribal knowledge. That — not the gates themselves — is
what makes people nervous: **you cannot predict which wall you will hit, and when you
hit one, the way past it is a different system each time.**

### 2.6 Where the work lives

A staff member's outstanding work is spread across (counted in
`app-v2/src/components/StaffLayout.jsx` and the screens it links):

- **11 independent badge counters** in the sidebar (6 were already merged into one
  Approvals badge — good — 6 remain separate);
- the pipeline's **7 exception tiles**; **My tasks** (two lists on one screen:
  scheduled tasks + condition items); **Workflow** (hand-offs); **Approvals** (6
  tabs); plus Orders, E-signatures, Closing, Purchasing, Draws, Data tapes, Email
  Center, Notifications (a parked-drafts queue), Chat, the AI Command Center — about
  **20 work-holding screens** in all, with several queues reachable through two
  different doors (findings ×2, track record ×2, draws ×2);
- **~36 scheduled email digests/reminders** (`src/lib/notification-digests.js`, 2,916 lines) —
  and several classes of work reach a person **only** by email (order overdue,
  workflow aging, purchase-advice chase), with no screen that lists them.

Inside one loan file: **21 sections in 8 rooms**, and **nine different "what next"
indicators** — of which only one (`WhatsLeftPanel`) is an actual work list, and only
one (`SubmitFilePanel`) ever recommends a forward step, and it covers just 2 of the
11 hand-off types. Meanwhile **the borrower's portal already does this right**: one
"Action needed" list across their files, one timeline, one default filter meaning
"still needs you". The borrower has a clearer picture of the process than the team.

### 2.7 What has already been fixed (and what the plan builds on)

Credit where due — July and August already delivered, and this plan deliberately
stands on them rather than re-proposing them:

- The **Eight Rooms** file layout + permanent section addresses (`stations.js`).
- **WhatsLeftPanel** — one merged "what's holding this file" list with ageing chips
  and a Go-fix button, fed by the live readiness endpoint (`GET /applications/:id/gating`).
- **conditions-vocab.js** — one dictionary for condition words (built because one
  stored value had four names).
- The **exception register** with EX-numbers, expiry, SLAs, and an export.
- The **closing money gate** and the 3-system funded-date reconciliation — the
  cleanest gate pattern in the repo: one predicate + a plain-language reason + a
  recorded override.
- The **draw checklist** (`src/sitewire/draw-checklist.js`) — _"the same set of
  facts, stated FORWARD: every step, whether it is done, who we are waiting on, and
  the ONE action that clears it… IT DECIDES NOTHING. This is a description of the
  file, not a gate."_

The last two are the house style the rest of the gates should be brought up to.

---

## 3. Part 2 — What you are feeling, named precisely

Eight findings. Each one is a real, evidenced property of the system — not an
impression.

### F1. The process is invisible — people meet it as refusals

The five phases and the hand-off chain exist in data (§2.2) and are rendered nowhere.
There is no screen that says: _"This file is in **Verifications & Orders**. Sarah owns
it. 9 of 15 items are done. To leave this stage: appraisal back + credit imported +
title ordered. The next gate after that is the term sheet, and it will need X, Y, Z."_
The only forward-looking surfaces are the status stepper (stage names, no actions) and
WhatsLeftPanel (actions, but only for the last two gates — clear-to-close and
funding). Everything between intake and clear-to-close runs on memory.

*Industry contrast:* Encompass shows the milestone worksheet — the current stage's
full requirement list — from day one. NASA publishes a review's **entrance criteria**
before the review is convened; nobody discovers requirements at the gate.

### F2. Gates fire as surprises, at the moment of action

Nearly every gate here is checked when a button is pressed: Send, Sign off, Register,
Advance, Export. Until that click, nothing tells you the wall is coming. The e-sign
send gate can refuse for seven different reasons; the sign-off gate has ~28 refusal
messages; the tape export has its own; the Encompass gate its own. The refusal texts
themselves are actually good — plain English, naming the missing thing — but they
arrive **after** the person believed they were done. Repeated a few times a week,
that is exactly "nervous".

The system has already diagnosed this about itself, on the draws side
(`src/sitewire/draw-checklist.js`, 2026-08-09): _"Everything a draw is waiting on
already exists somewhere… But none of it was ever assembled, so the blockers only
appeared as a REFUSAL when somebody pressed Deliver — **you had to try the action to
find out what was missing.**"_ That sentence describes the whole loan workflow, not
just draws.

### F3. Twenty-four ways to hear "no", nine unrelated ways to get to "yes"

§2.4/§2.5. The cost is not any single gate — it is that the *shape* of the system is
unpredictable. A processor cannot generalize from one gate to the next: the flood
condition's way out (super-admin condition override) is different from the term
sheet's (clear the package, or finalize, or a super-admin reason on the send), which
is different from a manual program's (escalation box), which is different from an
Encompass mismatch (per-field exception), which is different from a frozen file
(structural unlock). Five of the eight remedies live on a **different screen** than
the refusal (Appendix A lists eight concrete cases — e.g. the e-sign panel refuses
because of Encompass, but the fix is per-field in the Encompass tab, and for some
fields only fixable inside Encompass itself).

### F4. The freeze design punishes normal work — and we know it, one patch at a time

The term-sheet-sent freeze is the clearest case. The freeze itself is right (a sent
term sheet must never silently disagree with the file). But it shipped as a blanket
"no", and then reality arrived: a budget-neutral Scope-of-Work edit, a payoff contact,
a neutral re-register, an as-is correction, a flip↔hold reallocation, a details fix on
a cleared file… Each time somebody dead-ended, a carve-out was hand-built — **seven
so far** (`src/lib/file-lock.js`). The codebase names this pattern itself: _"the
dead-end class this codebase keeps having to fix"_ — **73** "dead end" mentions in
comments, including the canonical one: _"a remedy that cannot produce the state the
refusal demands is a dead end"_ (`src/lib/esign/term-sheet-stamp.js`). This is the
"go around the bush again and again," named by the system's own authors.

*Industry contrast:* Cooper's stage-gate model has a **fixed decision vocabulary**
that includes **Conditional GO** — "proceed, with these named remedial items and
deadlines" — so real life doesn't need ad-hoc back doors. Our exception register
already implements exactly that idea; it just doesn't govern most of the gates.

### F5. No stage has one owner, and some hand-offs go nowhere

Encompass's rule is: one milestone = one owning role = one gatekeeper, and finishing a
stage **is** the hand-off (the next person can accept or return it). Ours is close —
`workflow.js` routes 11 hand-off types by role with SLAs — but: there is **no
hand-off type for the underwriter at all** (an "Underwriting workflow" view exists
that nothing feeds); `post_closing` requires the sender to hand-pick a person;
`draw_setup` silently raises **nobody** when there are zero or two-plus active draw
coordinators; and only 2 of the 11 steps are ever *recommended* by the screen. The
two ends of the chain (underwriting in, post-purchase out) are "somebody watches a
queue".

And three of the clear-to-close gates are still **manual tick-boxes** (`rtl_p4_ts`
"term sheet generated", `rtl_f_review` "investor final review", `rtl_f_ctc` "investor
CTC") sitting **beside** the real, system-verified signals for the same facts — so
people do the work twice: get the real signal, then also tick the box that says so.
The code already promises their retirement _"when those land"_
(`app-v2/src/lib/condition-workflow-steps.js:21-30`).

### F6. Twelve languages for "where is this loan"

At least 12 status vocabularies touch one file (Appendix B): 11 external statuses, 39
internal ClickUp statuses, the ClickUp "Borrower Portal Status" dropdown, a 6-step
borrower journey, an 8-step timeline, 5 pipeline groups, 11 workflow submission
types, 6 closing stages, 5 checklist statuses, 4 underwriting-condition statuses, 7+7
e-sign states, draw stages… With four hand-kept label maps of the same 11 values, a
`new` status that nothing in ClickUp can produce and nothing lands on, and `funded`
hiding an 8-status post-closing life inside it. The earlier UI audit counted **171
distinct status words** across the portal. When the same fact has twelve names,
"where is this file and what's next" is a translation exercise.

### F7. Work lives in ~12–20 places, and some work only arrives by email

§2.6. There is no single "My Day" — `/internal/tasks` and `/internal/workflow` are
two halves of that answer that never meet, several queues have two doors, and a few
classes of work have **no screen at all** (digest-only). The checklist the owner
wants to "make there" effectively exists — as ~80 conditions, 11 hand-offs, 20
queues, and 40 digests. What is missing is the one place they roll up per person and
per file.

### F8. "Done" has five spellings, and some workflow state lives in prose

A condition can read as done via `status='satisfied'`, `signed_off_at`,
`reviewed_at`, `waived_at`, or an override stamp — and each screen re-derives "done"
its own way (`roleDone`, `conditionDisplayState`). Deeper: real workflow state is
stored in **text** — ~338 `[auto]`-prefixed notes act as machine state (an `[auto]`
note the system itself wrote permanently pins a condition against automatic
retraction); an approved early-send waiver stays valid only while the blocker's
refusal *sentence* stays byte-identical (`esign/gate.js:130` warns that rewording it
"would silently un-waive every approved exception"). State in prose is why cleanups
keep needing cleanups (db/374 had to go back and edit db/335's marker notes).

---

## 4. Part 3 — How the professional systems do it

The full benchmark (Encompass/ICE, nCino, Floify, SimpleNexus, Mortgage Automator,
LendingWise, Liquid Logics, plus Cooper's Stage-Gate model, NASA's review-gate
criteria, and Gawande's checklist research) reduced to what matters for us.

### 4.1 Encompass's actual design (the one the team compares us to)

- **~13 milestones, one owner each.** Started → Qualification (LO) → Processing →
  Submittal (Processor) → Conditional Approval (UW) → Resubmittal → Approval (UW) →
  Doc Prep → Docs Signing (Closer) → Funding (Funder) → Post Closing → Shipping →
  Completion. Milestone **templates** per channel/loan type are auto-matched to the
  loan. Everything granular lives one level down, inside a milestone.
- **The gate is a visible checklist, checked by the machine.** Per milestone, admin
  rules define the documents that must be received and the fields that must be filled;
  the "Finished" box literally cannot be ticked until they are. The **Milestone
  Worksheet** shows that list the whole time you are in the stage — the gate is a
  confirmation, never a discovery.
- **Conditions are bucketed by the deadline they block** — Prior to Approval / Prior
  to Docs / Prior to Funding / Prior to Purchase / trailing. "Can we draw docs?" =
  "are open Prior-to-Docs conditions zero?" — a count, not a meeting. The pipeline
  shows those counts as sortable columns. Each condition has its own small lifecycle
  (Added → Requested → Received → Reviewed → **Cleared/Waived**) with dates and
  owners; **Waive is a first-class, logged, permissioned status** — the override
  lives *inside* the model.
- **Finishing a milestone IS the hand-off**: the file lands in the next role's
  pipeline; they accept it or **return it to sender**; the sender drops to view-only.
  Expected dates cascade from per-stage "days to finish"; the login screen is your
  at-risk (yellow) and late (red) items — exception-first.
- ICE's newest version keeps the milestone spine but lets tasks run **in parallel
  across milestones** — gates only at genuine sequence points (docs out, wire).

### 4.2 The gate science (what "military-grade" actually means)

- **Cooper's Stage-Gate:** every gate = deliverables defined *in advance* + criteria
  (must-meet vs should-meet) + a **fixed decision vocabulary**: Go / Hold / Return /
  Kill / **Conditional Go** (proceed with named remedial items and deadlines, which
  become tracked items — not verbal promises). Gates have named gatekeepers with real
  authority.
- **NASA/military reviews:** published **entrance criteria** (the review is not even
  convened until they're met) and **exit criteria**; anything raised at the gate
  becomes a tracked action item closed before the next gate. Predictable, decidable,
  owned, closed-loop.
- **Checklist research (aviation/Gawande):** a usable checklist is 5–9 killer items
  at a natural pause point, run in 60–90 seconds, in DO-CONFIRM mode (people work
  from expertise, then pause and confirm). A flat list of 100 items is an
  anti-checklist. The fix is partitioning by pause point — which is exactly what the
  Prior-to-X buckets are.
- **State-machine hygiene:** one small status enum per concern (loan stage, condition,
  document, draw); transitions whitelisted in one place; every transition an audited
  event; **readiness always derived, never stored twice** — the same computation
  powers the gate and the "what's missing" display, so they can never disagree.

### 4.3 The scorecard

| Principle (industry) | PILOT today |
|---|---|
| ~10 loan-level stages, one per hand-off | ✅ exists (11 statuses + hand-off chain) — ❌ never shown as a journey |
| One stage = one owning role = one gatekeeper | ⚠️ half — hand-offs exist; underwriter/post-purchase ends are queue-watching |
| Gate criteria visible from day one | ❌ only for the last two gates (WhatsLeftPanel); everything else refuses at click time |
| Gates = machine-checkable evidence | ✅ mostly real evidence — ⚠️ plus 3 manual tick-gates duplicating real signals |
| Conditions tagged by the gate they block; ready = a count | ⚠️ the timing field exists (`category`) but is empty on most templates and unused by the UI |
| Per-condition lifecycle w/ owners; Waive first-class | ✅ close (5 statuses + stamps) — ⚠️ five spellings of "done" |
| Checklists auto-generated from loan data | ✅ the Condition Studio — genuinely ahead of most vendors |
| Fixed decision vocabulary incl. Conditional-Go | ⚠️ the exception register IS this — but only some gates route through it (9 override systems) |
| Gate passage = hand-off with acceptance | ⚠️ submit exists; accept/return-to-sender does not |
| 5–9 item human gate reviews | ❌ flat lists; the human confirms everything |
| One small status enum per concern | ❌ ≥12 vocabularies, 4 duplicate label maps |
| Readiness derived, never stored twice | ✅ for CTC/funded (`gating`) — ❌ three predicates re-implement the same condition test |
| Per-stage SLA + exception-first pipeline | ⚠️ SLAs on hand-offs and ageing chips exist; the pipeline is not exception-first |
| Parallel tasks, gates only at sequence points | ✅ broadly true already |

Read the ✅ column: **the raw material is nearly all present.** This is an assembly
problem, not a rebuild.

---

## 5. Part 4 — The plan

Six moves, in three stages. Ordered so that each stage pays for itself and nothing
depends on a rewrite. The same discipline as the July file-screen work: **reveal and
reuse before build; hide, never delete; every gate keeps working exactly as it does
today until its replacement is proven.** No frozen pricing engine is touched by any
of this. Nothing here weakens a gate — the point is to make the same gates
predictable.

### Stage 1 — Make the process visible (reveal what exists)

**Move 1 — The Milestone Bar: one spine on every file and on the pipeline.**

Define the RTL milestone list ONCE, in one server module (the way
`src/sitewire/approval.js` does it for draws): roughly **9 milestones** derived from
what already exists — Intake → Setup & Orders → Appraisal Back → Terms Out → Signed
Terms → Conditions Cleared → Clear to Close → Closing & Funding → Post-Closing —
each mapped from the CURRENT statuses/hand-offs (no new hand-maintained state; the 39
ClickUp statuses keep driving, exactly as the sync blueprint requires). For each
milestone the module states, in data: the owning role, the entry criteria, the exit
criteria (computed from the readiness checks we already run — `advancementBlockers`,
the e-sign gate disposition, the closing blockers, registration state), the expected
days, and the plain-language "what happens next".

On the file: a horizontal milestone bar under the header — "you are here", who owns
it, N of M to leave the stage — and one **Stage Card** listing this stage's items
with the same Go-fix buttons WhatsLeftPanel already has. WhatsLeftPanel becomes the
Stage Card's last-two-stages case rather than a separate idea. On the pipeline: a
milestone column + "open items to next gate" count per file (the Encompass
open-conditions-column pattern).

Two rules from our own July research are honored: **phase is a ribbon and a facet,
never a container** (no navigation-by-phase — that was measured to fail), and the
conditions list stays ONE list.

*Reuses:* statuses, `workflow.js` chain, `gating` endpoint, gate dispositions,
stage-history. *New:* one `src/lib/milestones.js` definition + the bar/card UI + a
`GET /applications/:id/milestones` readiness endpoint generalizing `gating` beyond
two targets.

**Move 2 — No surprise gates: every gate shows its checklist before the button.**

A small, uniform **gate registry**: every one of the 24 mechanisms gets an entry that
can answer, live, for a given file: what do you check · what's your verdict right now
· what exactly is missing · who can pass it anyway · which button/door does that.
Most gates already compute this internally at refusal time — the change is exposing
the same computation as a *preview* (the pattern already proven by `esignSendGate`'s
panel blockers and the closing-prep card). Then:

- The Stage Card shows the NEXT gate's checklist while you're still working the stage
  (the Milestone Worksheet idea — this is the single highest-value change in the
  whole plan for the "nervous" feeling).
- Every refusal message gets the same footer, generated from the registry: _"Fix: …
  [button]. If it can't be fixed: [the one override path], decided by [role]."_ No
  refusal without a door, ever — this becomes a written rule and a test, since the
  codebase has fixed "a remedy that cannot produce the state the refusal demands" at
  least ten separate times, once each.

*Reuses:* every existing gate predicate untouched — the registry only names and
exposes them. *New:* the registry module + preview wiring + a lint-style test that
every registered gate names its remedy and its override path.

### Stage 2 — One door and one language

**Move 3 — One book of "yes": fold the override paths into the exception register.**

The exception register (EX-numbers, request → decide, expiry, SLA, export) already is
the industry's "Conditional Go". Finish what its own roadmap started: fold the
escalation box (`manual_program_escalations`) into it as an exception type; route the
admin "force" on status doors through it (recorded the same way `issuance_override`
already is); keep the super-admin unlock and condition override as they are but list
them in the same register view so ONE screen answers "everything senior-approved on
this file" (the decision certificate already wants this). End state: **one request
flow, one decision desk, one vocabulary** ("exception", decided by named roles),
with the specialized mechanics kept underneath. Nothing gets easier to bypass — it
gets easier to *find*.

**Move 4 — One language.**

- One status dictionary module per concern (the `conditions-vocab.js` pattern,
  extended to loan statuses and e-sign states); the four hand-kept label maps import
  it. Retire the dead `new` status from the pickers (it stays valid in data).
- Fill in `checklist_templates.category` (the Prior-to-Docs / Prior-to-Funding
  timing) on the ~57 templates that have it empty, and show it as a facet + count
  ("3 open before docs") — the field and the CTC-vs-funding split already exist;
  this is data entry plus one chip.
- One milestone name set shared by PILOT, the borrower timeline, and (display-only)
  the ClickUp bucket names — the borrower's 6-step journey and staff's 8-step
  stepper become views of the same list.

### Stage 3 — Structural clean-up (the double work and the missing hand-offs)

**Move 5 — Retire the double gates; finish the hand-off chain.**

- Replace the three manual tick-gates (`rtl_p4_ts`, `rtl_f_review`, `rtl_f_ctc`) with
  the real signals the code already promised: the FINAL-stamped term sheet document,
  an investor-review hand-off with an outcome, and the CTC confirmation that already
  exists on the ClickUp path. (Each replacement lands only when its signal is proven;
  the tick-box is hidden, not deleted — the July rule.)
- Give the chain its missing links: an `underwriting` hand-off type; a real
  post-purchase routing (the notify-list already exists — db/546); a loud failure
  (not silence) when `draw_setup` finds no single coordinator; and accept/return-to-
  sender on hand-offs (the workflow tables already record outcomes — this is UI).
- A **checklist truth pass** over the db/005-era items: the 2026 manual steps the
  system now performs itself (SharePoint folders, ClickUp task creation, USPS, credit
  scores into Encompass…) either self-complete from the real signal or are retired
  from new files — so the checklist stops asking humans to attest what the machine
  already did. (One owner review session decides each item; nothing is auto-deleted.)

**Move 6 — "My Day": one work list per person, and an exception-first pipeline.**

One endpoint per person that merges what today lives in ~12 places — their conditions
to clear, hand-offs, approvals waiting on them, sync reviews, expiring exceptions,
overdue orders — ranked by the same worst-first logic `next-up.js` already uses, with
SLA/ageing chips. The sidebar badges and the digests point AT this list rather than
being the list. The pipeline gains "at-risk / late" as the default sort (the
Encompass login pattern). This is last on purpose: it is the biggest UI build and it
gets easier once Moves 1–4 give it clean inputs.

### What we will NOT do

- No gate is removed or weakened; no frozen pricing engine is touched; the ClickUp
  status ladder stays authoritative; the Long-Term product is untouched.
- No phase-container navigation (measured to fail); the conditions list stays one
  list; nothing is deleted — hidden and aliased only.
- No big-bang rewrite. Every move ships in slices behind the standing audit gates.

### How we will know it worked (measure, don't hope)

Start counting now (before Move 1 ships), so the before/after is real:

1. **Gate-surprise rate** — refusals per week per gate (the refusal chokepoints
   already exist; add a counter). Success = refusals fall as previews rise.
2. **Time-in-stage** — already recorded (`application_status_history` +
   `status_changed_at`); report it per milestone.
3. **Clicks-to-answer** — "what's next on this file" and "what's on my plate today"
   each answerable from one screen in one click.
4. **Override sprawl** — share of senior-approvals recorded in the one register
   (target: all of them).
5. **The nervousness test** — the team can say, before pressing any Send/Advance
   button, exactly what will happen. Ask them monthly.

### Suggested order and rough effort

| Order | Move | Size (dev-days, rough) | Depends on |
|---|---|---|---|
| 1 | Move 2a — gate previews on the 3 scariest gates (term-sheet send, CTC, sign-off) | 3–5 | nothing |
| 2 | Move 1 — milestone module + bar + stage card | 8–12 | nothing |
| 3 | Move 2b — full gate registry + refusal footer rule | 5–8 | Move 1 |
| 4 | Move 4 — one language + category fill | 4–6 | nothing |
| 5 | Move 3 — one book of yes | 5–8 | nothing |
| 6 | Move 5 — double gates + hand-off chain + truth pass | 8–12 | Moves 1–2 |
| 7 | Move 6 — My Day + exception-first pipeline | 10–15 | Moves 1–4 |

Every estimate is an estimate. Each move is separately shippable and separately
reversible.

---

## Appendix A — The gate inventory (all 24)

| # | Gate | Blocks | Escape hatch | Who |
|---|---|---|---|---|
| 1 | Status freeze (`file-lock.js:127`) | structure writes on CTC/funded/declined/withdrawn files | move back, or structural unlock | super-admin |
| 2 | Term-sheet-sent freeze (`file-lock.js:144`) | all economics writes once the package is out | clear/void the package; 7 carve-outs (budget-neutral SOW, payoff contact, exp realloc — anyone; terms-neutral re-register, as-is/ARV, details — super-admin; unlock) | varies |
| 3 | E-sign send gate (`esign/gate.js:92`) | sending any package; 7 blocker codes (appraisal docs, appraisal review, product sign-off, closing date, stale registration, manual approval, rate-term cash) | `esign_before_ctc` exception with named waived codes | any staff request; admins decide |
| 4 | Term-sheet FINAL stamp (`term-sheet-stamp.js`) | mailing a term sheet stamped "INITIAL" | Finalize & send; super-admin reason | super-admin |
| 5 | Term-sheet freshness (`orchestrate.js:919`) | sending a sheet older than the appraisal | regenerate | — |
| 6 | Missing package documents (`orchestrate.js:996`) | sending an incomplete package | generate them | — |
| 7 | `send_term_sheet` capability | a broker/TPO sending the official package | none (by design) | internal staff only |
| 8 | Executed-package CTC gate (`esign/ctc-gate.js`) | clear-to-close without a fully signed package | admin force (recorded) | admin |
| 9 | `advancementBlockers` — conditions (`staff.js:12755`) | CTC/funded with open required conditions | clear/waive them; admin force | admin |
| 10 | `advancementBlockers` — gate items | CTC with unsigned `is_gate` rows | sign off; admin force | admin |
| 11 | Sign-off gate (~30 branches, `staff.js:8603`) | clearing a condition without its real evidence | super-admin condition override (db/344) or condition-waiver exception | super-admin / manage_pricing |
| 12 | Pending-documents pre-check (`staff.js:8586`) | signing off over an unreviewed document | accept/reject the document | any reviewer |
| 13 | Extra-slots pre-check (db/578) | signing off with an empty ad-hoc slot | fill or remove the slot | — |
| 14 | Inbound-CTC hold (`inbound-ctc-confirm.js`) | ClickUp moving a file to CTC unreviewed | human confirm | staff |
| 15 | Inbound-CTC readiness (same) | confirming an unready file | admin override (records what was skipped) | admin |
| 16 | Issuance backstop (`issuance-backstop.js`) | CTC/funding/exports on fatal findings — currently advisory-only | super-admin (recorded) when armed | super-admin |
| 17 | Encompass agreement gate (`reconcile.js:1372`) | term-sheet send while fields disagree | admin override w/ reason; per-field exceptions | admin / super-admin |
| 18 | Encompass tape gate (`reconcile.js:1302`) | tape export while unreconciled | super-admin `tape_encompass_override` | super-admin |
| 19 | Funding-channel rule (`reconcile.js:978`) | Blue Lake/EMCAP/CorrFirst table-funded | per-field exception | super-admin |
| 20 | Tape buyer/program gate (`tapes/buyer-rule.js`) | exporting a tape to the wrong buyer/program | admin bypass | admin |
| 21 | Pricing approval hold (`manual-program.js:87`) | manual programs / admin-zone overrides; borrower email withheld | escalation box decide/counter | manage_pricing |
| 22 | Rate-term $2,000 cash gate (`rate-term-gate.js`) | term-sheet send on an over-cash rate-term refi | fix costs / switch type / exception | super-admin |
| 23 | SOW budget trigger (db/069) | marking the budget condition satisfied off by a cent | fix the numbers (no DB-level override) | — |
| 24 | Closing-prep blockers (`closing-prep.js:854`) | ordering attorney closing prep unready | complete the named items | — |

Plus (not counted above): the reopen triggers that un-clear work when inputs change
(db/071/072/486, db/155/375, db/286-292, db/379/415), the sync-safety guards, the
accepted-documents-only outbound rule (db/424), the draw birth/park gates, and the
two CI gates (product separation; Encompass read-only).

## Appendix B — The status vocabularies (≥12)

1. External `applications.status` — 11 values (`staff.js:12540`).
2. Internal `applications.internal_status` — 39 ClickUp statuses (`clickup/status.js:28-71`).
3. The live ClickUp board's own status list (documented as 38 — the map has 39; the doc drifted).
4. ClickUp's "Borrower Portal Status" custom field (a pushed mirror of #1).
5. Borrower journey — 6 steps (`status-notify.js:51`).
6. Timeline/stepper paths — 8 steps (`StatusTimeline.jsx`, `LoanProgress.jsx`).
7. Pipeline groups — 5 (`StaffQueue.jsx:21` + server twin `staff.js:760`).
8. Workflow submission types — 11 (+12 outcome labels) (`workflow.js`).
9. Closing stages — 6 (`workflow.js:723`).
10. Checklist item statuses — 5 (+4 "done" stamps) (`db/schema.sql:243`).
11. Underwriting condition statuses — 4 (`db/022`).
12. E-sign envelope statuses + derived phases — 7+7 (`esign/tracking.js`).
    (+ draw lifecycle & approval stages, sync states, Encompass milestones.)

Four hand-kept label maps render vocabulary #1 (`status-notify.js:28`,
`StaffApplication.jsx:1000`, `StaffQueue.jsx:11`, the stepper pair). The `new` status
is unreachable from ClickUp and has no landing status (`clickup/status.js:123-126`).

## Appendix C — Where a staffer's work lives today

Sidebar badge counters: workflow, tasks, my-exceptions, track-record reviews,
closing, purchasing, sync reviews, escalations, exceptions, finding escalations,
notification drafts, chat unread (`StaffLayout.jsx:303-416`). Work-holding screens
(~20): pipeline (7 KPI + 7 exception tiles), tasks (2 lists), workflow, approvals (6
tabs), chat, leads, emails, notifications, e-sign, orders, tapes, closing,
purchasing, draws, AI center, track-record workspace, dashboards, ClickUp control,
CRM, ops. Duplicate doors: findings ×2, track record ×2, draws ×2, file overview ×2.
Digest-only work classes: order overdue, workflow ageing, draw chases,
purchase-advice chase (`notification-digests.js`).

## Appendix D — Sources for the industry benchmark

ICE/Encompass: "Working with Configurable Loan Workflows" (ICE documentation
library); ICE LO Connect Pipeline help; ICE "task-based workflow" announcement;
Encompass 18.2 release notes (open-condition pipeline columns); Developer Connect —
Enhanced Conditions & Loan Conditions APIs; Take Five Consulting milestone guides;
NAMP on PTD/PTF clearing authority. Modern platforms: Floify, nCino, SimpleNexus,
Mortgage Automator, LendingWise, Liquid Logics public documentation. Gate science:
Cooper, "The Stage-Gate Idea-to-Launch System" (Wiley 2010) and Stage-Gate
International's overview (Go/Kill/Hold/Recycle/Conditional-Go); NASA Systems
Engineering Handbook §7.9 (entrance/exit criteria) and NPR 7123.1 Appendix G;
Gawande, *The Checklist Manifesto* (5–9 items, DO-CONFIRM, pause points);
state-machine workflow literature (one enum per concern, whitelisted transitions,
derived readiness).

## Appendix E — Small factual clean-ups found during this research

Recorded here so they are not lost; none change behavior:

1. `src/routes/staff.js:3759` — a stale comment says the "initial term sheet"
   refusal must not be re-added; the 2026-08-14 reversal deliberately restored that
   refusal (with the Finalize remedy). The comment should be corrected before it
   misleads a future session.
2. The "38-status" figure in docs and comments vs. the live 39-key map
   (`clickup/status.js:47` — `imported to bank (2-em)`).
3. The dead phase-label dictionary (`StaffApplication.jsx:1001-1006`) — keys
   `p1_intake…p5_closing` never match the stored `'1'…'5'`.
4. `PHASE`/`category` both exist as timing taxonomies; `category` is null on ~57
   templates (`app-v2/src/lib/condition-subjects.js:15-18`).
