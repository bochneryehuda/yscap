# Appraisal order — feature + interface enhancements

**Status:** design + research spec. No code here. Drives the unified-panel rebuild.
**Builds on (do NOT re-read as new — this extends them):**
`UNIFIED-UI-SPEC.md` (the section wireframe + Pay flow), `NAN-FEATURE-INVENTORY.md` (AppraisalScope/CDG
API), `CLASS-FEATURE-INVENTORY.md` (Class Valuation API), `CURRENT-ARCHITECTURE.md` (what exists on `main`).
**Scope:** RTL only. Both vendors (AppraisalScope / NAN `src/amc/*`; Class Valuation `src/class/*`) stay
backend-separate; everything below merges only in the **frontend + a thin adapter/read layer**, exactly the
discipline `CURRENT-ARCHITECTURE.md §5` sets out.
**Owner intent (the north star):** ONE beautiful appraisal-order section where **both vendors look almost
identical** — you pick which vendor to place with, and every order shows with a **vendor stamp + base info**.
Only the backend differs; a vendor row is greyed out **only** where that vendor genuinely can't do the thing,
with the reason shown.

All portal text is **dark on white** (`#141B22` primary, `#4B585C` secondary) — never a `var(--ink*)` token
(those resolve LIGHT). This is the standing HARD RULE and it governs every new component below.

---

## 0. Plain-language summary (for the owner)

Right now the appraisal desk can place an order, message the appraiser, ask for revisions, and hand documents
up — but it can't tell you **what the fee is before you order**, **who the appraiser is**, **when the
inspection is**, **when it's due**, or **whether you still owe a document**. The two vendors also look like two
different products.

This doc proposes: one clean order section, both vendors identical; a **fee shown before you order**; an
**appraiser name + phone once assigned**; an **inspection date and a due date** with a nudge when something is
running late; a **redesigned "send a document" menu** with the document type chosen from a list; a **red
"missing documentation" flag** on an order when the appraiser still needs the contract or plans; and a **gold
"the scope of work changed — send the new one" button** that appears the moment the rehab budget changes. Plus
the **Pay button** and the normalized **status bar** already in the UI spec.

Nothing here changes a price, a guideline number, or how the two backends work.

---

## 1. Ranked feature enhancements — the whole workflow, beginning to end

