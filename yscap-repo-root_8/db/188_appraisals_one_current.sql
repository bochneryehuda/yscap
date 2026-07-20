-- ============================================================================
-- 188 — Enforce ONE current appraisal per file (process audit, 2026-07-20).
--
-- The import runs supersede-then-insert; two concurrent imports on the same file (double-click, two
-- officers, or the /import route racing the condition-slot auto-import) could each run on their own
-- MVCC snapshot and BOTH survive as superseded=false → multiple "current" appraisals + doubled open
-- findings, and undo/GET (which LIMIT 1) then silently hide the second. importAppraisalTx now takes a
-- `SELECT ... FOR UPDATE` row lock on the applications row to serialize; this migration is the
-- belt-and-suspenders: a UNIQUE partial index so the DB itself refuses a second current appraisal.
--
-- Because a UNIQUE index would FAIL to build if a past race already left duplicates, first DEDUP:
-- keep the most-recently-imported current appraisal per file, retire the rest, and supersede the
-- retired ones' still-open findings (so the open-count / blocksCtc summary isn't inflated). All
-- idempotent — a clean DB no-ops.
-- ============================================================================

-- 1. Retire duplicate current appraisals, keeping the newest per file.
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY application_id ORDER BY imported_at DESC NULLS LAST, id DESC) AS rn
    FROM appraisals
   WHERE superseded = false
)
UPDATE appraisals a
   SET superseded = true
  FROM ranked r
 WHERE a.id = r.id AND r.rn > 1;

-- 2. Supersede any open findings that belong to an appraisal now marked superseded (a normal
--    re-import already supersedes findings by application_id; this only catches the race leftovers).
UPDATE appraisal_findings af
   SET status = 'superseded'
  FROM appraisals a
 WHERE af.appraisal_id = a.id AND a.superseded = true AND af.status = 'open';

-- 3. From now on the DB enforces at most one current appraisal per file.
CREATE UNIQUE INDEX IF NOT EXISTS uq_appraisals_one_current
    ON appraisals(application_id) WHERE superseded = false;
