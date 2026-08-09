-- ============================================================================
-- 501 — THE BACK-BOOK ENTITY BACKFILL NEEDS ONE NARROW, TRANSACTION-LOCAL HOLE.
--
-- Owner-directed 2026-08-09, twice. First: "any LLC that he enters should be a
-- real LLC on his profile." Then, asked directly what should happen to lines
-- that are already verified: "Stay verified."
--
-- Those two together are the whole problem this file solves. Thousands of
-- existing track-record lines name their entity ONLY as free text in
-- `entity_name`. Connecting each to the real entity means writing `llc_id` —
-- and `llc_id` is MATERIAL to the verify guard, so a naive pass would un-verify
-- the entire book, drop every borrower's experience tier, and reopen the
-- experience condition on live files. That is precisely what the owner said must
-- not happen.
--
-- ── WHY NOT `ALTER TABLE ... DISABLE TRIGGER` ───────────────────────────────
-- The blueprint pointed at db/399, which disables user triggers for a bounded
-- pass. That is right for db/399 and WRONG here, for two reasons:
--
--   1. IT IS TABLE-WIDE. Every connection loses the guard, not just the pass —
--      so a staffer editing a purchase price while the backfill ran would keep
--      a verification they should have lost. db/399 gets away with it because a
--      migration file is ONE implicit transaction that runs at boot; this pass
--      runs over many batches while the application is serving traffic.
--   2. IT CAN BE LEFT OFF. If the pass dies between the disable and the
--      re-enable, the guard stays down for the whole application until somebody
--      notices — and nothing would notice, because the symptom is silence.
--
-- `current_setting('pilot.track_record_entity_backfill', true)` reads a GUC the
-- pass sets with SET LOCAL. That is scoped to ONE TRANSACTION on ONE CONNECTION
-- and disappears the instant the transaction ends, however it ends — commit,
-- rollback, or the process being killed. It cannot leak, and it cannot be left
-- on.
--
-- ── AND THE HOLE IS AS SMALL AS IT CAN BE ───────────────────────────────────
-- Only a NULL -> value FILL of `llc_id` is exempt. Re-pointing a line from one
-- entity to a DIFFERENT one is still a restatement and still un-verifies, even
-- inside the pass and even with the flag set. Every other material column —
-- the address, the figures, the dates, the deal type, `entity_name` itself,
-- `pillars_met` — is completely untouched by this file.
--
-- The pass itself (src/lib/track-record-entity-backfill.js) is bounded,
-- resumable from a durable cursor, audited per row, idempotent, and refuses to
-- write anything where the name is junk or could mean two of the borrower's
-- entities.
--
-- This is db/500's guard VERBATIM with exactly ONE line replaced, built by
-- extracting that function's text programmatically — db/497 was retyped from a
-- partial read and silently reverted three unrelated rules.
-- ============================================================================

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
  'db/485 + db/493 + db/500 + db/501. Nothing lands verified; a MATERIAL edit returns a row to '
  'pending. The address comparison is SEMANTIC. pillars_met is material in the withdrawal '
  'direction only. The ONE exemption is a NULL->value fill of llc_id while the transaction-local '
  'GUC pilot.track_record_entity_backfill is on — connecting a line to the entity its own free '
  'text already named is a repair. Re-pointing to a DIFFERENT entity is never exempt.';
