# Encompass Integration — Idea Catalog & Staged Roadmap

_Research pass, 2026-07-17. **Status: research only — nothing implemented.** Strictly read-only design:
the portal will be able to READ from Encompass, never write to it. No credentials appear in this
document. Where a source finding was uncertain, the uncertainty is carried forward explicitly in §9._

_Revision note (2026-07-19): post-critique consistency pass applied (decisions D1–D17)._

This is the "research before we build" deliverable for connecting the PILOT portal to Encompass —
what a read-only feed makes possible (idea catalogs from four research streams, merged and
de-duplicated), the design of the rule layer that makes "the portal can't say clear-to-close unless
Encompass agrees" real, what to build first, the staged roadmap with go/no-go tests, and — just as
important — the short list of things we will **never** build.

---

## 0. Read this first — the whole plan in plain words

Encompass is the loan operating system where YS Capital's files actually live. Today the portal only
hears about Encompass second-hand: a staffer reads Encompass, types a status into a ClickUp
dropdown, and the sync copies that text over (`db/047_clickup_extra_fields.sql:25`). That is hearsay,
not evidence.

The plan is to give the portal its own **read-only window** into Encompass — like a security camera
pointed at the source of truth. The camera can see everything; it cannot touch anything. With that
window we can:

1. **Recognize returning customers** the moment they apply, and pre-fill what we already know.
2. **Stop mistakes before they happen** — the portal refuses to mark a file "clear to close," or to
   sign off a mapped condition, unless Encompass actually agrees. A human can always override, with a
   reason, and every override is recorded.
3. **Save staff the tab-switching** — one dashboard shows the portal and Encompass side by side, a
   closing-week "war room" screen shows everything about files closing this week, and staff get a
   note when a loan hits a new milestone.
4. **Eventually show borrowers an honest "where is my loan?" timeline** — using our own friendly
   wording, never Encompass's internal text.

Three promises shape everything (§2): the software is **built so it physically cannot write** to
Encompass; **nothing is ever cleared, closed, or changed automatically** — Encompass agreement only
*unlocks* a human's normal, audited action; and the system is **quiet by default** — badges and
one daily digest, not a flood of alerts. The lesson is from our own history: the two-way ClickUp
sync suffered **16 forensically-reconstructed incidents in 9 days — the first corruption 32
minutes after go-live**; even the one-way SharePoint mirror needed 6 documents and a no-delete
policy (`CLAUDE.md:105-117`). That history is why this integration is read-only. Encompass is a
regulated system of record — so we take only the safe half: read, mirror, verify, suggest.

**Quick wins** (small builds, visible value — marked ⭐QW throughout): the side-by-side pipeline
dashboard, the daily mismatch report, staff milestone notifications, the closing-week war room, the
repeat-borrower banner at intake, and the "stated vs. actual experience" cross-check.

---

## 1. Where this sits in the industry (so we're not inventing anything exotic)

The vendor-landscape research (D1) confirms YS Capital is on the **Encompass Developer Connect**
rail — the lender's own API against its own instance — and that the shape we want has a large,
well-established family:

| Archetype | Examples | Us? |
|---|---|---|
| Service partner writing results into the loan (EPC rail) | Optimal Blue, Polly, DocMagic, Truv, The Work Number | **No — deliberately the opposite of us** |
| Bidirectional POS/CRM companion (webhooks + scoped write-back) | Blend, Floify, SimpleNexus, BeSmartee | Half of us — we take the **read half only** |
| One-way mapped feed with a sync-gate flag | Total Expert Fusion, Surefire | Close |
| **Read-only replication → serve from a local copy** | ICE's own Encompass Data Connect, Richey May RM Analyze, Mortgage Coach | **This is us** |

Two industry practices worth copying verbatim: Blend consumes webhooks as *thin triggers* and
**re-reads current state before acting** ("not a full two-way sync" — an enumerated field list
only); Floify runs on a **dedicated, non-expiring service account** with a lender-owned API key so
the audit trail is clean. ICE's own guidance is webhooks-first with polling as reconciliation (for
Phase 1 we take the polling half alone — Decision D2), and the instance's API concurrency budget (~30 concurrent calls, shared with every other consumer) is a
real reason to serve every portal page from a **local Postgres mirror**, never from live Encompass
calls per page view. The repo anticipated all of this: the sync worker was designed so
"Encompass/Graph targets slot in here behind the same interface later" (`src/sync/queue.js:4-5`),
and `sync_queue.target` already admits `'encompass'` (`db/schema.sql:306`).

---

## 2. Hard boundaries and the simplicity filter

