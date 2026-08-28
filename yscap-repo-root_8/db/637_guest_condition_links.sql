-- ============================================================================
-- db/637 — guest condition links
--
-- WHAT THIS CHANGES, AND WHY (owner-directed 2026-08-28): borrowers who are
-- "not so technical" need "another way to manage their conditions … without him
-- being able to set up an account or portal" — an EMAILED outstanding-conditions
-- list where every condition carries a direct button to upload / fill in, and
-- pressing Save lands it straight on the file, no login. The button's link must
-- therefore be a capability on its own: this table records those links.
--
-- One row per minted link. The clear token exists only at mint time and only in
-- the email — the row stores a sha256, exactly like `term_sheet_offers` and
-- `invite_tokens`. Opening the link exchanges the token for a REAL borrower-kind
-- access token carrying a guest envelope (the `borrower_assistants` dual-identity
-- model), so every existing borrower endpoint, guard, scrub and freeze applies
-- with no second implementation; auth re-validates this row on EVERY request, so
-- revoking a link (or its expiry passing) kills live sessions immediately.
--
-- The link is scoped to ONE application AND ONE borrower identity (the primary's
-- or the co-borrower's — whichever person the email went to), because a
-- co-borrower's link must answer THEIR personal conditions, never the primary's.
--
-- BACKFILL: none — this table is new and starts empty; links exist only from the
-- moment staff first send an outstanding-conditions email.
--
-- PRODUCT SEPARATION: RTL only. `applications` / `borrowers` are RTL + shared
-- identity; nothing here touches `lt_*`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS condition_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- WHOSE view this link opens (the primary borrower or the co-borrower). The
  -- guest session acts as this person, so per-borrower privacy (#82) holds.
  borrower_id     uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
  -- Where the link was sent (the borrower's own address, or their helper's).
  -- Recorded for the audit trail and the staff screen — never used to authorize.
  sent_to_email   text NOT NULL,
  token_hash      text NOT NULL,
  created_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- A link is a standing convenience, not a standing key: it expires. Every
  -- fresh send mints a fresh link; old ones keep working until expiry unless
  -- revoked.
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  last_used_at    timestamptz,
  use_count       integer NOT NULL DEFAULT 0
);

-- The exchange looks a token up by its hash; expiry/revocation are checked in
-- the query, so the partial index keeps only the candidates that could match.
CREATE UNIQUE INDEX IF NOT EXISTS condition_links_token_uk
  ON condition_links (token_hash);
CREATE INDEX IF NOT EXISTS condition_links_app_idx
  ON condition_links (application_id, created_at DESC);

-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself.
