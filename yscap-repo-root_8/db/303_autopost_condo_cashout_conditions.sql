-- ============================================================================
-- 303 — Auto-post two trigger-driven borrower conditions (IG-W16, owner-directed
--       2026-07-24): a CONDO project-documents condition and a CASH-OUT letter.
--
-- Background: the note-buyer guideline SPEC (investor-guidelines/*-spec.js) lists
-- "Condo requirements" (cond 2120) and "Cash Out Letter" (cond 10022) as
-- document conditions that should be POSTED when their trigger fires — but they
-- had NO checklist_templates, so the Condition Center engine could not auto-post
-- them (the ISG desk could only ever raise an advisory suggestion whose
-- proposed code was null — nothing a human could even attach). This migration
-- creates the two rule-driven templates so the ALREADY-RUNNING engine
-- (src/lib/conditions/engine.js) attaches them when the trigger matches and
-- retracts them (untouched only) when it stops — the exact proven pattern of
-- db/191 (cond_emd_corrfirst) and db/281 (rtl_cond_flood).
--
-- Both conditions are scope 'all_note_buyers' in the spec — i.e. they apply to
-- EVERY file with that structural trait, regardless of the note buyer — so the
-- rules are purely STRUCTURAL (no note-buyer gate) and there is no capital-
-- partner name anywhere. Borrower-facing document conditions; the borrower_label/
-- borrower_hint are plain-language and name no note buyer.
--
-- Triggers mirror the spec's T table + the field-registry normalizers 1:1:
--   • Condo    → property_type = 'condo'  (normPropertyType maps "condo" → 'condo')
--   • Cash-out → loan_purpose = 'refinance_cash_out'
--               (normLoanPurpose maps "cash-out" → 'refinance_cash_out')
-- Both fields are in engine.loadRuleContext (property_type ← applications.property_type,
-- loan_purpose ← applications.loan_type) and are registered rule fields.
--
-- Previous AND future files: future files are covered by the engine on every
-- evaluate; the backfills below attach each condition to every existing OPEN
-- file that matches, as an engine-owned 'auto' item (origin_kind='auto',
-- untouched) so the engine can retract it cleanly if the file later changes away
-- from condo / cash-out. Idempotent — safe to re-run every boot.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) Condo project-documents condition — rule: property_type = 'condo'.
-- ---------------------------------------------------------------------------
INSERT INTO checklist_templates
  (code, label, borrower_label, scope, audience, item_kind, role_scope, phase,
   sort_order, category, hint, borrower_hint, tpr_exclude, is_required,
   auto_apply, rule_logic)
SELECT
  'cond_condo_docs',
  'Condo project documents (questionnaire, budget, master insurance)',
  'Condo association documents',
  'application', 'borrower', 'document', 'processor', '3',
  448, 'prior_to_approval',
  'Condo/condotel project package: full Project Questionnaire (incl. the Fannie Mae Addendum), the current-year approved budget, and the Master Insurance Certificate with the mortgagee clause; add the Master Flood Policy if the project is in a flood zone, and an HO-6 (walls-in) policy if the master certificate lacks walls-in coverage.',
  'Because this property is a condo, we need a few documents from the condo association: the completed project questionnaire, this year''s approved budget, and the master insurance certificate. If the project is in a flood zone we''ll also need the master flood policy, and if the master policy doesn''t cover the inside of the unit we''ll need an HO-6 (walls-in) policy. Please upload what you have.',
  false, true,
  'rules',
  '{"combinator":"and","rules":[{"field":"property_type","operator":"eq","value":"condo"}]}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code = 'cond_condo_docs');

UPDATE checklist_templates
   SET audience = 'borrower', item_kind = 'document', auto_apply = 'rules',
       borrower_label = 'Condo association documents',
       rule_logic = '{"combinator":"and","rules":[{"field":"property_type","operator":"eq","value":"condo"}]}'::jsonb,
       is_active = true
 WHERE code = 'cond_condo_docs';

-- ---------------------------------------------------------------------------
-- (2) Cash-out letter condition — rule: loan_purpose IN (cash-out).
-- ---------------------------------------------------------------------------
INSERT INTO checklist_templates
  (code, label, borrower_label, scope, audience, item_kind, role_scope, phase,
   sort_order, category, hint, borrower_hint, tpr_exclude, is_required,
   auto_apply, rule_logic)
SELECT
  'cond_cashout_letter',
  'Cash-out letter of explanation',
  'Letter explaining your cash-out',
  'application', 'borrower', 'document', 'processor', '3',
  449, 'prior_to_approval',
  'A written explanation from the borrower of how the cash-out proceeds will be used.',
  'Because you''re taking cash out of this loan, please upload a short written note explaining how you plan to use the cash-out money.',
  false, true,
  'rules',
  '{"combinator":"and","rules":[{"field":"loan_purpose","operator":"in","value":["refinance_cash_out"]}]}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code = 'cond_cashout_letter');

UPDATE checklist_templates
   SET audience = 'borrower', item_kind = 'document', auto_apply = 'rules',
       borrower_label = 'Letter explaining your cash-out',
       rule_logic = '{"combinator":"and","rules":[{"field":"loan_purpose","operator":"in","value":["refinance_cash_out"]}]}'::jsonb,
       is_active = true
 WHERE code = 'cond_cashout_letter';

-- ---------------------------------------------------------------------------
-- (3) Backfill onto existing OPEN files. Attached as engine-owned 'auto' items
--     so the engine retracts them cleanly if the file later changes away from
--     condo / cash-out. The WHERE clauses mirror the JS normalizers exactly
--     (condo: contains "condo" but not "mixed" — normPropertyType checks /mixed/
--     first; cash-out: matches /cash[-\s]?out/). An over/under-match is self-
--     healing anyway — the engine re-evaluates on the next file view and
--     attaches/retracts to match the real normalized rule.
-- ---------------------------------------------------------------------------
INSERT INTO checklist_items
  (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
   phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, tpr_exclude, created_by_kind, is_required, category,
   origin_kind, origin_detail, application_id)
SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
       COALESCE(t.role_scope, 'processor'), t.phase, t.hint, t.borrower_hint,
       COALESCE(t.is_gate, false), COALESCE(t.is_milestone, false),
       COALESCE(t.sort_order, 448), t.tool_key, t.clickup_field_id,
       COALESCE(t.tpr_exclude, false), 'system',
       COALESCE(t.is_required, true), t.category,
       'auto',
       jsonb_build_object('rule', 'Property type is condo', 'reason', 'backfill_303'),
       a.id
  FROM applications a
 CROSS JOIN checklist_templates t
 WHERE t.code = 'cond_condo_docs'
   AND t.is_active = true
   AND a.deleted_at IS NULL
   AND a.status IN ('new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close')
   AND lower(COALESCE(a.property_type, '')) LIKE '%condo%'
   AND lower(COALESCE(a.property_type, '')) NOT LIKE '%mixed%'
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.application_id = a.id AND ci.template_id = t.id);

INSERT INTO checklist_items
  (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
   phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, tpr_exclude, created_by_kind, is_required, category,
   origin_kind, origin_detail, application_id)
SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
       COALESCE(t.role_scope, 'processor'), t.phase, t.hint, t.borrower_hint,
       COALESCE(t.is_gate, false), COALESCE(t.is_milestone, false),
       COALESCE(t.sort_order, 449), t.tool_key, t.clickup_field_id,
       COALESCE(t.tpr_exclude, false), 'system',
       COALESCE(t.is_required, true), t.category,
       'auto',
       jsonb_build_object('rule', 'Loan purpose is cash-out', 'reason', 'backfill_303'),
       a.id
  FROM applications a
 CROSS JOIN checklist_templates t
 WHERE t.code = 'cond_cashout_letter'
   AND t.is_active = true
   AND a.deleted_at IS NULL
   AND a.status IN ('new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close')
   AND lower(COALESCE(a.loan_type, '')) ~ 'cash[-[:space:]]?out'
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.application_id = a.id AND ci.template_id = t.id);
