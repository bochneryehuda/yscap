-- ============================================================================
-- 319_on_hold_is_on_hold.sql
--
-- Owner-directed 2026-07-26: a ClickUp file sitting in "inactive / on hold" was
-- showing in PILOT with the borrower-facing status FILE INTAKE. File intake is
-- the FIRST stage (a brand-new prospect); "on hold" is a PAUSE and must be its
-- own status — off the active board, out of the task/reminder lists, and with
-- the borrower-facing notification emails silenced.
--
-- The mapping itself already existed (src/clickup/status.js `'inactive / on
-- hold' -> on_hold`), but it is only applied WHEN A TASK IS RE-INGESTED. A file
-- that entered PILOT while the card was "starting" (→ file_intake) and was later
-- parked in ClickUp keeps the stale intake status until its next inbound pull —
-- which for a parked file may be never, because nobody touches a held card and
-- the reconcile poll is windowed on `date_updated`. So the previous files stay
-- wrong forever unless they are healed here.
--
-- This migration re-asserts the invariant on EVERY boot:
--   the ClickUp status IS the internal status, and an internal status that
--   means "on hold" MUST show the borrower-facing status on_hold.
-- It is safe to re-run and self-healing: staff moving a held file forward in
-- PILOT changes `internal_status` too (applyInternalStatus writes both), so this
-- can never fight a deliberate human move.
--
-- `status_notified_external` is stamped alongside so the correction is SILENT —
-- healing months of history must not fire a "your loan is now on hold" email to
-- every one of those borrowers.
-- ============================================================================

UPDATE applications
   SET status = 'on_hold',
       status_notified_external = 'on_hold',
       status_changed_at = COALESCE(status_changed_at, now()),
       updated_at = now()
 WHERE deleted_at IS NULL
   AND status <> 'on_hold'
   -- The exact live ClickUp status, plus the same keyword rule the runtime
   -- fallback uses (statusMap.fallbackExternal: anything containing "hold"),
   -- so a renamed/added hold status is healed without another migration.
   AND (lower(btrim(coalesce(internal_status, ''))) = 'inactive / on hold'
        OR lower(coalesce(internal_status, '')) LIKE '%hold%');
