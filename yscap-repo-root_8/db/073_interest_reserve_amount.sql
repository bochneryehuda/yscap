-- ============================================================================
-- 073 - Interest reserve as an exact dollar amount (owner-directed 2026-07-12)
--
-- The financed interest reserve could previously only be requested as a number
-- of MONTHS (converted to a reserve via the monthly interest payment). Add an
-- optional exact-AMOUNT alternative: when requested_ir_amount > 0 the pricing
-- engines use it directly as the desired reserve (fit through the same caps);
-- when null/0 the months path is unchanged. Purely additive.
-- ============================================================================

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS requested_ir_amount numeric(14,2);
