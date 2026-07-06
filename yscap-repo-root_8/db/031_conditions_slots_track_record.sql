-- =====================================================================
-- 031_conditions_slots_track_record.sql
-- Borrower "Conditions" restructure:
--   (a) Document SLOTS — one condition can hold several coexisting documents,
--       each in its own named slot (re-uploading a slot supersedes only that
--       slot's previous version, never the other documents on the condition).
--   (b) tool_state — live autosave draft for tool-backed conditions (the
--       Scope of Work builder). The submitted snapshot stays in tool_payload.
--   (c) Ground-up placeholder condition: "Plans & permits (if applicable)",
--       generated only for ground-up construction files.
--   (d) Track records get the static Track Record tool's full shape:
--       property type, free-text entity, city-level verification status
--       (pending / docs / verified / limited), LO notes, and per-record
--       supporting documents.
-- Idempotent: safe to re-run on every boot.
-- =====================================================================

-- (a) slots: several current documents may coexist on one checklist item.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS slot_label text;

-- (b) live draft state for tool-backed conditions (Scope of Work autosave).
ALTER TABLE checklist_items
  ADD COLUMN IF NOT EXISTS tool_state jsonb;

-- (c) plans & permits placeholder for ground-up construction files.
--     generateChecklist() only materializes this template when the file is a
--     ground-up build (see src/routes/borrower.js).
INSERT INTO checklist_templates
  (code, label, borrower_label, scope, audience, item_kind, applies_loan_type,
   role_scope, phase, sort_order, hint, borrower_hint, is_gate, is_milestone)
SELECT 'rtl_p1_plans',
       'Plans & permits (ground-up) — if applicable',
       'Plans & permits (if applicable)',
       'application', 'both', 'document', 'rtl',
       'loan_officer', '1', 175,
       'Ground-up build: collect architectural plans and permits when the borrower has them',
       'Upload your architectural plans and permits if you already have them — if not yet, you can add them later.',
       false, false
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code = 'rtl_p1_plans');

-- (c2) the borrower sees ONE rehab budget / scope of work condition — the
--      tool-backed one. The later "Completed Scope of Work received" item is
--      an internal review checkpoint, never a second borrower ask.
UPDATE checklist_templates SET audience='staff'
 WHERE code='rtl_p3_sow1' AND audience <> 'staff';
UPDATE checklist_items ci SET audience='staff', updated_at=now()
  FROM checklist_templates t
 WHERE t.id=ci.template_id AND t.code='rtl_p3_sow1' AND ci.audience <> 'staff';

-- (d) track records: full static-tool shape + per-record documents.
ALTER TABLE track_records
  ADD COLUMN IF NOT EXISTS property_type       text,
  ADD COLUMN IF NOT EXISTS entity_name         text,
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS lo_notes            text;

-- Keep the richer status in step with the legacy boolean for existing rows.
UPDATE track_records SET verification_status = 'verified'
 WHERE is_verified = true AND verification_status = 'pending';

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS track_record_id uuid REFERENCES track_records(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_documents_track_record ON documents(track_record_id);
