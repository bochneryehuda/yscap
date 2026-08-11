# DRAFT — Research proposal (owner review before build)

**The bulk property workbench — blueprint Phase 9 (§9.5), owner-directed 2026-08-09.**
Research + design only. No code was changed to write this; nothing here is built yet.

---

## In plain words (owner summary)

You asked for a screen where staff can *"search and see ALL the properties that come in from
Elementix … select which properties they want to import and then review the information for each
and every property for accuracy"* — and to *"do a lot of research on how to make this massive,
better than ever."*

Here is the honest starting point: **a first version of this screen already exists and works.**
For one borrower, staff can search the public records, see every property that came back in a list,
tick the ones that are theirs, and then walk the ticked ones one at a time to check each one before
it lands. That screen is `StaffPropertyWorkbench.jsx`.

So this proposal is not "build it from scratch." It is **"make the one we have massive."** The six
things it is missing, all of which you named in the blueprint:

1. The list is thin — forty look-alike rows are hard to tell apart at a glance.
2. If a reviewer closes the tab halfway through a batch, they lose their place.
3. "These forty are all under one company" still has to be answered on every single one.
4. There is no way to undo a batch someone rushed through.
5. The rich "read this one property" panel could show more of what the records actually say.
6. The whole thing lives inside one borrower's file — there is no shared "what came in today" landing.

**The one shape we must never build, and you said so yourself:** a "select all → import" button that
skips the reading. Ticking is the cheap step. *Reading each property is the step that carries the
risk*, and it stays per-property. Everything below is designed around keeping that true while making
the surrounding work fast.

---

## 1. What already exists — the base this builds ON (cite)

Everything in this section is live today. The proposal extends it; it does not replace it.

**The screen** — `app-v2/src/screens/StaffPropertyWorkbench.jsx`, mounted per borrower in three
places: the loan file (`StaffApplication.jsx:2733`), the borrower profile
(`StaffBorrowerDetail.jsx:557`), and its own full-screen route `/internal/track-record?borrower=<id>`
(`App.jsx:208`).

- **Search** — a deliberate button with a confirm dialog (`StaffPropertyWorkbench.jsx:137`), because a
  search spends the office's shared hourly lookup allowance.
- **The candidate list** — one row per staged property (`:405`), each showing address, dates, entity,
  and a word-band chip (`BAND`, `:71` — `Already on the record` / `Not sure` / `New`; never a number).
- **Ticking + tick-all-shown** (`toggle` `:157`, `tickAllShown` `:160`).
- **`startRun`** (`:169`) — the tick imports **nothing**; it claims the ticked ids
  (`api.staffClaimCandidates`) and builds a client-side review run.
- **`declineTicked`** (`:190`) — bulk decline, allowed because it can only ever *withhold* credit;
  requires a reason (the next search reads it).
- **The one-at-a-time compare/decide walk** (`:284`–`:381`) — the review pane: address, dates, prices,
  entity, the side-by-side compare table for a match, and four decision buttons (Join to existing /
  Bring on as new / Not theirs / Decide later).
- **The budget meter** (`:255`) — lookups this hour (shared) + paid contact credits this month, read
  only; `api.staffElementixUsage()`.

**The server** — `src/lib/track-record/importer.js`:
- `runSearch` (`:390`) reads only; stages what comes back into `track_record_candidates`; records
  every skip with a reason in `track_record_searches`.
- `candidatesFrom` (`:190`) turns vendor deed/mortgage rows into candidates; a property is a candidate
  only when a deed conveyed it **to** one of the borrower's entities (the York-PA false-positive guard,
  §2.2); the dedupe key has two families — `doc:<sorted ids>` when the vendor gave document ids
  (`:264`), `addr:<key>|<buy>|<sell>` otherwise (`dedupeKeyFor`, `:175`).
- `stageOne` (`:555`) — durable-decline check, now **by place as well as by key** (`:579`–`:601`), so a
  once-declined house cannot return under a sibling key; computes `match_confidence`
  (`exact`/`near`/`none`) via `MATCH.decideMatch`, failing closed to `near` when the DB is unreachable.
- `loadQueue` (`:685`) — buckets: `toReview` (staged + expired-snooze), `alreadyHere` (imported/merged),
  `declined`; each row carries a `claim` state.
- `decideCandidate` / `decideLocked` (`:785`/`:805`) — the four verbs under a `FOR UPDATE` lock so two
  reviewers cannot double-decide one property.
