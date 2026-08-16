# Unified "Appraisal order" section — UI design spec

**Status:** design spec, drives the frontend rebuild. No code here.
**Replaces:** `app-v2/src/components/AmcAppraisalPanel.jsx` (AppraisalScope / NAN) and
`app-v2/src/components/ClassAppraisalPanel.jsx` (Class Valuation), currently mounted
side-by-side under two `<VendorHeading>`s inside the `sec-order-appraisal` `Section` in
`app-v2/src/screens/StaffApplication.jsx` (~line 6062).
**Target:** ONE section titled **"Appraisal order"** with a vendor selector at the top, one
shared form, open active-order cards, and a single collapsed drawer for drafts + failed orders.

The V2/PILOT design system is white-first. **HARD RULE honored throughout:** all body text is
dark on the white canvas — `#141B22` (primary), `#4B585C`/`#3A4550` (secondary). Never a
`var(--ink*)` token for text (those resolve LIGHT and paint white-on-white); use `#141B22`,
`var(--text)`, or `var(--ivory)`.

---

## 1. What each current panel does — the feature audit

The owner says BOTH panels carry good enhancements worth keeping. Every feature below is
preserved in the unified section; the audit also records where each panel is bulky so the
rebuild can drop the clutter.

### 1a. AppraisalScope / NAN (`AmcAppraisalPanel.jsx`) — keep these

- **Config / connection line.** "Not turned on yet" dashed card, or a one-line `Connected ·
  outbound on/off · test mode` status. **Keep** (collapse into a small vendor-status chip).
