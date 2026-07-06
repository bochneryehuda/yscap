-- =====================================================================
-- 033_llc_rebuild.sql
-- LLC section rebuild: the LLC on the borrower profile becomes the single
-- source of truth for entity info, ownership structure, and the three
-- entity documents — reused on every loan file.
--   (a) llc_members — the OTHER members of the LLC (the borrower's own stake
--       stays in llcs.ownership_pct). When the borrower owns <100%, members
--       must be filled in until borrower % + member %s = 100.
--   (b) Borrower-facing wording on the three llc-scoped document templates
--       (they now render as fixed upload slots on the borrower profile).
--   (c) Backfill: every existing LLC gets its three document requirement
--       items (older LLCs created before generateLlcChecklist existed, or
--       whose creation predates a template, have gaps).
--   (d) The application-scoped 'rtl_p1_llc' umbrella condition gets copy
--       reflecting the new flow: it is fulfilled BY the linked LLC's state
--       (verified LLC => auto-satisfied; otherwise "set up your LLC").
-- Idempotent: safe to re-run on every boot.
-- =====================================================================

-- (a) ownership structure: other members of the LLC.
CREATE TABLE IF NOT EXISTS llc_members (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  llc_id        uuid NOT NULL REFERENCES llcs(id) ON DELETE CASCADE,
  full_name     text NOT NULL,
  ownership_pct numeric(5,2) NOT NULL CHECK (ownership_pct > 0 AND ownership_pct <= 100),
  email         text,
  phone         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_llc_members_llc ON llc_members(llc_id);

-- (b) borrower-facing wording for the three document slots.
UPDATE checklist_templates
   SET borrower_label = 'State formation documents',
       borrower_hint  = 'Articles of Organization / Certificate of Formation from the state'
 WHERE code = 'rtl_llc_formation'
   AND (borrower_label IS DISTINCT FROM 'State formation documents'
     OR borrower_hint IS DISTINCT FROM 'Articles of Organization / Certificate of Formation from the state');
UPDATE checklist_templates
   SET borrower_label = 'EIN letter (IRS)',
       borrower_hint  = 'IRS SS-4 / CP-575 EIN confirmation letter'
 WHERE code = 'rtl_llc_ein'
   AND (borrower_label IS DISTINCT FROM 'EIN letter (IRS)'
     OR borrower_hint IS DISTINCT FROM 'IRS SS-4 / CP-575 EIN confirmation letter');
UPDATE checklist_templates
   SET borrower_label = 'Operating agreement',
       borrower_hint  = 'Signed operating agreement showing the ownership structure'
 WHERE code = 'rtl_llc_opagmt'
   AND (borrower_label IS DISTINCT FROM 'Operating agreement'
     OR borrower_hint IS DISTINCT FROM 'Signed operating agreement showing the ownership structure');

-- copy the new wording onto items already generated from those templates.
UPDATE checklist_items ci
   SET borrower_label = t.borrower_label,
       borrower_hint  = t.borrower_hint,
       updated_at     = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id
   AND t.code IN ('rtl_llc_formation','rtl_llc_ein','rtl_llc_opagmt')
   AND (ci.borrower_label IS DISTINCT FROM t.borrower_label
     OR ci.borrower_hint IS DISTINCT FROM t.borrower_hint);

-- (c) every existing LLC gets its three document requirement items.
INSERT INTO checklist_items
  (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
   phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, created_by_kind, llc_id)
SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
       COALESCE(t.role_scope,'any'), t.phase, t.hint, t.borrower_hint,
       COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
       COALESCE(t.sort_order,100), t.tool_key, t.clickup_field_id, 'system', l.id
  FROM llcs l
 CROSS JOIN checklist_templates t
 WHERE t.scope = 'llc' AND t.is_active = true
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.llc_id = l.id AND ci.template_id = t.id);

-- (d) umbrella condition copy: fulfilled by the linked LLC's state.
UPDATE checklist_templates
   SET label = 'LLC — entity, ownership & documents',
       borrower_label = 'Your LLC (vesting entity)',
       hint = 'Fulfilled by the linked LLC on the borrower profile: verified LLC = auto-satisfied; otherwise the borrower completes ownership + the three documents there',
       borrower_hint = 'Link the LLC taking title, complete its ownership details, and upload its three documents — done once, reused on every loan'
 WHERE code = 'rtl_p1_llc'
   AND label IS DISTINCT FROM 'LLC — entity, ownership & documents';
UPDATE checklist_items ci
   SET label = t.label, borrower_label = t.borrower_label,
       hint = t.hint, borrower_hint = t.borrower_hint, updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id AND t.code = 'rtl_p1_llc'
   AND ci.label IS DISTINCT FROM t.label;
