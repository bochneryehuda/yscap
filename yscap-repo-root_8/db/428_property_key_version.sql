-- 428 — WHEN THE IDENTITY RULE MOVES, EVERY EXISTING ROW HAS TO MOVE WITH IT
--
-- `properties.address_key` IS a property's identity: `upsertProperty` matches on
-- it. So the moment `propertyKey()` starts computing a different string for the
-- same house, the next report about that house stops matching the row we already
-- hold and MINTS A DUPLICATE — which makes a fix to the identity rule strictly
-- WORSE than the bug it fixes, until every existing row has been re-keyed.
--
-- Three defects moved the rule, each reproduced against the live function:
--
--   * TWO STREETS MERGED INTO ONE PROPERTY. `splitUnit` matched the unit keyword
--     inside a street NAME, so "5 Building Rd" and "5 Room Rd" both parsed to
--     street "5" + a unit, and both keyed `5|rd|newark|nj`. The street name was
--     simply gone. (Fixed at the split itself, where `withoutUnit` has carried
--     the same guard since 2026-07-27.)
--   * FIVE DIFFERENT UNITS MERGED INTO ONE. Every kind word was stripped, so
--     `Apt 5`, `Suite 5`, `Floor 5`, `Building 5` and `Lot 5` all keyed `5` — a
--     mixed-use building's commercial suite and residential apartment became one
--     property. The dwelling synonyms (apt/unit/#/bare) still collapse together,
--     because those genuinely ARE five appraisers writing one apartment.
--   * ONE STREET SPLIT INTO SEVERAL. `15 Ave` ≠ `15th Ave`, `St James` ≠
--     `Saint James`, `Oak Street Ext` ≠ `Oak St Ext`.
--
-- `key_version` is the drain marker for the re-key sweep (`research/rekey.js`),
-- which is JavaScript and not SQL deliberately: a PL/pgSQL twin of `propertyKey`
-- would drift from the live one — the `pilot_term_norm` class — and then the
-- sweep and the ingest would disagree about what a property IS, which is the one
-- disagreement this warehouse cannot survive.
--
-- The sweep MERGES where the new rule brings two rows together (that is the
-- split-fix landing) and never SPLITS where it should pull one apart: un-picking
-- a wrongly-merged row needs each observation's own `address_as_stated` and a
-- human decision about which sales and photos belong to which. Those are counted
-- and reported instead of being taken apart unattended.

ALTER TABLE properties ADD COLUMN IF NOT EXISTS key_version smallint;

COMMENT ON COLUMN properties.key_version IS
  'Which version of propertyKey() computed this row''s address_key. Behind the '
  'current version means the row is re-keyed by the boot sweep — without which a '
  'changed identity rule mints duplicates instead of matching what we hold.';

-- The sweep reads exactly this predicate.
CREATE INDEX IF NOT EXISTS ix_properties_key_version ON properties(key_version);
