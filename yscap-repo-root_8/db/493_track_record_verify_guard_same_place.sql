-- ============================================================================
-- 490 — A RE-SPELLING OF THE SAME ADDRESS IS NOT A RESTATEMENT OF THE DEAL,
--       AND `verification_status` CAN NO LONGER HOLD A VALUE NOBODY READS.
--
-- Two fixes to db/485's verify guard, both found by the 2026-08-09 track-record
-- audit (docs/TRACK-RECORD-CURRENT-STATE.md, defects D3 and D7).
--
-- ── (1) THE ADDRESS REPAIR WAS UN-VERIFYING THE BOOK ─────────────────────────
--
-- db/485's header is careful about exactly this class of write:
--
--     "`address_key` (a derived key the heal pass re-computes — re-keying is a
--      repair, not a restatement, and treating it as material would un-verify
--      the whole book on the next heal)"
--
-- So `address_key` was left out of the material list. But `src/lib/address-heal.js`
-- rewrites `property_address` and re-keys `address_key` IN THE SAME STATEMENT
-- (address-heal.js:78-84), and `property_address` IS material. Every long-form
-- address that pass repaired at boot therefore dropped that line's verification
-- and — through syncExperienceChecklistForBorrower — could reopen the experience
-- condition on a live file and flag a registered product stale. The exemption
-- protected the key and not the thing the key is derived from.
--
-- The fix is the one this repo already made for the identical problem on the
-- USPS stamp. db/415 replaced a naive `IS DISTINCT FROM` on `property_address`
-- with a SEMANTIC comparison, because the ClickUp pull kept overwriting the
-- address with Google's spelling of the same place and bouncing the stamp off.
-- Its own header:
--
--     "under-matching costs a re-verification, over-matching would leave a USPS
--      stamp standing on a different property"
--
-- Same reasoning, same function. `pilot_address_same_place(a, b)` (db/415:173)
-- keys on house|street|state|zip5|unit and returns FALSE unless both keys are
-- non-empty and equal — so it deliberately UNDER-matches, and anything it cannot
-- read stays material and still un-verifies. `scripts/test-usps-address-stability-db.js`
-- asserts as a standing invariant that it never calls two addresses the same
-- place when the JS `sameAddress` does not.
--
-- WHAT STILL UN-VERIFIES, unchanged:
--   · a genuinely different property (different house number, street, zip, unit)
--   · filling in an address where there was none (the line now claims a specific
--     property it did not claim before — that IS a restatement)
--   · an address either side of which is unreadable (fails closed, by design)
--
-- WHAT STOPS UN-VERIFYING:
--   · "1727 S 2nd St" -> "1727 South 2nd Street" — the same house, respelled
--   · the same address re-serialized into a different jsonb key order
--
-- ── (2) `verification_status` HAD NO CHECK CONSTRAINT ────────────────────────
--
-- The column has carried four meanings since db/031 — pending | docs | verified
-- | limited — enforced only by `TR_STATUSES` in src/routes/staff.js. Nothing at
-- the database level stopped a fifth value, and nothing tied it to `is_verified`,
-- so `verification_status='verified'` alongside `is_verified=false` was storable.
-- Every count reads `is_verified`; every screen reads `verification_status`. A
-- row where they disagree is a row where the pipeline and the portal show
-- different things about the same deal.
--
-- The constraint is added NOT VALID and then validated separately: NOT VALID
-- takes only a SHARE UPDATE EXCLUSIVE lock and does not scan the table, so a
-- boot on a large table is not blocked. VALIDATE re-scans without blocking
-- writes. If the back book already holds a bad value the validation is skipped
-- with a NOTICE rather than failing the boot — a migration that cannot deploy is
-- worse than a constraint that lands one deploy later.
--
-- Idempotent: CREATE OR REPLACE + DROP/CREATE TRIGGER + guarded ADD CONSTRAINT.
-- ============================================================================

-- (1) The guard, with the address comparison made semantic.
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
  'db/485 + db/493. Nothing lands verified; a MATERIAL edit returns a row to pending. '
  'The address comparison is SEMANTIC (pilot_address_same_place, db/415): a re-spelling '
  'of the same place is a repair, not a restatement, so the boot address-heal no longer '
  'un-verifies every line it fixes.';

-- (2) verification_status: the four values the app has always meant.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'track_records_verification_status_check'
  ) THEN
    ALTER TABLE track_records
      ADD CONSTRAINT track_records_verification_status_check
      CHECK (verification_status IN ('pending','docs','verified','limited')) NOT VALID;
  END IF;
END $$;

DO $$
DECLARE bad bigint;
BEGIN
  SELECT count(*) INTO bad FROM track_records
   WHERE verification_status NOT IN ('pending','docs','verified','limited');
  IF bad > 0 THEN
    RAISE NOTICE 'db/493: % track_records row(s) carry an unknown verification_status; '
                 'leaving track_records_verification_status_check NOT VALID. '
                 'Fix the rows, then run: ALTER TABLE track_records VALIDATE CONSTRAINT '
                 'track_records_verification_status_check;', bad;
  ELSE
    -- VALIDATE is a no-op once the constraint is already validated, so this is
    -- safe on every re-run.
    ALTER TABLE track_records VALIDATE CONSTRAINT track_records_verification_status_check;
  END IF;
END $$;

COMMENT ON COLUMN track_records.verification_status IS
  'pending | docs | verified | limited. ''verified'' and ''limited'' both COUNT toward '
  'experience (track_record_counts_as_verified). Constrained by db/493; the authority on '
  'whether a line counts is still is_verified, which only POST /track-records/:id/verify sets.';
