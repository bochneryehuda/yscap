# The Loan File — Navigation Audit & the "Seven Rooms" Blueprint

_Owner-directed 2026-07-31: "There's too much sections within a loan file. It's
too messy… everybody looks, they don't know which section to look for… they
scroll, they scroll, they scroll within the loan file, they don't get anywhere…
**fewer sections, nicely designed, more organized** — everything should be where
they belong… like a **top, top, top portal**."_

**This document changes no code. It is the plan.** It is the successor to
`docs/LOAN-FILE-SIMPLICITY-BLUEPRINT.md` (2026-07-27): that plan said "keep all
16 sections, group and label them" — the owner has now overridden that with
**fewer sections**, so this plan goes further. Everything already shipped from
the old blueprint is kept and built on, not undone.

---

## 0. How this was researched

Per the owner's direction ("run a few agents… do research on our system and
research on industry standards… a lot of reviews and a lot of research"),
twelve agents ran on 2026-07-31:

| Fleet | Agents | What they did |
|---|---|---|
| Map our system | 3 | Read every line of the staff loan file screen and its panels; mapped the global nav, queues and the borrower screen; verified what shipped from the old blueprint; built a role-by-role "who actually uses which section" matrix |
| Research the world | 3 | How 14 loan-origination systems organize a loan record (Encompass desktop + web, Blend, nCino, Floify, LendingWise, Mortgage Automator, Baseline, LoanPro, Built…); how dense record pages are designed outside lending (Salesforce, HubSpot, Attio, Linear, Epic/EHR, NN/g, Carbon, Polaris, GOV.UK); how companies consolidated messy screens without breaking users (Encompass Enhanced Conditions, Jira, Zendesk, Intercom, Salesforce Lightning, GitHub) |
| Design & review | 6 | Three independent redesigns from three different angles; a judge scored all three and synthesized the winner; a red-team reviewer attacked the winner against the real code (0 blockers, 4 majors — all fixed in §7); an owner-fit reviewer judged it purely in the owner's words |

Every claim below carries a `file:line` or a URL. Findings the research could
NOT verify are listed honestly in §12.

---

## 1. The short version

Opening one loan file today gives a staff member **17 sections on one page
that scrolls about 27 screens deep**. A cleanup round already shipped in July
(the "What needs you next" card, one set of status words, sections that start
closed with summary lines) — and the owner still can't find things, because
the shape didn't change: everything is still one long hallway of closed doors.

**The fix: the hallway becomes seven rooms.**

```
 ┌────────────────────────────────────────────────────────────────────┐
 │ PINNED HEADER — borrower · address · loan # · amount · status ·    │
 │ stage dots · [search ⌘K]                                           │
 │ NEXT-UP STRIP — "what needs you now", follows you into every room  │
 ├──────────────┬─────────────────────────────────────────────────────┤
 │ 1 Overview   │                                                     │
 │ 2 The Deal   │        ONE room on screen at a time —               │
 │ 3 Review &   │        only what belongs to that job.               │
 │   Conditions │                                                     │
 │ 4 Signing &  │        The other rooms are not rendered             │
 │   Closing    │        at all. No more 27-screen scroll.            │
 │ 5 Send to    │                                                     │
 │   Investor   │        Every old link still lands in the            │
 │ 6 Constr.    │        right place. The old page stays              │
 │   Draws      │        one click away ("Full file view").           │
 │ 7 Messages   │                                                     │
 └──────────────┴─────────────────────────────────────────────────────┘
```

- **7 rooms instead of 17 sections.** A typical loan officer sees 5 (Send to
  Investor and Construction Draws are permission-gated, exactly like today).
- **One room renders at a time** — the scroll problem is gone structurally,
  not softened.
- **The "what needs you" list follows you into every room**, so the answer to
  "what do I do next" never scrolls away.
- **Everyone starts in their own room**: the closer lands on Signing &
  Closing, the processor on Review & Conditions with their filter remembered,
  the draw coordinator on Construction Draws.
- **Type to jump** (Phase 2): press ⌘K, type "flood" or "tape" or "encompass",
  land there — with all 17 old section names kept as search synonyms forever.
- **Nothing is removed.** Every panel, button and permission gate moves whole.
  All ~100 existing deep links (emails, queues, exception cards) keep landing.
  The old single-page layout stays available forever as "Full file (classic
  view)" for printing, QC and Ctrl-F.

Not one feature is added or removed by this plan; it is a re-housing. Phase 1
needs **no server or schema changes at all**.

---

## 2. Where we are today

### 2.1 What the July cleanup already shipped (verified in code)

| Old-blueprint move | Status | Evidence |
|---|---|---|
| 1 — "What needs you next" front door | **Shipped** | `NextUpPanel.jsx` + `lib/next-up.js`, rendered at `StaffApplication.jsx:3919` |
| 2 — One vocabulary (labels + colors) | **Shipped** | `lib/conditions-vocab.js` + `lib/findings-vocab.js`, imported across all condition/finding surfaces; "severity"→"timing" rename done |
| 3 — Collapsed-section summary lines | **Shipped (9 of 17)** | `summaries` at `StaffApplication.jsx:3807`; 8 sections still show title+badge only |
| 4a/5a — conditions out of the checklist | **Shipped** | comment at `:4327-4332` |
| 4c/5c — checklist hidden, not deleted | **Shipped** | Internal tab gone; hide scoped `audience='staff' AND item_kind='task'` |
| 4b — one conditions list, filters, subject groups | **Partial** | Filter row + subject groups shipped (`:2644-2679`), but the tab bar survives: **All conditions / Underwriting / LLC** at `:4278-4292`; the Underwriting tab still has its own separate filter (4 options, `:3278`) and its own add-form |
| 4d — LLC fold-in | **Not shipped** | LLC is still a tab AND a condition row (2 renders) |
| 5 — Find by typing (⌘K) | **Not shipped** | No palette anywhere in app-v2 |
| 6 — One card style | **Not shipped** | `UnderwritingPanel.jsx` still carries ~635 inline styles; `EncompassSyncPanel.jsx` 71 |
| 7 — Deep-link fixes | **Shipped** | `?focus=ai-findings` / `?focus=chat` open the section first (`:3245-3257`, `:3357-3374`) |
| 8 — Honest buttons | **Half** | AI conditions born normal ✓ (`underwriting.js:2920-2926`); "Post a condition" still creates nothing (`lib/underwriting/actions.js:16`) |

