# Encompass Integration — Master Research & Plan

_Research pass, 2026-07-17. **Status: research only — nothing implemented.** No code has been written, no Encompass API call has been made, and no file in the repo has been modified. No credentials appear in this document. All repo paths are relative to `yscap-repo-root_8/`._

_Revision note (2026-07-19): post-critique consistency pass applied (decisions D1–D17)._

This is the master document for the read-only Encompass integration. It summarizes the full research program; five sibling documents (§9) carry the deep detail. The audience is the owner first, engineering second — each section opens in plain language and then gets specific.

---

## 1. Executive summary

**What Encompass is.** Encompass (ICE Mortgage Technology) is the loan origination system — the industry-standard "system of record" where the ops team actually works loans: opens files, tracks conditions, moves milestones, and receives clear-to-close. YS Capital's production instance is **BE11397907**.

**What our portal is.** PILOT, the YS Capital borrower/staff portal (`src/server.js`, Node/Express + Postgres, React front-end), runs the borrower-facing loan lifecycle: an 11-status pipeline, two condition systems, a clear-to-close gate, pricing registration, and post-closing tracking (see B5 findings, summarized in §4). Today the portal knows about Encompass only through **five manual checklist tasks** telling staff to do things *in* Encompass (`db/005_rtl_workflow.sql:74-84`) and one **human-typed ClickUp mirror column** (`applications.encompass_status`, `src/clickup/mapper.js:122`). Nothing reads Encompass directly.

**What we are building.** A strictly **one-way, read-only** feed: Encompass → portal, never the reverse. The portal will pull loans, statuses/milestones, conditions, and selected borrower data so that:

1. Staff and (selectively) borrowers see **real LOS state** instead of a hand-maintained mirror.
2. The portal's decision gates get **teeth**: a **mapped** portal condition cannot be cleared unless Encompass agrees, and the portal cannot issue clear-to-close unless Encompass shows clear-to-close. Gating is opt-in per condition via the mapping table — unmapped conditions behave exactly as today — and enforcement turns on only after mapping coverage of active-pipeline conditions reaches the ≥90% coverage gate (ENCOMPASS-IDEAS-AND-ROADMAP §7). (Decision D9, 2026-07-19.)

**What we are explicitly NOT building — the write freeze.** In Phase 1 the portal will be **architecturally incapable of writing to Encompass**. No loan edits, no document uploads, no disclosure sending, no milestone changes, no rate-lock actions, no user or settings changes — not blocked, but *absent*: zero write functions exist in the code, and five more independent layers (§5.2) each stop a write on their own. Phase 1 is **poll-only and performs zero writes of any kind — not even platform-config writes**: no webhook subscriptions are created, so there is no public endpoint, no signing-key management, and the simplest possible freeze story. Webhooks are a Phase-1.5/2 accelerator behind an explicit owner decision; if adopted, subscription setup becomes the one sanctioned config-write category, run out-of-band from a separate admin credential the portal server never holds (§5.4; Decision D2, 2026-07-19). Nothing about Phase 1 changes anything inside Encompass.

**Why this posture.** The ClickUp bidirectional sync — built overnight with its own safeguards waived — corrupted data 32 minutes after go-live and produced 16 incidents in 9 days (§2). Read-only means Encompass itself cannot be damaged, period. Every remaining risk lands on the portal side (a wrong or stale mirror driving a wrong decision), and the whole design in §4–§7 is aimed at exactly that.

---

## 2. The one-way principle and why

### 2.1 What actually happened with ClickUp (the base rate)

The portal↔ClickUp sync was built in ~8 hours overnight (Jul 6→7, 2026) and went live with its designed safeguards explicitly waived — the go-live commit message read *"The ONLY protection is no deletion"* (`docs/AUDIT-2026-07-15-SYNC-ANNUAL.md`). The first data corruption hit **32 minutes** later. Over the following 9 days: **16 forensically reconstructed incidents**, ~45 reactively added guard layers, 13 deploys in a single day. Highlights, in plain terms:

- **10 borrowers' dates of birth silently moved back one day** — a date stored as a moment-in-time crossed a timezone boundary.
- **Two different people were merged into one profile** because a married couple shared an email — file access leaked to the wrong loan officer; fixed on the third attempt.
- **Eight fields on one file were wiped by an unidentified second automation** running under the same shared token — never fully attributed, because the portal's writes were indistinguishable from anyone else's.
- **Closing dates landed in year 0026** because the UI saved on every keystroke.
- **Copied loan numbers from ClickUp's duplicate-a-task workflow stole file identities.**
- **The repair script itself rewrote a DOB nobody asked it to touch** — the tool built to fix corruption caused some.
- Failed writes were **swallowed as "done"**; there was **zero rate-limit handling**; every deploy re-swept the whole portfolio because sync state lived in memory.

