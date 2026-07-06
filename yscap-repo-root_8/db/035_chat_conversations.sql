-- =====================================================================
-- 035_chat_conversations.sql — conversations become first-class objects.
--
-- Until now a "conversation" was the implicit pair (application_id, channel)
-- with channel ∈ {borrower, internal}. This promotes conversations to a real
-- table so a loan file can carry SEVERAL named chats — the borrower chat, the
-- internal Loan Team chat, an Officer ↔ Processor chat, and any number of
-- custom group chats — each with its own member roster, display name, emoji
-- and topic, all renameable and auditable.
--
-- Also added here (one migration so a single boot brings chat v3 up):
--   * messages.seq             — global monotonic sequence; watermark + cursor
--                                pagination need an ordered id and the existing
--                                uuid PK cannot be compared.
--   * conversation_members     — one row per member with the READ and
--                                DELIVERED watermarks (last_*_seq). Unread is
--                                denormalized and reset-from-truth on read.
--   * message_revisions        — append-only pre-edit bodies (compliance).
--   * chat_drafts              — per-user per-conversation composer drafts.
--   * chat_notification_jobs   — deferred email fallback ("email only if still
--                                unread after N minutes") + urgent re-notify.
--   * messages.reply_to / reply_snippet / kind / priority / client_msg_id.
--   * staff_users.status_*     — custom status with emoji + expiry.
--
-- Idempotent: safe to run on every boot.
-- =====================================================================

CREATE TABLE IF NOT EXISTS conversations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id  uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    kind            text NOT NULL CHECK (kind IN ('borrower','internal','lo_processor','custom')),
    name            text NOT NULL,
    emoji           text,
    topic           text,
    borrower_visible boolean NOT NULL DEFAULT false,
    created_by_kind text,
    created_by_id   uuid,
    archived_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_app ON conversations(application_id);
-- The three default chats exist at most once per file; custom chats are unlimited.
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_default
  ON conversations(application_id, kind) WHERE kind <> 'custom';

CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id     uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    member_kind         text NOT NULL CHECK (member_kind IN ('borrower','staff')),
    member_id           uuid NOT NULL,
    role_label          text,
    -- Watermarks: only ever move FORWARD (GREATEST on update). Per-message
    -- "Seen by X" is derived at render time (member.last_read_seq >= m.seq),
    -- so there are no per-message receipt rows to fan out.
    last_read_seq       bigint NOT NULL DEFAULT 0,
    last_delivered_seq  bigint NOT NULL DEFAULT 0,
    last_read_at        timestamptz,
    unread_count        int NOT NULL DEFAULT 0,
    muted_until         timestamptz,
    added_at            timestamptz NOT NULL DEFAULT now(),
    removed_at          timestamptz,          -- soft-remove keeps history/audit
    PRIMARY KEY (conversation_id, member_kind, member_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_members_member ON conversation_members(member_kind, member_id);

-- Global monotonic message sequence. uuid PKs can't be range-compared, and
-- created_at can collide; seq gives watermarks and cursor pagination a total
-- order that is cheap to index and safe to compare.
CREATE SEQUENCE IF NOT EXISTS messages_seq_counter;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS seq bigint;
ALTER TABLE messages ALTER COLUMN seq SET DEFAULT nextval('messages_seq_counter');
UPDATE messages SET seq = sub.rn
  FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
          FROM messages WHERE seq IS NULL) sub
 WHERE messages.id = sub.id AND messages.seq IS NULL;
SELECT setval('messages_seq_counter', COALESCE((SELECT max(seq) FROM messages), 0) + 1, false);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS client_msg_id text,          -- idempotent optimistic sends
  ADD COLUMN IF NOT EXISTS reply_to_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  -- Denormalized snapshot of the quoted message (sender, excerpt) so the quote
  -- block survives the original being edited or deleted.
  ADD COLUMN IF NOT EXISTS reply_snippet jsonb,
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'text'
      CHECK (kind IN ('text','system','milestone')),
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal'
      CHECK (priority IN ('normal','important','urgent'));

CREATE INDEX IF NOT EXISTS idx_messages_conv_seq ON messages(conversation_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_client_msg
  ON messages(conversation_id, client_msg_id) WHERE client_msg_id IS NOT NULL;

-- Append-only pre-edit history. The UI shows only the latest body + "(edited)";
-- examiners and discovery get the full trail.
CREATE TABLE IF NOT EXISTS message_revisions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id  uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    body        text NOT NULL,
    edited_by_kind text,
    edited_by_id   uuid,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_message_revisions_msg ON message_revisions(message_id);

-- Composer drafts, synced server-side so a half-written message survives a
-- tab close / device switch and shows as "Draft: …" in the conversation list.
CREATE TABLE IF NOT EXISTS chat_drafts (
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    member_kind     text NOT NULL,
    member_id       uuid NOT NULL,
    body            text NOT NULL,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, member_kind, member_id)
);

-- Deferred chat notifications: 'chat_email' = email fallback sent only if the
-- recipient is STILL unread past run_after (in-app + SSE are instant; email is
-- the ladder's last rung). 'urgent_renotify' = Teams-style urgent messages
-- re-ping every 2 minutes until the read watermark passes the message.
CREATE TABLE IF NOT EXISTS chat_notification_jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_kind        text NOT NULL CHECK (job_kind IN ('chat_email','urgent_renotify')),
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id      uuid REFERENCES messages(id) ON DELETE CASCADE,
    message_seq     bigint NOT NULL,
    recipient_kind  text NOT NULL,
    recipient_id    uuid NOT NULL,
    run_after       timestamptz NOT NULL,
    attempts        int NOT NULL DEFAULT 0,
    done_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_jobs_due ON chat_notification_jobs(run_after) WHERE done_at IS NULL;

-- Custom staff status ("In a closing until 4pm") shown in rosters and as an
-- interstitial above the composer when messaging that person.
ALTER TABLE staff_users
  ADD COLUMN IF NOT EXISTS status_emoji text,
  ADD COLUMN IF NOT EXISTS status_text  text,
  ADD COLUMN IF NOT EXISTS status_expires_at timestamptz;

-- ---------------------------------------------------------------------
-- Backfill: give every existing application its three default chats, point
-- historical messages at them by their legacy channel, and seed the member
-- rosters from the file's assignments. Watermarks start at the current max
-- (a clean slate — nothing shows as unread at cutover).
-- ---------------------------------------------------------------------
INSERT INTO conversations (application_id, kind, name, emoji, borrower_visible)
SELECT a.id, 'borrower',
       'Borrower — ' || COALESCE(NULLIF(trim(b.last_name), ''), NULLIF(trim(b.first_name), ''), 'Chat'),
       '💬', true
  FROM applications a JOIN borrowers b ON b.id = a.borrower_id
 WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.application_id = a.id AND c.kind = 'borrower');

INSERT INTO conversations (application_id, kind, name, emoji, borrower_visible)
SELECT a.id, 'internal', 'Loan Team', '🔒', false
  FROM applications a
 WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.application_id = a.id AND c.kind = 'internal');

