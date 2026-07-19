-- 129_clear_auto_assigned_processor.sql — REMEDIATION (owner-directed 2026-07-19).
--
-- Symptom: Lisa Katz (role 'processor', but really the DRAW coordinator) kept
-- "popping up again and again" as the processor on files nobody ever picked her on.
--
-- Root cause (fixed in code this same change): the ClickUp inbound sync used to set
-- applications.processor_id from the ClickUp "Processor Email" custom field, applied
-- as a COALESCE-OVERWRITE on every pull (src/clickup/ingest.js). That field is
-- populated in ClickUp by defaults / automations / task duplication — NOT by an
-- explicit portal pick and NOT by our own push (which only writes the Processor
-- *users* field) — so it re-asserted a processor nobody chose, and clearing her in
-- the portal was futile because the next sync put her right back. Inbound processor
-- assignment is now severed; the processor is portal-owned, explicit-pick only.
--
-- This migration cleans up the damage the root already did on EXISTING files: it
-- clears processor_id where it points at Lisa Katz UNLESS an admin genuinely picked
-- her through the /assign endpoint (which leaves an 'assign_processor' audit row).
-- Deliberate picks are preserved; every automatic/mirrored assignment is cleared and
-- audited. The db/103 trigger (trg_sync_primary_assignee) fires on the processor_id
-- change and retires her primary application_assignees row in lock-step, so her file
-- ACCESS is revoked too — not just the label.
--
-- Idempotent: a second run finds nothing to clear (processor_id is already NULL) and
-- writes no further audit rows. Deterministic; scoped to Lisa only.

DO $$
DECLARE lisa uuid;
BEGIN
  SELECT id INTO lisa FROM staff_users WHERE lower(email) = 'lisa@yscapgroup.com' LIMIT 1;
  IF lisa IS NULL THEN
    RAISE NOTICE '[129] Lisa Katz (lisa@yscapgroup.com) not found in staff_users — nothing to clear';
    RETURN;
  END IF;

  -- Audit each file we are about to clear (before → after), so the cross-system
  -- assignment history stays complete and the change is reversible/reviewable.
  INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
  SELECT 'system', NULL, 'processor_cleared_auto_assigned', 'application', a.id,
         jsonb_build_object(
           'from', lisa,
           'to', NULL,
           'reason', 'processor was auto-assigned / ClickUp-mirrored, never explicitly picked in the portal (owner-directed 2026-07-19)')
    FROM applications a
   WHERE a.processor_id = lisa
     AND NOT EXISTS (
           SELECT 1 FROM audit_log al
            WHERE al.action = 'assign_processor'
              AND al.entity_type = 'application'
              AND al.entity_id = a.id
              AND lower(al.detail->>'to') = lower(lisa::text));

  -- Clear the pointer. The db/103 AFTER UPDATE trigger mirrors this into
  -- application_assignees (retires her primary processor row) automatically.
  UPDATE applications a
     SET processor_id = NULL, updated_at = now()
   WHERE a.processor_id = lisa
     AND NOT EXISTS (
           SELECT 1 FROM audit_log al
            WHERE al.action = 'assign_processor'
              AND al.entity_type = 'application'
              AND al.entity_id = a.id
              AND lower(al.detail->>'to') = lower(lisa::text));
END $$;