- `importNew` (`:877`) — creates a `track_records` row (`origin='public_records'`,
  `entered_by_kind='staff'`), runs the entity chokepoint (`promoteEntityName`), and the row lands
  `pending` because **db/485's guard forces it** — never because this module remembered.
- `matchExisting` (`:992`) — fills blanks only, never overwrites; refuses to silently reopen a verified
  line (`would_reopen_verification`, `:1018`) until asked twice.
- `compareCandidate` (`:1061`) — the field-by-field diff (this is the piece the accuracy review is
  built on; see Q2).

**The claim layer** — `src/lib/track-record/claims.js`: `claimForReview` (`:97`) is one atomic
statement (`RETURNING`, never read-then-write); `claimStateOf` (`:174`) with a **30-minute** stale
window (`STALE_MINUTES`, `:74`). A claim is **advisory** — it never blocks a decision (module header).

**The vendor client** — `src/elementix/client.js`: read-only; free calls draw on the shared **hourly**
bucket (self-capped `maxPerHour`, default 400; platform ceiling 1,000/hour, `:71`/`:90`); the one
**paid** tool `submit_contact_enrichment` is refused unless a `paidActor` (staff id + person + reason)
is supplied (`:278`), and is capped at the **monthly** `paidPerMonth` (default 1,000, `:301`) — the
"1,000/month ceiling" §9.5 names. `usage()` (`:473`) feeds the meter.

**The schema** — `db/496` (`track_record_candidates` + `track_record_searches`), `db/485`/`db/493`
(the verify guard — nothing lands verified; a material edit un-verifies), `db/504` (a borrower can
answer a candidate; recorded as `decided_by_kind='borrower'`), `db/505` (the hold's exit —
`rent_date`/`refi_date`, read off the county mortgage record).

---

## 2. NON-NEGOTIABLES (stated first, per the blueprint's own §9.5)

These are the rules the build must preserve. They are stated up front because every design choice
below is constrained by them, and because "make bulk work comfortable" is exactly the pressure that
erodes them.

1. **Nothing auto-imports.** The staging table stays the only landing place for a search. Bulk means a
   person decides about many properties in one sitting — never that a machine decides for them.
