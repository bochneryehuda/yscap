-- #151 (owner-directed 2026-07-17): new FIRST status `file_intake`, BEFORE
-- processing. ClickUp 'starting' and 'Prospect / Pricing' now interpret as
-- file_intake — a prospect that exists in the system but is NOT an active file.
-- Excluded from every active-file KPI/filter/count (INACTIVE_FILE_STATUSES in
-- src/routes/staff.js); its own Intake filter chip sits beside Active / On hold
-- / Closed / Cancelled. Idempotent; safe to re-run on every boot.

-- 1) Widen the borrower-facing status CHECK (pattern from db/041).
ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_status_check;
ALTER TABLE applications ADD  CONSTRAINT applications_status_check
  CHECK (status IN ('file_intake','new','in_review','processing','underwriting','approved',
                    'clear_to_close','funded','on_hold','declined','withdrawn'));

-- 2) Backfill PREVIOUS files ("previous AND future"): any live file whose
--    ClickUp status is one of the two intake stages was deriving to 'new' (an
--    ACTIVE status) — move it to file_intake so it falls out of the active
--    KPIs on this boot, not on its next ClickUp touch. Exact-match the two
--    known ClickUp statuses only; terminal/held files are never touched.
UPDATE applications
   SET status = 'file_intake', updated_at = now()
 WHERE lower(btrim(coalesce(internal_status, ''))) IN ('starting', 'prospect / pricing')
   AND status NOT IN ('file_intake', 'funded', 'declined', 'withdrawn', 'on_hold');
