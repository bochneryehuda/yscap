# Appraisal-Ordering: CURRENT Architecture (PILOT / RTL)

**Scope:** the two appraisal-ordering vendor integrations that live side by side in PILOT today —
**AppraisalScope / NAN** (routed through CoreLogic Digital Gateway, "CDG"; code namespace `amc`) and
**Class Valuation** (code namespace `class`). This is a factual map of what exists on `main` as of
2026-08-13, written as the backbone for a unified redesign. It does **not** propose code changes except in
§5 (the recommended architecture). RTL only — both integrations are RTL-only by design.

Everything below is paths relative to `/home/user/yscap/yscap-repo-root_8/`.

---

## 0. Orientation — what's where

| Concern | AppraisalScope / NAN (`amc`) | Class Valuation (`class`) |
|---|---|---|
| Transport / auth | `src/amc/client.js`, `src/amc/session.js` | `src/class/client.js` |
| Wire message build/parse | `src/amc/cdg.js` (CDG JSON envelope) | `src/class/order-build.js` (REST body) |
| Loan-file → order shape | `src/amc/order-service.js` (`loadContext`) | `src/class/order-service.js` (`loadContext`) |
| Pure order spec + assumptions | `src/amc/order-build.js` | `src/class/order-build.js` |
| Form/product selection rules | `src/amc/form-select.js` + `amc_form_map` | `src/class/form-select.js` + `class_form_map` |
| Comments / messages thread | `src/amc/comments.js` | `src/class/messages.js` (`note`/`syncNotes`) |
| Revisions / ROV / SOW-change | `src/amc/revisions.js` + `src/amc/rov.js` | `src/class/messages.js` (`requestRevision`) + `src/class/revision-reasons.js` |
| Documents in/out | `src/amc/documents.js` (out), `src/amc/sync.js` `ingestDocuments` (in) | `src/class/documents.js` (`ingestForOrder`, in only) |
| Cancel | `src/amc/cancel.js` | `src/class/messages.js` (`requestCancel`) |
| Status intake | **POLL** — `src/amc/sync.js` | **WEBHOOK** — `src/routes/class-webhook.js` → `src/class/callbacks.js`; poll BACKSTOP `src/class/poller.js` |
| Lookups/catalog cache | `src/amc/lookups.js` + `amc_lookup_cache` | `src/class/products.js` (live, paginated) |
| Party mapping | `src/amc/party-map.js` | (n/a) |
| HTTP route (staff) | `src/routes/amc.js` → `/api/amc` | `src/routes/class.js` → `/api/class` |
| HTTP route (public webhook) | (none — polled) | `src/routes/class-webhook.js` → `/api/class/callbacks` |
| Frontend panel | `app-v2/src/components/AmcAppraisalPanel.jsx` | `app-v2/src/components/ClassAppraisalPanel.jsx` |
| Feature switches | `AMC_ENABLED` / `AMC_OUTBOUND_ENABLED` / `AMC_DRYRUN` | `CLASS_ENABLED` / `CLASS_OUTBOUND_ENABLED` / `CLASS_DRYRUN` |

**Server mounting** (`src/server.js`):
- L438 `app.use('/api/appraisal', require('./routes/appraisal'))` — the appraisal **desk** (import + findings), unrelated to ordering.
- L443 `app.use('/api/amc', require('./routes/amc'))` — NAN order desk.
- L446 `app.use('/api/class', require('./routes/class'))` — Class order desk.
- L59 `app.use('/api/class/callbacks', require('./routes/class-webhook'))` — public Class webhook, mounted **before** the global JSON parser.
- L1166 `require('./class/poller').start()` — Class callback-drain + order-poll backstop.
- L1181 `require('./amc/sync').start()` — NAN status/document poll worker.

The three route mounts explicitly refuse to pick between vendors. From `src/server.js` L444-446:
> "The SECOND appraisal vendor, mounted alongside — never inside — the AMC desk. Each answers only for itself; nothing here picks between them."

**Frontend mounting** (`app-v2/src/screens/StaffApplication.jsx` L6063-6074): both panels already live inside **one** collapsible `Section` (`id="sec-order-appraisal"`, title "Appraisal"), stacked vertically under `<VendorHeading>` labels — NAN first, Class second, with an explicit comment: *"TWO VENDORS, SIDE BY SIDE, NEITHER THE DEFAULT … Do NOT quietly grow a default here, and do NOT merge the two panels — each answers only for its own vendor."* So the two backends are already visually co-located in one section; what does **not** exist yet is a single unified panel with a **vendor selector** and a shared order model. That is the redesign target.

---

## 1. End-to-end lifecycle map — per vendor

### 1a. AppraisalScope / NAN (CDG "pull" integration)

