-- ============================================================================
-- 149_appraisal_comp_grid.sql — Phase 1 of the appraisal-review program.
--
-- The parser now mines each comparable's sales-grid data (settled sale date, GLA,
-- UAD condition/quality, days-on-market, price-per-GLA, the full adjustment list)
-- and the SUBJECT's prior-sale history. The comp grid columns (gla, sale_date,
-- condition_uad, quality_uad, days_on_market, adjustments) already exist on
-- appraisal_comparables from db/137; this migration adds the two still-missing
-- pieces so nothing the parser reads is dropped:
--   * appraisal_comparables.price_per_gla  — the comp's $/sqft (grid line)
--   * appraisals.prior_sale_* / has_prior_sale — the subject's last transfer,
--     used by the flip / recent-resale review check.
--
-- Additive + idempotent (safe on every boot). Purely stores what we KNOW from the
-- appraisal XML; never overwrites the loan file.
-- ============================================================================

ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS price_per_gla numeric(12,2);

ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS prior_sale_amount  numeric(14,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS prior_sale_date    date;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS has_prior_sale     boolean;
