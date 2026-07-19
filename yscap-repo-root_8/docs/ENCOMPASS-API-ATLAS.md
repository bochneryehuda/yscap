# Encompass Developer Connect — API Atlas & Platform Notes

_Research pass, 2026-07-17. **Status: research only — nothing implemented.** Read-only scope for
instance BE11397907. No Encompass endpoint was called during this research; no credentials appear
in this document (the Postman environment reviewed contains placeholder values only). Compiled from
seven research passes (C1–C7) over the official Encompass Developer Connect 26.2 Postman collection
(800 requests), developer.icemortgagetechnology.com documentation, and the portal repo
`/home/user/yscap/yscap-repo-root_8` (read-only)._

_Revision note (2026-07-19): post-critique consistency pass applied (decisions D1–D17)._

---

## 0. Plain-language summary (read this first)

Encompass is the loan origination system (LOS) — the system of record for every loan file. The goal
is for the PILOT portal to **read** from it (loan status, conditions, milestones, documents) and
**never write to it** — the portal should be structurally incapable of changing a loan file even if
a bug tried. This document is the map of how that works:

- **How we log in (§2):** the portal gets a key (an "API key") from Encompass plus its own dedicated
  Encompass user account. Like a building keycard, the pass expires quickly if unused and must be
  renewed constantly — the software handles that automatically. The Encompass admin can make that
  user account **View Only** on the Encompass side, so even Encompass itself refuses writes from it.
- **What we can read (§4–§8):** everything the business cares about — borrower details, loan
  amounts, which milestone a file is on, whether the rate is locked, every underwriting condition
  and the documents attached to it, and who changed what and when.
- **How we find loans (§5):** one "pipeline" query sweeps the whole book (including archived/funded
  files) in a handful of calls, then we pull details per loan.
- **How Encompass tells us about changes (§6):** in Phase 1 we simply ask on a schedule (polling)
  — no webhooks are set up at all (Decision D2). Webhooks — Encompass calling our server when
  something changes — are a later accelerator, and ICE (the vendor) says delivery is **not
  guaranteed**, so polling remains the source of truth either way.
- **The safety fence (§9–§10):** of the 800 operations in the official API catalog, **318 change
  loan data and are permanently forbidden**. Only a short, explicit allowlist of read operations is
  ever permitted; everything else is denied by default at a single choke point in code — the same
  pattern the portal already uses to make ClickUp deletes impossible
  (`src/clickup/client.js:15-40`).

Nothing below is built. This is the reference for the design conversation and for future
engineering sessions.

---

## 1. Scope and sources

| Source | What it provided |
|---|---|
| Encompass Developer Connect 26.2 Postman collection (800 requests, local upload) | The complete endpoint surface, request/response samples, field-ID examples |
| Pre-built endpoint index (`scratchpad/research/postman-endpoint-index.md`) | Line-referenced inventory used for classification |
| developer.icemortgagetechnology.com (fetched 2026-07-19) | Official contracts, limits, changelogs (URLs cited in the C1–C7 findings files) |
| Portal repo (read-only) | Existing patterns to reuse: token cache (`src/lib/sharepoint.js`), write guards (`src/clickup/client.js`), webhook receiver (`src/routes/clickup-webhook.js`), sync queue (`src/sync/queue.js`), review queue (`db/108_sync_review_queue.sql`) |
| Findings files | `scratchpad/research/findings/C1.md` (auth) … `C7.md` (classification); machine-readable classification in `scratchpad/research/c7-classified.json` |

Three identifiers exist and must not be confused: the **OAuth client_id** (the API key), the
**Encompass Client ID** (10 digits), and the **Instance ID** (`BE11397907` for YS Cap).

---

## 2. Authentication and token lifecycle

### 2.1 The grant that applies to us

Official docs are explicit: *"Grant type client_credentials is for ISV partners only. Lenders must
use grant type = password."* YS Cap is a lender, so the portal uses the **resource-owner password
grant** with a dedicated Encompass service user:

`POST https://api.elliemae.com/oauth2/v1/token` with form fields `grant_type=password`,
`username=<serviceuser>@encompass:BE11397907` (fully-qualified format), `password`, `client_id`,
`client_secret`, `scope=lp`. Confirmed exactly in the Postman collection.

The `client_credentials` path is structurally unavailable to us: it requires a partner-issued API
key paired to an "API User" whose password is removed by the very act of checking the API User box.
The interactive `authorization_code` flow (the only SSO-compatible one) is irrelevant for a
headless sync. **Impersonation via token exchange exists and is fully write-capable** (the Postman
sample literally creates a loan as the impersonated user) — excluded from Phase 1 entirely.

### 2.2 Token lifetime — two conflicting rules; design for the stricter

- EDC docs: token active **30 minutes**, extended only if used within **15 minutes** of last use,
  hard cap **24 hours**. No refresh token exists — "refresh" means re-authenticating.
- A newer platform overview page says **15-minute idle / 2-hour max**.

**Open question — carry both:** which regime applies today is unconfirmed. A cache that reuses a
token only while `idle < ~12–14 min` and `age < ~1.5 h`, plus a one-shot re-auth-and-retry on any
401, is correct under either rule. The documented token response sample omits `expires_in` — track
lifetimes with our own clock and never infer validity from a successful call (a call made after 15
idle minutes can succeed without extending the window).

### 2.3 Introspection, revocation, key management

- `POST /oauth2/v1/token/introspection` (Basic auth `client_id:client_secret`) returns `active`,
  `user_name`, `encompass_instance_id`, `identity_type` — **assert at startup that the token is
  bound to the expected service user and to `BE11397907`**, and refuse to sync on mismatch.
- `POST /oauth2/v1/token/revocation` — call best-effort on graceful shutdown and in the leak runbook.
- The API key is obtainable only by a **Super Administrator** (Developer Connect portal → My
  Account → API Key). The only rotation path is **Regenerate Secret**, which "breaks any current
  Developer Connect applications using this API key" — rotation is a coordinated cutover, not a
  zero-downtime dual-key swap. Whether a second concurrent key can be issued is an open question
  for ICE.

