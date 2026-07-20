-- 183_sent_emails.sql  (owner-directed 2026-07-20 — a real "open the whole email" center)
-- The notifications table stores only the plain title/body of a message. To let staff OPEN a sent
-- notification and see the ENTIRE email exactly as delivered — the full branded HTML design, the real
-- recipients, the reply-to, and any attachments — we persist the rendered email here at send time (the one
-- chokepoint src/lib/notify.js `_emailRow`). Go-forward only: emails sent before this ships have no captured
-- copy (the reading pane falls back to the plain body). Scoped to FILE emails (application_id set); system
-- emails aren't captured. Rows cascade-delete with the notification / application.
CREATE TABLE IF NOT EXISTS sent_emails (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id  uuid REFERENCES notifications(id) ON DELETE CASCADE,
  application_id   uuid REFERENCES applications(id) ON DELETE CASCADE,
  audience         text,                                  -- 'staff' | 'borrower'
  recipient_kind   text,
  subject          text,
  from_email       text,
  to_emails        text[],                                -- the actual recipient address(es)
  reply_to         text,
  html             text,                                  -- the full rendered branded email (the design)
  body_text        text,                                  -- the plaintext fallback
  attachments      jsonb NOT NULL DEFAULT '[]'::jsonb,    -- [{filename, content_type, size, storage_provider, storage_ref}]
  status           text,                                  -- mirrors the notification's email_status at send time
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sent_emails_notif ON sent_emails (notification_id);
CREATE INDEX IF NOT EXISTS idx_sent_emails_app   ON sent_emails (application_id);
