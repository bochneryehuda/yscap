-- ============================================================================
-- 049_appraisal_card_reuse.sql — wire the "reuse the appraisal card on the
-- next file" half of the feature.
--
-- Migration 043 already added the reusable copy on the borrower profile
-- (saved_card_number_encrypted / saved_card_last4 / saved_card_exp /
--  saved_card_cvv_encrypted / save_card_for_reuse). Those hold the encrypted
-- PAN + CVV, the last 4 for display, the expiry and the opt-in flag.
--
-- To rebuild a complete application_payment_cards row when the borrower reuses
-- the card (that table also needs a brand + billing ZIP), we persist two more
-- non-secret fields alongside the encrypted copy so the reuse path never has to
-- decrypt the PAN just to preview it:
--   * saved_card_brand        — Visa / Mastercard / Amex / Discover (display)
--   * saved_card_billing_zip  — billing ZIP carried onto the new file
--
-- Additive + idempotent. No secret is added here; the PAN/CVV stay in the
-- bytea columns from 043 (AES-256-GCM, same key handling as SSNs).
-- ============================================================================

ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS saved_card_brand        text;
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS saved_card_billing_zip  text;
