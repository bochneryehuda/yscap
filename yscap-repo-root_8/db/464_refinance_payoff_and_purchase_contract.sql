-- ============================================================================
-- 464 — Refinance conditions (owner-directed 2026-08-04):
--   (1) EVERY refinance gets a PAYOFF condition — one EXTERNAL (borrower-facing)
--       and one INTERNAL (staff-only). "Any refinance should have a condition for
--       the payoff … an internal and external condition."
--   (2) The purchase-contract condition (rtl_p1_contract) must NOT populate or
--       fire on ANY refinance — "obviously there is no purchase contract."
--
-- Both use the ALREADY-RUNNING Condition Center rules engine
-- (src/lib/conditions/engine.js), the exact proven pattern of db/303 (condo /
-- cash-out) and db/191/db/281: a rule-driven template (auto_apply='rules') the
-- engine attaches when the rule matches and retracts (untouched only) when it
-- stops, plus a deterministic backfill for existing files (previous AND future).
--
-- The discriminator is the registered rule field `loan_purpose` =
-- normLoanPurpose(applications.loan_type): 'purchase' / 'refinance_rate_term' /
-- 'refinance_cash_out' / 'other'. A bare "Refinance" normalizes to
-- 'refinance_rate_term', "Delayed Purchase Financing" to 'purchase'. Idempotent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1a) EXTERNAL payoff condition — borrower-facing document. The borrower gives
--      us their current mortgage/payoff statement so we can order the official
--      payoff and confirm the balance + the existing lender's loan number.
-- ---------------------------------------------------------------------------
INSERT INTO checklist_templates
  (code, label, borrower_label, scope, audience, item_kind, role_scope, phase,
   sort_order, category, hint, borrower_hint, tpr_exclude, is_required,
   auto_apply, rule_logic)
SELECT
  'cond_payoff_external',
  'Current mortgage / payoff statement (existing loan)',
  'Your current mortgage (payoff) statement',
  'application', 'borrower', 'document', 'processor', '3',
  452, 'prior_to_approval',
  'Borrower-provided current mortgage / payoff statement for the loan being refinanced — shows the existing lender, the loan number and the outstanding balance, so the payoff can be ordered and verified before closing.',
  'Because this is a refinance, please upload your most recent mortgage statement for the loan on this property (the one being paid off). It should show your current lender, your loan number and the balance owed.',
  false, true,
  'rules',
  '{"combinator":"and","rules":[{"field":"loan_purpose","operator":"in","value":["refinance_rate_term","refinance_cash_out"]}]}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code = 'cond_payoff_external');

UPDATE checklist_templates
   SET audience = 'borrower', item_kind = 'document', auto_apply = 'rules',
       borrower_label = 'Your current mortgage (payoff) statement',
       rule_logic = '{"combinator":"and","rules":[{"field":"loan_purpose","operator":"in","value":["refinance_rate_term","refinance_cash_out"]}]}'::jsonb,
       is_active = true
 WHERE code = 'cond_payoff_external';

-- ---------------------------------------------------------------------------
-- (1b) INTERNAL payoff condition — staff-only checkpoint. The official payoff
--      letter has been ordered from the existing lender and the figure + lender
--      + loan number are verified on the file before clear-to-close. NEVER
--      borrower-facing (audience 'staff').
-- ---------------------------------------------------------------------------
INSERT INTO checklist_templates
  (code, label, borrower_label, scope, audience, item_kind, role_scope, phase,
   sort_order, category, hint, borrower_hint, tpr_exclude, is_required,
   auto_apply, rule_logic)