2. **Every promotion lands `pending`** (db/485's `track_record_verify_guard`). An import counts toward
   nothing until a human clicks Verify. Two independent gates: a person chose to add it; a person must
   still verify it.
3. **The per-property read is mandatory.** Ticking is bulk; reading is per line. A "select all →
   import" that skips the read is the one shape this must never become. The tick builds a *review run*,
   not an import.
4. **No skip trace, no bulk paid trace, ever.** The workbench never calls `submit_contact_enrichment`.
   Contact enrichment is OUT of this feature entirely — not "gated," not "one click away," absent.
5. **The paid 1,000/month ceiling is untouched by rendering.** A screen that shows forty properties
   fires **zero** paid lookups because it rendered (see Q6). The paid monthly cap is only ever spent by
   a deliberate per-person action elsewhere in the app, never here.

A short banner at the top of the screen should state #2 and #3 in the reviewer's own words, so the
rule is visible on the surface and not only in the code — the same way the search button already
states what it will spend.

---

## 3. The eight design answers

### Q1 — Telling forty look-alike rows apart at a glance

**The problem:** a reviewer facing forty rows named "…LLC bought a house" needs to sort the real ones
from the noise without opening each. The current row (`:405`) shows address, one date line, entity, and
a band chip — enough for six rows, thin for forty.

**Design: a denser, sortable, groupable table.** Each row carries these signals, every one already
present in the candidate record or one cheap free lookup away — none of them a paid call:

| Signal | Source | Why it separates rows |
|---|---|---|
| **Address** (street, city, state) | `property_address` | The anchor. Bold, primary. |
| **Entity** it was found under | `entity_name` / `proposed_llc_id` | Groups the forty into a handful of companies (Q4). |
| **Bought → Sold** dates + **prices** | `purchase_*` / `sale_*` | The prices are on the candidate today but the *list* row hides them; showing them is what separates a $410k→$612k flip from a $1 quitclaim between related parties. |
| **Refi / rent** exit | `refi_date` / `rent_date` (db/505) | For holds — the row that currently reads "no exit" vs the one with a real refinance. |
| **Deal shape** | derived: bought+sold ⇒ "looks like a flip"; bought only ⇒ "still owned / unknown" | `dealTypeFromRecords` (`importer.js:119`) already computes this; surface it as a muted hint, never a claim. |
| **Match band** | `match_confidence` | `Already on the record` / `Not sure` / `New` — present today (`BAND`), keep it. |
| **How it matched** (dedupe basis) | `dedupe_key` family | "Matched by county deed id" (`doc:`) reads as stronger identity than "matched by address + dates" (`addr:`). A one-word chip. |
| **Deed / record count** | `raw.deeds.length` (`deedCount`, `loadQueue:727`) | "3 documents" vs "1" tells a reviewer how much the records actually carry. |
| **County + coverage** | property county + `get_coverage` (`lookups.js:378`) | **The blueprint's own ask.** A "New" in a well-covered county means something different from a "New" in a county Elementix barely covers. Show a small coverage dot (good / thin / none) so "found nothing like this" is read correctly. See the note below. |
| **Borrower said "not mine"** | `decided_by_kind='borrower'` (db/504) | Only in the declined section, flagged amber — a borrower's rushed "no" is the one answer that quietly *removes* experience and must be re-checkable (`loadQueue:724`). |
| **Who's on it** | `claim` (`claimStateOf`) | "R. Stein is reviewing this" — advisory, names them, never disables (`:432`). |

**Controls:** sort by any column; **group by entity** (default — see Q4); filter box (present, `:388`);
and quick filters mirroring `BAND` — "New only" / "Not sure only" / "Already here." The table is the
one screen; the review panel (Q2) opens over it.

*Coverage note:* `get_coverage` exists as a tool and `researchProperty` reserves a `coverage` slot
(`lookups.js:498`) but does not populate it per-property today. Wiring one coverage lookup **per county
per search** (not per property — counties repeat) into the search pass, cached in
`elementix_lookup_cache` (blueprint §3.5), is a small addition and the honest way to answer "is this a
thin-coverage county?" without forty extra calls. If the owner would rather ship without it first, the
column degrades to "coverage unknown" and nothing breaks.

**Industry echo:** Regrid's coverage explorer is exactly this idea — click a county, see parcel counts
and field-by-field completeness and refresh dates — so a user never mistakes "no data" for "nothing
there." We adopt the *signal*, per row, at a glance.

---

### Q2 — The per-property accuracy review: what it shows, and in what order

**This is the heart of the feature and the part the owner protected explicitly.** Ticking opens a
review run; the run is walked one property at a time (`current`/`runAt`, `:119`). For each property,
in this order:

1. **What is this property?** — address, `Bought <date> for <price> → Sold <date> for <price>`, the
   hold exit (`refi`/`rent`), and `Under <entity>`. (Present, `:305`–`:315`; add the prices to the
   headline and the refi/rent line.)
2. **Where did this come from?** — the county, the recording documents behind it (`raw.deeds` /
   `raw.mortgages`), each with an "open in the record" link. This is the reviewer's *proof*, and it is
   the difference between "the screen says $410k" and "here is the deed that says $410k." (New; the data
   is already in `raw`.)
3. **Is it already on the record?** — for a `match`, the **side-by-side compare table**, which is
   `compareCandidate` (`importer.js:1061`) rendered as it is today (`:320`–`:344`):
   - only **conflicting** fields are a decision (both sides hold a value and they disagree) — amber;
   - a **one-sided fill** is informational ("blank here, so this fills in");
   - a same-place address spelled two ways is **not** a conflict (`samePlace`, `:1086`);
   - blanks render as an explicit "blank," so "we hold nothing" and "they hold nothing" never look the
     same;
   - the panel states, per row, the policy: *the public record fills a blank; anything a human typed
     wins* (`willFill`, `:1096`);
   - and it flags `wouldReopen` (`:1112`) when a fill would un-verify a verified line, so the reviewer
     is never surprised.
   This is the component the blueprint §9.3 asks to lift out of `CompareMerge`
   (`StaffBorrowerDetail.jsx`) into a shared, reusable panel. **Reuse it — do not write a second diff.**
4. **The decision, per property** — the four verbs, unchanged: Join to the line we have / Bring it on
   as a new one (asks the deal type — required, or the line counts toward nothing, `importNew:878`) /
   Not theirs (asks why) / Decide later. Each is one property, one click, then advance.

**What must NOT appear in this panel: a "do all remaining" button.** The walk is the read. The panel
may show *"3 of 8"* progress (Q3) and a "Decide later" that skips without deciding, but there is no path
that promotes an unread property.

**Deal-type contradiction is surfaced, not silenced** — if the records read a bought-and-sold pair as
a flip and the reviewer says "ground-up," the answer stands but the line carries a note for the
verifier (`contradicted`, `importer.js:916`). Keep that; it is the accuracy check working.

**Industry echo:** Jira's bulk-change wizard (select → choose → *resolve conflicts* → review → apply)
is the closest analogue — but ours is deliberately more conservative: per *item*, not per *field batch*,
because the risk here is a wrong deal on someone's borrowing record, not a mis-set ticket field.

---

### Q3 — Surviving a closed tab (the resumable batch)

**The gap:** the claim persists (`claims.js`, `claimed_by`/`claimed_at`), but the **run itself** —
which ids are in this batch, and where the reviewer is in it — is client-only state
(`run`/`runAt`, `StaffPropertyWorkbench.jsx:85`–`86`). Close the tab mid-batch and the place is lost;
worse, the 30-minute claim can expire over a lunch break and quietly release the properties.

**Design — extend the claim/review-run into a durable batch.** Two viable shapes; the recommendation
is the first, with the second as the fuller option:

**Option A (recommended, lighter): reconstruct the run from claims, and lengthen the claim.**
- The run is *"my claimed candidates that are still `staged`, in a stable order."* As each is decided it
  leaves `staged` on its own, so **the remaining set IS the remaining run** — no separate position
  counter to keep in sync. This is exactly the eDiscovery rule ("a document is considered reviewed once
  its Reviewed field has a value") applied to `status`.
- On load, if the reviewer has fresh claims still `staged`, show **"Resume your batch — N left"** and
  reopen the run from them.
- Add a small `track_record_review_batches` row *only* to hold the **ordering and a batch label**
  (`id`, `borrower_id`, `staff_id`, `candidate_ids jsonb`, `created_at`, `note`) so "resume batch #3"
  is meaningful and the order is stable; the *progress* is still derived from candidate status, not
  stored, so it can never drift.
- Lengthen the claim horizon for an *active* batch (e.g. refresh `claimed_at` as the reviewer decides
  each property, and treat a batch as live for a few hours, not 30 minutes) so a break does not drop
  the batch. The claim stays **advisory** — a released claim still never blocks a decision
  (`claims.js` header). The worst case remains "one line of stale text."

**Option B (fuller): a first-class batch/session table** that stores the ordered ids *and* an explicit
position and status (`open`/`done`/`abandoned`), assignable to a reviewer. This is what an eDiscovery
platform does — a review manager creates batches, assigns them, watches progress. It is more code and
more UI, and it is the right shape *if* the owner wants a supervisor view of "who is working which
batch" (Q9). It is not needed for the basic "don't lose my place" requirement, which Option A covers.

Either way, the promise to the reviewer is the one the industry converged on: **the system makes it
obvious what's selected, clear what will happen, and gives a way back** — here, "you have a batch in
progress, N left, pick up where you were."

---

### Q4 — Answering "these forty are all under one company" once

**§2.2's whole point:** ownership is two checks. **Check A** — does the borrower control the LLC — is
proved **once per entity** (the operating agreement; `llcs.is_verified` + `llc_borrowers.ownership_verified`).
**Check B** — did that LLC own *this* property — is a small per-property deed lookup. *"A borrower with
ten properties across two LLCs does two Check A's and ten small Check B's, not ten investigations."*

**The engine already honours this**, and the workbench should make it visible:
- `stageOne` resolves `proposed_llc_id` at **stage** time, so every candidate already knows which of
  the borrower's companies it belongs to before anyone opens it.
- `candidatesFrom` only stages a property whose deed grantee **is** one of the borrower's entities
  (`isOurs`, `importer.js:192`) — that *is* Check B, applied before the row ever reaches the queue.
- `importNew` runs the entity chokepoint once (`promoteEntityName`, `:922`) — the first import under a
  company creates it on the profile; the rest link to the same `llc_id`.

**Design — group the list by entity, and put Check A at the group header, once.** In the grouped table
(Q1 default), each company is a collapsible group:

```
▸ MW TRADING LLC (NJ)  ·  Check A: ✓ verified (operating agreement on file)   ·  14 properties
▸ WEIL HOLDINGS LLC (NJ)  ·  Check A: ⚠ not verified — one upload needed        ·  6 properties
▸ (personal name — Moses Weil)  ·  no entity                                    ·  3 properties
```

- The header shows the entity's **Check A status once** (verified / needs the operating agreement /
  registry-corroborated), links to the entity's LLC section to resolve it, and — the owner's 2026-08-09
  ruling — *"once it's owned by that LLC, we just bring in that verified LLC section into the track
  record as verified."* So when Check A is already ✓, the header says so and the per-property review
  for that group only has to confirm Check B (which the deed already proves).
- The per-property panel then **does not re-ask about the company** — it shows "Under MW TRADING LLC —
  control verified" as a settled fact and moves straight to the property's own facts (Q2).
- A **"verify this company once"** action on the header (open the operating-agreement upload / mark
  Check A) that, once done, flips every property under it from "needs A" to "A ✓, confirm B."

This is the difference between forty investigations and two: the entity question is answered at the
group, the property question at the line. Nothing new is needed in the importer — it already links the
entity; the work is UI grouping plus surfacing the entity's Check-A state on the header.

---

### Q5 — The rows nobody ticks, and undoing a batch worked too fast

**Rows nobody ticks:** they stay `staged` and simply wait. Nothing is lost — a staged row is durable,
invisible to every count (it is in a different table, not behind a flag, `db/496` header), and a
re-search **cannot** duplicate it (the partial unique index `uq_trc_staged`) nor re-raise a declined
one (`stageOne`'s durable-decline check). So "the ones nobody ticks" need no special handling beyond
being obviously still there: the list header should read *"N waiting"* and the leftovers persist across
sessions. A **"snooze"** verb already exists (`decideLocked:819`) for "not now, ask me later"; surface
it as a per-row and bulk action so a reviewer can clear low-priority rows out of view without declining
them.

**Undo a batch worked through too fast — two tiers, by how safe the reversal is:**

**Tier 1 — bulk un-decline (safe, easy).** A decline only ever *withholds* credit, so reversing it
adds nothing risky. Add a **"put back in the queue"** action on the declined section (`:464`) — single
and bulk — that moves `declined → staged`, attributed and audited. This directly answers "a reviewer
undoes a batch they worked through too fast": the most common rushed mistake is a wrong "not theirs,"
and this makes it a two-click fix.

**Tier 2 — undo an import (careful, bounded).** This is the sharp one, because an import created a real
`track_records` line. Mirror the borrower undo that already exists — `borrower-confirm.undoAnswer` /
`undoLocked` (`:260`/`:282`), route `borrower.js:2865`:
- Undo is allowed **only** on a line that is still **pristine**: `pending` / not verified, no documents
  attached, no manual edits, notes matching the import's own text verbatim (the exact pristine test the
  borrower undo uses, `:240`). *"The moment anybody has touched the line it is theirs"* — then undo is
  refused with that reason, never forced.
- The undo runs under `FOR UPDATE` (two concurrent undos must not each tell a different story), deletes
  the pristine line, and re-stages the candidate to `staged` so it returns to the queue.
- Attributed to the staffer and audited. A **staffer may undo a staffer's or a borrower's** pristine
  import; a borrower may not undo a staffer's (the existing asymmetry, `:289`).
- A **merged** decision is the awkward case: `matchExisting` COALESCE-fills blanks, so a clean
  automatic un-fill is not always possible. Recommendation: reverting a merge re-stages the candidate
  and leaves the (now-filled) line for a human to eyeball, rather than guessing what was blank before —
  or, if the owner wants true reversal, store a pre-fill snapshot of the filled columns at merge time
  (small addition). Flag this as an open question (Q9).

**Bulk-undo the last batch:** because a batch is a known set of candidate ids (Q3), "undo my last batch"
is "run the Tier-1/Tier-2 undo across the batch's ids, skipping any line that is no longer pristine,
and report exactly what was and wasn't reverted" — never a silent partial (the screen already refuses
silent partials, `:207`).