CDG **never pushes** to PILOT. Everything is an HTTPS POST that PILOT initiates. Two-step auth
(`src/amc/client.js`): GetToken (OAuth2 `client_credentials`, Basic header) → Bearer access token
(cached, single-flight); then DoLogin → an AppraisalScope `api_key` (`src/amc/session.js`) that
`src/amc/cdg.js` embeds in every message body's `clientSystem.referenceIdentifiers` (masked in logs).

| Step | What happens | Owner file / function | Tables |
|---|---|---|---|
| **Load context** | One join reads the file into a normalized shape (property, borrowers, notify emails, entity, client-displayed-on-report id, appraisal card status) | `amc/order-service.js` `loadContext` | `applications`, `borrowers`, `llcs`, `staff_users`, `application_payment_cards`, `amc_lookup_cache` |
| **Draft / preview** | Chooses a form (`chooseForm` over `amc_form_map` rows via `formRules`), auto-fills the spec (`order-build.buildOrderSpec`), computes what's missing (`missingRequired`) and what was auto-filled (`orderAssumptions`). No network. | `amc/order-service.js` `buildPreview` → `route GET /api/amc/files/:id/preview` | reads `amc_form_map`, `amc_lookup_cache` |
| **Place order** | `createOrder(place:true)`: DoLogin → `cdg.buildCreateAppraisal(spec, authCtx)` → insert a `draft` row → set `placing` → `client.write(...,label:'CreateAppraisal')` → parse ACK (`cdg.parseAck`), apply via `applyAck` (writes cdg_order_number / sp_order_number / appraisal_file_number / status). A draft (`place:false`) inserts the masked payload only, no network. | `amc/order-service.js` `createOrder`, `insertOrder`, `applyAck` → `route POST /api/amc/files/:id/order` | `amc_orders` (insert + update), `amc_write_log` (journal) |
| **Status updates** | Poll worker `pollOpenOrdersOnce` selects open orders → `syncOne` → GetAppraisalStatus → `applyStatusResponse` records a status-timeline row (`recordStatusEvent`, dedupe hash) and maps the vendor code to a PILOT lifecycle (`cdg.mapStatusToLifecycle`). | `amc/sync.js` | `amc_orders`, `amc_status_events` |
| **Comments in/out** | Outbound: staff message → `postComment` → AddComment. Inbound: `syncComments` (polled inside `syncOne`) → GetComments, deduped on the AMC comment id. | `amc/comments.js` → `route .../comments` | `amc_order_comments` |
| **Documents out** | Staff pick Document-Center docs → stage bytes at `/postdocuments` (multipart) → carry the getdocument retrievalUrls as `UploadDocument(Multi)`. Auto-upload of the SOW + contract runs every poll (`autoUploadForOrder`, deduped on `documents.id` per order). | `amc/documents.js` `uploadToOrder`, `autoUploadForOrder` → `route .../documents` | `amc_order_documents`, `documents` |
| **Documents in / report** | On `product_available` (CDG 1990), `ingestDocuments`: RetriveAppraisalDocuments → GET each objectURL → save to storage → insert a `documents` row (`doc_kind=NULL`, `visibility='staff_only'`, `source_type='system'`) → hand the MISMO XML to `lib/appraisal/desk.runAppraisalImport` (the SAME importer manual upload uses). On success → order `completed`. | `amc/sync.js` `ingestDocuments` | `amc_order_documents`, `documents`, then all appraisal tables |
| **Revisions / ROV / SOW-change** | All three ride one CDG `AddRevision`. The KIND + structured ROV detail (disputed values + comps from the Property Research Center via `amc/rov.js`) live in `amc_order_revisions`. Revisions/ROV are gated to `completed`/`product_available` (`postRevision` returns `not_ready` otherwise). Inbound status polled by `syncRevisions`. | `amc/revisions.js`, `amc/rov.js` → routes `.../revisions`, `.../rov`, `.../rov-comps`, `.../rov-comp-search` | `amc_order_revisions` |
| **Cancel** | `requestCancel`: guarded write (CancelOrder) → order → `cancel_requested`; only the vendor's 1051 (Cancellation) status confirmation flips it to `cancelled`. Records who/when/why. | `amc/cancel.js` → `route POST /api/amc/orders/:orderId/cancel` | `amc_orders` (cancel_reason/at/by), `amc_write_log` |
| **(Payment)** | Not part of the order lifecycle. The appraisal-fee card is entered via `POST /api/amc/files/:id/card` → the SHARED `lib/appraisal-card.saveApplicationCard` (bidirectional with the `appraisal_card` condition). Payment is MANUAL; nothing is charged programmatically. See §3. | `routes/amc.js` L104, `lib/appraisal-card.js` | `application_payment_cards`, `checklist_items` |

