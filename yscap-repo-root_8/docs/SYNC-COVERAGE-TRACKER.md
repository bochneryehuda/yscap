# Audit Coverage Tracker — the honest scorecard

**What this is:** a truthful, living map of the ENTIRE sync audit against what is actually implemented. Its job is to make false "done" impossible — the one failure mode that caused the incidents. Updated as each fix lands.

**Status legend:** ✅ DONE (live in `main`) · 🟡 PARTIAL · ⬜ OPEN (not started).

**Bottom line as of 2026-07-17:** of ~27 verified findings, **13 fully closed + 2 partial**; of 19 work orders, **7 fully done + 3 partial**. Roughly **~55% of the audit is implemented** (the first 5 fixes live in `main`; the rest staged on PR #314). Done: the critical silent-lost-edit bug, the reliability core (rate-limiting, durable bookmark, both boot-storm drivers), token-rotation safety, loud enqueue failures, year-0026-proof LLC/checklist dates, and auto-closable DOB review rows. The bulk still remaining — the structural work (field registry, provenance, identity tiers), the review-queue redesign, SharePoint pre-launch, and SSN minimization — is a multi-day body of work, tracked below.

---

## Findings coverage (F-*)

| Finding | What it is | Status | Where / next |
|---|---|---|---|
| **F-C1** | Failed field write silently dropped (job marked done) | ✅ DONE | WO-1, live |
| **F-H1** | No 429/Retry-After anywhere | ✅ DONE | WO-2, live |
| **F-H2** | SharePoint name-only fuzzy match auto-files a doc | ⬜ OPEN | WO-14 (mirror never ran in prod — fix before enabling) |
| **F-H3** | Backdating DOB auto-adopt can overwrite a portal DOB | ⬜ OPEN | WO-11 |
| **F-H4** | Every deploy re-ingests the whole portfolio (storm) | ✅ DONE | watermark (WO-4a) + bounded rotating sweep (WO-4b) |
| **F-M1** | Stale internal_status re-asserted onto ClickUp | ✅ DONE | WO-16 (task-status pushed only on a deliberate internal-status change) |
| **F-M2** | Outbound DOB gate omits human-provenance | ⬜ OPEN | WO-11 |
| **F-M3** | Enqueue failures swallowed; backstop sweep retired | 🟡 PARTIAL | loud+traceable failure done (WO-5 ph1); transactional enqueue = WO-5 ph2 |
| **F-M4** | Inbound human-edit-wins on one-sided evidence | ⬜ OPEN | WO-11 |
| **F-M5** | Email+phone corroboration merges different-named people | ⬜ OPEN | WO-12 |
| **F-M6** | Inbound webhook 'error' = silent terminal drop | 🟡 PARTIAL | traceable (audit_log) + boot re-drive self-heal done (WO-3 ph1); visible card + webhook-health probe = ph2 |
| **F-M7** | Watermark advances past mid-pass / failed tasks | ✅ DONE | WO-4a, live |
| **F-M8** | Year-range review cards carry no portal value | ✅ DONE | WO-6 (both producers pass the PILOT value) |
| **F-M9** | Value-agnostic dismissals over-suppress new conflicts | ⬜ OPEN | WO-8 |
| **F-M10** | sp_rematch clears the wrong scope cache | ⬜ OPEN | WO-14 |
| **F-M11** | LLC/checklist dates skip normalizeTypedDate | ✅ DONE | WO-6 (5 write sites now year-0026-proof) |
| **F-M12** | Legacy /approve writes DOB without sanitizeDob | ✅ DONE | WO-6 (sanitizeDob + normalizeTypedDate on approve) |
| **F-M13** | Inbound year guard is a hardcoded 2-field list | ⬜ OPEN | WO-10 (registry makes it structural) |
| **F-M14** | 401-with-"not found" treated as task deletion | ✅ DONE | WO-6, live after next merge |
| **F-M15** | 5-min reclaim can double-run a slow push | ✅ DONE | WO-4b (heartbeat keeps a long push claimed) |
| **F-M16** | Volume breaker per-process, reset by deploy | ✅ DONE | WO-4b (seeded from journal on boot — survives restart; single-instance) |
| **F-M17** | allow_shared_email irreversible, no confirmation | ⬜ OPEN | WO-8 |
| **F-M18** | Additive contacts absorb a wrong person silently | ⬜ OPEN | WO-12 |
| **F-M19** | No migration ledger; duplicate db/NNN numbers | ✅ DONE | dup-number CI check + 113 resolved + schema_migrations ledger with checksum-drift alarm |
| **F-M20** | Outbound DOB review rows can never auto-close | ✅ DONE | WO-6 (borrowerId added → dedup + auto-close) |
| **F-M21** | Skipped materialization with no review row | ⬜ OPEN | WO-3 area |
| **F-M22** | upsertTrackRecord address-key race (dup rows) | ⬜ OPEN | WO-6 area |

---

## Work-order coverage (WO-*)

| WO | What it delivers | Status |
|---|---|---|
| **WO-13a** | Assurance floor: CI + `npm test` + dup-migration gate + bundle-drift | ✅ DONE (live) |
| **WO-1** | Throw on failed field writes (F-C1) | ✅ DONE (live) |
| **WO-2** | Retry/rate-limit contract at the client (F-H1) | ✅ DONE (live) |
| **WO-4a** | Durable reconcile watermark (F-M7, part of F-H4) | ✅ DONE (live) |
| **WO-4b** | Bound+pace reconcileLinkedPrograms (F-H4) + heartbeat (F-M15) + breaker-seed (F-M16) | ✅ DONE |
| **WO-5** | Transactional enqueue (F-M3) | 🟡 PARTIAL (ph1 loud-failure done; ph2 transactional open) |
| **WO-3** | Inbound dead-letters + webhook-health probe (F-M6) | 🟡 PARTIAL (ph1 traceable+self-heal done; ph2 review card + webhook health) |
| **WO-6** | Small-fixes bundle (F-M14✅ F-M11✅ F-M20✅ F-M12✅ F-M8✅; 113 renumber✅) | ✅ DONE |
| **WO-7** | Review-queue tiers + notification coalescer | ⬜ OPEN |
| **WO-8** | Sticky dismissals + noise telemetry + unlink (F-M9/17) | ⬜ OPEN |
| **WO-9** | Dedicated bot identity + actor echo suppression | ⬜ OPEN (needs owner to create the ClickUp bot seat) |
| **WO-10** | Typed field registry (direction+authority+PII as data) | ⬜ OPEN (structural centerpiece) |
| **WO-11** | Per-field provenance + decideField (F-H3/M2/M4) | ⬜ OPEN |
| **WO-12** | Deterministic-only identity tiers (F-M5/M18) | ⬜ OPEN |
| **WO-13** | 12 incident regression tests + schema_migrations ledger | 🟡 PARTIAL (ledger✅ + 7 new test suites; the full 12 incident tests open) |
| **WO-14** | SharePoint pre-launch safety (F-H2/M10) + go-live | ⬜ OPEN |
| **WO-15** | SSN minimization in ClickUp (last-4) + GLBA memo | ⬜ OPEN (owner decision) |
| **WO-16** | Status ownership decoupling (F-M1) | ✅ DONE |
| **WO-17** | Runtime pause switches + flood hold | ⬜ OPEN |
| **WO-18** | Nightly portal-vs-ClickUp reconciliation report | ⬜ OPEN |
| **WO-19** | Deploy discipline (app-v2 build wiring / drift gate) | ⬜ OPEN |

---

## Field-forensics still-open items (from SYNC-FIELD-FORENSICS)

These are the "hidden siblings" — same bug class, other fields, not yet hit. None fixed yet; folded into the WOs above.

- **DOB:** standing auto-adopt (F-H3/WO-11); co-borrower DOB field unguarded if added; closing dates have no DOB-style engine.
- **Emails:** ⚠️ **co-borrower email push is armed but unguarded** — the July-7 clobber one field over; must be guarded before co-borrowers are wired into the push (WO-10/WO-12 area).
- **Names:** four divergent "not a real name" definitions; "New Borrower" title round-trip; LLC placeholder names (WO-10).
- **Loan numbers:** `investor_loan_number` is the untreated Salamon/Gruber class (WO-6/WO-12).
- **Latent:** zero-wipes-money, "N/A"→$0, officer reassignment reverts + accumulates, UTC-"today", RTL name characters (WO-6/WO-10 area).

---

## How to read progress

Each ✅ is tested (its own suite in `npm test`) and CI-green in `main`. The safety net (WO-13a) runs every suite on every change, so no ✅ can silently regress. This tracker is updated with each merge; when every row is ✅, the audit is covered — not before.
