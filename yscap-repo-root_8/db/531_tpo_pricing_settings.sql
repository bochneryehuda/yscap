-- 531_tpo_pricing_settings.sql — the TPO (broker/wholesale) PRICING LAYER
-- (owner-directed 2026-08-06). A NEW layer ON TOP of the frozen pricing engines:
-- separate markup + origination controls for the TPO channel, optional per-firm
-- overrides, and a firm-set broker origination fee. It changes NO retail number
-- and NO frozen engine formula — every column here is NULL by default and NULL
-- means "same as retail", so with no rows/values a TPO file prices byte-for-byte
-- like retail. Only a TPO file (is_tpo) ever reads these values; resolution lives
-- in src/lib/tpo-pricing.js and is threaded into pricing.js as an opt-in setting.
--
-- Precedence (owner's words): frozen engine → retail company default
-- (company_pricing_settings) → TPO channel default (tpo_pricing_settings) → that
-- firm's override (tpo_firm_pricing) → broker fee (origination only, never the rate).

-- ── The TPO-channel admin defaults (a one-row singleton, mirrors company_pricing_settings
--    but for the wholesale channel). All pct columns NULLABLE: NULL = fall back to
--    the retail company default. Written by the admin Pricing Center (manage_pricing);
--    a kind='tpo' actor can never reach it.
CREATE TABLE IF NOT EXISTS tpo_pricing_settings (
  id                 int PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- singleton guard
  markup_std_pct     numeric(6,3),      -- NULL = same as retail markup_std_pct
  markup_gold_pct    numeric(6,3),
  markup_silver_pct  numeric(6,3),
  orig_std_pct       numeric(6,3),      -- NULL = same as retail orig_std_pct
  orig_gold_pct      numeric(6,3),
  orig_silver_pct    numeric(6,3),
  markup_tiers       jsonb,             -- NULL = same as retail markup_tiers ({standard:{1,2,3},gold,silver} of percents)
  updated_by         uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- Seed the single row so the settings source always exists (all NULL = TPO prices
-- exactly like retail until an admin changes a TPO value).
INSERT INTO tpo_pricing_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── Per-firm pricing overrides (special pricing for one brokerage firm). Same
--    NULLABLE markup/orig columns (NULL = fall back to the TPO channel default),
--    PLUS broker_orig_pct: the firm's OWN origination / broker fee. The markup/orig
--    override columns are written by the ADMIN (platform_setup); broker_orig_pct is
--    the ONLY column the firm-admin (broker) self-service route may write, and it
--    only ever adds to origination — never the rate.
CREATE TABLE IF NOT EXISTS tpo_firm_pricing (
  tpo_firm_id            uuid PRIMARY KEY REFERENCES tpo_firms(id) ON DELETE CASCADE,
  markup_std_pct         numeric(6,3),      -- NULL = fall back to the TPO channel default
  markup_gold_pct        numeric(6,3),
  markup_silver_pct      numeric(6,3),
  orig_std_pct           numeric(6,3),
  orig_gold_pct          numeric(6,3),
  orig_silver_pct        numeric(6,3),
  markup_tiers           jsonb,
  broker_orig_pct        numeric(6,3),      -- the firm's own origination/broker fee (points); firm-admin-set; NULL/0 = none
  updated_by             uuid REFERENCES staff_users(id) ON DELETE SET NULL,   -- admin who last set the overrides
  broker_fee_updated_by  uuid REFERENCES staff_users(id) ON DELETE SET NULL,   -- who last set broker_orig_pct
  broker_fee_updated_at  timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Touch updated_at on every write so the stamp stays fresh without hand-setting it.
CREATE OR REPLACE FUNCTION tpo_firm_pricing_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_tpo_firm_pricing_touch ON tpo_firm_pricing;
CREATE TRIGGER trg_tpo_firm_pricing_touch
  BEFORE UPDATE ON tpo_firm_pricing
  FOR EACH ROW EXECUTE FUNCTION tpo_firm_pricing_touch();

CREATE OR REPLACE FUNCTION tpo_pricing_settings_touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_tpo_pricing_settings_touch ON tpo_pricing_settings;
CREATE TRIGGER trg_tpo_pricing_settings_touch
  BEFORE UPDATE ON tpo_pricing_settings
  FOR EACH ROW EXECUTE FUNCTION tpo_pricing_settings_touch();
