-- 273 — Credit reports (Xactus import) storage.
--
-- Owner-directed 2026-07-22: the internal "Credit report" condition
-- (rtl_cond_credit, db/076) gets an "Import credit" button that pulls/reissues a
-- tri-merge credit report from Xactus using ONE shared company login (stored in
-- Render env, not per-user). Each import saves the PDF + the source XML as
-- documents on the file AND parses the XML into a normalized structure so the
-- team can see a full credit-details section and underwriting can consume it.
--
-- This table is the parsed system-of-record for each imported report. The raw
-- bytes live as `documents` rows (doc_kind credit_pdf / credit_xml); the
-- normalized data lives here in `parsed` (jsonb) with the headline middle score
-- promoted to a column for fast reads + the FICO write-back.
--
-- Go-forward by nature (an on-demand pull), so there is no backfill — every
-- existing file already carries the rtl_cond_credit condition from db/076, and a
-- credit_reports row appears the first time staff import for that file.

CREATE TABLE IF NOT EXISTS credit_reports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  borrower_id       uuid REFERENCES borrowers(id) ON DELETE SET NULL,
  -- request shape the pull was ordered with
  vendor            text NOT NULL DEFAULT 'xactus',
  pull_type         text NOT NULL DEFAULT 'soft'    CHECK (pull_type IN ('soft','hard')),
  request_type      text NOT NULL DEFAULT 'reissue' CHECK (request_type IN ('reissue','new')),
  bureaus           text[] NOT NULL DEFAULT ARRAY['Equifax','Experian','TransUnion']::text[],
  interface_version text,                            -- e.g. '3.4' (default), free-form
  -- lifecycle
  status            text NOT NULL DEFAULT 'completed' CHECK (status IN ('pending','completed','error')),
  error             text,
  source            text NOT NULL DEFAULT 'api'      CHECK (source IN ('api','upload')),  -- live pull vs an imported downloaded file
  -- parsed results
  vendor_report_id  text,
  report_date       date,
  middle_score      integer CHECK (middle_score IS NULL OR (middle_score BETWEEN 300 AND 850)),
  scores            jsonb,        -- [{bureau,model,value,factors}]
  summary           jsonb,        -- {tradelineCount,totalMonthlyPayments,…}
  parsed            jsonb,        -- the full normalized report (src/lib/credit/parse.js output)
  -- linkage to the stored source documents
  xml_document_id   uuid REFERENCES documents(id) ON DELETE SET NULL,
  pdf_document_id   uuid REFERENCES documents(id) ON DELETE SET NULL,
  checklist_item_id uuid REFERENCES checklist_items(id) ON DELETE SET NULL,
  -- book-keeping
  pulled_by         uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  pulled_at         timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_reports_app     ON credit_reports(application_id, pulled_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_reports_borrower ON credit_reports(borrower_id);
