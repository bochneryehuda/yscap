# Observability & the audit/event log (#147)

This is the map of **everything the PILOT backend records about what happened** —
who did what, when, and across which system (the portal, ClickUp, SharePoint,
email). Every stream below is already journaled with a timestamp; this doc says
what each one captures, where it lives, how to read it, and how they compose into
one picture of a file's life.

The design principle: **no cross-system action goes dark.** A field write, a sync
decision, a mirror upload, a blocked guardrail — each leaves a durable, queryable
row. When something looks wrong ("the DOB changed", "the loan number is off",
"the doc didn't sync"), there is always a record that explains it.

---

## The unified per-file timeline (start here)

`GET /api/staff/applications/:id/observability` merges every stream below into ONE
time-ordered feed for a single file — the fastest way to answer "what happened to
this file?". It is scoped by the file's own access (the `/applications/:id`
middleware), so a file's team sees its own history and nothing new is exposed.
Read-only; never emits a raw SSN/card (values are masked upstream; the feed
surfaces field KEYS and outcomes).

- Optional `?sources=portal,clickup,sync,sharepoint` narrows the streams.
- Optional `?limit=` (1–500, default 250).
- Response: `{ applicationId, counts:{portal,clickup,sync,sharepoint,total}, events:[…] }`
  where each event is `{ ts, source, category, actor, action, summary, detail }`.
- Frontend: `api.staffObservability(id, { sources })`.

The company-wide compliance trail (all files, all actors) remains at
`GET /api/staff/audit-log` (+ `/audit-log/facets`), gated on the `view_audit_log`
capability — that's the global oversight view; the per-file timeline is the local
one.

---

## The streams

### 1. Portal audit trail — `audit_log` (`db/schema.sql`)
Every meaningful portal action: sign-ins, SSN views, document uploads/downloads,
condition sign-offs, application edits, assignments, admin changes, PII access.
Columns: `actor_kind` (staff/borrower/system), `actor_id`, `action` (a stable
code — see `src/lib/audit-actions.js` for the code→label→category map), `entity_type`/
`entity_id`, `ip_address`, `user_agent`, `detail` (jsonb), `created_at`. Written
through the `audit(req, action, entityType, entityId, detail)` helper in
`src/routes/staff.js` and equivalents elsewhere. SSNs/cards are redacted from any
`detail`/`raw_intake` before it lands (`src/lib/redact.js`).

### 2. Outbound ClickUp writes — `clickup_write_log` (`db/107`)
Every field PILOT writes (or *tries* to write) to a ClickUp task: `task_id`,
`field_id`/`field_key`, `old_value`, `new_value`, `changed` (did it actually
change?), `blocked` (did a guardrail refuse it?), `source` (`create` /
`scoped_push` / `full_repush`). No-op-suppressed and guard-blocked writes are BOTH
recorded, so a refused DOB shift or a clobber-shield block is visible, not silent.
SSN/card values are masked in `old_value`/`new_value`. Guardrails live in
`src/clickup/client.js` (`guardNoFieldClearing`, `guardTaskUpdatePayload`, the
volume circuit breaker) — see `docs/CLICKUP-DATA-SAFETY.md`.

### 3. Inbound ClickUp changes — `clickup_pull_field_change` audit action
When ClickUp changes a field and PILOT ingests it, the change is audited (action
`clickup_pull_field_change`) so the inbound side of the sync has the same history
as the outbound side. See `docs/CLICKUP-DATE-INCIDENT.md` for why this must never
go dark (the DOB off-by-a-day incident).

### 4. Sync review queue — `sync_review_queue` (`db/108`, `110`, `112`)
The human gate for suspicious cross-system changes: an automated ±1-day DOB move,
an inbound out-of-range/2-digit year, an inbound value that disagrees with the
portal, a PII overwrite, a stuck/ambiguous file. Nothing suspicious is ever
silently applied or dropped — it parks here with BOTH sides' values
(`clickup_value`, `portal_value`), a `reason`, a `direction`, and a `status`;
resolution records the `winner` and `resolved_by`/`resolved_at`. `auto_resolved`
marks the provable verdicts the resolver settled without a human. UI:
`/internal/sync-reviews`. Producers/resolvers: `src/lib/sync-review.js`,
`src/lib/sync-file-review.js`, `src/lib/sync-autoresolve.js`.

### 5. SharePoint mirror lifecycle — `documents.sharepoint_*` (`db/092`, `db/115`)
Per document: `sharepoint_backed_up_at` (mirrored), `sharepoint_verified_at` +
`sharepoint_integrity` (the corrupted-mirror audit's verdict), `sharepoint_skipped_reason`
(deliberately not uploaded — superseded snapshot, duplicate bytes),
`sharepoint_backup_error` (a real failure), `sharepoint_item_size`/`sha256`
(integrity trail), `sharepoint_web_url`. The one-way, never-delete mirror and its
integrity audit are described in `docs/SHAREPOINT-POLICY.md` and
`docs/SHAREPOINT-INTEGRATION-RESEARCH.md`. The verify audit + its state live in
`src/lib/sharepoint-backup.js`.

### 6. Status history — `status_history` (`db/027`)
Every loan-status transition with a timestamp (drives the vertical stepper).

### 7. Notifications & email — `notifications` + the per-file email inbox (#68/#80)
Every in-app notification and branded email is a row (`notifications`); the per-file
email inbox (`inbound_file_emails`, `db/116`/`117`) records inbound replies and
their forward/attribution. So "was the borrower emailed, did they reply, did it
reach the team" is answerable.

---

## How they compose

To reconstruct a file's full history you rarely need more than the per-file
timeline endpoint above — it already fans across streams 1, 2, 4 and 5 (and the
portal trail in 1 includes the inbound ClickUp changes of 3). For deeper drills:

- **"Why did this field change?"** → `clickup_write_log` (outbound) + the
  `clickup_pull_field_change` audit rows (inbound) + any `sync_review_queue` row
  for that field.
- **"Did this document sync?"** → the document's `sharepoint_*` stamps (stream 5),
  and if it errored/skipped, the reason is on the row.
- **"Who viewed this borrower's SSN?"** → `audit_log` filtered to the `view_ssn`
  action for the borrower's entity (compliance view, `view_audit_log`).
- **"What's stuck?"** → open `sync_review_queue` rows (each carries a concrete
  resolution action).

## Retention & privacy

All streams are append-only and keep timestamps indefinitely (compliance trail).
No stream stores an unmasked SSN or card number — those are redacted at write time
(`src/lib/redact.js`) and masked in the ClickUp journal and sync queue. The
per-file timeline endpoint surfaces field KEYS and outcomes, never full values.
Access to the global `audit-log` is gated on the `view_audit_log` capability; the
per-file timeline inherits the file's own access scope.

## Tests

- `scripts/test-observability-timeline.js` — seeds one event in each stream and
  asserts the per-file timeline merges and time-orders them, and that the file's
  scope gates access.
