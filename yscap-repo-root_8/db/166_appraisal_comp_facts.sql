-- ============================================================================
-- 166 — Appraisal COMPARABLE facts round 6 (owner-directed "squeeze more from the XML", 2026-07-20).
-- The coverage sweep found these per-comp UAD grid lines still unextracted on the ~24/37 files that
-- carry COMPARISON_DETAIL (135 comps). All never-guess (enum-whitelisted / magnitude-bounded).
--
--  * view_rating / location_rating: the comp's UAD view & location overall ratings
--    (COMPARISON_VIEW_OVERALL_RATING / COMPARISON_LOCATION_OVERALL_RATING → Beneficial/Neutral/
--    Adverse) — the two remaining UAD grid lines beyond condition/quality/beds/baths. An Adverse
--    view or location on a comp is a comparability signal.
--  * below_grade_sqft / below_grade_finished_sqft: the comp's basement area
--    (COMPARISON_DETAIL GSEBelowGradeTotalSquareFeetNumber / GSEBelowGradeFinishSquareFeetNumber) —
--    the subject already carries these (db/158); this completes the comp side of the grid.
--  * data_source: the comp's data source / MLS number (COMPARISON_DETAIL GSEDataSourceDescription,
--    e.g. "GSMLS#3933873") — provenance for the comp.
-- Additive + idempotent.
-- ============================================================================
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS view_rating              text;
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS location_rating          text;
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS below_grade_sqft         numeric(12,2);
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS below_grade_finished_sqft numeric(12,2);
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS data_source              text;
