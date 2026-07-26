# TrustPoint Public API vs Sitewire — Draw-Workflow Capability Comparison & Integration Roadmap

**Date:** 2026-07-24
**Sources:** TrustPoint Public API OpenAPI 3.1 spec (`docs/trustpoint/trustpoint-public-api-openapi.json`, servers `https://api.trustpoint.ai/` + sandbox `https://api.sandbox.trustpoint.ai/`); Sitewire API v2 (`docs/sitewire/SITEWIRE-API-v2.md`, `docs/sitewire/sitewire-api-v2-swagger.json`); our integration code (`src/sitewire/`, `src/routes/sitewire.js`, `src/sync/sitewire-sync.js`, `db/*sitewire*`); note-buyer materials (`src/lib/investor-guidelines/`, BlueLake RTL spec, TPR export).
**Method:** every capability claim below — especially every "TrustPoint CANNOT do X" — was checked directly against the raw specs (path/schema enumeration + keyword sweeps), then adversarially re-verified in a second pass. Nuances that survived verification are marked inline.

---

## 1. Plain-English summary (for the owner)

Sitewire and TrustPoint both manage construction draws, but the door they give our computer system is completely different.

- **Sitewire's door lets us DRIVE.** Our system pushes the budget in, sets the approved dollar amount on every single line, approves or amends the draw, pulls every inspection photo, and runs the borrower's accept-or-dispute step ourselves. Sitewire is our steering wheel.
- **TrustPoint's door lets us WATCH, SET UP, and REPORT MONEY — but not drive.** Through TrustPoint's connection we can create the project and budget at the start, upload documents (something Sitewire never let us do properly — we had to build a "robot" that fills in their website), get instant pings when a draw is created, submitted, reviewed, approved, or returned, see inspection orders and their timing, download their inspection report PDF, and tell TrustPoint "we wired this draw, here's the amount." What we can NOT do through it: approve a draw, change any line item's amount, edit the budget after it's locked, order an inspection, or pull inspection photos. Those all happen inside TrustPoint's own website, by a person.

That split actually matches the business: on BlueLake loans, TrustPoint is the note buyer's draw administrator — they run the approvals; we fund and service. Today those loans are **completely invisible** to our system: no draw status, no exposure numbers, no reminders, no records. The biggest win available is simply making them visible — mirroring everything TrustPoint knows into our draw desk and monitors, archiving their inspection reports, and closing the money loop automatically when we wire. The double-typing of project + budget into TrustPoint's website at loan sale can also be automated, and their document-upload connection retires our website robot for those files.

Before any building: we must find out **whose TrustPoint account we'd connect through** (BlueLake's, with us invited — or our own) and agree that our loan number gets stamped on each project at creation, because that stamp can never be changed later and it's how every ping they send gets matched back to our file.

---

## 2. The fundamental shape difference

| | Sitewire API (+ our workarounds) | TrustPoint Public API |
|---|---|---|
| Role it gives the integrator | **Operator** — PILOT runs the lender side of the draw | **Observer + onboarder + disbursement-reporter** |
| Draw actions (approve / amend / return / per-line amounts) | Yes — core of our approval desk | **None. Draws are 100% read-only** (only write anywhere near a draw: deleting a draw document, and the inbound "Draw Disbursed" event) |
| Who runs the draw workflow | Us (PILOT) | TrustPoint's own console (the note buyer's administrator) |
| Freshness model | Poll-only (5-min reconcile, full-collection lists, no filters) | **Webhooks (10 events) + filtered/paginated polling** (`updated_at__gte` watermarks) |
| Correlation | None — bind-by-name crosswalk + adopt machinery (`mapper.js`) | **`loan.external_id` + `milestone.external_id` + event `transaction_id`** — set once at creation, echoed as `loan_id` on every webhook |
| Document upload | No API — we built a browser robot (`web-client.js` + `doc-push.js`) | **Real multipart upload API** (project-level, async, no id returned — poll-verify) |
| Sandbox | None (we improvised with read-only test creds) | **Yes** (`api.sandbox.trustpoint.ai`) |

**Bottom line:** for TrustPoint-administered loans, PILOT's role inverts from lender-operator to **mirror + money-closer**. Several flagship PILOT features (per-line approval desk, per-line borrower findings grid with photos, dispute write-back, budget reallocation push) **cannot be rebuilt on this API** — by design, since TrustPoint owns the workflow for the buyer.

