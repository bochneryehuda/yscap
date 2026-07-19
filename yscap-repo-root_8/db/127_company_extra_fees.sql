-- 127 — Company "extra fees" list on the pricing settings (owner-directed 2026-07-17).
--
-- One editable list of additional closing fees the admin manages in the Pricing
-- Admin Center. Each entry: { name, amount, state } where state '' (or absent) =
-- applies to EVERY file, and a 2-letter code = that state only. Seeded with the
-- New York settlement-agent fee ($2,000, NY-only) the owner asked for; it is just
-- the first (editable/removable) entry, so the same "Add a fee" tool manages it
-- and any future fee. These flow into cash-to-close AND the liquidity-to-show on
-- the term sheet, products & pricing, and the public marketing tools.

ALTER TABLE company_pricing_settings
  ADD COLUMN IF NOT EXISTS extra_fees jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Seed the CURRENT settings row with the NY settlement-agent fee if it has no
-- extra fees yet (idempotent — re-running never duplicates or overwrites edits).
UPDATE company_pricing_settings
   SET extra_fees = '[{"name":"Settlement agent fee","amount":2000,"state":"NY"}]'::jsonb
 WHERE is_current
   AND (extra_fees IS NULL OR extra_fees = '[]'::jsonb);
