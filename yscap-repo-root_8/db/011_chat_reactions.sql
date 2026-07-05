-- =====================================================================
-- 011_chat_reactions.sql — emoji reactions on messages (WhatsApp/Slack
-- style, toggle per person per emoji) + entity mentions: a message can
-- reference tasks, documents, applications/properties, borrowers — stored as
-- structured refs so the UI renders clickable chips. Idempotent.
-- =====================================================================

CREATE TABLE IF NOT EXISTS message_reactions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id  uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    actor_kind  text NOT NULL CHECK (actor_kind IN ('borrower','staff')),
    actor_id    uuid NOT NULL,
    emoji       text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (message_id, actor_kind, actor_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);

-- [{type:'task'|'document'|'application'|'borrower', id:'uuid', label:'…'}]
ALTER TABLE messages ADD COLUMN IF NOT EXISTS entity_refs jsonb;
