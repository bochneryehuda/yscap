-- LOAN-OFFICER DISPUTE-ON-BEHALF (owner-directed 2026-08-12).
-- A loan officer with view_draws may file a draw dispute FOR the borrower, stamped
-- disputed_via='staff' + disputed_by_staff_id (db/527 added the column and 'tpo';
-- db/454 added accepted_via='staff'). This widens the disputed_via CHECK to allow
-- 'staff', mirroring accepted_via's value set.
--
-- REPLAY-SAFE + ORDERING: numbered AFTER db/527, which re-asserts the same-named
-- constraint with ('portal','email','tpo') on every boot. db/527's guard skips when
-- the live constraint already contains 'tpo' — and this file's converged constraint
-- still contains 'tpo' — so db/527 finds it and skips, never clobbering 'staff'. This
-- file's own guard keys on 'staff', so once widened it is a no-op. On a fresh DB the
-- two run in order (527 → 'tpo'; 538 → +'staff') and converge to the full set.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'draw_findings_disputed_via_chk'
      AND pg_get_constraintdef(oid) LIKE '%staff%'
  ) THEN
    ALTER TABLE draw_findings DROP CONSTRAINT IF EXISTS draw_findings_disputed_via_chk;
    ALTER TABLE draw_findings ADD CONSTRAINT draw_findings_disputed_via_chk
      CHECK (disputed_via IS NULL OR disputed_via IN ('portal', 'email', 'staff', 'tpo'));
  END IF;
END $$;
