-- 103_application_assignees.sql — a loan file can carry MULTIPLE loan officers
-- and MULTIPLE processors: one PRIMARY per role (mirrored from the denormalized
-- applications.loan_officer_id / processor_id pointer) plus one or more full-access
-- ASSISTANTS. Assistants get the same file access as the primary (owner-directed
-- 2026-07-14). Idempotent. Backfills the existing primary for every file (previous
-- AND future) and keeps the primary row in lock-step with the pointer via a trigger
-- (mirrors the db/071/072 "catch every write path centrally" pattern), so the
-- ClickUp/SharePoint integrations — which read the single pointer — need no change.

CREATE TABLE IF NOT EXISTS application_assignees (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  staff_id       uuid NOT NULL REFERENCES staff_users(id),
  role           text NOT NULL CHECK (role IN ('loan_officer','processor')),
  is_primary     boolean NOT NULL DEFAULT false,
  added_by       uuid REFERENCES staff_users(id),
  added_at       timestamptz NOT NULL DEFAULT now(),
  removed_at     timestamptz
);

-- One ACTIVE row per (file, role, staffer): can't be added twice, and can't be
-- both the primary and an assistant of the same role on the same file.
CREATE UNIQUE INDEX IF NOT EXISTS uq_assignee_active
  ON application_assignees(application_id, role, staff_id)
  WHERE removed_at IS NULL;

-- At most ONE active primary per (file, role).
CREATE UNIQUE INDEX IF NOT EXISTS uq_assignee_one_primary
  ON application_assignees(application_id, role)
  WHERE is_primary = true AND removed_at IS NULL;

-- Hot paths: "is $me assigned to file X?" and "which files is $me on?"
CREATE INDEX IF NOT EXISTS idx_assignee_staff_active
  ON application_assignees(staff_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assignee_app_active
  ON application_assignees(application_id) WHERE removed_at IS NULL;

-- DETERMINISTIC BACKFILL — insert the existing primary LO + processor for EVERY
-- application (previous and future re-run alike). INSERT…SELECT…WHERE NOT EXISTS,
-- mirroring db/041/db/066. A NULL pointer produces no row.
INSERT INTO application_assignees (application_id, staff_id, role, is_primary, added_by)
SELECT a.id, a.loan_officer_id, 'loan_officer', true, NULL
  FROM applications a
 WHERE a.loan_officer_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM application_assignees aa
                    WHERE aa.application_id=a.id AND aa.role='loan_officer'
                      AND aa.staff_id=a.loan_officer_id AND aa.removed_at IS NULL);

INSERT INTO application_assignees (application_id, staff_id, role, is_primary, added_by)
SELECT a.id, a.processor_id, 'processor', true, NULL
  FROM applications a
 WHERE a.processor_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM application_assignees aa
                    WHERE aa.application_id=a.id AND aa.role='processor'
                      AND aa.staff_id=a.processor_id AND aa.removed_at IS NULL);

-- Keep the primary assignee row in lock-step with the denormalized pointer on
-- ANY write path (staff assign, file create, ClickUp inbound sync). Reassigning
-- the primary retires the old primary row and upserts the new one; ASSISTANTS are
-- never touched. Promote-in-place (UPDATE before INSERT…WHERE NOT EXISTS) so an
-- existing assistant being made primary doesn't collide with uq_assignee_active.
CREATE OR REPLACE FUNCTION sync_primary_assignee() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'INSERT') OR (NEW.loan_officer_id IS DISTINCT FROM OLD.loan_officer_id) THEN
    -- retire the current active primary if it is someone else
    UPDATE application_assignees SET is_primary=false, removed_at=now()
      WHERE application_id=NEW.id AND role='loan_officer' AND is_primary=true AND removed_at IS NULL
        AND staff_id IS DISTINCT FROM NEW.loan_officer_id;
    IF NEW.loan_officer_id IS NOT NULL THEN
      -- 1) promote the new primary's ACTIVE row (assistant or already-primary) if any
      UPDATE application_assignees SET is_primary=true
        WHERE application_id=NEW.id AND role='loan_officer' AND staff_id=NEW.loan_officer_id AND removed_at IS NULL;
      IF NOT FOUND THEN
        -- 2) else reactivate ONE previously-removed row (the newest) as primary
        UPDATE application_assignees SET is_primary=true, removed_at=NULL
          WHERE ctid = (SELECT ctid FROM application_assignees
                         WHERE application_id=NEW.id AND role='loan_officer' AND staff_id=NEW.loan_officer_id
                         ORDER BY added_at DESC LIMIT 1);
        IF NOT FOUND THEN
          -- 3) else there is no row at all: insert a fresh primary
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
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_primary_assignee ON applications;
CREATE TRIGGER trg_sync_primary_assignee
  AFTER INSERT OR UPDATE OF loan_officer_id, processor_id ON applications
  FOR EACH ROW EXECUTE FUNCTION sync_primary_assignee();
