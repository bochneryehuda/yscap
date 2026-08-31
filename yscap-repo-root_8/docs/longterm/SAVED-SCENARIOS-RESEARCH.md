# SAVED SCENARIOS — the research, before the build

**Long-Term (DSCR) only.** Owner-directed 2026-08-31, and the owner asked for the
research first, in their own words: *"Full Workflow: To Research How To Enhance It."*

> *"a new Scenario screen sharing the General Pricing Engine's fields, plus
> optional property address / borrower name / entity name / scenario name; a Save
> Scenario button; re-run anytime."*

Nothing has been built from this document. It ends with the questions that are
the owner's to answer, because each of them changes what gets built.

---

## 1. What exists today — measured, not remembered

| Thing | What it holds | Whose | Notes |
|---|---|---|---|
| `LtPricer.jsx` `START` | **21 scenario fields** — purpose, value, amount mode, loan, LTV, FICO, DSCR, ZIP, state, county, property type, units, non-warrantable, borrower type, lock days, interest-only, escrow waive, first-time buyer, term, prepay months, prepay structure | in the browser, for the length of one visit | lost on reload |
| `CALC_START` | **7 more** — rent, tax (+ its monthly/yearly basis), insurance (+ basis), HOA, and a typed rate — the boxes that work out the ratio | same | **never sent to the vendor** — deliberately, they exist to produce ONE number |
| `PREPARED_START` | borrower name, vesting entity, property address | same | **exactly three of the four** party fields the owner asked to save; the fourth (a scenario NAME) does not exist anywhere yet |
| `scenarioFields.toScenario(f)` | the ONE definition that turns the form into what the server is asked | — | drops what was not typed, so the server stays the single authority |
| `lt_pricer_investor_groups` (db/634) | named sets of investor keys | **per person** | the only saved thing on this screen today; a DISPLAY overlay, never a search input |
| `lt_term_sheet_cart` (db/649) | the comparison being assembled | **one open cart per officer** | holds PRICED members, not inputs |
| `lt_term_sheet` (db/649) | an ISSUED document | the officer who issued it | immutable; `supersedes` is how a correction is made |

**So: nothing stores the INPUTS.** Re-running yesterday's search means retyping
twenty-one fields, and the three party fields on top of them. That is the whole
gap, and it is worth saying plainly because it makes the feature small: the data
is already assembled in one place by one function.

## 2. The distinction that decides the entire design

**A saved scenario is INPUTS. It is not a price.**

Rates move daily; the board is a live answer from Lender Price. So a scenario
re-run tomorrow is a *different board* — the same question, a new answer. Every
design decision below follows from that one sentence, and the most expensive
mistake available here is to save a scenario in a way that lets somebody believe
they saved a price.

There are three genuinely different products hiding behind the phrase "save this",
and they answer three different questions:

**(a) A saved SEARCH — inputs only, re-run live.**
Answers *"price this deal again"*. Small, honest, never stale, and it cannot
mislead: there is no price in it to go out of date. This is what the owner
described.

**(b) A saved QUOTE — inputs plus the board as it stood.**
Answers *"what did we see on Tuesday?"*. Useful for an argument with a borrower,
and dangerous the moment anybody reads it as an offer. PILOT already has the
honest version of this and it is called a term sheet: it is stamped, it expires,
it says on its face when its pricing dies, and it carries a code.

**(c) A saved scenario ON A FILE — inputs attached to a loan.**
Answers *"what are we doing on 14 Oak Street?"*. A different feature with a
different owner, and the one that overlaps the existing pipeline.

**Recommendation: build (a).** It is what was asked for, it is the one with no way
to mislead, and (b) already exists in the only form that should exist. Whether (c)
follows is question Q2 below.

## 3. The strongest finding: the "what changed" machinery already exists

`POST /api/lt/dscr/term-sheet/:code/replay` already answers, for an issued sheet,
**as issued · as it prices today · the difference** — and stores nothing, because
re-pricing a quote must never look as though it changed the document.

A saved scenario's re-run is *the same question one stage earlier*. So "re-run it"
should not be a bare re-search that quietly shows a new board: it should be able to
say **what moved since you saved it**, using the shape that is already built and
already trusted. That is a much better feature than the ask, for almost no extra
work, and it is the single thing this research would most recommend adding.

It needs one thing the ask does not mention: a scenario would have to record the
*headline of the board at save time* (best rate, best price, how many programs came
back) to have anything to compare against. That is a small, honest snapshot — not a
saved price, and never a document — but it is a real decision, so it is Q4.

## 4. What comparable systems do

Stated at the level of SHAPES, because these are patterns this document can stand
behind; nothing here is a claim about a named vendor's current behaviour, which
would need checking against that vendor rather than remembering.

- Product-and-pricing engines generally keep a **saved search / scenario list per
  user**, keyed to a loan when one exists and floating free when it does not.
- The **name is optional and derived when blank** — an address, or the headline
  terms — because a required name is the field people abandon a save on.
