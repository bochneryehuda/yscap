# Sitewire Draw-Management — Research, Full Field Mapping & Detailed Proposal

_Owner-requested, 2026-07-19. Research + design only — nothing implemented yet. This is the
build spec the owner reviews before code. Grounded in a live read-only walk of the real Sitewire
account (lender **id 236**, 35 properties, 81 draws), the Sitewire OpenAPI, and a deep read of the
existing ClickUp/SharePoint integration patterns. No credentials appear in this document._

---

## 0. What we're building (plain terms)

A full construction **draw-management system inside the PILOT portal** that connects to Sitewire.
PILOT automatically **pushes** each funded loan's property, construction budget, borrower, and
inspection rules into Sitewire; **mirrors** every draw's status back; gives staff a **draw desk**
to review/approve/trim/release; gives borrowers **live status**; and owns the **money ledger**
(fee, net release, dates) that Sitewire doesn't model — all built the YS way: nothing guessed,
every write guarded and journaled, anything unusual parked for a human.

### Owner decisions locked
1. **Borrower draws:** Sitewire owns borrower submission + photo upload; PILOT tracks/reminds.
2. **First version:** auto-sync push + reconcile + the lender draw desk + money ledger.
3. **Money:** requested, approved, **our fee**, **net release**, **dates**, fulfillment. No lien
   waivers, no wire reference numbers for now.
4. **Location:** inside the PILOT portal (this repo).
5. **Credentials (owner-authorized):** the provided Sitewire credentials are used as-is; they live
   in Render's secure settings, never committed to the repo. Rotation optional/owner's choice.
