# The Milestone Spine — one workflow layer over everything we already have

_Owner-directed 2026-08-20: "Let's focus on one thing right now… an overlay layer with
solid rock workflow and milestones that just control all the milestones in the back. **It
needs to be bi-directional.** Everybody should know what the process is, what the stages
are… I believe there is most structure already. I just want to foundation it solid rock,
high-end… **not mess everything up.** Focus on simplicity like crazy… Everything should keep
working solid rock. Focus on the loan file… the draws, the loan file workflow and milestones
should be together as one big thing. It should be keeping all the other milestones on the
back of it, connected. **Every milestone shouldn't stand in the way of the others' part.**"_

_Extended 2026-08-20: "The last thing post-closing should be post-closing/purchasing, and then
there should be another step of sold post-purchase. **Do the research exactly for how to name
them.** And enhance the action center so that everybody should have the actions: submit a file
for processing, submit a file for condition clearing… **even more rock-solid connected to the
actual milestone statuses and the workflow of the processors.** When they finish clearing
condition, it should… take it to the next stage… while conditions are being cleared… it should
automatically move statuses. **You need to watch what you're doing and watch the notifications
that are currently tied to certain statuses.**"_

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
  ┌────────┬─────────────┬────────────┬──────────────┬──────────┬────────────────┬────────┬──────────────────────────┬─────────────────────┐
  │ Intake │ Structuring │ Processing │ Underwriting │ Approval │ Clear to Close │ Funded │ Post-Closing & Purchasing│ Sold — Post-Purchase│
  └────────┴─────────────┴────────────┴──────────────┴──────────┴────────────────┴────────┴──────────────────────────┴─────────────────────┘
        (off the path: On hold · Declined · Withdrawn)          └──── the sale ────┘

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

## 3. The nine milestones

Chosen so **each maps onto ClickUp statuses that already exist** — this table is the entire
definition. Nothing is invented, nothing is renamed in ClickUp, and the borrower-facing status
keeps its current meaning.

| # | Milestone | Owned by | The ClickUp statuses it covers today | Borrower sees |
|---|---|---|---|---|
| 1 | **Intake** | Loan officer | `starting`, `prospect / pricing` | File intake |
| 2 | **Structuring** | Loan officer | `structuring loan`, `active / fill clickup(1-em`, `rolled back` | In review |
| 3 | **Processing** | Processor | `assigned to processor`, `self procesing`, `workflow`, `secondary workflow`, `file being worked`, `file on desk`, `waiting for docs` | Processing |
| 4 | **Underwriting** | Underwriter | `delegated initial`, `delegated conditional`, `in underwriting`, `non del imported ba(2-em)`, `imported to bank (2-em)`, `approval processing (3-em)`, `resubmitted (4-em)` | Underwriting |
| 5 | **Approval** | Underwriter → LO | `delegated ctc submission`, `final submission (4-em)` | Approved |
| 6 | **Clear to Close** | Closer | `ctc (4-email)`, `scheduling closing`, `active closing` | Clear to close |
| 7 | **Funded** | Closer → draw coordinator | `closed (6-email funded)`, `refinanced` | Funded |
| 8 | **Post-Closing & Purchasing** | Post-closing desk | `in purchase review`, `purchase conditions` | Funded |
| 9 | **Sold — Post-Purchase** | Post-purchase desk | `pa issued-post closing.`, `waiting for final docs`, `non del closed reconciled`, `closed reconciled` | Funded |

Off the path, unchanged: **On hold** (`inactive / on hold`), **Declined**, **Withdrawn** (5 cancel
statuses). The code already treats on-hold correctly as *"a PAUSE overlaid on the stage, not a
stage"* — but today it cannot say which stage is paused, because the status field does not carry
it, so the bar simply goes blank. **The spine can recover it** from the stage history the system
already records, and show "On hold — paused in Underwriting". A small, genuine gain, and a good
early test of the whole idea: it is pure reading.

**The only real change in this table** is that the last two milestones are pulled out of
`funded`, where six ClickUp statuses are invisible today. That is a **read**: the information
already sits in `internal_status`, the borrower-facing status does not move, and
`applications.status` is not touched.

