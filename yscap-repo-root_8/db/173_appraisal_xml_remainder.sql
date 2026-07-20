-- ============================================================================
-- 167 — Appraisal XML "final remainder" round 7 (owner-directed "squeeze the most possible",
-- 2026-07-20). A second full coverage sweep after rounds 3–6 confirmed the high-value structured
-- data is extracted; these are the last consistently-present fields that clear the never-guess bar
-- (everything else remaining is a GSE duplicate of an already-extracted field, a cryptic materials
-- code, a redundant percent/trend variant, or a "see 1004MC" pointer). Additive + idempotent.
--
--  * appraisal_comparables.location_type: the comp's UAD location TYPE (COMPARISON_LOCATION_DETAIL
--    GSELocationType → Residential / BusyRoad / Other, 24/37) — the "why" behind an adverse
--    location rating (a comp on a busy road is a real comparability/desirability signal).
--  * market_conditions_comment / market_reconciliation_comment: the appraiser's neighborhood
--    market-conditions narrative (NEIGHBORHOOD _MarketConditionsDescription) and 1004MC market-
--    trends reconciliation (MARKET MarketTrendsReconciliationComment). Stored ONLY when concrete —
--    the ~27% that are "See 1004MC"/"See attached" pointers are rejected (never store a pointer).
-- ============================================================================
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS location_type              text;
ALTER TABLE appraisals            ADD COLUMN IF NOT EXISTS market_conditions_comment  text;
ALTER TABLE appraisals            ADD COLUMN IF NOT EXISTS market_reconciliation_comment text;
