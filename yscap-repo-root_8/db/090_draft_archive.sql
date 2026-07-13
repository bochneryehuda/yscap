-- Let borrowers tidy their in-progress applications (owner-directed, 2026-07-13).
-- A borrower may have several deals going at once, so we do NOT cap open drafts;
-- instead they can ARCHIVE a draft (hide it from the active list, reversible) or
-- DELETE it outright — but only before it is submitted. Idempotent add-column;
-- the open-draft queries exclude archived rows in code. Submitted drafts are
-- unaffected (they already drop out of the list via submitted_application_id).
ALTER TABLE application_drafts ADD COLUMN IF NOT EXISTS archived_at timestamptz;
