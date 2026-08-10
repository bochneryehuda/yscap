-- A STORAGE-SHAPE REPAIR OF property_address IS NOT A RESTATEMENT — do not un-verify for it.
--
-- The THIRD fix to the verify guard, on top of db/485 (the guard) and db/493 (which made the
-- address comparison SEMANTIC so address-heal's re-spellings stop un-verifying). db/493
-- compares two addresses with `pilot_address_same_place`, which keys on house|street|state|
-- zip|unit — and db/415 returns an EMPTY key for any jsonb that is NOT an object. So a bare
-- one-line STRING property_address reads as unreadable, `pilot_address_same_place` fails
-- closed to FALSE, and the guard calls it a restatement.
--
-- The public-records importer stored property_address as a bare string (elementix shapes.js
-- flattens a deed's addresses[{addressFull}] to a one-liner). That is fixed at the source,
-- and a boot heal (lib/track-record-address-shape) reshapes the rows it already wrote into
-- the canonical { line1, city, state, zip, oneLine } object every reader expects — keeping
-- oneLine byte-identical to the original string. Under db/493 that reshape trips the guard
-- and un-verifies every reviewed public-records line on the next deploy — dropping the
-- borrower's experience tier, reopening the experience condition
-- (syncExperienceChecklistForBorrower), and un-readying closing-ready files. That is the
-- EXACT harm db/485/db/493 were written to prevent; db/493 simply could not read the string
-- side to spare it.
--
-- THE FIX ADDS ONE BRANCH and preserves db/493 intact. Before asking
-- `pilot_address_same_place`, ask whether the two addresses carry the SAME canonical text
-- (oneLine, falling back to a bare string). If they do, only the storage shape changed — a
-- repair, not a restatement — and it is spared, exactly as db/485 spares address_key and
-- db/493 spares a re-spelling. `pilot_address_same_place` still governs every case with
-- DIFFERENT text (a genuine re-spelling of the same place stays non-material; a different
-- property, an unreadable side, or filling in an address where there was none all stay
-- material and still un-verify). A reshape from this heal never changes the text, so it is
-- always spared; a real edit always changes the text, so it is never spared.
--
-- Numbered above db/493 so this definition wins on every boot (both re-create the function
-- each deploy — the db/334 -> db/375 ordering mechanism). The db/493 verification_status
-- CHECK constraint is untouched.
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
  --                                         object. pilot_address_same_place cannot read a
  --                                         string, so identical text is what proves the
  --                                         same place here (db/516).
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

  IF addr_restated
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
  'db/485 + db/493 + db/516. Nothing lands verified; a MATERIAL edit returns a row to '
  'pending. The address comparison is SEMANTIC (pilot_address_same_place, db/415) with a '
  'same-canonical-text short-circuit (db/516): a re-spelling of the same place OR a pure '
  'storage-shape reshape (bare string -> canonical object) is a repair, not a restatement, '
  'so neither the boot address-heal nor the public-records address-shape heal un-verifies.';
