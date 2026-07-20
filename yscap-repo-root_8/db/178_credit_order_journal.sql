-- ============================================================================
-- 159 — Credit order journal + idempotency (owner-directed 2026-07-19)
--
-- The order/reissue POST is BILLABLE and not idempotent at Xactus, so the portal
-- journals every order in credit_reports BEFORE the POST and reconciles it after.
-- These columns turn credit_reports into that journal + the manual-review queue:
--   - request_id / idempotency_key : correlation + a client-supplied key that a
--     retry/double-click reuses so one intent bills at most once. Partial-unique.
--   - status gains 'ordering' (pre-POST) and 'review' (needs a human).
--   - review_reason / error_detail : why a report is in review or errored
--     (frozen bureau, no score, FICO bracket mismatch, vendor error layer).
--   - representative_score / representative_bracket : the computed loan FICO
--     (highest of the borrowers' middles) + its bracket, stored for display and
--     the bracket-reset audit trail.
--   - pricing_bracket_at_import : the bracket the loan was priced on when the
--     report imported, so a later view can explain WHY registration reopened.
-- Idempotent (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).
-- ============================================================================

ALTER TABLE credit_reports
  ADD COLUMN IF NOT EXISTS request_id                 text,
  ADD COLUMN IF NOT EXISTS idempotency_key            text,
  ADD COLUMN IF NOT EXISTS review_reason              text,
  ADD COLUMN IF NOT EXISTS error_detail               jsonb,
  ADD COLUMN IF NOT EXISTS representative_score       integer,
  ADD COLUMN IF NOT EXISTS representative_bracket     text,
  ADD COLUMN IF NOT EXISTS pricing_bracket_at_import  text,
  ADD COLUMN IF NOT EXISTS ordered_at                 timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at               timestamptz;

-- One intent bills at most once: a reused idempotency key collides here and the
-- caller returns the prior journal row instead of placing a second order.
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_reports_idempotency
  ON credit_reports (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- The manual-review queue and the in-flight/journal views are status scans.
CREATE INDEX IF NOT EXISTS idx_credit_reports_status ON credit_reports (status);
CREATE INDEX IF NOT EXISTS idx_credit_reports_review ON credit_reports (status) WHERE status = 'review';

-- Representative score must be a real FICO when present.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_reports_rep_score_range') THEN
    ALTER TABLE credit_reports ADD CONSTRAINT credit_reports_rep_score_range
      CHECK (representative_score IS NULL OR (representative_score BETWEEN 300 AND 850));
  END IF;
END $$;
