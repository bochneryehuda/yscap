# Draw Workflow — Status Model & Reminder-Routing Blueprint

Owner-directed (message-3, 2026-08-04): restructure the construction-draw process into a proper
STATUS WORKFLOW where every status knows **who it is waiting for** and **who to remind**, so the
borrower stops getting the "inspection result is waiting for you" email over and over. "You already
have all the logic and all the statuses; now structure it into a workflow."

This is the blueprint the build follows. It is implemented in safe increments (below); Increment B
(stop the bombardment) shipped first.

## The key finding

All the states already exist — scattered across six tables plus one computed module. The canonical
ordered status ladder (with **both borrower-facing and internal labels per stage**) already lives in
`src/sitewire/approval.js` (`STAGE_ORDER`, `STAGE_TEXT`, `approvalState()`). The work is to (a) make it
the single routing key, (b) add the two pre-inspection ORDER stages, and (c) attach a per-status
"waiting-on / remind-whom / cadence" table.

**Why the borrower was bombarded:** `notification-digests.js drawFindingsAwaitingBorrowerOnce` emailed
the borrower every ~4 business hours **forever** while a `draw_findings` row sat at `status='delivered'`.
It had a rate limiter but **no stop/cap**. The only thing that stopped it was the finding leaving
`'delivered'` — which happens when the borrower accepts/disputes, or when staff use `mark-accepted`
(db/454, already exists and already stops it). Fix: a **CAP** on the borrower nudges, then a hand-off to
the draw coordinator.

## The 8-step status model (owner's steps → existing data)

| # | Status | Borrower sees | Internal | Backed by | Waits on / Remind / Cadence |
|---|---|---|---|---|---|
| 1 | draw_requested | "Draw submitted" | "Draw requested" | `sitewire_draws.status`, `portal_draw_requests.status='submitted'` | borrower / nobody (Sitewire nudges) / — |
| 2v | inspecting_virtual | "Inspection in progress" | "Virtual (Sitewire) — nothing for us" | `resolveInspection='mobile'` | inspector / **nobody** / — |
| 2b | order_trustpoint | "Inspection in progress" | "Order + enter draw in TrustPoint" | Blue Lake (`isBlueLakeNoteBuyer` / rule `draw_platform='trustpoint'`), no `trustpoint_draws` row | us / **coordinator** / daily |
| 2p | order_trinity | "Inspection in progress" | "Order physical inspection on Trinity" | `resolveInspection='traditional'` & not Blue Lake; `trinity_inspection_orders.status='requested'` | us / **coordinator** / daily |
| 3 | inspection_completed | "Under review" | "Inspection completed" | inspector amounts present / `trinity…='report_received'` / TrustPoint report | us / coordinator / — |
| 4 | gc_review → gc_approved | "Under review" | "GC review" → "ready to deliver" | **new** `draw_findings.gc_reviewed_at` | GC/us / coordinator / daily |
| 5 | delivered_awaiting_borrower | "Please review and accept" | "Delivered — awaiting borrower" | `draw_findings.status='delivered'` | borrower **capped→coordinator** / 4 biz-h × N → coordinator |
| 6 | borrower_approved | **"Waiting for final approval"** | **"Waiting for investor approval"** | `draw_findings.status∈{accepted,resolved}` | us (deliver) / coordinator / keep reminding |
| 7a | investor_pending_delivery | "Waiting for final approval" | "Deliver to investor" | approved & no `draw_investor_deliveries` row | coordinator / **coordinator** / every 2 days |
| 7b | with_investor | "Waiting for final approval" | "With investor — awaiting funding" | `draw_investor_deliveries` row exists | investor / coordinator / **+48h then every 2 days** |
| 8 | final_approved / released | "Approved" / "Released" | "Final approved" / "Wire released" | `sitewire_draws.status='approved'` / `draw_disbursements.funded_status='released'` | us then done / coordinator (existing `drawReleaseOverdueOnce`) |

Terminal: `sitewire_property_links.lifecycle_state∈{finished,paid_off}` suppresses all reminders
(already enforced in the digest queries). Coordinator resolution: `draw-recipients.coordinatorsOrDesk(appId)`.

## What already exists (reuse, don't rebuild)

- Borrower accept/dispute (`draw-findings-public.js`), staff `mark-accepted` (db/454) — both stop the reminder.
- Investor delivery + the three modes (`reimbursement` / `investor_direct` / mark-manually-delivered) and the
  gating that already refuses delivery until the borrower approved — `investor-delivery.js`
  (`deliveryBlockers`, `AGREED_STATUSES`), `investor-delivery-send.js`.
- Draw coordinator resolution + loop-in — `draw-recipients.js`.
- Borrower-safe scrub is a HARD invariant — no note-buyer/capital-partner name in any borrower-facing
  status label or email (the `with_investor` borrower label stays "Waiting for final approval").

## Increments

- **A** — pure `drawWorkflowStatus()` resolver extending `approval.approvalState` with the ORDER +
  investor stages, plus a frozen `{status → {waitingOn, remind, cadence}}` routing table. Display only.
- **B — SHIPPED** — cap the borrower nudge (`DRAW_FINDINGS_BORROWER_CAP`, default 5), then hand off to
  the coordinator once / 2 days (`draw_borrower_stuck` gate). Surface `mark-accepted` as a first-class
  "mark borrower approved" control.
- **C** — the four missing coordinator reminders (order-in-TrustPoint, order-in-Trinity,
  deliver-to-investor while not delivered, +48h after delivery), each a self-gated sweep modelled on the
  existing `drawFindingsAwaitingBorrowerOnce` shape.
- **D** — the GC-review state (migration `draw_findings.gc_reviewed_at/by`, a coordinator action).
- **E** — optional: persist/display the unified status on the draw list.

Every new sweep MUST copy the existing anti-starvation pattern: filter `matched_by='created'` + active
lifecycle, put the throttle in the WHERE (not just the gate), deterministic ORDER, atomic `_gate` claim.

Key files: `src/sitewire/approval.js`, `src/lib/notification-digests.js`, `src/lib/draw-recipients.js`,
`src/sitewire/investor-delivery.js` / `investor-delivery-send.js`, `src/routes/sitewire.js`
(`deliver`/`mark-accepted`/investor-delivery), schema `db/131,132,174,193,299,357,454`.
