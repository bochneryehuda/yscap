-- 057_llc_condition_internal_verify.sql
-- #57 — the RTL "LLC" condition is the INTERNAL verification of the vesting
-- entity (the LLC taking title on THIS property). The borrower still links the
-- entity and uploads its three documents from their profile (borrower_label /
-- borrower_hint unchanged, audience stays 'both'); but the staff-facing wording
-- now reads as the inline internal verification it really is — confirm entity
-- details, 100% ownership and the Certificate of Formation + EIN letter +
-- Operating Agreement, then mark the entity verified (which auto-satisfies this
-- condition on every open file it vests). Sign-off remains staff-only.
--
-- Presentation only — no audience/kind/gate change, so the borrower's LLC
-- linking + upload flow is untouched. Idempotent (guarded by IS DISTINCT FROM).

UPDATE checklist_templates
   SET label = 'LLC (vesting entity) — verify entity, ownership & the three documents',
       hint  = 'Internal verification of the LLC taking title on this property: confirm EIN, formation state & date and that ownership totals 100%, review the Certificate of Formation, IRS EIN letter and Operating Agreement, then mark the entity verified. Verifying it satisfies this condition on every open file it vests.',
       updated_at = now()
 WHERE code = 'rtl_p1_llc'
   AND label IS DISTINCT FROM 'LLC (vesting entity) — verify entity, ownership & the three documents';

UPDATE checklist_items ci
   SET label = t.label, hint = t.hint, updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id AND t.code = 'rtl_p1_llc'
   AND (ci.label IS DISTINCT FROM t.label OR ci.hint IS DISTINCT FROM t.hint);
