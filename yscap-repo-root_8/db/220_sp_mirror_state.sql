-- SharePoint mirror — explicit per-document state machine (Phase 1, 2026-07-21).
--
-- Owner-directed "$1,000,000 buildup": replace the implicit boolean queue
-- (sharepoint_backed_up_at IS NULL, reconstructed differently by the work
-- selectors and the alert queries — the root of every recurring "(not yet
-- attempted)" false alarm) with ONE explicit status column that the worker
-- itself writes at claim time, before any Graph call. See
-- docs/SHAREPOINT-MIRROR-QUEUE-DESIGN.md.
--
-- This migration is ADDITIVE ONLY (expand phase). It adds the state-machine
-- columns alongside the existing sharepoint_* columns, derives an initial
-- status from those existing columns (idempotent backfill), and indexes the
-- claim hot-path. NOTHING reads these columns yet — the FSM worker ships behind
-- SHAREPOINT_MIRROR_FSM (default off) in a later phase, so this file changes no
-- runtime behavior. It is safe to re-run on every boot (migrate-boot replays
-- every file): all DDL is IF NOT EXISTS / guarded, and the backfill only touches
-- rows whose status is still NULL (freshly-inserted docs between boots — a small
-- set — plus, on the very first run, all pre-existing rows).
--
-- Columns are nullable (metadata-only add, no table rewrite, no long lock).
-- sharepoint_permanent_strikes has a CONSTANT default 0, also metadata-only on
-- PG11+. NOT NULL on the status column is deliberately deferred to the contract
-- phase (CHECK ... NOT VALID -> VALIDATE -> SET NOT NULL) so it never takes an
-- ACCESS EXCLUSIVE full-heap scan here.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS sharepoint_mirror_status     text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sharepoint_lease_expires_at  timestamptz;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sharepoint_locked_by         text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sharepoint_next_attempt_at   timestamptz;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sharepoint_dead_reason       text;
-- Persisted "consecutive PERMANENT/AUTH confirmations" counter — the state
-- library's decideAfterAttempt reads it back to enforce the 2-confirmation
-- fluke-protection rule (a hard maxAttempts backstop in the library guarantees
-- termination even if this is ever lost).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sharepoint_permanent_strikes int NOT NULL DEFAULT 0;

-- Guard the status domain so a stray write can never introduce an unknown state.
-- Added NOT VALID (instant, no scan under ACCESS EXCLUSIVE) and validated in a
-- separate guarded step (SHARE UPDATE EXCLUSIVE — does not block reads/writes),
-- so even a huge table wouldn't stall here. Both halves are idempotent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_sp_mirror_status_chk') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_sp_mirror_status_chk
      CHECK (sharepoint_mirror_status IS NULL OR sharepoint_mirror_status IN
             ('PENDING','IN_PROGRESS','DONE','FAILED','DEAD','SKIPPED')) NOT VALID;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conname = 'documents_sp_mirror_status_chk' AND convalidated = false) THEN
    ALTER TABLE documents VALIDATE CONSTRAINT documents_sp_mirror_status_chk;
  END IF;
END$$;

-- Idempotent backfill: derive the explicit status from the columns that already
-- encode it implicitly today. Only rows still NULL are touched, so it never
-- fights the live worker and only re-derives docs inserted since the last boot.
--   backed_up_at set        -> DONE
--   skipped_reason set      -> SKIPPED   (never-mirror / superseded-regen settle)
--   attempts >= cap (8)     -> DEAD      (retry-exhausted; the old invisible backlog)
--   attempts > 0            -> FAILED    (was retrying)
--   else                    -> PENDING   (fresh / never attempted)
-- The literal 8 mirrors DEFAULTS.maxAttempts in src/lib/sp-mirror-state.js and the
-- JS deriveStatus() twin; keep them in sync (both are the historical MAX_ATTEMPTS).
UPDATE documents
SET sharepoint_mirror_status = CASE
      WHEN sharepoint_backed_up_at   IS NOT NULL THEN 'DONE'
      WHEN sharepoint_skipped_reason IS NOT NULL THEN 'SKIPPED'
      WHEN COALESCE(sharepoint_backup_attempts, 0) >= 8 THEN 'DEAD'
      WHEN COALESCE(sharepoint_backup_attempts, 0) > 0  THEN 'FAILED'
      ELSE 'PENDING'
    END,
    sharepoint_dead_reason = CASE
      WHEN sharepoint_backed_up_at IS NULL
       AND sharepoint_skipped_reason IS NULL
       AND COALESCE(sharepoint_backup_attempts, 0) >= 8 THEN 'transient_exhausted'
    END
WHERE sharepoint_mirror_status IS NULL;

-- Claim hot-path index: partial (covers ONLY claimable/active rows, so it stays
-- small as DONE grows unbounded) and keyed on the SAME expression the claim query
-- orders by — COALESCE(next_attempt_at, created_at) — so the planner walks it and
-- stops at LIMIT without a Sort node. (A bare next_attempt_at column index would
-- NOT satisfy that ORDER BY, since backfilled rows leave next_attempt_at NULL and
-- fall back to created_at.) Terminal rows (DONE/DEAD/SKIPPED) are excluded.
-- Plain IF NOT EXISTS, not CONCURRENTLY: this repo replays each migration file in
-- one implicit transaction on every boot, where CONCURRENTLY is illegal, and the
-- documents table is portal-scale (a brief SHARE-lock build is fine). At millions
-- of rows this would be built CONCURRENTLY out-of-band instead.
CREATE INDEX IF NOT EXISTS ix_documents_sp_claim
  ON documents ((COALESCE(sharepoint_next_attempt_at, created_at)), id)
  WHERE sharepoint_mirror_status IN ('PENDING','FAILED','IN_PROGRESS');

-- Dead-letter / stuck-lease observability index (Phase 3 alerting reads these).
CREATE INDEX IF NOT EXISTS ix_documents_sp_terminal
  ON documents (sharepoint_mirror_status, sharepoint_lease_expires_at)
  WHERE sharepoint_mirror_status IN ('DEAD','IN_PROGRESS');
