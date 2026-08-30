-- ============================================================================
-- db/650 — the mortgagee-clause instructions already saved on files say MONTROSE
--
-- WHAT THIS CHANGES, AND WHY. `LENDER_MORTGAGEE_CLAUSE` spelled our street
-- "MONROSE" until 2026-08-30. It is not an internal label: `underwriting/
-- doc-checks.js` and `underwriting/title-checks.js` interpolate it verbatim into
-- the `how_to` of five findings, which is the sentence a person reads out to an
-- insurance agent or a title company when asking them to RE-ISSUE a policy or
-- CORRECT Schedule A —
--     insurance_wrong_mortgagee, insurance_mortgagee_address,
--     insurance_mortgagee_address_unrecognized,
--     title_wrong_mortgagee, title_mortgagee_address
-- — and into the `file_value` shown beside it as "what it should say". A
-- mortgagee clause is the address insurance CANCELLATION AND LOSS NOTICES are
-- mailed to, so the misspelling was us dictating the wrong notice address onto a
-- real policy: the exact harm those five checks exist to prevent.
--
-- The code fix corrects every finding computed from now on. It cannot reach the
-- ones already written: `underwriting/store.js` persists `how_to`/`file_value`
-- at analysis time and only replaces them when that document is RE-analyzed, so
-- a finding sitting on a file today keeps reading out the wrong street until
-- somebody happens to re-run it. THIS FILE is that other half. Owner-directed
-- 2026-08-30: *"fix the already-saved findings too."*
--
-- BOTH PLACES THE SENTENCE LANDS. `document_findings` is where it is written;
-- `finding_escalations` (db/222) SNAPSHOTS a finding's `how_to`/`file_value` at
-- escalation time and is deliberately never joined back for its content, so a
-- correction to the first does not reach the second. Both are healed here or the
-- escalation queue keeps handing out the old address after the file stops.
--
-- WHAT IS DELIBERATELY LEFT ALONE, and this is the load-bearing half:
--   · `doc_value` — what the BINDER ACTUALLY SAID, read off the vendor's own
--     document. That is evidence, not our prose. Rewriting it would falsify the
--     record of what we were handed, and would break the reader's ability to see
--     that the document and our expectation genuinely differed.
--   · `document_extractions` — the raw read of the document, same reasoning.
--   · `resolution_note`, `question`, `decision_note` and every other free-text
--     column a HUMAN typed. If a person wrote the misspelling by hand, that is
--     their words, and a migration does not edit what somebody said.
--   · `finding_committee_reviews.reasoning` — the AI committee's own prose about a
--     judgement it already made. If a model quoted the old address back, that is a
--     record of what the model said, not an instruction we generated; it is not
--     derived from the constant and it is not ours to rewrite either.
--   · The appraisal side (`appraisal_findings`) and the AVM/cure paths never
--     require `underwriting/lender.js`, so our clause was never in them. Nor does
--     `ai_suggestions`, whose only finding-shaped factory (`fromCureNewFinding`)
--     carries the cure analysis's own text.
--
-- EVERY STATUS IS CORRECTED, not only `open`, and the resolution columns are
-- untouched. The reasoning: `how_to` is BOILERPLATE GENERATED FROM A CONSTANT,
-- never a record of a human decision — what was decided lives in `resolution`,
-- `resolution_note`, `resolved_by`, `resolved_at`, and none of those are read or
-- written here. A resolved or superseded finding is still displayed in the file
-- history, and an address can be copied off a screen just as easily there as in
-- the open queue. Leaving a known-wrong notice address sitting in the record
-- because the row is closed protects nothing and still risks the policy.
--
-- NOTHING IS LOST. Every corrected row gets an `audit_log` entry naming the row,
-- the file, the columns touched and both spellings, so the fact that we once
-- dictated the wrong street survives this correction rather than being quietly
-- erased by it. The change is a pure, exactly reversible substitution
-- (MONTROSE -> MONROSE restores the old text verbatim), so the audit line does
-- not need to carry a copy of the whole sentence to be complete.
--
-- NARROW BY CONSTRUCTION. The guard requires the WHOLE old address
-- ("5 NEW MONROSE AVE #BSMT BROOKLYN NY 11211"), which only our own generated
-- clause ever contained, and the substitution then rewrites only the street
-- token inside it. A row that merely happens to contain the word elsewhere is
-- never matched, and nothing outside those two columns is written.
--
-- IDEMPOTENT, AND STABLE ON REPLAY. `migrate-boot` replays this on every boot.
-- After the first run no row matches the guard (the old address is gone), so the
-- UPDATEs touch nothing, no audit rows are written and no notice is raised. A
-- finding written AFTER this deploy comes from the corrected constant and can
-- never match either.
--
-- BACKFILL. This file IS the backfill. No schema changes, so the schema map
-- (docs/schema/) is unaffected.
--
-- PRODUCT SEPARATION. RTL only — `document_findings` (db/200),
-- `finding_escalations` (db/222) and `audit_log` are all RTL tables. Nothing
-- here names `lt_*`, and no long-term surface has document underwriting at all.
-- ============================================================================

