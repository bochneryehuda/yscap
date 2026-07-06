-- =====================================================================
-- 004_email_auth.sql — email verification, password reset, and email-OTP
-- infrastructure. Idempotent (safe to re-run).
--
--   * borrower_auth.email_verified already exists (base schema); we add a
--     timestamp stamp for audit/GLBA trails.
--   * email_tokens holds single-use magic-link tokens AND 6-digit codes for
--     three flows: 'verify' (confirm email), 'reset' (password reset),
--     'login' (email one-time passcode — infrastructure ready for a future
--     email-based 2FA path; TOTP remains the live second factor).
--   * Only hashes are stored — the raw token/code lives only in the email.
-- =====================================================================

ALTER TABLE borrower_auth ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS email_tokens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    borrower_id  uuid REFERENCES borrowers(id)   ON DELETE CASCADE,
    staff_id     uuid REFERENCES staff_users(id) ON DELETE CASCADE,
    email        citext,
    kind         text NOT NULL CHECK (kind IN ('verify','reset','login')),
    token_hash   text,                       -- sha256 of the URL token (magic-link flows)
    code_hash    text,                       -- sha256 of the numeric code (OTP flows)
    expires_at   timestamptz NOT NULL,
    used_at      timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT email_tokens_owner_chk
        CHECK (borrower_id IS NOT NULL OR staff_id IS NOT NULL OR email IS NOT NULL),
    CONSTRAINT email_tokens_secret_chk
        CHECK (token_hash IS NOT NULL OR code_hash IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_email_tokens_token
    ON email_tokens(token_hash) WHERE token_hash IS NOT NULL AND used_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_email_tokens_borrower
    ON email_tokens(borrower_id, kind) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_email_tokens_email
    ON email_tokens(email, kind) WHERE used_at IS NULL;
