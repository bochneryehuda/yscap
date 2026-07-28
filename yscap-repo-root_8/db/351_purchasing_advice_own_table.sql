-- 351 — Purchase advice moves OFF purchasing_workflow onto its own table.
--
-- db/350 put `purchase_advice_date` / `purchase_advice_document_id` ON the
-- `purchasing_workflow` row. That row is DELETED by
-- purchasing.withdrawFromPurchasing — which runs on two ordinary closer actions:
-- switching the warehouse to Table Funding, and un-signing investor delivery.
-- So the recorded purchase advice date and the pointer to the advice document
-- were silently destroyed, with no warning and no audit of the loss, while the
-- notes / tasks / conditions sitting beside them survived (they are keyed on
-- application_id in their own tables). Nothing looked wrong.
--
-- Purchase advice is a fact about the LOAN, not about the file's current
-- membership of the purchasing desk, so it belongs in the same shape as the
-- others: its own table keyed on application_id, surviving a withdrawal.
--
-- Idempotent: IF NOT EXISTS throughout, and the copy-forward is NOT EXISTS-
-- guarded and only runs while the old columns still exist. The old columns are
-- deliberately left in place (never destructive); nothing reads them after this.

CREATE TABLE IF NOT EXISTS purchasing_advice (
  application_id  uuid PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  advice_date     date,
  document_id     uuid REFERENCES documents(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL
);

-- Carry forward anything db/350 already recorded (guarded so it is a no-op both
-- on a fresh database and on every later boot).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'purchasing_workflow' AND column_name = 'purchase_advice_date'
       AND table_schema = current_schema()
  ) THEN
    INSERT INTO purchasing_advice (application_id, advice_date, document_id, updated_at, updated_by)
    SELECT p.application_id, p.purchase_advice_date, p.purchase_advice_document_id,
           COALESCE(p.purchase_advice_updated_at, now()), p.purchase_advice_updated_by
      FROM purchasing_workflow p
     WHERE (p.purchase_advice_date IS NOT NULL OR p.purchase_advice_document_id IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM purchasing_advice a WHERE a.application_id = p.application_id);
  END IF;
END $$;
