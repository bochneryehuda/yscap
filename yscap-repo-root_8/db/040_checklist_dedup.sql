-- 040_checklist_dedup.sql
-- Fold internal-checklist tasks that duplicate borrower conditions into the
-- conditions themselves. Borrower-facing ('both') items are already separated
-- out of the "Internal checklist" section by the staff UI (it renders only
-- audience='staff' rows); these four are the staff-only tasks the product owner
-- explicitly asked to remove because the same work is now tracked as a
-- condition:
--   rtl_p1_ssn    SSN collected & saved            (borrower profile / SSN condition)
--   rtl_p1_addr   Primary address + occupancy      (borrower profile)
--   rtl_p1_suite  Investor Suite link sent (SOW)   (rehab-budget / SOW condition)
--   rtl_p1_pay    Appraisal payment method         (appraisal-card condition)
--
-- This is a ONE-TIME data change guarded by data_migrations so re-running it on
-- every boot never re-disables a template an admin later chooses to reactivate
-- (the numbered migrations here run on every startup).

CREATE TABLE IF NOT EXISTS data_migrations (
  key        text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM data_migrations WHERE key = '040_checklist_dedup') THEN
    -- Never seed these onto new files again.
    UPDATE checklist_templates
       SET is_active = false, updated_at = now()
     WHERE code IN ('rtl_p1_ssn', 'rtl_p1_addr', 'rtl_p1_suite', 'rtl_p1_pay');

    -- Strip existing instances off files that are still open (terminal files
    -- keep their history untouched). Any attached document survives —
    -- documents.checklist_item_id is ON DELETE SET NULL.
    DELETE FROM checklist_items ci
      USING checklist_templates t, applications a
     WHERE ci.template_id = t.id
       AND t.code IN ('rtl_p1_ssn', 'rtl_p1_addr', 'rtl_p1_suite', 'rtl_p1_pay')
       AND a.id = ci.application_id
       AND a.deleted_at IS NULL
       AND a.status IN ('new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close');

    INSERT INTO data_migrations(key) VALUES ('040_checklist_dedup');
  END IF;
END $$;
