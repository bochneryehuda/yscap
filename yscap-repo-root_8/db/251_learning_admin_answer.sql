-- 251 — Extend training_proposals to accept the 'admin_answer' proposal_type
-- (R3.20, owner-directed 2026-07-22).
--
-- When the AI asks a super-admin a question via ai-suggestions.askAdmin() and
-- the super-admin answers, learning.captureAdminAnswer() records the Q+A as a
-- training_proposals row. That closes the loop: the super-admin's plain-English
-- answer becomes a training signal a future runTraining pass can aggregate.
--
-- Idempotent — safely re-runs by DROPping the old constraint (if present) and
-- adding the broader one. proposed_change is NOT NULL in the original schema
-- but admin_answer rows carry meaning in `scope` and don't need a diff, so
-- either the insert path or an ALTER makes proposed_change nullable / default
-- to empty jsonb.

ALTER TABLE training_proposals
  ALTER COLUMN proposed_change DROP NOT NULL,
  ALTER COLUMN proposed_change SET DEFAULT '{}'::jsonb;
ALTER TABLE training_proposals
  ALTER COLUMN rationale DROP NOT NULL,
  ALTER COLUMN rationale SET DEFAULT '';

ALTER TABLE training_proposals DROP CONSTRAINT IF EXISTS training_proposals_proposal_type_check;
ALTER TABLE training_proposals
  ADD CONSTRAINT training_proposals_proposal_type_check CHECK (proposal_type IN (
    'suppress_finding','downgrade_severity','upgrade_severity','tune_threshold',
    'normalizer_alias','prompt_tweak','add_specialist_lens','committee_prompt_tweak',
    'admin_answer'
  ));

-- evidence_json column for the admin-answer rows (idempotent add).
ALTER TABLE training_proposals ADD COLUMN IF NOT EXISTS evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb;
