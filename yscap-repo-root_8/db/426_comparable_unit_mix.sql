-- 426 — A COMPARABLE'S UNITS, AND THE FACT THAT ITS ROOM COUNTS WERE WRONG
--
-- On a Fannie Form 1025 (2-4 unit) the comparable grid states its room line PER
-- UNIT: one `ROOM_ADJUSTMENT` element per dwelling. `extract.js` read the FIRST
-- one — `X.find(c, 'ROOM_ADJUSTMENT')` — which is UNIT 1, and filed it as the
-- whole property.
--
-- That is a WRONG ANSWER, not a missing one, and it is the worse of the two.
-- Measured end to end on a three-unit comparable whose grid states 14 rooms /
-- 7 beds / 3 baths: the warehouse stored 5 / 3 / 1. `beds` is in `ROLLUP_FACTS`,
-- so the wrong number reached `properties`; and `scoreComp` DROPS an unknown
-- fact from its denominator while scoring a stated one as a confident match — so
-- a 7-bedroom triplex was being offered as a strong comparable for a 3-bedroom
-- house, and a search for "3 bedrooms" matched it.
--
-- `extract.js` now reads EVERY row: the counts add up to the property's totals
-- (or come from a summary row where a vendor writes one, detected by it equalling
-- the sum of the rest), and the rows themselves are the per-unit breakdown —
-- which is a fact we have never stored about a comparable at all, and the one the
-- owner asked for by name: "each and every unit how many bedrooms how many
-- bathrooms each and every unit how many square footage".
--
-- THE UNIT COUNT IS STATED, NEVER INFERRED. It is set only when the grid actually
-- wrote a row per unit. A single row proves nothing about how many units there
-- are — a 1004 has exactly one — so it stays NULL rather than claiming "1", and
-- it is never taken from the subject (handoff rule 8: a comparable's unit count
-- is genuinely absent from most MISMO 2.6 grids, and inheriting the subject's
-- would file a duplex as a single-family every time we appraised one).
--
-- `appraisal_comparables.units` already exists (db/409 §7) and was written by
-- NOTHING — `comparableRowFrom` never emitted the key. It is filled now.

ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS unit_mix jsonb;

COMMENT ON COLUMN appraisal_comparables.unit_mix IS
  'Per-unit room line as the 1025 grid stated it: [{unit,rooms,beds,baths_full,'
  'baths_half,baths}]. NULL on a single-unit grid — one row is the property, not '
  'a unit. Never inherited from the subject.';

-- PREVIOUS AND FUTURE. Nothing is recomputed in SQL: the corrected counts live in
-- the PARSER, so the reports have to be READ AGAIN. `INGEST_VERSION` moves to 3
-- in `research/ingest.js` and the boot sweep re-reads every report we hold,
-- oldest first, bounded per boot and self-draining — which is also what carries
-- the corrected totals onto the `properties` rows that are currently holding
-- unit 1's bedroom count.
--
-- The `appraisal_comparables` rows themselves are re-written by the same pass:
-- `importAppraisal` re-runs `comparableRowFrom` for the report it re-reads.
