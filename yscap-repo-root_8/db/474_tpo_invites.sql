-- ============================================================================
-- 474 — TPO PORTAL, phase 2a: firm onboarding + the broker/processor INVITE.
--       Depends on db/472 (tpo_firms, staff_users external flags).
--
-- An internal admin creates a firm and invites the lead broker; the lead broker
-- (a firm admin) invites their own processors. Both invites reuse the existing
-- `invite_tokens` + `/auth/accept` machinery, so the invite carries WHICH firm,
-- WHICH external role, and WHETHER the invitee is a firm admin.
--
-- Idempotent — safe to re-run on every boot.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (1) Carry the firm + firm-admin flag on a tpo invite. A retired firm's
--     pending invites go with it (firms are retired via status='closed', not
--     deleted, so CASCADE is defensive rather than routine).
-- ----------------------------------------------------------------------------
ALTER TABLE invite_tokens ADD COLUMN IF NOT EXISTS tpo_firm_id   uuid REFERENCES tpo_firms(id) ON DELETE CASCADE;
ALTER TABLE invite_tokens ADD COLUMN IF NOT EXISTS is_firm_admin boolean NOT NULL DEFAULT false;

-- The invite `kind` gains 'tpo' (was staff | borrower only). Drop-then-add so
-- the widened set is exact; a superset, so no existing invite can fail it.
ALTER TABLE invite_tokens DROP CONSTRAINT IF EXISTS invite_tokens_kind_check;
ALTER TABLE invite_tokens ADD  CONSTRAINT invite_tokens_kind_check
  CHECK (kind IN ('staff','borrower','tpo'));

-- ----------------------------------------------------------------------------
-- (2) A firm-admin is always an external user (audit follow-up, db/472 §4
--     didn't cover this): `is_firm_admin=true` implies `is_external=true`. All
--     existing rows are is_firm_admin=false, so none can fail.
-- ----------------------------------------------------------------------------
ALTER TABLE staff_users DROP CONSTRAINT IF EXISTS staff_users_firm_admin_check;
ALTER TABLE staff_users ADD  CONSTRAINT staff_users_firm_admin_check
  CHECK (is_firm_admin = false OR is_external = true);
