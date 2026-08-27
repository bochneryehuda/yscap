-- ============================================================================
-- db/636 — A VERIFICATION SURVIVES A WRITER THAT CHANGES NOTHING IT WAS MADE
--          AGAINST, AND EVERY VERIFICATION RECORDS WHAT IT WAS MADE AGAINST.
--
-- THE ROOT CAUSE THIS CLOSES (file YSCAP258134794, borrower Leib Lichtman).
-- db/635 established that the verify guard drops verifications silently and
-- made it leave a trace. That is the DIAGNOSIS, not the cure: it tells you a
-- line fell out, after the investor package has already gone.
--
-- The cure is to stop the drop happening for a reason nobody chose. db/485
-- compares NEW to OLD, which answers "did this statement change something" —
-- and that is the wrong question. Two writers that disagree about one material
-- column un-verify a line on every pass: writer A moves a date, the guard drops
-- the verification (correct — the row no longer matches the review), writer B
-- moves it back, and the guard drops it AGAIN. The row ends up byte-identical
-- to what a named human approved, its verification is gone, and no human made
-- a single edit. On 2026-08-26 a line verified at 20:25:07 was unverified by
-- 20:43:39 with no `unverify_track_record` row anywhere, and today that row
-- still holds the exact dates it was verified with — the signature of exactly
-- this flip-flop.
--
-- THE RIGHT QUESTION is whether the row still holds the values a human
-- approved. Nothing could ask it, because nothing recorded them. So:
--
--   1. `track_record_verifications` records, at the moment of every
--      verification, WHO verified, WHEN, and the row's material values.
--   2. The guard compares NEW against that SNAPSHOT instead of dropping on any
--      difference from OLD. Identical -> the verification stands, and if an
--      earlier pass already dropped it, it is PUT BACK (audited). Different ->
--      it drops exactly as db/485 always has, with db/635's trace.
--
-- CONSEQUENCE, which is the owner's ask of 2026-08-27 ("make sure that if the
-- property is verified, it's being exported"): a line a human verified and
-- nobody materially changed is verified, so the verified-only export carries
-- it. The export's own predicate is untouched — this makes the flag TRUE
-- rather than teaching the document to second-guess it.
--
-- WHAT THIS IS NOT. It cannot invent a verification: it restores only one that
-- genuinely happened, only to the person and moment it happened at, and only
-- while EVERY material value matches. A real edit still un-verifies. db/485's
-- material list, db/493's re-spelling exemption, db/500's pillar rule, db/501's
-- entity-backfill GUC and db/516's storage-shape repair are all preserved
-- byte-for-byte — this file is db/635's guard extracted programmatically with
-- the comparison wrapped around its existing drop block.
--
-- Numbered above db/635 so this definition wins on every boot (db/485, 493,
-- 500, 501, 516 and 635 each re-create this function every deploy — the
-- db/334 -> db/375 ordering mechanism).
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE, DROP/CREATE
-- TRIGGER, and a seed guarded by NOT EXISTS.
-- PRODUCT SEPARATION: `track_records`, `track_record_verifications` and
-- `audit_log` are RTL objects; nothing here names an `lt_*` object.
-- ============================================================================

