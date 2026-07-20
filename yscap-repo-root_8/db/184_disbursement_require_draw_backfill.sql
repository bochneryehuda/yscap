-- 182_disbursement_require_draw_backfill.sql  (audit F-2, 2026-07-20)
-- Idempotent + go-forward-safe. A construction-draw release now REQUIRES its Sitewire draw id on the money
-- route (src/routes/sitewire.js POST /disbursements), and the overdue monitor matches a release to its
-- finding by an EXACT draw id (dropping the old NULL-fallback that over-suppressed OTHER draws on a
-- multi-draw file). Legacy rows recorded before this change may carry a NULL sitewire_draw_id; with the
-- NULL-fallback gone they would (wrongly) read as "no release recorded" and could alert as overdue.
--
-- This backfill binds each legacy NULL-draw release to its draw ONLY where it is UNAMBIGUOUS — never a guess:
-- a file that has exactly ONE kind='draw' disbursement missing its draw id AND exactly ONE draw that has no
-- kind='draw' disbursement yet. That single free draw is the only draw the orphan release can belong to, so
-- the binding is certain (single-draw files, and multi-draw files where every other draw is already
-- accounted for). Truly ambiguous multi-orphan/multi-free-draw files are LEFT NULL: they will surface a
-- correct overdue nudge that self-heals the instant staff re-record the release with its draw picked. The
-- db/148 partial unique index (one release per draw) is respected because we bind at most one release to the
-- one free draw per file.
WITH one_null AS (          -- files with exactly one NULL-draw kind='draw' release
  SELECT application_id, min(id) AS disb_id
    FROM draw_disbursements
   WHERE kind = 'draw' AND sitewire_draw_id IS NULL
   GROUP BY application_id
  HAVING count(*) = 1
),
one_free_draw AS (          -- files with exactly one draw that has no kind='draw' release yet
  SELECT d.application_id, min(d.sitewire_draw_id) AS draw_id
    FROM sitewire_draws d
   WHERE NOT EXISTS (
     SELECT 1 FROM draw_disbursements x
      WHERE x.kind = 'draw' AND x.sitewire_draw_id = d.sitewire_draw_id)
   GROUP BY d.application_id
  HAVING count(*) = 1
)
UPDATE draw_disbursements dd
   SET sitewire_draw_id = f.draw_id
  FROM one_null nu
  JOIN one_free_draw f ON f.application_id = nu.application_id
 WHERE dd.id = nu.disb_id
   AND dd.sitewire_draw_id IS NULL;   -- re-run safe (already-bound rows are excluded)
