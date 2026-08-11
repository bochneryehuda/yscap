-- ============================================================================
-- 534 — MANUAL PROGRAM: DEFAULT RESERVE = THREE MONTHS (owner-directed 2026-08-11)
--
-- The owner: "Only on the manual program, the default should be three months'
-- reserves, but that manual box should override the months of reserves you need
-- for the manual." The Manual Program's "months of liquidity" is how many months
-- of RESERVES the borrower must show in the ending balance (NOT the bank-statement
-- count, which is always two — db/533). Its company default was seeded at 2 by
-- db/207; bump it to 3.
--
-- ONLY the UNTOUCHED SEED is changed: the current row must still be db/207's seed
-- (its note) AND still hold the seeded 2. An admin who has explicitly saved a
-- config (saveSettings writes a new is_current row with a different / null note)
-- is never overwritten — a deliberate choice of any months stands. Idempotent:
-- after this runs the current row holds 3, so the guard is false on replay. The
-- per-file box (product_registrations.asset_months) is untouched and still
-- overrides this default. The engine mirrors the default in
-- src/lib/pricing.js MANUAL_RESERVE_DEFAULT_MONTHS / manual-program.js
-- SETTINGS_DEFAULTS.assetMonths.
-- ============================================================================

UPDATE manual_program_settings
   SET asset_months = 3
 WHERE is_current
   AND asset_months = 2
   AND note = 'Default manual-program config (seeded)';
