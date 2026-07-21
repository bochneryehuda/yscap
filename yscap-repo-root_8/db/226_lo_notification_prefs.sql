-- 226_lo_notification_prefs.sql — per loan-officer notification preferences and
-- a "draft queue" for notifications the LO wants to hand-review before they
-- reach the borrower. Two tables, idempotent.
--
-- lo_notification_prefs
--   The LO's per-notification switch: enabled (master on/off) + mode
--   (automatic | manual). Rows are OPTIONAL — absence = default (enabled,
--   automatic). This is the one place the notify chokepoint consults when
--   deciding whether to send, drop, or park a borrower-facing notification
--   about ANY file where this LO is the assigned loan officer.
--
-- lo_notification_drafts
--   When a notification's mode is 'manual', the notify chokepoint records the
--   whole rendered opts snapshot here instead of sending. The LO opens the
--   Notification Center → Drafts view (Gmail-style) and clicks Send / Discard.

CREATE TABLE IF NOT EXISTS lo_notification_prefs (
  staff_id     uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  notif_key    text NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  mode         text NOT NULL DEFAULT 'automatic' CHECK (mode IN ('automatic','manual')),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES staff_users(id),
  PRIMARY KEY (staff_id, notif_key)
);

CREATE INDEX IF NOT EXISTS ix_lo_notification_prefs_staff
  ON lo_notification_prefs(staff_id);

CREATE TABLE IF NOT EXISTS lo_notification_drafts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id              uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  notif_key             text NOT NULL,
  audience              text NOT NULL CHECK (audience IN ('borrower','staff','admin')),
  recipient_kind        text NOT NULL CHECK (recipient_kind IN ('borrower','staff')),
  recipient_id          uuid,
  recipient_label       text,
  application_id        uuid REFERENCES applications(id) ON DELETE CASCADE,
  notif_type            text NOT NULL,
  subject_preview       text,
  body_preview          text,
  opts                  jsonb NOT NULL,
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','discarded')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  sent_at               timestamptz,
  sent_notification_id  uuid,
  discarded_at          timestamptz,
  discarded_by          uuid REFERENCES staff_users(id)
);

CREATE INDEX IF NOT EXISTS ix_lo_notification_drafts_staff_status
  ON lo_notification_drafts(staff_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_lo_notification_drafts_app
  ON lo_notification_drafts(application_id) WHERE application_id IS NOT NULL;
