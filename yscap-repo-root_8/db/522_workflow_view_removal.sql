-- 522 — Remove a file from a WORKFLOW VIEW without deleting it (owner-directed
-- 2026-08-11: "anybody should be able to remove a file from the workflow — the row
-- coordinator, closing, purchasing — if it landed there by mistake. Double warning,
-- and it should NOT delete the file from the system, just remove it from their
-- workflow view").
--
-- This is a per-VIEW hide, distinct from applications.deleted_at (the global
-- archive that removes a file from EVERY surface and needs the delete_files
-- capability). Each of the three workflows gets its own nullable removal marker,
-- so a file removed from one view is untouched on every other surface (the other
-- desks, the borrower portal, the file itself). Reversible (a restore clears the
-- marker) and audited. Additive + idempotent; NULL default = go-forward, nothing
-- is hidden until a human removes it.
--
-- The row coordinator's view is the PIPELINE (the master list of loan-file rows
-- the loan/row coordinator works — there is no separate coordinator desk), so its
-- marker lives on applications. It is NOT watched by any economics/reopen trigger
-- (db/071/072 watch the pricing inputs), so hiding a file never touches pricing,
-- conditions or the sync.

ALTER TABLE closing_workflow    ADD COLUMN IF NOT EXISTS removed_at     timestamptz;
ALTER TABLE closing_workflow    ADD COLUMN IF NOT EXISTS removed_by     uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE closing_workflow    ADD COLUMN IF NOT EXISTS removed_reason text;

ALTER TABLE purchasing_workflow ADD COLUMN IF NOT EXISTS removed_at     timestamptz;
ALTER TABLE purchasing_workflow ADD COLUMN IF NOT EXISTS removed_by     uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE purchasing_workflow ADD COLUMN IF NOT EXISTS removed_reason text;

ALTER TABLE applications        ADD COLUMN IF NOT EXISTS pipeline_removed_at     timestamptz;
ALTER TABLE applications        ADD COLUMN IF NOT EXISTS pipeline_removed_by     uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE applications        ADD COLUMN IF NOT EXISTS pipeline_removed_reason text;