- **Order preview / assumptions (`PreviewCard`).** The strongest NAN enhancement:
  - **Form picker** — the appraisal form (`productCode`) shown by NAME, changeable via a select,
    default auto-picked (`preview.spec.productCode` / `preview.chosenFormName`).
  - **"Client shown on the report" picker** (`clientDisplayedId`) — only appears when the account
    has >1 profile; auto-selected otherwise.
  - **Field grid** — Loan #, Property, Type, Purpose, Loan amount, Borrowers, Payment card.
  - **Missing-fields line** — "Still needed before ordering: …" (red) vs "Ready to order." (green).
  - **Notify emails** — "Update emails from the appraiser will go to: …".
  - **Two assumption blocks** — an **amber caution** block ("Before you order — please check",
    e.g. a stale closing date that won't be sent) and a neutral **"What PILOT filled in for you"**
    block. Amber palette `WARN #9A3412 / WARN_BG #FDF4E7 / WARN_LINE #EAD4AE`.
  - **Save draft** + **Place order with the AMC** (disabled while missing fields or outbound off).
- **Orders list, bucketed (`OrdersList`).** Live orders lead; **failed** ("Needs attention")
  and **draft** orders each collapse into their own `<details>` section.
- **Order row** — status pill, form description, property + `AMC #` + ordered date; on a failed
  order it inlines "Why it didn't go through: …".
- **Order detail (`OrderDetail`)** with a "What was ordered" summary grid + status, and tabs:
  - **Messages** — 2-way thread with the AMC, outbound/inbound bubbles, send box.
  - **Revisions & disputes** — (1) ordinary **revision / fix** + **scope-of-work change**
    (locked with a gold "report isn't back yet" note until `product_available`/`completed`);
    (2) **ROV / value dispute** via **`RovBuilder`** — dispute two values, search the Property
    Research Center for comps, add them (auto-filled details), or type a comp in manually,
    optional note, send. This is a keeper — it is the richest revision UX of the two.
  - **Documents** — checkbox list of the file's documents, "already sent" greying, upload
    selected to the order.
  - **Cancel order** — asks a reason (sent to the AMC), only when `sp_order_number` present and
    not already done/cancelling.
- **`OrderError`** — full vendor rejection with a **"Show technical details"** expander +
  **copy** button (raw last-status-response). Keep as the "full details" of a failed order.

**Where NAN is bulky:** every color is an inline hex literal; the preview card stacks form
picker + cdor picker + a 7-field flex grid + two assumption boxes + notify line + two buttons
in one long column; tabs are hand-built pill buttons; the RovBuilder is a 140-line inline form.

### 1b. Class Valuation (`ClassAppraisalPanel.jsx`) — keep these

- **Connection line (`ConnectionLine`)** — "isn't set up yet" / "isn't turned on yet, you can
  still see what would be sent" + a `sign-in details · connection on/off · ordering on/off ·
  TEST MODE` status line, plus an environment (UAT/PROD) note.
- **The provenance-colored field list — the strongest Class enhancement.** The owner's standing
  rule for Class: *"we need to make sure that we see all the fields that he's filling
  automatically before he's sending those over."* So Class lists **EVERY field that would be
  sent**, server-driven (never re-listed in JSX), each **colored by where its value came from**:
  - `read` = "From the file" (muted), `derived` = "PILOT worked this out" (gold), `overridden`
    = "You changed this" (teal), `missing` = "Still needed" (red).
  - A **legend**, a **"Show every field (N) / Show only what needs a look (N)"** toggle, an
    **"Undo my changes"** link, and inline **editable** rows (free text, or a pick-from-Class's-
    own-enum select) for the allowlisted fields.
- **UAD version picker (`VersionRow`)** — Class ships two forms (UAD 2.6 / 3.6). First on screen
  because the version decides what the other fields even are. Vendor-specific.
- **Product picker (`ProductRow` + `ProductPicker`)** — "Which report to order", auto-picked from
  admin rules or hand-picked from Class's full searchable catalog.
- **Contacts (`Contacts`)** — "Who Class will contact" (borrower / co-borrower / property access /
  loan officer, with primary-contact marks).
- **Missing list** + **Place order (`PlaceOrder`)** with per-switch **block reasons** in a gold
  **`WhyBox`** ("Class ordering is switched off — turn on X and Y on the API Health page"),
  a derived-count nudge, and a test-mode warning.
- **Orders list, bucketed (`PlacedOrders`)** — live lead; **failed** ("Needs attention") and
  **cancelled** ("Closed") collapse. Row shows Class order id, `UAD n`, ordered/ due/ inspection
  dates, an **unread "N new" badge**, and an "value disputed / revision asked" tag.
- **Order detail (`OrderDetail`)** — summary grid + tabs:
  - **Messages** — thread with **"Check for replies"** (pull/sync) + **"Mark read"** + per-note
    "not delivered" / "sending…" states.
  - **Ask for a fix** / **Dispute the value** — ONE `AskForm` (at Class a value dispute is a
    revision filed with value reasons): pick from **Class's own reason list** (common vs "show
    every reason Class accepts"), a free-text why, submit. Locked with a `WhyBox` until the
    report is in.
  - **What we've asked for (history)** — every revision/ROV/cancel with status + reasons.
- **Send-failure parity** — a failed send renders the SAME rich `OrderFailure` box a failed
  order does.

**Where Class is bulky:** four hand-built tab buttons, three stacked "row" cards (version /
product / field list) before you even reach contacts, and a very long field list that dominates
the panel even collapsed.

### 1c. Shared today

Both already share **`OrderFailure`** (`components/OrderFailure.jsx` + pure `lib/orderError.js`)
— a **vendor-stamped** failure box ("AppraisalScope / NAN could not place this order." / "Class
Valuation could not …") with reason, error code, HTTP status, "what their system reported", and
a "Show the full technical details" expander. **This is the model for the whole unification:**
one component, vendor name stamped on it, the two desks can never drift. The rebuild extends this
principle to the entire section.

---

## 2. Section anatomy — the wireframe in words

```
┌─ Appraisal order ───────────────────────────────────────────────── (Section) ─┐
│                                                                                 │
│  ┌─ Header row ───────────────────────────────────────────────────────────┐   │
│  │  "New appraisal order"            [ AppraisalScope / NAN | Class ]  ⓘ   │   │  ← .seg vendor selector
│  │  vendor status chip: ● Connected · sending on · test mode              │   │
│  └────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  ┌─ Order builder (.act-card, one per file) ──────────────────────────────┐   │
│  │  FORM / PRODUCT   [ picker ▾ ]        (+ vendor-specific: UAD version,   │   │
│  │                                          "client shown on report")      │   │
│  │  ── shared basic details grid (Loan#, Property, Type, Purpose, …) ──    │   │
│  │  ⚠ Before you order — please check  (amber)                             │   │
│  │  What PILOT filled in for you        (neutral)                          │   │
│  │  [ Review all fields (N) ▾ ]   ← Class provenance list lives here       │   │
│  │  Still needed: …  /  Ready to order.                                    │   │
│  │  [ Save draft ]                              [ Place order · NAN ]       │   │  ← .btn.soft / .btn.primary
│  └────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  ACTIVE ORDERS  (open by default)                                               │
│  ┌─ Active order card ────────────────────────────────────────────┐  ┌──────┐ │
│  │  [FNM1004 · 1004 URAR]                    ● In review           │  │ NAN  │ │  ← vendor stamp rail
│  │  129 Carlisle St · AMC #48213 · ordered 07/12                   │  │ stamp│ │
│  │  ●━━━━●━━━━●━━━━○━━━━○   Placed·Scheduled·Inspected·Review·Report │  └──────┘ │  ← normalized timeline
│  │  [ Details ▾ ]                                                   │           │
│  │  Messages · Documents · Revision · [ Pay $650 ]                  │           │  ← .act-bar
│  └─────────────────────────────────────────────────────────────────┘           │
│                                                                                 │
│  ▸ Past & failed orders (3)                                                     │  ← ONE collapsed drawer
└─────────────────────────────────────────────────────────────────────────────────┘
```

Component tree (all under one `AppraisalOrderSection` that replaces both panels):

```
AppraisalOrderSection(appId)
├─ OrderHeader
│  ├─ VendorSelector            (.seg — AppraisalScope / NAN · Class)
│  └─ VendorStatusChip          (connected / outbound / test-mode; per selected vendor)
├─ NoticeBanner                 (success/notice; OrderFailure for build/place errors)
├─ OrderBuilder (.act-card)     (the "new order" area for the selected vendor)
│  ├─ ProductRow                (form/product picker — always)
│  ├─ VendorExtras              (NAN: client-shown-on-report · Class: UAD version)
│  ├─ BasicDetailsGrid          (shared summary of what will be sent)
│  ├─ AssumptionsBlock          (amber cautions + neutral "what PILOT filled")
│  ├─ FieldReview (<details>)    (Class provenance list / NAN full spec — "Review all fields")
│  ├─ ReadinessLine             (missing → "Still needed" / "Ready to order")
│  └─ BuilderActions            (Save draft · Place order · <vendor>)
├─ ActiveOrders                 (open cards, newest first, both vendors interleaved)
│  └─ ActiveOrderCard[]         (see §5)
└─ PastAndFailedDrawer (<details>, collapsed)   (see §7)
```

**One shared store.** The section fetches BOTH vendors' config + orders once (`amcConfig`,
`amcOrders`, `classConfig`, `classOrders`) and previews only the **selected** vendor
(`amcPreview` / `classPreview`) so switching vendors never re-fetches the order lists. The
active-order cards and the drawer render orders from **both** vendors together (each carries its
own vendor stamp), because "the file's appraisal orders" is one list to the user even though two
backends produced it. The builder is the only vendor-scoped part.

---

## 3. The vendor selector

**Pattern: the `.seg` segmented control** (already in `styles.css` @4152). Two segments:
**AppraisalScope / NAN** (leftmost, the natural first choice) and **Class**. It sits top-right of
the header row; the on-segment uses `--primary-soft` background + `--primary-hover` text.

- **No default is chosen for the file.** The owner's standing note: "none of them are ready right
  now, we don't need to set a default." The selector defaults to **AppraisalScope / NAN** as the
  *display* starting point only (matching the current left-to-right order and the requirement
  "default AppraisalScope / NAN, switchable to Class"). Selecting a segment does not register a
  file-level preference — it just chooses which backend the **builder** targets and which
  vendor's preview loads.
- **What the selector changes:** which vendor the "Place order" button submits to (`amcPlaceOrder`
  vs `classPlaceOrder`), which preview call runs, and which vendor-specific extras render. It does
  NOT change the active-orders list or the drawer (both always show all orders from both vendors).
- **Vendor status chip** sits under the segmented control and reflects the SELECTED vendor:
  a small `.dd-chip`-style pill — `● Connected · sending on · test mode`, or `● Not turned on yet`
  when `!config.enabled`. Dot color: `--success` connected, `--warning` off, `--text-soft` not set
  up. When a vendor is not configured, the builder shows the "you can still see what would be sent"
  read-only preview (Class already does this) and disables Place order with a plain reason.
- **Accessibility / RTL:** the platform is RTL; `.seg` is `inline-flex` and already stacks
  vertically under 720px. Keep the vendor names LTR-safe (they're proper nouns). `aria-pressed`
  on each segment.

---

## 4. The one shared form — shared vs vendor-specific fields

The goal (owner req #1): **the form + fields look as SIMILAR as possible across vendors; only the
genuinely vendor-specific options differ.** The builder is ONE component with the same layout for
both vendors; a thin per-vendor adapter supplies the pieces.

### 4a. Always present (identical layout both vendors)

| Slot | NAN source | Class source |
|---|---|---|
| **Product / form picker** (`ProductRow`) | `preview.forms` + `formOverride` (productCode) | `preview` product picker + `overrides.productId` (searchable Class catalog) |
| **Basic details grid** | `spec` (Loan #, Property, Type, Purpose, Loan amount, Borrowers, Payment card) | `preview.body` fields (Property, purpose, loan type, occupancy, reference #, due date) |
| **Assumptions — amber cautions** | `assumptions.filter(a=>a.warn)` | derived-field callouts (`state==='derived'` rows summarized) |
| **Assumptions — "what PILOT filled"** | `assumptions.filter(a=>!a.warn)` | the `derived` provenance rows |
| **Field review** (`<details>` "Review all fields (N)") | the `spec` shown as a read-only key/value list | the full **provenance-colored, editable** field list + legend + "show every field" toggle |
| **Notify emails** | `preview.notifyEmails` | `preview.notifyEmails` |
| **Readiness line** | `preview.missing` | `preview.missing` (bulleted `why`) |
| **Actions** | Save draft · Place order · **NAN** | Save draft (n/a today — add) · Place order · **Class** |

**Field review is where the two enhancements meet.** NAN currently has no full field list; Class's
provenance list is the better idea. In the unified builder, **both vendors get a "Review all
fields (N)" `<details>`**. For Class it renders the existing server-driven provenance list
(read/derived/overridden/missing, editable, legend). For NAN it renders the `spec` the same way —
read-only where NAN has no override, editable for the two NAN overrides (form, client-shown). The
visual shell (row = label + provenance dot + value/editor + `why`) is identical; only which rows
are editable differs. This directly satisfies "see all the fields before they're sent" for BOTH
vendors, and makes NAN look like Class rather than the reverse.

### 4b. Genuinely vendor-specific (render in a `VendorExtras` slot right under the product picker)

- **NAN only:** **"Client shown on the report"** picker (`clientDisplayedId`) — only when the
  account has >1 profile.
- **Class only:** **UAD version** picker (2.6 / 3.6) — first among the extras because it decides
  the field set. Render it as a `.seg` too (two versions, "normal" marked), so it visually rhymes
  with the vendor selector without being confused for it (place it inside the builder card, under
  the product row, labeled "Which of their forms").
- **Class only:** the "Who Class will contact" **Contacts** list — fold it into the field-review
  `<details>` (it is reference detail, not a decision), or keep as a small labeled sub-list below
  the grid. Keep it Class-only; NAN has no equivalent.

**Rule for the adapter:** anything a vendor does not have simply doesn't render — the shared layout
never shows an empty NAN "UAD version" or an empty Class "client shown on report" row. The shared
rows (product, grid, assumptions, review, readiness, actions) are always in the same order and the
same components, so a person moving between vendors sees the same shape with different contents.

### 4c. Place-order gating (unified `WhyBox`)

Both vendors block Place order for their own reasons; unify the presentation on Class's **`WhyBox`**
pattern (gold-bordered callout that always explains the greyed button in one place):
- NAN: missing fields, or outbound off ("Sending to the AMC is off — save a draft now").
- Class: not `canPlace`; connection off; outbound off; test mode; derived-count nudge.
The Place-order button label carries the vendor: **"Place order · AppraisalScope / NAN"** /
**"Place order · Class"** — so even mid-builder the person sees which backend they're about to hit.
On success show a green `NoticeBanner` ("Order placed with AppraisalScope / NAN.").

---

## 5. The active-order card

Active = placed and not draft/failed. **Shown OPEN by default** (owner req #3). Both vendors'
active orders render as the SAME `ActiveOrderCard`, newest first, interleaved, each stamped with
its vendor.

### 5a. Anatomy (built on `.act-card`)

```
┌──────────────────────────────────────────────────────────────┐ ┌────────┐
│  PRODUCT/FORM          basic details row            ● status  │ │  NAN   │  ← vendor stamp rail
│  1004 URAR             129 Carlisle St · AMC#48213 · 07/12     │ │ (gold  │
│                                                                │ │  side) │
│  ●━━━━━●━━━━━●━━━━━○━━━━━○                                      │ └────────┘
│  Placed  Scheduled  Inspected  In review  Report               │  ← StatusTimeline (§6)
│                                                                │
│  [ Details ▾ ]   ← expand to full "everything sent + status + timeline detail"
│                                                                │
│  ── action bar (.act-bar) ──                                   │
│  Messages(2) · Documents · Revision      [ Pay $650 ]          │
└──────────────────────────────────────────────────────────────┘
```

- **Vendor stamp** — a fixed rail/badge on the **inline-end side** of the card (RTL: the left in a
  Hebrew layout; use a flex order that keeps it "on the side" per the requirement). A small
  vertical gold bar + the vendor short name: **"NAN"** or **"Class"**. Reuse the `VendorHeading`
  visual language (4px gold bar `#AE8746` + bold `#141B22`) turned into a compact side stamp.
  This is the single clearest signal of "which vendor it was ordered with" and must be visible
  without expanding.
- **Product / form** — bold `--text`, top-left: NAN `form_description` (or "Form <productCode>"),
  Class product name/`Class order <id>` + `UAD n`.
- **Basic details row** — muted `--text-muted`, one line: property · vendor order number
  (`AMC #cdg_order_number` / `Class order class_order_id`) · ordered date · due/inspection date if
  present · `· test` when dryrun. This is the "basic details visible outside" (req #3).
- **Status pill** — top-right, colored by the normalized status (see §6). Reuse the pill shape
  (`border + color`, `border-radius:999px`).
- **Status timeline bar** — the normalized milestone stepper (§6), always visible on the open card.
- **Expand to full details** — a `Details ▾` toggle (native `<details>` or a controlled expander).
  Expanded shows: the **"What was ordered"** summary grid (every field sent — the existing
  `order.summary`), the **current status** in words, and a **detailed timeline** (each milestone
  with its date + any revision states). This is the "clicking expands to the full details
  (everything sent + current status + timeline)" of req #3.
- **Action bar (`.act-bar` / `.act-group`)** — grouped, weighted (owner's "everything a little more
  modern, buttons in a nice place"):
  - **Messages** — `.btn.soft`, with an unread count badge when the vendor exposes one (Class
    `unread`; NAN comments). Opens the thread inline (expandable panel) or in the Details area.
  - **Documents** — `.btn.soft`, opens the document upload + list.
  - **Revision** — `.btn.soft`, opens the revision / dispute UI (NAN: revision + SOW change + ROV
    builder; Class: fix + value dispute reason-picker). Gate identically: locked until the report
    is in, with the same gold note.
  - **Pay** — `.btn.primary` (money moves → the loudest), right-aligned via the `.act-bar` flex.
    Label carries the amount when known: **"Pay $650"**, else **"Pay"**. See §8.
  - **Cancel order** — a quiet `.btn.ghost` in a right-most `.act-group` labeled nothing, only when
    cancellable (NAN `sp_order_number` present + not done; Class equivalent). Never as loud as Pay.
- The action row uses `.act-group` clusters with an `.act-sep` hairline between the
  "communicate" cluster (Messages · Documents · Revision) and the "money" cluster (Pay · Cancel),
  so Pay never reads as just another button in a flat row (the exact bulk the owner complained
  about on the draw desk).

### 5b. The sub-surfaces (Messages / Documents / Revision) — unified, vendor-adapted

Rather than the current per-panel tab strips, each opens as an inline expandable region under the
action bar (only one open at a time), so an active card stays compact until you act:

- **Messages** — the 2-way thread. Bubbles: outbound (`--primary-soft`) end-aligned, inbound
  (`--surface-soft`) start-aligned, author + date. Send box + `.btn.primary` Send. Vendor extras:
  Class adds **"Check for replies"** (`.btn.soft`, pull) + **"Mark read"** (`.btn.ghost`); NAN has
  neither. This satisfies "including messages the team posted in the vendor's own portal" — both
  backends already fold portal-side messages into the thread (`amcComments` / `classThread.notes`).
- **Documents** — the file's documents as a checkbox list (already-sent greyed), "Send N to the
  order" `.btn.primary`. Identical both vendors (`amcDocuments`/`amcUploadDocs` vs the Class
  equivalent). Note "scope of work + contract sent automatically" stays.
- **Revision** — the richest shared surface. Two sub-modes exposed with a `.seg`:
  **"Ask for a fix"** and **"Dispute the value"** (mirrors Class's two tabs and NAN's revision vs
  ROV). "Ask for a fix" = free-text (+ NAN "scope-of-work change"). "Dispute the value" = the NAN
  **`RovBuilder`** (comp search + manual comp + two values + note) for NAN, and the Class
  **reason-picker `AskForm`** for Class. Both share the "locked until report is in" gold note and
  the "what we've asked for" history list below the form. Keep both builders — they are the good
  enhancements; only the shell (heading, seg, history) is shared.

---

## 6. The normalized status timeline

Owner req #4: a notification/status bar showing progress to the parties —
**order placed → inspection scheduled → inspection completed → report completed/in**, plus
revision states. Both vendors expose these via different mechanisms; the UI shows ONE normalized
timeline and maps each vendor's raw status onto it.

### 6a. The five canonical milestones

```
①Placed  →  ②Inspection scheduled  →  ③Inspection completed  →  ④In review  →  ⑤Report in
```

Rendered as a horizontal stepper (reuse the `.loan-prog` / `.dd-meter` visual language already in
the app): filled dots + connecting bar up to the current milestone, hollow ahead. Current
milestone label in `--text`, past in `--text-muted`, future in `--text-soft`. On a phone it wraps
or scrolls in its own `overflow-x:auto` container (never widens the card).

### 6b. Per-vendor mapping (the adapter's status table)

| Canonical milestone | NAN (`STATUS_LABEL` / order fields) | Class (`ORDER_STATUS` / order fields) |
|---|---|---|
| ① Placed | `ordered`, `in_process` | `ordered`, `in_process` |
| ② Inspection scheduled | `assigned` (Assigned to appraiser) + inspection date if any | `assigned` (With the appraiser) + `appointment_date` |
| ③ Inspection completed | `inspected` | `inspected` |
| ④ In review | `in_review` | (Class has no distinct review state → merge into ③→⑤; show ④ only if data supports it) |
| ⑤ Report in | `product_available` (Report ready), `completed` | `completed` (Report ready) |

**Off-track / overlay states** (rendered on the timeline as a colored badge, not a step):
- `on_hold` / `cancel_requested` → amber "On hold" / "Cancelling…" overlay (`--warning`).
- `cancelled` / `rejected` → the timeline greys out with a "Cancelled" / "Rejected" cap.
- `error` → the card is not "active"; it moves to the drawer (see §7).
- **Revision states** — when a revision/ROV/dispute is open (`asks`/`revisions`), show a gold
  "Revision requested" / "Value disputed" chip beside the current milestone. When a revision comes
  back, the milestone reflects the vendor's re-issued status. Keep the "requested / delivered /
  resolved" wording from the existing revision history.

The mapping lives in ONE place (`statusToMilestone(vendor, raw, order)`), so the two desks can
never disagree on what "inspected" means — the same discipline `OrderFailure` uses for errors.
Both vendors already carry the inspection/appointment date (`appointment_date` on Class;
inspection date threaded on NAN), so ② can show the scheduled date and ③ the completed date.

### 6c. Status color

Reuse a single normalized `milestoneColor(status)`: green (`#1E7B4F`) for report-in/completed,
teal (`--primary`) for in-flight, amber (`--warning`) for on-hold/cancelling, red (`#B4453B`) for
cancelled/rejected. Both panels already have near-identical `statusColor`/`ORDER_STATUS` color
maps — collapse them into one.

---

## 7. The collapsed drafts + failed drawer

Owner req #2: **draft orders and FAILED orders are auto-COLLAPSED — they do not show by default;
they sit collapsed at the bottom and expand only on click.** When expanded, show full details of
each draft/failed order (everything sent to the vendor, the error, etc.).

- **ONE drawer** for the whole section, titled **"Past & failed orders (N)"** — a single
  `<details>` (native, so it's keyboard/AT-friendly and starts closed). N = drafts + failed +
  cancelled/closed, across BOTH vendors. This replaces the current TWO separate collapse sections
  per panel × two panels (four `<details>` today) with one.
- Inside, three light sub-groups (only rendered when non-empty), in this order:
  1. **⚠ Needs attention (N)** — failed orders (`status === 'error'`). Each row leads with its
     **vendor stamp**, the form/product, the property, and inlines **"Why it didn't go through"**.
     Expanding a failed row shows the full `OrderFailure`/`OrderError` box — reason, code, HTTP
     status, "what their system reported", the **"Show technical details"** raw expander + copy,
     AND the **"What was ordered"** grid (everything that was sent). This is the "full details of
     each failed order" of req #2.
  2. **Drafts (N not sent yet)** — NAN drafts. Row → vendor stamp + form + property + "Drafts —
     not sent yet". Expanding shows the full spec grid and a **Place / Delete** action.
  3. **Closed (N)** — cancelled orders (both vendors). Row → vendor stamp + status + reason.
- The "⚠ Needs attention" sub-group border/background uses the existing bad tone
  (`#E4B4AE` border / `#FDF6F5` bg) so a failure reads as a failure even collapsed; the drawer
  summary line shows a small red count when any failed orders exist (so a person knows to open it
  without it dominating the page).
- **Never auto-open** except: if there are NO active orders and there ARE failed ones, the drawer
  may default-open (matching NAN's current `defaultOpen={!live.length}`), so a file whose only
  order failed doesn't hide the failure entirely.

---

## 8. The Pay flow

Owner req #5. The **appraisal payment card is already a condition** (`tool_key='appraisal_card'`,
`application_payment_cards`, satisfied → condition moves to `received`). The Pay button opens that
existing card form, pre-filled if already filled, and on success clears the condition.

### 8a. Where Pay lives

- **On each active order card**, in the money cluster of the `.act-bar`, as the `.btn.primary`
  (the loudest action, right/inline-end). Label **"Pay $<fee>"** when the vendor preview/order
  exposes a fee, else **"Pay"**.
- **State on the button:**
  - **Card not on file** → `Pay` (primary). Opens the modal to the empty card form.
  - **Card on file, condition not yet cleared** → `Pay` (primary) — the card exists
    (`card.onFile` / `application_payment_cards` row) but payment hasn't been confirmed/condition
    cleared. Opens the modal **pre-filled** from `staffAppraisalCard(appId)`.
  - **Paid / condition cleared** → the button becomes a quiet `.btn.soft` **"Paid ✓ · ••4242"**
    (or hides behind the Details expander), showing brand + last4. Never a loud primary once done.

### 8b. The pay modal (reuse `AppDialog`/the `.cv-modal` shell + `StaffCardEntry` fields)

A centered `.cv-modal` (bottom sheet on phones) titled **"Pay the appraisal order"**:

```
┌─ Pay the appraisal order ─────────────────────────────┐
│  AppraisalScope / NAN · 1004 URAR · 129 Carlisle St    │  ← what's being paid (vendor + form + property)
│  Amount: $650                                          │
│                                                        │
│  Card number   [ 4242 4242 4242 4242 ]                 │  ← pre-filled from staffAppraisalCard
│  MM [12]  YYYY [2027]  CVC [•••]  ZIP [11249]           │
│  ☐ Save this card to the borrower's profile for reuse  │  ← existing save_card_for_reuse opt-in
│                                                        │
│  [ Cancel ]                        [ Pay $650 ]         │
└────────────────────────────────────────────────────────┘
```

- **Pre-fill:** on open, `GET staffAppraisalCard(appId)` → if a card exists, fill number (masked
  or full per the existing reveal audit rules), MM/YYYY/CVC/ZIP. The existing `StaffCardEntry`
  fields (number, expMonth, expYear, cvc, ZipInput) are the exact inputs — the pay modal is that
  form in a dialog with a "what's being paid" header on top. Validation is the shared
  `validateCardInput` (Luhn, expiry, CVC, ZIP) — the same server contract, so the modal shows the
  same plain-language errors ("That does not look like a valid card number …").
- **Submit:** `POST staffSaveAppraisalCard(appId, form)` (which encrypts at rest and flips the
  `appraisal_card` condition to `received`). If "save for reuse" is ticked, the existing
  `saveCardForReuse` path runs. Then trigger the vendor payment (the card is what the back office
  charges the order on; if/when a live charge endpoint exists it is called here — today saving the
  card + clearing the condition IS the pay step, matching the current model).
- **Feedback:**
  - **Success** → green inline confirmation in the modal ("Card saved — the appraisal payment
    condition is cleared."), the modal closes, the card's Pay button flips to **"Paid ✓ · ••4242"**,
    and the section re-fetches so the `appraisal_card` condition shows satisfied/received. Fire the
    parent `onChanged` so the file's condition list updates in lock-step (the condition-cleared
    confirmation the owner asked for).
  - **Failure** → the SAME `OrderFailure`-style box inside the modal (reason + code), vendor-
    stamped where the failure is vendor-side, or the validation message where it's the card. Never
    a bare `alert()` — use the section's error surface / `showMessage` per the app's dialog rule.
- **Condition-cleared confirmation** — because the card condition lives in the file's condition
  list too, after a successful pay the section shows a one-line success banner AND the underlying
  `appraisal_card` condition (rendered elsewhere on the page) flips to received; the Pay flow is
  the single place both update. If the card was already on file and the condition already cleared,
  opening Pay shows the pre-filled read-only summary with an **"Update card"** action rather than
  re-charging.

### 8c. Security / rules carried over

- Never log card data; the reveal of an on-file card is audited (existing behavior). The modal's
  pre-fill uses the audited `staffAppraisalCard` read.
- The card is the file's borrower's card even when a staffer enters it (existing
  `saveApplicationCard` semantics). No change.
- All modal text dark on white per the HARD RULE; the amount + last4 use tabular numerals.

---

## 9. Making NAN and Class look maximally similar

The unification principle: **one shell, per-vendor adapters, differences only where the vendor
genuinely differs.** Concretely:

1. **One `AppraisalOrderSection`** replaces two panels. It owns the vendor selector, the shared
   store, the builder shell, the active-order list, and the drawer.
2. **A `vendorAdapter` object per vendor** supplies: display name + short stamp; config/preview/
   orders/place API calls; the status→milestone map; the list of extra builder rows; the revision
   builder (RovBuilder vs reason-picker); the messages extras (Class pull/mark-read). Everything
   else is shared components.
3. **Identical component shells** for: order builder card, basic-details grid, assumptions blocks,
   "Review all fields" `<details>`, readiness line, active-order card, status timeline, messages
   thread, documents list, revision shell, the drawer, and the pay modal. The two vendors flow
   through the same JSX; only the adapter data differs.
4. **One error surface** (`OrderFailure`, already vendor-stamped) and **one success banner**.
5. **One status vocabulary** — the five canonical milestones + the color map, mapped from each
   vendor's raw status in one function. NAN's `STATUS_LABEL`/`statusColor` and Class's
   `ORDER_STATUS` collapse into it.
6. **Where a vendor lacks a concept, the row simply doesn't render** (NAN has no UAD version;
   Class has no "client shown on report"); the surrounding layout is unchanged, so the two look
   the same minus one row rather than structurally different.

Result: a person who has ordered with NAN can order with Class with zero relearning — same builder,
same card anatomy, same timeline, same Pay button, same drawer — and the only visible differences
are the UAD-version picker (Class) vs client-shown picker (NAN) and the two revision builders.

---

## 10. Concrete use of existing `styles.css` classes + tokens

Everything below already exists in `app-v2/src/styles.css` (line refs approximate) — reuse, don't
reinvent.

- **Vendor selector + UAD-version picker + revision sub-mode:** `.seg` + `.seg > button(.on)`
  (@4152). Stacks vertically < 720px already.
- **Order builder + "section owns its action":** `.act-card` / `.act-card-head` /
  `.act-card-title` / `.act-card-sub` (@4135).
- **Action bar on the active card:** `.act-bar` / `.act-group` / `.act-label` / `.act-sep` (@4116)
  — group "communicate" vs "money" with an `.act-sep` between them.
- **Buttons, weighted:** `.btn.primary` (Place order, Pay — money/commit), `.btn.soft` (Messages,
  Documents, Revision, "Review all fields", "Check for replies" — utility, @4108), `.btn.ghost`
  (Cancel, Mark read, secondary — @4103), focus ring `.btn:focus-visible` (@4113).
- **Money read-out (fee, on the expanded card / pay modal):** `.act-figs` + `.act-figs .rule`
  + `.act-figs .tot` (@4143) — the continuous rule above a total.
- **Blocking-reason / next-step notes (readiness, "locked until report in"):** `.dd-note` +
  `.dd-note.warn` / `.dd-note.next` (@4308) — one class, two tones, replaces the hand-drawn bullets.
- **Status pills / chips:** the existing pill shape (`border:1px solid <color>; border-radius:999px`)
  and `.dd-chip` / `.dd-chip.warn` (@194) for the vendor status chip and revision chips.
- **Card house style (expanded details, contacts sub-list):** `.dd-card` / `.dd-card-h` (@237),
  `.dd-field-l` (@245) for label/value pairs.
- **Timeline visual language:** `.loan-prog`/`.lp-*` (the in-loan stepper) or `.dd-meter`/`.dd-meter > i`
  (@211) for the filled-to-current bar.
- **Modal:** `.cv-modal` / `.cv-modal-back` (the app's modal shell, bottom sheet on phones) for the
  Pay dialog; route messages through `AppDialog`/`showMessage`, never `alert()`.
- **Tokens** (`:root`, @11–37): text `--text`/`#141B22`, `--text-muted`/`#4B585C`,
  `--text-soft`/`#636B6E`; surfaces `--surface`/`#FFFFFF`, `--surface-soft`/`#F4F1EA`; borders
  `--border`/`#D9D4C8`, `--border-strong`/`#C7C0B0`; interaction `--primary`/`#2F7F86`,
  `--primary-hover`/`#1F5A60`, `--primary-soft`/`#E4EFF0`, `--primary-border`/`#AECFD1`; brand
  `--gold`/`#AE8746` (rules/marks) and `--gold-ink`/`#856529` (gold-as-text); status
  `--success`/`#2A6E55`, `--warning`/`#8A5F14`; `--radius`/4px; deep teal link `--teal-br`/`#256168`.
- **Amber "caution" palette** (already used in `AmcAppraisalPanel`, keep as-is for the pre-order
  "please check" block): `WARN #9A3412 / WARN_BG #FDF4E7 / WARN_LINE #EAD4AE` — dark amber text on
  a light amber card, AA on white.

### Small new CSS to add (namespaced `.aord-*` to avoid collisions)

Keep it tiny; most needs are met by the classes above. Add only:

- `.aord-stamp` — the vendor stamp side rail on the active card: a small flex column /
  badge pinned to the inline-end, a 4px `--gold` bar + the vendor short name in bold `#141B22`
  (the `VendorHeading` language turned vertical/compact). One rule + a `@media(max-width:720px)`
  that drops it above the card header instead of beside it.
- `.aord-timeline` / `.aord-step` / `.aord-step.done/.now/.todo` — the normalized stepper, if the
  existing `.loan-prog` isn't reused verbatim. Must wrap/scroll in its own `overflow-x:auto`
  container so it never widens the card (the app's standing mobile rule).
- `.aord-vendor-chip` — the connection status chip under the selector (or reuse `.dd-chip`
  outright; prefer reuse).

Everything else — builder, buttons, action bar, notes, modal, money read-out — is existing classes.
**No color may be defined only inside a dark/`@media` block; all text is explicit dark hex or a
confirmed-dark token.** Namespace every state modifier (`.aord-step.now`, never a bare `.now`) —
the codebase has already been bitten by a global `.off`/`.on` utility collision.

---

## 11. Data / API notes for the adapter (no backend change required)

The unified section is a pure frontend rebuild over the existing endpoints:

- **NAN:** `amcConfig`, `amcPreview(appId, overrides)`, `amcOrders(appId)`, `amcPlaceOrder`,
  `amcComments`/`amcPostComment`/`amcReadComment`, `amcRevisions`/`amcPostRevision`,
  `amcRovComps`/`amcRovCompSearch`/`amcPostRov`, `amcDocuments`/`amcUploadDocs`,
  `amcCancelOrder`. Overrides: `formOverride` (productCode), `cdorOverride` (clientDisplayedId).
- **Class:** `classConfig`, `classPreview(appId, overrides)`, `classOrders(appId)`,
  `classPlaceOrder`, `classThread`/`classThreadSync`/`classNote`/`classMarkRead`,
  `classRevision`/`classReasons`, `classProducts`, `classCancelOrder`. Overrides: `apiVersion`
  (UAD), `productId`, and the editable field allowlist.
- **Pay:** `staffAppraisalCard(appId)` (pre-fill, audited), `staffSaveAppraisalCard(appId, form)`
  (save + clear condition). Validation `appraisal-card.validateCardInput`.
- **Errors:** `parseOrderFailure` / `vendorSummary` (pure, in `lib/orderError.js`) →
  `<OrderFailure vendor=… />`. Reuse everywhere (build, place, message, revision, cancel, pay).

Three small pure adapters to add on the frontend (no server work):
1. `statusToMilestone(vendor, rawStatus, order)` → one of the five canonical milestones + overlay.
2. `vendorAdapter(vendor)` → `{ name, stamp, api, extras, revisionBuilder, messageExtras }`.
3. `orderFee(vendor, order|preview)` → the fee to show on the Pay button / `.act-figs`, or null.

---

## 12. Build & verification checklist

- Replace the two `<VendorHeading>` + `<AmcAppraisalPanel>` / `<ClassAppraisalPanel>` mounts in
  `StaffApplication.jsx` (`sec-order-appraisal`, ~line 6069) with one `<AppraisalOrderSection appId={id} />`.
- Keep the section's `info` copy (it already explains "two places can do it — you pick which one
  per file; neither is the default").
- Delete `AmcAppraisalPanel.jsx` / `ClassAppraisalPanel.jsx` only after the shared shell + both
  adapters reach feature parity (every feature in §1 present).
- Verify all text is dark on white (grep for `var(--ink` in the new files — every hit is the
  white-on-white bug). Confirm no bare-class state modifiers.
- Confirm the section renders both vendors' orders in one active list + one drawer; that switching
  the vendor selector only re-scopes the builder; that a failed order lands in the drawer with full
  technical details; that Pay pre-fills, clears the `appraisal_card` condition, and flips to
  "Paid ✓".
- Rebuild `web/v2/portal` from `app-v2/src` after implementing (Render does not build the frontend).
- eslint `no-undef` on the new `.jsx` (an undeclared identifier builds clean and throws at render).
```
