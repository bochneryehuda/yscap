-- ============================================================================
-- 472 — TPO PORTAL, foundation part 1: the brokerage FIRM + the external TPO
--       user identity (owner-directed 2026-08-04: "We're rolling out a TPO
--       portal … connect brokerage firms and users within that firm to handle
--       files. They should be the loan officer on the file; we're the lender's
--       account executive / account manager.").
--
-- This is an RTL build — a wholesale ORIGINATION CHANNEL for the main RTL
-- product. It is NOT a third product: a TPO loan is a normal RTL `applications`
-- row, flagged TPO (db/473). Design + the owner's locked decisions:
-- docs/TPO-PORTAL-BLUEPRINT.md.
--
-- IDENTITY MODEL (see the auth spine in src/auth/index.js + src/lib/permissions.js):
--   • A brokerage firm is a `tpo_firms` row.
--   • A TPO user (a broker, or one of their processors) is a `staff_users` row
--     flagged `is_external=true` with `tpo_firm_id` set and a role of
--     `tpo_officer` / `tpo_processor`. Storing them in staff_users — rather than
--     a parallel table — is deliberate: `applications.loan_officer_id`,
--     `application_assignees.staff_id`, the "Your loan officer" card
--     (notify.fileContext) and every file-scope gate already point at
--     staff_users, so the broker-as-loan-officer mapping works with no rewrite.
--   • Their SESSION carries `kind='tpo'` (not `'staff'`), so they route to the
--     third front door and are structurally refused by `requireStaff` /
--     `requireBorrower`. Firm scoping is enforced in permissions.tpoFirmScopeSql.
--
-- Idempotent — safe to re-run on every boot.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (1) The brokerage firm.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tpo_firms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  nmls        text,                                        -- the firm's NMLS #, if any
  notes       text,
  created_by  uuid REFERENCES staff_users(id) ON DELETE SET NULL,   -- the internal admin who onboarded it
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tpo_firms_status ON tpo_firms(status);

-- ----------------------------------------------------------------------------
-- (2) The external-user flags on staff_users. All default to the INTERNAL value
--     (is_external=false, firm NULL), so every existing staffer is byte-for-byte
--     an internal user — previous AND future.
-- ----------------------------------------------------------------------------
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS is_external   boolean NOT NULL DEFAULT false;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS tpo_firm_id   uuid REFERENCES tpo_firms(id) ON DELETE SET NULL;
-- The lead broker for a firm: may invite their own firm's processors (Phase 2).
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS is_firm_admin boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_staff_users_firm ON staff_users(tpo_firm_id) WHERE tpo_firm_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- (3) Add the two EXTERNAL roles to the staff role set. Re-assert the FULL list
--     (the drop-then-add pattern of db/131 / db/212) so the constraint is exact
--     and a superset — no existing row can fail it.
--     tpo_officer   = the broker (the loan officer on their files)
--     tpo_processor = a processor on the broker's own team
-- ----------------------------------------------------------------------------
ALTER TABLE staff_users DROP CONSTRAINT IF EXISTS staff_users_role_check;
ALTER TABLE staff_users ADD  CONSTRAINT staff_users_role_check
  CHECK (role IN ('super_admin','admin','underwriter','loan_officer','loan_coordinator',
                  'draw_coordinator','processor','closer','software_setup',
                  'tpo_officer','tpo_processor'));

-- ----------------------------------------------------------------------------
-- (4) SAFETY INVARIANTS a bug could otherwise violate:
--   · an EXTERNAL user must belong to a firm (an external user with no firm has
--     no scope — every file/borrower query would be unbounded), and
--   · an INTERNAL user must never carry a firm.
--   Enforced as a table CHECK so no write path — present or future — can create
--   an unscoped external identity.
-- ----------------------------------------------------------------------------
ALTER TABLE staff_users DROP CONSTRAINT IF EXISTS staff_users_external_firm_check;
ALTER TABLE staff_users ADD  CONSTRAINT staff_users_external_firm_check
  CHECK ( (is_external = true  AND tpo_firm_id IS NOT NULL)
       OR (is_external = false AND tpo_firm_id IS NULL) );