**It matches the process you already wrote.** The five phases seeded from the Fix & Flip
processing guide — Borrower Intake · File Setup · Verifications & Orders · Appraisal Back /
Check the Numbers · Attorney & Final Review — sit inside milestones 1–6. The spine carries the
story past the term sheet, which the written guide never covered.

---

## 3a. Why those two names — the research

You asked me to research the naming exactly rather than pick something that sounded right. The
short answer: **your two names are the industry's two names**, and the split point is the
purchase advice.

**What the industry does.** Encompass runs Post-Closing → Shipping → Completion after funding.
Correspondent lending — which is what we actually do, funding loans and selling them to note
buyers — uses a well-defined chain: *deliver → purchase review → purchase conditions (also called
purchase suspense) → **purchase** → purchase advice → trailing documents → reconciliation.*
"Post-purchase" is a real, formal term: Fannie Mae runs a documented **post-purchase review
process** and a **Post-Purchase Adjustment** programme. The dividing line the industry draws is
exactly the one you drew: **post-closing** is after the borrower signs and before the investor
buys; **post-purchase** is after the investor buys. Servicing is a third thing and neither stage
is servicing.

**Where the boundary falls, and why.** **The purchase advice IS the sale** — Fannie's own rule is
that the PA is available *the business day the purchase proceeds fund*. It is a receipt, not an
invitation. So `in purchase review` and `purchase conditions` are the selling process (milestone
8), and everything from `pa issued` onward is after the money (milestone 9). Our own code already
agrees: a recorded purchase-advice date is treated as conclusive proof the loan sold.

