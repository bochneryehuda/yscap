# The Plan — Make the Sync Safe, Reliable, and Quiet

**Companion to:** `docs/AUDIT-2026-07-15-SYNC-ANNUAL.md` (finding IDs F-* referenced throughout).
**Goal, in the owner's words:** it should be good, safe, never mess up the data, reliable enough to trust, built the proper way, manual review should be legit — only important things — and the whole logic should succeed more.
**Shape:** 5 phases. Phase 0 is owner-only actions (no code). Every code item is a **work order (WO)** sized for one AI session: scope, files, acceptance criteria, and the regression test that locks it in. Nothing here is a rewrite — every WO replaces N spot-fixes with one structure, and the load-bearing walls (write journal, client hard-stops, scoped push, two-sided review, dates-as-strings) are explicitly kept.

---

## North-star invariants (the contract everything below serves)

1. **No silent failure, ever.** Every sync operation that exhausts its retries ends as a queued retry **or** a review row. A silent `done` is a bug by definition. (Today this is violated at the exact center of the system — F-C1.)
2. **No unreviewed write to sensitive identity.** DOB/SSN/name/contact changes are applied only by: a human's direct edit, a provable auto-resolution, or an approved review. No standing rule may adopt a *differing plausible* value without review (F-H3 narrowing).
3. **Every write is attributable.** The portal writes as its own ClickUp identity; anything else writing to the workspace is visibly someone else. (Industry: dedicated integration user is THE loop-prevention and attribution pattern — Workato's documented design; ClickUp has no app-actor concept, so this must be a real member seat.)
4. **The review queue contains only decisions.** If nothing was written and nothing blocks work, it's a digest line, not a card, not an email.
5. **Every incident closes with a test.** A fix without a regression test locking it in is not done (16 incidents: only 4 fully covered today).

---

## Phase 0 — TODAY, owner-only (no code, ~1 hour total)

| # | Action | Why |
|---|---|---|
| 0.1 | **Rotate the Render + ClickUp API keys** pasted into chat (Render dashboard → API Keys; ClickUp → Apps). | Transcript hygiene. Nothing used them from this session, but they exist in a log. |
| 0.2 | **Deploy `main`.** Then do the two pending human clicks: the Mendelovits **Split** (verify officer access is severed after), and the Yaniv Erez **admin repush**. | Several root fixes (Unknown-Unknown factory `8f3e23a`, Stauber re-seat, split repair) are inert until deployed. |
| 0.3 | **Check SharePoint env** in Render: is `SHAREPOINT_BACKUP_ENABLED=1` + `SHAREPOINT_DRIVE_ID` + `MS_*` set? (Audit §4: live probe says the mirror never ran.) | Decide with clear eyes: today the Render disk is the only copy of every portal-uploaded borrower doc. Do NOT enable until WO-13. |
| 0.4 | **Create the "YS Portal Bot" ClickUp member** (a real seat — ClickUp attributes ALL API writes to the token's human, so a distinct identity requires a distinct member), generate its token, add it to the pipeline spaces. Don't switch the portal to it yet (WO-9 does that). | Invariant 3. Also instantly makes the *second automation* visible: after the switch, anything still writing as "Yehuda" is not the portal. |
| 0.5 | **Audit ClickUp → Settings → Automations + Integrations/connected apps.** List everything with write access. The Jul 14 forensics proved a second automation writes under your token (literal `"undefined"`, 8-field same-second clears). | Find and name the co-tenant before it causes the next false alarm — or the next real one. |
| 0.6 | **Run the evidence report** in the Render Shell: `node scripts/audit-evidence-report.js --days 10 --diff` and paste the output into a session. | Turns the audit's code-level findings into live numbers: dead letters, blocked writes, open-card aging, breaker events, actual mirror count. |

---

## Phase 1 — Week 1: STOP SILENT DATA LOSS (reliability contract)

The theme: reads already fail closed; writes must stop failing silent. This phase alone removes the "my edit didn't stick / the sync reverted my fix" class.

**WO-1 — Throw on failed field writes + honest push results.** *(F-C1, confirmed critical)*
- `src/clickup/orchestrator.js`: count `journalStats.failed` in the per-field loop; after the loop, if any non-suppressed field failed, **throw** (carrying which fields succeeded — re-push is idempotent via no-op suppression, so retrying the whole set is safe). `pushOutboxOnce` then retries/dead-letters normally, and the dead-letter review card appears.
- Also: the status write's silent `catch(_){}` (orchestrator ~`:363`) gets the same treatment.
- **Accept:** a stubbed `setField` failure on 1 of 3 fields → job NOT marked done; retried; dead-letters after budget → `push_dead_lettered` card exists.
- **Test:** extend `scripts/test-clickup-write-guards.js` with a monkey-patched client (the test-gap analysis proved the whole module loads with no DB — pattern in its report §3).

**WO-2 — One retry/error contract at the HTTP chokepoint.** *(F-H1 confirmed; industry-standard client behavior)*
- `src/clickup/client.js call()`: on 429 honor `Retry-After` (ClickUp sends it; Business plan limit is 100 req/min/token); on 429/5xx/network retry with capped exponential backoff + **full jitter** (AWS-documented standard) up to a small budget, then throw with `e.retryable=true`, `e.status`, `e.retryAfter`. Never retry other 4xx.
- **The correct pattern already exists in this repo:** `src/lib/sharepoint.js:105-125` honors 429/503/504 Retry-After exactly, bounded — port it. (The client that never ran in production has the handling; the client hammered daily has none.)
- Add a simple token-bucket pre-throttle (~60–80 req/min, leaving headroom for the co-tenant automation until WO-9 isolates it) inside `call()`, and log `X-RateLimit-Remaining` from responses.
- `pushOutboxOnce`'s outage predicate: add `e.retryable` to the existing two internal codes.
- **Accept:** a 429 storm never dead-letters a job (patient retries); a 400 fails fast; every retry visible in logs.
- **Test:** stubbed fetch returning 429-with-Retry-After / 500 / 400 sequences.

**WO-3 — Inbound failures get the same dignity as outbound.** *(F-M6)*
- `processInboxOnce`: on terminal inbox failure (attempts ≥6) queue a `file_link`/`ingest_failed` review row (task id, last error) and add a bounded boot re-drive of `error` rows (mirror `retryStuckTasksOnce`).
- **Webhook-health probe** (documented ClickUp behavior: a failing webhook is retried 5×, and the webhook is **silently suspended at fail_count 100** — from that moment events are lost until someone notices): a periodic `listWebhooks` check surfaces fail_count growth in the Control Center and auto-re-registers a suspended webhook, audited.
- **Accept:** no webhook can die silently — neither a single event nor the webhook itself; `error` rows self-heal on deploy.
- **Test:** `scripts/test-sync-file-review.js` drift-check covers the new reason's UI copy + actions.

**WO-4 — Tame the boot storm.** *(F-H4 confirmed; F-M15, F-M16)*
- Persist the reconcile watermark (a `settings` row) — a restart resumes instead of re-scanning 24h.
- `reconcileLinkedProgramsOnce`: LIMIT + oldest-first rotation + inter-call pacing (mirror `retryStuckTasksOnce`), so a deploy touches a bounded slice, and the whole portfolio still converges across boots.
- Move the volume-breaker window to a DB query over `clickup_write_log` (it already timestamps every write) so deploys don't reset it and a legit heal storm can be allowed deliberately (env override) instead of colliding with user edits.
- Heartbeat `updated_at` during long pushes (kills the 5-min reclaim double-run).
- **Accept:** a deploy issues ≤ configurable N ClickUp reads; breaker state survives restart; no double-journal on slow pushes.

**WO-5 — Close the enqueue trapdoor.** *(F-M3; industry: transactional outbox)*
- The structural fix, per the transactional-outbox standard: enqueue **inside the caller's business-write transaction** (pass the client, not `db`) so "the row changed" and "a push job exists" are atomic — an enqueue can then never be lost separately from the edit itself. Do this for the top write paths (staff details/complete-fields/closing-date, borrower profile) first.
- Everywhere else: on insert failure, log loudly + write an `audit_log` row; delete the stale "the sweep is the backstop" header comment.
- **Accept:** on the converted paths a lost enqueue is transactionally impossible; elsewhere it is at least visible.

**Also in week 1 (one-liners bundled as WO-6):** `borrower_id` on outbound DOB review rows so they can auto-close (F-M20) · `sanitizeDob` in the legacy `/approve` path (F-M12) · `normalizeTypedDate` on LLC formation-date + checklist due-date (F-M11) · portal-side value on `clickup_year_out_of_range` cards (F-M8) · require 404 (not 401-with-text) for the task-deleted verdict, keep the breaker (F-M14) · renumber `db/113_address_canon_cache.sql` → `115` + fix the `112_` header (F-M19).

---

## Phase 2 — Week 1–2: MAKE MANUAL REVIEW LEGIT (only important things)

The owner's requirement verbatim: *"manual review should be legit, only important things."* Industry anchors: HubSpot's sync-health triages by error TYPE with counts, not row-per-error; Reltio remembers "Not a Match" so pairs stop reappearing; Zapier HOLDS floods (100+ events) pending owner confirmation; Tamr tiers matches by confidence — auto-merge high, review medium only.

**WO-7 — Tier the queue + coalesce the notifications.**
- One `REASON_TIER` map: **Tier A (decision cards — email immediately):** `file_not_materialized_*`, `push_dead_lettered`, `task_deleted_needs_decision`, `borrower_identity_conflict`, `shared_email_needs_reassignment`, outbound DOB blocks, `copied_loan_number`, `ingest_failed`. **Tier B (informational — badge + daily digest only):** `identity_mismatch_audit`, both SharePoint reasons, `clickup_year_out_of_range`, the inbound DOB trio, `pii_overwrite_blocked`, `file_unlinked_no_task`.
- `notifyLoanOfficer` → per-LO coalescer: at most one email/hour ("4 reviews need you"), using the same audit-log self-gate pattern the weekly digest already proves.
- Aging ladder: Tier A keeps the 3-day reminder; Tier B **auto-expires** (~14 days, note "expired — nothing was ever written") and never escalates to admins.
- **Accept:** a deploy that queues 40 rows produces ≤1 email per affected LO; informational cards never page anyone.

**WO-8 — Dismissals stick; noise tunes itself.**
- Inside `queueReview` (not per-caller): never re-open a rejected (task/borrower + field + **same proposed value**) tuple. A *changed* value is a genuinely new event — this also fixes the F-M9 inverse (one dismiss suppressing future different conflicts).
- List endpoint groups cards per borrower/file; bulk bar operates per group.
- Weekly digest gains per-reason telemetry: dismiss-rate vs acted-on-rate vs auto-closed-rate; any reason with >80% dismiss rate over its last 50 rows is auto-demoted to Tier B (loudly logged). The queue becomes self-tuning instead of incident-tuned.
- `allow_shared_email` gets a confirmation naming both people + an **unlink** action (F-M17).
- **Accept:** the same card never comes back after dismissal unless the value changed; queue volume trend is visible in the digest.

**Success metric for Phase 2 (measure via the evidence script, before/after):** open-card count, cards-per-deploy, LO emails/day, median time-to-resolve Tier A. Target: **LO sees <5 emails/day and every one is a real decision.**

---

## Phase 3 — Weeks 2–4: BUILT THE PROPER WAY (structure over guards)

**WO-9 — Portal writes as the Bot; echo suppression by actor.** *(finishes Phase 0.4)*
- Switch `CLICKUP_API_TOKEN` to the YS Portal Bot's token. Inbound: drop/short-circuit webhook events whose actor is the bot (the Workato pattern) — structural loop prevention replaces "COALESCE happens to be idempotent."
- Task activity now reads "YS Portal Bot" for every sync write — staff can finally *see* what the automation did, and anything else writing is exposed by name.
- **Accept:** the write journal's actor matches the bot; an inbound webhook for our own write is visibly skipped.

**WO-10 — The typed field registry (authority as data).** *(the audit's #1 structural item; the blueprint even built the empty table)*
- One module/table per logical field: ClickUp field id, portal column, type, direction, **authority** (`portal | clickup | two_sided`), PII class, validator. Mapper (`FIELD_MAP` + the ~15 ad-hoc specials), inbound persistence, guards (PII shield membership, date-guard membership — kills the hardcoded 2-field list F-M13), review producers, and `applyReviewWinner` all iterate the registry.
- HubSpot ships exactly this as product UI (per-field Two-way / Always-A / Always-B); Informatica/Reltio make survivorship per-attribute data. Adding a field becomes one row; every guard applies automatically.
- **Accept:** deleting a field's registry row removes it from push, pull, guards, and review simultaneously; a new date field is year-guarded with zero extra code.

**WO-11 — Per-field provenance; narrow the DOB auto-adopts.** *(F-H3, F-M2, F-M4)*
- Record who last set each sensitive field (`human_portal | human_clickup | sync | unknown`, with timestamp) at the write sites that already journal. "Human edits win" becomes a lookup, not audit-log archaeology per call site.
- Then: `decideDob` **requires** the provenance signal (no more optional `portalHumanEdited`); the standing `clickup_current_beats_sync_derived_profile` rule and one-sided human-edit-wins both demand *portal side has no human provenance* before adopting; everything else → review. Both borrower self-edit and staff `/details` DOB paths set `humanEditKeys` like the file-screen path already does.
- **Accept:** the Elbaum scenario still auto-heals (human fixed ClickUp, portal value was sync-derived); a human-entered portal DOB is never overwritten without a card; the same staff action behaves identically from every screen.

**WO-12 — Identity resolution gets confidence tiers.** *(F-M5, F-M18; the Fellegi-Sunter / Informatica automerge-vs-manual split)*
- Deterministic auto-merge only (SSN match; email + real name-token corroboration with `nameConflict` required for phone/DOB corroborators). Everything in the middle → a match-review card (the machinery exists: `borrower_dedup_candidates` + the split/allow actions). "Not-a-Match" verdicts persist (Reltio pattern — WO-8 gives this for free).
- Additive-contacts keeps accumulating, but a NEW differing primary email/phone also drops a Tier-B digest line (accumulate ≠ never-mention).
- **Accept:** two differently-named people can never auto-merge on any corroborator combination; the Mendelovits-class requires a human click to merge, ever.

**WO-13 — Regression tests + CI (the assurance floor).**
- Adopt the test-gap analysis wholesale: `npm test` chain in package.json + the 15-line GitHub Actions workflow (verified: all suites run in seconds, no DB). Then the 12 proposed tests, starting with the four uncovered owner-escalated incidents (inbound DOB heal branches, loan-number adjudication, duplicate-defer wiring, role re-seat) + the 5-minute breaker test.
- CI side-effect already proven: the bundle-drift check fails any PR that edits `app-v2/src` without the rebuilt bundle — closing the silent-frontend-non-deploy hole. Add the duplicate-migration-number check + a `schema_migrations` ledger.
- **Accept:** a PR that regresses any locked incident fix goes red; migration collisions are impossible to merge.

---

## Phase 4 — SharePoint go-live + compliance posture (when Phases 1–2 are live)

**WO-14 — Fix the mirror before enabling it.** *(F-H2 confirmed high; F-M10)*
- Non-exact single-candidate fuzzy matches at borrower-profile scope (photo ID / SSN / track record) → `sharepoint_match_uncertain` review instead of auto-file; `sp_rematch` derives scope from the document row, not guessed from `application_id`.
- Then set the env vars and enable — **with its first week watched via the (now-quiet) review queue** and the evidence script's mirror counters.
- **Accept:** zero documents filed into a fuzzy-matched borrower folder without either an exact match or a human confirmation; mirror counts rise in the evidence report.

**WO-15 — GLBA/Safeguards posture (decide, then document).**
- Facts from research: the FTC Safeguards Rule applies to mortgage brokers/lenders; requires encryption, least-privilege access, user-activity monitoring/logging, and (since May 2024) FTC notification within 30 days of a breach of unencrypted customer info. Industry SSN practice: encrypted vault + last-4 elsewhere. ClickUp is SOC-2/ISO-certified but supports regulated data under a BAA only on Enterprise.
- Decision for the owner: keep full SSNs in ClickUp custom fields (current state — anyone with workspace access sees them; every guest/automation too), or move ClickUp to **last-4 + "on file in PILOT"** with the full SSN living only encrypted in the portal (it already is). The sync already masks SSNs in journals/queues; this extends the same principle to the system with the widest human access. Recommendation: last-4 in ClickUp; staff who need the full SSN have PILOT.
- Either way, write the choice down in `CLICKUP-DATA-SAFETY.md` so it's a policy, not an accident.

---

## Phase 5 — Ongoing assurance (how you'll KNOW you can rely on it)

1. **Weekly 10-minute ritual:** run `audit-evidence-report.js --days 7`; look at four numbers — dead-lettered pushes (target 0), blocked writes (each one explained), open Tier-A cards older than 3 days (target 0), per-reason dismiss rates (anything >80% gets demoted/tuned). The report is designed so an AI session can read the paste and triage it for you.
2. **Deploy discipline:** deploys no longer trigger portfolio storms (WO-4), so deploy freely — but after each deploy, the boot log's one-shot summary lines (`reconcile-programs`, `stuck-task retry`, `identity audit`) are the health check.
3. **Webhook health:** ClickUp retries a failing webhook 5× and then **auto-disables it silently** (documented behavior) — the Control Center gets a webhook-status check + one-click re-register (small WO, fold into WO-3).
4. **The never-regress list** (already in CLAUDE.md, now enforced by CI): client hard-stops, scoped-push-never-creates, dates-as-strings + round-trip throw, fill-only inbound PII, the review-queue invariants — plus the new one: *every failure ends as a retry or a review row.*
5. **Definition of "reliable" (measurable):** 0 silent drops (journal writes reconcile with queue outcomes) · 0 unreviewed sensitive-identity changes (journal `source` audit) · <5 LO emails/day, 100% of them decisions · every incident class in the audit has a green test · deploy causes no card flood.
6. **Quarterly drift drill (scheduled, not incident-driven):** run `clickup-date-restore.js` dry-run + the identity-mismatch audit + the review-queue aging report as a fire drill; findings become WOs, not emergencies.
7. **Buy-vs-build checkpoint (once, this quarter):** spend one hour comparing against Unito (the closest commercial ClickUp two-way product). Honest expectation: the custom PII guards, review queue, and duplicate-task lifecycle justify keeping the build — but make it a deliberate decision, not inertia. (Industry validation worth knowing: the audit scored the review/stewardship UX **at or above** commercial standard — the investment there is real.)

---

## Execution notes for AI sessions working this plan

- One WO per session/PR. Cite the finding IDs in the commit. The two-audit-agent gate (CLAUDE.md) applies to every WO.
- Order: WO-1 → WO-2 are the foundation (do first, in one PR if convenient); WO-7/WO-8 can run in parallel with them; WO-9 waits for Phase 0.4; WO-10/11/12 build on each other; WO-13 (CI) can land any time and should land early.
- Never weaken anything on the never-regress list to make a WO easier. If a WO seems to require it, stop and surface it.
- After each phase: run the full suite + the evidence script; update this doc's checkboxes; the plan is done when Phase 5's five metrics hold for two consecutive weeks.
