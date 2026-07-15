# ClickUp Data Safety — incident forensics + the layered guard system

Status: **binding policy** (owner-directed 2026-07-15). Companion to
`docs/CLICKUP-DATE-INCIDENT.md` (the date-corruption root fix, write journal,
and sync review queue). This document adds the independent forensics of the
2026-07-14 "data destruction" report and the SECOND guard layer built on top of
the date-incident fixes. Every change touching `src/clickup/*` or `src/sync/*`
must keep both layers intact.

## 1. Forensics: the 2026-07-14 "wipe" report, verified against live ClickUp

| Reported | Verdict | Evidence |
| --- | --- | --- |
| "Pinches Lichtman financial profile wiped 5:23–5:27 PM" | **Not a wipe.** Original task FILLE-1911 (129 Carlisle St) untouched since Jul 8 with every value intact (verified field-by-field). FILLE-1969 (381 S Main St) was **created 5:22 PM** as a ClickUp-UI duplicate: copied description, pull-only fields the sync cannot write, a UI-picker `place_id` on its location, no portal stamps. | live task reads |
| "Yaniv Erez Miami reset at 12:00–12:03 PM" | **Same pattern.** FILLE-1966 created 11:59:34 AM; its *Date File Submitted* equals the Yonkers source task's creation instant to the second (only duplication copies that). Source FILLE-1961 holds every "wiped" value + intact portal stamps. | live task reads |
| Same-second 8-field clear + literal `"undefined"` written 12:01 PM | **Programmatic, but not this codebase.** The portal had no binding to that task at noon (the stamp-ambiguity bug fixed at 3:44 PM that day), has no field-clear primitive (all task-path DELETEs hard-blocked since Jul 7; empty values skipped since the mapper's first commit), and no string path that can produce `"undefined"` (all `.filter(Boolean).join()`). A second automation writes to this workspace under the same token identity (the email/phone auto-fill on task creation; the legacy `"Name  - "` double-space title builder on pre-portal tasks — the exact missing-variable bug family). Check ClickUp Automations + connected apps; give the portal its own token identity. | code + git history + live reads |
| Year-0026 expected closing walking backward (Yuda elbaum) | **Real — the date-incident class.** Root-fixed in #233/#235 (4 AM America/New_York write convention, year windows, review queue, restore script). | live epoch `-61329625438000` = 0026-07-17 04:00 NY-LMT |
| DOB off-by-one on 10 files | **Real — same class.** Midnight-UTC epochs re-day to the previous NY day in ClickUp. Fixed by `dateOnlyToClickUpEpoch` (#233); existing values healed by `scripts/clickup-date-restore.js`. | live epochs |

Attribution lesson: every API write shows in ClickUp as the token owner. The
`clickup_write_log` journal (#233) is the portal's complete, queryable record —
if an event is not in the journal, the portal did not do it:

```sql
SELECT created_at, task_id, field_id, field_key, old_value, new_value, changed, blocked, source
  FROM clickup_write_log WHERE task_id = '<task>' ORDER BY created_at;
```

## 2. Guard layer 1 — the date-incident fixes (#233/#235, summarized)

Calendar-string dates end-to-end · `dateOnlyToClickUpEpoch` (4 AM NY, garbage
years refused, round-trip invariant enforced) · read-before-write with no-op
suppression · `clickup_write_log` journal (before + after, SSN/card masked) ·
DOB ±1-day shift block → `sync_review_queue` + staff UI · inbound year guards →
review with auto-pivoted proposals · inbound DOB-disagreement review · inbound
change audit (`clickup_pull_field_change`) · restore tooling (wipe-don't-guess).
Full detail: `docs/CLICKUP-DATE-INCIDENT.md`.

## 3. Guard layer 2 — structural anti-destruction (this change)

**HTTP chokepoint hard stops** (`src/clickup/client.js` — every ClickUp call
funnels through `call()`):
- `guardNoFieldClearing`: `setField` refuses null / undefined / empty-string /
  empty-array / empty-users values AND any value containing a nested null, NaN,
  Infinity, or undefined (JSON.stringify silently converts those into
  field-clearing nulls). **The sync can update ClickUp values; it is physically
  unable to erase one.**
- `guardTaskUpdatePayload`: task updates are a **status-only allowlist** — the
  sync can never rename a task or touch a description (names are set only at
  task creation).
- `guardNoTaskDeletion` (pre-existing): no DELETE on any task path, ever.

**Push orchestration** (`src/clickup/orchestrator.js`, layered into the #233
guardrails):
- **Scoped pushes never create tasks** — a lost binding can't spawn a
  near-duplicate on the next edit.
- **Scoped pushes fail CLOSED** when the pre-write read fails (queue retries);
  only the human-watched admin full repush proceeds warn-only.
- **PII overwrite shield**: a full repush may FILL a blank identity field
  (name / SSN / email / cell / home address) but never REWRITE a differing one;
  blocked writes are journaled + queued to the sync review queue
  (`pii_overwrite_blocked`), and approval applies through the normal scoped
  path (`resolveOnly` keys `ssn` / `current_address` / `email` / `cell_phone` /
  `first_name`). DOB keeps its dedicated day-shift guard. Deliberate portal
  edits still flow — they arrive as scoped pushes of exactly that field
  (borrower profile edits now propagate `current_address` too).
- **Overwrite-storm alarm**: >10 rewrites of existing values in one push →
  loud audit (`push_overwrite_storm`).
- **Volume circuit breaker**: > `CLICKUP_MAX_FIELD_WRITES_10MIN` (default 300)
  field writes in a rolling 10 minutes → every further push throws and the
  opening is audited (`outbound_circuit_open`). Runaway loops stop hard.

**Mapper hygiene** (`src/clickup/mapper.js`): locations require finite,
non-null coordinates; whitespace-proof task-name builder; synthetic
placeholder borrowers still stripped (Jul 7 incident guard).

## 4. The duplicated-task lifecycle (owner-specified)

"Duplicate a task to start a new deal" is the team's documented workflow. The
sync now handles the full lifecycle:

1. The duplicate's **copied Portal-File-ID stamp is ignored** (stale-copy
   detection — it's bound to a different live task).
2. While the duplicate **still shows the source deal's address** (or none),
   creation **defers**: `match_status='duplicate_pending'`, visible in the
   Control Center manual-review queue. No same-address twin file, no old-deal
   data materialized mid-cleanup. (Deferral also applies when the borrower has
   any live-task file at the same normalized address.)
3. The officer cleans the task and updates the address → the webhook re-ingests
   → the new portal file is created **from the cleaned task**, linked to it.
4. The **`portal_stamp` scoped push re-stamps the task** with its own file's
   ID + deep link (no-op-suppressed when already correct; journaled). The boot
   reconcile pass enqueues the same heal portfolio-wide, so pre-existing stale
   stamps converge too.
5. A **genuine second deal at the same address** is unblocked deliberately:
   `POST /api/admin/clickup/manual-review/task/:taskId/force-create` (runs the
   normal ingest with the defer bypassed; every other guard still applies).
6. A duplicate that copied a **real YS loan number** stays `ambiguous` until
   the officer sets the new deal's number (loan numbers are globally unique).

### Follow-up hardening (post-merge audit)

- `fieldValueEquivalent` understands **location + users** values: an identical
  borrower address is a recognized no-op (no phantom PII-shield review rows on
  repushes), and an already-assigned officer is never re-added. Note:
  `acquisition_date` has NO inbound persistence path (the ingest `cols` never
  carry it), so the inbound year-guard loop deliberately covers only
  expected/actual closing — extend it if that pull is ever added.
- **Outage-class retries**: a `CLICKUP_CIRCUIT_OPEN` or `CLICKUP_PREREAD_FAILED`
  failure means ClickUp (or our own volume cap) is temporarily unavailable —
  those queue jobs retry every 10 minutes for up to ~7 hours instead of
  dead-lettering after ~4 minutes, so a breaker opening or a brief API outage
  can never permanently drop a user's edit.
- **Unlinked-file recovery** (`recoverUnlinkedFilesOnce`, boot one-shot after
  the reconcile pass): a file whose create-at-file-start failed transiently
  gets one bounded create retry (≤50 files/boot, 10-minute–30-day age window,
  portal-origin states only, outbound-gated) — restoring self-healing without
  weakening the scoped-pushes-never-create guard.

### DOB lockdown (2026-07-15 evening, after the restore-script rewrite)

The restore script's `garbage-year` and `portal-utc-midnight` branches could
rewrite a ClickUp DOB from the portal DB **without review** — which propagated
a wrong-profile DOB across all of one borrower's files (Shaindel Schwimmer,
journaled under `source='date_restore'`). Now locked down everywhere:

- **`mapper.isDobChange`** — ANY change to an existing DOB (any magnitude, not
  just ±1 day) blocks on EVERY automated outbound path (scoped, full repush,
  and both restore-script branches) and queues for review
  (`dob_change_blocked_pending_review` / `dob_restore_needs_review`); approval
  applies via the re-push bypass. Blank DOBs may still be filled.
- **`lib/fields.sanitizeDob`** — real calendar date AND adult plausibility
  (age 18–120) at every DOB entry point, inbound fill, and review proposal
  (a `12/11/2022` toddler DOB passed the plain 1900–2100 window).
- **DOB reviews dedupe per borrower** (one open row per borrower + proposal,
  not one per linked task).
- Damage enumeration for any restore run:
  `SELECT created_at, task_id, old_value, new_value FROM clickup_write_log
    WHERE source='date_restore' AND field_key='dob' ORDER BY created_at;`

### Auto-resolution + the full two-sided review (2026-07-15 evening, owner-directed)

"The system should know how to handle issues like this — and only when it
doesn't know, trigger the review."

- **`src/lib/sync-autoresolve.js` `decideDob()`** is the ONE decision function
  consulted by all three DOB-conflict sites (inbound heal, outbound push gate,
  restore script). Provable verdicts settle silently, applied to BOTH systems
  (`adoptDobEverywhere`: portal profile + every linked task, journaled
  `source='auto_resolve_*'`, audited `sync_dob_auto_resolve`):
  same-day/different-form (artifact pivots, convention offsets); an implausible
  value losing to a plausible adult DOB (the 12/11/2022 toddler class); a typed
  2-digit-year ClickUp artifact beating a portal value whose provenance is the
  sync itself (`borrowers.origin='clickup_backfill'` — the Shaindel class).
  Two plausible adult DOBs with human provenance = genuine ambiguity → review.
- **Two-sided review** (db/110): every row carries `clickup_value` AND
  `portal_value`; the reviewer sees "In ClickUp" vs "In PILOT" and adopts a
  winner — `POST /sync-reviews/:id/resolve {winner}` re-reads the winning side
  LIVE and applies it to **both systems** (dates, DOB, SSN — never stored in
  the queue, masked display only — and file status). Legacy approve/reject
  remain for unsupported field keys.
- **The loan officer owns the queue**: every new review row emails + in-app
  notifies the file's LO (borrower-level rows notify every LO across the
  borrower's active files) with a deep link to `/internal/sync-reviews`; the
  screen and resolve endpoints are already scoped so LOs resolve their own
  files' rows. `notified_at` prevents double-sends.

## 5. One way to read a typed date, system-wide

`lib/fields.sanitizeDateOnly` (real calendar date, 4-digit year 1900–2100) and
`lib/fields.normalizeTypedDate(v, kind)` (a typed 2-digit year RESOLVES to the
real year — closings/application/acquisition/track-record dates → 20xx, DOBs →
the century that makes an adult) are wired into **every** portal date entry
point: staff closing-date / details / complete-fields / co-borrower attach +
complete, borrower profile / application submit / complete-fields / co-borrower
fill / track-record rows (shared `trackRecordCols` covers staff too), and the
condition-engine info-condition answers. Inbound ClickUp dates keep the #233
behavior (year-guarded → review queue with pivoted proposals). Unresolvable
years (0203, 9999) are rejected, never guessed.

## 6. Invariants for future changes (audit checklist)

1. No ClickUp API call outside `src/clickup/client.js`; the three client guards
   must keep throwing (extend `scripts/test-clickup-write-guards.js` for any
   new write shape).
2. Outbound stays scoped enqueue-on-write; no dirty-sweep, ever (Jul 7).
3. Every new date write path: `normalizeTypedDate`/`sanitizeDateOnly` at entry,
   `dateOnlyToClickUpEpoch` at the push boundary — never hand-rolled epochs.
4. New borrower-identity fields: add to `PII_OVERWRITE_SHIELD` +
   `PII_REVIEW_KEY` + a `resolveOnly` key.
5. Keep the journal + review queue wired into any new push path.
6. Suites that must stay green on every sync change: `test-clickup-transforms`,
   `test-clickup-mapper`, `test-clickup-write-guards`, `test-clickup-delete-guard`,
   `test-checklist-sync`.
