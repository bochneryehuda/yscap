# PILOT sync — Round 2 audit (after we shipped the fixes)

**Date:** 2026-07-19  ·  **Reviewed against:** production `main` (commit `b1bfb68`)  ·  **Scope:** the two "robots" that copy loan files between our portal, ClickUp, and SharePoint.

---

## Read this first (plain language)

Think of PILOT and ClickUp as two filing cabinets that a robot keeps in step, and SharePoint as a photocopier that files copies of documents. In July we found 43 problems and fixed a little over half of them. This round checks two things:

1. **Did the repairs we already shipped stay fixed?** — Mostly yes. Every safety repair we shipped is still doing its job. **But one of them quietly opened a brand-new door:** the change that makes the robot patient and keeps retrying ClickUp when the line is busy can, in one specific situation, create the borrower's card in ClickUp **twice** — two cards for the same person, both carrying their Social Security number and date of birth.

2. **What new problems turned up, including in work other people shipped while we were fixing things?** — Several. The most serious involve **money and identity**: a blank or "N/A" coming back from ClickUp can silently erase a real six- or seven-figure loan amount; inviting a co-borrower who shares a family email address can hand the wrong person a window into someone else's file; and a pricing change shipped by another team will **re-open every already-signed term sheet** because of a formatting mismatch.

**Bottom line:** nothing we shipped broke or reversed. But the sum of our fixes plus other teams' parallel work introduced a handful of *new* ways to duplicate a card, erase a number, or reopen a signed document. None of these is on fire today, but two of them (the duplicate PII card and the money-erase) should be closed before the next busy origination week.

---

## Section 1 — Did every fix we shipped hold up?

**Short answer: Yes — every deployed fix is still correct and doing its job.** Two of them are *weaker than they look* because of edge cases (not because they broke), and one of those edge cases is serious enough that it graduates into a new bug in Section 2 (the duplicate card).

Plain-language scorecard:

