-- One-shot the e-sign magic-link "log me back in" handoff (task #35, audit MED-1).
--
-- The return-auth (`ra`) token rides in the DocuSign returnUrl, so it is briefly
-- present in the borrower's browser history / any proxy log. /api/esign/return must
-- therefore mint a login code for a given `ra` (keyed by its `jti`) AT MOST ONCE —
-- otherwise a captured returnUrl could be replayed to keep minting borrower sessions.
-- /return records the jti as a USED email_tokens('login') marker (token_hash =
-- sha256('esign_ra:'||jti)) and refuses a second handoff.
--
-- This partial UNIQUE index makes that claim ATOMIC: /return does
--   INSERT ... ON CONFLICT (token_hash) WHERE kind='login' AND token_hash IS NOT NULL DO NOTHING
-- and mints the login code only if the marker INSERT won the row — so even two returns
-- racing the SAME `ra` can hand out a session exactly once.
--
-- Safe to add: every kind='login' token_hash is already unique by construction — a real
-- login code is sha256 of a random 24-byte token, and a jti marker is sha256 of a random
-- 12-byte jti — so no existing rows collide. Idempotent (IF NOT EXISTS).
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_tokens_login_hash
  ON email_tokens (token_hash)
  WHERE kind = 'login' AND token_hash IS NOT NULL;
