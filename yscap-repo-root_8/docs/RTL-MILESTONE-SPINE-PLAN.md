# The Milestone Spine — one workflow layer over everything we already have

_Owner-directed 2026-08-20: "Let's focus on one thing right now… an overlay layer with
solid rock workflow and milestones that just control all the milestones in the back. **It
needs to be bi-directional.** Everybody should know what the process is, what the stages
are… I believe there is most structure already. I just want to foundation it solid rock,
high-end… **not mess everything up.** Focus on simplicity like crazy… Everything should keep
working solid rock. Focus on the loan file… the draws, the loan file workflow and milestones
should be together as one big thing. It should be keeping all the other milestones on the
back of it, connected. **Every milestone shouldn't stand in the way of the others' part.**"_

**This document changes no code.** It is the plan for the one thing.

Companion: `docs/RTL-WORKFLOW-GATES-RESEARCH.md` (the full as-is study). This takes ONE move
out of it — the spine — and makes it a real, slow, safe build. Everything else is parked in
the ranked list at §11.

---

## 1. The answer in one paragraph

**You are right that the structure already exists — more than you think.** The five phases of
the RTL process are already in the database with every condition carrying its phase, its
owning role and a gate flag. The 39-status ClickUp ladder is already mirrored both ways. The
hand-off chain already routes work by role with deadlines. And — the finding that matters
most — **the parallel-track model you are asking for is already half-built**: a file can
already carry a draw hand-off, a post-closing hand-off and an exception at the same time,
each with its own deadline and its own owner, and **the draw system already refuses to write
a loan status at all**, which is exactly why draws never block anything today. What is
missing is that **none of it has ever been assembled into one picture, and nothing shows
it.** So the Milestone Spine is not a new system. It is **one thin layer that reads what is
already there, shows it as one process, and drives the systems underneath through the doors
they already have.** It stores no new state of its own — and that single property is what
makes it bi-directional for free and impossible for it to break what works today.

---

## 2. The design, in one picture

Two things, and keeping them apart is the whole idea:

```
  THE SPINE — where the FILE is (exactly one at a time)
  ┌────────┬─────────────┬────────────┬──────────────┬──────────┬───────────────┬────────┬──────────────┐
  │ Intake │ Structuring │ Processing │ Underwriting │ Approval │ Clear to Close│ Funded │ Post-Closing │
  └────────┴─────────────┴────────────┴──────────────┴──────────┴───────────────┴────────┴──────────────┘
        (off the path: On hold · Declined · Withdrawn)

  THE TRACKS — what is HAPPENING (many at once, each with its own state)
        Conditions   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
        Valuation        ▓▓▓▓▓▓▓▓▓▓▓▓▓
        Orders           ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
        Terms                ▓▓▓▓▓▓▓▓▓▓▓▓▓▓
        Closing                          ▓▓▓▓▓▓▓▓▓▓▓▓
        Draws                                        ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
        Investor / purchase                          ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
```

**The rule that answers "every milestone shouldn't stand in the way of the others' part":**

> **The spine says where the file IS. The tracks say what is HAPPENING.
> A track never moves the file by itself. A milestone never freezes a track that is not its business.**

This costs no new database columns, because every track already keeps its own state
somewhere. We are only agreeing to stop reading them all as one number.

---

## 3. The eight milestones

Chosen so **each maps onto ClickUp statuses that already exist** — this table is the entire
definition. Nothing is invented, nothing is renamed in ClickUp, and the borrower-facing
status keeps its current meaning.

| # | Milestone | Owned by | The ClickUp statuses it covers today | Borrower sees |
|---|---|---|---|---|
| 1 | **Intake** | Loan officer | `starting`, `prospect / pricing` | File intake |
| 2 | **Structuring** | Loan officer | `structuring loan`, `active / fill clickup(1-em`, `rolled back` | In review |
| 3 | **Processing** | Processor | `assigned to processor`, `self procesing`, `workflow`, `secondary workflow`, `file being worked`, `file on desk`, `waiting for docs` | Processing |
| 4 | **Underwriting** | Underwriter | `delegated initial`, `delegated conditional`, `in underwriting`, `non del imported ba(2-em)`, `imported to bank (2-em)`, `approval processing (3-em)`, `resubmitted (4-em)` | Underwriting |
| 5 | **Approval** | Underwriter → LO | `delegated ctc submission`, `final submission (4-em)` | Approved |
| 6 | **Clear to Close** | Closer | `ctc (4-email)`, `scheduling closing`, `active closing` | Clear to close |
| 7 | **Funded** | Closer → draw coordinator | `closed (6-email funded)`, `refinanced` | Funded |
| 8 | **Post-Closing** | Post-purchase desk | `in purchase review`, `purchase conditions`, `pa issued-post closing.`, `waiting for final docs`, `non del closed reconciled`, `closed reconciled` | Funded |

