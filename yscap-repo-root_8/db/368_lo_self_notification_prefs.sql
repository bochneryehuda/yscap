-- 368_lo_self_notification_prefs.sql — the loan-officer's OWN inbox.
--
-- Companion to lo_notification_prefs (which controls what BORROWERS on the
-- LO's files receive). This set controls what THE LO THEMSELVES receives —
-- so they can dial down their own inbox without touching what goes to the
-- borrower.
--
-- Tables:
--   lo_self_notification_prefs   — per-notif channel + frequency
--   lo_self_delivery_rules       — one row per LO: master mode, vacation,
--                                   quiet hours, weekend hold, presence-aware,
--                                   batching, digests, volume cap
--   lo_muted_files               — silence a specific file (temp or forever)
--   lo_starred_files             — priority-follow a specific file
--   lo_batched_emails            — held emails waiting for a bundle window
--
-- All idempotent.

CREATE TABLE IF NOT EXISTS lo_self_notification_prefs (
  staff_id     uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  notif_key    text NOT NULL,
  -- Where the LO wants this notification:
  --   'both'  — email + in-app  (default)
  --   'email' — email only
  --   'inapp' — in-app only (no email)
  --   'off'   — silently drop (still respects FORCED overrides at the gate)
  channel      text NOT NULL DEFAULT 'both' CHECK (channel IN ('both','email','inapp','off')),
  -- When to deliver an EMAIL if channel includes email:
  --   'instant' — send now
  --   'hourly'  — bundle into an hourly digest
  --   'daily'   — bundle into the daily digest
  --   'weekly'  — bundle into the weekly digest
  frequency    text NOT NULL DEFAULT 'instant' CHECK (frequency IN ('instant','hourly','daily','weekly')),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES staff_users(id),
  PRIMARY KEY (staff_id, notif_key)
);
CREATE INDEX IF NOT EXISTS ix_lo_self_notif_prefs_staff
  ON lo_self_notification_prefs(staff_id);

CREATE TABLE IF NOT EXISTS lo_self_delivery_rules (
  staff_id                    uuid PRIMARY KEY REFERENCES staff_users(id) ON DELETE CASCADE,
  -- Master switch for how email leaves the system for THIS LO:
  --   'instant'     — send each email as it fires (default)
  --   'batched'     — bundle non-urgent into an every-N-minutes digest
  --   'digest_only' — only the scheduled daily/weekly digests, no live emails
  --   'off'         — no email at all (in-app still on)
  master_mode                 text NOT NULL DEFAULT 'instant'
    CHECK (master_mode IN ('instant','batched','digest_only','off')),
  batch_minutes               int  NOT NULL DEFAULT 60,   -- 15/30/60/240 typical
  daily_digest_enabled        boolean NOT NULL DEFAULT true,
  daily_digest_hour           int  NOT NULL DEFAULT 8,    -- 0-23 local tz
  weekly_digest_enabled       boolean NOT NULL DEFAULT true,
  weekly_digest_dow           int  NOT NULL DEFAULT 1,    -- 1=Mon..7=Sun
  -- Vacation mode: NULLable start/end — while `now()` is inside the window,
  -- all non-forced email is deferred to the end of vacation (or dropped if
  -- `vacation_drop=true`).
  vacation_from               timestamptz,
  vacation_to                 timestamptz,
  vacation_drop               boolean NOT NULL DEFAULT false,
  vacation_note               text,
  -- Weekend hold: Sat/Sun non-urgent → Monday morning batch.
  weekend_hold                boolean NOT NULL DEFAULT false,
  -- Quiet hours + workdays (same shape as lo_notification_rules).
  timezone                    text NOT NULL DEFAULT 'America/New_York',
  quiet_hours_start           text,   -- 'HH:MM'
  quiet_hours_end             text,
  work_days_mask              int NOT NULL DEFAULT 127,   -- bit Mon=1..Sun=64
  -- Presence-aware: skip email if the LO has been active in the portal in
  -- the last N minutes (0 = off).
  presence_hold_minutes       int NOT NULL DEFAULT 0,
  -- Suppress the email if the in-app row has been READ before the email
  -- would have gone out (defer-and-check pattern).
  suppress_email_if_read      boolean NOT NULL DEFAULT false,
  -- If the SAME FILE fires ≥N events in Y minutes, bundle them.
  per_file_batch_minutes      int NOT NULL DEFAULT 0,
  per_file_batch_threshold    int NOT NULL DEFAULT 3,
  -- Volume cap: hard ceiling on emails/hour (surplus batched into next window).
  volume_cap_per_hour         int NOT NULL DEFAULT 0,     -- 0 = no cap
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lo_muted_files (
  staff_id       uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  muted_at       timestamptz NOT NULL DEFAULT now(),
  mute_until     timestamptz,   -- NULL = until explicitly unmuted
  note           text,
  PRIMARY KEY (staff_id, application_id)
);
CREATE INDEX IF NOT EXISTS ix_lo_muted_files_staff
  ON lo_muted_files(staff_id);

CREATE TABLE IF NOT EXISTS lo_starred_files (
  staff_id       uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  starred_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, application_id)
);
CREATE INDEX IF NOT EXISTS ix_lo_starred_files_staff
  ON lo_starred_files(staff_id);

-- Batched-email queue: non-urgent email held until the next batch window
-- (master_mode=batched, weekend_hold, vacation_from<now<vacation_to,
--  quiet_hours, volume_cap overflow, per_file_batch). The worker drains
-- pending rows whose release_at has passed, groups by (staff_id, batch_key),
-- and sends a single "N updates on your files" digest email.
CREATE TABLE IF NOT EXISTS lo_batched_emails (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id              uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  notification_id       uuid REFERENCES notifications(id) ON DELETE CASCADE,
  notif_key             text,
  notif_type            text,
  application_id        uuid REFERENCES applications(id) ON DELETE CASCADE,
  subject               text,
  body_preview          text,
  opts                  jsonb NOT NULL,
  batch_key             text NOT NULL DEFAULT 'default',   -- 'digest' | 'file:<uuid>' | 'daily' | 'weekly'
  release_at            timestamptz NOT NULL,
  released_at           timestamptz,
  status                text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','released','dropped'))
);
CREATE INDEX IF NOT EXISTS ix_lo_batched_release
  ON lo_batched_emails(release_at) WHERE status='pending';
CREATE INDEX IF NOT EXISTS ix_lo_batched_staff
  ON lo_batched_emails(staff_id, status);
