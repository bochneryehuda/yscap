-- ============================================================================
-- LONG-TERM (LT) — db/583 — which engine wiring MEASURED a parity-cell row.
--
-- WHY (§2.126a). db/575 stores one row per band per day, and the whole point of
-- keeping the series is the sentence a reader builds from it: "this band has been
-- off for twelve days", "this one is improving", "these are the persistently worst
-- cells". Every one of those is a statement about a SEQUENCE, and a sequence is
-- only a measurement when the same instrument took every reading in it.
--
-- db/575's header is already scrupulous about one way that fails: a missing row
-- means NOT MEASURED, never MEASURED BADLY, so gaps are reported as gaps and never
-- zero-filled. It has no rule at all about the other way — a row measured by a
-- DIFFERENT ENGINE. When the "ours" leg was corrected (§2.122 gave it the deal's
-- real facts; §2.124 taught it that a quote answers in three states) the series
-- crossed a boundary, and `cellHistory` went on comparing the days either side as
-- though they were the same reading. Measured on a real Postgres, 2026-08-19: a
-- twelve-day window whose ONLY change was the leg fix reports
--   trend = { direction: 'improving', delta: 0.20 }
-- which describes the repair of the instrument, not the behaviour of the band.
--
-- WHAT THE COLUMN IS. The value of `agreement-provenance.LEG_VERSION` when the row
-- was written — the same stamp db/565's runs and db/582's findings carry, so all
-- three boards can be read against one another.
--
-- ⛔ NULL IS THE SIGNAL, NOT A GAP TO BACKFILL. A stamp cannot go back in time, and
-- inventing one would be the same fabrication db/575 already refuses for counts.
-- A window containing an unstamped day is reported as not comparable, and the
-- trend for it is REFUSED rather than stated.
--
-- SEPARATION: lt_ppe_* only; no RTL table touched; no trigger or function.
-- IDEMPOTENT: re-runnable on every boot (ADD COLUMN IF NOT EXISTS).
--
-- SOURCE OF TRUTH FOR THE SHAPE: src/longterm/prisma/schema.prisma
-- (LtPpeParityCell.legVersion). Model and migration land together.
-- ---------------------------------------------------------------------------

ALTER TABLE lt_ppe_parity_cell
    ADD COLUMN IF NOT EXISTS leg_version TEXT;   -- agreement-provenance.LEG_VERSION at write time; NULL = pre-stamp

COMMENT ON COLUMN lt_ppe_parity_cell.leg_version IS
    'The engine-wiring stamp (agreement-provenance.LEG_VERSION) that measured this day cell. NULL means the row predates the stamp; a window mixing values is not a comparable series and its trend is refused.';
