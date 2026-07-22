-- Clear (archive/close-out) a loan exception (owner-directed 2026-07-22).
--
-- Adds a terminal 'cleared' status to loan_exceptions so a handled exception can
-- be closed out of the active queue by a super-admin (or the person who requested
-- it), separate from the approve/deny DECISION. Clearing is housekeeping only — it
-- archives the exception record and does NOT change any borrower-facing value; an
-- already-APPROVED guaranty waiver stays in effect (the co_borrower_pg_waived flag
-- is untouched by a clear).
--
-- Additive + idempotent; go-forward only (existing rows keep their status). The
-- one-open-per-file partial index (WHERE status='requested') is preserved verbatim,
-- so clearing an open request frees the file to receive a new one.

-- Widen the status CHECK to include 'cleared' (drop + re-add; Postgres auto-named it).
ALTER TABLE loan_exceptions DROP CONSTRAINT IF EXISTS loan_exceptions_status_check;
ALTER TABLE loan_exceptions
  ADD CONSTRAINT loan_exceptions_status_check
  CHECK (status IN ('requested','approved','denied','withdrawn','cleared'));

ALTER TABLE loan_exceptions ADD COLUMN IF NOT EXISTS cleared_by uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE loan_exceptions ADD COLUMN IF NOT EXISTS cleared_at timestamptz;
ALTER TABLE loan_exceptions ADD COLUMN IF NOT EXISTS clear_note text;
