-- ============================================================================
-- 355 — Back-date the undo record for appraisals imported BEFORE the As-Is /
--       ARV write recorded itself (owner-directed 2026-07-28, previous AND
--       future).
--
-- WHY THIS EXISTS
-- ---------------
-- `undoAppraisalImport` used to reverse the import's blank-fills by RULE:
--   "blank as_is_value / arv when the file still shows exactly what this
--    appraisal imported — the import only ever fills a blank, so the previous
--    value must have been NULL."
-- That rule stopped being true the day the appraisal desk started making the
-- file AGREE with the appraisal (db/352 + db/353): "equal" became the NORMAL
-- state of a healthy file, so the rule deleted As-Is and ARV values officers
-- had typed by hand — including on the very condition that asked them to type
-- one. The undo now reverses only what PILOT RECORDED writing
-- (as_is_applied_value / arv_applied_value + the value the file showed before).
--
-- A VALUE PILOT DID NOT WRITE IS NOT PILOT'S TO REMOVE.
--
-- But appraisals imported BEFORE that recording existed carry no record, so on
-- those files the undo would now leave the imported values behind. This migration
-- writes the record they never got — reproducing the OLD behaviour exactly, and
-- only where the old rule would have fired: the file still shows precisely what
-- the appraisal imported, and the desk has never touched the row (no read, no
-- applied stamp), so the value can only have come from the import's blank-fill.
-- `as_is_file_value_before` is NULL because a blank-fill only ever fills a blank.
--
-- ONE-SHOT, ON PURPOSE
-- --------------------
-- Every migration re-runs on every boot, and this one MUST NOT. Once the desk is
-- live, "the file equals the appraisal" is the normal healthy state and is very
-- often a number a HUMAN typed on the As-Is condition. Re-running this later
-- would stamp that human value as PILOT's and hand the undo permission to delete
-- it — the exact bug being fixed. So it is gated on a durable marker in
-- sync_runtime_state and can only ever run once per database.
-- ============================================================================

DO $$
DECLARE
  done boolean;
  n_asis int := 0;
  n_arv  int := 0;
BEGIN
  SELECT COALESCE((value->>'done')::boolean, false) INTO done
    FROM sync_runtime_state WHERE key = 'appraisal_undo_backdate';
  IF COALESCE(done, false) THEN
    RETURN;
  END IF;

  -- The As-Is the import blank-filled.
  UPDATE appraisals a
     SET as_is_applied           = true,
         as_is_applied_value     = a.as_is_value,
         as_is_file_value_before = NULL
    FROM applications ap
   WHERE ap.id = a.application_id
     AND a.superseded = false
     AND a.as_is_value IS NOT NULL
     AND ap.as_is_value IS NOT DISTINCT FROM a.as_is_value
     -- untouched by the appraisal desk: no reading, no write, no human answer
     AND a.as_is_applied = false
     AND a.as_is_applied_value IS NULL
     AND a.as_is_read_at IS NULL
     AND a.as_is_confirmed_value IS NULL;
  GET DIAGNOSTICS n_asis = ROW_COUNT;

  -- The ARV the import blank-filled.
  UPDATE appraisals a
     SET arv_applied           = true,
         arv_applied_value     = a.arv_value,
         arv_file_value_before = NULL
    FROM applications ap
   WHERE ap.id = a.application_id
     AND a.superseded = false
     AND a.arv_value IS NOT NULL
     AND ap.arv IS NOT DISTINCT FROM a.arv_value
     AND a.arv_applied = false
     AND a.arv_applied_value IS NULL
     AND a.as_is_read_at IS NULL
     AND a.arv_confirmed_value IS NULL;
  GET DIAGNOSTICS n_arv = ROW_COUNT;

  INSERT INTO sync_runtime_state (key, value, updated_at)
  VALUES ('appraisal_undo_backdate',
          jsonb_build_object('done', true, 'as_is_rows', n_asis, 'arv_rows', n_arv, 'at', now()),
          now())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = now();

  RAISE NOTICE '355: back-dated undo record on % As-Is and % ARV appraisal row(s)', n_asis, n_arv;
END $$;