### 2.1 The three anti-goals (non-negotiable)

1. **No writes to Encompass — architecturally.** A key technical finding repeated across all
   streams: several essential Encompass *reads* are HTTP POSTs (`loanPipeline`, `fieldReader`,
   selectors, `auditTrail`), so "GET-only" verb filtering is **not** a sufficient guarantee. The
   read-only client must enforce an **endpoint-path allowlist**; nothing outside the list can be
   called, whatever the verb. The rules engine goes further: the request-path evaluator holds **no
   HTTP client at all** — it reads only local mirror tables (F4 §1; settled — Decision D1).
2. **No auto-clearing of conditions, ever — in either direction.** Encompass showing "Cleared"
   never clears a portal condition; it lights a green "Ready to clear — Encompass agrees" chip that
   opens the *normal, audited human sign-off*. A portal clear never touches Encompass (no write path
   exists). Encompass drift never silently reopens a portal condition either — it produces a review
   row and a one-click `pushBack` offer for a human (F4 §4.3, §5.5).
3. **No noisy alerts.** Digest-over-drip; at most ~5 rules ever hard-block; one chip per file
   screen; notifications fire only on state transitions, deduped and capped. A rule that would fire
   on >20% of active files is treated as a **rule defect**, not a user problem (E2 §6).

### 2.2 The five-question simplicity filter (from E4 — every idea must pass all five)

1. **One-sentence test** — can the owner explain it to a borrower or LO in one plain sentence?
2. **Direction test** — does data still flow one way, Encompass remaining sole source of loan truth?
3. **Failure-mode test** — when it breaks, does it degrade to *"information temporarily missing"*
   (acceptable) or *"a wrong action was taken / wrong fact shown"* (unacceptable)?
4. **Ceremony-budget test** — is the guard machinery smaller than the feature? (The ClickUp sync
   failed this in hindsight.)
5. **Ongoing-care test** — does it add a new queue/reconciler someone must babysit forever?

A repo-specific corollary: **never render a raw Encompass string to a borrower.** Encompass
milestone names, condition titles, and comments can embed the capital-partner names that are banned
from every borrower-facing surface (`CLAUDE.md` hard rule; the `notify.js:143-160` scrub is the
backstop, not the plan). Every borrower-facing feature uses a portal-owned label map.

---

## 3. Foundations everything shares (build once)

| Foundation | What it is | Key precedent in the repo |
|---|---|---|
| Read-only Encompass client | Endpoint-**path** allowlist (POST-as-read endpoints included); dedicated service account; every call journaled | Journaling standing rule, `docs/OBSERVABILITY.md:3-8` |
| Local mirror tables | Canonical schema per DATA-MAPPING §2.1 (Decision D4): `encompass_loan_index` (crosswalk), `encompass_snapshots` (append-only raw JSONB per loan per fetch, stamped `fetched_at`), `encompass_pull_log` (the read journal), `encompass_gate_log` (gate evidence). Typed convenience projections (conditions/milestones mirrors) are **optional implementation detail**, never separate sources of truth. Incremental pulls on `Loan.LastModified`; all Encompass-derived data stays in `encompass_*` side tables that borrower routes never select from | Avoids the S2-04/S2-06 "send-everything-then-hide" leak surfaces — `GET /applications/:id` (the `SELECT a.*` full-row response) and the track-record `SELECT t.*` response in `src/routes/borrower.js` |
| Loan ↔ file linkage | Binding lives in `encompass_loan_index.application_id` **only** (Decision D4) — no new column on `applications` in Phases 1–2; match state is the 7-state enum in DATA-MAPPING §2.1, and links are **suggested by machine, confirmed by staff** (gates require match state ∈ {auto_matched, manual_confirmed}) | Modeled on `db/081_borrower_dedup_candidates.sql` |
| Identity matching | Launch matching runs **without SSN/DOB** (Tier 3 pull disabled — Decision D3): ys_loan_number ↔ Encompass Loan Number, canonical address + last name, name/entity + amount/date corroboration; the SSN-hash key becomes available only if the owner ever enables Tier 3. Email needs corroboration (phone/full name — never surname alone, the 2026-07-15 family-shared-email lesson) | `src/clickup/identity.js:113-142`, `resolveBorrower` in `src/clickup/ingest.js` |
| Refresh transport | Phase 1 is **poll-only — decided** (Decision D2, 2026-07-19): no webhook subscriptions are created, so Phase 1 performs **zero** Encompass writes of any kind, platform-config included. Webhooks are the Phase-1.5/2 accelerator behind an explicit owner decision (§9 Q3: when/whether); when adopted, subscription CRUD is the one sanctioned config-write category (admin-credential, out-of-band — Atlas §10.2) and polling remains the source of truth | Blend/ICE webhooks-first pattern reserved for Phase 1.5/2+ |
| Provenance & freshness | Every derived row/flag carries source loan GUID + `fetched_at`; UI always shows "as of …" so staff never mistake a cache for live truth | Guard #16: "staleness is a number, shown once" (`docs/SYNC-GUARD-MATRIX.md`) |

