-- ============================================================================
-- 127_esign_send_bookkeeping.sql — retry bookkeeping for the esign send drainer
--
-- The DocuSign send path is driven directly off esign_envelopes (which already
-- carries the send-once claim on send_claimed_at), NOT the ClickUp-coupled
-- sync_queue. These columns give the drainer the same durable retry semantics
-- the ClickUp queue has: bounded attempts, backoff scheduling, last error, and a
-- dead-letter stamp that pairs with a sync_review_queue row.
--
-- Additive/nullable; no behavior change. Idempotent.
-- ============================================================================

ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS attempts        integer NOT NULL DEFAULT 0;
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;   -- when the drainer may next try (backoff); NULL = eligible now
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS last_error      text;
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz;  -- exhausted retries → a sync_review_queue row was raised

-- Drainer scan: rows in 'error' (retryable, not dead) whose backoff has elapsed,
-- plus never-sent rows. The partial index keeps the scan cheap.
CREATE INDEX IF NOT EXISTS idx_esign_send_due
  ON esign_envelopes(next_attempt_at)
  WHERE envelope_id IS NULL AND dead_lettered_at IS NULL;
