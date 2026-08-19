-- ============================================================================
-- db/587 — arena ticket adjustments so a decision can be undone
--
-- WHAT THIS CHANGES, AND WHY. Declining a challenge fulfilment took the chances
-- back by adding a NEGATIVE ledger row that carried no `entry_id`. Two things
-- follow from that, both observed: declining the SAME fulfilment twice took the
-- chances back TWICE (the "what has this entry already been paid?" question
-- reads `entry_id`, and the negative row was invisible to it), and APPROVING it
-- again afterwards gave nothing back (the approve insert is guarded by a unique
-- index on `entry_id`, so it refused to re-add a row that was already there).
-- A person who was declined by mistake ended the day one chance short with no
-- way to fix it.
--
-- The fix in `src/lib/arena/challenges.js` reconciles an entry's own tickets the
-- way the streak bonus already does: work out what this entry SHOULD be worth
-- now, read what it has actually been paid, and write the difference as one
-- `adjustment` row carrying the `entry_id`. That makes every path — approve,
-- approve twice, decline, decline twice, decline then approve — land on the
-- same answer. This file widens the ledger's source list so that row can exist,
-- and re-keys the negative rows already written so they are counted.
--
-- IDEMPOTENT. `migrate-boot` replays EVERY file in db/ on EVERY boot, in
-- filename order. That is not a safety net, it is the contract: a statement
-- that throws on its second run breaks every future deploy, and migrate-boot
-- logs the failure and CONTINUES, so it breaks quietly. The four shapes the
-- hygiene gate enforces:
--
--   CREATE TABLE IF NOT EXISTS t (...);
--   CREATE INDEX IF NOT EXISTS t_col_idx ON t (col);
--   ALTER TABLE t ADD COLUMN IF NOT EXISTS c text;
--   ALTER TABLE t DROP CONSTRAINT IF EXISTS t_chk;   -- always drop first,
--   ALTER TABLE t ADD CONSTRAINT t_chk CHECK (...);  -- then re-add
--
-- RE-ASSERTING A CHECK. db/586 also asserts `arena_tickets_source_chk`, with
-- the narrower list, and it re-runs on every boot BEFORE this file does. So the
-- list below names EVERY value db/586 allows plus the new one — a narrower
-- re-assert here would roll this one back the moment a row uses 'adjustment'.
-- Once such a row exists, db/586's own re-add fails on each boot; the runner
-- recognises that exact case (a check_violation on a constraint a LATER file
-- re-defines), skips it quietly, and this file re-asserts the wide list, so the
-- end state is correct. This is why the constraint is re-added here under
-- db/586's OWN name rather than a new one.
--
-- BACKFILL. Yes, and it is deterministic: a reversal row records the challenge
-- and the person, and there is at most one fulfilment per (challenge, person),
-- so the entry it reversed is knowable. Re-keying those rows is what stops the
-- new reconciliation from counting a reversal that already happened as though
-- it had not. Scoped to `source = 'reversal'` with both keys present, so a
-- manual or bonus row is never touched (a bonus row deliberately carries no
-- entry, and re-keying one would let a decline claw back a streak bonus).
--
-- PRODUCT SEPARATION. RTL and Long-Term do not share tables. If this touches
-- `lt_*`, it is Long-Term's and must not reach into RTL's; if it touches RTL's,
-- the reverse. `check-product-separation.js` is the gate.
-- ============================================================================

-- ── (1) THE LEDGER MAY CARRY A CORRECTION ───────────────────────────────────
ALTER TABLE arena_tickets DROP CONSTRAINT IF EXISTS arena_tickets_source_chk;
ALTER TABLE arena_tickets ADD CONSTRAINT arena_tickets_source_chk
  CHECK (source IN ('challenge', 'manual', 'bonus', 'reversal', 'adjustment'));

-- ── (2) RE-KEY THE REVERSALS ALREADY WRITTEN ────────────────────────────────
-- Guarded on `entry_id IS NULL`, so a row this has already fixed is left alone
-- and the statement is a no-op on every boot after the first.
UPDATE arena_tickets t
   SET entry_id = e.id
  FROM arena_challenge_entries e
 WHERE t.source = 'reversal'
   AND t.entry_id IS NULL
   AND t.challenge_id IS NOT NULL
   AND e.challenge_id = t.challenge_id
   AND e.staff_id = t.staff_id;


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