**NAN lifecycle status vocabulary** (`amc_orders.status`, plain text, no CHECK):
`draft → placing → ordered → in_process → assigned → inspected → in_review → product_available → completed`,
plus `on_hold`, `cancel_requested`, `cancelled`, `rejected`, `error`. Mapping is `cdg.mapStatusToLifecycle`
(e.g. 1990→product_available, 1999→completed, 1051→cancelled, 1001→on_hold, 1200→assigned).

### 1b. Class Valuation (REST + webhook)

Class **pushes**: PILOT registers a callback URL once, Class POSTs an event per order change. Class also
supports **two UAD versions per order** — 2.6 (`POST /orders`, `api_version='v1'`) and 3.6 (`POST /v2/orders`,
`api_version='v2'`) — and its callbacks **do not say which version** an order is on, so the version is
written on the order row at placement (`class_orders.api_version`/`uad`/`order_path`) and read back by every
follow-up. Auth to Class is API-key style (`client.configured().ready`); callbacks in are HTTP Basic that
PILOT chooses (`CLASS_CALLBACK_*`).

| Step | What happens | Owner file / function | Tables |
|---|---|---|---|
| **Load context** | Reads the file into a normalized shape (property w/ canonical `propertyTypeKey`, borrower, co-borrower, LO, notify emails). Class requires a **county** → `addressCanon.resolveCounty` geocodes it (recorded as a derived assumption). | `class/order-service.js` `loadContext` | `applications`, `borrowers`, `staff_users` |
| **Draft / preview** | `buildPreview`: auto-picks the product (`form-select.chooseProduct` over `class_form_map`, currently EMPTY so returns null → staff pick), builds the version-correct body (`order-build.buildOrder`), and flattens the **whole built body** into labelled provenance rows (`fieldRows`: read / derived / overridden / missing) — so the screen shows every field that would be sent, not a hand-kept subset. | `class/order-service.js` `buildPreview`, `fieldRows` → `route GET /api/class/files/:id/preview` | reads `class_form_map` |
| **Place order** | `POST /api/class/files/:id/order` requires `confirm:true` + `canPlace`. Writes the `class_orders` row FIRST (status `placing`, recording `api_version`/`uad`/`order_path`/`request_body`), then `client.createOrder(body, query, {path})` on the version-matched path. Includes an **occupancy cascade** (v1 occupancy binds an undocumented enum, so it tries candidate values until Class accepts one, remembering the winner in-process via `orderService.rememberOccupancy`). | `routes/class.js` L117 | `class_orders` |
| **Status updates** | Class POSTs `StatusChanged` etc. → `routes/class-webhook.js` stores verbatim → `class/callbacks.processEvent` maps to a PILOT status via `callbacks.STATUS` and applies via `changesFor`. | `class/callbacks.js` `changesFor`, `processEvent` | `class_callback_events`, `class_orders` |
| **Notes in/out** | Outbound: `messages.note` writes a `class_notes` FromClient row FIRST, then `client.addNote`. Inbound: `NewNotes` callback → `class_notes` ToClient (deduped on Class note id), OR polled `messages.syncNotes`. | `class/messages.js`, `class/callbacks.js` | `class_notes` |
| **Documents in** | `NewAttachments` callback (or completion) → `class/documents.ingestForOrder`: LIST the order's attachments (announcement carries only a name, not bytes/id), FETCH each, resolve bytes across three undocumented shapes (`resolveAttachmentBytes`), save to storage, insert a `documents` row (staff-only, system), and hand any MISMO XML to `runAppraisalImport`. Under a **per-order advisory lock**. | `class/documents.js` | `class_attachments`, `documents`, appraisal tables |
| **Revisions / ROV** | ONE call at Class (no separate ROV endpoint). `messages.requestRevision(kind)`: validates reasons against Class's CLOSED list (`revision-reasons.js`), records to `class_revisions`, gated to `completed`. ROV = same call with value reason codes + supporting comps. | `class/messages.js`, `class/revision-reasons.js` → `route .../revision` | `class_revisions` |
| **Cancel** | `messages.requestCancel` (own endpoint, same reason vocabulary), `confirm:true` required. Not marked cancelled until Class's StatusChanged says Cancelled. | `class/messages.js` → `route .../cancel` | `class_revisions` |
| **(Payment)** | Same as NAN — no vendor-side payment; the appraisal card is the shared condition (§3). | | |
| **Callback registration** | `POST /api/class/callback-setup/register` (`platform_setup` perm) → `client.registerAllCallbacks`, recorded in `class_callback_registrations`. | `routes/class.js` L439 | `class_callback_registrations` |

