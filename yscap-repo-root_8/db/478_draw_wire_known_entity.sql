-- ============================================================================
-- 478 — Draw-wire name check: recognize a KNOWN entity of the borrower
--       (owner-directed 2026-08-06). The wire "new entity" fatal (db/206) cleared
--       an account name only when it was the borrower's personal name OR the file's
--       LINKED vesting entity (applications.llc_id). But a file's own vesting entity
--       is very often on the borrower's ENTITY LIBRARY (llcs) without ever being the
--       linked a.llc_id — e.g. it arrived from the ClickUp sync, or the link was
--       never set. So a draw wire to the file's OWN LLC was flagged a fatal "new
--       entity" (owner report: "69 Bassett LLC … this is the LLC the file was taking
--       on. This is a bug.").
--
--       The classifier (src/lib/esign/draw-wire.js) now also clears an account name
--       that matches ANY entity already on the borrower's / co-borrower's profile —
--       an entity the file's borrower is already associated with is not an unknown
--       third party. It is recorded with the new name_kind 'known_entity' so the
--       audit trail distinguishes it from the file's explicitly-linked subject LLC.
--       A name that matches NOTHING on the borrower's profile still escalates fatal.
--
--       Schema-only: widen the name_kind CHECK to admit 'known_entity'. Idempotent.
-- ============================================================================

DO $$ BEGIN
  ALTER TABLE draw_wire_instructions DROP CONSTRAINT IF EXISTS draw_wire_instructions_name_kind_check;
  ALTER TABLE draw_wire_instructions ADD CONSTRAINT draw_wire_instructions_name_kind_check CHECK (
    name_kind IS NULL OR name_kind IN
      ('borrower_personal','subject_llc','known_entity','new_entity','unknown'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
