-- 341_finding_ai_review_borrower_wording.sql
-- BORROWER-SAFE CONDITION WORDING (owner-directed 2026-07-27, the "what else" AI list).
--
-- When the finding-review AI confirms a real finding, it now also drafts the BORROWER-FACING
-- condition wording — a short plain-English label + a one-line "what we need and why" hint — scrubbed
-- of any capital-partner / note-buyer name, so a human can convert the finding into a condition with
-- the copy pre-written (and the note-buyer scrub already applied). Advisory: a human still approves
-- before it becomes a real condition (the AI never creates/edits a condition). These nullable columns
-- store the drafted wording. NULL when the model returned nothing (a false alarm / nothing to ask the
-- borrower). Idempotent.
ALTER TABLE finding_ai_reviews ADD COLUMN IF NOT EXISTS borrower_label text;
ALTER TABLE finding_ai_reviews ADD COLUMN IF NOT EXISTS borrower_hint  text;

COMMENT ON COLUMN finding_ai_reviews.borrower_label IS
  'AI-drafted borrower-facing condition label (scrubbed of note-buyer names). Advisory — a human approves before it becomes a condition.';