**Class lifecycle status vocabulary** (`class_orders.status`): `placing → ordered → in_process / assigned /
inspected / on_hold → completed / cancelled`, plus `dryrun`, `error`. Class's raw StatusChanged values
(`active`/`onhold`/`resume`/`completed`/`cancelled`) map via `callbacks.STATUS`.

---

## 2. What is already SEPARATE vs SHARED

### Confirmed separate (the two backends are genuinely independent)

- **Distinct code trees:** `src/amc/*` and `src/class/*` share no runtime module for transport, session,
  message build/parse, order persistence, comments, revisions, documents, cancel, or status intake.
- **Distinct tables:** `amc_orders / amc_order_comments / amc_order_revisions / amc_order_documents /
  amc_status_events / amc_lookup_cache / amc_form_map / amc_write_log` vs `class_orders / class_notes /
  class_revisions / class_attachments / class_callback_events / class_callback_registrations / class_form_map`.
  No foreign key crosses between the two families.
- **Distinct routes + switches:** `/api/amc` vs `/api/class`; `AMC_*` vs `CLASS_*`.
- **Distinct status models:** NAN is a **pull/poll** state machine (`amc/sync.js`); Class is **webhook-driven**
  with a poll backstop (`class-webhook.js` + `class/callbacks.js` + `class/poller.js`). NAN's status codes are
  CDG numeric codes; Class's are its own words + the two-UAD-version problem.
- **Distinct frontends:** `AmcAppraisalPanel.jsx` and `ClassAppraisalPanel.jsx` are independent components with
  their own state, their own `api.amc*` / `api.class*` call sets (`app-v2/src/lib/api.js` L592-637), and their
  own status-label maps.

### Shared today (the seams a unified layer can build on)

1. **The appraisal REPORT view** — `app-v2/src/components/AppraisalPanel.jsx`, mounted at
   `sec-appraisal` (StaffApplication L6013) as "Appraisal & findings". This renders the imported/parsed
   appraisal, findings, photos, and comparables. It is **vendor-agnostic**: both vendors' `ingestDocuments`
   feed the SAME `lib/appraisal/desk.runAppraisalImport`, which populates `appraisals` etc. So a completed
   order from either vendor lands in the ONE report view. `AppraisalPanel` is NOT an order panel — do not
   conflate it with the ordering panels.
2. **The appraisal importer** — `lib/appraisal/desk.runAppraisalImport(appId, xml, ...)` is the single sink
   for the finished MISMO XML from either vendor (NAN `amc/sync.js` L192; Class `class/documents.js` L318).
   This also fires the borrower **"appraisal received" milestone** and the appraisal findings/desk pipeline.
3. **The appraisal payment card / condition** — `lib/appraisal-card.js` + the `appraisal_card` condition,
   shared by borrower routes, staff routes, AND the NAN order desk (`routes/amc.js` `POST .../card`). Class's
   panel does not yet wire the card, but the condition/card storage is vendor-neutral. See §3.
4. **The RTL deal-strategy key** — `amc/order-build.dealStrategyKey` is REUSED by Class
   (`class/order-service.js` L37 imports it) so a `class_form_map` rule keyed on strategy means the same thing
   as an `amc_form_map` rule. The property-type canonicalizer `lib/property-type.propertyTypeKey` is reused by both.
5. **The Document Center + storage** — both vendors file returned docs into `documents` (`visibility='staff_only'`,
   `source_type='system'`) via `lib/storage.save`, and both push out documents categorized by the shared
   `lib/tpr-export.categoryFor`.
6. **Frontend `OrderFailure` component** — both panels render vendor errors through the same
   `app-v2/src/components/OrderFailure.jsx` (`parseOrderFailure`).
7. **The "notify emails" concept** — both compute a recipient list (LO + processor + borrowers) but this is
   the list handed to the VENDOR to email (NAN `products[].notifications`; Class `notificationList`, exactly ONE
   BorrowerInfo item). **Neither integration calls PILOT's own `lib/notify.js`.** There is currently NO in-app or
   PILOT-email notification on order events (placed / status change / comment / report received) — the only
   PILOT notification adjacent to appraisal ordering is the borrower "appraisal received" milestone fired
   downstream by `runAppraisalImport`. This is a real gap for the unified layer (see §4 and §5).

---

## 3. The appraisal payment / credit-card condition (reuse target for a future "Pay" button)

**What the condition is:** a checklist condition keyed by `tool_key='appraisal_card'` (defined in the
condition-type vocabulary `src/lib/conditions/types.js` L24: `{ v: 'appraisal_card', label: 'Appraisal payment
card' }`; also carried as template code `rtl_p1_apprcard` in `staff.js` gates). It represents "the credit card
the appraisal will be ordered on / paid with." Payment is **manual** today — the back office reveals the card
and charges it out-of-band; nothing in PILOT calls a payment processor.

