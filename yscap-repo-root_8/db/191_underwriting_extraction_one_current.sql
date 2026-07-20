-- 191_underwriting_extraction_one_current.sql
-- Guard: at most ONE current extraction per (document, file).
--
-- saveAnalysis (src/lib/underwriting/store.js) supersedes the prior current extraction and then
-- inserts the new one inside a transaction. That is correct for the sequential case, but two
-- CONCURRENT first-time analyses of the same document (a double-clicked "Analyze", a client
-- retry, two staffers at once) can EACH see "nothing current", each insert, and leave TWO
-- is_current rows for the same document on the same file — which double-counts that document's
-- findings and its CTC-blocking fatals in every roll-up. A unique partial index makes the second
-- commit fail (23505) so only one current row can ever exist; the loser's transaction rolls back
-- and a retry lands on the idempotency cache. (deep-audit finding, 2026-07-20)
--
-- COALESCE folds a NULL application_id to a fixed sentinel so profile-scoped rows (if any are ever
-- stored with a NULL app) still collapse to one-current-per-document; underwriting extractions are
-- always stored under a concrete application_id, so this is belt-and-suspenders.
--
-- Idempotent: collapse any pre-existing duplicate current rows (keep the newest) BEFORE creating
-- the unique index, or the CREATE would fail on legacy duplicates. Safe to re-run every boot.

UPDATE document_extractions e SET is_current = false, superseded = true, updated_at = now()
 WHERE e.is_current
   AND EXISTS (
     SELECT 1 FROM document_extractions e2
      WHERE e2.document_id = e.document_id
        AND e2.application_id IS NOT DISTINCT FROM e.application_id
        AND e2.is_current
        AND (e2.created_at, e2.id) > (e.created_at, e.id));

CREATE UNIQUE INDEX IF NOT EXISTS uq_docextract_one_current
  ON document_extractions (document_id, COALESCE(application_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_current;
