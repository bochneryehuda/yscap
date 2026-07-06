# YS Capital ⇄ ClickUp — True Bidirectional Sync

**Full architecture, field-by-field mapping, status model, and build task list.**
Status: **PROPOSAL — nothing implemented. Awaiting owner sign-off on every section.**
Scope of this build: **RTL / short-term loans only** (Fix & Flip, Bridge, Private hard money). DSCR / Non-QM / HELOC are explicitly out of scope for now.

> This document supersedes the earlier `FIELD-MAP.md` and `ROUTING.md` drafts. Those were never approved; treat this as the single source of truth once signed off. Everything here was verified against the **live** ClickUp workspace (`9011888435`, spaces *CRM & SALES* `90113224042` and *Loan Pipeline* `90113223301`) and against the current portal code.

---

## 0. TL;DR — what's true today and what we're building

**Today (already in the repo):** a *one-directional, half-wired* scaffold. `src/clickup/{client,fields,mapping,routing}.js` + `src/sync/queue.js` can create **one** Pipeline task from a portal application. It does **not** dual-write the CRM contact, does **not** update fields after creation, does **not** sync checklist/condition statuses, and has **nothing** flowing back from ClickUp. The intake path (`src/routes/intake.js`) doesn't even enqueue the one create job it could. So "bidirectional" is a genuine build.

**What we build:** a durable, echo-safe, two-way sync for RTL files:
- **Portal → ClickUp:** create/update the loan-file task + the CRM contact, push every mapped field, push checklist/condition statuses, push officer/processor/underwriter, push the internal status.
- **ClickUp → Portal:** ingest task create/update/status/delete via **webhooks + a reconciliation poll**, translate ClickUp's 38-status workflow into our two-layer status model, pull the YS loan number, actual closing date, appraisal/CDA/condition fields, and all mapped data back.
- **An Admin "ClickUp Control Center"** to run it all without a developer: connection health, field-mapping overrides, per-file resync, pause/override toggles, and a **full live activity log** of every API call in and out.

---

## 0.1 Owner decisions — LOCKED (2026-07-06)