Also landed the same day as the new directive (2026-07-31, don't re-propose):
"Application details" already became a 3-tab sub-hub (Deal & property /
Missing info / Pipeline data) and Payoff became its own refinance-only
section.

### 2.2 What still hurts (fresh measurements, 2026-07-31)

- **17 `<Section>` blocks** (`StaffApplication.jsx:3939-4475`); 13 render for
  every staff role. 15 start collapsed; Overview starts open; Draws can't
  collapse.
- **The page is still one spine** — every room's door is always in the
  hallway, and orienting still means scrolling past all of them.
- **The conditions area still runs 5 separate show-me controls**: the 3-tab
  bar, "Who sees it" (3 options), "Show" (6 options), collapsible subject
  groups, and the Underwriting tab's OWN 4-option filter + its own add-form —
  the residue of the unfinished 4b fold-in.
- **The same fact renders in up to 6 places**: status (6 surfaces, 2 setters),
  loan number (5 surfaces, 2 entry points), note buyer (5 surfaces, 3 doors to
  one endpoint), economics (7 surfaces), documents (accept/reject/download in
  ≥4 places), the CTC outstanding list (4 renders of one payload). A
  right-side summary rail (`:4516-4538`) duplicates facts the header and
  Overview already show.
- **No way to find anything by typing.** Still zero search inside a file.
- **A dead deep link**: the Findings-to-review screen links every row with
  `?finding=<id>` (`StaffFindingEscalations.jsx:203-204`) but StaffApplication
  has no handler for it — the pulse code lives inside UnderwritingPanel, which
  is unmounted while its section is collapsed, and it's collapsed by default.
  The click lands and does nothing (red-team confirmed; fixed in Phase 1).

### 2.3 Who actually uses what (role × section)

The full matrix is in the audit records; the headline:

- A **loan officer** works in ~7 of their 13-15 visible sections; Encompass
  sync, Exceptions, Document review, Orders are rendered noise for them.
- A **closer** works in ~7; more than half the page is noise for them.
- A **draw coordinator** is the starkest case: ~14 sections rendered, **~12
  of them pure noise** — their whole job is the last section on the page.
- Only processors/admins genuinely touch most of the page — and they benefit
  most from "needs my sign-off" following them around.

Section visibility gates that must survive any redesign: `sec-tapes` only
with `export_data_tapes` (`:3874`), `sec-draws` only with `manage_draws`
(`:3880`), `sec-closing` only for `manage_closings` OR an assigned closer OR
status ∈ {clear_to_close, funded} (`:3717`), `sec-payoff` refinance-only.

---

## 3. What the research says

### 3.1 The industry: nobody good runs a 17-stop scroll

Patterns that repeat across the 14 platforms researched (full sources §12):

| Pattern | Who does it |
|---|---|
| **Few top-level items (4–8), depth inside** | LoanPro (4 tabs: Summary/Transactions/Documents/Collateral), Encompass TPO Connect (~6 menu items), nCino sub-nav, Built |
| **Persistent summary header with key figures + stage** | LoanPro summary widgets, TPO Loan Summary, Blend workspace, Salesforce Path |
| **One documents repository driven by a needs-list** | Encompass eFolder, Floify needs list, LendingWise Required Docs, Finmo Smart Documents |
| **Conditions = ONE list; phase is a facet, role is a permission — never separate screens** | Encompass Enhanced Conditions (their 20.2 redesign replaced fragmented per-persona condition views with one list — the industry already made our mistake and reversed it) |
| **Activity/audit feed as a first-class place** | Encompass eFolder History, Floify audit log, Blend Autopilot feed |
| **Role decides the default view, not the geography** | Encompass Personas, nCino field sets, TPO admin-gated sections |
| **Draws = budget grid + per-draw cards + wizard in one place** | Built, Baseline, The Mortgage Office |
| **Complaint themes in reviews** | "clunky", "docs hard to find", "too many screens", "cluttered for new users" — findability and click-depth, never "too few sections" |

### 3.2 Outside lending: how dense record pages are actually solved

Ranked most-applicable (full sources §12):

1. **Pinned highlights header** (Salesforce highlights panel, Epic Storyboard)
   — the ~7 facts every role needs stay on screen; kills half the scrolling.
2. **Regroup into 5–7 task-based workspaces** (Salesforce's own rationale for
   Lightning: Classic put everything "on one long page… tons of scrolling").
3. **In-record search** (Epic Chart Search is the proven answer for the most
   section-dense UI in any industry).
4. **⌘K command palette** (Linear, Intercom — Intercom's rebuild used Cmd+K as
   the explicit safety net so consolidation never made anything unreachable).
5. **Overview hub with drill-in spokes, ≤2 disclosure levels** (GOV.UK task
   list; NN/g: beyond 2 levels users get lost — we are at 3-4 today).
6. **Peek/drawer for child records** (Linear Peek, Airtable side sheet) so
   comparing never means leaving context.
7. **Role-based default views** (HubSpot team views, SugarCRM role layouts).
8. **Process path in the header** (Salesforce Path) — the stage spine belongs
   in the chrome, not in a section.
9. **One activity timeline with a "needs me" split** (Salesforce, Linear
   Inbox).
10. **Stable geography + personalized landing** — never per-role page shapes.

NN/g's accordion guidance still reads like a description of our page: avoid
accordions "when your audience requires the majority of the content" — and 17
long accordions is neither tabs-shaped nor accordion-shaped.

### 3.3 Consolidation lessons: how to do this without a riot

From the documented redesigns (Encompass Enhanced Conditions, Jira's new issue
view backlash, Zendesk Agent Workspace, Intercom Inbox 2, Gmail tabs,
Salesforce Classic→Lightning, GitHub Issues 2025):

**DO:** object/job-based hubs with phase as a filter, never phase-as-container
(phase tabs sit empty early and stale late) · keep conditions and the
documents that clear them in ONE room (clearing a condition IS comparing a
document) · a permanent anchor-alias map treated like a site-migration
redirect table, tested in CI · reuse the old names — **relocate, never
rename** (Jira's core failure was flattening + hiding fields; Zendesk's was
breaking muscle memory) · opt-in preview with a revert window + a "where did X
go" sheet (GitHub/Salesforce/Zendesk all did this) · keep a full single-page
view for print/QC/Ctrl-F die-hards (the Jira lesson: power users asked for
the scroll BACK — so we keep it one click away instead of deleting it).

**DO NOT:** group top-level by loan phase · separate conditions from documents
· nest tabs in tabs · exceed ~7 top-level items · rename and relocate in the
same release · let any legacy link land at the top of the page or 404 · force
a big-bang cutover with no fallback.

---

## 4. Three designs were drawn; one won

Three independent designers worked from the same inventory and research, then
a judge scored them (1-10 per criterion):

| Criterion | 1 "The Loan's Journey" (stage-backbone) | 2 "Job Stations" | 3 "Command Center + Hubs" |
|---|---|---|---|
| Owner-fit (fewer, plain, no scroll) | 7 | **9** | 8 |
| Findability | 7 | **9** | 8 |
| Zero-feature-loss mapping | 8 | **9** | 9 |
| Feasibility in this codebase | **9** | 8 | 7 |
| Role fit | 7 | 8 | **9** |
| Durability | 6 | 8 | **9** |
| **Total** | 44 | **51** | 50 |

**Winner: Job Stations** — it answers the owner's exact words (fewer, plain,
no scroll) with the least Phase-1 risk. The journey design left the page one
long spine (the literal complaint); the command-center design had the best
landing screen but the heaviest "phase 1" and split conditions from document
review — the one task that must never span two rooms.

