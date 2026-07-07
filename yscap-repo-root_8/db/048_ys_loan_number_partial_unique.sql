-- 048_ys_loan_number_partial_unique.sql
-- The plain UNIQUE on applications.ys_loan_number (schema.sql) counts SOFT-DELETED
-- rows, so when a live ClickUp task's loan number matches an archived portal file,
-- the inbound create throws a unique_violation (findExistingApp only matches
-- non-deleted rows, so it can't link to the archived one and falls through to
-- INSERT). Replace it with a PARTIAL unique index that ignores soft-deleted rows,
-- so an archived file never blocks re-materializing the same loan. Idempotent.
ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_ys_loan_number_key;
DROP INDEX IF EXISTS uq_applications_ys_loan_number;
CREATE UNIQUE INDEX IF NOT EXISTS uq_applications_ys_loan_number
  ON applications (ys_loan_number)
  WHERE ys_loan_number IS NOT NULL AND deleted_at IS NULL;