---

### Q6 — The paid-call discipline: forty rows must not fire forty lookups

**The rule, made structural:** *rendering the workbench spends nothing.* Here is exactly what is free
and what is paid, and where the line is enforced.

**Free (and already paid for):**
- **Rendering the list and every row.** The rows are read from `track_record_candidates` — the search
  already happened and already staged them. Opening the screen, sorting, filtering, grouping, paging:
  **zero Elementix calls.**
- **The per-property compare.** `compareCandidate` (`:1061`) is a database read of two rows we already
  hold. Zero calls.
- **A search** — this is the only thing on the screen that touches the vendor. It is a **free** call
  family (`get_entity_deeds`, `get_person_deeds`, etc.), it draws on the shared **hourly** bucket, and
  it is a deliberate button with a confirm (`:137`). It stages results; it never enriches contacts.

**Paid (and OUT of this feature entirely):**
- `submit_contact_enrichment` — the only paid tool (`client.js:PAID_TOOLS`, `:41`). The workbench
  **never calls it.** It is refused at the client unless a `paidActor` (staff id + person + reason) is
  passed (`:278`) — which the workbench never passes — and it is capped at `paidPerMonth` (1,000/month,
  `:301`), failing **closed** if the count can't be read. There is no skip trace, no "get the owner's
  phone," no "trace this list."

