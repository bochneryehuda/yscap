-- 295_trustpoint_routing.sql
-- Idempotent. Physical-draw workflow phase 1 (owner-directed 2026-07-24; blueprint
-- docs/TRUSTPOINT-PHYSICAL-DRAW-WORKFLOW-BLUEPRINT.md).
--
-- A note-buyer rule now names WHICH PLATFORM administers the file's draws:
--   'sitewire'   — today's default: PILOT pushes + operates the draw in Sitewire.
--   'trustpoint' — the note buyer's administrator (TrustPoint) runs approvals; the file
--                  STILL gets the full Sitewire setup (intake + mirror), but every submitted
--                  draw is hand-entered into TrustPoint by the draw coordinator (a workflow
--                  task) and PILOT mirrors TrustPoint's decisions back. (Blue Lake physical.)
--   'external'   — the legacy handled_externally semantics: PILOT does nothing for this
--                  partner's draws (no Sitewire push at all).
-- handled_externally is KEPT in lock-step (external ⇔ true) for back-compat readers; new
-- code reads draw_platform via src/sitewire/routing.js platformOf().

ALTER TABLE sitewire_inspection_rules ADD COLUMN IF NOT EXISTS draw_platform text NOT NULL DEFAULT 'sitewire';
-- Dormant per-rule markup knob (owner D9 2026-07-24): YS earns nothing on Blue Lake draws
-- today; a future owner-authorized markup becomes data entry, not a build. Unused by code yet.
ALTER TABLE sitewire_inspection_rules ADD COLUMN IF NOT EXISTS markup_cents bigint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_swrule_draw_platform') THEN
    ALTER TABLE sitewire_inspection_rules
      ADD CONSTRAINT chk_swrule_draw_platform CHECK (draw_platform IN ('sitewire','trustpoint','external'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_swrule_markup_cents') THEN
    ALTER TABLE sitewire_inspection_rules
      ADD CONSTRAINT chk_swrule_markup_cents CHECK (markup_cents IS NULL OR (markup_cents >= 0 AND markup_cents <= 10000000));
  END IF;
END $$;

-- Backfill: an existing handled-externally rule keeps its exact behavior under the new key.
-- Only rows still carrying the column default are moved, so a later admin choice always wins.
UPDATE sitewire_inspection_rules SET draw_platform = 'external'
 WHERE handled_externally AND draw_platform = 'sitewire';

-- Per-draw single-open stamp for the coordinator "enter this draw into TrustPoint" workflow
-- task: the reconcile hook claims it atomically (WHERE ... IS NULL) so overlapping polls can
-- never open two tasks for one draw. NULL = no import task ever opened for this draw.
ALTER TABLE sitewire_draws ADD COLUMN IF NOT EXISTS tp_import_task_opened_at timestamptz;

-- Widen the Workflow submission-type allow-list with the new coordinator hand-off.
-- db/212's inline CHECK is auto-named workflow_items_submission_type_check; replace it once
-- with a stably-named constraint carrying the full list + 'trustpoint_import'. Idempotent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_items_submission_type_check') THEN
    ALTER TABLE workflow_items DROP CONSTRAINT workflow_items_submission_type_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_workflow_submission_type') THEN
    ALTER TABLE workflow_items ADD CONSTRAINT chk_workflow_submission_type CHECK (submission_type IN (
      'loan_setup','processing','condition_clearing','clear_to_close',
      'closing','draw_setup','post_closing','exception','escalation','trustpoint_import'));
  END IF;
END $$;
