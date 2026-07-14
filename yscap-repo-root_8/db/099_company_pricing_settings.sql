-- 099 — Company-wide pricing defaults (owner-directed 2026-07-14).
--
-- A super-admin (or a staffer granted 'manage_pricing') sets company-wide
-- defaults for markup, origination %, and the flat fees — the same knobs that
-- are overridable per-file today. Changing a value here changes it for every
-- file NOT YET REGISTERED (the marketing generator, the portal studio, and the
-- backend all read these defaults live), while registered files keep their
-- snapshot. The frozen pricing-engine MATH is untouched — this is purely the
-- input/fee default layer, exactly like the existing per-file adminPricing
-- override.
--
-- Append-only history (mirrors product_registrations): each save flips the
-- prior current row to is_current=false and inserts a new row → full audit +
-- rollback. The seed row uses TODAY'S EXACT literals so behavior is
-- byte-identical until an admin changes something (previous AND future).

CREATE TABLE IF NOT EXISTS company_pricing_settings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  markup_std_pct  numeric,   markup_gold_pct numeric,    -- percents, e.g. 0.5
  orig_std_pct    numeric,   orig_gold_pct   numeric,    -- percents, e.g. 1.25
  lender_fee      numeric,   credit_fee      numeric,    -- dollars
  appraisal_fee   numeric,   title_fee       numeric,    -- title_fee NULL = auto-estimate
  note            text,
  is_current      boolean NOT NULL DEFAULT true,
  updated_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- One current row (mirror db/026's partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_pricing_current
  ON company_pricing_settings (is_current) WHERE is_current;

-- Seed with today's exact defaults so nothing changes until an admin edits.
-- Standard/Gold markup 0.5, origination 1.25, UW/legal 2195, credit 150,
-- appraisal 800, title NULL (auto-estimate per state).
INSERT INTO company_pricing_settings
  (markup_std_pct, markup_gold_pct, orig_std_pct, orig_gold_pct,
   lender_fee, credit_fee, appraisal_fee, title_fee, note, is_current)
SELECT 0.5, 0.5, 1.25, 1.25, 2195, 150, 800, NULL, 'system default (seeded)', true
 WHERE NOT EXISTS (SELECT 1 FROM company_pricing_settings WHERE is_current);
