-- 481_reassert_assignee_trigger.sql — re-assert the application_assignees
-- pointer-sync trigger AFTER db/476, so a boot-replay that skips db/392 can no
-- longer break the closer / draw-coordinator workflow.
--
-- THE BUG (found via CI test-db, reproduced deterministically):
--   • db/392 re-adds `application_assignees_role_check` UNCONDITIONALLY every boot
--     with the NARROW list ('loan_officer','processor','closer','draw_coordinator')
--     and THEN, later in the SAME file, re-creates the sync_primary_assignee
--     function + trigger with the closer block.
--   • db/476 (Phase 3 / TPO) widens that SAME-named constraint to also allow
--     'account_executive' / 'account_manager' (our LO/processor on a TPO file).
--   • Once an account_executive/account_manager assignee ROW exists, db/392's
--     boot-replay of the NARROW constraint ADD fails ("violated by some row").
--     migrate-boot's superseded-constraint detection recognizes it (db/476 re-adds
--     the same name at a higher number) and SKIPS THE REST OF db/392 quietly — so
--     db/392's function+trigger re-creation (statement 3) never runs on that boot.
--   • sync_primary_assignee therefore reverts to db/103's older 2-block version
--     (loan_officer + processor only, no closer), and the trigger reverts to firing
--     on `UPDATE OF loan_officer_id, processor_id` only. Setting/changing
--     applications.closer_id then silently syncs NOTHING — breaking the closing
--     workflow's primary-closer routing (and, downstream, the whole file-role
--     contacts feature). draw_coordinator has no pointer, so it is unaffected.
--
-- THE FIX (the db/375/db/334 pattern — a later migration re-asserts the converged
-- state): this file runs numerically LAST, has NO data-dependent statement (a pure
-- CREATE OR REPLACE FUNCTION + DROP/CREATE TRIGGER, which cannot fail on any row),
-- and re-installs db/392's full 3-block function + the closer_id trigger. So even
-- on a boot where db/392's own re-creation was skipped, the correct trigger is
-- restored. The constraint itself is already left WIDE by db/476 (its wide re-add
-- can never fail on data), so only the trigger needed repair. The function body
-- below is byte-for-byte db/392's (keep them in lock-step; a future migration that
-- extends the trigger further must be numbered above this file and re-assert its
-- own version). Fully idempotent.

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
