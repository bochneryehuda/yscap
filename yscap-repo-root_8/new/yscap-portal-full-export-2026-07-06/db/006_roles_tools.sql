-- ============================================================================
--  006 — Super-admin role + tool-backed borrower tasks
--  * Adds 'super_admin' to the staff role hierarchy (full visibility/control).
--  * Adds tool_key + tool_payload so a checklist item can be completed IN the
--    portal by the borrower using an embedded tool (Rehab Budget / Track Record)
--    instead of a plain file upload. Completing the tool satisfies the task.
--  Idempotent: safe to re-run.
-- ============================================================================

-- ---- 1. super_admin role ---------------------------------------------------
ALTER TABLE staff_users DROP CONSTRAINT IF EXISTS staff_users_role_check;
ALTER TABLE staff_users ADD  CONSTRAINT staff_users_role_check
  CHECK (role IN ('super_admin','admin','loan_officer','processor','underwriter'));

-- ---- 2. tool columns -------------------------------------------------------
ALTER TABLE checklist_templates
  ADD COLUMN IF NOT EXISTS tool_key text;        -- 'rehab_budget' | 'track_record' | NULL

ALTER TABLE checklist_items
  ADD COLUMN IF NOT EXISTS tool_key     text,
  ADD COLUMN IF NOT EXISTS tool_payload jsonb;   -- borrower-submitted tool output

-- ---- 3. mark the tool-backed RTL tasks -------------------------------------
-- Rehab Budget tool produces BOTH the construction budget AND the Scope of Work.
UPDATE checklist_templates SET tool_key='rehab_budget', item_kind='task'
  WHERE code IN ('rtl_p1_budget','rtl_p3_sow1');
-- Track Record tool produces the REO / experience sheet.
UPDATE checklist_templates SET tool_key='track_record', item_kind='task'
  WHERE code IN ('rtl_p3_reo');

-- ---- 4. back-fill any already-generated items ------------------------------
UPDATE checklist_items ci
   SET tool_key = t.tool_key, item_kind = 'task'
  FROM checklist_templates t
 WHERE ci.template_id = t.id
   AND t.tool_key IS NOT NULL
   AND ci.tool_key IS DISTINCT FROM t.tool_key;

-- ---- 5. index for tool tasks ----------------------------------------------
CREATE INDEX IF NOT EXISTS idx_checklist_items_tool
  ON checklist_items (application_id, tool_key) WHERE tool_key IS NOT NULL;
