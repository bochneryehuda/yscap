-- ============================================================================
-- db/635 — A VERIFICATION THE DATABASE DROPS ON ITS OWN LEAVES A TRACE.
--
-- WHAT WAS OBSERVED (file YSCAP258134794, borrower Leib Lichtman, 2026-08-26).
-- A loan team verified the borrower's third project at 20:25:07. The investor
-- package was exported at 20:43:39 and carried TWO projects. The same staffer
-- verified the SAME line again at 22:06:33. There is no `unverify_track_record`
-- audit row anywhere between those two verifications, and there could not be:
-- the ONLY thing in this system that clears `is_verified` without one is this
-- trigger, and it recorded nothing at all. So the loan team had no way to learn
-- that a line had fallen out, and nobody afterwards could establish which writer
-- had touched the row — the audit trail, the saved copy and the notifications
-- were all silent by construction.
--
-- The un-verifying itself is CORRECT and is not changed here: a material edit
-- genuinely does invalidate a review (db/485), and the exemptions for a
-- re-spelling (db/493), a storage-shape repair (db/516) and the entity backfill
-- (db/501) are all preserved byte-for-byte. What changes is that the drop is now
-- RECORDED, with the columns that moved and the statement that moved them.
--
-- THIS FILE IS db/516's GUARD VERBATIM, extracted programmatically, with ONE
-- addition inside the branch that already drops the verification. That copying
-- discipline is db/501's, and its header records why: db/497 was "retyped from a
-- partial read and silently reverted three unrelated rules".
--
-- Numbered above db/516 so this definition wins on every boot (every one of
-- db/485, 493, 500, 501, 516 re-creates this function each deploy — the
-- db/334 -> db/375 ordering mechanism).
--
-- BACKFILL: NONE, and none is possible. A drop that already happened left no
-- record anywhere to reconstruct it from — that is the whole defect. This is
-- go-forward by nature, not by choice.
--
-- IDEMPOTENT: CREATE OR REPLACE + DROP/CREATE TRIGGER. No table, column,
-- constraint or index is touched.
-- PRODUCT SEPARATION: `track_records` and `audit_log` are RTL tables; nothing
-- here names an `lt_*` object.
-- ============================================================================

CREATE OR REPLACE FUNCTION track_record_verify_guard() RETURNS trigger AS $$
DECLARE
  addr_restated boolean;
  was_counting  boolean;   -- db/635: did this row's verification actually exist to lose?
  changed       jsonb;     -- db/635: what the statement moved, derived from the rows themselves
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
    /* db/635 — A DROPPED VERIFICATION LEAVES A TRACE. Read this BEFORE the
       assignments below, because after them there is nothing left to read. */
    was_counting := COALESCE(OLD.is_verified, false)
                    OR track_record_counts_as_verified(OLD.verification_status);

    NEW.is_verified := false;
    NEW.verified_at := NULL;
    NEW.verified_by := NULL;
    IF track_record_counts_as_verified(NEW.verification_status) THEN
      NEW.verification_status := 'pending';
    END IF;

    IF was_counting THEN
      /* WHAT MOVED IS DERIVED FROM THE TWO ROWS, NEVER FROM A SECOND COPY OF THE
         MATERIAL LIST. A hand-kept list here would go stale the first time a
         column is added to the condition above, and it would go stale SILENTLY —
         the row would say a verification was dropped and name nothing. The
         guard's OWN outputs are excluded (they always differ here, by
         construction) along with `updated_at`, which every writer touches. */
      BEGIN
        SELECT COALESCE(jsonb_object_agg(o.key, jsonb_build_object(
                 'from', CASE WHEN jsonb_typeof(o.value) = 'string' AND length(o.value #>> '{}') > 200
                              THEN to_jsonb(left(o.value #>> '{}', 200) || '…') ELSE o.value END,
                 'to',   CASE WHEN jsonb_typeof(n.value) = 'string' AND length(n.value #>> '{}') > 200
                              THEN to_jsonb(left(n.value #>> '{}', 200) || '…') ELSE n.value END)), '{}'::jsonb)
          INTO changed
          FROM jsonb_each(to_jsonb(OLD)) o
          JOIN jsonb_each(to_jsonb(NEW)) n ON n.key = o.key
         WHERE o.value IS DISTINCT FROM n.value
           AND o.key NOT IN ('is_verified', 'verified_at', 'verified_by',
                             'verification_status', 'updated_at');

        INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
        VALUES ('system', NULL, 'track_record_verification_dropped', 'track_record', NEW.id,
                jsonb_build_object(
                  'borrowerId',        NEW.borrower_id,
                  'wasVerified',       COALESCE(OLD.is_verified, false),
                  'wasStatus',         OLD.verification_status,
                  'verifiedBy',        OLD.verified_by,
                  'verifiedAt',        OLD.verified_at,
                  'addressRestated',   addr_restated,
                  'changed',           changed,
                  /* The statement that did it. Every writer in this repo binds its
                     values as parameters, so this is SQL text with $1 placeholders
                     rather than anybody's data; it is truncated regardless. This is
                     the field that answers WHICH writer, which is the question a
                     silent un-verify leaves nobody able to answer. */
                  'statement',         left(current_query(), 300)));
      EXCEPTION WHEN OTHERS THEN
        /* THE TRACE MAY NEVER COST THE WRITE. A verification being dropped is a
           real state change the rest of the system depends on; failing the
           statement because its audit row could not be written would be worse
           than the silence this file exists to end. */
        NULL;
      END;
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_track_record_verify_guard ON track_records;
CREATE TRIGGER trg_track_record_verify_guard
  BEFORE INSERT OR UPDATE ON track_records
  FOR EACH ROW EXECUTE FUNCTION track_record_verify_guard();

COMMENT ON FUNCTION track_record_verify_guard() IS
  'db/485 + db/493 + db/500 + db/501 + db/516 + db/635. Nothing lands verified; a MATERIAL '
  'edit returns a row to pending. The address comparison is SEMANTIC (pilot_address_same_place) '
  'with a same-canonical-text short-circuit (db/516): a re-spelling of the same place OR a '
  'pure storage-shape reshape (bare string -> canonical object) is a repair, not a '
  'restatement. pillars_met is material in the withdrawal direction only. The ONE exemption '
  'is a NULL->value fill of llc_id while the transaction-local GUC '
  'pilot.track_record_entity_backfill is on. Since db/635 a drop that actually removed a '
  'standing verification writes a track_record_verification_dropped row on audit_log, naming '
  'the columns that moved and the statement that moved them; that write can never fail the '
  'statement it is recording.';
