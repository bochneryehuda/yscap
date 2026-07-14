-- 095 — Continuous checklist reconciler (root fix for the missing-conditions
-- breach, owner-directed 2026-07-14).
--
-- WHY: checklist generation was caller-side and skippable. The worst instance
-- (2026-07-09): ClickUp ingest skipped generation whenever a file had ANY
-- checklist item, and the vesting rewrite began inserting the rtl_p1_llc
-- condition BEFORE generation ran — so every ClickUp-materialized file with an
-- LLC or co-borrower got 1-2 items and silently missed the other ~39
-- (purchase contract, credit report, assignment, the entire internal
-- checklist). The one-shot backfill markers were already consumed, and the
-- 076/077 heals required >=1 existing item — zero-item files were unhealable.
--
-- WHAT: an anti-join per (file, template) that fills EVERY missing legacy
-- template instantiation. No data_migrations marker and no "has items" gate —
-- numbered migrations re-run on every boot, so this doubles as the permanent
-- reconciler ("previous AND future"). Idempotency comes from the NOT EXISTS
-- per (application, template) — the same dedup rule insertFromTemplate uses.
-- Engine-managed templates (auto_apply set) stay with evaluateApplication.
--
-- Track derivation mirrors normLoanType(): dscr-ish text -> 'dscr', else 'rtl'.
-- Gates mirror generateChecklist: rtl_p5_assign only on assignment deals;
-- rtl_p1_plans only on ground-up.

-- 1) Application-scoped legacy templates.
WITH f AS (
  SELECT a.id, a.borrower_id, a.program, a.is_assignment,
         CASE WHEN (COALESCE(a.program,'') || ' ' || COALESCE(a.loan_type,''))
              ~* 'dscr|rental|\mrent\M|long[- ]?term|30[- ]?year' THEN 'dscr' ELSE 'rtl' END AS track,
         (COALESCE(a.rehab_type,'') || ' ' || COALESCE(a.loan_type,'') || ' ' || COALESCE(a.program,'')) ~* 'ground' AS ground_up
    FROM applications a
   WHERE a.deleted_at IS NULL
     AND a.status NOT IN ('declined','withdrawn','cancelled')
)
INSERT INTO checklist_items
  (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
   phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id)
SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
       COALESCE(t.role_scope,'any'), t.phase, t.hint, t.borrower_hint,
       COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
       COALESCE(t.sort_order,100), t.tool_key, t.clickup_field_id,
       COALESCE(t.tpr_exclude,false), 'system', COALESCE(t.is_required,true), f.id
  FROM f
 CROSS JOIN checklist_templates t
 WHERE t.is_active = true
   AND t.auto_apply IS NULL
   AND t.scope = 'application'
   AND (t.applies_program  IS NULL OR t.applies_program  = f.program)
   AND (t.applies_loan_type IS NULL OR t.applies_loan_type = f.track)
   AND (t.code <> 'rtl_p5_assign' OR f.is_assignment IS TRUE)
   AND (t.code <> 'rtl_p1_plans'  OR f.ground_up)
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.application_id = f.id AND ci.template_id = t.id);

-- 2) Borrower-profile-scoped legacy templates, for every borrower with at
--    least one live file (same population generateChecklist would have hit).
WITH bb AS (
  SELECT DISTINCT a.borrower_id,
         first_value(CASE WHEN (COALESCE(a.program,'') || ' ' || COALESCE(a.loan_type,''))
                          ~* 'dscr|rental|\mrent\M|long[- ]?term|30[- ]?year' THEN 'dscr' ELSE 'rtl' END)
           OVER (PARTITION BY a.borrower_id ORDER BY a.created_at DESC) AS track
    FROM applications a
   WHERE a.deleted_at IS NULL
     AND a.status NOT IN ('declined','withdrawn','cancelled')
     AND a.borrower_id IS NOT NULL
)
INSERT INTO checklist_items
  (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
   phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, tpr_exclude, created_by_kind, is_required, borrower_id)
SELECT DISTINCT ON (t.id, bb.borrower_id)
       t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
       COALESCE(t.role_scope,'any'), t.phase, t.hint, t.borrower_hint,
       COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
       COALESCE(t.sort_order,100), t.tool_key, t.clickup_field_id,
       COALESCE(t.tpr_exclude,false), 'system', COALESCE(t.is_required,true), bb.borrower_id
  FROM bb
 CROSS JOIN checklist_templates t
 WHERE t.is_active = true
   AND t.auto_apply IS NULL
   AND t.scope = 'borrower_profile'
   AND (t.applies_program IS NULL)
   AND (t.applies_loan_type IS NULL OR t.applies_loan_type = bb.track)
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.borrower_id = bb.borrower_id AND ci.template_id = t.id);