Off the path, unchanged: **On hold** (`inactive / on hold`), **Declined**, **Withdrawn** (5
cancel statuses). The code already treats on-hold correctly as *"a PAUSE overlaid on the
stage, not a stage"* — but today it cannot say which stage is paused, because the status
field does not carry it, so the bar simply goes blank. **The spine can recover it** from the
stage history the system already records, and show "On hold — paused in Underwriting". That
is a small, genuine gain and a good early test of the whole idea: it is pure reading.

**The only real change in this table** is that milestone 8 is pulled out of milestone 7.
Today six post-closing ClickUp statuses all read as the single word "funded" — so from the
day a loan closes, PILOT stops being able to say where it is, while the purchase desk, the
reconciliation and the draws are all still running. Splitting them is a **read**: the
information already sits in `internal_status`, the borrower-facing status does not move, and
`applications.status` is not touched.

**It matches the process you already wrote.** The five phases seeded from the Fix & Flip
processing guide (`db/005_rtl_workflow.sql`) — Borrower Intake · File Setup · Verifications &
Orders · Appraisal Back / Check the Numbers · Attorney & Final Review — sit inside milestones
1–6. The spine simply carries the story past the term sheet, which the written guide never
covered.

---

## 4. The three rules that make it solid rock

**Rule 1 — It stores nothing of its own.**
No milestone column, no new status field, no second copy of anything. The milestone is
*computed* from what the file already holds. A thing that is never stored can never drift,
can never disagree with ClickUp, and can never need a backfill. Verified: `applications`
carries no milestone/stage/phase column today, so there is nothing to collide with, and
**phase 1 needs no migration at all.**

**Rule 2 — Reading is a pure function; writing goes through the doors we already have.**
- *Reading:* one pure resolver — facts in, milestone picture out, no writes, no side effects.
  If it is ever wrong it shows a wrong label; it cannot move a loan.
- *Writing:* advancing a milestone **calls the same door the status dropdown already calls**
  (`applyInternalStatus`). It never writes a status itself.

**Rule 3 — It decides nothing.**
Every gate that refuses something today keeps refusing it, in the same place, with the same
words. The spine never becomes a new reason a file cannot move. This is the discipline the
draw checklist already states about itself: *"IT DECIDES NOTHING. This is a description of
the file, not a gate… a checklist that could silently start refusing a draw would be a new
gate nobody signed off."*

---

## 5. Bi-directional, exactly

**Back systems → the spine (inbound): free and instant.** Because the milestone is *derived*
from `internal_status` — the field the existing two-way sync already maintains — the moment
anybody moves a card in ClickUp, the next read of the file shows the new milestone. No
listener, no new sync, no watermark to keep, nothing to fall out of step. **This direction is
bi-directional for free precisely because we refused to store the milestone.**

**The spine → back systems (outbound): one door, five answers.** Advancing resolves the
target to an exact ClickUp status and hands it to `applyInternalStatus`, which already does
all of this in one place: validates the status is real, writes `internal_status` + `status` +
the notification watermark + the stage clock **in a single statement**, queues the ClickUp
push, records the stage history, re-runs the conditions engine, and announces the change. The
spine must handle all five of its answers — `unchanged`, `healed`, `forbidden` (role),
`blocked` (with the blockers), and `ok` — and must never retry past `blocked` without an
explicit admin force.

Two invariants the spine inherits by using that door, both already proven by tests:
**word-preserving** (the ClickUp stage it lands on reads back as the same borrower-facing
word, so the next pull cannot flip it) and **no surprise emails** (it never lands on a ClickUp
stage whose name triggers a ClickUp email, except the two you want).

**Where a milestone is really a hand-off** (to the processor, the closer, the draw
coordinator), advancing submits that hand-off instead — which already moves the ClickUp status
by itself, and already carries the role, the pointer and the deadline.

**Encompass stays read-only and stays out of the driver's seat.** Its milestones are read
today only to answer "is this deal closed or dead?" for the track record, and there is no
Encompass-milestone → PILOT-stage crosswalk anywhere in RTL. The spine shows Encompass's
milestone as an **advisory column beside** our stage; it never derives from it.

**The one thing the spine must never do** is write `applications.status` or `internal_status`
directly — see §9 for exactly what that would break.

---

## 6. Milestones that do not block each other

### What is already parallel — and must not be broken

- **A file can already run several hand-offs at once.** `workflow_items` is unique only over
  *live* rows per (file, type), so `draw_setup`, `post_closing` and `exception` can all be
  open simultaneously, each with its own owner and SLA. **This is already the tracks
  skeleton.**
