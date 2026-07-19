-- ============================================================================
-- 135 — Adverse-action letter scaffolding (owner-directed 2026-07-19)
--
-- The owner wants adverse-action letters built in-system (permission is taken
-- verbally, so there is NO signed-auth capture step). RTL loans are
-- business-purpose, so the ECOA/Reg B business-credit adverse-action path
-- applies — the exact notice content + timing is a compliance decision, so this
-- is a SCAFFOLD: it records the structured decision (who, when, why, which
-- report, principal reasons) as a DRAFT for a human to review and finalize.
-- Nothing here sends anything or renders final legal prose.
--
-- Lifecycle: draft -> reviewed -> issued (or cancelled). Never auto-advances.
-- ============================================================================
CREATE TABLE IF NOT EXISTS adverse_action_letters (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid REFERENCES applications(id) ON DELETE SET NULL,
  borrower_id      uuid REFERENCES borrowers(id) ON DELETE SET NULL,
  credit_report_id uuid REFERENCES credit_reports(id) ON DELETE SET NULL,
  decision         text NOT NULL DEFAULT 'declined',   -- declined | counteroffer | incomplete
  -- Principal reason(s) for the action (structured; the human confirms/edits).
  principal_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The bureau score(s) disclosed on the notice (FCRA §615(a) when a score was used).
  scores_disclosed jsonb NOT NULL DEFAULT '[]'::jsonb,
  notice_body      text,                                -- assembled draft text (review before use)
  status           text NOT NULL DEFAULT 'draft',       -- draft | reviewed | issued | cancelled
  created_by       uuid REFERENCES staff_users(id),
  reviewed_by      uuid REFERENCES staff_users(id),
  reviewed_at      timestamptz,
  issued_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT adverse_action_status_check CHECK (status = ANY (ARRAY['draft','reviewed','issued','cancelled'])),
  CONSTRAINT adverse_action_decision_check CHECK (decision = ANY (ARRAY['declined','counteroffer','incomplete']))
);
CREATE INDEX IF NOT EXISTS idx_adverse_action_app ON adverse_action_letters(application_id);
CREATE INDEX IF NOT EXISTS idx_adverse_action_status ON adverse_action_letters(status);
