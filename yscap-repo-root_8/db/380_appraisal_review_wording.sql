-- 380 — Make the internal appraisal-review task FINDABLE, and say what clears it.
--
-- Owner-reported 2026-07-30: on a file with no appraisal XML the term sheet will
-- not generate because it "waits for appraisal review to be signed off" — but
-- "I don't see a condition for appraisal review … to sign off."
--
-- The condition IS there — rtl_p3_apprreview, the internal appraisal-review
-- sign-off, on every RTL file (db/056). It is what the term-sheet send gate
-- (src/lib/esign/gate.js) blocks on. It was invisible for two reasons, both in
-- its wording:
--   • its label read "Appraisal review cleared (CoreFirst files)" — a note-buyer
--     name from a program that is long gone, so on any other file it reads as
--     "not mine", and the owner could not connect it to the appraisal review the
--     term sheet was waiting on;
--   • it had NO hint at all, so nothing on the row said what clears it — least of
--     all the no-XML path (record "No XML available", type the As-Is + ARV by
--     hand), which is exactly the situation the owner was stuck in.
--
-- Renamed to "Appraisal review — internal sign-off" (findable, and distinct from
-- the findings-gated 'Appraisal review cleared (all PILOT findings resolved)'
-- condition, appraisal_review_cleared, which governs on a file that HAS an
-- imported appraisal). The hint now names the no-XML path in as many words.
--
-- WORDING ONLY. The code (rtl_p3_apprreview — the send gate, the esign exception
-- waiver list db/289, and the section map are all keyed on it), audience
-- ('staff' — never borrower-facing), item_kind, is_gate/is_milestone/is_required,
-- phase and sort order are all untouched.
--
-- PREVIOUS AND FUTURE: checklist_items.label/.hint are COPIED from the template at
-- creation, so both tables are updated. Idempotent — every statement is guarded on
-- the exact old text (or a NULL hint), so a re-run (every boot) matches nothing
-- once applied and a label/hint a human edited by hand is never overwritten.

UPDATE checklist_templates SET label = 'Appraisal review — internal sign-off', updated_at = now()
 WHERE code = 'rtl_p3_apprreview' AND label = 'Appraisal review cleared (CoreFirst files)';
UPDATE checklist_items ci SET label = 'Appraisal review — internal sign-off', updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id AND t.code = 'rtl_p3_apprreview'
   AND ci.label = 'Appraisal review cleared (CoreFirst files)';

UPDATE checklist_templates SET
       hint = 'Sign this off once the appraisal has been reviewed — this is what the term sheet waits on. On a file with an appraisal in PILOT, the "Appraisal review cleared (all PILOT findings resolved)" condition covers it. If there is NO appraisal XML, use "No XML available" to enter the As-Is and ARV by hand — that stands in for the review and lets the term sheet go out.',
       updated_at = now()
 WHERE code = 'rtl_p3_apprreview' AND hint IS NULL;
UPDATE checklist_items ci SET
       hint = 'Sign this off once the appraisal has been reviewed — this is what the term sheet waits on. On a file with an appraisal in PILOT, the "Appraisal review cleared (all PILOT findings resolved)" condition covers it. If there is NO appraisal XML, use "No XML available" to enter the As-Is and ARV by hand — that stands in for the review and lets the term sheet go out.',
       updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id AND t.code = 'rtl_p3_apprreview'
   AND ci.hint IS NULL;
