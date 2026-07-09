-- 068 — The vesting-entity LLC condition (rtl_p1_llc) is a CONDITION TO CLOSE.
-- Make it a gate so it counts toward Clear-to-Close, on both the internal and the
-- external (borrower) condition lists. It stays audience 'both' and item_kind
-- 'document' — only is_gate flips. Verifying the entity satisfies/signs it off
-- (src/lib/llc.js syncLlcConditions), so this gate clears the moment the entity is
-- verified. Idempotent (guarded by IS DISTINCT FROM).
UPDATE checklist_templates
   SET is_gate = true, updated_at = now()
 WHERE code = 'rtl_p1_llc' AND is_gate IS DISTINCT FROM true;

UPDATE checklist_items ci
   SET is_gate = true, updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id AND t.code = 'rtl_p1_llc'
   AND ci.is_gate IS DISTINCT FROM true;
