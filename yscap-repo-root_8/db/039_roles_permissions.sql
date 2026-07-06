-- ============================================================================
-- 039_roles_permissions.sql — role personas + per-user permission grants
--
-- Adds two staff personas (loan_coordinator, software_setup) and a
-- permissions jsonb on staff_users for per-user capability overrides on top of
-- the role's defaults. Capabilities and role defaults live in
-- src/lib/permissions.js; a NULL/absent permissions value means "use the role
-- defaults", and per-capability booleans in the jsonb override those.
--
-- Idempotent: safe to re-run.
-- ============================================================================

ALTER TABLE staff_users DROP CONSTRAINT IF EXISTS staff_users_role_check;
ALTER TABLE staff_users ADD  CONSTRAINT staff_users_role_check
  CHECK (role IN ('super_admin','admin','underwriter','loan_officer','loan_coordinator','processor','software_setup'));

ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS permissions jsonb;
