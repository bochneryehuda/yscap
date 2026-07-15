# Annual Sync Audit — Bidirectional ClickUp Sync, SharePoint Mirror, Error Handling & Manual Review

**Date:** 2026-07-15 · **Scope:** the full sync stream (portal ⇄ ClickUp, portal → SharePoint), its error handling, the manual-review system, every deploy/enhancement in the repo's history (491 commits, Jul 5–15), and live-tenant evidence where reachable.
**Method:** 21 AI auditors in three waves — 8 subsystem code-finders with adversarial verification of every critical/high finding, 2 full-history forensic agents, 3 deep-dive analysts (blueprint conformance, test coverage, review-queue load), 6 industry-research agents with a gap-analysis synthesis, plus independent hand-verification of the core paths and a live read-only probe of the SharePoint tenant. Findings below cite `file:line` at `origin/main` (`8f3e23a`) and commit SHAs.

**Access notes:** this session's network policy blocks `api.render.com` and `api.clickup.com` (connections refused at the gateway before any credential is sent), so live Render/ClickUp data could not be pulled from here. The pasted API keys were used for nothing, transmitted nowhere — and having appeared in a chat transcript they should be **rotated**. Live DB/ClickUp evidence is obtainable in one command via `scripts/audit-evidence-report.js` (committed with this report; runs read-only in the Render Shell using the env vars already there).

---

## 1. Executive summary

**The question you asked:** why does the sync keep messing up sensitive data, why is error handling a daily firefight, and how do we make integrations only help?

**The answer, in one paragraph:** the sync was built in ~8 hours overnight (Jul 6→7) and its outbound writes were enabled with the design's own safeguards explicitly waived — the first data-corruption incident hit **32 minutes after go-live**. Everything since (~45 guard layers, 19 review-card types, 7 boot one-shots) has been added reactively, incident by incident, by parallel sessions under pressure. The result today is genuinely far safer than a week ago — 11 failure classes are now *structurally impossible* — but the error-handling model has three systemic defects that keep you in the loop all day: **(a)** failures on the write path are handled asymmetrically (reads fail closed, writes fail *silent* — one confirmed-critical bug marks a failed push "done" and drops the user's edit); **(b)** the review queue is diverging — every incident adds a new card type, most card volume is informational, dismissals don't stick for the noisiest types, and every card emails the LO with no rate cap, multiplied by 13 deploys/day re-running full-portfolio sweeps; **(c)** three foundational items the blueprint itself called for were never built — a dedicated ClickUp bot identity (attribution), rate-limit handling (429/Retry-After), and per-field authority as data. Separately, a live probe of your tenant shows the **SharePoint document mirror has never actually run in production** — no sync-created folder exists anywhere.

**Verdict on the recurring pattern:** chokepoint fixes stayed dead (the date convention, the client hard-stops, `decideDob`); call-site/instance fixes recurred within a day (stamp → loan-number → race → defer; role re-seat ×3). The path out is not more guards — it is moving the remaining heuristics to the same chokepoint discipline, making failure *loud by invariant* ("every failed sync op ends as a retry or a review row — never silently done"), and cutting review noise at the notification layer.

---

## 2. What was deployed — the complete ledger

Full history: **491 commits, 2026-07-05 → 07-15** (repo was born Jul 5; the visible shallow history began at Jul 15 and was un-shallowed for this audit). Sync-relevant timeline:

| Date | Commits | What happened |
|---|---|---|
| Jul 6 22:35 | `9836fda` | Sync **blueprint** locked (584 lines) — "PROPOSAL, nothing implemented" |
| Jul 6 23:50 – Jul 7 03:57 | ~20 | **Entire sync built overnight**: migrations, mapper, client, orchestrator, ingest, worker |
| Jul 7 07:07 | `6a0c276` | Outbound auto-push enabled; commit message: *"The ONLY protection is no deletion"*; dirty-sweep accelerated 10s→3s |
| Jul 7 07:39 | `dc91df8` | **Incident #1** (32 min later): overwrite loop; sweep killed; restore tooling |
| Jul 7 (day) | ~15 | Scoped push, never-full-push, delete hard-stop, manual-review v1, checklist sync |
| Jul 9 | 4 | File-duplication incidents; orphan auto-heal; vesting rewrite |
| Jul 12 | 6 | Sync integrity audit; concurrency dup guards; case-insensitive matching |
| Jul 13 | 4 | **SharePoint mirror built** (policy, fuzzy matcher, Version-N); hotfix 29 min after ship |
| Jul 14 | 3 | Date root-cause (`53578e0`); duplicated-task root fix (`f346033`) |
| Jul 14 21:00 – Jul 15 16:36 | ~40 | The 40-hour wave: write journal, review queue (0→19 card types), DOB lockdown→auto-resolve→human-edit-wins, PII shield, circuit breaker, duplicate lifecycle, loan-number adjudication, wrong-merge detection ×3, role re-seat ×3, file-level reviews, identity audit, Unknown-Unknown fix (`8f3e23a`, HEAD) |

