-- 367 — The two Phase-5 gates are the INVESTOR's answer, and now they say so.
--
-- Owner-directed 2026-07-29, reading the conditions list on a live file:
-- "Final review requested / CTC — Clear to Close received … this is stuff that
-- needs to come from the investor."
--
-- They are right, and the old wording said the opposite on both rows:
--
--   • 'Final review requested' -> 'Investor final review'. "Requested" names OUR
--     action — sending the file out — which is done the moment somebody clicks
--     send. What the row actually holds the file on is the investor's answer
--     coming BACK. A gate named after our half reads as satisfied while the
--     thing it gates has not happened, which is precisely the confusion the
--     owner reported. Same rule db/363 applied to 'Appraisal documents
--     received': the row is the SLOT, and its state lives in the status column.
--
--   • 'CTC — Clear to Close received' -> 'Investor Clear to Close (CTC)'. Three
--     problems in one label: it led with an abbreviation nobody outside the team
--     reads cold, it then spelled that same abbreviation out (the label said
--     "CTC" twice), and "received" restated the status again. It also never said
--     WHO issues it — and that is the whole point of the row. PILOT does not
--     issue a Clear to Close; the investor does, and this condition is where
--     their written CTC lands. "CTC" is kept in parentheses because the team
--     says CTC out loud and searches for it.
--
-- Both now lead with "Investor", so the two steps that wait on the same outside
-- party read as a pair in the Closing group instead of as two unrelated rows.
--
-- The HINTS carry the instruction, which is where every other condition here
-- keeps one, and each states the thing the owner asked for in as many words:
-- the answer comes from the investor, not from us.
--
-- NOT CHANGED, deliberately: the codes (rtl_f_review / rtl_f_ctc — every gate,
-- subject-group and blueprint reference is keyed on those), audience ('staff' —
-- these never reach a borrower, so there is no borrower_label/borrower_hint to
-- move), is_gate/is_milestone, phase and sort order. Wording only.
--
-- NOT TOUCHED: the free-text `conditions` table. Nothing seeds these two codes
-- into it (its only writers are product registration and a staff-typed
-- condition), so a title matching this text there is a human's own row.
--
-- PREVIOUS AND FUTURE FILES. checklist_items.label and .hint are COPIED from the
-- template at creation (db/095 and every seeder), not joined at read time, so a
-- template-only rename would leave every existing file reading the old words.
-- Both tables are updated.
--
-- Idempotent: every statement is guarded on the exact old text, so a re-run
-- (every boot) matches nothing once applied, and a label or hint a human has
-- since edited by hand is never overwritten.

-- 1. Investor final review --------------------------------------------------
UPDATE checklist_templates SET label = 'Investor final review', updated_at = now()
 WHERE code = 'rtl_f_review' AND label = 'Final review requested';
UPDATE checklist_items ci SET label = 'Investor final review', updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id AND t.code = 'rtl_f_review'
   AND ci.label = 'Final review requested';

UPDATE checklist_templates SET
       hint = 'The investor reviews the full file. Clear this when their approval comes back — not when we send it. Last step before their CTC.',
       updated_at = now()
 WHERE code = 'rtl_f_review' AND hint = 'Last approval step before CTC';
UPDATE checklist_items ci SET
       hint = 'The investor reviews the full file. Clear this when their approval comes back — not when we send it. Last step before their CTC.',
       updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id AND t.code = 'rtl_f_review'
   AND ci.hint = 'Last approval step before CTC';

-- 2. Investor Clear to Close (CTC) ------------------------------------------
UPDATE checklist_templates SET label = 'Investor Clear to Close (CTC)', updated_at = now()
 WHERE code = 'rtl_f_ctc' AND label = 'CTC — Clear to Close received';
UPDATE checklist_items ci SET label = 'Investor Clear to Close (CTC)', updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id AND t.code = 'rtl_f_ctc'
   AND ci.label = 'CTC — Clear to Close received';

-- This row was seeded with no hint at all (db/005), which is how it came to say
-- nothing about who issues the CTC. Filled only where it is still empty, so a
-- hint anyone has written since is kept.
UPDATE checklist_templates SET
       hint = 'The Clear to Close is issued BY the investor. Clear this only when their written CTC is on the file — PILOT never issues one.',
       updated_at = now()
 WHERE code = 'rtl_f_ctc' AND hint IS NULL;
UPDATE checklist_items ci SET
       hint = 'The Clear to Close is issued BY the investor. Clear this only when their written CTC is on the file — PILOT never issues one.',
       updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id AND t.code = 'rtl_f_ctc'
   AND ci.hint IS NULL;