**The one chokepoint — `src/lib/appraisal-card.js`:**
- `validateCardInput(body)` — the single validation contract (Luhn, expiry, CVC 3-4 digits, billing ZIP required).
- `saveApplicationCard({appId, borrowerId, number, cvc, expMonth, expYear, zip})` — encrypts `{number, cvc}` at
  rest with the SSN AES-256-GCM helper (`lib/crypto.encryptSSN`, base64 into `application_payment_cards.card_encrypted`),
  upserts the per-file card row, and flips the `appraisal_card` condition to `status='received'`
  (`UPDATE checklist_items ... WHERE application_id=$1 AND tool_key='appraisal_card'`). **Sign-off stays separate.**
- Reusable copy (opt-in, cross-file): `saveCardForReuse` / `getSavedCard` / `applySavedCardToApplication` /
  `autoApplySavedCardIfOptedIn` — stores an encrypted reusable copy on `borrowers.saved_card_*` (db/043 + db/049)
  and can auto-apply to a new file's condition with no tap.

**Storage:**
- Per-file: `application_payment_cards` (PK `application_id`) — `card_encrypted` (base64 GCM blob of `{number, cvc}`),
  `last4`, `brand`, `exp_month`, `exp_year`, `billing_zip`, `borrower_id`.
- Reusable (profile): `borrowers.saved_card_number_encrypted` / `saved_card_cvv_encrypted` (bytea GCM),
  `saved_card_last4` / `saved_card_exp` / `saved_card_brand` / `saved_card_billing_zip` / `save_card_for_reuse`
  (db/043, db/049).

**How it's filled (all three doors go through the same chokepoint):**
- **Borrower:** `routes/borrower.js` L2163 (direct entry) + L2200 (reuse saved card) → audit `save_appraisal_card`.
- **Staff (generic):** `routes/staff.js` `POST /applications/:id/appraisal-card` (L9313) — "#107: the LO / processor
  / admin can ENTER the appraisal payment card on the borrower's behalf." Frontend: `StaffCardEntry` component
  (`StaffApplication.jsx` L3142), rendered on the `appraisal_card` condition row (L3877-3882).
- **Staff (from the NAN order desk):** `routes/amc.js` `POST /api/amc/files/:id/card` (L104) → the SAME
  `appraisalCard.saveApplicationCard`. This is the **bidirectional link**: entering the card on the order preview
  fills the borrower condition, and a card the borrower entered on the condition shows up on the order preview
  (`amc/order-service.cardStatus` reads it into `preview.card`). Documented in `routes/amc.js` header L11-14.

**How it's revealed (to charge it):** `routes/staff.js` `GET /applications/:id/appraisal-card` (L9177) —
decrypts `card_encrypted`, returns full PAN/CVC, **audits `view_appraisal_card`** (GLBA-grade). Frontend
`revealCard()` at `StaffApplication.jsx` L3439.

**How the condition clears:** `saveApplicationCard` moves it to `received`; final **sign-off** is the ordinary
condition sign-off gate (`staff.js signOffGate`, `isApprCard` branch at L8032 / L8645). It is a normal condition
from the workflow's point of view.

**For a future "Pay" button:** the reuse surface is `lib/appraisal-card.js` — a Pay flow should (a) read the
decrypted card via the existing reveal path (audited), or (b) if a processor is added, tokenize through
`saveApplicationCard`'s chokepoint so the condition + reuse copy stay in step. Any unified order panel should
render the SAME card entry/reveal UI (`StaffCardEntry` / `revealCard`) regardless of chosen vendor — the card is
**not** vendor-specific and neither vendor charges it today.

---

## 4. Status + logging wiring (auditability)

### NAN — polling (`src/amc/sync.js`)

- **Scheduled:** `sync.start()` (booted `server.js` L1181) sets a `setInterval` every
  `cfg.amc.pollSec` (min 30s, default 300s). Every tick calls `pollOpenOrdersOnce`, which **no-ops while
  `AMC_ENABLED` is off** (read at call time — flip on with no redeploy). `.unref()`ed.
- **Per tick:** selects up to `AMC_POLL_BATCH` (25) orders in `OPEN_STATUSES` with a `sp_order_number`,
  oldest `last_polled_at` first → `syncOne`: GetAppraisalStatus → `applyStatusResponse` → then best-effort
  `syncComments`, `syncRevisions`, `autoUploadForOrder`; and on `product_available` → `ingestDocuments`.
- **Inbound events recorded:** `amc_status_events` (one row per distinct status, deduped on a sha1 of
  code+name+condition+description+datetime — `statusDedupeKey`). The order row itself carries the latest
  `status_code/name/description` + `last_status_response` (raw JSON) + `last_polled_at`.