Recovery required a dry-run-default forensic restore tool, verify-every-write-by-re-read, a write journal built after the fact, a human review queue, and the owner manually pulling ClickUp's own activity history because the API record had gone dark. The decisive empirical lesson from the post-mortem: **fixes at a single chokepoint stayed dead; fixes at individual call sites recurred within a day.**

### 2.2 What one-way buys us

| ClickUp failure class | Under a read-only Encompass integration |
|---|---|
| Overwrite/echo loops between systems | Impossible — no portal value ever travels to Encompass |
| Field wipes, placeholder clobbers in the LOS | Impossible — nothing is written |
| Unattributable writes on a shared token | N/A for writes; a dedicated read-only identity + a journal of every call gives full attribution for reads (§5.2) |
| Repair operations on the LOS | Never needed — Encompass is never touched |

One-way does **not** eliminate risk; it relocates it. The portal will gate real lending decisions (condition clearing, CTC) on its Encompass mirror, so a wrong, stale, or mis-linked snapshot is not a data bug — it is a **wrong lending decision** (F5 framing). That is why §4 makes freshness and identity first-class gate inputs, and why the roadmap (§8) refuses to enforce any gate before shadow-mode proof. Every "NEVER-AGAIN" rule distilled from the ClickUp incidents (A6's 20-item list — structural read-only, dedicated identity, journaled calls, dates as strings, fill-only enrichment, GUID-only matching, fail-closed gates, review queue as a system, deploy-neutral state, no waived safeguards at go-live) is carried into this design as a day-one requirement, not an aspiration.

---

## 3. What we will pull and why

Plain language: we will read the list of loans, each loan's key fields, its conditions, and its milestone history — enough to display truthful status and to check "does Encompass agree?" before the portal clears anything. We deliberately pull the **minimum**: field-by-field detail (exact field IDs, formats, and portal columns) lives in **ENCOMPASS-API-ATLAS.md** and **ENCOMPASS-DATA-MAPPING.md**.

| Object | Encompass source (read-only) | Why the portal needs it |
|---|---|---|
| **Loan census + changes** | `POST /v3/loanPipeline` (a query, not a write), folder list | Discover which loans exist, link them to portal files, detect changes since the last look |
| **Loan detail** | `GET /v3/loans/{guid}`, `POST .../fieldReader` (bulk field read) | The identity fields for safe matching, plus status/CTC/economics fields for display and gates |
| **Conditions** | `GET /v3/loans/{guid}/conditions` (+ legacy v1 underwriting/preliminary/post-closing sets) | The "mapped portal condition may not clear unless Encompass agrees" rule (§4, D9) |
| **Milestones** | `GET /v3(or v1)/loans/{guid}/milestones`, associates | Stage annotations ("portal says underwriting, LOS hasn't submitted") and the CTC gate signal |
| **Field history** | `POST /v3/loans/{guid}/auditTrail` (verified pure read) | "Who cleared it and when" forensics for gated decisions |
| **Borrower data** | Loan entity / fieldReader, subject to the PII memo | **Fill-only** enrichment of empty portal fields, with provenance; conflicts go to a review card, never a silent overwrite |
| **Rate locks** | `GET .../ratelockRequests` — **uncertain** | The portal has **no rate-lock object today** (pricing "locks" via product registration only, `db/025`). Whether this instance uses rate locks at all for hard-money loans is an open question (§10 OQ-17); until answered this stays out of scope |
| **eFolder document metadata** | GET documents/attachments/histories (content download optional, deferred) | Later: auto-tick "ordered/received" tasks from real evidence; Phase 1 ships without content reads |

Two constraints govern everything pulled:

1. **PII minimization is decided before the first pull, not after.** The owner signs a field-allowlist memo: which borrower fields the portal stores vs. verifies-and-discards (prefer last-4 + verification flags over full values). Snapshots are masked at write time; a read-only persona can still *see* everything, so what we retain is a deliberate decision (F5 FM-26).
2. **Identity binds on the immutable Encompass loan GUID only.** The loan number is a matching *hint*, never an identity claim — ClickUp's copied-loan-number incidents proved business keys get duplicated. `ys_loan_number` is nullable ClickUp-sourced text (`db/schema.sql:164`, partial-unique `db/048`); whether it even equals the Encompass loan number is an open question (§10 OQ-20).

---

## 4. The rules we will enforce (the gate concept)

Plain language: today a person can mark a condition satisfied or move a file to clear-to-close based on what they believe. After this integration, the portal will also **check the system of record** — and if Encompass disagrees, is unreachable, or our copy is too old, the portal **refuses and says why**. An admin can still force past a gate, and every force is recorded.

The portal already has the exact chokepoints to hang this on (B5):

- **`advancementBlockers()`** (`src/routes/staff.js:3895-3923`) — the query that must be empty before `clear_to_close`/`funded`. The Encompass CTC requirement becomes **one more blocker row**, inheriting the existing 409 + admin-force + `forced=true` history semantics (`db/027`).
- **`signOffGate`** (`staff.js:2400-2540`) — already blocks condition sign-off until documents/budget/experience agree; gains an **Encompass-agreement branch**: the matching Encompass condition must be cleared/waived.
- **`sync_review_queue`** (`db/108`/`db/110`) — every conflict, mismatch, or stuck state becomes an actionable review card, reusing the two-sided-row + sticky-dismissal system built after the ClickUp incidents.

Non-negotiable properties (full detail in **ENCOMPASS-READONLY-GUARDRAILS.md**):

1. **Fail closed.** Stale data, an unlinked/conflicted loan, an inaccessible field ("User doesn't have access" from a persona rule), or an Encompass outage all mean "Encompass does not agree" — a blocked decision with a named reason, never a silent pass. Encompass agreement is *necessary*, never *sufficient*: the portal may be stricter than the LOS, never looser, and nothing auto-clears.
2. **Freshness is a number the gate consumes**, not a feeling — and the gate evaluator **never performs network I/O in the request path**. By construction the evaluator module holds no HTTP client; it reads only the local snapshot. The clear-to-close gate requires the loan's local Encompass snapshot to be **no older than the CTC freshness ceiling (15 minutes recommended, configurable)**. If the snapshot is older, the gate **fails closed** with a "refreshing Encompass data — retry shortly" outcome and an immediate high-priority refresh is enqueued for the background sync worker. A live blocking fetch at decision time is explicitly **rejected** for Phase 1 — it would put Encompass availability in the request path; revisiting that is a Phase-2 open question (§10 OQ-31). Lower-severity gates (soft warnings, condition clearing) tolerate the standard snapshot age (poll cadence); display surfaces show "as of \<time\>" and never block. A dead sync pipeline therefore automatically fails gates closed instead of lying. (Decision D1, 2026-07-19.)
3. **Identity is re-asserted at decision time.** The gate query re-checks loan-number/surname agreement between the linked snapshot and the portal file and logs the compared values; any doubt blocks the decision.
4. **Known hole to close (B5 caveat):** the internal-status door (`staff.js:4298-4325`) and the inbound ClickUp status path both bypass `advancementBlockers` today — an underwriter picking ClickUp status "ctc (4-email)" lands a file in CTC with no blocker check. The Encompass CTC gate covers **all three doors** (status PATCH, internal-status, and ClickUp-inbound status application). For the ClickUp door, "blocking" means the inbound CTC status change is **not applied locally**: it lands in the sync review queue with reason `encompass_gate_blocked`, exactly like other suspicious inbound changes — we cannot stop ClickUp itself from changing, but we refuse to mirror it ungated. (Decision D6, 2026-07-19; wording of record in ENCOMPASS-DATA-MAPPING §5.4.)
5. **No partial-value comparisons.** ClickUp's last-4/first-word comparisons made real conflicts invisible; every "does Encompass agree?" check compares canonical, fully-normalized values through the same transform on both sides, or fails closed to review.

---

## 5. Architecture overview

Full designs: F1 (read-only enforcement) and F2 (pull-sync architecture); condensed here.

### 5.1 Authentication (C1)

- **Grant:** OAuth2 **resource-owner password** — ICE's docs are explicit that lenders must use `grant_type=password`; `client_credentials` is for ISV partners only. Token call: `POST https://api.elliemae.com/oauth2/v1/token` with the fully-qualified username `serviceuser@encompass:BE11397907`, the API key's client_id/secret, `scope=lp`.
- **Lifetime:** documented as 30-min idle-extended / 24-h cap, but a newer ICE platform page says 15-min idle / 2-h max — the docs disagree, so the client designs for the **stricter** rule and self-heals on 401 either way. There is **no refresh token**; "refresh" = re-authenticate (cheap). The repo already contains the exact pattern to clone: the Graph client's in-memory cache + single-flight + one-retry-on-401 (`src/lib/sharepoint.js:38-125`).
- **Boot assertion:** call token **introspection** and refuse to sync unless `active`, the expected service username, and `encompass_instance_id === 'BE11397907'` all hold — a mis-provisioned credential must never mirror someone else's book.
- Tokens live in memory only — never the DB, never disk, never logs.

### 5.2 Read-only enforcement — six independent layers (F1)

Six independent layers, numbered 0–5 (source of truth: **ENCOMPASS-READONLY-GUARDRAILS §2**; Decision D10, 2026-07-19). A write would have to defeat **all six**; each alone is sufficient to stop it:

| # | Layer | Mechanism |
|---|---|---|
| 0 | **Encompass-side persona** | Dedicated service user + least-privilege persona with a "Persona Access to Loans = View Only" business rule — ICE itself 403s any write, regardless of our code. Personas genuinely bind API calls (confirmed by ICE changelog fixes in EDC 25.3/26.1) |
| 1 | **Single chokepoint client** (`src/encompass/client.js`) | One private `request()` enforcing an explicit **deny-by-default allowlist** of (method, anchored path pattern, query allowlist, body validator) tuples — C7's categories A–H (§5.5) are the exact membership. **Zero write functions exist anywhere**; only typed read helpers are exported |
| 2 | **Kill switches, default off** | `ENCOMPASS_ENABLED` / `ENCOMPASS_DRYRUN`; an `ENCOMPASS_OUTBOUND_*` flag is *permanently absent* and grep-banned — there is nothing behind the gate to turn on |
| 3 | **CI guard suite** | A no-DB/no-network script locks the allow/deny matrix, scans source for any call site outside the chokepoint, and pins the sha256 of the frozen allowlist — any edit is a deliberate, reviewed two-file change |
| 4 | **Read journal** | Append-only `encompass_pull_log` records every call, including guard-blocked ones. "If it's not in the journal, the portal didn't call it" — and a query showing zero write-shaped rows is standing compliance evidence |
| 5 | **DB constraint** | Makes a `sync_queue ('encompass','push')` row **unrepresentable** — a push job cannot exist in storage; paired with a journal-seeded read-budget circuit breaker that survives deploys (fixing ClickUp's deploy-reset weakness) |

**Why an allowlist, not method filtering:** method-only filtering fails in both directions on this API. Of 200 POSTs in the collection only 53 are reads/auth (the token grant, `fieldReader`, `loanPipeline`, `auditTrail`, schema generators) — so "deny POST" kills the integration — while GETs include two requests carrying a stray `action=Add` mutation parameter, a `recipients` GET that may mint borrower access codes, and opaque presigned URLs. `PATCH` is this API's main write verb (214 of 800 requests). Deny-by-default with per-entry query and body validation is the only safe posture — especially since the collection is 26.2-era and the live API may expose endpoints it doesn't list.

### 5.3 Sync engine (F2)

A loop-driven, one-directional clone of the proven ClickUp inbound stack (`src/sync/clickup-sync.js`):

- **Phase 1 is POLL-ONLY — four triggers, one code path:** initial backfill, watermark poll, hourly event-history reconcile, and a nightly full sweep all converge on one idempotent `ingestLoan(loanGuid)`. No webhook subscriptions are created in Phase 1 — zero writes to Encompass of any kind, including platform config: no public endpoint, no signing-key management, the simplest possible freeze story. (Decision D2, 2026-07-19.)
- **Backfill:** folder + field census, then a paged pipeline sweep writing crosswalk stubs, then a paced deep-fetch drainer (concurrency 2, `FOR UPDATE SKIP LOCKED`) — discovery and fetch decoupled so a crash loses nothing.
- **Webhooks are a Phase-1.5/2 accelerator, behind an explicit owner decision (§10 OQ-26) — never a Phase-1 trigger and never the source of truth.** When adopted, they become a fifth trigger that only *accelerates* the poll: ICE says webhook delivery "is not guaranteed" (4 attempts, then discarded), and many Loan events fire **only for API-originated actions** — staff working in the desktop Smart Client may not emit them at all. The system must remain correct with webhooks entirely disabled. The future webhook receiver verifies an HMAC signature on the raw body, dedupes on `eventId`, fails closed without a signing key, and **trusts no payload data** — it extracts the loan GUID and re-fetches current state; and because ICE auto-disables/deletes persistently-failing subscriptions (an integration can silently go deaf), a daily subscription-drift read check is mandatory once webhooks exist (Decision D15, 2026-07-19).
- **Cadence:** a fixed 5–15-minute watermark poll (configurable; webhook adoption in Phase 1.5/2 would merely allow relaxing it); the reconcile overlap is widened to 30 minutes because the pipeline API reads a lagging Reporting DB. Estimated volume: **roughly 500–1,750 calls/day depending on book size and poll cadence** — the low end assumes C3's minimal-poll cadence, the high end F2's denser cadence; assumptions live in ENCOMPASS-API-ATLAS §5 (Decision D11, 2026-07-19). Trivial against the environment's default 30-concurrent-call budget, which is nonetheless *shared with every other integration on the instance*, so the client self-limits to ~4 concurrent and adapts to the `X-Concurrency-Limit-*` headers.
- **Deploy-neutral state:** watermarks, breaker windows, and sweep ledgers live in Postgres (`sync_runtime_state`), never in memory — the ClickUp deploy-storm lesson.

### 5.4 Storage, identity, and the deferred webhook-config surface

The canonical Phase-1 schema is owned by **ENCOMPASS-DATA-MAPPING §2.1** (Decision D4, 2026-07-19); this section only summarizes it. Four tables: **`encompass_loan_index`** (one row per Encompass loan GUID seen; crosswalk to portal `application_id`, nullable; 7 match states: `unmatched` / `auto_matched` / `manual_confirmed` / `ambiguous` / `conflict` / `data_only` / `ignored`), **`encompass_snapshots`** (append-only raw JSONB snapshot per loan per fetch — diffable, replayable), **`encompass_pull_log`** (the READ journal, §5.2 layer 4), and **`encompass_gate_log`** (one row per gate evaluation).

- **Snapshots:** the **masked** raw JSON of every fetch, sha256-deduplicated (an unchanged poll writes no row), with a previous-pointer chain enabling diffs, forensics, and replaying ingest logic against history with zero API calls.
- **Crosswalk and binding:** binding is via `encompass_loan_index.application_id` **only** — no new column on `applications` in Phases 1–2 (the Stage-2 "no application/borrower columns touched" rule; a convenience column is a possible later denormalization, noted as such). Gates require match state ∈ {`auto_matched`, `manual_confirmed`}. Manual confirmations are sticky; contradictions **demote to `conflict` without unlinking**; a partial unique index makes double-binding structurally impossible; Phase 1 **never creates portal files or borrowers** from Encompass data.
- **Webhook subscriptions** (deferred — Phase 1 has NO config write at all, per Decision D2): if and when webhooks are adopted in Phase 1.5/2, subscriptions are managed as config-as-code by an out-of-band admin script with a **separate credential the server process never loads** — dry-run by default, verified by re-read, restricted to subscriptions pointing at the portal's own host. The runtime only *reads* subscriptions to detect drift (daily, per D15 — ICE auto-deletes failing subscriptions); it never heals drift by writing. If ICE's admin console can create the subscriptions by hand, even this future write disappears (§10 OQ-12).

### 5.5 The endpoint atlas in one paragraph (C7)

All **800 requests** in the official 26.2 Postman collection were classified: **329 READ (41%)**, 49 read-via-POST, 4 auth, **318 WRITE_LOAN (40%, forbidden)**, 92 WRITE_CONFIG, 8 ambiguous (all denied). Only ~47% of the surface is even candidate-permittable, and the proposed Phase-1 allowlist is far narrower: (A) auth, (B) loan reads, (C) pipeline queries, (D) schema, (E) conditions, (F) milestones, (G) eFolder metadata, (H) webhook subscription reads — H dormant until webhooks are adopted in Phase 1.5/2 (Decision D2). Everything else — including all 8 ambiguous endpoints and high-risk look-alikes such as `fieldWriter` (one word away from the allowlisted `fieldReader`), `loanBatch/updateRequests`, `resourceLocks`, and every `?action=` mutation — is deny-by-default with loud "tripwire" alarms on the nastiest shapes. Full tables: **ENCOMPASS-API-ATLAS.md**.

---

## 6. Prerequisites and asks (owner action list)

> **⚠️ BOLD CALLOUT — SECRET ROTATION IS A BLOCKER.** Verified fact (Decision D7, 2026-07-19; the research session itself is the eyewitness): on **2026-07-17** the owner pasted the Encompass Developer Connect **Client ID, Client Secret, and Instance ID into the task chat** for this research session. The secret was **never written to any file, commit, or document**, and **no API call was ever made with it**. Per the standing `CLAUDE.md` rule ("a credential pasted into a chat/transcript is considered compromised" — same policy as the SharePoint incident, `docs/SHAREPOINT-INTEGRATION-RESEARCH.md` §0), it is **treated as burned: regenerate the client secret in the Encompass API Key Management page before first use.** **Regenerate Secret** is the *only* rotation path, and ICE warns it "breaks any current Developer Connect applications using this API key" — so rotation is a planned, coordinated cutover, not a quiet fix. Do not store the shared value anywhere (not in git, not in a doc, not in Render as-is); the regenerated value goes directly into Render environment variables. **Rotation is step 1 of Stage 0** and of everything below.

What only the **Encompass super administrator** can do (C1 §7):

1. **Obtain the API key:** Developer Connect portal → My Account → API Key → record the Client ID (OAuth) + Client Secret **directly into Render env vars** — never through chat/email. (Only a super-admin persona can access this screen.)
2. **Create a dedicated service user** (e.g. `ysportal.svc`) — a *normal* user. **Do NOT check the "API User" box**: that pairing is for ISV partner keys and removes the password entirely, which would break the lender password grant we must use.
3. **Create a least-privilege persona** (e.g. "Portal ReadOnly API") — never reuse Super Administrator (the `admin` user ignores all business rules, which would silently void the read-only guarantee). Enable the LO Connect/web access option the API requires.
4. **Add a "Persona Access to Loans = View Only" business rule** for that persona, and review "Persona Access to Fields" rules — since EDC 25.3 field-deny rules genuinely hide values from the API, so make sure nothing the gates need is blanked (and consider deny rules for fields the portal must never see).
5. **Budget one license seat** for the service user, and **exempt or calendar its password expiry** — an unnoticed forced password change is the #1 way headless integrations die.
6. **Verify before go-live:** introspection asserts the right user + instance; a known loan reads back with all needed fields visible; and a deliberate write attempt is **rejected**.

Questions for the **ICE account manager** (answers shape the design; full list §10):

- Is a **test/R2T sandbox instance** included in our contract? Without one, all development runs against production PII — a material GLBA concern.
- **Rate-limit ground truth** for BE11397907: per-minute limits (undocumented), the concurrency ceiling, and which other integrations already consume the shared 30-slot budget.
- **Token semantics:** which lifetime regime applies (30-min/24-h vs 15-min/2-h); does the token response include `expires_in`; does Regenerate Secret kill outstanding tokens; can a lender hold **two API keys** for zero-downtime rotation?
- **Entitlements:** are standard webhooks included; is the portal-enrichment use case confirmed in writing as a sanctioned use; any seat-billing implications for the API user?

---

## 7. Risk summary (top 8 of 29)

F5 maintains the full register (29 risks, IDs FM-01…FM-44 non-contiguous, each with likelihood/impact/detection/mitigation/owner) — see **ENCOMPASS-READONLY-GUARDRAILS.md** for the enforcement side. The top eight by residual severity:

| # | Risk | Why it matters | Headline mitigation |
|---|---|---|---|
| 1 | **Wrong-loan matching** (FM-20) | A gate evaluating a *different* loan's snapshot = wrong lending decision + possible privacy breach; loan numbers are copyable/reusable (proven by the ClickUp incidents) | GUID-only binding; conflict demotion without re-binding; identity re-asserted at decision time; nightly independent recon; gates fail closed on any non-matched state |
| 2 | **Silent sync death** (FM-30) | Pipeline stops, mirror ages, gates keep answering from stale data (the SharePoint mirror "shipped but never ran" precedent) | "Every failure ends as a retry or review row"; Postgres heartbeats per loop; freshness consumed *by the gates*; an **external** dead-man's switch — in-process alerting died in the ClickUp era |
| 3 | **Credential leakage** (FM-10) | A leaked bearer token is the whole persona; Regenerate Secret is the only remediation and breaks running apps, tempting delay | Env-only secrets; never-log guards; dedicated credentials used by nothing else + a day-one read journal so any leak can be scoped; rotation and leak-response runbooks written in advance |
| 4 | **PII overexposure** (FM-26) | A read-only persona can still *read* everything (full SSNs, DOBs, account numbers); the plaintext-SSN-in-ClickUp episode is the standing precedent | Owner-signed field-allowlist memo before the first pull; masked snapshots; Encompass-side field-deny rules; inaccessible field = fail closed, never "empty and passing" |
| 5 | **Schema drift** (FM-40) | ~4 major Encompass releases/year with documented attribute removals and null-vs-empty flips — exactly the silent kind that flips a gate comparison | Contract validation at ingest from the typed field registry; unknown-value alarms; per-release regression against replay fixtures; fail closed on validation failure |
| 6 | **429/concurrency storms** (FM-15) | The 30-slot budget is shared instance-wide — a runaway poller throttles *every* YS integration, not just the portal | Day-one Retry-After honor, backoff + jitter, token-bucket pre-throttle, low local concurrency, header adaptation, priority lanes (gate calls preempt backfill) |
| 7 | **Maintenance windows / outages** (FM-16) | ICE maintenance is certain (quarterly release weekends; real incidents ~2h median); naive gates would either halt closings or silently pass stale data | Explicit outage mode: breaker opens, watermark holds, nothing classified as deleted; gates fail closed with a named reason; paced catch-up on recovery |
| 8 | **Webhook loss / blindness** (FM-17) | Delivery is not guaranteed, ordering is not guaranteed, and desktop-client activity may not emit events at all — a webhook-driven design would miss our own ops team's work | Phase 1 is poll-only (D2), so the risk is deferred entirely; if webhooks are adopted in Phase 1.5/2 they remain only an accelerator, polling stays the source of truth, and the hourly event-history reconcile plus a daily subscription-drift read check (D15) detect missed deliveries and ICE's auto-deletion of failing subscriptions |

---

## 8. Staged roadmap

Each stage is independently reversible by env switch; **no stage's safeguards are waivable at go-live** — that waiver is precisely how the ClickUp incident started.

| Stage | What turns on | Exit criteria |
|---|---|---|
| **0 — Provisioning** | Nothing in code. Secret rotated (§6 callout); service user + View-Only persona created; introspection + rejected-write verification passed; ICE questions answered or explicitly risk-accepted | All §6 items checked |
| **1 — Dry run** (`ENCOMPASS_DRYRUN`) | Authenticate, pull a bounded sample, run mapper + matcher, log what *would* happen; no loops, no portal writes | Field coverage verified; no unknown-value storms |
| **2 — Snapshots + crosswalk** | Backfill + incremental sync writing snapshots and link rows only; **no application/borrower columns touched**; review cards for unmatched/conflict | Match-rate acceptable; recon clean; monitoring (§F5 spec) live incl. external dead-man's switch |
| **3 — Enrichment + shadow gates** | COALESCE fill-only mirror columns; gates evaluate and **log** where they would block, without blocking | Shadow-mode results reviewed with the owner; false-block rate understood |
| **4 — Enforced gates** | CTC + condition-agreement blockers live (all three status doors); staleness budgets enforced. **Decommission (Decision D16):** retire or re-label the hand-typed `applications.encompass_status` ClickUp-mirror column and the five manual "check in Encompass" checklist tasks (`db/005_rtl_workflow.sql:74-84`) once their auto-verified equivalents are live | Two consecutive clean weeks; error budget green |
| **5 — Later (each its own decision)** | Optional: portal-file creation from unmatched loans; eFolder content reads; EFC webhook payloads; borrower-facing Encompass surfaces | Separate owner sign-off per item |

Stages 0–5 above are **the roadmap of record** (Decision D5, 2026-07-19); ENCOMPASS-IDEAS-AND-ROADMAP §7 maps its phases onto these stages. IDEAS' Phase-3 write-back candidates (e.g. the eFolder document push, idea L6) are explicitly **out of the roadmap of record**: adopting any of them would require the Guardrails unfreeze ceremony plus owner sign-off — nothing in stages 0–5 writes to Encompass.

Standing rule from day one: **error-budget freeze** — while any Encompass dead-letter or blocking review card is past SLA, only fixes merge, no new integration features (the one control aimed at the demonstrated root cause: velocity over safety).

---

## 9. The document set (cross-references)

| Document | What lives there |
|---|---|
| **ENCOMPASS-INTEGRATION-RESEARCH.md** (this file) | The master plan: scope, principles, architecture summary, risks, roadmap, asks |
| **ENCOMPASS-API-ATLAS.md** | The full 800-request read/write classification, the exact Phase-1 allowlist tables (A–H), suspect GETs, deny tripwires |
| **ENCOMPASS-READONLY-GUARDRAILS.md** | The six enforcement layers (numbered 0–5; source of truth, §2 there) in implementation detail: allowlist design, CI guard suite, read journal, kill switches, frozen-file policy, gate fail-closed rules, monitoring/alerting spec |
| **ENCOMPASS-DATA-MAPPING.md** | Field-by-field Encompass → portal mapping: field IDs, formats, the typed field registry, date/enum handling, PII classes, condition/milestone crosswalks |
| **ENCOMPASS-IDEAS-AND-ROADMAP.md** | The forward-looking backlog beyond Phase 1, with staging and prerequisites per idea |
| **ENCOMPASS-INDUSTRY-LANDSCAPE.md** | How comparable lenders/vendors integrate with Encompass; ICE's platform/commercial direction and what it means for us |

---

## 10. Open questions — the canonical tracker (OQ IDs)

**This section is the single deduplicated open-question superset for the whole document set (Decision D8, 2026-07-19).** Sibling docs keep local lists for reading convenience, but those lists are subsumed by — and cite — the stable IDs below. None of the OPEN items are settled, and several are blockers. Owners in brackets.

**ICE / contract [owner + ICE account manager]**
- **OQ-01** Test/R2T sandbox instance: included in the contract? Cost? Determines whether any development touches production PII (blocker for Stage 1).
- **OQ-02** Rate limits: per-minute limits, actual concurrency ceiling for BE11397907, and who else consumes the shared budget today.
- **OQ-03** Entitlements in writing: standard webhooks, EFC (if ever), concurrency uplift; confirmation that portal enrichment is a sanctioned use; API-user seat billing.
- **OQ-04** Commercial trajectory: any risk the read volume gets steered toward paid products at renewal.

**Legal / compliance [owner + counsel] (from INDUSTRY §8 and Guardrails)**
- **OQ-05** What does YS Capital's **signed** Encompass agreement say about data extraction/replication? (Public partner T&Cs restrict it; the lender-side language was not obtainable.)
- **OQ-06** The **licensed-state list**: which states is YS Capital licensed/lending in? Sets retention floors, exam programs, whether NYDFS 500 applies, and the breach-notice matrix.
- **OQ-07** Consumer count above/below the **5,000-consumer Safeguards Rule small-institution threshold** — determines which written-program elements apply.
- **OQ-08** Who is the **Qualified Individual** signing off on the pulled-field allowlist and the final ≥5-year retention number? (Guardrails Q11.)

**Authentication / provisioning [Encompass super admin + engineering]**
- **OQ-09** Which token-lifetime regime applies (30-min/24-h vs 15-min/2-h)? Does the token response include `expires_in`? (Design is safe under both, but confirm for capacity planning.)
- **OQ-10** Does Regenerate Secret invalidate outstanding tokens? Can a lender hold two API keys for zero-downtime rotation?
- **OQ-11** Exact persona template: how close can we get to "read everything, write nothing," and does the View-Only rule block all v3 write verbs at the API layer? (Verify empirically with a rejected write attempt.)
- **OQ-12** Whether webhook subscription CRUD works under the read-only persona — and whether subscriptions can instead be created by hand in the admin console, eliminating even the future config write. (Relevant only if OQ-26 adopts webhooks.)
- **OQ-13 — RESOLVED (Decision D7, 2026-07-19).** ~~Has any Encompass credential transited an insecure channel?~~ Yes, verified: on 2026-07-17 the owner pasted the Client ID + Client Secret + Instance ID into the task chat; never written to any file, no API call made with it; treated as burned per the `CLAUDE.md` rule. Rotation is step 1 of Stage 0 (§6).

**Instance configuration [Encompass admin + owner]**
- **OQ-14** **The authoritative CTC signal** — milestone name vs. status/custom field. The single most gate-critical mapping decision; the delegated-investor flow ("ctc (4-email)") suggests it may not be a stock milestone.
- **OQ-15** Enhanced Conditions (v3) vs. legacy v1 condition sets — and the mapping to the portal's severity taxonomy (`prior_to_docs` / `prior_to_funding` / `post_closing`).
- **OQ-16** Which milestone template the instance uses, and which portal statuses map to which milestones (`file_intake` and `on_hold` have no obvious LOS equivalent).
- **OQ-17** Are **rate locks** used at all for these loans? (Portal has no lock object; the lock branch may be N/A.)
- **OQ-18** Field-format ground truth: which date/enum fields return which encodings on v1 vs v3 — verify empirically during backfill; never assume symmetric encodings (the ClickUp dropdown lesson).

**Portal / owner decisions [owner]**
- **OQ-19** **The PII minimization memo**: which Encompass borrower fields the portal stores vs. verifies-and-discards — required before the first pull.
- **OQ-20** Is `ys_loan_number` identical to the Encompass loan number, and unique across folders? (Portal enforces partial uniqueness only.)
- **OQ-21 — RESOLVED (Decision D6, 2026-07-19).** ~~Should the Encompass CTC gate also cover the internal-status door and the ClickUp-inbound path?~~ Yes — the gate covers all three doors; the ClickUp-inbound CTC change is not applied locally and lands in the sync review queue with reason `encompass_gate_blocked` (§4).
- **OQ-22** Webhook reality check: which Loan events are actually enabled for this instance, and the event-history retention window (bounds the safe reconcile gap after an outage).
- **OQ-23** Deep-fetch shape: full loan GET vs. curated fieldReader set (payload size, 6 MB response cap behavior) — decide from sandbox samples.
- **OQ-24** Ambiguous endpoints (8, all denied for now): confirm with ICE docs whether `planCodes/{id}/evaluator`, `documentAudits`, EPPS `rateSelector`, `automatedConditions`, and the `recipients` GET have side effects — they stay denied regardless in Phase 1.
- **OQ-25** CI substrate: where the read-only guard suite runs automatically (the repo has no CI today) — the guard must be a real gate, not a convention.
- **OQ-26** **Webhook adoption timing** (per Decision D2): Phase 1 is poll-only; when — if ever — does the owner green-light webhooks as a Phase-1.5/2 accelerator? Explicit owner decision gate; adopting them makes subscription CRUD the one sanctioned config-write category and mandates the daily subscription-drift check (D15).
- **OQ-27** **Auto-verify funded-loan track records?** Should an Encompass-sourced track record from a loan YS itself funded auto-verify, or keep the human sign-off? (Recommendation: keep the human sign-off in Phase 1. IDEAS §9.)
- **OQ-28** **Borrower-facing gating** — hold a condition's "cleared" display until Encompass agrees? (Recommendation: no for Phase 1; the layer stays staff-only. IDEAS §9.)
- **OQ-29** **Outage / fail-closed tolerance duration** — how long may an Encompass outage block clears before the audited override becomes the expected path? This number belongs in the Phase-2 gate. (IDEAS §9.)
- **OQ-30** **Tolerance culture** — exact-to-the-cent (the SOW precedent) vs. cross-system rounding reality for the economics rules. (IDEAS §9.)
- **OQ-31** **Phase-2 live-refresh relaxation** (per Decision D1): the Phase-1 gate evaluator holds no HTTP client and fails closed on stale snapshots; is a bounded refresh-then-decide live call at hard gates ever warranted? Measure retry friction during shadow mode first.

---

_End of master document. Nothing described here is implemented; nothing in Encompass or the repo has been touched. The next concrete step is §6: rotate the burned credential (Decision D7), provision the service user and read-only persona, and get the ICE answers for OQ-01–OQ-04._
