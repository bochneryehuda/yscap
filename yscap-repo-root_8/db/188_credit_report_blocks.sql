-- ============================================================================
-- 169 - Credit report "blocks": the full report beyond scores (owner-directed
--       2026-07-19). The MISMO response we already store encrypted
--       (credit_reports.xml_encrypted) carries tradelines, inquiries, public
--       records, collections, and the bureau-reported identity. This adds
--       structured per-borrower / per-bureau tables so we can display + query
--       them. See docs/CREDIT-REPORT-ENHANCEMENTS-DESIGN.md (E1).
--
-- Every table mirrors credit_scores: credit_report_id FK (cascade), borrower_id,
-- report_borrower_id (B1/C1), bureau. `raw jsonb` keeps the parsed node for audit
-- / forward-compat. Account numbers are the only high-sensitivity field here:
-- stored ENCRYPTED (bytea, via crypto.encryptSecret) and MASKED (last-4) for
-- display — never plaintext (GLBA Safeguards Rule; NIST 800-122). SSNs are never
-- stored in these tables (the real SSN already lives encrypted on borrowers);
-- credit_report_identities keeps only a masked last-4 for the reported-vs-file
-- mismatch display.
-- ============================================================================

CREATE TABLE IF NOT EXISTS credit_tradelines (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_report_id            uuid NOT NULL REFERENCES credit_reports(id) ON DELETE CASCADE,
  borrower_id                 uuid REFERENCES borrowers(id),
  report_borrower_id          text,
  bureau                      text,
  credit_file_id              text,
  creditor_name               text,
  creditor_address            text,
  account_type                text,
  account_ownership_type      text,   -- Individual | AuthorizedUser | Joint | ...
  account_status_type         text,   -- Open | Paid | Closed | ...
  account_identifier_masked   text,   -- ••••1234 (display)
  account_identifier_encrypted bytea, -- full number, AES-256-GCM; never plaintext
  unpaid_balance              numeric,
  credit_limit                numeric,
  high_credit                 numeric,
  monthly_payment             numeric,
  past_due_amount             numeric,
  charge_off_amount           numeric,
  date_opened                 date,
  date_reported               date,
  date_closed                 date,
  last_activity_date          date,
  months_reviewed_count       integer,
  current_rating_code         text,
  current_rating_type         text,
  late_30_count               integer,
  late_60_count               integer,
  late_90_count               integer,
  payment_pattern             text,
  derogatory_indicator        boolean,
  is_collection               boolean NOT NULL DEFAULT false,
  is_authorized_user          boolean NOT NULL DEFAULT false,
  raw                         jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_tradelines_report   ON credit_tradelines(credit_report_id);
CREATE INDEX IF NOT EXISTS idx_credit_tradelines_borrower ON credit_tradelines(borrower_id);

CREATE TABLE IF NOT EXISTS credit_inquiries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_report_id     uuid NOT NULL REFERENCES credit_reports(id) ON DELETE CASCADE,
  borrower_id          uuid REFERENCES borrowers(id),
  report_borrower_id   text,
  bureau               text,
  inquiry_date         date,
  inquiring_party_name text,
  business_type        text,
  loan_type            text,
  raw                  jsonb,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_inquiries_report   ON credit_inquiries(credit_report_id);
CREATE INDEX IF NOT EXISTS idx_credit_inquiries_borrower ON credit_inquiries(borrower_id);

CREATE TABLE IF NOT EXISTS credit_public_records (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_report_id     uuid NOT NULL REFERENCES credit_reports(id) ON DELETE CASCADE,
  borrower_id          uuid REFERENCES borrowers(id),
  report_borrower_id   text,
  bureau               text,
  record_type          text,   -- bankruptcy | lien | judgment | ...
  filed_date           date,
  reported_date        date,
  disposition_type     text,
  disposition_date     date,
  amount               numeric,
  court_name           text,
  docket_identifier    text,
  plaintiff_name       text,
  derogatory_indicator boolean,
  raw                  jsonb,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_public_records_report   ON credit_public_records(credit_report_id);
CREATE INDEX IF NOT EXISTS idx_credit_public_records_borrower ON credit_public_records(borrower_id);

CREATE TABLE IF NOT EXISTS credit_collections (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_report_id       uuid NOT NULL REFERENCES credit_reports(id) ON DELETE CASCADE,
  borrower_id            uuid REFERENCES borrowers(id),
  report_borrower_id     text,
  bureau                 text,
  collection_agency_name text,
  original_creditor_name text,
  amount                 numeric,
  status                 text,
  date_reported          date,
  raw                    jsonb,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_collections_report   ON credit_collections(credit_report_id);
CREATE INDEX IF NOT EXISTS idx_credit_collections_borrower ON credit_collections(borrower_id);

-- The identity each bureau has on file for the borrower (for the reported-vs-file
-- mismatch checks + a per-bureau "as reported" header in the detail view). No raw
-- SSN — only a masked last-4.
CREATE TABLE IF NOT EXISTS credit_report_identities (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_report_id    uuid NOT NULL REFERENCES credit_reports(id) ON DELETE CASCADE,
  borrower_id         uuid REFERENCES borrowers(id),
  report_borrower_id  text,
  bureau              text,
  reported_name       text,
  aliases             jsonb,
  dob                 date,
  ssn_masked          text,        -- last-4 only; never the full reported SSN
  current_address     jsonb,
  former_addresses    jsonb,
  employers           jsonb,
  infile_date         date,
  alert_messages      jsonb,       -- per-borrower alert text tied to this bureau file
  raw                 jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_report_identities_report   ON credit_report_identities(credit_report_id);
CREATE INDEX IF NOT EXISTS idx_credit_report_identities_borrower ON credit_report_identities(borrower_id);

-- Report-level alerts (fraud / security freeze / active-duty / deceased / OFAC /
-- address-discrepancy / high-risk-score) parsed from the ALERT element. These
-- feed the file alert banner + the underwriting findings engine (E2). category is
-- the normalized signal; text is the vendor free text; borrower_id/report_borrower_id
-- when the alert is borrower-specific.
CREATE TABLE IF NOT EXISTS credit_alerts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_report_id   uuid NOT NULL REFERENCES credit_reports(id) ON DELETE CASCADE,
  borrower_id        uuid REFERENCES borrowers(id),
  report_borrower_id text,
  bureau             text,
  category           text,   -- normalized: fraud_alert | active_duty | security_freeze | deceased | ofac | address_discrepancy | ssn_alert | high_risk_score | consumer_statement | other
  raw_type           text,   -- the vendor's own category/type string
  message_text       text,
  raw                jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_alerts_report   ON credit_alerts(credit_report_id);
CREATE INDEX IF NOT EXISTS idx_credit_alerts_borrower ON credit_alerts(borrower_id);