Two sources feed this: (a) what each vendor's API **already supports but PILOT doesn't use** (from the two
inventories), and (b) how **modern lender/AMC platforms** present ordering (Reggora, Mercury Network/Cotality,
SharperLending's Appraisal Firewall, ValueLink, nCino — §1.5 + Sources).

### 1.1 How to read the table

- **Value** — P0 (build first / owner-driven), P1 (high value soon), P2 (nice to have).
- **Vendor support** — which backend can do it. **"NAN"** = AppraisalScope/CDG, **"Class"** = Class Valuation.
- **UI** — **Shared** (identical component both vendors) · **Shared+extra** (shared shell, one vendor adds a
  control) · **Vendor-only** (one vendor genuinely lacks it → grey out with a reason).
- **Effort** — S (a day-ish), M (a few days), L (a week+ / real backend wiring).
- Every "Shared" feature is drawn through the **one adapter** so the two desks can never drift — the same rule
  `OrderFailure` already follows.

### 1.2 The ranked list

#### P0 — build first

| # | Feature | Vendor support | UI | Effort | What it does / API |
|---|---|---|---|---|---|
| **1** | **Fee shown before you order** | NAN: `GetFee` / `GetAppraiserFeesByLocation` (by job type + state/zip). Class: `appraiserQuotedFee` on create + `GET /orders/{id}/payment-details` (`clientFee`, `outstandingBalance`) after. | Shared | M | The single biggest "ordering in the dark" gap. Show the quoted fee on the builder and carry it onto the **Pay button** (`Pay $650`). Mercury calls this "customary & reasonable fee" management. |
| **2** | **Fee + balance read on an active order** | NAN: `GetPaymentOptions` + fee. Class: `GET /orders/{id}/payment-details` → `clientFee` / `paidAmount` / `outstandingBalance`. | Shared | M | Feeds the Pay button state (`Pay $650` vs `Paid ✓ · ••4242`) and the `.act-figs` money read-out on the expanded card. Class also has `ClientFeeChanged` / `OrderPaid` webhooks; NAN polls. |
| **3** | **Redesigned upload-document menu (categorized)** — *owner element* | NAN: `UploadDocument`/`UploadDocumentMulti` + `Get_Additional_Document_Types` (Invoice, Appraiser E&O/License, EAD/Fannie/Freddie SSR…). **Class: `POST /{orderId}/attachments/{category}` — real endpoint, currently unwired (a P1 gap, NOT unsupported).** | Shared | M | See §1.3a. **Correction to `CURRENT-ARCHITECTURE §5.1`, which lists Class doc-upload as "unsupported": the Class API guide DOES expose outbound attachment upload** — so this menu is genuinely shared once the Class side is wired, not vendor-specific. |
| **4** | **"Missing documentation" alert on the order** — *owner element* | Derived from the file + what was sent up (`amc_order_documents` / `class_attachments`). | Shared | M | See §1.3b. A red `.dd-note.warn` when the appraiser still needs the contract / assignment / plans+specs. |
| **5** | **"SOW changed — send new SOW" alert + button** — *owner element* | Shared upload (feature 3). NAN adds a `scope-of-work change` revision kind (`AddRevision`); Class re-sends the attachment. | Shared+extra | M | See §1.3c. Fires off the existing `rehab_budget` reopen trigger (db/071/072). Gold/RTL-critical: the appraisal is subject-to the SOW. |
| **6** | **Pay button (shared appraisal card + clear condition)** | Shared card `lib/appraisal-card.js` + `appraisal_card` condition. | Shared | M | Already fully specced in `UNIFIED-UI-SPEC.md §8`. Layer the real-charge asymmetry (feature 17) on top later. |
| **7** | **PILOT notification + audit on order events** | New seam at the adapter boundary; `notify.notifyAppStaff` + a `class_write_log` mirroring `amc_write_log`. | Shared | M | `CURRENT-ARCHITECTURE §5.4/5.5`: neither backend notifies PILOT or audits placement today. Fire in-app (staff, per the in-app-only rule) on placed / report-ready / inbound message / failed. This is what makes the status bar *tell the parties* (owner req #4). |

#### P1 — high value soon

| # | Feature | Vendor support | UI | Effort | What it does / API |
|---|---|---|---|---|---|
| **8** | **Appraiser identity + contact once assigned** | NAN: `GetAppraisalDetail` → `deals[].appraisers[]`. Class: `AssignedToVendor` webhook (`userEmail`/`firstName`/`lastName`) + `assignedVendors[]`. | Shared | M | "Assigned to **Jane Doe** · (570) 555-0110". Industry standard (SharperLending: all parties follow the order). Sits under milestone ② on the timeline. |
| **9** | **Inspection appointment date (display + propose)** | NAN: status `1006 AppointmentTimeSet` + `inspectionScheduledDatetime` (display only). Class: `appointmentDate` + `SetAppointment` event **and** `POST /orders/{id}/appointment-date` to *propose* a borrower-confirmed date. | Shared+extra | M | Both **show** the scheduled/inspected dates on milestones ②/③. **Proposing** a date is Class-only → NAN greys that control with "AppraisalScope schedules on their side." Industry: the "Inspection Scheduled" status with all parties notified. |
| **10** | **ETA / turn-time / due-date tracking + past-due nudge** | NAN: `serviceNeedByDate` out; `estimated_completion_date` / `last_update_time` from `GetAppraisals` + `GetAppraisalDetail`. Class: `dueDate` + `ClientDueDateChanged` webhook. | Shared | M | Show the due date on the base line; a subtle **amber chip** when past due or within N days of the closing date. Reggora/ValueLink both automate "is any step taking too long" before it hits the closing. |
| **11** | **On-hold / off-hold** | Class: `POST request-on-hold` / `request-off-hold` (action). NAN: statuses `1001/1002` come FROM the vendor (display only — no request endpoint). | Shared+extra | M | Timeline **overlay** already in the spec (§6b). The *action* is Class-only → NAN greys "Put on hold" with "AppraisalScope sets holds on their side." |
| **12** | **Rush order** | Class: `rushOrder` flag on create. NAN: no explicit flag — degrade to a tight `serviceNeedByDate`. | Shared+extra | S | A "Rush" toggle in the builder. On NAN it just tightens the need-by date (labelled so the user knows). |
| **13** | **ROV / reconsideration-of-value (structured)** | NAN: `AddRevision` + `amc/rov` comp search from the **Property Research Center** (the `RovBuilder`). Class: `request-revision` with value-reason codes (the reason-picker). | Shared+extra | — (built) | Already in `UNIFIED-UI-SPEC §5b`. Keep BOTH builders behind one "Dispute the value" `.seg` tab. **Also add the GSE-compliance framing** (feature 20). |
| **14** | **Photos-metadata → property/comp research DB** | Class: `GET /{id}/attachments/photos-metadata` (geolocated, phototype, tags). NAN: photos arrive inside the report XML (appraisal desk). | Shared+extra | M | Feeds the existing property/comp research warehouse. Class pulls per-order; NAN inherits it from `runAppraisalImport`. Not on the order card — a background pull. |
| **15** | **Order search / reconcile sweep** | NAN: `GetAppraisals` (by loan #, date, status). Class: `GET /orders` search. | Shared | M | Back-office reconcile: find/repair an order by loan number without the vendor id. A nightly sweep + a "find order" admin action. |
| **16** | **Auto-attach contract + SOW on order** | NAN: already `autoUploadForOrder`. Class: gap (wire once feature 3 lands). | Shared | S | Bring Class to parity — the SOW + contract go up automatically at placement, deduped per order. |
| **17** | **Real charge on the Pay button (asymmetric)** | NAN: `PaymentAuthCapture` (genuine card charge via CDG→Authorize.Net) + eCheck / BillInvoice / SendInvoice. Class: **no charge API** — `add-creditcard-payment` RECORDS a charge taken elsewhere; `paymentDetails.paymentMethod=PaymentLink` emails the borrower a hosted page. | Shared+extra | L | The one big vendor asymmetry (§1.4). Phase-2 of Pay. NAN can charge in-app; Class offers "Send the borrower a payment link" or "record a charge" — greyed/relabelled, never a broken button. |

#### P2 — nice to have

| # | Feature | Vendor support | UI | Effort |
|---|---|---|---|---|
| **18** | AVM as a cheap pre-appraisal sanity check | Class: `POST /avm` + status/response. NAN: none. | Vendor-only (Class) | M-L |
| **19** | SSO deep-link into the vendor's own portal | Class: `cv_user_identity` + `GET /external/auth?…&loc=order/view/{id}`. NAN: raw `invisionURL`/desktop link only. | Shared+extra | M |
| **20** | Borrower-initiated **ROV disclosure + intake** (GSE Aug-2024 rule) | Shared concept; both file the ROV via feature 13. | Shared | M |
| **21** | Payment method at order time (Invoice / PaymentLink / Prepay) | Class: `paymentDetails.paymentMethod`. NAN: eCheck/BillInvoice/SendInvoice family. | Shared+extra | M |
| **22** | Separate notes-to-vendor / notes-to-manager channels | Class: `notesToVendor` / `notesToManager`. NAN: single `instructions`. | Shared+extra | S |
| **23** | GSE data revision (path-targeted) | Class: `request-gse-revision` (client-only, unwired). | Vendor-only (Class) | S |
| **24** | Validate order landed at vendor | Class: `POST /orders/{id}/validate`. NAN: implicit in ACK. | Shared+extra | S |

### 1.3 The three owner-directed elements, in detail

#### 1.3a — Redesigned upload-document menu

**Today:** a flat checkbox list of the file's documents with "already-sent" greying and one "upload selected"
button (both panels). **Owner wants it redesigned.** Concrete design:

- A **`.btn.soft` "Send a document ▾"** in the Documents cluster of the action bar opens an inline panel (not a
  separate tab), one open at a time under the card.
- Inside, two ways to add:
  1. **Pick from the file** — the file's documents as compact rows (name · type · size), each with a
     **document-type/category select** pre-filled from the shared `tpr-export.categoryFor` classification, and
     an "already sent to this order" chip that greys the row (dedup on the vendor doc id).
  2. **Upload new** — drag/drop or choose, then pick the category.
- The **category select** is the real vendor category list: NAN's `Get_Additional_Document_Types`
  (Invoice, Appraiser E&O, License, EAD/Fannie/Freddie SSR, …) or Class's fixed `category` enum
  (`SalesContract`, `PlansAndSpecs`, `ClientEngagementLetter`, `ROVDocument`, `Appraisal`, `Invoice`, …). The
  shell is identical; the option list comes from the adapter. Validate against `GET /attachments/types`
  (Class) before send so a wrong type is caught up front.
- One `.btn.primary` **"Send N to the appraiser"**. Failure → the shared `OrderFailure` box (`action="send that document"`).
- Note kept: *"the scope of work + contract go up automatically."*

**Prerequisite:** wire Class's `POST /{orderId}/attachments/{category}` (feature 3) so this menu behaves
identically on both vendors and is **not** greyed out for Class.

#### 1.3b — "Missing documentation" alert on the order

A derived, always-visible alert on an active order card when the appraiser still needs something we haven't
sent up. Rendered as a **red `.dd-note.warn`** directly under the base-details line:

> ⚠ **Missing documentation** — the appraiser still needs the **purchase contract** and **plans & specs**.
> [ Send them ▾ ]

- **What counts as "needed"** is a per-adapter list checked against what's been sent (`amc_order_documents` /
  `class_attachments`): the executed **contract** (+ assignment on an assignment file), **plans & specs / SOW**
  on a construction/reno deal, the **engagement letter**, and any **ROV support doc** while an ROV is open. It
  reuses the file's own condition data (contract on file, SOW total) so it never invents a requirement.
- The **[ Send them ▾ ]** button opens the redesigned upload menu (§1.3a) pre-filtered to the missing types.
- Clears itself the moment the documents are sent (go-forward, derived — nothing stored, no stale flag).

#### 1.3c — "SOW changed — send new SOW" alert + button

The RTL appraisal is subject-to the Scope of Work; when the rehab budget/SOW changes **after** the order was
placed, the appraiser is working off a stale scope. PILOT already fires a DB trigger reopening the
`rehab_budget`/Products-&-Pricing conditions on a `rehab_budget` change (db/071/072) — reuse that signal.

- A **gold `.dd-note.next`** appears on any active order placed **before** the file's current SOW timestamp:

  > ● **The scope of work changed since this order.** The appraiser has the old one.
  > [ Send the updated SOW ] · <small>changed 08/12 · $126,000 → $131,500</small>

- **[ Send the updated SOW ]** = re-upload the current SOW document through the shared upload path **and**, on
  NAN, optionally file the **scope-of-work-change revision** kind (`AddRevision`) so the appraiser is told to
  re-scope; on Class it re-sends the `PlansAndSpecs` attachment with a note. One button, adapter picks the mechanism.
- The alert is derived from `order.placedAt < file.sowUpdatedAt` (or the reopen trigger's timestamp), so it
  appears and disappears on its own and never needs a stored flag.

### 1.4 Key vendor asymmetries — exactly what to grey out (and why)

Keep the two vendors visually identical; grey a control **only** where the API genuinely can't, and always show
the reason (never a dead/silent button). The real asymmetries:

| Capability | NAN (AppraisalScope) | Class Valuation | UI treatment |
|---|---|---|---|
| **Charge a card in-app** | ✅ `PaymentAuthCapture` (real charge) | ❌ record-only + hosted `PaymentLink` | Pay button: NAN "Pay $650" charges; Class shows "Send payment link" / "Record payment" with a `.dd-note` reason. |
| **Request on-hold / off-hold** | ❌ (vendor sets it; display only) | ✅ `request-on-hold` / `-off-hold` | NAN greys "Put on hold" → *"AppraisalScope sets holds on their side."* |
| **Propose an inspection date** | ❌ (comes via status 1006) | ✅ `POST appointment-date` | NAN greys "Propose a date" with the same-style reason; both still **display** the date. |
| **Rush flag** | ❌ (tighten need-by date) | ✅ `rushOrder` | Shared toggle; NAN footnotes "sets a tighter due date." |
| **Structured ROV comps** | ✅ Property Research Center comp search | ❌ reason-coded revision only | Both offer "Dispute the value"; the *builder* differs (keep both — they're the good enhancements). |
| **AVM pre-check** | ❌ | ✅ `POST /avm` | Class-only card; simply absent on NAN (row doesn't render). |
| **SSO deep-link into portal** | ❌ (raw link) | ✅ `external/auth` deep-link | Shared "Open in vendor portal"; NAN opens the plain `invisionURL`. |

**The rule (from the spec):** where a vendor lacks a concept, the row **doesn't render at all** (AVM on NAN);
where a vendor lacks an *action* on a shared concept, the **button greys with a one-line reason** (hold/propose-date
on NAN, charge on Class). Never a structurally different panel — the same shape minus one control.

### 1.5 Industry cross-check (what modern platforms actually surface)

- **Reggora** — real-time status + instant notifications, a dedicated **Revisions tab** and a **"Request
  Reconsideration of Value"** button from the Submissions tab, plus ROV **analytics** (count + reasons). Validates
  our normalized timeline, the Revision/ROV split, and PILOT-side notifications (feature 7).
- **Mercury Network (Cotality)** — advanced **fee management** + a customary-and-reasonable fee guide, real-time
  order status with an audit trail, integrated **message dashboard**. Validates fee-before-order (feature 1/2)
  and the audit journal (feature 7).
- **SharperLending / Appraisal Firewall** — an **unlimited set of parties on one order** all "following the
  process as it moves toward completion," and a real-time review/scorecard collaboration surface. Validates the
  appraiser-identity + all-parties visibility model (feature 8) and the messages thread.
- **ValueLink / Appraisals-Unlimited / Reggora panel-management** — the canonical status ladder
  **Ordered → Appraiser assigned → Inspection scheduled → Inspected → In review → Report delivered**, borrower
  **payment collection**, and **automated past-due checks** that flag a stalled step before it hits the closing.
  This is exactly our five-milestone timeline + ETA nudge (features 9/10) + Pay (feature 6).
- **nCino** — notably **does not support appraisal ordering** (tracking/updates only). Confirms PILOT's
  in-house ordering desk is a genuine differentiator worth polishing, not commoditised.
- **GSE ROV rules (eff. Aug 29 2024; 2025 simplification)** — Fannie/Freddie/HUD require a consistent
  **borrower-initiated ROV** process, disclosure to the borrower **on delivery of the appraisal**, and working
  the borrower's request to the minimum requirements before it reaches the appraiser. Frames feature 20 and the
  wording of the "Dispute the value" flow.

---

## 2. The unified interface — concrete PILOT design

This section makes `UNIFIED-UI-SPEC.md` concrete for the new elements and maps every piece to an **existing**
`app-v2/src/styles.css` class. Read the spec §2–§8 for the section shell, vendor selector, builder, timeline,
drawer, and Pay modal — those are unchanged. Below is what's **new or sharpened**.

### 2.1 Where it mounts

Replace the two `<VendorHeading>` + `<AmcAppraisalPanel/>` / `<ClassAppraisalPanel/>` mounts at
`StaffApplication.jsx` `sec-order-appraisal` (~L6069) with one `<AppraisalOrderSection appId={id} />`. Keep the
section's `info` copy (it already explains "two places can do it — you pick which one per file; neither is the
default"). The `VendorHeading` visual language (4px gold bar `#AE8746` + bold `#141B22`) becomes the compact
**side stamp** (`.aord-stamp`).

### 2.2 The active-order card — full anatomy (with the new pieces)

```
┌────────────────────────────────────────────────────────────────┐ ┌────────┐
│  1004 URAR                       ● In review        [Details ▾] │ │  NAN   │  ← .aord-stamp (gold side rail)
│  129 Carlisle St · AMC #48213 · ordered 07/12 · due 07/28 · $650 │ │        │  ← base line (.act-card-sub)
│                                                                  │ └────────┘
│  ●━━━●━━━●━━━○━━━○   Placed · Scheduled · Inspected · Review · In │  ← timeline (.loan-prog / .aord-timeline)
│  Assigned to Jane Doe · (570) 555-0110 · inspection 07/22        │  ← appraiser + appt (.dd-field-l rows)
│                                                                  │
│  ⚠ Missing documentation — appraiser still needs the contract.  │  ← .dd-note.warn  (§1.3b)
│  ● Scope of work changed since this order.  [ Send updated SOW ] │  ← .dd-note.next  (§1.3c)
│                                                                  │
│  ── action bar (.act-bar) ─────────────────────────────────────  │
│  MESSAGES(2) · DOCUMENTS · REVISION  ‖  [ Pay $650 ] · Cancel     │  ← .act-group ‖ .act-sep ‖ .act-group
└────────────────────────────────────────────────────────────────┘
```

- **Vendor stamp** (`.aord-stamp`) — a fixed rail on the inline-end side: a 4px `--gold` bar + `NAN` / `Class`
  in bold `#141B22`. Visible without expanding — the single clearest "which vendor" signal.
- **Base line** — property · vendor order # (`AMC #cdg_order_number` / `Class order class_order_id`) · ordered
  date · **due date** (feature 10) · **fee** (feature 2) · `· test` when dryrun.
- **Timeline** — the five canonical milestones from spec §6, reusing the `.loan-prog` / `.lp-*` stepper (or the
  minimal `.aord-timeline` if `.loan-prog` isn't reused verbatim; must live in an `overflow-x:auto` container).
- **Appraiser + appointment** (features 8/9) — small `.dd-field-l` label/value rows under the timeline, shown
  once assigned; absent (not empty) before.
- **The two new alerts** stack between the appraiser rows and the action bar (§1.3b/§1.3c).
- **Action bar** — two `.act-group` clusters split by an `.act-sep` hairline: **communicate** (Messages ·
  Documents · Revision, all `.btn.soft`) ‖ **money** (Pay `.btn.primary`, Cancel `.btn.ghost`). Messages carries
  an unread count badge (Class `unread`; NAN comment count).

### 2.3 The redesigned upload-document menu → CSS

- Trigger: `.btn.soft` "Send a document ▾" in the Documents `.act-group`.
- Panel: an inline expandable region (one open at a time). Rows in `.dd-card` house style; each file row is a
  `.dd-field-l` label + a category `<select>` + an "already sent" `.dd-chip` (greys the row).
- The category select is the vendor category list from the adapter.
- Send: `.btn.primary` "Send N to the appraiser". Failure → `<OrderFailure action="send that document" />`.

### 2.4 Missing-documentation alert → CSS

- One `.dd-note.warn` (red dot, dark-amber text — the class already exists at styles.css:4313). Text names the
  exact missing documents. A `.btn.soft` "Send them ▾" opens §2.3 pre-filtered. No new CSS.

### 2.5 SOW-changed alert/button → CSS

- One `.dd-note.next` (gold dot, styles.css:4314). A `.btn.soft` "Send the updated SOW" + a `<small>` showing
  the change (`$126,000 → $131,500`, tabular numerals). No new CSS.

### 2.6 Fee / ETA / appraiser blocks → CSS

- **Fee on the builder + Pay button** — the fee value in the base line and on `Pay $<fee>`; the expanded card's
  money read-out reuses `.act-figs` + `.act-figs .rule` + `.act-figs .tot` (styles.css:4143).
- **Due-date nudge** — an amber `.dd-chip.warn` ("Due 07/28" → "2 days late") next to the base line when past
  due / near the closing date.
- **Appraiser + appointment** — `.dd-field-l` rows.

### 2.7 Exact CSS class mapping (everything reuses `app-v2/src/styles.css`)

| UI piece | Existing class(es) | styles.css line |
|---|---|---|
| Vendor selector · UAD-version picker · Revision sub-mode · Pay-method | `.seg` / `.seg > button(.on)` | 4152 |
| Order builder / "section owns its action" (Fee card, AVM card) | `.act-card` / `.act-card-head` / `.act-card-title` / `.act-card-sub` | 4135 |
| Action bar (communicate ‖ money) | `.act-bar` / `.act-group` / `.act-label` / `.act-sep` | 4116 |
| Buttons — commit/money | `.btn.primary` (Place order, Pay, Send docs) | 1603 |
| Buttons — utility | `.btn.soft` (Messages, Documents, Revision, Send a document, Send updated SOW) | (soft variant) |
| Buttons — quiet | `.btn.ghost` (Cancel, Mark read) | 1605 |
| Money read-out (fee / balance) | `.act-figs` / `.act-figs .rule` / `.act-figs .tot` | 4143 |
| Missing-docs alert | `.dd-note.warn` | 4309/4313 |
| SOW-changed alert | `.dd-note.next` | 4309/4314 |
| Vendor status chip · revision/hold overlay · due-date nudge | `.dd-chip` / `.dd-chip.warn` / `.dd-chip.on/.off` | 194 |
| Status timeline (filled-to-current stepper) | `.loan-prog` / `.lp-step(.done/.current)` / `.dd-meter > i` | 2070 / 210 |
| Expanded details, appraiser rows, contacts | `.dd-card` / `.dd-card-h` / `.dd-field-l` | 237 / 245 |
| Pay dialog / any modal | `.cv-modal` / `.cv-modal-back` (bottom sheet on phones) | 1486 |
| Failure surface (place / message / revision / cancel / pay / send doc) | `<OrderFailure vendor=… action=… />` (already vendor-stamped) | components/OrderFailure.jsx |
| Tokens | `--text`/#141B22, `--text-muted`/#4B585C, `--surface`/#FFF, `--surface-soft`, `--border`, `--primary`/#2F7F86, `--primary-soft`, `--gold`/#AE8746, `--gold-ink`/#856529, `--success`/#2A6E55, `--warning`/#8A5F14, `--radius`/4px | 9–37 |

### 2.8 New CSS to add (minimal, namespaced `.aord-*`)

Almost nothing is needed — the classes above cover it. Add only:

- **`.aord-stamp`** — the vendor side rail: a small flex column pinned inline-end, 4px `--gold` bar + short name
  in bold `#141B22` (the `VendorHeading` language turned vertical). One rule + a `@media(max-width:720px)` that
  drops it above the header instead of beside it.
- **`.aord-timeline` / `.aord-step.done/.now/.todo`** — only if `.loan-prog` isn't reused verbatim. Must sit in
  its own `overflow-x:auto` container so it never widens the card.
- **`.aord-vendor-chip`** — the connection-status chip under the selector, **or reuse `.dd-chip` outright
  (prefer reuse).**

**Rules carried over:** namespace every state modifier (`.aord-step.now`, never a bare `.now` — the codebase has
been bitten by a global `.off`/`.on` collision). No color defined only inside a dark/`@media` block. All text
explicit dark hex or a confirmed-dark token — grep the new files for `var(--ink` before shipping (every hit is
the white-on-white bug).

### 2.9 The greyed-out-with-reason pattern

A vendor that can't do a shared action shows the control **disabled + a reason**, never a missing or dead button:

- `.seg > button:disabled` (opacity .55, styles.css:4159) for a mode a vendor lacks (e.g. Pay-method segments).
- `.btn.soft` with `aria-disabled` + a `.dd-note` one-liner beneath: *"AppraisalScope sets holds on their side."*
- A concept a vendor entirely lacks (AVM on NAN) simply **doesn't render** — same layout, minus one row.

---

## 3. Notes for a non-technical user (the owner)

The owner is not a developer; the desk must read in plain business language, not vendor jargon.

- **One clear status line per order, in words** — not a raw vendor code. The five milestones read
  **"Placed → Inspection scheduled → Inspection completed → In review → Report in"**; the current one is bold,
  past ones muted, future ones faint. A person should never have to know that NAN calls it `1006` or Class calls
  it `SetAppointment`.
- **Plain labels, one crosswalk** — the UI never shows a raw API term:

  | Say this | Never this |
  |---|---|
  | Report / form to order | productCode / productId / UAD 2.6 / 3.6 |
  | Appraiser | assigned vendor / userId |
  | Inspection date | appointmentDate / SetAppointment |
  | Due date | serviceNeedByDate / dueDate |
  | Fee | clientFee / appraiserQuotedFee |
  | On hold | Vendor-SetHold / OnHold |
  | Dispute the value | ROV / reconsideration reasonType |
  | Send a document | UploadDocumentMulti / attachments/{category} |
  | Missing documentation | (derived) |
  | Scope of work changed | rehab_budget reopen trigger |

- **Money is loud, and named** — "Pay **$650**" not "Pay"; "Paid ✓ · ••4242" once done. The fee is visible
  *before* ordering so nothing is a surprise.
- **Alerts say what to do, not what's wrong** — "the appraiser still needs the contract → **Send them**",
  "the scope of work changed → **Send the updated SOW**". Every alert carries its own one-click fix.
- **A failure explains itself** — the vendor-stamped `OrderFailure` box already leads with the vendor name, the
  plain reason, the code, and a "show the full technical details" expander. Reuse it everywhere (place, message,
  revision, cancel, pay, send-doc).
- **Both vendors read identically** — a person who has ordered with NAN can order with Class with zero
  relearning; the only visible differences are the one or two controls a vendor genuinely can't do, each labelled.

---

## 4. Phased build suggestion

Each phase is shippable and additive; the two `/api/amc` + `/api/class` routes stay mounted the whole way, and
the adapter/read-merge discipline of `CURRENT-ARCHITECTURE §5` is the backbone.

**Phase 0 — the shell (no new backend).** Build `AppraisalOrderSection` + the vendor selector (`.seg`, NAN as
the display default), the shared builder shell, the active-order card with the **vendor stamp** and the
**normalized timeline**, and the **one drafts+failed drawer**. Wire both existing services behind the thin
adapter (`configured/preview/place/listOrders/getOrder/comments/documents/revision/cancel/capabilities`). Ship
the read-merge list (both vendors' orders in one list). *Nothing new is charged, nothing new is called.*

**Phase 1 — the owner's three elements + fee + Pay.** (features 1, 3, 4, 5, 6, and the fee read 2)
- Wire **Class outbound document upload** (`POST attachments/{category}`) → the **redesigned upload menu** works
  identically on both vendors.
- Add the **missing-documentation** and **SOW-changed** alerts (derived; SOW reuses the db/071/072 reopen signal).
- Add **fee-before-order** (`GetFee` / Class `payment-details`) and the **Pay button** (shared card + clear
  condition, exactly per spec §8).

**Phase 2 — status richness + notifications.** (features 7, 8, 9, 10, 11)
- **Appraiser identity + contact**, **inspection date** (display both; propose on Class), **due-date / ETA
  nudge**, **on-hold** (action Class / display NAN).
- The **PILOT notification + audit seam** at the adapter boundary (placed / report-ready / inbound message /
  failed) + a `class_write_log` so both vendors are auditable.

**Phase 3 — payment depth + revisions polish.** (features 12, 13, 16, 17, 20, 21)
- **Real charge** on NAN (`PaymentAuthCapture`) and the **hosted PaymentLink / record** path on Class — the one
  asymmetry, greyed/relabelled per §1.4.
- Bring **auto-attach SOW+contract** to Class parity; finish the **ROV** GSE-compliant framing + disclosure.

**Phase 4 — situational.** (features 14, 15, 18, 19, 22, 23, 24) AVM (Class), photos-metadata → research DB,
SSO deep-link, order-search reconcile, notes-to-vendor/manager, GSE data revision, validate-order. Wire as need
arises.

**Verification carried from the spec:** delete the two old panels only after the shared shell + both adapters
reach feature parity; grep the new files for `var(--ink`; rebuild `web/v2/portal` from `app-v2/src`; eslint
`no-undef` on the new `.jsx` (an undeclared identifier builds clean and throws at render).

---

## 5. Sources (public research)

- Reggora — ROV process & appraisal review, revisions/ROV workflow, LOS integration:
  https://www.reggora.com/blog/improving-your-rov-process-when-appraisal-bias-may-be-an-issue ·
  https://www.reggora.com/lenders/appraisal-review ·
  https://www.reggora.com/resource/reggora-guide-panel-management-best-practices
- Mercury Network (Cotality) — fee management, order status, message dashboard, turn-time:
  https://www.mercuryvmp.com/plans · https://www.mercuryvmp.com/
- SharperLending / Appraisal Firewall — all-parties-on-one-order, scorecard collaboration:
  https://sharperlending.co/solutions-lenders/ · https://corp.appraisalfirewall.com/
- ValueLink — automate appraisal ordering; ROV regulation changes:
  https://www.valuelinksoftware.com/automate-the-appraisal-ordering-process/ ·
  https://www.valuelinksoftware.com/new-reconsideration-of-value-rov-regulations-key-changes-for-mortgage-lenders/
- Appraisals-Unlimited — reducing appraisal-related delays (past-due monitoring, scheduling):
  https://www.appraisals-unlimited.com/blog/streamlining-appraisals-for-faster-loan-closings-how-lenders-can-reduce-appraisal-related-delays
- nCino — appraisal integration is tracking-only (no ordering):
  https://mortgagehelp.ncino.com/hc/en-us/articles/25939386495117-Appraisal-Integrations
- GSE Reconsideration-of-Value (borrower-initiated ROV, Aug 29 2024; 2025 simplification):
  https://singlefamily.fanniemae.com/initiative-updates/reconsideration-value-rov ·
  https://mortgagetech.ice.com/blog/how-lenders-can-prepare-for-the-new-rov-guidelines ·
  https://www.asurity.com/regulatory-updates/hud-fannie-mae-and-freddie-mac-announce-reconsideration-of-value-requirements/
