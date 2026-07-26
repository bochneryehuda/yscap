-- ============================================================================
-- 209 — Fast cross-ClickUp loan-number uniqueness lookup (owner-directed
--       2026-07-20).
--
-- "It should not be a loan number that is in a different file in ClickUp even if
--  that file is not in our system … maybe that loan number is in a different file
--  of a DSCR file that you only take to use of the data and you're not creating
--  files from it."
--
-- clickup_task_index caches a MASKED snapshot of EVERY ClickUp task the sync sees
-- — RTL files we materialize AND data_only (DSCR / long-term) tasks we only pull
-- for data. The YS loan number lives in snapshot->'app'->>'ys_loan_number'. This
-- expression index makes the uniqueness check in src/lib/loan-number.js
-- (findLoanNumberCollision) fast against that whole space, so a loan number that
-- already exists on ANY ClickUp file — even one we never turned into a loan — is
-- caught before it can be re-used here.
--
-- Case/space-insensitive (upper(btrim(...))), matching the applications
-- partial-unique index (db/048) + the uppercase backfill (db/199). Idempotent.
-- ============================================================================

CREATE INDEX IF NOT EXISTS ix_clickup_task_index_ys_loan_number
  ON clickup_task_index (upper(btrim(snapshot->'app'->>'ys_loan_number')))
  WHERE snapshot->'app'->>'ys_loan_number' IS NOT NULL
    AND btrim(snapshot->'app'->>'ys_loan_number') <> '';