-- ── 1. WHAT A HUMAN ACTUALLY VERIFIED ───────────────────────────────────────
-- Append-only. A row is never updated: each verification is its own historical
-- fact, and the guard reads the latest. `material` is the row's own jsonb minus
-- the guard's outputs, so a column added to track_records is included with no
-- second list to keep in step.
CREATE TABLE IF NOT EXISTS track_record_verifications (
  id                  bigserial PRIMARY KEY,
  track_record_id     uuid NOT NULL REFERENCES track_records(id) ON DELETE CASCADE,
  verified_by         uuid,
  verified_at         timestamptz NOT NULL DEFAULT now(),
  verification_status text,
  material            jsonb NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
-- The guard's read: latest verification for one line, on every material write.
CREATE INDEX IF NOT EXISTS idx_trv_line_latest
  ON track_record_verifications (track_record_id, verified_at DESC, id DESC);

COMMENT ON TABLE track_record_verifications IS
  'db/636. One row per verification of a track-record line: who, when, and the '
  'material values it was made against. Append-only. Read by track_record_verify_guard() '
  'to tell a row that genuinely changed since review from one that two writers moved and '
  'moved back.';

CREATE OR REPLACE FUNCTION track_record_verify_guard() RETURNS trigger AS $$
DECLARE
  addr_restated boolean;
  was_counting  boolean;   -- db/635: did this row's verification actually exist to lose?
  changed       jsonb;     -- db/635: what the statement moved, derived from the rows themselves
  snap          track_record_verifications%ROWTYPE;  -- db/636: what a human actually verified
  new_material  jsonb;   -- db/636: this row's material values, after this statement
  restored      boolean := false;  -- db/636: did we just put a verification back?
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
    /* ── db/636 — DOES THIS STATEMENT ACTUALLY DIFFER FROM WHAT A HUMAN VERIFIED? ──
       Everything above compares NEW to OLD, which answers "did this statement
       change something". That is the wrong question to un-verify on, and it is
       the defect this file exists to close: two writers that disagree about one
       material column un-verify the line on EVERY pass — writer A moves it,
       writer B moves it back — and the row ends up byte-identical to what the
       reviewer approved while the verification is gone. Nobody edited anything;
       the line simply stops being delivered.

       The right question is whether the row still holds the values a NAMED
       HUMAN approved, so that is what is asked here. The comparison is against
       the snapshot recorded at the moment of verification (below), never against
       a guess, and it is the COMPLEMENT of the guard's own outputs rather than a
       second copy of the material list: a column added to the condition above is
       automatically part of the snapshot, so it can only ever make a restore
       HARDER. A hand-kept list here could silently make one EASIER, which is the
       one direction that must never happen. */
    new_material := to_jsonb(NEW) - 'is_verified' - 'verified_at' - 'verified_by'
                                  - 'verification_status' - 'updated_at';
    SELECT * INTO snap
      FROM track_record_verifications v
     WHERE v.track_record_id = NEW.id
     ORDER BY v.verified_at DESC, v.id DESC
     LIMIT 1;

    IF snap.track_record_id IS NOT NULL AND snap.material = new_material THEN
      /* The row holds exactly what was approved. There is nothing to re-review,
         so the verification stands — and if an earlier pass had already dropped
         it, it is PUT BACK. Restoring is never silent: it is audited on the same
         terms as the drop. It can restore only a verification that genuinely
         happened, only to the person and moment it happened at, and only while
         every material value matches; it can never invent one. */
      restored := NOT COALESCE(OLD.is_verified, false);
      NEW.is_verified         := true;
      NEW.verified_at         := snap.verified_at;
      NEW.verified_by         := snap.verified_by;
      NEW.verification_status := snap.verification_status;

      IF restored THEN
        BEGIN
          INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
          VALUES ('system', NULL, 'track_record_verification_restored', 'track_record', NEW.id,
                  jsonb_build_object(
                    'borrowerId', NEW.borrower_id,
                    'verifiedBy', snap.verified_by,
                    'verifiedAt', snap.verified_at,
                    'statement',  left(current_query(), 300)));
        EXCEPTION WHEN OTHERS THEN
          NULL;   -- the trace may never cost the write (db/635's rule)
        END;
      END IF;
    ELSE
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
  END IF;

  /* ── db/636 — A VERIFICATION RECORDS THE VALUES IT WAS MADE AGAINST ──────────
     Every door that verifies a line does it with an UPDATE on this table, so
     this is the ONE place that sees them all — the staff verify route, an
     admin override, a bulk correction, and any door written next year. Without
     the snapshot the question "is this row still what was approved?" has no
     answer at all, which is why a dropped verification could not be told apart
     from a line nobody ever reviewed. Skipped when we just restored: that
     verification is already on file and re-recording it would say a human acted
     when no human did. */
  IF COALESCE(NEW.is_verified, false)
     AND NOT restored
     AND NOT COALESCE(OLD.is_verified, false) THEN
    BEGIN
      INSERT INTO track_record_verifications
             (track_record_id, verified_by, verified_at, verification_status, material)
      VALUES (NEW.id, NEW.verified_by, COALESCE(NEW.verified_at, now()),
              NEW.verification_status,
              to_jsonb(NEW) - 'is_verified' - 'verified_at' - 'verified_by'
                            - 'verification_status' - 'updated_at');
    EXCEPTION WHEN OTHERS THEN
      NULL;   -- recording the snapshot may never cost the verification itself
    END;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_track_record_verify_guard ON track_records;
CREATE TRIGGER trg_track_record_verify_guard
  BEFORE INSERT OR UPDATE ON track_records
  FOR EACH ROW EXECUTE FUNCTION track_record_verify_guard();

COMMENT ON FUNCTION track_record_verify_guard() IS
  'db/485 + db/493 + db/500 + db/501 + db/516 + db/635 + db/636. Nothing lands verified. '
  'A material edit returns a row to pending — but only when the row actually differs from '
  'the values a human VERIFIED (db/636, track_record_verifications), not merely from the '
  'previous statement: two writers that move a column and move it back no longer destroy a '
  'verification between them, and one already dropped that way is restored and audited. '
  'The address comparison is SEMANTIC (pilot_address_same_place) with a same-canonical-text '
  'short-circuit (db/516). pillars_met is material in the withdrawal direction only. The ONE '
  'exemption is a NULL->value fill of llc_id while the transaction-local GUC '
  'pilot.track_record_entity_backfill is on. A drop that removed a standing verification '
  'writes track_record_verification_dropped on audit_log (db/635); a restore writes '
  'track_record_verification_restored. Neither can fail the statement it is recording.';

-- ── 3. THE BOOK THAT IS ALREADY VERIFIED ────────────────────────────────────
-- A line verified before this file existed has no snapshot, so the guard would
-- read it as "never verified" and keep dropping it exactly as before. Its
-- CURRENT values ARE the values it was verified against — that is what being
-- verified means — so they are recorded as its snapshot, attributed to the
-- person and moment already stored on the row.
--
-- SEED ONLY, NEVER A RESTORE. Nothing here sets is_verified on any row: a line
-- that is currently unverified stays unverified, because we cannot know what it
-- looked like when it was last verified and guessing would hand back a
-- verification a human may have deliberately revoked. The go-forward mechanism
-- earns every restore from a snapshot it recorded itself.
--
-- Guarded by NOT EXISTS so a re-run on the next boot is a no-op rather than a
-- second snapshot per line.
--
-- A GENERATED COLUMN IS NULL INSIDE A BEFORE TRIGGER, so the seed must record it
-- the way the guard will later READ it or no seeded snapshot could ever match and
-- the whole back book would keep losing verifications exactly as before.
-- `track_records` has two (`counts_from`, `hold_days`), both pure functions of the
-- material columns beside them, so agreeing to see them as NULL loses nothing.
-- The list is asked of the CATALOG rather than typed here: a generated column
-- added later is covered without anybody remembering this file.
INSERT INTO track_record_verifications
       (track_record_id, verified_by, verified_at, verification_status, material)
SELECT t.id, t.verified_by, COALESCE(t.verified_at, now()), t.verification_status,
       (to_jsonb(t) - 'is_verified' - 'verified_at' - 'verified_by'
                    - 'verification_status' - 'updated_at')
       || COALESCE((SELECT jsonb_object_agg(c.column_name, 'null'::jsonb)
                      FROM information_schema.columns c
                     WHERE c.table_schema = 'public'
                       AND c.table_name   = 'track_records'
                       AND c.is_generated = 'ALWAYS'), '{}'::jsonb)
  FROM track_records t
 WHERE t.is_verified = true
   AND NOT EXISTS (SELECT 1 FROM track_record_verifications v WHERE v.track_record_id = t.id);
