-- =====================================================================
-- 467 — The three DocuSign-resolved conditions are INTERNAL (owner-directed
--       2026-08-04).
--
-- The Term Sheet, the Application & business-purpose Disclosure, and the Heter
-- Iska are all executed as part of ONE DocuSign package — the borrower never
-- uploads them; they file themselves the moment the package is fully signed. Yet
-- they showed on the BORROWER's checklist as OPEN conditions, so the borrower
-- kept asking "I don't see the term sheet — where do I sign it?" (he signs it
-- in DocuSign when WE send it). Owner's fix: these three conditions stay VISIBLE
-- to the loan officer / team as open conditions, but the BORROWER does not see
-- them. Handle them in the backend as internal, and put a note on each that it is
-- automatically fulfilled once the DocuSign package comes back.
--
-- SAFE: the SIGNED documents themselves are stored visibility='borrower' with the
-- borrower_id stamped (db/159 step 5), and the borrower document library
-- (borrower.js GET /documents) filters on visibility + borrower_id, NOT on the
-- condition's audience — so the borrower can still see and download their executed
-- term sheet / application / disclosure / Heter Iska. This change only removes the
-- confusing OPEN condition from their checklist. The e-sign completion flow files
-- the docs + marks the condition satisfied by TEMPLATE CODE, audience-independent,
-- so nothing about signing/fulfilment changes. Reopen-on-economics (db/145) is
-- likewise keyed on the code.
--
-- This runs AFTER db/051/141/146/159 on every boot (higher number), so it is the
-- final word on these three templates' audience; it also back-fills every existing
-- per-file item (previous AND future — owner-directed). Idempotent.
-- =====================================================================

-- 1) Templates → internal (audience='staff') + a staff hint stating the condition
--    is auto-fulfilled by the DocuSign package. borrower_label/hint are left as-is
--    (harmless — the borrower never sees the condition now).
UPDATE checklist_templates SET
    audience = 'staff',
    hint = 'Internal — automatically fulfilled when the term-sheet DocuSign package is fully signed. No borrower action; the borrower does not see this condition (they sign it in DocuSign when we send the package).',
    updated_at = now()
 WHERE code IN ('rtl_cond_signedts', 'rtl_cond_signed_app', 'rtl_cond_iska')
   AND audience IS DISTINCT FROM 'staff';

-- 2) EXISTING FILES — flip every already-created per-file item of these three
--    conditions to internal, and stamp the same auto-fulfil note on its hint so the
--    team reads why it's there. Only touches these three templates' items; only
--    where not already internal (idempotent, no churn).
UPDATE checklist_items ci SET
    audience = 'staff',
    hint = 'Internal — automatically fulfilled when the term-sheet DocuSign package is fully signed. No borrower action; the borrower does not see this condition.',
    updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id
   AND t.code IN ('rtl_cond_signedts', 'rtl_cond_signed_app', 'rtl_cond_iska')
   AND ci.audience IS DISTINCT FROM 'staff';
