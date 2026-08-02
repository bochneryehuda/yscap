-- 410 — VESTING IN AN INDIVIDUAL'S NAME ASKS FOR THE AFFIDAVIT AS ITS OWN CONDITION
--
-- Owner-directed 2026-08-02: "When anybody opens a file and marks that file
-- individual then there should be a condition populated that because it's
-- individual they need to upload the non owner occupied affidavit."
--
-- WHAT THIS UNBLOCKS. The affidavit is still required — it just stops being a
-- hidden PREREQUISITE of the act of marking a file individual. Today
-- `POST /vesting/personal-name` answers 400 unless an affidavit rides along in
-- the very same request, which makes the choice impossible at the two doors
-- where it matters most: a borrower filling in the public application form has
-- no affidavit to attach, and neither does a staffer opening a brand-new file.
-- The owner wants the choice available RIGHT AWAY on all three doors, so the
-- requirement moves to where every other requirement on this system lives — a
-- condition on the file.
--
-- RULE-DRIVEN, on the new `vesting_is_individual` field (the cond_emd_corrfirst
-- pattern). That field is DERIVED — personal_name_purchase AND no linked entity
-- — which gives the retraction for free: link a real LLC later and the engine
-- takes this condition back off (untouched items only) while the LLC condition
-- returns. An LLC always wins, and that rule already exists; nothing here
-- re-implements it.
--
-- audience 'both': the borrower has to sign and upload the affidavit, and the
-- team has to chase and clear it. item_kind 'document' so the ordinary document
-- gate applies — this is what must be satisfied before clear-to-close, which is
-- exactly the protection the old 400 was providing, now in the place a human can
-- actually see and work.

-- (1) The template.
INSERT INTO checklist_templates
  (code, label, borrower_label, scope, audience, item_kind, role_scope, phase,
   sort_order, category, hint, borrower_hint, tpr_exclude, is_required,
   auto_apply, rule_logic)
SELECT
  'cond_noo_affidavit_individual',
  'Non-owner-occupied affidavit (individual vesting)',
  'Non-owner-occupied affidavit',
  'application', 'both', 'document', 'processor', '1',
  178, 'prior_to_docs',
  'Required because this file vests in an INDIVIDUAL''s name rather than an entity. Collect the signed non-owner-occupied affidavit. This retracts on its own if a vesting LLC is linked later.',
  'Because this loan is being taken in your personal name rather than a company, please upload the signed non-owner-occupied affidavit confirming you will not live in the property.',
  false, true,
  'rules',
  '{"combinator":"and","rules":[{"field":"vesting_is_individual","operator":"is_true"}]}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code = 'cond_noo_affidavit_individual');

-- Keep the definition in lock-step if an earlier boot seeded a different version.
-- Never touches instances already on files.
UPDATE checklist_templates
   SET audience = 'both', item_kind = 'document', auto_apply = 'rules',
       category = 'prior_to_docs', is_required = true, is_active = true,
       rule_logic = '{"combinator":"and","rules":[{"field":"vesting_is_individual","operator":"is_true"}]}'::jsonb
 WHERE code = 'cond_noo_affidavit_individual'
   AND (audience IS DISTINCT FROM 'both'
     OR auto_apply IS DISTINCT FROM 'rules'
     OR category IS DISTINCT FROM 'prior_to_docs'
     OR is_active IS DISTINCT FROM true);

-- (2) PREVIOUS AND FUTURE. Every file ALREADY marked as a personal-name purchase
-- gets the condition on the next boot, rather than only files marked from now on.
-- Scoped to live files with a checklist; an entity on the file means it does not
-- vest in an individual, so it is excluded exactly as the rule would exclude it.
-- Engine-owned ('auto') so it retracts cleanly if an LLC is linked later.
INSERT INTO checklist_items
  (application_id, template_id, label, hint, status, is_required, category, origin_kind)
SELECT a.id, t.id, t.label, t.hint, 'outstanding', t.is_required, t.category, 'auto'
  FROM applications a
  CROSS JOIN checklist_templates t
 WHERE t.code = 'cond_noo_affidavit_individual'
   AND a.personal_name_purchase = true
   AND a.llc_id IS NULL
   AND a.deleted_at IS NULL
   AND a.status NOT IN ('funded', 'declined', 'withdrawn', 'cancelled')
   AND EXISTS (SELECT 1 FROM checklist_items x WHERE x.application_id = a.id)
   AND NOT EXISTS (
     SELECT 1 FROM checklist_items ci
      WHERE ci.application_id = a.id AND ci.template_id = t.id);

-- (3) An affidavit ALREADY on file settles it. A file the team marked individual
-- the old way had to upload one to get that far, so re-asking would be asking for
-- a document that is already sitting on the loan. The document currently hangs off
-- the LLC condition (that is where the old route filed it), so it is matched by
-- doc_kind on the FILE rather than by which condition it is pinned to.
UPDATE checklist_items ci
   SET status = 'satisfied', updated_at = now(),
       notes = COALESCE(NULLIF(ci.notes, ''), '[auto] The non-owner-occupied affidavit was already on this file when this condition was introduced.')
  FROM checklist_templates t
 WHERE t.id = ci.template_id
   AND t.code = 'cond_noo_affidavit_individual'
   AND ci.status = 'outstanding'
   AND ci.signed_off_at IS NULL
   AND EXISTS (
     SELECT 1 FROM documents d
      WHERE d.application_id = ci.application_id
        AND d.doc_kind = 'noo_affidavit'
        AND d.is_current
        AND COALESCE(d.review_status, '') <> 'rejected');