**"Sold", not "Purchased".** We are the seller; the investor is the buyer. Fannie says "purchased"
because Fannie is buying. From our desk the loan **sold** — and the codebase already made this
call consistently ("Sold to the investor", "Sold at the closing table", "This file was not sold
yet", "This loan has been sold", the "Chase the sale" badge). The *documents* keep the buyer's
word, because that is what is printed on them: purchase advice, purchase conditions, purchase
review, the purchasing desk. **State in our voice, documents in theirs.** That is why *Sold —
Post-Purchase* reads correctly instead of redundantly.

**The borrower keeps seeing "Funded" for both.** Three reasons, and the third is decisive: telling
a borrower "Sold" invites "sold to whom?", and never naming the capital partner to a borrower is
a standing hard rule; nothing about their loan actually changes at the sale; and the
borrower-facing status list is constrained in the database, so adding a value is a migration plus
every label map in the portal, for negative value.

### Three naming conflicts this creates inside the code

None is a blocker, all three are cheap, and each will bite later if left:

1. **`post_purchase_notify` and `post-purchase.js` today mean the people who finish
   *milestone 8*** — they upload the purchase advice and mark purchasing complete. If milestone 9
   is called Post-Purchase, that list is misnamed. The fix is a rename to something like
   `loan_sold_notify` / `sale-handoff.js`; the screen already supplies the right words — it says
   *"Told when a loan sells."* (The alternative is to call milestone 9 **Sold — Post-Sale**, which
   dodges the collision but gives up the industry term.)
2. **"Reconciled" is already overloaded.** Our closing workflow has a `fully_reconciled` stage —
   that is *our own wire and closing* reconciliation, which happens **before** the sale. ClickUp's
   `closed reconciled` is the *post-purchase* reconciliation of the purchase advice. Never name a
   stage "Reconciled" bare; keep reconciliation a status inside milestone 9.
3. **The seven post-closing trailing-document items straddle the boundary** — six are milestone-8
   document cure, and "Recorded trailing documents" is the milestone-9 chase. Either split the
   seed later, or accept that one post-closing checklist survives into the next stage.

### One question I will not guess

The ClickUp status is literally `pa issued-post closing.` — a name that contradicts itself, since
a PA-issued loan is past post-closing by definition. More importantly, our own code says in three
places that the advice is *"re-issued post closing and again post purchase."* **If there are two
purchase advices — a preliminary one at post-closing and the real one at the sale — then
`pa issued` may mean the preliminary one, and it belongs in milestone 8, not 9.** The ClickUp
ordering (after `purchase conditions`, before `waiting for final docs`) says it is the real one.
This decides where the boundary sits, so it is question 4 in §10 and the build does not start on
milestones 8–9 until you answer it.

If you do want that ClickUp status renamed to something honest like `pa issued — sold`, note that
three hard-coded lists match the literal string **including its trailing full stop** and must move
in the same commit.

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

## 6a. The Action Center — "submit for processing" and "submit for condition clearing"

You asked for everybody to have these actions, wired rock-solid to the milestones and to the
processors' workflow. Here is what is actually there today, because one part of the answer is
better than expected and one part is worse.

### The good news: it is already open to everybody

**Submitting is not gated by role or capability today.** The two endpoints behind the Submit
panel carry no permission check of their own — any staff member who can open the file can
already submit any type, including Processing and Condition Clearing. So "everybody should have
the actions" does not need a gate removed. What it needs is the **two real barriers** fixed,
because both are dead ends:

1. **No processor exists to send it to.** The button greys out and says *"No processor set up
   yet — add one on the Team screen"* — a refusal with no way to act from where you are standing.
2. **Two or more processors exist and nobody was picked.** The submit comes back asking you to
   pick a recipient, which the panel then has to re-open.

Neither is a permission problem. Both are the same shape as the gate problem in the wider
research: **a refusal that does not carry its own remedy.**

### What "rock-solid connected to the milestones" means concretely

The connection already exists — every hand-off type carries the exact ClickUp status it drives,
and submitting moves the file. What is missing is that **the file screen never shows the
hand-off.** There is already an endpoint that returns a file's full workflow timeline — who has
it, when they picked it up, whether it is overdue — and **nothing in the portal calls it.** The
panel shows one line: "Already in someone's workflow." That endpoint is a free win: the
milestone bar's stage card should show *who holds this file right now, since when, and whether
it is past its deadline*, straight from data we already compute.

Three smaller things to make it solid rather than approximately right:

- **One definition of "how clear are the conditions."** The 80% threshold is written as a literal
  in four separate places, and the percentage itself is computed by a rule that does **not** match
  the rule the clear-to-close gate uses — it counts gate items in the denominator and ignores
  condition timing. So "100% cleared" and "ready for clear to close" are two different facts today.
  One definition, read by both.
- **A blocked status move must be visible.** When a submit or a send-back tries to move the status
  and the move is refused, the refusal is swallowed — the submit succeeds, the status quietly does
  not move, and nobody is told. The response already carries a `statusBlocked` flag that no screen
  reads.
- **The outcome list has drifted into three copies** — twelve labels in one place, eleven in the
  table that decides what each outcome does, and a third hard-coded eleven in the queue screen.
  "Inspection ordered" exists in one and not the others. One list.

### Keeping the 80% rule exactly as it is

Condition Clearing today refuses to submit until 80% of conditions are already cleared, and the
code records that as **your own instruction** — *"once 80–90% of conditions are cleared."* Read
with its helper text — *"Sends this file to the processor to clear the remaining conditions"* —
the current design is a **last-mile hand-off**, not the whole condition phase. You said "the same
way we have it now", so the plan **keeps that rule untouched** and only makes the number one
definition instead of four.

The one thing worth confirming (question 5 in §10): if you think of Condition Clearing as *the
phase where conditions get worked* rather than the final push, then the 80% gate is backwards —
the action would be unavailable exactly when there is most to do. Today's code is coherent under
the "last mile" reading. I have not changed it either way.

---

## 6b. Statuses that move by themselves — and the line automation must never cross

You asked for statuses to move automatically as conditions are cleared, and warned me to watch
the notifications tied to statuses. That warning is exactly right, and the research turned it
into a hard boundary.

### The line is already drawn in the code, twice

The system already knows which statuses are consequential. It keeps two lists that agree with
each other: the statuses that require decision authority, and the statuses that **email the
borrower**. They are the same five: **Approved · Clear to Close · Funded · Declined · Withdrawn.**

So the plan adopts those existing lists verbatim rather than inventing a third one — the repo's
own rule is one definition, never a second copy.

| Zone | Statuses | What automation may do |
|---|---|---|
| 🟢 **Green** | Anything inside **Processing** (`assigned to processor`, `workflow`, `waiting for docs`), plus In review and Underwriting | **May move automatically.** Moving among the Processing statuses changes no borrower-facing status at all, so it announces *nothing* — no borrower email, no team email, no ClickUp email. Silent by construction. |
| 🟡 **Amber** | The step *after* condition clearing | **May raise the next hand-off automatically** — putting the work in the right person's queue and emailing that one person, which is the notification everybody wants — but **must not move the status.** |
| 🔴 **Red** | Approved · Clear to Close · Funded · Declined · Withdrawn · On hold | **Never automatic.** Always a human. |

### Why Red is Red — the specific damage

- **Funded is irreversible in three separate systems at once.** It fires a ClickUp automation
  email we do not control and cannot recall; it mints a signed decision certificate that can only
  be superseded, never revoked; and it writes a deal onto **the borrower's own track record**,
  which then feeds the experience and tier maths on *every other file that borrower has*.
- **Clear to Close freezes the whole loan structure.** From that moment every economics edit is
  refused — re-registering the product, editing details, even a budget-neutral scope
  reallocation — and the only way back is a super-admin unlock with a typed reason. It also emails
  outside counsel on the closing chain.
- **Approved, Declined and Withdrawn all send the borrower an unrecallable email** — "Your loan
  has been approved", "we are unable to move forward".
- **On hold is the quiet one and the dangerous one**: it notifies nobody at all, and it silently
  drops the file out of every dashboard, digest, task list and draw reminder.

### One more trap, which is not about statuses at all

Moving a file from Intake into the active pipeline is what **opens the conditions engine** for the
first time — and the engine then attaches its whole rule-driven set at once and sends the borrower
its *own* email about the new conditions. That email does not obey the status-email policy, so a
status move that looks safe can still mail the borrower through a side door. Automation must not
cross that particular transition, and any batch work must use the engine's existing "do not
notify" option.

### Five rules the automatic mover obeys

1. **Use the existing lists** — Decision statuses and borrower-email statuses, imported, never
   re-typed.
2. **Stamp every automatic move as `system`.** The stage-history table already accepts a `system`
   source; the two human doors hard-code `portal`. That one line is what keeps "days in stage",
   the borrower's timeline and every report able to tell a person's move from a machine's.
3. **At most one automatic move per file per hour**, using the same once-per-period claim the
   digests already use. No such throttle exists on status changes today, and without it churn
   would permanently blind the stale-file alerts — because every move resets the clock they
   measure.
4. **Never force past a gate.** Automation consults the same readiness check a human does and
   stops when it says stop; it never uses the admin override.
5. **Announce only when the borrower-facing status actually changed** — the existing test — and
   advance the notification watermark in the same write, or the next ClickUp sync will echo our
   own change back as if a human made it.

### What this delivers for your actual ask

- *"While conditions are being cleared it should automatically move statuses"* → **yes, inside the
  green zone**, where it is silent and reversible: picking up a condition-clearing hand-off moves
  the file to `waiting for docs`; work resuming moves it back to `workflow`. The borrower sees
  "Processing" throughout, because that is what is true.
- *"When they finish clearing conditions it should take it to the next stage"* → **the next stage's
  work is raised automatically; the decision to approve stays human.** Today, finishing condition
  clearing moves nothing at all — the "Cleared conditions" outcome is wired to no status — so this
  is a genuine gap being closed, and closing it stops one step short of the borrower's inbox.

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
| **0** | The definition: one pure module with the nine milestones and their status mapping, plus its tests. Not wired to anything. | Nobody | **None** |
| **1** | The milestone bar on the loan file. Read-only, derived. "You are here · owned by X · N of M to leave this stage." | Everyone, on the file | **Cosmetic** — a wrong label, never a wrong loan |
| **2** | The stage card: what this stage waits on, what the next gate needs, and **who is holding the file right now, since when, and whether it is overdue** (from the timeline endpoint nothing calls today). | Everyone, on the file | Cosmetic |
| **3** | **The Action Center, solid.** Both barriers fixed so the actions really are available to everybody; one definition of the condition percentage; blocked status moves made visible; the outcome list de-duplicated. Still no new automation. | Everyone who submits | Low — existing behaviour preserved, refusals become actionable |
| **4** | **Bi-directional write.** Advance / send back from the bar, delegating to the existing doors. Behind a switch, one door at a time. | Staff who move files | Controlled — same door the dropdown uses; the switch turns it off |
| **5** | **Green-zone automation.** Statuses move by themselves inside Processing as condition work starts and finishes; finishing condition clearing raises the next hand-off. Red zone still always human. Behind its own switch. | Processors, LOs | Controlled — silent by construction, throttled, `system`-stamped, switch-off |
| **6** | Draws joined onto the spine; the story continues past funded through milestones 8 and 9. | Coordinator, LOs | Cosmetic |
| **7** | The milestone column on the pipeline, so it reads across files. | Everyone | Cosmetic |

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

Five questions. The first three settle the words; the last two are business rules I will not
guess.

1. **The nine milestone names** (§3) — are these the words your team actually uses? A name is
   wrong on every screen forever, so it is worth settling now.
2. **Milestone 9's name.** "Sold — Post-Purchase" is the industry-correct pair and matches what
   you asked for. The catch is that `post_purchase_notify` and `post-purchase.js` in our code
   today mean *the people who finish milestone 8*. Either we rename those (my recommendation —
   the screen already says "Told when a loan sells"), or we call milestone 9 **"Sold — Post-Sale"**
   and leave the code alone. Which?
3. **The owners column** (§3) — is that the real ownership in your shop, especially for
   milestones 8 and 9?
4. **Is the purchase advice issued once or twice?** Our code says in three places that it is
   *"re-issued post closing and again post purchase."* If there is a preliminary advice at
   post-closing and a real one at the sale, then `pa issued` belongs in milestone 8 and the
   boundary moves. If there is only one, the plan as written is right.
5. **Condition Clearing — last mile, or the whole phase?** Today it refuses to start until 80% of
   conditions are already cleared, recorded as your own instruction. That is coherent as a
   "send it to the processor to finish the last few" hand-off. If you actually think of it as the
   phase where conditions get worked, the gate is backwards and should be removed. I have changed
   nothing either way.

## 11. Everything else — ranked

Not to be started until the spine lands. The two bugs are first because they are cheap and they
are hurting files today. Note that four items from the earlier list have moved **into** this plan
(the action-center barriers, the condition-percentage definition, the invisible blocked status
move, and the outcome-list drift) and so are no longer listed here.

| # | Item | Why it matters | Size |
|---|---|---|---|
| 1 | **The draw wire form dead-letter** (§6) | A funded loan's wire form fails permanently over an origination rule. Real money, real borrower. | Small |
| 2 | **Closing advances but the status is refused** (§6) | The loan is closed and wired while the file says Clear to Close and the whole draw phase is locked. | Small |
| 3 | **The three naming conflicts** (§3a) — the post-purchase notify list, the overloaded "reconciled", the straddling trailing-doc seed | Each will bite once milestones 8 and 9 carry those names. | Small |
| 4 | **"Post a condition" actually creates the condition** | The button is pressed and creates nothing. Authorised in July, still open. | Small |
| 5 | **The stale and dead references** — a comment contradicting a live gate, a phase dictionary whose keys never match, the 38-vs-39 status drift | Each one misleads whoever reads it next. | Small |
| 6 | **Gate previews on the three scariest gates** (term-sheet send, clear-to-close, condition sign-off) | The biggest single cure for "the gates make everybody nervous". Sits naturally on the stage card. | Medium |
| 7 | **One language for statuses** | Twelve vocabularies, four hand-kept copies of the same eleven words. | Medium |
| 8 | **The gate registry + "no refusal without a door"** | Every refusal names its fix and its one override path. | Medium |
| 9 | **One book of "yes"** — fold the escalation box and admin force into the exception register | Nine ways to approve becomes one place to look. | Medium |
| 10 | **Finish the hand-off chain** — the missing underwriter hand-off, real post-purchase routing, the silent draw-coordinator failure | Two ends of the chain are "somebody watches a queue". | Medium |
| 11 | **Retire the three double tick-boxes** | Only safe once the spine shows the real signal. | Medium |
| 12 | **Condition timing buckets** shown as counts ("3 before docs") | Makes "are we ready?" a number, not a meeting. | Small–Medium |
| 13 | **"My Day"** — one work list per person | Biggest build; easiest last, once the spine and one language are clean. | Large |

Deliberately **not** on this list: anything touching pricing, the ClickUp ladder itself, the
Encompass read-only rule, or the Long-Term product.
