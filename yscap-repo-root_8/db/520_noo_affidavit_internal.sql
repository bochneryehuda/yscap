-- =====================================================================
-- 520 — The non-owner-occupied affidavit is INTERNAL (owner-directed 2026-08-11).
--
-- On a file that vests in an INDIVIDUAL's name, db/417 posts the condition
-- cond_noo_affidavit_individual. It is part of the ONE DocuSign term-sheet
-- package (the borrower signs the non-owner-occupied CERTIFICATION when we send
-- the package — auto-clear.js already lists this code, and orchestrate.js binds
-- the noo_affidavit doc to it), so the borrower NEVER hand-sends it and it clears
-- itself when the package comes back. Yet db/417 seeded it audience='both', so it
-- showed on the BORROWER's portal AND — worse — leaked into the "what's still
-- needed" outstanding-items email (src/lib/reminders.js outstandingItems, whose
-- filter is `audience IN ('borrower','both')`): the borrower was asked to send a
-- document we deliver for them in the package.
--
-- Owner's fix, identical to db/467 for the term sheet / application+disclosure /
-- Heter Iska: the condition stays VISIBLE to the loan officer / team as an open
-- condition (the staff checklist query has NO audience filter) and keeps its
-- staff-side "DocuSign — auto-clears" stamp (that stamp is driven by the
-- auto-clear code set, not by audience), but the BORROWER no longer sees it — not
-- in the portal, not in the outstanding-items email/digest.
--
-- SAFE: signing/fulfilment is audience-INDEPENDENT. orchestrate.resolveConditionItem
-- and esign/clear.js key on the TEMPLATE CODE, and the auto-clear stamp keys on the
-- code too, so flipping audience to 'staff' changes nothing about how the condition
-- is created, bound, signed or cleared — it only removes the borrower-facing view.
--
-- ORDERING / no tug-of-war: db/417 §2 re-asserts the template's structural columns
-- (audience among them) to 'both' on every boot, guarded on `audience IS DISTINCT
-- FROM 'both'`. This file runs LAST (higher number), so it is the final word each
-- boot exactly as db/467's header documents — the audience ends every boot at
-- 'staff'. It also back-fills every existing per-file item (previous AND future).
-- db/473 (hints only) is guarded on db/417's ORIGINAL hint text; §3 below moves the
-- staff hint off that text, so db/473 simply stops matching and there is no fight.
-- Idempotent.
-- =====================================================================

-- 1) Template -> internal (audience='staff'). Re-asserted each boot (db/417 flips it
--    back to 'both' first); this file wins.
UPDATE checklist_templates SET
    audience = 'staff',
    updated_at = now()
 WHERE code = 'cond_noo_affidavit_individual'
   AND audience IS DISTINCT FROM 'staff';

-- 2) EXISTING FILES — flip every already-created per-file item of this condition to
--    internal (previous AND future). Only where not already internal (idempotent).
UPDATE checklist_items ci SET
    audience = 'staff',
    updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id
   AND t.code = 'cond_noo_affidavit_individual'
   AND ci.audience IS DISTINCT FROM 'staff';

-- 3) Staff hint states it is part of the DocuSign term-sheet package and that the
--    borrower does not see it. Guarded on db/473's exact current staff text so it
--    fires once, never overwrites a hand-edited hint, and db/473 (which guards on
--    db/417's ORIGINAL text) can never fight it. borrower_label/borrower_hint are
--    left as-is (harmless — the borrower never sees the condition now), matching
--    db/467's note.
UPDATE checklist_templates SET
    hint = 'Required because this file vests in an INDIVIDUAL''s name rather than an entity. Part of the DocuSign term-sheet package — the borrower signs the non-owner-occupied certification when we send the package, so the borrower does not see this condition and is not asked to upload it; it auto-clears when the package is fully signed. Retracts on its own if a vesting LLC is linked later.',
    updated_at = now()
 WHERE code = 'cond_noo_affidavit_individual'
   AND hint = 'Required because this file vests in an INDIVIDUAL''s name rather than an entity. Send the non-owner-occupied certification for e-signature (or collect a signed copy). This retracts on its own if a vesting LLC is linked later.';
UPDATE checklist_items ci SET
    hint = 'Required because this file vests in an INDIVIDUAL''s name rather than an entity. Part of the DocuSign term-sheet package — the borrower signs the non-owner-occupied certification when we send the package, so the borrower does not see this condition and is not asked to upload it; it auto-clears when the package is fully signed. Retracts on its own if a vesting LLC is linked later.',
    updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id AND t.code = 'cond_noo_affidavit_individual'
   AND ci.hint = 'Required because this file vests in an INDIVIDUAL''s name rather than an entity. Send the non-owner-occupied certification for e-signature (or collect a signed copy). This retracts on its own if a vesting LLC is linked later.';
