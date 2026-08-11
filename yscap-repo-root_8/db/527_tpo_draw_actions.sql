-- Phase 6d — a broker (TPO) ACCEPTS or DISPUTES a construction-draw inspection result
-- (owner-locked decision 2, 2026-08-04: brokers "view / accept / dispute on funded files,
-- like a borrower"). The broker acts through the authenticated, FIRM-SCOPED /api/tpo surface
-- that mirrors the borrower's AUTHENTICATED accept/dispute server-side — never the borrower's
-- public reply_token (which also permits accept/dispute and must never reach a broker).
--
-- A broker IS a staff_users row, so the money action is attributable: accepted_via / disputed_via
-- gain a 'tpo' value, accepted_by_staff_id (db/454) names the broker who accepted, and the new
-- disputed_by_staff_id names the broker who disputed.
--
-- IDEMPOTENCY — the CHECKs are widened IN PLACE under the SAME names db/454 / db/193 use, NOT under
-- new names. Every migration re-runs on every boot, so db/454 and db/193 replay BEFORE this file and
-- re-add their own constraint `IF NOT EXISTS(<their name>)`. Widening under a NEW name (an early
-- draft did) deletes their names, so the next boot they re-add the NARROW list — which then fails
-- against a real 'tpo' row, and migrate-boot's benign-superseded detection can't recognize it
-- (it keys on a LATER file re-adding the SAME name). Re-adding under THEIR names means their
-- IF NOT EXISTS guard finds the wide constraint this file leaves and skips cleanly — no failure,
-- ever. Each block only acts when the current constraint lacks 'tpo', so there is no per-boot churn,
-- and it also drops the early-draft names (…_chk3 / …_disputed_via_chk2) so any DB that ran the
-- draft converges. Safe to re-run.

-- 1) widen accepted_via to allow 'tpo', under db/454's name draw_findings_accepted_via_chk2
--    (db/131 created it inline 2-value as draw_findings_accepted_via_check; db/454 → +'staff').
DO $$
BEGIN
  ALTER TABLE draw_findings DROP CONSTRAINT IF EXISTS draw_findings_accepted_via_chk3;   -- early-draft name
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'draw_findings_accepted_via_chk2'
      AND pg_get_constraintdef(oid) LIKE '%tpo%'
  ) THEN
    ALTER TABLE draw_findings DROP CONSTRAINT IF EXISTS draw_findings_accepted_via_check;
    ALTER TABLE draw_findings DROP CONSTRAINT IF EXISTS draw_findings_accepted_via_chk2;
    ALTER TABLE draw_findings ADD CONSTRAINT draw_findings_accepted_via_chk2
      CHECK (accepted_via IS NULL OR accepted_via IN ('portal', 'email', 'staff', 'tpo'));
  END IF;
END $$;

-- 2) widen disputed_via to allow 'tpo', under db/193's name draw_findings_disputed_via_chk.
DO $$
BEGIN
  ALTER TABLE draw_findings DROP CONSTRAINT IF EXISTS draw_findings_disputed_via_chk2;   -- early-draft name
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'draw_findings_disputed_via_chk'
      AND pg_get_constraintdef(oid) LIKE '%tpo%'
  ) THEN
    ALTER TABLE draw_findings DROP CONSTRAINT IF EXISTS draw_findings_disputed_via_chk;
    ALTER TABLE draw_findings ADD CONSTRAINT draw_findings_disputed_via_chk
      CHECK (disputed_via IS NULL OR disputed_via IN ('portal', 'email', 'tpo'));
  END IF;
END $$;

-- 3) attribution parity with db/454's accepted_by_staff_id: which broker disputed.
ALTER TABLE draw_findings ADD COLUMN IF NOT EXISTS disputed_by_staff_id uuid REFERENCES staff_users(id) ON DELETE SET NULL;
