-- ============================================================================
-- 399 — Duplicate conditions: clean up the ones already created.
--       (The live fix is the per-file advisory lock in conditions/engine.js.)
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
-- same change. This file handles the one thing the lock cannot: the duplicates
-- ALREADY on files from before it existed.
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
-- (2) NO UNIQUE INDEX — a deliberate decision, recorded so nobody re-adds one
--     without knowing what it costs. A partial unique index on
--     (application_id, template_id, COALESCE(field_key,'')) was built, tested and
--     then REMOVED. It was correct about production: every real insert path
--     already enforces one-row-per-(file, template) on its own — closing.js,
--     vesting.js, appraisal/desk.js and underwriting.js all carry
--     NOT EXISTS (... application_id AND template_id); the engine is guarded;
--     co-condition.js and esign/draw-wire.js carry a distinct field_key; and
--     staff.js's hand-typed conditions, borrower.js, staff-chat.js and
--     raise-issue.js insert no template_id at all.
--
--     What it was NOT correct about is the TEST SUITE. Instantiating one template
--     twice on one file is a widespread fixture idiom — a cheap way to get two
--     independent conditions to work on — and the index turned every one of those
--     into a hard failure. Three suites broke before this was abandoned
--     (notification-doc-verdict-dedup, condition-admin-override-db,
--     evidence-reopen) and ~45 more instantiate templates in ways the scan could
--     not clear. Fixing them means editing unrelated suites to add synthetic
--     field_keys — which risks changing what those suites actually assert, and the
--     safety net is worth more than a second layer under a lock that already
--     closes the hole. The two suites already edited were reverted to exactly as
--     their authors wrote them.
--
--     So the guarantee is the ADVISORY LOCK plus the per-path NOT EXISTS checks
--     that were always there. If a future unguarded insert path is ever added,
--     the fix is to guard that path — not to add an index the tests cannot live
--     with.
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
