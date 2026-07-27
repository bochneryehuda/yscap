# The Loan File — Simplicity Blueprint

_Owner-directed 2026-07-27: "everything needs to be cleaner, simpler, more user
friendly and easier to find… focus on three things: **simplicity**, **user
friendly**, **easier to find sections**."_

**This document changes no code.** It is the plan.

---

## The three rules this plan obeys

The owner set them, and every recommendation below was tested against them:

1. **Do not remove a single feature.** Everything that works today still works.
2. **Do not add a single feature.** No new capability, no new business logic.
3. **Do not change how anything behaves.** No new gates, no new rules, no
   renumbered permissions, no touched pricing.

**Two deliberate exceptions, authorised by the owner on 2026-07-27** (see §9).
Both are behaviour changes, both were asked for explicitly, and both are named
here so they are never mistaken for scope creep:

1. **"Post a condition" will actually create the condition.**
2. **A condition created from an AI suggestion starts as normal, not red.**

Everything else below still obeys the three rules. So every other
recommendation is one of exactly four kinds of change:

| Kind | What it means | Risk |
|---|---|---|
| **Rename** | The same thing, called one consistent name | None — words only |
| **Regroup** | The same things, in a better order or box | None — layout only |
| **Reveal** | Something we already compute but never show | None — it already exists |
| **Reuse** | One shared component where we now have five copies | Low — same output |

Nothing here invents. Most of it **switches on work we have already paid for.**

---

## 1. The short version

The loan file is not missing anything. It is **carrying everything at once, with
no order of importance, in four different vocabularies.**

Concretely, opening one loan file today gives a staff member:

- **16 top-level sections**
- **~900–1,100 clickable things** when the sections they need are open
- **~24,000–26,000 pixels** of page — about **27 full screens** of scrolling
- **171 different status words** across the panels
- **36 separate places** a document can be seen or acted on
- **0 ways to search inside the file**

The fix is not a rewrite. It is four moves:

1. **Give the file a front door** — one short list that says what needs you now,
   built from data the server already produces.
2. **Speak one language** — one dictionary of status words, one set of colours.
3. **Separate the two things that were never the same** — conditions become one
   list; the staff checklist gets its own home and stops being a dumping ground.
4. **Make things findable by typing**, not only by scrolling.

---

## 2. What is actually wrong (the evidence)

Every number below was read out of the code, with the file and line recorded in
the Evidence Index (§10). Nothing here is an impression.

### 2.1 Too much on screen at once, with no hierarchy

| Measure | Today |
|---|---|
| Top-level sections | 16 |
| Interactive controls defined in source | 639 |
| Controls rendered on a busy file | ~900–1,100 |
| Page height, everything open | ~24,000–26,000 px (~27 screens) |
| Sub-widgets inside the underwriting panel alone | 30 |

The underwriting panel is the extreme case: **30 sub-widgets, and 17 of them
have no collapse control at all.** Once the data exists, they are open forever.

### 2.2 Nothing looks more important than anything else

This is measurable, and it is the root cause of "everything is messed up one
after the other."

| Measure | Today | Should be |
|---|---|---|
| Inline hand-written styles in the 4 biggest files | **1,576** | near zero |
| Inline styles app-wide vs CSS rules | 4,173 vs 1,981 | inverse |
| Distinct card/panel treatments | ~70 | ~3 |
| Corner-radius values on cards | **19** | 1 |
| Font sizes in CSS | **69** | ~6 |
| Box-shadows (58 used exactly once) | **67** | ~3 |
| Hardcoded colours vs design tokens | **189 vs 39** | tokens only |
| Ways "this one matters more" is expressed | **12** | 1 |

`UnderwritingPanel.jsx` has **631 inline styles and 52 class names** — a 12:1
ratio. `EncompassSyncPanel.jsx` has **71 inline styles and zero class names**.
Those two panels are effectively outside the design system entirely.

Meanwhile `LoanProgress.jsx` and `CreditReport.jsx` use the design system
properly and look clean. **The system works. It is just not being used.**

### 2.3 We speak four languages for the same thing

One database value shows up under **four different names** depending on where
the user is standing:

| Database value | Staff bucket | Borrower bucket | Staff filter label | Borrower label |
|---|---|---|---|---|
| `outstanding` | outstanding | todo | "Not submitted yet" | "Open — still needs you" |
| `received` | submitted | review | "In review — not signed off" | "Submitted — in review" |
| `issue` | rejected | attention | "Needs attention" | "Needs attention" |
| `satisfied` | satisfied | done | "Signed off" | "Completed" |

And staff are additionally shown the **raw database word** in a dropdown and
inline as "· received".

Worse, some words mean **two different things**:

