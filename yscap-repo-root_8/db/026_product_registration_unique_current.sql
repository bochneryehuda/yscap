-- =====================================================================
-- 026_product_registration_unique_current.sql — enforce the "one current
-- registration per file" invariant at the database level. Replaces the plain
-- partial index from 025 with a UNIQUE partial index so two concurrent
-- registrations can't both leave an is_current=true row (the loser's
-- transaction fails and rolls back). Idempotent.
-- =====================================================================

DROP INDEX IF EXISTS idx_product_reg_current;
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_reg_current
  ON product_registrations(application_id) WHERE is_current;
