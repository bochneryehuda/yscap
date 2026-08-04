-- 466 — Per-experience-tier markup control (owner-directed item 15, second wave).
--
-- The owner: "For the gold program, the top tier is set up in the backend so
-- that it does not have any markup. We need to set that up in the admin pricing
-- settings … for tier one, this markup, for tier two, this markup, for tier
-- three, this markup … Do research on how to make this model setup so that for
-- every tier we should be able to control the markups for every program
-- differently." And, for the studio: "In the products and pricing term sheet
-- generator manual section, we should have, for the gold program, a separate
-- section for the top tier … We should be able to place a markup manually."
--
-- The frozen pricing engines already gained an OPTIONAL per-tier markup overlay
-- (setMarkupTiers) that is INERT when unset — proven byte-identical over 77,760
-- scenarios. This migration adds the two places that value is stored, both
-- NULL/absent by default so every existing file prices exactly as before
-- (previous AND future).
--
-- (A) COMPANY per-tier defaults — the Pricing Admin Center. A jsonb map shaped
--     { "standard": { "1": pct, "2": pct, "3": pct }, "gold": {…}, "silver": {…} }
--     of PERCENTS (mirrors markup_std_pct). Any tier left out keeps its historic
--     markup (Gold Tier 1 = 0, every other tier the base/override). NULL = the
--     whole feature off — read as null by src/lib/pricing-settings.js, so the
--     seeded / existing rows need no backfill.
ALTER TABLE company_pricing_settings
  ADD COLUMN IF NOT EXISTS markup_tiers jsonb;

-- (B) The PER-FILE Gold TOP-TIER manual markup — the studio's "manual section".
--     A sticky percent (mirrors db/109/373 file_markup_*_pct): an explicit
--     per-file Gold Tier-1 markup persists on the application and re-applies to
--     every future quote, so a borrower's self-service pricing can never reprice
--     the top tier back to zero below the markup the file was structured at.
--     NULL = not set → the company per-tier default (or the historic 0) governs.
--
--     It is written ONLY by the register path (src/routes/staff.js), which
--     recomputes and re-registers the product itself, so — unlike an independent
--     edit surface — it does NOT need a clause in the economics-reopen trigger
--     (reopen_conditions_on_budget_change, db/373). If a direct edit surface is
--     ever added for it, watch this column there the same way file_markup_gold_pct
--     is watched.
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS file_markup_gold_t1_pct numeric;
