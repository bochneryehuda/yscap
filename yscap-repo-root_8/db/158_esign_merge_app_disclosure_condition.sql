-- =====================================================================
-- 158_esign_merge_app_disclosure_condition.sql
-- Merge the signed business-purpose disclosure INTO the signed-application
-- condition (owner-directed 2026-07-20): ONE combined condition holds BOTH the
-- signed loan application AND the signed business-purpose disclosure (each as its
-- own file inside it). The signed term sheet stays its own condition; the Heter
-- Iska stays its own. ALL signed-document conditions are borrower-visible
-- (audience 'both') — the signed PDFs are already stored visibility='borrower'; the
-- DocuSign Certificate of Completion stays staff-only (a standalone document, not a
-- condition).
--
--   * rtl_cond_signed_app   is REPURPOSED as the combined condition.
--   * rtl_cond_disclosures  is RETIRED: the template is deactivated (no NEW file
--     seeds it — db/141's backfill only seeds is_active=true), and every existing
--     per-file disclosures item is merged into its file's signed-application item
--     (docs + envelope-doc mapping moved, the more-advanced status adopted) and
--     then deleted. Every FK to checklist_items is ON DELETE SET NULL / CASCADE, so
--     deleting an emptied item is safe (and matches the dedup migrations 040/052/056).
--
-- The reopen family (db/145) still lists rtl_cond_disclosures; that becomes a no-op
-- for merged files (no items carry the code) and rtl_cond_signed_app — which now
-- holds the disclosure — is already reopened, so a numbers change still forces a
-- fresh signature on the whole packet.
--
-- Idempotent: re-running finds no disclosures items to merge and no template drift.
-- Runs AFTER db/141 on every boot, so the relabel + deactivation always win.
-- =====================================================================

-- 1) Repurpose the application condition as the combined condition, borrower-visible.
UPDATE checklist_templates SET
    label = 'Signed application & business-purpose disclosure',
    audience = 'both',
    hint = 'The borrower-signed loan application AND business-purpose disclosure (both filed automatically when the term-sheet package is fully signed).',
    borrower_label = 'Signed application & disclosure',
    borrower_hint = 'Your signed loan application and business-purpose disclosure — filed here for your records. Nothing to upload.',
    updated_at = now()
 WHERE code = 'rtl_cond_signed_app';

-- 2) The signed term sheet is borrower-visible too (owner-directed). Already 'both'
--    from db/051; converge only if it ever drifted.
UPDATE checklist_templates SET audience = 'both', updated_at = now()
 WHERE code = 'rtl_cond_signedts' AND audience IS DISTINCT FROM 'both';

-- 3) Retire the separate disclosure template — no new file seeds it.
UPDATE checklist_templates SET is_active = false, updated_at = now()
 WHERE code = 'rtl_cond_disclosures' AND is_active IS DISTINCT FROM false;

-- 4) EXISTING FILES — move the disclosure item's signed docs into the paired
--    application item (same application), then adopt its status, then delete it.
--    All three steps are pair-scoped to the SAME application and no-op after the
--    first run.

-- 4a) Move stored signed documents onto the combined (application) item.
--     (documents has no updated_at column — do not set it.)
UPDATE documents dd SET checklist_item_id = pair.app_id
  FROM (
    SELECT d.id AS disc_id, a.id AS app_id
      FROM checklist_items d
      JOIN checklist_templates td ON td.id = d.template_id AND td.code = 'rtl_cond_disclosures'
      JOIN checklist_items a ON a.application_id = d.application_id
      JOIN checklist_templates ta ON ta.id = a.template_id AND ta.code = 'rtl_cond_signed_app'
     WHERE d.application_id IS NOT NULL
  ) pair
 WHERE dd.checklist_item_id = pair.disc_id;

-- 4b) Move the envelope-doc → condition mapping onto the combined item.
UPDATE esign_envelope_docs ed SET checklist_item_id = pair.app_id
  FROM (
    SELECT d.id AS disc_id, a.id AS app_id
      FROM checklist_items d
      JOIN checklist_templates td ON td.id = d.template_id AND td.code = 'rtl_cond_disclosures'
      JOIN checklist_items a ON a.application_id = d.application_id
      JOIN checklist_templates ta ON ta.id = a.template_id AND ta.code = 'rtl_cond_signed_app'
     WHERE d.application_id IS NOT NULL
  ) pair
 WHERE ed.checklist_item_id = pair.disc_id;

-- 4c) Adopt the more-advanced status/sign-off from the disclosure item onto the
--     combined item (so a file where the disclosure was already received/satisfied
--     isn't quietly reset). Rank: satisfied > received > issue > requested > else.
UPDATE checklist_items a SET
    status = d.status,
    signed_off_at = COALESCE(d.signed_off_at, a.signed_off_at),
    signed_off_by = COALESCE(d.signed_off_by, a.signed_off_by),
    updated_at = now()
  FROM checklist_items d
  JOIN checklist_templates td ON td.id = d.template_id AND td.code = 'rtl_cond_disclosures'
 WHERE a.template_id = (SELECT id FROM checklist_templates WHERE code = 'rtl_cond_signed_app')
   AND d.application_id = a.application_id
   AND (CASE d.status WHEN 'satisfied' THEN 4 WHEN 'received' THEN 3 WHEN 'issue' THEN 2 WHEN 'requested' THEN 1 ELSE 0 END)
     > (CASE a.status WHEN 'satisfied' THEN 4 WHEN 'received' THEN 3 WHEN 'issue' THEN 2 WHEN 'requested' THEN 1 ELSE 0 END);

-- 4d) Delete the now-emptied disclosure items — ONLY where a paired application item
--     exists (so nothing is orphaned if a file somehow lacked the app item).
DELETE FROM checklist_items d
 USING checklist_templates td
 WHERE d.template_id = td.id AND td.code = 'rtl_cond_disclosures'
   AND EXISTS (
     SELECT 1 FROM checklist_items a
      JOIN checklist_templates ta ON ta.id = a.template_id AND ta.code = 'rtl_cond_signed_app'
     WHERE a.application_id = d.application_id);

-- 5) Backfill borrower_id onto already-stored signed copies. They were stored with
--    borrower_id NULL, which HID them from the borrower's in-portal document library
--    even though they are visibility='borrower' — so a borrower had no in-portal way
--    to find their executed documents. Stamp the file's borrower so previous loans'
--    signed copies show up too (previous AND future). The certificate is doc_kind
--    'esign_certificate' (not '%_signed') and staff-only, so it is never touched.
UPDATE documents d SET borrower_id = a.borrower_id
  FROM applications a
 WHERE d.application_id = a.id
   AND d.borrower_id IS NULL
   AND d.visibility = 'borrower'
   AND d.doc_kind IN ('term_sheet_signed','application_signed','bp_disclosure_signed','heter_iska_signed')
   AND a.borrower_id IS NOT NULL;