INSERT INTO conversations (application_id, kind, name, emoji, borrower_visible)
SELECT a.id, 'lo_processor', 'Officer ↔ Processor', '🤝', false
  FROM applications a
 WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.application_id = a.id AND c.kind = 'lo_processor');

-- Historical messages: channel 'borrower' → the borrower chat, 'internal' →
-- the Loan Team chat. (lo_processor and custom chats have no history yet.)
UPDATE messages m SET conversation_id = c.id
  FROM conversations c
 WHERE m.conversation_id IS NULL
   AND m.application_id IS NOT NULL
   AND c.application_id = m.application_id
   AND c.kind = m.channel;

-- Member rosters. Borrower chat: borrower + co-borrower + LO + processor.
INSERT INTO conversation_members (conversation_id, member_kind, member_id, role_label)
SELECT c.id, 'borrower', a.borrower_id, 'Borrower'
  FROM conversations c JOIN applications a ON a.id = c.application_id
 WHERE c.kind = 'borrower' AND a.borrower_id IS NOT NULL
ON CONFLICT DO NOTHING;
INSERT INTO conversation_members (conversation_id, member_kind, member_id, role_label)
SELECT c.id, 'borrower', a.co_borrower_id, 'Co-borrower'
  FROM conversations c JOIN applications a ON a.id = c.application_id
 WHERE c.kind = 'borrower' AND a.co_borrower_id IS NOT NULL
ON CONFLICT DO NOTHING;
-- Staff (LO + processor) join every default chat on the file.
INSERT INTO conversation_members (conversation_id, member_kind, member_id, role_label)
SELECT c.id, 'staff', a.loan_officer_id, 'Loan Officer'
  FROM conversations c JOIN applications a ON a.id = c.application_id
 WHERE c.kind IN ('borrower','internal','lo_processor') AND a.loan_officer_id IS NOT NULL
ON CONFLICT DO NOTHING;
INSERT INTO conversation_members (conversation_id, member_kind, member_id, role_label)
SELECT c.id, 'staff', a.processor_id, 'Processor'
  FROM conversations c JOIN applications a ON a.id = c.application_id
 WHERE c.kind IN ('borrower','internal','lo_processor') AND a.processor_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Clean-slate watermarks: everything that exists today is considered read and
-- delivered, so cutover doesn't light up years-old messages as unread.
UPDATE conversation_members cm
   SET last_read_seq = q.max_seq, last_delivered_seq = q.max_seq, unread_count = 0
  FROM (SELECT conversation_id, COALESCE(max(seq), 0) AS max_seq FROM messages GROUP BY conversation_id) q
 WHERE q.conversation_id = cm.conversation_id
   AND cm.last_read_seq = 0 AND cm.last_read_at IS NULL;
