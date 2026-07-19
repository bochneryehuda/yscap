-- ============================================================================
-- 150_appraisal_flood_check.sql — Phase 3 of the appraisal-review program.
--
-- Stores the result of the FEMA flood cross-check (the appraisal's stated flood
-- zone vs the official FEMA National Flood Hazard Layer, geocoded via the free
-- Census geocoder). Populated best-effort after import by src/lib/appraisal/flood.js
-- (gated by APPRAISAL_FLOOD_CHECK_ENABLED). NULLs mean "not checked" — never a
-- guessed zone.
--
-- Additive + idempotent (safe on every boot).
-- ============================================================================

ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS fema_flood_zone   text;      -- FEMA FLD_ZONE (AE, X, VE, …)
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS fema_flood_sfha   boolean;   -- in a Special Flood Hazard Area?
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS fema_flood_agrees boolean;   -- does it agree with the appraisal?
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS fema_flood_note   text;      -- plain-language comparison note
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS fema_flood_checked_at timestamptz;
