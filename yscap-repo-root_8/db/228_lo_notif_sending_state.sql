-- 228_lo_notif_sending_state.sql — atomic claim state for the drafts drainer.
--
-- Adds 'sending' to the allowed status set + a claimed_at timestamp. The
-- worker (and the /send endpoint) flip status='pending' → 'sending' in a
-- SINGLE UPDATE guarded by status='pending' — that is the atomic claim; only
-- one caller can win. After the actual send call returns, the winner flips
-- 'sending' → 'sent' (success) or 'pending' (failure, so retry can pick it up).
--
-- Belt-and-suspenders: any 'sending' row older than 15 minutes is treated as
-- stranded (the process died mid-send) and eligible for reclaim.

-- Drop the old constraint (it excludes 'sending') and add a broader one.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lo_notification_drafts_status_check'
  ) THEN
    ALTER TABLE lo_notification_drafts DROP CONSTRAINT lo_notification_drafts_status_check;
  END IF;
END$$;

ALTER TABLE lo_notification_drafts
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lo_notif_drafts_status_ck2'
  ) THEN
    ALTER TABLE lo_notification_drafts
      ADD CONSTRAINT lo_notif_drafts_status_ck2
      CHECK (status IN ('pending','sending','sent','discarded'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS ix_lo_notif_drafts_sending_stale
  ON lo_notification_drafts(claimed_at)
  WHERE status='sending';
