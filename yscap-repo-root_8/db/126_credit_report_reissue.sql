-- ============================================================================
-- 126 - Credit report reissue + FICO verification (owner-directed 2026-07-19)
--
-- Storage for the Xactus (Xactus360) credit integration + the FICO hard-freeze.
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT). No build wiring
-- here — this is the data layer + the DB-level freeze belt.
--
-- Sections:
--   A. credit_providers            — multi-provider registry (Xactus seeded, default)
--   B. user_credit_credentials     — each user's OWN encrypted login (per-user, no surrogate)
--   C. credit_reports / credit_scores — imported report + per-bureau scores (XML is the data)
--   D. borrowers verified-FICO columns + BEFORE UPDATE freeze trigger + audit
--   E. applications.fico_used_for_pricing — the score/bracket the loan was priced on
-- ============================================================================

-- ---- A. provider registry --------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_providers (
  id            serial PRIMARY KEY,
  key           text UNIQUE NOT NULL,
  display_name  text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  is_default    boolean NOT NULL DEFAULT false,
  capabilities  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO credit_providers (key, display_name, enabled, is_default, capabilities)
VALUES ('xactus', 'Xactus', true, true,
        '{"reissue":true,"softPull":true,"hardPull":true,"joint":true,"bureaus":["Equifax","Experian","TransUnion"]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---- B. per-user credentials (encrypted; write-only from the UI) ------------
CREATE TABLE IF NOT EXISTS user_credit_credentials (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  provider_id         integer NOT NULL REFERENCES credit_providers(id),
  operator_identifier text NOT NULL,               -- LoginAccountIdentifier (not secret)
  secret_encrypted    bytea NOT NULL,              -- AES-256-GCM ciphertext (crypto.js chokepoint)
  status              text NOT NULL DEFAULT 'unverified',  -- unverified | ok | invalid
  last_verified_at    timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider_id)
);

-- ---- C. imported reports + per-bureau scores -------------------------------
CREATE TABLE IF NOT EXISTS credit_reports (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id           uuid REFERENCES applications(id) ON DELETE SET NULL,
  provider_id              integer NOT NULL REFERENCES credit_providers(id),
  credit_report_identifier text,                   -- Xactus CreditReportIdentifier (drives Reissue)
  report_type              text,                   -- Other | Merge
  other_description        text,                   -- SoftCheck (soft pull)
  request_type             text,                   -- Individual | Joint
  action_type              text,                   -- Reissue | Submit | ForceNew | Upgrade | Unmerge
  first_issued_date        date,                   -- drives the 120-day condition reopen
  last_updated_date        date,
  ordered_by               uuid REFERENCES staff_users(id),
  credential_id            uuid REFERENCES user_credit_credentials(id),
  permissible_purpose_basis text,
  xml_encrypted            bytea,                  -- encrypted raw response XML (never cleartext)
  pdf_document_id          uuid REFERENCES documents(id),  -- stored, access-controlled PDF
  status                   text NOT NULL DEFAULT 'imported',  -- imported | error | review
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_reports_app ON credit_reports(application_id);
CREATE INDEX IF NOT EXISTS idx_credit_reports_identifier ON credit_reports(credit_report_identifier);

CREATE TABLE IF NOT EXISTS credit_scores (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_report_id  uuid NOT NULL REFERENCES credit_reports(id) ON DELETE CASCADE,
  borrower_id       uuid REFERENCES borrowers(id),
  report_borrower_id text,                         -- B1 / C1 from the XML
  bureau            text,                          -- Equifax | Experian | TransUnion
  model             text,                          -- EquifaxBeacon5.0 | ExperianFairIsaac | FICORiskScoreClassic04
  value             integer,                       -- NULL when no-score / excluded (never 0)
  raw_value         text,                          -- exactly as returned (audit)
  exclusion_reason  text,
  usable            boolean NOT NULL DEFAULT false,
  reason            text,                          -- ok | excluded | model_mismatch | out_of_range | unknown_bureau
  score_date        date,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_scores_report ON credit_scores(credit_report_id);
CREATE INDEX IF NOT EXISTS idx_credit_scores_borrower ON credit_scores(borrower_id);

-- ---- D. FICO hard-freeze on borrowers --------------------------------------
-- borrowers.fico stays the WORKING score: a staff/borrower ESTIMATE before a
-- report is imported, and the VERIFIED score (locked) after. On import the app
-- writes verified_fico + lineage, copies it into fico (so pricing/ClickUp/display
-- all read the verified value), and sets fico_locked = true.
ALTER TABLE borrowers
  ADD COLUMN IF NOT EXISTS verified_fico        integer,
  ADD COLUMN IF NOT EXISTS verified_fico_source text,          -- e.g. representative model / 'equifax_beacon_5.0'
  ADD COLUMN IF NOT EXISTS verified_report_id   text,          -- Xactus CreditReportIdentifier
  ADD COLUMN IF NOT EXISTS verified_pulled_at   date,
  ADD COLUMN IF NOT EXISTS verified_imported_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_imported_by uuid,
  ADD COLUMN IF NOT EXISTS fico_locked          boolean NOT NULL DEFAULT false;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'borrowers_verified_fico_range') THEN
    ALTER TABLE borrowers ADD CONSTRAINT borrowers_verified_fico_range
      CHECK (verified_fico IS NULL OR (verified_fico BETWEEN 300 AND 850));
  END IF;
END $$;

-- Append-only audit of verified-FICO lifecycle changes (successful ones).
CREATE TABLE IF NOT EXISTS credit_fico_audit (
  id            bigserial PRIMARY KEY,
  borrower_id   uuid NOT NULL,
  old_fico      integer,
  new_fico      integer,
  old_verified  integer,
  new_verified  integer,
  old_locked    boolean,
  new_locked    boolean,
  report_id     text,
  reason        text,                              -- 'import' | 'reverify' | other
  changed_at    timestamptz NOT NULL DEFAULT now()
);

-- The BEFORE UPDATE belt: once fico_locked, the frozen score / lineage / lock
-- cannot change from ANY path (portal, ClickUp inbound sync, manual, migration,
-- a raw psql UPDATE) EXCEPT the sanctioned re-import, which sets the GUC
-- app.credit_reverify='on' for exactly its own transaction. Real authorization
-- (which staff, capability) is enforced in the app before the GUC is set; this
-- trigger blocks every other path. Uses IS DISTINCT FROM so a change to/from
-- NULL is caught. Editing OTHER borrower fields while locked is unaffected.
CREATE OR REPLACE FUNCTION guard_frozen_fico() RETURNS trigger AS $$
BEGIN
  IF OLD.fico_locked
     AND coalesce(current_setting('app.credit_reverify', true), '') <> 'on'
     AND (   NEW.fico                 IS DISTINCT FROM OLD.fico
          OR NEW.verified_fico        IS DISTINCT FROM OLD.verified_fico
          OR NEW.verified_fico_source IS DISTINCT FROM OLD.verified_fico_source
          OR NEW.verified_report_id   IS DISTINCT FROM OLD.verified_report_id
          OR NEW.fico_locked          IS DISTINCT FROM OLD.fico_locked)
  THEN
    RAISE EXCEPTION 'FICO is verified and frozen for borrower % — it cannot be changed except by importing a new credit report', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_frozen_fico ON borrowers;
CREATE TRIGGER trg_guard_frozen_fico
  BEFORE UPDATE ON borrowers
  FOR EACH ROW
  EXECUTE FUNCTION guard_frozen_fico();

-- The AFTER UPDATE audit: log every successful change to the verified score /
-- lock (blocked attempts rollback and are logged at the app layer instead).
CREATE OR REPLACE FUNCTION audit_frozen_fico() RETURNS trigger AS $$
BEGIN
  IF NEW.verified_fico IS DISTINCT FROM OLD.verified_fico
     OR NEW.fico_locked IS DISTINCT FROM OLD.fico_locked
     OR NEW.fico IS DISTINCT FROM OLD.fico THEN
    INSERT INTO credit_fico_audit
      (borrower_id, old_fico, new_fico, old_verified, new_verified, old_locked, new_locked, report_id, reason)
    VALUES
      (OLD.id, OLD.fico, NEW.fico, OLD.verified_fico, NEW.verified_fico, OLD.fico_locked, NEW.fico_locked,
       NEW.verified_report_id,
       CASE WHEN coalesce(current_setting('app.credit_reverify', true), '') = 'on' THEN 'reverify'
            WHEN OLD.fico_locked IS DISTINCT FROM NEW.fico_locked AND NEW.fico_locked THEN 'import'
            ELSE 'estimate' END);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_frozen_fico ON borrowers;
CREATE TRIGGER trg_audit_frozen_fico
  AFTER UPDATE ON borrowers
  FOR EACH ROW
  EXECUTE FUNCTION audit_frozen_fico();

-- ---- E. the score the loan was priced on (for the bracket-reset compare) ----
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS fico_used_for_pricing integer;