DO $$
DECLARE
  -- The whole old address is the guard; only the street token is rewritten.
  old_addr  constant text := '5 NEW MONROSE AVE #BSMT BROOKLYN NY 11211';
  old_st    constant text := '5 NEW MONROSE AVE';
  new_st    constant text := '5 NEW MONTROSE AVE';
  n_find    int := 0;
  n_esc     int := 0;
BEGIN
  -- ---- 1. the findings themselves -----------------------------------------
  WITH healed AS (
    UPDATE document_findings f
       SET how_to     = replace(f.how_to,     old_st, new_st),
           file_value = replace(f.file_value, old_st, new_st)
     WHERE f.how_to LIKE '%' || old_addr || '%'
        OR f.file_value LIKE '%' || old_addr || '%'
    RETURNING f.id, f.application_id, f.code,
              (f.how_to     LIKE '%' || new_st || '%') AS fixed_how_to,
              (f.file_value LIKE '%' || new_st || '%') AS fixed_file_value
  )
  INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
  SELECT 'system', NULL, 'mortgagee_clause_street_corrected', 'document_finding', h.id,
         jsonb_strip_nulls(jsonb_build_object(
           'migration', 'db/650',
           'applicationId', h.application_id,
           'code', h.code,
           'was', 'MONROSE',
           'now', 'MONTROSE',
           'columns', (CASE WHEN h.fixed_how_to THEN jsonb_build_array('how_to') ELSE '[]'::jsonb END)
                   || (CASE WHEN h.fixed_file_value THEN jsonb_build_array('file_value') ELSE '[]'::jsonb END),
           'why', 'the saved instruction told staff to have the policy re-issued to a misspelled street; the mortgagee clause is where cancellation and loss notices are mailed'))
    FROM healed h;
  GET DIAGNOSTICS n_find = ROW_COUNT;

  -- ---- 2. the escalation snapshots ----------------------------------------
  -- Same sentence, copied onto the workload queue at escalation time. It is
  -- never re-read from document_findings, so it has to be healed in its own right.
  WITH healed AS (
    UPDATE finding_escalations e
       SET how_to     = replace(e.how_to,     old_st, new_st),
           file_value = replace(e.file_value, old_st, new_st)
     WHERE e.how_to LIKE '%' || old_addr || '%'
        OR e.file_value LIKE '%' || old_addr || '%'
    RETURNING e.id, e.application_id, e.code,
              (e.how_to     LIKE '%' || new_st || '%') AS fixed_how_to,
              (e.file_value LIKE '%' || new_st || '%') AS fixed_file_value
  )
  INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
  SELECT 'system', NULL, 'mortgagee_clause_street_corrected', 'finding_escalation', h.id,
         jsonb_strip_nulls(jsonb_build_object(
           'migration', 'db/650',
           'applicationId', h.application_id,
           'code', h.code,
           'was', 'MONROSE',
           'now', 'MONTROSE',
           'columns', (CASE WHEN h.fixed_how_to THEN jsonb_build_array('how_to') ELSE '[]'::jsonb END)
                   || (CASE WHEN h.fixed_file_value THEN jsonb_build_array('file_value') ELSE '[]'::jsonb END),
           'why', 'the escalated copy of the same instruction carried the misspelled street'))
    FROM healed h;
  GET DIAGNOSTICS n_esc = ROW_COUNT;

  IF n_find > 0 OR n_esc > 0 THEN
    RAISE NOTICE 'db/650: corrected the mortgagee-clause street on % finding(s) and % escalation(s) — MONROSE -> MONTROSE', n_find, n_esc;
  END IF;
END $$;
