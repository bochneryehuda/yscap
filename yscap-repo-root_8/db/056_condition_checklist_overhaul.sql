-- 056_condition_checklist_overhaul.sql
-- Owner-directed overhaul of the RTL internal checklist + conditions: renames
-- (more professional wording + added requirements), reordering, optional flags,
-- merges, removals, and new items. Renames/flag changes update BOTH the template
-- AND the already-instantiated checklist_items (which carry their own copied
-- label). Removals deactivate the template + strip open files (guarded once).
-- New templates propagate to existing open files via the boot backfill (bumped
-- to v2 in server.js).

-- ============================================================================
-- PART A — renames + flags + reorder (idempotent; safe every boot)
-- Helper pattern: update the template, then every checklist_item cloned from it.
-- ============================================================================

-- (6) SharePoint folders — drop "built first"
UPDATE checklist_templates SET label='SharePoint folders created & all documents synced', hint=NULL, updated_at=now()
 WHERE code='rtl_p2_sp';
UPDATE checklist_items SET label='SharePoint folders created & all documents synced', updated_at=now()
 WHERE template_id=(SELECT id FROM checklist_templates WHERE code='rtl_p2_sp');

-- (7) ClickUp task created — professional
UPDATE checklist_templates SET label='Pipeline task created with every required field populated', updated_at=now()
 WHERE code='rtl_p2_cu';
UPDATE checklist_items SET label='Pipeline task created with every required field populated', updated_at=now()
 WHERE template_id=(SELECT id FROM checklist_templates WHERE code='rtl_p2_cu');

-- (8) Encompass loan opened — keep wording, ADD amount + structure must match
UPDATE checklist_templates SET label='Encompass loan opened as Fix & Flip — loan amount & structure match the file', updated_at=now()
 WHERE code='rtl_p2_enc';
UPDATE checklist_items SET label='Encompass loan opened as Fix & Flip — loan amount & structure match the file', updated_at=now()
 WHERE template_id=(SELECT id FROM checklist_templates WHERE code='rtl_p2_enc');

-- (9) Appraisal ordered — move to the TOP of the checklist (lowest sort_order)
UPDATE checklist_templates SET sort_order=5, updated_at=now() WHERE code='rtl_p3_appr';
UPDATE checklist_items SET sort_order=5, updated_at=now()
 WHERE template_id=(SELECT id FROM checklist_templates WHERE code='rtl_p3_appr');

-- (10) Appraisal PAID — professional rename + OPTIONAL (not required)
UPDATE checklist_templates SET label='Appraisal payment confirmed (if applicable)', is_required=false, updated_at=now()
 WHERE code='rtl_p3_apprpay';
UPDATE checklist_items SET label='Appraisal payment confirmed (if applicable)', is_required=false, updated_at=now()
 WHERE template_id=(SELECT id FROM checklist_templates WHERE code='rtl_p3_apprpay');

-- (11) SOW uploaded to appraiser — professional
UPDATE checklist_templates SET label='Scope of Work delivered to the appraiser & filed in SharePoint', updated_at=now()
 WHERE code='rtl_p3_sow2';
UPDATE checklist_items SET label='Scope of Work delivered to the appraiser & filed in SharePoint', updated_at=now()
 WHERE template_id=(SELECT id FROM checklist_templates WHERE code='rtl_p3_sow2');

-- (12) Soft credit pull — professional
UPDATE checklist_templates SET label='Soft credit report pulled (Xactus)', updated_at=now()
 WHERE code='rtl_p3_credit';
UPDATE checklist_items SET label='Soft credit report pulled (Xactus)', updated_at=now()
 WHERE template_id=(SELECT id FROM checklist_templates WHERE code='rtl_p3_credit');

-- (13) Scores entered — rename + YS-portal scores verified + re-price if changed
UPDATE checklist_templates
   SET label='Credit scores entered in Encompass & YS portal, verified; product & pricing regenerated if the score changed from what was originally entered',
       updated_at=now()
 WHERE code='rtl_p3_credit2';
UPDATE checklist_items
   SET label='Credit scores entered in Encompass & YS portal, verified; product & pricing regenerated if the score changed from what was originally entered',
       updated_at=now()
 WHERE template_id=(SELECT id FROM checklist_templates WHERE code='rtl_p3_credit2');

-- (15) Variances cleared — note this is the SetPoint-channel review
UPDATE checklist_templates SET label='Variances cleared & report saved to SharePoint (SetPoint files)', updated_at=now()
 WHERE code='rtl_p3_fraud2';
