-- ============================================================================
-- 161 — Appraisal 1004MC MARKET-TRENDS grid (owner-directed enhancement round 3, 2026-07-20).
--
-- The 1004MC "Market Conditions Addendum" grid (MISMO <MARKET>/<MARKET_INVENTORY>)
-- is present on 33/37 corpus files and was never extracted. It carries the appraiser's
-- own read of the CURRENT market: months of housing supply, median days-on-market,
-- median sale-to-list ratio, and the median-sale-price trend — the strongest built-in
-- signal of how fast and at what price the collateral will actually exit.
--
-- IMPORTANT — these amounts are FULL DOLLARS (452500 = $452,500), NOT the $000s scale of
-- the neighborhood price band in db/158. extract.js reads them with a dedicated cleaner
-- (strips $ , %, rejects N/A / - / blank) and never with thousands(). Additive + idempotent.
-- ============================================================================

-- The full grid, verbatim, for display of every metric across all three periods + trend:
--   { <Metric>: { prior712, prior46, last3, trend } , ... }
-- Metrics seen: TotalSales, TotalListings, MedianSalesPrice, MedianListPrice,
--   MedianSalesDOM, MedianListDOM, AbsorptionRate, Supply, MedianSalesToListRatio.
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS market_trends        jsonb;

-- Flattened "current market" point metrics (Last-3-Months period) + the price-trend
-- conclusion — the fields the underwriting tripwires and the summary chips read.
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS mc_months_supply     numeric(8,2);   -- months of housing supply (Supply, last 3 mo)
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS mc_median_dom        integer;         -- median days-on-market (MedianSalesDOM, last 3 mo)
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS mc_sale_to_list_pct  numeric(6,2);    -- median sale-to-list % (MedianSalesToListRatio, last 3 mo)
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS mc_price_trend       text;            -- Increasing|Stable|Declining (MedianSalesPrice trend row)
