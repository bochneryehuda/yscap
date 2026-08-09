# THE BULK PROPERTY WORKBENCH — UX RESEARCH
### Phase 9 of `TRACK-RECORD-REBUILD-BLUEPRINT.md` §9.5 · research pass, no code
**2026-08-09. RTL only. Research only — nothing here has been built.**

The owner, in their own words:

> *"Staff should not go in only one at a time. They should have a view where they can just search
> and see all the properties that come in. This comes up from Elementix. They can select which
> properties they want to import and then review the information for each and every property for
> accuracy."*
>
> *"How the import section of Elementix should work the best way, and how the search should work?"*
>
> *"Do a lot of research on how to make this massive, better than ever."*

This document answers those questions. It sits **on top of** the Phase 7 importer
(`src/lib/track-record/importer.js`), which already searches, stages and decides one candidate at a
time. It does not replace it and it does not soften any of its rules.

---

## 0. THE ONE-SENTENCE ANSWER

**Ticking and reading are two different jobs with two different costs, and the whole design is
built on separating them: ticking is cheap and can be done in bulk, reading is expensive and is
always per property — so the tick does not import anything, it builds a list, and the list is
walked one property at a time on the keyboard.**

That is exactly what the owner described. It is also, independently, what every mature system in
this shape converged on: photo culling (flag fast, then work the picks), e-discovery (batch out a
set, code each document, check the batch back in), and bank reconciliation (auto-match at scale,
confirm each line). The interesting question is not *whether* to split the two passes — it is what
the second pass has to show so that it is a real read and not a rubber stamp. Most of this document
is about that.

---

## 1. WHAT THE SYSTEM ALREADY IS — read before designing anything

I read the blueprint (§2.2, §8, §9, §9.5), `importer.js`, `db/496`, `StaffTrackRecordWorkspace.jsx`,
`pillar-actions.js`, `checks.js`, `workspace.js`, `track-record-ownership.js`, `verify-run.js`,
`elementix/lookups.js` and the staff routes. Facts the design has to fit:

### 1.1 What exists and works

| Piece | Where | What it gives the workbench |
|---|---|---|
| Search → stage | `importer.runSearch` | Loops the borrower's entities, calls `lookups.researchProperty` per entity (~4 paid calls each), stages what comes back. Records `found/staged/skipped/skips/api_calls` per search |
| The staging table | `db/496` `track_record_candidates` | Address, deal type, prices, dates, entity name, `proposed_llc_id`, `dedupe_key`, `match_track_record_id`, `match_confidence`, `status`, `internal_notes`, **`claimed_by`/`claimed_at`**, `raw` |
| Durable decisions | `importer.stageOne` | A declined property never comes back. A snoozed one comes back on its date. The partial unique index makes a re-search safe |
| Borrower answers | `db/504` (landing in parallel, Phase 8) | `decided_by_borrower`, `decided_by_kind` (`staff`\|`borrower`), `borrower_seen_at`, and an index on borrower-answered rows. A borrower can now answer a staged candidate and the workbench has to show it (§2.6) |
| Four verbs | `importer.decideCandidate` | `import_new` / `match_existing` / `decline` / `snooze`, each with real refusals |
| The compare | `importer.compareCandidate` | Per-field `ours` / `theirs` / `conflict` / `willFill` / `material` / `wouldReopen` — already the right shape for a diff view |
| The entity chokepoint | `importer.importNew` → `entityLib.promoteEntityName` | Importing creates/links the LLC on the profile automatically |
| Check A carry | `track-record-ownership.syncEntityToTrackRecords` | Verify an entity once; every line it held gets `auto_verdict='proved'` on ownership, with `checkA`/`checkB` evidence. Writes `auto_*`, never `human_*`. Revoking revokes the carry |
| The design language | `StaffTrackRecordWorkspace.jsx` | `.ec-split` two-pane, explicit dark text (`#141B22` / `#4B585C`), server-owned verdicts, J/K navigation, errors in the banner **and** on the row |
| Server-owned buttons | `pillar-actions.js` | The screen renders `next` / `other` / `hint` verbatim. A button the server would refuse is the failure this arrangement exists to prevent |
| Paid-call accounting | `db/503` `elementix_calls` | Every call attributed to a staff id; monthly cap fails closed, hourly guard fails open |

### 1.2 What does not exist yet — this is the whole gap

- **There is no importer UI at all.** `app-v2/src/lib/api.js` has no method for
  `POST /borrowers/:id/track-record-search`, `GET /borrowers/:id/track-record-candidates`,
  `GET /track-record-candidates/:id/compare` or `POST /track-record-candidates/:id/decide`. Four
  working endpoints with no screen. The workbench is the first front end the importer will ever have.
- **`loadQueue` has no search, no filter, no sort, no pagination.** It returns everything for a
  borrower in three arrays.
- **There is no batch/run concept.** No way to say "these 12 are the ones I am working through."

### 1.3 Five live gaps I found while reading, each of which changes the design

1. **`match_confidence` is never `'near'`.** The column's CHECK allows `exact|near|none`, but
   `stageOne` writes only `'exact'` (a `matchTrackRecord` hit) or `'none'`. So the interface
   physically cannot render the "we are not sure" state the owner needs. **This is the single most
   important schema-supported change in the whole build** — see §2.4 and §12.

2. **A search only ever looks under the borrower's companies.** `runSearch` iterates
   `SELECT ... FROM llcs WHERE borrower_id=$1`, and a borrower with none gets a
   `{reason:'no_entities'}` skip buried inside `track_record_searches.skips`. That is correct policy
   (D6, entity-first) but it means the screen **must say what it asked**, or a zero-result search
   reads as "this borrower has done no deals" when the truth is "we never looked under his name."

3. **`importNew` accepts a null deal type, and that silently produces a line that counts toward
   nothing.** `candidatesFrom` deliberately never guesses a deal type (correct — nothing in a deed
   says whether the plan was a flip). But `experience.exitDateOf` reads
   `deal_type.includes('flip') ? sale_date : (rent_date || refi_date)`, so a bought-and-sold
   property imported with `deal_type = NULL` resolves its exit date to **NULL** and counts toward
   nothing, and `bucketOf(null)` returns `'holds'`, so if an exit date ever arrives it is counted in
   the wrong bucket. **Deal type must be required at import.** That is a correctness requirement
   first and an anti-rubber-stamp device second — see §3.4 and §4.6.

4. **`claimed_by` / `claimed_at` are written by nothing.** The multi-reviewer hook is already in the
   schema, unused. §5 uses it.

5. **`stageOne` runs `SELECT id, property_address, address_key FROM track_records WHERE
   borrower_id=$1` once per candidate, inside the staging loop.** Fine at 9 results, wasteful at 60.
   Hoist it out of the loop when the workbench makes 40-result searches ordinary.

---

## 2. THE LIST VIEW — telling forty look-alike rows apart

### 2.1 The actual problem

Forty properties from one borrower are not forty random rows. They are typically:
- in **two or three towns**, so the city and state are near-constant and carry almost no information;
- under **one to three LLCs**, so the entity is near-constant within a group;
- with **similar prices** ($200k–$600k) and dates clustered in a two-year band;
- and a handful of them are **genuinely confusable**: `27-29 Main St` vs `27 Main St` vs `29 Main
  St`; `5 Main St` vs `5 Main St Apt 1` vs `Apt 2`. `src/lib/address.js` already documents both
  cases — a house-number RANGE covers the numbers it spans, and a bare row matches every unit —
  and `sameAddress` is deliberately non-transitive because of them (D4).

So the differentiating information is, in order: **the house number, the money, the dates.** Not the
city, not the state, not the entity.

### 2.2 The columns that earn their space — six, and no more

Nielsen Norman Group's data-table guidance frames a table around four user tasks: *find records that
fit criteria, compare data, view/edit a single row, take action on records*. Here the row's only job
is the first and the last — comparison and editing happen in the read pane. So the row should carry
the minimum that supports "is this one of theirs, and is it different from the row above it."

```
┌────┬──────────────────────────────┬─────────────┬───────────────────────────┬──────────┬────────┐
│ ☐  │ ADDRESS                      │ STATE       │ THE MONEY                 │ WHAT IT  │ PROOF  │
│    │                              │             │                           │ IS       │        │
├────┼──────────────────────────────┼─────────────┼───────────────────────────┼──────────┼────────┤
│ ☐  │ **62 HIGHLAND ST**           │ ● NEW       │ $410k Aug'25 → $612k      │ Sold     │ deed   │
│    │ Lakewood NJ 08701            │             │ Mar'26 · held 224d        │          │ 8814/221│
├────┼──────────────────────────────┼─────────────┼───────────────────────────┼──────────┼────────┤
│ ☐  │ **27-29 MAIN ST**  ⚠         │ ◐ MAYBE THE │ $185k Jan'24 → no sale    │ Still    │ deed   │
│    │ Lakewood NJ 08701            │   SAME      │ on record                 │ owned    │ 8102/44│
│    │ ⚠ 3 properties on Main St    │ "27 Main St"│                           │          │        │
└────┴──────────────────────────────┴─────────────┴───────────────────────────┴──────────┴────────┘
```

1. **Address, with the decisive part loud.** House number + street in the row's own weight; city /
   state / ZIP one step down and muted. This is the only column that is allowed two lines.
2. **The match state**, as a coloured word — never a number. Four values only (§2.4).
3. **The money and the dates, on one line, as a story:** `bought → sold`, with the hold period. A
   missing figure renders as **`no sale on record`**, never as blank — "we hold nothing" and "the
   record holds nothing" must never look the same. (`compareCandidate` already applies this rule to
   the compare table; the list needs it too.)