UPDATE checklist_items SET label='Variances cleared & report saved to SharePoint (SetPoint files)', updated_at=now()
 WHERE template_id=(SELECT id FROM checklist_templates WHERE code='rtl_p3_fraud2');

-- (16) Required liquidity — rename against Encompass F&F sheet + YS portal requirement
UPDATE checklist_templates
   SET label='Required liquidity verified against the Encompass Fix & Flip sheet and the YS Capital portal liquidity requirement',
       updated_at=now()
 WHERE code='rtl_p3_liq';
UPDATE checklist_items
   SET label='Required liquidity verified against the Encompass Fix & Flip sheet and the YS Capital portal liquidity requirement',
       updated_at=now()
 WHERE template_id=(SELECT id FROM checklist_templates WHERE code='rtl_p3_liq');

-- (17) Attorney email — merge the "title contact given to attorney" step into it
UPDATE checklist_templates
   SET label='Attorney email sent — file ready for closing prep; title contact provided to the attorney',
       updated_at=now()
 WHERE code='rtl_p5_atty';
UPDATE checklist_items
   SET label='Attorney email sent — file ready for closing prep; title contact provided to the attorney',
       updated_at=now()
 WHERE template_id=(SELECT id FROM checklist_templates WHERE code='rtl_p5_atty');

-- ============================================================================
-- PART B — new items (idempotent inserts)
-- ============================================================================

-- (15) Appraisal review cleared — CoreFirst channel (internal checklist task)
INSERT INTO checklist_templates (code, label, scope, audience, item_kind, applies_loan_type, role_scope, phase, sort_order, hint, is_gate, is_milestone, is_required)
SELECT 'rtl_p3_apprreview', 'Appraisal review cleared (CoreFirst files)', 'application', 'staff', 'task', 'rtl', 'processor', '3', 415, NULL, false, false, false
 WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code='rtl_p3_apprreview');

-- (4) Investor structure printout — OPTIONAL internal condition (document upload),
-- never borrower-facing, excluded from the TPR export. Proves the investor allows
-- this loan amount / the structure matches (investor term sheet / data tape / xlsx).
INSERT INTO checklist_templates (code, label, scope, audience, item_kind, applies_loan_type, role_scope, phase, sort_order, category, hint, tpr_exclude, is_required)
SELECT 'rtl_cond_investorstruct', 'Investor structure printout', 'application', 'staff', 'document', 'rtl', 'any', '4', 486, 'prior_to_closing',
       'Optional: attach the investor''s structure/term sheet/data tape (from the investor portal) that matches this file to the investor file it will be sold to.',
       true, false
 WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code='rtl_cond_investorstruct');

-- ============================================================================
-- PART C — removals + the fraud→condition move (guarded once via data_migrations)
-- ============================================================================
CREATE TABLE IF NOT EXISTS data_migrations (key text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());

-- (14) Fraud / background — becomes an INTERNAL CONDITION with two doc slots
-- (background required; criminal optional, but required when program = Gold
-- Standard). Insert the template unconditionally (idempotent); the checklist
-- TASK version is deactivated + stripped in the guarded block below.
INSERT INTO checklist_templates (code, label, scope, audience, item_kind, applies_loan_type, role_scope, phase, sort_order, category, hint, slots, tpr_exclude, is_required)
SELECT 'rtl_cond_fraud', 'Fraud / background report', 'application', 'staff', 'document', 'rtl', 'processor', '3', 405, 'prior_to_docs',
       'Upload the background report (required). The criminal report is optional — but REQUIRED for the Gold Standard program.',
       '[{"key":"background","label":"Background report"},{"key":"criminal","label":"Criminal report"}]'::jsonb,
       true, true
 WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code='rtl_cond_fraud');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM data_migrations WHERE key = '056_checklist_overhaul') THEN
    -- (5) Remove "Borrower phone + email on file"; (14) remove the fraud TASK
    -- (now a condition); (17) remove the standalone "title contact to attorney"
    -- (merged into the attorney-email item above).
    UPDATE checklist_templates SET is_active=false, updated_at=now()
     WHERE code IN ('rtl_p1_contact', 'rtl_p3_fraud', 'rtl_p5_titleinfo');

    DELETE FROM checklist_items ci
      USING checklist_templates t, applications a
     WHERE ci.template_id = t.id
       AND t.code IN ('rtl_p1_contact', 'rtl_p3_fraud', 'rtl_p5_titleinfo')
       AND a.id = ci.application_id
       AND a.deleted_at IS NULL
       AND a.status IN ('new','in_review','processing','underwriting','approved','clear_to_close');

    INSERT INTO data_migrations(key) VALUES ('056_checklist_overhaul');
  END IF;
END $$;
