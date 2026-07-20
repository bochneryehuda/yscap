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

## 6. A-to-Z audit round (2026-07-20, second sweep)

Four parallel read-only audit agents (upload ingress · Graph client · reconciler
worker · matcher/cards/routes/config) + a real end-to-end functional test
(`scripts/test-sharepoint-e2e-db.js` — drives the real mirror pipeline against
Postgres + local storage, stubbing only the Graph/folder boundary, and asserts
the happy path AND every error path: missing bytes → permanent card; transient
503 → retry, no premature card; permanent 403 → park + card; recovery → mirror +
card auto-closes).

### Fixed this round
- **Borrower-typo misfile (SAFETY, matcher A1):** the name-typo fallback used to
  file a document INTO a possibly-different person's existing folder (no
  house-number-equivalent anchor — John↔Joan, Cohen↔Kohen). Now it CREATES A NEW
  folder and flags the near-match for a human to merge only if truly the same
  person. A borrower's document can no longer land in the wrong person's folder.
- **Boot reset re-armed parked permanents (reconciler #1):** every deploy re-burnt
  Graph attempts on doomed docs. Boot reset now skips `[permanent]` like the daily
  reset does.
- **Error mis-classification (reconciler #2):** bare `400`/`403` matched anywhere
  in a message (a byte count / hex id) → a retryable error could be wrongly parked
  permanent. Numeric codes are now digit-boundary-anchored. Local-integrity
  mismatches now park (retrying identical damaged bytes can't help).
- **Lead/CRM attachments (ingress F1):** a `lead_id`-only doc (no pipeline scope)
  used to churn 8 doomed "no borrower/file" attempts and sit as permanent stuck
  noise. It's now excluded from the mirror and settled-skipped at the pass.
- **Health told the truth (reconciler #3):** malware / source-suspect /
  item-missing / local-missing / non-local docs (which keep `backed_up_at` set)
  are now counted in `needs_attention` and make `healthy` false — a mirror
  carrying human-action items no longer reports healthy.
- **Graph body-read timeout (client F1):** the abort timer now covers the response
  body read, not just headers.
- **Path-length (client F2):** the filename trim now reserves room for the
  uniquifier suffix so a trimmed+uniquified name can't exceed the ~400-char limit.
- **Sanctioned-delete fail-closed (client F4/F6):** `corruptSize` and an `If-Match`
  eTag are now REQUIRED (were conditional) — the one delete path refuses rather
  than proceed unpinned/unverified.
- **Admin routes (C1/C2):** `/escalate-stuck` is fire-and-forget (no minutes-long
  blocking request racing the drain); `/doc/:id/remirror` validates the id (clean
  400, no raw pg error leak).
- **Config guards (D1/D2):** a loud warning when the mirror is enabled but STORAGE
  is non-local; the poll interval is clamped to [60s, 1h] so an absurd value can't
  disable the watchdogs.
- **Orphaned cards (review B1):** a periodic sweep closes any mirror-failure card
  whose document has since mirrored/settled (belt to the per-success close).
- **Matcher defensive (A3):** `dlDistance` bails on pathologically long tokens.

### Deliberately deferred (reviewed, low-risk, documented)
- Deduped-doc verification (reconciler #5) and cross-condition dedup (reconciler
  #4) — narrow/latent; touch the delicate dedup-identity path.
- Verify pass not dead-man-switched (reconciler #7) — verify is non-critical and
  has its own stall guard; acceptable.
- Force-attempt not single-flighted with the drain (reconciler #8) — safe in
  practice (adopt-on-conflict + expected-parent guards).
- Graph token-field validation (F5), Office size==0 band (F3), marker-strip anchor
  (matcher A2), appraisal-import kick / chat-attach filename (ingress F3/F4) —
  cosmetic/defensive; no correctness or data-safety impact.

## 7. Test-coverage round 2 + industry-standards assessment (2026-07-20)

Owner asked for another round of end-to-end testing on sections not yet covered,
plus industry research to make the integration top-notch. Two new suites close the
two highest-risk coverage gaps, and an industry-standards checklist confirms the
table-stakes items are already implemented.

### New test suites (both no-DB, in `npm test`, CI-safe)
- **`scripts/test-sharepoint-matcher.js` (44)** — the fuzzy folder matcher
  (`sharepoint-map.js`) was previously exercised only indirectly (the e2e test
  stubs `resolveSyncFolder` out entirely), so the "which person's folder does a
  document land in" logic — the A1 bug class — had no direct coverage. Pins:
  marker stripping (new "Synced by Pilot" + legacy "YS portal syncing"),
  house-number-anchored address matching with suffix/directional normalization,
  unit/apt isolation, the Damerau-Levenshtein typo layer incl. the length>64
  cap, middle-name tolerance, officer names (no typo tolerance), and the CRITICAL
  "Moshe Katz" ≠ "Moshe Katzman" guard at BOTH the exact and typo layers.
- **`scripts/test-sharepoint-graph-guards.js` (24)** — fault injection over a
  stubbed global `fetch` (WireMock/Toxiproxy-style programmed Graph failures)
  drives the REAL `uploadNew`/`moveOwnItem`/`deleteReplacedCorruptMirror`
  (the e2e test stubs `uploadNew`, so its integrity check + the delete/move
  guards never ran under test). Proves: `conflictBehavior=fail` (never
  `replace`), size-mismatch/unverifiable-upload rejection with Office
  property-promotion tolerated, >4MB → resumable upload session, 409 → no
  clobber, `moveOwnItem` expected-parent + If-Match, and EACH of the seven
  delete guards tripped independently (G1 kill switch, required args, G3
  replacement-verified, G4 same-bytes, G5 expected-parent, G6 Pilot-tree
  ancestry, G7 If-Match) with the all-pass delete pinned by eTag.

### Industry-standards checklist — status against a best-in-class one-way mirror
Table-stakes items, all ALREADY implemented (verified in code this round):
- QuickXorHash-based verify tolerating Office property-promotion drift — yes
  (`isOfficeFormat` warn-only; provenance identity for Office).
- If-Match / eTag concurrency guard on the sanctioned delete AND the move — yes.
- Resumable upload session for >4 MB (5 MB chunks, Content-Range, session throttle
  handling) — yes; simple PUT only ≤4 MB.
- `Retry-After` honored on 429 AND 503/504 (seconds-or-HTTP-date safe) on both the
  core call and the upload-session loop — yes.
- `conflictBehavior=fail` (never `replace`) — yes, now asserted in a test.
- Malware facet selected + classified as its own parked verdict (never treated as
  corruption → never auto-deleted) — yes.
- Typed poison/park reason codes + reconciliation/chain-of-custody report + worker
  liveness SLO/watchdog — yes (§1–§5).

Genuinely-additive future ideas (NOT gaps, logged for later, none blocking):
- Transactional-outbox enqueue in the same txn as the portal save (today the
  reconciler scans for un-mirrored rows — robust, but an outbox would make the
  zero-loss guarantee structural rather than scan-based).
- Delta-query engine for the periodic audit (today a direct metadata compare —
  correct; delta would cut Graph calls at scale and surface human tombstones).
- Self-pacing token-bucket rate governor (today reactive backoff/breaker only).
