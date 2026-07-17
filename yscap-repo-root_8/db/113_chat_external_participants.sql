-- =====================================================================
-- 113_chat_external_participants.sql — external EMAIL participants on a chat.
--
-- #75 (owner-directed 2026-07-15): staff can add an outside person (a
-- borrower's partner / secretary / attorney) to a conversation by EMAIL. They
-- are NOT a portal user — they receive each chat message as a branded email and
-- reply to a UNIQUE reply-to address that routes their reply back into the
-- thread (via the inbound webhook). They persist as an email participant even
-- after they later accept an invitation to sign up for a chat-only portal guest
-- account (email keeps flowing; guest_borrower_id is set on signup).
--
-- Idempotent: safe to run on every boot.
-- =====================================================================

CREATE TABLE IF NOT EXISTS conversation_external_participants (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id   uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    email             text NOT NULL,
    name              text,
    -- Opaque, unguessable token that IS the address secret: the participant's
    -- reply-to is chat+<reply_key>@<CHAT_REPLY_DOMAIN>. Rotatable by re-adding.
    reply_key         text NOT NULL UNIQUE,
    invited_by_kind   text,
    invited_by_id     uuid,
    -- Set once the guest accepts the "sign up for the chat" invite and gets a
    -- chat-only portal login. Email delivery continues regardless (owner rule).
    guest_borrower_id uuid REFERENCES borrowers(id) ON DELETE SET NULL,
    signed_up_at      timestamptz,
    -- Last message seq this address was emailed, so a reply or a resend can be
    -- idempotent / skip-echo without re-sending the whole thread.
    last_emailed_seq  bigint NOT NULL DEFAULT 0,
    added_at          timestamptz NOT NULL DEFAULT now(),
    removed_at        timestamptz,          -- soft-remove keeps the audit trail
    UNIQUE (conversation_id, email)
);
CREATE INDEX IF NOT EXISTS idx_conv_external_conv ON conversation_external_participants(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conv_external_replykey ON conversation_external_participants(reply_key) WHERE removed_at IS NULL;

-- An external participant's inbound email reply is posted as a first-class chat
-- message with sender_kind='external' (sender_id = the participant id). Widen
-- the messages sender_kind CHECK to allow it. Drop-then-add is idempotent: the
-- base constraint is the schema's inline (auto-named) messages_sender_kind_check.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_sender_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_sender_kind_check
  CHECK (sender_kind IN ('borrower','staff','system','external'));
