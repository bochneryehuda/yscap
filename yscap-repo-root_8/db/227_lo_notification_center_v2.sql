-- 227_lo_notification_center_v2.sql — the "major product" expansion of the
-- loan-officer Notification Center. Adds:
--
--   · lo_notification_rules            — per-LO settings (quiet hours, work
--                                         days, learning mode, auto-send SLA,
--                                         digest defaults, undo-window sec)
--   · lo_notification_file_overrides   — per-file exceptions to the LO's
--                                         personal catalog choices ("VIP mode"
--                                         for one borrower, or "silence
--                                         everything on this deal")
--   · new columns on lo_notification_drafts:
--       scheduled_for   — send at (drainer picks it up)
--       snoozed_until   — hide from Pending until then
--       auto_send_at    — safety fallback: if untouched by then, send anyway
--       priority        — 'normal' | 'high' — surfaces at the top of Pending
--       tags            — free-form labels the LO can filter by
--       edited_subject  — LO's last-mile edits (persisted between opens)
--       edited_body
--       edited_note
--       compose_source  — 'auto' (parked by the gate) or 'compose' (LO wrote it)
--
-- All idempotent.

CREATE TABLE IF NOT EXISTS lo_notification_rules (
  staff_id                uuid PRIMARY KEY REFERENCES staff_users(id) ON DELETE CASCADE,
  timezone                text        NOT NULL DEFAULT 'America/New_York',
  -- Quiet hours: NULL/NULL = 24/7 sends. Times are H:MM in the LO's timezone.
  -- Outside the send window the gate routes to draft (not dropped) so the LO
  -- can review + hand-send anything they still want to go now, and the
  -- scheduler drains them when the window opens.
  quiet_hours_start       text,       -- '20:00' means quiet from 8pm
  quiet_hours_end         text,       -- '08:00' means quiet ends 8am
  -- Bitmask (Mon=1, Sun=64). 127 = every day (default), 62 = Mon–Fri.
  work_days_mask          int         NOT NULL DEFAULT 127,
  -- Learning mode: while this timestamp is in the future, EVERY non-forced
  -- notification is parked as a draft — so a new LO can watch what would go
  -- out and turn the noisy ones off before they leave shadow mode. Default
  -- NULL (off). The onboarding UI sets it to now()+72h on first opt-in.
  learning_mode_until     timestamptz,
  -- Safety ceiling. A draft still Pending after this many hours auto-sends,
  -- so a busy LO can't accidentally silence a real event forever. NULL = never.
  auto_send_after_hours   int         DEFAULT 48,
  -- Undo window (seconds) the UI shows the toast for after Send. Purely UX.
  undo_window_seconds     int         NOT NULL DEFAULT 8,
  -- LO's default when they type an ad-hoc "Compose new notification" — set
  -- 'draft' to always park their own compose (double-check yourself), 'send'
  -- to fire directly.
  compose_default         text        NOT NULL DEFAULT 'send' CHECK (compose_default IN ('send','draft')),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lo_notification_file_overrides (
  staff_id      uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  notif_key     text NOT NULL,           -- '*' means "all" (VIP / silence-all)
  enabled       boolean NOT NULL DEFAULT true,
  mode          text NOT NULL DEFAULT 'automatic' CHECK (mode IN ('automatic','manual')),
  note          text,                     -- why this override exists (LO's note to self)
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES staff_users(id),
  PRIMARY KEY (staff_id, application_id, notif_key)
);
CREATE INDEX IF NOT EXISTS ix_lo_notif_file_overrides_app
  ON lo_notification_file_overrides(application_id);

ALTER TABLE lo_notification_drafts
  ADD COLUMN IF NOT EXISTS scheduled_for   timestamptz,
  ADD COLUMN IF NOT EXISTS snoozed_until   timestamptz,
  ADD COLUMN IF NOT EXISTS auto_send_at    timestamptz,
  ADD COLUMN IF NOT EXISTS priority        text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS tags            text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS edited_subject  text,
  ADD COLUMN IF NOT EXISTS edited_body     text,
  ADD COLUMN IF NOT EXISTS edited_note     text,
  ADD COLUMN IF NOT EXISTS compose_source  text NOT NULL DEFAULT 'auto';

-- Ensure priority is one of the values the gate understands.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lo_notif_drafts_priority_ck'
  ) THEN
    ALTER TABLE lo_notification_drafts
      ADD CONSTRAINT lo_notif_drafts_priority_ck CHECK (priority IN ('normal','high'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lo_notif_drafts_compose_source_ck'
  ) THEN
    ALTER TABLE lo_notification_drafts
      ADD CONSTRAINT lo_notif_drafts_compose_source_ck CHECK (compose_source IN ('auto','compose'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS ix_lo_notif_drafts_scheduled
  ON lo_notification_drafts(scheduled_for)
  WHERE scheduled_for IS NOT NULL AND status='pending';
CREATE INDEX IF NOT EXISTS ix_lo_notif_drafts_auto_send
  ON lo_notification_drafts(auto_send_at)
  WHERE auto_send_at IS NOT NULL AND status='pending';