---

## 3. Capability matrix (condensed — full detail in the research notes)

Verdicts: **HAS** = TrustPoint covers it at least as well · **PARTIAL** = with material limits · **MISSING** = no endpoint.

### A. Project / loan setup
| Capability | TrustPoint | Verdict |
|---|---|---|
| Create project | `POST /public-api/projects/` — richer than Sitewire: address, inline borrower company + multiple users w/ roles (LENDER/OWNER/INVESTOR), legal entity, `retainage_rate`, payment configuration, funding `sources[]`, `fees[]`, property details, full **loan object** (external_id, budget_commitment, ARV/AIV, LTC/LTV/LTAIV, FICO, interest_method DUTCH/NON_DUTCH, 18 servicing statuses, 10 loan types, maturity dates, trade_id, fund/facility) | **HAS** (richer) |
| Update project | `PATCH` is narrow: name, scope, status(+reason), loan (partial), legal_entity, fees (replace-all), customer. Address / types / dates / retainage / sources are **create-only** | **PARTIAL** — our repush-on-edit for address/units/type can't be expressed post-create |
| Lifecycle | Status CREATED/ACTIVE/PAUSED/INACTIVE_INCOMPLETE/INACTIVE_COMPLETE/DISCARDED + reason (vs Sitewire's single `inactive` bool) | **HAS** |
| Progress visibility | `project_completion_rate`, lender/inspector allowance rates, `last_inspection_date` on project read | **HAS** (net-new) |

### B. Budget / SOW lines ("milestones")
| Capability | TrustPoint | Verdict |
|---|---|---|
| Create lines | `POST /milestones/` + `/milestones/bulk/` — name + `prefunding_amount` required, `external_id` supported, **only while budget is unlocked**, 201 returns no body | **PARTIAL** (create OK pre-lock; verify by re-GET) |
| Edit / delete / rename lines | **No PATCH/DELETE/GET-single — milestones are immutable via API** (post-lock: fully frozen) | **MISSING** — kills budget re-push, drift-restore, SOW line editor, reallocation apply |
| Read lines | `GET /milestones/` (paginated). Schema has budget fields only; endpoint description mentions "completed and remaining work amounts" **not defined in the schema — sandbox-verify** (if real, some per-line progress exists at project level) | **PARTIAL** |
| Per-line proof requirements (photo/video counts, mandatory) | None — our $0 media-anchor lines have no analog | **MISSING** |
| Draws-allowed switch (`draw_eligible`) | None (project status PAUSED is coarser, semantics unverified) | **MISSING** |

### C. Draw requests
| Capability | TrustPoint | Verdict |
|---|---|---|
| Read draws | Cross-project list w/ date-range (`submitted/approved/completed/updated_at` `__gt/gte/lt/lte`) + lender filters, paginated; detail: statuses DRAFT/IN_REVIEW/APPROVED/COMPLETED, type DRAW_REQUEST\|CHANGE_REQUEST, requested/approved/disbursed amounts, holdback-vs-equity split, credits, **fees[], retainage (4 fields), contingency (3 fields)**, inspector/lender allowance + recommendation rates, coordinator, 4 timestamps | **HAS** (aggregate level — richer money fields + real filters) |
| Per-line draw breakdown | **None — no per-milestone draw resource exists at all** | **MISSING** (single biggest functional gap) |
| Approve / amend / return / transition | **None** — observe-only via `DRAW_REQUEST_REVIEW_ADDED` webhook (review_action Submit/Approve/Finalize/Reject/Forward + team names) | **MISSING** — staff act inside TrustPoint's console |
| Write per-line approved amounts + lender comments | **None** (Sitewire: `PATCH /requests/{id}` — core of our approval desk and dispute push-back) | **MISSING** |
| Draw event history (replayable) | None — 4 timestamps only; review actions arrive **only** as webhooks (no replay; non-2xx deliveries are not retried) | **MISSING** (webhooks = push-only visibility) |
| Draw report PDF | `GET .../report/` → JSON metadata with `file` download URL (most recent generated report) | **HAS** (dedicated endpoint) |
| Coordinator / pipeline labels | Coordinator read-only; no quick-notify analog | **MISSING** |

### D. Inspections & media
| Capability | TrustPoint | Verdict |
|---|---|---|
| Order / schedule / cancel | None — service orders are **read-only** (parity: Sitewire has no ordering API either; policy-driven) | Parity |
| Status/timeline visibility | Service orders: 10 statuses, `ordered_at → scheduled_at → completed_at`, 8 service types (INSPECTION, TITLE, APPRAISAL, **FEASIBILITY**, BUILDER_INFORMATION_REPORT, **PERMIT_VERIFICATION_REPORT**, BPO, VERIFIED_MEDIA) + 3 webhooks | **HAS** (richer than Sitewire; feasibility/permit orders map to BlueLake conds 200/203) |
| Per-line inspector findings (amounts, comments) | **None** — only scalar `inspector_allowance_rate` (overall %) + `inspector_recommendation_rate` (% of requested) | **MISSING** — our findings-delivery product can't be fed from TrustPoint REST |
| Photos / videos (geo/time-stamped) | **No media API.** Nuance: photos MAY surface as project/draw documents (`document_type` examples include "photo", `file` is a download URL) — metadata-free at best; **sandbox-verify** | **MISSING** (PARTIAL at best) |
| Per-project inspection policy (method, require-inspector) | None — platform-side config | **MISSING** |

### E. Documents
| Capability | TrustPoint | Verdict |
|---|---|---|
| Upload to project | `POST /projects/{pk}/documents/` multipart (file+name+comment), **async — 201 `{status:"ok"}`, no id returned, poll list to verify** | **HAS** — retires the entire browser-robot subsystem |
| Upload to a draw | None (draw docs: list + delete only) | **MISSING** (project-level compensates) |
| List / download / delete | Yes (project + draw lists, `file` URLs, `document_type`) — URL longevity unknown, keep archive-on-receipt | **HAS** |

### F. Money
| Capability | TrustPoint | Verdict |
|---|---|---|
| Disbursement recording | **`POST /public-api/events/` "Draw Disbursed"** `{draw_id (req), loan_id, transaction_id, amount_requested/approved/disbursed}` → populates `disbursed_amount`/`disbursed_at` (outbound webhook `amount_disbursed` is documented always-null; disbursements flow inbound). The API's one draw-adjacent write — a funding-loop closure **Sitewire lacks entirely** | **HAS** (net-new; natural sink for our `draw_disbursements` ledger) |
| Fees | Project `fees[]` (create + replace-all PATCH), per-draw `fees[]` read, webhook `amount_to_disburse` = approved − fees. (Sitewire: 3 flat property fee-config fields our money.js already uses; no per-draw fee ledger) | **HAS** (richer) — overlaps PILOT fee math; pick a master |
| Retainage | Project `retainage_rate` (create-only) + 4 read-only draw fields (release requested/approved, holdbacks). Sitewire: zero retainage | **PARTIAL** (visibility yes, control no) — **dual-master risk vs PILOT's ledger: mirror TrustPoint's numbers, stop computing our own for these files** |
| Contingency | `contingency_total/used/used_rate` on draw detail | **HAS** (net-new) |
| Lien waivers / dispute flow | None (parity: Sitewire has none either — both PILOT-owned). BUT with Sitewire we can push a dispute's corrected amount via per-line PATCH; with TrustPoint a dispute outcome **cannot be written anywhere** | Waivers: parity · Dispute write-back: **MISSING** |
| Budget change / reallocation | Milestones immutable → **not expressible**; their change requests at least visible (draw `type=CHANGE_REQUEST` + webhooks) | **MISSING** (write) / PARTIAL (read) |

### G. People & comms
| Capability | TrustPoint | Verdict |
|---|---|---|
| Borrower users | Multi-user borrower company (create/patch users, inline members at project create) vs Sitewire's ONE email per property | **HAS** |
| Invite trigger / resend | **No invite endpoint** — statuses (INACTIVE "Pending invitation"/INVITED/ACTIVE/DEACTIVATED) imply platform-side invitations; our stuck-invite auto-heal has no lever — **verify with vendor** | **PARTIAL** |
| Companies / roles | List own+invited companies; enroll on project w/ role LENDER/OWNER/INVESTOR; create-by-name | **HAS** |
| Comments | Project-level threaded comments (tags, replies, company addressing, filters by draw/milestone/document/service order); draw comments GET-only; no author field on reads | **HAS** (with draw-scoped-posting caveat) |
| Draw checklist templates | None | **MISSING** |

### H. Plumbing
| Capability | TrustPoint | Verdict |
|---|---|---|
| Webhooks | Full CRUD per company; 10 events: Draw Created/Submitted/Review Added/Approved/Returned/Deleted, Project Changed (tracked-field diffs), Service Order Ordered/Completed/Cancelled. **No Project Created, no Draw Completed, no document/comment/milestone/user events.** 30s ack; 3 retries on timeout/network only — **non-2xx deliveries are NOT retried, no replay endpoint** → polling backstop mandatory | **HAS** (with weak-delivery caveat) |
| Polling | limit/offset pagination, date-range + lender filters, RestQL field selection (Sitewire: zero params, full-collection pulls) | **HAS** |
| Rate limit | Documented: decreasing 2,000 → 600 rpm (announced Nov 2025, gradual; whether per-key or company-wide is unstated — budget conservatively) | **HAS** (documented at all) |
| Sandbox | Yes | **HAS** |
| Auth | Single company-scoped key: `Authorization: Api-Key <key>` (Org Settings → API Configuration) | Parity (simpler) |
| Money format | REST: **dollar doubles**; webhooks: **decimal strings**; rates inconsistently 0–1 vs 0–100 (service orders) — PILOT is integer-cents: one transform module + epsilon compares, never float `===` | Sitewire cleaner (integer cents) |
| Idempotency | None documented; POST project returns `{id}` only; doc upload + milestone create return no body. `POST /events/` carries OUR uuid → retry-safe. `external_id` makes duplicate *detection* easy | Parity (same no-POST-retry discipline) |
| Spec quirks | Paths say `/public-api/…`, all prose/curl says `/v1/…` (treat as aliases — verify); draw detail example contradicts its own enums (`type:"CONSTRUCTION"`, integer number) — parse defensively | — |

---

## 4. What Sitewire + our integration does that the TrustPoint API cannot (ordered by blast radius)

1. **Write per-line approved amounts + lender comments** (kills: approval desk writes, dispute push-back, money-override journaling).
2. **Drive draw transitions** (approve/amend/reopen) — YS staff operate inside TrustPoint's console; PILOT mirrors only.
3. **Read per-line draw breakdown** (kills as-is: `sitewire_draw_requests` mirror, per-line findings grid, line-level risk flags `unknown_line`/`line_oversubscribed`/`front_loading`-at-line, reverse per-unit rollup, reallocation cells).
4. **Edit/delete/rename budget lines after creation** (kills: budget re-push, drift restore, `sow-line-edit.js`, reallocation apply).
5. **Access geo/time-stamped inspection media** (kills: `media-archive.js` for photos, branded photo PDFs, findings media display).
6. **Read per-line inspector findings** (comments, amounts).
7. **Enforce per-line proof requirements** (required image/video counts, mandatory items).
8. **Toggle draws-allowed** (`draw_eligible`).
9. **Set the draw coordinator** (read-only in TrustPoint).
10. **Quick-notify pipeline labels** (no analog).
11. **Set per-project inspection policy** (our `sitewire_inspection_rules` engine has nothing to write to).
12. **Assign a draw checklist template.**
13. **Trigger/resend borrower invites.**
14. **Update project address/units/property-type post-create** (repush-on-edit can't be honored for those fields).
15. **Pull replayable draw event history** (a missed webhook is unrecoverable).
16. Historical draw backfill · site-check deliverable detail · 304 write-idempotency semantics (minor / unused).

**Non-issues** (absent from both, PILOT-owned, port cleanly): lien waivers, dispute data model, wire ledger mechanics, branded reporting shell, aggregate-level risk/monitor engines (stale/overdrawn/past-maturity still computable from TrustPoint draw totals + timestamps).

## 5. What the TrustPoint API adds that Sitewire lacks

1. **Outbound webhooks** (10 events, API-managed, filterable, 4 auth modes incl. OAuth2 refresh).
2. **Inbound "Draw Disbursed" event** — closes the funding loop; direct sink for `draw_disbursements`.
3. **Sandbox environment.**
4. **Real document-upload API** — retires `web-client.js`/`doc-push.js` browser robot.
5. **External correlation ids** (loan/milestone/event) — obsoletes bind-by-name, uniquify, and most adopt logic in `mapper.js`.
6. **Rich loan/servicing model** (18 servicing statuses, UPB, interest reserve, maturity dates, trade_id, fund/facility) + Project Changed diffs on those fields.
7. **Native retainage + per-draw fee ledger + net-to-disburse** (`amount_to_disburse` = approved − fees).
8. **Contingency tracking** + **funding-source split** per draw (holdback vs borrower equity).
9. **Service orders across 8 service types** with status timeline incl. `scheduled_at` + webhooks.
10. **Project-level progress metrics** (completion rate, allowance rates) — progress without a draw.
11. **Multi-user borrower company management.**
12. **Threaded project comments** with tags/replies/addressing/filters.
13. **Filtered, paginated, watermark-able polling** + documented rate limits + parseable error codes.
14. **Richer project lifecycle taxonomy** with change reasons.
15. **Dedicated draw-report endpoint**; **change-request visibility** (draw type=CHANGE_REQUEST).

---

## 6. Where TrustPoint fits the current draw workflow, stage by stage

Legend: **(a)** today via Sitewire · **(b)** TrustPoint equivalent · **(c)** stays manual in TrustPoint's web app · **(d)** plumbing reused.

**Context (repo-verified):** TrustPoint has zero presence in the repo today. Externally-administered files are handled by `sitewire_inspection_rules.handled_externally` (start-draw 422s; nothing pushes; nothing recorded) — the post-sale draw life of such loans is completely off-system. Note: current seed data links "Blue Lake" as a *Sitewire* capital partner (directory id 41) and only Churchill is seeded as handled-externally — "BlueLake draws administered on TrustPoint" is owner-stated business reality to be wired as per-file routing config, not something the repo encodes yet.

1. **Onboarding / draw setup.** (a) `orchestrator.pushFile` birth push + borrower assign + welcome email. (b) One `POST /projects/` carries everything (incl. borrower company + users inline, retainage, fees, sources, loan w/ `external_id` = YS loan number — **the immutable correlation key**; `interest_method` NON_DUTCH per BlueLake). (c) Borrower invite trigger; inspection/review policy; anything address/dates/retainage post-create; under Topology A (below) the whole stage may be BlueLake-side → PILOT does a **link/adopt step** instead. (d) `sync_queue` outbox (`target='trustpoint'`), park machine, advisory locks, transforms (+ cents→dollars), write journal, kill switches, welcome email with a TrustPoint branch.
2. **Budget / SOW load.** (a) `explodeSow` → `PATCH /budgets/{id}`, bind-by-name. (b) `POST /milestones/bulk/` **before budget lock**, with `milestone.external_id` = PILOT SOW-line key (kills the crosswalk machinery); re-GET to verify Σ = frozen rehab budget to the cent. Consider 1:1 SOW-line mapping instead of per-unit explosion (no per-line draw data comes back either way). (c) Any later edit/delete; reallocations; per-line media requirements; lock/unlock. (d) `explodeSow` (minus media anchors), Σ-guard, drift-verify pattern, simplified links table keyed by external_id.
3. **Borrower draw initiation.** (a) Borrower submits in the platform's app (same on both); PILOT mirrors by poll. (b) Event-driven mirror: `DRAW_REQUEST_CREATED`/`SUBMITTED` webhooks → hydrate detail; backstop poll `?updated_at__gte=`; eligibility card points at TrustPoint's portal. (c) Submission UX; draft deletes; change requests. (d) `reconcile.js` watermark/baseline patterns; **NEW: a public webhook receiver route** (none exists for Sitewire) — auth-validated, 2xx-in-30s, enqueue-then-process, dedupe on event+resource ids (delivery id is a fresh UUID per retry).
4. **Inspection.** (a) Per-line inspector output + media. (b) Service-order mirror (3 webhooks + GETs; `scheduled_at`; FEASIBILITY / PERMIT_VERIFICATION orders inform BlueLake conds 200/203) + scalar draw rates. (c) Ordering/scheduling; per-line findings; media. (d) `monitor.js` staleness (add ordered-not-completed alert); NOT `media-archive.js` for photos — archive the report PDF instead.
5. **Findings delivery / accept–dispute.** (a) Crown jewel: per-line grid + photos, accept/dispute tokens, corrected amounts pushed back. (b) Draw-level skeleton only: on FINALIZED/RETURNED, deliver "approved $X of $Y — report attached" + optional draw-level accept to preserve the wire-SLA trigger. (c) **Effectively the whole stage** — no per-line data, no media, no write-back, no draw-comment POST. Recommendation: don't port accept/dispute for TrustPoint loans; TrustPoint's Returned/review flow owns it. (d) Borrower-safe scrub (**add "trustpoint" to partner patterns**), notify chokepoints, token infra if draw-level accept kept.
6. **Staff review / approval.** (a) Per-line desk + transitions. (b) **Observation only**: REVIEW_ADDED ticker (actor/team/action), FINALIZED/RETURNED, draw-level rates/credits/contingency. Draw-level risk flags still computable. (c) Every decision. Desk badge: "Administered by TrustPoint — view + money only; act in TrustPoint." (d) Desk UI read-only variant; `risk.js` minus per-line flags; `rollup.js` degraded to project level; `monitor.js` fully.
7. **Wire / release.** (a) Entirely PILOT (`computeRelease`, waiver gate, ledger, borrower net-amount email, SLA). (b) **The fit-like-a-glove piece**: on recording a release, fire `POST /events/` "Draw Disbursed" (`transaction_id` = disbursement row ref; idempotent by our uuid → outbox-retry-safe); cross-check webhook `amount_to_disburse` vs `computeRelease`. (c) The wire itself (as today); DocuSign wire form, waivers, GL export unchanged. (d) `draw_disbursements` + `money.js` verbatim (+ `trustpoint_draw_id` column); SLA clock from accept or FINALIZED.
8. **Retainage.** (a) 100% PILOT-computed (Sitewire has none). (b) **TrustPoint is retainage system-of-record**: mirror its 4 draw fields; **disable PILOT-side retainage computation for TrustPoint files** (double-withholding risk if both subtract). (c) Requesting/approving releases; changing the rate post-create. (d) `kind='retainage_release'` ledger rows; release-drift alert repointed.
9. **Reporting / archive.** (a) Media archive, branded PDFs, packet/GL exports, pull-audit, SharePoint mirror. (b) Archive TrustPoint's report PDF (`.../report/`) as `doc_kind='draw_inspection_report'`; mirror document lists; `PROJECT_CHANGED` diffs → audit trail. (c) Per-line schedule-of-values reporting; raw media archive; regenerating old reports (only most-recent retrievable). (d) SSRF-guarded fetch pipeline, documents rows + SharePoint mirror, exports (packet loses per-line SOV section for TrustPoint files).
10. **Buyer reporting.** (a) Nothing programmatic post-sale; TPR is pre-purchase; buyer sits inside Sitewire as capital partner for Sitewire files. (b) **Largely inverts** — BlueLake is native in TrustPoint and already sees everything; YS's duties collapse to the Draw Disbursed event + keeping loan/servicing fields current (`PATCH` servicing_status/UPB/interest-reserve/next-due/trade_id). TrustPoint loans re-enter the per-partner exposure rollup and monitors (they're invisible today). (c) Purchase advice / remittance (unchanged); TPR ZIP (unchanged — optionally push key docs, Phase 4). (d) Portfolio/monitor surfaces gain a `platform` dimension (sitewire | trustpoint | none), replacing bare `handled_externally`.

---

## 7. Phased integration roadmap

**Phase 0 — Provisioning & decisions (blocking, mostly non-engineering).**
- **Resolve account topology — THE open question.** The API key is company-scoped; 404 = "not visible to your company". Topology A: BlueLake's TrustPoint org creates projects; YS is enrolled per-project (role LENDER) with its own key → Phases 3–4 are mostly moot; the critical ask becomes **"`loan.external_id` = YS loan number at every project creation"** (immutable after; it's the `loan_id` on every webhook — without it, correlation degrades to address/name heuristics + human confirm). Topology B: YS's own org; YS pushes projects and enrolls BlueLake as INVESTOR → full roadmap applies. Owner framing ("BlueLake uses TrustPoint") suggests A or hybrid — resolve with BlueLake/TrustPoint before Phase 1.
- Decide **who funds TrustPoint-loan draws** (`estimated_reimbursement_date` + inbound-disbursement design imply lender-funds-then-reimbursed — confirm; determines whether our wire ledger drives or mirrors).
- Sandbox verification list: live path prefix (`/public-api/` vs `/v1/`), document `file` URL auth/longevity, whether inspection photos appear as typed documents, milestone-list "completed/remaining work amounts" (description vs schema), inbound event types beyond "Draw Disbursed", invite mechanics, webhook payload realities.
- Config surface mirroring Sitewire's: `TRUSTPOINT_ENABLED` / `_OUTBOUND_ENABLED` / `_DRYRUN` / `_API_KEY` / base URL / poll seconds + sandbox credential set (never-guess field verification, `test-explorer` pattern).

