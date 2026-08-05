-- 473 — The non-owner-occupied condition now points at the E-SIGN certification.
--
-- Owner-directed 2026-08 for #27: the non-owner-occupied requirement (db/417's
-- cond_noo_affidavit_individual) is satisfied by a "Certification (e-sign, no
-- notary)" — the borrower signs it through DocuSign, they do not hand-upload an
-- affidavit. db/417 wrote its hints BEFORE that e-sign package existed, so the
-- borrower hint said "please upload the signed non-owner-occupied affidavit,"
-- which now mis-describes the flow (a borrower receives a certification to sign
-- electronically). The condition can still be cleared by an uploaded copy — this is
-- WORDING only, so the hints are made mechanism-accurate ("sign a certification")
-- without over-committing to any one path.
--
-- NOT CHANGED, deliberately: the code (cond_noo_affidavit_individual — every rule,
-- send-package binding and db/417 statement is keyed on it), the labels (the
-- condition keeps its recognized "non-owner-occupied affidavit" name), audience,
-- item_kind, auto_apply, category, is_required and rule_logic. Wording only.
--
-- PREVIOUS AND FUTURE FILES. checklist_items.hint/borrower_hint are COPIED from the
-- template at creation (not joined at read time), so a template-only edit would
-- leave every existing individual-vesting file reading the old words. Both tables
-- are updated.
--
-- Idempotent: every statement is guarded on the exact db/417 text, so a re-run
-- (every boot) matches nothing once applied, and a hint a human has edited by hand
-- is never overwritten. db/417 §2 keeps the template's structural columns in
-- lock-step but never touches the hints, so there is no tug-of-war across boots.

-- 1. The borrower hint: "please upload the … affidavit" -> "you'll sign a … certification".
UPDATE checklist_templates SET
       borrower_hint = 'Because this loan is in your personal name rather than a company, you''ll sign a short non-owner-occupied certification confirming you will not live in the property.',
       updated_at = now()
 WHERE code = 'cond_noo_affidavit_individual'
   AND borrower_hint = 'Because this loan is being taken in your personal name rather than a company, please upload the signed non-owner-occupied affidavit confirming you will not live in the property.';
UPDATE checklist_items ci SET
       borrower_hint = 'Because this loan is in your personal name rather than a company, you''ll sign a short non-owner-occupied certification confirming you will not live in the property.',
       updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id AND t.code = 'cond_noo_affidavit_individual'
   AND ci.borrower_hint = 'Because this loan is being taken in your personal name rather than a company, please upload the signed non-owner-occupied affidavit confirming you will not live in the property.';

-- 2. The staff hint: point the team at the e-sign send (a signed copy still clears it).
UPDATE checklist_templates SET
       hint = 'Required because this file vests in an INDIVIDUAL''s name rather than an entity. Send the non-owner-occupied certification for e-signature (or collect a signed copy). This retracts on its own if a vesting LLC is linked later.',
       updated_at = now()
 WHERE code = 'cond_noo_affidavit_individual'
   AND hint = 'Required because this file vests in an INDIVIDUAL''s name rather than an entity. Collect the signed non-owner-occupied affidavit. This retracts on its own if a vesting LLC is linked later.';
UPDATE checklist_items ci SET
       hint = 'Required because this file vests in an INDIVIDUAL''s name rather than an entity. Send the non-owner-occupied certification for e-signature (or collect a signed copy). This retracts on its own if a vesting LLC is linked later.',
       updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id AND t.code = 'cond_noo_affidavit_individual'
   AND ci.hint = 'Required because this file vests in an INDIVIDUAL''s name rather than an entity. Collect the signed non-owner-occupied affidavit. This retracts on its own if a vesting LLC is linked later.';
