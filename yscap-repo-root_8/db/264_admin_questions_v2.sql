-- 264 — Admin question schema v2 (R5.40, owner-directed 2026-07-22).
--
-- The review's admin-question upgrade: a question the AI escalates to a
-- super-admin must be NARROW, answerable from displayed evidence, tied to ONE
-- blocked decision, offer mutually-exclusive options, be case-scoped by default,
-- and never create a permanent rule automatically. These columns extend the
-- existing ai_admin_questions (db/248) with that structure — all additive +
-- nullable so every existing row + producer keeps working unchanged.
--
-- The question GENERATOR (Prompt F) + dedupe + side-by-side evidence UI are
-- R5.41; this is the data shape they write.

ALTER TABLE ai_admin_questions ADD COLUMN IF NOT EXISTS question_type text;
-- The component whose decision is blocked (conflict / condition / boundary / …).
ALTER TABLE ai_admin_questions ADD COLUMN IF NOT EXISTS blocked_component text;
ALTER TABLE ai_admin_questions ADD COLUMN IF NOT EXISTS decision_deadline timestamptz;
-- The mutually-exclusive options offered: [{key,label,effect,recommended?}].
ALTER TABLE ai_admin_questions ADD COLUMN IF NOT EXISTS option_schema jsonb;
-- Evidence spans (db/257) the reviewer should see side-by-side.
ALTER TABLE ai_admin_questions ADD COLUMN IF NOT EXISTS evidence_span_ids jsonb;
ALTER TABLE ai_admin_questions ADD COLUMN IF NOT EXISTS recommended_option text;
ALTER TABLE ai_admin_questions ADD COLUMN IF NOT EXISTS recommended_rationale text;
-- Scope of the answer: 'case_only' (default) | 'similar_cases_advisory' | 'propose_rule'.
ALTER TABLE ai_admin_questions ADD COLUMN IF NOT EXISTS answer_scope text NOT NULL DEFAULT 'case_only';
ALTER TABLE ai_admin_questions ADD COLUMN IF NOT EXISTS answer_reason_code text;
ALTER TABLE ai_admin_questions ADD COLUMN IF NOT EXISTS answered_option text;
-- What applying the answer did (audited), for the file's history.
ALTER TABLE ai_admin_questions ADD COLUMN IF NOT EXISTS resolution_effects jsonb;
-- Whether the answer is eligible to become a learning proposal (never auto).
ALTER TABLE ai_admin_questions ADD COLUMN IF NOT EXISTS learning_eligibility text NOT NULL DEFAULT 'case_only';
-- If the answer seeds a regression fixture (R5.42/R5.65).
ALTER TABLE ai_admin_questions ADD COLUMN IF NOT EXISTS evaluation_case_id uuid;

-- Dedupe key so the same unresolved uncertainty isn't asked twice (R5.41). A
-- producer sets a stable dedupe_key; a partial unique index keeps at most one
-- OPEN question per key per file.
ALTER TABLE ai_admin_questions ADD COLUMN IF NOT EXISTS dedupe_key text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_admin_questions_dedupe
  ON ai_admin_questions (application_id, dedupe_key)
  WHERE answered_at IS NULL AND dedupe_key IS NOT NULL;