**Phase 1 — Read-only mirror (GET + webhooks; zero writes).**
Register webhook endpoint (all 10 events) + new receiver route; hydrate + backstop-poll projects, draws (`updated_at__gte` watermark), service orders, milestones, documents, comments; archive report PDFs; `trustpoint_project_links` (adoption is the **norm** under Topology A — match on external_id when present, else address heuristic + human confirm, partner-links pattern) + `trustpoint_draws` mirror (no per-line child table — none exists); staff notifications via a curated event→notify map; monitors/exposure gain the `platform` dimension; read-only desk panel.
*Pain removed: BlueLake loans stop being invisible — status, exposure, SLAs, audit, archived inspection reports; coordinators stop chasing by email.*

**Phase 2 — Disbursement close-loop (first write, minimal surface).**
Fire "Draw Disbursed" from the existing disbursement flow for TrustPoint-linked draws; read-after-write verify `disbursed_amount`/`disbursed_at`; mirror retainage fields; disable PILOT retainage computation for these files; cross-check `amount_to_disburse` vs `computeRelease`; park on `status:"rejected"`.
*Pain removed: manual "we funded draw N" reporting; two-system money mismatch.*

**Phase 3 — Project + budget push at onboarding (Topology B, or delegated under A).**
Types lookup cache → `POST /projects/` (full payload; external_id from birth) → `POST /milestones/bulk/` (external_id crosswalk; Σ-to-the-cent as a **hard pre-gate** — a botched push is fixable only in TrustPoint's UI) → enroll companies → narrow PATCH corrections. No invite trigger exists — welcome email says "look for TrustPoint's invitation".
*Pain removed: double-entry of project + line-item budget at loan sale (BlueLake's Excel line-item budget requirement maps 1:1 from PILOT's SOW).*

**Phase 4 — Documents, comments, users.**
Multipart doc push (appraisal, SOW, feasibility, permits — poll-verify by name, sha256 dedupe; retires the browser-robot pattern for these files); project comments wired to the coordinator message box (no author field — attribute in message text); user/contact provisioning + corrections.

**Phase 5 — Servicing sync + drift.**
Servicing-triggered `PATCH` (servicing_status, UPB, interest reserve balance, next due, extended maturity, trade_id; project status close-out ↔ lifecycle actions); `PROJECT_CHANGED` consumed as two-sided drift detection (restore/accept review pattern); hourly milestone drift verify (report-only for unpatchable fields).

**Deliberately out of scope at every phase (the API cannot):** borrower draw submission from our portal, per-line approval desk, dispute write-back, inspection ordering, budget reallocation push, media archive, pipeline labels — these remain in TrustPoint's web app, and the routing UI must set staff expectations accordingly.

---

## 8. Cross-cutting risks & guardrails

1. **Borrower-safe scrubbing is non-negotiable** — "TrustPoint" and "BlueLake" are staff-only names (Gold Standard program rule). Add `trustpoint` to the partner patterns in `src/lib/borrower-safe.js`. TrustPoint's report PDF may itself carry TrustPoint/BlueLake branding — review before any borrower-facing delivery (possibly staff-only).
2. **Money formats**: dollar-doubles (REST) / decimal-strings (webhooks) / integer-cents (PILOT); rates 0–1 vs 0–100 by resource; one transform module, epsilon compares, property-based tests.
3. **Fail-closed write guards** (journal, read-after-write, dry-run, kill switches, no-retry on non-idempotent POSTs) for all 5 write families — even with the draw-decision surface gone.
4. **Two-platform routing**: a file must never be live on both pipelines; route on `normNoteBuyer` + explicit per-rule `platform`; define the mid-construction handover runbook (Sitewire deactivate + TrustPoint link/push) for loans sold to BlueLake mid-project.
5. **Webhook delivery is best-effort** (3 retries on network errors only; non-2xx dropped; no replay) → the watermark poll is a mandatory reconciliation backstop, not a nice-to-have.
6. **Rate budget**: assume 600 rpm company-wide worst case; webhooks make deep polling unnecessary.
7. **Never-guess policy carries over**: spec examples contradict their own enums in places; verify every trusted field on sandbox first.
