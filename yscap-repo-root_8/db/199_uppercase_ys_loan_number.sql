-- 199_uppercase_ys_loan_number.sql
-- Normalize stored YS loan numbers to the professional all-caps form ("YSCAP258134769").
-- A loan number typed lowercase ("yscap258…") used to be stored verbatim, so it
-- leaked lowercase into emails, the ClickUp sync, exports and every file surface.
-- Going forward every write path normalizes to uppercase (sanitizeLoanNumber on
-- staff entry, normalizeLoanNumber on the ClickUp inbound write); this backfills
-- the rows already stored in mixed / lower case.
--
-- Collision-safe against the partial unique index (db/048), which is CASE-SENSITIVE:
-- only uppercase a row when NO OTHER live (non-deleted) row shares the same value
-- case-insensitively. A genuine case-only duplicate ("yscap1" alongside a live
-- "YSCAP1", or two rows that would collapse onto the same value) is a real data
-- conflict for a human to resolve — never something to auto-merge here — so those
-- rows are left untouched. Idempotent (re-running changes nothing once normalized).
UPDATE applications a
   SET ys_loan_number = upper(a.ys_loan_number)
 WHERE a.ys_loan_number IS NOT NULL
   AND a.ys_loan_number <> upper(a.ys_loan_number)
   AND NOT EXISTS (
     SELECT 1 FROM applications b
      WHERE b.id <> a.id
        AND b.deleted_at IS NULL
        AND upper(b.ys_loan_number) = upper(a.ys_loan_number));
