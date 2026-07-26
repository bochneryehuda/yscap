-- Conditions / document-requests attached to a loan exception (owner-directed 2026-07-22).
--
-- Lets a super-admin (or the requester) attach a checklist condition — most often
-- a DOCUMENT REQUEST — directly to an exception so the paperwork the exception
-- depends on is tracked with it. The condition still lives on the file's normal
-- checklist (so the borrower/team see it where they expect); this column just tags
-- WHICH exception it belongs to, so the exception detail can show its conditions +
-- any uploaded documents.
--
-- ON DELETE SET NULL (never CASCADE) so clearing/deleting an exception never
-- destroys a real condition or its documents — the tag simply detaches.
--
-- Additive + idempotent; go-forward only (existing checklist_items are NULL).

ALTER TABLE checklist_items
  ADD COLUMN IF NOT EXISTS loan_exception_id uuid REFERENCES loan_exceptions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_checklist_loan_exc
  ON checklist_items(loan_exception_id) WHERE loan_exception_id IS NOT NULL;