1. **Sync identity:** run on Yehuda's token (`pk_120151948…`). **No bot seat for now** → echo-suppression relies entirely on value-hash + suppression window + loopback guard (§3.3), which become mandatory. A "YS Portal Bot" seat stays a recommended future hardening (drop-in later, no mapping change).
2. **New-file trigger — hybrid (§4.3–4.4):** (a) every new ClickUp task auto-syncs via `taskCreated` webhook; (b) a new **"Send to Portal"** checkbox on the task = *emergency create* (if the webhook didn't fire) **and** *force full resync* (uncheck→recheck re-fires a complete ClickUp→portal field pull); (c) **duplicate files wait until the Subject Property Address is changed** from the source before they materialize + open on the portal; (d) freshly-duplicated files run in **hot-poll mode** (poll ~every 30–60s for the first minutes) so rapid field edits all land.
3. **Officer (re)assignment in the portal:** set the Loan Officer field **and move** the task into that officer's Pipeline folder (§4.1).
4. **"inactive / on hold":** add a **new borrower-facing "On hold" status** (§5) — requires extending the `applications.status` CHECK set + a borrower-UI label.

*(Still open — see §17: descope behavior, task-delete handling, PPP/value canonicals, processor authority, roster reconciliation, condition-issue notifications, new-field approvals.)*

---

## 1. Guiding principles (the rules this design obeys)

1. **RTL-only scope, driven by the `*Program` field.** A file syncs **only** if its ClickUp `*Program` is one of the RTL options (§2). Everything else is ignored on both sides.
2. **System of record is per-field, not per-system.** Some fields are portal-authoritative (borrower application data), some are ClickUp-authoritative (YS loan number, actual closing date, internal workflow status, appraisal/underwriting fields worked in ClickUp). The mapping table (§6) names the authority for every field. This is what makes conflicts deterministic instead of "last save wins randomly."
3. **The immutable join key is the ClickUp `task_id`, not the loan number.** Loan numbers are duplicated for ~1 minute during your "duplicate a file to start a new one" workflow (§4.4). Keying on `task_id` (which is unique even for a duplicate) makes that safe.
4. **Sensitive data syncs both ways, fully.** ClickUp is your regulated system and already holds SSNs, DOBs, and card data. We sync SSN and all sensitive fields **bidirectionally**, encrypted at rest on our side, transported over TLS, and **never written to any log, activity feed, or error message in plaintext** (we log field *names* and a masked indicator, never values). No downgrading, no stripping.
5. **No new native dependencies.** The portal runs on `express` + `pg` only. Webhook HMAC verification, hashing, and everything else use Node's built-in `crypto`. (Keeps Render builds clean, per repo rule.)
6. **Idempotent + durable.** Every sync action is a row in a durable queue with retries/backoff and a dead-letter state. Webhooks are deduped. Re-running never double-creates.
7. **Human-in-the-loop, always overridable.** Admin can pause the whole sync, pause one direction, force a field's authority, re-push or re-pull a single file, and see exactly what happened. The system never "runs away."

---

## 2. Scope filter — which files sync (RTL only)

The decision field is ClickUp **`*Program`** (`50eb857a-d8b1-4c48-9ffe-20b15cdf1338`, dropdown).

**IN SCOPE (sync ON):**
| Program option | Option ID |
|---|---|
| Fix & Flip With Construction | `31e3b89d-34a4-40a9-9bb9-cbcbd1130060` |
| bridge Without Construction | `e8ff7301-6a64-4d5c-b4d4-48c8dd707eaa` |
| Private hard money | `3222c2ec-a6be-419e-99d7-4471f466a9d7` |

**OUT OF SCOPE (ignored on both sides):** `Non-QM - DSCR Ratio`, every `Non-QM …`, `HELOC`, `HELOAN`, `HELOC/HELOAN - *`, `Conventional`, `FHA`, `Jumbo`. (Full option list captured; the sync treats "not in the IN-SCOPE set" as out of scope, so newly-added non-RTL options are safe by default.)

**Edge case — owner-decided:** a file that flips *from* RTL *to* a non-RTL program after we've created it is **not** silently dropped. We **pause its sync** and route it to a new **Manual Review** queue/folder on the loan-officer site (§12.1) where the officer decides what to do — switch it back (maybe it was a mistake), delete it, or archive it. No data loss, human in control.

---

## 3. Architecture

```
                    ┌───────────────────────────── PORTAL (system of record for borrower data) ─────────────────────────────┐
   Borrower/Staff   │                                                                                                        │
   edits ──────────▶│  write endpoints ──▶ emit change ──▶ [sync_outbox]  ──▶  Sync Worker  ──▶ ClickUp REST (Yehuda token)  │──▶ ClickUp
                    │       (borrower.js, staff.js, intake.js, conditions engine)      ▲            │  (create/update task,   │
                    │                                                                  │            │   set custom fields,    │
                    │   apply inbound ◀── reconcile ◀── [webhook_inbox] ◀── /api/clickup/webhook (HMAC verified)             │◀── ClickUp webhook
                    │       (dedupe + echo-suppress + field authority)      ▲                                                 │
                    │                                                       └──── Reconciliation poller (every N min) ────────┘◀── ClickUp GET (filtered)
                    └────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 The durable outbox (portal → ClickUp)
Reuse and extend the existing **`sync_queue`** table (`schema.sql:302`). It already has `entity_type, entity_id, target, direction, op, payload, status, attempts, last_error, run_after`. We add job types beyond today's single `application/create`:
- `application/create`, `application/update` (field-level payload), `application/status`
- `contact/upsert` (CRM dual-write)
- `checklist/status` (one condition dropdown)
- `assignment/officer`, `assignment/processor`, `assignment/underwriter`
- The worker (`src/sync/queue.js`) drains it on an interval (already gated by `RUN_SYNC`/production at `server.js:200`), with the existing exponential backoff, plus a new **`dead`** status after N attempts (surfaced in the Control Center for manual retry).

### 3.2 Inbound: webhooks + reconciliation (ClickUp → portal)
- **New route `POST /api/clickup/webhook`** (mounted *outside* the auth routers, like `/api/events`), verifies ClickUp's `X-Signature` HMAC-SHA256 against the webhook secret, writes the raw event to a **`clickup_webhook_inbox`** table (dedupe by ClickUp's event id), returns `200` fast, and lets the worker process it asynchronously. (At-least-once delivery → we must dedupe; never process inline.)
- **Webhook events we subscribe to:** `taskCreated`, `taskUpdated`, `taskStatusUpdated`, `taskMoved`, `taskDeleted`, `taskAssigneeUpdated`, and (optional) `taskCommentPosted`. Scoped to the **Loan Pipeline space** (`90113223301`) so we don't get CRM-call noise. ClickUp's `taskUpdated` payload carries `history_items` telling us **which** field changed and its before/after — we use that to apply only the changed field, not re-pull everything.
- **Reconciliation poller (safety net):** webhooks are best-effort and ClickUp does **not** emit events for everything (e.g. some bulk/automation changes, and missed deliveries). Every N minutes (configurable, default 5) the worker calls the **filtered team-tasks endpoint** for the Pipeline folders, filtered by `*Program` ∈ RTL set and `date_updated > lastPollWatermark`, and diffs against our shadow copy. This catches anything webhooks missed and is also the **initial backfill** mechanism.

### 3.3 Echo / infinite-loop prevention (the hard part)
Because the integration authenticates as **Yehuda's token**, ClickUp will fire webhooks for *our own* writes, and the actor on those events is "Yehuda Bochner" — indistinguishable by user from Yehuda working manually. So we **cannot** suppress by actor. Instead, three layers:
1. **Shadow copy + content hash.** For every synced file we store the last value we wrote/read per field (a per-file `clickup_shadow` JSON + hash). An inbound change whose value **equals our shadow** is an echo → recorded but not re-applied, and **not** re-pushed.
2. **Suppression window.** When we push field F on task T, we stamp `(T,F,valueHash,expiresAt=now+90s)`. Inbound events for `(T,F)` matching that hash inside the window are dropped as echoes.
3. **Direction stamping on the job.** Outbound jobs carry an origin marker; inbound apply-writes to our DB are flagged so our own write-endpoints don't re-enqueue an outbound job for a value that just came *from* ClickUp (the classic A→B→A loop). This is the standard "loopback guard."

**Owner decision:** run on **Yehuda's token** (`pk_120151948…`), no bot seat for now. Consequence: we **cannot** use the actor to detect echoes (our writes look like Yehuda's own edits), so layers 1–3 above (shadow-hash + suppression window + loopback guard) carry the full load and are **mandatory, not optional**. A dedicated **"YS Portal Bot"** seat remains the recommended future hardening — it would add a clean actor signal and honest attribution ("changed by YS Portal Bot") — and can be dropped in later by swapping the token, with zero mapping changes.

### 3.4 Identity, matching & the join key *(owner-refined — ≥2-field fuzzy match)*
**The Portal File ID is NOT the trigger.** It is the *binding stamp* we write onto both records **after** we've confidently identified them as the same loan. Establishing that identity uses a **multi-field fuzzy match**, never a single key.

- **Identity fields** (any can contribute to a match): Subject Property Address · YS Loan Number · Borrower Name · Borrower DOB · Borrower Email · Borrower SSN · Borrower Cell Phone · Purchase Price.
- **Match rule:** a ClickUp task and a portal application (or a new task vs. an existing one) are the **same file only when ≥2 identity fields agree**. One field alone is never enough — this prevents false binds and is what makes the duplicate case safe (a duplicate transiently matches its *source* on stale data).
- **Materialization gate:** a ClickUp task auto-creates a portal file only once it has **≥2 populated identity fields** — empty/scratch tasks never sync. (This replaces the earlier "past starting status" idea with a concrete data test.)
- **Binding:** once matched (or confirmed genuinely new), we **write our Portal File ID onto the ClickUp task** and store the ClickUp `task_id` on the portal application. From then on the **Portal File ID ↔ task_id** pair is the authoritative link; the fuzzy match is used only to *establish or repair* a binding, never as the ongoing trigger.
- **Duplicate interaction (ties to §4.4):** a freshly-duplicated task initially matches its **source** on several identity fields — we must **not** bind it to the source's portal record (already bound to the source `task_id`). We hold it until the **Subject Property Address changes**; once it diverges, the task is a distinct new file, gets its own Portal File ID, and syncs.
- Every create is an **idempotent upsert keyed by task_id**; re-delivery/replay can't double-create.

---

## 4. WHEN we sync — trigger logic (both directions)

### 4.1 Portal → ClickUp
| Trigger | Action |
|---|---|
| Borrower **submits** an application (not on every draft autosave) **and** program ∈ RTL | `contact/upsert` (CRM) + `application/create` (Pipeline task in the officer's folder, or Lead Capture) |
| Staff/borrower edits a **mapped field** on an existing synced file | Debounced `application/update` with just the changed field(s) — coalesced over ~10s so rapid edits become one push |
| **Internal status** changes (staff) | `application/status` → set ClickUp task status |
| **Checklist/condition status** changes (§8) | `checklist/status` → set the mapped ClickUp dropdown |
| **Officer** assigned/changed | `assignment/officer` → set the Loan Officer users field **and MOVE** the task into that officer's Pipeline folder |
| **Processor** assigned/changed | `assignment/processor` → set the Processor users field **and ADD** the task to that processor's folder/list (multi-list, **keep home** in officer folder) |
| **Underwriter** assigned/changed | `assignment/underwriter` → set the Underwriter users field only (no move/add) |

### 4.2 ClickUp → Portal
| Trigger | Action |
|---|---|
| `taskCreated` in Pipeline space, program ∈ RTL, **passes the duplicate guard (§4.4)** | Create portal application + borrower (keyed by task_id) |
| `taskUpdated` / `taskStatusUpdated` on a mapped task | Apply the changed field(s) per field authority (§6); translate status (§5) |
| `taskMoved` (folder change) | Re-resolve officer from the destination folder; update assignment |
| `taskDeleted` | **Unlink** the ClickUp link, **keep** the portal file + data, route to **Manual Review** (§12.1) for the officer to archive/delete/keep. Never hard-delete. *(owner-decided)* |
| Reconciliation poll | Backfill + catch missed events |

### 4.3 New-file trigger — auto webhook + "Send to Portal" checkbox (emergency + force-resync)
*(Owner-decided.)* A normal (non-duplicate) new RTL task syncs **immediately**, no status gate:
- **Auto (primary):** a `taskCreated` webhook in the Pipeline space with program ∈ RTL, that has **≥2 populated identity fields** (§3.4) and passes the duplicate guard (§4.4) → create the portal file right away, pull all fields, and stamp the Portal File ID ↔ task_id binding.
- **"Send to Portal" checkbox (a new ClickUp field) — two jobs:**
  1. **Emergency create:** if the automatic webhook never fired (missed delivery, downtime, sync paused), staff tick it to force the file over with all its fields.
  2. **Force full resync:** if a change made in ClickUp did **not** propagate through the normal field-level sync, staff **uncheck → recheck** the box to fire a fresh webhook that re-pulls **every** mapped field from ClickUp → portal for that file. The checkbox is the human override for "the sync missed something."
- Both paths converge on the same idempotent upsert keyed on `task_id`, so ticking the box never double-creates.

### 4.4 Duplicate-file guard — wait for the Subject Property Address to change
*(Owner-decided.)* Your standard workflow duplicates an existing task to start a new file; the duplicate momentarily carries the **source's loan number and subject property address** before staff edit it.
1. We key on the immutable **`task_id`**, so a duplicate is always a distinct entity from its source — we never merge or overwrite the source file's portal record.
2. **Detect** a likely duplicate when a `taskCreated` arrives whose **Subject Property Address matches an already-synced task's address** (and/or shares its YS Loan Number).
3. **Hold materialization** for such tasks — do **not** create the portal file — **until the Subject Property Address is replaced** (changes to a new value). That address change is the signal staff have begun the real, distinct file. On that change we immediately create the portal file and pull all current fields.
4. **Hot-poll mode:** freshly-duplicated (and freshly-materialized) files are polled far more frequently (~every 30–60s for the first N minutes, configurable) because rapid field edits are expected — so every field lands on the portal promptly instead of waiting for the normal poll interval.
5. The Control Center shows a **"pending — awaiting address change"** list of held duplicates; staff can force one through with the **Send to Portal** checkbox if needed, or see a **"duplicate loan number"** flag if two live tasks still share a loan number.

---

## 5. Status model — two layers, fully bidirectional

Per your direction: **keep the borrower-facing (external) statuses exactly as they are; mirror ClickUp's workflow internally; translate every internal status to an external one.**

### 5.1 The two layers
- **Internal status** (new column `applications.internal_status`): a **1:1 mirror of the ClickUp task status** (all 38 values). This is what syncs both ways, verbatim.
- **External / borrower-facing status** (`applications.status`): the existing values **plus a new `on_hold`** (owner-approved) = 10 total. **Derived** from `internal_status` via the table below. Borrowers only ever see this. Never pushed *up* to ClickUp (it's a projection, not a source). *(Adding `on_hold` = extend the `applications.status` CHECK constraint via a new migration + a borrower-UI label/badge.)*

**Bidirectional rule:**
- Staff change internal status in portal → push the exact matching ClickUp status. ✅
- ClickUp status changes → set `internal_status` verbatim → re-derive external. ✅
- External status is display-only and always recomputed; it never drives sync (one external maps to many internal, so pushing it up would be ambiguous — that's why the internal mirror exists).

### 5.2 ClickUp status → external (borrower-facing) translation
Grouping follows your rule: *pre-work → new/in-review; anything in back-and-forth processing → processing; underwriting/lender → underwriting; clear-to-close/closing → clear_to_close; anything at/after closing (incl. all post-closing/reconciliation) → funded (borrower sees "funded").*

| ClickUp internal status | External (borrower) |
|---|---|
| starting | new |
| prospect / pricing | new |
| active / fill clickup(1-em) | in_review |
| structuring loan | in_review |
| rolled back | in_review |
| self procesing | processing |
| assigned to processor | processing |
| workflow | processing |
| secondary workflow | processing |
| file being worked | processing |
| file on desk | processing |
| waiting for docs | processing |
| delegated initial | underwriting |
| delegated conditional | underwriting |
| non del imported ba(2-em) | underwriting |
| in underwriting | underwriting |
| approval processing (3-em) | underwriting |
| resubmitted (4-em) | underwriting |
| delegated ctc submission | approved |
| final submission (4-em) | approved |
| ctc (4-email) | clear_to_close |
| scheduling closing | clear_to_close |
| active closing | clear_to_close |
| closed (6-email funded) | funded |
| refinanced | funded |
| in purchase review | funded *(post-closing)* |
| purchase conditions | funded *(post-closing)* |
| pa issued-post closing. | funded *(post-closing)* |
| waiting for final docs | funded *(post-closing)* |
| non del closed reconciled | funded *(post-closing)* |
| closed reconciled | funded *(post-closing)* |
| declined | declined |
| cancelled | withdrawn |
| cancelled & reconciled | withdrawn |
| trash | withdrawn |
| recalled | withdrawn |
| pre-recall | withdrawn |
| inactive / on hold | **on_hold** *(new borrower-facing status — owner-approved)* |

*Confirm the handful marked with notes. "inactive / on hold" is the main judgment call — borrowers can't see an "on hold" state today; do we surface one, or keep showing "processing"?*

### 5.3 External → internal (for portal-originated files, before ClickUp exists)
When a borrower submits, we set `internal_status = 'starting'` and push a new ClickUp task at `starting`. From then on ClickUp's workflow drives internal status. Staff working a file in the portal pick from the **full internal (ClickUp) status list**, and that pushes up.

---

## 6. THE FIELD MAP — every field, both directions

Legend — **Dir:** `⇄` two-way · `←CU` ClickUp is source (pull-authoritative) · `→CU` portal is source (push-authoritative). **All dropdowns:** write with the **option UUID**, read back the **orderindex integer** — the mapping layer translates both ways (see §9). Field IDs are live-verified.

### 6.1 Identity / Borrower PII — *shared field IDs across CRM + Pipeline; write once, applies to both*
| Portal (table.column) | ClickUp field | Field ID | Type | Dir | Source of record |
|---|---|---|---|---|---|
| borrowers.first_name + last_name | *Borrower Name | `474a54a3-a430-4e1f-a3ca-b94d375bece8` | short_text | ⇄ | portal |
| borrowers.email | *Borrower Email | `743c16d3-68f8-4ea2-bda2-e22bf30bbe3b` | email | ⇄ | portal |
| borrowers.cell_phone | 📞 *Borrower Cell Number | `d60cf254-0914-4da9-91cb-c314a64eaa73` | short_text | ⇄ | portal |
| borrowers.date_of_birth | Borrower DOB | `d4e72161-3688-4653-9d35-bd73e04066f7` | date (epoch ms) | ⇄ | portal |
| **borrowers.ssn** (decrypt on push, encrypt on pull) | Borrower SSN | `51e0826e-0293-4d13-ba73-04e4547de520` | short_text | ⇄ | portal — **sensitive, never logged** |
| borrowers.fico | Borrower FICO | `a67357ca-69f0-497b-afd4-39581af60a30` | number | ⇄ | either (both edit; last-writer w/ authority=portal) |
| borrowers.current_address | *Borrower Address | `0b469d1b-a9b0-41de-aac3-b1c3c954d9b4` | location | ⇄ | portal |
| borrowers.citizenship | Citizenship | `045f993c-4c7a-4a03-b71d-44e3ed15aa07` | short_text | ⇄ | portal |
| borrowers.marital_status | Marital Status *(YES/NO = "married?")* | `b91e06a6-ed47-4249-afa5-eaaedf7b4c3e` | drop_down | ⇄ | portal *(confirm semantics)* |
| borrowers.employment_type | Borrowers employment type | `33bf62d8-fa4f-45e5-9c91-a51ce78e5e32` | drop_down | ⇄ | portal |
| borrowers.employer | Borrowers employment | `04f7b699-7e55-49f3-b1a2-77f0ee0fc560` | short_text | ⇄ | portal |
| borrowers.dependents_count | Number of Dependents | `19ce13e0-bdcd-43c3-b365-7b07f1f3824e` | short_text | ⇄ | portal |
| borrowers.years_at_residence | How many Years at Primary Residence? | `fabf5994-e218-43ee-9694-3b2e0caf2a12` | short_text | ⇄ | portal |
| borrowers.prior_address | If less than 2 years… add Prior Address | `616f218e-7bb3-4ee2-9f94-f9f96a054516` | location | ⇄ | portal |
| borrowers.housing_status *(add col?)* | Primary Housing *(Rent/Mortgage/Free…)* | `6ae80836-6835-4c91-a3ef-209923f89e30` | drop_down | ⇄ | portal |
| borrowers.housing_payment *(add col?)* | Primary Housing *(currency)* | `51a91012-5665-4f22-b0c6-3048ed862e3b` | currency | ⇄ | portal |

### 6.2 Loan officer / processor / underwriter (ClickUp "users" fields — set by numeric ClickUp user ID)
| Portal | ClickUp field | Field ID | Type | Dir | Notes |
|---|---|---|---|---|---|
| applications.loan_officer_id → staff_users.clickup_user_id | Loan Officer | `14839ebf-b214-4841-af35-ca10703397f3` | users (single) | ⇄ | requires `staff_users.clickup_user_id` populated (§7) |
| (officer email) | *Loan Officer Email | `9f6cc87f-b93d-4dce-a13e-66de8f47616a` | email | ⇄ | portal |
| (officer phone) | Loan Officer Phone Number | `94026464-bca6-4414-9a9c-f9e238d0533a` | phone | →CU | portal |
| applications.processor_id → clickup_user_id | Processor | `926bad3b-d1a2-432b-8bb4-867c9f7d9a5b` | users (single) | ⇄ | **two-way (owner)** — either side sets it; last-write-wins w/ echo-suppression |
| (processor email) | Processor Email | `4f7b2c03-44da-47a5-8d4c-c0aa823b1283` | email | ⇄ | |
| applications.underwriter_id *(add col)* | Underwriter | `ce85aa3a-ddd4-41b5-8c03-410532077024` | users | ←CU | ClickUp authoritative |
| (underwriter email) | Underwriter email | `951c3a1d-05c5-4387-8203-1e2b8d0d329c` | email | ←CU | |

### 6.3 Product / structure
| Portal | ClickUp field | Field ID | Type | Dir | Source |
|---|---|---|---|---|---|
| applications.program | *Program | `50eb857a-d8b1-4c48-9ffe-20b15cdf1338` | drop_down | ⇄ | portal *(also the scope gate)* |
| applications.loan_type | *Loan type | `ee1b564f-13cb-4841-af4c-e0f762cbcf52` | drop_down | ⇄ | portal |
| applications.lender | *Lender | `a914ec5a-7419-480f-9c28-982f979e8702` | drop_down (40+) | ←CU | ClickUp authoritative (staff pick lender) |
| applications.channel | *Wholesale / correspondent | `6eb27010-b23a-46a7-9040-40d68d930e9d` | drop_down | ←CU | ClickUp authoritative |
| applications.occupancy | * Occupancy | `df9d81b5-0b5d-4e09-a44a-4bbfb3b0291c` | drop_down | ⇄ | portal |
| applications.property_type | *Property Type | `541524d9-255f-4484-ac6d-1011ac60e87b` | drop_down | ⇄ | portal |
| applications.units | *Number of Units | `81fc839f-23f5-4780-a5f1-8298121cce2b` | number | ⇄ | portal |
| applications.term | Term | `b67dd5fd-c753-47e9-b3dd-aa576d742abd` | drop_down | ⇄ | either |
| applications.ppp | *PPP Type & term | `82269a33-79e8-4495-9d74-320edf4e41b6` | short_text | ⇄ | portal — **rarely used on RTL** (owner: PPP is a DSCR/long-term concept); mapping defined, expect empty. Revisit when DSCR is added. |
| applications.ppp (structured) | Is there a Prepayment Penalty? | `a7a92ef5-0011-49bf-9009-625064e6007e` | drop_down | ⇄ | same — DSCR-era field |
| applications.vesting *(via llc)* | *Vesting | `173dc79a-a12d-4233-a6a6-9f4101770ca9` | drop_down | ⇄ | portal |

### 6.4 Property / subject
| Portal | ClickUp field | Field ID | Type | Dir | Source |
|---|---|---|---|---|---|
| applications.property_address | *Subject Property Address | `ef691991-2d07-4d61-aefe-e34a332d61de` | location | ⇄ | portal |

### 6.5 Economics (snapshots — the frozen pricing engine stays client-side; these are values, not recomputations)
| Portal | ClickUp field | Field ID | Type | Dir | Source |
|---|---|---|---|---|---|
| applications.purchase_price | *Purchase price / Estimate Value? | `0fc6370c-60b7-4e20-8b5c-0facb90729cf` | currency | ⇄ | portal |
| applications.as_is_value | **RTL As-Is Value** *(NEW field to add to ClickUp — §10)* | *(new)* | currency | ⇄ | portal *(owner: dedicated RTL as-is field, kept distinct from appraised values)* |
| *(read-only)* → new portal col | Actual Appraised Value *(the appraisal that comes back)* | `9356ceea-f3b2-4373-9271-d1354214db47` | currency | ←CU | ClickUp authoritative |
| *(read-only)* → new portal col | Approximate Appraised Value | `834d0ffb-38ac-4358-b1ea-13f5d345dd91` | currency | ←CU | ClickUp internal estimate |
| applications.arv | ARV - For RTL | `5644fe6e-50bc-449b-91b2-f48aa6aaea55` | currency | ⇄ | portal |
| applications.rehab_budget | Construction budget | `2d27cb55-9f53-4fb1-8a93-eb523ae40660` | currency | ⇄ | portal |
| applications.loan_amount | *Loan Amount | `e393e64a-63e3-46cc-ae03-402520614f28` | currency | ⇄ | portal |
| applications.ltv | *LTV | `3f5cd2e2-9238-4eff-9762-ca888c14201d` | short_text | ⇄ | portal |
| applications.dscr_ratio | DSCR Ratio | `7157db7c-b102-4725-9dbe-2e88a83e5d55` | number | ⇄ | portal (rarely for RTL) |
| applications.rate_pct | Desired Rate % | `ca47de7f-40b7-4a98-b540-2378c0e87954` | number | ⇄ | either |
| (scope of work text) | Scope Of Work (SOW) | `5991f10c-f59f-4b2b-ab25-39da42b35b96` | text | ⇄ | portal |
| applications.original_purchase_price | Original Purchase Price? (Refi only) | `253e80ff-9a76-432e-a2ac-366db5a2c3c5` | currency | ⇄ | portal |
| applications.acquisition_date | Date Subject Property was Purchased? | `dd703e85-247e-4b3b-9664-f73c4877162c` | date | ⇄ | portal |
| applications.assignment_fee | Assignment fee | `6d62e510-9ef7-4d96-b81f-fa1251b11c26` | currency | ⇄ | portal |
| applications.underlying_contract_price | Underlying purchase price | `1a83ab87-bb06-4f20-8187-2bc0476d1f05` | currency | ⇄ | portal |

### 6.6 Entity / LLC / co-borrower
| Portal | ClickUp field | Field ID | Type | Dir | Source |
|---|---|---|---|---|---|
| llcs.llc_name | *LLC Name | `8bb530c0-a903-487d-bfcd-17810ecffddd` | text | ⇄ | portal |
| llcs.ein | EIN | `0ed80e37-17c1-4a36-9b23-33b75a27e385` | short_text | ⇄ | portal |
| applications.co_borrower_id (present?) | *Is there a Co-borrower? | `a62d4e6a-5699-4682-8ac1-144b5119f523` | drop_down YES/NO | ⇄ | portal |
| co_borrower.name | Co-Borrower Name | `5e4d2128-886c-4705-afce-a22ad311a1a9` | short_text | ⇄ | portal |
| co_borrower.email | 2nd Borrower Email | `a5e70ced-f60a-4832-92ba-0d7bee087eb1` | email | ⇄ | portal |
| co_borrower.phone | 2nd Borrower Cell Number | `37837aab-8e6c-4550-b626-01b35e6f5bf0` | phone | ⇄ | portal |

### 6.7 Loan numbers (bidirectional; ClickUp usually the origin)
| Portal | ClickUp field | Field ID | Type | Dir | Source |
|---|---|---|---|---|---|
| applications.ys_loan_number *(editable slot in our UI)* | YS Cap Loan Number | `a6da91bc-9eae-4f9d-b788-353afd4d2858` | short_text | ⇄ | **ClickUp authoritative**, but portal can set/edit and push |
| applications.investor_loan_number | investor Loan Number | `8ff507cc-24f8-4aea-beec-349c7d575980` | short_text | ⇄ | ClickUp authoritative |

### 6.8 Dates
| Portal | ClickUp field | Field ID | Type | Dir | Source |
|---|---|---|---|---|---|
| applications.submitted_at | Date File Submitted | `51ef2193-6f42-4b6a-ab8e-d4bc13f0bd0c` | date | →CU | portal |
| applications.expected_closing | Expected Closing Date | `de57d9fb-4c9e-4881-b6bf-fcf6268e44a6` | date | ⇄ | two-way (owner) |
| **applications.actual_closing** | **Actual Closing Date** | `0846edc7-8619-4ee6-827e-a673570d3057` | date | **←CU** | **ClickUp authoritative (per your instruction)** |
| (status change ts) | Status Milestone change timestamp | `f88cd36d-e57d-4f3e-b4ac-da02da23e8af` | date | ←CU | ClickUp internal |

### 6.9 CRM contact fields (the borrower's contact card, CRM & SALES space)
The CRM contact is upserted in the officer's CRM folder, linked to the Pipeline file via the relation fields. Shared PII IDs above apply. CRM-only:
| Portal | ClickUp field | Field ID | Type | Dir |
|---|---|---|---|---|
| borrowers.contact_type | Contact Type (INVESTOR/PRIMARY/FIRST TIME) | `44120431-132f-4509-a086-e2dea10c3a72` | drop_down | ⇄ |
| (lead source) | Lead Source | `fce6283c-c075-4908-84e8-506cdd4f7c51` | drop_down | ←CU |
| borrowers.cell_phone | 📞 Phone Number | `db6ff972-fc74-49ae-a59a-be684f3e7e81` | short_text | ⇄ |
| relation | Pipeline Link (CRM→files) | `4952e019-c90f-4003-904b-3ae471263ab7` | tasks relation | system |
| relation | CRM Link (file→contact) | `612eed39-0f26-4378-8eda-6346ef9866e8` | tasks relation | system |

---

## 7. Loan-officer & processor mapping (identity crosswalk)

The ClickUp "users" fields need the **numeric ClickUp user ID**. We populate `staff_users.clickup_user_id` (column already exists) from the live member list. **Match on email** (most reliable — names have spelling/case drift). Verified live members:

| Name (ClickUp) | Email | ClickUp user ID | Pipeline folder | CRM folder |
|---|---|---|---|---|
| Joshua friedlander | joshua@yscapgroup.com | 81586262 | 90116357907 | 90116357856 |
| Esther Bochner | esther@yscapgroup.com | 81441384 | 90115283054 | 90115283061 |
| Solomon katz | solomon@yscapgroup.com | 81441383 | 90115017331 | 90115018413 |
| Yehuda Bochner | yehuda@yscapgroup.com | 120151948 | 90115017377 | 90115018437 |
| Yosef Cohen | yosef@yscapgroup.com | 81466296 | 90115279409 | 90115279344 |
| Moshe Mermelstein | moshe@yscapgroup.com | 81537660 | 90115913843 | 90115913766 |
| shia kaff | shia@yscapgroup.com | 81561587 | 90116152676 | 90116152663 |
| Mendel Schwimmer | mendel@yscapgroup.com | 87369209 | 90117307844 | 90117576712 |
| Abraham Eisen | abraham@yscapgroup.com | 87396408 | 90117588937 | 90117589009 |
| solomon weiss | sol@yscapgroup.com | 87406875 | 90117693051 | 90117693135 |
| josef schnitzler | josef@yscapgroup.com | 87406877 | 90117693037 | 90117693155 |
| Isaac Zadmehr | yitzchak@yscapgroup.com | 87406874 | 90117692994 | 90117693166 |
| Pinchus Wieder | pinchus@yscapgroup.com | 87441231 | 90118028635 | 90118110162 |
| Yisroel Weinstock | yisroel@yscapgroup.com | 87450032 | 90118081048 | 90118110163 |
| Simcha Shedrowitzky | simcha@yscapgroup.com | 87451319 | 90118094956 | 90118110164 |

**Processors / ops** (Pipeline-only, never a lead target): Malky Katz `87335667` (malky@) `90117376201` · goldy@yscapgroup `87380437` (goldy@) `90117430703` · Lisa Katz `87431116` (lisa@) `90117952996` · **Yonah Rapaport** (`yonah@yscapgroup.com` — *assumed, verify*) `90118065743` · **Ezra Green** (`ezra@yscapgroup.com`) `90117447287` — *owner: give Ezra **some admin capabilities**; exact portal permissions to confirm at build.*

> **Processor assignment mechanic (owner-clarified):** when a processor is assigned to a file, **ADD** the ClickUp task to that processor's folder/list (multi-home) — do **NOT move** it. The task keeps its home in the loan-officer folder and also appears in the processor's workflow view. Uses ClickUp's **"Tasks in Multiple Lists"** ClickApp (`add task to additional list`). This is the opposite of officer (re)assignment, which **moves** the task.

**Underwriters:** Amanda Cooper `87439003` (amanda@) — **Underwriter manager** *(owner-confirmed)* → maps to the ClickUp **Underwriter** users field; not a loan-officer/lead target. · Shana `87435940` (shana@) `90117990325` — UW.

**Reconciliation — owner decisions:**
- **Chaim Lebowitz** (Pipeline `90118110153`) & **Mendel Bochner** (Pipeline `90118110154`) **ARE loan officers.** Action: create their **CRM folders + lists** set up like the others (folder `"<Name> CRM"` → `List`; space custom fields auto-inherit). *(Build task — see §18.)* **Feasibility:** the public API **can** create the folder + list, but **cannot** create automations or clone a saved list-view. Recommended: **duplicate an existing officer's CRM folder in the ClickUp UI and rename** — that copies lists, views, **and** automations. API folder/list creation is the fallback (you'd re-add views/automations manually).
- **Resolved:** Ezra = **Ezra Green** (ezra@, processor + some admin); Yonah Rapaport = processor (yonah@ assumed); **excluded set confirmed** — Samual Stein, Berish Mendlovic, Boruch Stauber stay non-selectable.
- Cosmetic: code has "Joshua **Freidlander**" vs ClickUp "Joshua **friedlander**"; " Josef Schnitzler CRM" has a stray leading space. We match by **email**, so sync is unaffected — just standardizing display names.

---

## 8. Conditions / checklist mapping (the "bottom of the file" fields)

Two kinds of condition data live in ClickUp; both sync.

### 8.1 The 5-state document-status dropdowns (portal checklist item ⇄ ClickUp dropdown)
Portal `checklist_items.status` uses `outstanding | requested | received | satisfied | issue`. Each portal template already carries a `clickup_field_id` linkage. Mapping (option IDs are in the code's `CHECKLIST` map and verified live):

| Portal checklist template | ClickUp dropdown | Field ID | States |
|---|---|---|---|
| Title | Title | `96799e30-0f72-47e5-9136-5d59203d27b7` | Requested/Received/Satisfied/Issue/Outstanding |
| Insurance | Insurance | `2cfc1e61-6be7-484f-929e-c2de9c7a2e40` | (same 5) |
| Purchase contract | Contract | `85866d28-7135-490d-be71-471a34669629` | (same 5) |
| Assignment | Assignment | `a22694cb-7fcf-49d0-83b5-163cd07b26b0` | (same 5) |
| Rehab budget / SOW | Rehab budget (Scope of work) | `b1cdb8b1-5f74-40bb-8d57-76ec0b0d629f` | Requested/Received/Issue/Received&Uploaded |
| REO | REO | `fa211bd9-d464-44cb-a54c-8485f2d9ec8d` | (same 5) |
| Assets documentation | Assets documentation | `1b813089-5605-4da9-b77b-49a7e105965b` | (same 5) |
| Signed term sheet | Signed term sheet | `d60eef93-d13a-404b-9523-72826e2e37b0` | Requested/Received/Issue |
| ISKA (halachic) | ISKA | `d6c23813-8041-4e8e-916e-89b9ee21e4cc` | Requested/Received/Issue |

**Status normalization:** ClickUp's option labels vary in case ("received" vs "Received", "satisfied" vs "Satisfied"). We normalize on the way in and resolve to the exact option UUID on the way out (§9). When ClickUp has no "outstanding"/"satisfied" option (e.g., Signed term sheet), the portal state collapses to the nearest available option (documented per field).

### 8.2 Internal underwriting/appraisal condition fields (mostly ClickUp-authoritative → surfaced in portal)
These are worked in ClickUp by staff; we **pull** them so the portal reflects reality, and optionally **push** when the portal drives them (e.g., borrower uploads appraisal deposit).
| Meaning | ClickUp field | Field ID | Type | Dir |
|---|---|---|---|---|
| Appraisal ready to order | Is the appraisal ready to order? | `fe1ce98c-…` | checkbox | ←CU |
| Appraisal ordered | appraisal ordered? | `b7d1e6f6-…` | checkbox | ←CU |
| Appraisal received | Appraisal Receved? | `1ee31bfc-…` | checkbox | ←CU |
| Appraisal review | Appraisal review | `e98fa078-…` | drop_down | ←CU |
| CDA (collateral desktop) | CDA (First Fill All Details) | `300b9523-…` | drop_down (Ordered/Cleared/…) | ←CU |
| CDA value | CDA Value | `c80b6083-…` | currency | ←CU |
| Actual appraised value | Actual Appraised Value | `9356ceea-…` | currency | ←CU |
| TPR approval | TPR approval | `5a88002d-…` | drop_down | ←CU |
| Rehab feasibility | Rehab budget Feasibility report | `8ecdd092-…` | drop_down | ←CU |
| Deposit received | Deposit Receved | `b0e894cc-…` | drop_down | ⇄ |
| Submission complete | Submission Complete | `74081468-…` | drop_down | ←CU |
| Credit report pulled | Credit Report | `bfcc21cb-…` | checkbox | ←CU |
| Background report | Background Report | `9ef4bd56-…` | checkbox | ←CU |
| Encompass status | Encompass | `6961b76e-…` | drop_down | ←CU |
| In SharePoint | All Files In SharePoint? | `3d35b577-…` | checkbox | ←CU |
| Title company contact | Title Company Contact | `252cd875-…` | email | ⇄ |
| Insurance company name | Insurance Company Name | `dc0b20e7-…` | short_text | ⇄ |

**Condition reasoning:** when a ClickUp dropdown flips to "Issue obtaining," we surface it in the portal Condition Center as an *issue* on the matching condition, and (optionally) push the ClickUp "Clear File Notes" (`c80cd7aa-…`) text as the reason. Confirm whether "Issue obtaining" should notify the borrower or stay staff-only.

---

## 9. Dropdown index ↔ UUID translation (the classic bug — handled explicitly)

**This is the #1 thing to get right.** ClickUp is asymmetric:
- **Writing** a dropdown value: you send the **option UUID** (`{"value":"31e3b89d-…"}`).
- **Reading** it back (GET task, and in webhook history): ClickUp returns the **orderindex integer** (`"value":0`), *not* the UUID. Verified live: on a real file, `*Program`'s value came back as `0` = "Fix & Flip With Construction", Vesting `1` = "LLC / Corp", Lender `8` = "Blue Lake".

**The translation layer** (in a single `resolveOption`/`readOption` module) keeps, per field, the full option list `[{id, orderindex, name}]` and provides:
- `toClickUp(portalLabel) → optionUUID` (for writes),
- `fromClickUp(index) → portalLabel` (for reads/webhooks),
- and a **name-based fallback** (normalize case/whitespace) so label drift doesn't silently drop a value.

We snapshot the option lists at deploy and refresh them from ClickUp on a schedule (options can be added in ClickUp), stored in the Control Center's mapping table so an admin can see/verify them. **Every mapping direction is unit-tested with the live option lists** so an off-by-one index can't ship.

---

## 10. Fields to ADD to ClickUp (please create these; I'll wire them)

| New ClickUp field | Type | Why |
|---|---|---|
| **Portal File ID** | short_text | The **binding stamp** — holds the portal application UUID, written **after** a ≥2-field identity match (§3.4). **NOT the sync trigger.** Duplicate-proof cross-reference once bound. |
| **Portal File Link** | url | *(approved)* Clickable link that opens the file directly in the portal — for staff jumping from ClickUp to the portal. |
| **Borrower Portal Status** | drop_down | *(approved)* Mirrors the borrower-facing status on the task so staff see exactly what the borrower sees. |
| **Sync Status / Last Error** | short_text | *(approved)* Sync health (ok / retrying / failed + last error) on the task, mirroring the Control Center. |
| **Rehab Type** | drop_down (Cosmetic/Moderate/Heavy/Adding SF/Ground-up) | *(approved)* Portal has `rehab_type`; no ClickUp analog today — add to sync it. |
| **RTL As-Is Value** | currency | *(approved)* Dedicated RTL as-is value, mapped from portal `as_is_value` (kept distinct from Approximate/Actual Appraised Value). |
| **Synced to Portal** | date | Last-sync timestamp; lets staff and the poller see at a glance what's linked and when. |
| **Send to Portal** *(required — owner-approved)* | checkbox | Emergency/manual trigger **and** force-resync. If the auto webhook didn't fire, staff tick it to push the file over with all fields. If a ClickUp change didn't propagate, staff **uncheck→recheck** to fire a full field re-pull for that file. (§4.3) |

*I will not create these myself — you confirm the list first, then I add them via the API (or you add them) and I capture their IDs.*

## 11. Fields / columns to ADD to our system

| New portal column/table | Why |
|---|---|
| `applications.internal_status` (text) | The ClickUp-mirrored internal status (§5). |
| `applications.clickup_status_updated_at` (timestamptz) | When ClickUp last changed status. |
| `applications.underwriter_id` (uuid → staff_users) | We map ClickUp's Underwriter users field. |
| `applications.actual_closing` — *(already exists)* | Populated from ClickUp Actual Closing Date. |
| `applications.clickup_shadow` (jsonb) + `clickup_shadow_hash` (text) | Echo-suppression shadow copy (§3.3). |
| `applications.clickup_last_synced_at`, `sync_state` (text: linked / pending / awaiting_address_change / manual_review / descoped / unlinked / dead) | Per-file sync bookkeeping + Manual Review queue (§12.1). |
| `applications.status` CHECK **+= `on_hold`** | New borrower-facing status (§5). New migration; borrower-UI badge. |
| `applications.hot_poll_until` (timestamptz) | Marks freshly-duplicated files for high-frequency polling (§4.4). |
| `staff_users.clickup_user_id` — *(already exists)* | Populate from §7. |
| **`clickup_field_mappings`** (table) | Admin-editable overrides for every field/option/folder mapping (§12). Seeded from this doc's IDs. |
| **`clickup_webhook_inbox`** (table) | Dedupe + durable inbound events. |
| **`clickup_sync_activity`** *(or reuse `audit_log` with `entity_type='clickup'`)* | The full API activity log (§12). |
| Editable **YS Loan Number** slot in the staff file UI | Per your instruction — enter/edit on our side, syncs up. |
| Structured **card fields** — `card_number`, `card_exp`, `card_cvv` (encrypted) | Parsed from ClickUp's single-line card field (§13); PCI-sensitive, masked/never logged. |

---

## 12. Admin "ClickUp Control Center" (no developer needed)

New screen `/internal/integrations/clickup` (gated by `platform_setup`), backed by `src/routes/admin-clickup.js`. Reuses the existing SSE bus (`src/lib/events.js`) for the live log and `audit_log` for the durable trail. Capabilities:

**Connection & health**
- Token status, workspace/space IDs, webhook registration status + health (ClickUp auto-disables a webhook after repeated failures — we show it and offer "re-register"), last poll time, rate-limit headroom.
- **Master switch:** pause all sync · pause inbound only · pause outbound only.

**Field mapping (editable)**
- The full §6 table rendered live: portal key ↔ ClickUp field ↔ direction ↔ source-of-record, each **editable** (change direction, change authority, disable a field, remap an option). Stored in `clickup_field_mappings`; code constants are the fallback default so behavior is unchanged until an admin edits.
- **Option inspector:** for each dropdown, the live option list with index↔UUID, so mismatches are visible and fixable without a deploy.

**Files & overrides**
- Per-file panel: link/unlink to a ClickUp task, **force re-push**, **force re-pull**, view the shadow copy + last sync, resolve a "duplicate loan number" or "descoped" flag, manually materialize a "pending" file.
- Officer/processor identity crosswalk (§7) with "match by email" + manual override.

**The activity log (your requirement)**
- A **full, filterable, live-streaming log of every API call** both directions: timestamp, direction (▲push/▼pull), file (borrower + address + loan #), field(s) touched, old→new (values **masked for sensitive fields**), actor (portal user / ClickUp user / bot / poller), result (ok / retried / **dead-letter** with the error). Backed by `audit_log` (durable) + the SSE bus (live). Export to CSV.
- Dead-letter queue view with one-click retry.

---

### 12.1 Manual Review queue (LO-facing exception desk) — *owner-requested*
A new **Manual Review** folder/status on the loan-officer site collects files the sync can't decide automatically, so a human resolves them. It catches:
- **Descoped files** — Program changed RTL → non-RTL after sync (§2).
- **Ambiguous matches** — a ClickUp task that matched a portal file on only 1 identity field (below the ≥2 threshold, §3.4), or two live tasks sharing a loan number.
- **Held duplicates** — awaiting the Subject Property Address change (§4.4), surfaced for optional manual push.
- **Dead-letter syncs** — jobs that exhausted retries and need a human call.

For each file the officer can: **switch it back / re-classify**, **delete**, **archive**, or **assign a manual status** (a free internal status that pauses auto-sync until cleared). Implemented as a portal `sync_state='manual_review'` flag + a filtered LO view; borrower-facing status is **frozen** while a file sits here (borrowers see no change). Every action is audit-logged.

## 13. Security / PII policy (sensitive data included, per your instruction)

- **Sync sensitive fields both ways** (SSN, DOB, borrower address). On our side SSN stays **encrypted at rest** (existing `ssn_encrypted` + `ssn_last4`); we decrypt only in-memory at the moment of push and re-encrypt immediately on pull.
- **Never log a sensitive value.** The activity log and `audit_log` store the **field name + a masked token** (e.g. `SSN ✱✱✱-✱✱-1594`), never the plaintext. Error messages are scrubbed via the existing `src/lib/redact.js`.
- **Transport:** TLS only, token in the `Authorization` header, token stored server-side (env / secret), never shipped to the browser (matches current `client.js`).
- **Card data — owner-decided: sync it, with smart splitting.** ClickUp's **Credit card info for appraisal** (`684c900f-…`) crams number + expiry + CVV into one line (e.g. `4266843539945489  05/31  789`). We add **structured card fields on the portal** (card number / expiration / security code) and a **parser at the boundary**: on **pull**, split the single ClickUp line into the three portal slots (regex + heuristics, with an LLM fallback for messy formats); on **push**, re-join the three slots into one line. Stored **encrypted at rest** (same envelope as SSN), **never logged**, masked everywhere (`✱✱✱✱ ✱✱✱✱ ✱✱✱✱ 5489`).
  - ⚠️ **Compliance flag (your call on retention):** PCI-DSS discourages storing the **CVV/security code** after authorization, even encrypted. I'll build exactly as instructed; flagging so you can decide whether to persist the CVV or drop it after use.

---

## 14. Data-model changes (new idempotent migrations)

Following the repo's numbered-migration rule (next is `db/041_*`):
- `041_clickup_sync_core.sql` — add the `applications` columns (§11), `staff_users` backfill, extend `sync_queue` status set with `dead`.
- `042_clickup_control.sql` — `clickup_field_mappings`, `clickup_webhook_inbox`, seed mappings from this doc.
- All idempotent (`IF NOT EXISTS` / `ON CONFLICT`), applied on boot by `migrate-boot.js`.

## 15. Rollout plan (safe, staged — no big-bang)

1. **Phase 0 — Spec sign-off (this doc).** Confirm every section. *(we are here)*
2. **Phase 1 — Identity + read-only backfill.** Populate `clickup_user_id`; poller reads RTL Pipeline files into a **shadow** table; **nothing written anywhere** yet. Prove the mapping + status translation against real files in the Control Center.
3. **Phase 2 — Portal → ClickUp (outbound only).** New portal submissions create/update ClickUp; existing echo-suppression on. Watch the activity log.
4. **Phase 3 — ClickUp → Portal (inbound).** Turn on webhooks + apply, status-gated creation + duplicate guard, on a **pilot subset** (one officer's folder) first.
5. **Phase 4 — Full two-way** across all officers, conditions, the officer toggle UI change, and the loan-number slot. Reconciliation poller as the safety net.
6. **Phase 5 — Go live**, master switch defaults on, dead-letter monitoring.

## 16. The officer-selection change (your requested UX change)

In `app/src/screens/Apply.jsx` (Step 3), replace the always-shown officer dropdown with a **toggle**: *"Do you already work with a specific loan officer?"* — OFF (default) → file routes to **Lead Capture** (exactly today's empty-officer behavior, already handled server-side); ON → reveals the live officer dropdown (fed by `GET /api/roster`). Selecting an officer routes the file to that officer's folder and notifies them; the officer flows through to the ClickUp "Loan Officer" users field and the folder placement. (Minimal, uses the existing autosave + `pickOfficer` handler; rebuild `web/portal/` after.)

---

## 17. Open questions — I need your call on these before building

**✅ Answered:** #2 sync identity → Yehuda's token (§0.1) · #3 duplicate handling → auto webhook + "Send to Portal" checkbox + wait-for-address-change + hot-poll (§4.3–4.4) · #4 on-hold → new borrower status (§5) · #6 officer reassign → set field + move task (§4.1) · **#1 descope → Manual Review queue (§12.1)** · **#7 processor → two-way (§6.2)** · **#9 new ClickUp fields → all approved; matching uses ≥2 identity fields, Portal File ID is a binding stamp not a trigger (§3.4, §10)** · **#11 condition "Issue obtaining" → staff only.**

Also answered: **#5 taskDeleted → unlink + Manual Review (§4.2)** · **card data → sync + smart-split into structured fields (§13)** · **Expected Closing Date → two-way (§6.8)**.

Round 3 answered: **#8 (partial)** Chaim Lebowitz & Mendel Bochner = **loan officers** (create CRM folders, §7/§18) · Amanda Cooper = **Underwriter manager** · **#10** PPP = N/A for RTL (revisit for DSCR); as-is → **new `RTL As-Is Value` field** (§6.5/§10).

**✅ ALL open questions resolved — the spec is fully locked.** Ezra = Ezra Green (ezra@, processor + some admin); Yonah Rapaport = processor (yonah@ assumed); excluded set confirmed; processor assignment = **add-to-list, not move** (§4.1). Build checklist: §18.

1. ~~Descope behavior~~ → **ANSWERED (Manual Review, §12.1).**
2. **Dedicated bot user:** create a "YS Portal Bot" ClickUp seat + token for clean attribution & echo-suppression, or run on Yehuda's token? (recommended: bot)
3. **Duplicate hard-gate:** add a "Create in Portal" checkbox staff tick, or rely on the status-gate + 3-min debounce alone? (recommended: debounce first, add checkbox only if noise persists)
4. **"inactive / on hold"** → which borrower-facing status? (options: processing / a new "on hold" / hidden)
5. **`taskDeleted`** → unlink the portal file (keep data) vs. archive vs. nothing? (recommended: unlink + flag)
6. **Folder moves from the portal:** when an officer is (re)assigned in the portal, should we *move* the ClickUp task into that officer's folder, or only set the Loan Officer field? (moving changes the file's home; confirm)
7. **Processor authority:** is the processor assigned in ClickUp (pull) or the portal (push)? (I assumed ClickUp-authoritative)
8. **Officer roster reconciliation:** confirm Chaim Lebowitz, Mendel Bochner, Ezra, Yonah Rapaport, Amanda Cooper roles; confirm the excluded list; approve standardizing display-name spellings.
9. **New ClickUp fields:** approve the §10 list (esp. Portal File ID — required) and whether to add Rehab Type.
10. **PPP + as-is/appraised value:** confirm which of the two PPP fields and which value field are canonical (§6.3/6.5).
11. **Sensitive notify:** when a condition flips to "Issue obtaining" in ClickUp, notify the borrower or keep staff-only?

---

## 18. Implementation task list (the full build checklist)

### A. ClickUp-side setup (I can do most via API on your go; automations/views are manual)
- [ ] **Create new custom fields** in the Loan Pipeline space: `Portal File ID` (text), `Send to Portal` (checkbox), `Portal File Link` (url), `Borrower Portal Status` (dropdown), `Sync Status / Last Error` (text), `Rehab Type` (dropdown), `RTL As-Is Value` (currency). *(API-creatable; I capture the new IDs into the mapping.)*
- [ ] **Create CRM folders + lists** for **Chaim Lebowitz** and **Mendel Bochner** (`"<Name> CRM"` → `List`). *(Recommended: duplicate an existing officer's CRM folder in the ClickUp UI to also copy views + automations; API fallback creates bare folder+list.)*
- [ ] **Register webhook(s)** on the Pipeline space (`POST /team/{team_id}/webhook`) for `taskCreated, taskUpdated, taskStatusUpdated, taskMoved, taskDeleted, taskAssigneeUpdated`; store the returned **webhook secret**.
- [ ] **Confirm the "Tasks in Multiple Lists" ClickApp is enabled** (required so processor assignment can *add* a task to the processor's folder without moving it).
- [ ] *(Optional, declined for now)* create a **YS Portal Bot** member + token.

### B. Portal DB migrations (idempotent, numbered)
- [ ] `041_clickup_sync_core.sql`: add `applications.internal_status`, `clickup_status_updated_at`, `underwriter_id`, `clickup_shadow` (jsonb) + `clickup_shadow_hash`, `sync_state`, `clickup_last_synced_at`, `hot_poll_until`, `actual_appraised_value`, `approx_appraised_value`, `card_number`/`card_exp`/`card_cvv` (encrypted); extend `applications.status` CHECK **+= `on_hold`**; extend `sync_queue.status` **+= `dead`**.
- [ ] `042_clickup_control.sql`: `clickup_field_mappings`, `clickup_webhook_inbox` (dedupe), seed mappings from this doc.
- [ ] Backfill `staff_users.clickup_user_id` (match by email, §7): all 15 officers + **Chaim Lebowitz & Mendel Bochner** (new LOs) + processors (Malky, Goldy, Lisa, **Ezra Green**, **Yonah Rapaport**) + underwriters (**Amanda Cooper** = UW manager, Shana). Exclude Samual Stein, Berish Mendlovic, Boruch Stauber.

### C. Portal backend
- [ ] Extend `src/clickup/client.js` (get task, set field, get filtered team tasks, create/verify webhook).
- [ ] `src/clickup/registry.js` — DB-backed mapping cache (fallback to code constants) + **index↔UUID option translator** (§9) with unit tests against live option lists.
- [ ] `src/clickup/identity.js` — **≥2-field identity match** (§3.4) + binding (stamp Portal File ID / store task_id).
- [ ] `src/clickup/status.js` — the two-layer **status translation** (§5), both directions.
- [ ] `src/sync/echo.js` — shadow-copy + hash + suppression window + loopback guard (§3.3).
- [ ] Extend `src/sync/queue.js` — job handlers for `application/create|update|status`, `contact/upsert`, `checklist/status`, `assignment/*`; dead-letter; backoff (exists).
- [ ] `src/routes/clickup-webhook.js` — `POST /api/clickup/webhook`, HMAC verify (built-in `crypto`), dedupe→inbox, fast 200.
- [ ] `src/sync/poller.js` — reconciliation poll (RTL filter + `date_updated` watermark) + **hot-poll** for fresh duplicates (§4.4).
- [ ] `src/clickup/card.js` — parse/join the single-line card field (§13), encrypted, masked.
- [ ] Manual Review logic (§12.1): set `sync_state='manual_review'` on descope / ambiguous-match / delete / dead-letter.
- [ ] `src/routes/admin-clickup.js` — Control Center API (health, mappings CRUD, per-file re-push/re-pull, pause switches, activity feed) gated by `platform_setup`; write ClickUp events to `audit_log` + SSE broadcast (§12).
- [ ] Emit outbound jobs from existing write paths (`intake.js`, `borrower.js`, `staff.js`, conditions engine) — debounced/coalesced, loopback-guarded.

### D. Portal frontend (rebuild `web/portal/` after)
- [ ] `Apply.jsx` — the **officer toggle** (§16).
- [ ] Staff file UI — editable **YS Loan Number** slot, **internal-status** picker (full ClickUp list), a **sync panel** (linked task, last sync, re-push/re-pull), card fields.
- [ ] **On hold** borrower-facing badge (§5).
- [ ] Admin **ClickUp Control Center** screen (`/internal/integrations/clickup`) + **Manual Review** queue view for officers.

### E. Config / env
- [ ] `CLICKUP_API_TOKEN` (Yehuda's), `CLICKUP_TEAM_ID` (`9011888435`), `CLICKUP_WEBHOOK_SECRET`, `CLICKUP_POLL_SEC`, `CLICKUP_SYNC_ENABLED`; keep `RUN_SYNC` gate.

### F. Rollout — follow §15 phases (read-only backfill → outbound → inbound pilot → full → go-live).

---

*Prepared from a live audit of the ClickUp workspace and the portal codebase. No code or ClickUp data has been changed. On your sign-off (answers to the last small roster items + a "go"), I build it in the staged phases above.*
