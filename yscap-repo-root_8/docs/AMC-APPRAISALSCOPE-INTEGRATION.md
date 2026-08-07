# AMC appraisal ordering — AppraisalScope / CoreLogic Digital Gateway (CDG)

**Product:** RTL only. LT explicitly excludes orders (AGENTS.md rule 6), and the
appraisal tables already live on the RTL side — this integration never touches LT.

**Status:** Phase 1 (foundation) landed — schema, config, switches, the CDG transport
client + message builders. Everything is **off by default and inert** (no routes
mounted, no worker booted) until later phases wire it and the switches are turned on.

---

## 1. What this is

Today PILOT only *ingests* a completed appraisal XML (`src/lib/appraisal/desk.js`
`runAppraisalImport` → `appraisals` + comps/units/photos/findings + conditions +
reprice). Ordering is a manual checklist task (`rtl_p3_appr`) plus a stored payment
card the back office charges by hand.

This integration adds the **outbound** half: order the appraisal directly from the AMC
with every field auto-filled and the right form auto-selected; track the whole
lifecycle; run a two-way comment thread with the AMC; request revisions, ROV
(reconsideration-of-value) disputes and scope-of-work changes; push documents up and
pull the finished report back into the file automatically.

## 2. The vendor: how CDG actually works

It's a **synchronous "pull" integration**. **We always initiate over HTTPS POST, and
CDG never pushes anything to us.** That single fact shapes the architecture: every
inbound thing — status changes, AMC messages, revisions, completed documents — must be
**polled** on a schedule. There is no webhook to receive.

### Auth (two steps, then every call carries the api key in its body)
1. **GetToken** — OAuth2 `client_credentials`, HTTP Basic auth (`clientId:clientSecret`),
   form body `grant_type=client_credentials`. Returns an `accessToken` used as the
   `Bearer` on all later calls. Cached in-memory to expiry with single-flight.
2. **DoLogin** — body carries the account id/password + subdomain; returns an
   AppraisalScope **`api_key`** we embed in the body of **every** subsequent request at
   `message.clientSystem.referenceIdentifiers[type="ApiKey"]`.

### Endpoints (all POST)
- **Lookups + Create** → `.../order/appraisal_service/request/appraisalscope/client`
  (Create omits `?orderId=`).
- **Update / order-lookup** → same base with `?orderId=<DigitalGatewayOrderNumber>`.
- **DoLogin** → `.../direct/appraisal_service/request/appraisalscope/client`.
- **Document bytes out** → `POST /postdocuments` (multipart) → returns a `retrievalUrl`
  (a `getdocument` URL) we then pass as `objectURL`.
- **Document bytes in** → `GET` the `objectURL`/`getdocument/<id>` returned by
  `RetriveAppraisalDocuments` (same Bearer auth).

### Key identifiers
- `DigitalGatewayLenderIdentifier` — a CoreLogic reporting id (assigned to us).
- `DigitalGatewayOrderNumber` — the CDG order id (e.g. `CLGGL100417`); the `?orderId=`.
- `ServiceProviderOrderNumber` — the **AppraisalScope `appraisal_id`**; used on every
  order-specific action.
- `ServiceProviderSubDomain` — our vendor subdomain (e.g. `integrations.uat`), on
  every call.
- `ClientOrderNumber` — our own order number. `sourceClientIdentifier` — our client/user id.

### The actions we use
- **Order:** `CreateAppraisal` (+ `AddForm` for extra forms on the same loan).
- **Message:** `AddComment` (out) + `GetComments` (poll in) — the AMC↔us thread,
  deduped by `commentId`.
- **Revisions:** `AddRevision` (out — free text) + `GetRevisions` (poll in).
- **Documents:** `UploadDocument` / `UploadDocumentMulti` / `UploadContract` (out) +
  `RetriveAppraisalDocuments` (in).
- **Status:** `GetAppraisalStatus` / `GetAppraisalDetail` (poll).
- **Lookups (cache):** `GetJobType`, `Get_JobTypes_By_LoanType`, `GetLoanType`,
  `GetPropertyType`, `GetAMCPreference`, `GetLoanOfficer`, `GetProcessor`, … (populate
  the order-form dropdowns and drive form selection).

