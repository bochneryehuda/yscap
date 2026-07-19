# Encompass Read-Only Guardrails — Write Freeze, Guards & Reviews

_Research pass, 2026-07-17. **Status: research only — nothing implemented.** No code was written, no repo file was changed, no call was made to any Encompass endpoint. No secrets and no customer data appear in this document. Sources: research findings A1, A2, A3, A5, A6, F1, F3, F5 (this document consolidates them); repo `/home/user/yscap/yscap-repo-root_8`, inspected read-only._

_Revision note (2026-07-19): post-critique consistency pass applied (decisions D1–D17)._

**This is the document every future session must read before touching any Encompass code.** It states the write freeze (the policy), the enforcement design (how the freeze becomes physically unbreakable), the lessons that make the freeze non-negotiable (the ClickUp incident history), the human-review model for inbound data, the data-governance rules for what we may store, the risk register and monitoring the integration must ship with, and the secret-handling rules — including a rotate-before-use callout.

---

## 0. Read this first — plain language, and one blocker

**What this is about.** The portal (PILOT) is going to *read* loan information from Encompass — the company's loan origination system — so it can check things like "does Encompass agree this condition is cleared?" and "does Encompass show clear-to-close?". The portal will **never write anything into Encompass**. Not a field, not a document, not a status. Reading only.

**Why we are this careful.** The last time we connected the portal to an outside system in a hurry (ClickUp, July 6→7, 2026), the first data corruption happened **32 minutes after go-live**, and 16 incidents followed over 9 days — dates of birth silently shifted by a day, files linked to the wrong people, fields wiped by an unidentified second program sharing our access key. And the stakes are higher this time: the portal will *gate lending decisions* on Encompass data, so a wrong or stale copy is not a data bug — it is a wrong lending decision (F5).

**The core promise.** The portal will be **architecturally incapable** of writing to Encompass — like a mail slot that only lets letters come in. Not "we promise not to write" but "there is no button, no wire, and no door through which a write could happen," enforced in six independent layers (§2, numbered 0–5), each one alone enough to stop a write.

**RESOLVED BLOCKER — credential hygiene (the rotation-before-use callout).** The standing owner rule (CLAUDE.md, adopted 2026-07-12 after an Azure client secret and a Render API key were pasted into a chat during the SharePoint research — see `docs/SHAREPOINT-INTEGRATION-RESEARCH.md` §0) applies with full force here: **any credential that has ever transited a chat, transcript, email, ticket, or commit is compromised and must be rotated before use.** That question is no longer open: **on 2026-07-17 the owner pasted the Encompass Developer Connect Client ID, Client Secret, and Instance ID into the task chat for this research session.** The secret was never written to any file, commit, or document, and no API call was ever made with it — but per the standing rule it is treated as burned. Therefore, before the Encompass integration makes its first API call: (1) **regenerate the client secret** in the Encompass API Key Management page — rotation is mandatory, not conditional; (2) know that ICE's "Regenerate Secret" is the *only* remediation and it **breaks any running application immediately** (F5 FM-10/FM-11), so a rotation is normally a planned mini-outage — here it is cheap, because nothing runs yet; (3) rotated values go only into Render environment variables via `src/config.js` — never into git, docs, or chat. Former Open Question 1 is closed with this answer (§8). _Decision D7 (2026-07-19)._

---

## 1. The write freeze — formal policy statement

> **Policy.** The YS Capital portal is, and must remain, architecturally incapable of writing to Encompass (ICE Mortgage Technology, instance BE11397907). No portal code path — present or future, deliberate or accidental — may create, modify, delete, lock, move, order, send, invite, or otherwise change any state in Encompass. The integration is strictly pull-only. This freeze can only be reopened by the owner's explicit sign-off in their own words, recorded in the binding policy doc (`docs/ENCOMPASS-READ-ONLY-POLICY.md`, to be created), with the full change ceremony of §2.6.

### 1.1 What counts as a write (the broad definition)

"Write" is defined by **effect, not verb**. All of the following are writes and are frozen (classification per the F1 endpoint analysis of the ~800-request Encompass API atlas):

| Category | Examples (all frozen) |
|---|---|
| Field/loan mutation | `PATCH` anything (214 of the collection's 800 requests — PATCH is this API's write verb); `POST .../fieldWriter`; loan create/import (`.../importer`) |
| **Batch operations** | `loanBatch/updateRequests` — one call can rewrite many loans; treated as the most dangerous single endpoint class |
| **Resource locks** | `resourceLocks` create/extend/release — locking a loan changes state *and* can block human users out of their own files; a lock is a write |
| Documents / eFolder | attachment uploads (`attachmentUploadUrl`/`attachmentUrl`), document orders + `/delivery`, export-job mutations beyond sanctioned read-side download-URL generators |
| Pricing / secondary | rate-lock requests (`RatelockRequests`), lock confirm/extend/relock via `?action=` |
| Disclosures / consumers | disclosure sends, `consumers/v1/invitations` and `reminders`, partner `transactions`, `ComplianceReports` |
| Admin / settings | `/scim2/` user management, settings writes, `customObjects` writes, folder moves |
| **Mutation-by-query-parameter** | any request carrying `?action=` (`add/update/delete/clear/confirm/extend/relock/move`) — including on GET, where copied `action=Add` artifacts exist in the vendor collection; `action` is globally denied |
| Side-effectful "reads" | `GET /loans/{id}/recipients` may mint/rotate disclosure auth codes (credential issuance is a side effect — denied); generator-named GETs are denied until proven pure |

