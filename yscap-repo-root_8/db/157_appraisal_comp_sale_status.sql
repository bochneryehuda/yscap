-- ============================================================================
-- 157 — Record a comparable's SALE STATUS (owner audit 2026-07-19).
--
-- A comp's PropertySalesAmount holds the LIST/asking price when the comp is an
-- ACTIVE or PENDING listing rather than a closed sale. Counting a listing as a
-- settled comparable inflates the "closed comps" pool (the pool-adequacy check +
-- the collateral score's closed-comp credit) and pollutes the implied-value median
-- with an asking price. The parser now reads the data-source text and marks a comp
-- 'active'/'pending' ONLY when it explicitly says so (MLS ACTIVE, pending, under
-- contract, expired, for sale); everything else is a closed sale.
--
-- Additive + idempotent. Default NULL is read as 'closed' by the app (previously
-- imported rows keep counting as closed, which matches their prior behavior).
-- ============================================================================

ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS sale_status text;  -- closed | active | pending