### The important realisation: there is **no native ROV / SOW endpoint**
The AMC exposes three primitives — `AddRevision` (free-text request), `AddComment`
(thread) and the upload actions (evidence). So an **ROV dispute**, a **general revision
request**, and a **scope-of-work change** are all built as structured workflows *in our
system* on top of those primitives. PILOT owns the ROV/revision UX and audit trail; the
AMC just sees revision text + attached PDFs + comments.

### Requirement → mechanism
| Owner's requirement | CDG mechanism |
|---|---|
| Order appraisals, auto-filled | `CreateAppraisal` (+ `AddForm`) |
| Auto-select the form | `GetJobType` / `Get_JobTypes_By_LoanType` → a form-mapping rule (`productCode`) |
| Get documents back automatically | poll `GetAppraisalStatus` → **ProductAvailable (1990)** → `RetriveAppraisalDocuments` → download → Document Center → `runAppraisalImport` |
| Comment section back-and-forth | `AddComment` (out) + poll `GetComments` (in) |
| ROV dispute from Property Research | `AddRevision` (narrative) + `UploadDocumentMulti` (comps/evidence) + thread |
| General revision request | `AddRevision` |
| Upload documents to specific orders | `/postdocuments` → `retrievalUrl` → `UploadDocument(Multi)` |
| Contract in → upload; SOW changed → revise + upload | `UploadContract`; `AddRevision` + upload new SOW |

### Status lifecycle (poll `GetAppraisalStatus`)
`OrderReceived (1010)` → `OrderInProcess (1102)` → `AssignedToAppraiser (1200)` →
`AppointmentTimeSet (1006)` → `Inspected (1054)` → `AppraisalSubmittedToAMC (1056)` →
`OrderInReview (1105)` → **`ProductAvailable (1990)`** (PDF ready → pull docs) →
`Complete (1999)`. Also `SetHold (1001)` / `SetOffHold (1002)`, `Cancellation (1051)`,
`OrderDeclined (1201)`, `Correction (1092)`, `NoteToClient (1000, free-form vendor note)`.
NACK/errors: `0`=ACK; negatives (`-100 NOT_AUTHENTICATED`, `-996 Missing required field`,
`-1007 OrderRejected`, `-1008 Service Provider Processing Error`, …).

## 3. Our data model (`db/480_amc_orders.sql`)

- **`amc_orders`** — one row per order (CreateAppraisal + AddForm children). Holds our
  and the AMC's identifiers, the form ordered, the lifecycle `status`, fees, and the
  request/ack/status audit payloads. `checklist_item_id` links the appraisal condition.
- **`amc_order_comments`** — the two-way thread (`direction` in/out, `amc_comment_id`
  deduped).
- **`amc_order_revisions`** — general revisions + ROV + SOW-change (`kind`), with
  structured `rov_detail` (disputed values + Property-Research comps).
- **`amc_order_documents`** — documents pushed/pulled (`direction`, `amc_document_id`
  deduped, `document_id` → our Document Center).
- **`amc_status_events`** — the polled status timeline (deduped per order).
- **`amc_lookup_cache`** — cached lookups per (type, environment).
- **`amc_form_map`** — admin-editable form-selection rules (program / property /
  purpose → `productCode` + add-ons + preferred AMC).
- **`amc_write_log`** — the masked outbound write journal.

## 4. Where auto-fill / ROV / documents pull from (existing subsystems)

