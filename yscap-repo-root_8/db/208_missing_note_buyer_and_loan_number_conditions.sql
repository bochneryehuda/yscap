-- ============================================================================
-- 208 — Internal (staff-only) conditions for a MISSING note buyer and a MISSING
--       YS loan number (owner-directed 2026-07-20).
--
-- "If the note buyer is missing that should automatically come up as an internal
--  condition … to enter the note buyer. Also, if the loan number from the file is
--  missing, you should also add an internal condition for them to enter the loan
--  number …"
--
-- Both are RULE-DRIVEN Condition Center templates (mirrors db/191
-- cond_emd_corrfirst): scope='application', audience='staff' (INTERNAL — never
-- shown to or emailed to a borrower), item_kind='condition', auto_apply='rules'.
--   • cond_note_buyer_missing  attaches while applications.lender is blank
--     (rule field note_buyer is_empty) and retracts the moment a note buyer is set.
--   • cond_loan_number_missing attaches while applications.ys_loan_number is blank
--     (rule field ys_loan_number is_empty) and retracts once a loan number is set.
--
-- The engine (src/lib/conditions/engine.js) attaches an untouched 'auto' item
-- while the rule matches and DELETES it when the rule stops matching, so filling
-- the field anywhere (completeness panel, the condition's own inline entry, the
-- dedicated loan-number entry, or a ClickUp inbound pull) clears the condition on
-- the next evaluate — which already runs on the staff completeness edit
-- (staff.js completeFields) and on ClickUp ingest (clickup/ingest.js).
--
-- The rule fields note_buyer / ys_loan_number are registered in
-- src/lib/conditions/field-registry.js and exposed on engine.loadRuleContext ctx.
--
-- Previous AND future files: future files pick them up on every evaluate; the
-- backfills below attach them to EVERY existing OPEN file currently missing the
-- field (as engine-owned 'auto' items so they retract cleanly once filled).
-- Idempotent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) Templates.
-- ---------------------------------------------------------------------------
INSERT INTO checklist_templates
  (code, label, scope, audience, item_kind, role_scope, phase,
   sort_order, category, hint, tpr_exclude, is_required, auto_apply, rule_logic)
SELECT
  'cond_note_buyer_missing',
  'Note buyer missing — set the capital partner',
  'application', 'staff', 'condition', 'processor', '1',
  60, 'prior_to_approval',
  'No note buyer / capital partner is on this file yet. Pick the note buyer from the dropdown so the file can be mapped to the right capital partner (this also syncs to the ClickUp file list). Internal only — never shown to the borrower.',
  true, false,
  'rules',
  '{"combinator":"and","rules":[{"field":"note_buyer","operator":"is_empty"}]}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code = 'cond_note_buyer_missing');

INSERT INTO checklist_templates
  (code, label, scope, audience, item_kind, role_scope, phase,
   sort_order, category, hint, tpr_exclude, is_required, auto_apply, rule_logic)
SELECT
  'cond_loan_number_missing',
  'Loan number missing — enter the YS loan number',
  'application', 'staff', 'condition', 'processor', '1',
  61, 'prior_to_approval',
  'No YS loan number is on this file yet. Enter the loan number (it must start with "YSCAP"). It has to be unique — not used on another file here or on any other file in ClickUp. Internal only — never shown to the borrower.',
  true, false,
  'rules',
  '{"combinator":"and","rules":[{"field":"ys_loan_number","operator":"is_empty"}]}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code = 'cond_loan_number_missing');

-- Keep the definitions in lock-step if a prior boot seeded an earlier version
-- (idempotent re-assert of audience/kind/rule — never touches instances on files).
UPDATE checklist_templates
   SET audience = 'staff', item_kind = 'condition', auto_apply = 'rules', is_active = true, is_required = false,
       rule_logic = '{"combinator":"and","rules":[{"field":"note_buyer","operator":"is_empty"}]}'::jsonb
 WHERE code = 'cond_note_buyer_missing';

UPDATE checklist_templates
   SET audience = 'staff', item_kind = 'condition', auto_apply = 'rules', is_active = true, is_required = false,
       rule_logic = '{"combinator":"and","rules":[{"field":"ys_loan_number","operator":"is_empty"}]}'::jsonb
 WHERE code = 'cond_loan_number_missing';

-- ---------------------------------------------------------------------------
-- (2) Backfill onto every existing OPEN file currently missing the field.
--     Attached as engine-owned 'auto' items (origin_kind='auto', untouched) so
--     the engine retracts them once the field is filled — exactly what
--     evaluateApplication would create. Same OPEN status set as engine.OPEN_STATUSES
--     (db/191) so no phantom item lands on an intake-stage or funded/closed file.
-- ---------------------------------------------------------------------------
INSERT INTO checklist_items
  (template_id, scope, label, audience, item_kind, role_scope,
   phase, hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, tpr_exclude, created_by_kind, is_required, category,
   origin_kind, origin_detail, application_id)
SELECT t.id, t.scope, t.label, t.audience, t.item_kind,
       COALESCE(t.role_scope, 'processor'), t.phase, t.hint,
       COALESCE(t.is_gate, false), COALESCE(t.is_milestone, false),
       COALESCE(t.sort_order, 60), t.tool_key, t.clickup_field_id,
       COALESCE(t.tpr_exclude, true), 'system',
       COALESCE(t.is_required, true), t.category,
       'auto',
       jsonb_build_object('rule', 'Note buyer is missing', 'reason', 'backfill_208'),
       a.id
  FROM applications a
 CROSS JOIN checklist_templates t
 WHERE t.code = 'cond_note_buyer_missing'
   AND t.is_active = true
   AND a.deleted_at IS NULL
   AND a.status IN ('new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close')
   AND COALESCE(btrim(a.lender), '') = ''
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.application_id = a.id
                      AND ci.template_id = t.id);

INSERT INTO checklist_items
  (template_id, scope, label, audience, item_kind, role_scope,
   phase, hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, tpr_exclude, created_by_kind, is_required, category,
   origin_kind, origin_detail, application_id)
SELECT t.id, t.scope, t.label, t.audience, t.item_kind,
       COALESCE(t.role_scope, 'processor'), t.phase, t.hint,
       COALESCE(t.is_gate, false), COALESCE(t.is_milestone, false),
       COALESCE(t.sort_order, 61), t.tool_key, t.clickup_field_id,
       COALESCE(t.tpr_exclude, true), 'system',
       COALESCE(t.is_required, true), t.category,
       'auto',
       jsonb_build_object('rule', 'Loan number is missing', 'reason', 'backfill_208'),
       a.id
  FROM applications a
 CROSS JOIN checklist_templates t
 WHERE t.code = 'cond_loan_number_missing'
   AND t.is_active = true
   AND a.deleted_at IS NULL
   AND a.status IN ('new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close')
   AND COALESCE(btrim(a.ys_loan_number), '') = ''
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.application_id = a.id
                      AND ci.template_id = t.id);
