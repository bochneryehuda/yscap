-- ============================================================================
-- db/575 — lt application source ids
--
-- WHAT THIS CHANGES, AND WHY. The 1003 child tables (db/549) carry NO record of
-- where each row came from, so there is no way to mirror them twice. Encompass
-- gives every one of these rows a stable id of its own — `reoProperties[].id`,
-- `vols[].id`, `vods[].id`, `income[].id`, `residences[]` — and without somewhere
-- to keep it, a second read of the same loan can only ADD: a borrower with a
-- nine-property REO schedule would show eighteen after two passes, twenty-seven
-- after three, and the only alternatives are to delete and re-insert the lot
-- (this mirror's rule is that nothing is ever deleted) or to key on a name and
-- an address, which two rows on one file legitimately share.
--
-- So each child table gains `encompass_id` plus a PARTIAL unique index — partial
-- because a row Encompass sends without an id must still be storable, and a
-- blanket unique index over a nullable column would collapse two real rows that
-- both happen to arrive without one. A writer keying on it must repeat the
-- predicate in its `ON CONFLICT`, or Postgres cannot infer a partial index.
--
-- `lt_parties` gets one too. Its identity is the SLOT (pair + role, db/549's own
-- unique index) and that stays the key — a name changes and a slot does not —
-- but Encompass's own party id is worth keeping beside it: it is what a future
-- reader will need to tie a residence, an employment or an income row back to
-- the person it belongs to when the payload names the party rather than the pair.
--
-- IDEMPOTENT. Every statement is IF NOT EXISTS; the file replays cleanly.
--
-- BACKFILL: NONE, and deliberately. Nothing has ever written these tables (the
-- writer lands in the same change), so there are no rows to key. A backfill here
-- would have nothing to read and nothing to write.
--
-- PRODUCT SEPARATION. Long-Term only: every table named is `lt_*`.
-- ============================================================================

ALTER TABLE lt_parties          ADD COLUMN IF NOT EXISTS encompass_id TEXT;
ALTER TABLE lt_residences       ADD COLUMN IF NOT EXISTS encompass_id TEXT;
ALTER TABLE lt_employments      ADD COLUMN IF NOT EXISTS encompass_id TEXT;
ALTER TABLE lt_other_incomes    ADD COLUMN IF NOT EXISTS encompass_id TEXT;
ALTER TABLE lt_assets           ADD COLUMN IF NOT EXISTS encompass_id TEXT;
ALTER TABLE lt_liabilities      ADD COLUMN IF NOT EXISTS encompass_id TEXT;
ALTER TABLE lt_reo_properties   ADD COLUMN IF NOT EXISTS encompass_id TEXT;

-- PARTIAL, on (owner, id): the id is unique within the loan it came from, and
-- scoping it to the party is what keeps two people's rows from colliding on an
-- id Encompass happens to reuse across applications.
CREATE UNIQUE INDEX IF NOT EXISTS lt_residences_enc_uk
    ON lt_residences (party_id, encompass_id) WHERE encompass_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS lt_employments_enc_uk
    ON lt_employments (party_id, encompass_id) WHERE encompass_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS lt_other_incomes_enc_uk
    ON lt_other_incomes (party_id, encompass_id) WHERE encompass_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS lt_assets_enc_uk
    ON lt_assets (party_id, encompass_id) WHERE encompass_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS lt_liabilities_enc_uk
    ON lt_liabilities (party_id, encompass_id) WHERE encompass_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS lt_reo_properties_enc_uk
    ON lt_reo_properties (party_id, encompass_id) WHERE encompass_id IS NOT NULL;

-- The party's own id is NOT unique-indexed: the slot (pair_id, role) is already
-- the identity, and a second unique key on the same row is a second way for a
-- write to be refused for a reason nobody is looking at.
CREATE INDEX IF NOT EXISTS lt_parties_encompass_id_idx
    ON lt_parties (encompass_id) WHERE encompass_id IS NOT NULL;


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself.
