-- ============================================================================
-- 163 — Appraisal neighborhood LAND-USE mix + OFF-SITE improvements (enhancement round 4,
-- 2026-07-20). Both are present on 37/37 corpus files and were never extracted.
--
--  * present_land_use: the neighborhood's land-use composition (NEIGHBORHOOD > _PRESENT_LAND_USE
--    rows: {_Type, _Percent}) — SingleFamily / TwoToFourFamily / Apartment / Commercial / Other %.
--    Tells the exit read what kind of neighborhood the collateral sits in (a 2–4-unit flip in a
--    50%-single-family block reads differently than one in a commercial corridor). Stored verbatim,
--    NOT normalized to 100 (the appraiser's percentages are recorded as given, never a guess).
--  * off_site_improvements: street / alley / access rows (_OFF_SITE_IMPROVEMENT: {_Type,
--    _Description, _OwnershipType, _ExistsIndicator}) — the PUBLIC vs PRIVATE ownership of the
--    street/alley is a real maintenance/access cost signal on a flip.
--
-- Additive + idempotent.
-- ============================================================================
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS present_land_use     jsonb;  -- [{type,percent}]
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS off_site_improvements jsonb; -- [{type,description,ownership,exists}]