- **The draw system writes no loan status at all** — all three draw hand-offs carry no status.
  That single decision is what keeps draws from blocking anything today, and it is the model
  the spine generalises.
- **Closing-stage conditions are excluded from clear-to-close but included for funding** —
  title and insurance cannot deadlock CTC but do hold the wire. This is the correct pattern to
  copy, not to change.
- **AI findings never gate** — kept in a separate advisory list, with a second filter behind it.
- **The purchase desk and the draw desk deliberately do not wait for each other** — the code
  says so in as many words: *"TWO CLOCKS, AND THEY DELIBERATELY DO NOT WAIT FOR EACH OTHER."*

### What blocks unnecessarily — found by this research

Two of these are **live bugs**, not design opinions. Both were reproduced in the code.

1. **A funded file's draw wire form can dead-letter on an origination rule.** On the first
   send, a draw wire form correctly skips the origination gate. But when the retry poller
   re-sends it, the gate runs again and only two of its blockers are scoped by purpose — the
   appraisal-documents, appraisal-review and product-pricing blockers still apply to a *draw*
   envelope. A permanent failure follows, so the borrower's wire form is dead-lettered because
   of an appraisal condition on a loan that funded weeks ago. The gate's own comment names
   this exact hazard and fixed it for one blocker only.
2. **The money can move while the milestone does not.** When the closer advances the closing
   stage to fully-closed, the matching status change runs in a swallowing catch and can come
   back refused — the file stays at Clear to Close and reports `statusBlocked`. Because every
   draw entry point keys on the status being `funded`, one unrelated outstanding condition
   leaves a loan that is closed, wired and reconciled with its **entire draw phase locked**.
   (An admin advancing the stage forces past it; a closer without admin rights does not.)
3. **"Funded" is one word for eight situations**, so a file that is simultaneously drawing, in
   purchase review and chasing trailing documents has one slot to say so. Milestone 8 and the
   tracks fix this by reading, not by writing.
4. **The draw section is locked pre-funding for reading, too** — a coordinator cannot
   pre-stage inspection rules or partner matching before the status flips, although the panel
   underneath already handles that state.

Items 1 and 2 are on the outstanding list as bugs (§11). The spine does not fix them and must
not hide them.

---

## 7. Draws are part of the same thing

On the spine they already are: **the draw track opens at milestone 7 and runs through
milestone 8.** The loan's story does not end at funding — it continues, and the same bar shows
it.

Nothing about the draw system changes. It keeps its ladder, its screens, its approvals and its
coordinator. What changes is that the file's spine *knows* the draw track exists and shows its
state in line with everything else — today the file knows only "funded and you have the
permission", and the section badge literally reads "soon". The draw desk already knows a great
deal about the file; the file knows almost nothing about the draws. That is the seam to close,
and it closes by reading.

---

## 8. How we build it — slowly, one reversible step at a time

Five steps. **Only step 3 writes anything.**

| Step | What ships | Who sees it | Risk if wrong |
|---|---|---|---|
| **0** | The definition: one pure module with the eight milestones and their status mapping, plus its tests. Not wired to anything. | Nobody | **None** |
| **1** | The milestone bar on the loan file. Read-only, derived. "You are here · owned by X · N of M to leave this stage." | Everyone, on the file | **Cosmetic** — a wrong label, never a wrong loan |
| **2** | The stage card: what this stage waits on, and what the next gate will need — from readiness the system already computes. | Everyone, on the file | Cosmetic |
| **3** | **Bi-directional write.** Advance / send back from the bar, delegating to the existing status and hand-off doors. Behind a switch, one door at a time. | Staff who move files | Controlled — same door the dropdown uses; the switch turns it off |
| **4** | Draws joined onto the spine; the story continues past funded. | Draw coordinator, LOs | Cosmetic |
| **5** | The milestone column on the pipeline, so it reads across files. | Everyone | Cosmetic |

**Steps 0–2 change nothing about how the system behaves** — they make visible what is already
true. That is deliberate: you get "everybody knows what the process is" before a single write
path is touched.

### The footprint of step 1 — four files, no migration

1. **New** `src/lib/milestones.js` — pure: the milestone list, and one resolver.
2. **One additive key** on the readiness endpoint the file screen already calls. Nothing in the
   codebase reads that response exhaustively, so a new key is invisible to every existing
   reader; the call is wrapped so a milestone error can never break the widget four surfaces
   depend on.
3. **One render line** on the loan file, beside the stage dots that already sit above the rooms
   (so it shows in every room without a room switch). No new fetch — the readiness payload is
   already loaded there.
4. **One pure test** added to the test chain.

That is the whole of step 1. No migration, no new endpoint, no new screen state, no gate
touched, and every existing reader byte-identical.

### What we get for free

