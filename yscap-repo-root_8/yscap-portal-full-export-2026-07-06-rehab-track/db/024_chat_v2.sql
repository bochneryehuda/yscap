-- 024_chat_v2.sql — Slack-grade message controls: pin, edit, and soft-delete.
-- Soft delete keeps the row + audit trail; the body reads "[message removed]".
-- Idempotent.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS pinned    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pinned_by uuid,
  ADD COLUMN IF NOT EXISTS pinned_at timestamptz,
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(application_id, pinned) WHERE pinned;
