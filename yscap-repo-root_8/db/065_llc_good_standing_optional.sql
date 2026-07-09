-- 065 — Certificate of Good Standing is OPTIONAL and must never gate LLC
-- verification. The verification code (src/lib/llc.js) already forces this
-- regardless of the stored flag, but align the data so the UI's required marker
-- and any other consumer agree: mark every good-standing checklist item optional.
UPDATE checklist_items ci
   SET is_required = false, updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id
   AND t.scope = 'llc'
   AND t.code = 'rtl_llc_goodstanding'
   AND ci.is_required IS DISTINCT FROM false;

-- And the template default, so newly-generated good-standing slots are optional too.
UPDATE checklist_templates
   SET is_required = false
 WHERE scope = 'llc' AND code = 'rtl_llc_goodstanding'
   AND is_required IS DISTINCT FROM false;