---

## 4. The idea catalog (merged and de-duplicated)

Legend: **Value** to the business · **Difficulty** S/M/L (assuming §3 foundations exist) ·
**Risk** = worst realistic failure · **Checkpoint** = the human-review gate that contains it.
⭐QW = quick win. Cross-stream duplicates are merged; the merge notes say what was folded in.

### 4a. Borrower intelligence (from E1)

| # | Idea | Value | Diff | Risk | Manual-review checkpoint |
|---|---|---|---|---|---|
| B1 ⭐QW | **Repeat-borrower banner at intake** — match new leads against a cached Encompass borrower index; staff-only banner "Likely repeat borrower — N prior YS loans" | High: instant known-customer context; it *is* the identity join everything else uses | S–M | False match leaks another person's history and mis-prices the deal | Banner is suggestion-only; staff confirm/reject; only a confirmed verdict creates a durable link |
| B2 ⭐QW | **Auto-built track records from closed YS loans** — generate *unverified*, provenance-stamped `track_records` rows from our own funded Encompass loans | High: kills the biggest borrower friction (re-typing deals we funded) | M | Wrong link propagates someone else's deal; duplicates inflating counts | Rows land `is_verified=false`; verification stays a human sign-off. **Caveat carried forward:** Encompass proves a deal's *entry*, but the 36-month experience window keys on the *exit* (`src/lib/experience.js:13-18`) — exit stays blank (counts toward nothing, safe by default) unless payoff data exists (§9 Q6) |
| B3 ⭐QW | **Stated-vs-actual experience cross-check** — claimed `requested_exp_*` vs. Encompass-funded count, staff-only panel | High: hardens the funding gate; also catches *understated* experience (a sales win) | S | Encompass only sees YS-funded deals — must present as a **floor**, never proof of lying | Divergence creates an `[auto]` note/review row; never auto-fails a condition or changes counts |
| B4 | **Pre-filled applications for repeat borrowers** | High: conversion + fewer typo-born duplicates | M | Pre-filling from a mismatched person = direct PII leak — worst failure in this catalog | Only after a **staff-confirmed** link; blank-fields-only; borrower re-attests every field; all pre-fills audit-logged |
| B5 | **Entity/LLC relationship graph** (vesting entities + borrower pairs merged with portal `llcs`) | High for risk/dedup ("these two 'unrelated' applicants share an entity") | L (entity-name canonicalization is the hard part; phase table-based flags before a visual graph) | Generic LLC names collide; over-reading the graph | Entity merges go through a review queue; unreviewed matches render as dashed "possible" edges, never fact. Staff-only forever |
| B6 | **Borrower risk flags** (fallout, stalls, early-payoff history) | Med–High: institutional memory; EPO penalties are real money | L (M for fallout-count-only) | Mislabeling — a loan can "fall out" for reasons that aren't the borrower's; fair-lending optics | Advisory badges with drill-down to evidence, never auto-gates; any flag influencing a decline must be human-confirmed on the file. Depends on how YS marks fallout in the instance (§9 Q6) |
| B7 | **Concentration analytics** (top sponsor groups by exposure) | Med–High: "one sponsor is 14% of the book" | M (L with entity rollups) | Garbage-in: unresolved duplicates *understate* concentration | Dashboard shows a data-quality banner linking to the unresolved-link queues; no automation hangs off it |
| B8 | **Borrower-360 staff timeline** (portal + ClickUp + Encompass events in one feed) | Med: context without tab-switching | S–M once B1's cache exists | Raw Encompass text leaking internal names | Field allowlist rendering only; confirmed links only |
| B9 ⭐QW | **Encompass as dedup oracle** — enrich the existing `borrower_dedup_candidates` resolution UI with each side's Encompass matches | Med: turns undecidable email-share cases decidable | S | An Encompass contact can itself be a duplicate | Unchanged: human records the verdict; merge stays manual |
| B10 | **Dormant repeat-borrower reactivation list** | Med (marketing) | S | Contacting people about history they don't associate with YS | LO reviews the list; no automated borrower email from this feature |

