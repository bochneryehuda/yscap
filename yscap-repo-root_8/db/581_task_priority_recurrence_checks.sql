-- ============================================================================
-- db/581 — task priority + recurrence + the CHECKs the table never had
--
-- WHAT THIS CHANGES, AND WHY (owner-directed 2026-08-18: "much more options
-- for the task and reminders section … build this up like crazy"). The
-- reminders table (db/062 — one table for both kinds, 'reminder' | 'task')
-- had no priority, no way to repeat, and no database-level guard on kind or
-- status (both were JS-enforced only, so a bad writer could store a value no
-- screen understands). This adds:
--   · priority  — high | normal | low (tasks sort by it after overdue-ness)
--   · recur     — how a row repeats: a completed recurring TASK spawns its
--                 next occurrence; a fired recurring REMINDER advances its
--                 own due date and stays scheduled (src/lib/reminders.js owns
--                 both mechanics — this is only the column)
--   · CHECK constraints on kind / status / priority / recur, dropped-then-
--     re-added so a later widening under the same name survives replays
--   · the touch-updated_at trigger the table never had (updated_at was
--     maintained by hand in update() and never set on create)
--
-- BACKFILL: none needed — the new columns default to the exact behavior every
-- existing row already has (normal priority, no recurrence), and every stored
-- kind/status value already conforms to the CHECKs (they mirror the JS
-- vocabulary reminders.js has enforced since db/062).
-- ============================================================================

ALTER TABLE reminders ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal';
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS recur text;

ALTER TABLE reminders DROP CONSTRAINT IF EXISTS reminders_kind_chk;
ALTER TABLE reminders ADD CONSTRAINT reminders_kind_chk
  CHECK (kind IN ('reminder','task'));

ALTER TABLE reminders DROP CONSTRAINT IF EXISTS reminders_status_chk;
ALTER TABLE reminders ADD CONSTRAINT reminders_status_chk
  CHECK (status IN ('scheduled','sent','done','dismissed','cancelled'));

ALTER TABLE reminders DROP CONSTRAINT IF EXISTS reminders_priority_chk;
ALTER TABLE reminders ADD CONSTRAINT reminders_priority_chk
  CHECK (priority IN ('high','normal','low'));

ALTER TABLE reminders DROP CONSTRAINT IF EXISTS reminders_recur_chk;
ALTER TABLE reminders ADD CONSTRAINT reminders_recur_chk
  CHECK (recur IS NULL OR recur IN ('daily','weekdays','weekly','biweekly','monthly'));

CREATE OR REPLACE FUNCTION reminders_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reminders_touch_updated ON reminders;
CREATE TRIGGER trg_reminders_touch_updated
  BEFORE UPDATE ON reminders
  FOR EACH ROW EXECUTE FUNCTION reminders_touch_updated_at();

-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself.