6. **Budget shape (this doc's core):** our SOW keeps one line with per-unit columns; Sitewire keeps
   **one line per unit**. We must explode on push and roll back up on pull — reversibly.
7. **Draw coordinator:** add a Draw-Coordinator persona in PILOT; default **Lisa Katz**; admin can
   override the coordinator rules later.

---

## 1. The two systems, side by side

| Concept | YS / PILOT | Sitewire |
|---|---|---|
| Construction project | `applications` row (one per property) | **Property** (`id`) |
| Lender | YS Capital | **Lender** (id **236**) |
| Note buyer | `applications.lender` (free label, staff-only) | **Capital Partner** (`id`) |
| Borrower | `borrowers` + vesting `llcs` | **Borrower** (assigned by email) |
| Construction budget | `applications.rehab_budget` (frozen) + SOW line items | **Budget** (`id`) + **Job Items** |
| A budget line | one SOW line, per-unit **columns** | **one Job Item per unit** |
| Draw | _(net-new)_ | **Draw** (`drafting→…→approved`) |
| Per-line request | _(net-new)_ | **Request** (`requested_cents`/`approved_cents`) |
| Inspection media | _(net-new)_ | **Request.inspections[]** (geo-tagged) |
| Site check | _(net-new)_ | **Deliverable Update** |
| Draw coordinator | Draw-Coordinator persona (new) | property `default_draw_coordinator_id` |
| Pipeline label | _(net-new)_ | **Quick Notify Status** |
| Fee / net release / dates | **our ledger** (new) | not modeled (static property fee only) |

---

## 2. Complete field mapping (every Sitewire field ↔ our field)

Legend — **W** = we can write it (as lender_owner), **R** = read-only. "Guard" names the never-guess
protection (see §7 for the full catalog).

### 2.1 Property — `POST /properties`, `PATCH /properties/{id}`
| Sitewire field | R/W | YS source / rule | Guard |
|---|---|---|---|
| `address{street,city,state,zip,unit}` | W | `applications.property_address` (jsonb `{line1,unit,city,state,zip}`) via `src/lib/address.js normalizeAddress` → street=`line1` | **G-ADDR**: Sitewire 422 geocode fail → review, never a guessed address |
| `loan_number` | W | `applications.ys_loan_number` | **G-LOAN**: blank loan number → block push |
| `capital_partner_id` | W | `applications.lender` label → Sitewire capital-partner id (directory `GET /capital_partners`) via a staff-confirmed name→id map | **G-CP**: no confident match → review |
| `borrower_entity_name` | W | `llcs.entity_name`/`llc_name` via `applications.llc_id` | — |
| `total_units` | W | `applications.units` | **G-UNITS**: units vs SOW unit count mismatch → review |
| `development_type` (`single_family_residential`/`multi_family_residential`/`commercial`/`other`) | W | map from `applications.property_type` (SFR→single_family, Multi 2-4/5+→multi_family, Mixed/other→other) | **G-ENUM**: unrecognized type → leave null + review, never guess |
| `construction_type` (`rehabilitation_or_remodel`/`ground_up`) | W | map from `loan_type`/`rehab_type` (Ground-up→ground_up else rehab) | **G-ENUM** |
| `inspection_method` (`mobile`/`traditional`) | W | **inspection-rules engine** (per capital partner) | — |
| `require_sitewire_inspector` | W | rules engine | — |
| `require_capital_partner_approval` | W | rules engine (default false — 35/35 live are false) | — |
| `allow_reallocation` | W | rules engine (default false) | — |
| `processing_fee_cents` | W | **fee schedule** (virtual $299 / physical per partner) | **G-FEE**: live fee ≠ configured schedule → review, never silent overwrite |
| `money_transfer_fee_cents` | W | default 0 | — |
| `other_fees_cents` | W | default 0 | — |
| `default_draw_coordinator_id` | W | Draw-Coordinator persona → Sitewire lender user id (Lisa Katz=16146) via **email map** | **G-USER**: staff email not a Sitewire lender user → review |
| `draw_checklist_template_id` | W | default **84** (the lender's "Checklist") | — |
| `start_date` / `end_date` | W | `actual_closing` / loan maturity | — |
| `project_id`, `lockbox_code` | W | optional; blank unless set | — |
| `inactive` | W | false while active; true when `status∈{withdrawn,declined}` | — |
| `budget{id,…}`, `deliverables[]`, `documents[]`, `borrower.status` | R | mirror into PILOT | — |

### 2.2 Borrower assignment — `PATCH /properties/{id}/borrower`
| Sitewire field | R/W | YS source | Guard |
|---|---|---|---|
| `contact_email` | W | `borrowers.email` (primary borrower of the file) | **G-EMAIL**: invalid/blank → 422 → review |

### 2.3 Budget — `PATCH /budgets/{id}`
| Sitewire field | R/W | YS source / rule | Guard |
|---|---|---|---|
| `funding_ratio` (1–100) | W | rules engine (default 100) | — |
| `funding_threshold_cents` | W | default 0 | — |
| `draw_eligible` | W | true once funded AND budget reconciles | **G-RECON** |
| `job_items[]` | W | **exploded SOW cells** (§4) | §4 guards |
| `total_budgeted_cents`, `total_approved_cents`, `balance_cents` | R | cross-check vs our ledger | **G-RECON** |

### 2.4 Job Item — inside `budget.job_items[]`
| Sitewire field | R/W | YS source / rule | Guard |
|---|---|---|---|
| `id` | (assigned) | captured from PATCH response into our crosswalk | **G-BIND** |
| `name` | W | deterministic `"Unit <n> - <line>"` / `"Common - <line>"` / `"Exterior - <line>"` / `"Project - <line>"` | **G-NAME**: collision → disambiguate/review; never rename after a draw exists (422) |
| `budgeted_cents` | W | `lineSectionVal(cell)` × 100 (floor + residual) | **G-SPLIT**, **G-LOWER** |
| `required_image_count` | W | rules engine default (e.g. 5) | — |
| `required_video_count` | W | rules engine default (e.g. 0) | — |
| `mandatory` | W | false for budget lines; **true** for media anchors | — |
| `_destroy` | W | true when a cell is removed AND no draw references it | **G-DELREF** |
| `available_cents`, `total_approved_cents`, `total_released_cents`, `description`, `*_status`, timestamps | R | reconcile / display | **G-RECON** |

### 2.5 Draw — `GET /draws`, `GET /draws/{id}`, `PATCH /draws/{id}`, `/approve` `/amend` `/reopen`
| Sitewire field | R/W | YS source / rule | Guard |
|---|---|---|---|
| `status` (`drafting`,`pending_borrower`,`inspecting`,`pending`,`pending_capital_partner`,`approved`) | R | mirror into `sitewire_draws` | — |
| `coordinator_id` | W (`PATCH /draws`) | Draw-Coordinator persona | **G-USER** |
| `quick_notify_status_id` | W | our pipeline label | — |
| approve / amend / reopen | W (transition) | staff action on the desk | **G-ROLE**: only valid transition for our role/status |
| `number`,`total_requested_cents`,`total_approved_cents`,`pdf_src`,`draw_events[]`,`borrower_id` | R | mirror; derive `submitted_at`/`approved_at` from events | — |

### 2.6 Request — `GET /requests/{id}`, `PATCH /requests/{id}`
| Sitewire field | R/W | YS source / rule | Guard |
|---|---|---|---|
| `approved_cents` | W | staff-set approval on the desk | **G-APPRV**: never exceed requested/budget without override |
| `lender_comments` | W | staff note | — |
| `requested_cents` | R | borrower's ask (mirror) | — |
| `job_item{id,name,…}` | R | **reverse crosswalk key** (§4.4) | **G-UNKNOWN** |
| `inspections[]{media,lat,lng,captured_at}` | R | show on the desk | — |
| `inspector_comments` | R | show | — |

### 2.7 Quick Notify Status — full CRUD (`/quick_notify_statuses`)
| field | R/W | YS source | Guard |
|---|---|---|---|
| `name` | W | staff-defined pipeline labels ("Sent to wire dept", …) | — |
| `id`,`lender_id` | R | mirror | — |

### 2.8 What Sitewire does NOT expose (our ledger owns it)
`fee per draw` (only static property fee), `net release to borrower`, `release date`, `retainage`,
`lien waivers`, `wire reference`. Modeled in **`draw_disbursements`** (§6). No webhooks → we **poll**.

---

## 3. Draw-Coordinator persona + staff ↔ Sitewire-user map

- **Persona:** add `draw_coordinator` to the persona/capability layer in `src/lib/permissions.js`
  (alongside `loan_coordinator`), granting the draw-desk capabilities (see draws, set approved,
  approve/amend/reopen, record releases). Assignable to staff by an admin.
- **Default coordinator = Lisa Katz** (Sitewire user **16146**). Pushed as the property's
  `default_draw_coordinator_id`. Admin-overridable later per file / per capital-partner rule.
- **Staff ↔ Sitewire user map:** add `sitewire_user_id` to `staff_users`, matched by email against
  `GET /lenders/236.users` (yehuda/chaya/goldy/esther/lisa/draws@). A coordinator whose email isn't
  a Sitewire lender user → **G-USER** review (never guess an id).

---

## 4. THE CORE: SOW ⇄ Sitewire per-unit budget crosswalk

This is the hardest, most important piece. Our SOW keeps **one line with per-unit columns**;
Sitewire keeps **one line per unit**. We explode on push and roll back up on pull — reversibly.

### 4.1 Our budget "cells" (source of truth)
The SOW payload lives in `checklist_items.tool_payload` (jsonb, `tool_key='rehab_budget'`) as raw
state; the server recomputes each cell's dollars via the tool's own math (`lineTotal`/
`lineSectionVal`, string-parsed with `num()`). Every **atomic cell** has a stable identity:

- **`sow_line_key`** — the single SOW line: `"catId:index"` (taxonomy) or `"x:<id>"` (custom).
- **`section_token`** — `all` (single-family) · `u1…uN` (per unit) · `common` · `exterior` · `project`.
- **dollar** — by the line's `applies` mode: `each`→same `num(each)` for every unit (N cells);
  `split`→`num(u.uK)` per unit (N cells); `common`/`exterior`/`project`→one cell; single-family→one
  `num(each)`.
- **name** — `label || taxonomy/custom original`; split+`perUnitDesc` can carry a per-unit description.
- **Contingency + GC fee** — flat project-wide figures (no unit); pushed as their own job items
  ("Project - Contingency", "Project - GC Fee") so Sitewire's budget total reconciles to the cent.

### 4.2 Explosion → Sitewire job items
Each cell becomes one job item with a **deterministic name**:
- unit cells → `"Unit <n> - <line name>"` (matches live Sitewire, e.g. "Unit 1 - HVAC-Furnace")
- `common`/`exterior`/`project` → `"Common - <name>"` / `"Exterior - <name>"` / `"Project - <name>"`
- single-family → `"<name>"`
Plus the **$0 mandatory media anchors** ("Exterior of House Photos", "Interior Video Tour") that
gate every draw — created once, `mandatory:true`, `budgeted_cents:0`, positive media counts.

### 4.3 The crosswalk table (durable, reversible) — `sitewire_job_item_links`
Because Sitewire job items have **no external-id/metadata field** (verified), our own table is the
bridge. One row per exploded job item:

`application_id, sitewire_budget_id, sow_line_key, section_token, unit_index, sitewire_job_item_id,
name, budgeted_cents, is_media_item, state ('pending'|'live'|'orphan_review'|'deleted'),
last_response_hash, last_pushed_at`. Unique on `(sitewire_budget_id, sitewire_job_item_id)` and on
`(application_id, sow_line_key, section_token)`; indexed on `sitewire_job_item_id` for reverse lookup.

**Id capture (first push):** send creates (no `id`) with unique deterministic names → read the PATCH
200's full `job_items` → bind each sent item to the response item with the **same unique name**
(order is a cross-check only) → store its `id`. Any name missing or doubled → bind only the
unambiguous rows, **park the rest** (**G-BIND**). After first bind, identity is **always** the
`sitewire_job_item_id` — a later human rename in Sitewire can't detach it.

### 4.4 Push algorithm (idempotent, never duplicates)
Per file, per push, driven entirely by the crosswalk:
1. Compute the desired set of `(sow_line_key, section_token, unit_index) → {name, budgeted_cents,
   media, mandatory}` from the current SOW (+ contingency/GC + media anchors).
2. Diff against crosswalk rows for this budget:
   - desired, **no** crosswalk id → **CREATE** (no `id`; capture id after).
   - desired, **has** id, value changed → **UPDATE** (`{id, budgeted_cents, …}`, changed fields only,
     echo-hash suppresses no-ops). Never re-send `name` after a draw exists.
   - crosswalk id, **no** desired row → **DELETE** (`{id,_destroy:true}`) **only if** no draw
     references it, else **G-DELREF**.
3. One PATCH carries creates+updates+deletes together. An already-bound cell always carries its id →
   becomes an UPDATE, never a second CREATE ⇒ **re-push never duplicates**.
4. Gate: `Σ desired budgeted_cents` must equal the frozen `requiredRehabBudget()`; post-PATCH,
   `Budget.total_budgeted_cents` must equal it too (**G-RECON**). Journal every write.

### 4.5 Reverse reconciliation (their per-unit draws → our one line)
1. For each pulled `request`: read `request.job_item.id`, `requested_cents`, `approved_cents`
   (nullable — null = in-flight, not drawn).
2. Look up `sitewire_job_item_id` in the crosswalk → `(sow_line_key, section_token, unit_index,
   is_media_item)`. Media anchors excluded from dollars. No crosswalk hit → **G-UNKNOWN**.
3. Aggregate: per unit `unit_drawn = Σ approved`, `unit_remaining = budgeted − unit_drawn`; per SOW
   line `line_drawn = Σ approved across units`, `line_remaining = line_budget − line_drawn`;
   in-flight = `Σ requested − Σ approved`.
4. Cross-check against Sitewire's read-only rollups (`job_item.total_approved_cents`/`available_cents`,
   `Budget.total_approved_cents`/`balance_cents`); any divergence → review, never a silent fix.
5. Present drawn-vs-remaining back in the **one-line-per-cell** SOW shape staff already know.

---

## 4.6 THE TRIGGER — the integration is "born" on the Request-a-draw click

**Nothing pushes to Sitewire on `funded` alone.** The whole integration is **born** for a file only
when BOTH are true: the file is `status='funded'` **and** someone clicks **"Request a draw"** (the
existing borrower/staff button, `borrower.js:300`, one-shot `draw_setup_requested_at`). That click is
the birth event: it fires the first push (property → borrower → exploded budget → rules/fees/
coordinator), and only then does PILOT begin mirroring draws for that file. Before that click a
funded file has NO Sitewire footprint from us. (Re-clicks stay one-shot; re-pushes are idempotent.)

## 4.7 Managed vs legacy budgets (grounded in the real 35)

Live data proves the existing 35 Sitewire budgets are **hand-entered and wildly inconsistent** —
`Unit 1 - Demo` (prefix) vs `Demo … unit 1` (suffix) vs no unit at all; media counts set on some
lines and not others; a `Contingency`/`Other (Contingencies)` line on some; Unit 1 fully itemized
while Units 2–3 carry 4 lines; some budgets **empty** (0 items). We therefore split budgets into two
regimes and **never guess** across them:

- **PILOT-managed** — a budget WE created by pushing our exploded SOW. Clean deterministic names, a
  full `sitewire_job_item_links` crosswalk, and full roll-up of draw requests back to our SOW cells.
  This is the path for every file born via the trigger above.
- **Legacy / unmanaged** — a budget already hand-entered in Sitewire (the current 35). We **adopt the
  property link by loan number** and **mirror its draws read-only at the Sitewire-line level** (show
  "Unit 1 - Demo & Trash: $X drawn of $Y"), but we do **NOT** reverse-map its messy lines to our SOW
  cells (that would require guessing) and we do **NOT** overwrite it. A staff-only "migrate to
  PILOT-managed" action can later replace a legacy budget with our clean exploded version — allowed
  only when it reconciles and is safe (guarded by G-DELREF / G-MIDFLIGHT). Until then it stays
  read-only mirror. This is what "only reasonable stuff gets there" means for the back-catalog.

## 5. End-to-end workflow

1. **Adopt existing (read-only):** match the 35 Sitewire properties to loans by `loan_number`; build
   links marked **legacy**; produce a **match report**; ambiguous → review. Zero writes.
2. **Birth on Request-a-draw (funded files only):** when a `funded` file's "Request a draw" is
   clicked and its SOW reconciles, push property → assign borrower → push budget/job-items (exploded,
   **PILOT-managed**) → apply inspection rules + fees + coordinator. All guarded. Nothing before this.
3. **Borrower draws in Sitewire:** Sitewire invites the borrower; they submit + upload photos; the
   inspector (or Sitewire inspector) reviews. PILOT shows live status + reminders.
4. **Reconcile back (poll):** mirror draws/requests/status/events; roll up to our SOW lines
   (PILOT-managed) or show at Sitewire-line level (legacy).
5. **Draw desk (staff):** review requested vs approved per line/unit with inspection photos; set
   `approved_cents` + comments; approve/amend/reopen; set quick-notify label.
6. **Money ledger:** record fee, net release (= approved − fee), release date, fulfillment.
7. **Borrower view:** live status, requested/approved/net-release, inspection state, PDF.

---

## 6. Data model (new idempotent migrations, `db/126+`)

- `sitewire_property_links` (application ↔ property/budget/capital-partner + match provenance)
- `sitewire_job_item_links` (the §4.3 crosswalk)
- `sitewire_draws`, `sitewire_draw_requests` (mirrors)
- `draw_disbursements` (our money ledger: approved, fee, fee_kind, net_release, release_date,
  funded_status)
- `sitewire_capital_partners` (directory cache), `sitewire_inspection_rules` (per-partner rules+fees)
- `sitewire_write_log` (clone of `clickup_write_log`) — journal of every write
- reuse `sync_review_queue` (widen reason set), `sync_runtime_state` (poll watermark), `sync_queue`
  (widen `target` CHECK to add `'sitewire'`), `sync_locks`
- `staff_users.sitewire_user_id` (email-matched), `draw_coordinator` persona in `permissions.js`
- deterministic **backfill** for the 35 existing files (previous-and-future rule)

---

## 7. Error handling & guards — "the system never guesses"

Every guard = **detect → journal → park in a review row with options → take no guessed write**
(mirrors `sync-review.js` / `sync-file-review.js`). The connector also carries the ClickUp client's
structural protections: env-only auth, retry/backoff, rate-limit bucket, a **no-empty-write guard**
(a blank can never clear a Sitewire field), an **allowlist** on draw PATCH, a **volume circuit
breaker**, **scoped-push-fail-closed**, and **assertPushComplete** (a lossy push throws → retried,
never marked done).

| # | Guard | What it catches | Action |
|---|---|---|---|
| G-ADDR | Address geocode | Sitewire 422 on address | park; never guess an address |
| G-LOAN | Loan number | blank `ys_loan_number` | block push |
| G-CP | Capital partner | `lender` label → no confident Sitewire id | park |
| G-USER | Coordinator | staff email not a Sitewire lender user | park |
| G-ENUM | Type enums | unrecognized property/construction type | null + park; never guess |
| G-FEE | Fee schedule | live fee ≠ configured schedule | park; never overwrite |
| G-EMAIL | Borrower assign | invalid/blank email (422) | park |
| G-RECON | Budget reconcile | `Σ job items ≠ frozen rehab_budget` (pre or post) | block/park |
| G-BIND | Id capture | sent name missing/doubled in response | bind unambiguous; park rest |
| G-NAME | Name collision | two cells → same name / dup on budget | disambiguate or park; never re-match by name after bind |
| G-SPLIT | Cent rounding | `Σ per-unit ≠ cell total` | use explicit columns verbatim; else floor+residual to unit 1; never push a non-reconciling split |
| G-LOWER | Lower below drawn | `budgeted_cents < approved+pending` (422) | catch specific 422; park; no retry loop |
| G-DELREF | Delete referenced | delete/shrink an item that has draw requests | park; require human |
| G-UNITS | Unit-count change | units changed after a draw exists | park conflict; grow is safe + re-check |
| G-UNKNOWN | Unknown job item | pulled `job_item.id` not in crosswalk | media-anchor allowlist auto-classifies; else park; never auto-adopt/delete |
| G-ORPHAN | Counterpart deleted | crosswalk id gone from live budget | mark orphan_review; recreate only on human confirm |
| G-MIDFLIGHT | Re-push during draw | draw not yet approved | allow only safe raises; defer lowering/rename/delete |
| G-APPRV | Over-approve | approved > requested/budget w/o override | block; require override |
| G-ROLE | Bad transition | approve/amend/reopen invalid for role/status | block |
| G-OVERDRAW | Over-draw | `line_drawn > line_budget` / `available < 0` | report + flag; correct nothing |
| G-VERIFY | Non-atomic PATCH | non-200 or returned ≠ sent | GET truth, reconcile, journal, then retry |

---

## 8. Module architecture (mirrors `src/clickup/`)

`src/sitewire/{client,transforms,mapper,orchestrator,reconcile,enqueue}.js` + `src/routes/sitewire.js`
+ new `app-v2/src/screens/StaffDraws.jsx` / `StaffDrawDetail.jsx` + a borrower Draws section +
`scripts/test-sitewire-*.js`. Config `SITEWIRE_*` (master switch OFF, separate write gate, dry-run,
poll interval), started self-gated from `src/server.js`. Full details in the plan file
`/root/.claude/plans/…-unified-wadler.md`.

---

## 9. Setup checklist (owner)
1. Confirm the **fee schedule** (virtual $299; physical amount **per capital partner**).
2. Approve the **capital-partner name → Sitewire-id** map (prefilled from `GET /capital_partners`).
3. Confirm **default coordinator** = Lisa Katz (16146) and checklist template **84**.
4. Ask Sitewire support: any **webhook** (else we poll) and any **borrower-invite/draw-submit API**.
5. Provided credentials go in **Render** (`SITEWIRE_ACCESS_TOKEN`/`_CLIENT`/`_UID`/`_BASE_URL`);
   master switch stays OFF until the read-only match report looks right.

---

## 10. Verification
Read path already validated live. Then: dry-run push asserting exact bodies (budget reconciles, fee
matches, partner+coordinator resolve, explosion names correct); reconcile match report over the real
35; unit tests (transforms, explosion, crosswalk bind, reverse reconcile, money math, every guard);
one guarded live smoke on a single file (write → re-GET → confirm persisted); two-audit-agent gate.
