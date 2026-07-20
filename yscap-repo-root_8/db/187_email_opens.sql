-- 187_email_opens.sql — email OPEN tracking (owner-directed 2026-07-20).
--
-- "Did the borrower actually open the email?" Every per-recipient notification
-- email embeds an invisible 1x1 tracking pixel keyed on that recipient's
-- notification id (<img src="/e/o/<notificationId>.gif">). When their email
-- client loads the image, the public /e/o route stamps a row here — so the Email
-- Center can show, per recipient, whether/when they opened it and how many times.
--
-- Keyed on notification_id (one open row per recipient's notification). The FK to
-- notifications means a guessed/bogus id can't create a junk row, and opens
-- cascade-delete with the notification / file. Best-effort + approximate (image
-- blocking undercounts; some clients prefetch and over-count) — treat it as a
-- signal, not proof. Idempotent.

CREATE TABLE IF NOT EXISTS email_opens (
  notification_id uuid PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,
  first_opened_at timestamptz NOT NULL DEFAULT now(),
  last_opened_at  timestamptz NOT NULL DEFAULT now(),
  open_count      integer NOT NULL DEFAULT 1,
  first_ua        text,
  last_ip         text
);
