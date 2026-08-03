-- 421 — THE RE-ROLL SWEEP'S INDEX MUST NOT BE PINNED TO ONE VERSION NUMBER
--
-- db/414 created the index the boot re-roll sweep drains through:
--
--   CREATE INDEX ix_properties_rollup_version ON properties(rollup_version, observation_count DESC)
--     WHERE rollup_version < 2;      -- ← the literal 2
--
-- ...and its own comment two lines above says "any future change to what rolls up
-- bumps ROLLUP_VERSION in ingest.js and the whole warehouse re-rolls itself over
-- the following boots. Nothing else to write."
--
-- That instruction is a trap as written. `ROLLUP_VERSION` is 2 today, so the
-- predicate matches the query. The moment anyone follows the instruction and
-- bumps it to 3, `WHERE rollup_version < 3` no longer implies `< 2`, Postgres
-- cannot use the partial index, and the sweep falls back to a sequential scan of
-- the whole table — measured on this schema, `EXPLAIN` reports `Seq Scan` — on
-- EVERY boot until the backlog drains. Correctness is unaffected; at a few
-- hundred thousand properties the cost is not.
--
-- The fix is to stop encoding the current version in the index at all. The sweep
-- only ever asks for "rows behind the current version, biggest first", and a row
-- that is CURRENT is the overwhelming majority — so what the index needs to be
-- selective about is not the number, it is the ordering. A plain btree on
-- (rollup_version, observation_count DESC) serves `rollup_version < N` for ANY N
-- and never needs touching again.
--
-- Idempotent, and safe to run against a table of any size: the new index is
-- created first, so the sweep is never left without one.

CREATE INDEX IF NOT EXISTS ix_properties_rollup_version_all
  ON properties(rollup_version, observation_count DESC);

DROP INDEX IF EXISTS ix_properties_rollup_version;

COMMENT ON INDEX ix_properties_rollup_version_all IS
  'Drains the boot re-roll sweep (ingest.rerollStaleProperties). Deliberately NOT '
  'partial: a WHERE rollup_version < <literal> predicate stops serving the query the '
  'first time ROLLUP_VERSION is bumped, which is exactly when the sweep matters most.';
