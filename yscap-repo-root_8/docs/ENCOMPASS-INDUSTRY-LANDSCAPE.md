# Encompass Integration — Industry Landscape & Platform Intelligence

_Research pass, 2026-07-17. Status: **research only — nothing implemented.** Read-only throughout: no code written, no Encompass or ICE endpoint contacted, nothing in the repository modified, and no credentials or secrets appear in this document._

_Revision note (2026-07-19): post-critique consistency pass applied (decisions D1–D17)._

This is the "outside world" half of the Encompass research: how the rest of the mortgage industry integrates with Encompass (ICE Mortgage Technology's loan origination system), what the developer community has learned the hard way, what compliance and data-governance norms apply to pulling LOS data, and what licensing/platform risks ICE itself introduces. It synthesizes four dedicated research streams (D1 vendor landscape, D2 developer community, D3 compliance, D4 licensing/platform risk — full findings in the research workflow’s session working files, not committed — their conclusions are folded into this doc), the local **Encompass Developer Connect 26.2 Postman collection** (800 requests), and read-only inspection of the portal codebase at `/home/user/yscap/yscap-repo-root_8`. The companion current-state/architecture doc pattern follows `docs/SHAREPOINT-INTEGRATION-RESEARCH.md`.

---

## 0. Plain-language summary — read this first

Encompass is the filing cabinet where YS Capital's loan files live. Before we build anything that connects the borrower portal to it, we researched four questions: **how does everyone else connect, what goes wrong, what do the rules require, and what does ICE permit or charge for?**

The headline findings, in plain terms:

1. **There are two doors into Encompass.** One is for vendors who sell services to many lenders (appraisals, pricing, verifications) and deliver results *into* the loan file. The other is for the lender itself to work with its own data. We are on the second door — and we only want to **read**. That is a normal, well-trodden path.
2. **The companies that look most like us copy the data out, then serve the copy.** Analytics products and borrower-facing readers all listen for "something changed on loan X" notifications, re-read the loan through the official interface, keep a local copy, and show people the copy — never hitting Encompass live per page load. That is our blueprint, and the portal already runs this exact pattern for ClickUp.
3. **The developer community around Encompass is small and shrinking.** ICE deleted its own developer forum this year; the best community library hasn't shipped since 2021; there is no maintained Node or Python client. So: we write our own thin, read-only connection code, budget for ICE support tickets instead of Google searches, and depend on no one's abandoned library.
4. **The rules treat everything in a loan file as protected personal information — even though our loans are business-purpose.** Business-purpose lending exempts us from some consumer paperwork rules, but data-security rules (FTC Safeguards Rule, all 50 states' breach laws) still apply because guarantors are real people with SSNs and credit reports in the file. The portal already has the right protections (encrypted SSNs, audit log). The biggest governance call is now the **decided launch default** (Decision D3): **do not copy SSNs or dates of birth out of Encompass at all** — match loans by loan number and internal ID instead.
5. **Two things must be confirmed with ICE before a line of code is written.** (a) What our contract includes: API access cost, a test environment, and the premium notification features. (b) Whether ICE's "data replication" terms require written approval for our copy — ICE's public partner terms prohibit building data warehouses without approval, while its own developer guidance *sanctions* API extraction for reporting. Our design threads the needle with a **small, documented list of specific fields** rather than a wholesale mirror — but counsel must read our signed agreement, and §6.6 has a 12-question list for the ICE account manager.

Nothing here commits us to anything. The document ends with the consolidated open questions to be answered — by ICE, counsel, and engineering discovery — before design is frozen.

---

## 1. The two integration rails (and a third, read-only one)

ICE runs two distinct integration platforms. Knowing which rail a vendor rides explains almost everything about how their integration behaves.

| Dimension | **Encompass Developer Connect (EDC)** — *our rail* | **Encompass Partner Connect (EPC)** |
|---|---|---|
| Who it's for | The **lender itself** (or an ISV using the lender's key) building against its own instance | **Service providers/ISVs** (credit, appraisal, title, MI, verifications, docs, pricing) who "build once, use everywhere" |
| Credentials | Lender's own OAuth2 client + a dedicated API user, scoped to one instance (ours: `BE11397907`) | Partner-level credentials issued by ICE; lender "orders a service" |
| Data model | Direct REST access to loans, pipeline, eFolder, conditions, milestones | Order/response transactions, governed by declarative **entitlements** (what data may flow each way) |
| UI surface | None required — headless APIs | Sandboxed iFrame inside Encompass |
| Events | Lender-subscribed **webhooks** (`/webhook/v1/subscriptions`) | EPC lifecycle webhooks, signed with a shared secret |
| Distribution | Private to the lender | Listed in the ICE Marketplace |

The Marketplace's service categories (appraisal, pricing, verifications, docs, title, MI) are all EPC territory — vendors that *write results into* the loan and eFolder. That is the archetype we are deliberately **not** building. EPC still teaches one thing worth stealing: its entitlement model — a hard, declared list of what data flows in each direction. Our "write entitlement" is simply the **empty set**, encoded structurally (a client with no write code paths), not just promised.

A third rail matters as context: **Encompass Data Connect**, ICE's own paid product for near-real-time replication of all loan fields into a lender warehouse or an ICE-hosted Snowflake instance (~3 years of history, automatic schema updates). It is the industry's canonical read-only, one-way Encompass integration — the closest architectural cousin to this project, just implemented by ICE and licensed separately. It also matters commercially: at replication scale, ICE steers customers to Data Connect (§5.3, §6).

---

## 2. Vendor landscape — who connects how

| Category | Vendors | Rail | Direction | The instructive detail |
|---|---|---|---|---|
| Point of sale | Blend, Floify, SimpleNexus, BeSmartee | EDC (lender-issued key) | Bidirectional but **scoped** | Blend's docs say outright it is "**not a full two-way sync**" — it consumes webhooks, **re-reads current state before acting**, and syncs only an enumerated field list. Floify requires a lender-issued key plus a **dedicated non-expiring service account**, and mirrors **Encompass conditions into borrower document requests** — the exact read-direction pattern our portal wants. |
| CRM | Total Expert (Fusion), Jungo, Surefire | EDC | Mostly one-way mapped feeds | Total Expert Fusion maps an explicit field list with a **sync-gate field**: only flagged loans flow at all. Jungo calls the API directly from the lender's Salesforce, no vendor server in the middle. |
| Pricing engines | Optimal Blue, Polly, Lender Price | EPC | Bidirectional (price/lock written back) | The contrast case: canonical EPC citizens writing results into the loan. Not us. |
| Docs & verifications | DocMagic, Truv, The Work Number | EPC + Automated Service Ordering | Order out, results in | Results land in the **eFolder** via document-type mapping — expect vendor-deposited artifacts when we read conditions/documents. |
| Read-only / analytics | Encompass Data Connect, Richey May RM Analyze, Mortgage Coach, RETR | Data Connect / EDC read-mostly | **One-way, replicate-then-serve** | Richey May replicates then reports — dashboards never hit the LOS live. Mortgage Coach pulls loan data via EDC for borrower-facing presentations with no material write-back — the closest well-known product to our shape. |

ICE's own **TPO Connect** (its broker/correspondent web portal) is worth naming: it is ICE's first-party version of "a portal in front of Encompass." YS Capital's borrower portal is functionally a private, borrower-facing analog of TPO Connect — minus the write path.

---

## 3. Integration archetypes — and where this project fits

The vendor study reduces to four archetypes:

1. **Service-transaction partner (EPC)** — order/response, entitlement-governed, writes results into the loan/eFolder (Optimal Blue, Polly, DocMagic, Truv, TWN). *Not us.*
2. **Bidirectional POS/CRM companion (EDC + webhooks)** — Encompass is system of record; the companion listens to webhooks, re-reads state, pushes a small scoped field set back on defined events (Blend, Floify, BeSmartee, SimpleNexus, Jungo). *Half of us — we take the read half only.*
3. **One-way mapped feed (EDC)** — create/update-triggered export of mapped fields, gated by a control flag (Total Expert Fusion, Surefire). *Close.*
4. **Read-only replication / analytics** — a bounded loan-data copy in an external store; the portal/BI reads the copy, never the LOS per page view, and never writes back (Data Connect, Richey May, RETR-style products, Mortgage Coach). ***This is us.***

**Recommended blueprint — archetype 4 implemented with archetype 2's plumbing** (validated against the local 26.2 Postman collection). Phasing note (Decision D2): Phase 1 runs **poll-only** and creates no webhook subscriptions; the webhook plumbing below is the Phase-1.5/2 accelerator, adopted only on an explicit owner decision, with polling remaining the source of truth throughout:

- **Subscribe to Loan webhook events as thin triggers** — `milestone`, `condition`, `fieldchange`/`enhancedfieldchange`, `update`, `move`, `delete`. Payloads are thin references ("loan X changed"), never trusted as data.
- **Re-read via GET-only calls** — `loanPipeline`, `GET /encompass/v3/loans/{id}` with `entities=` subsets, `conditions`, `milestones`, and the V3 `fieldReader` for explicit field lists. Every read the portal's condition/CTC gating needs exists as a read endpoint in the collection.
- **Serve from local Postgres** — the portal and its rule engine read the local copy per page view, never Encompass. This keeps borrower page loads off the shared concurrency budget and isolates the portal from Encompass outages.
- **Backstop with a scheduled pipeline reconciliation sweep** — ICE's own docs warn webhooks "are not guaranteed to be in real-time," and failing subscriptions get auto-deleted (§4.1, lesson 6).

The repo already runs this exact shape against ClickUp: an idempotent pull/ingest processor keyed on an immutable external ID, fed by a live webhook processor plus historical backfill (`src/clickup/ingest.js:1-12`), and a queue worker whose header says "Encompass/Graph targets slot in here behind the same interface later" (`src/sync/queue.js:1-6`). `sync_queue` is already earmarked "ClickUp/Encompass, deferred" (`CLAUDE.md:45`, `README.md:100`). This is reuse, not invention.

### 3.1 Practices to copy from the vendors

1. **Dedicated, non-expiring API service account** with a lender-owned key (Floify's pattern) — a named "portal-encompass-reader" user for clean audit trails.
2. **Webhooks-first, poll-as-reconciliation** (Blend + ICE's own guidance) — never trust the event payload as data; always re-read. (Our Phase 1 takes the polling half alone — Decision D2.)
3. **Explicit, small, versioned field map with a sync gate** (Total Expert, Blend) — enumerate exactly which fields the portal consumes; `fieldReader`/pipeline field lists, never whole-loan dumps.
4. **Entitlement thinking from EPC** — "write entitlement = none," structural: a client exposing only GET plus the POST-shaped reads (`loanPipeline`, `fieldReader`); no PATCH/PUT/DELETE code paths at all.
5. **Local mirror as the serving layer** (Data Connect / Richey May) — failure-isolated, concurrency-friendly.
6. **Idempotent, external-ID-keyed ingest with backfill** — proven in-repo for ClickUp; reuse with the Encompass loan GUID as the immutable key, including `move`/`delete` handling (Blend treats `move` as an archive signal).
7. **Signed webhook endpoint** — verify the `Elli-Signature` HMAC; the premium Custom Auth function is an entitlement question (§6.1).
8. **Condition→borrower-task mirroring** (Floify) — direct precedent for the rule that a portal condition reflects, and clears only in agreement with, the Encompass condition.

---

## 4. Developer community intelligence

A structural finding first: **the Encompass developer community is thin, fragmented, and shrinking.** Stack Overflow holds roughly seven relevant questions *ever*, mostly from the 2017–2018 SDK era. ICE removed its own Developer Forum in the 26.2 site release (forum sunset June 25, 2026), so historical community Q&A is disappearing. The de-facto public knowledge base is the issue tracker of the **EncompassRest** C# library (120 stars; last release April 2021). The only notable Node wrapper (`heythisispaul/EncompassConnect`) is ~5 years stale; **no Python client exists on PyPI**; even ICE's *official* .NET bindings were sunset in January 2022.

**Recommendation:** build a thin in-house GET-only HTTP client (fetch/undici + retry/backoff, read-only allowlist enforced at that layer). Treat community wrappers as design references, never dependencies; mine EncompassRest's issue tracker as the de-facto FAQ before filing an ICE ticket.

### 4.1 Top 10 practitioner lessons, each with its mitigation

| # | Lesson (hard platform fact) | Mitigation |
|---|---|---|
| 1 | **Tokens die fast and quietly** — ICE's own docs state **two conflicting token-lifetime regimes** (a 30-minute window extended by activity within 15 minutes, hard-capped at 24 h — vs a stricter 15-minute-idle / 2-hour-max rule); design for the **stricter** reading. There is **no refresh token**: "refreshing" means re-authenticating with the stored credentials. Expired tokens are the #1 cause of syncs that die mid-day. | One central token manager that re-authenticates before the stricter window closes, never caches a token past its observed validity, retries exactly once on 401, and can verify via token introspection — align with Atlas §2.2 (Decision D12). |
| 2 | **The limit is concurrency, not rate** — default **30 concurrent in-flight calls per lender environment, shared across ALL vendors** on the instance; 429s hit everyone at once. | Route all calls through one queue with a low ceiling (start ≤5); watch `X-Concurrency-Limit-Remaining`; exponential backoff with jitter on 429. |
| 3 | **V1 and V3 are different products** — V1 is a REST wrapper over legacy SOAP with inconsistent IDs; V3 is true REST but parity is incomplete; V1 endpoints are being sunset piecemeal (eFolder attachments in 26.3, loan importer in 26.1). | Default to V3; isolate any unavoidable V1 call behind an adapter; subscribe to the deprecation and breaking-change notice pages. |
| 4 | **Field addressing is a trap** — classic field IDs, pipeline canonical names, and V3 JSON paths don't line up; borrower-pair (`#2`) semantics are buggy; fieldReader reads only the first application. | One config-driven field-mapping table (portal concept → field ID → canonical name), validated at startup against the field-schema endpoint. |
| 5 | **Pipeline queries silently truncate; cursors expire** — 1,000 rows default / 25,000 max with a real silent-truncation report on record; 10-cursor cap; 5-minute idle expiry. | Page briskly with cursors, order by immutable keys, cross-check counts. Only reporting-database fields are pipeline-queryable — custom `CX.*` fields must be added there by the Encompass admin. |
| 6 | **Webhooks are hints, not truth** — thin payloads, retries only 3×20 s with a 30 s callback timeout, and **ICE auto-disables/deletes persistently-failing subscriptions** (the integration can silently go deaf). | Ack in <30 s before processing; verify the `Elli-Signature` HMAC; run a scheduled Events-API + pipeline sweep reconciler that assumes events were missed; once subscriptions exist (Phase 1.5+, Decision D2), a daily subscription-drift read check is mandatory (Decision D15). |
| 7 | **Big loans break responses** — 6 MB API-gateway response cap vs a 40 MB max loan file. A full `?view=entity` pull can simply fail. | Never `?view=entity` in production paths — request `entities=` subsets or fieldReader values; always send `Accept-Encoding: gzip`. |
| 8 | **Custom fields lie subtly** — `dateValue`/`stringValue` duality; values outside the reporting DB are invisible to pipeline queries. | Enumerate custom-field definitions daily; have needed `CX.*` fields added to the reporting DB; validate types on ingest. |
| 9 | **There is no public sandbox** — test capacity is a per-lender provisioned instance, and our stated instance `BE11397907` appears to be **production** (the "test = TEBE-prefix" convention is third-party-reported, unconfirmed officially). | Get a test/R2T instance confirmed before writing code; meanwhile enforce read-only *architecturally*: GET-only client + an API user whose persona has no write rights. |
| 10 | **The community is thin and shrinking** — SO ~7 questions ever; ICE forum deleted; flagship libraries unmaintained since 2021. | In-house docs and runbooks; ICE support tickets as the primary channel; keep the 26.2 Postman collection under version control and refresh each major release. |

One more stability datum: the **SDK sunset** slipped from October 2025 to **December 31, 2026** (feature-frozen November 2025; monthly activity-based fees for "transitional access" from January 2027). The REST APIs are unambiguously the invested platform — but the entire SDK install base is being forced onto them by end-2026, so expect **crowding of the shared 30-call concurrency budget** as vendors migrate.

---

## 5. Compliance & data governance norms

> **Not legal advice.** This section synthesizes public regulatory materials, vendor terms, and industry norms. Final applicability calls — especially business-purpose vs consumer coverage, state licensing, and interpretation of YS Capital's signed ICE agreement — belong with counsel and the compliance owner.

### 5.1 Framing: treat the whole loan file as protected data

Encompass loan-file data is textbook **GLBA NPI** — personally identifiable financial information collected in providing a financial product. YS Capital's business-purpose focus narrows some obligations but not the security ones, because guarantors are individuals whose SSNs, DOBs, and credit reports sit in the file. The industry norm (and the posture the portal already codifies — `db/schema.sql:11` "SSN is encrypted at rest… PII access is audit-logged (GLBA)") is to protect the entire file uniformly rather than litigate record-by-record.

| Regime | Consumer mortgage | Business-purpose (YS Capital) |
|---|---|---|
| TILA / Reg Z | Applies | **Exempt** (12 CFR 1026.3(a)) — but purpose must be documented per loan |
| RESPA / Reg X | Applies | **Exempt** (12 CFR 1024.5) — same caveat |
| ECOA / Reg B | Applies | **Still applies** — business-credit record retention is 12 months (vs 25 for consumer) |
| FCRA | Applies | **Applies** to consumer reports on individual guarantors |
| FTC Safeguards Rule | Applies | **Treat as applying** — the FTC's "financial institution" examples explicitly include mortgage lenders and finance companies |
| GLBA privacy notices | Applies | Counsel question (a pure entity loan arguably has no GLBA "consumer") |
| State breach-notification laws | Apply | **Apply** — keyed to the individual's data, not loan purpose, in all 50 states |

### 5.2 The Safeguards Rule is the controlling baseline

The written information security program must have: a named **Qualified Individual**; a **written risk assessment** updated for this new data flow *before* go-live; access controls, a **data inventory** (examiners expect us to know exactly which Encompass fields land where), **encryption at rest and in transit**, **MFA**, activity **logging**, secure disposal (**within 2 years of last use** absent a documented need), service-provider oversight (ICE is our service provider; our hosting provider holds NPI too); monitoring/testing; training; an incident-response plan; and an annual report to ownership. Since May 2024, breaches of **unencrypted** customer information affecting **≥500 consumers** must be reported to the **FTC within 30 days**. **Encryption is the safe-harbor lever** — federally and in most states — the strongest argument for envelope-encrypting anything sensitive in the mirror with keys held outside the database. (A small-institution carve-out exists below 5,000 consumers; our count is unconfirmed — open question.)

State examiners use the **CSBS Baseline Nonbank Cybersecurity Exam Program** (URSIT-based) and will request, for this integration specifically: the design doc showing read-only architecture, the field inventory, the ICE contract/vendor file, the access-control matrix, and audit-log samples. If NY-licensed, **NYDFS 23 NYCRR 500** applies — its §500.06 audit-trail bar (reconstruct material transactions, records ≥5 years) is the de-facto standard to design to, and the repo already name-checks it (`src/lib/crypto.js:164`).

### 5.3 The critical vendor-terms finding: "data replication" restriction

ICE's public **Encompass Partner Connect API Terms and Conditions** (Rev 09-2018), §3.1(k), prohibits using the APIs — without prior written approval — "for the purposes of **data replication (e.g., data warehouses or analytics repositories)**." Two crucial caveats carry forward:

- Those are the **partner/ISV** terms. YS Capital operates on its own instance under its own Encompass master agreement, whose data-use language **must be checked by counsel** — the ICE agreements page blocks automated fetch and was not reviewable in this research.
- In apparent tension, ICE's own developer guidance ("Loan Data Extracts") **sanctions** Pipeline + Get Loan + field-change webhooks for "reporting, data warehousing, and batch operations" — while steering large-scale replication to the paid **Data Connect** product.

**Design consequence (regardless of how the contract question resolves):** build a **bounded, documented field-allowlist cache** serving defined workflows (condition gating, CTC gating, borrower display) — not a wholesale replica or analytics warehouse. The short, versioned pulled-field list simultaneously answers the ICE-terms risk, the GLBA data-inventory duty, and minimization.

### 5.4 SSN/DOB minimization — the decided launch default (Decision D3, 2026-07-19)

- **Pull no full SSN or DOB from Encompass — this is now the decided launch default (Decision D3):** Tier 3 (the SSN/DOB pull) launches disabled. Match loans/borrowers on Encompass loan GUID + loan number + name/email/address — the non-SSN ladder is primary. If the owner ever enables Tier 3, compute the portal's existing `ssn_hash` HMAC transiently in memory and discard the plaintext — never persist a second encrypted SSN copy under a second lifecycle (`db/044_borrower_history_backfill.sql:10-12`; write chokepoint `src/lib/crypto.js:127-139`).
- **Enforce it server-side too:** Encompass "Persona Access to Field" rules hide denied fields from API responses, so a read-only, field-restricted persona on the API user means the SSN never even leaves Encompass — defense in depth for the "architecturally incapable of misuse" claim.
- Prefer `fieldReader` allowlist calls over `view=full`; exclude credit-report payloads, bank/card numbers, and income-document images from the mirror (documents stay in the eFolder, fetched on demand); strip sensitive fields from logs, exports, and analytics payloads (extend the existing `src/lib/pii-guard.js` / `src/lib/redact.js` pattern to the sync path).

### 5.5 Retention, audit, and evidence

- **Encompass remains the system of record; the portal's Encompass tables are a derived cache** — keep them thin and re-pullable. What the portal must durably retain is **evidence of its own decisions**: "condition X cleared at time T because Encompass snapshot S showed Y" — decision-time snapshots of the exact fields relied on, in the append-only `audit_log` (`db/schema.sql:322-335`), kept ≥5 years (the NYDFS bar comfortably covers typical 3–5-year state loan-file floors; Reg B's 12-month business-credit minimum is subsumed).
- **Caution carried forward:** the "GLBA ≥ 6 years" figure in `docs/SHAREPOINT-SECURITY-COMPLIANCE.md:38` overstates — GLBA imposes no general 6-year retention; the FTC rule pushes the opposite (2-year disposal absent documented need). Derive the Encompass retention schedule from actual state floors + Reg B + business need; do not copy that number.
- Add integration-specific audit actions mirroring the ClickUp write-journal pattern (`db/107_clickup_write_journal.sql`): pull batches, staff views of Encompass-sourced data, gate pass/fail with field snapshots, config and credential changes.

---

## 6. Licensing, entitlements, environments & platform risk

### 6.1 What's included vs. what's entitled

**Base access:** Developer Connect is restricted to Encompass clients. The API key (Client ID + Secret, one per instance) is **self-provisioned by a Super Admin** from the developer portal and grants no extra data rights — the API user's persona bounds everything. No public source prices base API access separately, but **"included with Encompass" is unconfirmed and must be verified contractually.** Several capabilities are demonstrably premium or entitled:

| Capability | Status |
|---|---|
| Webhook subscriptions + HMAC signing key | Standard self-serve |
| **Webhook Custom Auth** | **Premium** — the 26.2 Postman collection itself labels the folder "Webhook Custom Auth - Premium" |
| **Enhanced Field Change (EFC) webhook** (previous + new values) | **Per-instance ICE support-ticket enablement**, R2T instance first, production on a pre-determined change date; requires specific persona rights |
| Concurrency increase above the default 30 | A relationship-manager "**pricing**" discussion |
| Bulk replication | Separate paid product (**Encompass Data Connect**) |
| SDK access after Dec 31, 2026 | Special approval + monthly activity-based fees from Jan 2027 |

**API users and seats — warning (Decision D14): for a LENDER service account, do NOT check Encompass's "API User" flag.** That designation is for **ISV partners**; checking it removes the user's password and **breaks the lender password grant**. Provision a normal service user with an assigned read-only persona, following the Master's §6 provisioning steps (ENCOMPASS-INTEGRATION-RESEARCH) exactly. Third-party sources report API service accounts **count against enabled-user license limits** — *not confirmed in any official ICE source*; verify with the account manager. On grants: ICE docs are explicit that client-credentials "is for ISV partners only" — the sanctioned lender grant is the **password grant** with the dedicated service user (the 26.2 Postman collection includes both flows, which is exactly why the distinction must be enforced, not assumed; Atlas §2.1).

### 6.2 Environments

**No self-serve lender sandbox is publicly documented.** Lenders use purchased test instances and **R2T (Release-to-Test)** instances that receive each major release ~4–8 weeks before production. Whether YS Capital's contract includes one is unknown — and matters doubly, because instance `BE11397907` appears to be **production**: without a test instance, first development would run against live borrower PII (a GLBA and testing risk in itself). The reported "test = `TEBE…` / prod = `BE…`" prefix convention comes from third-party setup guides, not official docs — carried as unconfirmed.

### 6.3 Release cadence and churn

ICE now ships roughly **four major releases per year** (25.1→26.2 observed; 26.3 next), each preceded by an R2T drop. Majors routinely carry **breaking changes** — attribute removals (`fundingFees`, 26.2), null-vs-empty-string semantics on custom fields, default response truncation (26.3) — exactly the silent shifts that could corrupt a condition-matching/CTC-mirroring rules engine that doesn't validate contracts per release. V1 endpoints sunset piecemeal (V1 eFolder attachments in 26.3; V1 loan APIs "will be deprecated over time"). The SDK story is the precedent: ICE retires integration surfaces and attaches fees to legacy access. Countermeasures: **V3-only where parity exists**, contract validation at ingest, regression tests in R2T during the pre-release window, and the deprecation/breaking-change pages on the release checklist.

### 6.4 Support and outages

Standard support is business-hours with 24×7 for production-critical severity; a paid **Premier** tier exists. The Developer Forum's June 2026 sunset makes formal tickets (and the enablement-ticket path used for EFC) the primary channel, with lead times to plan for. Status lives at **ice.com/status** (the old emstatuscenter.elliemae.com redirects there). Third-party trackers show **multiple real outages per year, median ~2 hours**, plus scheduled maintenance and quarterly release weekends. **Design consequence:** rules like "no CTC unless Encompass shows CTC" must define outage behavior — **fail closed for CTC issuance**, but serve cached last-known-good data with explicit "Encompass data as of X" staleness indicators so a 2-hour outage doesn't blind operations. (This is exactly the decided gate design: the gate reads the local snapshot under a 15-minute CTC freshness ceiling and fails closed when stale — Decision D1.)

### 6.5 Condensed risk register

| # | Risk | Mitigation |
|---|---|---|
| R1 | Premium features (EFC, Custom Auth, concurrency uplift) assumed but not entitled — discovered mid-build | Confirm entitlements in writing before design freeze; make EFC an optimization, not a dependency (baseline = standard webhooks + polling fallback) |
| R2 | EFC enablement lead time (ticket → R2T test → scheduled production change date) | File the ticket at project start, not integration time |
| R3 | No test instance → developing against production PII | Confirm/negotiate test-instance entitlement first; read-only persona as the hard backstop |
| R4 | Quarterly breaking changes silently corrupt the condition/CTC rules engine | Release-notes subscription; R2T regression pass each major; schema validation at ingest; fail closed on CTC |
| R5 | Dependence on V1 endpoints that later sunset | V3-only policy; inventory any unavoidable V1 usage with a migration owner |
| R6 | 429s from the shared 30-concurrent-call budget | Low-cadence polling in Phase 1 (webhook-driven sync when adopted, Phase 1.5+ — Decision D2); central queue honoring `X-Concurrency-Limit-*`; ≤80% utilization |
| R7 | Encompass outage while portal rules require live agreement | Cached last-known-good + staleness display; fail-closed CTC; outage runbook |
| R8 | Commercial policy shift (SDK-style retirement/fees on a surface we use) | Internal adapter layer; document API scope at contract renewal; avoid exotic/legacy surfaces |
| R9 | API-user seat cost ambiguity | Ask the account manager; provision exactly one read-only API user |
| R10 | Terms ambiguity on sustained extraction; ICE steers to paid Data Connect | Get written confirmation of the bounded-cache use case; keep volumes modest; price Data Connect as the fallback |

For YS Capital's volume (a private lender with hundreds, not tens of thousands, of active loans), both Phase 1's poll-only cadence — roughly 500–1,750 calls/day, assumptions in Atlas §5 — and a later webhook-driven design sit comfortably inside default limits.

### 6.6 The ICE account-manager question list (ask before building)

1. Is Developer Connect API access **included** in our current Encompass subscription for instance `BE11397907`, or a separate entitlement/SKU? Any per-call, per-loan, or monthly API charges?
2. Does a dedicated **API user** consume a billable seat? Is there a reduced-cost API-only seat class? How many API users are we entitled to?
3. Do we have (or can we get) a **test and/or R2T instance**? Cost, refresh mechanics, and can PII be masked in it?
4. What is required — and what does it cost — to enable (a) the **Enhanced Field Change webhook** and (b) **Webhook Custom Auth**, on both R2T and production? Typical lead times and change dates?
5. What is our instance's current **concurrency limit**, are there per-minute rate limits, who else is consuming the budget today, and what does an increase cost?
6. Provide the **API terms / master-agreement sections** covering programmatic extraction of our loan data into our own borrower database — and confirm our read-only portal use case is permitted without Encompass Data Connect.
7. At what volume/use case would ICE require or recommend **Data Connect** instead, and what is its pricing for a lender our size?
8. Which **support tier** do we have, what are API-incident SLAs, and how do we get advance notice of breaking changes relevant to our endpoints?
9. Confirm the sanctioned **OAuth grant** for a lender-built server integration (password-grant API user vs client credentials), secret-rotation policy, and whether IP allowlisting/mTLS options exist.
10. Are any endpoints we plan to use (V3 loans, pipeline, eFolder/attachments, milestones/conditions, webhooks) scheduled for **deprecation in 26.3/27.x** beyond what's published? Add us to advance-notice communications.
11. During **major-release weekends and maintenance windows**, what API behavior should we expect, and is there a machine-readable maintenance calendar?
12. Any restriction on **retaining Encompass-sourced data** after a loan closes or after an Encompass contract ends (data portability/exit terms)?

---

## 7. Recommended posture (summary)

_This section is a condensed view of the six-layer doctrine (Guardrails §2) — six independent
write-prevention layers, numbered 0–5 (Decision D10); the layers named below are a subset, not the
whole stack._

1. **Archetype:** read-only replication (archetype 4) built on webhook plumbing (archetype 2) — thin events → GET-only re-read → local Postgres → scheduled reconciliation sweep. Phase 1 runs this with polling alone — no subscriptions created (Decision D2); the webhook plumbing arrives at Phase 1.5/2 on owner decision. Reuse the proven ClickUp ingest/queue pattern.
2. **Client:** thin in-house GET-only HTTP client; no community library dependency; one token manager; one concurrency-limited queue; V3-only where parity exists.
3. **Write-block:** GET-only client code, a dedicated API user whose **read-only persona** has no write rights, and field-level persona denies so sensitive fields never leave Encompass — three of the six guardrail layers; the full doctrine is Guardrails §2.
4. **Data:** a bounded, versioned **field allowlist** (no full SSN/DOB, no credit payloads, no document warehousing) — simultaneously the minimization control, the GLBA data-inventory artifact, and the answer to ICE's replication-restriction risk.
5. **Evidence:** decision-time field snapshots in the append-only audit log, retained ≥5 years; integration health telemetry; exam-ready vendor file.
6. **Sequence:** ICE account-manager answers (§6.6) and counsel's read of the signed agreement **before** design freeze; test/R2T instance before code touches production data.

---

## 8. Open questions

_Canonical tracker: Master §10 (OQ-xx IDs); this local list is subsumed (Decision D8)._

Consolidated from all four research streams; none block continued design work, all block build.

**Contract / ICE (owner + account manager)**
1. The full §6.6 list — headline items: base API access included? Test/R2T instance? EFC + Custom Auth entitlement and cost? Concurrency allocation? Data-replication language in *our* agreement?
2. Whether ICE partner-program terms would ever require ISV registration if the portal were offered beyond YS Capital's own instance (today: pure lender use, no Marketplace obligations).

**Legal / compliance (counsel + compliance owner) — not resolved by this research**
3. Which states is YS Capital licensed/lending in? (Sets retention floors, exam programs, whether NYDFS 500 applies, breach-notice matrix.)
4. Consumer count above/below the 5,000-consumer Safeguards small-institution threshold?
5. What does YS Capital's **signed** Encompass agreement say about data extraction/replication? (Public partner T&Cs restrict it; the lender-side language was not obtainable — the agreements page blocks automated fetch.)
6. Is any product line arguably consumer-purpose (e.g., owner-occupied bridge)? If yes, the exemption analysis changes per loan.
7. Who signs off on the pulled-field allowlist? (The SSN/DOB half is decided — Decision D3: none pulled at launch; Tier 3 remains a future owner-enable only.)
8. Cyber-insurance notification requirements (often shorter than statutory) for the incident-response plan.

**Engineering discovery (needs credentials / a test instance — none used in this research)**
9. Which webhook events are actually enabled/licensed on instance `BE11397907` (`enhancedfieldchange` and Custom Auth are premium; `disclosureTracking` is beta) — confirm via `GET /webhook/v1/resources` once credentials exist.
10. Does YS Capital use **Enhanced Conditions** (V3) or legacy conditions (V1)? The portal's condition gating must target the right model — both exist in the collection.
11. Exact field IDs / canonical names for "clear to close" in *this* instance's configuration (org-configurable: milestone name vs field value) — required before the CTC rule can be specified.
12. Actual concurrency/rate allocation for the instance and what other consumers already share it (undocumented volume tiers need an ICE support confirmation).
13. Webhook **ordering and delivery semantics** (at-least-once vs at-most-once) are undocumented — needs empirical testing on a test instance.
14. Can the API user's persona be made strictly read-only while `fieldReader`/`loanPipeline` (POST-shaped reads) still function under it?
15. Is **Encompass Data Connect** cost-effective later for the BI/enrichment half (leaving Developer Connect for low-latency condition/CTC gates), given actual loan volume?

**Unverified claims carried forward deliberately** (do not treat as fact): base API access "included with Encompass"; API users consuming billable seats (third-party sources only); the `TEBE`/`BE` instance-prefix convention (third-party setup guides only, and therefore also the production status of `BE11397907` — highly likely, not officially confirmed).

---

## 9. Sources

Every external URL cited across the four research streams, grouped. Local sources: the 26.2 Developer Connect Postman collection (800 requests) and its generated endpoint index (session working file, not committed); read-only inspection of `/home/user/yscap/yscap-repo-root_8`.

### ICE / Encompass official — Developer Connect docs
- https://developer.icemortgagetechnology.com/developer-connect/docs/welcome
- https://developer.icemortgagetechnology.com/developer-connect/docs/overview
- https://developer.icemortgagetechnology.com/developer-connect/docs/authentication
- https://developer.icemortgagetechnology.com/developer-connect/docs/api-user-isv-partner
- https://developer.icemortgagetechnology.com/developer-connect/docs/get-an-api-key
- https://developer.icemortgagetechnology.com/developer-connect/docs/concurrency-limits
- https://developer.icemortgagetechnology.com/developer-connect/docs/response-payload-size-limit
- https://developer.icemortgagetechnology.com/developer-connect/docs/loan-size-limit
- https://developer.icemortgagetechnology.com/developer-connect/docs/ka-large-loan-sizes-251-r2t
- https://developer.icemortgagetechnology.com/developer-connect/docs/v1-vs-v3-encompass-apis-whats-the-difference-1
- https://developer.icemortgagetechnology.com/developer-connect/docs/sdk-to-api-migration-getting-started-guide
- https://developer.icemortgagetechnology.com/developer-connect/docs/deprecation-notices
- https://developer.icemortgagetechnology.com/developer-connect/docs/breaking-change-notices
- https://developer.icemortgagetechnology.com/developer-connect/docs/webhook-subscriptions
- https://developer.icemortgagetechnology.com/developer-connect/docs/efc-webhook-how-to-enable
- https://developer.icemortgagetechnology.com/developer-connect/docs/efc-webhook-user-setup-guide
- https://developer.icemortgagetechnology.com/developer-connect/docs/efc-webhook-access-controls-to-data
- https://developer.icemortgagetechnology.com/developer-connect/docs/ucm-loan-data-extracts
- https://developer.icemortgagetechnology.com/developer-connect/docs/encompass-loan-data-dictionary-guide
- https://developer.icemortgagetechnology.com/developer-connect/reference/webhook
- https://developer.icemortgagetechnology.com/developer-connect/reference/wbhks-re-cat-loan
- https://developer.icemortgagetechnology.com/developer-connect/reference/signing-keys
- https://developer.icemortgagetechnology.com/developer-connect/reference/loan-pipeline
- https://developer.icemortgagetechnology.com/developer-connect/reference/get-field-schema-1
- https://developer.icemortgagetechnology.com/developer-connect/changelog/release-notes-log
- https://developer.icemortgagetechnology.com/developer-connect/changelog/251-major-release
- https://developer.icemortgagetechnology.com/developer-connect/changelog/253-major-release
- https://developer.icemortgagetechnology.com/developer-connect/changelog/261-major-release

### ICE / Encompass official — Partner Connect, products, terms, support, status
- https://docs.partnerconnect.elliemae.com/partnerconnect/docs/what-is-encompass-partner-connect
- https://docs.partnerconnect.elliemae.com/partnerconnect/docs/how-does-epc-work
- https://docs.partnerconnect.elliemae.com/partnerconnect/docs/transaction-fulfillment
- https://docs.partnerconnect.elliemae.com/partnerconnect/docs/webhooks
- https://docs.partnerconnect.elliemae.com/partnerconnect/docs/documents-delivery
- https://docs.partnerconnect.elliemae.com/partnerconnect/docs/inbound-document-mapping
- https://docs.partnerconnect.elliemae.com/partnerconnect/docs/what-do-i-need-to-get-started
- https://mortgagetech.ice.com/products/encompass
- https://mortgagetech.ice.com/products/encompass-data-connect
- https://mortgagetech.ice.com/products/encompass-tpo-connect
- https://mortgagetech.ice.com/products/marketplace
- https://mortgagetech.ice.com/partners/industry-service-provider-partners
- https://mortgagetech.ice.com/partners/solution-provider-partners
- https://mortgagetech.ice.com/publicdocs/mortgage/encompass-partner-connect-api-terms-and-conditions.pdf
- https://mortgagetech.ice.com/agreements
- https://mortgagetech.ice.com/support
- https://icemortgagetechnology.com/support/technical-support
- https://mortgagetech.ice.com/explore/encompass-sdk-and-legacy-integrations-transition
- https://mortgagetech.ice.com/explore/encompass-legacy-service-ordering-and-sdk-transition-deadline-october-31-2025
- https://www.ice.com/status (redirect target of https://emstatuscenter.elliemae.com/)

### Vendor documentation & announcements
- https://help.blend.com/support/solutions/articles/156000371700-loan-updates
- https://help.blend.com/support/solutions/articles/156000371699-application-sync
- https://www.kensiemaellc.com/product/blend
- https://help.floify.com/hc/en-us/articles/360042244091-Encompass-Developer-Connect
- https://help.floify.com/hc/en-us/articles/360056854832
- https://help.floify.com/hc/en-us/articles/360041825392
- https://help.floify.com/hc/en-us/articles/7745936627853
- https://investor.ncino.com/news-releases/news-release-details/simplenexus-ncino-company-announces-new-integration-empower
- https://www.globenewswire.com/news-release/2023/08/01/2715701/0/en/
- https://www.prweb.com/releases/besmartee_announces_integration_with_encompass_by_ellie_mae/prweb16139308.htm
- https://totalexpert.freshdesk.com/support/solutions/articles/22000286617-encompass-best-practices
- https://totalexpert-trainingteam.s3.us-east-2.amazonaws.com/TE_Encompass/Fusion-+Encompass+Feature+and+Configuration+Guide.pdf
- https://ijungo.com/los-sync/
- https://ijungo.com/encompass-api-admin-instructions/
- https://www.topofmind.com/integrations/encompass/
- https://www.capterra.com/p/202529/Surefire-CRM/reviews/
- https://engage.optimalblue.com/digital-hub-epc
- https://www2.optimalblue.com/api
- https://appraisalbuzz.com/optimal-blue-now-integrated-with-ellie-maes-encompass-lo-connect/
- https://polly.io/media/polly-continues-to-strengthen-its-ice-mortgage-technology-partnership/
- https://lenderprice.com/lender-price-enhances-its-ppe-integration-with-ellie-mae/
- https://www.docmagic.com/support/kbase/docmagic-online/1499
- https://truv.com/mortgage-lending/los-integrations/encompass
- https://truv.com/blog/truv-announces-integration-with-encompass-tpo-connect-to-streamline-wholesale-and-correspondent-lending
- https://docs.truv.com/docs/encompass-integration-guide
- https://theworknumber.com/all-press/-/story/the-work-number-enhances-instant-verifications-service-leveraging-ice-mortgage-technology-s-encompass-platform
- https://www.prnewswire.com/news-releases/the-work-number-enhances-instant-verifications-service-leveraging-ice-mortgage-technologys-encompass-platform-301469181.html
- https://richeymay.com/resource/articles/rm-analyze-connects-to-the-systems-you-use/
- https://www.domo.com/news/press/domo-partners-with-richey-may
- https://www.hometownstations.com/news/national/mortgage-coach-announces-integration-with-ice-mortgage-technology-enabling-lenders-to-deliver-accurate-loan-comparisons/article_a8936b48-64e3-54ab-abb9-f526e187313f.html
- https://trustengine.com/mortgage-coach/mc-encompass/
- https://www.prnewswire.com/news-releases/ellie-mae-announces-new-data-delivery-method-encompass-data-connect-now-includes-a-hosted-delivery-choice-301069872.html
- https://support.proof.com/hc/en-us/articles/1500003014402-Set-Up-API-Users-in-Encompass
- https://www.stitchflow.com/user-management/encompass/api

### Developer community, open source, practitioner blogs
- https://github.com/EncompassRest/EncompassRest
- https://github.com/EncompassRest/EncompassRest/wiki/Retrieving-Loan-Data
- EncompassRest issue tracker (the de-facto community FAQ) — issues cited: #77, #83, #117, #120, #164, #189, #191, #212, #217, #275, #286, #302, #303, #338, #360, #363, #372, #376, #390, #401, #408, #427 (all under https://github.com/EncompassRest/EncompassRest/issues/)
- https://github.com/heythisispaul/EncompassConnect · https://www.npmjs.com/package/encompassconnect · https://heythisispaul.github.io/EncompassConnect/index.html
- https://github.com/intercontinentalexchange/imt-developerconnect-dotnet-bindings
- https://github.com/novus-home-mortgage/encompass-deploy
- https://github.com/welch-ja/CommunityPlugin
- https://github.com/api-evangelist/encompass-developer-connect
- https://github.com/richie-rk/EncompassRest-RAG-Assistant
- https://pypi.org/ (negative search evidence: no maintained Encompass client)
- https://stackoverflow.com/questions/43456273/get-field-data-outside-of-reporting-database-using-encompass360-sdk
- https://stackoverflow.com/questions/53669491/how-to-query-loans-with-custom-field-in-encompass
- https://qualityexcellence.info/blog/2022/12/04/developer-connect-postman-and-first-api-call/
- https://awesometechinc.com/what-is-encompass-developer-connect/
- https://awesometechinc.com/what-is-encompass-partner-connect
- https://awesometechinc.com/encompass-sdk-to-api-step-by-step-migration/
- https://mortgageworkspace.com/blog/exploring-api-integrations-for-encompass-whats-possible-in-2025
- https://www.valuelinksoftware.com/what-is-encompass-partner-connect-epc/
- https://www.valuelinksoftware.com/prepare-for-the-encompass-sdk-sunset/

### Trade press & industry news
- https://www.housingwire.com/articles/ice-delays-encompass-sdk-transition-until-end-of-2026/
- https://www.housingwire.com/articles/ice-mortgage-technology-encompass-sdk-to-api-transition-2025/
- https://www.housingwire.com/articles/37918-ellie-maes-tpo-connect-allows-seamless-collaboration-with-lenders/
- https://www.housingwire.com/articles/retr-mortgage-technology-hires-heidi-iverson-anthony-savala/
- https://www.nationalmortgagenews.com/news/ice-mortgage-technology-pushes-sdk-sunset-to-end-of-2026
- https://www.nationalmortgagenews.com/news/ice-mortgage-technology-to-sunset-encompass-sdk
- https://www.scotsmanguide.com/news/ice-mortgage-technology-adds-grace-period-after-encompass-sdk-sunset-date/
- https://lendertoolkit.com/encompass-sdk-and-epc-transition-deadlines-extended-to-december-31-2026/
- https://www.fintechfutures.com/press-releases/ice-launches-mortgage-insurance-center-for-encompass-digital-lending-platform-with-integrations-to-all-major-mi-providers

### Outage / status trackers
- https://isdown.app/status/ice-mortgage-technology/encompass
- https://isdown.app/status/ice-mortgage-technology/incidents/429112-encompass-web-version-is-experiencing-issues
- https://statusgator.com/services/ellie-mae

### Regulatory, legal & standards (compliance stream — not legal advice)
- https://www.ftc.gov/business-guidance/resources/ftc-safeguards-rule-what-your-business-needs-know
- https://www.ftc.gov/business-guidance/resources/how-comply-privacy-consumer-financial-information-rule-gramm-leach-bliley-act
- https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-314
- https://www.ftc.gov/news-events/news/press-releases/2023/10/ftc-amends-safeguards-rule-require-non-banking-financial-institutions-report-data-security-breaches
- https://www.ftc.gov/business-guidance/blog/2024/05/safeguards-rule-notification-requirement-now-effect
- https://www.federalregister.gov/documents/2023/11/13/2023-24412/standards-for-safeguarding-customer-information
- https://www.fdic.gov/consumer-compliance-examination-manual/viii-1-gramm-leach-bliley-act-privacy-consumer-financial
- https://www.consumerfinance.gov/rules-policy/regulations/1026/3/
- https://www.consumerfinance.gov/rules-policy/regulations/1024/5/
- https://www.ecfr.gov/current/title-12/chapter-X/part-1002/subpart-A/section-1002.12
- https://www.californiamortgageassociation.org/2024/02/29/the-cfpbs-recent-amicus-brief-on-business-purpose-loans-what-you-need-to-know/
- https://www.dosslaw.com/doss-guides/business-purpose-exemption-simplified/
- https://www.csbs.org/nonbank-cybersecurity-exam-programs-0
- https://www.csbs.org/newsroom/csbs-releases-nonbank-cybersecurity-exam-procedures
- https://www.csbs.org/sites/default/files/2023-06/Baseline%20Nonbank%20Exam%20Program%20V1.1%20-%20FINAL-6-30-2023.pdf
- https://www.csbs.org/sites/default/files/2022-08/Nonbank%20Exam%20Programs%20Summary%20-%20Industry.pdf
- https://www.mayerbrown.com/en/insights/publications/2022/10/cybersecurity-examination-guidance-for-nonbank-financial-services-companies
- https://www.dfs.ny.gov/system/files/documents/2019/02/dfsrf500txt.pdf
- https://www.law.cornell.edu/regulations/new-york/23-NYCRR-500.6
- https://doa.mt.gov/BFID/mortgage-consumer-finance/MLguide
- https://www.law.cornell.edu/regulations/maryland/COMAR-09-03-06-05
- https://codes.ohio.gov/ohio-administrative-code/rule-1301:8-2-04
- https://dre.ca.gov/files/pdf/re7.pdf
- https://www.mismo.org/standards-resources/mismo-product/mismo-version-3-4
- https://singlefamily.fanniemae.com/learning-center/delivering/faqs-uniform-residential-loan-application-uniform-loan-application-dataset
- https://singlefamily.fanniemae.com/delivering/uniform-mortgage-data-program/uniform-loan-delivery-dataset
- https://sf.freddiemac.com/tools-learning/uniform-mortgage-data-program/ulad
- https://sf.freddiemac.com/tools-learning/uniform-mortgage-data-program/uldd
- https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-122.pdf
- https://www.corbado.com/blog/ftc-safeguards-rule-mfa-compliance
- https://www.ncsl.org/technology-and-communication/security-breach-notification-laws
- https://privacyrights.org/resources-tools/reports/data-breach-notification-laws-50-state-survey-2026-edition
- https://www.justia.com/consumer/identity-theft/security-breach-notification-laws-50-state-survey/
- https://www.jacksonlewis.com/insights/state-data-breach-notification-laws-overview-patchwork
- https://www.gtlaw-dataprivacydish.com/2021/07/financial-institution-confusion-are-financial-institutions-fully-exempt-from-the-ccpa-cpra-vcdpa-and-cpa/
- https://www.orrick.com/en/Insights/2025/07/Where-is-the-GLBA-Entity-Level-Exemption-Two-More-State-Privacy-Laws

### Encompass profile / pricing context
- https://www.softwareadvice.com/product/133471-Encompass360/