Two consequences follow. First, **method-only filtering is unusable in both directions** (F1 §1): of 200 POSTs only ~53 are read/auth (the OAuth token grant, `fieldReader`, `loanPipeline`, `auditTrail`, schema path/contract generators), so "block POST" kills the integration and "allow POST" admits ~147 writes; meanwhile some GETs are unsafe. Enforcement must therefore be an explicit **allowlist of (method + path + query + body)** — deny-by-default (§2.2). Second, because the vendor collection is 26.2-era and the live API will grow, only deny-unknown survives an upgrade; deny-known-writes does not.

### 1.2 The one future exception (and it never runs in the server)

**Phase 1 is poll-only and performs ZERO writes of any kind to Encompass — not even platform-config writes; no webhook subscriptions are created in Phase 1** (Decision D2, 2026-07-19). Webhook adoption is a Phase-1.5/2 accelerator behind an explicit owner decision; polling remains the source of truth regardless. If and when webhooks are adopted, **subscription management** (`POST/PUT/DELETE /webhook/v1/subscriptions*`) becomes the single sanctioned config-write category. Policy for that day (F1 §5): prefer creating subscriptions in the ICE admin UI so the portal writes nothing at all (Open Question 3); if the API is required, it happens **only** via a standalone, dry-run-by-default script (`scripts/encompass-webhook-admin.js` pattern, modeled on `scripts/clickup-date-restore.js`) using a **separate admin credential the server process never loads**. The runtime detects subscription drift by *reading* and alerting — it never "heals" by writing; and because ICE auto-disables/deletes subscriptions that persistently fail delivery, a daily subscription-drift read check is mandatory once webhooks exist. Everything else stays frozen.

---

## 2. Enforcement design — six independent layers, numbered 0–5 (from F1)

The design thesis is the repo's proven doctrine (`src/clickup/client.js:15-21`, `docs/CLICKUP-DATA-SAFETY.md`): **structural incapability** — dangerous operations are not "not called," they *throw at one chokepoint*. The empirical ClickUp finding (A6 §5.2): chokepoint fixes stayed dead forever; call-site fixes recurred within a day. **This section is the source of truth for the layer count: six independent layers, numbered 0–5, with the DB constraint as layer 5** (Decision D10, 2026-07-19); sibling docs carry condensed views. A bug would have to defeat all six layers at once:

| # | Layer | Why a write is stopped | Repo precedent |
|---|---|---|---|
| 0 | **Encompass-side read-only persona** — dedicated API user on BE11397907, stripped of every write right the admin console allows | ICE returns 403 regardless of our code; dedicated identity also buys attribution | shared-token lesson, `docs/CLICKUP-DATA-SAFETY.md` §1 |
| 1 | **Single chokepoint client** (`src/encompass/client.js`) with a deny-by-default allowlist; **zero write functions exist anywhere** | Nothing to call, and the transport refuses anything off-list before the socket | `guardTaskUpdatePayload` allowlist shape (`src/clickup/client.js:84-99`); `sharepoint.remove()` throwing no-op; `enqueue.js` has no delete op |
| 2 | **Kill switches, all default OFF** (`ENCOMPASS_ENABLED`, `ENCOMPASS_DRYRUN`); `ENCOMPASS_OUTBOUND_*` is **permanently absent and grep-banned** | Integration is dark until deliberately lit; there is no write flag to ever flip | `src/config.js:208-232` staged-switch pattern |
| 3 | **CI guard suite** (`scripts/test-encompass-readonly-guard.js`, no DB / no network) | A new call site, write shape, or allowlist edit fails the build | `scripts/test-clickup-delete-guard.js`; drift-check style of `test-sync-file-review.js:179-195` |
| 4 | **Append-only READ journal** (`encompass_pull_log`) recording every outbound call, including guard-blocked ones | Every call is queryable and attributable; a write-shaped row is an alarm | `clickup_write_log`, `db/107` |
| 5 | **DB constraint** making a `sync_queue ('encompass','push')` row unrepresentable; journal-seeded read-budget circuit breaker | A push job cannot exist in storage; a runaway read loop stops hard and survives deploys | `db/schema.sql:302-314`; `db/069` trigger style; orchestrator breaker with the deploy-reset gap fixed |

### 2.1 The chokepoint client