| Word | Meaning A | Meaning B |
|---|---|---|
| **severity** | fatal / warning / info | **timing**: prior-to-docs / prior-to-funding |
| **ready** | the file is clear to close | PILOT thinks one condition can be cleared |
| **cleared** | a terminal signed-off status | a filter meaning "done for me" |
| **waived** | a terminal status | a stamp that still reads "satisfied" |
| **accepted** | the document was accepted (green) | the mismatch was acknowledged, still differs (red) |

That last one is worth care: **both colours are correct for their own meaning.**
It is not a colouring bug — it is one word doing two jobs. The fix is to rename,
never to recolour. (Flagged so nobody "corrects" working code.)

Across the 21 panel files there are **171 distinct status words in 34 separate
constant maps** — 13 of those maps inside one file.

### 2.4 The conditions area is four different things wearing one tab bar

This is the single biggest source of "you don't know where to find what," and it
has a precise cause. The four tabs are split on **three different criteria at
once**:

| Tab | What it really is | Split by | Table |
|---|---|---|---|
| Borrower | items the borrower sees | **audience** | `checklist_items` |
| Internal | items only staff see | **audience** | `checklist_items` |
| Underwriting | a **different table entirely** | **data source** | `conditions` |
| LLC / entity | one subject area | **subject** | `llcs` + items |

The consequences are real, not theoretical:

- The Underwriting tab has an "audience" dropdown offering **"Borrower-facing."**
  A borrower-facing condition created there **never appears on the Borrower
  tab** and has no upload slot. **A borrower's conditions live in two places
  depending on which button staff happened to press.**
- That tab is also **usually empty** — only two things in the whole system write
  to its table, and one of them is its own add-form. A typical file has **0–2**
  rows there while the other tabs carry ~50.
- Four filter dropdowns, **19 options, four different vocabularies** for the same
  underlying data. One tab has no filter at all.
- The LLC condition is rendered **three times**: excluded from the borrower list,
  re-added as a synthetic fake row, and again as its own tab.
- The section's badge counts the borrower tab only. The badge's denominator and
  the list's denominator **disagree** — for a loan officer, an item they marked
  Done vanishes from the list but keeps counting in the badge.
- **The checklist is not actually a checklist.** Rows carry an `item_kind` of
  `document`, `condition` or `task` (the standard file seeds 11 / 8 / 25), but the
  Internal tab builds its checklist as *"everything that is not a document"* — so
  the **8 staff conditions are swept into the checklist** alongside the 25 real
  tasks (`StaffApplication.jsx:2909-2910`). Conditions and work-steps are being
  shown as one list.

A typical file carries **~50–55 conditions**, and there are **16 different places
in the product that can create one**, writing to three different tables.

