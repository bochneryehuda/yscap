# Borrower History Backfill & Identity Graph (from ClickUp) — design

**Goal:** ingest the **entire ClickUp task history** (all officers, all statuses, RTL *and* non-RTL) to build, inside our system:
- **Shadow borrower profiles** for people who have no portal account yet,
- a per-borrower **LLC library** (every entity they've ever used),
- a per-borrower **track record** (every closed deal, auto-derived),
- **RTL loan files** for the bridge / fix-&-flip / short-term deals, sitting in each loan officer's internal pipeline "ready to be linked,"

so that (a) staff can use the system as an internal CRM immediately, and (b) when a borrower registers, their whole history (files, LLCs, track record) **auto-links** to their new account — no re-entering old info.

This runs **now** (one-time backfill) **and continuously** (every webhook / re-sync).

> Status: **DESIGN — awaiting owner answers to §11 before building.**

---

## 1. What we ingest
Every task in the **Loan Pipeline** space, **all folders, all statuses (incl. closed/funded/cancelled)**, paged and rate-paced. From each task we extract the borrower identity, the LLC, the property, economics, dates, and status.

**Two tiers by the RTL `*Program` filter:**
- **RTL (bridge / fix-&-flip / private HM / short-term):** create a **portal loan file** (`applications`, source `clickup_backfill`) in the officer's pipeline, linked by `task_id`, plus everything below.
- **Non-RTL (DSCR / Non-QM / HELOC / etc.):** **do NOT** create a portal loan file — but still harvest the **borrower profile, LLC, address, and track-record line** from it (data-only). *(This is how a borrower's full LLC library & track record get built even from non-RTL deals.)*

## 2. Borrower identity resolution (the graph)
**Primary key = SSN.** ClickUp stores plaintext SSNs on tasks; our system encrypts them. To match without exposing plaintext we compute a **keyed hash** `ssn_hash = HMAC-SHA256(normalizedSSN, SSN_MATCH_KEY)` and store it on `borrowers` and on each synced source. Same SSN ⇒ same hash ⇒ same person. *(Decision §11.2.)*

**Secondary matching (when SSN is absent, or to confirm):** a borrower is the same person when **≥2 of** {full name, email, phone, DOB, SSN} agree (reuses `identity.js`). SSN match alone is treated as strong.

**On registration:** when someone creates a portal account, we resolve them into the graph and **link** their account to the matching shadow profile + all its files/LLCs/track-record. *(Auto vs confirm — Decision §11.1.)*

## 3. Shadow borrower profiles (no account)
We create `borrowers` rows (PII, encrypted SSN) **without** `borrower_auth` — a "shadow" contact usable internally. When a real registration matches, we **merge** the account into the shadow profile (or link) rather than duplicating. Marked `origin='clickup_backfill'`.

## 4. LLC library
Every `*LLC Name` seen on any task (RTL or not) for a borrower → an `llcs` row on that borrower, `is_verified=false`, `origin='clickup_backfill'`, with the source task id + EIN if present. Deduped by (borrower, normalized llc_name). When a new file is created, the officer/borrower can **select from all of the borrower's LLCs**.

## 5. Track record (auto-derived)
Every **closed/funded** task for a borrower → a `track_records` line, `is_verified=false`, note `"auto-derived from ClickUp, unverified"`, source task id. Fields harvested: property address, purchase price, sale/refi info, purchase date, closing date, ARV/rehab.

**Deal-type inference (Decision §11.3):**
- Program = fix-&-flip → **flip**;
- a **purchase AND a refinance for the SAME property** (address match) → **fix-&-hold**;
- otherwise **default fix-&-hold**, flagged unverified. (Owner: "if unsure, default fix-&-hold; manually changeable.")
Dedup by (borrower, normalized address, deal window).

## 6. LO internal application autocomplete
When a loan officer starts a file and types a **borrower name**, we search the whole borrower graph and **auto-populate** everything known (emails, phones, DOB, address, LLCs, track record) — all editable. Powered by the shadow profiles above.

## 7. Multiple emails / phones per borrower
A borrower often has several emails/phones across files. We keep them all in a new **`borrower_contacts`** table (kind = email|phone, value, source, is_primary), so none are lost and any can be chosen. *(Decision §11.4.)*

## 8. The backfill job
A **paced, batched** worker: iterate officer folders → `getFilteredTeamTasks` pages → for each task, upsert borrower (by ssn_hash / identity) → LLC → track-record → (RTL) application. Respects ClickUp's 100 req/min. Idempotent (keyed on task_id), resumable (watermark). Stores the **same normalized fields a live file stores** (no heavy blobs — efficient). Runs once now, then **incrementally** on every webhook/poll (new/closed tasks re-checked by SSN).

## 9. Ongoing linkage
On every webhook/poll we re-resolve the task's borrower and **keep linking** any tasks that share the borrower's SSN — so the graph, LLC library, and track record stay current forever, not just at backfill.

## 10. Privacy & security (must get right)
- Auto-linking a **new account** to files by fuzzy match can expose one person's PII to another if the match is wrong. SSN match is strong; 2-piece (name+email) is weaker. **Decision §11.1** sets auto vs confirm per strength.
- SSN is matched via keyed **hash**, never compared in plaintext; the plaintext stays encrypted. Logs stay masked.
- Backfilled files/profiles are **internal/staff-only** until a borrower links; nothing is shown borrower-facing without a confirmed link.

## 11. Decisions — ✅ RESOLVED (locked)
1. **Auto-link:** ✅ **auto-link on a full SSN match; on weaker 2-piece matches (name+email/phone/DOB), show a "these look like your past files — confirm?" step** before linking. Never blind-link on weak signals.
2. **SSN matching:** ✅ **keyed HMAC-SHA256(SSN, SSN_MATCH_KEY)** stored on borrowers + synced sources; plaintext stays encrypted, logs masked.
3. **Track-record deal type:** ✅ fix&flip→**flip**; purchase+refi same property→**fix-&-hold**; else **default fix-&-hold, unverified/changeable**.
4. **Alt contacts:** ✅ **`borrower_contacts` table** keeps every email/phone; one primary; all selectable.
5. **Track-record source:** ✅ default — only **closed/funded** tasks become track-record lines *(owner may override later)*.
6. **Cadence:** ✅ default — **live webhooks + a nightly full reconciliation sweep** *(owner may retune)*.

**Confirmation UX (from #1):** a new `borrower_link_candidates` surface — when a registering borrower has a weak match, we present the candidate past-profile(s) for them (or staff) to confirm/merge; a strong SSN match links silently.

---

## New schema (sketch, pending §11)
- `borrowers` += `ssn_hash text`, `origin text`, (has-account inferred from `borrower_auth`).
- `borrower_contacts (id, borrower_id, kind check(email|phone), value, source, is_primary, created_at)`.
- `llcs` += `origin`, `source_task_id`.
- `track_records` += `origin`, `source_task_id`, `inferred` (bool), address dedup key.
- `applications` source `clickup_backfill`; `clickup_pipeline_task_id` already the join key.
- a `clickup_task_index (task_id pk, borrower_id, application_id, kind, program, ssn_hash, last_seen)` to make re-sync/linking O(1).
