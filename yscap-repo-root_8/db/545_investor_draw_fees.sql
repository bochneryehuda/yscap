-- ============================================================================
-- 545_investor_draw_fees.sql — WHAT EACH INVESTOR KEEPS OUT OF OUR DRAW FEE,
-- editable in the admin settings (owner-directed 2026-08-13: "we need to add
-- these investor fee settings in the admin settings to be able to control, in
-- general, each investor's fee … every investor that we add to our system
-- should automatically come up with their option to set how much their fee is.
-- It should already preset the rules that we set together").
--
-- db/542 put the investor's cut on the money ledger; the RATES lived only in
-- code (`src/sitewire/investor-fee.js`). This is where they live now, so the
-- owner can change one without a deploy — and where a NEW note buyer's rate is
-- set the day they are added.
--
-- ITS OWN TABLE, DELIBERATELY, rather than a column on
-- `sitewire_inspection_rules`: a row there is keyed to a Sitewire capital
-- partner and drives the PUSH (a rule row whose partner does not resolve is
-- rejected at the route, by design — audit B-9). A draw-fee rate has nothing to
-- do with pushing a property to Sitewire, and making somebody create a routing
-- rule just to record "CorrFirst keeps $95" would couple two unrelated things
-- and risk the push machinery. One tiny table, one question.
--
-- KEYED BY THE SHARED CAPITAL-PROVIDER TOKEN (`funding-channel.toBuyerKey`), the
-- same key the code resolves rates with, so "CorrFirst" / "Corr First" /
-- "corrfirst" are one row and can never be configured twice with two answers.
--
-- SEEDED WITH THE RATES THE OWNER SET (CorrFirst $95, Blue Lake $250), so the
-- screen opens already correct. The seed is INSERT ... ON CONFLICT DO NOTHING:
-- it establishes the rates once and NEVER overwrites an edit on a later boot.
-- The code keeps the same two numbers as its fallback, so a deployment whose
-- table was emptied still behaves exactly as it does today.
-- ============================================================================

CREATE TABLE IF NOT EXISTS investor_draw_fees (
  buyer_key       text PRIMARY KEY,
  -- What this investor keeps out of OUR draw fee, per released draw. 0 = they
  -- keep nothing (the whole fee reaches us), which is most investors.
  per_draw_cents  bigint NOT NULL DEFAULT 0 CHECK (per_draw_cents >= 0),
  -- The spelling to show on screen; the KEY is what the code matches on.
  label           text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL
);

INSERT INTO investor_draw_fees (buyer_key, per_draw_cents, label) VALUES
  ('corrfirst', 9500,  'CorrFirst'),
  ('bluelake',  25000, 'Blue Lake')
ON CONFLICT (buyer_key) DO NOTHING;