> **The industry already made this mistake and reversed it.** Encompass split its
> conditions into separate tabs by persona — *Preliminary* ("typically used by
> loan processors"), *Underwriting* ("typically used by underwriters"),
> *Post-Closing* ("typically used by shippers"). Under **Enhanced Conditions
> those tabs collapse into a single Conditions tab.** They split by who works it,
> found it was wrong, and merged. Our four tabs are the same mistake at the same
> stage. — [ICE Developer Connect](https://developer.icemortgagetechnology.com/developer-connect/reference/get-all-enhanced-conditions)

### 2.5 The same thing appears in many places

| Thing | Places it appears |
|---|---|
| A document | **36** |
| A finding | 8 |
| The loan's status | 5 (+3 more for the internal status) |
| Deal economics | 5 full renderings |
| "X of Y done" tallies | 6 independent counters |
| Upload paths | 6, using 3 different upload functions |
| Preview/Download/Accept/Reject/Delete cluster | re-authored 5 times |
| Loan-number editors | 4 |
| Ways to add a condition | 16 |

The code already knows this hurts: the underwriting panel implements a
**three-key de-duplicator** purely to stop the same issue rendering twice, with a
checkbox reading "Show N also in Open findings."

### 2.6 There is no way to find anything by name

There is **no search box anywhere inside a loan file.** No keyboard shortcut, no
command palette, no filter-by-text. With ~1,000 controls on screen, the only
tools are scrolling and a 16-item rail.

### 2.7 Two navigation links are silently broken

`?focus=ai-findings` — the **"Review AI →" button on the Insights dashboard** —
scrolls to an element that does not exist, because its section is collapsed and a
collapsed section removes its contents from the page. The click does nothing.
`?focus=chat` has the same fault. Both are **one-line fixes**.

---

## 3. What we are already doing right (do not break these)

An honest plan has to protect what works.

| Already good | Why it matters |
|---|---|
| **The section rail** | Sticky, grouped, tracks your scroll position, click expands. Good bones. |
| **Collapsed sections cost nothing** | A closed section removes its contents entirely. Real performance win — keep it. |
| **`goToSection(id, tab)`** | One call opens the right section *and* the right conditions tab, from anywhere. |
| **`ClearToClosePanel`** | 97 lines. Title + plain-English reason + "Go fix →". **This is the pattern to spread.** |
| **`useStickyFilter`** | Already remembers 6 filter choices per user. Saved views are a small step. |
| **`lib/esign.js`** | The **one** shared vocabulary module — label + colour + dot per state, "so the two screens never drift." It works. |
| **The brand system** | Ink `#141B22`, Gold `#AE8746`, Teal `#2F7F86`, Paper `#F6F3EC`, Fraunces + Hanken Grotesk. Calm and premium. |
| **AI is advisory-only** | Hard-won and correct. Nothing below may turn a list into a gate. |

**`lib/esign.js` is the single most important precedent in this document.** It
proves the fix works here, in this codebase, already. Everything in §5 is a
continuation of that pattern — not an invention.

---

## 4. What the best software does about exactly this

We benchmarked mortgage platforms, compliance tools, construction punch lists,
audit request lists, and the major design systems. Four findings do most of the
work, and each one has a named source.

### 4.1 Our container is the wrong one, and the guidance says so directly

Nielsen Norman Group lists when **not** to use accordions, and it reads like a
description of our file:

- *"When your audience requires the majority or all the content on the page."*
- *"Restricting users' ability to combine information from multiple accordions at
  the same time."*
- *"It is easier to scroll down the page than to decide which heading to click on."*

Their one-line rule: **"Tabs suit a few long sections, while accordions fit many
short ones."** We have *many long* ones — which is neither. That is a rail.
([NN/g](https://www.nngroup.com/articles/accordions-on-desktop/))

**Good news: we already have the rail.** It is grouped, sticky, and tracks
scroll position. We do not need to build it — we need to stop making it compete
with sixteen accordions.

### 4.2 Sixteen sections is not the problem — sixteen *unlabelled* ones is

The instinct is that 16 is too many. The research says otherwise, and this
matters because it means **we do not have to remove or merge any section**:

> *"Is it okay to have more than 7-9 top-tier categories in the global
> navigation? (Spoiler alert: it is okay, you just need to plan appropriately.)"*
> Vertical left navigation *"can accommodate as many top-tier items as needed"* —
> and *"users look at the left half of the screen 80% of the time."*
> ([NN/g](https://www.nngroup.com/articles/vertical-nav/))

The "7±2" rule people cite is a misreading — Miller himself said it had *"nothing
to do with a person's capacity to comprehend printed text,"* and the same source
notes **broad top-level menus work best**.
([UX Myths](https://uxmyths.com/post/931925744/myth-23-choices-should-always-be-limited-to-seven))

**So: keep all 16. Group and label them.** Which our rail already does.

### 4.3 Tabs are specifically wrong for comparing — which is what conditions work is

Three design systems say the same thing:

- **NN/g:** avoid tabs *"when users must repeatedly switch between tabs to compare
  or reference information."*
- **Carbon:** *"Tabs should not be used if the user needs to compare information in
  different groups, as this would result in the user having to click back and
  forth."* ([Carbon](https://carbondesignsystem.com/components/tabs/usage/))
- **Polaris:** tabs should *"not force merchants to jump back and forth to do a
  single task"* and should represent *"a list-view with different filters
  applied."* ([Polaris](https://polaris-react.shopify.com/components/navigation/tabs))

That last line is the answer for us: our four tabs *are* four filters of one
list, wearing the wrong control.

### 4.4 Cap the depth at two levels

Progressive disclosure works, with one hard limit: **"Designs that go beyond 2
disclosure levels typically have low usability because users often get lost
moving between the levels."**
([NN/g](https://www.nngroup.com/articles/progressive-disclosure/))

We are at **three to four**: section → tab → row → inline expand. Carbon adds the
matching rules: *"Avoid nesting disclosures"* and *"Do not hide critical
information within a disclosure."*

### 4.5 Our direct competitors organise conditions on two axes — the same two we already have

We looked at the private-lending platforms specifically (The Mortgage Office,
Baseline, LendingWise, Lendesk/Finmo, LoanPro, Mortgage Automator). The ones with
documented condition models all use **two orthogonal axes** — a *timing gate* and
a *topical group*:

| Platform | Timing axis | Subject axis |
|---|---|---|
| The Mortgage Office | Condition **Phase** — Prior to Docs / Funding / Closing | Condition **Group** |
| LendingWise | Prior to Approval / Funding / Post-Closing | **Category** — ID Verification, Financials, Property Docs |
| **PILOT today** | `severity` — prior-to-docs / funding / post-closing | *(none — we have the data, we don't group by it)* |

**We already have both axes.** Our `severity` field *is* the timing axis
(mislabelled), and the investor-guideline `domain` list *is* the subject axis.
Move 2 renames the first; Move 4 starts using the second. Neither invents
anything.

Just as important — **not one of them separates borrower-facing from internal
using tabs.** Three different mechanisms show up instead, and all three treat
audience as a *property of the condition*:

- **Baseline:** the status itself controls visibility — `Pending` is invisible to
  the borrower, `Requested` publishes it and notifies them.
- **LendingWise:** a `RequiredBy` role field (borrower / branch / loan officer /
  broker), plus a hard back-office-only flag.
- **Finmo:** edit freely, then an explicit *"Update Borrower → Send Update"*.

We then checked the legacy and bank platforms as well — Encompass, Blend, Floify,
nCino, Calyx Point, MeridianLink/LendingQB, Byte. The result is unambiguous:

> **Across every system we could document — thirteen platforms in total — not one
> splits its conditions into tabs by category or by audience.** They all use a
> single list, with either status buckets (Floify: *Docs Owed / Pending Review /
> Accepted*) or a category **column** (LendingQB, Calyx). Category-as-a-tab
> appears nowhere in the industry.

Two mechanisms are effectively universal, and both confirm audience is a
*property*, not a place:

- **A borrower-facing flag on the condition itself** — Encompass *Print
  Externally*, nCino *Portal Enabled?*, MeridianLink *hide_from_pml_users*,
  Floify *hide from borrower*, Blend *Share with borrower(s)*.
- **Two descriptions, one internal and one external**, side by side — Encompass,
  MeridianLink, nCino all store both. Blend's sync rule is explicit: the external
  description *overrides* the internal one when populated.

> **The market's own users are complaining about exactly what our owner
> described.** Mortgage Automator: *"Screens can be busy at times — more defined
> tabs/shortcuts/sections within a loan would be helpful."* LendingWise:
> *"cluttered at times for new users."* MeridianLink: *"Too many screens"* and
> *"conditions/tasks… could all be better."* Floify: *"making changes to needed
> documents after flow is created is a bit difficult to find."*
> This is an industry-wide failure, not a local one — which makes it a chance to
> be visibly better than what our competitors ship.

### 4.6 Where other tools put things we cram into one field

Two patterns are worth knowing even though they are **not in scope for this plan**
(both would change behaviour). Recorded so the owner can decide later:

- **Procore splits status into three columns** — lifecycle (*Open/Draft/Closed*),
  reviewer verdict (*Approved / Revise and resubmit / Rejected…*), and **"Ball in
  Court"** — *"the name of the person responsible for completing the next
  action."* We compress all three into one status word, which is why our
  vocabulary keeps colliding.
- **Encompass stores two descriptions side by side** — `internalDescription` and
  `externalDescription` as adjacent columns — rather than one text with a
  visibility toggle. A reviewer sees both at once.

### 4.7 And a caution: do not over-simplify a staff tool

GOV.UK's "one thing per page" rule carries an explicit exemption for
*"an internal service for government users who need to repeat and switch between
tasks quickly."*
([GOV.UK](https://design-system.service.gov.uk/patterns/question-pages/))

That is exactly what this is. The goal is **order, not minimalism.** We are not
going to strip a professional tool down to a consumer app — and we are not
removing anything.

---

## 5. The plan

Ordered by **value per unit of risk**. Every item names what kind of change it is.

### Move 1 — Give the file a front door · _Reveal + Reuse_

**One card at the top of the file: "What needs you next."**

Five to eight items, worst first, each with a plain-English reason and a
**"Go fix →"** that jumps to the exact existing control. A "show everything (N)"
link opens the full list. Nothing is hidden; it is ordered.

**Why this is nearly free:** the server *already* computes every ingredient. For
each outstanding item `advancementBlockers()` already returns its title, its
severity, a plain-language reason, **which of the 16 sections fixes it**, and
**which conditions tab**. `ClearToClosePanel` already renders exactly this, and
`goToSection()` already performs the jump.

Three things are wrong with it today, all presentational:
- it only shows clear-to-close blockers, though the same payload already carries
  the funding set;
- it is buried inside "File overview" instead of being the first thing seen;
- **condition ageing is computed, sent to the browser, and never displayed** —
  `daysOpen`, `agingBucket`, `overdue`, `overdueBy` have **zero references** in
  the entire front-end. That is a ready-made "what is going stale" signal we are
  already paying for.

**Server work required: none.**

> **Guard rail.** This list must never become a gate. AI advisories are
> deliberately kept in a separate bucket so they cannot block a file. The card
> must say "suggested order," must keep advisories visually separate, and must
> never feed a blocking check. This is a hard rule, not a preference.

### Move 2 — One dictionary of words and colours · _Rename_

Create `lib/conditions-vocab.js` and `lib/findings-vocab.js` **in exactly the
shape `lib/esign.js` already uses** — for each state: one label, one CSS class,
one dot colour. Import them everywhere. Delete the local copies.

The canonical set for a condition, replacing all four current vocabularies:

| State | The one label | Meaning |
|---|---|---|
| `outstanding` | **Not started** | nothing submitted yet |
| `requested` | **Asked for** | we have asked the borrower |
| `received` | **In review** | something arrived, needs a look |
| `issue` | **Needs attention** | sent back, waiting on a fix |
| `satisfied` | **Done** | signed off / waived / complete |

Rules that come with it:
- The raw database word is **never** shown to a human.
- **"Severity" is renamed to "Timing"** wherever it means prior-to-docs /
  prior-to-funding. It is a schedule, not a danger level, and calling both
  "severity" is the worst collision on the screen.
- One word may not carry two meanings. Where it does today (`accepted`,
  `ready`, `cleared`), rename one side — **never recolour working code.**

**This is words and colours only. No behaviour, no schema, no features.**

### Move 3 — Make every closed section worth judging · _Reveal_

Each collapsed header gains one line built from numbers **already computed** on
the page:

> **Conditions** — 3 need your sign-off · 1 sent back to the borrower
> **Appraisal** — in, 2 findings, none fatal
> **Encompass sync** — 47 of 50 match
> **Orders** — nothing waiting

Also fix, in the same pass:
- **Rail labels and section titles must match.** Four disagree today
  ("Structure & pricing" vs "Loan structure & pricing").
- **One badge calculation, not two.** The rail and the header compute badges
  separately today and disagree in wording and arithmetic.
- **`sec-tapes` should default closed** like the other 13. It is the only export
  tool sitting open, above collapsed sections that matter more.

### Move 4 — Conditions: one list. The checklist: its own thing · _Regroup_

The deepest fix, and the one the owner asked for most directly.

#### 4a. First, the line the owner drew: a checklist is not a condition

_Owner-directed 2026-07-27: "the checklist should not be mixed up with the
conditions… it should be separated as a checklist."_

**The code already knows the difference, and the current screen ignores it.**
Every row carries an `item_kind` of `document`, `condition`, or `task`. The
standard RTL file seeds **11 documents, 8 conditions and 25 tasks**.

But the Internal tab splits on the wrong line. It builds its "Checklist" panel as
*everything that is not a document* — so the **8 staff conditions land inside the
checklist**, mixed in with the 25 real tasks:

```
internalConds  = staff AND item_kind === 'document'    → "Document conditions"
internalItems  = staff AND item_kind !== 'document'    → "Checklist"  ← catches
                                                          'condition' too
```
`StaffApplication.jsx:2909-2910`

So the checklist today is **a staff task list with conditions mixed into it**.
That alone explains a good deal of why it doesn't feel right.

**The correct line, which needs no new data:**

| | What it is | Where it lives |
|---|---|---|
| `document` + `condition` | **Conditions** — something must be satisfied and cleared | The one conditions list |
| `task` | **Checklist** — staff work steps, phase by phase | Its own separate home |

#### 4b. The conditions list

**One list. Filters instead of tabs. Grouped by subject.**

The current tab bar becomes a filter row, because tabs are the wrong control for
a split that is not mutually exclusive — and because **Encompass already ran this
experiment and reversed it** (§2.4), while Polaris describes tabs as belonging to
*"a list-view with different filters applied,"* which is precisely what our four
tabs are:

```
Show:  [ Needs me ▾ ]   Who sees it: [ Everyone ▾ ]   Subject: [ All ▾ ]
```

- **"Show"** replaces the four different filter dropdowns with **one six-option
  list in the shared vocabulary** (Needs me · Not started · In review · Needs
  attention · Done · Everything).
- **"Who sees it"** (Borrower / Internal) becomes a *filter*, not a tab — so a
  processor can finally see **everything outstanding in one view**, which four
  tabs make impossible today.
- **Subject** groups the ~50 conditions into human themes — Title · Insurance &
  flood · Identity · Entity & vesting · Assets & liquidity · Credit · Property &
  valuation · Construction. **We do not need to invent this taxonomy**: the
  investor-guideline `domain` vocabulary already lists exactly these, and
  `condition-map.js` already maps document types onto condition codes.

Each group header reads *"Title — 2 of 5 done."* Groups collapse. The user's
choices persist in the `useStickyFilter` mechanism that already exists.

**The LLC section keeps its own home** — it is genuinely a different shape (an
entity with members and its own documents), and it is the one tab where the split
by subject is honest. It becomes a group in the list *and* keeps its dedicated
panel, rather than being rendered three times as it is today.

**The Underwriting tab folds in — the owner approved this on 2026-07-27.** It is a
different table, usually empty (0–2 rows), and it can create borrower-facing
conditions the borrower's own tab never shows. It stops being a tab:

1. Its rows appear **in the one list**, marked with their source, so nothing hides
   in a tab people forget to open.
2. Its add-form is **retired in favour of the main one**, which removes the
   "Borrower-facing" option that does not behave like borrower-facing elsewhere.
3. The two tables can then be reconciled behind the scenes without the user ever
   seeing a seam. Sequence it **after** the list is working, so the visible
   improvement does not wait on a data migration.

#### 4c. The checklist

The checklist keeps its own home and is **not** merged into the conditions list.

Two things happen to it now, both small:

1. **It gets its real contents.** Once the split is drawn on `item_kind`, the 8
   staff conditions move out to the conditions list, and the checklist becomes
   what its name says — the staff work steps, phase by phase.
2. **It keeps its phase grouping**, which is genuinely useful and already built.

_Owner-directed: the checklist "is not good right now" and may be **removed or
completely remodelled**._ That is a **separate piece of work**, deliberately not
designed here — remodelling it properly needs its own look at what staff actually
use it for. Cleaning out the conditions that don't belong in it is worth doing
either way, because it makes the remaining question ("is this list earning its
place?") answerable for the first time.

### Move 5 — Let people find things by typing · _Reveal_

**⌘K inside the file.** Type "flood" → jump to the flood condition. Type "tape" →
jump to the tapes section. Type "waive" → the waive control on the matching
condition.

The first version needs **no AI at all**: it is a fuzzy match over a list of
destinations we can already enumerate — the 16 sections, ~50 conditions, the
findings, the documents. `goToSection()` already performs the jump. There is an
existing search box in the staff layout to copy the interaction from.

This is the highest-value item per hour of work in the whole document, because it
turns *finding* into *typing* and it degrades gracefully — worst case, you land
one section away.

### Move 6 — One card style, one chip style · _Reuse_

Promote the repeated inline patterns into a small set of named classes built from
the **existing** brand tokens — `card`, `card-quiet`, `stat`, `chip`, `toolbar`,
`empty`. Then convert the four worst offenders panel by panel.

Three rules make this modern rather than merely tidy:

1. **One elevation ladder.** Flat by default; one soft shadow for the thing that
   needs attention. Not 67 shadows.
2. **One radius.** The token is 4px. Use it. Not 19 values.
3. **Hierarchy by size and space, not by colour.** Gold is for *one* thing per
   screen. Today 12 different devices all shout "I matter more," which means
   none of them do.

Do the two files that are already outside the system first — `UnderwritingPanel`
(631 inline styles, 52 classes) and `EncompassSyncPanel` (71 inline styles, zero
classes). They are the largest wins and the lowest risk, because they are not
sharing styles with anything.

### Move 7 — Two one-line bug fixes · _Reveal_

- `?focus=ai-findings` must open the section before scrolling. The Insights
  dashboard's "Review AI →" button has been doing nothing.
- `?focus=chat` — same fault, same fix.

### Move 8 — Honest labels on two buttons · _Rename_

The finding action labelled **"Post a condition"**, whose own description reads
*"Add an underwriting condition the borrower must satisfy,"* **creates no
condition.** It records a note on the finding and leaves it open. Meanwhile a
near-identically-labelled AI-suggestion button, **"Post the condition,"** *does*
create one.

Two buttons, near-identical labels, opposite behaviour. Staff can reasonably
believe a condition was posted when none was.

**Owner-directed 2026-07-27: it should actually create the condition.** So the
fix is no longer cosmetic — the button does what its label and description have
always promised. The finding stays open until that condition clears, which is the
behaviour the description already describes.

Two things to get right when building it:

- **Create into the main conditions list**, not the separate underwriting table —
  otherwise this re-creates the split that Move 4 is closing.
- **Keep it one action, not two.** Today a staffer records the note and then has
  to go and create the condition by hand; the whole point is that they no longer
  have to remember the second step.

**And the second one, also owner-directed: an AI-suggested condition starts as
normal, not red.** Today it is born in the `issue` state — the red *"Needs
attention"* bucket — although nothing was ever rejected. It should start in the
ordinary **"Not started"** state like any other new condition.

---

## 6. Sequencing

Each phase stands alone and ships on its own. Nothing later depends on anything
earlier being perfect.

| Phase | Contents | Kind | Risk |
|---|---|---|---|
| **1** | Broken deep links · rail/title mismatches · one badge calculation · `sec-tapes` closed by default · honest button labels · **AI-suggested conditions start normal, not red** | Rename, Reveal | **Very low** |
| **2** | The shared vocabulary modules; adopt them across the conditions and findings surfaces | Rename | **Low** — words and colours |
| **3** | "What needs you next" at the top of the file, incl. the ageing we already compute | Reveal, Reuse | **Low** — no server work |
| **4** | Collapsed-section summary lines | Reveal | **Low** |
| **5a** | **Split conditions from the checklist on `item_kind`** — the 8 misfiled staff conditions move out | Regroup | **Low** — one filter line, existing data |
| **5b** | Conditions: one list, filters, subject groups; the Underwriting tab folds in | Regroup | **Medium** — the deepest change; after the vocabulary is settled |
| **5c** | **"Post a condition" creates the condition** | Behaviour *(authorised)* | **Medium** — do it once 5b's single list exists, so it creates into the right place |
| **6** | ⌘K find-in-file | Reveal | **Low** — additive, degrades safely |
| **7** | The shared card/chip classes, worst files first | Reuse | **Medium** — mechanical but wide |
| **—** | *Checklist: remove or remodel* | Separate project | Not designed here — needs its own pass |

Phases 1–4 are, together, most of the perceived improvement, carry almost no
risk, and require **no server changes and no new AI spend.**

---

## 7. What this plan deliberately does not do

Stated plainly, so nobody quietly does them later under this banner:

- **No feature is removed.** Every button, filter, panel and export survives.
- **No feature is added.** No new capability, report, or automation.
- **No behaviour changes — except the two the owner authorised** (§9): "Post a
  condition" creates the condition, and AI-suggested conditions start normal
  rather than red. No new gate, no changed permission, no altered rule beyond
  those two.
- **The checklist is not merged into conditions**, and it is not redesigned here.
  It gets its correct contents and keeps its own home; its future is a separate
  piece of work.
- **AI stays advisory.** No list here may become a blocker, and no second
  "dismiss" mechanism may appear beside the existing one.
- **No pricing, guideline, or engine number is touched.** Nothing in this
  document goes near them.
- **No section IDs change.** They are deep-linked from roughly 100 places —
  emails, the Orders queue, the clear-to-close list, the Insights dashboard.
  Labels and grouping may change; **the IDs must not.**
- **Working code is not "corrected."** Where one word legitimately means two
  things in two panels, we rename — we do not recolour.
- **The borrower's screen keeps its own shape.** It shares seven section IDs with
  the staff screen but has 10 sections and reads far more cleanly. It is the
  proof the approach works; it is not the thing being fixed.

---

## 8. How we will know it worked

Measurable, from the same counts used in §2:

| Measure | Today | Target |
|---|---|---|
| Distinct status words on the conditions surface | 171 across 34 maps | one dictionary |
| Filter vocabularies in the conditions area | 4 | 1 |
| Clicks to find what needs you on a fresh file | scroll 27 screens | 0 — it is the first thing |
| Ways to reach a named condition | scroll + guess the tab | type its name |
| Card treatments / radii / shadows | ~70 / 19 / 67 | ~3 / 1 / ~3 |
| Sections whose closed state tells you something | 5 of 16 | 16 of 16 |
| Staff conditions misfiled into the checklist | 8 per standard file | **0** |
| Things the checklist contains that aren't work steps | conditions + tasks | tasks only |
| Features removed | — | **0** |
| Features added | — | **0** |
| Behaviour changes | — | **2, both owner-authorised** |

---

## 9. Decisions — owner-directed 2026-07-27

All open questions are now answered. Recorded verbatim in effect, so the
implementer never has to guess:

| # | Question | Decision |
|---|---|---|
| 1 | Merge the Underwriting tab's separate condition table into the main list? | **Yes.** It stops being a tab; its rows join the one list. |
| 2 | Should "Post a condition" actually create the condition? | **Yes.** The button does what it says. |
| 3 | Should an AI-suggested condition still appear red? | **No.** It starts as normal, like any other new condition. |
| 4 | *(raised by the owner)* Should the internal checklist merge into the conditions list? | **No — the opposite.** The checklist stays **separate** and must not be mixed with conditions. |

**On the checklist specifically.** The owner's words: it *"is not good right
now"* and may be **removed or completely remodelled**. This plan therefore does
two things and stops:

- draws the line correctly (`task` = checklist, `document`/`condition` =
  conditions), which pulls the 8 misfiled staff conditions out of it;
- leaves the checklist's own future as a **separate piece of work**, not designed
  here.

Rebuilding or retiring the checklist is a real product question — what staff
actually use it for, whether the phase structure earns its keep — and it deserves
its own pass rather than being decided as a footnote to a layout change.

---

## 10. Evidence index

Every claim above, with its source.

| Claim | Where |
|---|---|
| 16 sections | `app-v2/src/screens/StaffApplication.jsx:2941-2967`, `:3007-3525` |
| Sections deep-linked from ~100 places | `StaffOrders.jsx:101`, `StaffClosing.jsx:86`, `ExceptionCard.jsx:56-123`, `ClearToClosePanel.jsx:58,90` |
| Section rail, scrollspy, unmount-when-closed | `components/FileSections.jsx:55-188`, esp. `:90` |
| `goToSection(id, tab)` | `components/FileSections.jsx:34-40` |
| Blockers already carry section + tab + reason | `src/routes/staff.js:6821-6859` (`sectionForBlocker`, `condTabForBlocker`, `blockerReason`, `decorateBlocker`) |
| Gating payload already on the client | `src/routes/staff.js:7011-7020`; consumed `ClearToClosePanel.jsx` |
| Ageing computed, never displayed | `src/routes/staff.js:2892`, `:4317`; zero references in `app-v2/src` |
| Two condition tables | `api.staffChecklist` `StaffApplication.jsx:2609` vs `api.staffConditions` `:2612`; `db/schema.sql:233` vs `db/022_conditions.sql:6-27` |
| "Borrower-facing" on the Underwriting tab | `StaffApplication.jsx:3675-3678` |
| Only two writers to the `conditions` table | `src/routes/staff.js:4338`, `src/lib/product-registration.js:61` |
| `item_kind` is `document` / `condition` / `task` | `db/002_backend.sql:15-22` |
| Standard file seeds 11 documents, 8 conditions, 25 tasks | `db/005_rtl_workflow.sql:57` |
| The checklist catches `condition`-kind rows | `StaffApplication.jsx:2909-2910` (`!== 'document'`) |
| Four filter dropdowns, 19 options | `StaffApplication.jsx:2009-2017`, `:3338-3340`, `:3361-3366`, `:3634-3637` |
| Status renaming disagrees | `StaffApplication.jsx:2899` vs `screens/Application.jsx:939` |
| `severity` means timing here | `StaffApplication.jsx:3630`, `:3647` |
| 171 status words / 34 maps | across the 21 panel files |
| Inline styles 1,576 / 4,173 | `UnderwritingPanel` 631, `StaffApplication` 342, `DrawsPanel` 336, `AppraisalPanel` 301, `EncompassSyncPanel` 71 |
| `.panel` defined 7 times | `app-v2/src/styles.css:110,111,548,605,1054,1403,1759` |
| The shared-vocabulary precedent | `app-v2/src/lib/esign.js:1-20` |
| `accepted` red vs green (homonym, not a bug) | `EncompassSyncPanel.jsx:106` vs `OrdersPanel.jsx:127` |
| Broken deep links | `StaffApplication.jsx:2512-2519` (`?focus=ai-findings`), `:2635-2641` (`?focus=chat`) |
| "Post a condition" creates nothing | `src/lib/underwriting/actions.js:16` vs `UnderwritingPanel.jsx:2856` |
| AI conditions born as `issue` | `src/routes/underwriting.js:2661-2678` |
| Subject taxonomy already exists | `src/lib/underwriting/investor-guidelines/bluelake-rtl-spec.js`; `src/lib/conditions/condition-map.js:18-40` |
| Brand tokens | `app-v2/src/styles.css:7-24` |
| AI advisory-only rule | `src/lib/underwriting/advisory-policy.js`; `src/routes/staff.js:6905-6916` |

---

---

## 11. What the research could not confirm

Recorded so nobody repeats these as fact:

- **No sourced user complaints about Encompass's UI.** The review sites all
  blocked automated access. The only hard evidence of pain is ICE documenting
  its own performance bug (adding 30+ conditions taking up to 60 seconds).
- **Most competitor LOS platforms publish nothing about their record UI** —
  nCino, Blend, Floify, LoanPro, Lendesk and the rest are marketing pages only.
  The genuinely useful patterns came from *outside* mortgage: audit request
  lists, compliance evidence tools, and construction punch lists.
- **"Linear has no modals"** is widely repeated and could not be traced to any
  Linear source. Treat as folklore.
- **Drawer-over-modal is not universal doctrine.** Atlassian is deprecating its
  Drawer in favour of Modal. It is right for *our* case — a review queue where
  you compare rows — but it is a judgement, not a law.
- **A frequently quoted "30–50% faster task completion" figure** for progressive
  disclosure could not be traced to a primary study. Not used in this plan.
- **The aviation-checklist principle is the opposite of how it is usually
  quoted:** critical items go **first**, not last, *"to increase the likelihood
  of completing the task before interruptions may occur"* (Degani & Wiener, NASA
  CR-177549). That is why "what needs you next" belongs at the top of the file.

---

_Prepared 2026-07-27. Research: five parallel audits — the staff loan-file
surface, the conditions engine, the underwriting panels, comparable lending and
dense-record software, and the existing AI stack. Benchmark sources: NN/g, IBM
Carbon, Shopify Polaris, Salesforce Lightning, GOV.UK, ICE Developer Connect,
Procore, Suralink, Vanta, Drata._
