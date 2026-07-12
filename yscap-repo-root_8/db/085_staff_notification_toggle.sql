-- 085_staff_notification_toggle.sql — per-member notification switch (S1-01).
--
-- The team control center can turn a staff member's emailed notifications OFF
-- (e.g. someone on leave, or a role that shouldn't be paged). ON by default, so
-- every existing member keeps getting notifications exactly as before. When off,
-- src/lib/notify.js `notifyStaff` still writes the in-app notification row (so
-- nothing is lost and their in-app queue keeps working) but skips the email.
-- Idempotent; NOT NULL DEFAULT true backfills existing rows as enabled.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS notifications_enabled boolean NOT NULL DEFAULT true;
