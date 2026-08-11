-- ============================================================================
-- 524 — TPO PORTAL, foundation part 2: the TPO loan CHANNEL on the file +
--       the account-executive / account-manager file roles
--       (owner-directed 2026-08-04). Depends on db/523 (tpo_firms).
--
-- A TPO loan is an ordinary RTL `applications` row, flagged `is_tpo` and tied to
-- the originating brokerage `tpo_firm_id`. The people on the file map like this
-- (owner's words): the BROKER is the loan officer (`applications.loan_officer_id`
-- → the external staff_users row); OUR loan officer becomes the firm's ACCOUNT
-- EXECUTIVE and OUR processor the ACCOUNT MANAGER — two new file-roles carried in
-- application_assignees, exactly as db/392 carried closer / draw_coordinator.
--
-- Idempotent — safe to re-run on every boot.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (1) The channel flag + firm link on the file. Defaults make every existing
--     file a normal RETAIL file (is_tpo=false, no firm) — previous AND future.
--     borrower_portal_enabled defaults TRUE (owner: the borrower keeps their own
--     login by default; the broker may turn it off per borrower — Phase later).
-- ----------------------------------------------------------------------------
ALTER TABLE applications ADD COLUMN IF NOT EXISTS is_tpo                  boolean NOT NULL DEFAULT false;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS tpo_firm_id             uuid REFERENCES tpo_firms(id) ON DELETE SET NULL;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS borrower_portal_enabled boolean NOT NULL DEFAULT true;
-- Scoping reads a TPO firm's whole pipeline off this pair, so index it.
CREATE INDEX IF NOT EXISTS idx_applications_tpo_firm ON applications(tpo_firm_id) WHERE is_tpo = true;

-- A TPO file must name its firm, and a retail file must not — the same
-- external-firm invariant as staff_users (db/523 §4), so the firm-scope gate can
-- never see an is_tpo file it cannot bound to a firm.
ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_tpo_firm_check;
ALTER TABLE applications ADD  CONSTRAINT applications_tpo_firm_check
  CHECK ( (is_tpo = true  AND tpo_firm_id IS NOT NULL)
       OR (is_tpo = false AND tpo_firm_id IS NULL) );

-- ----------------------------------------------------------------------------
-- (2) The two lender-side file roles. Widen the application_assignees role CHECK
--     (drop-then-add, the db/392 pattern; a superset, so no existing row fails).
--     account_executive = our loan officer on a TPO file
--     account_manager   = our processor on a TPO file
--     Like draw_coordinator, these have NO denormalized pointer on applications —
--     the assignee row IS the record, so the sync_primary_assignee() trigger
--     (which fires only on the loan_officer_id/processor_id/closer_id pointers)
--     needs no change.
-- ----------------------------------------------------------------------------
ALTER TABLE application_assignees DROP CONSTRAINT IF EXISTS application_assignees_role_check;
ALTER TABLE application_assignees
  ADD CONSTRAINT application_assignees_role_check
  CHECK (role IN ('loan_officer','processor','closer','draw_coordinator',
                  'account_executive','account_manager'));
