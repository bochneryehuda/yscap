-- ============================================================================
-- 505 — A CANDIDATE CAN CARRY THE HOLD'S EXIT, NOT ONLY THE FLIP'S.
--
-- The owner (2026-08-09), on the public-records search: "You need to add some
-- enhancements to understand from Elementix: when this LLC purchased it, when
-- this LLC sold it, when this LLC refinanced it."
--
-- The staging table had columns for the purchase and the sale — the two facts
-- a DEED carries — and nowhere to put what a MORTGAGE carries. Verified live
-- against the vendor (2026-08-09): a mortgage row states `isRefinance`,
-- `loanPurpose`, `recordingDate`, `mortgageAmount` and `satisfactionDate`, so
-- "this LLC refinanced this property on this day for this amount" is right
-- there in the county record — and the importer was fetching those rows (and
-- paying for them) and then reading only the deeds.
--
-- Why it matters beyond completeness: the frozen exit rule
-- (experience.EXIT_DATE_SQL) sends a HOLD to COALESCE(rent_date, refi_date).
-- With no way to stage either date, EVERY imported hold landed with a NULL
-- exit and counted toward nothing, silently — the reviewer confirmed a real
-- rental portfolio and the tier read zero. Measured, not assumed, by the
-- 2026-08-09 field-fidelity audit.
--
-- The MLS rent block (the one lease signal the records carry) stays in `raw`
-- as evidence for the reviewer; a rent DATE is only ever staged when the
-- vendor states an outcome, never inferred from a listing (a property listed
-- for rent is not a property rented).
--
-- Idempotent, additive. Reads nothing, deletes nothing.
-- ============================================================================

ALTER TABLE track_record_candidates
  ADD COLUMN IF NOT EXISTS rent_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS rent_date   date,
  ADD COLUMN IF NOT EXISTS refi_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS refi_date   date;

COMMENT ON COLUMN track_record_candidates.refi_date IS
  'The county-recorded refinance: a mortgage row of the borrower''s with isRefinance=true. '
  'This is the HOLD exit the frozen rule reads (COALESCE(rent_date, refi_date)) — without it '
  'every imported hold counted toward nothing.';
COMMENT ON COLUMN track_record_candidates.rent_date IS
  'Staged only when the records state a lease outcome — never inferred from an MLS listing. '
  'Usually NULL; the MLS rent evidence stays in raw for the reviewer.';
