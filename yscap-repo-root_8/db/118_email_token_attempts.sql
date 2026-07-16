-- 118_email_token_attempts.sql — S1-09: cap wrong-code guesses on email tokens.
--
-- The email-confirmation flow can be completed with a 6-digit code (the token
-- link is the default since #94, but the code path still exists). Without an
-- attempt cap a code is brute-forceable while it's valid. This column lets the
-- /verify handler retire an active token after a handful of wrong guesses, the
-- same "lock after a few tries" protection the 2FA (MFA) path already has.
-- Idempotent.
ALTER TABLE email_tokens ADD COLUMN IF NOT EXISTS code_attempts integer NOT NULL DEFAULT 0;
