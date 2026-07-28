-- 350 — The purchasing workflow grows CONDITIONS and PURCHASE ADVICE
-- (owner-directed 2026-07-26: "under purchasing workflow we should be able to
-- add tasks add conditions track stuff put notes and put in potentially a
-- purchase advice date and update the purchase advice document post closing
-- post purchase").
--
-- Notes + tasks already exist (db/348). This adds the other three.
--
-- Idempotent: every statement is IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, so it
-- re-runs safely on every boot like every other numbered migration.

-- ---------------------------------------------------------------------------
-- (1) PURCHASE ADVICE — the date the file is expected to be (or was) purchased,
--     plus a pointer to the current purchase advice DOCUMENT. The document is an
--     ordinary `documents` row (doc_kind='purchase_advice'), so it inherits
--     storage, the SharePoint mirror and the download authorization check for
--     free; this column just records which one is CURRENT, because the advice is
--     re-issued post closing and again post purchase.
-- ---------------------------------------------------------------------------
ALTER TABLE purchasing_workflow ADD COLUMN IF NOT EXISTS purchase_advice_date date;
ALTER TABLE purchasing_workflow ADD COLUMN IF NOT EXISTS purchase_advice_document_id uuid REFERENCES documents(id) ON DELETE SET NULL;
ALTER TABLE purchasing_workflow ADD COLUMN IF NOT EXISTS purchase_advice_updated_at timestamptz;
ALTER TABLE purchasing_workflow ADD COLUMN IF NOT EXISTS purchase_advice_updated_by uuid REFERENCES staff_users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- (2) PURCHASING CONDITIONS — what the buyer still needs before they will
--     purchase. Deliberately its own table rather than a `checklist_items` row:
--     these are post-closing, buyer-facing items owned by the purchasing desk,
--     they are never borrower-visible, and they must not appear in the borrower
--     or underwriting condition surfaces (which read checklist_items and would
--     have shown them to a borrower on the file).
--
--     status: open -> cleared (with a waived escape hatch, matching how every
--     other condition surface in the platform lets a human close an item that
--     will never be satisfied).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchasing_conditions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  label           text NOT NULL,
  detail          text,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','cleared','waived')),
  sort_order      int  NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  resolved_at     timestamptz,
  resolved_by     uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  resolution_note text
);
CREATE INDEX IF NOT EXISTS idx_purchasing_conditions_app
  ON purchasing_conditions(application_id, status, sort_order, created_at);