### 4b. Verification gates & rules (from E2 — summarized; full ~35-rule catalog in the E2 findings)

The rule layer is the headline feature. E2 cataloged ~35 rules in 10 families; each specifies its
trigger point, Encompass evidence, severity, staleness behavior, and override path:

| Family | Theme | Example rules | Default severity |
|---|---|---|---|
| A | Condition parity | A1: a **mapped** portal condition cannot be signed off unless its Encompass twin is Cleared/Waived; A5 (the helpful inverse): "Encompass cleared this — mark it here?" one-click into normal sign-off | A1 BLOCK (ships as warn); A5 positive NOTICE |
| B | CTC / milestone gates | B1: portal cannot move to `clear_to_close` unless Encompass shows CTC — enforced at **all three doors** (status PATCH, internal-status, and ClickUp-inbound mirroring, where a blocked change is not applied locally and lands in sync review with reason `encompass_gate_blocked` — Decision D6); B2: the celebratory borrower CTC **email** holds until B1 passes | BLOCK |
| C | Economics tolerance | Loan amount / rate / budget within tolerance ($1 money, 0.001 rate) | NOTICE, escalating to CONFIRM at CTC |
| D | Dates | Closing-date edits contradicting Encompass; D4: Encompass closing moved after CTC → one deduped LO notification | CONFIRM / NOTICE |
| E | Rate locks | E1: `funded` blocked while the Encompass lock is expired | BLOCK — **ships disabled until discovery confirms YS actually uses the lock desk** (§9 Q5) |
| F | Stage drift | Portal stage vs. Encompass milestone crosswalk; F2 helper: "Encompass shows this file further along — update?" | NOTICE / SILENT |
| G | Regression detection | G1 condition reopened in Encompass after portal sign-off; G2 CTC revoked | NOTICE / CONFIRM + targeted LO note |
| H | eFolder parity | H2 helper: "Encompass already has an appraisal dated Jul 14" while the portal item is outstanding | NOTICE (positive) / SILENT |
| I | Linkage sanity | I0: CTC on an unlinked file is blocked (nothing to verify against); I3: one Encompass loan ⇔ one active portal file | BLOCK at link/CTC |
| K | Post-closing | Trailing-doc parity via the same engine | CONFIRM / NOTICE |

Design center: **quiet by default** — only ~5 rules ever hard-block (A1, B1/B2, E1 if locks are
real, I0/I3); everything else is a chip, a dashboard row, or silence. The layer *gives before it
takes*: the helpful rules (A5, F2, H2) ship first so staff see it saving clicks before it ever
blocks anything. Severity, tolerance, and staleness are **registry config, not code**, so the owner
can promote/demote any rule without a deploy.