- The re-run is nearly always **live**, with the previous board's headline shown
  beside it. Saving a whole board is rare, and where it exists it is presented as a
  dated snapshot rather than as a quote.
- **Deletion is soft**, because "I saved fifty and want the three that matter" is
  the normal state of one of these lists after a month.

The one pattern worth deliberately NOT copying is the auto-save-every-search list.
It produces a hundred entries nobody named and makes the feature useless within a
week; an explicit **Save** is what makes the list mean something.

## 5. The shape this build would take

Everything below obeys the Long-Term rules: `lt_*` table, `/api/lt/*` door,
`src/longterm/**` only, staff-gated, and the investor never reaches a client.

**The table** — one row per saved scenario:
`lt_pricer_scenario` — id, `staff_id` (whose), `name` (optional), the three party
fields (borrower name, vesting entity, property address — all optional), the
scenario as `jsonb`, the calculator's own boxes as `jsonb` (they are inputs too,
and re-typing the rent is exactly as annoying as re-typing the FICO), a
`saved_board` headline if Q4 says yes, `created_at`, `updated_at`, and a soft
`archived_at`.

**Why the scenario is `jsonb` and not twenty-one columns.** The form is the
vendor's question, and it has changed four times this month; a column per field
turns every new pricing input into a migration and a back-fill. It is written by
ONE function (`toScenario`) and would be read by one, so the shape is governed in
code where it already is.

**Why it stores the FORM as well as the scenario.** `toScenario` deliberately drops
what was not typed — that is what keeps the server the single authority on the
third figure when somebody types an LTV instead of a loan amount. But a saved
scenario has to come *back into the boxes*, and a scenario that has been through
that filter cannot: re-loading it would silently move somebody from LTV mode into
loan mode. So the row stores the form as typed AND the scenario is re-derived by
the same one function on the way out. **This is the single easiest thing to get
wrong in the whole feature.**

**The doors** — four, mirroring `pricer-groups` exactly, because that is the
blessed precedent for "somebody's own arrangement of their own screen":
`GET /api/lt/dscr/scenarios`, `POST` (save), `PATCH /:id` (rename, re-save),
`DELETE /:id` (archive).

**The screen.** Not a new screen. The owner said *"a new Scenario screen sharing
the General Pricing Engine's fields"* — and the pricing engine IS that screen, with
those fields, already carrying the three party boxes. A second screen would be a
second copy of twenty-one fields, and the copy that drifts is the one that prices
the wrong deal. So: a **Save this scenario** button beside Price it, and a
**Saved scenarios** list that fills the form back in. That is the same reading the
owner's own words support ("sharing the General Pricing Engine's fields"), and it
is worth confirming — Q1.

## 6. What this must NOT do

- **It must never look like a saved price.** No rate, no payment and no price on
  the list rows unless Q4 says otherwise, and if it does, every one of them dated
  and labelled as *what it was*, never as what it is.
- **It must not become a second pipeline.** A scenario is not a loan file. If it
  needs to become one, that is the existing "create a file" path, not a new one.
- **It must not auto-save.** See §4.
- **The investor never reaches a client.** A saved scenario is staff-side and stays
  there; nothing about this touches a borrower surface.
- **It must not re-implement `toScenario`, `searchProblem` or `deriveAmount`.**
  Those are the screen's own rules and there must go on being one of each.

## 7. Staging

1. The table, the four doors, save-and-restore, no board snapshot. Small, and it is
   the whole of the owner's stated ask.
2. The list screen: name, address, when it was saved, restore, rename, archive.
3. *(If Q4 is yes)* the headline snapshot and the **what moved since you saved it**
   comparison, reusing the replay's shape.
4. *(If Q2 is yes)* attaching a scenario to a loan file or a borrower.

## 8. The questions that are the owner's, not mine

Each of these changes what gets built, and none of them is safely guessable.

**Q1 — Is this a button on the pricing engine, or a genuinely separate screen?**
This research recommends the button plus a saved list, because a second screen
means a second copy of twenty-one fields. The owner's own words can be read either
way.

**Q2 — Does a saved scenario belong to a person, or to the office?**
`pricer-groups` is per person. But *"the scenario for 14 Oak Street"* is the kind
of thing a colleague covering a file needs. Per person is the safer default and the
easier one to widen later.

**Q3 — Should a scenario attach to a borrower or a loan file when one exists?**
It is the difference between a scratch pad and a record.

**Q4 — On re-running, should PILOT say what MOVED since it was saved?**
Recommended, and it is the one enhancement worth more than the ask. It costs a
small dated headline stored on the row — which needs the owner's agreement,
because it is the one thing in this design that stores anything resembling a price.

**Q5 — How long does a saved scenario live?**
Never deleted, archived by hand, or aged out? A list nobody prunes stops being
useful; a list that deletes things by itself loses the one somebody wanted.

**Q6 — Is the name required?**
Recommended optional, derived from the address or the headline terms when blank —
a required name is the field people abandon a save on.

---

*Research only. Nothing here has been built, and the questions above are open.*
