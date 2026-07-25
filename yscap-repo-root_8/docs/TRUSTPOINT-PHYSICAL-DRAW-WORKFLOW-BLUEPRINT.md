# Physical Draws via TrustPoint — Workflow Blueprint (Blue Lake files) + General Physical Program (Trinity)

**Date:** 2026-07-24 · **Status:** owner-directed design, pre-build
**Companion docs:** `docs/TRUSTPOINT-DRAW-INTEGRATION-RESEARCH.md` (API capability comparison), `docs/trustpoint/trustpoint-public-api-openapi.json` (spec)
**Research base:** four verified deep-dives (portal/task machinery, Sitewire mechanics, TrustPoint operations, requirements decomposition R1–R46 with conflicts C1–C15) — all claims below carry file/endpoint citations from those passes.

---

## 0. Owner's design, restated (what we're building)

For files where **Blue Lake is the note buyer** and the draw program is **physical inspection**:

1. Files are **still fully set up in Sitewire** at draw setup, defaulted to **physical** inspection (`inspection_method: traditional`).
2. The borrower **usually submits the draw in Sitewire** (unchanged). NEW: the borrower can also submit on **our portal**, and **our staff (draw coordinator / manage_draws) can compose a draw on our portal picking exact SOW line items + amounts**. Portal composer is **physical-files-only**.
3. Draws **cannot be pushed into TrustPoint by machine** (verified twice: TrustPoint's public API has no draw create/submit/approve — draws are read-only). So on every intake (Sitewire or portal), PILOT opens a **coordinator task + email**: "new draw — enter it into TrustPoint."
4. PILOT then **follows TrustPoint**: webhooks + polls, mirrors status and findings, updates the file, the staff, and the borrower, archives TrustPoint's inspection report, and builds **our branded report** from TrustPoint data.
5. PILOT **writes progress + approval numbers back into Sitewire**: live Sitewire draws get per-line approved amounts + approve transition; portal-originated draws get created in Sitewire **after full approval** as **historical draws** (verified supported: `POST /api/v2/draws` with `historical:true` + per-line amounts).
6. PILOT records **approval + wire/release figures** in its own ledger and (provisioning permitting) reports the disbursement to TrustPoint (`POST /public-api/events/` "Draw Disbursed" — the API's one draw write).
7. TrustPoint projects are **created by the investor** — PILOT **links** them to our files by loan number / address / other keys, with a human-confirm desk.
8. Scope: **Blue Lake-as-processor files only** for the TrustPoint leg. The **general physical program** (non-Blue-Lake physical files from our portal) is a **separate workflow**: same portal composer, but the inspection is **ordered from Trinity** via a coordinator task — **no TrustPoint**.

Owner uncertainties resolved by research: direct push to TrustPoint — **impossible, permanent** (R44); live Sitewire draw creation from our side — **impossible; the owner's historical-draw plan is the supported path** (R45). Owner re-confirmed the historical-draw rule: **historical draws ONLY for portal-originated draws, and only after approval**; Sitewire-originated draws are handled live, status mirrored as TrustPoint updates.

### Decisions locked in (owner, 2026-07-24)

- **D1 Access & linking:** Blue Lake will provide TrustPoint access. Link by loan number when present, else by **address** — owner confirms there is never more than one project per address, so a unique normalized-address match may auto-link (conflicts still go to the confirm queue).
- **D2 Wires:** **Blue Lake/TrustPoint releases the draw wire directly.** PILOT does NOT wire these draws — the money leg is observe-and-mirror (§5C/D reshaped accordingly).
- **D3 No double inspection:** Sitewire does **not** dispatch its own inspector on physical/traditional — the internal coordinator task IS the inspection trigger on every physical file (to TrustPoint for Blue Lake, to Trinity otherwise). Conflict C2 resolved; Sitewire intake stays.
- **D4 Per-line numbers via budget crosswalk:** the coordinator manually **copies PILOT's budget into TrustPoint** when creating the project, so TrustPoint's milestones mirror our SOW lines — PILOT must link its budget items to TrustPoint's milestones directly (§6 rebuilt around a milestone crosswalk).
- **D5 Single borrower voice:** PILOT is the only voice to the borrower; the borrower is never invited into TrustPoint.
- **D6 Fees:** Blue Lake physical draws carry the **$250** fee (discounted vs the usual physical fee), **deducted from the net wire**.
- **D7 Retainage:** TrustPoint's holdback numbers are the source of truth; PILOT's own retainage computation is off for these files.
- **D8 Trinity:** Trinity is the physical-inspection company. On Blue Lake files, **Blue Lake/TrustPoint sends Trinity inspectors themselves** — Trinity's reports reach PILOT *through TrustPoint* (service orders + report PDF). For non-Blue-Lake physical draws: manual coordinator task to send to Trinity for now, with a **Trinity ordering API planned as the next step** — build the order record/status machinery now so the API adapter slots in without rework.
- **D9 Fee economics (2026-07-24 follow-up):** the $250 deducted from a Blue Lake draw's net wire is **NOT YS revenue** — YS makes no money on Blue Lake draws today (draw-fee revenue exists only on the other programs). No receivable/remittance tracking. **Future:** a possible YS **markup** on Blue Lake draws once Blue Lake allows it — leave a dormant `markup_cents` knob on the rule config so enabling it later is data entry, not a build.

---

## 1. Routing & file setup (Phase 1)

- **`sitewire_inspection_rules` gains a `draw_platform` routing column**: `sitewire` (default) | `trustpoint` | `external` (legacy `handled_externally` semantics). One file is only ever live on ONE platform pipeline (C-invariant). `handled_externally` reads (`orchestrator.js:317` skip, `sitewire.js:706` 422) are replaced by routing: `trustpoint` files get the FULL Sitewire birth push (unchanged) and route draw handling to the TrustPoint flow instead of blocking.
- **Blue Lake rule row** (admin-entered via StaffDrawRules, keyed on `normNoteBuyer(applications.lender)`): method `traditional`, fee $250 (`fee_cents_override` = 25000), `require_capital_partner_approval` **false** (mandatory: `pending_capital_partner` draws are approvable only by a capital-partner login — `client.js:87` reject is CP-only), `draw_platform: 'trustpoint'`.
- **Blue Lake's Sitewire capital-partner link stays** (`sitewire_partner_links` bluelake→41): pushFile parks any file whose partner doesn't resolve (`sitewire_capital_partner_unmatched`, `orchestrator.js:184` — explicit-NULL is not exempted), and with RCPA=false a linked CP is visibility-only per Sitewire docs.
- **Method-aware fixes that ship with routing** (both are live bugs the moment physical files flow): the `pending` staff notification copy says "was inspected — ready for your review" (wrong for physical), and `risk.js:62` flags `no_inspection` on every money line (expected state for physical files) — both gate on method/platform.

## 2. Intake paths (two doors, one canonical draw)

### Path A — Sitewire submission (the usual door, unchanged for the borrower)
Borrower submits in Sitewire → the existing 300s reconcile mirrors the draw + per-line requests (this path **gives us per-line requested amounts for free**) → on first sight of a submitted draw on a `trustpoint`-routed file, PILOT opens the **coordinator import task + email** (§3). The draw then sits in Sitewire `pending` (no Sitewire timeout/auto-action documented) until §5 writes the approval numbers back. Owner-confirmed (D3): Sitewire dispatches **no inspector** on physical mode — the coordinator task is the only inspection trigger, so there is no double-inspection risk and Sitewire intake stays.

### Path B — Portal submission (new composer; physical files only)
- **Staff composer** (capability `manage_draws` — draw coordinator, processor, admin): pick exact SOW line items + amounts against the file's rollup (per-line budget / drawn / remaining already computed by `rollup.js`); validation: line exists, amount ≤ remaining (override with reason), Σ > 0. **Borrower composer**: same picker, simplified, on the borrower draws screen (which today only hands off to Sitewire — `BorrowerDraws.jsx:162-214`). Gated: hidden + server-422 unless the file's rule/method is physical (R10).
- Creates a PILOT-native record: **`portal_draw_requests`** (file, source staff|borrower, status, lines JSONB `{sow_line_key, unit, label, requested_cents}`, totals) — the canonical draw for this cycle.
- **NOT sent to Sitewire at intake** (impossible live). After full approval in TrustPoint (§4), PILOT creates it in Sitewire as a **historical draw** (§5B).
- **Dedupe (C3/C5):** one in-flight draw per file across both doors. Composer blocks (coordinator can override with reason) while a Sitewire draw is open, and the import task tells the coordinator when both exist so one is canceled/merged. A portal draw later found matching an open Sitewire draw links to it rather than double-creating (and then follows Path A's write-back, NOT a historical draw — never both).
- Note: the existing borrower **"Request a draw" button is draw-SETUP only** (`borrower.js:469-516` — one-shot, no amounts); it remains as-is for un-set-up files; the composer appears once the file is set up.

### Path C — General physical program (non-Blue-Lake) — separate workflow, no TrustPoint
Same portal composer (or Sitewire submission on a physical non-Blue-Lake file) → coordinator task **"order physical inspection from Trinity"** (+ email). Modeled on the title/insurance **Orders desk** (`db/211_file_orders.sql`, `src/lib/orders.js`: per-order reply-to email, follow-ups, returned-document routing) so the order, the vendor's report, and the coordinator's findings entry live on one record — a **`trinity_inspection_orders`-style record with its own status lifecycle (requested → ordered → report_received → entered)**, built now so the **planned Trinity ordering API (D8)** later replaces the manual "ordered" step with an adapter call and nothing else changes. Findings → coordinator enters approved amounts per line (same entry screen as §6's fallback) → approval → Sitewire write-back — same machinery as the Blue Lake flow minus every TrustPoint step. (On Blue Lake files Trinity inspectors are dispatched by Blue Lake/TrustPoint and their reports arrive through TrustPoint — Path C never applies to Blue Lake files.)

## 3. Coordinator task + email ("enter it into TrustPoint")

- **Task primitive:** the internal Workflow hand-off desk (`workflow_items`/`workflow_events`, db/212 — role inboxes, SLA, pickup/outcomes, daily overdue digest), NOT ClickUp (server-side ClickUp creation exists only for the per-file pipeline card, `clickup/orchestrator.js:607-619`; no generic to-do surface). New type **`trustpoint_import`** (role `draw_coordinator`, SLA 24h) copying the `workflow-automation.onFunded` `draw_setup` precedent (`workflow-automation.js:62-88`): sole-active-coordinator resolution, dedupe (one live per file+type), `auto:true`, action-bearing email.
- **Email:** one throttled action email to the coordinator + the `draws@yscapgroup.com` desk (per-file reply-to, `fileReplyTo` pattern), new notify type registered in `KICKER_OF`/`CATEGORY_OF` (category `draws`); NOT in `STAFF_INAPP_TYPES` (this is action-needed). Content: source door (Sitewire | portal-staff | portal-borrower), property, loan number, **copy-ready line-item table (line name → requested $)**, total, link to the file's draw desk, and the instruction: **enter as a REGULAR workflow draw in TrustPoint — never TrustPoint's own "historical/imported draw"** (imported draws fire no webhooks per the spec's webhook docs, which would blind the whole mirror).
- **Task completes** when the TrustPoint draw links to this intake (§4 matcher) — auto-complete on link, plus a self-gated reminder if unlinked after N days (`_gate` audit-stamp pattern, NY business-hours window).

## 4. Following TrustPoint (mirror; needs provisioning §8)

- **Linking investor-created projects → PILOT files** (`trustpoint_project_links`, UNIQUE both sides; desk copies the `sitewire_partner_links` never-guess doctrine — db/151, `StaffDrawRules.jsx` pills UI):
  - Tier 1 auto-link: exact YS loan number in `loan.external_id` or tokenized project name. (Caveat: `external_id` is whatever the INVESTOR set — may be absent or Blue Lake's own number; it is **immutable after creation**, so the "stamp our loan number at creation" ask (§8) remains worth making.)
  - Tier 2 auto-link (per D1 — owner confirms never more than one project per address): **unique normalized-address match auto-links**; corroborators (`budget_commitment` ≈ rehab budget, borrower member email — **platform-unique in TrustPoint**, origination date, `legal_entity` ≈ vesting LLC) upgrade confidence and break ties.
  - Non-unique / conflicting matches → human-confirm queue. Never fuzzy auto-bind. DISCARDED projects flag their link for review.
- **Budget crosswalk (`trustpoint_milestone_links`) — D4:** the coordinator copies PILOT's budget into TrustPoint at project creation, so TrustPoint milestones ARE our SOW lines under manual re-entry. On link (or first milestone sweep), match `GET /projects/{pk}/milestones/` rows to PILOT SOW lines by normalized name + amount (they were copied from us, so matches should be near-exact); unmatched/ambiguous lines go to a small confirm screen inside the coordinator's task; Σ(milestones) is verified against the frozen rehab budget to the cent, with drift alerts thereafter. This crosswalk is what makes per-line draw numbers possible (§6).
  - Discovery: 30-min full-pagination id-diff sweep of `GET /projects/` (no created_at/updated_at on projects, no Project Created webhook, RestQL undocumented — do not design around it) + just-in-time discovery when a webhook carries an unknown `project_id` (park-and-replay).
- **Webhook receiver** (new public route — none exists for any draw platform): auth-validated (we issue TrustPoint a token at registration), 2xx-within-30s, enqueue-then-process via `sync_queue`, dedupe on (event, resource ids, state) — delivery `id` is a fresh UUID per attempt. Registered per YS company for all 10 events; `subscribed_events` is PATCH-only after create.
- **Polls are correctness machinery, not backup** (non-2xx deliveries are dropped forever; no replay): 5-min global draw watermark (`updated_at__gt` wall-clock watermark with overlap — draw responses carry no `updated_at`), hourly service-order sweep, daily per-project refresh. Total ≈ 0.5 rpm vs the 600 rpm cap.
- **Event → update map** (webhook payloads are thin — Submitted/Approved/Returned/service-order events all need a hydrating GET):

| Event | PILOT action |
|---|---|
| Draw Created / Submitted | mirror row (`trustpoint_draws`); link to intake record (match by amount+timing; coordinator confirms in task); borrower "draw submitted" milestone (Path-B draws — Path A's came from Sitewire); staff in-app |
| Draw Review Added | staff pipeline ticker (review_action, teams) — in-app only |
| Draw Approved (FINALIZED) | hydrate; capture approved/`amount_to_disburse`/fees/retainage/contingency/rates; pull + archive `/report/` PDF; borrower "approved $X of $Y" milestone; open §5 write-backs; per-line entry prompt to coordinator (§6) |
| Draw Returned | hydrate; borrower action-needed email (plain-language reason field from coordinator); staff notify |
| Draw Deleted | close mirror row + intake dedupe release |
| Project Changed | append to audit (tracked-field diffs); drift review for fields PILOT masters |
| Service Order Ordered/Completed/Cancelled | inspection timeline on the draw desk; staleness monitor (`ordered_at` → no `completed_at` in N days); FEASIBILITY / PERMIT_VERIFICATION completions surfaced to the ISG desk (BL conds 200/203) |
| *(poll-only)* draw COMPLETED, `disbursed_at`, project status | mirror + close-out (no webhooks exist for these) |

## 5. Write-backs

**A. Live Sitewire draw (Path A) — mirror TrustPoint's decision into Sitewire:** per-line `approved_cents` + `lender_comments` via `updateRequest` (PATCH /requests/{id}), then `drawTransition('approve')` — zero-inspection approval is API-legal (no documented precondition; role-gating only), and approved amounts are Sitewire's ONLY writable progress lever, automatically driving its read-only rollups (`total_approved_cents`, `available_cents`, budget `balance_cents`). Stage labels via `setDrawQuickNotify` through the cycle. All under the existing guard rails (read-after-write, journal, park `sitewire_approve_failed`, no-retry POSTs). Per-line amounts come from §6; until then the draw stays `pending`.
**B. Historical Sitewire draw (Path B) — after full approval only:** new `client.createHistoricalDraw()` → `POST /api/v2/draws {property_id, historical: true, requests_attributes: [{job_item_id, requested_cents, pending_approved_cents}]}` (per-line approved at create is `pending_approved_cents`), include every mandatory $0 media-anchor line, land `pending`, then `approve`. Cent-exact Σ pre-verify (hard gate — **no draw DELETE exists**; undo is amend/zero-out or the nuclear whole-property `resetDrawSetup`), single-flight advisory lock, duplicate guard (never when the intake is linked to a live Sitewire draw). No backdating field exists — TrustPoint's approval date goes in `lender_comments`.
**C. Money = observe-and-mirror (D2 — Blue Lake/TrustPoint releases the wire directly, PILOT never wires these draws):** approval numbers land on the intake record from the Approved event; the **disbursement is detected by poll** (`disbursed_amount`/`disbursed_at` are poll-only — the outbound webhook's `amount_disbursed` is documented always-null) and recorded as a **mirror row** in `draw_disbursements` (source `trustpoint`, one `kind='draw'` row per draw, `trustpoint_draw_id` column added). On observed release: borrower **NET amount email** (approved − fees, D6), Sitewire close-out (§5A/B — approval in Sitewire IS its release event), staff in-app note. The SLA machinery inverts: instead of `wire_due_at` on ourselves, an **approved-but-not-released-in-N-days** staff nudge (self-gated digest) so someone chases Blue Lake.
**D. "Draw Disbursed" POST — not ours under D2.** Blue Lake/TrustPoint disburses and populates their own system; PILOT does not post the inbound event. Keep the outbox lane dormant as a contingency (if TrustPoint ever requires the lender of record to report, the verified `POST /public-api/events/` shape + idempotent-uuid pattern is ready).
**E. Retainage & fees precedence (D6/D7/D9):** TrustPoint is the retainage system of record — PILOT mirrors its 4 draw fields and **disables its own `retainage_pct` computation** on these files (double-withholding risk). Fees: the **$250 Blue Lake physical fee is deducted from the net wire and is not YS revenue (D9)** — PILOT mirrors the draw's `fees[]` for the record, verifies a $250 fee line is present on every Blue Lake physical draw (staff alert if absent or different — the borrower's NET depends on it), and shows NET = approved − fees to the borrower. No receivable tracking; a dormant `markup_cents` rule knob covers the possible future markup.

## 6. Per-line numbers + the branded report (C4, resolved via D4's budget crosswalk)

TrustPoint's **draw** schemas return aggregates only — per-milestone draw amounts, per-line inspector comments, and media are absent. But per D4 the milestones ARE our SOW lines (manually copied), and the `trustpoint_milestone_links` crosswalk (§4) opens a derivation path, in preference order:
1. **Milestone-progress diff (primary, sandbox-gated):** the milestones list endpoint's description says it returns line items "**including completed and remaining work amounts**" (fields not defined in its schema — the top sandbox verification). If real: snapshot milestones on every draw event; the per-line delta between the pre-submission and post-approval snapshots IS that draw's per-line approved amounts — fully automatic, keyed through the crosswalk. (Supporting evidence: the project's `lender_allowance_rate`/`inspector_allowance_rate` are documented as "derived from milestones", so per-line progress exists platform-side.)
2. **Coordinator per-line entry (fallback):** one screen inside the import task, pre-filled with the requested lines mapped through the crosswalk; she transcribes approved-per-line from TrustPoint's console/report PDF she already has open. Minutes, exact.
3. **Pro-rata allocation (last resort):** approved total split across requested lines, flagged "allocated" on every surface, never presented as inspector-verified.

**Branded report** (`draw-report.js` reskin, PILOT-branded, borrower-safe): our SOW context + requested vs approved (per-line when entered, else totals + allocation note), inspector allowance/recommendation rates, project completion rate, inspection/service-order timeline, fees/retainage/contingency, NET release figure — with TrustPoint's own report PDF archived **staff-only by default** (it may carry TrustPoint/Blue Lake branding; never auto-forwarded to the borrower — C8).

## 7. Communications discipline

- **Borrower** (single voice = PILOT, owner-confirmed D5 — borrower is never invited into TrustPoint; Gold Standard naming — "TrustPoint"/"Blue Lake" join the `borrower-safe.js` partner scrub patterns): milestones only — submitted, approved ($X of $Y + NET), returned (action needed), released; `drawFindingsAwaitingBorrowerOnce`-style nudges only where an accept step exists. Sitewire's own emails on mirrored approvals/historical creates are undocumented → vendor question; if Sitewire does email, suppress one side.
- **Staff:** routine mirror transitions in-app only (`STAFF_INAPP_TYPES` discipline); action items email (import task, returned draw, link-review, release overdue). All through `notify.js` chokepoints; recurring reminders use the `_gate` + NY-window pattern.

## 8. Provisioning asks (Phase 0, non-engineering, blocking the TrustPoint leg)

1. YS company **enrolled (role LENDER) on every purchased project at creation** (un-enrolled projects are invisible — 404 semantics). Owner: access is being granted (D1).
2. YS **API key** (Org Settings → API Configuration) + **webhook registration rights** for YS's company.
3. **Ask Blue Lake to stamp YS's loan number** into `loan.external_id` (or the project name) **at creation** — immutable after; this is the `loan_id` on every webhook. (D1 fallback: address linking is acceptable — one project per address.)
4. Sandbox access; verify (priority order): **milestone list "completed and remaining work amounts" fields** (§6 primary path hinges on it), path prefix (`/public-api/` vs `/v1/`), report-PDF URL auth, photos-as-documents, duplicate-event dedupe, comment `milestone` filter (possible per-line notes), spec-example enum violations (`SPECIAL_SERVICING`, draw `type:"CONSTRUCTION"`).

**Sitewire vendor questions (remaining):** does approve / historical-create / quick-notify email the borrower (single-voice D5 needs to know); does `draw_eligible:false` block historical POSTs; historical-draw semantics (borrower visibility, irreversibility). ~~Traditional-mode inspector dispatch~~ — answered by owner (D3): Sitewire sends no inspector.

## 9. Data model additions (sketch)

`sitewire_inspection_rules.draw_platform` · `portal_draw_requests` (+ lines JSONB, source, status, dedupe key) · `trustpoint_project_links` (UNIQUE both sides, matched_by, confirmed_by) · **`trustpoint_milestone_links`** (project link × milestone id ↔ SOW line key, matched_by name+amount | confirmed) · `trustpoint_draws` mirror (+ audit table + per-draw milestone **snapshots** for the §6 progress diff) · `trustpoint_write_log` · `draw_disbursements.trustpoint_draw_id` (+ source + fee mirror) · **`trinity_inspection_orders`** (Path C: requested → ordered → report_received → entered; API-adapter-ready) · workflow types `trustpoint_import` + `trinity_inspection_order` · notify types (import task, link review, mirrored milestones, unreleased nudge, fee-mismatch alert) · config: `TRUSTPOINT_ENABLED/_DRYRUN/_API_KEY/_BASE_URL/_POLL_SEC` + sandbox credential set (outbound writes are limited to webhook registration under D2 — the write-guard/journal discipline still applies to it).

## 10. Build phases

**BUILD STATUS (2026-07-24): all five phases are BUILT and merged into this branch, each with a pre-merge audit pass** (findings fixed in the same batch). What ships per phase, with the landing commits:

| Phase | Status | Where it landed |
|---|---|---|
| **1. Routing + import tasks** | ✅ built + audited | db/295, `src/sitewire/routing.js`, `trustpoint-intake.js`, reconcile/risk method-aware fixes, StaffDrawRules "Draws administered on", DrawsPanel chip; tests `test-trustpoint-routing` (23) + `test-trustpoint-intake` (15) |
| **2. TrustPoint mirror** | ✅ built + audited | db/296, `src/trustpoint/{client,matcher,mirror,discovery,poller}.js`, staff router `/api/trustpoint` + public webhook receiver `trustpoint-webhook.js`, config/switches, borrower-safe scrub; tests `test-trustpoint-matcher-pure` (24) + `test-trustpoint-mirror-db` (20) |
| **3. Write-backs + report** | ✅ built + audited | db/297, `src/trustpoint/{lines,writeback,report}.js` (+ retry sweep), desk panel per-line entry + push + PDF; tests `test-trustpoint-writeback-db` (18) |
| **4. Portal composer + close-outs** | ✅ built + audited | db/298, `src/lib/portal-draws.js`, staff desk routes + borrower composer routes/UI, Trinity order lifecycle + staff decision, historical close-out + re-drive sweep; tests `test-portal-draws-db` (43) |
| **5. Money mirror** | ✅ built + audited | db/299–301, `mirror.js` mirrorDisbursement/verifyPartnerFee, retainage precedence chokepoint, `trustpointUnreleasedOnce` digest, Released chip; tests `test-trustpoint-money-db` (22) |

Everything is staged OFF behind `TRUSTPOINT_ENABLED` (+ `SITEWIRE_*` switches); turning it on is provisioning (§8) + data entry, not a build.

| Phase | Contents | External dependency |
|---|---|---|
| **1. Routing + import tasks** | `draw_platform` column + Blue Lake rule; start-draw stops 422ing → routes; coordinator `trustpoint_import` task + email on Sitewire-submitted draws (per-line table from the existing mirror); method-aware notification/risk fixes | **None — immediate value** |
| **2. TrustPoint mirror** | linking desk + discovery sweep + webhook receiver + watermark polls; `trustpoint_draws` mirror + event→update map; borrower/staff updates; report-PDF archive; monitors/exposure gain `platform` dimension | Provisioning (§8) |
| **3. Write-backs + report** | per-line entry screen; Sitewire live-draw mirror (approved+comments+approve+quick-notify); branded report | Phases 1–2 |
| **4. Portal composer + close-outs** | staff composer → borrower composer; dedupe; historical-draw close-out (§5B); Path C Trinity order record + task (API-adapter-ready per D8) | Phase 1 (3 for close-outs) |
| **5. Money mirror** | poll-detected disbursements → mirror ledger rows + NET borrower email; approved-but-unreleased staff nudge; retainage precedence + $250 fee verification (D2/D6/D7) | Phase 2 |

Acceptance per phase: (1) a Blue Lake physical file submits in Sitewire and the coordinator has a task+email with the line table within minutes, nothing 422s; (2) every linked project's draw/status/inspection activity is visible on the draw desk within 5 minutes, zero writes; (3) an approved TrustPoint draw shows approved-per-line in PILOT + Sitewire and produces a branded report; (4) a coordinator/borrower composes a portal draw, it reaches TrustPoint via the task, and lands in Sitewire as an approved historical draw after approval, cent-exact; (5) an observed TrustPoint disbursement produces exactly one mirror ledger row and one NET borrower email, and a Blue Lake draw missing its $250 fee line raises a staff alert.

## 11. Owner decisions & remaining questions

All owner questions are answered — recorded as **D1–D9 in §0** (D9: the $250 is not YS revenue; no receivable tracking; dormant markup knob). Remaining open items are operational checks, not owner decisions:

- **Q-B (vendor, §8):** the remaining Sitewire behavior checks (borrower emails on approve/historical-create; `draw_eligible` vs historical POST).
- **Q-C (sandbox, §8):** whether TrustPoint milestone reads expose per-line completed/remaining amounts — decides §6 path 1 vs 2.
