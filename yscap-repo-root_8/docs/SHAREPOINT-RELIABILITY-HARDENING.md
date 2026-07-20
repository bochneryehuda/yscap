# SharePoint sync — reliability hardening (root-cause map + standards)

Owner-directed 2026-07-20 ("we had so many issues of the same type — go to the
root, harden against the whole class, make it solid-proof and silent"). This
records every incident this integration hit, the ROOT cause and the failure
CLASS, and how the system is now engineered against that class — grounded in
standard reliable-background-worker practice.

## 1. Every incident → root cause → class → status

| # | Symptom | Root cause | Class | Fixed by |
|---|---------|-----------|-------|----------|
| 1 | Files corrupted / won't open | `data:`-URL prefix reached Node's lenient base64 decoder, which silently skips invalid chars and garbles every byte | Silent data corruption at an unbounded input | Strict `decodeUploadBase64` chokepoint at all upload sites (reject, never garble) |
| 2 | "47 versions" of one document | Every 2.5s autosave superseded the last and the mirror minted a Version-N folder per autosave | Churn / no coalescing of a regenerable stream | Coalesce same-session autosaves; settle superseded snapshots WITHOUT uploading; regen kinds never version-shuffle |
| 3 | xlsx stuck "name conflict persisted" | SharePoint rewrites Office files seconds after upload ("property promotion") — size+hash drift → false corruption + re-upload loop | Comparing bytes of a thing the far side mutates | Office identity by PROVENANCE (`createdByThisApp`), never byte-compare Office post-upload |
| 4 | Review cards said "permission failure" | The card never surfaced the actual recorded error | Misleading / non-actionable alert | Show the real "Last error" on every card |
| 5 | SLO email, empty review queue; transient errors churned forever | No ceiling on transient-error suppression → stuck-but-silent | Silent infinite retry / poison churn | `stuckDocuments` + `escalateStuckDocs` card regardless of class past a threshold |
| 6 | Docs retried 8× then re-armed daily forever | No classification of permanent vs transient failure | No dead-letter discipline | `classifyMirrorError`: permanent → card fast + PARK; transient → retry |
| 7 | Doc "not yet attempted", invisible | A doc could be excluded from the single selection query yet counted as pending | Counted-but-never-selected divergence | Every-pass stray-net force-attempt + `explainExclusion` logging; NULL-safe selection |
| 8 | Same SLO email twice on restart | Dedup lived in process memory, reset on boot | In-memory state lost on restart | Persistent DB cooldown (`sync_locks`) |
| 9 | **Nothing synced for ~6 hours; docs "not yet attempted"** | The drain's in-memory `_running` single-flight flag had no escape: any hung `await` (a lock-blocked DB query has no timeout in node-postgres) left it stuck `true`, so every later pass returned early — a total freeze — while the backlog alarm (a separate timer) kept emailing | **Unbounded hang + no worker-liveness signal** | Per-document `withTimeout`; drain stall-guard + heartbeat + generation token; **this** hardening extends it (below) |

The recurring theme across #5–#9: this is a **background queue-drain worker**, and it
kept failing the way naive background workers fail — a single item or query could
stall/poison the whole loop, failures were silent or the alarm watched the wrong
signal, and recovery needed a manual restart.

## 2. Standard practice for this class (grounded)

From SRE / message-queue / background-job literature (Google SRE book; AWS
Builders' Library timeouts+backoff; dead-letter/poison-message handling;
worker-liveness / dead-man's-switch; Postgres statement timeouts):

1. **Liveness / heartbeat / watchdog** — watch that the *worker* is alive and
   *progressing*, not just the backlog. A frozen worker with an empty queue looks
   healthy; a slow worker with a big queue looks dead. Persist a `last_progress`
   timestamp; a watchdog self-heals, then alerts on the *absence* of progress.
2. **Bound every operation** — per-task/HTTP timeouts AND a DB `statement_timeout`
   so no single call can hang the loop.
3. **Poison-message / dead-letter** — attempt ceiling; transient vs permanent
   routing; on exhaustion move to a visible dead-letter state with the stamped
   error — never silent churn, never silent drop.
4. **Idempotency + backoff-with-jitter + circuit breaker** — retries produce the
   same *effect* as once; jitter avoids retry storms; a breaker stops hammering a
   down dependency.
5. **Observability** — a health surface exposing last-successful-pass age,
   oldest-pending age, pending/in-flight/dead-letter counts, worker-alive.
6. **Alerting discipline** — alert on symptoms users feel + worker liveness (not
   causes); dedup + cooldown + auto-resolve; self-heal first, page only if that
   fails; every alert actionable.

## 3. How the system now meets it

| Standard | Mechanism in `src/lib/sharepoint-backup.js` |
|----------|---------------------------------------------|
| Liveness heartbeat | `recordHeartbeat` stamps a persistent dead-man's switch row (`sync_locks` `sp-drain-heartbeat`) on every completed pass; `heartbeatStaleSec` reads it cross-process |
| Watchdog + self-heal + alert | `checkDrainLiveness` on its own interval: stale past grace → kick a recovery drain (silent); stale past 2× grace (self-heal failed) or never-started → alert admins ONCE (persistent dedup, distinct "worker stalled" email); recovery auto-clears |
| Stall-proof drain AND verify | `drain` and `drainVerify` both: stall-guard (abandon a wedged pass past 15 min) + progress heartbeat + generation token; a resumed zombie can't run concurrently or reset a newer pass |
| Bound every operation | Per-document `withTimeout` (mirror 10 min; verify 2 min); pre-loop settle/select/daily-reset/lease-acquire all wrapped in `withTimeout` (DB-lock-proof); Graph calls already have 60s/180s socket timeouts + capped retries |
| Throughput / no monopoly | Per-drain wall-clock budget (`DRAIN_BUDGET_MS`) yields the slot so a slow backlog can't starve fresh uploads for hours |
| Dead-letter | `classifyMirrorError` + PARK permanent failures; `escalateStuckDocs` cards anything stuck past the threshold with the real reason |
| Idempotency | adopt-on-conflict + sha256 dedup + cross-process `sync_locks` leases; `conflictBehavior:'fail'` (never overwrite) |
| Backoff + jitter | `graph()` honors `Retry-After`, exponential backoff **with jitter**, capped |
| Observability | `health()` → `lastPassAgeSec`/`stalled`; `reconciliation().worker` → `lastPassAgeSec`/`stalled`/`inFlightAgeSec`/`verifyRunning`, and `healthy` now goes false when the worker is stalled (the freeze lesson); `nonlocal_pending` counts otherwise-invisible non-local docs |
| Alerting discipline | Backlog alert only when there are NAMED docs; liveness alert self-heals first and is deduped per episode with a distinct key; both survive restarts |

## 4. Deliberately deferred (documented, not silent)

- **Deduped-doc verification (gap-audit #6):** a byte-dedup row rides its
  sibling's mirror and is not independently re-verified; if a human deletes the
  sibling item the dependent's URL 404s undetected. Lower severity; touches the
  delicate dedup-identity path. Track for a dedicated change.
- **Full non-local re-surfacing (gap-audit #5):** non-'local' provider docs are
  now COUNTED (`nonlocal_pending`) so they can't be fully silent, but are still
  not re-driven every pass. Latent — every document is `local` today (s3/sharepoint
  storage providers are stubs). Revisit when a second provider ships.
- **External supervisor / crash-restart:** on Render the platform restarts a
  dead process; the in-process watchdog covers "up but stalled." A true external
  dead-man's switch (uptime monitor hitting `/health`) is an ops add-on.
- **`settle*` hoisting + path-budget/uniquifier-suffix:** minor efficiency/edge
  items from the gap-audit; no correctness impact.

## 5. The same pattern applies to the other workers

The ClickUp, SiteWire, e-sign, and reminder loops are the same class of
background worker. This SharePoint worker is now the reference implementation for
liveness+timeouts+dead-letter+observability; apply the same pattern there in a
follow-up rather than waiting for each to have its own incident.
