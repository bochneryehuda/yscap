# SharePoint Mirror — Explicit Per-Document State Machine (Design)

**Status:** Phase 0 design (approved for build, owner-directed 2026-07-21).
**Goal (owner's words):** *"major root cause … fix it once and for all … it should look like a $1,000,000 buildup."*
**One-line intent:** make **"a document silently stuck / never attempted"** *structurally impossible* by
replacing the implicit boolean queue with an explicit, self-healing per-document state machine —
built the way mature Postgres work-queues (River, graphile-worker, pg-boss, Oban) and the AWS/Stripe
playbooks do it, and rolled out with **zero downtime and instant rollback**.

This document is the blueprint the four implementation phases follow. It is deliberately concrete: exact
columns, exact SQL, exact constants, and — most importantly — an exact mapping onto **every** existing
mirror behavior so nothing the owner already relies on is lost.

---

## 1. The root problem: an implicit boolean queue

Today "is this document mirrored?" is answered by reading several columns and *inferring* a state:

| Real-world condition | How it's encoded today | Failure mode |
|---|---|---|
| Never tried | `sharepoint_backed_up_at IS NULL` (+ not skipped) | Indistinguishable from "in-flight" and "silently dropped" |
| Done | `sharepoint_backed_up_at IS NOT NULL` | — |
| Deliberately not mirrored | `sharepoint_skipped_reason IS NOT NULL` | Must be stamped by a *separate* settle pass or it looks "never tried" forever |
| In-flight right now | *(not represented)* — a global `sync_locks` drain lease, not per-doc | A crash mid-upload leaves `backed_up_at NULL`, i.e. "never tried" |
| Failed-and-retrying | `sharepoint_backup_attempts > 0 AND backed_up_at IS NULL` | Same NULL as "never tried" |
| Failed permanently (poison) | *(not represented)* — `attempts >= MAX_ATTEMPTS` inferred | No terminal state; sits in the backlog forever |

Because "never tried", "in-flight", "retrying", and "silently dropped" **all look like `backed_up_at IS NULL`**,
the selectors that decide *what work to do* and the queries that decide *what to alert on* are two different
pieces of SQL that must be kept in perfect agreement by hand. Every production incident in this subsystem has
been a case of those two diverging:

- The **REGEN_KIND_SQL NULL trap** (fixed 2026-07-21, PR #510): the work selectors filtered a `doc_kind`-NULL +
  `is_current=false` row out via `NOT(NULL)`, but the alert query still counted it → "(not yet attempted)" for hours.
- The **appraisal_photo stuck-noise** bug (fixed 2026-07-20): a kind was excluded from the drain but never stamped
  `skipped`, so it read as "never tried" forever.

Both are the *same class of bug*: **an absent explicit state, reconstructed differently by two readers.** No
amount of point-fixing removes the class. An explicit `mirror_status` column that is the single source of truth —
written by the worker itself, at claim time, before the external call — removes it by construction.

**This is the industry-recognized anti-pattern.** A boolean/implicit queue cannot represent "leased", "poison", or
"in-flight", which is exactly why every production Postgres queue uses an explicit state column plus a lease. We
adopt their model.

---

## 2. The state machine

```
                        enqueue (kick / interval sweep discovers the row)
                                        │
                                        ▼
   settle pass (never-mirror kind, ┌─────────┐   claim (FOR UPDATE SKIP LOCKED):
   superseded regen) ────────────► │ PENDING │   status→IN_PROGRESS, attempts++,
                │                   └─────────┘   lease_expires_at = now()+LEASE, BEFORE any Graph call
                │                        │
                ▼                        ▼
          ┌─────────┐             ┌────────────┐
          │ SKIPPED │             │ IN_PROGRESS│──── success ────► ┌──────┐
          │(terminal│             │  (leased)  │                   │ DONE │ (terminal)
          │ w/reason│             └────────────┘                   └──────┘
          └─────────┘              │  │  │  │
                                   │  │  │  └─ throttle (429/Retry-After) ─► PENDING, next_attempt_at = now()+RetryAfter
                                   │  │  │                                    (does NOT consume attempts budget)
                                   │  │  └─ transient fail & attempts<MAX ──► PENDING, next_attempt_at = now()+backoff
                                   │  │                                       (FAILED = the visible "retrying" label)
                                   │  └─ transient fail & attempts>=MAX ────► ┌──────┐
                                   │  └─ permanent fail (bad request/403) ──► │ DEAD │ (terminal, dead_reason recorded)
                                   │                                          └──────┘
                                   └─ crash / lease expires (no clean exit):
                                        reaper sweep, attempts<MAX ─► PENDING (reclaimed)
                                        reaper sweep, attempts>=MAX ─► DEAD(reason='lease_exhausted')

   External-audit lane (anti-entropy): a DONE row whose SharePoint item is gone / hash-mismatched
      → re-enqueue to PENDING (corrupt re-mirror path; already exists today as integrity re-mirror).
```

**States (`mirror_status text`):**

| Status | Meaning | Terminal? | Maps to today |
|---|---|---|---|
| `PENDING` | Needs work; claimable when `next_attempt_at <= now()` | no | `backed_up_at IS NULL` & not skipped |
| `IN_PROGRESS` | Claimed by a worker, lease held | no | *(new — was invisible)* |
| `DONE` | Mirrored & recorded (`sharepoint_backup_ref` set) | yes | `backed_up_at IS NOT NULL` |
| `FAILED` | Transient failure, will retry (visible "retrying (n/8)") | no | `attempts>0 & backed_up_at NULL` |
| `DEAD` | Permanent / exhausted; **the dead-letter** — never self-heals, alert on it | yes | *(new — was invisible backlog)* |
| `SKIPPED` | Deliberately never mirrored (owner policy), with reason | yes | `skipped_reason IS NOT NULL` |

`FAILED` and `PENDING` are both "claimable"; `FAILED` exists purely so the UI and operators can *see* "this is
retrying because of X" versus "this is fresh work". Internally the claim query treats them identically
(`status IN ('PENDING','FAILED') AND next_attempt_at <= now()`).

**The one invariant that kills the whole bug class:**

> The worker writes `IN_PROGRESS` + `attempts++` + `lease_expires_at` **in one atomic statement, before it makes
> any Graph call.** A row is therefore *always* in exactly one explicit state. "Never attempted" is `PENDING with
> attempts=0`; a crash mid-upload is `IN_PROGRESS with an expired lease` (reclaimed automatically) — never an
> ambiguous NULL. The work selectors and the alert queries read the **same** `mirror_status` column, so they can
> never disagree again.

---

## 3. Schema (additive, layered on existing columns)

No existing column is dropped or repurposed. We **add** the state-machine columns and *derive their initial
values from the columns that already exist* (§7 backfill). This is the expand half of expand/contract.

```sql
-- db/NNN_sp_mirror_state.sql  (Phase 1)
ALTER TABLE documents ADD COLUMN sharepoint_mirror_status  text;         -- nullable first (no rewrite)
ALTER TABLE documents ADD COLUMN sharepoint_lease_expires_at timestamptz; -- lease / visibility timeout
ALTER TABLE documents ADD COLUMN sharepoint_locked_by       text;         -- worker holder id (fencing)
ALTER TABLE documents ADD COLUMN sharepoint_next_attempt_at timestamptz;  -- backoff schedule ("claimable at")
ALTER TABLE documents ADD COLUMN sharepoint_dead_reason     text;         -- why it's DEAD (forensics)
-- (sharepoint_backup_attempts, sharepoint_backup_error, sharepoint_backed_up_at,
--  sharepoint_backup_ref, sharepoint_skipped_reason, sharepoint_integrity … already exist and are REUSED.)
```

Adding a **nullable column with no default is metadata-only** — no table rewrite, no long lock (strong_migrations;
Postgres 11+). We deliberately do **not** `SET NOT NULL` in Phase 1 (that needs an `ACCESS EXCLUSIVE` full scan);
NOT-NULL is deferred to the contract phase via `CHECK (…) NOT VALID` → `VALIDATE CONSTRAINT` → `SET NOT NULL`.

**Partial index for the claim hot-path** (built `CONCURRENTLY`, its own non-transactional migration), scoped to
only claimable/active rows so it stays small as `DONE` grows unbounded:

```sql
CREATE INDEX CONCURRENTLY ix_documents_sp_claim
  ON documents (sharepoint_next_attempt_at, id)
  WHERE sharepoint_mirror_status IN ('PENDING','FAILED','IN_PROGRESS');
```

Column order = the claim `ORDER BY` so Postgres walks the index and stops at `LIMIT n` without a sort. Terminal
rows (`DONE`/`DEAD`/`SKIPPED` — the vast majority over time) are excluded from the index entirely.

---

## 4. The atomic claim (crash-safe, race-free)

The single most important query. It **claims fresh work AND reclaims crashed/expired-lease rows in one shot**,
using `FOR UPDATE SKIP LOCKED` so N concurrent passes (deploy overlap, future scale-out) never collide and never
head-of-line-block each other. This is River's `JobGetAvailable` shape, adapted.

```sql
WITH claimable AS (
  SELECT d.id
  FROM documents d
  WHERE COALESCE(d.sharepoint_next_attempt_at, d.created_at) <= now()
    AND (
          d.sharepoint_mirror_status IN ('PENDING','FAILED')                       -- fresh / retrying
       OR (d.sharepoint_mirror_status = 'IN_PROGRESS'
             AND d.sharepoint_lease_expires_at < now())                            -- crashed / lease expired
    )
    -- existing scope guards travel with the claim so semantics never change:
    AND <NEVER_MIRROR_SQL>                                                         -- §7.1
    AND NOT (<REGEN_KIND_SQL> AND d.is_current = false)                            -- §7.2 (NULL-safe COALESCE)
  ORDER BY COALESCE(d.sharepoint_next_attempt_at, d.created_at) ASC, d.id ASC      -- oldest-first (backfill order)
  LIMIT $batch
  FOR UPDATE SKIP LOCKED
)
UPDATE documents d
SET sharepoint_mirror_status   = 'IN_PROGRESS',
    sharepoint_backup_attempts = d.sharepoint_backup_attempts + 1,   -- increment at CLAIM, not completion
    sharepoint_lease_expires_at = now() + ($lease || ' minutes')::interval,
    sharepoint_locked_by        = $holder,
    sharepoint_backup_attempted_at = now()
FROM claimable c
WHERE d.id = c.id
RETURNING d.*;
```

**Why increment `attempts` at claim, not on failure:** a worker that dies mid-upload (OOM, deploy kill, power
loss) never records the attempt otherwise, so a genuinely poisonous document that reliably crashes the process
would be retried forever and never reach `DEAD`. Incrementing at claim makes `attempts` a durable "how many times
has anyone picked this up," which is what `MAX_ATTEMPTS` must be enforced against. River, graphile-worker, and
Oban all increment at claim for exactly this reason. A crash "burns" one attempt — the correct trade for a mirror.

**Fencing:** every terminal/`UPDATE` on a claimed row carries `AND sharepoint_locked_by = $holder AND
sharepoint_mirror_status = 'IN_PROGRESS'`, so a row reclaimed by the reaper and handed to another worker can't be
clobbered by the original slow worker when it finally returns.

---

## 5. Outcomes: success, throttle, transient, permanent, crash

**Success:**
```sql
UPDATE documents
SET sharepoint_mirror_status='DONE', sharepoint_backed_up_at=now(),
    sharepoint_lease_expires_at=NULL, sharepoint_locked_by=NULL,
    sharepoint_backup_error=NULL, sharepoint_next_attempt_at=NULL
WHERE id=$1 AND sharepoint_locked_by=$holder AND sharepoint_mirror_status='IN_PROGRESS';
```
(`sharepoint_backup_ref`, `sharepoint_version`, `sharepoint_web_url`, integrity fields stamped as they are today
by `uploadAndRecord`.)

**Failure — classified by the Graph response** (from the replication research). The classifier decides
retry-vs-dead-vs-throttle; this is the heart of "poison rows fail fast, transient rows heal":

| Graph status / condition | Verdict | Action |
|---|---|---|
| 200 / 201 | SUCCESS | → `DONE` |
| **429 TooManyRequests** | **THROTTLE** | → `PENDING`, `next_attempt_at = now() + max(Retry-After, RateLimit-Reset) + jitter(0..1s)`; **do NOT increment the permanent budget** (throttle ≠ failure) |
| 500/502/503/504, network/DNS/TLS/timeout | TRANSIENT | attempts<MAX → `FAILED`, `next_attempt_at = now()+backoff`; attempts≥MAX → `DEAD('transient_exhausted')` |
| 409 nameAlreadyExists | ADOPT | GET item; if provenance matches (app id + name + size/hash) → `DONE` (dedup, the existing `adoptIfIdentical` path); else `DEAD('path_collision')` |
| 404 upload-session gone | RESTART | discard session, restart upload (one transient attempt) |
| 400 invalid / 403 forbidden / 413 too-large / 415 / 405 / 411 | PERMANENT | → `DEAD(reason)` after `PERMANENT_CONFIRMATIONS` (2, or 1 if unambiguous) — avoids DEAD-ing on a fluke |
| 401 Unauthorized | AUTH | refresh token once; recurs → `DEAD('auth')` (config, don't spin) |
| 412 / 416 precondition/range | BENIGN | re-query state and continue; not a failure |

**Transient failure → FAILED:**
```sql
UPDATE documents
SET sharepoint_mirror_status = CASE WHEN sharepoint_backup_attempts >= $maxAttempts
                                    THEN 'DEAD' ELSE 'FAILED' END,
    sharepoint_dead_reason = CASE WHEN sharepoint_backup_attempts >= $maxAttempts
                                    THEN 'transient_exhausted' END,
    sharepoint_next_attempt_at = now() + ($backoffSecs || ' seconds')::interval,
    sharepoint_lease_expires_at = NULL, sharepoint_locked_by = NULL,
    sharepoint_backup_error = $err
WHERE id=$1 AND sharepoint_locked_by=$holder AND sharepoint_mirror_status='IN_PROGRESS';
```

**Backoff — AWS full jitter, capped** (decorrelates any future multi-worker retries; a single stuck row polls at
worst every `CAP`):
```js
// sleep = random_between(0, min(cap, base * 2^attempt))    — AWS "Exponential Backoff And Jitter"
const backoffMs = (attempt, base = 1000, cap = 300_000) =>
  Math.random() * Math.min(cap, base * 2 ** attempt);
```
Constants: `BASE=1s`, `CAP=300s (5 min)`, `MAX_ATTEMPTS=8` (keeps today's cap). Throttle uses `Retry-After` verbatim
+ 0–1s jitter and never shortens the header (honoring it is *required* — throttled requests still count against
Graph quota).

**Crash recovery** is not a code path in the worker at all — it's the reaper (§6) reclaiming an expired lease. The
worker can die anywhere and the row is never lost.

---

## 6. Self-healing lanes (anti-entropy) — three independent sweeps

Each runs on its **own timer and its own DB connection** so no lane can starve another.

**6.1 Lease reaper — every ~45s.** Reclaims orphaned `IN_PROGRESS` rows whose worker died:
```sql
UPDATE documents
SET sharepoint_mirror_status = CASE WHEN sharepoint_backup_attempts >= $maxAttempts THEN 'DEAD' ELSE 'PENDING' END,
    sharepoint_dead_reason   = CASE WHEN sharepoint_backup_attempts >= $maxAttempts THEN 'lease_exhausted' END,
    sharepoint_next_attempt_at = now(),
    sharepoint_lease_expires_at = NULL, sharepoint_locked_by = NULL
WHERE sharepoint_mirror_status = 'IN_PROGRESS' AND sharepoint_lease_expires_at < now();
```
Lease expiry is **not** a permanent attempt penalty beyond the one already burned at claim; the row simply becomes
claimable again. `LEASE` = a small multiple of the longest single mirror op (default 10 min, matching today's
`MIRROR_ATTEMPT_TIMEOUT_MS`). For very large uploads the worker heartbeats the lease (`SET lease_expires_at=now()+LEASE
WHERE id=$1 AND locked_by=$holder`) at ~lease/3 so a live-but-slow worker keeps its claim while a dead one is
reclaimed fast.

**6.2 Backlog sweep — every ~2 min.** Belt-and-suspenders: any `PENDING/FAILED` row whose `next_attempt_at` is far
in the past (fell through the hot loop) is re-surfaced. This is today's `neverAttemptedStrays` net, now trivially
correct because it reads the explicit status.

**6.3 External audit (anti-entropy) — delta hourly, deep hash daily.** A `DONE` row whose SharePoint item was
deleted or whose bytes drifted is re-enqueued to `PENDING` (with `conflictBehavior=replace`). This is exactly
today's integrity re-mirror / corrupt-mirror re-sync, now expressed as a state transition. Uses the Graph
`/delta` token (1 resource unit) for the cheap incremental pass.

---

## 7. Mapping onto EVERY existing mirror behavior (nothing lost)

The state machine is a *substrate*; all owner-directed semantics ride on top unchanged.

| Existing behavior (owner-directed) | Today | Under the state machine |
|---|---|---|
| **7.1 Never-mirror kinds** (`heter_iska_signed`, `appraisal_photo`, lead-CRM strays) via `NEVER_MIRROR_SQL` + settle pass | settle pass stamps `skipped_reason` | settle pass sets `mirror_status='SKIPPED'` + `skipped_reason`. **One writer**, so the appraisal_photo "excluded-but-not-stamped" gap is impossible — a row is never both out-of-scope and PENDING. |
| **7.2 Regen settle** (`REGEN_KIND_SQL`: track_record_html, tpr_export, draw_inspection_report, `%_export`) — a superseded regen snapshot settles *without uploading* (no Version-N churn) | `settleSupersededSnapshots` stamps skip; NULL-safe COALESCE guard | superseded regen → `SKIPPED('superseded snapshot')`. The COALESCE-NULL-safe guard (PR #510) stays in the claim predicate verbatim. |
| **7.3 Version-N folders** for human uploads (Version 1/2/3…) | `isSupersedeEvent` + `shuffleRootIntoVersion1` at upload time | unchanged — runs inside the `IN_PROGRESS` mirror op; state machine only governs *when* the row is claimed, not *how* it's filed. |
| **7.4 Regen long settle window** (10 min collapse of an edit burst) | `snapshotSettleSec()` gates eligibility | becomes `next_attempt_at = created_at + settle` on enqueue for regen kinds → the row is simply not *claimable* until the burst settles. Cleaner: settle is now a schedule, not a filter. |
| **7.5 Dedup / adopt-if-identical** (crash-safe: re-mirror finds its own prior copy) | `adoptIfIdentical` on 409/existing | the 409→ADOPT verdict (§5); provenance match → `DONE`. Deterministic target path makes retries idempotent. |
| **7.6 Integrity / corrupt re-mirror** (quickXor/size/sha mismatch → replace) | integrity fields + re-mirror | external-audit lane (§6.3) re-enqueues `DONE`→`PENDING`; upload uses `replace`. |
| **7.7 One-way / no-delete / never-touch-human-files** (SHAREPOINT-POLICY.md) | enforced in `mirrorRowInner`/`moveOwnItem` | **completely unchanged** — the state machine never reads SharePoint bytes, never deletes, only moves the portal's own mirror copies. |
| **7.8 "A SharePoint problem never breaks an upload"** | out-of-band best-effort | unchanged — the queue is still out-of-band; a DEAD row never blocks ingest. |
| **7.9 Global single-flight** (`sync_locks` 'sp-drain' lease) | one process runs the pass | kept as a coarse guard; the per-doc `FOR UPDATE SKIP LOCKED` claim is now the *fine* guard, so even overlapping processes are safe (needed during deploy cutover). |

---

## 8. Observability & alerting — alert on the DISEASE, not the symptom

The current backlog-**age** SLO alert is the metric that has produced every false alarm: a single poison row or a
healthy batch pins "oldest un-done age" without indicating a real problem. The AWS dead-letter guidance is
explicit — **alert on the contents of the dead-letter, not on age or send-rate**, because a move to DEAD emits no
event; polling its count is the *only* way to learn work died.

New alert set (pagers first):

| # | Alert | Condition | Severity |
|---|---|---|---|
| 1 | **Dead-letter present** | `count(*) WHERE mirror_status='DEAD'` > 0 | **PAGE** — real, permanent, never self-heals |
| 2 | **Orphaned leases** | `count(*) WHERE mirror_status='IN_PROGRESS' AND lease_expires_at < now()` > 0, sustained | **PAGE** — worker crashed/wedged |
| 3 | **Throughput collapse** | `DONE`/min ≈ 0 while `PENDING`>0 | **PAGE** — loop wedged |
| 4 | **Attempts rising** | `p95(attempts)` / `max(attempts)` climbing | WARN — dependency degrading (leading indicator) |
| 5 | **Oldest-PENDING age** | `now() - min(created_at) WHERE mirror_status='PENDING'` > SLO | WARN — *secondary* drain-rate check, generously thresholded |

Alert #5 replaces today's alert but is demoted to a warning and — critically — scoped to **PENDING only** (not
"oldest overall", which would include correctly-`IN_PROGRESS` and deliberately-`DEAD` rows). Single health-snapshot
query (`count(*) FILTER (WHERE …)` per state) backs an admin dashboard with per-state tiles, a DEAD list with a
one-click **requeue** action, and a stuck-lease list. Runbook maps each alert → exact triage SQL.

---

## 9. Zero-downtime rollout (expand → dual-write → shadow → cutover → contract)

Martin Fowler's Parallel Change / Stripe's four-phase migration, scoped to one DB + one worker. **Every step is
independently deployable and reversible; no step is a flag day.** Gated by a runtime feature flag
`SHAREPOINT_MIRROR_FSM = off | shadow | on` read each loop (flip = instant rollback, no redeploy).

- **Phase 1 — Expand + backfill (Task #44).** Additive migration (§3). Backfill `mirror_status` from existing
  columns in idempotent throttled batches (`WHERE mirror_status IS NULL … LIMIT 5000 FOR UPDATE SKIP LOCKED`,
  loop until 0):
  `backed_up_at IS NOT NULL → DONE`; `skipped_reason IS NOT NULL → SKIPPED`; `attempts >= MAX → DEAD`;
  `attempts > 0 → FAILED`; else `PENDING`. Ship a **pure state-transition library** (`sp-mirror-state.js`,
  no I/O) with exhaustive unit tests for every legal/illegal transition. `CREATE INDEX CONCURRENTLY`. Flag `off`.
- **Phase 2 — Claim-based worker (Task #45).** New claim/execute path behind the flag; dual-writes both the old
  columns and `mirror_status`. Flag `shadow`: the new claim query runs read-only and logs *which rows it would
  claim*; the existing worker still does the uploads. Compare candidate sets; require zero divergence over a
  sustained window (≥24h + one full backlog drain).
- **Phase 3 — Observability + alerting (Task #46).** New alert set + admin dashboard + requeue action, reading the
  explicit status. Old backlog-age alert demoted.
- **Phase 4 — Cutover + contract (Task #47).** Flip `shadow → on`: the FSM worker claims and uploads; old path
  stops claiming. Soak. Then remove old inference code, and only *then* enforce `NOT NULL` on `mirror_status` via
  `CHECK … NOT VALID` → `VALIDATE` → `SET NOT NULL`. Each phase passes the **two-audit gate + CI + merge**.

At no point is there downtime or a step whose failure loses/duplicates work: rows are always claimable by exactly
one path (`SKIP LOCKED` + fencing), backfill is idempotent, and rollback is a flag flip because the old columns
stay authoritative until Phase 4.

---

## 10. Constants (single source, `SHAREPOINT_MIRROR_*` env-overridable)

```
BASE_BACKOFF        = 1_000 ms          CAP_BACKOFF   = 300_000 ms (5 min)
MAX_ATTEMPTS        = 8                  LEASE         = 10 min (= MIRROR_ATTEMPT_TIMEOUT_MS)
PERMANENT_CONFIRMATIONS = 2 (1 unambiguous)   THROTTLE_DEADLINE = 24 h (wall-clock give-up → alert)
POLL/kick           = existing kick()    REAPER_INTERVAL = 45 s   BACKLOG_SWEEP = 2 min
AUDIT               = delta hourly / deep hash daily
User-Agent (decorate, avoid deprioritization): "NONISV|YS Capital Group|YS-Portal-Mirror/1.0"
```

## 11. Sources (implementation-grade, from Phase-0 research)

River (`JobGetAvailable`, `attempt^4`+jitter retry, `JobRescuer RescueAfter=1h`), graphile-worker (`get_job`
SKIP LOCKED claim, `exp()` backoff, `locked_at` reclaim), pg-boss (`expireInSeconds`, `retryDelay*2^n`, deadLetter),
Oban (state lifecycle, Lifeline orphan rescue); Microsoft Graph throttling (`Retry-After`, RateLimit headers,
`createUploadSession`/`conflictBehavior`, resumable `nextExpectedRanges`); AWS *Exponential Backoff And Jitter*
(full jitter) + DLQ CloudWatch alarm guidance; microservices.io transactional outbox / polling publisher;
Fowler *Parallel Change*, Stripe *Online migrations at scale*, ankane/strong_migrations, Squawk. Full URLs in the
Phase-0 research transcripts.
```
