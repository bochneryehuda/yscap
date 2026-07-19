-- #146 — a per-member SET of message seqs already emailed, alongside the existing
-- read/delivered watermarks (db/035). The two notification paths (immediate offline
-- send + deferred online digest) can email messages OUT OF ORDER — an offline
-- message with a higher seq can be emailed before an online-queued lower-seq message
-- fires its digest — so a single high-water seq is WRONG (it would mark the earlier,
-- un-emailed message as done and silently drop it). A set is order-independent:
--   • the immediate send adds the message's seq on success;
--   • the digest excludes any seq already in the set (never re-sends emailed text)
--     and adds every seq it covers after a successful send;
--   • a message never emailed (e.g. an immediate send that FAILED) stays out of the
--     set, so its deferred backstop job re-sends it — a transient error can't drop a
--     notification.
-- The set is pruned to seqs past the read watermark on every read, so it stays small
-- (only unread-but-emailed messages). '{}' default is correct for existing rows.

ALTER TABLE conversation_members
  ADD COLUMN IF NOT EXISTS emailed_seqs bigint[] NOT NULL DEFAULT '{}';
