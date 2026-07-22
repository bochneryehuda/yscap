-- Close orphaned sync-review findings whose file was already removed from the portal
-- (owner-directed 2026-07-22, Libby Baum / 1600 Mildred Ave).
--
-- ROOT CAUSE: the RTL -> duplicate -> DSCR workflow. An RTL task is duplicated to
-- start a new deal; for a moment the duplicate is an exact RTL copy carrying the
-- SAME YS loan number, so PILOT flags a copied_loan_number_needs_assignment finding.
-- The duplicate is then changed to a DSCR and its loan number cleared, so PILOT
-- DESCOPES it (soft-deletes the file, ClickUp untouched) -- but the descope path
-- never closed the finding it was carrying, and Re-check had no branch for a
-- loan-number finding, so the card was stuck open forever ("can't auto-clear it here").
--
-- Going forward this can't recur: descopeFlipped() now closes a descoped file's
-- open file-level findings, and Re-check re-derives a loan-number finding live. This
-- migration heals the EXISTING backlog (previous + future rule) by closing every open
-- file-level finding whose linked application is already soft-deleted. Idempotent:
-- a second run finds no open rows left to close.
UPDATE sync_review_queue q
   SET status='resolved', auto_resolved=true, resolved_at=now(),
       resolution_note='auto-closed (backfill db/277) — the file this review was about was removed from the portal (descoped to a non-RTL/data-only type)'
  FROM applications a
 WHERE q.status='open'
   AND q.application_id = a.id
   AND a.deleted_at IS NOT NULL
   AND q.field_key IN ('ys_loan_number','file_link','push_job','sharepoint_folder','sharepoint_doc');
