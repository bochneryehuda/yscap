# The two wordings of a milestone — what a file's status is called (#44)

**The owner's rule, in their words (2026-08-24):**

> *"Every milestone has two different kinds of wording: before it's completed and after it's
> completed. The name of the status in our system should always be the last milestone that is
> completed. For example, when funding is completed, the name of the milestone in our system is
> 'funded'. When LO prep is completed, it's assigned to processor because that's the name of the
> milestone 'LO prep' when it's completed. The same with all the milestones."*

So a loan whose **Funding** step is done and whose **Investor Delivery** step has not happened is
called **Funded** — never "Funding" (which reads as not-yet-funded) and never "Investor Delivery"
(a step nobody has worked). Two separate things had to change to make that true:

1. **WHERE the file stands** — `milestone-ladder.sittingOf` answers the **last step whose
   `doneIndicator` is true**. (Its first cut answered the first NOT-done step, which is what put
   "Investor Delivery" on the reported loan.)
2. **WHAT that step is called** — `stages.completedFormLabel()` turns the step's name into its
   completed wording. The raw Encompass name is always kept beside it for anything that joins on it.

## Encompass's own semantics agree — verified live, not assumed

Measured on 363 Birch Dr (YSCAP258134741) and across the book on 2026-08-24:

| What we asked Encompass | What it answered |
|---|---|
| `GET /loans/{id}/milestones` | Funding `doneIndicator: true`, Investor Delivery `doneIndicator: false` |
| `MS.STATUS` (the tenant's own status field) | **"Funded"** — exactly the owner's example |
| `Log.MS.CurrentMilestone` | **"Funding"** — the last COMPLETED step, not the next one |

So Encompass itself carries the last completed milestone as the loan's current one, and stamps its
own **completed-form wording** into `MS.STATUS`. The rule is the tenant's, not an invention.

**`MS.STATUS` is not used as the label**, deliberately: it is maintained by tenant rules and is
**stale on older loans** (sampled per-milestone across the 724-loan book — e.g. Loan Setup files
answering "File started"). The label is DERIVED from the ladder's done flags and this table, which
is always current; `MS.STATUS` is still mirrored onto the loan for reference.

## The table (`stages.COMPLETED_FORM`) and where each wording comes from

Only three kinds of evidence count, and a fourth was **rejected** in audit round 3 — see the warning
below the table.

| Milestone | Completed wording | Evidence |
|---|---|---|
| Started | File started | CENSUS — the sweep's own note pairs these two names |
| LO Prep | **Assigned to Processor** | **the owner's own words** |
| Submittal | **Submitted** | **the owner's own words** |
| Cond. Approval | Conditionally Approved | the owner's seven-stop vocabulary |
| Resubmittal | In Underwriting | db/547 — the tenant's own `tpo_status` for that step |
| Clear To Close | Clear to Close | the owner's seven-stop vocabulary |
| Schedule Closing | Closing Scheduled | db/547 — the tenant's own `tpo_status` for that step |
| Funding | **Funded** | **the owner's own words** |

> ⚠ **A PER-MILESTONE `MS.STATUS` SAMPLE IS NOT EVIDENCE, and this table used to contain one.**
> Audit round 3 removed `Loan Setup → "Sent to Processing"`. It gave two reasons, and **one of them
> was false** — corrected 2026-08-24 after the owner said so.
>
> **The false half.** The note claimed that string "was never once OBSERVED" on this tenant. Our own
> 490-loan MS.STATUS census recorded it on **27 loans**. The error came from reading a hand-typed
> summary list in `src/longterm/encompass/dropdowns.js` rather than the machine-recorded census
> beside it; that list omitted eleven values the sweep saw and invented two it never did. It is now
> **derived** from the census, so the same mistake cannot be made from it again.
>
> **What the census really says**, which matters more than the wrong claim: MS.STATUS **returns a
> mix of both vocabularies**. On 342 of 490 loans it gives a tenant milestone name; on the other 148
> it gives one of Encompass's seven stock bucket names — Completed 79, Submitted 32,
> "Sent to processing" 27, Started 6, Funded 4. Nothing about a value says which vocabulary it is
> from.
>
> **The removal stands, on the reason that never depended on the false half.** MS.STATUS **lags**,
> so a per-milestone sample of it attributes each wording to the milestone one step off wherever the
> lag is present — which is exactly the question this table answers. And the owner's rule below
> seals it from the other side: "Sent to processing" is a **stock bucket** word, not this tenant's
> own name for Loan Setup.
>
> `Started → "File started"` survives because the sweep's own note pairs the two names in words;
> every other row above rests on the owner's own words or on db/547. `Completion → "Completed"` did
> NOT survive — the word is on 79 loans, but the census counts values without breaking them down by
> milestone, so nothing ties those 79 to Completion. See the owner's rule below.

> **THE OWNER SETTLED THIS ON 2026-08-24, and it removed a row rather than adding one.** Asked what
> the ten uncovered milestones should read, the answer was a rule rather than ten words:
>
> *"Keep the milestones the same way it is in Encompass if a certain milestone doesn't have different
> language, and keep it in the language it is in Encompass. Potentially, if we switch the language in
> Encompass and we rename something, then you should rename your system as well. It should be exactly
> as it is in Encompass."*
>
> So the table is ONLY for a milestone Encompass itself words differently once it completes — which is
> what the owner's own examples always were (*"when LO Prep is completed, it's Assigned to Processor
> because that's the name of the milestone when it's completed"*). Everything else reads as Encompass
> names it, and that is now a settled answer rather than an open question.
>
> **`Completion → "Completed"` was therefore REMOVED.** It was the one row attributed by name
> similarity rather than by anything stated: the string is genuinely observed in the 490-loan sweep,
> so it was never invented, but the sweep records a flat list of DISTINCT values with no
> per-milestone breakdown, so nothing tied it to COMPLETION rather than to another step. Under the
> owner's rule an unproven wording is not a wording. Re-adding it is one line, and the bar is the one
> the owner set — Encompass showing a different word when that milestone completes, not a value seen
> somewhere in the book.
>
> **The rename half needs no code.** Nothing here stores a copy of an Encompass name: the label falls
> back to the name on the loan's own ladder row, re-read from Encompass every sync, and the lookup is
> keyed punctuation-blind on that name — so a rename in Encompass reaches every screen on the next
> pass, and a renamed milestone correctly stops matching a wording chosen for its old name.

**Anything not in that table keeps its own name.** That is honest rather than lazy: inventing a
past-tense wording for a step nobody has stated one for would put a word on a loan file that no
person chose. db/547 seeds **19** milestones and the table covers **8**, so **eleven** read as
Encompass names them:

> **Loan Setup** · Processing · Waiting for Docs · Ready for Docs · Docs Out · Wire Order ·
> Investor Delivery · Purchasing Conditions · Final Docs · **Closed** · **Completion**

**These are ANSWERED, not open** (owner-directed 2026-08-24, above): each reads as Encompass names
it, and follows a rename in Encompass automatically. Adding a wording is still one line in
`COMPLETED_FORM` if Encompass turns out to word one of them differently on completion.

**THE ONE CONSEQUENCE STILL WORTH RAISING, about three of the eleven.** Keeping the Encompass name is
exactly what the owner asked for, and on three steps it reads as the ACTIVE form on the seven-stop
bar's `Status:` line — a file that has FINISHED waiting for documents reads "Waiting for Docs", one
whose documents are back reads "Docs Out", and one whose wire is ordered reads "Wire Order". That is
not a defect under the rule; it is what the rule produces when Encompass has only one word for the
step. The question to put to the owner is narrow: does Encompass ITSELF show a different word once
those three complete? If it does, this table gains three lines. If it does not, the wording stays
inverted by their own instruction — which is a choice they are entitled to make, not a bug to fix
behind their back.

**A note that matters for the post-closing ones:** the tenant's own db/547 catalog collapses *every*
post-Funding step (Investor Delivery, Purchasing Conditions, Final Docs, Closed, Completion) to the
single outward wording **"Funded"** for both TPOs and borrowers. So the tenant already treats
everything after funding as "Funded" to the outside world. Whether our *internal* status should do
the same, or keep naming the individual post-closing step, is the owner's call — it is not something
to infer from the catalog.

## Moving the existing book — `milestone-ladder.realignStanding`

Every already-laddered loan was holding the old first-not-done milestone. The obvious fix (let the
next ordinary sync notice) would have been **wrong**: `ladderOne` records a change through
`writeMilestone`, so the whole book would have gained a spurious **backward** "moved Investor
Delivery → Funding" event — a move that never happened, on every loan, polluting every file's
history.

So the realign:

- recomputes the last-done step **from the `lt_loan_milestones` mirror alone** — no Encompass call;
- writes `milestone_name` + `stage_key` **directly**, so **no history event is written at all**;
- **leaves `milestone_since` alone** — the moment a loan "entered Investor Delivery" under the old
  reading *is* the moment it "became Funded" under the new one, so the clock stays truthful;
- is `IS DISTINCT FROM`-guarded and therefore self-draining, and runs every worker tick, which also
  self-heals any future drift between the mirror and the loan row;
- never throws, and a per-loan failure costs that one loan.

Afterwards `ladderOne` finds prior == next and writes nothing, so the next ordinary sync is silent.

Pinned by `scripts/test-lt-milestone-ladder.js` section I, including the assertion that the event
count does not move. Two mutations were proven to fail it (one that emitted an event per realigned
loan; one that routed the write through `writeMilestone`).

## Where the label is shown, and where the raw name still lives

Shown as the **completed form**: the pipeline's Milestone column (`milestone_label`, decorated onto
every row by `pipeline.loadPipeline`), the archive, the file's summary rail, the seven-stop bar's
`Status:` line, and every **done** row on the Milestones board.

Kept as the **raw Encompass name**: `lt_loans.milestone_name` itself, the board row's `name`, and
every join key — so nothing that matches on a milestone name is affected by the wording.

## One related fix that rode along (audit round 2, obs 4)

Milestone names are joined across three sources (the ladder, the db/547 catalog, the event log) that
differ only in punctuation — "Cond Approval" vs "Cond. Approval". The old key kept punctuation, so
those silently missed each other: the board read `inLadder: false`, the seven-stop bar showed the
step unreached, the stepper called the whole loan "unrecognised" and drew no progress, and witnessed
dates were dropped. `stages.milestoneKey()` (letters and digits only) is now used on **both sides of
every one of those joins** — `sevenStops`, `milestoneBoard` and `milestoneStepper`.

## The status pushed to ClickUp is NOT affected

`clickup/status-engine.desiredStatus` keys on the **ladder's own done flags**, never on
`lt_loans.milestone_name` — so the ClickUp status rules (#39) are untouched by this change, and were
re-verified as such. The wording change is about what a **person reads in PILOT**.
