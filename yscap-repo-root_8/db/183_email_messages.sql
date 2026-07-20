-- 183_email_messages.sql — the file EMAIL CENTER store (owner-directed 2026-07-20).
--
-- Until now the exact email that went out was rendered on the fly at send time
-- (src/lib/notify.js `_emailRow` and src/lib/email/catalog.js `deliver`) and
-- thrown away — only a plain title/body lived on the `notifications` row, and an
-- inbound reply's body was retrieved transiently and never persisted. The owner
-- wants a Gmail/Outlook-style history on every file: the full designed email
-- body, exactly whom it went to and when, the delivery status (so a failed send
-- can be troubleshot), the inbound replies, and the ability to reply — plus a
-- global mailbox for admins / loan officers across all their files, and the
-- prior history backdated in.
--
-- `email_messages` is that single store. Going FORWARD every outbound send and
-- every inbound reply is captured here with its FULL rendered body. HISTORICAL
-- notifications (predating this feature) are mirrored in as lightweight rows by a
-- boot backfill (src/lib/email-log.js `backfillEmailHistoryOnce`) and their body
-- is re-rendered on demand from the linked `notifications` row — so old files get
-- their history without storing tens of thousands of large bodies at once.
--
-- Access is staff-only and file-scoped (the routes reuse the same VISIBLE_OFFICERS
-- scope as every other file read). Persisting an inbound reply's body here is the
-- whole point of the feature (an audit trail in OUR access-controlled DB) — it is
-- NOT the same as the "never LOG a body to the console" rule in file-inbox.js,
-- which still holds. Idempotent.

CREATE TABLE IF NOT EXISTS email_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The file this email belongs to. NULL = a non-file email (auth / invite /
  -- security) — still captured so the global mailbox can audit EVERYTHING, just
  -- not shown under any one file.
  application_id      uuid REFERENCES applications(id) ON DELETE CASCADE,
  -- Conversation grouping: normalized subject within a file (Re:/Fwd: + the
  -- "· loan# · street" subject tag stripped). Inbound replies share it so a
  -- thread reads top-to-bottom like an email client.
  thread_key          text,
  direction           text NOT NULL DEFAULT 'outbound'
                      CHECK (direction IN ('outbound','inbound')),
  -- Back-links so a live send can be re-marked and the backfill can dedupe.
  notification_id     uuid,                 -- outbound: the notifications row (nullable)
  inbound_id          bigint,               -- inbound: the inbound_file_emails row (nullable)
  msg_type            text,                 -- notification type / catalog kind / 'staff_reply' / 'inbound_reply'
  category            text,                 -- coarse bucket for filtering (messages/documents/status/…)
  -- Sender + recipients. to_emails is an array of {email,name?,kind?} objects.
  from_email          text,
  from_name           text,
  to_emails           jsonb NOT NULL DEFAULT '[]'::jsonb,
  cc_emails           jsonb,
  reply_to            text,
  subject             text,
  preview             text,                 -- short snippet for the list row
  body_html           text,                 -- the FULL rendered email (NULL for lazily-rendered historical rows)
  body_text           text,
  recipient_kind      text,                 -- staff | borrower | external | mixed
  audience            text,                 -- staff | borrower (how it was rendered)
  provider            text,
  provider_message_id text,
  -- Delivery / processing status. Outbound: sent | skipped | error. Inbound:
  -- received | forwarded | auto_reply | no_recipients | chat_posted | … (mirrors
  -- inbound_file_emails.status).
  status              text,
  error               text,
  attachments         jsonb,                -- [{filename,contentType,size}] — metadata only, never bytes
  meta                jsonb,                -- subjectTag, kicker, forwarded_to, badge, …
  reconstructed       boolean NOT NULL DEFAULT false,   -- true = backfilled historical row (body rendered on demand)
  occurred_at         timestamptz NOT NULL DEFAULT now(),  -- when it was sent / received
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Per-file history, newest first (the file's Email Center tab).
CREATE INDEX IF NOT EXISTS idx_email_msgs_app
  ON email_messages (application_id, occurred_at DESC) WHERE application_id IS NOT NULL;
-- Thread read (a conversation top-to-bottom).
CREATE INDEX IF NOT EXISTS idx_email_msgs_thread
  ON email_messages (thread_key, occurred_at) WHERE thread_key IS NOT NULL;
-- Global mailbox (all files, newest first).
CREATE INDEX IF NOT EXISTS idx_email_msgs_recent
  ON email_messages (occurred_at DESC);
-- Troubleshooting filter (failed / skipped).
CREATE INDEX IF NOT EXISTS idx_email_msgs_status
  ON email_messages (status);
-- Idempotency: a live send updates its row by notification_id; the backfill
-- inserts historical rows ON CONFLICT DO NOTHING — so a notification is mirrored
-- at most once and a re-mark never duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_msgs_notification
  ON email_messages (notification_id) WHERE notification_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_msgs_inbound
  ON email_messages (inbound_id) WHERE inbound_id IS NOT NULL;