- **Vendor request/response log:** `amc_write_log` (`order-service.journal`) — every **write** action
  (CreateAppraisal, AddComment, AddRevision, UploadDocument*, CancelOrder, postdocuments) with the **masked**
  request (`cdg.maskRequest` strips the api key + login password) + response + `ok`/`error` + `staff_id`.
  Reads (status/comments/revisions/documents polls) are NOT written to `amc_write_log`; their raw payloads
  land on the order/status rows (`last_status_response`, `amc_status_events.raw`).

### Class — webhooks + poll backstop

- **Receiver** (`src/routes/class-webhook.js`, mounted `server.js` L59, **before** the global JSON parser with
  its own 2MB parser): authenticates HTTP Basic (or ApiToken) **fail-closed** (constant-time digest compare),
  stores the delivery **verbatim** into `class_callback_events` (deduped on `(event_name, payload_hash)` where
  the hash includes the day), answers **200 first**, then `setImmediate` → `callbacks.drain({limit:25})`.
  Oversize / unserializable bodies are stored as a marker carrying `bodyDigest` (so two un-storable deliveries
  stay distinct).
- **Processing** (`src/class/callbacks.js`): `drain` selects due, unprocessed, non-dead rows oldest-first →
  `processEvent`: `findOrder` (by Class order id, then unambiguous reference number) → `changesFor` maps the
  payload to `class_orders` column changes (status/reason/appointment/due/inspection/vendor/fee/paid) → applies
  NewNotes (`class_notes`), NewAttachments (`class_attachments`), and triggers `documents.ingestForOrder` on
  attach/completion. A failure **backs off** (`attempts`/`next_attempt_at`, MAX_ATTEMPTS=6 → `dead_at`) so one
  poison delivery can't head-of-line-block the inbox (db/492).
- **Poll backstop** (`src/class/poller.js`, booted `server.js` L1166, every `CLASS_DRAIN_SEC` default 300s):
  (1) re-`drain()` unprocessed rows; (2) `documents.sweepPendingOnce()` re-fetches announced-but-unfetched
  attachments; (3) `pollOpenOrdersOnce()` (owner-directed 2026-08-12) walks open orders and pulls
  notes/report/status straight from Class — an **idempotent** fallback for a lost webhook. All self-gated on
  `CLASS_ENABLED`, bounded, never throws.
- **Inbound events recorded:** `class_callback_events` (the raw inbox, with `processed_at`/`process_error`/
  `attempts`/`dead_at`). The order row carries `last_event_at`, `last_error`, `status_reason`, `invision_url`,
  `assigned_vendor`, etc. Their notes → `class_notes`; their attachments → `class_attachments`.
- **Vendor request/response log:** Class has **no equivalent of `amc_write_log`.** Outbound calls record
  outcome ON the domain row instead: `class_orders.request_body` (the exact body sent) + `last_error`;
  `class_notes.send_error`/`class_note_id`; `class_revisions.vendor_response`/`last_error`;
  `class_callback_registrations.last_error`. The raw callback payloads are fully retained in
  `class_callback_events.payload`. **Gap for the "all logs auditable in the DB" goal:** there is no single
  unified vendor-write journal for Class outbound calls the way `amc_write_log` is for NAN. `audit_log` is used
  for the card reveal/save but NOT for order placement on either vendor.

### Audit-log usage

`audit_log` is written for the payment card (`view_appraisal_card`, `save_appraisal_card` — `lib/audit-actions.js`
L19/L51, `lib/activity.js`) but **NOT** for placing/cancelling/messaging an appraisal order on either vendor.
Order-level audit today lives entirely in the vendor-specific tables above.

---

## 5. Recommended UNIFIED architecture

Goal (owner-stated): merge NAN + Class into **ONE "appraisal order" section with a vendor selector**, backed by a
**thin vendor-adapter interface** that dispatches to the existing, unchanged, technically-separate backends. Keep
the hard-won working order placement for BOTH vendors intact.

### 5.1 The thin adapter interface (a common shape, not a shared backend)

Define one adapter module per vendor exposing a **common contract** that the two existing services already
satisfy under different names. Suggested location: `src/appraisal-order/adapters/{nan,class}.js`, each a thin
wrapper over the existing `src/amc/*` / `src/class/*` — **no logic moves out of the vendor backends.**

Common interface (every method takes `(db, appId | orderRef, opts)` and returns a normalized shape):

