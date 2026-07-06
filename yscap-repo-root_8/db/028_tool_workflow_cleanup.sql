-- ============================================================================
-- 028 - Tool workflow cleanup
--   * Keep ONE borrower rehab-budget tool per file.
--   * Preserve already-submitted duplicate SOW tool data by copying it onto the
--     main rehab-budget task when the main task is blank.
--   * Add requested-experience counters to applications so a track-record task
--     can auto-clear when the borrower's profile already proves enough deals.
-- ============================================================================

-- The borrower submits one Rehab Budget / Scope of Work. The later SOW item is
-- an internal/appraiser checkpoint, not a second borrower tool.
UPDATE checklist_templates SET tool_key='rehab_budget', item_kind='task'
 WHERE code='rtl_p1_budget';
UPDATE checklist_templates SET tool_key=NULL, item_kind='document'
 WHERE code='rtl_p3_sow1';

-- If legacy rows already have both tool-backed items, preserve the submitted
-- Scope of Work payload on the main rehab-budget item when needed.
WITH sow AS (
  SELECT ci.application_id, ci.tool_payload, ci.status, ci.notes
    FROM checklist_items ci
    JOIN checklist_templates t ON t.id=ci.template_id
   WHERE t.code='rtl_p3_sow1' AND ci.tool_key='rehab_budget'
),
budget AS (
  SELECT ci.id, ci.application_id
    FROM checklist_items ci
    JOIN checklist_templates t ON t.id=ci.template_id
   WHERE t.code='rtl_p1_budget'
)
UPDATE checklist_items b
   SET tool_payload = COALESCE(b.tool_payload, sow.tool_payload),
       status = CASE WHEN b.status IN ('outstanding','requested') AND sow.status IN ('received','satisfied')
                     THEN sow.status ELSE b.status END,
       notes = COALESCE(b.notes, sow.notes),
       updated_at = now()
  FROM budget
  JOIN sow ON sow.application_id=budget.application_id
 WHERE b.id=budget.id;

-- Clear duplicate tool behavior from existing SOW rows. Keep the row as a
-- normal borrower-visible/staff-visible document/review checkpoint.
UPDATE checklist_items ci
   SET tool_key=NULL,
       item_kind='document',
       updated_at=now()
  FROM checklist_templates t
 WHERE t.id=ci.template_id
   AND t.code='rtl_p3_sow1'
   AND ci.tool_key='rehab_budget';

-- Requested experience entered on an application/registration. These are
-- compared against borrower-level track_records and can auto-clear the profile
-- experience task when already satisfied.
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS requested_exp_flips integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS requested_exp_holds integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS requested_exp_ground integer NOT NULL DEFAULT 0;
