-- =====================================================================
-- 009_collab.sql — per-file collaboration channels + chat-to-task linking.
--
--   * messages.channel: 'borrower' (borrower <-> loan team, the existing
--     thread) or 'internal' (loan officer <-> processor <-> underwriter <->
--     admin; NEVER visible to the borrower).
--   * messages.checklist_item_id: a message can be promoted into a real task
--     on the application (checklist_items), keeping the conversation and the
--     work item linked.
-- Idempotent: safe to run on every boot.
-- =====================================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'borrower'
      CHECK (channel IN ('borrower','internal')),
  ADD COLUMN IF NOT EXISTS checklist_item_id uuid REFERENCES checklist_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_app_channel ON messages(application_id, channel, created_at);
