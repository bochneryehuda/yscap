-- Per-loan supplemental answers for capital-provider data tapes.
--
-- Some tape columns are not derivable from what we already store — chiefly the
-- New-Construction-only Fidelis fields (asset purchased, entitlement status,
-- build status, lot purchase price/date). When staff export a tape for a loan
-- that needs them, they answer a short questionnaire; the answers are saved HERE
-- so the tape fills correctly AND we never ask twice (a later export just uses
-- the stored answers). Keyed by tape field key, e.g.
--   { "asset_purchased": "Finished Lot", "entitlement_status": "Fully Entitled",
--     "build_status": "Framing", "lot_purchase_price": 120000,
--     "lot_purchase_date": "2026-03-01" }
-- Idempotent (safe to re-run every boot).
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS tape_supplemental jsonb NOT NULL DEFAULT '{}'::jsonb;
