-- ============================================================================
-- 156 — Record HOW the As-Is vs ARV comp-grid split was determined (owner-critical
--       correctness work, 2026-07-19).
--
-- A renovation appraisal supports two values off two SEPARATE comparable sets — an
-- ARV grid (after-repair) and an As-Is grid (current condition). The parser now
-- assigns each comp to a grid (appraisal_comparables.comp_set, which already exists
-- from db/137: 'arv' | 'as_is' | 'unknown') and NEVER guesses — it prefers the
-- appraiser's narrative naming, falls back to price-clustering only when both anchor
-- values are known and the raw + adjusted prices agree, and otherwise marks the comp
-- 'unknown' and raises a review flag.
--
-- This migration adds the appraisal-level provenance of that split so the desk knows
-- how much to trust it (and whether a human must verify the grids):
--   * comp_split_confidence  — narrative | proximity | single_grid | undetermined
--   * comp_split_needs_review — some comp could not be assigned with certainty
--
-- Additive + idempotent. The two per-value columns (as_is_value/arv_value) already
-- exist on appraisals from db/137; nothing here overwrites the loan file.
-- ============================================================================

ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS comp_split_confidence  text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS comp_split_needs_review boolean;
