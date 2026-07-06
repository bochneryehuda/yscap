-- 019_partners.sql — reusable co-borrower / partner records on the borrower, so
-- a borrower can link an existing partner on future files instead of re-typing.
-- Idempotent.
CREATE TABLE IF NOT EXISTS partners (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_borrower_id   uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
  partner_borrower_id uuid REFERENCES borrowers(id) ON DELETE SET NULL,  -- linked once they have an account
  first_name          text,
  last_name           text,
  email               text,
  phone               text,
  relationship_type   text NOT NULL DEFAULT 'co_borrower'
                      CHECK (relationship_type IN ('co_borrower','guarantor','partner','member','other')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_borrower_id, email)
);
CREATE INDEX IF NOT EXISTS idx_partners_owner ON partners(owner_borrower_id);
