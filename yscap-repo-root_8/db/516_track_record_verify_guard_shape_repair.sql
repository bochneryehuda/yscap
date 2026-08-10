-- A STORAGE-SHAPE REPAIR OF property_address IS NOT A RESTATEMENT — do not un-verify for it.
--
-- The FOURTH fix to the verify guard, on db/485 (the guard) + db/493 (semantic address
-- comparison) + db/500 (pillars_met is material in the withdrawal direction) + db/501 (the
-- transaction-local entity-backfill exemption). db/493 compares two addresses with
-- `pilot_address_same_place`, which keys on house|street|state|zip|unit — and db/415 returns
-- an EMPTY key for any jsonb that is NOT an object. So a bare one-line STRING property_address
-- reads as unreadable, `pilot_address_same_place` fails closed to FALSE, and the guard calls
-- it a restatement.
--
-- The public-records importer stored property_address as a bare string (elementix shapes.js
-- flattens a deed's addresses[{addressFull}] to a one-liner). That is fixed at the source,
-- and a boot heal (lib/track-record-address-shape) reshapes the rows it already wrote into
-- the canonical { line1, city, state, zip, oneLine } object every reader expects — keeping
-- oneLine byte-identical to the original string. Under db/501 that reshape trips the guard
-- and un-verifies every reviewed public-records line on the next deploy — dropping the
-- borrower's experience tier, reopening the experience condition
-- (syncExperienceChecklistForBorrower), and un-readying closing-ready files. db/501 simply
-- could not read the string side to spare it.
--
-- THE FIX ADDS ONE BRANCH to the address decision and CHANGES NOTHING ELSE. This file is
-- db/501's guard VERBATIM — the pillar-withdrawal rule (db/500), the entity-backfill
-- exemption (db/501) and every material column are byte-for-byte db/501 — with exactly the
-- three-way `addr_restated` decision replacing db/501's two-way one. That verbatim-copy
-- discipline is the whole point: db/501's own header records that db/497 was "retyped from a
-- partial read and silently reverted three unrelated rules", so the guard is only ever edited
-- by copying the current body and touching one thing.
--
-- THE ONE NEW BRANCH: before asking `pilot_address_same_place`, ask whether the two addresses
-- carry the SAME canonical text (oneLine, falling back to a bare string). If they do, only the
-- storage shape changed — a repair, not a restatement — exactly as db/485 spares address_key
-- and db/493 spares a re-spelling. A reshape from this heal never changes the text, so it is
-- always spared; a real edit always changes the text, so it is never spared; and every case
-- with DIFFERENT text still goes through `pilot_address_same_place` (a same-place re-spelling
-- stays non-material, a different property / unreadable side / filling a blank stays material).
--
-- Numbered above db/501 so this definition wins on every boot (all re-create the function each
-- deploy — the db/334 -> db/375 ordering mechanism). The verification_status CHECK constraint
-- (db/493) is untouched.
--
-- Idempotent: CREATE OR REPLACE + DROP/CREATE TRIGGER.

-- The canonical address TEXT of a property_address value, whether stored as the canonical
-- object (its oneLine) or a legacy bare string (the string itself). NULL for no address.
CREATE OR REPLACE FUNCTION track_record_address_text(pa jsonb) RETURNS text AS $$
  SELECT CASE
    WHEN pa IS NULL THEN NULL
    WHEN jsonb_typeof(pa) = 'string' THEN pa #>> '{}'
    ELSE COALESCE(pa ->> 'oneLine', pa #>> '{}')
  END;
$$ LANGUAGE sql IMMUTABLE;

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
  --   · not a change at all              -> no (db/485)
  --   · same canonical TEXT, new shape   -> no: a bare string reshaped to the canonical
  --                                         object (db/516). pilot_address_same_place cannot
  --                                         read a bare string (db/415 returns '' for a
  --                                         non-object), so identical text is what proves the
  --                                         same place here.
  --   · otherwise                        -> pilot_address_same_place, which fails closed on
  --                                         anything it cannot read (db/493 / db/415).
  IF NEW.property_address IS NOT DISTINCT FROM OLD.property_address THEN
    addr_restated := false;
  ELSIF track_record_address_text(NEW.property_address) IS NOT NULL
        AND track_record_address_text(NEW.property_address)
            IS NOT DISTINCT FROM track_record_address_text(OLD.property_address) THEN
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
     /* db/501 — THE ONE NARROW EXEMPTION, and it is transaction-local.
        Connecting a line to the entity its own free text ALREADY NAMED is a
        repair, not a restatement: the property, the price, the dates and the
        deal type are byte-identical before and after. Without this, the
        back-book pass would un-verify the entire book, drop every borrower's
        experience tier and reopen the experience condition on live files.

        WHY NOT `ALTER TABLE ... DISABLE TRIGGER`, which the blueprint's db/399
        precedent used: that is TABLE-WIDE and affects EVERY connection, so a
        staffer editing a purchase price while the pass ran would keep their
        verification too — and if the pass died between disable and re-enable,
        the guard would stay OFF for the whole application until somebody
        noticed. `current_setting(..., true)` reads a GUC the pass sets with
        SET LOCAL, so it is scoped to one transaction on one connection and is
        gone the instant that transaction ends, however it ends.

        AND IT IS THE NARROWEST POSSIBLE HOLE: only a NULL -> value FILL is
        exempt. Re-pointing a line from one entity to another is still a
        restatement and still un-verifies, even inside the pass. */
     OR (NEW.llc_id IS DISTINCT FROM OLD.llc_id
         AND NOT (OLD.llc_id IS NULL
                  AND NEW.llc_id IS NOT NULL
                  AND COALESCE(current_setting('pilot.track_record_entity_backfill', true), '') = 'on'))
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
  'db/485 + db/493 + db/500 + db/501 + db/516. Nothing lands verified; a MATERIAL edit '
  'returns a row to pending. The address comparison is SEMANTIC (pilot_address_same_place) '
  'with a same-canonical-text short-circuit (db/516): a re-spelling of the same place OR a '
  'pure storage-shape reshape (bare string -> canonical object) is a repair, not a '
  'restatement. pillars_met is material in the withdrawal direction only. The ONE exemption '
  'is a NULL->value fill of llc_id while the transaction-local GUC '
  'pilot.track_record_entity_backfill is on.';
