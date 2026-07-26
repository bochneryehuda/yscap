-- Sync-review RE-CHECK ("look again") — owner-directed 2026-07-22.
-- A reviewer can ask PILOT to re-run the underlying comparison in the backend to
-- see whether a review is still needed (the disagreement may have already been
-- fixed manually on either side). These columns record when we last looked and
-- how many times — so the card can show "checked just now" and so a re-check is
-- never mistaken for a human resolution.
ALTER TABLE sync_review_queue ADD COLUMN IF NOT EXISTS last_checked_at timestamptz;
ALTER TABLE sync_review_queue ADD COLUMN IF NOT EXISTS check_count     integer NOT NULL DEFAULT 0;
