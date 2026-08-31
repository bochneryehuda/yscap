# SAVED SCENARIOS — the research, before the build

**Long-Term (DSCR) only.** Owner-directed 2026-08-31, and the owner asked for the
research first, in their own words: *"Full Workflow: To Research How To Enhance It."*

> *"a new Scenario screen sharing the General Pricing Engine's fields, plus
> optional property address / borrower name / entity name / scenario name; a Save
> Scenario button; re-run anytime."*

Nothing has been built from this document yet. It ended with six questions that
were the owner's to answer; **the owner answered all six on 2026-08-31**, and those
answers are recorded in §8. Where a decision differs from what this research
recommended, **the owner's decision governs** and §5 and §7 have been rewritten to
match it.

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
follows was question Q3 — and the owner answered **no** (D3): a saved scenario
stays a scratch pad and does not attach to a loan file or a borrower.

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
saved price, and never a document — but it is a real decision, so it was put to
the owner as Q4, and the answer was **yes** (D4): the snapshot gets stored, dated,
and the re-run says what moved.

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
`saved_board` headline (decided yes — D4), `created_at`, `updated_at`, and a soft
`deleted_at`. **No aging column**: D5 says a scenario stays until its owner deletes
it, so nothing in this table may ever be archived or removed on a timer.

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
`GET /api/lt/dscr/scenarios`, `POST` (save — from either surface), `PATCH /:id`
(rename, re-save), `DELETE /:id` (soft-delete, by hand only). Every one of them is
scoped to `staff_id = the caller` (D2): a scenario is visible only to the person
who saved it, and the scoping belongs in the door, not the screen.

**The screens — two of them, decided (D1).** The owner settled this in their own
words, and it is not the shape this research had recommended:

> *"On the regular pricing engine, you should just have the save button and the
> saving workflow, where you name it and you put the address and the optional
> stuff. It saves into the scenario page... When you run a scenario in the pricing
> engine, you can save it, but it saves in the scenario page. You can also just go
> on the scenario page and over there create scenarios or save it over there as
> well."*

So there are exactly two surfaces, with a clean division of labour:

1. **The pricing engine** gets ONE new thing: a **Save this scenario** button, and
   the small save dialog behind it (name, property address, borrower name, entity
   — all optional, D6). It gains NO list and NO restore. A saved scenario does not
   come back into the pricing engine; it goes to the scenario page.
2. **The scenario page** is where scenarios live. It lists them, re-runs them,
   renames and deletes them — and it can also build one from scratch, with the
   same fields, without going through the pricing engine first.

**The one rule that makes this safe.** This research warned that a second screen
means a second copy of twenty-one fields and that the copy which drifts is the one
that prices the wrong deal. The owner wants both surfaces, so that risk is handled
in the build rather than argued again: **the field set is ONE component, imported
by both screens.** Not copied, not re-typed, not "kept in sync" — one file, two
mounts, exactly as `PriceAdjuster` is one component mounted at two sites and
`SendToBorrower` is one component mounted at three. If a future pricing field is
added to one screen and not the other, the build was done wrong. The same holds
one level down: `toScenario`, `searchProblem` and `deriveAmount` stay single, and
the scenario page calls the same `/api/lt/dscr/price` door the engine calls — the
scenario page must never grow a pricing path of its own.

## 6. What this must NOT do

- **It must never look like a saved price.** D4 puts a dated headline on the row,
  so the labelling is not optional: every stored figure is shown dated and worded
  as *what it was on that day*, never as what it is now. A saved scenario is a set
  of inputs; the price is whatever today's re-run says.
- **It must not become a second pipeline.** A scenario is not a loan file — D3
  settled it as a scratch pad, so nothing here attaches to a borrower record or a
  loan file. If a scenario needs to become a file, that is the existing "create a
  file" path, unchanged.
- **It must not auto-save.** See §4.
- **The investor never reaches a client.** A saved scenario is staff-side and stays
  there; nothing about this touches a borrower surface.
- **It must not re-implement `toScenario`, `searchProblem` or `deriveAmount`.**
  Those are the screen's own rules and there must go on being one of each.

## 7. Staging — as decided

1. **The shared field set becomes one component** before anything else is built.
   The pricing engine keeps working off it, unchanged, and the suites stay green.
   Nothing user-visible happens in this step, and skipping it is what creates the
   two-copies problem D1 otherwise invites.
2. **The table and the four doors**, each scoped to the caller (D2), with the
   soft `deleted_at` and no aging (D5).
3. **The Save this scenario button and its dialog on the pricing engine** — name
   optional and auto-derived when blank (D6). Saving takes you nowhere; it
   confirms, and says the scenario is on the scenario page.
4. **The scenario page**: the list (name, address, when it was saved), re-run,
   rename, delete, and create-from-scratch using the same component from step 1.
5. **"What moved since you saved it"** (D4) — the dated headline on the row and the
   comparison on re-run, reusing the term-sheet replay's shape rather than a second
   one of its own.

Nothing in this list attaches a scenario to a loan file or a borrower; D3 removed
that stage entirely.

## 8. The owner's decisions — answered 2026-08-31

These six were put to the owner as questions because none of them was safely
guessable. All six are now answered, and the answers govern §5 and §7 above.

| | Question | **Decision** |
|---|---|---|
| **D1** | Button on the pricing engine, or its own screen? | **Both** — see below |
| **D2** | Who can see a saved scenario? | **Only the person who saved it** |
| **D3** | Attach to a loan file or borrower? | **No — it stays a scratch pad** |
| **D4** | Say what MOVED since it was saved? | **Yes** |
| **D5** | How long does it live? | **Until you delete it** — never aged out |
| **D6** | Is the name required? | **No** — auto-named from the address or the headline terms when blank |

**D1 overrode this research, and the owner then said exactly what they meant.**
The recommendation here was a button and no second screen, on the grounds that a
second screen means a second copy of twenty-one fields. The owner chose both, and
drew the line themselves: the pricing engine gets the **save** half only (button +
dialog), and the scenario page owns the **list, the re-run and the
create-from-scratch** half. A saved scenario never reloads into the pricing engine.
That division is what makes "both" coherent rather than duplicative — and §5 turns
the remaining risk into a build rule: one shared field component, two mounts.

**D5 is a deliberate no to auto-archiving.** This research raised the usual worry
that an unpruned list stops being useful. The owner accepted that trade: nothing in
PILOT may delete or archive somebody's saved scenario on a timer. If the list ever
does get long, the answer is search and sort, never expiry.

**D2 and D3 together keep this small.** Per-person and unattached means a saved
scenario is nobody's system of record — which is what lets it stay a fast, private
scratch pad instead of turning into a second pipeline.

---

*Research complete; the six open questions are closed. Nothing has been built yet —
the build follows the staging in §7.*
