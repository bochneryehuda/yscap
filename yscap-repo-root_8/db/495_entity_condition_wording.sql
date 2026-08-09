-- 495_entity_condition_wording.sql — THE CONDITION IS ABOUT AN ENTITY, NOT AN LLC
-- (owner-directed 2026-08-09: "everywhere I shouldn't say LLC, say entity …
-- we have three tables for conditions — all conditions, on the right, conditions
-- that we have — LLC, that also should be changed to be called entity").
--
-- The vesting-entity condition `rtl_p1_llc` has said "LLC" on its face since
-- db/005, on every one of the three condition lists the owner named: the file's
-- "All conditions" list, the per-phase list beside it, and the borrower's own
-- to-do list. It is now reachable by a corporation, a partnership or a trust —
-- and telling one of those to upload "your LLC's operating agreement" asks for a
-- document that does not exist.
--
-- ORDERING IS THE MECHANISM, and it is the whole reason this file is numbered
-- where it is. THREE earlier migrations re-assert this condition's wording on
-- EVERY boot and are never edited:
--
--   · db/012 sets label + borrower_label to 'LLC verification'
--   · db/033 sets label 'LLC — entity, ownership & documents' and
--            borrower_label 'Your LLC (vesting entity)'
--   · db/057 sets the staff label 'LLC (vesting entity) — verify entity, …'
--
-- Each of those is guarded on its own exact prior text, so on a normal boot they
-- find the value they already wrote and do nothing — but on the FIRST boot after
-- this file lands, and on any boot where somebody has reverted a row, they will
-- fire. This file runs LAST and re-asserts the converged state, exactly the way
-- db/374 re-asserts the flood certificate over db/177…db/337. Do NOT renumber it
-- below any of those three.
--
-- THE CODE DOES NOT MOVE. `rtl_p1_llc` is what `llc.syncLlcConditions`,
-- `vesting.ensureLlcCondition`, `advancementBlockers`, `condition-subjects.js`
-- and the ClickUp field map are all keyed on. This is WORDING ONLY — audience,
-- item_kind, is_gate, phase and sort order are untouched.
--
-- PREVIOUS AND FUTURE. `checklist_items` COPY the wording from the template at
-- creation (the repo's long-standing pattern), so both tables are updated; each
-- statement is guarded on the exact prior text so a label somebody edited by hand
-- survives this and every future boot.

-- ─────────────────────────── the template ───────────────────────────

UPDATE checklist_templates
   SET label = 'Vesting entity — entity, ownership & documents',
       hint = 'Fulfilled by the linked entity on the borrower profile: a verified entity satisfies it automatically; otherwise the borrower completes ownership and its three documents there. What the third document is depends on the entity type — an operating agreement for an LLC, bylaws and a stock certificate for a corporation.'
 WHERE code = 'rtl_p1_llc'
   AND label IN ('LLC verification',
                 'LLC — entity, ownership & documents',
                 'LLC (vesting entity) — verify entity, ownership & the three documents',
                 'LLC documents received');

UPDATE checklist_templates
   SET borrower_label = 'Your vesting entity',
       borrower_hint  = 'Link the entity taking title, complete its ownership details, and upload its three documents — done once, reused on every loan'
 WHERE code = 'rtl_p1_llc'
   AND borrower_label IN ('LLC verification', 'Your LLC (vesting entity)', 'LLC documents received');

-- ──────────────────────── the items on live files ────────────────────────
-- Guarded on the same prior texts, so a hand-edited row is never rewritten.

UPDATE checklist_items ci
   SET label = t.label, hint = t.hint, updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id AND t.code = 'rtl_p1_llc'
   AND ci.label IN ('LLC verification',
                    'LLC — entity, ownership & documents',
                    'LLC (vesting entity) — verify entity, ownership & the three documents',
                    'LLC documents received')
   AND ci.label IS DISTINCT FROM t.label;

UPDATE checklist_items ci
   SET borrower_label = t.borrower_label, borrower_hint = t.borrower_hint, updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id AND t.code = 'rtl_p1_llc'
   AND ci.borrower_label IN ('LLC verification', 'Your LLC (vesting entity)', 'LLC documents received')
   AND ci.borrower_label IS DISTINCT FROM t.borrower_label;

-- ───────────────── the entity-documents bank-account condition ─────────────────
-- `rtl_cond_entity_docs` was already type-neutral in its LABEL and db/494 made
-- its HINTS type-neutral too. Nothing to do here — recorded so the next person
-- does not go looking for it. db/400 re-asserts that label every boot, which is
-- why it is left alone (the trap db/191/db/398 documents).
