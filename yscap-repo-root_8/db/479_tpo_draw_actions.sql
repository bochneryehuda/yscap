-- Phase 6d — a broker (TPO) ACCEPTS or DISPUTES a construction-draw inspection result
-- (owner-locked decision 2, 2026-08-04: brokers "view / accept / dispute on funded files,
-- like a borrower"). The broker acts through the authenticated, FIRM-SCOPED /api/tpo surface
-- that mirrors the borrower's AUTHENTICATED accept/dispute server-side — never the borrower's
-- public reply_token (which also permits accept/dispute and must never reach a broker).
--
-- A broker IS a staff_users row, so the money action is attributable: accepted_via / disputed_via
-- gain a 'tpo' value, accepted_by_staff_id (db/454) names the broker who accepted, and the new
-- disputed_by_staff_id names the broker who disputed. Idempotent + safe to re-run on every boot.

-- 1) widen accepted_via to allow 'tpo' (db/131 created it 2-value; db/454 widened it to +'staff').
DO $$
BEGIN
  ALTER TABLE draw_findings DROP CONSTRAINT IF EXISTS draw_findings_accepted_via_check;
  ALTER TABLE draw_findings DROP CONSTRAINT IF EXISTS draw_findings_accepted_via_chk2;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'draw_findings_accepted_via_chk3') THEN
    ALTER TABLE draw_findings ADD CONSTRAINT draw_findings_accepted_via_chk3
      CHECK (accepted_via IS NULL OR accepted_via IN ('portal', 'email', 'staff', 'tpo'));
  END IF;
END $$;

-- 2) widen disputed_via to allow 'tpo' (db/193 created it 'portal'|'email').
DO $$
BEGIN
  ALTER TABLE draw_findings DROP CONSTRAINT IF EXISTS draw_findings_disputed_via_chk;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'draw_findings_disputed_via_chk2') THEN
    ALTER TABLE draw_findings ADD CONSTRAINT draw_findings_disputed_via_chk2
      CHECK (disputed_via IS NULL OR disputed_via IN ('portal', 'email', 'tpo'));
  END IF;
END $$;

-- 3) attribution parity with db/454's accepted_by_staff_id: which broker disputed.
ALTER TABLE draw_findings ADD COLUMN IF NOT EXISTS disputed_by_staff_id uuid REFERENCES staff_users(id) ON DELETE SET NULL;
