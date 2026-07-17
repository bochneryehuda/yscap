-- #144 — ANY chat member's email reply lands back IN THE CHAT (owner-directed
-- 2026-07-16). An internal (staff) or borrower member who replies to their chat
-- notification email should have that reply post straight into the conversation
-- as themselves — exactly like an external guest already does (#75).
--
-- Root cause it fixes: only conversation_external_participants carried a
-- per-conversation reply_key (the chat+<key>@ address secret that routes an email
-- reply back into the thread). Internal/borrower members had none, so their chat
-- digest email fell back to the file+ inbox reply-to and their reply FORWARDED to
-- the assignees as email instead of posting into the chat. Giving every member
-- its own unguessable per-conversation reply key closes the gap at the root: the
-- reply-routing identity now exists for every participant family, not just guests.
--
-- The key is the address secret, like the external one: a v4 uuid's 122 bits of
-- entropy, hex-encoded (url/email-safe), unique, minted by DEFAULT for every
-- FUTURE member row and backfilled onto every EXISTING one. A removed member's
-- key stops resolving (the inbound resolver requires removed_at IS NULL), which is
-- the SAME boundary the live chat uses for access — so email-reply access can
-- never outlive chat membership.

ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS reply_key text;

-- Backfill every existing member (idempotent — only rows still missing a key).
UPDATE conversation_members
   SET reply_key = replace(gen_random_uuid()::text, '-', '')
 WHERE reply_key IS NULL;

-- Every future member row gets one automatically (the postMessage upsert and
-- ensureMember insert never set it explicitly, so the DEFAULT owns it).
ALTER TABLE conversation_members
  ALTER COLUMN reply_key SET DEFAULT replace(gen_random_uuid()::text, '-', '');

-- Looked up directly on inbound mail — one member per key.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_members_reply_key_uidx
  ON conversation_members(reply_key);