| Adapter method | NAN wraps | Class wraps |
|---|---|---|
| `configured()` | `amc/client.configured()` | `class/client.configured()` |
| `preview(db, appId, overrides)` | `amc/order-service.buildPreview` | `class/order-service.buildPreview` |
| `place(db, appId, opts)` | `amc/order-service.createOrder({place:true})` | `routes/class.js` order body → factor into `class/order-service.placeOrder` |
| `listOrders(db, appId)` | `amc/order-service.listOrders` | `class_orders` select in `routes/class.js` |
| `getOrder(db, orderId)` | `amc/order-service.getOrder` | `class_orders` select |
| `comments.list/post/read` | `amc/comments.*` | `class/messages.thread/note/markRead` + `syncNotes` |
| `documents.listUploadable/upload` | `amc/documents.*` | (Class has no doc-upload today — return `unsupported`) |
| `revision.request` (kind: revision/rov/sow_change) | `amc/revisions.postRevision` / `amc/rov` | `class/messages.requestRevision` |
| `cancel(reason)` | `amc/cancel.requestCancel` | `class/messages.requestCancel` |
| `capabilities()` | `{ docsOut:true, rov:'structured', sowChange:true }` | `{ docsOut:false, rov:'reasons', sowChange:false }` |

The adapter is **dispatch only** — it must never mix two vendors' transports, sessions, or tables. A `capabilities()`
method lets the unified UI hide controls a vendor doesn't support (Class has no outbound document upload; ROV is a
reason-coded revision, not a structured comps dispute) instead of hard-coding per-vendor branches in JSX.

### 5.2 The unified route + storage view

- **Route:** a new `src/routes/appraisal-order.js` mounted at `/api/appraisal-order`, applying the SAME
  `requireAuth + requireStaff + canSeeFile` file-scope both current routes use. Every endpoint takes a
  `?vendor=nan|class` (or reads it off the order row for order-scoped calls) and dispatches to the adapter.
  Keep `/api/amc` and `/api/class` mounted during migration so nothing breaks; the unified route is additive.
- **Unified read model (a VIEW, never a shared write table):** a `GET /api/appraisal-order/files/:id/orders`
  that concatenates `amc_orders` + `class_orders` into ONE list, each row carrying a **`vendor` stamp**
  (`'nan'|'class'`), a **normalized status** (see 5.3), and a normalized identity/money block. This is a
  read/view-layer merge only — each backend still answers for its own rows; **never a SQL join or a shared
  write path** (mirrors the RTL/LT front-end-merge rule). Drafts, failed, and active orders are represented
  uniformly by mapping each vendor's status set into one enum + surfacing `vendor` + `last_error` on every row.
- **Draft / failed / active uniformity:** both vendors already have a `draft`/`placing`/`error` notion. The
  unified list should present `{ vendor, unifiedStatus, unifiedStatusLabel, isDraft, isActive, isFailed,
  isTerminal, lastError, orderNumber, placedAt }` so the panel renders one table regardless of vendor.

### 5.3 Per-vendor status normalization

Add a pure normalizer `src/appraisal-order/status.js` mapping each vendor's status vocabulary to one shared enum,
e.g.: `draft | placing | ordered | in_progress | inspected | in_review | report_ready | completed | on_hold |
cancel_requested | cancelled | rejected | error`. NAN already emits near-these strings (`amc_orders.status`);
Class maps its `callbacks.STATUS` outputs. Keep the normalizer **pure + unit-tested** and read the vendor's
native status off the row — do not re-derive from vendor codes at the UI. The UI shows the unified label; a
per-vendor "native status" is available on hover for the desk.

### 5.4 A unified notification layer (new — closes the §4 gap)

