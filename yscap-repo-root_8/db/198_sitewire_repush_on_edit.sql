-- Bidirectional Phase 3 — PILOT-side edits flow back to Sitewire (owner-directed 2026-07-20).
--
-- After the birth push, a PILOT-side edit to a re-pushable PROPERTY field (the address a coordinator
-- fixed, a unit count, the property/loan/rehab type, or the borrower's email) silently did NOT reach
-- Sitewire until someone manually re-pushed. This mirrors the existing trg_reopen_on_budget_change:
-- a trigger ENQUEUES a guarded re-push (op='push_file') when one of those fields changes on a MANAGED
-- file. The actual Sitewire write still goes through the guarded orchestrator.pushFile (property update
-- + budget no-op + read-after-write) when the worker drains it — NEVER a raw write from the trigger.
--
-- The BUDGET is intentionally NOT a trigger field: a rehab_budget change goes through the reallocation
-- / re-registration flow, which already enqueues its own push at the right moment. Idempotent.

-- Coalescing enqueue (mirrors src/sitewire/enqueue.js): merge into an existing queued push, else insert.
-- NOTE (audit L1): this INSERT runs INSIDE the user's edit transaction, so the sync_queue write must
-- never be able to fail on a valid managed-file edit. That holds today (no UNIQUE index on sync_queue;
-- target='sitewire'/direction='push'/status='queued' are all permitted by db/131). If a future migration
-- ever tightens sync_queue's CHECK constraints, wrap this in an exception handler first.
CREATE OR REPLACE FUNCTION sitewire_enqueue_repush(p_app uuid) RETURNS void AS $$
BEGIN
  UPDATE sync_queue SET updated_at = now()
    WHERE target = 'sitewire' AND direction = 'push' AND entity_type = 'application'
      AND entity_id = p_app AND op = 'push_file' AND status = 'queued';
  IF NOT FOUND THEN
    INSERT INTO sync_queue (entity_type, entity_id, target, direction, op, status, payload, run_after)
    VALUES ('application', p_app, 'sitewire', 'push', 'push_file', 'queued', '{}'::jsonb, now());
  END IF;
END;
$$ LANGUAGE plpgsql;

-- A managed file's re-pushable property fields changed → enqueue a re-push.
CREATE OR REPLACE FUNCTION sitewire_repush_on_app_change() RETURNS trigger AS $$
BEGIN
  IF (NEW.property_address IS DISTINCT FROM OLD.property_address
      OR NEW.units         IS DISTINCT FROM OLD.units
      OR NEW.property_type IS DISTINCT FROM OLD.property_type
      OR NEW.loan_type     IS DISTINCT FROM OLD.loan_type
      OR NEW.rehab_type    IS DISTINCT FROM OLD.rehab_type)
     AND EXISTS (SELECT 1 FROM sitewire_property_links l
                  WHERE l.application_id = NEW.id AND l.matched_by = 'created' AND l.sitewire_property_id IS NOT NULL)
  THEN
    PERFORM sitewire_enqueue_repush(NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sitewire_repush_on_app_change ON applications;
CREATE TRIGGER trg_sitewire_repush_on_app_change AFTER UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION sitewire_repush_on_app_change();

-- The borrower's email changed → re-assign in Sitewire (pushFile re-sends the borrower contact email).
CREATE OR REPLACE FUNCTION sitewire_repush_on_borrower_change() RETURNS trigger AS $$
DECLARE r record;
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    FOR r IN
      SELECT a.id FROM applications a
        JOIN sitewire_property_links l ON l.application_id = a.id AND l.matched_by = 'created' AND l.sitewire_property_id IS NOT NULL
       WHERE a.borrower_id = NEW.id AND a.deleted_at IS NULL
    LOOP
      PERFORM sitewire_enqueue_repush(r.id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sitewire_repush_on_borrower_change ON borrowers;
CREATE TRIGGER trg_sitewire_repush_on_borrower_change AFTER UPDATE ON borrowers
  FOR EACH ROW EXECUTE FUNCTION sitewire_repush_on_borrower_change();
