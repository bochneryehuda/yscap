-- 472_borrower_assistants.sql
-- Borrower-assistant login (owner-directed): a borrower may authorize an
-- ASSISTANT with their own login who "can do everything but not see the personal
-- information and not sign documents".
--
-- The assistant is a SECOND credential tied to a borrower. It is stored in its
-- OWN table (blast-radius separation, exactly like `borrowers` vs `borrower_auth`)
-- so an assistant credential can never be confused with the borrower's own login,
-- can be disabled independently, and never carries the borrower's PII.
--
-- At sign-in the assistant is handed a REAL borrower-kind access token whose
-- `sub` is the borrower id (so every already-borrower-scoped endpoint works with
-- no new code) PLUS an assistant envelope (`asst`/`asstId`/`astv`) that
-- `authenticate()` re-validates on every request — the same dual-identity model
-- as Borrower View. The envelope is what strips PII and blocks the signing
-- ceremony; nothing else changes.

CREATE TABLE IF NOT EXISTS borrower_assistants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  borrower_id       uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
  email             text NOT NULL,
  name              text,
  -- NULL until the assistant accepts the invite and sets a password.
  password_hash     text,
  token_version     integer NOT NULL DEFAULT 0,
  -- One-time set-password link, stored HASHED (never the raw token) + an expiry.
  invite_token_hash text,
  invite_expires_at timestamptz,
  -- Provenance: who set this assistant up (a staff row, or the borrower themselves).
  invited_by_staff  uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  invited_by_self   boolean NOT NULL DEFAULT false,
  failed_attempts   integer NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  last_login_at     timestamptz,
  -- A disabled assistant keeps its row (audit trail) but can never sign in.
  disabled_at       timestamptz,
  disabled_by       uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- An assistant signs in by email, so an active assistant email must resolve to
-- exactly one live assistant. A disabled row is excluded so the same email can be
-- re-invited later. Emails are stored lower-cased by the app.
CREATE UNIQUE INDEX IF NOT EXISTS borrower_assistants_email_uk
  ON borrower_assistants (lower(email))
  WHERE disabled_at IS NULL;

CREATE INDEX IF NOT EXISTS borrower_assistants_borrower_idx
  ON borrower_assistants (borrower_id) WHERE disabled_at IS NULL;
