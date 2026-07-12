-- 084_staff_login_security.sql — brute-force lockout for STAFF logins (S1-02).
--
-- Staff accounts (which can see every borrower's PII and decrypted SSNs) had NO
-- failed-attempt lockout, unlike borrowers. Mirror borrower_auth's counters so
-- the staff login can lock after repeated wrong passwords. Idempotent; the
-- columns default to 0/NULL so existing rows are unaffected.
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS failed_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS locked_until    timestamptz;