**13 deploys on Jul 15 alone.** Merge discipline across parallel sessions substantively **held** — an added-line survival analysis over every window commit found zero silently-clobbered guards (the 7-layer DOB gate composed intact across commits from different sessions), and 67/67 frontend commits correctly committed rebuilt bundles. The one recurring violation: **migration-number collisions** (033 ×2, 088 ×2, 113 ×2) — harmless today only because every migration is rigorously idempotent and the runner is filename-ordered.

---

## 3. The complete incident history (16 incidents, forensically reconstructed)

| # | Incident | Real damage? | Root-caused? | Recurred? |
|---|---|---|---|---|
| 1 | Jul 7 overwrite loop (sweep round-tripped ingested data; placeholders clobbered real contacts) | **Yes** | Loop: yes (sweep deleted). Placeholder class: no — persisted to #16 | Yes (class) |
| 2 | Jul 9 file duplication (task deleted+recreated → orphan twins) | Yes (portal) | Mechanism only | Yes → #3,9,10,11 |
| 3 | Duplicated-task copied-stamp → silent `ambiguous` forever | Yes | Stamp key only | Yes → #9 |
| 4 | Lichtman "financial profile wiped" | **False alarm** (ClickUp-UI duplicate; original intact) | n/a — cost a forensic day due to shared token | Attribution class still open |
| 5 | DOB −1 day corruption (UTC-midnight epochs re-dayed by ClickUp; 10 DOBs) | **Yes, silent, systemic** | **Yes — structural** (strings end-to-end + throw-on-violation round-trip) | No new corruption |
| 6 | Year-0026 closing dates (save-per-keystroke) | Yes | Yes — 3 layers | No |
| 7 | Yaniv Erez 8-field wipe + literal `"undefined"` | Programmatic but **not this codebase** (second automation, same token) | Portal side yes; foreign automation **unresolved** | Open risk |
| 8 | Restore script rewrote DOBs without review (Shaindel Schwimmer) | Yes — caused by our own repair tool | Yes (DOB lockdown, one decision fn) | Over-blocked → #12 |
| 9 | Copied loan number → silent ambiguous (Asher Salamon) | Yes | Partial (left race) | Yes → #10 same day |
| 10 | First-claim-wins loan number (Abraham Gruber) | Yes | Yes (live adjudication) | No |
| 11 | Successor-deal deferred forever (Shulom Eisenberg) | Stuck state | Yes (`isTerminal` exception) | No |
| 12 | Owner's own ClickUp DOB fix parked in review (Shalom Elbaum) | Guard-caused | Yes (human-edit-wins channel) | No |
| 13 | Shadow-email noise ×hundreds (Avrohom Kopel) | Noise | Symptom then root (#16) | Fed #15 until HEAD |
| 14 | Wrong-person merge on shared family email+surname → file leaked to wrong officer (Mendelovits/Cohen) | **Yes + access leak** | Yes — on the **3rd** attempt | Split repair unverified in prod |
| 15 | Role swap borrower⇄co-borrower ×4 tasks (Boruch Stauber) | Yes | Yes — on the **3rd** attempt (`6b62ee1`) | Terminal fix at HEAD−1 |
| 16 | "Unknown Unknown" profile factory (title-blind read + floor-less creation) | Yes (noise + husk profiles) | Yes (`8f3e23a`, HEAD) | Heal pending deploy |
| — | Stale-tab "two different DOBs" | False alarm on data, real UX bug | Yes (no-cache + watchdog) | No |

**Counts:** ~45 guard layers added reactively in 9 days (~35 in one 40-hour window). **5 incidents needed 2–3 fix attempts.** Two false alarms consumed real forensic days — both traceable to the **shared ClickUp token identity** (you cannot tell the portal's writes from anyone else's).

**Structurally dead classes (provably impossible now):** task deletion; field wipes both directions; task rename/description writes; the echo/overwrite loop; date day-walk; garbage years reaching ClickUp; scoped-push task creation; silent stuck files (review rows + boot retry); un-reviewed automated DOB rewrites; email+surname merges; identity-less profile creation.

**Merely guarded (heuristic, can still miss):** PII overwrite shield; volume breaker (per-process, resets on deploy); duplicate-defer address heuristics; loan-number "older task wins"; DOB plausibility windows; human-edit-wins (snapshot-dependent); wrong-merge detector (signature-based — already missed the phone shape once); same-place address judgment; title-name fallback; backdating provenance. **Not guarded at all:** the second automation writing under your token.

---

## 4. LIVE FINDING — the SharePoint mirror has never run in production

A read-only probe of the actual tenant (via the Microsoft 365 connector, signed in as the owner) shows:

- Pipeline Drive is real and heavily used by humans: 695 documents modified since Jul 12, officer→borrower→address→Closing/DRAWS/SOW structure, including the exact borrower folders from the incidents.
- **Zero sync-created artifacts exist anywhere in the tenant**: no "Synced by Pilot", no "YS portal sync(ing)", no "Unfiled", no sync-style `Term Sheet/Unsigned`. The index demonstrably covers the drive (finds lowercase partials in deep paths).

**Conclusion:** the mirror shipped Jul 13 (code, policy, Version-N history, mirror-failure reviews) has almost certainly **never executed** — consistent with `SHAREPOINT_BACKUP_ENABLED` / `SHAREPOINT_DRIVE_ID` / `MS_*` never being set in Render (`render.yaml` lists them as "fill in the dashboard").

- **Good news:** the mirror's wrong-folder risks (see F-SP1) have never had a chance to hurt you; nothing was ever mis-filed because nothing was ever filed.
- **Bad news:** if you believed portal-uploaded borrower documents were being backed up since Jul 13 — **they are not**. The only copy is the Render persistent disk. Single point of failure for every borrower document in PILOT.
- **Verify in 30 seconds:** Render → Environment → is `SHAREPOINT_BACKUP_ENABLED=1` set? Or run the evidence script — its SharePoint section will read `mirrored: 0`.
- **Do not enable it until F-SP1 is fixed** (below).

---

## 5. Verified findings (ranked)

Every CRITICAL/HIGH was adversarially verified by an independent agent tracing the code path; one HIGH claim was refuted and removed. IDs are stable for tracking.

### Critical

**F-C1 — CONFIRMED. A failed field write is swallowed and the push job is marked done: the user's edit is silently dropped.** `src/clickup/orchestrator.js:346-349` — the per-field loop catches any `setField` error (except breaker-open), logs to console, and continues; `pushApplication` returns success; `pushOutboxOnce` marks the job `done`. A ClickUp 429/500/timeout on the write itself = the edit never reaches ClickUp, no retry, no dead-letter, no review row — and the next inbound pull can revert the portal to ClickUp's old value. This is the exact "my edit didn't stick" experience. *Fix: count failures in `journalStats.failed` and throw after the loop so the queue retries/dead-letters; pair with F-H1.*

### High

**F-H1 — CONFIRMED. No 429/Retry-After handling anywhere; "outage class" recognizes only two internal codes.** `src/clickup/client.js` (no backoff at the chokepoint), `src/sync/clickup-sync.js:101`. Meanwhile every deploy fires unbounded, unpaced boot sweeps (F-H4) straight into ClickUp's per-token rate limit — manufacturing exactly the failures F-C1 then swallows. *Fix: centralize retryability in `client.call()` — honor `Retry-After`, exponential backoff + jitter, tag `e.retryable`; add 429/5xx to the outage predicate.*

**F-H2 — CONFIRMED. SharePoint: a single name-only fuzzy match auto-files with NO review.** `src/lib/sharepoint-map.js:153`. Two different clients named "David Cohen" under one officer → the second David Cohen's photo-ID/SSN doc files into the first's folder. Highest-blast-radius pre-production defect; must be fixed **before** the mirror is ever enabled. *Fix: non-exact single candidates at borrower-profile scope → `sharepoint_match_uncertain` review, not auto-file.* (A second SharePoint claim — comma-separated unit dropping — was **REFUTED** by the verifier and removed.)

**F-H3 — CONFIRMED. The "backdating" DOB auto-adopt can silently overwrite a portal DOB — and the shared token can feed it.** `src/lib/sync-autoresolve.js:81`: for a sync-origin profile with no portal-human fingerprint, a *differing plausible adult* ClickUp DOB is adopted to both systems without review. A fat-fingered (or foreign-automation) plausible DOB in ClickUp propagates everywhere on the next boot re-ingest. This deliberately trades your "DOB is always a human decision" rule for backlog healing — defensible as a one-time backfill, dangerous as a *standing* rule. *Fix: keep for the one-shot heal; thereafter require review for any differing plausible DOB regardless of provenance (or gate the standing rule on the bot-identity actor check once it exists).*

**F-H4 — CONFIRMED (severity moderated to med-high). Every deploy re-ingests the entire linked portfolio and re-runs all heals/auto-adopts.** `src/sync/clickup-sync.js:807` (`reconcileLinkedProgramsOnce` — no LIMIT, no pacing, one `getTask` per linked file) + the in-memory reconcile watermark resets to a 24h lookback on every boot (`:691`), + identity audit (500) + shared-email (200) + stuck retry (200) + recover (50) + flag (100). At 13 deploys/day this is a daily write/read storm and the direct multiplier of the review-queue flood. *Fix: persist the watermark; bound + pace the reconcile like `retryStuckTasksOnce`; move the breaker window into the DB so restarts don't reset it.*

### Medium (selected — the full agent output is preserved in the session transcript)

| ID | Finding | Where |
|---|---|---|
| F-M1 | Scoped `status` push / full repush re-asserts the stale `internal_status` mirror onto the task, reverting a concurrent ClickUp status advance — on the field ClickUp owns | `orchestrator.js:359` |
| F-M2 | Outbound DOB gate omits `portalHumanEdited`, so a fresh human DOB fix on a `clickup_backfill` profile (borrower self-edit or staff `/details` path — neither sets `humanEditKeys`) is auto-"resolved" the wrong way; same action writes through from one screen, is discarded from another | `orchestrator.js:295` |
| F-M3 | Enqueue failure is swallowed while the file header still claims a backstop sweep that was retired to a no-op — a DB blip at enqueue = edit lost with zero trace | `enqueue.js:67` vs `clickup-sync.js:639` |
| F-M4 | Inbound HUMAN-EDIT-WINS adopts on one-sided evidence: any plausible ClickUp DOB change beats a human-entered portal DOB (no `portalHumanEdited` check on this branch) | `ingest.js:135-158` |
| F-M5 | Email-match corroboration by phone/DOB can still merge two differently-named people (spouses share email+phone); name-conflict check not required for those corroborators | `identity.js:136` |
| F-M6 | Webhook-inbox `error` is a silent terminal drop — no review row, no re-drive (outbound dead-letters get both; inbound doesn't) | `clickup-sync.js:668` |
| F-M7 | Reconcile watermark set to `Date.now()` *after* a long pass — tasks updated mid-pass (or whose ingest threw) are skipped next poll | `clickup-sync.js:703` |
| F-M8 | `clickup_year_out_of_range` review rows carry no portal-side value — the card's "In PILOT" column is blank and can mislead an adopt | `ingest.js:1426` |
| F-M9 | Value-agnostic `suppressIfRejected` on identity/SSN audit rows: one dismiss suppresses **future, genuinely different** conflicts on the same task+field | `clickup-sync.js:499` |
| F-M10 | `sp_rematch` review action clears the wrong scope cache for photo-ID/track-record docs (app-scope guessed from `application_id`) | `sync-file-review.js:204` |
| F-M11 | LLC `formation_date` (+ checklist `due_date`) skip `normalizeTypedDate` — the year-0026 class persists on those fields; `new Date('0026-…')` age math goes wild | `staff.js:3328`, `lib/llc.js:222` |
| F-M12 | Legacy `/sync-reviews/:id/approve` writes an inbound DOB **without** `sanitizeDob` — a 10-year-old's DOB passes | `staff.js:5551` |
| F-M13 | Inbound garbage-year guard is a hardcoded 2-field list, not structural — the next date field added to `cols` ships unguarded | `ingest.js:1229` |
| F-M14 | `isTaskDeletedError` accepts 401-with-"not found" as deletion; a token rotation window can partially 404-classify the portfolio (reconcile breaker is the only backstop) | `clickup-sync.js:716` |
| F-M15 | 5-minute `processing` reclaim isn't heartbeat and can double-run a slow (throttled) push — double journal entries + breaker double-count | `clickup-sync.js:60` |
| F-M16 | Volume breaker + storm alarm are per-process, in-memory: reset by every deploy (13×/day), not shared across instances, and over-block legitimate heal storms while under-protecting restarts | `orchestrator.js:426` |
| F-M17 | `allow_shared_email` irreversibly links two borrowers' logins/files/SSN visibility with no unlink action and no confirmation naming both people | `sync-file-review.js:349` |
| F-M18 | Additive-contacts absorbs a wrong-person email/phone silently unless it happens to trip the wrong-merge signature (accumulate ≠ never-review) | `clickup-sync.js:374` |
| F-M19 | Two migrations numbered `db/113` (third collision: 033, 088, 113); `113_chat` header still says `112_`; no `schema_migrations` ledger — safety rests entirely on idempotency | `db/` |
| F-M20 | Outbound DOB review rows carry `borrower_id=NULL` → they are the only field rows that can **never** auto-close | `orchestrator.js:283,310` |
| F-M21 | A real RTL task failing the materialization gate resolves `skipped` with **no review row** — outside the "nothing is silent" guarantee | `ingest.js:1476` |
| F-M22 | `upsertTrackRecord` address-key dedup isn't race-safe (no unique index) — concurrent webhook+reconcile can double-insert | `ingest.js:491` |

---

## 6. Why you are "eating errors all day" — the mechanics

The review queue went **0 → 19 card types in ~40 hours**. The load model:

1. **Boot sweeps × deploy frequency.** Every deploy re-runs the full-portfolio passes (F-H4). 13 deploys on Jul 15 = 13 portfolio sweeps in one day.
2. **Dismissals don't stick for the noisiest types.** All DOB/year/PII cards respawn (with fresh LO email) on every re-ingest while the systems still disagree — `suppressIfRejected` is opt-in per producer and those producers don't pass it.
3. **No notification rate cap anywhere.** Every new row = immediate LO email + in-app; borrower-level rows fan out to *every* LO on that borrower; +1 reminder at day 3; admin escalation at day 7. 40 rows in one boot = 40 emails in minutes.
4. **Two-thirds of card volume is informational** (audit mismatches where nothing was written anywhere), yet it emails identically to work-blocking cards — and the aging ladder escalates exactly the least-actionable rows to admins.
5. Three card types can never auto-close (F-M20 + `task_deleted_needs_decision` by design).

**The 5 highest-leverage queue fixes** (from the ops analysis, all small):
1. **Severity tiers**: work-blocking cards keep immediate email; informational cards → in-app/badge only + one daily digest (~70% email cut, zero information loss).
2. **Per-LO coalescer** in `notifyLoanOfficer` ("N reviews need you", ≥1h apart) — defuses deploy floods regardless of producers.
3. **Dismissals stick by default** inside `queueReview` (same task/borrower+field+**same proposed value**; a changed value is a genuinely new event — this also fixes F-M9 the right way).
4. **Group cards per borrower/file** in the list + bulk bar; tier-B rows auto-expire (~14d, "expired — nothing was ever written") instead of escalating.
5. **Per-reason noise telemetry**: extend the weekly digest with dismiss-rate vs acted-on-rate per reason; auto-demote any reason with >80% dismiss rate to digest-only. Makes the queue self-tuning instead of incident-tuned.

---

## 7. Blueprint conformance — the design vs what got built

The three headline incidents map exactly onto three conformance failures:

| Incident | Conformance failure |
|---|---|
| Jul 7 overwrite loop | **Un-blueprinted divergence**: the dirty-sweep never appeared in the design; the echo-suppression the blueprint called *"mandatory, not optional"* was written + tested (`8b6566d`), **never wired**, then deleted (`a26f2e6`) |
| Jul 14 duplicate/attribution | **Skipped safeguards**: the §4.4 duplicate hold was deferred 7 days; the "YS Portal Bot" seat was deferred (making the false-wipe forensics cost a day) |
| Jul 15 date/DOB | **Blueprint blind spot**: dates specified as bare "epoch ms" with no timezone/day-preservation convention |

Designed but never built (selected): the **"Send to Portal"** escape-hatch checkbox (ClickUp field exists, zero handler); **webhook registration + health monitoring** (`createWebhook` never called — if ClickUp auto-disables the webhook, nothing notices; the 5-min poll is the de-facto transport); **runtime pause switches** (stopping a runaway sync requires a redeploy); **`clickup_field_mappings`** with `direction` + `source_of_record` columns (exists in the DB, read by nothing — per-field authority was never encoded as data); officer-reassignment folder moves; CRM contact dual-write; task-side "Sync Status/Last Error" writes; hot-poll after duplication.

Field **direction** is genuinely enforced at one chokepoint (`mapper.js FIELD_MAP` + `buildTaskFields`/`readTaskFields` skips) with ~10 silent deltas vs §6 and ~15 special fields handled ad hoc. Field **authority** was replaced by five emergent conflict regimes (last-ingest-wins COALESCE for economics; fill-only for identity; PII shield outbound; the DOB engine; the review queue) — arguably safer than the static table, but documented nowhere except incident docs. **The blueprint is now materially misleading** (still headed "PROPOSAL — nothing implemented", describes deleted machinery) — it needs a superseded-banner pointing at `CLICKUP-DATA-SAFETY.md` + `CLICKUP-DATE-INCIDENT.md` + the CLAUDE.md invariants.

---

## 8. Test coverage vs the incidents

All 8 suites run green in seconds with **no DB, no env, no network** (verified by execution: 525 assertions). But mapped strictly against the 16 incidents: **4 covered, 6 partial, 6 uncovered** — and the pattern is exact: everything reachable as a pure function got a lock-in test; everything inside DB-touching orchestration got none. **`ingest.js` — 1,545 lines carrying fixes for 9 of the 16 incidents — has zero direct test coverage.** Fully uncovered today: the inbound DOB heal flow (human-edit-wins, cleared-DOB vacate/wipe-don't-guess), the whole loan-number lifecycle, materialization-gate wiring, role reconciliation, the restore script's own branches, the orchestrator's runtime guards (breaker, never-creates, fail-closed, DOB gate), stale-tab protection.

The analysis produced **12 ready-to-write regression tests** (highest value: the four owner-escalated uncovered incidents share one stub harness; the breaker test is 5 minutes of work) and a **minimal CI**: add an `npm test` chain to package.json + a 15-line GitHub Actions workflow at the git root (`working-directory: yscap-repo-root_8`, `npm ci`, `npm test`, no Postgres service needed). Bonus: the existing bundle-drift check inside `test-sync-file-review.js` would then **fail any PR that edits `app-v2/src` without committing the rebuilt bundle** — closing the "frontend silently not deployed" hole, since Render builds only the legacy `app/` and the live V2 portal deploys solely via the committed bundle.

---

## 9. Industry gap analysis

From a 5-topic research sweep (commercial sync engines, reliability engineering, MDM/conflict models, ClickUp API documentation, regulated-domain practice) synthesized against this codebase. Scores: 0 = at standard … 3 = critical gap.

| Dimension | Severity | Verdict |
|---|---|---|
| Rate-limit handling | **3** | Zero 429/Retry-After handling in the ClickUp client; ClickUp's documented limit is 100 req/min/token on Business plan; a 429 burns a dead-letter attempt. **The repo's own `sharepoint.js:105-125` already implements the exact correct pattern** — port it. |
| Loop prevention / attribution | **3** | Industry canon (Workato): dedicated integration user + actor filtering at the trigger. ClickUp has **no app/bot actor concept** — even OAuth attributes to the authorizing human — so this requires a real "YS Portal Bot" member seat. Today the portal shares the owner's token with a second, unidentified automation. |
| PII handling / compliance | **3** | Portal side is strong (AES-256-GCM SSN, masked journals). But **full SSNs sit in plaintext ClickUp custom fields** visible to the whole workspace; FTC Safeguards Rule (applies to mortgage brokers) expects data minimization + access limits; industry SSN practice is vault + last-4 elsewhere. Decision memo needed. |
| Conflict resolution model | 2 | `decideDob()` is a real single-decision-function resolver — the right shape — but only DOB has it. Generalize to `decideField()` driven by a persisted authority matrix (the empty `clickup_field_mappings` table was built for exactly this). |
| Field ownership / provenance | 2 | "Empty never overwrites" fully implemented both ways (ahead of many). Missing: per-field provenance (Informatica XREF / Reltio crosswalk pattern) so survivorship is computable and merges reversible. |
| Identity resolution | 2 | Deterministic-only auto-merge is the standard (Reltio: suspect rules never auto-merge; Fellegi-Sunter three-zone model). Weak-key corroborations (email+phone) must suggest, never merge. |
| Schema / migration discipline | 2 | No `schema_migrations` ledger; replay-everything rests on hand-maintained idempotence across 114 files; three number collisions already. |
| Testing / CI | 2 | 8 real incident-derived suites exist; nothing runs them (no `npm test`, no CI). |
| Deploy behavior | 2 | Industry: deploys are sync-neutral (persistent cursors, scheduled full re-syncs — e.g. Merge.dev's every-3-days). Here: every deploy = portfolio-wide re-ingest against a reset watermark and a reset breaker. |
| Outbox / queue reliability | 1 | Genuinely close to standard (FOR UPDATE SKIP LOCKED, crash reclaim, dead-letter → review). Tighten: enqueue inside the caller's transaction; jitter on backoff. |
| Observability / audit | 1 | The write journal is **better** than typical hand-rolled syncs. Missing: webhook-health probe (ClickUp silently suspends a webhook at fail_count 100) and surfacing `X-RateLimit-Remaining`. |
| Review / stewardship UX | **0** | **At or above industry standard** — two-sided rows, live re-read resolution, file-level actions, auto-close on convergence. Polish only (group-by-reason headers). |

**Where this codebase is ahead of industry practice** (validated, keep): the PII-masked before+after write journal with its provable negative ("not in the journal ⇒ the portal didn't do it"); the structural hard-stops in the HTTP client (including nested-null/NaN detection); the two-sided LO-owned review queue with live re-read; `decideDob()` provenance-aware auto-resolution; and the dates-as-strings + throw-on-violation round-trip discipline.

**Strategic note:** a buy-vs-build checkpoint against Unito (the commercial product closest to a ClickUp two-way stack) is worth an hour this quarter — the honest expectation is that the custom PII guards, review queue, and duplicate-task lifecycle justify keeping the build, but the comparison keeps the decision deliberate.

---

## 10. The redesign — how to stop firefighting

The system's own history proves the pattern: **chokepoints stay fixed; call-sites recur.** The redesign moves the remaining scattered heuristics to five chokepoints. None of this is a rewrite; each piece replaces N spot-fixes with one structure, and each is independently shippable.

1. **One retry/error contract at the HTTP client** (fixes F-C1, F-H1, F-M6 at the root). `client.call()` owns retryability: honor `Retry-After`, backoff+jitter, normalized `e.retryable`/`e.status`; `pushApplication` throws on any failed non-suppressed write. **Invariant (adopt as a CLAUDE.md rule): every sync operation that exhausts retries MUST end as a queued retry or a review row — a silent `done` is a bug by definition.** Inbound inbox `error` rows get the same dead-letter → review → boot-redrive treatment outbound already has.
2. **A typed field registry as data** (finishes what `clickup_field_mappings` started; fixes F-M13 and the "next field ships unguarded" class). One table/module per logical field: ClickUp field id, portal column, type, direction, **authority** (portal-owned / clickup-owned / two-sided), PII class, validators. Mapper, guards, inbound persistence, review producers, and resolution appliers all iterate the registry — adding a field means adding one row, and every guard applies automatically.
3. **Provenance + actor identity** (fixes F-H3/F-M4 at the root; ends the attribution ambiguity). (a) Stand up the **dedicated ClickUp bot token** — the blueprint scoped it as drop-in; it makes echo suppression trivial (ignore inbound events whose actor is the bot), makes every journal row attributable, and exposes the second automation on day one. (b) Record per-field provenance (who last set it: human-portal / human-clickup / sync / unknown) — then "human edits win" becomes a lookup, not a heuristic reconstructed from audit-log archaeology per call site.
4. **One review state-machine + notification layer** (§6 fixes 1–5). All 19 reasons through one registry: tier (blocking/informational), dedupe key incl. proposed value, auto-close conditions, expiry, and a single coalescing notifier with a per-LO rate cap and per-reason noise telemetry.
5. **Boring-but-critical operational floor:** persist the reconcile watermark; bound+pace every boot one-shot; DB-backed breaker window; runtime pause flags (inbound/outbound/all) readable without redeploy; webhook health check + re-register in the Control Center; `schema_migrations` ledger + duplicate-number CI check; `npm test` + the Actions workflow; wire `app-v2` into the Render build.

**What NOT to change:** the write journal, the client hard-stops, scoped-push-never-creates, fail-closed pre-reads, dates-as-strings + the round-trip throw, two-sided review with live re-read, COALESCE fill-only inbound for PII. These are the load-bearing walls — several are ahead of industry practice — and every one of them stayed fixed once built.

---

## 11. Action plan

**Today (operational, no code):**
1. **Rotate the two API keys** pasted into chat (Render + ClickUp) — they went nowhere from this session, but they're in a transcript.
2. **Deploy `main`** — several root fixes (Unknown-Unknown factory, Stauber re-seat, split repair) are inert until deployed; then do the two pending human clicks (Mendelovits split; Yaniv Erez repush) and verify.
3. **Check SharePoint env vars** in Render — confirm the mirror status (§4). Decide: if you want document backup, fix F-H2 first, then enable; either way, know that today the Render disk is the only copy.
4. **Create the ClickUp bot user/token** for the portal and audit ClickUp Automations + connected apps to identify the second automation writing under your token.

**This week (small PRs, big leverage):**
5. F-C1 + F-H1: throw-on-failed-write + 429/Retry-After in the client (one PR).
6. Review-queue noise package: tiers, coalescer, sticky dismissals, borrower grouping (§6 items 1–4; one PR).
7. `npm test` + CI workflow + the migration-ledger/duplicate-number check; renumber `db/113_address_canon_cache.sql` → 115 (re-run-safe), fix the `112_` header.
8. Persist the reconcile watermark + bound/pace `reconcileLinkedProgramsOnce`; heartbeat the outbox reclaim (F-M15).
9. The four one-line-ish correctness fixes: F-M20 (borrower_id on outbound DOB rows), F-M12 (`sanitizeDob` in legacy approve), F-M11 (`normalizeTypedDate` on LLC/checklist dates), F-M8 (portal value on year-range cards).

**This month (structural):**
10. Typed field registry (item 2 above) and route mapper/guards/producers through it.
11. Provenance columns + bot-actor echo suppression; then narrow F-H3's standing rule to review-always.
12. The 12 regression tests (starting with the 4 uncovered owner-escalated incidents + the breaker test).
13. SharePoint: fix F-H2 + F-M10, then enable the mirror deliberately with the review queue watching its first week.
14. Retire/mark-superseded the blueprint; fold the emergent authority rules into the field registry doc.

**Live evidence (any time):** in the Render Shell —
`node scripts/audit-evidence-report.js --days 10 --diff` (full picture) · `--task <taskId>` (one task's complete write/review history). Read-only; uses the env credentials already on the service. Paste the output into a session and the numbers (dead letters, blocked writes, open-card aging, breaker events) become part of this audit's evidence base.

---

*Report assembled from 21 agent investigations (~2.7M tokens of analysis), with every critical/high finding independently verified against the code, one claim refuted and removed, and all history claims grounded in commit SHAs. The companion evidence script and this document live on branch `claude/sync-error-handling-audit-vh7feq`.*
