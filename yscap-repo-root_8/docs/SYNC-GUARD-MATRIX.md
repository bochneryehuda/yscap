# SYNC GUARD MATRIX (2026-07-17)

Companion to `docs/SYNC-FINAL-CONCLUSIONS-2026-07.md`. Every guard from the 80-guard program
catalog, grouped by domain and ranked within each domain.

**Scoring method.** Three independent judges each ranked their top 15 of the 80 guards. A guard
scores `16 − rank` per judge (rank 1 = 15 pts … rank 15 = 1 pt), 0 if unranked by that judge.
**Score = median of the three judges' points.** "Judges" = how many of the three ranked it. A
median of 0 with Judges 1/3 still signals one judge's conviction; unranked guards are not
worthless — they simply were not top-15 material against this field.

**Status.** `exists` = already enforced in production today · `partial` = machinery exists but the
guarantee has holes · `new` = does not exist yet. Duplicates across domain catalogs are marked
*(merge with #N)* — they are one guard, listed where each domain team proposed it.

**Lands in** maps to the build list in the final conclusions.

---

## Domain 1 — Outbound write path (portal → ClickUp)

| # | Guard | Status | Score | Judges | Failure it prevents | Lands in |
|---|-------|--------|-------|--------|---------------------|----------|
| 1 | Per-field write failure propagates — a push job cannot be "done" unless every intended write landed | new | **15** | 3/3 | F-C1: user edit silently dropped, job marked done, divergence invisible until a human notices wrong data | WO-1 |
| 2 | 429/Retry-After handling + global concurrency cap at the HTTP chokepoint | new | **14** | 3/3 | F-H1: rate-limit storms dead-lettering good writes; hammering a 100 req/min token shared with a co-tenant automation | WO-2 |
| 7 | Outbound parity auditor (DETECT): portal outbound-mapped values vs last ingest snapshot *(merged by judge 3 with #37 into one unified drift auditor)* | new | **12** | 3/3 | Any silent write loss the write path itself can't see — the F-C1 class detected independently of the code that caused it | WO-16 |
| 3 | Write-time binding assertion: the pre-read task's portal-stamp must match the app being pushed | new | **11** | 3/3 | Writing one borrower's fields onto another borrower's task after a re-link/duplicate mixup | WO-2 / WO-10 |
| 4 | Durable cross-process circuit breaker backed by the write journal *(merge with #54)* | partial (per-process, deploy-reset — F-M16) | 0 | 0/3 | A runaway write loop resuming at full speed because a deploy reset the counter | WO-4 |
| 5 | Read-back verification for sensitive writes (DOB, dates, SSN, name, status) | new | 0 | 0/3 | A write that "succeeded" but landed as a different value (ClickUp-side coercion, epoch re-daying) | WO-10 (pii_class hook) |
| 6 | Lost-enqueue backstop: loud enqueue failures + sweep detecting edits that never got a push job | new | 0 | 1/3 | F-M3: a portal edit that never generated a sync job, invisible forever | WO-5 |
| 8 | Create idempotency: search-by-stamp before any task create retry | new | 0 | 0/3 | Duplicate ClickUp tasks born from a create retried after an ambiguous timeout | WO-2 (create path) |
| 9 | Status freshness gate: never re-assert a stale portal status mirror onto ClickUp | new | 0 | 0/3 | F-M1: an old portal status overwriting the team's current pipeline stage | WO-10 (status → ClickUp-owned) |
| 10 | Outbound DOB/PII review rows auto-close on agreement | new | 0 | 1/3 | F-M20: DOB review rows that can never close, training staff that cards are noise | WO-6 |

## Domain 2 — Inbound ingest path (ClickUp → portal)

| # | Guard | Status | Score | Judges | Failure it prevents | Lands in |
|---|-------|--------|-------|--------|---------------------|----------|
| 19 | Ingest golden-fixture regression suite + CI that actually runs all suites *(judge 3: absorbs #39's CI wiring)* | partial (8 suites exist, green, nothing runs them) | **13** | 3/3 | Regressing any of the 9 incident fixes carried by 1,545-line, zero-coverage ingest.js | WO-13a + WO-19 |
| 12 | Persistent, pre-pass reconcile watermark that only advances past successes *(merge with #76)* | partial (in-memory, post-pass — F-M7) | **8** | 3/3 | Mid-pass ClickUp updates skipped forever; every deploy re-scanning 24h | WO-4 |
| 11 | Inbound dead-letter review row + boot re-drive (mirror of the outbound pattern) | new | **8** | 2/3 | F-M6: webhook inbox "error" = silent terminal drop of a real ClickUp edit | WO-3 |
| 16 | Inbound sync health heartbeat — staleness becomes a number, not a feeling | new | **5** | 3/3 | Dead inbound sync discovered only when a human notices ClickUp and PILOT disagree | WO-18 |
| 17 | Per-task advisory lock serializing `ingestTask` (single chokepoint, all callers) | new | **4** | 2/3 | Webhook drain + reconcile + boot sweep ingesting the same task concurrently and interleaving fills | WO-3 / WO-4 |
| 18 | Boot one-shot ledger: full-portfolio sweeps run at most once per window, not per deploy *(merge with #53)* | partial (pacing proven on 2 of 7 one-shots) | **10** | 3/3 | F-H4: 13 deploys/day = 13 portfolio-wide re-ingest storms on a 100 req/min token | WO-4 |
| 15 | Unknown-ClickUp-status alarm at the ingest chokepoint | new | 0 | 1/3 | A renamed/new ClickUp status silently mapping to nothing (or the wrong stage) portfolio-wide | WO-10 |
| 13 | Snapshot advances only when ingest actually persisted (evidence-integrity invariant) | new | 0 | 0/3 | "Human-edit-wins" evidence destroyed by a snapshot that advanced past a failed persist | WO-3 |
| 14 | Economic-magnitude quarantine on inbound money fields (currency twin of the year guard) | new | 0 | 0/3 | A $8,500,000 typo (or cents-vs-dollars) silently replacing $850,000 and repricing the deal | WO-10 (validators) |
| 20 | Backfill/reconcile per-task failure ledger on `clickup_task_index` | new | 0 | 0/3 | The same task failing every reconcile pass forever with no record it ever failed | WO-16 |

## Domain 3 — Identity & merge

| # | Guard | Status | Score | Judges | Failure it prevents | Lands in |
|---|-------|--------|-------|--------|---------------------|----------|
| 23 | G3: `nameConflict` VETO inside the email-corroboration auto-merge | new | **11** | 3/3 | F-M5: spouses/relatives on a shared family email + shared phone deterministically fused into one borrower | WO-12 |
| 21 | G1: ssn_hash written at EVERY SSN write, via one chokepoint + backfill | partial (hash exists; not all write paths stamp it) | **6** | 3/3 | Strong-match and never-merge veto silently dark for borrowers whose hash was never computed | WO-12 |
| 22 | G2: partial UNIQUE index on `borrowers(ssn_hash)` | new | 0 | 0/3 | Two borrower rows carrying the same real SSN (duplicate person) entering silently | WO-12 |
| 24 | G4: ONE borrower-adoption chokepoint for every `ON CONFLICT (email)` upsert | new | 0 | 0/3 | Scattered upserts adopting a borrower under different rules than resolveBorrower | WO-12 |
| 25 | G5: co-borrower shadow-profile dedup across the borrower's OTHER files | new | 0 | 0/3 | The same co-borrower minted as a new person on every file they appear on | WO-12 |
| 26 | G6 (DETECT): nightly identity-integrity scan → dedup candidates + one digest | new | 0 | 0/3 | Duplicate/miswired identities accumulating with no scheduled detection | WO-16 |
| 27 | G7: guarded MERGE action (the missing inverse of the split tool) | new | 0 | 0/3 | Staff hand-editing rows to fuse duplicates, bypassing every journal and guard | WO-12 (backlog) |
| 28 | G8: `allow_shared_email` becomes reversible + informed | partial (flag exists, irreversible — F-M17) | 0 | 0/3 | A one-click irreversible identity decision with no unlink and no explanation | WO-6 / WO-8 |
| 29 | G9: bound-task identity-fingerprint drift alarm | new | 0 | 0/3 | A linked task quietly becoming a different person's deal (duplicate-workflow artifact) | WO-16 |
| 30 | G10: `CHECK (borrower_id <> co_borrower_id)` on applications | new | 0 | 0/3 | A merge/mixup leaving a person as their own co-borrower, poisoning downstream logic | WO-12 |

## Domain 4 — Types, mapping & transforms

| # | Guard | Status | Score | Judges | Failure it prevents | Lands in |
|---|-------|--------|-------|--------|---------------------|----------|
| 32 | Unknown enum value never silently substitutes the default or drops — review instead | new (fixes a live wrong-write today) | **3** | 3/3 | A new ClickUp dropdown option silently mapped to the default (wrong program/type on a live deal) | WO-10 |
| 34 | Generalize the throw-on-violation round-trip invariant to every typed field | partial (dates only today) | **1** | 2/3 | The DOB-corruption class recurring on any other typed field (money, enum, phone) | WO-10 |
| 31 | Epoch plausibility window at the read chokepoint (fromEpochMs / toEpochMs) | new | 0 | 0/3 | A garbage epoch (1970/2106) ingested as a real date | WO-10 (validators) |
| 33 | Dropdown resolution: task-embedded options first, exact-match writes, cache-drift alarm | partial | 0 | 0/3 | Writing a dropdown by stale cached option-id → wrong label lands | WO-10 |
| 35 | Per-field numeric plausibility ranges at both chokepoints | new | 0 | 0/3 | Impossible magnitudes (0.75% ARV, $2 purchase price) crossing systems unchallenged | WO-10 (validators) |
| 36 | Strict numeric grammar in `parseMoney` — reject-to-review, never strip-and-guess | partial | 0 | 0/3 | "1.250.000" or "850k" guessed into a different number than the human meant | WO-10 |
| 37 | DETECT: scheduled cross-system value-drift diff *(merged with #7 — one pass, both directions)* | new | — | (see #7) | Divergence between systems that neither write path noticed | WO-16 |
| 38 | DETECT: per-field oscillation alarm over the existing journals | new | 0 | 0/3 | Two automations ping-ponging a field (also the FMEA R3 deletion-refill churn signature) | WO-16 |
| 39 | Load-time crosswalk bijectivity assertion + CI actually running the transform/mapper suites | partial (absorbed into #19 by judge 3) | 0 | (via #19) | Two portal values mapping to one ClickUp value (or back) and silently swapping on round-trip | WO-13a |
| 40 | Transform provenance in both journals (raw value + resolution path) | new | 0 | 0/3 | Post-incident forensics unable to say WHY a value transformed the way it did | WO-11 |

## Domain 5 — Documents & SharePoint mirror

| # | Guard | Status | Score | Judges | Failure it prevents | Lands in |
|---|-------|--------|-------|--------|---------------------|----------|
| 41 | G-D1: Ephemeral-storage upload gate | new | **1** | 3/3 | Borrower documents written to a temp dir that vanishes on restart (silent byte loss) | WO-14 / WO-17 |
| 42 | G-D2: Content hash on every document (write-time seal, read-time verify) | new | 0 | 0/3 | Corrupted/truncated bytes served or mirrored without anyone knowing | WO-17 |
| 43 | G-D3: Document delete quarantine (tombstone instead of unlink) | new | 0 | 0/3 | A wrong delete destroying the only copy of a borrower document | WO-17 |
| 44 | G-D4: First-contact fuzzy-match confirmation (no silent adoption of a non-exact folder match) | new | 0 | 0/3 | F-H2: SSN-bearing docs auto-filed into a name-similar stranger's SharePoint folder | WO-14 |
| 45 | G-D5: Folder-binding exclusivity invariant | new | 0 | 0/3 | Two borrowers bound to one SharePoint folder, interleaving their PII | WO-14 |
| 46 | G-D6: Resolver-input drift re-resolution | new | 0 | 0/3 | A renamed borrower/address leaving mirrors filing into the old (now wrong) folder | WO-14 |
| 47 | G-D7: Mirror liveness + backlog alarm (including the enabled-flag trap) | new | 0 | 0/3 | The mirror silently off (today's live state: coded Jul 13, never enabled, zero alarms) | WO-14 / WO-18 |
| 48 | G-D8: Authorization enforced inside the document-serving chokepoint | partial | 0 | 0/3 | A route added later serving borrower docs without the scoped-access check | standing (audit) |
| 49 | G-D9: Post-upload mirror verification (size + parent echo-check) | new | 0 | 0/3 | A mirror "success" that landed a 0-byte file or filed into the wrong parent | WO-14 |
| 50 | G-D10: Daily document-integrity digest + missing-bytes sweep | new | 0 | 0/3 | Documents rows whose bytes are gone, discovered only at closing | WO-16 / WO-17 |

## Domain 6 — Deploy, config & change management

| # | Guard | Status | Score | Judges | Failure it prevents | Lands in |
|---|-------|--------|-------|--------|---------------------|----------|
| 55 | CI gate: run the existing green suites + `node --check` + eslint no-undef on every PR | partial (suites exist; nothing runs them) | 0 | 0/3 | Shipping a regression of any locked incident fix; render-crash ReferenceErrors reaching prod | WO-13a |
| 51 | `schema_migrations` ledger with checksum + fail-loud on migration failure | new (F-M19) | 0 | 0/3 | Silent migration failure booting a schema the code doesn't match (the WO-7 42703 class) | WO-13a |
| 52 | Migration file invariants check: unique numbers, append-only, idempotency smoke | new | 0 | 0/3 | The three live duplicate-number collisions class recurring | WO-13a / WO-6 |
| 53 | Cross-deploy throttle on boot one-shot portfolio sweeps (DB-persisted last-run) *(merge with #18)* | partial | — | (see #18) | F-H4 boot storms | WO-4 |
| 54 | Durable outbound circuit breaker backed by `clickup_write_log` *(merge with #4)* | partial | — | (see #4) | F-M16 deploy-reset breaker | WO-4 |
| 56 | Committed-bundle ↔ source parity check for the V2 portal | new | 0 | 0/3 | Frontend fixes committed in `app-v2/src` but never actually deployed (stale bundle) | WO-13a |
| 57 | Production config fail-fast / degraded-mode chokepoint in `config.js` | partial (JWT/SSN key checks exist) | 0 | 0/3 | Booting prod with noop email / missing sync env and running silently degraded | WO-18 |
| 58 | Dual-key go-live switches with flip detection (env flag AND persisted DB acknowledgment) | new | 0 | 0/3 | A one-env-var accidental go-live of the SharePoint mirror (or outbound sync) | WO-14 |
| 59 | Single-writer leader election for sync loops + prod-DB-from-nonprod refusal | new | 0 | 0/3 | Render deploy-overlap running two drains against one token/queue; a laptop pointed at prod | WO-4 (partial via locks) |
| 60 | DETECT: deploy ledger + post-deploy delta canary report | new | 0 | 0/3 | "Which of the 13 deploys broke it" being unanswerable | WO-18 |

## Domain 7 — Review queue & human actions

| # | Guard | Status | Score | Judges | Failure it prevents | Lands in |
|---|-------|--------|-------|--------|---------------------|----------|
| 67 | Value-aware sticky dismissals for field rows | partial (value-agnostic today — F-M8/M9) | 0 | 0/3 | A July dismissal suppressing October's different-fact recurrence (FMEA R7); OR the same card respawning forever | WO-8 |
| 64 | High-stakes fields are per-row-only (excluded from bulk resolve) | new | 0 | 0/3 | FMEA R6: a fatigued bulk-approve overwriting correct DOBs with full human authority | WO-7/WO-8 |
| 66 | Per-recipient notification cap with roll-up digest at the notify chokepoint *(merge with #79)* | new | 0 | 0/3 | Uncapped per-row LO email floods (the exact flood that trains staff to dismiss) | WO-7 |
| 61 | Atomic claim-then-apply on every review resolution | partial | 0 | 0/3 | Two staff resolving one card concurrently, double-applying to borrower PII | WO-2(d) + WO-8 |
| 62 | What-you-saw-is-what-you-approve (optimistic concurrency on card values) | new | 0 | 0/3 | Approving a card whose underlying values changed after it was rendered | WO-8 |
| 63 | Sanitizer parity on the legacy approve path | new (F-M12) | 0 | 0/3 | The one un-sanitized approve path re-admitting the DOB garbage every other path blocks | WO-6 |
| 65 | Resolution outcome verification — never mark resolved on a half-applied fix | new | 0 | 0/3 | A "resolved" card whose winner value only landed on one of the two systems | WO-8 |
| 68 | Two-step confirm + an inverse for irreversible review actions | partial (F-M17) | 0 | 0/3 | One-click irreversible decisions (allow_shared_email) with no undo | WO-6 / WO-8 |
| 69 | DETECT: queue health gauges + hour-scale flood alarm + day-0 unassigned escalation | new | 0 | 0/3 | A queue flood (or an orphaned card) sitting invisible until it ages into an incident | WO-18 |
| 70 | Full-queue visibility: oldest-first ordering + pagination on the open list | partial | 0 | 0/3 | Old cards scrolled off the bottom of an unpaginated list, never seen again | WO-8 |

## Domain 8 — Observability & telemetry

| # | Guard | Status | Score | Judges | Failure it prevents | Lands in |
|---|-------|--------|-------|--------|---------------------|----------|
| 72 | Per-field write failure fails the job + journaled as error *(merge with #1 — telemetry facet)* | new | — | (see #1) | F-C1 plus its forensics: failure counts become queryable | WO-1 |
| 73 | Nightly read-only portal↔ClickUp drift audit with summary report *(merge with #7/#37)* | new | — | (see #7) | Divergence detection independent of the sync path | WO-16 |
| 76 | Durable reconcile watermark + inbound-lag metric *(merge with #12)* | partial | — | (see #12) | F-M7 plus lag-as-a-number | WO-4 / WO-18 |
| 74 | 429 / non-2xx accounting at the ClickUp client chokepoint | new | 0 | 0/3 | Flying blind on rate-limit pressure shared with the co-tenant automation | WO-2 |
| 75 | Webhook liveness detector (dead-webhook alarm) | new | 0 | 0/3 | ClickUp silently suspending the webhook at fail_count 100 → invisible event loss | WO-3 |
| 77 | Immediate page-out on breaker-open and overwrite-storm, with durable breaker state | new | 0 | 0/3 | The breaker opening (a five-alarm event) and nobody knowing until the queue backs up | WO-18 |
| 78 | Deploy-tagged boot-sweep budget and summary (re-ingest storm telemetry) | new | 0 | 0/3 | Boot storms with no per-deploy accounting (the WO-4 acceptance metric's data source) | WO-4 |
| 79 | Notification flood governor with digest rollup and delivery accounting *(merge with #66)* | new | — | (see #66) | Email floods AND silent email death — delivery becomes accounted, not fire-and-forget | WO-7 / WO-18 |
| 80 | Foreign-actor and echo-write detection on the shared ClickUp token | new | 0 | 0/3 | The second unidentified automation writing anonymously as "Yehuda" forever | WO-9 |
| 71 | Sentinel sweep + ops alert channel for terminal-failure states | new | 0 | 0/3 | Terminal states (dead-letters, suspended webhook, mute email) with no second-channel alarm — FMEA R4 | WO-18 |

---

## Reading the matrix

- **The consensus fifteen** (every guard with a non-zero median, §3 of the conclusions doc) are the
  program's spine; all fifteen are scheduled in Stages 0–4.
- **Zero-median guards are not rejected.** Most land "for free" inside a WO they naturally belong to
  (registry validators absorb #14/#31/#35; the recon absorbs #20/#26/#29/#38/#50; WO-18 absorbs the
  alarm cluster #69/#71/#77/#60). The registry (WO-10) is deliberately the single largest absorber:
  a guard that can be a registry row instead of code should be a registry row.
- **Six duplicate pairs** were proposed independently by different domain teams (#1/#72, #4/#54,
  #7/#37/#73, #12/#76, #18/#53, #66/#79). Independent rediscovery is signal: five of the six pairs
  sit in the program's Stage 0–1 critical path.
- Status counts: **exists 0 · partial 17 · new 63** (counting merged duplicates once). That ratio is
  the honest summary of the audit: the system's walls are real, but almost everything that makes
  them *structural* rather than reactive is still to be built.