### 2.4 Provisioning checklist for the Encompass admin

1. Create a normal (non-"API User") service user with a strong password — checking "API User"
   removes the password and breaks the lender grant.
2. Build a dedicated least-privilege persona (e.g. `Portal ReadOnly API`) with LO Connect/web
   access enabled (required for API access) — never reuse `admin`/Super Administrator (`admin`
   ignores business rules entirely, voiding the read-only guarantee).
3. Add a **"Persona Access to Loans = View Only"** business rule — the server-side read-only lock,
   independent of anything the portal does. Personas genuinely bind API calls; ICE has actively
   patched enforcement gaps (EDC 25.3 field-rule fix, EDC 26.1 loan-rule fix).
4. Review **"Persona Access to Fields"** rules: since 25.3 restricted fields come back hidden or as
   "User doesn't have access" — a missing field is indistinguishable from an empty one, so audit
   field visibility after every persona change.
5. Exempt or calendar the service user's password expiry (an unnoticed forced change is the #1 way
   headless integrations die), budget one license seat, and verify before go-live: introspect,
   read a known loan, and confirm a sandbox write attempt is **rejected**.

Secrets live only in Render environment variables (the repo's existing pattern, `src/config.js`);
tokens live in memory only, never logged, never persisted, never shipped to the browser.

---

## 3. V1 vs V3 APIs

| Aspect | V1 | V3 |
|---|---|---|
| Architecture | "RESTful wrappers on legacy SOAP/WCF" | True REST, better performance |
| Collection IDs | Inconsistent — some unique IDs, some positional indices | Variable collections get **system-generated, immutable, per-loan-unique IDs** (persist these as foreign keys, never array positions) |
| ICE guidance | — | "Always use the V3 API when it's available; if not, use V1" |

V1 remains required today for: borrower-pair reads (`/v1/loans/{id}/applications`), classic
(non-enhanced) conditions, rate-lock requests, loan metadata, `supportedEntities`, and the
`pathGenerator`/`contractGenerator` schema helpers. Build on V3 everywhere else and keep unneeded
V1 routes off the allowlist.

---

## 4. Reading loan data

### 4.1 The three read paths

| Path | Verb/URL | Best for |
|---|---|---|
| **V3 Get Loan** | `GET /encompass/v3/loans/{loanId}` + `view=entity\|logs\|full`, `entities=` comma list, `includeEmpty`, `includeRemoved` | Structured objects: borrower pairs, property, residences, employment, logs |
| **fieldReader** | `POST /encompass/v3/loans/{loanId}/fieldReader?invalidFieldBehavior=Fail\|Exclude\|Include` (also V1) — body is a JSON array of field IDs | Point reads of classic field IDs including virtual roll-ups; **POST verb but strictly read-only** |
| **Sub-resource GETs** | `GET /v3/loans/{loanId}/<collection>` (milestones, conditions, applications/{appId}/borrower/residences, vestingEntities, …) | One collection at a time with stable IDs |

An unfiltered `view=full` loan is enormous (thousands of fields plus logs) — always pass
`entities`. There is **no published enumeration of legal `entities` values**; derive them from the
top-level properties of `GET /v3/schemas/loan` at runtime and pin in config (open question). V1 has
an explicit helper (`GET /v1/loans/supportedEntities`).

fieldReader returns flat `{fieldId, value}` string pairs, accepts standard/custom/virtual IDs, and
explicitly does **not** support canonical pipeline names (passing them currently "works" as a known
issue — do not rely on it). Its write twin, `POST .../fieldWriter`, shares the verb and base path:
**method-level filtering is insufficient; the allowlist must match the exact `/fieldReader` path.**

### 4.2 Schema / data dictionary toolchain

| API | Endpoint | Purpose |
|---|---|---|
| V3 Loan Schema | `GET /v3/schemas/loan` | JSON Schema; top-level properties double as the `entities` vocabulary |
| V3 Standard Fields | `GET /v3/schemas/loan/standardFields?ids=…` | Field ID → metadata incl. `jsonPath` (the ID↔JSON-path translation table) |
| V3 Virtual Fields | `GET /v3/schemas/loan/virtualFields` | The only systematic discovery of `Log.MS.*`, `LOCKRATE.*`, `PCC.*`, … |
| Custom Field Settings | `GET /v3/settings/loan/customFields` | All `CX.*` / `CUSTnnFV` definitions on the instance |
| V1 pathGenerator | `POST /v1/schema/loan/pathGenerator` | Field IDs → JSON paths (feeds webhook filter attributes); compute-only |
| V1 contractGenerator | `POST /v1/schema/loan/contractGenerator` | Field ID/value pairs → loan-JSON fragment; compute-only |

**Recommendation:** snapshot `standardFields`, `virtualFields`, `customFields`, and the loan schema
into Postgres at integration startup and on each Encompass release. That snapshot is the dictionary
between what ops staff quote ("field 1109") and what the API returns.

### 4.3 Key field IDs (verified in collection samples and public docs, except where marked docs-sourced)

| Field ID | Meaning |
|---|---|
| `4000` / `4001` / `4002` | Borrower first / middle / last name (`4000#2` = borrower pair 2) |
| `1109` | Loan amount |
| `364` | Loan number (canonical twin: `Loan.LoanNumber`) |
| `353` | LTV |
| `3142` | Application date |
| `2025` | File-started / creation date |
| `1996` / `1997` / `1999` / `1994` | Funds ordered / sent / released / funding close date |
| `CUST01FV`–`CUST99FV`, `CX.*` | Custom fields — YS concepts (ARV, rehab budget, DSCR, experience) very likely live here; enumerate on day 1 |
| `Log.MS.CurrentMilestone` / `.LastCompleted` / `.Stage`, `CoreMilestone` | Milestone roll-ups |
| `LOCKRATE.*` (17 fields incl. `RATESTATUS`, `CURRENTSTATUS`, `REQUESTPENDING`) | Rate-lock posture |
| `UWC.*` (20 fields), `PRECON.*` (18 fields) | Underwriting / preliminary condition counts by state and prior-to bucket |
| `PCC.ALL` / `PCC.NOTCLEARED` | Post-closing/preliminary-closing condition text blobs (exact rendering unverified — open question) |
| `EDISCLOSEDTRK.DisclosureCount` | Disclosure count |
| `ENHANCEDCOND.X1` | Whether the loan uses Enhanced (V3) or Standard (V1) conditions — the branch switch for the condition sync. **Docs-sourced only — not present in the collection samples**; verify in sandbox |

One fieldReader POST with the virtual roll-ups returns milestone + lock + condition counts in a
single flat payload — the cheapest per-loan status snapshot primitive.

**Uncertainty carried forward:** the `#N` borrower-pair suffix appears in official V3 samples, but
an older community client claims per-pair reads aren't possible via fieldReader — verify in sandbox.

---

## 5. Pipeline queries and loan discovery

`POST /encompass/v3/loanPipeline` is the discovery workhorse — **a pure read despite the POST
verb** (the query is too rich for a query string). Body supports `fields` (columns), `filter`
(nestable `{operator: and/or, terms:[]}` with leaf terms
`{canonicalName, value, matchType, precision, include}`), multi-key `sortOrder`, `loanIds`,
`loanFolders`, `includeArchivedLoans` (**essential** — the funded back-book lives in Archive
folders), `orgType`, and `loanOwnership:"AllLoans"`. matchTypes: exact, equals, notEquals,
greaterThan(OrEquals), lessThan(OrEquals), contains, startsWith, isEmpty, isNotEmpty, MultiValue;
`precision` applies to dates only.

**Pagination:** offset (`start`/`limit`, max 1000 loans/page, server may shrink the limit to fit
the 6 MB response cap) or snapshot cursors (ID in the `X-Cursor` header, totals in
`X-Total-Count`; cursors expire after 5 minutes of inactivity, 1 hour max, 10 per instance).
`POST /v3/loanPipeline/report` is the report-cursor variant.

**Freshness caveat (load-bearing):** the pipeline reads the **Reporting Database**, which lags loan
saves and only exposes `Fields.*` the admin has provisioned into it. Pipeline is for *discovery*;
the local snapshots that gating decisions read (§7.4) must be refreshed from the live loan via
Get Loan / fieldReader — never populated from pipeline rows. (The gate itself reads only the local
snapshot, never the network — Decision D1; see §7.4.)

Supporting reads: `GET /v3/loanFolders` (folder census — classify Regular/Archive/Trash, detect new
folders), `GET /v3/loanPipeline/canonicalFields` (which names are queryable), and
`GET /v1/loans/{id}/metadata` (cheap freshness probe; exact response schema unverified).

`POST /v3/loans/{id}/auditTrail` is a **read-only** pull of who/when/what per field ID
(`includeHistoricalData=true` for full history) — the verification weapon for "who set this field,
when." **Prerequisite:** audit trail is captured only for fields the admin flagged in the Reporting
Database tool — an open admin question before any portal rule depends on it.

**Writes in this neighborhood that must be forbidden:** `POST /v1/loanBatch/updateRequests` is an
admin-only **mass field update** that accepts the *same filter contract* as the pipeline query and
bypasses business rules, triggers, and calculations — a copy/paste error between a pipeline body
and a batch body could silently overwrite the book. `POST/DELETE .../resourceLocks` creates or
releases editing locks (an orphaned exclusive lock from a crashed worker would freeze loan files
for staff); GET on resourceLocks is a legitimate read ("who has this loan open").

**Rate limits:** Encompass enforces a **concurrency** limit — default 30 concurrent calls per
lender environment, shared across ALL integrations the company runs. Every response carries
`X-Concurrency-Limit-Limit` / `-Remaining`; exceeding it returns 429. Design: a single process-wide
semaphore of ~4–6, header-driven adaptation, exponential backoff with jitter on 429, and on a
6 MB/400 payload error halve the page size rather than retry. **Estimated steady state — the
canonical call-volume assumptions live here (Decision D11):** roughly **500–1,750 calls/day**
depending on book size and poll cadence — the low end assumes C3's minimal-poll cadence (watermark
poll every 5–15 min + nightly reconciliation), the high end F2's denser cadence (tighter polls +
per-event verification). Comfortable headroom either way; the Master cites this section.

