-- 052_checklist_dedup_round2.sql
-- Second internal-checklist dedup pass (owner-directed follow-up to db/040).
-- Now that the actual Title, Insurance, and Signed-term-sheet work is tracked as
-- CONDITIONS (rtl_cond_title, rtl_cond_insurance, rtl_cond_signedts — db/051),
-- the equivalent internal-checklist TASK items are duplicates and are folded:
--
--   rtl_p3_titleord  Title order email sent          → Title condition
--   rtl_p3_insord    Insurance order email sent       → Insurance condition
--   rtl_p4_ts        Term sheet generated             → Signed-term-sheet condition
--
-- The Title/Insurance CONTACT items (rtl_p1_titlec, rtl_p1_insc) and the
-- attorney-handoff step (rtl_p5_titleinfo) are intentionally KEPT — the owner
-- asked to remove the actual title/insurance work, "other than the contact."
--
-- Deactivating the templates (is_active=false) ALSO stops the RTL checklist
-- backfill (server boot) from re-adding them, since it only instantiates active
-- templates. One-time, guarded by data_migrations so a reactivation later sticks.

CREATE TABLE IF NOT EXISTS data_migrations (
  key        text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM data_migrations WHERE key = '052_checklist_dedup_round2') THEN
    -- Never seed these onto new files again (and keep the backfill from re-adding them).
    UPDATE checklist_templates
       SET is_active = false, updated_at = now()
     WHERE code IN ('rtl_p3_titleord', 'rtl_p3_insord', 'rtl_p4_ts');

    -- Strip existing instances off files that are still open (terminal/funded
    -- files keep their history). Any attached document survives —
    -- documents.checklist_item_id is ON DELETE SET NULL.
    DELETE FROM checklist_items ci
      USING checklist_templates t, applications a
     WHERE ci.template_id = t.id
       AND t.code IN ('rtl_p3_titleord', 'rtl_p3_insord', 'rtl_p4_ts')
       AND a.id = ci.application_id
       AND a.deleted_at IS NULL
       AND a.status IN ('new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close');

    INSERT INTO data_migrations(key) VALUES ('052_checklist_dedup_round2');
  END IF;
END $$;
