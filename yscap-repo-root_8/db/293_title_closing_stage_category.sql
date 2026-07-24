-- Title is a CLOSING-STAGE condition — it must not hold clear-to-close (IG-W8,
-- owner-directed 2026-07-24: "Title & Tax — push to closing, do NOT hold CTC").
--
-- The clear-to-close gate (src/routes/staff.js advancementBlockers) now excludes
-- checklist conditions whose category is a closing/funding-stage category
-- (prior_to_closing / prior_to_funding / at_closing / post_closing) — they still
-- HARD-block funding, just not clear-to-close. The RTL title condition (rtl_cond_title)
-- is already category 'prior_to_closing', so it is covered.
--
-- The LEGACY V1 title template `title_commitment` (db/002, pre-RTL-workflow) has a NULL
-- category, so it would still wrongly hold clear-to-close on any file that carries it.
-- Reclassify it to the same closing stage so the whole "title" class behaves
-- consistently — a title commitment is, by definition, a closing-stage document. This
-- is idempotent and touches ONLY the category (it never changes a required flag, so
-- title still blocks funding). Applies to previous AND future files (the CTC gate reads
-- the category live — no per-file backfill needed).

UPDATE checklist_templates
   SET category = 'prior_to_closing'
 WHERE code = 'title_commitment'
   AND (category IS NULL OR category = '');

-- Belt-and-suspenders: any checklist_item that carries a per-item category override of
-- NULL/'' inherits the template category (the gate COALESCEs item→template), so no item
-- backfill is required. If a title_commitment item ever stored an explicit non-closing
-- category, it stays as the human set it — we never overwrite an explicit override.
