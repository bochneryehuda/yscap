-- 362 — A purchase advice is NEVER borrower-visible. Previous files too.
--
-- The purchase advice names the note buyer and the price the loan sold for. The
-- standing rule is that a capital-partner name never reaches a borrower-facing
-- surface — so the document must be staff-only, always.
--
-- Going forward the designation route forces it (see the purchasing/advice
-- handler). This is the PREVIOUS-files half. It is needed because the upload
-- endpoint derives visibility from the CONDITION a document was filed against —
-- `staff_only` only when that condition's audience is exactly 'staff' — and the
-- purchasing screen had no upload slot of its own, so an advice filed against any
-- ordinary borrower-facing condition was stored visibility='borrower'. Both
-- borrower doors (the documents list and the mentionables list) admit exactly
-- that, and the download hands back the bytes unscrubbed.
--
-- Scoped as tightly as the fact allows: ONLY a document a purchasing_advice row
-- actually points at. A document that merely carries doc_kind='purchase_advice'
-- but was never designated is deliberately left alone — this migration re-runs on
-- every boot and must not quietly reclassify documents nobody chose.
--
-- Idempotent: the WHERE clause matches nothing on a second pass.

-- Only rows this has NEVER handled: `document_prior_visibility` (db/361) is
-- stamped the moment the designation code forces a document, so its presence
-- means the new code owns this row. Without that guard this migration re-runs on
-- EVERY boot and would silently re-force a document an admin had deliberately
-- restored — making the documented undo impossible to keep.
--
-- Also scoped to documents that are BORROWER-visible: a document marked
-- 'internal' is MORE restricted than staff_only (tpr-export treats it as never
-- shippable to a buyer), so forcing it down to staff_only would be a widening.
--
-- AND IT STAMPS WHAT IT HID, in the same statement. An earlier cut only ran the
-- documents UPDATE, which left the legacy rows in exactly the state the guard
-- above exists to prevent: no `document_prior_visibility`, so (a) there was
-- nothing for an admin to read to undo a wrong hide, and (b) the guard did not
-- match them, so an admin who DID restore one to 'borrower' had it silently
-- re-hidden on the very next boot — forever. The runtime designation code
-- stamps the prior value for exactly this reason; the back-date has to as well,
-- or "previous files" get a strictly worse guarantee than new ones.
--
-- 'borrower' is the honest value to record: the WHERE matched either an explicit
-- 'borrower' or a NULL, and NULL means the column default, which every borrower
-- door reads as visible. Restoring to 'borrower' is the correct undo for both.
--
-- One data-modifying CTE so the hide and its undo record cannot half-apply — a
-- document hidden with no recorded prior visibility is the bug, not a smaller
-- version of the fix.
WITH forced AS (
  UPDATE documents d
     SET visibility = 'staff_only'
    FROM purchasing_advice a
   WHERE a.document_id = d.id
     AND a.document_prior_visibility IS NULL
     AND COALESCE(d.visibility, 'borrower') = 'borrower'
  RETURNING a.application_id
)
UPDATE purchasing_advice a
   SET document_prior_visibility = 'borrower'
  FROM forced f
 WHERE a.application_id = f.application_id;

-- ============================================================================
-- THE SUPERSEDED ADVICE DOCUMENTS — a ONE-SHOT sweep.
--
-- The half above only reaches the document the advice CURRENTLY points at. But
-- moving that pointer is the documented normal workflow: the advice is re-issued
-- post closing and again post purchase, and the purchasing screen tells the
-- closer to do exactly that. Every PREVIOUS advice on such a file — a real one,
-- naming the note buyer and the price the loan sold for — keeps whatever
-- visibility it was uploaded with, and until the designation code began forcing
-- (this branch) that was 'borrower': in the borrower's own Documents list, in the
-- mentionables list, and downloadable with the bytes intact. That is the
-- identical breach this migration exists to close, on the identical document.
--
-- Deterministic because the route has always recorded every designation:
-- audit_log rows with action='purchasing_advice' carry the document id in
-- detail->>'documentId'. Nothing is inferred from doc_kind or filename.
--
-- ONE-SHOT, guarded by sync_runtime_state (the db/356 pattern), for a reason
-- specific to this half: a superseded document has NO per-document marker to
-- record its prior visibility against — purchasing_advice holds exactly one row
-- per file, describing the CURRENT pointer. Re-running would therefore re-hide a
-- document an admin had deliberately restored, with no way to tell the two
-- states apart. The current-pointer half above keeps its per-row guard and stays
-- idempotent; this half runs once, ever.
-- ============================================================================
DO $$
DECLARE
  done boolean;
  n int := 0;
BEGIN
  SELECT COALESCE((value->>'done')::boolean, false) INTO done
    FROM sync_runtime_state WHERE key = 'purchase_advice_superseded_hide';
  IF COALESCE(done, false) THEN RETURN; END IF;

  UPDATE documents d
     SET visibility = 'staff_only'
   WHERE COALESCE(d.visibility, 'borrower') = 'borrower'
     AND EXISTS (
       SELECT 1 FROM audit_log al
        WHERE al.action = 'purchasing_advice'
          AND al.entity_type = 'application'
          AND al.entity_id = d.application_id
          AND al.detail->>'documentId' = d.id::text);
  GET DIAGNOSTICS n = ROW_COUNT;

  INSERT INTO sync_runtime_state (key, value, updated_at)
  VALUES ('purchase_advice_superseded_hide',
          jsonb_build_object('done', true, 'hidden', n), now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  IF n > 0 THEN
    RAISE NOTICE 'db/362: hid % superseded purchase advice document(s)', n;
  END IF;
END $$;
