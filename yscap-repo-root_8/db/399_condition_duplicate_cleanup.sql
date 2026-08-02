-- ============================================================================
-- 399 — Duplicate conditions: clean up the ones already created, and add the
--       structural guard so they cannot come back.
--       Owner-reported 2026-08-02: "check if there is more than one EMD
--       condition on a file … maybe on certain files if there's any potentials
--       we can get more than 1 EMD condition."
--
-- THERE ARE, AND IT WAS REPRODUCED. `conditions/engine.js` suppresses duplicates
-- by READING the file's existing items, deciding a template has no instance, and
-- THEN inserting — with nothing in between and no unique constraint underneath.
-- Two passes running at the same instant both read "not there" and both insert.
-- Measured: two concurrent evaluateApplication calls on one CorrFirst file →
-- TWO EMD rows and TWO SSN rows; sequential → one each.
--
-- It is ordinary traffic, not a freak case: evaluateApplication runs from the
-- staff completeness save, the details PATCH, the borrower edit, the ClickUp
-- inbound ingest, the file-view sync and the boot sweep — and the NOTE BUYER is
-- written from both the portal and ClickUp, so "a staffer saves the note buyer
-- while that card's webhook lands" is exactly the shape. The class covers EVERY
-- rule-driven condition (flood, assignment, condo, cash-out…), not just the
-- CorrFirst pair — the EMD condition is simply where it was noticed.
--
-- The live fix is the per-file advisory lock added to evaluateApplication in the
-- same change. This file handles the two things the lock cannot: the duplicates
-- ALREADY on files, and a structural backstop for any future insert path that
-- forgets to check.
--
-- (1) CLEAN UP — deliberately CONSERVATIVE. Only a duplicate that is provably
--     UNTOUCHED is removed: engine-owned ('auto'), still 'outstanding', never
--     signed off / reviewed / waived, no note, no tool payload, and nothing
--     hanging off it. That last part is the important one — deleting a
--     checklist item SET-NULLs its documents, credit reports, messages, linked
--     conditions and AI suggestions, and CASCADE-DELETES its e-sign envelopes
--     and clearance proofs. An untouched row has none of those, and each is
--     re-checked here anyway rather than assumed. A duplicate where the second
--     copy HAS been worked is LEFT ALONE for a human — picking a winner there
--     would silently discard somebody's work.
--
--     The keeper is the copy with work on it, else the oldest. Idempotent: a
--     re-run finds nothing. Audited per row, so the deletion is not only in a log
--     line that scrolls away.
--
-- (2) THE GUARD — a partial unique index on
--     (application_id, template_id, COALESCE(field_key,'')).
--     The key is NOT (application_id, template_id): the co-borrower CREDIT
--     condition deliberately puts a SECOND row of the same `rtl_cond_credit`
--     template on one file, told apart only by field_key (credit/co-condition.js),
--     and the draw conditions do the same with a draw marker. Including field_key
--     keeps every one of those legal and blocks only a true duplicate. Rows with
--     no template (a hand-typed condition, raise-issue.js, the co-borrower gov-ID)
--     are outside the index entirely.
--
--     It is created inside an exception handler ON PURPOSE. If a file still has a
--     duplicate whose copies have BOTH been worked, step 1 correctly refused to
--     touch it, and a bare CREATE UNIQUE INDEX would then throw — which at boot
--     means the whole service does not start. So a failure raises a NOTICE and
--     the boot continues on the advisory lock alone; the next boot tries again,
--     so the guard appears on its own once a human resolves the leftover. Never
--     replace this with an unguarded CREATE.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) Remove provably-untouched duplicates.
-- ---------------------------------------------------------------------------
WITH ranked AS (
  SELECT ci.id,
         ci.application_id,
         ci.template_id,
         row_number() OVER (
           PARTITION BY ci.application_id, ci.template_id, COALESCE(ci.field_key, '')
           -- Keep the copy somebody has WORKED; among equals, the oldest.
           ORDER BY (ci.status <> 'outstanding'
                     OR ci.signed_off_at IS NOT NULL
                     OR ci.reviewed_at IS NOT NULL
                     OR ci.waived_at IS NOT NULL
                     OR ci.notes IS NOT NULL
                     OR ci.tool_payload IS NOT NULL) DESC,
                    ci.created_at ASC, ci.id ASC) AS rn
    FROM checklist_items ci
   WHERE ci.application_id IS NOT NULL
     AND ci.template_id IS NOT NULL
),
doomed AS (
  SELECT ci.id, ci.application_id, ci.template_id, ci.label
    FROM checklist_items ci
    JOIN ranked r ON r.id = ci.id AND r.rn > 1
   WHERE ci.origin_kind = 'auto'
     AND ci.status = 'outstanding'
     AND ci.signed_off_at IS NULL
     AND ci.reviewed_at  IS NULL
     AND ci.waived_at    IS NULL
     AND ci.notes        IS NULL
     AND ci.tool_payload IS NULL
     -- nothing may be orphaned or cascade-deleted by removing it
     AND NOT EXISTS (SELECT 1 FROM documents                  x WHERE x.checklist_item_id = ci.id)
     AND NOT EXISTS (SELECT 1 FROM esign_envelopes            x WHERE x.checklist_item_id = ci.id)
     AND NOT EXISTS (SELECT 1 FROM esign_envelope_docs        x WHERE x.checklist_item_id = ci.id)
     AND NOT EXISTS (SELECT 1 FROM condition_clearance_proofs x WHERE x.checklist_item_id = ci.id)
     AND NOT EXISTS (SELECT 1 FROM credit_reports            x WHERE x.checklist_item_id = ci.id)
     AND NOT EXISTS (SELECT 1 FROM messages                  x WHERE x.checklist_item_id = ci.id)
     AND NOT EXISTS (SELECT 1 FROM conditions                x WHERE x.checklist_item_id = ci.id)
     AND NOT EXISTS (SELECT 1 FROM ai_suggestions            x WHERE x.checklist_item_id = ci.id
                                                                 OR x.linked_condition_id = ci.id)
     AND NOT EXISTS (SELECT 1 FROM encompass_flood_orders    x WHERE x.checklist_item_id = ci.id)
     AND NOT EXISTS (SELECT 1 FROM draw_wire_instructions    x WHERE x.operating_agreement_item_id = ci.id)
),
logged AS (
  INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
  SELECT 'system', NULL, 'condition_duplicate_removed', 'application', d.application_id,
         jsonb_build_object('checklistItemId', d.id, 'templateId', d.template_id,
                            'label', d.label, 'reason', 'db/399 duplicate cleanup')
    FROM doomed d
  RETURNING 1
)
DELETE FROM checklist_items ci USING doomed d WHERE ci.id = d.id;

-- ---------------------------------------------------------------------------
-- (2) The structural guard. Guarded so a leftover worked-duplicate can never
--     stop the service booting (see the header — do not un-guard this).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS checklist_items_one_per_template_uk
      ON checklist_items (application_id, template_id, COALESCE(field_key, ''))
      WHERE application_id IS NOT NULL AND template_id IS NOT NULL;
  EXCEPTION WHEN unique_violation OR duplicate_table THEN
    RAISE NOTICE '[399] duplicate conditions remain whose copies have BOTH been worked — '
                 'the unique guard was not created this boot. The per-file advisory lock in '
                 'conditions/engine.js still prevents new ones. Resolve the leftovers by hand '
                 '(audit action condition_duplicate_removed lists what was auto-cleaned) and '
                 'the guard will be created on the next boot.';
  END;
END $$;
