-- 248 — AI Suggestions store (owner-directed 2026-07-22, HARD RULE).
--
-- Owner's rule: the AI never writes conditions, never overrides anything,
-- never changes file status, never declines a file, never acts on its own.
-- Every AI output is a SUGGESTION that lives in its own section. A human
-- clicks to escalate, add a note, convert it into a condition, convert it
-- into a task, mark it important, dismiss it, or ask the super-admin.
--
-- This migration adds two tables:
--   * ai_suggestions       — the suggestion box every AI agent writes to.
--   * ai_admin_questions   — questions the AI escalates to the super-admin.
--                             The super-admin's answer feeds the learning loop
--                             and closes the suggestion.
--
-- Idempotent (safe to re-run every boot).

CREATE TABLE IF NOT EXISTS ai_suggestions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  document_id           uuid REFERENCES documents(id) ON DELETE SET NULL,
  checklist_item_id     uuid REFERENCES checklist_items(id) ON DELETE SET NULL,
  -- Which agent produced this suggestion:
  --   cure_analysis       — the cure engine noticed a new issue in a document
  --   promoted_rules      — a super-admin-promoted rule wants to suppress/upgrade a finding
  --   committee           — the multi-model committee returned a verdict
  --   section_1071        — the CFPB Section 1071 classifier landed a verdict
  --   twin_reconcile      — the loan digital twin wants to pick a canonical value
  --   authenticity        — PDF forensics flagged something
  --   entity_chain        — seller/title/appraisal/borrower chain broke
  --   assignment_fraud    — non-arm's-length assignment signals
  --   wrong_condition     — the classifier says the document belongs to a different condition
  --   ask_admin           — the AI is uncertain and is asking the super-admin
  source                text NOT NULL,
  -- What KIND of suggestion — determines the action button set in the UI.
  --   finding      — suggests raising a finding
  --   condition    — suggests attaching a checklist condition
  --   certificate  — suggests issuing a decision certificate
  --   value_pick   — suggests picking a canonical value in the twin
  --   question     — a plain question for the super-admin
  --   info         — an informational insight (no action button)
  kind                  text NOT NULL,
  title                 text NOT NULL,
  body                  text,                                     -- plain-English WHY
  evidence              jsonb NOT NULL DEFAULT '{}'::jsonb,       -- {pages, boundingBox, sourceDocumentId, quote, ...}
  proposed_action       jsonb NOT NULL DEFAULT '{}'::jsonb,       -- {type,'create_finding'|'attach_condition'|..., fields:{...}}
  severity              text,                                     -- fatal|warning|info (finding-shape suggestions)
  confidence            numeric,                                  -- 0..1
  trace_url             text,                                     -- deep link into Langfuse
  status                text NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','escalated','noted','converted_to_condition','converted_to_task','dismissed','marked_important','asked_admin','answered')),
  status_reason         text,
  decided_by_staff_id   uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  decided_at            timestamptz,
  important             boolean NOT NULL DEFAULT false,
  notes                 jsonb NOT NULL DEFAULT '[]'::jsonb,       -- [{staff_id, at, text}]
  linked_condition_id   uuid REFERENCES checklist_items(id) ON DELETE SET NULL,
  linked_task_id        text,
  -- Dedupe key: an OPEN suggestion of the same source+dedupe_key on the same
  -- file collapses to a single row (an agent that re-runs never spams). NULL
  -- disables dedupe for that suggestion.
  dedupe_key            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_suggestions_open_dedupe
  ON ai_suggestions (application_id, source, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status = 'open';
CREATE INDEX IF NOT EXISTS idx_ai_suggestions_open_by_file
  ON ai_suggestions (application_id, status, source);
CREATE INDEX IF NOT EXISTS idx_ai_suggestions_important
  ON ai_suggestions (application_id) WHERE important = true AND status = 'open';

CREATE TABLE IF NOT EXISTS ai_admin_questions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suggestion_id         uuid REFERENCES ai_suggestions(id) ON DELETE CASCADE,
  application_id        uuid REFERENCES applications(id) ON DELETE CASCADE,
  agent                 text NOT NULL,        -- 'cure' | 'committee' | 'twin' | 'entity_chain' | 'assignment_fraud' | ...
  question              text NOT NULL,
  context               jsonb NOT NULL DEFAULT '{}'::jsonb,
  asked_at              timestamptz NOT NULL DEFAULT now(),
  answered_by_staff_id  uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  answered_at           timestamptz,
  answer                text,
  -- Set to true once the answer has been captured as a training signal for
  -- the specific agent. Prevents double-recording on re-runs.
  learning_captured     boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_ai_admin_questions_open
  ON ai_admin_questions (application_id, answered_at) WHERE answered_at IS NULL;

-- updated_at trigger (idempotent replace)
CREATE OR REPLACE FUNCTION set_ai_suggestions_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_ai_suggestions_updated ON ai_suggestions;
CREATE TRIGGER trg_ai_suggestions_updated BEFORE UPDATE ON ai_suggestions
  FOR EACH ROW EXECUTE FUNCTION set_ai_suggestions_updated_at();
