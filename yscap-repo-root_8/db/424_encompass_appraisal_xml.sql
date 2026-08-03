-- 424 — the ledger for appraisal XMLs caught out of Encompass.
--
-- WHY THIS TABLE EXISTS AT ALL.
-- An AMC delivering an appraisal through Encompass Partner Connect attaches the MISMO 2.6
-- XML to the service order as LOAN MEDIA (urn:elli:media:loans) — never as an eFolder
-- attachment, because Encompass sorts delivered files by type and .xml is not an
-- eFolder-supported type. The order keeps a download URL that is MINTED AT DELIVERY and
-- carries roughly a FIFTEEN MINUTE validity, and Encompass offers no way to re-mint it:
-- the one lender-side endpoint that issues fresh URLs is built on the eFolder export
-- pipeline, so loan media has no path through it. Full evidence + the 11 eliminated
-- retrieval routes: docs/ENCOMPASS-APPRAISAL-XML-DISCOVERY.md.
--
-- So the file is retrievable ONLY inside that window, which is why the catcher polls.
-- This table is what makes the polling safe and honest:
--   * `resource_id` is UNIQUE, so a file is downloaded once however often we sweep;
--   * a resource we saw too late is recorded as 'expired' rather than forgotten, so the
--     back-book is a KNOWN list we can hand to the AMC instead of a guess;
--   * a failure is recorded and retried, never silently dropped.
--
-- It records what we CAUGHT. It is not a document table — the bytes live in storage
-- (`storage_ref`) and the market data lands in the research warehouse
-- (`research_import_id` → `research_imports`).
CREATE TABLE IF NOT EXISTS encompass_appraisal_xml (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Encompass identity. `resource_id` is the storage object key the service order names
  -- (e.g. 'B2.<instance>KS*<loanGuid>KS*<uuid>.xml'). Treat it as an OPAQUE string — it is
  -- not a uuid and must never be parsed.
  resource_id        text NOT NULL,
  loan_guid          text NOT NULL,
  loan_number        text,
  order_id           text,
  transaction_id     text,
  vendor             text,                    -- serviceSetup.product.listingName
  resource_type      text,                    -- e.g. urn:ice:epc:partner:appraisal:report:version:V2.6
  filename           text,
  mime_type          text,

  -- The two timestamps that decide whether a sweep could ever have caught it.
  received_date      timestamptz,             -- when the AMC delivered it
  validity_at        timestamptz,             -- when its download URL dies (~received + 15 min)

  -- A row holds the STRONGEST outcome it has ever reached — the writer keeps the
  -- higher-ranked status on conflict, so an outcome never walks backwards. That
  -- matters because this ledger's job is to say what happened to each file:
  -- 'captured'  — bytes are in storage (an `error` alongside it means the bytes
  --               are safe but the research warehouse would not take them)
  -- 'failed'    — we saw it live and the download/save did not work; retried
  -- 'expired'   — first seen after its URL died; only the AMC can supply it now
  -- 'pending'   — recorded, about to be downloaded. Distinct from 'failed' so a
  --               crash mid-capture is not mistaken for a real download failure.
  status             text NOT NULL DEFAULT 'expired'
                     CHECK (status IN ('captured','expired','failed','pending')),

  storage_ref        text,
  storage_provider   text,
  byte_size          bigint,
  sha256             text,
  research_import_id uuid,                    -- deliberately NOT an FK: the ledger of what we
                                              -- caught must survive a research-side cleanup.
  attempts           integer NOT NULL DEFAULT 0,
  error              text,

  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  captured_at        timestamptz
);

-- One row per delivered file, so the sweep is idempotent no matter how often it runs.
CREATE UNIQUE INDEX IF NOT EXISTS uq_enc_appraisal_xml_resource
  ON encompass_appraisal_xml (resource_id);

-- "What is still missing?" and "what failed and should be retried?" are the two questions
-- asked of this table, so both are indexed.
CREATE INDEX IF NOT EXISTS ix_enc_appraisal_xml_status
  ON encompass_appraisal_xml (status, received_date DESC);

CREATE INDEX IF NOT EXISTS ix_enc_appraisal_xml_loan
  ON encompass_appraisal_xml (loan_guid);
