-- ============================================================================
-- 163 — Per-bureau status on a credit report (owner-directed 2026-07-19)
--
-- Partial-merge is the norm (one bureau frozen / down / no-hit while the others
-- return). Store the per-bureau outcome + the "N of 3 scored" count so staff see
-- exactly which repositories came back, and a frozen/no-hit bureau can be
-- re-pulled on its own. Idempotent.
-- ============================================================================
ALTER TABLE credit_reports
  ADD COLUMN IF NOT EXISTS bureau_status jsonb;   -- { perBureau:{equifax,experian,transunion}, scoredCount, requested }