- **The "don't mark a file done if part of it failed to save" guard** — still holds. The robot still refuses to call a push finished if any field failed.
- **The "be patient with ClickUp when the line is busy" upgrade** — still holds, *but* it now has a side effect: when it retries creating a brand-new card and the first attempt actually went through but looked like it failed, you can get two cards. (New bug #1.)
- **The "bookmark that remembers where the robot left off"** (reconcile watermark) — still holds, solid.
- **The loud-failure alarms** (enqueue / ingest / dead-letter get written to the audit log instead of vanishing) — all still holding.
- **The date, status, and duplicate-task safety fixes from WO-6/WO-16** — all still holding.
- **The migration ledger + duplicate-number guard** — still holding; one stale code comment to correct, no behavior impact.

### 1a. Verification table

| Fix (what it does) | Verdict | Concern |
|---|---|---|
| **WO-1 / F-C1** — push *throws* on any failed field write (`recordFieldFailure`/`assertPushComplete`) so a half-written card retries instead of being marked done | **Intact / correct** | Create branch (`orchestrator.js:264-271`) has no per-field tracking, but a create failure throws the whole push and scoped pushes can't reach create — semantics hold. |
| **WO-2 / F-H1** — `client.js call()` token bucket + Retry-After + backoff + timeout + `e.retryable` tagging | **Intact but weak** | The retry loop retries **every** method on timeout/5xx, including the non-idempotent `createTask` POST. A create that ClickUp committed but that timed out gets retried → **duplicate card**. Promoted to New Bug #1. |
| `pushOutboxOnce` treats `retryable` as outage (WO-1+WO-2 seam) | **Intact / correct** | Predicate is sound; 5-min reclaim floor is protected by the WO-4b heartbeat. |
| **WO-4a** — watermark persisted in `sync_runtime_state` (db/125) | **Intact / correct** | — |
| **WO-4a** — watermark captured pre-query, 72h-clamped, advances only on full success | **Intact / correct** | — |
| **WO-4b** — `reconcileLinkedProgramsOnce` bounded + rotating (oldest-snapshot-first) | **Intact but weak** | Loops are un-mutexed `setInterval`s; a long pass can overlap itself (Section 2 lower-severity items). |
| **WO-4b** — periodic reconcile-programs tick keeps rotation moving | **Intact / correct** | — |
| **WO-4b / F-M15** — long-push heartbeat prevents 5-min reclaim double-run | **Intact / correct** | — |
| **WO-4b / F-M16** — `seedBreakerFromDb` primes the volume breaker on boot | **Intact but weak** | Seed is fire-and-forget / un-awaited before the drain starts → brief empty-breaker window at boot. New Bug (low). |
| **WO-4b** — `shouldSkipOrphanResolution` outage-breaker semantics | **Intact / correct** | — |
| Unlocked `setInterval` reconcile loops (double-run surface) | **Intact but weak** | No in-flight guard / advisory lock; overlap possible during long catch-ups. |
| **WO-5 ph1 / F-M3** — enqueue failures audited, not swallowed | **Intact / correct** | — |
| **WO-3 ph1 / F-M6** — terminal inbox failure audited (dead-letter traceable) | **Intact / correct** | — |
| **WO-3 ph1 / F-M6** — boot re-drive works, cannot infinite-loop | **Intact / correct** | — |
| **WO-3 ph1 / F-M6** — ingest idempotent so re-drive is safe | **Intact but weak** | Idempotent on immutable `task_id` for convergent writes; the *additive* co-borrower/contact class (F-M5/M18) is still exposed to duplicate delivery. |
| **F-M14** — `isTaskDeletedError` hard-404 only | **Intact / correct** | — |
| **F-M11** — `normalizeTypedDate` on LLC `formation_date` + checklist `due_date` (5 sites) | **Intact / correct** | — |
| **F-M20** — `borrowerId` on outbound DOB review rows | **Intact / correct** | — |
| **F-M12** — `sanitizeDob`/`normalizeTypedDate` in legacy `/sync-reviews/:id/approve` | **Intact / correct** | — |
| **F-M8** — portal value on `clickup_year_out_of_range` cards | **Intact / correct** | — |
| **F-M1 / WO-16** — `resolveOnly` status (mirror) vs internal_status (task status) split | **Intact / correct** | — |
| **WO-13 / F-M19** — `schema_migrations` ledger + checksum-drift alarm | **Intact / correct** | Drift alarm self-heals the ledger row same boot (warns first boot only) — documented, acceptable. |
| **WO-13** — dup-number gate, baselined 033/088, 113 resolution, CI + npm test chain | **Intact / correct** | One stale comment in `check-migrations.js:39-40` (says `address_canon_cache -> 115`, actually at 124). Cosmetic; fix to avoid misleading the next author. |

**Verification verdict:** **PASS with two watch-items.** No shipped fix regressed or reversed. The WO-2 retry loop's create-duplicate edge and the un-awaited breaker seed are the only "weak" spots that carry real risk, and both are captured below.

---

## Section 2 — New problems found this round

Ordered most-severe first. **CONFIRMED** = I traced the exact code path and it fires as described. **Needs a closer look** = strong evidence, one assumption not yet nailed down.

### CONFIRMED — fix before the next busy week

#### N-1 (HIGH) — The "be patient" upgrade can create the borrower's card in ClickUp twice, both with full SSN/DOB
- **Plain version:** When the robot creates a new card and the line to ClickUp stalls, our new patience feature tries again. But if the *first* attempt actually reached ClickUp and made the card — and only the *reply* got lost — the retry makes a **second identical card**. Two cards for one borrower, each stamped with our file ID and each carrying the Social Security number and date of birth. This is exactly the near-duplicate mess the sync fights everywhere else, and we introduced it ourselves.
- **Code anchor:** `src/clickup/client.js` `call()` retry loop lines **177-213** — retries on network/timeout (`186-191`) **and** on retryable HTTP status (`197`) for **every** method. Reached by `createTask` (`217-218`) via `orchestrator.pushApplication` create branch (`267`) and `createForNewFile`/`recoverUnlinkedFilesOnce`. Before WO-2, `call()` was a single bare fetch with no retry, so this window is brand new.
- **Why it's real:** `createTask` is a POST with no idempotency key and no post-timeout "did it already land?" check. `setField`/`updateTask` retries are value-idempotent and safe — only **create** (and `addComment`) are exposed.
- **Severity:** HIGH — duplicate borrower record + duplicated PII + the downstream twin-file cleanup burden.
- **Recommended fix:** Gate the retry by method. Retry GET/PUT and value-idempotent `setField` freely; for `createTask`, either (a) do a single attempt with **no** network/timeout retry, or (b) attach an idempotency key / do a post-timeout "search for a card already carrying this Portal-File-ID" existence check before re-issuing the create.

#### N-2 (HIGH) — Inviting a co-borrower on a shared family email can hand the wrong person into someone else's file
- **Plain version:** The primary borrower on a $2M file adds a co-borrower and types the co-borrower's name plus a **family email already on record for a different real borrower** (a father, sibling, or office manager — common in this book of business). The co-borrower paths match purely on email and quietly attach that *other* existing person to the file, giving them a portal invite that opens someone else's SSN, DOB, and documents. The primary borrower/staff *create* paths were fixed for this (they call a name-conflict guard); the **two co-borrower paths were not.**
- **Code anchor:** `src/routes/borrower.js:2624-2628` (`inviteCoBorrower`) and `src/routes/staff.js:1143-1164` (`attachCoBorrowerToApp`) both do `ON CONFLICT (email) DO UPDATE` with **no** name-conflict check. Contrast the guarded primary paths at `staff.js:1006` and `:806`, which call `emailAdoptionConflict` (`staff.js:767`) before their upsert. **Verified in source** — `inviteCoBorrower` upsert at `2624-2627` has no guard.
- **Severity:** HIGH — wrong person granted access to another borrower's PII; a GLBA/Safeguards-relevant unauthorized-disclosure path.
- **Recommended fix:** Run the existing `emailAdoptionConflict(email, first, last)` guard before the `ON CONFLICT (email)` upsert in **both** co-borrower paths; on a name mismatch, stop and raise a review instead of silently adopting.

#### N-3 (HIGH) — A blank or "N/A" coming back from ClickUp can erase a real six/seven-figure loan amount
- **Plain version:** For money fields, when ClickUp sends back a plain `0`, or any non-numeric text like "N/A", our reader turns it into a **real 0** and writes it over the true amount. Unlike dates and DOB — which stop at a review when they look wrong — money has **no review gate**. A stray 0 silently overwrites the loan amount, purchase price, or ARV.
- **Code anchor:** `src/clickup/transforms.js:174` `parseMoney` — strips everything except `[0-9.\-]`, so `"N/A"` becomes `""`, and `Number("")` is **0** (`isFinite(0)` is true → returns `0`, not `null`). **Verified in source.** Consumed by `readValue` (`mapper.js:290`) and applied via `COALESCE` at `ingest.js:1198-1216`/`1411` — and because `0` is not null, `COALESCE` keeps the 0 (i.e. it overwrites).
- **Severity:** HIGH — silent corruption of the single most important number on the file.
- **Recommended fix:** Have `parseMoney` return **null** (not 0) when the source contains non-numeric characters, and have `readValue` return **undefined** for an unparseable currency so `COALESCE` keeps the real portal value. Consider a review gate for a money value that swings toward 0.

#### N-4 (HIGH) — A pricing change another team shipped (db/126) will reopen *every* already-signed term sheet
- **Plain version:** A parallel team added the loan **term** to the list of things that "reopen the signed term sheet when they change." But the portal stores term as a bare number-string (`"12"`, `"30"`) while ClickUp's term dropdown round-trips as a label (`"12 Months"`, `"30 year"`). Those never match, so on the next reconcile the trigger sees "the term changed" on essentially every registered file and **reopens the signed term sheet** — forcing a fresh signature on deals that never actually changed.
- **Code anchor:** `db/126_reopen_trigger_full_inputs_and_fico.sql:48` (`NEW.term IS DISTINCT FROM OLD.term`) **×** `src/lib/product-registration.js:150` (`term = inputs.term ? String(inputs.term) : null`) **×** `src/lib/pricing.js:147` (`parseTermMonths`) **×** `src/clickup/ingest.js:1197,1411` (inbound `term = a.term` via `COALESCE`) **×** `src/clickup/crosswalk.js:75` (term labels `'12 Months'`, `'30 year'`, ...). **db/126 line 48 verified in source.**
- **Severity:** HIGH — mass spurious reopen of signed legal documents; erodes trust in the reopen mechanism and buries staff in false conditions.
- **Recommended fix:** Compare `term` **canonically** in the trigger (parsed month-count / normalized label), or store `applications.term` in the same representation the inbound sync writes, so a no-op inbound term write can't look like a change.

### Needs a closer look — likely real, verify before scheduling

#### N-5 (MEDIUM) — db/126 also reopens a signed term sheet when the sync merely re-seats co-borrower *roles*
- **Plain version:** The same db/126 change added `co_borrower_id` to the reopen list. But the inbound identity sync routinely **re-seats** who is "borrower" vs "co-borrower" as a structural, no-review correction — same two people, roles swapped. That now trips the trigger and reopens the signed term sheet even though the economics didn't change.
- **Code anchor:** `db/126:50` (`NEW.co_borrower_id IS DISTINCT FROM OLD.co_borrower_id`, verified) **×** `src/clickup/ingest.js:1001,1039,1471` (`UPDATE applications SET borrower_id=$2, co_borrower_id=$3 ...` role swaps).
- **Severity:** MEDIUM. **Recommended fix:** Only reopen when a co-borrower actually enters/leaves the deal (the *set* of people changes), not on a pure role re-seat.

#### N-6 (MEDIUM) — Hebrew/Yiddish borrower names get thrown away, minting "Unknown Unknown" profiles
- **Plain version:** When a ClickUp card's Borrower-Name field is blank, the reader recovers the name from the card title (`"<Name> - <address>"`). But the check requires a Latin letter, so a name written in Hebrew/Yiddish fails the test and the borrower becomes "Unknown Unknown." Given this clientele (names like Elbaum, Salamon, Schwimmer, Leifer), this is a live risk, not a hypothetical.
- **Code anchor:** `src/clickup/mapper.js:346` — guard `/[a-z]/i.test(head)`.
- **Severity:** MEDIUM. **Recommended fix:** Use a Unicode-aware letter test: `/\p{L}/u.test(head)` (the comment already says the intent is "must contain letters").

#### N-7 (MEDIUM) — Borrower date of birth is written to the server log in cleartext on every blocked DOB push
- **Plain version:** Every time the DOB safety gate blocks a change (now a routine event), it logs the old and new DOB values in the clear. Those epoch values decode to the exact date of birth — PII sitting in plain server logs.
- **Code anchor:** `src/clickup/orchestrator.js:364` — `console.error('[clickup] BLOCKED DOB change push', { appId, taskId: id, from: old, to: c.value, reason })`.
- **Severity:** MEDIUM (PII / Safeguards-relevant). **Recommended fix:** Drop `from`/`to` from the log line (keep appId/taskId/reason), or log only masked day-forms behind a debug flag. The structured audit rows already capture this safely.

#### N-8 (MEDIUM) — "Investor loan number" copied from a duplicated card is never scrubbed
- **Plain version:** The documented way to start a new deal is to **duplicate** a ClickUp card. We already scrub the copied YS loan number and the Portal-File-ID stamp as stale — but the **investor loan number** gets no such treatment and rides onto the new/different file.
- **Code anchor:** `src/clickup/mapper.js:126` (`{ col:'investor_loan_number', dir:'pull' }`); `ys_loan_number` gets full stale-copy handling (`ingest.js` `copiedLoanNumber` at `601-633`, `1347-1363`) but `investor_loan_number` gets none and is `COALESCE`-upserted from `read.app` on create (`ingest.js:1200,1528`).
- **Severity:** MEDIUM. **Recommended fix:** Treat `investor_loan_number` like `ys_loan_number` in the copied-key logic — drop it when a stale-duplicate is detected.

#### N-9 (MEDIUM) — The assignment-fee identity (purchase = contract + fee) isn't enforced on the inbound path
- **Plain version:** The one place that binds `purchase_price = underlying_contract_price + assignment_fee` only runs on staff/borrower create+edit. When the same three numbers come **inbound from ClickUp**, they're each written independently, so they can drift out of the frozen assignment relationship.
- **Code anchor:** `src/clickup/ingest.js:1198` (purchase_price) & `1211-1212` (underlying/fee) via independent `COALESCE`; `src/lib/fields.js:44-53` (`assignmentFields`, create/edit only); `product-registration.js:104-110`.
- **Severity:** MEDIUM. **Recommended fix:** On inbound apply, when `is_assignment` is true, recompute `purchase_price = num(underlying) + num(fee)` (route all three through `assignmentFields`).

#### N-10 (MEDIUM) — Outbound money write can emit a literal "0" that slips past the no-clearing guard
- **Plain version:** The mirror of N-3 going the other way: a portal money value of 0 is pushed as the string `"0"`, which the "never clear a field" guard does **not** block (it only blocks null/empty), so it can overwrite a real ClickUp amount.
- **Code anchor:** `src/clickup/mapper.js:160` (`numToString(parseMoney(val))`); guard at `src/clickup/client.js:65-77`.
- **Severity:** MEDIUM. **Recommended fix:** Treat 0 as "no value" on the outbound push (return undefined from `writeValue` for 0 unless a deliberate zero is explicitly intended).

#### N-11 (MEDIUM) — Staff task list flips tasks to "Overdue/Today" an evening early (UTC "today")
- **Plain version:** The task screen computes "today" in UTC, so after ~7-8pm Eastern it thinks it's already tomorrow and marks due-today items overdue.
- **Code anchor:** `app-v2/src/screens/StaffTasks.jsx:59,77,79` (consumed at 62/80/81/135-138/161).
- **Severity:** MEDIUM. **Recommended fix:** Build "today" from the browser's local calendar (`getFullYear`/`getMonth`/`getDate`), matching `StaffQueue.jsx`.

#### N-12 (MEDIUM) — Family members with compound surnames can merge on a shared email
- **Plain version:** The name-conflict check compares last names by their **first word only**, so "Cohen Katz" and "Cohen Weiss" both reduce to "Cohen" and are treated as the same surname — letting two different family members merge on a shared email. The corroboration check nearby uses the *full* last name, so the two disagree.
- **Code anchor:** `src/clickup/identity.js:153-161` (`nameConflict` uses `nameToken(aLast)`) vs `identity.js:131-135` (`emailMatchCorroborated` uses full `lc(a.lastName)`); consumed at `staff.js:775`, `intake.js:52`.
- **Severity:** MEDIUM. **Recommended fix:** Compare last names by the full normalized string in `nameConflict` (keep the initial-vs-full allowance only for the first name).

### Lower-severity new items (log, batch into cleanup)

| # | Plain summary | Anchor | Sev |
|---|---|---|---|
| N-13 | Sustained (>~6.7h) ClickUp outage turns into a per-file review-row + loan-officer email storm (WO-1 throw × WO-2 40-attempt dead-letter). | `clickup-sync.js:116-138` → `sync-review.js:86,97` | Med/low |
| N-14 | WO-2's 40 patient retries each count toward the volume breaker (counted before the write lands), so an outage can hold the breaker open and stall recovery. | `orchestrator.js:399` circuitCheck before `setField`; `clickup-sync.js:116-118` | Med/low |
| N-15 | Breaker seed (`seedBreakerFromDb`) is un-awaited before the drain starts — brief empty-breaker window at boot, the exact deploy-mid-storm moment F-M16 was meant to cover. | `clickup-sync.js:1280`; `orchestrator.js:527-538` | Low |
| N-16 | The seed **overwrites** (`_writeTimes = seeded.slice(...)`) any breaker entries appended by pushes that fire before it resolves — merge instead of clobber. | `orchestrator.js:536` | Low |
| N-17 | `reconcileOnce` has no concurrency guard — overlapping passes read the same watermark and last-writer-wins on save, regressing the bookmark during long catch-ups. | `clickup-sync.js:789-811,1366` | Low |
| N-18 | Inbox "processing" reclaim has no heartbeat (unlike the push side) — a slow ingest can be re-claimed and double-ingested under token-bucket contention. | `clickup-sync.js:659-703` | Low |
| N-19 | `upsertTrackRecord` dedups on `address_key` with **no unique index** — concurrent ingest of two closed tasks for the same borrower+property can create duplicate track records that inflate verified experience. | `ingest.js:476-519`; `db/082:135-136`; `db/044:36` | Med/low |
| N-20 | #324 SharePoint cards permanent mirror failures into the **shared** `sync_review_queue`, inflating the ClickUp sync's reminder/escalation/weekly-digest sweeps. | `sharepoint-backup.js:841,1475`; `sync-review.js:197-271` | Low |
| N-21 | Outbound co-borrower push is **armed but unguarded** — shadow/placeholder blanking and the PII-overwrite shield don't cover second-borrower fields. Latent; fires the instant `ctx.coBorrower` is wired. | `mapper.js:242-248`; `orchestrator.js:465-468` | Low (latent) |
| N-22 | Funded MTD/YTD counts + YTD dollars + avg cycle-days bucket closings by a **UTC** month/year boundary. | `staff.js:316-332` | Low |
| N-23 | DOB review annotation ("not born yet"/age) uses UTC today/year. | `SyncReviews.jsx:100-105` | Low |
| N-24 | SSN last-4 collision (1-in-10,000) alone short-circuits the whole identity-mismatch audit for a file. | `clickup-sync.js:327-332` | Low |
| N-25 | Three divergent shadow-email detectors (`@clickup.local` domain-only vs `noemail+` prefix) — latent misclassification. | `transforms.js:30`, `mapper.js:199` vs `clickup-sync.js:263,547` | Low |

---

## Section 3 — Still-open findings from Round 1, re-confirmed

These were flagged in July, are **not** yet fixed, and are still real. Ranked by risk. (Do not fix here — this is an audit.)

| Rank | Finding | Plain risk | Still real? |
|---|---|---|---|
| 1 | **F-H3** — standing DOB backdating auto-adopt in `sync-autoresolve.js` | A DOB can be moved automatically when the system *thinks* it can prove the change; the "provable" set is where DOB corruption keeps re-entering. | **Yes** |
| 2 | **F-M5 / F-M18** — identity merge on a shared attribute; additive contacts absorb the wrong person | Same root as New Bug N-2/N-12; the additive-contact path is the one the idempotency fix does **not** cover. | **Yes** |
| 3 | **F-H2** — SharePoint name-only fuzzy auto-file | A document can auto-file into the wrong borrower/address folder on a fuzzy name match. **Note:** another agent edited `sharepoint-backup.js` (#323/#324) since July — the classifier/escalation now cards failures into the shared queue (N-20), but the underlying name-only auto-file risk still stands; re-audit against the current matcher. | **Yes (re-check)** |
| 4 | **F-M2 / F-M4** — DOB human-provenance gaps | Some DOB writes don't record who/what made the change, weakening the "a DOB change is always a human decision" guarantee. | **Yes** |
| 5 | **Zero-wipes-money / "N/A"→$0** (field-forensics) | Now **confirmed and promoted** to New Bug N-3/N-10. | **Yes (confirmed)** |
| 6 | **co-borrower email push armed but unguarded** (field-forensics) | Confirmed and captured as N-21 (latent). | **Yes** |
| 7 | **investor_loan_number untreated copied-key** (field-forensics) | Confirmed and captured as N-8. | **Yes** |
| 8 | **four divergent placeholder-name sets** | A name stored as "N/A"/"TBD"/"Borrower" can never be healed to the real name (heal predicates omit those tokens). | **Yes** |
| 9 | **F-M22** — `upsertTrackRecord` address-key race | Confirmed and captured as N-19 (no unique index). | **Yes** |
| 10 | **F-M21** — silent skipped materialization | A file that can't be created can still go quiet in edge cases; verify every skip path queues a visible review row. | **Yes** |
| 11 | **officer reassignment reverts + accumulates**, **UTC-"today"**, **RTL name chars** | UTC-today → N-11/N-22/N-23; RTL name chars → N-6 (confirmed). Officer reassignment revert still open. | **Yes** |
| 12 | **F-M9 / F-M17** (review dismissals / allow_shared_email), **F-M10** (sp_rematch scope), **F-M13** (hardcoded year-guard field list) | Lower-severity correctness/scoping gaps; still present. | **Yes** |

**Parallel-team work (outside the original audit):** pricing/term-sheet (#316/#317/#320) and SharePoint (#323/#324). **#320's db/126 introduced two real regressions into the sync's reopen behavior** (N-4 confirmed, N-5 needs-a-look). **#323/#324's SharePoint changes** route permanent mirror failures into the shared review queue (N-20) — a cross-contamination of the ClickUp sync's own sweeps. Everything else in that parallel work looks isolated from the sync.

---

## Section 4 — Industry lessons (concrete "we should check/do X")

Fact-checked against ClickUp's docs, bidirectional-sync vendor writeups (Unito/Stacksync/Whalesync), and 2024-2026 FTC/PII guidance.

1. **Confirm the ClickUp webhook receiver ACKs in well under 7 seconds and does all PII work *after* acknowledging.** ClickUp marks a webhook "failing" on any non-2xx **or** any response slower than 7s, and **immediately suspends** it on a single 401/410; after ~100 failures it's auto-suspended for good. If our receiver runs auth, `sanitizeDob`, identity-merge, or DB work *before* replying 200, a slow spell or one bad auth response can silently kill the entire inbound leg. *(Confirmed.)* — **Check:** the receiver replies 200 fast and defers processing to the durable inbox.

2. **Confirm the token-bucket RPM ceiling matches our actual ClickUp plan.** ClickUp's limit is ~100 requests/min/token on most plans (Enterprise far higher). If our constant is too high we get 429 storms; too low and the sync crawls. *(Confirmed 100/min for most plans.)* — **Check:** the `client.js` bucket size equals the real plan limit, with headroom.

3. **Add a scheduled content-checksum reconciliation plus a canary round-trip.** Never trust row counts — validate field *values*. Store a per-application hash of the exact fields we last pushed; on reconcile, recompute and emit a repair push on divergence. Separately, write a changing sentinel into one dedicated **non-PII test task** and read it back on a schedule, so a fully-broken pipeline is caught with zero user traffic. *(Content hashes + shadow/canary testing are confirmed industry standard; Postgres has no built-in MD5 aggregate but one is trivially `CREATE AGGREGATE`-able.)* — **Do:** both, cheap-first.

4. **Stop pushing the full 9-digit SSN to ClickUp; align with the amended FTC Safeguards Rule.** Since May 2024, Safeguards requires encryption, least-privilege, monitoring, and **FTC breach notification within 30 days** for ≥500 consumers; the Blackbaud order adds a delete-what-you-don't-need duty. Standard practice is tokenization with a format-preserving **last-4** — and we already carry `ssn_last4`. *(Confirmed.)* — **Do:** push last-4 only; confirm signed DPAs with ClickUp **and** Microsoft/SharePoint and a written 30-day breach runbook; define an SSN/DOB retention/deletion policy inside both tools.

5. **Never derive any dedup/idempotency/correlation key from borrower PII, and resolve conflicts per-field with human review for identity/legal fields.** Idempotency keys must be random high-entropy values, never built from SSN/DOB/email (confirmed best practice). And cross-system "last-write-wins" by comparing timestamps is unreliable because clocks skew — PII/legal fields specifically must go to human review, not auto-resolve. *(Both confirmed.)* — **Check:** no key in `orchestrator`/`enqueue`/`identity` is built from PII; conflict resolution is field-level; the reconcile watermark and any ordering do **not** rely on comparing ClickUp `date_updated` against a portal `updated_at`.

6. **Treat ClickUp webhooks as at-least-once (duplicates are contract).** Convergent `task_id`-keyed writes are safe; the exposed class is **additive** deliveries (a duplicate co-borrower/contact) — exactly F-M5/M18 and N-2. — **Check:** every additive create is guarded by a name/identity corroboration, not email alone.

7. **Verify dropdown/label fields survive the round-trip.** ClickUp returns dropdown/label selections as an **orderindex integer**, not the option name, and must be *set* by option UUID. If our enum crosswalk (program, loan_type, property_type, **term**) is off, we silently write the wrong option — and N-4 is a live example of a label/round-trip mismatch already biting. *(Confirmed.)* — **Check:** every enum crosswalk is exercised both directions.

8. **Confirm the backfill paging can't strand a large folder.** `runBackfill` breaks when a page returns <100 tasks; a pipeline folder holding >1000 tasks can leave the tail unsynced. — **Check:** page-limit vs real folder sizes.

---

## Section 5 — Error-handling enhancement plan (ranked by leverage)

1. **Make non-idempotent creates safe (highest leverage).** Attach an idempotency key or a post-timeout existence check to `createTask`, and restrict network/timeout retries to idempotent methods. This closes New Bug N-1 *and* hardens the whole retry layer WO-2 introduced. One change, removes the worst new failure mode.

2. **A money value needs the same review gate dates/DOB already have.** Return null (not 0) from `parseMoney` for non-numeric input, return undefined for unparseable currency, and route a swing-to-zero on a money field to `sync_review_queue` instead of silently writing. Closes N-3/N-10 and the long-standing zero-wipes-money class.

3. **A real, terminal dead-letter table with stamped failure metadata + a staff "sync health" view.** We already write `clickup_enqueue_failed` / `clickup_ingest_failed` / dead-letter rows; promote them into one terminal DLQ (no self-redrive) carrying error class, attempt count, first/last seen, and a one-click reviewer action. Feed the audit taxonomy into a staff-facing health page. Turns loud-but-scattered signals into something operable.

4. **Classify ClickUp 400/422 as terminal-poison, separate from transient outage.** WO-2 tags `e.retryable`, but a rejected field (bad option id, year-out-of-range) will retry 40× and then dead-letter noisily. Separate "ClickUp said no, don't retry" from "ClickUp is down, do retry" so poison rows short-circuit to review immediately. Also fixes the outage-email-storm (N-13) and the breaker-count inflation (N-14).

5. **Full jitter + await the breaker seed + mutex the reconcile/inbox loops.** Confirm backoff uses randomized full jitter (so a fleet doesn't dead-letter in lockstep after an outage), `await seedBreakerFromDb()` before the first drain (N-15/N-16), and give `reconcileOnce`/`processInboxOnce` an in-process guard + advisory lock (N-17/N-18). Small changes, remove the double-run and thundering-herd surfaces.

6. **Half-open the volume breaker deliberately.** When the breaker is open, verify there's a controlled single-probe recovery rather than an all-at-once resume, and that a genuine outage's failed *attempts* don't count toward the write ceiling (N-14).

---

## Section 6 — Updated priorities (new + still-open, one list)

**Do first (before the next busy origination week):**
1. **N-1** — stop `createTask` retries from duplicating the borrower's PII card *(HIGH, confirmed)*.
2. **N-2** — add the name-conflict guard to both co-borrower paths so a shared family email can't leak another borrower's file *(HIGH, confirmed)*.
3. **N-3** — stop a blank/"N/A" from ClickUp erasing a real loan amount *(HIGH, confirmed)*.
4. **N-4** — fix db/126 so it stops reopening every signed term sheet on the term round-trip mismatch *(HIGH, confirmed; owner decision below)*.

**Do next (this cycle):**
5. **N-5** — db/126 co-borrower role re-seat spurious reopen.
6. **N-7** — stop logging DOB in cleartext (PII).
7. **N-6** — Unicode-aware name recovery (Hebrew/Yiddish) so borrowers stop becoming "Unknown Unknown".
8. **N-8 / N-9 / N-10** — copied investor_loan_number, inbound assignment invariant, outbound "0" overwrite.
9. **F-H3 / F-M2 / F-M4** — tighten DOB auto-adopt + provenance (still-open, high-value).
10. **F-H2** — re-audit SharePoint name-only auto-file against the current (#323/#324) matcher.

**Then (cleanup batch):**
11. N-11/N-22/N-23 (UTC-today), N-12 (compound surname), N-19 (track-record unique index), N-13/N-14/N-15/N-16/N-17/N-18 (outage-storm, breaker seed, loop mutexes), N-20 (SharePoint queue contamination), N-24/N-25, and the four-placeholder-name-set unification.

**Industry adds (schedule alongside):** SSN-last-4-only to ClickUp + DPAs/breach runbook (Section 4 #4); webhook <7s ACK check (#1); content-checksum reconcile + canary (#3); token-bucket ceiling check (#2).

### Two owner decisions needed
- **Decision A — Duplicate-card prevention approach for N-1:** do we (a) simply **not retry** a create on a timeout (simplest, tiny risk a genuinely-lost create isn't retried and instead surfaces as an unlinked-file review), or (b) invest in an **idempotency key / post-timeout "does this card already exist?" check** (more robust, more code)? Recommendation: (a) now, (b) as a fast-follow.
- **Decision B — db/126 reopen scope (N-4/N-5):** the parallel team's intent was to catch real pricing changes. Do we **narrow** the trigger (canonical term compare + reopen co-borrower only when the *set* of people changes) — recommended — or **temporarily remove** `term`/`co_borrower_id` from the reopen list until the canonical compare ships? This touches another team's migration, so it needs an owner call on who owns the fix.

---

*Prepared read-only against `origin/main` @ `b1bfb68`. No code was modified. Top confirmed bugs (N-1, N-2, N-3, N-4) were traced to their exact source lines; `client.js:177-213`, `borrower.js:2624-2628`, `transforms.js:174`, and `db/126:48,50` were each read and verified for this report.*
