-- 063 — Backfill the file's vesting entity (applications.llc_id) for files that
-- were synced from ClickUp before the fill-only link existed.
--
-- Root cause (fixed forward in the ingest UPDATE path): the ClickUp LLC was
-- written into the borrower's llcs library but `applications.llc_id` (the
-- subject-property vesting entity) was only ever set when a file was CREATED,
-- never on a later sync of an existing file. So files whose LLC arrived on the
-- ClickUp task after the portal file already existed were left with
-- llc_id = NULL — the library had the entity, but the file didn't know which one
-- was its vesting entity.
--
-- This repairs those files DETERMINISTICALLY (no guessing) from the two places
-- the sync already recorded the resolved entity per task. Idempotent and safe:
-- fill-only (WHERE llc_id IS NULL), so a staff-set / corrected vesting entity is
-- never touched, and re-running changes nothing.

-- (1) Primary source: the per-task index stamps the resolved vesting llc_id for
--     every task it ingests (clickup_task_index.llc_id). Use it where the linked
--     file has no vesting entity yet.
UPDATE applications a
   SET llc_id = i.llc_id, updated_at = now()
  FROM clickup_task_index i
 WHERE i.application_id = a.id
   AND a.llc_id IS NULL
   AND i.llc_id IS NOT NULL
   AND a.deleted_at IS NULL;

-- (2) Secondary source: an LLC created from ClickUp carries the originating
--     task id (llcs.source_task_id). Match it to the file's own ClickUp task —
--     that entity is, by construction, this file's vesting entity. Covers any
--     file the index missed. Scoped to the file's borrower and fill-only.
--     DISTINCT ON keeps it single-valued if a task ever produced >1 library row.
UPDATE applications a
   SET llc_id = pick.llc_id, updated_at = now()
  FROM (
    SELECT DISTINCT ON (l.borrower_id, l.source_task_id)
           l.id AS llc_id, l.borrower_id, l.source_task_id
      FROM llcs l
     WHERE l.source_task_id IS NOT NULL
     ORDER BY l.borrower_id, l.source_task_id, l.created_at
  ) pick
 WHERE pick.source_task_id = a.clickup_pipeline_task_id
   AND pick.borrower_id     = a.borrower_id
   AND a.llc_id IS NULL
   AND a.deleted_at IS NULL;

-- (3) For files we just gave a vesting entity that also have a co-borrower, link
--     the co-borrower to that vesting LLC too (same as 061's backfill (b), which
--     only saw the llc_ids that were set at its run time). The primary owner is
--     already covered every boot by 061's backfill (a) (llcs.borrower_id). Stake
--     is left for staff to fill; ON CONFLICT preserves any existing stake.
INSERT INTO llc_borrowers (llc_id, borrower_id)
SELECT DISTINCT a.llc_id, a.co_borrower_id
  FROM applications a
 WHERE a.llc_id IS NOT NULL AND a.co_borrower_id IS NOT NULL AND a.deleted_at IS NULL
ON CONFLICT (llc_id, borrower_id) DO NOTHING;
