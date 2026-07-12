-- 088_mfa_backup_codes.sql — one-time recovery codes for 2FA (S1-09 / self-service 2FA).
--
-- When a user turns on two-factor, they get a set of one-time backup codes to save
-- so losing their authenticator app doesn't lock them out. Stored HASHED (sha256);
-- the plaintext is shown to the user exactly once. A used code is removed from the
-- array. Applies to both login tables. Idempotent; NULL = no codes.
ALTER TABLE staff_users   ADD COLUMN IF NOT EXISTS mfa_backup_codes text[];
ALTER TABLE borrower_auth ADD COLUMN IF NOT EXISTS mfa_backup_codes text[];