4. **What it is** — derived, not claimed: `Sold` (a sale deed exists), `Refinanced`, `Still owned`
   (bought, never sold). NOT the deal type: `candidatesFrom` never writes one and the reviewer
   supplies it in the read pane. Labelling the row "Fix & Flip" before a human said so is exactly
   the fabrication `candidatesFrom`'s own comment refuses.
5. **Proof** — the recorded instrument (book/page or document id), or **`vendor record only, no
   document`**. This is the honest one-glance evidence weight, and it is what the NIST-derived
   grade ladder in `checks.js` is actually measuring (`strong` = a recorded instrument with an id;
   `fair` = the vendor's aggregate with no document).
6. **The collision marker** — `⚠ 3 properties on Main St` on any row whose street is shared inside
   the same result set, and a stronger `⚠ number range` marker on a hyphenated house number.
   Nothing else in the row can tell you that two rows are about to be confused.

**What I deliberately left out of the row:** county, ZIP as its own column, grantor/grantee names,
the deed date separate from the sale date, a score, a percentage, the vendor's internal ids. All of
those belong in the read pane, where there is room for them and where they are actually load-bearing.

### 2.3 Grouping, not sorting

The list is **grouped by the entity on the deed**, collapsible, with a count and a Check A banner
per group (§6). Two reasons:

- The blueprint's own workspace already groups by borrower for exactly this reason: *"Eight
  properties entered at once are read TOGETHER against one document set and one entity. A flat list
  of lines makes a reviewer open the same operating agreement eight times."* The same argument is
  stronger here, because the entity **is** the Check A unit.
- The moderation-queue study behind "Towards a Better Modqueue" (arXiv 2409.16840) found **74.5% of
  moderators would rather have extra information surfaced through *visual cues* than through sorting
  or filtering options**, and that they need to see the whole queue to understand its patterns.
  Grouping is a visual cue that carries a pattern; a sort control is a thing you have to think to use.

Within a group, default order is **exit date, newest first** — the most recent exits are the ones
most likely to be inside the 36-month window, i.e. the ones where the work has any effect.

### 2.4 "Already here" vs "new" vs "we're not sure" — the three-way band

This is a solved problem with a name. Probabilistic record linkage (Fellegi & Sunter, 1969) puts
every candidate pair in one of **three** regions: above an upper threshold it is a match, below a
lower threshold it is a non-match, and **between them is the clerical review region** — the pairs a
human has to look at. The decision rule is optimal in that, for fixed error bounds, it *minimises*
the size of that middle region; it does not eliminate it, and it does not pretend to.

The importer today has two regions and no middle. It needs three:

| Chip | Meaning | `match_confidence` | Pre-selected verb | Colour |
|---|---|---|---|---|
| **● NEW** | Nothing on the record looks like this | `none` | **none — the reviewer picks** | teal `#2F7F86` |
| **◐ MAYBE THE SAME** | Something looks like it, and we are not certain | `near` | **Match to the existing line** | gold `#AE8746` |
| **◉ ALREADY HERE** | An exact address-key hit | `exact` | **Match to the existing line** | grey, collapsed by default |
| **✓ DECIDED** | Imported / matched / declined / snoozed | — | — | folded into its own section |

**What puts a candidate in the middle band.** The near band must come from the *existing* comparer's
own signals — never a new fuzzy matcher (blueprint §6.3: *"never a new normalizer"*, and §12 forbids
a second `sameAddress`). `address.sameAddress` already returns false with a stated reason for the
cases that are genuinely uncertain, and `match.js` already lists the ones that must go to a human:
either house number hyphenated, exactly one side naming a unit, either street ending `Ext`, or
`differs.directional`. Those are the near band, plus: same address key but the sale date differs by
more than `DATE_TOLERANCE_DAYS`, or the price differs by more than a few percent.

**And the chip must be able to say WHY, in one line, on the row:** *"same address · sale date within
1 day · price within 0.3%"*. That is the blueprint's own §9.2 wording and it is right.

### 2.5 Do not put a confidence number on the row

The temptation is a score — `scoring.js` already produces one, with bands at 85 and 55. Keep it off
the list.

The decision-support literature is consistent and uncomfortable here: **high confidence displays
increase trust and reliance but can reduce accuracy**, and modern scoring is poorly calibrated —
high-confidence predictions are often wrong while low-confidence ones are often right. In the
clinical studies, confidence-aware assistance beat no-confidence assistance *when the model was
accurate*, and hurt when it was not. Ours is not accurate enough to earn that: Elementix is live in
**421 of 3,226 counties** with **zero document images in Los Angeles County** (D2), so a "92%" on a
row in a covered county and a "31%" on an identical property in an uncovered one would be saying
something about the county and reading as something about the borrower. That is D3 rendered as a
number.

The moderation research points the same way from the other side: **AI assistance improved reviewer
performance when the AI was highly accurate and impaired it when accuracy was relatively low.**

**So: show the reason, never the number.** The chip plus the one-line why. The score can still run
server-side and drive the ordering and the near band — it just never appears as a figure a person
reads and anchors on.

### 2.6 The fifth state — what the borrower already said

Phase 8 (`db/504`, landing in parallel) lets a borrower answer a staged candidate themselves:
`decided_by_kind` is `staff` or `borrower`, and its own header states the asymmetry plainly — a
borrower *"is answering from memory, at speed, often on a phone, about a property they may have held
years ago under a company they barely remember,"* so their mistaken **"not mine"** *"would silently
cost them experience — and experience sets the tier, and the tier sets the leverage."*

That is a fifth thing the workbench has to show, and the important half is the **declines**, not the
confirmations. So:

- A borrower-answered row carries a small person-shaped mark and the answer in words:
  **`👤 they said this is theirs`** / **`👤 they said this is NOT theirs`**.
- **A borrower's "not mine" gets its own view tab**, right next to Maybes:
  `[ They said not theirs (4) ]`. It is the highest-value review on the screen after the maybes,
  because it is the only place where a wrong answer quietly *removes* credit and nobody is looking.
  The copy says why: *"They said these are not theirs. Worth a sanity check — a wrong 'no' here
  costs them experience and nobody will notice."*
- A staffer can **overturn** either answer, and the overturn is what writes `decided_by` /
  `decided_by_kind='staff'`. `db/504`'s `trc_one_decider_check` means exactly one decider column may
  be set, so an overturn replaces the answer rather than adding a second one — the row must never be
  able to say two people decided it.
- A borrower's **confirmation** is a claim, not a verification — blueprint §9.4 is explicit
  (*"A borrower's 'yes' is a claim, not a verification"*). It must never pre-select `import_new` in
  the read pane for the same reason nothing else does (§4.5): the default that adds credit is the
  one default we do not set.

### 2.7 Density and the responsive shape

Two rows of text per record, 44–48px tall, hairline dividers — the workspace's existing
`.ec-split` + `.panel` language, not a new table component. Under 720px the row stacks and the money
line wraps; the tick box stays at the left edge and stays at least 44px. The repo's existing rule
applies: dark text (`#141B22` / `#4B585C`) explicitly, never an `--ink*` token.

---

## 3. SEARCH

### 3.1 There are two searches and conflating them is the trap

| | **THE FETCH** | **THE FILTER** |
|---|---|---|
| What | Ask Elementix what exists | Narrow what already came back |
| Cost | **Real money** — ~4 paid calls per entity | Free |
| Scope | One borrower | The staged rows |
| Trigger | An explicit button with a confirm | Typing |
| Where | Top of the panel, with the last-searched line | The filter bar over the list |

They must never share a control. A single box that sometimes costs $0 and sometimes fires eight
paid calls is how a monthly ceiling gets eaten by someone exploring. The blueprint's §9.1 copy is
right and should be kept verbatim above the fetch button:

> *This reads a public-records database. It does not touch the loan file, create a file, open a
> condition, or email anybody. Nothing is added to the track record until you import it below.*
>
> *Last searched 12 days ago by R. Stein — 9 found, 6 staged, 3 already here.*

**Add one line the blueprint does not have:** *what we looked under.* Because `runSearch` searches
only under entities (§1.3 #2), the panel must render `track_record_searches.query`:

> *We looked under: **MW TRADING LLC** (NJ) · **WEIL HOLDINGS LLC** (NJ). We did not look under
> Moses Weil personally — public records under a person's name are far less reliable than under a
> company, so we search companies first. [Add a company]*

And it must show the cost before the click: **"Searching 3 companies — about 12 lookups."**

### 3.2 What the filter box searches

One box, no syntax to learn, matching across: street, city, ZIP, county, entity name, document
book/page or id, and — when the text is a number — **either price within ±10% and the year**. So
typing `Highland` finds one, `08701` finds a town, `MW Trading` finds a company's 23,
`612` finds the $612k sale, `2026` finds the year.

Debounced, client-side while the set is under ~200 rows, server-side above that. It must never
trigger a paid call — say so under the box: *"This only searches what already came back."*

### 3.3 The filters that matter, in priority order

1. **Inside the 3-year window / outside it.** The single highest-value filter in the whole screen,
   because the 36-month exit window is frozen and **a property outside it counts toward nothing** —
   importing it is real work with zero effect on the tier. Computed with `experience.exitDateOf` on
   the candidate's own dates, so it can never disagree with the count. **This is the default view.**
2. **Status** — to review / decided / declined / snoozed.
3. **Match band** — new / maybe the same / already here (§2.4).
4. **Entity** (multi-select, drawn from the groups).
5. **State** — from `property_address.state`; only shown when the set spans more than one.
6. **What it is** — sold / refinanced / still owned. NOT "deal type": there is none yet.
7. **Evidence** — has a recorded document / vendor record only. This is the fastest way to find the
   rows that will need a borrower document no matter what.
8. **Price and date range** — last, and collapsed. Sliders are a trap on a 40-row set.

### 3.4 Saved views and the default

Five built-in views, shown as tabs, each with a live count:

```
[ To review · in the window (14) ] [ Maybes (3) ] [ They said not theirs (4) ]
[ Everything found (41) ] [ Decided (27) ]
```

**The default is "To review · in the window."** But it must never *silently* hide the rest, because
the residual matters: the owner's own 2026-08-09 direction is that **REO is the derived residual
list — anything that does not count goes there with the reason why.** So the view carries a
permanent footer line:

> *18 more properties came back that finish outside the 3-year window. They still belong on the
> REO list. [Show them]*

User-defined saved views are polish, not core (§12). Four good defaults beat a view builder nobody
configures.

### 3.5 The empty states — five of them, never one

This is where most import screens lie to their users. Each of these means something completely
different and needs completely different words:

**(a) Never searched.**
> **Nothing has been looked up yet.**
> Searching reads public deed records for this borrower's companies. It costs about 4 lookups per
> company and does not touch the loan file.
> `[ Search public records — 3 companies, about 12 lookups ]`

**(b) Searched, and genuinely nothing came back.** This is the one that must not read as a finding
against the borrower (D2, D3 — a coverage gap must never become a borrower deficiency):
> **Nothing came back for MW TRADING LLC in New Jersey.**
> That is not evidence they have done no deals. The records service covers 421 of the country's
> 3,226 counties, and some counties publish nothing at all online.
> The way to settle this is a closing statement or a deed from the borrower.
> `[ Ask for a document ]`   `[ Search again ]`
> *Searched 2 minutes ago by R. Stein.*

**(c) Things came back, but this filter hides all of them.** Critically distinct from (b):
> **41 properties came back. None of them match what you have filtered to.**
> `[ Clear the filters ]`

**(d) Everything is decided.**
> **All 9 are handled** — 5 brought on, 2 matched to lines you already had, 2 marked not theirs.
> `[ Show what was decided ]`   `[ Search again ]`

**(e) A partial failure.** If `runSearch` recorded skips with reasons, they get their own collapsed
section with the reason per row — never a silent shortfall. `db/496`'s own header says why: *"A
search that quietly returns 3 of 11 results reads exactly like a borrower who only did 3 deals."*

---

## 4. SELECTION

### 4.1 The classic trap, and why the answer here is "don't paginate"

The trap is Gmail's: the header checkbox selects **the visible page**, and a second banner offers
*"Select all conversations that match this search."* Two tiers, and users routinely believe they
have selected everything when they have selected fifty. Gmail keeps it deliberately, as protection
against accidental mass action. NN/g's bulk-action guidance says the same thing positively: provide
select-all, show the count across pages (*"78 items selected across 3 pages"*), and offer an
explicit "select all N results."

**Here, the cleanest fix is to not have pages.** One borrower's result set is typically 5–60 rows and
almost never over 200. Render the whole filtered set, virtualized. Then:

- The header checkbox means **"everything this filter is showing"**, and its label says the number
  and the filter, always: `☑ Select all 14 shown (To review · in the window)`.
- Above 200 rows the second tier appears with Gmail's wording, counted and naming the filter:
  *"Select all 340 that match this filter."* Never a bare "Select all."
- The selection **survives a filter change** and the count bar says so: *"12 selected — 3 of them
  are outside the filter you're now looking at. [Show only selected]"*. Selection silently
  evaporating when a filter changes is the second-worst bug in this class.

### 4.2 Select-by-filter is the primary bulk gesture

Not select-all. A reviewer does not think "the first fifty" — they think *"everything under MW
Trading"* or *"everything with a recorded deed"* or *"everything before 2023."* So the fastest bulk
gesture is: **filter, then take the whole filtered set.** Every group header carries its own
`Select all 23 in MW TRADING LLC`, which is the gesture that actually matches how the work is
organised (§6).

### 4.3 The contextual action bar

NN/g guideline two. It appears when anything is ticked, pinned to the bottom of the list, and it
says the count and the filter in words:

```
┌────────────────────────────────────────────────────────────────────────────────┐
│  12 picked   ·   9 new, 3 maybe the same   ·   all under MW TRADING LLC        │
│  [ Review these 12 ▸ ]        [ Not theirs ]   [ Snooze ]        [ Clear ]     │
└────────────────────────────────────────────────────────────────────────────────┘
```

Note what is **not** in that bar: an Import button. There is none, anywhere, ever.

### 4.4 The asymmetry: decline can be bulk, import cannot

This is the rule that makes the whole screen safe, and it is not invented — it is the doctrine
`pillar-actions.js` already runs on, quoted from its own header:

> *"CONFIRM needs `sign_off_conditions`. REJECT and 'needs a document' do not. That is not an
> oversight: confirming a pillar is the substantive judgement that lets a deal count toward the
> experience tier, which prices the loan — an action that can only ADD credit. Rejecting or asking
> for a document can only WITHHOLD it."*

Applied here:

| Verb | Bulk? | Why |
|---|---|---|
| **Not theirs** (`decline`) | **Yes** | Can only withhold credit. One shared reason, required (the server already refuses a blank note). Reversible (§7) |
| **Snooze** | **Yes** | Changes nothing at all |
| **Match to existing** | **No** | It writes to a real line and can reopen a verification. Per-property |
| **Import as new** | **No** | Creates a line that feeds the experience tier. Per-property, and the owner said so twice |

### 4.5 How you stop somebody ticking forty boxes they never read

Honest answer first: **you cannot stop them at the tick, and you should not try.** Every mechanism
that tries — a dwell timer, a "I have reviewed this" checkbox, a captcha — is defeated in ten
seconds and teaches the reviewer that the system is an obstacle rather than a tool. See §8.

What you *can* do is make the tick cost nothing and put the gate at the read:

1. **The tick imports nothing.** Ticking 40 boxes produces a *list of 40 to read* and zero track
   record lines. The gesture a fast reviewer wants is now cheap and harmless.
2. **The run's counter is the gate, and it is honest.** `Read 0 of 40`. A property leaves the run
   only when it has been opened and decided. There is no "apply to the rest."
3. **The read requires a fact the machine genuinely does not have.** `candidatesFrom` deliberately
   never guesses a deal type, and §1.3 #3 shows that importing without one produces a line that
   counts toward nothing. So **the deal type is required before "Import & next" is live**, and it is
   a real judgement (was this a flip, a rental hold, or a ground-up?) that cannot be produced by
   holding a key down. This is far better than an artificial speed bump because it is not artificial
   — it is a missing fact that the system correctly refuses to invent.
4. **The default is asymmetric.** Defaults are enormously powerful — Johnson & Goldstein's
   *"Do Defaults Save Lives?"* found the opt-out framing roughly **doubled** consent rates for the
   same underlying decision, purely from which box was pre-ticked, and the automation-bias
   literature (Skitka; Parasuraman & Riley) shows people commit *commission errors* — following a
   wrong automated recommendation even with contradicting evidence in front of them — because
   accepting the machine is the low-effort route. So:
   - **"Maybe the same" and "Already here" pre-select MATCH** — the conservative verb. It fills
     blanks, never overwrites, and the server refuses it on a verified line without a second
     confirmation.
   - **"New" pre-selects NOTHING.** The reviewer picks. This is the one place where the extra click
     is worth it, because the pre-selected option would be the one that adds credit.

   That inverts the importer's current `suggested: r.match_track_record_id ? 'match_existing' :
   'import_new'`. The `import_new` half of that line should go.
5. **Make the batch's own shape visible.** *"12 picked — 9 new, 3 maybe the same."* A reviewer who
   ticked indiscriminately sees a shape that does not match what they meant.

---

## 5. THE PER-PROPERTY ACCURACY REVIEW

### 5.1 One screen, a split pane — not a drawer, not a modal, not a full page

- **A modal is wrong.** It traps the keyboard, it cannot show the list position, and this repo has
  already paid for modal traps once — the standing rule from the tool sheets is *"a tool sheet
  ALWAYS has a way out"*, added after a refused save became the only exit. A review that can 409 on
  a verified line must not be inside something you can get stuck in.
- **A drawer is wrong.** An overlay drawer covers the list, so it has the modal's problem with more
  animation. Drawers are the mobile-friendly answer to a narrow viewport; this screen is a desktop
  back-office screen.
- **A full page per property is wrong.** It loses "3 of 40", which the blueprint's own §9.4 already
  identifies as materially raising completion — and the goal-gradient literature (Kivetz, Urminsky
  & Zheng 2006, *JMR* 43(1)) is exactly about this: people accelerate as a visible goal gets closer,
  and even an *illusory* head start produces the acceleration. A denominator is not decoration.
- **A primary-detail split is right,** and it is what the workspace already uses (`.ec-split`).
  PatternFly's own guidance: *"use a primary-detail layout when viewing details from an item in a
  large list… useful for navigating back and forth through a list and making edits in the details of
  each list item, without losing context of the larger list."*

In read mode the left pane collapses from a full list to a **narrow progress rail** — just the
ticked set, with a mark per decided item — and the right pane takes focus and the full width it can
get.

### 5.2 What it shows, in what order

Ordered by **what would make me stop**, not by what is easy to render. The five questions, in the
order a reviewer actually asks them:

```
1. IS THIS THE RIGHT PROPERTY?      ← address, verbatim, plus any collision warning
2. IS THIS THE RIGHT COMPANY?       ← the deed parties, verbatim, and how they matched
3. ARE THE FIGURES RIGHT?           ← money and dates, each with the document under it
4. DOES IT EVEN COUNT?              ← the 36-month window, stated in months
5. WHAT WILL HAPPEN IF I PRESS THIS? ← the preview, then the decision
```

**Question 1 — the property.** Address as the record states it, big. Then the collision warning
when there is one, in words a non-developer reads:
> *⚠ The house number is a range (27-29). A range covers 27 and 29, so this could be one building
> or two different properties. Check the deed before you decide.*

**Question 2 — the company.** This is the one the blueprint says catches real false positives, and
it needs the parties **verbatim** — the York, PA case in §2.2 of the blueprint was a property that
came back under an investor who never owned it, because his LLC appeared as *grantor* on an
unrelated later deed:
```
  Bought by:  MW TRADING LLC                    ← matched "MW Trading LLC" on the profile
  Sold by:    MW TRADING LLC
  Sold to:    J & R HOLDINGS LLC                ← not one of theirs
```
Plus the D5 name-commonness flag when it fires, and — critically — a plain statement when the
entity is only on the *grantor* side: *"This company sold it but we never see them buying it. That
can mean the record is incomplete, or it can mean this was never their property."*

**Question 3 — the figures.** Two columns when there is an existing line to compare against, one
when there is not. Every figure carries its source underneath:
```
  Bought      $410,000        2025-08-02       Ocean County deed, Bk 8814 Pg 221 · recorded 2025-08-09
  Sold        $612,000        2026-03-14       Ocean County deed, Bk 8901 Pg 12  · recorded 2026-03-19
  Rehab       — not on the record —            (public records never show a rehab budget)
  Held        224 days                          shown as a fact; it blocks nothing (D10)
```
The `— not on the record —` treatment is non-negotiable and `compareCandidate` already does it for
the compare table. A blank where a number should be reads as a bug; a stated absence reads as a fact.

**Question 4 — does it count.** One sentence, computed with the frozen rule:
> **This finished 5 months ago — inside the 3-year window, so it counts once it is verified.**

or

> **This finished 4 years 2 months ago — outside the 3-year window, so it counts toward nothing.
> It still belongs on the REO list. You can still bring it on.**

That second sentence changes the reviewer's effort allocation completely and it is one line of text.

**Question 5 — the preview and the decision.** See §5.4.

### 5.3 The compare, when there is an existing line

Reuse `compareCandidate` verbatim — it already returns exactly the right shape. The presentation
rule comes from two places that agree:

- The blueprint §9.3: *"only conflicting fields get a row; one-sided fills are informational; blank
  renders `— empty —`; merge disabled until every conflict is decided."*
- Flatfile's importer, whose primary affordance is a **"Only show rows with problems"** toggle, and
  OneSchema, whose differentiator is surfacing row-level issues inline with an explanation so the
  user can fix them before submitting.

So: **conflicts and fills expanded, agreements collapsed to a count.**

```
  ┌─ Against the line you already have: "62 Highland Street" ──────────────────┐
  │  ⚠ 1 disagreement                                                          │
  │     Sale price      yours $610,000        records $612,000                 │
  │     → the line keeps YOURS. Change it by hand if the records are right.    │
  │                                                                            │
  │  + 2 blanks will fill                                                      │
  │     Purchase date   — empty —             2025-08-02                       │
  │     Entity          — empty —             MW TRADING LLC                   │
  │                                                                            │
  │  ✓ 4 other fields agree.  [show]                                           │
  │                                                                            │
  │  ⚠ This line is already verified. Filling in the purchase date will reopen │
  │    it for review.   ☐ Yes, reopen it                                       │
  └────────────────────────────────────────────────────────────────────────────┘
```

That last block is `compareCandidate`'s `wouldReopen` plus `decideCandidate`'s `confirmReopen` — the
server already refuses without it and the message is already written. Render it as a checkbox the
reviewer ticks, not as a 409 they discover after clicking.

Salesforce's merge UI is the reference for the general shape (side-by-side, master pre-selected,
per-field choice, related records follow) — but ours is deliberately **narrower**: our policy is
fill-blanks-only, "anything a human typed wins," so there is no per-field radio at all. Do not add
one. A field-level chooser invites a reviewer to overwrite a typed figure with a vendor's, which is
the exact thing `matchExisting`'s strict reading refuses.

### 5.4 The preview — "what will happen if I press this"

The single highest-value block on the screen, and it does not exist anywhere in the system today.
Before the buttons, in plain words, computed server-side:

```
  IF YOU BRING THIS ON:
   · A new line appears on Moses Weil's track record — pending, counting toward nothing yet.
   · MW TRADING LLC is created on his profile and this line is tied to it.
   · Its three checks start unanswered. Somebody still has to confirm each one.
   · Nothing is emailed to the borrower.
```

Every one of those four lines is a real, verifiable consequence of `importNew`
(`entityLib.promoteEntityName` → the entity is created; db/485 → `pending`; the pillar backfill →
three unanswered checks). Say them. The whole reason a bulk screen is dangerous is that people stop
knowing what a button does.

### 5.5 The fastest correct path

For the common case — a new property, figures that read cleanly, an obvious deal type:

**read four lines → `F` → `Enter`.** Two keystrokes after the read.

For the match case — **read the diff → `Enter`** (match is pre-selected).

For "not theirs" — **`X` → type a reason → `Enter`.** The reason is required by the server today and
that is right: `stageOne` reads a decline forever, so the next person to search needs to know why.

Everything else (open the compare, jump to the entity, add an internal note) is one key and is
never on the fast path.

---

## 6. CHECK A ONCE, NOT FORTY TIMES

### 6.1 The mechanism already exists — this is a UI question, not a build

`track-record-ownership.syncEntityToTrackRecords` already does the fan-out, and its header already
states the doctrine: Check A is asked once per entity, Check B is a small per-property lookup, ten
properties across two entities is two Check A's and ten Check B's. It writes `auto_verdict`, never
`human_verdict`. It reverses on revoke. Nothing needs inventing.

What is missing is that **the workbench never asks the question.** So a reviewer walks forty
properties and hits "we can't confirm ownership" forty times, for one unanswered question.

### 6.2 Put the question above the group, once

```
┌─ MW TRADING LLC · New Jersey ─────────────────────── 23 of the 41 found ────┐
│                                                                              │
│   Does Moses Weil control this company?          ◐  NOT ANSWERED YET         │
│   One answer covers all 23 properties below.                                 │
│                                                                              │
│   What we have already:                                                      │
│     · NJ Secretary of State lists him as MANAGER                             │
│     · He signed 4 recorded deeds for this company                            │
│   What actually proves it:                                                   │
│     · The operating agreement. It is the only document that proves control —  │
│       signing authority is not an ownership stake.                            │
│                                                                              │
│   [ Ask for the operating agreement ]   [ It's on file — open it ]           │
└──────────────────────────────────────────────────────────────────────────────┘
```

Then the per-property ownership question shrinks to Check B — *"the deed says MW TRADING LLC bought
it. Is that this company?"* — which is a factual lookup, not an investigation.

### 6.3 The rules this must not break

1. **Answering Check A imports nothing.** It writes `llc_borrowers.ownership_verified` and fans
   `auto_verdict` onto *existing* lines. Candidates have no pillar rows at all. A reviewer who
   answers Check A and walks away has changed the entity's status and added zero track-record lines.
2. **It writes the machine's column, never the human's.** Already true. Keep it. A carried pillar
   arrives with its evidence assembled so confirming is one click — but it is still a click.
3. **No cascade.** Relativity's propagation feature — code one document and its family and duplicates
   inherit the value — carries the same guard, stated plainly in their own docs: *"propagation
   doesn't cascade or cause chain reactions."* Coding a parent propagates to its children and to its
   own duplicates; it does **not** then propagate to the children's duplicates. That is the exact
   safety property `syncEntityToTrackRecords` needs and already has (it walks
   `getDescendantEntityIds` once, from the entity that was answered). Do not add a "and re-run for
   everything that just changed" pass.
4. **Check B failing does not touch the entity, and the message names which check failed.** Already
   in the module. Surface it that way: *"The company is verified. We just can't see this company on
   this property's deed"* is a completely different instruction from *"we haven't verified the
   company yet."*
5. **Order the work by the answer.** The run should offer *"Start with MW TRADING LLC — 23
   properties, and the company is already verified"* over *"start with the newest."* Twenty-three
   properties under a verified company are twenty-three cheap reads. Twenty-three under an
   unanswered one are twenty-three reads that all end in the same open question.

### 6.4 The counter is the honest persuasion

`One answer covers all 23 properties below.` That is a truthful statement of leverage and it is the
thing most likely to make a reviewer stop and go get the operating agreement instead of grinding
through forty half-answers. It is the same lever the progress denominator uses in §5.1, pointed at
the highest-value action on the screen.

---

## 7. UNDO

NN/g's position on destructive actions is that confirmation dialogs are for the genuinely
irreversible, that over-using them makes people click through without reading, and that **undo is
the better instrument** — *"do go to great lengths to provide undo, because some user errors will
remain despite even the best of confirmation dialogs."* Applied here as three levels, because the
four verbs are not equally reversible.

### 7.1 Level 1 — the last decision, for about fifteen seconds

A toast, bottom-left, with the address and one key (`U`, and `Ctrl+Z`):

> *Brought on 62 Highland St.* **[ Undo ]** *(14)*

Reversal semantics per verb, honestly stated because they genuinely differ:

| Verb | Undo | Risk |
|---|---|---|
| `decline` | Back to `staged`. The audit row stays | None |
| `snooze` | Back to `staged` | None |
| `import_new` | **Deletes the `track_records` row it created** — and only if nothing has attached to it | Real |
| `match_existing` | **Restores the exact values it wrote**, and only where they are still what it wrote | Real |

**The import undo must reuse `track-record-findings.removeLine`, not write a second remover.** That
module already refuses to destroy verified evidence, refuses when figures have moved, and detaches
documents rather than letting `documents.track_record_id`'s CASCADE take them. If it refuses, say
so plainly: *"Somebody has already uploaded a deed against this line, so it can't be taken back
automatically. Open it and decide."*

**The match undo needs one new column: `track_record_candidates.applied_fills jsonb`**, written by
`matchExisting` recording exactly which fields it filled and with what. Then undo restores only
where the current value **still equals what we wrote** — which is the repo's own established rule,
stated in CLAUDE.md for the appraisal As-Is undo: *"a value PILOT did not write is not PILOT's to
remove."* Copy that discipline exactly.

And one thing undo must **not** do: **restoring the values does not restore a verification.** If the
match reopened a verified line, undoing the fills leaves it reopened, and the toast says so:
*"The figures are back. The line is still open for review — re-verifying it is a person's decision."*

### 7.2 Level 2 — the run ("I went through those twelve too fast")

A run-level `Take back this whole list`, available while the run is the newest run on that borrower
and no one else has touched its lines. It walks the run's decisions newest-first through the
level-1 undo and **reports what it could and could not reverse**:

> *Took back 9 of 12.*
> *3 could not be taken back:*
> *· 118 Oak Ave — a document was uploaded against it*
> *· 9 Elm Ct — somebody confirmed a check on it*
> *· 40 Pine St — it has already been verified*
> *[ Open those 3 ]*

Never all-or-nothing, and never silently partial. A batch undo that reports "done" while three lines
survived is worse than no batch undo.

### 7.3 Level 3 — the permanent record

Every undo writes an audit row (`track_record_candidate_undone`), and the candidate keeps its
decision history rather than being reset to virgin. Two reasons: a declined-then-undeclined property
is a different thing from one nobody ever looked at, and `stageOne`'s durable-decision rule reads
the last status — so the history is what stops the next search from silently re-raising something a
human already thought about twice.

**Undo is never the mechanism by which a declined property comes back into the queue.** Un-declining
is a deliberate act on that row, and it is logged.

---

## 8. WHAT NOT TO BUILD

Twelve patterns that look attractive here and are traps. Several of them are in comparable products
right now.

1. **A bulk "Import selected" button.** The owner's one forbidden shape. It is worth knowing that
   the pressure to build it is real and sustained: Xero's own users have been asking for bulk
   reconcile since April 2022 — 245 votes, with comments like *"clicking OK is giving us RSI"*,
   *"I have to click thousands of times a month"*, and a user reconciling 300+ receipts a day where
   *"95% are correctly matched"* and every one still needs its click. Xero held the line for four
   years, and Xero's stakes are a misfiled ledger entry. Ours is a line that feeds the experience
   tier, which prices the loan. **Do not build it, and expect to be asked for it.**

2. **A confidence percentage or a score badge on the row.** §2.5. Show the reason.

3. **A minimum dwell timer.** *"You must look at this for 3 seconds."* It teaches people to alt-tab
   and wait, it punishes the expert who genuinely recognises the property, and it converts the
   screen into a throughput device. The moderation study is blunt about how that lands: moderators
   ranked **accuracy (μ=4.35) and fairness (μ=3.81) far above efficiency**, and redundancy — the
   platforms' own priority — dead last (μ=2.10). One participant: *"It takes as long as it takes to
   do it correctly."* Use a required real judgement (the deal type) instead of a fake one.

4. **A "☐ I have reviewed this for accuracy" checkbox.** A click-through agreement. It measures
   nothing, and it produces an audit trail that *looks* like diligence, which is worse than no
   audit trail.

5. **Auto-import above a confidence threshold.** The blueprint's own §9.2 says *"Bulk import only
   for `certain`-confidence, no-match candidates"* — **recommend deleting that sentence.**
   `match_confidence` today is computed by an exact address key with no near band at all (§1.3 #1),
   so "certain" currently means "the address key did not collide," which is not the same claim. And
   D5 (a common name never auto-matches) plus the York PA false positive in blueprint §2.2 are
   precisely the cases that would present as certain. Owner-directed, twice: humans click each one.

6. **Firing lookups on render.** Forty rows must never become forty paid calls. The list reads
   `track_record_candidates` and nothing else. Every paid call is a click, attributed to a staff id
   through `db/503`. §9.5 of the blueprint says this explicitly and it is worth restating in the
   code that renders the list.

7. **A hard check-out lock on candidates.** Relativity's batch model is a real, working design —
   batch sets, a batch size, `Blank` / `In progress` / `Completed`, checked out to a named reviewer —
   and it is right for two hundred contract reviewers on a document population. It is wrong for a
   five-person back office, where a hard lock strands a half-worked list the moment somebody goes
   home. **Advisory claim, visible, expiring** — which is also what blueprint §8.3 already chose for
   the workspace, so the two screens agree.

8. **Infinite scroll.** It breaks the denominator ("3 of 40"), breaks selection accounting, and
   breaks keyboard position on re-render. Virtualized full list with a fixed count.

9. **A second address matcher for the "near" band.** `matchTrackRecord` / `sameAddress` is the one
   definition, and blueprint §12 forbids a SQL twin and forbids group matching. The near band comes
   from the existing comparer's own stated-uncertain cases (§2.4), not from a new fuzzy score.

10. **A "merge these three candidates" gesture.** Group/cluster matching is forbidden (D4), and it
    has already caused a near-miss in this repo: `track-record-findings.js` documents that the first
    cut of the dedupe heal grouped transitively and *"would have DELETED a real second condo unit."*
    Pairwise only, always.

11. **A cross-borrower sweep** — "search everybody overnight." `verify-run.js` states the reason in
    its own header: the vendor's hourly allowance is shared by the whole organisation, so a batch job
    starves the person on the phone, and a background pass writing to borrowers' records unattended
    is the shape this rebuild exists to avoid.

12. **`localStorage` for draft state.** Per-device, invisible to a second reviewer, and lost when
    somebody moves to a laptop. The repo already has the right pattern — the tools autosave their
    working state to the server through `PUT …/tool-state`, debounced and `IS DISTINCT FROM`-guarded.
    Do that.

**One more, borderline:** *a "similar to the last one you decided — do the same?"* suggestion. It is
tempting for 23 properties under one company. It is an automation-bias amplifier with a friendly
face, and it makes the fortieth decision a function of the first. If it is ever built, it must be a
*filter* ("show me the 8 that look like this one") and never a *pre-filled verdict*.

---

## 9. THE PROPOSED SCREEN

Three states of one screen. The design language is the workspace's — `.ec-split`, `.panel`,
`.pill`, explicit `#141B22` / `#4B585C` text, gold `#AE8746` for "look at this", teal `#2F7F86` for
the selected thing.

### 9.1 FIND & TICK

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│  Properties found in the public records — MOSES WEIL                        [ ← Profile ]    │
│                                                                                               │
│  Searched 2 minutes ago by R. Stein.  41 found · 38 staged · 3 already on the record.         │
│  We looked under: MW TRADING LLC (NJ) · WEIL HOLDINGS LLC (NJ) · M&S REALTY LLC (NY)          │
│  We did not look under Moses Weil personally.  [ Add a company ]                              │
│                                    [ Search again — 3 companies, about 12 lookups ]           │
│  ─────────────────────────────────────────────────────────────────────────────────────────    │
│  [ To review · in the window (14) ] [ Maybes (3) ] [ They said not theirs (4) ]              │
│  [ Everything (41) ] [ Decided (27) ]                                                         │
│                                                                                               │
│  🔍 [ filter what came back — street, town, company, a price, a year        ]  ⌨ ?           │
│     Free. This only searches what already came back.                                          │
│  Filters: [ In the 3-year window ▾ ] [ Any company ▾ ] [ Any state ▾ ] [ Sold / Held ▾ ]      │
└──────────────────────────────────────────────────────────────────────────────────────────────┘

┌─ ▾ MW TRADING LLC · New Jersey ──────────────────────────── 23 found ── [☐ all 23] ─────────┐
│                                                                                              │
│   Does Moses Weil control this company?   ◐ NOT ANSWERED YET                                 │
│   One answer covers all 23 below.  NJ SoS lists him as MANAGER · signed 4 deeds.             │
│   The operating agreement is the only thing that proves control.                             │
│   [ Ask for the operating agreement ]   [ It's on file — open it ]                           │
│  ──────────────────────────────────────────────────────────────────────────────────────────  │
│  ☑ │ 62 HIGHLAND ST            │ ● NEW          │ $410k Aug'25 → $612k Mar'26 │ Sold │ deed  │
│    │ Lakewood NJ 08701         │                │ held 224 days               │      │ 8814/221│
│  ──┼───────────────────────────┼────────────────┼─────────────────────────────┼──────┼───────│
│  ☑ │ 27-29 MAIN ST         ⚠   │ ◐ MAYBE THE    │ $185k Jan'24 → no sale on   │ Still│ deed  │
│    │ Lakewood NJ 08701         │   SAME as      │ record                      │ owned│ 8102/44│
│    │ ⚠ 3 properties on Main St │   "27 Main St" │                             │      │       │
│    │                           │   same address·│                             │      │       │
│    │                           │   price ±0.3%  │                             │      │       │
│  ──┼───────────────────────────┼────────────────┼─────────────────────────────┼──────┼───────│
│  ☐ │ 9 ELM CT                  │ ◉ ALREADY HERE │ $240k Mar'21 → $301k Jun'21 │ Sold │ vendor│
│    │ Lakewood NJ 08701         │                │ outside the 3-year window   │      │ record│
│    │                           │                │                             │      │ only  │
│  ──┴───────────────────────────┴────────────────┴─────────────────────────────┴──────┴───────│
│  … 20 more in this company            [ show all 23 ]                                        │
└──────────────────────────────────────────────────────────────────────────────────────────────┘

┌─ ▸ WEIL HOLDINGS LLC · New Jersey ──── 12 found ── ✓ company verified ── [☐ all 12] ─────────┐
└──────────────────────────────────────────────────────────────────────────────────────────────┘

  18 more finished outside the 3-year window, so they count toward nothing. They still belong
  on the REO list.  [ Show them ]

┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│  12 picked  ·  9 new, 3 maybe the same  ·  all under MW TRADING LLC                          │
│  [ Review these 12 ▸ ]              [ Not theirs ]  [ Snooze ]            [ Clear ]           │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 9.2 READ — one property at a time

```
┌───────────────┬──────────────────────────────────────────────────────────────────────────────┐
│ Reading 12    │  62 HIGHLAND ST, LAKEWOOD NJ 08701                       3 of 12   ‹  ›     │
│ 2 of 12 done  │  ● NEW — nothing on the record looks like this                                │
│ ▓▓░░░░░░░░░░  │  ──────────────────────────────────────────────────────────────────────────  │
│               │                                                                               │
│ ✓ 118 Oak Ave │  1 · IS THIS THE RIGHT PROPERTY?                                              │
│ ✓ 9 Elm Ct    │     62 HIGHLAND ST, LAKEWOOD NJ 08701                                         │
│ ▸ 62 Highland │     Ocean County · parcel 1234-56-7                                           │
│   27-29 Main  │                                                                               │
│   40 Pine     │  2 · IS THIS THE RIGHT COMPANY?                                                │
│   … 7 more    │     Bought by   MW TRADING LLC        ← matches "MW Trading LLC" on his profile│
│               │     Sold by     MW TRADING LLC                                                 │
│ [ Leave — your│     Sold to     J & R HOLDINGS LLC    ← not one of theirs, and no shared owner │
│   answers are │                                                                                │
│   saved ]     │  3 · ARE THE FIGURES RIGHT?                                                    │
│               │     Bought   $410,000   2025-08-02   Ocean Cty deed Bk 8814 Pg 221, rec 08-09  │
│               │     Sold     $612,000   2026-03-14   Ocean Cty deed Bk 8901 Pg 12,  rec 03-19  │
│               │     Rehab    — not on the record —   (public records never show a rehab budget)│
│               │     Held     224 days                shown as a fact — it blocks nothing       │
│               │                                                                                │
│               │     "GRANTOR MW TRADING LLC → J&R HOLDINGS LLC, $612,000,                      │
│               │      Ocean County Bk 8814 Pg 221"                                              │
│               │                                                                                │
│               │  4 · DOES IT COUNT?                                                            │
│               │     Finished 5 months ago — inside the 3-year window, so it counts once        │
│               │     somebody verifies it.                                                      │
│               │                                                                                │
│               │  5 · WHAT WILL HAPPEN                                                          │
│               │     · A new line appears on his track record — pending, counting toward nothing│
│               │     · MW TRADING LLC is created on his profile and this line is tied to it     │
│               │     · Its three checks start unanswered — somebody still confirms each one     │
│               │     · Nothing is emailed to the borrower                                       │
│               │  ──────────────────────────────────────────────────────────────────────────    │
│               │  WHAT KIND OF PROJECT WAS THIS?   (required — the records never say)           │
│               │     ( ) Fix & Flip  F      ( ) Fix & Hold  H      ( ) Ground-up  N             │
│               │                                                                                │
│               │  Internal note (staff only) [                                            ]    │
│               │                                                                                │
│               │  [ Bring it on & next  ⏎ ]   [ Not theirs  X ]   [ Snooze  S ]   [ Skip  . ]  │
└───────────────┴──────────────────────────────────────────────────────────────────────────────┘
```

### 9.3 READ — when there is a line to match against

```
│  27-29 MAIN ST, LAKEWOOD NJ 08701                                          4 of 12   ‹  ›   │
│  ◐ MAYBE THE SAME as a line you already have: "27 Main Street"                                │
│     same address key · sale date within 1 day · price within 0.3%                             │
│  ⚠ The house number is a range (27-29). A range covers 27 and 29, so this could be one        │
│    building or two different properties. Check the deed before you decide.                    │
│  ──────────────────────────────────────────────────────────────────────────────────────────   │
│  ⚠ 1 disagreement                                                                             │
│     Sale price     yours $610,000        records $612,000                                     │
│     → the line keeps YOURS. Change it by hand if the records are right.                       │
│  + 2 blanks will fill                                                                         │
│     Purchase date  — empty —             2025-08-02                                           │
│     Entity         — empty —             MW TRADING LLC                                       │
│  ✓ 4 other fields agree.  [ show ]                                                            │
│                                                                                               │
│  ⚠ That line is already verified. Filling in the purchase date reopens it for review.         │
│     ☐ Yes, reopen it                                                                          │
│  ──────────────────────────────────────────────────────────────────────────────────────────   │
│  (•) Fill in the blanks on the line I have   ⏎     ← recommended                               │
│  ( ) Bring it on as a separate property      I                                                 │
│  ( ) Not theirs                              X                                                 │
│  [ Do it & next  ⏎ ]        [ Compare side by side  C ]        [ Skip  . ]                    │
```

---

## 10. KEYBOARD MAP

Two modes. The model is Lightroom's culling loop — **three keys and auto-advance** (`P` pick, `X`
reject, `U` unflag, with Caps Lock enabling auto-advance so each keypress moves to the next photo)
— adapted so that `X` means *reject* in both of our modes, which is the one mnemonic worth
preserving across the screen.

The existing workspace already implements the guard this needs: keystrokes are ignored while an
`INPUT`, `TEXTAREA` or `SELECT` has focus. Reuse it verbatim.

### FIND & TICK

| Key | Does |
|---|---|
| `/` | Focus the filter box |
| `Esc` | Leave the filter box, back to the list |
| `J` / `↓` | Next row |
| `K` / `↑` | Previous row |
| `Space` | Tick / untick this row |
| `Shift`+`J`/`K` | Extend the tick to a range |
| `A` | Tick everything this filter is showing — **states the number, then needs `Enter`** |
| `X` | Not theirs — asks for one shared reason |
| `S` | Snooze |
| `G` | Collapse / expand this company's group |
| `E` | Open this company's Check A card |
| `Enter` | **Start reading the ticked set** |
| `1`–`4` | Jump to a view tab (To review / Maybes / Everything / Decided) |
| `?` | The key legend |

### READ

| Key | Does |
|---|---|
| `F` | Fix & Flip |
| `H` | Fix & Hold |
| `N` | Ground-up (**N**ew build) |
| `Enter` | Do the pre-selected verb and go to the next |
| `I` | Bring it on as new |
| `M` | Match — fill the blanks on the line I have |
| `X` | Not theirs (asks for a reason; required) |
| `S` | Snooze |
| `.` | Next without deciding |
| `,` | Previous |
| `C` | Open the side-by-side compare |
| `E` | Jump to this company's Check A card |
| `T` | Focus the internal note |
| `U` / `Ctrl`+`Z` | Undo the last decision |
| `Esc` | Leave the run — everything decided is saved |
| `?` | The key legend |

**Auto-advance is on and not optional.** `Enter`, `X` and `S` always move to the next property.
Lightroom's own numbers make the case: without auto-advance the extra keypress costs about 1.5
seconds per item, which over 2,000 photos is fifty minutes. Our sets are smaller, but the argument
about *rhythm* is the real one — a loop that requires two gestures per item never becomes automatic
enough to leave attention for the actual reading.

**`.` is the deliberate skip**, and it exists because Lightroom's `U` does the same job: when you
are on the fence, you need a key that means *"I don't know, move on"* which is not the same as any
verdict. Without it, an unsure reviewer either guesses or stalls.

---

## 11. BATCH STATE — surviving a closed tab, a second reviewer, and a crash

Four layers. Two of the hooks are already in `db/496`.

### 11.1 The candidate row is already the durable state

Every decision is already written to the row with `status`, `decided_by`, `decided_at`. Closing the
tab loses nothing that was decided. That is true today and it is most of the answer.

### 11.2 The run — one small new table (db/505)

```
track_record_review_runs
  id, borrower_id, created_by, created_at
  filter        jsonb   -- what produced this list, in words, for the header
  candidate_ids bigint[] -- FROZEN, ordered. The list is what it was when it started
  cursor        int      -- where they got to
  status        text     -- 'open' | 'finished' | 'abandoned'
  finished_at
```

Resume looks like this, on the borrower's panel, before anything else:

> **You were part-way through a list.**
> *9 of 12 read — started 2 hours ago by you.*
> `[ Pick up where you left off ]`  `[ Start a new list ]`  `[ Drop this one ]`

**The list is frozen at creation.** If a new search stages six more properties while a run is open,
they do **not** appear inside it. They are announced instead:

> *6 more properties came in while you were working. They are waiting after you finish this list.*

Injecting into a run in progress breaks the denominator (which is doing real motivational work,
§5.1) and makes "3 of 12" a lie. Hiding them silently is worse. Announce, defer.

### 11.3 The claim — advisory, visible, expiring

`claimed_by` / `claimed_at` already exist and are written by nothing. Write them when a run starts,
per candidate. A second reviewer sees:

> *R. Stein has been working this list for 20 minutes.* `[ Work it anyway ]`

Not a lock. Blueprint §8.3 already chose advisory-not-a-hard-lock for the workspace and the two
screens should agree. Relativity's hard check-out (`Blank` / `In progress` / `Completed`, assigned
to a named reviewer) is the alternative and it is genuinely better *at their scale*; at ours, a
lock that outlives the person who set it is a support ticket. Claims expire after a shift.

### 11.4 The crash — server-side per-property drafts

The deal type and the internal note a reviewer typed before deciding go to the **server**, debounced,
on the candidate row (`internal_notes` already exists; add a small `draft jsonb` for the pending deal
type and verb). Never `localStorage` (§8 #12). The repo already has this pattern in the tools'
`PUT …/tool-state` autosave, including the `IS DISTINCT FROM` guard that stops an echoing autosave
touching a row.

The exit affordance is permanent and unconditional — `[ Leave — your answers are saved ]` in the
rail, always enabled, never gated on a save succeeding. That is the standing rule from the tool
sheets, added the last time a refused save became the only way out.

---

## 12. THE BUILD LIST

### 12.1 The core — the screen does not work without these

| # | What | Why it is core | Touches |
|---|---|---|---|
| 1 | **API client + screen skeleton** | There is no importer UI at all today — four working endpoints and no front end | `app-v2/src/lib/api.js`, a new `StaffPropertyWorkbench.jsx`, a route |
| 2 | **The `near` band** | Without it the "we're not sure" state is unrenderable. The schema already allows it; only `stageOne` needs to compute it, from `match.js`'s existing forced-manual-review conditions | `importer.stageOne`, `match.js` |
| 3 | **Filter / search / sort over the staged rows** | 40 rows without a filter is the same problem in a different shape | `importer.loadQueue` (add args), the route |
| 4 | **Entity grouping + the Check A banner** | The highest-leverage single feature. `syncEntityToTrackRecords` already exists; nothing asks the question | `loadQueue` grouping, `track-record-ownership` (read only) |
| 5 | **The review run** | The owner's "review each and every property" needs a list to walk, and it must survive a closed tab | `db/505`, a small `review-run.js`, 3 routes |
| 6 | **The read pane, five sections** | This *is* the accuracy review | new component, reuse `compareCandidate` |
| 7 | **"What will happen" preview** | Nothing in the system explains a button's consequences today, and a bulk screen is exactly where that starts costing | server-computed, in `loadQueue`/a detail route |
| 8 | **Deal type required at import** | **A correctness fix, not a UX nicety** — a null deal type produces a line with a NULL exit date that counts toward nothing and buckets as a hold (§1.3 #3). Enforce server-side in `importNew`, not only in the screen | `importer.importNew` |
| 9 | **Bulk decline + bulk snooze, and the server refusing bulk import** | The asymmetry is the safety property. It must be enforced in the route, exactly as `bulkConfirmRefusal` is for pillars | a `decideMany` that accepts only `decline`/`snooze` |
| 10 | **Undo — level 1** | `applied_fills jsonb` on the candidate + one undo route reusing `track-record-findings.removeLine` | `db/505`, `importer.matchExisting`, a route |

> **Migration number.** `db/504` is already taken by the Phase 8 borrower-answers migration landing
> in parallel, so this phase starts at **db/505**. Re-check the highest number in `db/` immediately
> before writing the file — the standing rule is that a colliding number is renumbered on *your*
> side, never theirs, because theirs may already have been applied in production.
| 11 | **The five empty states + rendering `lastSearch.query`** | A zero-result search currently reads as a finding against the borrower. That is a D3 violation on the screen | the panel |
| 12 | **Per-property draft autosave, server-side** | The owner asked for tab-close survival by name | `importer` + a small route |
| 13 | **Keyboard: both modes, with the input-focus guard** | The whole speed argument collapses without it | the screen |
| 14 | **Hoist the `track_records` read out of `stageOne`'s loop** | Ordinary hygiene once 40-result searches are normal | `importer.runSearch` |

### 12.2 Polish — real value, none of it blocking

- User-defined saved views (the four built-ins carry most of the value).
- The claim (`claimed_by` is already there; the run works fine without it for a single reviewer).
- Run-level undo (§7.2) — the level-1 undo covers the common mistake.
- The address-collision markers (`⚠ 3 properties on Main St`, range warnings).
- The `?` key-legend overlay.
- The "6 arrived while you were working" banner.
- "Start with the biggest verified company" ordering hint.
- The REO residual footer line with its own count.
- Per-group "select all in this company" (the global select-all covers it initially).
- Mobile stacking. This is a desktop back-office screen; make it not broken, do not optimise it.

### 12.3 Explicitly out of scope for this phase

- The borrower-side confirmation flow (blueprint §9.4, Phase 8).
- Any change to `scoring.js` bands or the pillar engine.
- Any change to the borrower's own tool.
- A second vendor (blueprint §13, still open).

---

## 13. THE COPY, IN THE OWNER'S ENGLISH

Every user-visible string proposed above, in one place, so it can be read as a set. Short sentences,
no jargon, and never a word that implies the machine decided.

| Where | Words |
|---|---|
| Above the fetch button | *This reads public deed records. It does not touch the loan file, create a file, open a condition, or email anybody. Nothing lands on the track record until you bring it on below.* |
| The cost | *Searching 3 companies — about 12 lookups.* |
| What we asked | *We looked under: MW TRADING LLC (NJ) · WEIL HOLDINGS LLC (NJ). We did not look under Moses Weil personally.* |
| The filter box | *Filter what came back — street, town, company, a price, a year. Free. This only searches what already came back.* |
| Nothing found | *Nothing came back. That is not evidence they have done no deals — the records service covers 421 of the country's 3,226 counties, and some publish nothing online at all. The way to settle it is a closing statement or a deed from the borrower.* |
| The three bands | *New* · *Maybe the same* · *Already here* |
| A borrower's answer | *👤 They said this is theirs* / *👤 They said this is NOT theirs* |
| The "not theirs" tab | *They said these are not theirs. Worth a sanity check — a wrong "no" here costs them experience and nobody will notice.* |
| A missing figure | *— not on the record —* |
| Outside the window | *Finished 4 years ago — outside the 3-year window, so it counts toward nothing. It still belongs on the REO list.* |
| Check A | *Does Moses Weil control this company? One answer covers all 23 properties below.* |
| Why the OA | *The operating agreement is the only thing that proves control. Being allowed to sign is not the same as owning a share.* |
| The preview | *A new line appears on his track record — pending, counting toward nothing yet.* |
| Deal type | *What kind of project was this? The records never say, so we need you to tell us.* |
| Reopening | *That line is already verified. Filling in the purchase date reopens it for review.* |
| The match policy | *The line keeps yours. Change it by hand if the records are right.* |
| The exit | *Leave — your answers are saved.* |
| Undo | *Brought on 62 Highland St. **Undo**.* |
| Undo refused | *Somebody has already uploaded a deed against this line, so it can't be taken back automatically. Open it and decide.* |

---

## 14. WHERE THE EVIDENCE IS THIN — stated rather than dressed up

1. **There is no published study of exactly this task.** "Review machine-found real-property records
   against a borrower's claimed track record" is not a studied UX domain. Everything in §2–§7 is
   transferred from adjacent domains (record linkage, e-discovery, reconciliation, moderation,
   culling) plus this system's own documented failures. Treat the transfers as arguments, not proof.

2. **The 74.5%-prefer-visual-cues finding** is from one survey of volunteer community moderators
   (arXiv 2409.16840), not paid reviewers on a financial workflow. It is directionally useful and it
   agrees with the workspace's existing grouping choice; it is not a number to design a threshold on.

3. **Lightroom's "1.5 seconds per photo"** figure comes from photography-workflow writing, not a
   controlled study. The *shape* of the claim (a second gesture per item destroys rhythm) is sound;
   the number is illustrative.

4. **The confidence-display literature is mostly clinical.** The trust-calibration and
   overreliance findings are from diagnostic decision support with physicians. The mechanism —
   high stated confidence increases reliance, and miscalibrated confidence is worse than none —
   transfers cleanly; the effect sizes do not.

5. **I did not test any of this with the people who will use it.** Two things in particular are worth
   watching in the first week: whether the required deal type reads as help or as friction, and
   whether the entity grouping is right when a borrower's properties are spread thin across many
   companies (1–2 each) rather than concentrated. If entities are thin, group by town instead and
   keep the Check A banner as a per-row chip.

6. **The `near` band's thresholds are not decided.** Fellegi–Sunter is explicit that the model tells
   you a middle region exists and is optimal in size, but **not where to put the thresholds** — that
   is left to the practitioner. §2.4 proposes deriving the band from `match.js`'s existing
   forced-manual-review conditions rather than from a numeric cut, which sidesteps the question. If
   a numeric cut is ever added, it needs its own calibration pass against real staged data.

---

## 15. OPEN QUESTIONS FOR THE OWNER

1. **Should the workbench live on the borrower profile, in the Approvals hub, or both?** The
   workspace is a hub tab plus an in-file section. The workbench is inherently per-borrower (a
   search is per-borrower), so the profile is the natural home — but a hub tab answers "who has
   properties waiting to be reviewed" across the book. Recommendation: **the profile is the home;
   the hub gets a count and a link**, not a second copy of the screen.

2. **Who may bring a property on?** Today `decideCandidate` requires only borrower visibility. The
   pillar doctrine says the action that *adds* credit needs `sign_off_conditions`. An import lands
   `pending` and counts toward nothing, so this is defensible either way — but it should be a
   decision, not an accident. Recommendation: **any staffer with file access may import; only
   sign-off may verify** (unchanged), because the import is genuinely reversible and the verify is
   the real gate.

3. **Should a property outside the 3-year window be importable at all?** It counts toward nothing
   forever unless the window moves. Recommendation: **yes, and default the view to hide them** — the
   REO residual rule says nothing a borrower did should fall out of the record, and a line that
   ages *into* relevance is impossible, but a line that was already outside can still matter to an
   investor reading the REO schedule.

4. **How many properties before the run should be split?** Forty in one sitting is a lot. Relativity
   sets a batch size deliberately. Recommendation: **no hard cap, but suggest a split above ~25** —
   *"That's 40 properties. Most people work these in sets of about 20. [Take the first 20] [Take all
   40]"* — and never impose it.

5. **Search under the borrower's personal name too?** D6 says entity-first because LLC names are far
   more distinctive, and D5 hard-caps common names at manual review. But a borrower with no LLC on
   file currently gets a zero-result search and a buried reason. Recommendation: **offer it as an
   explicit, separately-priced second search** with the commonness warning shown before the click —
   never as part of the default entity sweep.

---

## SOURCES

Read for this pass, and what each was used for.

**Bulk actions, tables and selection**
- [Bulk Actions: 3 Design Guidelines — Nielsen Norman Group](https://www.nngroup.com/videos/bulk-actions-design-guidelines/) — select-all, contextual action bar, feedback with undo (§4).
- [Data Tables: Four Major User Tasks — Nielsen Norman Group](https://www.nngroup.com/articles/data-tables/) — the four tasks a table has to support; selection across pages with a stated count (§2.2, §4.1).
- [How to Select All in Gmail — Mailmeteor](https://mailmeteor.com/blog/how-to-select-all-in-gmail) and [Select All in Gmail Explained — NewMail](https://www.newmail.ai/blog/select-all-emails-gmail) — the two-tier page-vs-search select-all, and Gmail's stated reason for keeping it (§4.1).

**Errors, confirmation and undo**
- [Confirmation Dialogs Can Prevent User Errors (If Not Overused) — Nielsen Norman Group](https://www.nngroup.com/articles/confirmation-dialog/) — over-used dialogs increase errors; go to great lengths to provide undo (§7).
- [Preventing User Errors: Avoiding Conscious Mistakes — Nielsen Norman Group](https://www.nngroup.com/articles/user-mistakes/) — undo reduces both slips and mistakes (§7).

**Record linkage — the three-way band**
- [Record Linkage Methods — William E. Winkler, NISS](https://www.niss.org/sites/default/files/winkler-presentation.pdf) and [Machine Learning and Record Linkage — Winkler, ISI](https://isi-web.org/sites/default/files/import/files-2011/450070.pdf) — Fellegi–Sunter's three regions, the clerical review band, and its optimality for fixed error bounds (§2.4).
- [The Data-Adaptive Fellegi-Sunter Model — JMIR 2022](https://www.jmir.org/2022/9/e33775) — the decision rule stated in threshold form (§2.4).
- [5 Fellegi-Sunter Model Limitations — Zingg](https://www.zingg.ai/post/fellegi-sunter-model-limitations-modern-entity-resolution) — the model does not tell you where to put the thresholds (§14.6).

**E-discovery review — batches, propagation, coding**
- [Batches — RelativityOne](https://help.relativity.com/RelativityOne/Content/Relativity/Batches/Batches.htm) — batch sets, batch size, `Blank`/`In progress`/`Completed`, assigned-to (§11.3, §8 #7).
- [Reviewing documents in Relativity — RelativityOne](https://help.relativity.com/RelativityOne/Content/Solutions/Reviewing_documents_in_Relativity.htm) — the check-out review loop (§11.3).
- [Applying propagation to documents — RelativityOne](https://help.relativity.com/RelativityOne/Content/Relativity/Fields/Applying_propagation_to_documents.htm) — code once, related documents inherit; **propagation does not cascade** (§6.3).
- [Keyboard Shortcuts — RelativityOne](https://help.relativity.com/RelativityOne/Content/Relativity/Keyboard_shortcuts/Keyboard_shortcuts.htm) — shortcuts on by default, with a discoverable legend (§10). *Note: the public page does not enumerate the default bindings; the specific keys in §10 are ours, not Relativity's.*
- [Document Review — The Everlaw Guide to eDiscovery](https://www.everlaw.com/guides/the-everlaw-guide-to-ediscovery/document-review/) — batch assignment, progress tracking, second-level review (§11).

**Photo culling — the two-pass model and auto-advance**
- [Lightroom Shortcuts for Faster Culling — Photofocus](https://photofocus.com/photography/lightroom-shortcuts-for-faster-culling/) and [How to cull photos in Lightroom Classic — The Lens Lounge](https://thelenslounge.com/how-to-cull-photos-in-lightroom/) — `P`/`X`/`U`, Caps Lock auto-advance, `U` as the explicit "I don't know, move on", and the per-item cost of the extra keypress (§5.5, §10).

**Reconciliation — the per-line confirm, and the pressure to remove it**
- [Reconciliation — Bulk 'OK' for reconciling bank transactions — Xero Product Ideas](https://productideas.xero.com/forums/967136-banking-chart-of-accounts/suggestions/44988634-reconciliation-bulk-ok-for-reconciling-bank-tr) — 245 votes since April 2022, *"clicking OK is giving us RSI"*, *"I have to click thousands of times a month"*, 95% correctly matched and still confirmed one by one (§8 #1).
- [How AI Is Changing Bank Reconciliation — Atlar](https://www.atlar.com/guides/how-ai-is-changing-bank-reconciliation) — suggested matches with full context for the cases needing human judgement (§5.3).

**Data-import wizards — error review**
- [Building a Seamless CSV Import Experience — Flatfile](https://flatfile.com/blog/optimizing-csv-import-experiences-flatfile-portal/) — the "only show rows with problems" toggle, inline error display (§5.3).
- [Best UX flow for spreadsheet imports — CSVBox](https://blog.csvbox.io/spreadsheet-import-ux/) — file → map → validate → submit; staged storage, persisted sessions, resumable progress (§5.3, §11).

**Duplicate merge**
- [Merge Duplicate Records in Salesforce Lightning — Salesforce Ben](https://www.salesforceben.com/merge-duplicate-records-in-salesforce-lightning/) and [Salesforce Duplicate Management — Verum](https://veruminc.com/resources/salesforce-duplicate-management) — side-by-side, master pre-selected, per-field choice, related records follow the master (§5.3, and why we deliberately do *not* offer per-field choice).

**Moderation queues — what reviewers actually want**
- [Towards a Better Modqueue: Designing for Diversity Across Moderator Objectives and Workflows — arXiv 2409.16840](https://arxiv.org/html/2409.16840) — accuracy (μ=4.35) and fairness (μ=3.81) over efficiency; redundancy last (μ=2.10); **74.5% prefer visual cues to sorting/filtering**; full-queue visibility for context; *"it takes as long as it takes to do it correctly"* (§2.3, §8 #3).
- [What do content moderators need? Designing AI-assisted content moderation tasks based on cognitive demand — Int. J. Human-Computer Studies](https://www.sciencedirect.com/science/article/abs/pii/S0169814126000855) — AI assistance improved performance when accurate and impaired it when not (§2.5).
- [The psychological impacts of content moderation on content moderators — Cyberpsychology](https://cyberpsychology.eu/article/view/33166) — throughput quotas and rushing degrade accuracy (§8 #3).

**Automation bias, defaults and progress**
- [Misuse of automated decision aids: complacency, automation bias and the impact of training experience — Computers in Human Behavior](https://www.sciencedirect.com/science/article/abs/pii/S1071581908000724) — commission vs omission errors; following a wrong aid with disproving information available (§4.5).
- [Automation Bias — The Decision Lab](https://thedecisionlab.com/biases/automation-bias) — the least-cognitive-effort account, and accountability as a moderator (§4.5).
- [Do Defaults Save Lives? — Johnson & Goldstein, *Science* 302:1338 (2003)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=1324774) — the opt-out framing roughly doubled consent for the same decision (§4.5).
- [The Goal-Gradient Hypothesis Resurrected — Kivetz, Urminsky & Zheng, *JMR* 43(1):39–58 (2006)](https://home.uchicago.edu/ourminsky/Goal-Gradient_Illusionary_Goal_Progress.pdf) — acceleration toward a visible goal, including from illusory progress (§5.1).

**Confidence displays and trust calibration**
- [Understanding the Effects of Miscalibrated AI Confidence on User Trust, Reliance, and Decision Efficacy — arXiv 2402.07632](https://arxiv.org/pdf/2402.07632) — modern models are poorly calibrated; miscalibrated confidence damages decisions (§2.5).
- [Facilitating Trust Calibration in AI-Driven Diagnostic Decision Support Systems — PMC11612524](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11612524/) — high confidence scores increased trust *and* overreliance, reducing accuracy (§2.5).
- [Explainability and AI Confidence in Clinical Decision Support Systems — arXiv 2501.16693](https://arxiv.org/pdf/2501.16693) — confidence-aware assistance helps when accurate, and the design must actively mitigate automation bias (§2.5).

**Layout**
- [Primary-detail design guidelines — PatternFly](https://www.patternfly.org/patterns/primary-detail/design-guidelines/) — when a primary-detail split beats navigating away (§5.1).
- [Drawer design guidelines — PatternFly](https://www.patternfly.org/components/drawer/design-guidelines/) — an overlay drawer covers page content and must be closed to see it (§5.1).

**Internal**
- `docs/TRACK-RECORD-REBUILD-BLUEPRINT.md` §2.2, §6.3, §8, §9.1–9.5, §12, D1–D16
- `src/lib/track-record/{importer,pillar-actions,checks,workspace,verify-run,match}.js`
- `src/lib/track-record-ownership.js`, `src/lib/track-record-findings.js`, `src/lib/experience.js`
- `src/lib/address.js`, `src/lib/elementix/lookups.js`
- `db/496_track_record_candidates.sql`, `db/503_elementix_call_ledger.sql`
- `app-v2/src/screens/StaffTrackRecordWorkspace.jsx`
- `CLAUDE.md` — the plain-English rule, the palette rule, the appraisal-undo "a value PILOT did not
  write is not PILOT's to remove" precedent, the REO residual rule, the tool-sheet always-an-exit rule