SELECT
  'cond_payoff_internal',
  'Payoff verified — statement ordered, figure & lender confirmed',
  NULL,
  'application', 'staff', 'condition', 'processor', '5',
  453, 'prior_to_closing',
  'Internal: order the official payoff letter from the existing lender and confirm the payoff amount, the lender being paid off and their loan number are on the file. The new loan cannot fund until the payoff figure is confirmed against the payoff letter.',
  NULL,
  true, true,
  'rules',
  '{"combinator":"and","rules":[{"field":"loan_purpose","operator":"in","value":["refinance_rate_term","refinance_cash_out"]}]}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code = 'cond_payoff_internal');

UPDATE checklist_templates
   SET audience = 'staff', item_kind = 'condition', auto_apply = 'rules',
       rule_logic = '{"combinator":"and","rules":[{"field":"loan_purpose","operator":"in","value":["refinance_rate_term","refinance_cash_out"]}]}'::jsonb,
       is_active = true
 WHERE code = 'cond_payoff_internal';

-- ---------------------------------------------------------------------------
-- (2) Purchase-contract condition (rtl_p1_contract) becomes rules-driven and is
--     suppressed on refinances. Rule: loan_purpose NOT IN (the two refinance
--     purposes) — so it attaches on purchase / delayed-purchase / other (the
--     legacy default) and retracts on any refinance. Converting it from a legacy
--     (auto_apply NULL) template to a rules template means generateChecklist no
--     longer creates it; the engine does, on matching files only.
-- ---------------------------------------------------------------------------
UPDATE checklist_templates
   SET auto_apply = 'rules',
       rule_logic = '{"combinator":"and","rules":[{"field":"loan_purpose","operator":"not_in","value":["refinance_rate_term","refinance_cash_out"]}]}'::jsonb
 WHERE code = 'rtl_p1_contract';

-- ---------------------------------------------------------------------------
-- (3) Backfills — previous AND future. Future files: the engine attaches/retracts
--     on every evaluate. Existing files below.
-- ---------------------------------------------------------------------------

-- (3a) Attach the two payoff conditions to every existing OPEN refinance file,
--      as engine-owned 'auto' items (so the engine can retract them cleanly if
--      the file later changes off a refinance).
INSERT INTO checklist_items
  (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
   phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, tpr_exclude, created_by_kind, is_required, category,
   origin_kind, origin_detail, application_id)
SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
       COALESCE(t.role_scope, 'processor'), t.phase, t.hint, t.borrower_hint,
       COALESCE(t.is_gate, false), COALESCE(t.is_milestone, false),
       COALESCE(t.sort_order, 452), t.tool_key, t.clickup_field_id,
       COALESCE(t.tpr_exclude, false), 'system',
       COALESCE(t.is_required, true), t.category,
       'auto',
       jsonb_build_object('rule', 'Loan purpose is a refinance', 'reason', 'backfill_464'),
       a.id
  FROM applications a
 CROSS JOIN checklist_templates t
 WHERE t.code IN ('cond_payoff_external', 'cond_payoff_internal')
   AND t.is_active = true
   AND a.deleted_at IS NULL
   AND a.status IN ('new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close')
   AND lower(COALESCE(a.loan_type, '')) ~ 'refi'
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.application_id = a.id AND ci.template_id = t.id);

-- (3b) Remove the purchase-contract condition from existing REFINANCE files that
--      wrongly carry it. Mirrors db/179's assignment-condition backfill: a
--      refinance has no purchase contract. documents.checklist_item_id is
--      ON DELETE SET NULL, so any misfiled document is unlinked, never destroyed.
--      Restricted to untouched items so a signed-off / evidenced condition is
--      never silently discarded.
DELETE FROM checklist_items ci
  USING checklist_templates t, applications a
 WHERE ci.template_id = t.id AND t.code = 'rtl_p1_contract'
   AND ci.application_id = a.id
   AND lower(COALESCE(a.loan_type, '')) ~ 'refi'
   AND ci.status = 'outstanding'
   AND ci.signed_off_at IS NULL
   AND ci.reviewed_at IS NULL
   AND (ci.notes IS NULL OR ci.notes = '')
   AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.checklist_item_id = ci.id);
