-- ============================================================================
-- db/666 — where a long-term file's flood answer CAME FROM
--
-- WHAT THIS CHANGES, AND WHY. `lt_properties.in_flood_zone` decides whether a
-- long-term file asks for a flood insurance agent and a flood insurance order.
-- Until now it had exactly ONE writer — a person ticking the switch on the
-- Orders screen (routes/orders.js, owner-directed 2026-08-31) — while Encompass
-- has carried the answer all along in field 541
-- (closingDocument.specialFloodHazardAreaIndictor, labelled "Property Info
-- Flood Zone"), filled on 40.2% of this tenant's long-term loans. The owner
-- asked for both routes: *"This is only if you tick that this is a flood zone
-- or if it realizes from encompass that this is in a flood zone."*
--
-- Reading Encompass and writing the same two columns puts TWO writers on one
-- fact, and the loser is always the person: the sync runs every few minutes and
-- a plain overwrite would wipe a tick within the hour. So the column below
-- records WHO ANSWERED. The sync writes only where a human has not
-- ('encompass', or nothing recorded yet); the switch stamps 'manual' and is
-- never overwritten afterwards. That is the whole reason this column exists —
-- it is not provenance decoration, it is the guard.
--
-- `in_flood_zone` and `flood_zone` are NOT added here: db/549 already carries
-- both. Only the source is new.
--
-- IDEMPOTENT. `ADD COLUMN IF NOT EXISTS` plus a drop-then-add CHECK, so every
-- replay is a no-op.
--
-- BACKFILL: NONE, DELIBERATELY. A NULL source means "nobody has answered", and
-- every existing row is either genuinely unanswered or was ticked by hand
-- before this column existed. Stamping the whole book 'encompass' would claim a
-- read that never happened; stamping it 'manual' would freeze Encompass out of
-- every loan for ever. NULL is the honest value, and it is the one the sync is
-- allowed to fill — so a hand-ticked row from before today can be replaced by a
-- real Encompass read, which is the correct outcome: the zone letter on the
-- loan is the determination, and the tick was standing in for it.
--
-- PRODUCT SEPARATION. `lt_*` only. Nothing here reaches an RTL table.
-- ============================================================================

ALTER TABLE lt_properties ADD COLUMN IF NOT EXISTS flood_zone_source text;

COMMENT ON COLUMN lt_properties.flood_zone_source IS
  'Who answered the flood question: encompass (read from field 541) or manual (a person ticked the switch). NULL = nobody has answered. The sync refuses to write over manual.';

-- A value outside the two is not a source, and letting one in would make the
-- sync's own guard unreadable: `flood_zone_source = 'manual'` is the whole test
-- that stops a person's answer being overwritten, so a typo there fails OPEN
-- and the tick is lost on the very next pass.
ALTER TABLE lt_properties DROP CONSTRAINT IF EXISTS lt_properties_flood_zone_source_chk;
ALTER TABLE lt_properties ADD CONSTRAINT lt_properties_flood_zone_source_chk
  CHECK (flood_zone_source IS NULL OR flood_zone_source IN ('encompass', 'manual'));
