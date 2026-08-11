-- 490_tpo_firm_credit_credentials.sql — TPO "own-Xactus" (owner roadmap Phase 5b):
-- a brokerage firm may pull CREDIT on THEIR OWN Xactus account instead of ours.
--
-- One optional credentials row per firm. When a firm has an ACTIVE row, a credit
-- pull for that firm's file uses these credentials; otherwise every pull uses our
-- shared company account exactly as before (config.xactusProd). So this table is
-- INERT until an admin configures a firm — with no rows, behavior is byte-identical
-- to today. FLOOD is always ordered on our account (never per-firm), unchanged.
--
-- The password is stored ENCRYPTED at rest (AES-256-GCM via crypto.encryptSecret,
-- the SSN_ENCRYPTION_KEY cipher) as bytea — the plaintext is never stored, never
-- selected back to any client, and never logged (provider.scrubCredentials strips
-- the ACTIVE login from every error/log line). The endpoint/username/account are
-- config, not secrets, and are stored in the clear so an admin can see what is set.

CREATE TABLE IF NOT EXISTS tpo_firm_credit_credentials (
  tpo_firm_id        uuid PRIMARY KEY REFERENCES tpo_firms(id) ON DELETE CASCADE,
  endpoint           text NOT NULL,                 -- the firm's Xactus Credit ReportX request URL
  username           text NOT NULL,                 -- the firm's Xactus login (Operator ID)
  password_encrypted bytea NOT NULL,                 -- AES-256-GCM ciphertext; NEVER returned to a client
  account            text,                           -- optional account / subscriber id
  client_id          text,                           -- optional client id
  version            text,                           -- interface version override (default falls back to ours: 3.4)
  requesting_party   text,                           -- RequestingParty name printed in the MISMO request
  auth_mode          text NOT NULL DEFAULT 'basic' CHECK (auth_mode IN ('basic','query')),
  is_active          boolean NOT NULL DEFAULT true,  -- turn a firm's own-account off without deleting it
  configured_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  configured_at      timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- A `touch updated_at` trigger so every write keeps the stamp fresh without hand-setting it.
CREATE OR REPLACE FUNCTION tpo_firm_credit_credentials_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_tpo_firm_credit_creds_touch ON tpo_firm_credit_credentials;
CREATE TRIGGER trg_tpo_firm_credit_creds_touch
  BEFORE UPDATE ON tpo_firm_credit_credentials
  FOR EACH ROW EXECUTE FUNCTION tpo_firm_credit_credentials_touch();
