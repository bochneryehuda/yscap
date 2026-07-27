-- 339_finding_ai_review_second_opinion.sql
-- THE SECOND AI (owner-directed 2026-07-27: "add ChatGPT AND add some other AI").
--
-- The finding-review gate now gets a SECOND, INDEPENDENT model's verdict (Claude / Anthropic) on a
-- finding — but only when the primary model (GPT) wants to HIDE it, because a false-alarm
-- suppression is the one AI decision that can hide a real problem. Two independent models have
-- different blind spots, so the gate requires CONSENSUS to hide: a finding is suppressed only when
-- BOTH confidently reject it; if they disagree it stays visible and is flagged for a human.
--
-- These nullable columns record the second model's take alongside the primary one. NULL whenever no
-- second model weighed in (no ANTHROPIC_API_KEY, disabled, or the primary didn't reject) — so with
-- the second model off, behavior is byte-identical to the single-model gate. Advisory only; never
-- blocks, never changes a number. Idempotent.
ALTER TABLE finding_ai_reviews ADD COLUMN IF NOT EXISTS verdict2     text;   -- the 2nd model's verdict (confirmed|rejected|uncertain)
ALTER TABLE finding_ai_reviews ADD COLUMN IF NOT EXISTS confidence2  real;   -- its confidence (0..1)
ALTER TABLE finding_ai_reviews ADD COLUMN IF NOT EXISTS reasoning2   text;   -- its explanation
ALTER TABLE finding_ai_reviews ADD COLUMN IF NOT EXISTS model2       text;   -- which provider gave it ('anthropic')

COMMENT ON COLUMN finding_ai_reviews.verdict2 IS
  'The independent second model''s verdict, present only when the primary tried to hide the finding. The gate requires both models to reject before suppressing; disagreement keeps the finding visible. Advisory only.';
