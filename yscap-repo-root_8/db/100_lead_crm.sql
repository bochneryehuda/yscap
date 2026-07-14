-- Lead CRM buildout (owner-directed 2026-07-14): give loan officers a working
-- CRM on top of the marketing-lead capture — a per-lead activity/notes log and a
-- next-follow-up date, on top of the existing status + officer assignment.
-- Idempotent; applied on every boot.

-- A timestamped note / contact-log entry on a lead. Kept append-only (no edit)
-- so it doubles as the contact history a loan officer can scan.
CREATE TABLE IF NOT EXISTS lead_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  -- ON DELETE SET NULL: a note survives (keeps the contact history) if its author
  -- is ever hard-deleted; the reader LEFT JOINs staff_users and tolerates NULL.
  staff_id    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- Bring an already-created table (this migration ran before the SET NULL rule was
-- added) up to the intended FK behavior — idempotent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='lead_notes_staff_id_fkey' AND confdeltype <> 'n') THEN
    ALTER TABLE lead_notes DROP CONSTRAINT lead_notes_staff_id_fkey;
    ALTER TABLE lead_notes ADD CONSTRAINT lead_notes_staff_id_fkey
      FOREIGN KEY (staff_id) REFERENCES staff_users(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_lead_notes_lead ON lead_notes(lead_id, created_at DESC);

-- When to chase this lead next (the loan officer's follow-up reminder).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_follow_up date;
CREATE INDEX IF NOT EXISTS idx_leads_follow_up ON leads(next_follow_up) WHERE next_follow_up IS NOT NULL;