- **Master order data — `applications`**: `ys_loan_number` (loan #), `borrower_id` /
  `co_borrower_id` → `borrowers`, `llc_id` → `llcs` (vesting entity), `property_address`
  (jsonb), `property_type` / `units`, `occupancy`, `loan_amount`, `loan_type` /
  `program` / `refinance_economic_type`, `purchase_price` / `as_is_value` / `arv`,
  assignment fields. Use `src/lib/deal-basis.js` for purchase-vs-refi basis.
- **Property Research Center — `/api/research`**: `GET /properties/:id` (address,
  county, occupancy, flood, comps history, sale contract); `GET /comps?application_id=`
  (ranked comparables → ROV evidence). Tables `properties` / `property_observations` /
  `property_sales` (`db/409`).
- **Document Center — `documents`**: enumerate with `GET /api/staff/applications/:id/documents`;
  bytes via `src/lib/storage.js`; categorize with `tpr-export.categoryFor` /
  `selectTprDocuments` (the ONE "every current document on this file" chokepoint —
  accepted-only). Categories include Appraisal, Contract & Assignment, Scope of Work, EMD…
- **Contracts** — documents on `rtl_p1_contract` / `rtl_p5_assign` (category
  "Contract & Assignment"). **SOW** — the `rehab_budget` checklist item's `tool_payload`
  + exports `doc_kind='rehab_budget_export'`; "signed off" = `status='satisfied'` /
  `signed_off_at`. **Signed-off conditions** — `checklist_items.status='satisfied'` /
  `signed_off_at`; docs link via `documents.checklist_item_id`.
- **Inbound completed appraisal** — file the returned XML/PDF as `documents`
  (`doc_kind='appraisal_xml'`/`appraisal_pdf`, staff-only) and call
  `runAppraisalImport` (`src/lib/appraisal/desk.js`) — the deep inbound machinery
  already parses, reconciles, raises findings and reprices.

## 5. Architecture (mirrors the Sitewire read-write exemplar)

- `src/amc/client.js` — the CDG transport: `fetch`-based, token bucket, body-under-abort
  timeout, transient-only retry, `AMC_DRYRUN` gate, fail-closed `AMC_OUTBOUND_ENABLED`
  gate, in-memory OAuth token cache + single-flight, `/postdocuments` multipart,
  `getdocument` fetch.
- `src/amc/cdg.js` — pure message builders + response parsers (unit-tested,
  `scripts/test-amc-cdg-pure.js`).
- Config in `src/config.js` `cfg.amc.*` (env-driven, default off); documented in
  `.env.example`; switches `AMC_ENABLED` / `AMC_OUTBOUND_ENABLED` / `AMC_DRYRUN` in
  `src/lib/integrations/switches.js`.
- (Later) `src/sync/amc-sync.js` — a `setInterval` poll worker booted in `server.js`,
  self-gated on `AMC_ENABLED`; watermark in `sync_runtime_state`.
- (Later) `src/routes/amc.js` (staff, per-file scope) + `src/routes/admin-amc.js`.
- (Later) `app-v2` order/comments/ROV/document panels in the appraisal area of
  `StaffApplication.jsx`.

**Safety posture:** additive idempotent migrations; every write journaled; ambiguous
cases park to `sync_review_queue` (`source='amc'`); nothing sends while the master switch
is off; writes need the separate outbound gate; dry-run builds+logs and sends nothing.

## 6. Phased plan (task list)

1. **Foundation** *(done)* — schema, config, switches, CDG client + builders + pure test.
2. **CDG transport + envelope builders** *(done with #1)*.
3. **Lookups cache + form-selection mapping** — cache the lookups; build the
   program/property/purpose → `productCode` rules; admin editor.
4. **CreateAppraisal order builder + auto-fill** — assemble a full order from
   `applications` + Property Research; `AddForm` for multi-form loans; staff
   preview/edit/submit.
5. **Polling worker + inbound document ingest** — poll status/comments/revisions; on
   ProductAvailable pull docs → Document Center → `runAppraisalImport`.
6. **Comment thread** — AddComment/GetComments; unread badges.
7. **Revisions / ROV / SOW & contract automation** — AddRevision; ROV builder pulling
   comps from Property Research; auto-upload corrected SOW / contract.
8. **Document upload picker + auto-upload rules** — select from Document Center /
   conditions / SOW / contracts and push to a specific order.
9. **Frontend** — order/status/comments/ROV/document panels + admin health/mapping.
10. **Tests, product-separation, docs, PR.**

## 7. Credentials — what we have, what is still missing, how to check

**No credential value belongs in this repository.** Everything below is set in the
Render service environment (or a local `.env`, which is gitignored). This section names
variables only.

### Received (owner, 2026-08-06) — UAT

| Variable | What arrived | Status |
|---|---|---|
| `AMC_CLIENT_ID` | UAT OAuth client id | received |
| `AMC_CLIENT_SECRET` | UAT OAuth client secret | received |
| `AMC_LENDER_IDENTIFIER` | the vendor's **"GGID"** (`GG…`) — same field, paste verbatim | received |

### Still required before anything can authenticate

| Variable | What to ask the vendor for | Blocks |
|---|---|---|
| `AMC_LOGIN_ACCOUNT` | the AppraisalScope **user** orders are placed as | DoLogin → everything |
| `AMC_LOGIN_PASSWORD` | that user's password | DoLogin → everything |
| `AMC_SUBDOMAIN` | our AppraisalScope tenant, e.g. `integrations.uat` | DoLogin → everything |
| `AMC_SOURCE_CLIENT_ID` | our client/user id inside AppraisalScope | placing an order |

The OAuth pair and the login pair are **two different credentials for two different
systems** — the first authenticates *the software* to CoreLogic's gateway, the second
authenticates *a person* to the AppraisalScope tenant behind it. Having one is not
having the other, which is why `AMC_LOGIN_ACCOUNT` is still outstanding even though
the OAuth keys have arrived.

`AMC_FALLBACK_APIKEY` is the escape hatch: if the vendor hands over a ready-made UAT
`api_key` instead of a login, set that and DoLogin is skipped entirely.

### Verifying, without ordering anything

```
npm run amc:preflight                  # config → GetToken → DoLogin → one read-only lookup
npm run amc:preflight -- --config-only # just report what is set/missing, call nothing
npm run amc:preflight -- --lookup GetJobType --verbose
```

`scripts/amc-preflight.js` reads the same variables the running service does and goes
through the same transport, so a pass here means the service will work. It turns the
master switch on **for its own process only** and force-disables the write gate, so it
cannot place a billable order. Each step isolates one credential and a failure is
*named* — `credentials`, `session`, `endpoint`, `network`, `vendor` — with the fix.

One trap it is explicitly built to avoid: **an egress firewall answers HTTP 403 too.**
A blocked outbound connection and a wrong client secret look identical unless you read
the response body, so the classifier checks the body first and reports a network denial
as `network`, never as `credentials`. If the preflight reports `network`, the
credentials have not been tested at all — the request never left our side. CoreLogic's
hosts must be reachable from wherever it runs (and CoreLogic generally has to allowlist
the caller's egress IP on their end too — worth confirming when the login is requested).

### Still to verify against a live UAT tenant

A handful of *optional* CreateAppraisal leaf field names (best-contact, some
site-analysis fields) are marked "verify against UAT" in `cdg.js` — the **required**
fields all come from the vendor's own sample payloads and are pinned by the pure test.
The lookups (`GetJobType` etc.) also decide the real `amc_form_map` rules, and those
cannot be finalized until a lookup call actually returns this tenant's form catalog.

## 8. Owner decisions (2026-08-05)

- **Credentials:** *(updated 2026-08-06)* the UAT OAuth pair and the GGID have arrived;
  the AppraisalScope login (`AMC_LOGIN_ACCOUNT`/`PASSWORD`), the `AMC_SUBDOMAIN` and
  `AMC_SOURCE_CLIENT_ID` are still outstanding. Full status and the check command are in
  section 7.
- **Payment stays MANUAL**, but the appraisal-fee card must be **linked** to the
  existing payment-card condition (`application_payment_cards` / the `appraisal_card`
  condition, `src/lib/appraisal-card.js`): entering the card **at the order fills the
  condition**, and entering it **at the condition fills the order** — one card, entered
  once, both places. No auto-charge through the AMC for now (the Payment* actions stay
  unused).
- **Ordering lives in the Orders desk.** Add "Order an appraisal" as a **new order type
  in the existing Orders section** (`file_orders` — alongside Title, Insurance, Attorney
  closing prep; `src/lib/closing-prep.js` / the Orders desk routes). That's where a
  staffer places and tracks the appraisal order.
- **Form auto-picks, staff can override** — the `amc_form_map` rules choose the form,
  shown on the order preview where staff can change it before sending.
