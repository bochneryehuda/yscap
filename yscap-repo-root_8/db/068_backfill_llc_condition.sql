-- 068 — Backfill the vesting-entity LLC condition (rtl_p1_llc) onto EVERY active
-- RTL file that has a checklist but is missing it, so the LLC "condition to close"
-- populates on PREVIOUS files too — not only on files the ClickUp sync happens to
-- re-ingest. This is the deterministic, boot-time counterpart to the runtime
-- ensureLlcCondition (src/lib/vesting.js): the section renders from applications.
-- llc_id while the conditions-to-close LIST renders from this checklist item, so a
-- file that had the entity but not the item showed the section but no condition.
--
-- rtl_p1_llc is a gate (067) + audience 'both', so once present it shows on the
-- INTERNAL and EXTERNAL conditions-to-close list, on both staff and borrower.
-- Mirrors migration 066. Idempotent (NOT EXISTS guard). Cancelled/declined/
-- withdrawn/funded and deleted files are skipped.
INSERT INTO checklist_items
  (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
   phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
   clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id)
SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
       COALESCE(t.role_scope,'any'), t.phase, t.hint, t.borrower_hint,
       COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
       COALESCE(t.sort_order,130), t.tool_key, t.clickup_field_id,
       COALESCE(t.tpr_exclude,false), 'system',
       COALESCE(t.is_required,true), a.id
  FROM applications a
 CROSS JOIN checklist_templates t
 WHERE t.code = 'rtl_p1_llc'
   AND t.is_active = true
   AND a.deleted_at IS NULL
   AND a.status IN ('new','in_review','processing','underwriting','approved','clear_to_close')
   AND EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.application_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.application_id = a.id
                      AND ci.template_id = t.id);

-- For every file that already has (or just got) the LLC condition AND a linked,
-- VERIFIED vesting entity, make sure the condition reflects that (satisfied/signed
-- off) instead of sitting as a phantom open gate. Unverified/linked entities are
-- left to the normal sync (syncLlcConditions) so their state stays live.
UPDATE checklist_items ci
   SET status = 'satisfied',
       signed_off_by = COALESCE(ci.signed_off_by, l.verified_by),
       signed_off_at = COALESCE(ci.signed_off_at, l.verified_at, now()),
       updated_at = now()
  FROM checklist_templates t, applications a, llcs l
 WHERE t.id = ci.template_id AND t.code = 'rtl_p1_llc'
   AND a.id = ci.application_id AND a.deleted_at IS NULL
   AND l.id = a.llc_id AND l.is_verified = true
   AND ci.status IS DISTINCT FROM 'satisfied';
