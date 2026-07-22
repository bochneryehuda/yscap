-- 225 — Counter-offer state for manual-program escalations.
--
-- Owner-directed 2026-07-21: a super-admin reviewing an exception should be able
-- to COUNTER-OFFER (not just approve or decline). A countered escalation stays
-- open on the queue, the loan officer + borrower are notified with the exact
-- terms the super-admin would accept, and the file waits for the loan officer to
-- re-register with the countered terms (which supersedes this row and closes it
-- automatically) or re-request the exception with different numbers.
--
-- New state added to the status CHECK: 'countered' (in addition to
-- pending/approved/declined). Idempotent + safe to re-run.

-- (1) Widen the status CHECK to include the new 'countered' state.
ALTER TABLE manual_program_escalations
  DROP CONSTRAINT IF EXISTS manual_program_escalations_status_check;
ALTER TABLE manual_program_escalations
  ADD CONSTRAINT manual_program_escalations_status_check
  CHECK (status IN ('pending','countered','approved','declined'));

-- (2) Structured counter-offer fields. counter_terms is a small JSON blob (what
--     the super-admin proposes: LTV/LTC/ARV or rate/points/loan-amount tweaks);
--     counter_note is the plain-language explanation that reaches the loan
--     officer + borrower.
ALTER TABLE manual_program_escalations
  ADD COLUMN IF NOT EXISTS counter_terms jsonb,
  ADD COLUMN IF NOT EXISTS counter_note  text,
  ADD COLUMN IF NOT EXISTS countered_at  timestamptz,
  ADD COLUMN IF NOT EXISTS countered_by  uuid REFERENCES staff_users(id) ON DELETE SET NULL;

-- (3) Widen the "one open escalation per file" partial-unique index so it also
--     covers 'countered' rows. A re-register while a counter is outstanding
--     supersedes it the same way it supersedes a plain pending row (handled in
--     app code via openEscalation()).
DROP INDEX IF EXISTS uq_manual_esc_pending_per_app;
CREATE UNIQUE INDEX IF NOT EXISTS uq_manual_esc_openish_per_app
  ON manual_program_escalations(application_id) WHERE status IN ('pending','countered');