The final plan below is Job Stations' skeleton with the best grafts from the
others: the command-deck Overview and its "any future feature gets a chip on
Overview and a body in a room" governance rule (from 3), the header stepper
and the relocate-never-rename discipline and CI link test (from 1).

---

## 5. The plan — Seven Rooms

**One sentence:** seven rooms instead of seventeen sections — open a file, one
screen says where it stands and what needs you, that list follows you into
every room, everything for one job lives whole in one room, you can type to
jump anywhere, and the old page stays one click away.

### 5.1 The seven rooms

Fixed order for everyone. A room never appears/disappears with loan **phase**
(stable geography); rooms gated by **permission** vanish exactly as their
sections do today. Inside a room, its children are today's `<Section>` blocks,
unchanged.

| # | id | Rail label | The job | Children (existing sections, verbatim) |
|---|---|---|---|---|
| 1 | st-overview | **Overview** | Where it stands, who's on it, what needs us | sec-overview |
| 2 | st-deal | **The Deal** | What we're lending, on what, at what price | sec-application · sec-payoff (refi only) · sec-pricing · sec-exceptions · sec-encompass |
| 3 | st-review | **Review & Conditions** | Clear the file | sec-conditions (default child) · sec-underwriting · sec-appraisal · sec-track · sec-documents |
| 4 | st-signing | **Signing & Closing** | Signed, ordered, funded | sec-esign · sec-orders · sec-closing (today's visibility rule) |
| 5 | st-delivery | **Send to Investor** | Deliver the loan to the capital provider | sec-tapes (`export_data_tapes`); Phase 2 adds the exports + trailing docs. Room renders only when it has a visible child |
| 6 | st-draws | **Construction Draws** | Post-funding money | sec-draws (`manage_draws`; hand-off to the Draw Center unchanged) |
| 7 | st-messages | **Messages & History** | Chat, email, activity | sec-messages |

Naming notes (owner-fit review): "Send to Investor" — not "Investor
Delivery" — and the word "tapes" never appears in anything the owner reads
(staff-only label stays as-is inside). Internally these are "stations"; to
the owner they are **rooms**. Words like "hub/palette/IA/canvas" never reach
the screen — the search box is called **Search**.

Room badges roll up worst-first — but ONLY from page-level sources that exist
without visiting the room: the server-stamped gating counts
(`needsBySection`/`notesBySection`, `StaffApplication.jsx:3781-3791`),
`nCondOpen`, `payoffMissing`, `nOrdersToAssign`, `docs.length`. The
appraisal/underwriting summary ladders are panel-reported and mount-dependent
(`:3768-3774`) — they remain after-visit enrichment and are never the roll-up
source (red-team major #3).

### 5.2 The complete map — nothing homeless

| Today | New home | Detail |
|---|---|---|
| sec-overview | Overview | **Whole in Phase 1.** Phase 2 splits into **at most 6 cards** (hard budget): ① Status & dates (both status dropdowns — internal status shown UNCONDITIONALLY, no longer behind the pipeline toggle — closing dates ×2, Message/Remind/Invite; modals unchanged) ② Snapshot & note buyer (DealSnapshot + NoteBuyerCard; **`#note-buyer-slot` STAYS on Overview — owner-directed 2026-07-27, do not move**) ③ **Deal facts** (the As-is row with its "(= purchase)" note + the assignment trio: assignment yes/underlying price/fee — explicitly homed here, red-team minor) ④ People & entity (BorrowerProfilePanel ×2 + CoBorrowerBlock + entity rows — the person editor stays on Overview per the 2026-07-27 rule; exactly one mount per person) ⑤ Team & assignment (TeamAssignees + assign selects + underwriter row) ⑥ Hand-off (SubmitFilePanel) + an "Advanced" drawer (FileNotificationOverrides + ClickupSyncPanel until the Phase-2 Data-sync move). PropertyPhoto thumbnails into the header in Phase 2 |
| LoanProgress stepper | Pinned header | The stage dots move into the sticky identity bar (Salesforce-Path style); Phase 2 makes dots clickable |
| NextUpPanel | Global | Pinned **Next-up strip** under the header on EVERY room; rows keep `goToSection(r.section, r.condTab)` and route through the alias layer. **Keeps excluding AI advisories** (`NextUpPanel.jsx:26-30`) — and so must the Phase-2 "show everything left to clear" toggle (hard rule) |
| ClearToClosePanel + `#ctc-outstanding` | Overview (Phase 1) | Phase 2 merges it into the strip as "Show everything left to clear"; the `#ctc-outstanding` id stays live on that list |
| file-top identity bar | Pinned header | Kept; gains stepper + loan amount + Search button. Borrower view / archive / delete unchanged |
| StructuralLockBanner + notices | Global | Under the header, above every room (already global today, `:3930`) |
| Right summary rail (`.file-rail-grid` aside) | Retired Phase 1 | Pure duplicates: loan#/status → header; team → Overview; doc count → the room badge. Internal status moves to the Status card (see above) |
| Overlays (DocPreview, chat modal, ReminderModal, ToolModals, the hidden conditions upload input) | Global / move with owner | Unchanged; the hidden upload input moves with sec-conditions |
| sec-application | The Deal | Its 3 tabs verbatim (Deal & property / Missing info / Pipeline data) |
| sec-payoff | The Deal | Refi-only exactly as today; Signing & Closing gains a payoff-status chip once closing is active (Phase 2) |
| sec-pricing | The Deal | ProductStudioPanel primary; `studioRef.openStudio()` keeps working cross-room (§7 fix R2) |
| sec-exceptions | The Deal | ExceptionRegisterCard right under pricing; the Approvals desk stays the decide surface |
| sec-encompass | The Deal | Collapsed "Encompass sync (advanced)". Phase 2 pairs it with the relocated ClickupSyncPanel as one **Data sync (advanced)** area — the two mirror-compare panels finally live together |
| sec-conditions | Review & Conditions | **Default child.** The hub moves verbatim in Phase 1 (tabs, filter row, subject groups, `__llc` row, full-screen render-prop). Phase 2 finishes old-blueprint 4b/4d: fold the Underwriting tab and the LLC tab into the one list |
| sec-underwriting | Review & Conditions | UnderwritingPanel + InvestorGuidelinesPanel subsection; `?finding=` pulse + `#ai-findings` intact; findings stay ADVISORY |
| sec-appraisal | Review & Conditions | AppraisalXmlWaiver + AppraisalPanel whole |
| sec-track | Review & Conditions | Verifying experience is file-clearing work; still also opens from its condition row |
| sec-documents | Review & Conditions | **Whole in Phase 1** — the library sits beside the conditions it clears (the research's strongest do-not-separate rule). Phase 2: PostClosing + TprExport + MismoExport move to **Send to Investor** with new anchors + permanent aliases; the working set + Trash stay here |
| sec-esign | Signing & Closing | EsignFileSection whole — early and late envelopes are one chase-signatures job |
| sec-orders | Signing & Closing | OrdersPanel + ClosingPrepCard; StaffOrders `#sec-orders` links alias here |
| sec-closing | Signing & Closing | ClosingPanel; closer auto-landing remapped (not rebuilt); same visibility rule |
| sec-tapes | Send to Investor | `export_data_tapes` gate unchanged; staff-only surface (note-buyer names never borrower-facing — holds structurally: the borrower screen is untouched) |
| sec-messages | Messages & History | Chat / Email / Activity tabs; `commTab` sticky; `#conversations` anchor preserved |
| sec-draws | Construction Draws | Hand-off buttons / locked notice unchanged; DrawsPanel stays at `/internal/app/:id/draws` |

Every inner label keeps its current wording verbatim — **relocate, never
rename** (both at once is the documented double-break).

### 5.3 The landing screen

Phase 1: pinned header (borrowers · address · loan # · status pill · stage
dots · amount) → Next-up strip (worst-first, same gating payload) → the
viewer's default room open, its children as today's collapsed sections with
their summary lines.

Phase 2 upgrade: Overview becomes the command deck — the ≤6 cards above plus a
**room map**: one row per room with its rolled-up badge and a one-line receipt
("The Deal — Registered: Gold · payoff complete"), click = open the room.
Overview must fit 1440×900 without scrolling — a hard budget enforced at
review. **Governance rule, permanent:** any future feature gets a chip/count
on Overview and its body in a room — never a new top-level section.

### 5.4 Navigation & search

**Navigation:** the left rail lists 7 rooms; the active room's row expands to
show its child sections (spokes). The canvas mounts ONE room: its 2-5 child
`<Section>`s stacked — ids, labels, badges, summaries, collapse behavior and
full-screen all byte-identical. Scroll drops from ~27 screens to one room's
worth. Any child is ≤2 clicks (room → child, and `goToSection` auto-expands).
Disclosure depth: room → section → row (back inside NN/g's 2-level limit for
day-to-day work).

**Full file (classic view):** a rail-footer toggle renders all 17 sections in
today's order — literally today's render path behind a flag — for print,
Ctrl-F, QC, and instant revert. Kept forever.

**Search (Phase 2; ⌘K, `/` outside inputs, header button on mobile):** one
file-scoped search over data already in memory: the 7 rooms + all child
sections + **all 17 legacy section names as permanent synonyms** ("tapes",
"encompass", "orders" always land) + condition titles/statuses/subjects +
document filenames (Enter opens the preview) + people + actions-as-verbs
(message borrower, remind, open studio, re-register, add condition, order
flood certificate, export TPR/MISMO/tape, open Draw Center, full file view) —
each an existing handler. Enter = alias-aware room hop + `goToSection` + gold
pulse (the existing `?finding=` pulse pattern, `UnderwritingPanel.jsx:2975-2990`).
Misses are counted (localStorage in Phase 2; server telemetry in Phase 3) so
the map learns from what people can't find.

### 5.5 Each role starts in their room

The rail order is identical for everyone — geography never changes per role.
What varies: the default room on open, the default child/tab, and quiet
styling for rarely-used rooms (muted label, badge only when non-zero — with
explicit dark text colors `#141B22`/`#4B585C`, never `var(--ink*)`, per the
documented white-on-white trap).

| Role | Lands on | Default child / note |
|---|---|---|
| Loan officer | Overview | — |
| Processor | Review & Conditions | Conditions child; "Needs my sign-off" sticky filter kept |
| Underwriter | Review & Conditions | Document review child |
| Closer | Signing & Closing | The existing auto-landing (`:3221`) remapped |
| Draw coordinator | Construction Draws (funded) else Overview | Down from ~14 rendered sections to 3 loud items |
| Admin / super-admin | Overview | — |

Deep links, `#sec-*`, `?focus=`, `?finding=` and Next-up clicks ALWAYS beat
the role default. Per-user "pin my landing room" uses the existing
`useStickyFilter`/localStorage pattern. Nothing is hidden beyond today's
permission gates.

### 5.6 Phones (≤720px)

The rail's existing chip-bar collapse now shows **7 chips that fit one row**
(17 didn't). A room is naturally a full-screen workspace; the header condenses
to two lines plus a Next-up count chip that opens the strip as a bottom sheet
(existing `.cv-modal` pattern). Section full-screen mode is the default
working posture for the big panels. Inputs stay ≥16px; wide tables keep their
own `overflow-x:auto` containers; the `html{overflow-x:clip}` guarantee is
untouched; safe-area insets on fixed bars.

---

## 6. Every old link keeps working

**Doctrine: `sec-*` ids are permanent public addresses; rooms are
presentation.** Ids are never renamed, the alias table is additive-only, and a
CI test over the full link inventory is the contract.

- **`STATION_OF` alias map** (new `app-v2/src/lib/stations.js`): every sec-* id
  → its owning room (per §5.1). `goToSection(id, tab)` resolves the room
  first, activates it, queues the open+scroll, flushes after mount. With no
  resolver registered the helper is byte-identical — the borrower screen and
  every existing caller need zero changes.
- **`#sec-*` hash** (`:3213`): unchanged — covers StaffOrders:119,
  StaffClosing:96, SyncReviews FIELD_SECTION (:250-264), ExceptionCard
  (:57-136), EditFileDetails:313, EsignFileSection:498, TapeExport
  (:4794/:4808/:4839), and the four server-email anchors
  (`admin-exceptions.js:335,352`, `closing-inbox.js:217`,
  `notification-digests.js:1160`) with zero producer changes.
- **`?focus=ai-findings`**: room-hop to Review & Conditions + open
  sec-underwriting + scroll `#ai-findings`. **`?focus=chat`**: Messages &
  History + messages tab + `#conversations` (kept although currently
  producerless). **`?esign=`**: global toast, no room.
- **`?finding=<id>`**: today this link is DEAD (no handler; the pulse lives in
  an unmounted panel). Phase 1 adds the handler — parsing **both** URL shapes,
  since the producer emits the query inside the hash
  (`#/internal/app/:id?finding=`, invisible to `location.search`) exactly as
  the panel itself parses it (`UnderwritingPanel.jsx:2981-2987`).
- **Inner anchors** `#note-buyer-slot`, `#ctc-outstanding` (both callers:
  `:3968` AND `DealSnapshot.jsx:76`), `#conversations`, `#ai-findings` route
  through a tiny `revealAnchor()` that resolves the owning room first. When
  Phase 2 moves a widget, the old anchor id stays live on the new mount.
- **Server-stamped targets** (`r.section`/`r.condTab` from
  `staff.js:8596-8631`, including the legacy `'internal'` tab value the client
  already normalizes to `'borrower'` `:3654-3664`): all in the alias map; the
  server keeps emitting them unchanged until Phase 3.
- **Hidden-room degrade:** a deep link into a room the viewer can't see
  (sitewire→draws for a non-coordinator; `#sec-closing` pre-CTC for a
  non-closer) stays a silent no-op — exact parity with today.
- **Legacy names live forever as search synonyms**, so muscle memory always
  lands.
- **CI link test:** every fixture in the inventory above must resolve to a
  mounted, visible, open element — with per-fixture role/status context so
  gated configurations don't false-fail. Written against the NEW page (the
  `?finding=` fixture fails against today's page — it's a bug fix, not
  parity).

---

## 7. The build, in phases

Each phase ships alone. Every phase runs the repo's standard gates: rebuild
`web/v2/portal`, eslint `no-undef` on changed JSX, the two-audit-agent rule,
and the stale-build watchdog stays (StaffApplication remains inside
StaffLayout — no new shell).

### Phase 1 — the rooms (presentation-only; no server, no schema, no renames)

1. `app-v2/src/lib/stations.js`: `STATIONS` (7 defs wrapping the existing
   SECTIONS entries), `STATION_OF` alias map (all 17 sec-* ids + the four
   inner anchors), pure helpers + unit test.
2. `StaffApplication.jsx`: `activeStation` state; pinned header (identity bar
   + LoanProgress moved up + amount); the Next-up strip above the canvas;
   render ONLY the active room's existing `<Section>` blocks — components,
   ids, labels, badges, summaries, `defaultOpen`, full-screen all
   byte-identical. Retire the right aside (its facts re-homed per §5.2 —
   internal status becomes unconditional in the Status panel). Keep sec-draws
   `collapsible={false}`.
3. **The resolver shim** (the one genuinely new mechanic): Section bus
   listeners exist only while mounted (`FileSections.jsx:93-98`) and
   `goToSection` scrolls immediately (`:34-40`) — so `FileSections.jsx` gains
   an optional module-level resolver: `setSectionResolver(fn)`, registered by
   StaffApplication **in an effect with cleanup on unmount**, no-op for ids
   outside `STATION_OF` — the borrower screen and the Draw Center also use
   FileSections and must never be hijacked (red-team minor). `goToSection`
   consults it first (activate room, queue `{id, tab}`), a post-mount effect
   flushes through the existing `requestOpenSection` + `requestConditionsTab`
   + scroll.
4. **R1 (red-team major): the `?finding=` handler** — new, parsing both URL
   shapes; pre-activates Review & Conditions + opens sec-underwriting so the
   panel mounts and its own pulse runs.
5. **R2 (red-team major): cross-room ACTIONS** — the queue carries an optional
   post-mount action, so "Open the studio" from a condition row (via
   `studioRef.openStudio()`, ref alive only while sec-pricing is mounted,
   `:4301`) activates The Deal → opens sec-pricing → invokes the ref once it
   lands. Audit every ref-based jump the same way.
6. **R3 (red-team major): room badges** roll up only from page-level sources
   (§5.1); panel-reported summaries stay after-visit enrichment.
7. **Sticky offsets**: the taller pinned header (stepper + strip) breaks
   hard-coded offsets — `.file-top top:72px` (`styles.css:980`), `.file-nav
   top:152px/0` (`:989,:1096`), the tracker line 160 (`FileSections.jsx:164`),
   `#ai-findings scrollMarginTop:80`. All four move to a measured
   `--file-header-h` variable; phone strip gets `env(safe-area-inset-*)`.
8. "Full file (classic view)" toggle (today's render path behind a flag) +
   per-user opt-in preview with instant revert for one release + a "Where did
   X go" one-pager keyed by the old 17 labels. Never force-switch everyone on
   day one.
9. The CI deep-link test (§6), with role/status context per fixture.

**Deliberately NOT in Phase 1:** search (lands early in Phase 2 — the
transition month leans on 7 rooms + the cheat sheet; ship the search fast),
the Overview card split, any move of exports.

### Phase 2 — findability + finishing old business (client only)

- **Search** (§5.4) over places/conditions/documents with legacy synonyms +
  localStorage miss counts.
- **Overview command deck**: the ≤6-card split (including the Deal-facts card)
  + room map receipts; ClearToClose merges into the strip — **still excluding
  AI advisories** (hard rule).
- **Data sync (advanced)** pairing in The Deal (Encompass + ClickUp panels
  together).
- **Send to Investor grows up**: PostClosing + TprExport + MismoExport move in
  with new anchors + permanent aliases; room visibility = has visible
  children.
- **Finish old-blueprint 4b/4d**: fold the Underwriting tab (LoanConditionsPanel
  + its private filter + its add-form) and the LLC tab into the one conditions
  list. One list, one filter row, at last.
- **Peek drawer** (DocPreview grown) so condition↔document compare never
  leaves the room.
- **R4 (red-team major): do NOT blanket-keep visited rooms mounted.**
  UnderwritingPanel polls every 60s while mounted
  (`UnderwritingPanel.jsx:2636`), EsignFileSection every 20s
  (`EsignFileSection.jsx:84`), ChatThread runs typing timers — N hidden rooms
  would multiply pollers per open tab. Cap the kept-alive set to the last room
  (or none), persist scroll offsets + light state instead of live trees, and
  gate pollers on a visibility signal before any mounted-hidden variant ships.
- Role-default landing + quiet rooms + personal pin; clickable stepper dots.
- Also worth closing here: the still-open old-blueprint Move 8 half — "Post a
  condition" on a finding should finally create the condition (into the ONE
  list), per the owner's 2026-07-27 authorization.

### Phase 3 — server-aware polish

- `condTabForBlocker` + blocker `r.section` stamps + email templates emit
  room-aware links and stop emitting `'internal'` (sec-* anchors remain the
  permanent canonical addresses; aliases never deleted).
- Search actions + optional server search over email/chat/activity; palette
  telemetry (misses, room visits, classic-view usage, deep-link outcomes).
- Per-user default room on the staff profile.
- Old-blueprint Move 6 styling consolidation, room by room
  (UnderwritingPanel's 626 inline styles first).
- Retire the preview toggle; classic view stays forever for print/QC.

---

## 8. The reviews (what attacked this plan, and what it changed)

**Red team (against the real code): verdict "feasible; no blockers" — 0
blockers, 4 majors, 9 minors plus two spec nits.** Every major is folded in
above: the dead `?finding=` link + dual URL shapes (→ Phase 1 R1), cross-room
action refs (→ R2), mount-dependent badge sources (→ R3), Phase-2 poller
economics (→ R4). The minors and nits are folded in where they bite: the Deal-facts card, unconditional
internal status, the second `#ctc-outstanding` caller, resolver lifecycle
cleanup, has-visible-children room gating + hidden-room silent degrade,
advisory-exclusion on the strip toggle, explicit dark text on quiet labels,
the `--file-header-h` variable, palette-miss logging deferred to Phase 3, and
honesty that the two-level rail is new code (only `Section` is byte-identical
— `FileSections`' nav/tracker is reworked around `activeStation`).

**Owner-fit review (judged purely in the owner's words):** "Genuinely fewer,
not relabeled — the other rooms are not on the page at all… Phase 1 kills the
scrolling; Phase 2 delivers the 'nicely designed'." It renamed one room (Send
to Investor), banned internal jargon from the screen, and flagged the honest
costs, each now mitigated in the plan: the Phase-1 search gap (ship search
early in Phase 2; cheat sheet + classic view meanwhile), the week-one
muscle-memory reset (opt-in preview, never force-switch day one), Encompass
mirror-checkers gaining a click (it sits one expand deeper in The Deal), and
pricing-vs-conditions comparisons pending the Phase-2 peek drawer.

Staff "finally" list (what lands best): the to-do list follows you · you start
in YOUR room · conditions and their documents finally sit together · phones
work (7 chips fit one row) · the header always shows which deal you're in.

---

## 9. What this plan deliberately does not do

- **Nothing is deleted.** Every panel, button, filter, export and permission
  gate moves whole. Zero rows, zero features.
- **No behavior changes in Phase 1** beyond navigation itself — and two
  explicitly listed bug fixes (`?finding=` dead link; cross-room action
  jumps). The only Phase-2 behavior item is the owner-authorized 2026-07-27
  "Post a condition creates the condition".
- **No section id changes, ever.** `sec-*` are permanent addresses; aliases
  are additive-only.
- **The borrower screen is untouched.** It's already the clean sibling (10
  sections max, conditional ones vanish); the resolver is a no-op there.
- **AI stays advisory.** The Next-up strip and its Phase-2 toggle keep
  excluding advisories; no list here may become a gate.
- **No pricing/guideline engine, sync rule, or server contract is touched**
  before Phase 3's link-emission cleanup (additive even then).
- **No renames of things that work** — relocate, never rename; the one
  renamed surface is the new room label "Send to Investor" (a new surface,
  not an existing one).

---

## 10. How we'll know it worked

| Measure | Today | Target |
|---|---|---|
| Top-level places to look | 17 sections | **7 rooms** (typical LO sees 5) |
| Scroll to orient on a fresh file | ~27 screens | ~1 screen (header + strip + room) |
| Sections rendered that are noise for a draw coordinator | ~12 of 14 | 0 loud (quiet rooms + landing in Draws) |
| "What needs me" visibility | top of page only | pinned on every room |
| Ways to reach a named thing by typing | 0 | search over rooms/sections/conditions/docs/actions with 17 legacy synonyms |
| Filter systems in the conditions area | 5 (incl. a private 4-option filter on a tab) | 1 (after Phase-2 fold-in) |
| Legacy deep links that land correctly | ~100 minus 1 dead (`?finding=`) | 100%, CI-enforced |
| Features added / removed | — | **0 / 0** |
| Old layout available | n/a | forever ("Full file (classic view)") |

---

## 11. Evidence index (code claims)

| Claim | Where |
|---|---|
| 17 `<Section>` blocks; render order = rail order | `app-v2/src/screens/StaffApplication.jsx:3939-4475`; SECTIONS `:3850-3881` |
| 15 collapsed by default; Overview open; Draws non-collapsible | `:3939`, `:4475`; `FileSections.jsx:65` |
| Summaries on 9 of 17 sections | `:3807-3849` |
| Section children unmount when collapsed | `FileSections.jsx:138` |
| Bus listeners mounted-only; goToSection scrolls immediately | `FileSections.jsx:93-98`, `:34-40` |
| Conditions hub: 3 tabs + 5 filter systems | `:4278-4292`, `:2644-2679`, `:3278`, `:4587-4592` |
| 'internal' tab normalized client-side; server still emits it | `:3654-3664`; `src/routes/staff.js:8609-8615` |
| Overview contains 12 major widgets | `:3939-4128` |
| Right aside duplicates header/Overview facts | `:4516-4538` |
| Duplications (status ×6, loan # ×5, note buyer ×5, economics ×7, docs ×4+) | inventory §4 (agent report, from `:2973-2990`, `:4366-4431`, et al.) |
| Deep-link handlers (`?esign`, `#sec-*`, closer landing, `?focus=…`) | `:3181-3374` |
| `?finding=` producer exists, handler doesn't; pulse in unmounted panel | `StaffFindingEscalations.jsx:203-204`; `UnderwritingPanel.jsx:2975-2990` |
| External deep-linkers | `StaffOrders.jsx:119`, `StaffClosing.jsx:96`, `SyncReviews.jsx:250-264,508`, `ExceptionCard.jsx:57-136`, `StaffInsightsDashboard.jsx:203`, server: `admin-exceptions.js:335,352`, `closing-inbox.js:217`, `notification-digests.js:1160` |
| Server-stamped blocker targets | `src/routes/staff.js:8596-8631` |
| Section visibility gates | `:3717` (closing), `:3874` (tapes), `:3880` (draws), `:3855` (payoff) |
| Role capabilities | `src/lib/permissions.js` ROLE_DEFAULTS |
| Panel pollers (Phase-2 R4) | `UnderwritingPanel.jsx:2636`, `EsignFileSection.jsx:84`, `ChatThread.jsx:352` |
| Sticky offsets that must become measured | `styles.css:980,989,1096`; `FileSections.jsx:164` |
| Old-blueprint move status (shipped/partial) | §2.1 table, verified per item |
| Tab-shell precedents in this repo | `StaffApprovals.jsx:24-30`, `StaffAiCenter.jsx:21-28`, `StaffBorrowerDetail.jsx:46-83`, `StaffFileDraws` route |
| Borrower screen structure (the clean sibling) | `app-v2/src/screens/Application.jsx:830-841` |

## 12. Research appendix (external sources)

**LOS / lending industry.** Encompass eFolder & forms: ICE training PDFs
(help.icemortgagetechnology.com/training — IntroEnc.pdf, eFolder.pdf);
Enhanced Conditions: developer.icemortgagetechnology.com
(loan-enhanced-conditions API), mortgagetech.ice.com 20.2 release demo series,
25.1 web-conditions release notes (help.icemortgagetechnology.com), Lender
Toolkit 20.2 release notes; TPO Connect user guides (wholesale.thelender.com,
beinmortgage.com); Encompass web push: mortgagetech.ice.com SDK-transition
notice; Blend: blend.com platform-approach + Autopilot newsroom post; nCino:
ncino.com commercial-lending, G2/Capterra reviews; Floify: floify.com blog
(custom fields/layouts, milestone sets, audit log); LendingWise:
help.lendingwise.com required-docs, Capterra reviews; Mortgage Automator:
mortgageautomator.com, Capterra/GetApp reviews; Baseline:
privatelenderlink.com profiles; Liquid Logics: liquidlogics.com; The Mortgage
Office: themortgageoffice.com, SoftwareAdvice reviews; Lendesk/Finmo:
lendesk.com; LoanPro upgraded-UX blog: loanpro.io; Built draw workflow:
help.getbuilt.com, Draw Agent press: getbuilt.com; HouseCanary Property
Explorer: housecanary.com.

**Record-page UX.** Salesforce: Trailhead lightning_app_builder +
lightning-experience modules ("one long page… tons of scrolling"), Help tabs
docs; HubSpot: knowledge.hubspot.com record-layout + records docs,
blog.hubspot.com record customization; Attio: attio.com configure-record-pages;
Linear: linear.app/docs/peek; Airtable: support.airtable.com record-detail
layouts; NN/g: tabs-used-right, accordions-complex-content, vertical-nav,
progressive-disclosure, in-page-links, complex-apps-workflows; IBM Carbon
accordion/tabs usage; Shopify Polaris tabs; Atlassian tabs + side-navigation +
navigation blog; GOV.UK task-list pattern + one-thing-per-page + form-structure;
Epic: arhfoundation.org Storyboard explainer, uiowa Chart Review guide,
epicshare.org Chart Search (+OCR), Hopkins Epic tips.

**Consolidation lessons.** Encompass Enhanced Conditions (above +
awesometechinc.com, takefiveconsulting.org, mortgageworkflowpartners.com);
Jira new issue view: JRACLOUD-69983, JRACLOUD-70127, community threads (2025
navigation-refresh feedback); GitHub Issues 2025: github.blog changelogs +
sub-issues engineering post + community discussion 148713; GitLab
interface-redesign docs + work-item epic 18816; Zendesk Agent Workspace
migration guide + improved-ticket-tabs announcement; Intercom next-gen inbox
announcement + Cmd+K help; Gmail tabs retrospectives (yespo.io, smtpedia.com);
Salesforce Classic→Lightning adoption writeups (matchmyemail.com,
adminhero.com); command palettes: Superhuman blog, Retool design blog,
uxpatterns.dev; `hidden=until-found`: developer.chrome.com, css-tricks.com;
redirect-map discipline: urllo.com, artversion.com, hashmeta.com; role-based
views: SugarCRM role-based record views, NetSuite saved-search defaults,
Power Apps role-scoped views.

**What the research could not confirm** (recorded so nobody repeats it as
fact): exact in-loan tab names for Blend, Floify, Baseline, Liquid Logics and
Mortgage Automator (help centers unfetchable — patterns taken only where
documented); the phrase "Encompass merged persona tabs into one list" verbatim
(what IS documented: multiple per-phase condition tabs → one enhanced list
with persona permissions); Linear Inbox internals beyond snippets; Height as a
source at all (no citable docs); `hidden=until-found` is Chrome/Firefox-only
today (Safari TP) — treated as progressive enhancement, and it cannot reveal
collapsed sections whose children are unmounted anyway.

---

_Prepared 2026-07-31 on the owner's directive, by a 12-agent research fleet:
three system-mapping agents, three web-research agents, three independent
designers, one judge, two adversarial reviewers. Successor to
`docs/LOAN-FILE-SIMPLICITY-BLUEPRINT.md`; builds on its shipped moves and
finishes its unfinished ones (4b, 4d, 5, 6, 8) inside the new shape._
