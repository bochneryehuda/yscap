# Full system logging — what exists, what is measured missing, and what is the owner's to decide

Owner-directed 2026-08-26: *"we need to work on a better log. Everything should be logged in
the system… Set up the entire system with a full log… Do research exactly how to set this up."*

This is the research half. Every number below was **measured against the live schema and the
live table**, not estimated. Where a decision is a business or compliance rule it is named as
an owner question rather than guessed at — the standing hard rule in `CLAUDE.md`.

---

## 1. What is already built, and it is more than it looks

### 1.1 `request_audit_log` — one row per HTTP request, automatically

`src/lib/request-audit.js`, mounted once in `src/server.js`. **No per-handler wiring**, so a
route written next year is covered knowing none of this exists.

`shouldLog()` logs **everything under `/api` and `/auth` unconditionally**, plus webhooks,
email link/open pixels and SPA shell requests. The ONLY thing skipped is a static asset by
file suffix (css/js/png/font/…), because those arrive by the thousand per page load and would
drown the rows that matter.

Each row carries: time, request id (echoed to the browser as `X-Request-Id`, so a support
ticket — *"it failed at 3:14"* — resolves to one row in one step), actor kind / id / email /
role, **the impersonator** when a staffer is inside somebody's portal, method, path, matched
route, query with secrets redacted, status, duration, client IP, user agent, referer, the
entity it touched, bytes out, and — since the 2026-08-16 work — **the real reason behind a
"server error"**.

Writes are buffered and flushed on a timer, so logging can never slow a request, and a
database blip drops rows rather than breaking a live call.

**So "is every action logged?" is already YES at the HTTP level.**

### 1.2 `audit_log` — the business-language trail

The semantic log: *"viewed SSN"*, *"granted an exception"*, *"overrode a condition"*. **481
call sites.** Read on the **System log** screen (`StaffAuditLog.jsx`, `view_audit_log`) with
free text, category, action, actor kind, actor and a date range, each row linked to its file.

### 1.3 The specialised journals

Per-integration write journals — `clickup_write_log`, `amc_write_log`, `sitewire_write_log`,
`trinity_*`, `docusign_event_inbox`, `research_imports` — plus roughly fifteen `*_events`
tables (draw stages, document lifecycle, AMC status, DocLab requests, AI cost). Every outbound
write to a third-party system is journaled before and after.

### 1.4 The per-file trail

`src/lib/activity.js` TRAILS assembles a readable per-file history — conditions, documents,
draws, closing milestones, policy exceptions, escalations — from those tables.

---

## 2. What was measured broken, and is now fixed

**The log's own search could not find a file** (fixed 2026-08-26, this pass). The System log
matched a property address against `property_address::text` — that renders the STORAGE, not
the address — and it was wrong in both directions. Measured across **547 files**:

| Typed into the System log | Before | After |
|---|---|---|
| `9 Oak St, Lakewood` (a real address, written the way a person writes one) | **0 files** | 2 files |
| `state` (a JSON key name) | **280 of 547** | 0 |
| `oneLine` (a JSON key name) | **137** | 0 |
| a borrower's whole name | **0** | 1 |
| a YS loan number | not searchable | found |

The raw JSON reads `{"line1":"9 Oak St","city":"Lakewood"}`, so the `","city":"` sitting
between the street and the city can never match the comma-space somebody types; and the key
names are in every row, so typing one returns half the pipeline.

**A log you cannot search is a log nobody reads**, which is why this belongs to the logging
ask rather than to a tidy-up. It now goes through `src/lib/file-search.js`, the one definition
the approvals queues and the global omnibox also use.

---

## 3. The two real gaps, measured

### 3.1 About half of the write routes have no business-language entry

Counted across `src/routes/**`:

| | count |
|---|---|
| write routes (POST / PATCH / PUT / DELETE) | **682** |
| carrying a semantic `audit(...)` call | **331 (49%)** |
| carrying none | **351 (51%)** |

Concentrated in `sitewire.js` (61), `staff.js` (41), `borrower.js` (31), `underwriting.js`
(22), `staff-notif-center.js` (18), `tpo.js` (17).

**State this carefully: those 351 are NOT unlogged.** Every one of them writes a
`request_audit_log` row with the actor, the path, the status and the entity. What they lack is
the business sentence a person can read on the file's own trail — *"Chaya changed the note
buyer on this file"* rather than `PATCH /api/staff/applications/…/complete-fields → 200`.

**The structural answer is NOT to add 351 audit calls.** A hand-kept list of routes-that-log
is exactly the shape that goes stale on route 683, and the automatic layer already covers
every one of them. What is worth doing is naming the actions a HUMAN needs to read on a file,
and covering those — which is a judgement about what matters, not a sweep.

### 3.2 Nothing is ever deleted, and that is an outage waiting to happen

`db/252` says so in as many words: *"Retention is a policy decision (not enforced here yet)."*
Neither table is pruned by anything.

`request_audit_log` takes a row for **every** `/api` call — including the health probe that
runs on a timer. On Render the database disk is a fixed size, and a **full disk takes the
whole application down**, not just the log.

**How long a lender must keep a GLBA PII access trail is a compliance rule.** It is not mine
to guess, and guessing short is unrecoverable — the rows are gone. See the question below.

---

## 4. What is the owner's to decide

1. **How long do we keep the two logs?** A common split is: the per-request HTTP log for
   **90 days** (it is the troubleshooting layer, and it is the one that grows fastest), and
   the business-action log — who viewed an SSN, who granted an exception — for **7 years**,
   the ordinary lending record-retention horizon. Both numbers need the owner's word, and the
   two can differ. Until then nothing is deleted, which is the safe direction but not a
   permanent one.

2. **Which actions should read in plain English on a file's own trail?** Rather than sweeping
   all 351, the useful question is: which of them would somebody want to see when they open a
   file and ask *"who changed this, and when?"* That list is a business judgement and short.
