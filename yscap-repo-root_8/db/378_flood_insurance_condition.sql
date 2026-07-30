-- ============================================================================
-- 378 — FLOOD-INSURANCE condition, auto-attached when the property is in a
--       flood zone (owner-directed 2026-07-30: "If it comes back that it's in
--       the flood zone, pilot should automatically add the condition for flood
--       insurance on the file").
--
-- There was no dedicated flood-insurance condition template — the "flood zone ⇒
-- flood insurance required" logic only ever existed as advisory findings. This
-- creates a real, staff-facing document condition `rtl_cond_flood_insurance`,
-- RULE-DRIVEN on the `in_flood_zone` registry field (auto_apply='rules').
--
-- `in_flood_zone` is true when a FLOOD ZONE is proven — from the current
-- appraisal (FEMA SFHA flag / FEMA zone / appraiser zone A*/V*) OR, now, from a
-- completed Encompass flood-determination order (src/lib/conditions/engine.js
-- loadRuleContext also reads the newest completed encompass_flood_orders row). So
-- when a flood order comes back "in a flood zone", the engine attaches this
-- condition automatically on the next evaluate (the flood-order worker + the
-- appraisal desk both re-run evaluateApplication).
--
-- Staff-facing (audience='staff'): the flood-insurance requirement is an internal
-- workflow item; the borrower's insurance obligations are handled through the
-- existing insurance condition/contacts, not by naming a flood zone to them.
--
-- Previous AND future: the engine attaches it going forward on every evaluate;
-- the backfill below attaches it to every existing OPEN file whose CURRENT
-- appraisal already proves a flood zone (the same A*/V* test the engine uses),
-- as an engine-owned 'auto' item so it retracts cleanly if the zone is later
-- reversed and nobody has touched it. Idempotent.
-- ============================================================================

-- (1) Template — rule-driven, staff-facing document condition.
INSERT INTO checklist_templates
  (code, label, scope, audience, item_kind, applies_loan_type, role_scope, phase,
   sort_order, category, hint, tpr_exclude, is_required, auto_apply, rule_logic)
SELECT
  'rtl_cond_flood_insurance',
  'Flood insurance (property is in a flood zone)',
  'application', 'staff', 'document', 'rtl', 'processor', '3',
  407, 'prior_to_docs',
  'The property is in a FEMA flood zone (Special Flood Hazard Area), so a flood insurance policy is required. Collect the flood policy / binder + paid invoice with adequate coverage before docs.',
  false, true,
  'rules',
  '{"combinator":"and","rules":[{"field":"in_flood_zone","operator":"is_true"}]}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code = 'rtl_cond_flood_insurance');

-- Keep the definition in lock-step across boots (idempotent; never touches
-- instances already on files).
UPDATE checklist_templates
   SET label = 'Flood insurance (property is in a flood zone)',
       audience = 'staff', item_kind = 'document', auto_apply = 'rules',
       rule_logic = '{"combinator":"and","rules":[{"field":"in_flood_zone","operator":"is_true"}]}'::jsonb,
       is_active = true
 WHERE code = 'rtl_cond_flood_insurance';

-- (2) Backfill onto every existing OPEN file whose CURRENT appraisal already
--     proves a flood zone (A*/V* zone or the FEMA SFHA flag) and that doesn't
--     already carry the condition. Attached as an engine-owned 'auto' item so the
--     engine can retract it (untouched only) if the flood determination is later
--     reversed — matching exactly what evaluateApplication would create.
INSERT INTO checklist_items
  (template_id, scope, label, audience, item_kind, role_scope,
   phase, hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, tpr_exclude, created_by_kind, is_required, category,
   origin_kind, origin_detail, application_id)
SELECT t.id, t.scope, t.label, t.audience, t.item_kind,
       COALESCE(t.role_scope, 'processor'), t.phase, t.hint,
       COALESCE(t.is_gate, false), COALESCE(t.is_milestone, false),
       COALESCE(t.sort_order, 407), t.tool_key, t.clickup_field_id,
       COALESCE(t.tpr_exclude, false), 'system',
       COALESCE(t.is_required, true), t.category,
       'auto',
       jsonb_build_object('rule', 'Property is in a flood zone', 'reason', 'backfill_378'),
       a.id
  FROM applications a
 CROSS JOIN checklist_templates t
 WHERE t.code = 'rtl_cond_flood_insurance'
   AND t.is_active = true
   AND a.deleted_at IS NULL
   -- Same OPEN set the engine instantiates for — no phantom item on an
   -- intake-stage or already-funded/closed file.
   AND a.status IN ('new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close')
   -- In a flood zone per the CURRENT appraisal (mirrors engine.loadRuleContext).
   AND EXISTS (
     SELECT 1 FROM appraisals ap
      WHERE ap.application_id = a.id AND ap.superseded = false
        AND ( ap.fema_flood_sfha = true
              OR upper(btrim(COALESCE(ap.fema_flood_zone, ''))) ~ '^(A|V)'
              OR upper(btrim(COALESCE(ap.flood_zone, ''))) ~ '^(A|V)' ))
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.application_id = a.id
                      AND ci.template_id = t.id);
