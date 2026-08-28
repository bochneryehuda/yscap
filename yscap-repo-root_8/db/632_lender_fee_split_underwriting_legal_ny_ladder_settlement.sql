-- ============================================================================
-- db/632 — our fee split in two, the New York legal ladder, and the optional
--          New York settlement agent fee that replaces the mandatory one
--
-- WHAT THIS CHANGES, AND WHY. Owner-directed 2026-08-26, in the owner's own
-- words — which is the written authorization the frozen-pricing HARD RULE
-- requires before any fee number may move. Three instructions, one change:
--
--   "Right now, we have $2,195 for our total fees. I want to split it up for:
--    general products: $1,200 underwriting, processing; $995 legal fee for
--    general files. This should be split up in the structure screen of the
--    products and pricing. You need to make sure you wire all these fees
--    correctly into the liquidity, cash to close, and stuff like that. So the
--    total stays the same for general loans."
--
--   "For any New York file, remove the extra settlement fee that we have now
--    listed for New York files and replace it with higher legal fees instead of
--    $995. Any New York file should populate a base fee of $2,000 legal fee …
--    everything of this should not be hardwired. It should just be pre-filled
--    in the manual section. Everything can be changeable." … "On heavier rehab
--    in New York, or any New York City file, the base legal fee in New York
--    instead of $2,000 should pre-populate as $2,500 … in New York, the base fee
--    for a smaller construction (less than $100,000): If it's not in the New
--    York City five boroughs, then it's a $2,000 base legal fee. If it's in the
--    five boroughs or the construction's worth $100,000, then it's $2,500. For
--    any ground-up, the standard price is $2,000 in general. If it's in New
--    York, then it's $2,500."
--
--   "Now, for New York files, pre-fill the settlement fee that I just told you
--    to remove … Pre-fill an optional settlement fee of $500 to $750. A
--    pre-filler that we should be able to change it … it should say on the term
--    sheet everywhere that it's optional, but it should be included in
--    calculating the cash to close."
--
-- THE TOTAL STAYS THE SAME BY CONSTRUCTION, not by a check somebody has to
-- remember to run. `pricing.js` no longer reads a single lender-fee number: it
-- reads the two parts and SUMS them, so a general file is 1,200 + 995 = 2,195 —
-- byte for byte the figure the old `lender_fee` column held — and every existing
-- reader of that total (the closing-cost sum, the tapes, the printed sheets)
-- keeps working untouched. See src/lib/lender-fees.js, which is the ONE
-- definition of both parts, of which rung a New York deal lands on, of what each
-- part is called, and of how a manual amount overrides it.
--
-- THE MANDATORY NEW YORK SETTLEMENT FEE IS REMOVED HERE, AND THAT IS THE HALF
-- THAT IS EASY TO MISS. Until today a New York file carried a $2,000
-- "Settlement agent fee" as a company EXTRA fee (`extra_fees`, seeded by db/153
-- and shipped as a cold-cache fallback in pricing-settings.SYSTEM_DEFAULTS).
-- The owner asked for that to be folded into the higher legal fee. Leaving it in
-- place beside the ladder would bill a New York borrower twice, so it is deleted
-- from the settings row below AND from the code fallback in the same commit —
-- either one alone leaves the double charge reachable.
--
--   ONLY THAT ROW. The delete is keyed on state = 'NY' AND a name that reads as
--   a settlement fee, so any other extra fee an admin has added — in New York or
--   anywhere else — is left exactly where it is. An admin who genuinely wants a
--   mandatory settlement fee back can add one on the Pricing screen.
--
-- TWO PLACES, TWO DIFFERENT JOBS, mirroring db/609:
--   · company_pricing_settings.lender_fees — the COMPANY numbers, shaped
--     { underwriting, legal, legalGroundUp, legalNy, legalNyHigh, settlementNy },
--     edited in the Pricing Admin Center. jsonb rather than six numeric columns
--     because the shape belongs to ONE rule module and a future seventh rung
--     would otherwise need another migration and another column on every read.
--   · applications.file_underwriting_fee / file_legal_fee / file_settlement_fee
--     — the per-file MANUAL amounts ("it should just be pre-filled in the manual
--     section. Everything can be changeable"). NULL means "use the company
--     number / this deal's own rung"; a typed 0 means that part is deliberately
--     WAIVED (or, for the optional settlement fee, DECLINED) on this file, which
--     is why they are nullable numeric and not DEFAULT 0.
--
-- THE SEED PRESERVES A CUSTOMISED TOTAL. Where the current row still holds the
-- untouched $2,195 the parts are the owner's 1,200 / 995. Where an admin had
-- changed the total, the LEGAL part is the stated $995 and underwriting is the
-- RESIDUAL, so that company's total is preserved to the cent as well — which is
-- what the owner asked for and is a better answer than silently re-pricing them.
-- A stored total below the legal fee is nonsense to split, so it takes the
-- owner's pair and the admin can correct it on the Pricing screen.
--
-- NO SIZING NUMBER MOVES. These are costs, not inputs: the loan amount, the note
-- rate, every LTV/LTC/ARV cap and the whole sizing waterfall are computed above
-- them and never read them. They cascade into cash-to-close and the liquidity
-- the borrower must show, which is what a real borrower closing cost does.
--
-- NO BACKFILL OF FILES, DELIBERATELY. The three per-file columns stay NULL on
-- every existing file: NULL reads as "use the company number / this deal's own
-- rung", so a live New York file picks the ladder up on its next quote without
-- anybody stamping a number onto a deal priced before this existed. A file whose
-- terms are already out for signature is protected by the ordinary term-sheet
-- freeze, not by this.
--
-- THE ECONOMICS-REOPEN TRIGGER IS DELIBERATELY NOT WIDENED, for exactly the
-- reason db/609 gives: these columns can only ever be written as part of a
-- REGISTRATION (the staff register route, beside the sticky markups they mirror),
-- so there is never a stale registration for the trigger to catch. Section F of
-- scripts/test-lender-fees-pure.js enforces that single-writer claim, so the next
-- door added cannot quietly invalidate it.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; the seed writes only where the column is
-- still NULL, so an admin's own later value is never overwritten; and the
-- extra-fee delete is a no-op once the row is gone.
--
-- PRODUCT SEPARATION: RTL only. `applications` and `company_pricing_settings`
-- ARE the RTL product's tables; the Long-Term side has its own `lt_*` tables and
-- does not appear here.
-- ============================================================================

ALTER TABLE company_pricing_settings
  ADD COLUMN IF NOT EXISTS lender_fees jsonb;

-- The owner's numbers, onto every settings row that has none, with the
-- underwriting part carrying whatever residual keeps that row's TOTAL unchanged.
-- `pricing-settings.shape()` falls back to the same set when the column is NULL,
-- so this seed is what the admin screen shows rather than something the pricing
-- path depends on.
UPDATE company_pricing_settings
   SET lender_fees = jsonb_build_object(
         'underwriting', CASE
             WHEN lender_fee IS NULL THEN 1200
             WHEN lender_fee - 995 >= 0 THEN round(lender_fee - 995, 2)
             ELSE 1200
           END,
         'legal', 995,
         'legalGroundUp', 2000,
         'legalNy', 2000,
         'legalNyHigh', 2500,
         'settlementNy', 750)
 WHERE lender_fees IS NULL;

-- THE MANDATORY NEW YORK SETTLEMENT FEE, REMOVED. Its replacement is the higher
-- New York legal fee above plus the OPTIONAL `settlementNy` pre-fill; leaving
-- this row would charge a New York borrower for both. Keyed narrowly — a New
-- York row whose name reads as a settlement fee — so nothing else an admin added
-- is touched. Idempotent: a second run finds nothing to remove.
UPDATE company_pricing_settings
   SET extra_fees = COALESCE((
         SELECT jsonb_agg(f)
           FROM jsonb_array_elements(extra_fees) AS f
          WHERE NOT (upper(COALESCE(f->>'state','')) = 'NY'
                     AND lower(COALESCE(f->>'name','')) LIKE '%settlement%')
       ), '[]'::jsonb)
 WHERE extra_fees IS NOT NULL
   AND jsonb_typeof(extra_fees) = 'array'
   AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(extra_fees) AS f
          WHERE upper(COALESCE(f->>'state','')) = 'NY'
            AND lower(COALESCE(f->>'name','')) LIKE '%settlement%');

-- The per-file manual amounts. NULL = the company number / this deal's own rung;
-- 0 = deliberately waived (or, for the optional settlement fee, declined).
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS file_underwriting_fee numeric;
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS file_legal_fee numeric;
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS file_settlement_fee numeric;
