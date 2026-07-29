-- 278_staff_last_active_and_batch_retry.sql
--
-- Two tiny follow-ups for the "For me" work in db/277:
--
--   (a) staff_users.last_active_at — a lightweight presence stamp so the LO's
--       "presence-aware" rule (skip live email when the LO was just in the
--       portal) actually has data to read. Updated best-effort by the
--       notification-center + a few hot staff routes.
--
--   (b) lo_batched_emails.attempts — a retry counter so a batched digest that
--       fails to send can be re-drained on a later tick instead of being
--       permanently stuck in status='released' with the underlying
--       notifications marked 'error'. Bounded to a small number of retries;
--       after that the row is 'dropped' and the LO still has the in-app rows.

ALTER TABLE staff_users
  ADD COLUMN IF NOT EXISTS last_active_at timestamptz;

CREATE INDEX IF NOT EXISTS ix_staff_last_active_at
  ON staff_users(last_active_at) WHERE last_active_at IS NOT NULL;

ALTER TABLE lo_batched_emails
  ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error text;
