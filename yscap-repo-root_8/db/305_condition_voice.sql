-- 305 — IG-VOICE (#285): keep every ACTIVE posted condition in PILOT's own plain,
--       beginner-friendly voice on borrower-facing surfaces (owner-directed 2026-07-24).
--
-- The borrower-facing wording on the active condition catalog was already rewritten into
-- plain language, condition-by-condition, as each IG-W item was built, and a review confirmed
-- NO note-buyer / capital-partner name appears on any borrower-facing field (borrower_label /
-- borrower_hint) — partner names live only on staff fields, which is allowed. The one piece of
-- leftover jargon a borrower would trip on was the EIN letter's hint, which listed bare IRS
-- FORM NUMBERS ("IRS SS-4 / CP-575 EIN confirmation letter") with no explanation. Rewrite it in
-- plain language that says what the document IS.
--
-- Previous AND future: update the TEMPLATE (future posts) and every EXISTING checklist_item
-- that still carries the old snapshot (checklist_items copy the wording at post time). Idempotent
-- + non-clobbering — only rows whose text still EQUALS the old value are touched, so a hand-edited
-- item is never overwritten and a re-run is a no-op. Display/wording only; no logic, no number.

-- Template (drives all future posts).
UPDATE checklist_templates
   SET borrower_hint = 'The letter from the IRS confirming your company''s federal tax ID number (EIN) — usually called the CP-575, or your EIN confirmation letter.'
 WHERE code = 'rtl_llc_ein'
   AND borrower_hint = 'IRS SS-4 / CP-575 EIN confirmation letter';

-- Existing posted items that still carry the old snapshot (previous files).
UPDATE checklist_items ci
   SET borrower_hint = 'The letter from the IRS confirming your company''s federal tax ID number (EIN) — usually called the CP-575, or your EIN confirmation letter.'
  FROM checklist_templates t
 WHERE ci.template_id = t.id
   AND t.code = 'rtl_llc_ein'
   AND ci.borrower_hint = 'IRS SS-4 / CP-575 EIN confirmation letter';
