# SharePoint Integration — Next-Level Roadmap

_Owner-requested (2026-07-16): "research integrations structured like this, our current
structure, and how we take it further — the standard guards and the standard enhancements
that make it a real high-level integration." This is the gap analysis and ranked roadmap.
Companion docs: `SHAREPOINT-POLICY.md` (binding rules), `SHAREPOINT-SYNC-HARDENING-RESEARCH.md`
(failure-mode → guard map), `SHAREPOINT-SYNC-FIELD-STUDY.md` (the real-tree study)._

Sources:
[Inbox/Outbox reliable event processing](https://theburningmonk.com/2026/05/inbox-outbox-patterns-for-reliable-event-processing/) ·
[Outbox/Inbox delivery guarantees](https://event-driven.io/en/outbox_inbox_patterns_and_delivery_guarantees_explained/) ·
[Dead Letter Channel (EIP)](https://www.enterpriseintegrationpatterns.com/patterns/messaging/DeadLetterChannel.html) ·
[Graph delta query overview](https://learn.microsoft.com/en-us/graph/delta-query-overview) ·
[Scan guidance: discovering files & detecting changes at scale](https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/scan-guidance?view=odsp-graph-online) ·
[Graph webhooks + delta best practices](https://www.voitanos.io/blog/microsoft-graph-webhook-delta-query/) ·
[driveItem delta](https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0) ·
[ShareGate/AvePoint pre-flight & validation reporting](https://www.techtarget.com/searchcontentmanagement/tip/SharePoint-migration-tools-to-consider) ·
[Audit-trail completeness for regulatory examinations](https://www.themortgageoffice.com/loan-management-audit-trails/) ·
[GLBA-compliant document management](https://start.docuware.com/blog/document-management/glba-compliance-software-secure-document-management) ·
[Uploading with metadata via Graph (two-step)](https://learn.microsoft.com/en-us/answers/questions/2046114/is-it-possible-to-insert-metadata-when-uploading-a)

## 1. Where we stand vs. the commercial state of the art

What the expensive tools (ShareGate/AvePoint-class movers, iManage/NetDocuments-class DMS
links) sell, and what we already have:

| Enterprise capability | Status here |
|---|---|
| Transactional outbox (DB row = intent; worker publishes; retry budget) | ✅ `documents` table + reconciler IS an outbox; attempts budget + boot/daily re-arm |
| Idempotency / exactly-once effect | ✅ adopt-on-conflict (clean + uniquified names), sha256 byte-dedup, `conflictBehavior:fail` |
| Post-transfer verification (size + hash) | ✅ verify-then-record on EVERY upload; QuickXorHash self-calibrating; sha256 kept portal-side |
| Recurring integrity audit + self-repair | ✅ boot + 6h sweep; "(fixed copy)" replacement; seven-guard sanctioned delete of the corrupt original |
| Dead-letter + human review with real errors | ✅ exhausted → Sync review card with the actual error; transient noise never pages; bulk re-arm endpoint |
| Throttling compliance (Retry-After, backoff, pacing) | ✅ everywhere, incl. chunk-loop date-form Retry-After and 416/nextExpectedRanges resume |
| Concurrency safety across instances | ✅ `sync_locks` leases (drain + verify) |
| Pre-flight name/path validation | ✅ filename sanitize (`safeFilename`), strict decode, **path-length budget (~400-char limit) added 2026-07-16** |
| Conservative entity matching + review of uncertainty | ✅ exact-first, DL≤1 typo fallback, single-candidate, always review-flagged |
| Chain-of-custody audit trail | ✅ `audit_log` rows for restores/deletes; per-doc integrity verdicts; write journal on the ClickUp side |

That is genuinely the reliability core the expensive products sell. The gaps below are what
separates "reliable mirror" from "platform-grade integration."

## 2. Ranked roadmap

### Tier 1 — high value, low risk
1. **R1 — Metadata ID stamping (rename/move-proof identity). ✅ BUILT (2026-07-16).** After
   each upload the mirror ensures four text columns exist on the library
   (`PilotDocumentId`/`PilotFileId`/`PilotBorrower`/`PilotSyncedAt`, created once + cached in
   `sharepoint.ensurePilotColumns`) and PATCHes them onto the driveItem's listItem fields
   (`sharepoint.stampItemFields`). Best-effort + gated (`SHAREPOINT_STAMP_METADATA`, default
   on) — a stamp failure NEVER affects the mirror; `documents.sharepoint_stamped_at` (db/120)
   tracks coverage. Matching can become id-based and immune to human rename/move; staff see
   provenance as columns. NEXT for this: an id-based re-locator in the verify pass (find our
   item by `PilotDocumentId` even after a move) — the columns now exist to support it.
2. **R2 — Delta-query drift healer (read-only).** Walk the drive's delta feed on a schedule
   (Microsoft's scan guidance: delta is THE at-scale change detector) to notice renames/moves/
   deletions of OUR items and folders within hours, self-heal `sharepoint_folder_cache` and
   `sharepoint_parent_id`, and queue item-missing reviews immediately instead of at the next
   30-day audit. Never writes back — pure observation + bookkeeping. (R1's columns make the
   healed item identifiable.)
3. **R3 — Reconciliation & coverage report (the "chain of custody" deliverable). ✅ BUILT
   (2026-07-16).** `backup.reconciliation()` classifies every document into exactly one bucket
   (mirrored / pending / exhausted / skipped / unverified / verified-ok / integrity-mismatch /
   source-suspect / malware / item-missing / local-missing), reports oldest-pending age and a
   `healthy` verdict, exposed at `GET /api/admin/sharepoint/reconciliation`. The auditable
   proof the mirror is whole — what AvePoint sells as compliance reporting.
4. **R4 — Backlog-age SLO alert. ✅ BUILT (2026-07-16).** `backup.checkBacklogSlo()` runs on
   the sweep cadence; if the oldest un-mirrored doc passes `SHAREPOINT_BACKLOG_SLO_HOURS`
   (default 6) or anything is exhausted, it notifies admins ONCE per breach episode (re-arms on
   recovery). Silent degradation becomes a signal.

### Tier 2 — medium
5. **R5 — Graph change notifications (webhooks) on the drive.** Push-model complement to R2
   (notification says "something changed", delta says what). Near-real-time detection of
   human deletions/moves. Needs a public notification endpoint + subscription auto-renewal
   (<30 days); delta remains the source of truth.
6. **R6 — Portal-side sync visibility.** "View in SharePoint" link + mirror-status badge
   (pending / mirrored / fixed / needs-review) on each document row in the staff file view
   (webUrl + integrity columns already exist). Field-study idea #6.
7. **R7 — Officer-folder pinning + resolution cache metadata.** Pin resolved officer folder
   ids on `staff_users` (rename-stable, one less listing per resolution); R1 makes the rest
   of the tree id-stable.
8. **R8 — Retention labels on mirrored records (GLBA posture).** Apply a SharePoint retention
   label to `Synced by Pilot` content so mirror copies are tamper-evident/undeletable by
   casual users — complements the portal-side immutable `audit_log`.

### Tier 3 — bigger bets (decide deliberately)
9. **R9 — Condition-folder alias dictionary** onto the firm's own vocabulary (`closing`,
   `title`, `credit` …) — needs the owner-approved word list (field-study #2).
10. **R10 — SharePoint Embedded / app-owned containers** for the mirror. Maximum isolation
    and metadata control, but it would take the tree OUT of the staff's Explorer workflow —
    the field study showed Explorer IS how staff live. Likely a no; recorded so it's a
    conscious decision.
11. **R11 — LLM-assisted long-tail folder linker** (review-gated proposals only) for the ~300
    human folders rule-based matching can't classify (field-study #12).

## 3. Explicit non-goals (owner policy)
- **No two-way byte sync** — documents flow portal → SharePoint only, forever.
- **No deletion** beyond the single seven-guard sanctioned replacement of a diagnosed-corrupt
  mirror copy.
- **No renames/moves of human content** — ever; healing is bookkeeping-side only.
