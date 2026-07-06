-- ============================================================================
-- 029 - Application rehab + experience fields
--   * Carry the "dead" application/term-sheet fields into the live file.
--   * Track fix-and-hold/rental exits with rent/refi fields instead of forcing
--     every experience record into a sale-only shape.
-- ============================================================================

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS rehab_type text,
  ADD COLUMN IF NOT EXISTS sqft_pre integer,
  ADD COLUMN IF NOT EXISTS sqft_post integer,
  ADD COLUMN IF NOT EXISTS requested_exp_flips integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS requested_exp_holds integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS requested_exp_ground integer NOT NULL DEFAULT 0;

ALTER TABLE track_records
  ADD COLUMN IF NOT EXISTS rent_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS rent_date date,
  ADD COLUMN IF NOT EXISTS refi_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS refi_date date,
  ADD COLUMN IF NOT EXISTS current_value numeric(14,2),
  ADD COLUMN IF NOT EXISTS notes text;