The readiness payload already stamps **every outstanding item with the file section that fixes
it and a plain-language reason** — so "N of M to leave this stage" and the Go-fix links cost
nothing to build. The hand-off chain already knows who owns each step and why a step is not
yet available, which is most of a milestone owner model.

### The house pattern to copy

`src/sitewire/draw-checklist.js` is the closest thing that already exists and should be the
template: a frozen list of steps as *data*, a pure builder that degrades a fact it cannot read
to **"unknown" rather than guessing "done"**, and an IO half that takes its database handle as
an argument. Its stage vocabulary should follow `src/sitewire/approval.js`, which keeps a
staff label and a borrower label per stage — so the day the borrower timeline reads the same
list, it already speaks the right words.

The test bar this repo holds to: pin the ladder (every status maps to exactly one milestone,
none claimed twice); pin that **unknown is its own state** (an unrecognised status shows the
raw word, and on-hold/declined/withdrawn stay off the path); pin that **it decides nothing**
(no gate, no status door imports it); pin that it degrades honestly when the payload is
missing; and pin that the readiness payload is byte-identical with and without the new key.
Then break each rule on purpose and confirm the suite goes red.

---

## 9. What could break, and why it will not

Writing a status directly instead of through the existing door would cause all of this — which
is exactly why the spine does not:

| The worry | Why it cannot happen |
|---|---|
| The spine and ClickUp disagree | No stored state to disagree *with* — it reads ClickUp's own mirrored field |
| A stale milestone after somebody moves a card | Computed at read time, every time |
| The card never actually moves | The push is queued by the door; a direct write would never queue it, and there is no sweep that would notice |
| PILOT's own change comes back as a new event | The door stamps the watermark in the same statement as the status |
| A borrower is emailed a change they already know about | Same watermark; the door owns announcements |
| "Days in stage" goes wrong | Stage history is written by the door — and it cannot be backdated later |
| A gate gets skipped | The door runs the role check, the readiness check and the issuance backstop |
| Funding side effects are missed | Post-closing seeding, the draw hand-off and the track record all hang off the door |
| A new gate starts refusing things | The spine decides nothing (Rule 3) |
| A migration goes sideways on a live database | Steps 0–2 need no migration |
| It gets in the way while half-built | Every step is independently revertible; step 3 is behind a switch |

---

## 10. What I need from you before step 0

1. **The eight milestone names** (§3) — are these the words your team actually uses? A name is
   wrong on every screen forever, so it is worth settling now.
2. **Splitting Post-Closing out of Funded** — confirm you want the loan's life after funding
   visible as its own stage. It changes nothing the borrower sees.
3. **The owners column** (§3) — is that the real ownership in your shop today?

---

## 11. Everything else — ranked

Not to be started until the spine lands. The two bugs are first because they are cheap and
they are hurting files today.

| # | Item | Why it matters | Size |
|---|---|---|---|
| 1 | **The draw wire form dead-letter** (§6.1) | A funded loan's wire form fails permanently over an origination rule. Real money, real borrower. | Small |
| 2 | **Closing advances but the status is refused** (§6.2) | The loan is closed and wired while the file says Clear to Close and the whole draw phase is locked. | Small |
| 3 | **"Post a condition" actually creates the condition** | The button is pressed and creates nothing. Authorised in July, still open. | Small |
| 4 | **The stale/dead references** — a comment contradicting a live gate, a phase dictionary whose keys never match, the 38-vs-39 status drift | Each one misleads whoever reads it next. | Small |
| 5 | **Gate previews on the three scariest gates** (term-sheet send, clear-to-close, condition sign-off) | The biggest single cure for "the gates make everybody nervous". Sits naturally on the step-2 stage card. | Medium |
| 6 | **One language for statuses** | Twelve vocabularies, four hand-kept copies of the same eleven words. | Medium |
| 7 | **The gate registry + "no refusal without a door"** | Every refusal names its fix and its one override path. | Medium |
| 8 | **One book of "yes"** — fold the escalation box and admin force into the exception register | Nine ways to approve becomes one place to look. | Medium |
| 9 | **Finish the hand-off chain** — the missing underwriter hand-off, real post-purchase routing, the silent draw-coordinator failure | Two ends of the chain are "somebody watches a queue". | Medium |
| 10 | **Retire the three double tick-boxes** | Only safe once the spine shows the real signal. | Medium |
| 11 | **Condition timing buckets** shown as counts ("3 before docs") | Makes "are we ready?" a number, not a meeting. | Small–Medium |
| 12 | **"My Day"** — one work list per person | Biggest build; easiest last, once the spine and one language are clean. | Large |

Deliberately **not** on this list: anything touching pricing, the ClickUp ladder itself, the
Encompass read-only rule, or the Long-Term product.
