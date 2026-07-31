-- 392_file_role_contacts.sql — per-file CLOSER + DRAW COORDINATOR assignment
-- (owner-directed 2026-07-31: "For the file contacts right now [it defaults] to
-- draw coordinator and the closer … leave the default the way it is, but we
-- should also have an option to change this on the file. And when we change
-- this, when that draw coordinator or that closer is logging in they should see
-- their workflow with only files that is assigned to them … We should also be
-- able to select multiple people for the same role, like multiple closers.")
--
-- application_assignees (db/103) already models exactly this for loan_officer/
-- processor: one PRIMARY per role + any number of additional people, all
-- file-scoped. This migration extends the SAME table to 'closer' and
-- 'draw_coordinator':
--   • the role CHECK widens (superset — no existing row can fail it);
--   • the db/103 pointer-sync trigger grows a closer_id block, so the existing
--     applications.closer_id pointer (db/212 — what the workflow's closing
--     submit reads) and the primary closer assignee row can never drift;
--   • existing closer_id pointers are backfilled as primary closer rows
--     (previous AND future);
--   • draw_coordinator has NO denormalized pointer (none exists today) — the
--     assignee rows are the record.
-- The workflow queue (src/lib/workflow.js listQueue) and the submit resolver
-- (src/routes/staff.js workflow/submit) read these rows: a file's role items
-- route to the file's PRIMARY, are visible to every ACTIVE assignee of that
-- role on the file, and only fall back to the whole-role inbox when the file
-- has nobody assigned for that role. Idempotent.

-- 1) Widen the role CHECK (drop-then-add is the re-runnable pattern, db/359).
ALTER TABLE application_assignees DROP CONSTRAINT IF EXISTS application_assignees_role_check;
ALTER TABLE application_assignees
  ADD CONSTRAINT application_assignees_role_check
  CHECK (role IN ('loan_officer','processor','closer','draw_coordinator'));

-- 2) Backfill: every file's existing closer pointer becomes its primary closer
--    row (mirrors db/103's LO/processor backfill; re-runs are no-ops).
INSERT INTO application_assignees (application_id, staff_id, role, is_primary, added_by)
SELECT a.id, a.closer_id, 'closer', true, NULL
  FROM applications a
 WHERE a.closer_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM application_assignees aa
                    WHERE aa.application_id=a.id AND aa.role='closer'
                      AND aa.staff_id=a.closer_id AND aa.removed_at IS NULL);

-- 3) Extend the pointer-sync trigger with a closer_id block (same
--    promote-in-place shape as db/103 so an additional-closer → primary swap
--    never collides with uq_assignee_active). CREATE OR REPLACE + re-create the
--    trigger with closer_id in its UPDATE OF list.
CREATE OR REPLACE FUNCTION sync_primary_assignee() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'INSERT') OR (NEW.loan_officer_id IS DISTINCT FROM OLD.loan_officer_id) THEN
    UPDATE application_assignees SET is_primary=false, removed_at=now()
      WHERE application_id=NEW.id AND role='loan_officer' AND is_primary=true AND removed_at IS NULL
        AND staff_id IS DISTINCT FROM NEW.loan_officer_id;
    IF NEW.loan_officer_id IS NOT NULL THEN
      UPDATE application_assignees SET is_primary=true
        WHERE application_id=NEW.id AND role='loan_officer' AND staff_id=NEW.loan_officer_id AND removed_at IS NULL;
      IF NOT FOUND THEN
        UPDATE application_assignees SET is_primary=true, removed_at=NULL
          WHERE ctid = (SELECT ctid FROM application_assignees
                         WHERE application_id=NEW.id AND role='loan_officer' AND staff_id=NEW.loan_officer_id
                         ORDER BY added_at DESC LIMIT 1);
        IF NOT FOUND THEN
          INSERT INTO application_assignees (application_id, staff_id, role, is_primary)
          VALUES (NEW.id, NEW.loan_officer_id, 'loan_officer', true);
        END IF;
      END IF;
    END IF;
  END IF;
  IF (TG_OP = 'INSERT') OR (NEW.processor_id IS DISTINCT FROM OLD.processor_id) THEN
    UPDATE application_assignees SET is_primary=false, removed_at=now()
      WHERE application_id=NEW.id AND role='processor' AND is_primary=true AND removed_at IS NULL
        AND staff_id IS DISTINCT FROM NEW.processor_id;
    IF NEW.processor_id IS NOT NULL THEN
      UPDATE application_assignees SET is_primary=true
        WHERE application_id=NEW.id AND role='processor' AND staff_id=NEW.processor_id AND removed_at IS NULL;
      IF NOT FOUND THEN
        UPDATE application_assignees SET is_primary=true, removed_at=NULL
          WHERE ctid = (SELECT ctid FROM application_assignees
                         WHERE application_id=NEW.id AND role='processor' AND staff_id=NEW.processor_id
                         ORDER BY added_at DESC LIMIT 1);
        IF NOT FOUND THEN
          INSERT INTO application_assignees (application_id, staff_id, role, is_primary)
          VALUES (NEW.id, NEW.processor_id, 'processor', true);
        END IF;
      END IF;
    END IF;
  END IF;
  -- CLOSER (db/392): same lock-step for applications.closer_id, which the
  -- closing workflow submit reads as its sticky pointer.
  IF (TG_OP = 'INSERT') OR (NEW.closer_id IS DISTINCT FROM OLD.closer_id) THEN
    UPDATE application_assignees SET is_primary=false, removed_at=now()
      WHERE application_id=NEW.id AND role='closer' AND is_primary=true AND removed_at IS NULL
        AND staff_id IS DISTINCT FROM NEW.closer_id;
    IF NEW.closer_id IS NOT NULL THEN
      UPDATE application_assignees SET is_primary=true
        WHERE application_id=NEW.id AND role='closer' AND staff_id=NEW.closer_id AND removed_at IS NULL;
      IF NOT FOUND THEN
        UPDATE application_assignees SET is_primary=true, removed_at=NULL
          WHERE ctid = (SELECT ctid FROM application_assignees
                         WHERE application_id=NEW.id AND role='closer' AND staff_id=NEW.closer_id
                         ORDER BY added_at DESC LIMIT 1);
        IF NOT FOUND THEN
          INSERT INTO application_assignees (application_id, staff_id, role, is_primary)
          VALUES (NEW.id, NEW.closer_id, 'closer', true);
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_primary_assignee ON applications;
CREATE TRIGGER trg_sync_primary_assignee
  AFTER INSERT OR UPDATE OF loan_officer_id, processor_id, closer_id ON applications
  FOR EACH ROW EXECUTE FUNCTION sync_primary_assignee();
