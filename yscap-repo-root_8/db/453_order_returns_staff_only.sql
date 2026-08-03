-- ============================================================================
-- 453 — SECURITY backfill: every document a TITLE or INSURANCE vendor returned on an
-- order is STAFF-ONLY (audit finding, 2026-08-03).
--
-- `src/lib/order-inbox.js saveReturnedDocs` inserted the vendor's returned documents
-- WITHOUT the two classification columns, so they took db/014's defaults —
-- visibility='borrower', source_type='borrower_upload'. The borrower's document
-- library and download route gate on the DOCUMENT's visibility
-- (routes/borrower.js), NOT on the owning condition's audience — and both
-- `rtl_cond_title` and `rtl_cond_insurance` are audience='staff' (db/051). So a
-- borrower could list and download the title commitment, the CPL, the tax
-- certificate and the title company's WIRING INSTRUCTIONS, with no context and no
-- one having chosen to share them.
--
-- This is the SAME omission, with the same consequence, that db/175 closed for the
-- appraisal source documents — and it is fixed the same way: the insert now writes
-- 'system'/'staff_only', and this migration closes the exposure on every document
-- ALREADY filed (previous AND future).
--
-- These documents still ride into the TPR investor package: that selector
-- (tpr-export.selectTprDocuments) filters chat attachments and regenerable
-- artifacts, never visibility, and a title commitment belongs in the package.
--
-- Idempotent — only touches rows not already classified this way.
-- ============================================================================
UPDATE documents
   SET visibility  = 'staff_only',
       source_type = 'system'
 WHERE COALESCE(doc_kind,'') IN ('title_order_return', 'insurance_order_return')
   AND (visibility IS DISTINCT FROM 'staff_only' OR source_type IS DISTINCT FROM 'system');
