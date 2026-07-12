-- 089_mfa_lockout_counter.sql — dedicated lockout counter for the 2FA step (S1-09).
--
-- The MFA verify step must NOT share the password login's failed_attempts /
-- locked_until: a successful password login resets those, so an attacker who
-- knows the password could re-login to zero the counter and guess 2FA codes
-- forever without ever tripping the lock. These separate columns are cleared only
-- by a successful 2FA step (or when 2FA is re-enabled), so the lock actually holds.
-- Idempotent.
ALTER TABLE staff_users   ADD COLUMN IF NOT EXISTS mfa_failed_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE staff_users   ADD COLUMN IF NOT EXISTS mfa_locked_until    timestamptz;
ALTER TABLE borrower_auth ADD COLUMN IF NOT EXISTS mfa_failed_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE borrower_auth ADD COLUMN IF NOT EXISTS mfa_locked_until    timestamptz;
