-- #103 — Borrower self-service pricing.
-- A borrower can price loans / build term sheets in their own portal (not only
-- submit a full application) and SAVE a scenario to return to later without
-- retyping. Each row is one saved scenario: a human label + the Term Sheet Studio
-- input set (program, economics, leverage/term/reserve knobs, claimed experience)
-- as jsonb. Pricing itself is computed client-side by the frozen engine, so we
-- only persist the inputs; reopening a scenario re-feeds the studio.
CREATE TABLE IF NOT EXISTS borrower_pricing_scenarios (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  borrower_id uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
  label       text NOT NULL,
  inputs      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bps_borrower ON borrower_pricing_scenarios(borrower_id, updated_at DESC);
