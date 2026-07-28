-- 350 — Condition wording the owner corrected on 2026-07-27, on previous files too.
--
-- Three renames, each because the stored label says more (or less) than the
-- thing actually is:
--
--   • 'ISKA' -> 'Heter Iska'. The document's real name. "ISKA" is an
--     abbreviation staff have to translate in their head, and it appears on a
--     borrower-facing condition.
--
--   • 'Appraisal documents received' -> 'Appraisal documents'. The condition is
--     the SLOT the appraisal XML and PDF are uploaded into — it exists before
--     anything is received, so "received" describes a state the row is usually
--     not in. Owner: "the received word is extra."
--
--   • 'Loan number missing — enter the YS loan number' -> 'YS loan number'. The
--     row is rule-driven and only ever attaches while the number IS missing
--     (db/210, rule ys_loan_number is_empty), and it retracts itself the moment
--     one is entered — so "missing" restates the only reason it is on screen and
--     "enter the YS loan number" restates the box sitting under it. The full
--     instruction (YSCAP prefix, must be unique) already lives in the hint,
--     which is where every other condition keeps its instructions.
--
-- PREVIOUS AND FUTURE FILES. checklist_items.label is COPIED from the template
-- at creation, not joined at read time, so a template-only rename would leave
-- every existing file reading the old words. Both tables are updated.
--
-- Idempotent: each statement is guarded on the old text, so a re-run (every
-- boot) matches nothing once applied, and a label a human has since edited by
-- hand is never overwritten.

-- 1. Heter Iska ------------------------------------------------------------
UPDATE checklist_templates SET label = 'Heter Iska', updated_at = now()
 WHERE code = 'rtl_cond_iska' AND label = 'ISKA';
UPDATE checklist_items ci SET label = 'Heter Iska', updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id AND t.code = 'rtl_cond_iska' AND ci.label = 'ISKA';
-- The borrower sees this one, so its borrower-facing label moves too.
UPDATE checklist_templates SET borrower_label = 'Heter Iska', updated_at = now()
 WHERE code = 'rtl_cond_iska' AND borrower_label = 'ISKA';
UPDATE checklist_items ci SET borrower_label = 'Heter Iska', updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id AND t.code = 'rtl_cond_iska' AND ci.borrower_label = 'ISKA';
-- The staff hint names the document too — a rename that leaves "ISKA document"
-- underneath has only half-renamed it. Only the document's name changes; the
-- export note is kept verbatim. (The BORROWER hint already says "Heter Iska" —
-- db/146 rewrote it when the signing moved into the portal.)
UPDATE checklist_templates SET
       hint = 'Heter Iska document — never included in the TPR / clean-file export',
       updated_at = now()
 WHERE code = 'rtl_cond_iska'
   AND hint = 'ISKA document — never included in the TPR / clean-file export';
UPDATE checklist_items ci SET
       hint = 'Heter Iska document — never included in the TPR / clean-file export',
       updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id AND t.code = 'rtl_cond_iska'
   AND ci.hint = 'ISKA document — never included in the TPR / clean-file export';

-- 2. Appraisal documents ---------------------------------------------------
UPDATE checklist_templates SET label = 'Appraisal documents', updated_at = now()
 WHERE code = 'rtl_cond_appraisaldocs' AND label = 'Appraisal documents received';
UPDATE checklist_items ci SET label = 'Appraisal documents', updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id AND t.code = 'rtl_cond_appraisaldocs'
   AND ci.label = 'Appraisal documents received';

-- 3. YS loan number --------------------------------------------------------
-- The old label's instruction is preserved in the hint rather than dropped;
-- only re-hinted when it still carries the text db/210 wrote.
UPDATE checklist_templates SET label = 'YS loan number', updated_at = now()
 WHERE code = 'cond_loan_number_missing'
   AND label = 'Loan number missing — enter the YS loan number';
UPDATE checklist_items ci SET label = 'YS loan number', updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id AND t.code = 'cond_loan_number_missing'
   AND ci.label = 'Loan number missing — enter the YS loan number';
