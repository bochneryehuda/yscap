-- =====================================================================
-- 025_product_registration.sql — register a priced product / term sheet on
-- a loan file. Each row is an authoritative, server-computed quote snapshot
-- (frozen-engine output) with the exact inputs used, kept as an append-only
-- history; the latest row with is_current=true is the file's active terms.
-- Idempotent.
-- =====================================================================

CREATE TABLE IF NOT EXISTS product_registrations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  program          text NOT NULL,                 -- 'standard' | 'gold'
  product_label    text,                           -- engine product name (Gold Standard)
  status           text,                           -- ELIGIBLE | MANUAL | INELIGIBLE at registration
  note_rate        numeric(7,5),                   -- borrower note rate (fraction)
  total_loan       numeric(14,2),
  target_ltc       numeric(7,5),                   -- chosen leverage (Standard ladder) or null
  inputs           jsonb NOT NULL,                 -- engine inputs used (audit)
  quote            jsonb NOT NULL,                 -- normalized server-computed quote
  is_current       boolean NOT NULL DEFAULT true,
  registered_by    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_reg_app     ON product_registrations(application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_reg_current ON product_registrations(application_id) WHERE is_current;
