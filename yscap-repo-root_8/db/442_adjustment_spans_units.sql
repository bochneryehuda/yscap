-- 442 — A WHOLE-BUILDING TOTAL IS NOT A PER-PROPERTY ADJUSTMENT
--
-- db/440 describes `property_adjustments` as "one row per adjustment line an
-- appraiser wrote on a comparable". For the ROOM COUNT line on a 2-4 unit grid
-- that is not quite true, and the difference matters.
--
-- A Fannie 1025 states its room line PER DWELLING — one `ROOM_ADJUSTMENT` element
-- per unit — and `extract.js` sums their dollar figures into ONE `RoomCount`
-- adjustment, because that sum is what the grid reconciles on. So the stored row
-- is sometimes a figure about one property and sometimes a total across four.
-- Measured over the 152 real reports: **313 room lines cover one dwelling, 237
-- cover several**.
--
-- `adjustmentBenchmark('RoomCount')` was averaging the two together, and the
-- resulting median describes neither: a $5,000 adjustment on a single house and
-- a $5,000 total across a four-family are not the same fact. db/441 already
-- excluded RoomCount from the per-unit RATE for exactly this reason; the
-- benchmark had no such guard.
--
-- The honest fix is to record what the number IS, the same way `gla_basis` and
-- `unit_delta_basis` already do, rather than to drop the rows: a whole-building
-- total is real information about how that grid was worked, and somebody
-- comparing four-family adjustments should be able to ask for exactly those.
--
-- `1` means an ordinary single-dwelling line. NULL means the line predates this
-- column or is not a room line — and the benchmark treats NULL as "not known to
-- span", because every other line type genuinely describes one property.

ALTER TABLE property_adjustments ADD COLUMN IF NOT EXISTS spans_units integer;

COMMENT ON COLUMN property_adjustments.spans_units IS
  'How many dwelling units this adjustment covers. 1 = a figure about one '
  'property. Greater than 1 = a SUM across the units of a 2-4 family grid, which '
  'is not comparable with a single-property adjustment and is excluded from the '
  'default benchmark. NULL = not a room line, or stored before db/442.';

CREATE INDEX IF NOT EXISTS ix_property_adjustments_spans
  ON property_adjustments (line_type, spans_units)
  WHERE amount IS NOT NULL AND amount <> 0;