Module layout: `src/encompass/allowlist.js` (frozen data — the allow table + deny tripwires), `client.js` (frozen transport — token handling, `guardReadOnly()`, private `request()`, pacing, retry, journal hook), `reads.js` (typed read helpers — the **only** module the rest of the codebase may import). Three deliberate hardenings beyond the ClickUp client:

1. **`request()` is module-private** — no generic "call any path" export exists, so callers can never construct raw paths.
2. **Zero write functions** — the literal strings `'PUT'`, `'PATCH'`, `'DELETE'` may not appear in `src/encompass/` at all (CI-enforced). ClickUp kept blocked write helpers for symmetry; Encompass keeps nothing.
3. **IDs, never paths, cross the module boundary** — helpers accept a loan GUID, validate its shape, and interpolate into a compiled template; `"{id}/fieldWriter?x="` cannot be smuggled through a parameter.

### 2.2 The allowlist

Each entry is `(method, anchored path regex, query-param allowlist, body validator)`. Rules: paths percent-decoded and normalized *before* matching (double-encoding rejected); unknown query params **denied, not stripped**; `action` globally denied; per-entry body validators stop an allowlisted POST from being repurposed (`fieldReader` bodies must be field-ID lists; an `"import"` key anywhere throws); host pinned to one `BASE` constant — no caller-supplied absolute URLs. Two value-free refusal codes: `ENCOMPASS_NOT_ALLOWLISTED` (default deny) and `ENCOMPASS_WRITE_FORBIDDEN` (a deny-tripwire hit — `fieldWriter`, `loanBatch`, `resourceLocks`, uploads, `?action=` — meaning *portal code attempted a write*: a build-breaking bug, loudly audited, never a retry).

### 2.3 Kill switches and boot posture

`ENCOMPASS_ENABLED=0` default (gated at client, scheduler, and ingest — defense in depth like `CLICKUP_SYNC_ENABLED`); `ENCOMPASS_DRYRUN=1` boot mode authenticates, pulls samples, runs the mapper, logs what *would* land, starts no loops, writes no rows (the `dryRunBackfill` pattern — the go-live validation tool). The boot log states: `"[encompass] READ-ONLY integration — zero write paths exist in this build"`. `/api/health` surfaces configured/enabled status.

### 2.4 The CI guard test

