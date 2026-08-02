-- Title documents and the insurance binder + invoice HOLD CLEAR TO CLOSE
-- (owner-directed 2026-08-02, in the owner's own words: "Insurance (binder +
-- invoice) — it's not before funding, it's before clear to close. I don't know
-- why you put that in a different section. Look for the bug. Title documents —
-- is also before CTC").
--
-- WHAT WAS WRONG
-- `advancementBlockers` (src/routes/staff.js) drops a checklist condition out of
-- the clear-to-close gate when its effective category is one of the CLOSING-STAGE
-- categories (prior_to_closing / prior_to_funding / at_closing / post_closing).
-- Both of these conditions were seeded 'prior_to_closing' by db/051, so the file's
-- work list showed them under "before funding" and a file could reach Clear to
-- Close with no title work and no insurance on the property.
--
-- The giveaway that this is a BUG and not a policy is inside the app itself:
-- db/378 seeded the FLOOD insurance condition as 'prior_to_docs', so PILOT already
-- refused to clear a file to close without a flood policy while letting the
-- ordinary hazard binder ride past. Two insurance conditions, two different
-- stages, for no stated reason. This settles them on the earlier one.
--
-- WHY 'prior_to_docs' AND NOT A CODE CHANGE
-- Removing 'prior_to_closing' from CLOSING_STAGE_CATEGORIES wholesale would ALSO
-- pull in the settlement statement (db/215) and the investor structure printout
-- (db/056) — documents that are PRODUCED at the closing table and cannot possibly
-- exist before a file is cleared to close. That would block every file forever.
-- So the fix moves the two conditions the owner named onto the stage that
-- describes them ('prior_to_docs' — needed before closing documents are drawn,
-- which is the industry's own name for a title commitment and an insurance
-- binder) and leaves the genuinely at-closing documents where they are. The
-- Heter Iska (db/051) is deliberately untouched — the owner did not name it and
-- it is signed as part of the closing package.
--
-- PREVIOUS AND FUTURE. checklist_items COPY the template's category at creation
-- (conditions/engine.js insertFromTemplate, db/378's own backfill), so the
-- template change alone would only reach new files. Both tables are updated,
-- each guarded on the exact prior value so a category a human deliberately set
-- to something else is never overwritten, and so re-running on every boot is a
-- no-op.
--
-- This changes NO required flag and NO frozen number. Title and insurance already
-- hard-blocked FUNDING; they now also hold clear-to-close. A file already sitting
-- at clear_to_close or funded keeps its status — the gate is only consulted when a
-- file is advanced.

UPDATE checklist_templates
   SET category = 'prior_to_docs'
 WHERE code IN ('rtl_cond_insurance', 'rtl_cond_title', 'title_commitment')
   AND category = 'prior_to_closing';

-- Existing files. Only a row that still carries the inherited 'prior_to_closing'
-- is moved; a NULL category already inherits the template and needs no write.
UPDATE checklist_items ci
   SET category = 'prior_to_docs'
  FROM checklist_templates t
 WHERE t.id = ci.template_id
   AND t.code IN ('rtl_cond_insurance', 'rtl_cond_title', 'title_commitment')
   AND ci.category = 'prior_to_closing';
