-- ============================================================================
-- db/579 — the A-piece / B-piece split on a MANUAL-program loan
--
-- Owner-directed 2026-08-18: on the manual program, staff can mark a loan as an
-- A/B-piece structure and type the A-piece dollar amount; the B-piece is the
-- REST of the loan (total loan − A-piece) and is always DERIVED, never stored —
-- two stored halves would drift from the loan the moment it re-registers.
--
-- The columns live on `applications` and are DELIBERATELY absent from every
-- db/071 / db/072 / db/486 trigger watch list: this is an INTERNAL bookkeeping
-- fact about how the loan is sold, not a pricing input, so recording or editing
-- it must NEVER reopen Products & Pricing, un-sign a term sheet, or flag the
-- registration stale — the owner's explicit requirement ("saveable any time
-- without tripping the re-register trigger"). Guarded by
-- scripts/test-ab-piece-db.js, which edits the split on a signed-off file and
-- proves nothing reopens.
--
-- INTERNAL ONLY: no borrower or TPO surface ever selects these columns.
-- BACKFILL: none — no existing file carries an A/B split; both columns default
-- to "not an A/B deal" and staff record the split when there is one.
-- ============================================================================

ALTER TABLE applications ADD COLUMN IF NOT EXISTS ab_piece_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS a_piece_amount numeric(14,2);

-- The A-piece is a dollar amount of THIS loan — never negative.
ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_a_piece_amount_chk;
ALTER TABLE applications ADD CONSTRAINT applications_a_piece_amount_chk
  CHECK (a_piece_amount IS NULL OR a_piece_amount >= 0);
