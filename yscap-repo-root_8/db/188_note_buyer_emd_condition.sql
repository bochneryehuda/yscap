-- ============================================================================
-- 188 — Earnest money deposit (EMD) verification — CorrFirst-gated borrower
--       external condition (owner-directed 2026-07-20).
--
-- "Open up a borrower external condition to verify the EMD deposit — but only if
--  the note buyer on file is CorrFirst."
--
-- The note buyer is applications.lender (a free-text ClickUp dropdown, staff-only
-- — its real name is NEVER shown to a borrower). So this is a RULE-DRIVEN
-- Condition Center template: audience='borrower' (external), item_kind='document'
-- (the borrower uploads proof of their EMD), auto_apply='rules', and rule_logic
-- gated on the normalized note-buyer key 'corrfirst'. The engine
-- (src/lib/conditions/engine.js) attaches it while the file's note buyer is
-- CorrFirst and retracts it (untouched only) if the note buyer changes away.
--
-- The rule references the `note_buyer` registry field (added to
-- src/lib/conditions/field-registry.js + engine.loadRuleContext ctx), which
-- normalizes applications.lender to a stable key so "CorrFirst" / "Corr First" /
-- "corrfirst" all match.
--
-- BORROWER-SAFE: the internal label/hint may name CorrFirst (staff-only); the
-- borrower_label/borrower_hint never do.
--
-- Previous AND future files: the template is picked up for future files by the
-- engine on every evaluate; the backfill below attaches it to EVERY existing
-- open CorrFirst file that doesn't carry it yet (as an engine-owned 'auto' item,
-- so it retracts cleanly if the note buyer later changes). Idempotent.
-- ============================================================================

-- (1) Template — rule-driven, borrower-facing document condition.
INSERT INTO checklist_templates
  (code, label, borrower_label, scope, audience, item_kind, role_scope, phase,
   sort_order, category, hint, borrower_hint, tpr_exclude, is_required,
   auto_apply, rule_logic)
SELECT
  'cond_emd_corrfirst',
  'Earnest money deposit (EMD) verification — CorrFirst',
  'Proof of earnest money deposit (EMD)',
  'application', 'borrower', 'document', 'processor', '1',
  175, 'prior_to_approval',
  'Verify the borrower''s earnest money deposit (EMD) has been made/cleared. Required on files sold to CorrFirst — collect the wire confirmation, cleared check, or escrow/title receipt showing the deposit.',
  'Please upload proof that your earnest money deposit (EMD) has been made — for example a wire confirmation, a cleared check, or an escrow/title receipt showing the deposit.',
  false, true,
  'rules',
  '{"combinator":"and","rules":[{"field":"note_buyer","operator":"eq","value":"corrfirst"}]}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code = 'cond_emd_corrfirst');

-- Keep the definition in lock-step if a prior boot seeded an earlier version
-- (idempotent re-assert of the rule + wording; never touches instances on files).
UPDATE checklist_templates
   SET audience = 'borrower', item_kind = 'document', auto_apply = 'rules',
       borrower_label = 'Proof of earnest money deposit (EMD)',
       rule_logic = '{"combinator":"and","rules":[{"field":"note_buyer","operator":"eq","value":"corrfirst"}]}'::jsonb,
       is_active = true
 WHERE code = 'cond_emd_corrfirst';

-- (2) Backfill onto every existing OPEN file whose note buyer is CorrFirst and
--     that doesn't already carry the condition. Attached as an engine-owned
--     'auto' item (origin_kind='auto', untouched) so the engine can retract it if
--     the note buyer later changes away from CorrFirst — matching exactly what
--     evaluateApplication would have created. Terminal files are left alone.
INSERT INTO checklist_items
  (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
   phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, tpr_exclude, created_by_kind, is_required, category,
   origin_kind, origin_detail, application_id)
SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
       COALESCE(t.role_scope, 'processor'), t.phase, t.hint, t.borrower_hint,
       COALESCE(t.is_gate, false), COALESCE(t.is_milestone, false),
       COALESCE(t.sort_order, 175), t.tool_key, t.clickup_field_id,
       COALESCE(t.tpr_exclude, false), 'system',
       COALESCE(t.is_required, true), t.category,
       'auto',
       jsonb_build_object('rule', 'Note buyer is CorrFirst', 'reason', 'backfill_186'),
       a.id
  FROM applications a
 CROSS JOIN checklist_templates t
 WHERE t.code = 'cond_emd_corrfirst'
   AND t.is_active = true
   AND a.deleted_at IS NULL
   -- Same OPEN set the engine (engine.OPEN_STATUSES) instantiates for, so the
   -- backfill produces exactly what evaluateApplication would — no phantom EMD
   -- item on an intake-stage or already-funded/closed file.
   AND a.status IN ('new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close')
   AND lower(regexp_replace(COALESCE(a.lender, ''), '[^a-zA-Z0-9]', '', 'g')) = 'corrfirst'
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.application_id = a.id
                      AND ci.template_id = t.id);
