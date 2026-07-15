-- ============================================================================
-- 112_sync_review_aging.sql — aging / escalation for the sync review queue
-- (owner-directed 2026-07-15 night: "anything that lands in manual review the
-- loan officer should get a notification" — and it must not go SILENT if
-- ignored; mega-audit enhancement #2).
--   * reminded_at  — the one-time re-notify to the file's LO after the row has
--                    sat open a few days (notified_at was the initial send).
--   * escalated_at — the one-time admin escalation after roughly a week.
-- Additive + idempotent.
-- ============================================================================

ALTER TABLE sync_review_queue ADD COLUMN IF NOT EXISTS reminded_at  timestamptz;
ALTER TABLE sync_review_queue ADD COLUMN IF NOT EXISTS escalated_at timestamptz;

-- Third resolution option: the reviewer TYPES the correct value when neither
-- side is right ('custom'); applied to both systems through the same
-- sanitizers + appliers as an adopted side.
ALTER TABLE sync_review_queue DROP CONSTRAINT IF EXISTS sync_review_queue_winner_check;
ALTER TABLE sync_review_queue ADD CONSTRAINT sync_review_queue_winner_check
  CHECK (winner IS NULL OR winner IN ('clickup','portal','custom'));
