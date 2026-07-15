-- 116_inbound_file_emails.sql — #68 per-file shared reply-to inbox.
--
-- When someone replies to a file notification email, the reply lands at
-- file+<applicationId>@<CHAT_REPLY_DOMAIN>, Resend posts an `email.received`
-- webhook to /api/inbound/file-email, and we fan the reply out to every active
-- assignee on that file. This table serves TWO purposes:
--   1. IDEMPOTENCY — `resend_email_id` is unique, so a webhook redelivery / a
--      dashboard replay of the same inbound email can never forward twice.
--   2. RECORD — a per-file history of inbound replies (who replied, subject, how
--      many staff it reached, final status), so the file's email history shows
--      the inbound side too (the outbound side is the notifications table, #80).
--
-- No email BODY is stored here (it's retrieved transiently from Resend at
-- forward time and never persisted) — only routing metadata. Idempotent.

CREATE TABLE IF NOT EXISTS inbound_file_emails (
  id               bigserial PRIMARY KEY,
  resend_email_id  text NOT NULL UNIQUE,               -- idempotency key (Resend email_id)
  application_id   uuid REFERENCES applications(id) ON DELETE SET NULL,
  from_email       text,
  subject          text,
  recipients       jsonb,                              -- raw event.data.to
  forwarded_to     jsonb,                              -- staff emails we forwarded to
  forwarded_count  integer NOT NULL DEFAULT 0,
  -- received | forwarded | no_recipients | unknown_app | retrieval_failed | error
  status           text NOT NULL DEFAULT 'received',
  received_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inbound_file_emails_app
  ON inbound_file_emails (application_id, received_at DESC);
