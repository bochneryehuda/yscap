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

| Milestone | Completed wording | Evidence |
|---|---|---|
| Started | File started | `MS.STATUS`, 6 of 8 sampled |
| LO Prep | **Assigned to Processor** | **the owner's own words** |
| Loan Setup | Sent to Processing | `MS.STATUS` ("Sent to processing"), 6 of 8 |
| Submittal | **Submitted** | **the owner's own words** + `MS.STATUS` 6 of 8 |
| Cond. Approval | Conditionally Approved | the owner's seven-stop vocabulary |
| Resubmittal | In Underwriting | db/547 — the tenant's own `tpo_status` for that step |
| Clear To Close | Clear to Close | the owner's seven-stop vocabulary |
| Schedule Closing | Closing Scheduled | db/547 — the tenant's own `tpo_status` for that step |
| Funding | **Funded** | **the owner's own words** + `MS.STATUS` 5 of 5 |
| Completion | Completed | `MS.STATUS`, 8 of 8 |

**Anything not in that table keeps its own name.** That is honest rather than lazy: inventing a
past-tense wording for a step nobody has stated one for would put a word on a loan file that no
person chose. The eight without a proven completed form today:

> Processing · Waiting for Docs · Ready for Docs · Docs Out · Wire Order · Investor Delivery ·
> Purchasing Conditions · Final Docs

**These are the open questions for the owner.** Adding a wording is one line in `COMPLETED_FORM`.

**A note that matters for those eight:** the tenant's own db/547 catalog collapses *every*
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