**The mismatch dashboard** (merges E3's daily reconciliation report, idea O2 below): a per-file
"Encompass agreement" chip (green "In agreement (as of 10:42)" / amber "3 things to look at") plus a
global drift screen. Rows **auto-close on agreement** (nobody cleans stale cards), dismissals are
value-aware sticky (an ignored $500 gap stays ignored; a new $2,000 gap respawns — guard #67), and
high-stakes rows are per-row only, never bulk (guard #64).

**Override design:** every hard block has exactly one door — a new `override_encompass_gate`
capability, a **required reason**, three audit writes (audit log, evidence row, `forced` history
flag), value-aware re-arming if Encompass's value changes again, and a weekly override digest so
"everyone overrides rule X daily" reads as *fix rule X*, not silence.

### 4c. Ops automation (from E3)

| # | Idea | Value | Diff | Noise risk | Notes / checkpoint |
|---|---|---|---|---|---|
| O1 ⭐QW | **Side-by-side pipeline dashboard** — portal status vs. Encompass milestone, amounts, dates, condition counts, delta cells highlighted | High — and it's the trust-builder that validates the loan↔file linkage everything depends on | S–M | None (pull UI) | One batch `loanPipeline` query powers it |
| O2 ⭐QW | **Daily reconciliation mismatch report** → review-queue rows + one admin email | High — the operational backbone of the "Encompass must agree" gates; safety net for poller bugs | M | Low (one capped email/day; acknowledged differences don't re-report) | Merged with the E2/F4 drift dashboard — same rows, one system |
| O3 ⭐QW | **Milestone-change notifications to staff** | High daily utility; low volume | S (snapshot diff + milestone→label map) | Low–Med | Borrower copies **deferred** until the map is proven; then only decision-grade milestones email, mirroring `MAJOR_STATUSES` |
| O4 ⭐QW | **Closing-week war-room view** (files closing within 7 days: countdown, CTC both sides, open conditions, lock vs. closing date) | High and very visible — the screen the owner shows people | M (pure composition of O1–O3 data) | None as a view | Optional single 8am digest |
| O5 | **Rate-lock countdown alerts** (T-7/3/1) | Unknown→Med — **only if YS actually locks in Encompass** (§9 Q5) | S | Low | Idempotent `fired_at` stamps (the `reminders.js` pattern) |
| O6 | **Condition status digests** (daily, per officer) | High for processors | M | Low — the digest *is* the noise control | Staff-only; raw Encompass condition titles never reach borrowers |
| O7 | **Borrower document nudges from Encompass condition state** | Med–High | H | **High — the worst idea to ship early**; a wrong nudge burns borrower trust | Deferred to Phase 2+; requires trustworthy condition matching (F4 §4), both-systems-agree, cooldowns, weekly caps |
| O8 | **Appraisal-received surfacing** from eFolder doc titles | Med–High (real hard-money bottleneck; completes the existing appraisal-payment story) | M | Low–Med (title matching can misfire; staff-only) | Merged with rule H2 — same evidence |
| O9 | **Disclosure tracking / AUS surfacing** | Low — business-purpose loans are likely TRID-exempt and AUS is n/a; verify on a real loan before investing (§9 Q5) | M | Low | Skip unless discovery surprises us |
| O10 | **Post-closing / trailing-doc tracking** | Med–High — trailing docs are dropped precisely because funded files leave active views | M + a product decision | Low (weekly digest) | Collides with the deliberate funded-file reminder mute (`src/lib/reminders.js:270`) — needs its own channel; owner decision (§9 Q8) |

### 4d. Long-term (from E4 — each already passed or failed the §2.2 filter)

| # | Idea | Filter verdict | Notes |
|---|---|---|---|
| L1 | **Borrower-facing milestone timeline** | **Strong pass — the first borrower-visible deliverable, placed at Master Stage 5 "Later" (Decision D5)** | Label-mapped (never passthrough), staff-first for ~a month, freshness-gated: hides itself rather than show stale data — degrade to *missing*, never to *wrong* |
| L2 | **Investor + warehouse-lender reporting** | Pass | Build both on **one** shared "report definition → scheduled export" primitive over the already-mirrored data; SQL + a scheduled spreadsheet, not a live BI platform |
| L3 | **Servicing handoff packages** (eFolder export jobs → one ZIP/PDF per funded loan) | Pass | A deliverable *file*, not a servicing module — draw management stays sandboxed by design |
| L4 | **AI-assisted condition matching** | Pass **only** as deterministic-map-first + suggest-and-confirm | Actually a Phase-1/2 enabler, not a luxury — see F4 §4. Auto-acting AI is refused permanently: every model error would become a wrong underwriting state |
| L5 | **Document OCR cross-checks** | **Defer** — fails the ceremony-budget test today | If ever: advisory-only yellow note, one document type (insurance), false-positive rate <10% on a shadow run first |
| L6 | **eFolder document push** (portal-collected docs uploaded as *new* attachments) | The **one write worth doing** — Phase 3, additive-only | Under a seven-step ceremony: owner sign-off in own words, binding policy doc, **separate service + separate credential**, kill switch default-off, dry-run journal 2–4 weeks, read-after-write verification, idempotency keys |
| L7 | **Custom-field breadcrumb** (portal deep-link + last-sync stamp on the loan) | Acceptable second write, only after ≥3 months of clean document pushes | One portal-owned field, idempotent |
| L8 | Condition/status write-back, loan edits, milestone finishes, locks, disclosures, loan creation | **Permanent no** | Fails the direction test forever; restated in §8 |

---

## 5. The rules-engine design in brief (F4)

F4 turned E2's catalog into a buildable design. The essentials:

- **A declarative `encompass_rules` registry** — one row per rule: `rule_key`, `trigger_points[]`,
  a **whitelisted jsonb predicate** (same discipline as the existing `rule_logic` walker in
  `src/lib/conditions/rules.js`), severity (`hard_block | soft_warn | review`), tolerance jsonb,
  `staleness_max_age` + stale behavior, override capability, and a per-rule mode dial
  `off | shadow | warn | enforce`. A global `ENCOMPASS_GATES` switch caps everything — one lever to
  stand the layer down. Promoting a rule is a row update, not a deploy.
- **Five predicate kinds cover all of Phase 1**: `loan_linked`, `mapped_condition_terminal`,
  `ctc_milestone_done`, `no_open_prior_to_closing_conditions`, `field_within_tolerance`. Malformed
  or unknown predicates evaluate to `UNKNOWN`, never `PASS`; the CTC rule **fails closed** on
  UNKNOWN (an unmapped milestone can never satisfy a CTC gate).
- **No network I/O in the request path — by construction. SETTLED: Decision D1 (2026-07-19).** The
  evaluator module holds no HTTP client; it reads only the mirror tables. Freshness is enforced
  instead: the clear-to-close gate requires the loan's snapshot to be no older than the **CTC
  freshness ceiling (15 minutes recommended, configurable)**; a staler snapshot means the gate
  **fails closed** and idempotently **queues** a high-priority `sync_queue` pull (constrained
  `target='encompass'` ⇒ `direction='pull'`) with plain copy ("refreshing Encompass data — retry
  shortly, or override with a reason"). Lower-severity gates (soft warnings) tolerate the standard
  snapshot age (poll cadence). A live blocking fetch at decision time is **rejected** for Phase 1 —
  it would put Encompass availability in the request path; the one question still open for Phase 2
  is whether to ever allow such a live fetch (§9 Q14). The shared principle holds: **Encompass
  being down never freezes the portal** — hard gates degrade to an informed, reasoned human
  confirmation.
- **The hooks are existing seams, verified in the repo — and the gate covers all THREE doors
  (Decision D6):** a new branch in `signOffGate` (`src/routes/staff.js:2400`, enforced ≈`:2599`)
  and in `POST /loan-conditions/:cid/clear` (`:2250`); a third `encompass` blocker group in
  `advancementBlockers` (`:3896`) covering door 1 (the status PATCH) and door 2
  (`POST /internal-status`, `:4298`, which today skips blockers entirely — a pre-existing gap this
  work closes); door 3 is **ClickUp-inbound status application**: a gated inbound CTC change is
  *not applied locally* — it lands in the sync review queue with reason `encompass_gate_blocked`,
  exactly like other suspicious inbound changes (we cannot stop ClickUp itself from changing; we
  refuse to mirror it ungated). Plus a hold on the borrower CTC email at `:4283`. The readiness
  widget (`GET /applications/:id/gating`) surfaces the new blocker group for free.
- **Condition matching is two-level and always human-confirmed.** Admin-authored template matchers
  generate *suggestions only*; per-file bindings (portal item ↔ `encompass_condition_id`, with the
  API family and the title captured at link time so later renames can't re-target) carry states
  `suggested / confirmed / rejected`. Never auto-bound — even a 100% title match only suggests.
  Gating is **opt-in per condition**: unmapped portal conditions are simply not gated, keeping the
  default experience identical to today.
- **The CTC gate** = `loan_linked` (match state ∈ {auto_matched, manual_confirmed} — DATA-MAPPING
  §2.1) AND the admin-mapped CTC milestone done (CTC is not a core Encompass milestone — its
  representation in our instance is a discovery item, §9 Q9; fail-closed if unmapped or vanished)
  AND zero open prior-to-closing Encompass conditions — which also covers **Encompass-only**
  conditions the portal never materialized — all evaluated against a snapshot inside the 15-minute
  CTC freshness ceiling (Decision D1).
- **Phase 1 ships four rules** (parity sign-off, CTC agreement, loan-amount parity as a drift row,
  and the positive "ready to clear" suggestion — which rolls out **first**), all starting in
  shadow/warn mode. The registry is designed for the full ~35-rule catalog; most later rules are
  pure registry rows plus at most one new predicate kind.
- **Evidence audit:** every evaluation appends to `encompass_gate_log` (the canonical table name —
  DATA-MAPPING §2.1, Decision D4) with the raw mirrored evidence and the rule version it ran under,
  so any historical block/pass/override can be replayed.

---

## 6. Phase-1 shortlist — what to build first for maximum visible value

Recommended build order (each item usable on its own; later items compose earlier ones):

| # | Build | Why this order |
|---|---|---|
| 1 | **Foundations** (§3): allowlisted read-only client, mirror tables, loan↔file link review queue | Everything depends on it; the linkage queue is the first human-facing surface |
| 2 ⭐ | **Side-by-side pipeline dashboard** (O1) | Zero noise, immediate value, and staff visibly *verify the linkage is right* before any rule fires |
| 3 ⭐ | **Daily reconciliation report + drift rows** (O2, merged with the F4 drift dashboard) | The backbone of every gate; catches mapping/poller bugs early |
| 4 ⭐ | **Staff milestone notifications** (O3) | First push automation — low volume, high daily utility; borrower copies deferred |
| 5 ⭐ | **Closing-week war room** (O4) | Highest "wow" per unit of work — composes data items 2–4 already pull |
| 6 ⭐ | **Repeat-borrower banner + dedup oracle** (B1, B9) | The borrower-intelligence quick wins; suggestion-only, review-queue contained |
| 7 | **Rules layer in shadow** (F4's four rules) + the per-file agreement chip | Rules evaluate and count silently; the "ready to clear" helper and the green chip ship first so the layer helps before it enforces |

Explicitly **not** in Phase 1: any borrower-visible surface, borrower document nudges (O7), rate
locks (until confirmed in use), disclosure/AUS panels, post-closing tracking (needs the mute
decision), all writes.

---

## 7. Staged roadmap with go/no-go gates

**The roadmap of record is the Master's stages 0–5** (ENCOMPASS-INTEGRATION-RESEARCH §8) —
Decision D5 (2026-07-19). The phases below are this doc's working shorthand; they map onto the
Master stages as follows, and where the two differ, the Master wins:

| This doc | Master roadmap of record |
|---|---|
| Phase 0 — Discovery | Stages 0–1 |
| Phase 1 — Read-only mirror | Stages 2–3 |
| Phase 2 — Enforcement | Stage 4 |
| Phase 3 — Selective expansion | Stage 5+ |

Two placements to note: the **borrower milestone timeline (L1) sits at Stage 5 "Later"** in the
roadmap of record — not a Stage-4 deliverable; and the **eFolder document push (L6) is outside the
roadmap of record entirely** — nothing in stages 0–5 writes to Encompass, and L6 would first
require the Guardrails unfreeze ceremony plus owner sign-off.

**Phase 0 — Discovery (days, not weeks).** Answer the instance facts in §9 with a handful of reads
against real loans: v1 vs. v3 conditions, the milestone vocabulary and how CTC/fallout are actually
represented, whether locks/disclosures are used, custom-field inventory, historical depth, payoff
data availability. Every design above is parameterized on these answers rather than assuming them.

**Phase 1 — Read-only mirror (prove the plumbing).** The §6 shortlist. Zero enforcement, zero
borrower visibility, zero writes.

*Gate 1→2 (all must hold):* ≥99% of active files auto-matched to exactly one Encompass loan, every
exception triaged with a documented cause; ≥4 consecutive weeks of staff side-by-side use with zero
outstanding "portal shows a different number" reports; freshness SLO met (data age ≤ agreed
threshold ≥99% of windows, staleness visibly stamped); a write-incapability audit — the Encompass
audit trail shows **zero** writes by the API user; ≥2 weeks of operational calm; the deterministic
condition map covering ≥90% of open conditions on active files (built during Phase 1, meaningless to
enforce without). *No-go signals:* match rate stuck below target; staff distrust the panel.

**Phase 2 — Enforcement (Master Stage 4).** Promote the four rules shadow → warn → enforce, one
registry flip at a time (each reversible without a deploy); turn on the CTC gate at **all three
doors** (status PATCH, internal-status, ClickUp-inbound — Decision D6) and the borrower-CTC email
hold. Add the next rule families (waive advisory, `funded` target, locks if real) as registry rows.
Still zero writes. The borrower milestone timeline (L1) is **not** here — it sits at Stage 5
"Later" per the roadmap of record (Decision D5).

*Gate 2→3:* override rate <5% of clears, every override reasoned, trend flat or falling over ≥8
weeks; at least one documented catch (or months of zero wrongful blocks); staff not working around
the portal; **per-item owner sign-off in the owner's own words** for each Phase-3 candidate. (The
timeline's own no-confusion/no-leak gate travels with it to Stage 5.) *No-go:* gates being
routinely overridden means the mapping is wrong — fix Phase 2, don't advance.

**Phase 3 — Selective expansion (Master Stage 5+), each item independently gated, in this order:**
1. Borrower milestone timeline (L1) — staff-first, then borrower-facing; live ≥4 weeks with no
   confusion incidents and no leaked internal strings before it counts as done (Stage 5 "Later").
2. Report exports (L2) — read-only, immediate business value.
3. Servicing handoff packages (L3) — read-only.
4. **eFolder document push (L6)** — **outside the roadmap of record** (Decision D5): the first and
   only candidate write, admissible only via the Guardrails **unfreeze ceremony** + owner sign-off,
   under the full seven-step ceremony, in a separate service with its own credential, dry-run
   first, kill switch default-off. Bonus: borrowers upload once to the portal and Encompass
   receives it — squarely "helping out."
5. Custom-field breadcrumb (L7) — only after ≥3 months of clean pushes; same ceremony.
6. OCR cross-checks (L5) — advisory-only, only if staff ask.

---

## 8. What we will never build (restated for the record)

- **Condition or status write-back to Encompass** — it inverts the entire premise ("portal cannot
  clear unless Encompass agrees" must never become "portal changes what Encompass says").
- **Loan creation or edits, milestone finishes, rate-lock actions, disclosure sends** — regulated
  artifacts, compliance timing, money. Origination stays in Encompass.
- **Auto-clearing, auto-reopening, auto-verifying, or auto-linking anything** — machine output is
  always a suggestion; a human's normal audited action is always the actor.
- **Any delete or overwrite anywhere**, and any relaxation of the read-only client's allowlist —
  if writes ever happen (L6/L7 only), they live in a physically separate service and credential.
- **Raw Encompass text on borrower surfaces**, ever.

---

## 9. Open questions (carried forward)

_Canonical tracker: Master §10 (OQ-xx IDs); this local list is subsumed (Decision D8)._

**For the owner (decisions):**
1. **Auto-verify our own funded loans?** Should an Encompass-sourced track record from a loan YS
   itself funded auto-verify, or keep the human sign-off? Recommendation: keep the human sign-off in
   Phase 1 (E1).
2. **Borrower-facing gating** — hold a condition's "cleared" display until Encompass agrees?
   Recommendation: no for Phase 1; the layer stays staff-only (E2).
3. **Webhook adoption timing** — Phase 1 poll-only is **decided** (Decision D2); the remaining
   owner question is when/whether to adopt webhooks as the Phase-1.5/2 accelerator. When adopted,
   subscription CRUD is the one sanctioned admin-credential config write (Atlas §10.2), polling
   stays the source of truth, and ICE's auto-disable/deletion of persistently-failing
   subscriptions makes a daily subscription-drift read check mandatory. (E1/E3/E4/D1.)
4. **Fail-closed tolerance** — how long may an Encompass outage block clears before the audited
   override becomes the expected path? This number belongs in the Phase-2 gate (E4).
5. **Tolerance culture** — exact-to-the-cent (the SOW precedent) vs. cross-system rounding reality
   for the economics rules (E2).

**Instance discovery (Phase 0 reads answer these):**
6. Does the instance carry **payoff/servicing outcomes** after loans are sold, or does that live
   elsewhere? Decides how much of the exit-date proxy (B2) and EPO flags (B6) is buildable (E1).
7. **How does YS mark fallout** — a folder, a milestone, a status field? B6's semantics depend
   entirely on the instance's conventions (E1).
8. **v1 legacy vs. v3 Enhanced Conditions**, per loan — determines endpoints and status vocabulary
   for the entire parity family (E2/E3/F4/D1).
9. **What is CTC in this instance** — a milestone, a field, or "zero open PTD conditions"? The CTC
   rule's evidence hierarchy is configurable for exactly this reason (E2/F4).
10. **Are rate locks, disclosure tracking, or AUS used at all** for these business-purpose loans?
    If not, Family E stays off and O5/O9 are dropped (E2/E3).
11. **SSN handling in the pull — decided for launch (Decision D3):** no full SSN or DOB is pulled;
    matching runs the non-SSN ladder (loan number, address + name, corroborated name/entity). The
    residual question is only whether the owner ever enables Tier 3 (the SSN-hash key), which would
    widen the GLBA blast radius the split `borrowers`/`borrower_auth` design exists to contain (E1).
12. **Historical depth** of closed loans in Encompass — determines how complete auto-built track
    records can be (E1).
13. **Concurrency reality** — the instance's actual rate allocation and which other consumers share
    it; sets poll cadence (D1/E3).

**Design questions parked for later phases:**
14. **Ever allow a live fetch at hard gates?** Phase 1 is settled — no network in the request
    path, queue-then-retry with the 15-minute CTC freshness ceiling (Decision D1). The open
    Phase-2 question is whether retry friction ever justifies E2's bounded refresh-then-decide
    live call. Measure during shadow (F4).
15. **Auto-reopen promotion** — should Encompass drift ever auto-reopen portal conditions once
    shadow data shows suggestion-acceptance rates? Deliberately excluded from Phase 1 (F4).
16. **Who confirms per-file condition bindings** — `sign_off_conditions` (proposed) or restrict to
    `manage_conditions`? (F4.)
17. **Post-closing visibility channel** — how does trailing-doc tracking coexist with the
    deliberate funded-file reminder mute? (E3.)
18. **Report consumers first** — warehouse template or investor tape, and can both truly share one
    export primitive? (E4.)
