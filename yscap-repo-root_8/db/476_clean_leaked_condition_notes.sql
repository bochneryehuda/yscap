-- Clean up LEAKED internal condition notes (owner-reported 2026-08-05).
--
-- The owner clicked "+ Add an internal note" on one file's condition, typed a
-- credit-card link, and it appeared on every file that has that condition. The
-- CURRENT code stores a note on the per-file checklist_items row and writes it by
-- primary key (WHERE id = <that one file's item>), so going forward a note can only
-- ever land on the one file it was typed on (locked by
-- scripts/test-condition-note-per-file-db.js). What this migration does is REMOVE
-- the leftover leaked copies an earlier version spread across files — the owner's
-- "we need to get this note removed and cleaned up."
--
-- THE LEAK SIGNATURE, and why it is safe to act on automatically: the SAME
-- human-typed note text (NOT an '[auto]' engine note) sitting VERBATIM on the same
-- condition template across >= 3 different files spanning >= 2 different borrowers.
-- A note a person genuinely writes for ONE file is essentially never character-for-
-- character identical across three files of two different borrowers — that only
-- happens when something copied it everywhere. A processor's own repeated note on a
-- single borrower's files (one borrower) is deliberately NOT touched.
--
-- Non-destructive by record: every cleared note's exact text is written to
-- audit_log first, so nothing is truly lost — it is removed from the conditions and
-- preserved in the trail. Idempotent: once cleared the notes are NULL, so a re-run
-- finds nothing.

DO $$
DECLARE
  g   RECORD;
  n   INTEGER := 0;
BEGIN
  -- Guard: audit_log must exist (it always does on a real DB; this keeps a bare
  -- schema-only test DB from failing the migration).
  IF to_regclass('public.audit_log') IS NULL THEN
    RAISE NOTICE 'clean-leaked-notes: audit_log missing, skipping';
    RETURN;
  END IF;

  FOR g IN
    SELECT ci.template_id,
           ci.notes AS note_text,
           count(DISTINCT ci.application_id)                     AS files,
           count(DISTINCT a.borrower_id)                         AS borrowers,
           array_agg(ci.id)                                      AS item_ids
      FROM checklist_items ci
      JOIN applications a ON a.id = ci.application_id
     WHERE ci.notes IS NOT NULL
       AND btrim(ci.notes) <> ''
       AND ci.notes NOT LIKE '[auto]%'          -- engine notes are per-file by design
       AND ci.template_id IS NOT NULL
     GROUP BY ci.template_id, ci.notes
    HAVING count(DISTINCT ci.application_id) >= 3
       AND count(DISTINCT a.borrower_id)     >= 2
  LOOP
    -- Record the exact leaked text on every affected file BEFORE clearing it.
    INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail, created_at)
    SELECT 'system', NULL, 'condition_note_leak_cleaned', 'checklist_item', ci.id,
           jsonb_build_object('note', ci.notes, 'application_id', ci.application_id,
                              'template_id', ci.template_id, 'files', g.files, 'borrowers', g.borrowers),
           now()
      FROM checklist_items ci
     WHERE ci.id = ANY(g.item_ids);

    UPDATE checklist_items
       SET notes = NULL, updated_at = now()
     WHERE id = ANY(g.item_ids);

    n := n + array_length(g.item_ids, 1);
    RAISE NOTICE 'clean-leaked-notes: cleared "%" from % files / % borrowers',
      left(g.note_text, 80), g.files, g.borrowers;
  END LOOP;

  IF n > 0 THEN
    RAISE NOTICE 'clean-leaked-notes: cleared % leaked note copy(ies) total (text preserved in audit_log)', n;
  END IF;
END $$;
