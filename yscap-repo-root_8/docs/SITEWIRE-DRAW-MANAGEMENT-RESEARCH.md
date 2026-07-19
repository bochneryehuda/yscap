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

## 4.7 HARD RULE — PILOT only ever manages what PILOT pushed (owner-directed 2026-07-19)

**We read, track, and include in draw management ONLY properties whose property + Scope of Work +
construction budget were pushed to Sitewire BY US.** If PILOT did not create it, PILOT does not touch
it — not read it, not mirror it, not reconcile it. Rationale (the owner's): only a budget WE built
from the SOW can be reliably linked back to your Scope of Work; a hand-entered one cannot, and
guessing a link is forbidden. This **removes the entire legacy-adoption problem** — the existing 35
hand-entered budgets stay hand-managed in Sitewire exactly as today, invisible to PILOT.

How "ours" is known (never guessed): at push time we record the Sitewire `property_id` +
`budget_id` we created into `sitewire_property_links` with `matched_by='created'`. The reconcile pulls
draws **only** for those recorded property ids — it never lists-and-adopts the account. A property we
did not create has no link row, so it is structurally outside draw management.

**Loan-number collision guard (G-DUPEPROP):** when a Request-a-draw fires and a Sitewire property with
our `loan_number` already exists (e.g. one of the 35 pre-existing), we do **NOT** create a duplicate
and do **NOT** adopt it — we **park it for review** ("this loan is already in Sitewire, hand-entered;
PILOT can't auto-manage it"). The owner decides; PILOT never guesses a link onto foreign data.

Consequence: every budget PILOT manages is **clean and deterministic** (we chose every name, we
captured every id), so the crosswalk, the tie-out, and the reverse roll-up are always reliable — see
the correctness argument in §11.6.

## 5. End-to-end workflow

1. **No adoption.** PILOT does **not** scan or adopt the existing Sitewire account. It manages only
   what it pushes (§4.7). The pre-existing 35 stay hand-managed in Sitewire, outside PILOT.
2. **Birth on Request-a-draw (funded files only):** when a `funded` file's "Request a draw" is
   clicked and its SOW reconciles, push property → assign borrower → push budget/job-items (exploded,
   **PILOT-managed**) → apply inspection rules + fees + coordinator, and record the created
   `property_id`/`budget_id` link. All guarded (incl. G-DUPEPROP). Nothing before this click.
3. **Borrower draws in Sitewire:** Sitewire invites the borrower; they submit + upload photos; the
   inspector (or Sitewire inspector) reviews. PILOT shows live status + reminders.
4. **Reconcile back (poll):** for **our** properties only, mirror draws/requests/status/events and
   roll up to our SOW lines via the crosswalk.
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

---

## 11. Error-handling & manual-review machine (industry-hardened)

Grounded in a failure-mode study of dual-write/financial-sync and construction-draw integrations
(Built, Rabbet, Land Gorilla; Stripe idempotency; Modern Treasury/Shopify money; Confluent/Formance
reconciliation; entity-resolution best practice). This integration is a **dual-write across a money
boundary with a fan-out transform and a reconciliation read-back** — the highest-risk shape — so the
machine below is mandatory. Most of it already exists in the repo and is reused.

### 11.1 Architecture (reuse what the ClickUp/SharePoint sync already proves)
- **Outbox, not two live writes.** No request path writes our DB *and* Sitewire together. The
  business change enqueues an outbox job (`sync_queue`, `target='sitewire'`); a relay drains it with
  retries. Converts two-system atomicity into one ACID write + a retryable async push.
- **Idempotency keys + natural-key uniqueness.** Every write carries a *deterministic* key from
  `(application_id, sitewire_budget_id, sow_line_key, section_token, op)` — the SAME key on every
  retry of the same logical op — plus the crosswalk's unique constraints as a second line of defense,
  so a timed-out-then-retried create can never duplicate a job item.
- **Append-only journal.** `sitewire_write_log` records every push/pull: idempotency key, request,
  response, state delta, origin, sequence (SSN/PII never applicable here, but masked if ever). Money
  is corrected only by new offsetting ledger entries, never by editing a row.
- **Park-for-human is a first-class state.** `sync_review_queue` rows (with resolution actions) are
  fed by every guard below. Nothing ambiguous is auto-resolved; nothing is silently dropped.
- **Webhooks + polling backstop.** No Sitewire webhooks exist → we **poll on a durable watermark**
  (`sync_runtime_state`) AND run a scheduled **reconciliation job** that compares counts/keys/money
  totals against Sitewire's authoritative read and backfills gaps / parks mismatches.

### 11.2 System-of-record per field (so split-brain can't persist)
- **Sitewire authoritative:** draw `status`, `draw_events`, inspections/media, `requested_cents`,
  and (for legacy budgets) the job-item list.
- **PILOT authoritative:** the **managed** budget/job-items (we own the explosion), the money ledger
  (fee, net release, dates, fulfillment), and the SOW roll-up.
- Reconciliation always has a defined winner per field; a disagreement on a PILOT-owned field where
  Sitewire changed → review (someone edited our managed budget in Sitewire).

### 11.3 Invariants enforced at WRITE time (reject, never clamp)
1. `Σ(unit job items for a cell) == cell total` (residual absorption puts leftover cents on unit 1).
2. `Σ(all job items) == requiredRehabBudget()` (frozen budget) — pre- and post-PATCH.
3. `cumulative_drawn(line) ≤ budgeted(line)` and `Σ(lines) ≤ loan` — over-funding blocked.
4. `net_release == approved − fee` (retainage = 0 for now; the identity is explicit so adding
   retainage later is one term).
5. Money is **integer cents end-to-end**, parsed at the boundary; one rounding mode; never a float in
   a ledger field; equality never on floats.
6. **Monotonic sequence** per draw/job item (apply an inbound event only if newer; buffer/park older)
   and **optimistic version** on managed-budget writes (write-if-unchanged) — no lost updates.
7. **Echo suppression:** every managed job item stores `last_response_hash`; a pulled value equal to
   what we last wrote is our own echo → ignored, never re-pushed (no ping-pong).

### 11.4 Additional guards (industry failure → our guard)
| # | Failure (source class) | Guard |
|---|---|---|
| G-DUP | retry after a timed-out create duplicates a job item | idempotency key + crosswalk unique key → the retry updates, never re-creates |
| G-ECHO | our push read back as an external change | origin tag + `last_response_hash` fingerprint → suppress no-op |
| G-ORDER | out-of-order draw events overwrite newer state | monotonic sequence per draw; park older-than-seen |
| G-LOST | concurrent re-explode vs manual edit clobber | optimistic version on managed-budget writes |
| G-OVERFUND | cumulative draws exceed line/loan budget | hard invariant `drawn ≤ budgeted`; park the offending request |
| G-INSPECT | release marked without a verified inspection | inspection is the funding gate; no release state without Sitewire inspection record |
| G-MONEYINV | fee/net computed on wrong base or double-subtracted | write-time `net = approved − fee` invariant; components stored separately |
| G-CENTS | float money / split loses a penny | integer cents + largest-remainder residual absorption; `Σ==whole` asserted |
| G-RAW | 2xx that silently coerced/truncated a value | **read-after-write**: re-GET and assert money/mapping fields match what we sent |
| G-422 | business-rule 422 retried or swallowed | classify: 5xx/429/408 retry (idempotent only); **422/400 → park**, never retry-loop |
| G-SCHEMA | Sitewire changes a field/type/precision, still 200 | validate every inbound payload against an explicit schema at the boundary; park on drift, never default-to-null |
| G-FUZZY | matching a legacy hand-entered line by messy name | deterministic-first (loan number, job-item id); fuzzy only confidence-banded — high→auto, mid→human confirm, low→reject; persist confirmed mappings |
| G-CHURN | a confirmed match flips after an upstream rename | a changed match on a confirmed pair is an exception to **park**, not an auto-update |
| G-VERSION | draw computed against a stale/superseded budget | stamp each draw with the budget version; a change order re-explodes and re-asserts before the next draw; refuse draws on a superseded version |
| G-DEGRADE | Sitewire slow/erroring → worker pileup | circuit breaker per endpoint + hard timeouts + backoff-with-jitter + retry budget → dead-letter + review |

(These compose with the 22 field/crosswalk guards in §7.)

### 11.5 Data-model additions for the machine
- `sync_queue` reused as the **outbox** (widen `target`); `sitewire_write_log` = **journal**;
  `sync_review_queue` = **park queue**; `sync_runtime_state` = **watermark**; `sync_locks` =
  cross-process serialization.
- `sitewire_property_links.budget_version` (bumped on every managed re-explode) +
  `sitewire_draws.budget_version_at_draw` (stamp) → G-VERSION.
- `sitewire_draws.last_sequence` (monotonic) → G-ORDER; `sitewire_job_item_links.last_response_hash`
  → G-ECHO; idempotency key persisted on the outbox job + journal → G-DUP.
- inbound dedupe by `(sitewire_draw_id, updated_at/sequence)` so at-least-once delivery never
  double-applies.

### 11.6 Correctness argument — why the budget link + reverse tracking is provably right

The owner's question: *how do I know the linking is actually correct?* The design makes it correct
by construction, not by hope, via a chain where every step is verified or parked:

1. **Closed world (§4.7).** PILOT manages only budgets it created. We assigned every line's name and
   captured every Sitewire id at creation → there is never a foreign/hand-entered line to guess about.
2. **Exact tie-out before push.** The exploded set (unit lines + contingency + GC) must sum to the
   frozen `requiredRehabBudget()` **to the cent** or the push is refused (invariant §11.3.2). Cents
   are integers; splitting a cell uses largest-remainder residual absorption so `Σ units == cell`
   exactly (§11.3.1). No total can drift.
3. **Id capture is unambiguous.** Deterministic unique names → bind each created line to its Sitewire
   id by exact name match on the PATCH response; any missing/duplicate name parks (G-BIND). After
   binding, identity is the id forever (a Sitewire-side rename can't detach it).
4. **Read-after-write.** We re-GET the budget and assert each line's `budgeted_cents` and the budget
   total equal what we sent; mismatch parks (G-RAW/G-RECON). "Returned 200 but didn't save" cannot
   pass silently.
5. **Every unit line points home.** The crosswalk row ties `(sitewire_job_item_id) → (sow_line_key,
   section_token, unit_index)`. Your one SOW line that became N unit lines is joined back through
   `sow_line_key` — so all N always roll up to the single line, even though you keep one line.
6. **Draws always resolve.** Because we created every line, every incoming `request.job_item.id` is in
   the crosswalk. The one exception — a human adds a line directly in Sitewire — has no crosswalk row
   and parks (G-UNKNOWN); it is never guessed into a cell.
7. **Roll-up is bounded and checked.** Per-unit `approved_cents` sum onto the SOW line; the invariant
   `cumulative_drawn(line) ≤ budgeted(line)` blocks over-draw (G-OVERFUND); our totals are cross-
   checked against Sitewire's own read-only `total_approved_cents`/`available_cents` and any
   divergence parks (G-RECON).
8. **Nothing silent.** Every branch above either succeeds verified or parks in the review queue with a
   concrete action — never a silent apply, never a silent drop.

Testable as invariants (the test suite asserts each): `Σ units == cell`; `Σ lines == rehab_budget`;
round-trip `explode → bind → reverse-map == identity`; `drawn ≤ budgeted`; `net == approved − fee`.

---

## 12. Real-data findings (traced live — draws, borrower flow, site checks, rules)

### 12.1 Draw lifecycle (traced on real approved draws)
- Sequence: `created`/`submit` (borrower_owner or **borrower_delegate**) → `inspector_assigned` +
  `inspector_approve` (**sitewire_inspector**, often same day for virtual) → `lender_approve`
  (**lender_owner**, typically next day). **The `lender_approve` event's date is the release date.**
- **The lender routinely approves LESS than requested** (real: $25k→$21k, $36k→$28k). Requested-vs-
  approved trimming is a core desk function; per-request `approved_cents` sums exactly to the draw's
  `total_approved_cents`.
- **The fee never appears in the draw or requests** — property-level `processing_fee_cents` only.
  Confirms net-to-borrower = `approved − fee` is computed in **our** ledger; the release date comes
  from `lender_approve`, and the fulfillment/"wire" signal from the quick-notify label (§12.4).
- **`draw_events` come back OUT OF ORDER** in the API — we MUST sort by `occurred_at` (never trust
  array order) to derive `submitted_at = min(created/submit)` and `approved_at = lender_approve`.
  (Guard G-ORDER already covers this.)

### 12.2 Borrower flow (confirmed)
- `borrower.status` across the 35: **unassigned 17 · assigned 17 · invited 1**. Flow is
  **unassigned → invited → assigned**: we `PATCH /properties/{id}/borrower` with the email, Sitewire
  sends the invite, the borrower accepts (→ assigned). We never submit or upload for them.
- A Sitewire **borrower** is an org (18 exist; named by deal/address) with a contact
  (`contact_email`/name/phone). A **delegate** can submit draws on the borrower's behalf.
- PILOT's job on the borrower side: assign by email, then **track status + remind + hand off** to
  Sitewire's app. No submission/upload in PILOT (API can't).

### 12.3 Site checks (Deliverable Updates) — not in use
- **Zero** deliverable updates across the whole account. Not a Phase-1 build target; we mirror them
  read-only **only if** they ever appear. Removes a whole surface from the initial scope.

### 12.4 Quick-notify pipeline labels (real)
- Four live labels: **"Awaiting internal approval", "Sent to the wire department", "Sent to
  servicer", "Wire initiated"**. We read them, set `quick_notify_status_id` on a draw, and CRUD the
  label set. **"Wire initiated" / "Sent to the wire department"** correlate to our ledger's release/
  fulfillment state — the desk can surface both together.

### 12.5 Inspection rules by capital partner (derived from real config) → the rules engine defaults
| Capital partner | inspection_method | require_sitewire_inspector | fee | notes |
|---|---|---|---|---|
| **Fidelis** | mobile (virtual) | yes | **$299** | dominant (27); exceptions seen: 2 traditional $499, 2 mobile $399 |
| **Blue Lake** | traditional (on-site) | yes | **$250** | |
| **CorrFirst** | mobile (virtual) | yes | **$299** | |
- These become the **per-partner defaults** in `sitewire_inspection_rules` (owner-editable). Because
  real files show exceptions, staff may override per file, and any existing property whose live config
  ≠ the partner default is **flagged (G-FEE / review)**, never overwritten. `require_capital_partner_
  approval` is **false on all 35** → default false.

### 12.6 Legacy budgets — OUT OF SCOPE under the only-ours rule (§4.7)
- The data that once argued for read-only legacy mirroring (24/35 have approved draws and are LOCKED
  from re-explode) now simply confirms the owner's hard rule: **PILOT does not touch the 35.** They
  stay hand-managed in Sitewire. No adoption, no mirroring, no migration path is built. The only
  interaction is the **G-DUPEPROP** collision guard (§4.7): if a Request-a-draw fires on a loan that
  already exists in Sitewire, PILOT parks it for the owner rather than duplicating or adopting.
- This deletes an entire class of risk (fuzzy-matching hand-entered lines, reverse-mapping messy
  budgets) from the build. Every property PILOT manages is one it created.

---

## 13. Workflow A — Borrower Scope-of-Work change requests (owner-directed 2026-07-19)

Reuses the EXISTING change-request machinery (`change_requests` table `db/086`,
`src/lib/change-requests.js` `openRequest`/`applyRequest`, staff routes
`POST /change-requests/:cid/{approve,reject}` `staff.js:2320/2365`, `ChangeRequestPanel.jsx` /
`StaffChangeRequests.jsx`). Add a governed field `'scope_of_work'` whose `new_value` carries the
proposed SOW payload and whose `applyRequest` branch reopens the SOW condition instead of writing a
scalar column. Industry-validated: reallocation must net to zero; only undrawn balance is movable;
later→earlier-stage moves are flagged; keep approved baseline + revised both on file
(Rabbet/Built/Land Gorilla — see §11 sources).

### 13.1 Trigger & review
- Anytime **after the SOW condition is reviewed (LO) or signed off (processor)** — even before funding
  — the borrower may request changes. It does **not** write the SOW; it opens a `change_requests`
  row (`requesterKind:'borrower'`, `field:'scope_of_work'`) → **manual review**.
- LO + processor get the **full change-request screen** (`StaffChangeRequests.jsx`) showing exact
  old→new detail. `notify.notifyAppStaff(type:'change_request')` alerts the team.
- **Accept** (`applyRequest`, in-txn, verify-after-write) files the revised SOW and **reopens the SOW
  condition** (the `enforceGoldSowContingency` code pattern: `status='issue'`, clear
  `signed_off_at/by`, `[auto]` note honoring the `notes LIKE '[auto]%'` convention). Borrower clicks
  **done** → **processor re-signs** through the unchanged `signOffGate` (exact-cent + Gold
  contingency gates) + `PATCH /checklist/:itemId`.

### 13.2 BEFORE CTC/funding
- A revised SOW that **also moves the total** writes `applications.rehab_budget` → the existing DB
  trigger `trg_reopen_on_budget_change` (`db/071/072/096`) fires: reopens **product_pricing**
  (`→received`, sign-off cleared, `product_registrations.stale=true`) and SOW (`→issue`) with FATAL
  `[auto]` notes → the file must be **re-registered** so everything matches to the cent.
- Folder: simple **Version 1 / Version 2** (SharePoint `shuffleRootIntoVersion1` supersede — the old
  SOW mirror moves to `Version 1`, the revised becomes current; nothing deleted).

### 13.3 AFTER CTC or after funding (the bigger logic)
- **Before LO/processor can approve, they are WARNED it needs capital-provider approval** — a new
  change-request status `awaiting_capital_partner` gates the apply; the file shows the requirement to
  both LO and processor.
- **Total must stay CONSTANT** (net-zero reallocation). The request is **refused at submit** unless
  `Σ new lines == Σ old lines` to the cent (**G-CR-TOTAL**). A true total change after CTC is not
  allowed (only before CTC, via re-registration §13.2).
- **Only the UNDRAWN balance of a line is movable** (**G-CR-DRAWN**): a line's floor =
  `drawn+pending` (rolled up from the crosswalk / Sitewire `total_approved_cents`); a reduction below
  it is refused. If $5k of a $10k line is released, only the undrawn $5k can be moved (50%-drawn →
  half movable). Mirrors Sitewire's own `422 budgeted_cents must be ≥ approved+pending`.
- **Warning (soft) when money moves from later/structural stages to earlier/cosmetic stages**
  (**G-CR-STAGE**) — higher decline risk; shown to LO/processor, not a hard block.
- **Both versions stay LIVE** on the file: the **closed/approved** SOW (baseline) and the
  **capital-partner-approved revised** SOW — modeled as **two `checklist_items`/slots** so both are
  `is_current` (SharePoint keeps both mirror folders).
- **Excel export** (LO/processor) via `buildXlsx` (`tpr-export.js:112`): old vs new **line-by-line**,
  Δ per line, which lines reduced/increased, and the net-zero proof — to share/escalate.
- **Push to Sitewire**: the reallocation updates only undrawn `budgeted_cents` via `PATCH /budgets`
  job_items (Sitewire enforces the same drawn floor); guarded/journaled/read-after-write (§11).

## 14. Workflow B — Inspector findings → borrower Accept/Dispute → funding (owner-directed 2026-07-19)

Industry baseline: findings per line (requested / approved% / not-approved / reason / geo-photos) →
Accept starts the wire SLA, or Dispute → per-line rebuttal with evidence → revision under a variance
policy → lender final approval → revised amounts flow back (Built/Land Gorilla/Trinity/Northwest —
§11 sources).

### 14.1 Bring findings in (from Sitewire)
- On draw reconcile, for each `request` pull `requested_cents`, `approved_cents`, `not_approved =
  requested − approved`, `lender_comments`/`inspector_comments` (**why** not approved), and
  `inspections[]` photos (geo + timestamp + thumbnail). Roll up to our SOW lines via the crosswalk.
- **CAPABILITY VERIFIED LIVE (draw 107399, 546 S 20th St):** every finding is retrievable via
  `GET /requests/{id}` — **64 photos + 9 videos** (each with `media.src`, `thumbnail`, latitude/
  longitude, `captured_at`), **inspector notes on 15 of 19 lines**, and exact per-line
  requested/approved/not-approved (e.g. Vinyl req $6,000→appr $0; HVAC-Duct $1,900→$1,400; Plumbing
  Other $5,000→$2,000 with both inspector AND lender notes). Nothing needed is missing from the API.
- **Deliver to borrower + LO + draw coordinator**: a portal **findings screen** and a **findings
  email** (new `catalog.js` builder, registered in `builders`; new `notify` type in `CATEGORY_OF`;
  routed through `notifyBorrower` so capital-partner names are scrubbed) with full per-line detail +
  photos, `Reply-To: fileReplyTo(appId)`.

### 14.2 Borrower ACCEPT
- **The borrower NEVER approves in the Sitewire portal.** The go-ahead is captured in **PILOT** — a
  portal button OR an email reply — and it means "borrower authorizes OUR team to proceed with
  funding." It is stored + audited in our system; it is not a Sitewire write.
- **Portal button** OR **email reply** (parsed by `topReply` in the reused `inbound-file-email.js` /
  `file-inbox.js` path — a `findings+<token>@domain` family mirroring `chatKeyFromRecipients`; the
  reply also routes to LO + draw coordinator via `forwardToAssignees`). Accept → findings
  `accepted` → **submit for funding on our side** (disbursement ledger: `net_release = approved −
  fee`, `release_date`, `funded_status`).
- Borrower is told the **wire turnaround (default 48h, admin-configurable)** — a settings row
  (`sitewire_settings.wire_turnaround_hours`); the message text reflects the configured number.

### 14.3 Borrower DISPUTE
- Portal per-line rebuttal: upload photos/receipts/files + notes + **desired amount** (e.g. approved
  $5k, still need $8k or the full $10k) on each not-/partially-approved line → **sent to LO + draw
  coordinator** (`notifyAppStaff`), who can **export to Excel** (`buildXlsx`) to escalate (capital
  provider / GC / others). Reuses `raiseEntityIssue` to open a dispute condition + audit trail.
- **Admin approves the dispute → push the revised amount back to Sitewire** (verified §1 capability):
  - draw **pending** → `PATCH /requests` raise `approved_cents` (spec: "applied as pending approved")
    → `PATCH /approve`.
  - draw **approved/released** → `PATCH /amend` → `PATCH /requests` → `PATCH /approve`.
  - borrower needs **more than they requested** → `PATCH /reopen` (back to borrower to resubmit
    higher in Sitewire).
  - **Fallback (G-FIND-PUSHBACK):** where the API can't apply it, the **processor confirms they
    updated Sitewire and enters the new release amount**; we **re-GET** and assert our release amount
    == Sitewire's (**G-FIND-MATCH**). Optional variance policy (5–10%/line auto; larger → escalate).

### 14.4 Settlement — tie everything to the SOW
- After findings settle (accept or resolved dispute): update **released / not-released**, the proof
  amount, and the **release amount** on our side AND in Sitewire, and assert the invariants
  `net_release == approved − fee` and `our release == Sitewire approved`. Nothing silent; any
  mismatch parks (§11).

### 14.5 New guards
| # | Guard | Behavior |
|---|---|---|
| G-CR-TOTAL | after-CTC change doesn't net to zero | refuse at submit; total must stay constant |
| G-CR-DRAWN | reduce a line below drawn+pending | refuse; only undrawn balance is movable |
| G-CR-STAGE | later/structural → earlier/cosmetic move | soft warning to LO/processor |
| G-CR-CPAPPROVAL | after-CTC change lacks capital-partner approval | gate the apply on `awaiting_capital_partner` |
| G-CR-REG | before-CTC total change | reopen product_pricing + re-register + SOW fatal |
| G-FIND-DISPUTE | dispute auto-applied | never; admin-approval + push-back or processor-confirm |
| G-FIND-MATCH | our release ≠ Sitewire release | park; re-GET + reconcile before funding |
| G-FIND-SLA | wire turnaround shown to borrower | admin-configurable; message reflects the setting |

### 14.6 Data-model additions
- `sow_change_requests` extension (reuse `change_requests` + a `scope_of_work` field; store proposed
  payload, per-line deltas, net-zero flag, capital-partner-approval state).
- `draw_findings` + `draw_finding_lines` (per-line requested/approved/not-approved/reason/photos,
  accept/dispute state) and `draw_finding_disputes` (per-line desired amount, evidence, resolution).
- `sitewire_settings` (`wire_turnaround_hours`, variance policy) — admin-editable.

---

## 15. The unified rollup + advisory draw-risk engine (built 2026-07-19)

Two capabilities that make PILOT more than a mirror — grounded in a review of the best-in-class
platforms (Built Technologies' "Draw Agent", Rabbet's portfolio exposure views, Land Gorilla's
lien/progress monitoring) and construction-loan fraud-control literature.

### 15.1 Unified rollup (`src/sitewire/rollup.js`) — "one system"
The single view tying **draws ↔ Scope of Work ↔ construction budget**. It rolls the per-unit
Sitewire draw requests back up through the crosswalk to each SOW line and layers the money story:
`budgeted` (frozen, per line & unit), `drawn` (= approved on **approved** draws only — mirrors
Sitewire `total_released_cents`), `approved_pending` / `requested_open` (in the pipeline),
`remaining`, `pct_complete`. Contingency / GC / media are separated; an unmatched Sitewire line is
surfaced in `unknown` and never folded in. Pure core + a thin DB loader that also folds the money
ledger (fee → net release → date) onto each draw. Powers the staff DrawsPanel, the borrower view,
and the `/portfolio` exposure/pacing dashboard.

### 15.2 Advisory draw-risk engine (`src/sitewire/risk.js`) — "audit mode"
A red-flag engine that **advises, never blocks** (a human draw coordinator always decides — the
"Audit" mode of Built's Draw Agent, deliberately not "Automate"). Per draw it flags:
`no_inspection` (money requested with no photos), `exceeds_remaining` / `over_total_budget`
(over-budget lines — the #1 fraud red flag), `approved_exceeds_requested`, `large_first_draw` &
`front_loading` (drawing ahead of verified work — the classic front-loading scheme),
`line_oversubscribed` (concurrent open draws that jointly bust a line), `money_on_media_line`,
`line_already_complete`, and `unknown_line`. Snapshot (`risk_level`/`risk_flags`) refreshed on
every reconcile; **only OPEN draws are assessed** (an approved draw's amount is already in `drawn`,
so re-assessing it would false-flag it). Sources: Rabbet & Built fraud-prevention guidance
(front-loading, over-billing, duplicate/false pay-applications, draws that outrun verifiable
progress); private-lender draw-schedule controls.

### 15.3 Reallocation rules (`src/sitewire/reallocation.js`) — encoded from the domain
Grounded in construction-loan reallocation/change-order practice (AIA contingency guidance; Rabbet
"Basics of Reallocations & Change Orders"; lender draw-administration playbooks): **after** clear-to-
close the budget must **net to zero** (money only moves, it is never created); **only undrawn money
is movable** (a line — and, on multi-unit lines, a *unit* — can never be cut below what's already
drawn); a **material** line change (> the admin `variance_pct`, default 10%) and any after-CTC move
need **capital-partner approval**; a **before**-CTC total change re-opens Products & Pricing (the
loan was sized off the old budget) rather than silently changing the frozen `rehab_budget`.

### 15.4 Best-of-breed feature gap-analysis (research 2026-07-19)
Confirmed present / built here, matched against Built, Rabbet, Land Gorilla, Nectar: line-item draws
with % complete; per-line/per-unit budget vs. drawn vs. remaining; portfolio exposure & pacing;
inspection routing (virtual vs. on-site) + geo-tagged photo review; per-partner fee schedule; draw
risk/fraud red-flags (audit mode); budget reallocation with net-zero + undrawn-only + material-
variance gating; borrower accept/dispute with a wire SLA; money ledger (fee → net release → date);
CSV export; capital-partner approval routing. **Deferred (roadmap, per owner):** retainage/holdback,
conditional/unconditional lien-waiver tracking, structured wire references, interest-reserve draw
tracking, AI photo analysis — each is a known industry feature we've scoped but intentionally
postponed; none is silently missing.

### 15.5 Implementation status
Everything in §12–§15 is **built and tested** (pure-logic unit tests in
`scripts/test-sitewire-rollup.js`; DB-backed verification; two adversarial audit passes with all
findings fixed). Still off by default behind `SITEWIRE_ENABLED` / `SITEWIRE_OUTBOUND_ENABLED`.

---

## 16. FULL ERROR-HANDLING SPECIFICATION (owner-directed 2026-07-19 — "nothing is guessed")

This is the definitive catalog of every error the integration can hit, how it is detected, how
it is handled, and how it recovers — with the guarantee the owner requires: **nothing is ever
guessed, and nothing is ever silently dropped.** Grounded in an exhaustive read of the code, a
reliability audit, and research into how real draw platforms (Built, Rabbet, Land Gorilla) and
financial-API guidance (AWS/Stripe idempotency + backoff, RFC 9457) handle failure.

### 16.0 Five principles (applied everywhere)
1. **Never guess a value.** A missing address part, an unknown property type, an unmatched (or
   only fuzzily-matched) capital partner, a budget that doesn't tie to the cent — none is filled
   in. The push stops and a review row is created.
2. **Never silently drop.** Every failure either retries on a durable queue, or parks a visible
   `sync_review_queue` row (`field_key='sitewire'`), or (for infra/journal failures) at minimum
   logs a warning. No empty `catch{}` on a path that could lose a value.
3. **Treat the first API response as provisional.** A write isn't "done" until read-after-write
   confirms it; if we can't confirm, we park rather than report success.
4. **Fail closed on the safety checks.** If the volume circuit breaker can't read its counter
   (DB trouble), the write is refused (retryable), not waved through.
5. **Human-in-the-loop for anything ambiguous.** Parks carry a plain-language reason and notify
   the file's loan officer; staff resolve at `/internal/sync-reviews`.

### 16.1 Error-code registry
Every distinct failure has a stable code, a detection point, a handling verb, and a recovery
path. Handling verbs: **RETRY** (durable queue re-attempts), **PARK** (visible review row),
**BLOCK** (refuse the write), **DEGRADE** (log + continue), **DEAD** (dead-letter → PARK).

| Code | Trigger | Handling | Recovery |
|---|---|---|---|
| E-API-TIMEOUT/5XX/429 | Sitewire slow / 5xx / rate-limit | client backoff+jitter (honors Retry-After ≤60s), then RETRY via queue (600s, DEAD@40 ≈7h) | auto, then PARK `push_dead_lettered` |
| E-API-422-PROPERTY / -BUDGET | Sitewire rejects a write (geocode / validation) | PARK `property_rejected` / `budget_rejected` (body excerpt) | human fixes the file |
| E-RAW-NOID | 200 with no property/budget id | PARK `bind_missing_property`; link NOT written | human checks Sitewire |
| E-RAW-TOTALDRIFT | re-read budget total ≠ expected | PARK `total_drift` | human reconciles |
| E-RAW-VERIFYFAIL | the read-after-write GET itself fails | PARK `total_unverified` (never reports ok blind) | human confirms |
| E-DUPE-LISTFAIL | the only-ours dupe check can't run | transient→RETRY; else PARK `dupe_check_failed`, **never creates** | retry / human |
| E-LOAN-ALREADY | loan number already in Sitewire | PARK `loan_already_in_sitewire`, never adopt/duplicate | human decides |
| E-BIND-MISSING / -AMBIGUOUS | created line absent / duplicate-named in response | PARK per-line (`dedupe` = line name, so N failures = N rows) | human renames/checks |
| E-BUDGET-MISMATCH | Σ SOW ≠ frozen budget (>$1) | BLOCK + PARK `budget_mismatch` before any write | human fixes SOW |
| E-CP-UNMATCHED / -AMBIGUOUS / -FUZZY | 0, >1, or only a fuzzy substring partner match | PARK `capital_partner_unmatched` (fuzzy candidate surfaced in the row) | human confirms |
| E-ADDR-INCOMPLETE / -GEOCODE | missing address part / Sitewire can't place it | PARK `address_incomplete` / `property_rejected` | human fixes address |
| E-UNKNOWN-DRAW-LINE | inbound draw line has no crosswalk row | PARK `unknown_draw_line` (per reconcile) **and** advisory flag | human reconciles |
| E-NAN-MONEY | non-numeric money on `/approve` or `/disbursements` | BLOCK 400 (never coerces to $0) | caller resubmits |
| E-NEG-MONEY | negative net / approved | BLOCK 422/400 | caller resubmits |
| E-REALLOC-* | not net-zero / below-drawn (per unit) / no CP approval / SOW ≠ budget | BLOCK 422/409, re-validated at apply against the live rollup | human fixes |
| E-DELIVER-OVER-ACTED | re-deliver over an accepted/disputed finding | BLOCK 409 unless `force:true` (protects borrower state) | explicit force |
| E-TOKEN-* | bad / reused / expired accept token | 404 / idempotent `already` / 410 after 30 days (portal still works) | sign in |
| E-CIRCUIT-OPEN | >300 writes/10min | BLOCK (RETRY later) + audit | auto |
| E-CIRCUIT-DBFAIL | breaker counter unreadable | **fail closed** — BLOCK retryable | auto retry |
| E-DEADLETTER | push failed past the attempt cap | DEAD + PARK `push_dead_lettered` | human |
| E-JOB-STUCK | worker died mid-job | reclaimed after 5 min (`FOR UPDATE SKIP LOCKED`) | auto |
| E-BIRTH-STRANDED | draw requested while Sitewire was off | worker start backfills funded+requested+unlinked files | auto on enable |
| E-RECONCILE-ROW / -FILE | one poison request row / one file's poll fails | per-row + per-file try/catch → DEGRADE (warn), next poll retries | auto + logged |
| E-JOURNAL-FAIL / E-PARK-FAIL | audit/park insert fails | DEGRADE (console.warn) — never silent | logged |

### 16.2 API-resilience layer (`src/sitewire/client.js`)
Per-minute **token bucket** (RPM 90); **capped exponential backoff + jitter** (retryable only:
429/5xx/network), honoring `Retry-After` up to 60s; a **25s timeout** via `AbortController`;
errors tagged `status`/`retryable`/`retryAfter`/`body` so the durable queue owns the long game.
Write safety in the same chokepoint: the **DRY-RUN gate** (logs the exact body, sends nothing),
`guardNoUnsafeWrite` (refuses any body JSON would turn into a field-clearing null/NaN), and the
**draw-transition allowlist** (`approve/amend/reopen` only — `reject` is capital-partner-only).
Idempotency posture: property/budget re-push is **structurally idempotent** (a linked file
UPDATEs, never re-creates; the budget diff binds by id), and the only non-idempotent op (property
create) is fenced by **G-DUPEPROP** — which now refuses to create if its own dupe check can't run.

### 16.3 The park-in-review contract (`orchestrator.park`)
Every park writes a `sync_review_queue` row keyed by a `task_id` of
`sitewire:<appId>:<reason-class>[:<instance>]`. The `<instance>` discriminator (e.g. the line
name on a bind failure) means **distinct failures never collapse into one row**; a true repeat
dedupes. On a unique-index race the existing row id is returned (never vanishes); on any DB
failure it logs a warning. Every new park notifies the file's loan officer.

### 16.4 Outbox + worker contract (`src/sync/sitewire-sync.js`)
The outbox is `sync_queue` (`target='sitewire'`). A worker claims one job with
`FOR UPDATE SKIP LOCKED`, reclaims jobs stuck in `processing` after 5 min, and classifies a
failure as **outage** (circuit-open / retryable / network → patient 600s retry, DEAD@40) or
**bad-value** (backoff, DEAD@8). A dead-letter always PARKs `push_dead_lettered`. On start (with
Sitewire on) it backfills any stranded births. Gating is layered: `SITEWIRE_ENABLED` (reads +
worker), a SEPARATE `SITEWIRE_OUTBOUND_ENABLED` (writes), `SITEWIRE_DRYRUN` (log, send nothing);
no path leaks an outbound network write past those gates.

### 16.5 Reconcile resilience (`src/sitewire/reconcile.js`)
Scoped only to properties we created (`matched_by='created'`). Each request row is upserted in
its own try/catch (a poison row can't strand the file); each file's poll is wrapped (one bad file
can't stop the sweep); a `getProperty`/`getDraw` failure degrades gracefully and retries next
poll. An **unknown inbound draw line** (no crosswalk) PARKs a review row — it is never folded
into a SOW line, and the park survives even after the draw is approved (unlike the advisory flag).

### 16.6 Draw-domain rejection reasons → our guards (from industry research)
Research shows the leading real-world draw problems; each maps to a guard/flag we enforce:
- **Missing/incorrect lien waivers** (the #1 hold) → **deferred** (roadmap §15.4); today Sitewire
  owns document collection. Flagged as a known gap, never silently "passed."
- **Math / reconciliation errors** (SOV totals don't tie) → **G-RECON** blocks any budget that
  isn't Σ-to-the-cent; the rollup reconciles per line/unit.
- **Failed inspection / SOV mismatch** → the **risk engine** flags `no_inspection`,
  `exceeds_remaining`, `front_loading`; the findings workflow surfaces not-approved lines.
- **Budget overages** → `exceeds_remaining` / `over_total_budget` / `overdrawn` (portfolio).
- **Minor admin issues** (wrong address, wrong draw number) → address guard + the crosswalk keys
  each draw to a specific job item; nothing is matched by loose text.

### 16.7 Known limitations (documented, never silent)
- **Duplicate SOW base labels** produce colliding exploded names → each now PARKs its own
  `bind_ambiguous` row (visible); a deeper fix (enforced name uniqueness pre-push) is roadmap.
- **Reallocation apply TOCTOU** — re-validated at apply time against the live rollup, but not in a
  single transaction with the SOW write; a concurrent approval in the same instant is a rare edge.
- **Retainage / lien waivers / stored materials / interest reserve** — modeled in the research,
  intentionally deferred; their absence is a documented roadmap item, not a silent omission.

---

## 18. Examiner-ready audit trail + SLA monitoring (built 2026-07-19)

Two more best-in-class capabilities, from a review of Built's "audit-ready documentation" and
Rabbet's SLA/covenant reporting:

- **Draw audit trail** (`GET /api/sitewire/files/:id/activity` + `/activity/export`): a single
  time-ordered record of the WHOLE draw lifecycle for a file — every guarded PILOT write (from
  `sitewire_write_log`), every Sitewire draw lifecycle event (sorted by `occurred_at`), every
  release recorded, every findings delivery/accept/dispute/resolution, and every Scope-of-Work
  reallocation. Newest-first, CSV-exportable (formula-injection-guarded), examiner-ready. Shown
  as a collapsible "Draw activity" panel on the file's draw desk.
- **Wire-SLA monitoring**: a `wire_overdue` portfolio alert fires when the borrower has ACCEPTED a
  draw but its release is past the (admin-configurable) wire deadline and no release is recorded —
  surfaced on the dashboard "Attention needed" panel alongside the pacing/stale/overdrawn alerts.

Both are advisory + read-only; no new tables (assembled from existing records). The gap-analysis
roadmap items (retainage, lien waivers, stored materials, AI photo % complete, interest reserve)
remain explicitly deferred, never silently missing.

---

## 19. Retainage + lien waivers + GL export (roadmap → built 2026-07-19)

Three of the deferred best-of-breed items, now built (all OFF by default; never-guessed):

- **Retainage / holdback** (`src/sitewire/money.js computeRelease`): an admin-set % (global
  `retainage_pct`, or a per-file override on the property link) is held from each approved draw —
  `net_release = approved − fee − retainage_held`. The ledger records `retainage_held_cents` per
  release and tracks retainage held vs. released; a **"Release retainage"** action pays out the
  accumulated holdback at completion (a `kind='retainage_release'` ledger entry). 0% is byte-
  identical to the pre-retainage behavior; a fee+retainage that would drive the net negative is
  flagged, never silently recorded.
- **Lien-waiver tracking** (`draw_lien_waivers` + `waiverGate`): a per-draw register —
  conditional/unconditional, progress/final, GC/sub/supplier, party, amount, status
  (required/received/waived/na), optional document link. When the admin turns the gate on
  (`require_lien_waivers`), a draw **cannot be marked released** while a REQUIRED waiver is
  outstanding — the missing party is named (the #1 real-world cause of draw delays). Managed on
  the file's draw desk.
- **GL / accounting export** (`GET /files/:id/gl-export`): the release ledger — approved, fee,
  retainage held, net release, status, dates — as a real Excel workbook for the accounting team /
  QuickBooks import.

- **Draw packet** (`GET /files/:id/draws/:drawId/packet`): a per-draw Excel workbook assembling the
  cover, the SCHEDULE OF VALUES (each SOW line: budget, drawn-to-date, this-draw requested/approved,
  remaining, % complete), the inspection findings (per line: approved/not-approved, photo/video
  counts, inspector note), and the lien waivers — the "draw packaging" Built/Rabbet lead with.

Still deferred (documented, never silent): a direct QuickBooks push, stored
materials, interest-reserve draw tracking, AI photo % complete, and a direct QuickBooks push.
