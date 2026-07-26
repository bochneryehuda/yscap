-- 321: per-DEVICE session revocation.
--
-- Why this exists (owner-reported 2026-07-26: "staff keep getting signed out
-- automatically / signed out right after signing in"):
--
-- Session revocation used to have exactly ONE lever — the global
-- `token_version` counter on staff_users / borrower_auth. Bumping it kills
-- EVERY session that person has, on EVERY device. And plain "Sign out" bumped
-- it. So signing out on a phone silently killed the desktop session, a
-- password change killed every open tab, and each of those surfaced to the
-- user as the generic "You were signed out because your session expired."
--
-- Each access token now carries a random session id (`sid`). Signing out
-- revokes ONLY that sid (this device), by writing the row here. token_version
-- stays as the "sign out EVERYWHERE" hammer for the events that genuinely
-- warrant it: password reset/change, admin deactivation, an explicit
-- "sign out of all devices".
--
-- Rows are only meaningful until the token they revoke would have expired on
-- its own (ACCESS_TTL_SEC), so this table is self-limiting; the auth layer
-- prunes anything older than 60 days on boot. A token minted BEFORE this
-- shipped has no `sid` — it is simply never matched here and keeps working off
-- token_version alone, so nobody is signed out by the deploy.
CREATE TABLE IF NOT EXISTS revoked_sessions (
  sid         text PRIMARY KEY,
  actor_kind  text NOT NULL,
  actor_id    uuid,
  revoked_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS revoked_sessions_revoked_at_idx ON revoked_sessions (revoked_at);
CREATE INDEX IF NOT EXISTS revoked_sessions_actor_idx      ON revoked_sessions (actor_kind, actor_id);

-- Self-pruning. Every numbered migration is replayed on every boot, so this is
-- the cheapest place to keep the table bounded: a revoked sid is meaningless
-- once the token it belongs to has expired on its own, and 60 days is
-- comfortably past the longest session we issue (ACCESS_TTL_SEC, 30 days).
DELETE FROM revoked_sessions WHERE revoked_at < now() - interval '60 days';
