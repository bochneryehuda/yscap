-- Idempotency key for portal-created track_records (owner-directed, 2026-07-12).
--
-- The Track Record tool autosaves each line as you edit it. A create must be
-- idempotent: a repeated POST for the SAME logical line — an autosave retry, a
-- second browser tab, a network replay, a double-tap — must UPDATE the one row
-- instead of inserting a duplicate. This is the belt-and-suspenders behind the
-- tool's client-side "create once, then adopt the server id" fix: even if the
-- client re-issues the create, the server collapses it onto a single row.
--
-- Mirrors the proven chat-message contract (db/035: messages.client_msg_id +
-- uq_messages_client_msg + ON CONFLICT). The client sends one stable
-- client_row_id per new line (its local temp id). Rows without a key — ClickUp
-- inbound and any legacy/portal row created before this — keep plain-insert
-- behavior, because the partial unique index ignores NULLs (so this never
-- collides existing data and needs no backfill).
ALTER TABLE track_records ADD COLUMN IF NOT EXISTS client_row_id text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_track_records_client_row
  ON track_records (borrower_id, client_row_id) WHERE client_row_id IS NOT NULL;
