-- ============================================================================
-- db/678 — the submittal ClickUp retry backs off
--
-- WHAT THIS CHANGES, AND WHY. db/673 records that a file's prior-to-submittal
-- work was declared complete, and `clickup/submittal.pushPass` tells the file's
-- ClickUp card so on the worker's tick. That pass selects EVERY completed loan
-- whose push has not landed and retries it, every tick, for ever.
--
-- WHAT WAS OBSERVED (adversarial review, 2026-09-02). A card whose
-- "Prior to submittal conditions" field is missing, or which carries no
-- "Completed" option, can never be pushed — nothing about retrying changes
-- that. So such a loan was read from ClickUp on every tick (one `getTask`
-- each), rewriting the same sentence into `submittal_clickup_error` for ever,
-- and — because the pass is bounded and ordered by completion date — a handful
-- of permanently unpushable loans could sit at the front of the queue and
-- starve a loan that was completed a minute ago and would have pushed fine.
--
-- THE STAMP THIS ADDS is the same shape as `conditions_evaluate_tried_at`
-- (db/672) and is there for the same reason:
--
--   submittal_clickup_tried_at   the last ATTEMPT, landed or not. The pass
--                                orders on it (never tried first), and skips a
--                                loan tried inside the back-off window — so a
--                                permanently broken card is asked about once a
--                                window instead of once a tick, and can never
--                                hold the front of the queue.
--
-- It is DELIBERATELY NOT a failure counter and never retires a loan. A card
-- that gains the field tomorrow must push tomorrow; a loan that quietly stopped
-- being retried would be a completion the card never hears about, which is the
-- one outcome this whole path exists to prevent.
--
-- IDEMPOTENT: one ADD COLUMN IF NOT EXISTS and one CREATE INDEX IF NOT EXISTS.
-- ============================================================================

ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS submittal_clickup_tried_at timestamptz;

COMMENT ON COLUMN lt_loans.submittal_clickup_tried_at IS
  'When the ClickUp "Prior to submittal conditions" push was last ATTEMPTED for this loan, landed or not. Written only by clickup/submittal.js; the retry pass orders on it and backs off.';

-- The retry pass reads exactly this set: completed, not yet landed, has a card.
CREATE INDEX IF NOT EXISTS lt_loans_submittal_push_owed_idx
  ON lt_loans (submittal_clickup_tried_at NULLS FIRST, submittal_completed_at)
  WHERE submittal_completed_at IS NOT NULL AND submittal_clickup_pushed_at IS NULL;
