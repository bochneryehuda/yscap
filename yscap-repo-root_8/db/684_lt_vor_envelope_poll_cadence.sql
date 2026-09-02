-- ============================================================================
-- db/684 — lt vor envelope poll cadence
--
-- WHAT THIS CHANGES, AND WHY. The Long-Term rent-verification (VOR) desk asks
-- DocuSign about every envelope still out on EVERY sync tick — five minutes —
-- because a Connect delivery can be lost and the poll is the correctness
-- machinery. DocuSign's polling policy allows one status request per envelope
-- per 15 minutes; asking three times as often is a policy violation that can get
-- the whole integration key throttled (owner-directed 2026-09-02: "make the LT
-- VOR poll also follow the 15 minute rule"). This records WHEN each envelope was
-- last asked about, so the pass can skip an envelope asked about less than 15
-- minutes ago. NULL means "never asked" and is due now — the existing behaviour.
--
-- BACKFILL: none. Every envelope out today reads NULL, which the pass treats as
-- due, exactly as it always did; the stamp then paces it from the next pass on.
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
-- RE-ASSERTING A CHECK. If this file widens a CHECK constraint that an earlier
-- migration also asserts, name EVERY value the earlier files added, not just
-- the new one — the older file replays too, and a narrower re-assert would roll
-- this one back the moment a row uses the new value.
--
-- BACKFILL. State the decision explicitly, even when it is "none". Silence
-- reads as "not considered".
--
-- PRODUCT SEPARATION. RTL and Long-Term do not share tables. If this touches
-- `lt_*`, it is Long-Term's and must not reach into RTL's; if it touches RTL's,
-- the reverse. `check-product-separation.js` is the gate.
-- ============================================================================

-- When DocuSign was last asked about this envelope. Stamped BEFORE the call, so a
-- failing read is paced like a successful one instead of retrying every tick.
ALTER TABLE lt_vor_envelopes ADD COLUMN IF NOT EXISTS docusign_checked_at timestamptz;

-- The reconcile pass selects the live envelopes due for a check, oldest-asked first.
CREATE INDEX IF NOT EXISTS lt_vor_envelopes_checked_idx
  ON lt_vor_envelopes (docusign_checked_at NULLS FIRST)
  WHERE envelope_id IS NOT NULL;


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
