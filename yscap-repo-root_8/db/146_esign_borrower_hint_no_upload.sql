-- 146 — Borrower-facing e-sign hints: sign in-portal, nothing to upload
--       (owner-approved 2026-07-19).
--
-- The borrower-signed conditions (signed term sheet, Heter Iska) predate the
-- in-portal DocuSign flow and still tell the borrower to "upload the signed copy."
-- The new flow lets them sign right in the portal and files the executed copy
-- automatically, so the upload instruction is misleading. Update the template
-- hints AND every existing item that still carries the old default (previous +
-- future files); custom hints (anything a human changed) are left untouched.
-- Idempotent: each UPDATE matches only the exact stale text, so re-running is a
-- no-op.

UPDATE checklist_templates
   SET borrower_hint = 'Sign your term sheet right here in the portal — no need to upload anything; your signed copy is filed to your loan automatically.'
 WHERE code = 'rtl_cond_signedts'
   AND borrower_hint = 'Sign your term sheet and upload the signed copy here.';

UPDATE checklist_items ci
   SET borrower_hint = 'Sign your term sheet right here in the portal — no need to upload anything; your signed copy is filed to your loan automatically.'
  FROM checklist_templates t
 WHERE t.id = ci.template_id AND t.code = 'rtl_cond_signedts'
   AND ci.borrower_hint = 'Sign your term sheet and upload the signed copy here.';

UPDATE checklist_templates
   SET borrower_hint = 'Sign the Heter Iska right here in the portal — no need to upload anything; your signed copy is filed to your loan automatically.'
 WHERE code = 'rtl_cond_iska'
   AND borrower_hint = 'Upload your ISKA document here.';

UPDATE checklist_items ci
   SET borrower_hint = 'Sign the Heter Iska right here in the portal — no need to upload anything; your signed copy is filed to your loan automatically.'
  FROM checklist_templates t
 WHERE t.id = ci.template_id AND t.code = 'rtl_cond_iska'
   AND ci.borrower_hint = 'Upload your ISKA document here.';