**Why forty rows can't become forty calls, structurally, not by discipline:**
- The screen renders from staged rows, so there is no per-row lookup at render.
- The one call-making button (search) makes a *bounded* set of calls per *entity* (about six to nine,
  `lookups.js:476`), not per property, and reports truncation rather than paging on
  (see the paging note below).
- The paid tool cannot be reached from here at all.

**The budget meter guards it and makes it visible** (`:255`, `usage()` `client.js:473`): *lookups this
hour of the hourly cap* (shared by the whole office) and *paid credits this month of 1,000* — read
only; the caps that actually refuse a call live server-side (`overBudgetShared`, `client.js:90`). The
meter should stay on the screen so a reviewer sees the shared budget before pressing search.

**One honest limitation to record: result paging is REPORTED, not FOLLOWED.** `researchProperty` asks
for `perPage: 100` (the vendor's ceiling) and, if the vendor says there is a next page, pushes a
`truncated` note into the search skips (`lookups.js:527`/`:561`) rather than fetching page 2. So a
single entity with **more than 100** recorded documents comes back capped, with a visible "there is
more than shown" skip — never silently short (`db/496` header's promise). Forty properties is well
inside 100, so this does not bite the owner's example; but for a very large portfolio it means "search
again / narrow by state" rather than an automatic deep page. Whether to follow paging automatically is
a cost trade-off (more free calls per search) and is an open question (Q9), not a bug.

**Industry contrast worth stating plainly:** every skip-trace platform (PropStream, REsimpli, Batch)
puts skip tracing *inside* the list-building flow — tick rows, hit "skip trace," spend per record. We
are deliberately doing the opposite: the list-building and review is the whole feature, and the paid
step does not exist here. The industry's own best practice — *"clean and dedupe before you spend,
chase cost-per-reachable-contact not price-per-record"* — is one we satisfy by never spending: staging
and dedupe (the free steps) are the entire workbench.

---

### Q7 — UI shape, and reusable vs new

**One screen.** The workbench is a single surface with three states, all present in skeleton today:

1. **The list** — the dense, sortable, entity-grouped table (Q1), multi-select, filter, budget meter,
   and a declined/snoozed drawer.
2. **Batch actions** (bulk-select bar): *Review N one at a time* (builds the run, Q3), *Mark ticked as
   not theirs* (bulk decline, present `:452`), *Snooze ticked*, and *Put back in queue* on the declined
   drawer (Tier-1 undo, Q5).
3. **The per-property review panel** (Q2) — opens over the list, reuses the shared `CompareMerge`/
   compare component, walks the batch, resumable (Q3), with per-property decide.

**Selection semantics, per the bulk-selection pattern:** distinguish *"tick all shown"* (the filtered
page, present `:160`) from *"tick all N matching"* — the PatternFly split-button convention — so a
reviewer who filtered to "New only, MW Trading LLC" can tick that whole set without hand-ticking, and
the count is always honest about what is selected.

**Where it lives:** keep the three existing mounts (loan file, borrower profile, full-screen
`/internal/track-record?borrower=<id>`). The full-screen route is the natural home for the "massive"
version. A cross-borrower landing is Q9.

**Reusable (most of it):**
- The entire server verb layer — `runSearch`, `stageOne`, `loadQueue`, `decideCandidate`,
  `importNew`, `matchExisting`, `compareCandidate` — unchanged in behaviour.
- The claim layer (`claims.js`) — extended (longer horizon, batch reconstruction), not rewritten.
- The compare table (`compareCandidate` + the inline renderer, blueprint §9.3 says lift `CompareMerge`).
- The budget meter, the search button + confirm, the four-verb decide flow, the durable-decline and
  verify-guard guarantees.
- `dealTypeFromRecords`, `BAND`, `claimStateOf`.

**New (mostly UI + one small table):**
- UI: the denser grouped/sortable table; entity group headers with Check-A state; the coverage signal;
  richer review panel (documents/provenance, prices in headline); resume-batch affordance; snooze and
  put-back actions; select-all-matching.
- Schema: a light `track_record_review_batches` table (Option A) for batch order/label; optional
  `elementix_lookup_cache` coverage rows per county (blueprint §3.5, already planned); optional pre-fill
  snapshot column if true merge-undo is wanted.
- Server: a **revert** endpoint pair — bulk un-decline (`declined → staged`) and pristine import-undo
  (mirror `undoAnswer`); a coverage-per-county pass folded into `runSearch`; batch load/resume reads.
  All read-only against Elementix; no new paid path.

**Effort / risk estimate:**

| Piece | Effort | Risk |
|---|---|---|
| Denser sortable/grouped list + select-all-matching | **M** | Low — pure UI over data we hold. |
| Entity group headers + Check-A once | **M** | Low–Med — reads `llcs.is_verified`; no new import logic. |
| Richer review panel (provenance, prices) | **S–M** | Low — data is in `raw`. |
| Resumable batch (Option A) | **M** | Med — the claim-horizon change and "resume" logic need care that a stale claim still never blocks a decision. |
| County coverage signal | **S** | Low — one cached lookup per county per search; degrades to "unknown." |
| Tier-1 bulk un-decline | **S** | Low — status flip, audited. |
| Tier-2 pristine import-undo | **M** | **Med–High** — deletes a real line; must reuse the exact pristine test and `FOR UPDATE` discipline; merge-undo is the sharp edge. |
| Batch table (Option B, if supervisor view wanted) | **L** | Med — more surface, assignment/QC semantics. |

Overall: **a medium-sized enhancement on a solid base**, not a rebuild. The genuinely risky square is
Tier-2 undo (it destroys data), and it is de-risked by copying the borrower undo's pristine-only,
locked, attributed shape verbatim rather than inventing a new one.

### Q8 — Non-negotiables

Stated in full in §2 above and repeated here as the checklist the build is measured against: nothing
auto-imports; every promotion lands `pending` (db/485); the per-property read is mandatory (no
select-all→import); no skip trace / no bulk paid trace (the paid tool is absent from this feature); the
1,000/month paid ceiling is never touched by the workbench.

---

## 4. Industry research (UX only — not to enable skip trace)

The blueprint asked for research on bulk data-review / triage UX in real-estate data platforms. What
transfers, and what we deliberately reject:

- **PropStream** — checkbox-select each record or a master "Records" checkbox to select the page, then
  an **Action** dropdown for the bulk operation (e.g. "Add to Favorites"); 120+ filters build the list.
  We adopt the multi-select + bulk-action bar and the filter-then-select flow. We **reject** its core
  workflow advantage — skip tracing folded into the same list — because contact enrichment is out.
  ([resimpli.com/blog/propstream-review](https://resimpli.com/blog/propstream-review/),
  [propstream.com/news/the-beginners-guide-for-propstream](https://www.propstream.com/news/the-beginners-guide-for-propstream))
- **Regrid coverage explorer** — click a county to see parcel counts, **field-by-field completeness**,
  and refresh dates, so "no data" is never mistaken for "nothing there." This is the model for our
  per-row **county-coverage signal** (Q1/Q6).
  ([regrid.com](https://regrid.com/), [demos.regrid.com/coverage](https://demos.regrid.com/coverage/))
- **ATTOM** — nationwide transaction/mortgage coverage across ~2,690 counties framed around
  currentness/coverage/completeness; the same "coverage is a first-class quality signal" framing.
  ([attomdata.com/data/property-data](https://www.attomdata.com/data/property-data/))
- **PatternFly bulk-selection pattern** — a split button offering **Select none / Select page / Select
  all (across pages)**, and per-item review markers that coexist with bulk select. This is exactly the
  "tick all shown vs tick all N matching" distinction (Q7).
  ([patternfly.org/patterns/bulk-selection](https://www.patternfly.org/patterns/bulk-selection/))
- **Bulk-action UX guidance (Eleken / Hforge)** — high-stakes bulk actions rest on three promises:
  make it **obvious what's selected**, **clear what will happen**, and **give a way back**. These map
  one-to-one to Q1 (selection clarity), Q2 (what import does), and Q5 (revert).
  ([eleken.co/blog-posts/bulk-actions-ux](https://www.eleken.co/blog-posts/bulk-actions-ux),
  [hforge.org/batch-operations-in-ux](https://www.hforge.org/batch-operations-in-ux-why-doing-things-in-bulk-quietly-saves-hours/))
- **Jira bulk-change wizard** — select → choose → **resolve conflicts** → review → apply: a staged,
  conflict-aware flow for high-stakes bulk edits. Our per-property walk is the more conservative,
  per-item version of the same instinct (Q2).
  ([eleken.co/blog-posts/bulk-actions-ux](https://www.eleken.co/blog-posts/bulk-actions-ux))
- **eDiscovery review batching (Knovos / Relativity / Casepoint)** — the review set is broken into
  **batches**, assigned to reviewers, and progress is monitored; a document is "reviewed" once its
  Reviewed field carries a value; a QC pass re-batches completed work. This is the model for our
  **resumable batch** (Q3 — progress derived from `status`, not a stored counter) and the optional
  supervisor/QC view (Q9).
  ([knovos.com/guides/ediscovery-guide/chapter-8-ediscovery-document-review](https://www.knovos.com/guides/ediscovery-guide/chapter-8-ediscovery-document-review/),
  [casepoint.com/resources/spotlight/ediscovery-document-review](https://www.casepoint.com/resources/spotlight/ediscovery-document-review/))
- **Skip-trace best practice (industry, for contrast)** — *"clean and dedupe before you spend"* and
  *"chase cost-per-reachable-contact, not price-per-record."* We satisfy the principle by never
  spending: staging + dedupe (the free steps) are the entire workbench; the paid step does not exist
  here. ([resimpli.com/blog/skip-tracing-real-estate-investors](https://resimpli.com/blog/skip-tracing-real-estate-investors/),
  [propertyradar.com/blog/the-complete-guide-to-skip-tracing](https://www.propertyradar.com/blog/the-complete-guide-to-skip-tracing))

---

## Open questions for the owner

Short, plain, and each one changes what we build:

1. **One borrower at a time, or a shared "what came in today" landing?** The search only works for a
   borrower we have already identified (that is on purpose — it is what stops us mixing up two people
   with the same name). So the workbench naturally lives per borrower. We *can* add a landing that lists
   recent searches and open batches across borrowers and links into each — but a single global "all
   Elementix properties" inbox would fight the very safety the staging table gives us. Do you want the
   per-borrower workbench only, or also a recent-activity landing on top?

2. **Should undo be able to reverse an import, or only a decline?** Reversing a "not theirs" is easy and
   safe. Reversing an *import* means deleting a line we just added — we can do it safely, but only while
   nobody has touched or verified that line. Is "undo the wrong decline, and undo a fresh untouched
   import" enough, or do you also want to undo a *merge* (harder, because a merge fills in blanks — true
   reversal needs us to remember what was blank first)?

3. **Do you want a supervisor view of who is working which batch?** The lighter design just lets each
   reviewer pick up their own unfinished batch. The fuller one (like the legal-review tools) lets a
   manager create batches, hand them to people, and watch progress. More work — only worth it if you
   want that oversight.

4. **County coverage dot — ship it now or later?** Showing "this county is well covered / thin / not
   covered" so "we found nothing" is read correctly costs one extra small lookup per county per search.
   Worth it in the first version, or add later?

5. **Very large portfolios (over ~100 documents under one company).** Today a search shows the first
   100 and tells you plainly "there is more than shown." Auto-fetching the rest is possible but spends
   more of the shared hourly allowance per search. Leave it as "search again / narrow by state," or
   fetch deeper automatically?

6. **How long should a batch stay "yours" before it's released?** Today a claim goes stale after 30
   minutes. For a resumable batch that spans a lunch break we'd extend that (a few hours). Any preference
   — or should a batch stay yours until you finish or hand it off?
