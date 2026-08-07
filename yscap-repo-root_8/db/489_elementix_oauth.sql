-- 489_elementix_oauth.sql — where PILOT keeps its Elementix authorization.
--
-- Elementix's MCP endpoint uses the standard MCP OAuth flow (confirmed by the
-- vendor, 2026-08-07: "standard OAuth flow for the MCP endpoint — the AI
-- client/harness will handle the work for you"). That answer is written for
-- somebody sitting in Cursor with a browser open. PILOT is a server with nobody
-- at the keyboard, so the shape we need is: a human approves ONCE in a browser,
-- and from then on PILOT renews the access by itself with a refresh token.
--
-- This table is that stored authorization. Nothing here is a credential the
-- owner has to buy — it is the same seat they already pay for, approved once.
--
-- TOKENS ARE ENCRYPTED AT REST. The columns are named *_enc and the only writer
-- is src/elementix/oauth.js, which refuses to store a token it cannot encrypt.
-- A token in plaintext in a jsonb blob would be readable by every admin query
-- and every database backup, so there is no plaintext path at all.
--
-- Idempotent; applied on every boot.

CREATE TABLE IF NOT EXISTS elementix_oauth (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The SCOPE of this authorization. NULL = the company-wide connection (one
  -- Elementix seat, shared by the whole team — the likely shape today). A staff
  -- id = that one officer's own connection, for the day the owner buys seats
  -- per officer and wants each officer's lookups and spend attributed to them.
  -- Both shapes are supported from day one so the choice is not load-bearing on
  -- the schema; see the two partial unique indexes below.
  staff_id          uuid REFERENCES staff_users(id) ON DELETE CASCADE,

  -- The MCP endpoint this authorization is FOR. Recorded rather than assumed:
  -- an OAuth token is bound to a resource, and if the endpoint ever moves, a
  -- token minted for the old one must not be replayed against the new one.
  resource_url      text NOT NULL,

  -- What discovery found. Kept so a human can answer "what does this server
  -- actually support?" without re-probing, and so a refresh knows where to go.
  auth_server       text,
  token_endpoint    text,
  discovery         jsonb,

  -- The OAuth client. client_id comes from dynamic client registration
  -- (RFC 7591) when the server supports it, else from ELEMENTIX_CLIENT_ID.
  -- A public client has no secret, so client_secret_enc is nullable by design.
  client_id         text,
  client_secret_enc text,

  access_token_enc  text,
  refresh_token_enc text,
  token_type        text,
  scope             text,
  expires_at        timestamptz,

  -- Provenance. Somebody clicked Approve; this records who and when.
  connected_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  connected_at      timestamptz,
  last_refresh_at   timestamptz,

  -- The last failure, in plain words, so the API-Health page can say what is
  -- wrong instead of showing a dead switch. Cleared on the next success.
  last_error        text,
  last_error_at     timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Exactly one company-wide row, and at most one row per officer. Two partial
-- indexes rather than one on (staff_id) because a plain unique index treats two
-- NULLs as distinct, which would let a second company-wide connection appear
-- and leave "which token is live?" ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS uq_elementix_oauth_company
  ON elementix_oauth (resource_url) WHERE staff_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_elementix_oauth_staff
  ON elementix_oauth (resource_url, staff_id) WHERE staff_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The in-flight authorization.
--
-- The OAuth authorization-code flow hands the browser off to Elementix and back
-- again, so the PKCE verifier and the CSRF state have to survive the round trip.
-- They live in the DATABASE rather than in process memory on purpose: PILOT runs
-- more than one instance on Render, so the callback can land on a different
-- process than the one that started the flow, and an in-memory map would lose
-- the verifier and fail every approval on a scaled service.
--
-- Rows are short-lived and swept; `state` is the lookup key and is random.
CREATE TABLE IF NOT EXISTS elementix_oauth_pending (
  state             text PRIMARY KEY,
  code_verifier     text NOT NULL,
  staff_id          uuid REFERENCES staff_users(id) ON DELETE CASCADE,
  resource_url      text NOT NULL,
  auth_server       text,
  token_endpoint    text,
  client_id         text,
  client_secret_enc text,
  discovery         jsonb,
  redirect_uri      text NOT NULL,
  scope             text,
  started_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_elementix_pending_expiry
  ON elementix_oauth_pending (expires_at);