Sections: deny-matrix (every tripwire, every ambiguous endpoint, `fieldReader` allowed **and** `fieldWriter` blocked — the proof pair that method-only filtering never returns); allow-matrix; export-surface audit; grep source scan (API host literal in exactly two files; no `fetch(` outside `client.js`; no write verbs; `ENCOMPASS_OUTBOUND` appears nowhere in `src/`; all imports resolve to `reads.js`); **sha256 hash pin of `allowlist.js`** so any edit is a deliberate two-file change; queue-guard unit test. The repo has no CI today (a known gap — SYNC-GUARD-MATRIX #19/#55); recommendation: this integration is where a minimal CI step is finally added, since the suite is dependency-free and sub-second.

### 2.5 The READ journal

`encompass_pull_log` (canonical name per DATA-MAPPING §2.1 — the earlier `encompass_request_log` working name is retired; Decision D4) (new numbered idempotent migration mirroring `db/107`): route id, method, **path template (never the raw path)**, loan GUID column, sanitized query params, status/duration/bytes, `blocked` + block code, `source` (`poll`/`staff_refresh`/`boot_dryrun`), actor kind/id. Response bodies are never stored. Purpose, stated in the migration header exactly like `db/107`'s: *"if a call is not in this journal, the portal did not make it"* — and the converse: **a query showing zero write-shaped rows is standing compliance evidence that the integration is read-only in practice, not just by design.** The journal also seeds the read-budget breaker on boot, closing the deploy-reset weakness the ClickUp breaker still has.

### 2.6 Frozen files and change ceremony

`allowlist.js` and the guard block of `client.js` are **FROZEN** in the same sense as the pricing engines (CLAUDE.md): any edit requires owner sign-off in their own words, an entry in `docs/ENCOMPASS-READ-ONLY-POLICY.md` (modeled on `docs/SHAREPOINT-POLICY.md`), an updated hash pin in the guard test, evidence the endpoint is a *proven* pure read ("probably read-only" stays denied), and the mandatory two-audit-agent gate. A CLAUDE.md session-rule paragraph mirroring the ClickUp/SharePoint hard rules makes every future agent session inherit the invariant.

---

## 3. What ClickUp and SharePoint taught us (A1/A2/A3/A6 distilled)

### 3.1 The history in three sentences

The ClickUp bidirectional sync was built in ~8 hours overnight with its own designed safeguards waived — the go-live commit read *"The ONLY protection is no deletion"* — and the first corruption hit 32 minutes later. Nine days produced 16 forensic incidents (10 DOBs silently shifted −1 day by a timezone/epoch bug, year-0026 dates from save-per-keystroke, copied loan numbers stealing file identity, a wrong-person merge on a shared family email that leaked file access, an 8-field wipe by an unidentified second automation on a shared token, and damage caused by the repair tool itself), ~45 reactively-added guard layers, 13 deploys in one day, 491 commits. Recovery required a dry-run-default forensic restore script, verify-every-write-by-re-read, a human review queue, and the owner manually pulling ClickUp's own activity history because normalization had erased the API fingerprints.

### 3.2 What actually worked (and is reused wholesale)

- **The chokepoint guards never regressed** — `guardNoTaskDeletion`, `guardNoFieldClearing`, the status-only update allowlist (`src/clickup/client.js`). Every per-call-site fix recurred within a day; every chokepoint fix stayed dead (A6 §5.2). This single finding drives the entire §2 design.
- **The write journal** (`clickup_write_log`, db/107) ended false-alarm forensics: "not in the journal ⇒ the portal didn't do it."
- **COALESCE fill-only inbound writes** (a blank never clears the portal) meant the portal DB was *not* mass-corrupted in the DOB incident — and became the trusted restore source.
- **The durable reconcile watermark** (`sync_runtime_state`, db/125): captured pre-query, advances only on clean passes, 2-minute overlap, 72-hour clamp; its pure helpers `reconcileSince`/`nextWatermark` are unit-tested and reusable verbatim for the Encompass poller (A2 §4).
- **The review queue** (`sync_review_queue`, db/108/110/112) with the "nothing stuck is silent" and "auto-resolve only what is provable" doctrine (§4).
- **Kill switches default-off, dry-run boot, staged rollout**; webhooks treated as lossy triggers with the poll as the source of truth and one idempotent ingest path keyed on the immutable external ID.

### 3.3 What failed — and the SharePoint cautionary tale

Failed writes swallowed as "done" (F-C1); zero 429 handling while boot sweeps hammered the rate limit (F-H1); in-memory watermarks resetting on all 13 daily deploys → portfolio re-ingest storms (F-H4); a review queue accreted to 19 card types with uncapped emails and ~90–95% noise on one type; three foundational blueprint items (dedicated bot identity, rate-limit handling, field policy as data) never built; and the SharePoint mirror **shipped July 13 but ran zero times in production** because env vars were never set — while everyone assumed documents were backed up. "Shipped" must be verified as "running."

### 3.4 The NEVER-AGAIN list (A6 §6, condensed — each item is a demonstrated failure class, restated as a day-one requirement)

| # | Never again | Day-one requirement for Encompass |
|---|---|---|
| NA-1 | Behavioral read-only | Structural at the chokepoint (§2), plus vendor-side persona |
| NA-2 | Shared token, no attribution | Dedicated credentials used by nothing else + read journal from request #1 |
| NA-3 | No 429 handling before the first sweep | Retry-After honor, backoff+jitter, token bucket, timeouts, deadlines — shipped before any sweep |
| NA-4 | Deploy-resetting sync state | All watermarks/breakers/ledgers in Postgres; sweeps bounded, paced, never per-deploy |
| NA-5 | Silent failure | Every exhausted retry ends as a queued retry or a review row — a silent "done" is a bug by definition |
| NA-6 | Gates trusting stale data | Fail closed; freshness is a number the gates consume, with alerts + a dead-man's switch |
| NA-7 | Dates as instants | `'YYYY-MM-DD'` strings end-to-end; round-trip assertions on every transform |
| NA-8 | Guards as scattered hardcoded lists | A typed field registry as data before the second field is mapped |
| NA-9 | Trusting values | Classify real/placeholder/empty/garbage; "N/A" is never $0; unknown enums go to review |
| NA-10 | Silent overwrites | Enrichment is fill-only with provenance stamped; conflicts go to review |
| NA-11 | Fuzzy / business-key identity | Join on the immutable Encompass loan GUID only; loan numbers are hints, never identity claims; name conflict is a hard veto |
| NA-12 | Partial-value comparisons | "Does Encompass agree?" compares canonical full values through one shared transform, or fails closed |
| NA-13 | PII decided after the fact | The field-allowlist memo is signed before the first pull (§5) |
| NA-14 | Review queue accreted per incident | Tiers, sticky dismissals, rate caps, auto-close, dismiss-rate telemetry — designed as a system (§4) |
| NA-15 | Trusting the pipeline about itself | Nightly independent recon joined on the GUID only |
| NA-16 | Deploy-required emergency stops | DB-backed pause flags + a persisted read-volume breaker |
| NA-17 | No tests/CI/migration ledger | Guard suite + replay fixtures + CI from day one |
| NA-18 | Improvised repair tooling | The restore-script discipline (dry-run default, classify, verify by re-read, never guess) built before it's needed |
| NA-19 | Waived safeguards; docs diverging from reality | No launch-gate item is waivable (§6.4); docs updated in the same change; first production pull *witnessed* |
| NA-20 | Velocity over safety | Error-budget freeze: while any dead-letter or blocking review card is past SLA, only fixes merge |

---

## 4. Manual review gates for inbound Encompass data (A3 applied)

The portal already has a mature, battle-tested human review gate built after the DOB incident: `sync_review_queue` holds any cross-system change that cannot be **proven** safe; the auto-resolve engine settles only provable conflicts; LOs own their rows (notified on creation, reminded at 3 days, admin-escalated at 7, weekly digest); dismissals stick; rows auto-close when the systems converge. Endpoints at `src/routes/staff.js:5929-6167`, UI at `/internal/sync-reviews` (`app-v2/src/screens/SyncReviews.jsx`).

**Recommendation: reuse the same queue** (add a `source` column, `'clickup'|'encompass'`, via a new idempotent migration) so notify/aging/digest/badge/bulk/scoping machinery and the UI shell come for free — with **one deliberate inversion**:

- The ClickUp resolver applies the winner to **both** systems. An Encompass resolver must be **architecturally incapable of writing back**. `winner:'encompass'` → re-read from the latest local snapshot, sanitize through the existing validators, write the *portal* record, audit + journal. `winner:'portal'` → **no write anywhere**; the note records "portal value kept; if Encompass is wrong, fix it in Encompass," with sticky suppression so the same (loan, field, value) tuple never respawns — a *changed* Encompass value is a fresh event. `winner:'custom'` → portal-only, flagged that Encompass still differs; auto-closes when a later pull shows agreement. There is **no Encompass applier module at all**.

**What auto-applies (no card):** filling a blank portal field (COALESCE fill-only), provable format canonicalization, pure Encompass-namespace facts landing in dedicated `encompass_*` columns, additive contacts.

**What stops for review (Tier A, LO emailed):** identity conflicts (name/DOB/SSN/email/phone/address differing from a non-blank portal value — DOBs run through `decideDob`-style logic first so only genuine ambiguity cards); decision-gating loan-field mismatches (amount, rate, dates, program, address); entity-resolution ambiguity (a GUID matching >1 portal file, or another borrower's file — with `link_existing`/`create_file`/dismiss actions); an Encompass loan that disappeared while the portal file is active; and pull-pipeline dead letters (never a silent skip). Informational drift is **Tier B** (badge + digest only) so the initial backfill cannot flood LOs.

**Gates are not reviews.** "A portal condition cannot clear unless Encompass agrees" and "no CTC unless Encompass shows CTC" are **blocking gates** in the sign-off path (`signOffGate` style — a 422 at clear time), evaluated against the snapshot mirror with a freshness check, failing closed on stale/absent/mismatched data. A *standing* disagreement (portal says satisfied, Encompass reopened it) additionally queues a Tier-A card so it isn't discovered only at CTC time. The gate module physically contains no client write calls (the "loopback guard by absence" pattern).

**Provenance from day one:** stamp `origin='encompass'` on integration-created values and record per-field last-writer, so "human edits win" is a lookup, not archaeology — the exact rule that made `decideDob` safe.

---

## 5. Data governance (F3): what we may pull, store, show, and for how long

Governing stance: a **bounded operational cache with a signed-off field allowlist — never a mirror**. ICE's public API terms restrict data replication (warehouses/analytics repositories) without written approval, and the bounded inventory is also the GLBA data-inventory artifact examiners ask for. Encompass stays the system of record; the portal durably retains only *evidence of its own decisions*.

### 5.1 Field intake policy — four tiers, enforced three ways

Enforcement: (a) Encompass-side persona **field denies**; (b) request-side `fieldReader` with explicit field-ID lists — never `view=full`; (c) intake-side allowlist filter + extended `redactPII()` (`src/lib/redact.js:9`) before anything persists. An unexpected key in a response is dropped **and** raises an `encompass_intake_violation` alert (the persona should have prevented it — its appearance means server-side config drifted).

| Tier | Content | Handling |
|---|---|---|
| 1 — PULL | Loan GUID/number, milestone + log, loan folder, **CTC flag + date**, key dates, UW condition list, economics (amount/rate/term/purpose), property, party names/emails/phones, loan team, credit **score number only** | Structured columns + redacted jsonb; plaintext OK |
| 2 — PULL MINIMIZED | Liquidity for `rtl_p3_liq`: **one aggregate figure** (or a computed ok-boolean + threshold) | Sum in memory during the pull; never account numbers, per-account balances, or statements |
| 3 — HASH/DERIVE | **SSN: never persist a full SSN from Encompass — no second ciphertext.** Default: don't request it at all; if matching measurably needs it, transient in-memory HMAC via the existing `ssn_hash`/`SSN_MATCH_KEY`, store last4 at most. **DOB: no full DOB persists**; in-memory compare, store a `dob_match` boolean; mismatches go to review (a DOB change is always a human decision) | Plaintext discarded in the same request scope; `ssnForStorage()` (`src/lib/crypto.js`) is never invoked for Encompass data in Phase 1 |
| 4 — EXCLUDE | Full SSN/ITIN/DL/passport numbers, account numbers, credit-report payloads, income docs/figures beyond the Tier-2 aggregate, tax transcripts, HMDA GMI, eFolder attachments, free-text conversation logs | Persona-denied; intake filter rejects on arrival |

The allowlist lives as a code constant + a versioned `docs/ENCOMPASS-FIELD-INVENTORY.md`; adding a field = code change + doc update + compliance-owner sign-off. **Decided (Decision D3, 2026-07-19): launch with Tier 3 disabled** and measure unmatched-loan rates first — the launch matching ladder is loan number, then canonical address + last name, then name + entity + amount/date corroboration (DATA-MAPPING §2).

### 5.2 Storage, access, audit, retention

**Storage tables: the canonical Phase-1 schema is defined once, in `ENCOMPASS-DATA-MAPPING.md` §2.1 (Decision D4, 2026-07-19) — this section is a pointer, not a second definition.** Four tables (new numbered idempotent migrations): `encompass_loan_index` (durable crosswalk binding via its `application_id` column — the only binding location; 7-state match ENUM; `clickup_task_index` clone), `encompass_snapshots` (append-only, allowlist-only redacted jsonb, prunable), `encompass_pull_log` (the READ journal of §2.5 — every fetch incl. failures and blocks, masked adopted values, db/107 model), and `encompass_gate_log` (**decision evidence**: the exact field values each gate relied on, at decision time — the NYDFS 500.06 "reconstruct the transaction" bar, and what makes snapshots freely prunable). Optional typed projections of snapshots (conditions/milestones convenience mirrors) are implementation detail, never separate sources of truth. No new field-level encryption is needed in Phase 1 *because sensitive fields never land*; DB-level at-rest encryption preserves breach safe harbor.

**Access:** no new paths. All Encompass-sourced reads inherit `VISIBLE_OFFICERS_SQL` / `canSeeBorrowerId` (`src/routes/staff.js:136-141, 2812-2826`) and the capability model; journals/gate logs behind `view_audit_log`; setup behind `platform_setup`. **Borrowers see derived outcomes only** ("condition cleared," "clear to close"), every borrower-facing string through `borrower-safe.scrubText` (investor names occur inside Encompass loan data). Every staff-rendered Encompass value carries a provenance badge — "Encompass · as of \<time\>", amber when stale — and gate results always show both sides.

**Audit:** every fetch and every gate evaluation logged — `audit_log` actions in a new `encompass` category (`encompass_pull_loan`, `encompass_gate_eval`, `encompass_ctc_gate_fail`, `encompass_intake_violation`, …; `detail` never carries PII), plus the two journals, INSERT/SELECT-only for the app DB role.

**Retention:** snapshots pruned aggressively (rolling ~90 days + keep-last-10 per loan; terminal loans drop to keep-last-1 after 30 days — safe because relied-on values live in the gate log, and thin snapshots are also the "not a warehouse" evidence). Pull log, gate log, and related audit rows **≥ 5 years** (final number set by the written retention schedule once the licensed-state list is confirmed — do **not** copy the inaccurate "GLBA ≥ 6 years" line from `docs/SHAREPOINT-SECURITY-COMPLIANCE.md:38`). A legal-hold flag suspends pruning and purge cascades. An incident runbook (`docs/ENCOMPASS-INCIDENT-RUNBOOK.md`) pre-stages the six F3 §6 scenarios — credential compromise, persona drift, wrong-loan match, DB breach, ICE-side outage, gate regression — all starting from the same two levers: kill switch + log preservation.

---

## 6. Risk register and monitoring spec (F5)

F5 catalogs **29 risks** (FM-01…FM-44, non-contiguous IDs) across auth, rate limits, webhooks, platform change, identity, PII, and pipeline health, each with likelihood/impact/detection/mitigation/owner. Day-one rule: **a risk without an automated detector is an unmitigated risk** (all 16 ClickUp incidents were caught by humans noticing wrong data).

### 6.1 Top risks

| Rank | ID | Risk | Impact | Core mitigation |
|---|---|---|---|---|
| 1 | FM-20 | **Wrong-loan matching** — a gate evaluates a *different* loan's snapshot (loan numbers are copyable/reusable; `ys_loan_number` is nullable ClickUp-sourced text) | Critical | Four layers: GUID-only deterministic binding with human-confirmed states; per-ingest link re-verification demoting contradictions to `conflict` without re-binding; gate-time identity assertion logged to `encompass_gate_log`; nightly independent recon with mismatch rate as a first-class metric. Gates fail closed on any state outside {auto_matched, manual_confirmed} |
| 2 | FM-30 | **Silent sync death** — pipeline stops, mirror ages, gates keep answering | Critical | "Every failure ends as a retry or review row"; per-loop Postgres heartbeats; freshness consumed *by the gates*; **external dead-man's switch** (in-process alerting died in the ClickUp era — one dead email key muted everything) |
| 3 | FM-10 | **Credential leakage** | Critical | §7 runbooks; dedicated credentials + day-one journal make scoping possible |
| 4 | FM-26 | **PII overexposure** (a read-only persona can still read everything) | Critical | §5.1 tiers; persona field denies; intake-violation detector; inaccessible field = fail closed, never "empty and passing" |
| 5 | FM-40 | **Schema drift** (~4 Encompass majors/year with documented attribute removals and null-vs-empty flips) | High | Contract validation at ingest from the typed registry; R2T regression + replay fixtures each release; a field failing validation = "Encompass does not agree," never a default |
| 6–10 | FM-15/16/17/22/01 | 429/concurrency storms (30 shared concurrent calls per instance); maintenance windows while gates need agreement; lossy/Smart-Client-blind webhooks; duplicate/deleted loans; token & service-user password expiry | Med–High | Client pacing ≤4 concurrent + breaker; DEGRADED-mode state machine (gates fail closed, nothing classified deleted); **webhooks are accelerators, polling is truth** — payloads carry no trusted data, only a GUID to re-fetch; absence is a review card, never an auto-descope; token cache + single-flight + one 401 self-heal, watermarks advance only past cleanly-consumed pages |

### 6.2 Monitoring the integration must ship with (none of it Phase 2)

- **Heartbeats:** every loop writes a `sync_runtime_state` row per pass; alert budgets per loop (poll 3× cadence, drainers 5–10 min, nightly jobs 26 h); an **external pinger** on `/api/health` (which exposes watermark age, queue depths, parked count, breaker state, token age, min freshness) plus a weekly alert-channel self-test a human must ack.
- **Freshness SLOs consumed by the gates (Decision D1, 2026-07-19):** gated snapshot age ≤ 2× poll cadence; the CTC gate evaluates the **local snapshot only** and requires it to be no older than the CTC freshness ceiling (**15 minutes** recommended, configurable) — if older, the gate **fails closed** with a "refreshing Encompass data — retry shortly" outcome and enqueues an immediate high-priority refresh for the background sync worker. There is **no live fetch in the request path**: the evaluator module holds no HTTP client, by construction; a live blocking fetch at decision time is explicitly rejected for Phase 1 (it would put Encompass availability in the request path) and is a Phase-2 open question. Lower-severity condition gates tolerate the standard snapshot age (≤ 1 h); every displayed value carries "as of \<timestamp\>".
- **Correctness metrics:** `link_conflict_rate`, nightly recon population/field breaks (target 0; >48 h escalates), gate-blocked-by-staleness/mismatch counters, intake violations (any occurrence alerts), unknown-enum and unmapped-field growth, 429 rate and concurrency headroom, auth-error rate, parked rows, snapshot storage trends, review-queue cards/day and dismiss rates (>5 LO emails/day = a queue-design bug).
- **Rituals:** weekly 10-minute metrics review; quarterly credential rotation; per-release R2T regression; **error-budget freeze** — while any S1/S2 item is past SLA, only fixes merge.

### 6.3 Deep-dive pointers

The four scariest — wrong-loan matching, silent sync death, credential leakage, outage mode — are spelled out in F5 §4 (findings file) and are incorporated by reference; §4.1's gate-side hard precondition (match state ∈ {auto_matched, manual_confirmed} AND fresh AND identity re-asserted at decision time, logged) is the single most important line in the whole design.

### 6.4 Launch gates (conditions of go-live — none waivable, per NA-19)

1. Read-only enforced **twice independently**: View-Only persona verified by a *rejected write attempt* in a test context, AND the client allowlist with the CI suite green.
2. Boot introspection asserts the expected API user and `encompass_instance_id === 'BE11397907'`, refusing to sync on mismatch.
3. Retry/backoff/429 handling + Postgres-persisted watermarks **before the first sweep**.
4. Read journal writing from request #1; dedicated credentials used by nothing else.
5. Gates demonstrably fail closed (staleness, mismatch, inaccessible field, outage) in shadow mode before enforcement.
6. Full monitoring live, including the external dead-man's switch and one end-to-end alert test.
7. PII field-allowlist memo signed by the owner; log-redaction test green.
8. Review queue shipped as a system (tiers, sticky dismissals, rate caps).
9. The first scheduled production pull **witnessed running** (the SharePoint-mirror lesson).
10. ICE answers in hand or explicitly risk-accepted: entitlements, test instance, concurrency, terms.

---

## 7. Secret handling

1. **Storage:** all Encompass credentials (client id, client secret, API-user credentials, instance id) live only in Render env vars via an `encompass: {}` block in `src/config.js` — never in source, docs, commits, PR bodies, or the frontend bundle. `.env.example` gets placeholders only. Tokens are held in memory only — never DB, logs, or `audit_log.detail`.
2. **Identity:** a dedicated API user + dedicated persona, used by nothing else (attribution is what ended ClickUp's false-alarm forensics). Two credentials, not one: the runtime read-only credential, and a separate webhook-admin credential the server process never loads (§1.2).
3. **Rotation-before-use (the resolved blocker restated):** any credential that has transited chat/email/tickets/commits is burned. This has already happened: the Encompass Client ID, Client Secret, and Instance ID were pasted into the task chat on 2026-07-17 (Decision D7) — regenerate the client secret before the first API call. See §0.
4. **Routine rotation:** quarterly, off-hours, **alternating** client secret and service-user password so a bad rotation is diagnosable; every rotation follows a cutover checklist ending in verification (introspection asserts user/instance; one known-loan read succeeds; a write attempt is rejected; freshness gauges recover).
5. **Leak response:** flip the DB-backed kill switch (no deploy needed) → regenerate immediately (the break-the-app cost *is* the incident cost — never wait for a convenient window) → best-effort token revocation → scope via the read journal (what was pulled, when, from where) → purge the pasted artifact → breach-notice analysis if unencrypted NPI of ≥500 consumers was plausibly acquired → verification checklist, then unpause.
6. **Never log a value:** error strings carry path templates and field IDs only; journal masking reuses the `maskSSN` discipline (`src/clickup/orchestrator.js:509-527`); a log-redaction guard test runs in CI.

---

## 8. Open questions

Canonical tracker: Master §10 (OQ-xx IDs); this local list is subsumed. (Decision D8, 2026-07-19.)

Carried forward explicitly from the findings; none may be silently assumed at build time.

1. **Credential transit history — RESOLVED (Decision D7, 2026-07-19):** on 2026-07-17 the owner pasted the Encompass Client ID, Client Secret, and Instance ID into the task chat for this research session. Per the standing CLAUDE.md rule they are treated as burned: regenerate the client secret in the Encompass API Key Management page before first use (§0). No API call was ever made with the values and they appear in no file or commit.
2. **Persona granularity:** can the API user's persona on BE11397907 be made fully write-less (loans, eFolder, disclosures, settings), giving vendor-enforced read-only? Everything stands without it, but it should be demanded. Also: can field-level denies cover every Tier-4 field? *(ICE engagement — the top open question in F1, A5, A6, F3.)*
3. **Webhook subscriptions via admin UI?** Relevant only if/when webhooks are adopted (Phase 1.5+, owner-gated per Decision D2 — Phase 1 is poll-only and creates no subscriptions). If the admin UI suffices, the portal never writes even config — the strongest posture; if not, the out-of-band script + separate credential path applies. *(ICE.)*
4. **Grant/token ground truth:** client-credentials API-user provisioning confirmed? Token lifetime regime (30 min/24 h vs 15 min/2 h — sources conflict); whether Regenerate Secret kills outstanding tokens; dual-key rotation possibility. *(ICE.)*
5. **Rate limits for this instance:** per-minute limits (undocumented), current concurrency ceiling, and who else consumes the shared 30-slot budget today. *(ICE.)*
6. **Test/R2T instance entitlement:** without one, the first build runs against production PII — determines the whole dev posture. *(ICE + owner.)*
7. **`GET /loans/{id}/recipients` side effects:** confirm before it could ever be considered; denied regardless for Phase 1.
8. **Does Phase 1 pull attachments?** If ever yes: eFolder download endpoints + the URL-follower exception, routed through `storage.js`/`serve-document.js` gates — currently excluded (Tier 4).
9. **Where the CTC signal lives** in this instance (milestone finished vs status field) — the single most gate-critical mapping decision.
10. **Custom-field layout of BE11397907** (ARV, rehab budget, assignment data) — determines Tier-1 fieldReader IDs.
11. **Allowlist/field-inventory sign-off owner** (the Qualified Individual) and the **licensed-state list** (sets the final ≥5-year retention number and the breach-notice matrix). *(Owner + compliance.)*
12. **Does identity matching actually need transient SSN/DOB (Tier 3)?** Decided for launch (Decision D3, 2026-07-19): disabled; measure unmatched rates on the non-SSN ladder first; enabling Tier 3 later is an owner decision.
13. **Same review queue or sibling table?** Recommended: same `sync_review_queue` + `source` column; the risk (slug collisions, mixed volume) is mitigated by tiering — but confirm with a dry-run diff report of expected initial-backfill conflict volume before the queue goes live.
14. **CI substrate:** where does `test-encompass-readonly-guard.js` run automatically (GitHub Action vs pre-merge convention)? The repo has no CI today; this must be a real gate, not a convention.
15. **Webhook event reliability:** event-history retention window (bounds the safe reconcile gap) and the live event list for this instance — polling remains primary regardless.

---

## 9. What this document does and does not do

- It **freezes** writes to Encompass (§1) and defines the only ceremony that could ever unfreeze anything (§2.6).
- It **specifies** enforcement, review, governance, risk, and monitoring designs — nothing here is built. There is no `src/encompass/` directory, no migration, no config flag, and no credential wired anywhere as of this research pass.
- Any future session implementing Phase 1 must: read this document; build the six layers of §2 before the first pull; satisfy every launch gate in §6.4; and treat every open question in §8 as unresolved until answered in writing.
