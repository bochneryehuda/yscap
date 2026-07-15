-- ============================================================================
-- 110_sync_review_two_sided.sql — full two-sided sync review (owner-directed
-- 2026-07-15 evening):
--   * every review row carries BOTH sides explicitly (what ClickUp holds vs
--     what PILOT holds) so the reviewer sees the whole picture regardless of
--     which direction tripped the guard;
--   * resolving picks a WINNER ('clickup' | 'portal') and the chosen value is
--     applied to BOTH systems (live re-read at resolve time — the row's stored
--     values are display-only, and SSNs are stored masked, never cleartext);
--   * the file's loan officer is emailed when a row lands (notified_at);
--   * auto_resolved marks disagreements the auto-resolution engine settled
--     WITHOUT human review (kept as closed rows for the audit trail).
--
-- Additive + idempotent.
-- ============================================================================

ALTER TABLE sync_review_queue ADD COLUMN IF NOT EXISTS clickup_value text;
ALTER TABLE sync_review_queue ADD COLUMN IF NOT EXISTS portal_value  text;
ALTER TABLE sync_review_queue ADD COLUMN IF NOT EXISTS winner        text;
ALTER TABLE sync_review_queue ADD COLUMN IF NOT EXISTS auto_resolved boolean NOT NULL DEFAULT false;
ALTER TABLE sync_review_queue ADD COLUMN IF NOT EXISTS notified_at   timestamptz;

-- 'resolved' = a two-sided resolution was applied to BOTH systems.
ALTER TABLE sync_review_queue DROP CONSTRAINT IF EXISTS sync_review_queue_status_check;
ALTER TABLE sync_review_queue ADD CONSTRAINT sync_review_queue_status_check
  CHECK (status IN ('open','approved','rejected','resolved'));
ALTER TABLE sync_review_queue DROP CONSTRAINT IF EXISTS sync_review_queue_winner_check;
ALTER TABLE sync_review_queue ADD CONSTRAINT sync_review_queue_winner_check
  CHECK (winner IS NULL OR winner IN ('clickup','portal'));
