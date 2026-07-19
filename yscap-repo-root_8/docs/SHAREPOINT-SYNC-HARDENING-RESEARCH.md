# SharePoint Sync — Hardening Research & Guard Map

_Owner-requested (2026-07-16): "research industry standards, how an integration like this
usually works, put the correct guards in place… none of the past errors should happen again,
and research what other errors can happen and how we protect against them." This document is
the guard map: every known failure mode of a portal→SharePoint document mirror, what the
industry guidance says, and exactly which guard in THIS codebase covers it. Companion to
`docs/SHAREPOINT-POLICY.md` (binding policy) and the CLAUDE.md integrity rules._

Sources: [Microsoft Graph throttling guidance](https://learn.microsoft.com/en-us/graph/throttling),
[driveItem createUploadSession](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0),
[Upload large files (Graph SDKs)](https://learn.microsoft.com/en-us/graph/sdks/large-file-upload),
[QuickXorHash file integrity](https://mgwdevcom.wordpress.com/2025/06/09/verifying-sharepoint-file-integrity-with-quickxorhash-in-powershell/),
[QuickXor caveats](https://pinpointlabs.com/the-m365-quirk-unraveling-the-mystery-of-quickxor/),
[hashing consistency across OneDrive/SharePoint](https://github.com/OneDrive/onedrive-api-docs/issues/501),
[SharePoint duplicate-file behaviors](https://techcommunity.microsoft.com/discussions/sharepoint_general/sharepoint-files-duplicating-with-computer-name-suffix/4078973).

## A. Failure modes that ALREADY HAPPENED here — root cause → structural fix

| # | What happened | Root cause | Structural fix (all live in code) |
|---|---|---|---|
| A1 | "Most files corrupted, won't open" | Node's base64 decoder silently skips invalid chars — a `data:`-URL prefix shifts alignment and garbles EVERY byte at ingest; the mirror then faithfully uploads garbage | ONE strict decode chokepoint (`lib/upload-bytes.decodeUploadBase64`) at all 10 upload endpoints: strips/normalizes/REJECTS — garbling is structurally impossible. Magic-byte sniff in the audit flags historical garbage for human re-upload (`source-suspect`). |
| A2 | "Version 47" folders | Track-record tool autosaves a full snapshot every ~2.5s; each superseded the last; the mirror minted a Version folder per autosave (prod evidence: Versions 30→39 seconds apart) | Same-session autosaves coalesce onto ONE row; superseded-before-mirror snapshots settle without uploading (and auto-close their review cards); regen kinds (`track_record_html`, `*_export`, `tpr_export`) never version-shuffle. Human documents keep the owner's Version-N history. |
| A3 | "Failed after every retry — permission failure" review queue (all SOW .xlsx) | Upload SUCCEEDED but the DB record write failed; every retry then name-conflicted, uniquified, conflicted again → `name conflict persisted after uniquification` → budget exhausted. The card never showed the real error, so staff read the generic "usually permissions" hint | Adopt-on-conflict (clean AND uniquified names): an identical already-uploaded item (size+hash) is ADOPTED, never re-uploaded. Cards show the actual "Last error". Boot/daily resets re-drive; successes and settles auto-close cards; `POST /api/admin/sharepoint/retry-exhausted` re-arms the whole queue in one click. |
| A4 | Corrupt mirror copies stayed next to the fixed ones | Absolute no-delete policy | Owner amendment 2026-07-16: THE ONE SANCTIONED DELETE (`sharepoint.deleteReplacedCorruptMirror`) — a DIAGNOSED-corrupt mirror copy may be deleted only after its verified "(fixed copy)" is uploaded and re-verified live, only inside a Pilot-created sync tree, behind seven guards (kill switch, DB ownership, replacement-first, same-bytes-as-diagnosed, expected parent, Pilot-leaf ancestry, If-Match). Everything else remains no-delete. |
| A5 | "SLO email fired but the review queue was EMPTY and the error was uninterpretable" (owner-reported 2026-07-17) | The #300 transient-error suppression (correctly silencing brief network blips) had no ceiling — a doc failing on a *transient-looking* error (503/timeout/network) for 31.8h exhausted SILENTLY forever, never creating a card; and the R4 SLO alert named neither the document nor its error. A day-long "transient" error is not transient — it's stuck, and it was invisible. | `stuckDocuments()` lists every past-SLO doc WITH identity + real error + plain diagnosis; `escalateStuckDocs()` (run by the SLO watchdog + on demand) SELF-HEALS phantom superseded snapshots and forces a REVIEW CARD for anything else stuck past `SHAREPOINT_STUCK_ESCALATE_HOURS` (default max(12, 2×SLO)) **regardless of error class**; the SLO email now NAMES the stuck documents; `GET /reconciliation` returns the `stuck` list; `POST /escalate-stuck` runs it on demand. The blind spot is closed: nothing stays invisible past the escalation window. |
| A6 | "WHY does a document get stuck at all — fix the root so it can't" (owner-directed 2026-07-17) | The deeper root behind A5: the mirror retried EVERY failure blindly 8× and re-armed it daily — treating a PERMANENT failure (one that retrying can never fix) exactly like a network blip. A doomed upload (no borrower to file under, a missing local file, an auth/permission problem, a persistent name conflict) churned invisibly for days instead of asking a human. | `classifyMirrorError()` routes every failure: **permanent** → a REVIEW CARD after just 2 attempts (minutes, not days) with the SPECIFIC plain-language cause, then PARK the doc (`[permanent]` marker) so the daily reset stops re-driving a doomed upload — only the card's Retry (after the human fixes the cause) re-arms it; **throttle**/**transient** → keep retrying with the escalation ceiling. Boot/deploy reset still re-tries permanent docs once (a deploy may have fixed the cause); the daily (time-only) reset does not. Result: a stuck doc surfaces in minutes with exactly what to do, and permanent failures stop churning entirely. |

## B. Microsoft-documented failure modes — guidance → our guard

1. **Throttling (429/503 + Retry-After).** Guidance: honor Retry-After exactly; exponential
   backoff otherwise. → `graph()` honors Retry-After with backoff+jitter; the chunk loop
   parses Retry-After defensively (an HTTP-date can never become `sleep(NaN)`); pacing between
   uploads; an outbound volume ceiling exists on the ClickUp side and the mirror is single-flight.
2. **Upload sessions: fragments must be 320 KiB multiples; sessions expire; 404 = start over;
   `nextExpectedRanges` is the resume truth.** → chunk size 5 MiB (16×320 KiB); 416 answers a
   session-status query and resumes at `nextExpectedRanges[0]`; a dead session throws and the
   document retries from scratch through the normal budget.
3. **Conflict on the final byte range / ambiguous outcomes (lost responses, 504s).** → every
   commit is size-verified (`verifySize` — missing id/size = failed, never recorded);
   adopt-on-conflict absorbs the upload-succeeded-but-unrecorded retry; a result that cannot
   be verified is never recorded as a document's mirror.
4. **Integrity: SharePoint exposes `quickXorHash` per item.** Guidance: use it to validate
   transfers; caveat — it is non-cryptographic. → we compute it locally (validated against an
   independent spec implementation), self-calibrate against Graph on fresh uploads (one failed
   calibration ⇒ size-only forever, never mass-flags), keep a local **sha256** as the
   authoritative portal-side fingerprint, and treat SIZE as always-authoritative.
5. **Office "property promotion": SharePoint REWRITES docx/xlsx after upload — size/hash drift
   that is NOT corruption.** → the audit's modified-after-upload guard: any mismatch on an item
   whose `lastModifiedDateTime` is later than our upload is recorded (`modified-in-sharepoint`)
   but NEVER auto-replaced — no "(fixed copy)" churn, no fighting SharePoint or human edits.
6. **Eventual consistency of search/addressing.** → the mirror never uses the search index for
   correctness; folder resolution reads live children listings; caches self-heal on 404 with a
   single re-resolution.

## B2. Platform limits & security behaviors (research round 3, 2026-07-16)

Sources: [SharePoint Online limits](https://learn.microsoft.com/en-us/office365/servicedescriptions/sharepoint-online-service-description/sharepoint-online-limits),
[built-in virus protection](https://learn.microsoft.com/en-us/defender-office-365/anti-malware-protection-for-spo-odfb-teams-about),
[SharePoint data deletion / recycle bin](https://learn.microsoft.com/en-us/sharepoint/sharepoint-data-deletion),
[JSON batching](https://learn.microsoft.com/en-us/graph/json-batching).

1. **400-character decoded path limit** → guarded: the mirror computes a path budget and trims
   the FILENAME to fit (extension preserved). Deep officer/borrower/address chains can never
   strand a document again.
2. **Malware scanning is asynchronous** — Microsoft Defender flags an infected upload AFTER it
   lands and BLOCKS it from opening (staff read that as "corrupted, won't open"). → the
   integrity audit now reads the `malware` facet: flagged mirrors get a distinct verdict + a
   review card that says to check the SOURCE file — never a blind re-upload (an infected
   source would just get re-flagged).
3. **Deletes are SOFT for 93 days** — the ONE sanctioned delete sends the corrupt copy to the
   site Recycle Bin, restorable by staff for 93 days (and Microsoft can restore beyond that).
   The exception is therefore recoverable by design.
4. **Credential lifecycle** — an expired certificate/secret kills the integration silently. →
   the admin health probe now reports the certificate's expiry date and days remaining, with
   an explicit warning under 30 days (dual cert+secret auth already gives one-credential
   failover).
5. **Graph `request-id`** — every Graph error we record now carries Microsoft's request-id, the
   correlation key their support needs to trace a failure server-side.
6. **Other hard limits, noted for awareness**: 250 GB max file (uploads are capped far below
   by `MAX_UPLOAD_MB`); ~5,000-item list-view threshold per view (our per-condition folders
   hold few files — safe by construction); OneDrive sync client degrades past ~300k files per
   synced scope (staff Explorer experience — monitor library growth); 50,000 major versions
   per document (irrelevant: we never overwrite, so SharePoint versioning barely engages).
7. **JSON batching ($batch, 20 requests/call)** — the verify sweep's metadata reads could be
   batched 20-at-a-time for ~20× fewer HTTP calls (each inner request still throttles
   individually). Roadmap item in `SHAREPOINT-INTEGRATION-NEXT-LEVEL.md`.

## C. Environment-level behaviors (not bugs in our sync — staff should know)

- **OneDrive Explorer sync duplicates** ("filename-COMPUTERNAME.pdf", conflict copies of PDFs
  edited by two people): created by Microsoft's sync client on staff machines, not by Pilot.
  Our matcher never matches them (names differ) and never deletes them (only the ONE sanctioned
  delete exists). If they clutter a folder, they are human files to clean by hand.
- **Files locked/checked out in SharePoint** (423): the upload retries through the budget; a
  real block surfaces on the review card with the actual error text.
- **The `.html` snapshot files** ("Track Record Saved Copy") are living deep-links back into
  the portal builder — opening one outside the portal shows a redirect page, which can read as
  "broken" in Explorer. That is by design; the live data is in PILOT.

## D. Cross-cutting guards that make the whole class un-repeatable

- **Verify-then-record**: nothing is ever recorded as mirrored without a live size (and, when
  trusted, hash) match — at upload time AND on the recurring integrity audit (boot + 6h).
- **No fake review cards**: exhaustion on TRANSIENT infra errors (429/503/timeouts/network)
  never queues a review card — resets keep retrying silently; the admin health screen counts
  the backlog. Only human-actionable errors page humans, and every card shows the real error.
- **Cross-process leases** (`sync_locks`): deploy overlap / scale-out cannot double-drain.
- **Byte dedup + adoption**: identical bytes never upload twice into one scope; healthy-only
  dedup targets (a corrupt-flagged sibling can never lend its URL).
- **Conservative matching**: exact rules first; typo tolerance is Damerau-Levenshtein ≤ 1 per
  token, single-candidate, house-number-anchored, and ALWAYS review-flagged; ambiguity always
  creates a fresh marked folder instead of guessing; every uncertain match surfaces in Sync
  review with a Re-match action.
- **Kill switches**: `SHAREPOINT_BACKUP_ENABLED`, `SHAREPOINT_DELETE_REPLACED_CORRUPT`,
  settle/verify cadence env knobs — every risky behavior can be turned off without a deploy.
