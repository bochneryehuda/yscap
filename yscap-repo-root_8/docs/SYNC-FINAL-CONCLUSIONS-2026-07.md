# SYNC PROGRAM — FINAL CONCLUSIONS (2026-07-17)

**Status: DECIDED.** This document is the binding output of the ~100-agent research and design
program run against the PILOT ↔ ClickUp ↔ SharePoint sync. It supersedes the *options* framing of
`docs/SYNC-ACTION-PLAN-2026-07.md` (whose WO numbering it keeps and extends) and states what we are
going to build, in what order, with what amendments, and how we will know it is done.

Inputs: the full-repo audit (F-C1, F-H1..H4, F-M1..M20), 19 double-verified implementation specs,
fact-checked industry research (recon, provenance, ledger integrity, LOS integrations, stewardship,
webhook reliability, rate/backpressure, change management), an 80-guard catalog scored by three
independent judges, a red-team FMEA, and a three-way architecture bake-off.

---

## 1. The decision: Contract-Gated Ledgered Sync (in-place), with two stolen ideas

**We are keeping the existing monolith and hardening it at its four chokepoints. We are not
rewriting anything.** The winning architecture is **"Contract-Gated Ledgered Sync"** (judge scores
9 / 9 / 8 across the data-safety, effort-vs-payoff, and solo-operator lenses — the highest total of
the three candidates). It is, concretely:

- The **same files, same chokepoints, same review UI** as today. `src/clickup/client.js` becomes the
  transport contract (retry/429/throttle), `src/clickup/orchestrator.js` becomes the truth contract
  (a job is "done" only when every field verifiably landed or was provably a no-op),
  `src/sync/clickup-sync.js` keeps its queue/inbox/reconcile loops but with durable state,
  `src/lib/sync-review.js` stays the single human interface but tiered and coalesced.
- **Per-field policy moves from code into data** (the typed field registry: direction, authority,
  PII class, validator per field) and **provenance becomes a required function argument**, not a
  convention.
- **Volatile safety state moves from process memory into Postgres** (breaker, watermark, boot-sweep
  ledger) so 13-deploys-a-day can never reset a guard again.
- Plus the three things only this architecture had: **document DR** (today the Render disk is the
  only copy of every borrower document — an extinction-class risk no other plan touched), a
  **deploy-freeze error-budget rule** (no feature work while dead-letters are non-zero — the only
  control aimed at the demonstrated root cause: velocity over safety), and a **nightly read-only
  recon** that detects divergence instead of assuming the write path is airtight.

Two ideas are stolen from the losing designs and are now part of the plan:

1. **From "The Guarded Monolith": the parity-test registry cutover.** The field registry (WO-10)
   converts one consumer at a time, each behind a test asserting the registry-driven output is
   **byte-identical** to the legacy FIELD_MAP path *before* the legacy path is deleted. Field by
   field, never big-bang. This is the only mechanical check that catches a mistranscribed
   direction/authority row — the one failure parity of implementation cannot see.
2. **From "LEDGER": replay fixtures from production traffic.** `clickup_webhook_inbox` rows are
   already a raw capture buffer. We add a harness that replays recorded real event sequences
   against `ingest.js` asserting identical decisions — manufacturing a regression suite for the
   1,545-line, 9-incident-fix, zero-coverage module from traffic that already exists (WO-19). We
   also adopt LEDGER's *derived completion* idea in miniature: "done" is checked against the
   `clickup_write_log` journal, not merely set as a flag.