---

## 6. Webhooks and event architecture

**Phase-1 posture (Decision D2, 2026-07-19): poll-only — no webhook subscriptions are created in
Phase 1.** That keeps Phase 1 at **zero** Encompass writes of any kind, including platform-config
writes: no public endpoint, no signing-key management, the simplest possible freeze story.
Everything below is the design for the Phase-1.5/2 accelerator, adopted only on an explicit owner
decision; when adopted, subscription CRUD becomes the one sanctioned config-write category
(admin-credential, out-of-band — §10.2) and polling remains the source of truth.

### 6.1 Subscriptions

All under `/webhook/v1/*`. A subscription body carries `endpoint` (public HTTPS, CA-signed cert,
TLS 1.2+ — Render's managed TLS qualifies), `resource`, `events`, optional `signingkey`
(auto-assigned if omitted; recoverable via Get Subscription), `filters.attributes` (JSON pointers
with wildcards, e.g. `/applications/*/borrower/lastName` or `/milestoneLogs/*/doneIndicator`;
supported only for Loan `change`/`fieldchange`; max 50 per subscription; **invalid attributes are
silently ignored** — test with real loans), and `enableSubscription`. Limits: ≤25 subscriptions per
lender; resource+event+endpoint must be unique.

### 6.2 Payloads and signature verification

Standard notifications carry **no loan data and no PII** — only `eventId`, `eventTime`,
`eventType`, and `meta.resourceRef` (`/encompass/v3/loans/{id}`) to dereference with an
authenticated read. Verify every delivery: `Elli-Signature` (some pages spell it
`X-Elli-Signature`; accept both) = base64(HMAC-SHA256(raw request body, UTF-8 signing key));
`Elli-SubscriptionId` selects the key. The repo already implements this exact raw-body + HMAC +
constant-time-compare pattern for ClickUp and Resend (`src/routes/clickup-webhook.js`,
`src/lib/resend-webhook.js`); replay defense is `eventId` dedupe (Encompass sends no timestamp
header).

### 6.3 Delivery is not guaranteed — reconciliation is mandatory

Failed = 5XX, invalid response, connection error, or no ack within **30 seconds**; after **four
total attempts** the notification is **discarded**. ICE's own guidance: implement reconciliation
against `GET /webhook/v1/events` (Event History; statuses EventReceived, SubscriptionMatch,
NotificationDelivered, DeliveryAttempted, NotificationFailed, DeliveryFailedExhaustedRetries; 100
records / 6 MB per page). Retention window is undocumented (open question) — reconcile at least
hourly. **Critical caveat:** many Loan events (`create`, `milestone`, `condition`, `fieldchange`)
fire for **API-originated actions only** — staff working in the Encompass desktop (Smart Client)
will not emit them. `change` (with filters), `update`, `move`, `delete` are the reliable
Smart-Client-visible signals. This is the decisive reason **polling stays the source of truth and
webhooks are only an accelerator.** One more silent failure mode (Decision D15): **ICE
auto-disables/deletes subscriptions that persistently fail delivery — an integration can silently
go deaf.** Once webhooks exist (Phase 1.5+, per Decision D2), a daily subscription-drift read
check (list subscriptions via H2, compare to the expected set) is mandatory.

### 6.4 Enhanced Field Change (EFC) — defer to Phase 2

EFC (`enhancedfieldchange`, 24.2+) delivers previous+new values in both classic and V3 forms,
chunked via `multipartIndicator`/`chunkId`, with **no field filters** (all changes emitted). It
requires an ICE support ticket naming the instance ID, R2T (test-instance) validation first — and
it reintroduces **PII into webhook payloads**, forcing redaction/encryption at the inbox. The
baseline `change` + re-GET pattern is simpler and PII-free at the webhook layer. Webhook custom
auth (`/webhook/v1/functions/auth*`) is a premium extra; the signing key is the baseline and is
sufficient for Phase 1.

### 6.5 Recommended shape

Receiver (verify → dedupe by eventId → insert into an inbox table → ack 200 in <1 s, mounted before
the JSON parser exactly like `src/server.js:26-28`) → interval drainer that dereferences
`meta.resourceRef` with the read-only client → hourly Event History reconciliation → scheduled
pipeline poll as the correctness backstop. Subscription CRUD is the only write in the webhook
domain and is **admin-gated** (§10.2) — it configures delivery plumbing, never loan data. None of
this shape exists in Phase 1: Phase 1 runs the scheduled pipeline poll alone (Decision D2).

---

## 7. Conditions, eFolder, disclosures, AUS

### 7.1 Two mutually exclusive condition systems

| | V1 "Standard" | V3 "Enhanced" |
|---|---|---|
| API | `/v1/loans/{id}/conditions/underwriting\|preliminary\|postclosing` | `/v3/loans/{id}/conditions` (+ `/comments`, `/tracking`, `/documents`) |
| Statuses | Fixed enum: Added, Expected, Requested, Received, Rerequested, Fulfilled, Reviewed, Sent, Cleared, Waived, Expired, Rejected | **Tenant-configurable** types/statuses/priorTo; read-only derived `status`, `statusDate`, `statusOpen` |
| Switch | — | Loan field `ENHANCEDCOND.X1` / `useEnhancedConditionIndicator` per loan |

The condition sync must read the switch first and branch; building only one path silently misses
the other kind of loan. Which mode BE11397907 runs is an **open question** (likely standard for a
hard-money shop unless Enhanced was enabled). Because Enhanced vocabularies are tenant-defined, the
portal can never hard-code "Cleared" — terminal statuses come from a config table seeded from the
instance's definitions (`/v3/settings/loan/conditions/types|templates`).

Condition objects carry title, description, `priorTo` (Approval/Docs/Funding/Closing/Purchase —
mapping 1:1 onto the portal's existing severity/category vocabulary in `db/037`), category,
status+statusDate, the requested/received/fulfilled flag-date-by triplets, `isRemoved` (everything
in the eFolder is **soft-deleted** — never treat disappearance as deletion), comments, and entity
references to eFolder documents. That yields a fully readable evidence chain:
**condition → document(s) → attachment(s) → bytes**, every hop a read.

### 7.2 eFolder reads

- **Documents:** `GET /v3/loans/{id}/documents?view=Summary|Detail|Full` (+ V1 equivalents) with
  lifecycle flags (`isReceived`, `isReviewed`, `isReadyForUw`, …).
- **Attachments metadata:** plain GETs (V3 handles both legacy and cloud storage; V1 may miss
  cloud-stored files).
- **Bytes:** read-semantics POSTs — `POST /v3/loans/{id}/attachmentDownloadUrl` returns a
  time-limited URL + auth header; V1 per-attachment `/url`, page and thumbnail URL generators; and
  the async batch `POST /efolder/v1/loans/{loanId}/exportJobsCreator` (max 10 per call) polled via
  `GET /efolder/v1/exportjobs/{jobId}`. The collection variant of that export request carries a
  `skipPersonaChecks` query parameter — the allowlist's query validation must explicitly
  **deny/never send it** (persona checks stay on). None mutate the loan. Do **not** confuse
  `attachmentDownloadUrl` with `attachmentUrl`/`attachmentUploadUrl` — those are upload paths and
  stay denied.
- **History:** `GET /v3/loans/{id}/histories/efolder` (24.2+; a UTC timestamp bug was fixed in
  25.2 — treat older timestamps with suspicion).

### 7.3 Disclosure tracking and AUS

`GET /v3/loans/{id}/disclosureTracking2015Logs` (+ per-log snapshot) exposes the compliance ledger:
LE/CD contents, disclosureType, delivery method and dates, per-borrower eConsent, intent to
proceed, changed circumstances, disclosed APR/finance charge, and a point-in-time loan snapshot.
For YS Cap's business-purpose loans TRID generally does not apply — treat disclosure logs as
optional evidence, present only if the instance actually discloses (open question).
`GET /v1/loans/{id}/ausTrackingLogs` mirrors the latest Underwriting Decision History row
(`uwRiskAssessType`, `recommendation`, `duCaseIdOrLpAusKey`) — usually absent in hard money;
optional.

### 7.4 The clear-gate contract (per Decision D1, 2026-07-19)

The gate evaluator performs **no network I/O in the request path** — by construction it holds no
HTTP client and reads only the loan's **local Encompass snapshot**. Freshness is enforced instead
of fetched: the clear-to-close gate requires the snapshot to be no older than the **CTC freshness
ceiling (15 minutes recommended, configurable)**; if it is older, the gate **fails closed** with a
"refreshing Encompass data — retry shortly" outcome and enqueues an immediate high-priority
refresh for the background sync worker. A live blocking fetch at decision time is explicitly
rejected for Phase 1 (it would put Encompass availability in the request path); revisiting that is
a Phase-2 open question. Lower-severity gates (soft warnings) tolerate the standard snapshot age
(poll cadence).

Against that snapshot, a portal condition may flip to cleared **only** if the linked Encompass
condition shows: it exists, `isRemoved=false`, status is terminal (V1: `Cleared`/`Waived`; V3:
`statusOpen=false` plus a configured terminal status with its `tracking[]` who/when entry), and
timestamps are sane — with the raw JSON persisted as an evidence bundle (canonical storage:
`encompass_snapshots` / `encompass_gate_log` — DATA-MAPPING §2.1, Decision D4). Portal CTC
additionally requires every at-or-before-closing condition terminal and the mapped CTC milestone
finished (§8); the snapshot itself is always sourced from live loan reads (Get Loan / fieldReader),
never from Reporting-DB pipeline rows (§5). `PCC.NOTCLEARED === ""` and the `UWC.*` counts serve
as cheap corroboration only, never as the primary key.

---

## 8. Milestones, rate locks, lifecycle signals

### 8.1 Milestones

Encompass ships 13 default milestones, but **every instance renames/adds/archives its own** — the
actual list for BE11397907 must be discovered via
`GET /v3/settings/milestones?includeArchived=True&view=Detail` and mapped by an admin, never
assumed. Per-loan: `GET /v3/loans/{id}/milestones` (entries carry `name`, `startDate`,
`doneIndicator` — the single most important lifecycle bit — `reviewedIndicator`, `loanAssociate`,
and a `milestoneSetting` reference joining back to settings), plus `milestoneFreeRoles` and V1
`associates` (the Encompass-side team roster).

Encompass also normalizes any custom list into **7 core buckets** (Started, Sent to processing,
Submitted, Approved, Doc signed, Funded, Completed) with per-bucket dates (`milestoneApprovedDate`,
`milestoneFundedDate`, …) — store both the raw names and the core dates; the core dates survive
milestone renames. **"Clear to Close" is not a core bucket**, which is exactly why CTC detection
must be config-driven (an admin mapping table with fail-closed drift handling, modeled on the
ClickUp status map in `src/clickup/status.js`). Milestones can be **unfinished** (rolled back) —
every sync must be a full snapshot replace with history appended, never append-only.

### 8.2 Rate locks

Read model is V1: `GET /v1/loans/{id}/ratelockrequests` (history), `.../{lockId}?view=detailed`,
`.../{lockId}/snapshot`. Lifecycle: requested → confirmed (by the Secondary Registration persona)
or denied; then extend / re-lock / cancel / void. Loan-level rollup `rateLock.rateStatus` ∈
notLocked / locked / expired / cancelled, plus pending flags; the `LOCKRATE.*` fieldReader family
returns the whole posture in one call. **Trust `lockExpirationDate` — never recompute it from
lockDate + days** (extensions and re-locks change it). Whether YS Cap's workflow uses locks at all
is an open question — if not, feature-flag the panel off. Do not confuse rate locks with *resource
locks* (editing-concurrency locks, §5).

### 8.3 Funding, registration, alerts

Funding lifecycle dates live on the loan's `funding` object (fields 1996/1997/1999/1994);
`fundingFees`/`fundingBalances` are accounting worksheets, not lifecycle. `registrationlogs`
records investor registration + expiration — useful to staff, but **capital-partner names must
never reach borrower-facing surfaces** (standing repo rule). Alert webhooks are gated to compliance
alert types and need an ICE ticket — derive lock-expiry and milestone-stall alerts locally from
pulled data instead, via the portal's existing notifications engine.

---

## 9. The full endpoint classification (all 800 requests)

C7 classified every request in the 26.2 Postman collection. Full per-request tables live in
`scratchpad/research/findings/C7.md`; machine-readable copy in
`scratchpad/research/c7-classified.json`.

### 9.1 Classification legend

| Class | Meaning | Phase-1 policy |
|---|---|---|
| **READ** | GET, no state change | Allowlist candidates |
| **READ_VIA_POST** | POST verb but read/compute semantics (fieldReader, pipeline queries, auditTrail, download-URL generators, calculators, introspection) | Allowlist candidates, by exact path |
| **WRITE_LOAN** | Creates/updates/deletes loan or business data | **Forbidden — deny always** |
| **WRITE_CONFIG** | Platform configuration (webhooks, settings, users/SCIM) | Deny by default; tiny admin-gated subset (§10.2) |
| **AMBIGUOUS** | Cannot be proven read-only from available evidence | Deny (none are needed) |
| **AUTH** | OAuth2 token grants | Required plumbing |

### 9.2 Headline counts

| Class | Count | % |
|---|---:|---:|
| READ | 329 | 41.1% |
| READ_VIA_POST | 49 | 6.1% |
| WRITE_LOAN | 318 | 39.8% |
| WRITE_CONFIG | 92 | 11.5% |
| AMBIGUOUS | 8 | 1.0% |
| AUTH | 4 | 0.5% |
| **Total** | **800** | 100% |

Only ~47% of the surface (READ + READ_VIA_POST + AUTH = 382 requests) is even
candidate-permittable — and the proposed allowlist below is far narrower than that. Everything else
must be **deny-by-default at the HTTP-client layer** (a method+path gate), not merely "unused" —
the collection is 26.2-era and the live API may expose endpoints not in it, so deny-known-writes
would not be safe.

### 9.3 Per-folder summary

| Top-level folder | Total | READ | READ_VIA_POST | WRITE_LOAN | WRITE_CONFIG | AMBIGUOUS | AUTH |
|---|---:|---:|---:|---:|---:|---:|---:|
| Authentication | 7 | 0 | 2 | 1 | 0 | 0 | 4 |
| Calculators | 7 | 0 | 7 | 0 | 0 | 0 | 0 |
| Consumer Engagement | 41 | 15 | 1 | 13 | 12 | 0 | 0 |
| Encompass Contacts | 36 | 13 | 4 | 19 | 0 | 0 | 0 |
| Document Delivery | 8 | 2 | 0 | 6 | 0 | 0 | 0 |
| Encompass Docs | 52 | 23 | 0 | 21 | 3 | 5 | 0 |
| Encompass Loan | 332 | 102 | 24 | 206 | 0 | 0 | 0 |
| Secondary and Trades | 35 | 11 | 3 | 21 | 0 | 0 | 0 |
| Services | 51 | 38 | 5 | 5 | 2 | 1 | 0 |
| Settings and Utilities | 171 | 104 | 3 | 15 | 48 | 1 | 0 |
| Webhook Custom Auth - Premium | 9 | 2 | 0 | 0 | 6 | 1 | 0 |
| Webhook | 19 | 5 | 0 | 0 | 14 | 0 | 0 |
| Workflow Management | 32 | 14 | 0 | 11 | 7 | 0 | 0 |
| **Total** | **800** | **329** | **49** | **318** | **92** | **8** | **4** |

### 9.4 Hazards found during classification

- **Two GETs carry `action=Add`** copied from PATCH siblings
  (`GET .../urlaAlternateNames?action=Add`). Almost certainly ignored on GET, but the client must
  **strip/deny any `action` query parameter** on allowlisted routes — in this API `action=` is the
  mutation switch.
- **`GET /v3/loans/{id}/recipients`** may mint/rotate disclosure-access auth codes on read and
  returns borrower access secrets — excluded until ICE confirms it is side-effect-free.
- Several disclosure-flow reads poll **opaque Location-header URLs**; an allowlist must validate
  the resolved host+path prefix, not just trust the variable.
- The 8 AMBIGUOUS requests (plan-code evaluator with an `"import":"all"` body, documentAudits job
  creators, EPPS `rateSelector` staging lock state, the automatedConditions calculator that may
  apply conditions, the webhook custom-auth test trigger) are all unnecessary for Phase 1 —
  ambiguity costs nothing; deny all 8.

---

## 10. Proposed Phase-1 allowlist

Design rule: the Encompass client enforces **default-deny** — an explicit `(method, path-pattern)`
table is the only thing that can pass; everything else throws before an HTTP request is built
(single choke point, unit-tested, same philosophy as the ClickUp guards). Query strings validated
separately (notably: strip/deny `action=` on every allowlisted route).

### 10.1 Runtime allowlist (portal service account — read-only)

**A. Auth**
| # | Method | Path | Purpose |
|---|---|---|---|
| A1 | POST | `/oauth2/v1/token` | Token grant |
| A2 | POST | `/oauth2/v1/token/introspection` | Token introspection / instance-binding assertion |

**B. Loan reads**
| # | Method | Path | Purpose |
|---|---|---|---|
| B1 | GET | `/encompass/v3/loans/{loanId}` | Full/partial loan entity (`?view=`, `?entities=`) |
| B2 | GET | `/encompass/v1/loans/{loanId}` | V1 loan entity (legacy field coverage) |
| B3 | POST | `/encompass/v3/loans/{loanId}/fieldReader` | Bulk field values by field ID |
| B4 | POST | `/encompass/v1/loans/{loanId}/fieldReader` | V1 field reader |
| B5 | POST | `/encompass/v3/loans/{loanId}/auditTrail` | Field-change history query (verified pure read) |
| B6 | GET | `/encompass/v1/loans/{loanId}/metadata` + GET-only loan subresources (`applications`, `fundingFees`, `fundingBalances`, `fieldLockData`, `associates`, `milestoneFreeRoles`, `registrationLogs`, `ausTrackingLogs`, `ratelockRequests{,/{id},/{id}/snapshot}`) | Loan subresource reads |

_Note: `GET .../conversationLogs` is classified READ but deliberately **not** allowlisted —
excluded by data governance (Guardrails §5.1 Tier 4: free-text conversation logs)._

**C. Pipeline / discovery**
| # | Method | Path | Purpose |
|---|---|---|---|
| C1 | POST | `/encompass/v3/loanPipeline` | Pipeline query |
| C2 | POST | `/encompass/v3/loanPipeline/report` | Report cursor |
| C3 | POST | `/encompass/v1/loanPipeline` | V1 pipeline query/cursor |
| C4 | GET | `/encompass/v1/loanPipeline/fieldDefinitions` + `/encompass/v3/loanPipeline/canonicalFields` | Canonical field definitions |
| C5 | GET | `/encompass/v3/loanFolders{,/{name}}` | Folder enumeration |

**D. Schema / dictionary**
| # | Method | Path | Purpose |
|---|---|---|---|
| D1 | GET | `/encompass/v3/schemas/loan{,/standardFields,/virtualFields}` | V3 loan schema |
| D2 | GET | `/encompass/v1/schema/loan{,/{entity}}` | V1 loan schema |
| D3 | POST | `/encompass/v1/schema/loan/pathGenerator` | Field ID → JSON path |
| D4 | POST | `/encompass/v1/schema/loan/contractGenerator` | Field IDs → JSON contract |
| D5 | GET | `/encompass/v3/settings/loan/customFields`, `/encompass/v1/settings/loan/customFields{,/{fieldId}}` | Custom field definitions |

**E. Conditions**
| # | Method | Path | Purpose |
|---|---|---|---|
| E1 | GET | `/encompass/v3/loans/{loanId}/conditions{,/{conditionId}}` (+ `/comments`, `/documents`, `/tracking` GETs) | Enhanced conditions |
| E2 | GET | `/encompass/v1/loans/{loanId}/conditions/underwriting{,/{id}}`, `.../preliminary{,/{id}}`, `.../postclosing{,/{id}}` | Standard conditions |
| E3 | GET | `/encompass/v3/settings/loan/conditions/types{,/{id}}`, `.../templates{,/{id}}`, `.../sets{,/{id}}` | Condition vocabularies |

**F. Milestones**
| # | Method | Path | Purpose |
|---|---|---|---|
| F1 | GET | `/encompass/v3/loans/{loanId}/milestones{,/{id}}` | V3 milestones |
| F2 | GET | `/encompass/v1/loans/{loanId}/milestones{,/{id}}` | V1 milestones |
| F3 | GET | `/encompass/v1/loans/{loanId}/associates{,/{id}}` | Loan associates |
| F4 | GET | `/encompass/v3/settings/milestones{,/{id}}` | Milestone definitions |

**G. eFolder metadata (+ optional content reads)**
| # | Method | Path | Purpose |
|---|---|---|---|
| G1 | GET | `/encompass/v3/loans/{loanId}/documents{,/{docId}}` (+ `/comments`, `/attachments` GETs) | Document metadata |
| G2 | GET | `/encompass/v1/loans/{loanId}/documents{,/{docId}}` | V1 document metadata |
| G3 | GET | `/encompass/v3/loans/{loanId}/attachments{,/{attachmentId}}` | Attachment metadata |
| G4 | GET | `/encompass/v3/loans/{loanId}/histories/efolder` | eFolder history |
| G5 (optional) | POST | `/encompass/v3/loans/{loanId}/attachmentDownloadUrl` | Time-limited **download** URL (never `attachmentUploadUrl`/`attachmentUrl` — uploads, deny) |
| G6 (optional) | POST | `/encompass/v1/loans/{loanId}/attachments/{attachmentId}/url` (+ `/pages/{pageId}/url`, `/pages/{pageId}/thumbnail/url`) | V1 download/page/thumbnail URLs |
| G7 (optional) | POST + GET | `/efolder/v1/loans/{loanId}/exportJobsCreator` + `/efolder/v1/exportjobs/{jobId}` | Async batch export (creates a job resource; mutates no loan data). Query validation must explicitly deny/never send `skipPersonaChecks` (§7.2) |

**H. Webhook read side**
| # | Method | Path | Purpose |
|---|---|---|---|
| H1 | GET | `/webhook/v1/resources{,/{resource}/events}` | Available resources/events |
| H2 | GET | `/webhook/v1/subscriptions{,/{id}}` | Subscription drift detection |
| H3 | GET | `/webhook/v1/events{,/{eventId}}` | Event history / reconciliation |

**Optional additions if Phase-1 scope needs them (all reads):** disclosure tracking logs
(`/v3/loans/{loanId}/disclosureTracking2015Logs{,/{id},/{id}/snapshot,/snapshots}`), company user
reads for LO enrichment, trade-pipeline canonical fields.

### 10.2 Admin-only WRITE_CONFIG subset (separate credential; portal runtime never holds it)

This is the **future** sanctioned config-write category, owner-gated per Decision D2: Phase 1 is
poll-only and creates no subscriptions, so none of these are exercised in Phase 1. The table is the
contract for the day the owner adopts webhooks (Phase 1.5/2).

| Method | Path | Operation | Control |
|---|---|---|---|
| POST | `/webhook/v1/subscriptions` | Create subscription | Run from an admin CLI/runbook with a distinct credential; config-as-code with a reconcile job that never touches subscriptions it didn't create; every mutation audited |
| PUT | `/webhook/v1/subscriptions/{id}` | Update subscription | Same |
| DELETE | `/webhook/v1/subscriptions/{id}` | Remove subscription | Same |
| (deferred) | `/webhook/v1/functions/auth*` | Custom-auth functions (premium) | Leave denied unless custom auth is adopted; the `/test` endpoint triggers outbound calls from Encompass — keep denied |

### 10.3 Explicit deny tripwires (log + alert, not just refuse)

The highest-risk look-alikes of allowlisted routes; the client should recognize and hard-alarm on
them: `POST/PATCH/DELETE /encompass/v{1,3}/loans...` (loan create/update/delete), `POST
.../fieldWriter`, `POST .../importer`, `POST /encompass/v1/loanBatch/updateRequests`, `POST/PUT
.../attachmentUploadUrl` / `.../attachmentUrl` / `.../attachments/url` (upload generators), `POST
/encompassdocs/v1/documentOrders/**` and `.../delivery` (sends disclosures), `POST
.../RatelockRequests`, `POST/DELETE /encompass/v{1,3}/resourceLocks`, any `action=` query mutation
(`add|update|delete|clear|confirm|extend|relock|move|unfinish`), `PATCH
/encompass/v1/loanfolders/{folder}/loans` (moves loans), `/consumers/v1/invitations|reminders`
(emails borrowers), partner-service transaction orders, all of `/scim2/`, `/encompass/v3/users`,
`/encompass/v3/settings/**` writes, and `customObjects` writes.

---

## 11. Recommendations (summary)

_This section is a condensed view of the six-layer doctrine (Guardrails §2) — six independent
write-prevention layers, numbered 0–5 (Decision D10); the two detailed in this doc are layers of
that stack, not the whole of it._

1. **Two of the six guardrail layers live here:** the View Only persona server-side (§2.4) + the
   default-deny method+path allowlist client-side (§10). Either alone would suffice; run both —
   full doctrine in Guardrails §2.
2. **Build on V3**; keep V1 routes on the allowlist only where V3 has no equivalent (§3).
3. **Discovery = pipeline; gating = local snapshots sourced from live loan reads.** Never make a
   clear/CTC decision off the Reporting-DB-backed pipeline (§5); the gate itself reads only the
   local snapshot under the 15-minute CTC freshness ceiling and fails closed when stale (§7.4,
   Decision D1).
4. **Polling decides; webhooks — when adopted (Phase 1.5+, Decision D2) — only accelerate.**
   Phase 1 is poll-only with the scheduled pipeline sweep; the inbox + drainer + hourly Event
   History reconciliation shape (plus the daily subscription-drift check, Decision D15) waits for
   the owner's webhook decision; EFC and custom auth deferred further still (§6).
5. **Snapshot-replace sync semantics everywhere** — milestones unfinish, locks void, eFolder
   soft-deletes (§7–§8).
6. **Config-driven vocabularies:** milestone map, condition terminal statuses, entities list — all
   discovered from the instance, admin-confirmed, fail-closed on drift.
7. **Day-1 instance census:** loan folders, canonical fields, custom-field definitions, milestone
   settings, condition vocabularies, virtual-field list — persisted to Postgres before any sync
   logic is written.

---

## 12. Open questions

_Canonical tracker: Master §10 (OQ-xx IDs); this local list is subsumed (Decision D8)._

Consolidated from all seven passes; each blocks or shapes a design decision.

**Auth / provisioning (C1)**
1. Does the token response include `expires_in`? (Sample omits it — verify in sandbox.)
2. Which lifetime regime applies — 30 min/24 h (EDC docs) or 15 min/2 h (platform overview)?
3. Does Regenerate Secret invalidate outstanding tokens or only future grants? Can a lender hold
   two API keys for one instance (zero-downtime rotation)?
4. Sandbox availability: does YS Cap's contract include a test instance (separate `BE…` ID)?
5. Which stock persona is closest to read-everything-write-nothing, and does "Persona Access to
   Loans = View Only" block all V3 write verbs at the API layer? (Verify with a rejected sandbox write.)
6. Does issuing a new password-grant token invalidate prior tokens for the same user?

**Loan data (C2)**
7. Authoritative `entities` list — derive from `GET /v3/schemas/loan` and pin; not published.
8. `#N` borrower-pair suffix support in V3 fieldReader — samples show it, older client docs deny it.
9. Which `CX.*` fields the instance defines for ARV / rehab / experience / DSCR.

**Discovery (C3)**
10. Which fields have audit trail enabled in the Reporting Database (blocks "who cleared it" checks)?
11. Are the `CX.*` fields provisioned into the Reporting Database (required for pipeline filtering)?
12. Actual book size and daily change velocity; current concurrency headroom from other integrations.
13. Exact response schemas of `/v1/loans/{id}/metadata` and the pipeline row object (capture in sandbox).

**Webhooks (C4)**
14. Event History retention window (undocumented — bounds the safe reconciliation gap).
15. Does webhook subscription CRUD work under a read-only loan persona?
16. Live event list for this instance (`GET /webhook/v1/resources{,/loan/events}`); `Elli-Signature`
    vs `X-Elli-Signature` spelling; any published ICE egress IPs.

**Conditions / eFolder (C5)**
17. Standard or Enhanced conditions on BE11397907 (`useEnhancedConditionIndicator`)? If Enhanced,
    export the tracking-status and priorTo vocabularies.
18. Exact rendering of `PCC.ALL` / `PCC.NOTCLEARED` values.
19. Are disclosures ever run through Encompass for YS Cap's business-purpose loans?
20. Can the read-only persona see all documents/conditions it must verify (eFolder honors persona checks)?

**Lifecycle (C6)**
21. The instance's actual milestone list — is there an explicit "Clear to Close" milestone, or is
    CTC a custom field/alert?
22. Does the workflow use rate locks at all? Retail vs TPO channel? Milestone-free roles for
    funder/servicer?

**Classification (C7)**
23. `GET /v3/loans/{id}/recipients` — does reading mint disclosure auth codes? (Deny until answered.)
24. `documentAudits` / plan-code `evaluator` / EPPS `rateSelector` / `automatedConditions`
    calculator — confirm read-vs-write (all denied for now; none needed).
25. The collection is 26.2-era — the live API may differ; deny-by-default is the only safe posture.

---

## 13. Where the detail lives

Full findings with per-claim source URLs: `scratchpad/research/findings/C1.md` (auth), `C2.md`
(loan reads/schema), `C3.md` (pipeline/discovery), `C4.md` (webhooks), `C5.md`
(conditions/eFolder/disclosures), `C6.md` (milestones/locks/lifecycle), `C7.md` (all 800 requests
classified, per-request tables) + `c7-classified.json` (machine-readable). Repo patterns referenced
throughout: `src/lib/sharepoint.js` (token cache / 401 self-heal / backoff), `src/clickup/client.js`
(write-guard choke point), `src/routes/clickup-webhook.js` + `src/lib/resend-webhook.js` (raw-body
HMAC verification), `src/sync/queue.js` (interval worker), `db/108_sync_review_queue.sql` (human
review queue), `src/clickup/status.js` (two-layer status mapping — the template for the Encompass
milestone map).
