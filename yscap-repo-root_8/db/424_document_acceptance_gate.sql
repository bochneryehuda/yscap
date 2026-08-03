-- ============================================================================
-- 424 — A DOCUMENT NOBODY ACCEPTED IS NOT PART OF THE FILE'S DOCUMENT SET
--       (owner-directed 2026-08-03). The back-date half.
--
-- WHAT HAPPENED. An insurance condition already carried documents from a
-- PREVIOUS policy (different carrier, no mortgagee clause) that were never
-- accepted. Insurance was then ordered properly, the return came back, THAT
-- document was accepted, and the condition was signed off. The TPR export and
-- the closing-prep email to the outside law firm then shipped ALL of the
-- insurance documents — the never-accepted ones included.
--
-- ROOT CAUSE. Every selector asked `review_status <> 'rejected'`, which is a
-- test for "nobody threw this away", not "somebody checked this". A document
-- that has never been looked at is 'pending' (db/013 default) and passed it.
--
-- THE CODE CHANGE (src/lib/document-acceptance.js) is that the outbound test is
-- now `review_status = 'accepted'`, with NO exception list — and a document
-- PILOT itself generates or orders is born 'accepted' at its INSERT instead of
-- being carved out of the predicate. This file is the "previous AND future"
-- half: the same rows written BEFORE that change are still sitting at 'pending',
-- and without this they would silently vanish from every export and make their
-- conditions unsignable on the next deploy.
--
-- SCOPE IS DELIBERATELY NARROW. Only rows whose kind PROVES no human was ever
-- meant to review them, and only where the status is literally 'pending' (a
-- rejected or superseded row keeps its status — a decision already made is
-- never overwritten). This is the same shape as db/186 (appraisal photos) and
-- db/189 (appraisal source documents), which did exactly this for their kinds.
--
-- WHAT IS DELIBERATELY *NOT* TOUCHED, because a human genuinely does review it:
--   · a borrower or staff UPLOAD (no doc_kind, photo_id, track_record_doc, an
--     entity document, an order return emailed in by title/insurance) — this is
--     the whole point of the rule;
--   · an entity document COPIED onto a profile by `entity-adopt`, which carries
--     source_type='system' but is documented as needing a reviewer to confirm
--     the operating agreement names the borrower before the entity is verified.
--     That is why this file matches on doc_kind and NEVER on source_type alone;
--   · closing-chain CORRESPONDENCE from the attorney's own chain (an outside
--     party's document, and excluded from every package regardless).
--
-- Idempotent: re-running matches nothing once the rows are accepted.
-- ============================================================================

-- 1) PILOT's own generated artifacts and the packages executed through DocuSign.
--    `%\_export` covers every tool's Excel/PDF/HTML (rehab_budget_export,
--    track_record_export, …) — the escape is required or `_` is a wildcard.
UPDATE documents
   SET review_status = 'accepted',
       reviewed_at   = COALESCE(reviewed_at, now())
 WHERE review_status = 'pending'
   AND (
     doc_kind IN (
       -- executed through DocuSign — the authoritative signed copies
       'term_sheet_signed', 'application_signed', 'bp_disclosure_signed',
       'heter_iska_signed', 'esign_certificate',
       -- PILOT's own generated output
       'tpr_export', 'track_record_html', 'draw_inspection_report',
       -- ordered by PILOT from the vendor and downloaded through the API
       'flood_determination'
     )
     OR doc_kind LIKE '%\_export'
   );

-- 2) The generated (unsigned) term sheet PILOT draws at registration. This one is
--    keyed on the DOC_KIND alone, and that is safe for a specific reason: the
--    only thing in the whole system that sets `doc_kind='term_sheet'` is the Term
--    Sheet Studio capturing its own PDF (both upload doors set it solely from
--    `docKind:'term_sheet'`, which only the studio sends). A human uploading a
--    term sheet into a condition passes no docKind at all, so it is not matched.
--    It is NOT keyed on source_type: these rows go through the ordinary upload
--    doors and carry no source_type, so a source_type test would match nothing
--    and the sheet would silently disappear from the TPR export's Term Sheet
--    folder — and, worse, `closing-prep.blockers` would refuse EVERY closing-prep
--    order on the file for want of a term sheet that is sitting right there.
UPDATE documents
   SET review_status = 'accepted',
       reviewed_at   = COALESCE(reviewed_at, now())
 WHERE review_status = 'pending'
   AND doc_kind = 'term_sheet';

-- ---------------------------------------------------------------------------
-- NOTE FOR WHOEVER READS THIS NEXT: there is intentionally NO backfill that
-- accepts human-uploaded documents in bulk, and there must never be one. Files
-- that were signed off before today on documents nobody accepted will now show
-- those documents as held back on the export preview, and their conditions will
-- refuse a FRESH sign-off until somebody decides on each one. That is the
-- correct outcome and it is the entire point of the change — the alternative is
-- to mass-accept, in one statement, exactly the documents the owner reported
-- should never have shipped. An existing sign-off is left standing (nothing is
-- reopened here); the package simply stops carrying documents nobody vouched
-- for, and the preview says which ones and why.
-- ---------------------------------------------------------------------------
