-- ============================================================================
-- 500 — pillars_met, ITS BACKFILL, AND THE ONE ASYMMETRIC GUARD CLAUSE.
--
-- This is the migration that connects db/494's three verification pillars to the
-- line they describe. It is the most delicate file in Phase 1, because it touches
-- the verify guard, and getting that wrong un-verifies the whole book.
--
-- ── THE ORDER OF THE STATEMENTS IS LOAD-BEARING ─────────────────────────────
-- column -> BACKFILL -> trigger -> guard. The backfill inserts three pillar rows
-- per existing line, and it runs BEFORE the sync trigger exists. Two reasons:
--   1. the trigger would fire once per inserted row and do a SELECT + UPDATE
--      each time, turning a single INSERT ... SELECT into 3N round trips;
--   2. more importantly, it means the backfill provably cannot write to
--      track_records at all, so it cannot touch the verify guard, so it CANNOT
--      UN-VERIFY A SINGLE LINE. Owner-directed 2026-08-09: existing verified
--      lines keep their verification.
--
-- ── WHY THE BACKFILL IS SAFE EVEN ONCE THE TRIGGER EXISTS ───────────────────
-- Every backfilled pillar lands with `auto_verdict` and `human_verdict` NULL,
-- which reads as "nobody has checked this yet" — never as a failure. So the
-- computed pillars_met is FALSE, which equals the column DEFAULT, so the sync's
-- `IS DISTINCT FROM` guard writes nothing even on a re-run. Belt and braces.
--
-- ── THE ASYMMETRIC CLAUSE, WHICH CORRECTS THE BLUEPRINT ─────────────────────
-- The blueprint said pillars_met "is added to db/485's material-column list, so a
-- pillar change re-opens verification exactly as a figure change does". Taken
-- literally that is an ordinary `IS DISTINCT FROM`, and it is BACKWARDS: it fires
-- on false -> true as well, so the moment a reviewer confirms the third and last
-- pillar, the line they just finished verifying would drop back to pending. The
-- work would undo itself.
--
-- Only the WITHDRAWAL direction is a restatement. `OLD.pillars_met AND NOT
-- NEW.pillars_met` means the evidence this line was standing on has been taken
-- away — a pillar rejected, reopened, or lapsed — and that genuinely is new
-- information the verification never saw.
--
-- ── pillars_met READS human_verdict ONLY ────────────────────────────────────
-- Nothing automatic may ever satisfy a pillar (db/494's own rule). The sync
-- counts pillars whose HUMAN verdict is 'confirmed'; `auto_verdict` is not
-- consulted here at all, so no detector, sweep or vendor can move this column.
--
-- ── AND THE ONE HONEST LIMITATION ───────────────────────────────────────────
-- The count excludes a pillar whose `expires_at` has passed. Expiry is a clock
-- event with no accompanying write, so a line can become stale WITHOUT this
-- column changing. That is why `track_record_pillars_met_recompute(uuid)` is
-- exported as a plain function: the expiry sweep (Phase 2) must call it for each
-- line it touches. Do not assume the trigger alone keeps this true over time.
--
-- Idempotent throughout: ADD COLUMN IF NOT EXISTS, INSERT ... ON CONFLICT DO
-- NOTHING, CREATE OR REPLACE, DROP/CREATE TRIGGER.
-- ============================================================================

ALTER TABLE track_records
  ADD COLUMN IF NOT EXISTS pillars_met boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN track_records.pillars_met IS
  'db/500. All three pillars (recency, ownership, exit) carry human_verdict = ''confirmed'' and '
  'none has lapsed. Maintained by trg_track_record_pillars_met over track_record_pillars. Reads '
  'human_verdict ONLY — nothing automatic may satisfy a pillar. Material to the verify guard in '
  'ONE DIRECTION only: true -> false re-opens the line; false -> true must not, or finishing the '
  'verification work would undo the verification.';

-- ── THE BACKFILL. Runs BEFORE the trigger exists, so it cannot write to
--    track_records and therefore cannot un-verify anything.
INSERT INTO track_record_pillars (track_record_id, pillar)
SELECT t.id, p.pillar
  FROM track_records t
  CROSS JOIN (VALUES ('recency'), ('ownership'), ('exit')) AS p(pillar)
ON CONFLICT (track_record_id, pillar) DO NOTHING;

-- ── EVERY LINE GETS ITS THREE PILLARS, INCLUDING THE ONES CREATED TOMORROW.
--    The backfill above covers the book as it stands; without this trigger a line
--    created AFTER the migration would carry no pillars at all, so the workspace
--    would show nothing to verify and pillars_met could never become true. The
--    first cut of this migration shipped exactly that gap and the Phase 1 test
--    caught it ("a new line gets exactly three pillars").
--
--    NOT RE-ENTRANT: inserting the pillars fires the sync below, which computes
--    false and finds pillars_met already false, so its IS DISTINCT FROM guard
--    writes nothing back to track_records. The verify guard is never woken, so a
--    line cannot un-verify itself by being born.
CREATE OR REPLACE FUNCTION track_record_create_pillars() RETURNS trigger AS $$
BEGIN
  INSERT INTO track_record_pillars (track_record_id, pillar)
  SELECT NEW.id, p.pillar FROM (VALUES ('recency'),('ownership'),('exit')) AS p(pillar)
  ON CONFLICT (track_record_id, pillar) DO NOTHING;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_track_record_create_pillars ON track_records;
CREATE TRIGGER trg_track_record_create_pillars
  AFTER INSERT ON track_records
  FOR EACH ROW EXECUTE FUNCTION track_record_create_pillars();

-- ── THE SYNC. Exported as a callable function as well as a trigger, because
--    expiry is a clock event that arrives with no write of its own.
CREATE OR REPLACE FUNCTION track_record_pillars_met_recompute(tr uuid) RETURNS void AS $$
DECLARE met boolean;
BEGIN
  -- Exactly three pillars exist per line (db/494's unique constraint), so
  -- "three confirmed" is the same as "all confirmed" and is cheaper to read.
  SELECT count(*) FILTER (
           WHERE human_verdict = 'confirmed'
             AND (expires_at IS NULL OR expires_at > now())
         ) = 3
    INTO met
    FROM track_record_pillars WHERE track_record_id = tr;

  -- IS DISTINCT FROM: an unchanged value must write NOTHING, or every pillar
  -- edit would touch track_records and wake the verify guard for no reason.
  UPDATE track_records SET pillars_met = COALESCE(met, false)
   WHERE id = tr AND pillars_met IS DISTINCT FROM COALESCE(met, false);
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION track_record_pillars_met_sync() RETURNS trigger AS $$
BEGIN
  PERFORM track_record_pillars_met_recompute(COALESCE(NEW.track_record_id, OLD.track_record_id));
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_track_record_pillars_met ON track_record_pillars;
CREATE TRIGGER trg_track_record_pillars_met
  AFTER INSERT OR UPDATE OR DELETE ON track_record_pillars
  FOR EACH ROW EXECUTE FUNCTION track_record_pillars_met_sync();

-- ── THE GUARD. db/493's function VERBATIM with exactly ONE line replaced — the
--    material IF, which now leads with the asymmetric pillars_met clause. Built
--    by extracting db/493's text programmatically, not retyped: db/497 was
--    retyped from a partial read and silently reverted three unrelated rules.
CREATE OR REPLACE FUNCTION track_record_verify_guard() RETURNS trigger AS $$
DECLARE
  addr_restated boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- NOTHING ARRIVES VERIFIED. Unchanged from db/485.
    NEW.is_verified := false;
    NEW.verified_at := NULL;
    NEW.verified_by := NULL;
    IF track_record_counts_as_verified(NEW.verification_status) THEN
      NEW.verification_status := 'pending';
    END IF;
    RETURN NEW;
  END IF;

  -- Did the ADDRESS change in a way that restates which property this is?
  -- Not a change at all -> no. Otherwise ask whether the two are the same place;
  -- `pilot_address_same_place` fails closed on anything it cannot read, so an
  -- unreadable address on either side is still treated as a restatement.
  IF NEW.property_address IS NOT DISTINCT FROM OLD.property_address THEN
    addr_restated := false;
  ELSE
    addr_restated := NOT COALESCE(
      pilot_address_same_place(NEW.property_address, OLD.property_address), false);
  END IF;

  /* db/500 — A PILLAR THAT WAS MET AND IS NO LONGER RE-OPENS THE LINE.
     ASYMMETRIC ON PURPOSE, and this CORRECTS the blueprint, which said pillars_met
     "is added to db/485's material-column list, so a pillar change re-opens
     verification exactly as a figure change does". A plain IS DISTINCT FROM would
     also fire on false -> true, i.e. on somebody FINISHING the verification work —
     completing the three checks would un-verify the line they were completing.
     Only the withdrawal direction is a restatement: a pillar that was confirmed
     and now is not means the evidence this line stood on is gone. */
  IF (COALESCE(OLD.pillars_met, false) AND NOT COALESCE(NEW.pillars_met, false))
     OR addr_restated
     OR (NEW.llc_id           IS DISTINCT FROM OLD.llc_id)
     OR (NEW.owned_personally IS DISTINCT FROM OLD.owned_personally)
     OR (NEW.entity_name      IS DISTINCT FROM OLD.entity_name)
     OR (NEW.deal_type        IS DISTINCT FROM OLD.deal_type)
     OR (NEW.property_type    IS DISTINCT FROM OLD.property_type)
     OR (NEW.purchase_price   IS DISTINCT FROM OLD.purchase_price)
     OR (NEW.sale_price       IS DISTINCT FROM OLD.sale_price)
     OR (NEW.rehab_amount     IS DISTINCT FROM OLD.rehab_amount)
     OR (NEW.rent_amount      IS DISTINCT FROM OLD.rent_amount)
     OR (NEW.refi_amount      IS DISTINCT FROM OLD.refi_amount)
     OR (NEW.current_value    IS DISTINCT FROM OLD.current_value)
     OR (NEW.purchase_date    IS DISTINCT FROM OLD.purchase_date)
     OR (NEW.sale_date        IS DISTINCT FROM OLD.sale_date)
     OR (NEW.rent_date        IS DISTINCT FROM OLD.rent_date)
     OR (NEW.refi_date        IS DISTINCT FROM OLD.refi_date)
  THEN
    NEW.is_verified := false;
    NEW.verified_at := NULL;
    NEW.verified_by := NULL;
    IF track_record_counts_as_verified(NEW.verification_status) THEN
      NEW.verification_status := 'pending';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_track_record_verify_guard ON track_records;
CREATE TRIGGER trg_track_record_verify_guard
  BEFORE INSERT OR UPDATE ON track_records
  FOR EACH ROW EXECUTE FUNCTION track_record_verify_guard();

COMMENT ON FUNCTION track_record_verify_guard() IS
  'db/485 + db/493 + db/500. Nothing lands verified; a MATERIAL edit returns a row to pending. '
  'The address comparison is SEMANTIC (pilot_address_same_place). pillars_met is material in ONE '
  'DIRECTION only: a pillar that was met and no longer is re-opens the line; finishing the pillars '
  'must never un-verify the line being finished.';