Neither backend calls `lib/notify.js` today. Add a thin, vendor-neutral notification seam that fires PILOT
in-app/email on the events that matter — order **placed**, **status change to report_ready/completed**,
**inbound comment/note**, **failed/rejected** — routed through the existing `notify.notifyAppStaff` /
`notifyAppBorrowers` chokepoints with an appropriate category (a new `'appraisal_order'` category, staff-in-app
by default per the "routine staff events are in-app only" rule; the borrower already gets the "appraisal
received" milestone downstream). Wire it at the ADAPTER boundary (one call site per lifecycle transition) so it
fires identically regardless of vendor and cannot diverge between the two backends.

### 5.5 A unified vendor write/audit journal (for the "all logs auditable in Render DB" goal)

NAN has `amc_write_log`; Class has none. Two options, in order of preference:
1. **Minimal:** add a `class_write_log` mirroring `amc_write_log` and journal Class outbound calls there, plus
   emit an `audit_log` row on order place/cancel for BOTH vendors (there is none today).
2. **Unified view:** keep both `*_write_log` tables (do not merge the write paths) and expose a read-only
   `appraisal_order_activity` VIEW/endpoint that unions them with a `vendor` stamp — same read-merge discipline
   as 5.2. This gives one auditable timeline without touching the two write paths.

### 5.6 Frontend

Replace the two stacked panels (`AmcAppraisalPanel` + `ClassAppraisalPanel` under `sec-order-appraisal`) with ONE
`AppraisalOrderPanel` that: renders a **vendor selector** (per file; neither is the default — preserve the
owner's "no default" rule until one is chosen), calls the unified `/api/appraisal-order` endpoints, and uses
`capabilities()` to show/hide vendor-specific controls (doc upload, structured ROV). Keep the shared
`OrderFailure` component and the shared `AppraisalPanel` report view untouched. Render the SAME `StaffCardEntry` /
reveal card UI in the unified panel (the card is vendor-neutral). The two existing panels can be kept as the
first implementation behind the selector and retired once the unified panel is proven.

### 5.7 Risks / what must NOT break

- **Working order placement for both vendors is hard-won.** The NAN `createOrder` path (OAuth→DoLogin→CDG
  envelope→ACK parse→`applyAck`) and the Class path (version-correct body + occupancy cascade + write-row-first)
  must be called **unchanged** through the adapter. Do not "simplify" either into the other — CDG is a JSON
  envelope with an embedded api key; Class is REST with two UAD versions. The `amc/cdg.js` message shapes and
  the `class/order-build.js` version profiles are the load-bearing parts.
- **The vendor backends must stay technically separate** — no shared transport, session, table, or write path.
  Merge only in the read/view + adapter-dispatch layer (mirrors the product-separation discipline used for RTL/LT).
- **Class's version-per-order rule** (`class_orders.api_version`/`order_path`) is essential: a follow-up read on
  the wrong path silently returns the other UAD version's field names. The adapter must carry the order row (not
  re-derive the version from a default).
- **Class's "callback does not say the version" + reference-number ambiguity** (`callbacks.findOrder` refuses to
  guess between two orders on one file) must be preserved — a unified layer must not collapse `reference_number`
  matching into a "newest order wins" shortcut.
- **The occupancy cascade + `rememberOccupancy`** (Class) and the **cancel = 'cancel_requested' until vendor
  confirms** semantics (both vendors) are non-obvious and correct; keep them.
- **Idempotency guarantees:** NAN dedupes status events / comments / documents on vendor ids; Class dedupes
  callbacks on `(event_name, payload_hash)`, notes on note id, attachments on `(order, name)`, and doc-ingest
  under a per-order advisory lock. The unified layer must not introduce a second write path that bypasses these.
- **The appraisal card is manual + audited.** Do not wire a real charge into a "Pay" button without a deliberate
  processor decision; reuse `lib/appraisal-card.js` so the condition + reuse copy + audit stay in step.
- **No default vendor** until the owner picks one — the current code repeatedly and deliberately refuses to
  choose; preserve that in the selector.

---

## Appendix — key files & tables (quick index)

**NAN:** `src/routes/amc.js`; `src/amc/{client,session,cdg,order-service,order-build,form-select,lookups,
party-map,comments,documents,revisions,rov,cancel,sync}.js`; tables `amc_orders`, `amc_order_comments`,
`amc_order_revisions`, `amc_order_documents`, `amc_status_events`, `amc_lookup_cache`, `amc_form_map`,
`amc_write_log`; migrations `db/480`, `db/481`, `db/536`; panel `app-v2/src/components/AmcAppraisalPanel.jsx`;
api `app-v2/src/lib/api.js` L592-611.

**Class:** `src/routes/class.js`, `src/routes/class-webhook.js`; `src/class/{client,order-service,order-build,
form-select,products,messages,revision-reasons,callbacks,documents,poller}.js`; tables `class_orders`,
`class_notes`, `class_revisions`, `class_attachments`, `class_callback_events`, `class_callback_registrations`,
`class_form_map`; migrations `db/490`, `db/491`, `db/492`, `db/537`; panel
`app-v2/src/components/ClassAppraisalPanel.jsx`; api `app-v2/src/lib/api.js` L618-637.

**Shared:** `app-v2/src/components/AppraisalPanel.jsx` (report view, `sec-appraisal`); `lib/appraisal/desk.js`
`runAppraisalImport` (importer sink); `lib/appraisal-card.js` + `application_payment_cards` + `borrowers.saved_card_*`
+ `appraisal_card` condition (payment card); `lib/tpr-export.categoryFor` (doc categories); `lib/storage.js`
(`documents`); `amc/order-build.dealStrategyKey` + `lib/property-type.propertyTypeKey` (deal shape); frontend
`OrderFailure.jsx`. Mount point of both order panels: `app-v2/src/screens/StaffApplication.jsx` L6063-6074
(`sec-order-appraisal`).
