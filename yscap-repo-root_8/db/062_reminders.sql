-- 062_reminders.sql
-- (#93) Reminders + task-management behind the file's "Remind" button.
--
-- The old Remind button only fired a one-shot borrower email of outstanding
-- items. This adds a real, schedulable reminder/task system per file:
--   · a DUE date+time (reminders fire at that moment via the boot dispatcher),
--   · a flexible RECIPIENT list — any mix of the loan team (you, LO, processor,
--     underwriter), the borrower / co-borrower, or an ad-hoc email contact,
--   · a free-text message (with a "prefill outstanding conditions" helper),
--   · TASK mode with an assignee (who is responsible) + an optional lead-time
--     "remind before due" ping,
--   · a lifecycle: scheduled → sent, and done / dismissed / cancelled.
--
-- Recipients are stored RESOLVED (kind + id/email + display name) so the panel
-- keeps showing who was included even if the roster later changes. Borrower
-- recipients still flow through notify.notifyBorrower(), so the borrower's
-- notification preferences and note-buyer redaction rules continue to apply.

CREATE TABLE IF NOT EXISTS reminders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  kind              text NOT NULL DEFAULT 'reminder',       -- 'reminder' | 'task'
  title             text NOT NULL,
  body              text,
  due_at            timestamptz NOT NULL,
  remind_at         timestamptz,                            -- optional pre-due nudge (tasks)
  recipients        jsonb NOT NULL DEFAULT '[]'::jsonb,     -- [{kind,id,email,name,role}]
  assignee_staff_id uuid REFERENCES staff_users(id) ON DELETE SET NULL,   -- task owner
  status            text NOT NULL DEFAULT 'scheduled',      -- scheduled|sent|done|dismissed|cancelled
  fired_at          timestamptz,                            -- when the due notification went out
  reminded_at       timestamptz,                            -- when the pre-due nudge went out
  created_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  completed_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  completed_at      timestamptz,
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- The dispatcher scans for due, not-yet-fired scheduled rows every minute.
CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders (status, due_at)
  WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS reminders_app_idx ON reminders (application_id, due_at);