**Explicitly rejected: the LEDGER event-sourcing rewrite** (judge scores 6 / 5 / 4). Best
architecture on paper, worst fit for this operator: a dual-write soak window where the new truth can
lie, an outbox cursor whose correctness rides on commit-order subtleties ("exactly the kind of
invariant this team has historically gotten wrong at 3am"), PII in a physically unrewritable table,
and portfolio-wide blast radius on fold bugs. The industry research says the same thing in plain
words: the professional-grade target for a one-person Node/Postgres shop is current-state tables +
append-only journals + transactional outbox + recon — **not** event sourcing.

Every load-bearing wall is preserved verbatim and stays on the never-regress list:
`guardNoFieldClearing`, status-only task updates, the no-delete hard stop, scoped-push-never-creates,
fail-closed pre-read, dates-as-strings with round-trip throw, fill-only inbound PII, two-sided review
cards, the SharePoint no-delete/no-rename policy.

---

## 2. The definitive ordered build list

Nineteen work orders. Every verifier **blocking issue is resolved into the ordering and scope
below** — a WO ships with its amendments or it does not ship. Effort: S = one session,
M = 1–3 sessions, L = 3–5 sessions. One WO per session/PR; the two-audit-agent gate applies to all.

### Stage 0 — Foundation (land first; zero runtime behavior change)

| # | WO | Effort | What ships |
|---|----|--------|------------|
| 1 | **WO-13a — Assurance floor** | S | `npm test` chaining the 8 existing green suites; the 15-line GitHub Actions workflow; `schema_migrations` ledger + fail-loud on migration failure; duplicate-migration-number CI check (renumber the three live collisions); committed-bundle ↔ source drift check for the V2 portal. Nothing later lands without this net. |
| 2 | **WO-1 — Throw on failed field writes** (F-C1) | S | Verified **sound as specced** — ship unmodified. `journalStats.failed` counter + bounded failure detail; `pushApplication` throws when any non-suppressed, non-blocked field write (or the status write) fails; `pushOutboxOnce` can no longer mark a lossy job `done`. Expect a temporary rise in dead-letter cards — that is the silence becoming visible, not the system getting worse. |

### Stage 1 — Stop silent loss (strict order; amendments are part of scope)

| # | WO | Effort | What ships (verifier amendments folded in, **bold**) |
|---|----|--------|------------|
| 3 | **WO-2 — Retry/rate-limit contract at `client.js`** (F-H1) | M | Port the proven SharePoint retry discipline (Retry-After on 429/503/504, capped backoff + jitter, fetch timeout) into `call()`, plus a token-bucket pre-throttle. **Amendments (all blocking, all in scope): (a)** a per-JOB wall-clock deadline threaded from `pushOutboxOnce` into `pushApplication`/`call()`, started **before** `takeToken()`, plus a `sync_queue.updated_at` heartbeat between fields — the 5-minute reclaim invariant must actually hold for unbounded `payload.only` fan-outs; **(b)** token bucket uses a take-after-wake re-check loop (`while tokens < 1: refill, sleep`) and **every retry attempt consumes a token**; **(c)** in-flight re-entrancy guards on the `tick()` drains ship **in this WO** (the WO is what creates 60s+ loop bodies inside unguarded `setInterval`s); **(d)** request-path callers (`staff.js` review-resolve, `sync-autoresolve` appliers) get a short-budget option (~10s / maxRetries:1) so a browser can never double-submit a resolve; **(e)** a written rollback runbook: outbound off → `UPDATE sync_queue SET attempts=0 WHERE status='queued' AND attempts>=8` → revert → re-enable (prevents rollback converting an outage into a mass dead-letter + email flood). |
| 4 | **WO-4 — Durable state + tamed boot storm** (F-H4, F-M7, F-M16) | M | Postgres `sync_runtime_state` watermark; breaker rebased onto `clickup_write_log`; keyset-sliced 6h rotation replacing per-deploy portfolio sweeps; push heartbeat. **Amendments: (a)** watermark UPSERT guard uses `COALESCE((value->>'since_ms')::bigint, 0)` so an empty/malformed row can never silently freeze saves; **(b)** `reconcileOnce` gains page-looping and only advances the watermark after cleanly consuming the last page (removing the boot storm unmasks the missing pagination); **(c)** breaker baseline expires past `CIRCUIT_WINDOW_MS` (no stale-baseline lockup on DB blips); **(d)** an `AbortSignal` fetch timeout in `call()` ships with the heartbeat, and the heartbeat has a max lifetime — a hung socket must still get reclaimed; **(e)** the orphan outage-breaker probes one known-live task outside a dead tail slice before skipping (clustered real deletions must not become a permanent-skip trap). |
| 5 | **WO-5 — Transactional enqueue** (F-M3) | M | Enqueue atomic with the data write on the four top write paths; loud + audited failure everywhere else; the `AND op='update'` merge guard (fixes the legacy-create payload clobber). **Amendments: (a)** two-phase rollout — deploy 1 ships loud enqueue + merge guard + `withTransaction` (added, unused); after a day of measuring real enqueue-failure rates, deploy 2 converts the routes; rollback of phase 2 is a one-commit revert that keeps the loudness fixes; **(b)** global lock ordering: within every transaction, ALL data-row UPDATEs precede ANY enqueue (applications, then borrowers, then one **merged** enqueue call in the complete-fields paths) — the spec's original ordering deadlocks against the borrower-profile path. |
| 6 | **WO-3 — Inbound dead-letter parity + webhook health** (F-M6) | M | Inbox `error` rows dead-letter into review cards exactly like outbound; webhook liveness probe. **Amendments: (a)** sequenced AFTER WO-2 — the boot re-drive must ride the throttle (the "4s pacing" the spec assumed does not exist); re-drives are paced like `retryStuckTasksOnce` (per-task sleep, small per-boot cap); **(b)** rotation via `ORDER BY COALESCE(processing_started_at, received_at)` so >50 poisoned tasks can't starve the tail forever; **(c)** the manual `retry_ingest` supersede touches ONLY `status='error'` (and crash-stale `processing`) rows — never `received` (no new silent-drop window); **(d)** day-one blast radius bounded: ship the catch-block visibility first, pre-count the error backlog, enable the boot re-drive at a small cap in a second deploy; **(e)** the webhook **autocreate branch is DROPPED** — its env-vs-stored secret verification flaps into a permanent self-inflicted outage; we ship the health probe + alert + one-click re-register in the Control Center instead. |

### Stage 2 — The review queue becomes legitimate ("manual review = only important things")

| # | WO | Effort | What ships |
|---|----|--------|------------|
| 7 | **WO-6 — Small fixes bundle** | S | The six one-liners (borrower_id on outbound DOB rows so F-M20 rows auto-close; sanitizeDob on the legacy approve path; normalizeTypedDate on LLC/checklist dates; portal-side value on year-range cards; 404-only task-deleted verdict; migration renumbering). **Amendment:** the migration-header drift test is mismatch-only (or carries a frozen allowlist of ~39 headerless legacy files) — as specced it ships red. |
| 8 | **WO-7 — Queue tiers + notification coalescer** | M | REASON_TIER map over the 19 slugs; per-LO hourly coalescer; Tier-B digest + auto-expiry. **Amendments: (a)** `clickup_dob_differs_from_portal` and `pii_overwrite_blocked` stay **Tier A** unless the owner signs off the demotion in writing — we do not de-escalate the category the system was built after; **(b)** the auto-expiry allowlist is split from the tier map: ONLY sweep-regenerated slugs expire; `sharepoint_mirror_failed`, `pii_overwrite_blocked`, and every DOB-disagreement slug **never** auto-expire (they have no producer to re-raise them); **(c)** fail-safe email: feature-detect the db/116 column (catch 42703) and fall back to legacy per-row Tier-A email until the schema is confirmed — a failed migration must degrade to *more* email, never to silence. Two-phase rollout (shadow per-row email kept in deploy 1). |
| 9 | **WO-8 — Sticky dismissals + telemetry** | M | Value-keyed suppression as the `queueReview` default; grouped queue UI; per-reason verdict telemetry with loud auto-demotion. **Amendments: (a)** the grouped ORDER BY is rewritten as valid PostgreSQL (window computed in the SELECT list against qualified input columns; bare aliases in ORDER BY) — as specced it 500s the whole review list; **(b)** `direction` joins the R2/R3 suppression match tuple — a dismissed inbound proposition must never suppress the opposite outbound one; **(c)** auto-demotion rollout is sequenced after the tier map has soaked. |

### Stage 3 — Built the proper way (structure over guards)

| # | WO | Effort | What ships |
|---|----|--------|------------|
| 10 | **WO-9 — Bot seat + actor echo suppression** | S (+ owner action) | Owner creates the "YS Portal Bot" ClickUp member seat + token (Phase 0.4); portal writes switch to it; inbound short-circuits bot-actor events. Structural loop prevention replaces "COALESCE happens to be idempotent"; the co-tenant automation becomes visible by elimination. |
| 11 | **WO-10 — Typed field registry** | L | Per-field {clickup_field_id, portal column, type, direction, **authority**, pii_class, validator} as data; mapper selection, ingest fill-only membership, guard membership, review producers, `applyReviewWinner` all iterate it. **Stolen discipline is mandatory:** one consumer at a time, each behind a byte-identical parity test vs the legacy FIELD_MAP path before that path is deleted; the seeded authority/direction VALUES get a line-by-line human review (a faithful migration of wrong policy passes every test). While seeding, demote every field that doesn't truly need two-way flow to one-way (status: ClickUp-owned — kills F-M1 structurally). |
| 12 | **WO-11 — Provenance + `decideField()`** (F-H3, F-M2, F-M4) | M | Who-last-set-it recorded at the already-journaling write sites; `decideDob` becomes the DOB instantiation of a general `decideField(registryRow, sides, provenance)` whose provenance argument is **required by signature**. Acceptance: the Elbaum auto-heal still works; a human-entered portal DOB can never be overwritten without a card. |
| 13 | **WO-12 — Identity confidence tiers** (F-M5, F-M18) | M | Deterministic auto-merge only (SSN match, or email + real name-token corroboration); **G3 `nameConflict` is a hard veto inside the email-corroboration branch**; when neither side has an ssn_hash, TWO corroborators are required; every auto-merge is journaled to a merge-provenance table (reconstructible, reversible). Everything in the middle → the existing `borrower_dedup_candidates` card machinery; Not-a-Match verdicts persist via WO-8. |
| 14 | **WO-19 — Ingest replay-fixture harness** (stolen from LEDGER) | M | Record real `clickup_webhook_inbox` sequences as deterministic fixtures; replay them against `ingest.js` in CI asserting identical decisions (adopt/skip/review/materialize). This is the only credible test strategy anyone proposed for the highest-risk module in the system, and it runs on traffic we already have. |

### Stage 4 — Detection, DR, operations (trust becomes verifiable)

| # | WO | Effort | What ships |
|---|----|--------|------------|
| 15 | **WO-16 — Nightly read-only recon** | M | A 2AM-NY cron, independent of deploys and of the sync path, that never writes to either system. Two passes per industry standard: population (every active app ↔ exactly one live task) then field-level diff; joins on `clickup_task_id` only (never fuzzy identity); both sides normalized through the same transforms; `clickup_write_log` is the expected-state journal (mismatch where we logged success = the F-C1 detector class: `EXPECTED_WRITE_NOT_LANDED`); in-flight work excluded; breaks persisted on (application_id, field, break_type) with first_seen/last_seen aging — a re-detected break updates, never re-cards. Fixed taxonomy: MISSING_TASK, ORPHAN_TASK, DUP_LINK, FIELD_MISMATCH_PII (top severity), FIELD_MISMATCH_STATUS, FIELD_MISMATCH_OTHER, EXPECTED_WRITE_NOT_LANDED. |
| 16 | **WO-17 — Document DR** | S | Nightly offsite snapshot of `STORAGE_DIR` + **one tested restore, performed and documented**. Today the Render disk is the only copy of every borrower document; this is the single cheapest catastrophic-risk fix in the program. |
| 17 | **WO-18 — Runtime ops + alert dead-man's switch** | M | Settings-backed pause switches (outbound / inbound / reconcile independently, no deploy); inbound flood hold; review-queue age/size on `/api/health` so an external pinger sees "unacknowledged Tier-A reviews" as a failing check; the nightly recon records provider-confirmed delivery and a >26h gap fires on a **second channel**; production refuses to boot with the noop email provider while sync is enabled. All 16 incidents were caught by humans noticing wrong data — from here on the detection layer itself is monitored. |

### Stage 5 — Egress posture (owner decisions, gated)

| # | WO | Effort | What ships |
|---|----|--------|------------|
| 18 | **WO-14 — SharePoint mirror: fix, then enable** (F-H2, F-M10) | M | Non-exact single-candidate fuzzy matches → `sharepoint_match_uncertain` review, never auto-file; `sp_rematch` derives scope from the document row; G-D1 ephemeral-storage upload gate; G-D7 mirror liveness/backlog alarm; **plus the FMEA misfile-recall guard: a filing snapshot (scope + borrower_id + app_id) persisted per mirrored doc, and a mandatory `mirror_misfiled` review row whenever a doc's attribution changes after mirroring** (resolve relocates our own copy via the existing own-item machinery — still zero deletes). Only then set the env vars and enable, watched through the now-quiet queue. |
| 19 | **WO-15 — GLBA/SSN posture** | M (owner decision first) | Recommendation stands: last-4 + "on file in PILOT" in ClickUp, full SSN encrypted only in the portal. **Amendment (FMEA top risk): the migration must be identity-aware, not display-aware** — a keyed last4+DOB secondary deterministic key; inbound last4-match + corroborator = strong, last4 CONFLICT = hard never-merge veto (restoring the veto the migration would otherwise silently kill); a regression test that `resolveBorrower` still strong-matches a last-4 task; a null-ssnHash ingest metric on the nightly recon. **WO-15 is blocked until this design is in the spec.** Decision recorded in `CLICKUP-DATA-SAFETY.md` either way. |

### Standing operating rules (policies, not WOs — in force from Stage 1)

- **Error-budget deploy freeze:** while `sync_queue` dead-letters > 0 or a Tier-A card is open past
  SLA, no feature work merges — only fixes. This is the only control aimed at the program's actual
  root cause (491 commits in 10 days, 13 deploys in one).
- **Weekly 10-minute ritual** (unchanged from the action plan): dead-letters (0), blocked writes
  (each explained), Tier-A cards >3 days (0), per-reason dismiss rates (>80% → tune).
- **Never-regress list** (CLAUDE.md) is CI-enforced from Stage 0, plus the program's new invariant:
  *every failure ends as a retry or a review row — never silence.*

---

## 3. The top-15 guards adopted (three-judge consensus)

Full 80-guard matrix with scores and status: `docs/SYNC-GUARD-MATRIX.md`. These fifteen carry the
program (median judge score in parentheses; 3/3 = named by all three judges):

| Rank | Guard | Consensus | Lands in |
|------|-------|-----------|----------|
| 1 | Per-field write failure propagates — a push job cannot be "done" unless every intended write landed (15) | 3/3 | WO-1 |
| 2 | 429/Retry-After handling + global concurrency cap at the HTTP chokepoint (14) | 3/3 | WO-2 |
| 3 | Ingest golden-fixture regression suite + CI that actually runs all suites (13) | 3/3 | WO-13a + WO-19 |
| 4 | Unified cross-system drift auditor — read-only, both directions, expected-state from the write journal (12) | 3/3 | WO-16 |
| 5 | G3: `nameConflict` VETO inside the email-corroboration auto-merge (11) | 3/3 | WO-12 |
| 6 | Write-time binding assertion: the pre-read task's portal-stamp must match the app being pushed (11) | 3/3 | WO-2/WO-10 |
| 7 | Boot one-shot ledger: full-portfolio sweeps run at most once per window, not per deploy (10) | 3/3 | WO-4 |
| 8 | Persistent, pre-pass reconcile watermark that only advances past successes (8) | 3/3 | WO-4 |
| 9 | Inbound dead-letter review row + boot re-drive — the mirror of the outbound pattern (8) | 2/3 | WO-3 |
| 10 | G1: ssn_hash written at EVERY SSN write, via one chokepoint + backfill (6) | 3/3 | WO-12 |
| 11 | Inbound sync health heartbeat — staleness becomes a number, not a feeling (5) | 3/3 | WO-18 |
| 12 | Per-task advisory lock serializing `ingestTask` — one chokepoint, all callers (4) | 2/3 | WO-3/WO-4 |
| 13 | Unknown enum value never silently substitutes the default or drops — review instead (3) | 3/3 | WO-10 |
| 14 | G-D1: Ephemeral-storage upload gate (1) | 3/3 | WO-14/WO-17 |
| 15 | Generalize the throw-on-violation round-trip invariant to every typed field (1) | 2/3 | WO-10 |

---

## 4. Top residual risks accepted for now (red-team FMEA)

These are the risks we are consciously carrying, ranked by red-team RPN (severity × likelihood ×
detectability). Each names the closing guard so acceptance is a scheduling decision, not amnesia.

| # | Residual risk | RPN | Disposition | Closing guard (named) |
|---|---------------|-----|-------------|------------------------|
| R1 | **SSN last-4 migration silently kills the only strong merge key** (null ssn_hash on every ClickUp-originated borrower; the never-merge veto goes dark) | 576 | **Not accepted — blocked.** WO-15 cannot ship as display-only. | Identity-aware last-4 migration: keyed last4+DOB secondary key, last4-conflict hard veto, `resolveBorrower` regression test, null-ssnHash recon metric (folded into WO-15 scope). |
| R2 | **Blank-field COALESCE fill is a zero-scrutiny channel** — a wrong-but-plausible first fill (transposed DOB, wrong-tab phone, mistyped SSN) becomes "the portal value" all future conflicts defend | 504 | Accepted until WO-11 lands, then closed in its second phase. | PII-class first-fill tiering: `clickup_unverified` provenance + visible chip, hardening at a human checkpoint; ambiguous dates (day ≤ 12, century-pivoted) go to the low review tier instead of filling silently. |
| R3 | **Correction-by-deletion is undone within 5 minutes** — a human clears a wrong value, the reconcile refills it from the other side's stale copy, journaled as a legitimate fill | 504 | Accepted; interim: per-field oscillation alarm on the nightly recon flags refill churn; staff guidance ("replace, don't delete"). | Clear-tombstones in the provenance layer: a human blank is a provenance event that outranks stale remote values; "propagate clear" becomes the one allowlisted, journaled path through `guardNoFieldClearing`. |
| R4 | **Dead alert channel** — every detection (cards, digests, recon) funnels into one fire-and-forget email path; a Resend key expiry or env typo mutes ALL alerting while queues backlog invisibly | 504 | Accepted until WO-18 (Stage 4). **This is the program's single biggest live residual** — until it closes, the weekly ritual is the compensating control. | Dead-man's switch on the nightly recon (provider-confirmed delivery, >26h gap alarms on a second channel), `/api/health` review-queue metric for an external pinger, refuse-to-boot on noop email provider in prod. |
| R5 | **Mis-filed PII is permanent in SharePoint** — an upstream mis-merge mirrors borrower B's ID into borrower A's folder forever (no-delete policy, no recall path) | 486 | Accepted only while the mirror stays OFF (it is off today). Hard gate: the recall guard ships inside WO-14 **before** enablement. | Filing snapshot per mirrored doc + mandatory `mirror_misfiled` review row on attribution change; resolve relocates our own copy to quarantine/corrected scope via `sp.moveOwnItem` (zero deletes preserved). |
| R6 | **Flood + bulk rubber-stamp** — a mass event queues ~100 same-reason rows; a fatigued LO bulk-resolves; the handful of rows where the other side was right get overwritten with full human authority | 441 | Partially closed in Stage 2: PII/DOB rows become per-row-only (excluded from bulk) inside WO-7/8. | Full closure: flood-hold that *inverts* the telemetry (rate spike → pause + disable bulk, not demote), before-images + one-click revert on bulk resolves. Backlog item after Stage 2 soak. |
| R7 | **Sticky dismissal = permanent blind spot** — a July dismissal suppresses October's genuinely-different recurrence of the same slug forever | 441 | Substantially closed by WO-8 as amended (value-keyed + direction-scoped). Residual: no TTL, no suppressed-recurrence counter yet. | Suppression TTL + `suppressed_count`/`last_suppressed_at` surfaced in the nightly recon, auto-reopen after N suppressions. Backlog item. |

---

## 5. What we explicitly will NOT do (and why)

1. **No event-sourcing rewrite (LEDGER).** Rejected above. The research is blunt: reject this scope
   for a one-operator shop; current-state tables + journals + outbox + recon is the professional
   target.
2. **No message broker, no Redis, no vault/KMS, no microservices.** Postgres is the broker (FOR
   UPDATE SKIP LOCKED is already proven here); env-var secrets with rotation runbooks are
   right-sized.
3. **No SOC 2 / Vanta / Drata, no pentest program, no formal IRP, no board-reporting theater.**
   Under the FTC Safeguards Rule's 5,000-consumer threshold these are not required; the six
   engineering controls (CI gate, branch protection, migration ledger, dedicated token, DR,
   change-procedure doc) ARE the legally-required change-management substance (16 CFR 314.4(c)),
   without the theater.
4. **No rewrite or decomposition of `ingest.js`.** It carries fixes for 9 of 16 incidents; we harden
   around it and make it the most regression-tested module in the repo via replay fixtures (WO-19)
   instead of the most recently rewritten one.
5. **No bitemporal schema, no `temporal_tables`.** Two timestamps (observed_at vs recorded_at) only
   where backdating disputes actually occur: DOB/SSN change records.
6. **No expansion of fuzzy identity matching, ever.** Deterministic-only auto-merge; everything in
   the middle band is a human click. F-M5 is how different-named people got merged.
7. **No webhook autocreate.** Dropped from WO-3 by verifier finding — its secret-verification flap
   is a self-inflicted permanent outage. Probe + alert + one-click human re-register instead.
8. **No new bidirectional fields by default.** The registry seeding (WO-10) demotes every field that
   doesn't truly need two-way flow; status becomes ClickUp-owned, portal mirrors read-only.
9. **No migration-tool swap (node-pg-migrate) mid-program.** The ledger + CI invariants deliver the
   safety now; a tool swap is a post-program cleanup candidate, not a Stage-0 risk.
10. **No SharePoint enablement before WO-14's gates AND the misfile-recall guard land.** The mirror
    stays dark until auto-filing into a fuzzy-matched folder is structurally impossible.
11. **No full staging environment this quarter.** The winner's drop-discipline holds: CI + replay
    fixtures + parity cutover + pause switches carry the assurance load. Revisit at the quarterly
    checkpoint alongside the Unito buy-vs-build hour.
12. **No new guards as scattered code.** Anything guard-shaped must land at one of the four
    chokepoints or in the registry — the ~45-reactive-layers pattern is the pathology we are
    curing, not the pattern we extend.

---

## 6. Definition of done (measurable, owner-language)

The program is **done** when every metric below holds for **two consecutive weeks**, measured by the
evidence script + nightly recon (not by feelings):

| Owner's demand | Metric | Target |
|----------------|--------|--------|
| "Never mess up data again" | Recon `EXPECTED_WRITE_NOT_LANDED` breaks; unreviewed sensitive-identity changes (journal source audit) | **0** and **0** |
| " | Outbound jobs whose terminal state is neither verified-done nor a review card | **0** (structurally unreachable after WO-1) |
| "Reliable" | Dead-letters caused by transient 429/5xx; sync loops' watermark/breaker surviving a deploy drill | **0**; **pass** |
| " | Deploy cost: ClickUp reads in the 10 min after a deploy (boot-sweep budget line) | Within the configured cap; no card flood |
| " | Documents | **3 independent copies** + 1 tested restore on record |
| "Built properly, like a professional financial company" | CI required + green on `main`; every one of the 16 incident classes has a locked regression test (replay fixtures cover ingest); `schema_migrations` ledger live; every outbound write attributed to the bot seat | **100%** |
| " | Nightly recon delivered with provider-confirmed receipt (dead-man < 26h); unexplained breaks older than 3 business days | **100%**; **0** |
| "Manual review = only important things" | LO emails/day (all Tier-A decisions); median Tier-A time-to-resolve; Tier-A cards open > 3 days | **< 5**; **< 1 business day**; **0** |

Exit note: after the two green weeks, the standing rules (§2) remain in force permanently — the
weekly ritual, the error-budget freeze, and the never-regress list are the system's immune system,
not scaffolding.

---

*Program lead sign-off, 2026-07-17. Companion document: `docs/SYNC-GUARD-MATRIX.md` (full 80-guard
catalog with judge scores and status). Predecessor: `docs/SYNC-ACTION-PLAN-2026-07.md` (WO numbering
retained; this document governs where they differ).*
