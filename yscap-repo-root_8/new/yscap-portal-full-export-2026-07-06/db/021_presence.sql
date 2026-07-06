-- 021_presence.sql — last-seen heartbeat so chat can show who is currently
-- online. Updated (throttled) by the auth middleware on any authenticated
-- request. Idempotent.
ALTER TABLE borrowers   ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
