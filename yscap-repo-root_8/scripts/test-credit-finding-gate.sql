-- Integration test for db/168: the fatal FICO-mismatch finding is a HARD gate on
-- completing a credit condition, backstopped at the database level.
-- Requires the migrations applied. NOT in `npm test` (DB-free). Run:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test-credit-finding-gate.sql
-- Proves: a fatal, unreconciled finding on the LATEST credit report blocks the
-- credit condition from being flipped to 'satisfied'; reconciling the finding OR
-- a newer clean report clears the gate; a non-credit condition is never affected.
DO $$
DECLARE bid uuid; aid uuid; tmpl uuid; crid uuid; blocked boolean;
BEGIN
  DELETE FROM borrowers WHERE email='findinggate-test@example.com';
  INSERT INTO borrowers (first_name,last_name,email,fico) VALUES ('Finding','Gate','findinggate-test@example.com',700) RETURNING id INTO bid;
  INSERT INTO applications (borrower_id) VALUES (bid) RETURNING id INTO aid;
  SELECT id INTO tmpl FROM checklist_templates WHERE code='rtl_cond_credit' LIMIT 1;
  IF tmpl IS NULL THEN RAISE EXCEPTION 'rtl_cond_credit template missing'; END IF;

  -- credit report WITH a fatal FICO-mismatch finding
  INSERT INTO credit_reports (application_id, provider_id, status, underwriting_finding)
    VALUES (aid, 1, 'imported', '{"type":"fico_mismatch","severity":"fatal","verified":732,"claimed":699,"verifiedBracket":"720-739","claimedBracket":"680-699"}'::jsonb)
    RETURNING id INTO crid;
  INSERT INTO checklist_items (scope,label,application_id,template_id,status)
    VALUES ('application','Credit report',aid,tmpl,'received');

  -- TEST 1: flip to satisfied => BLOCKED
  blocked := false;
  BEGIN
    UPDATE checklist_items SET status='satisfied' WHERE application_id=aid AND template_id=tmpl;
  EXCEPTION WHEN check_violation THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL T1: fatal finding did NOT block credit sign-off'; END IF;
  RAISE NOTICE 'PASS T1: fatal unreconciled finding blocks credit sign-off';

  -- TEST 2: reconcile => sign-off SUCCEEDS
  UPDATE credit_reports SET underwriting_finding_reconciled_at=now(), underwriting_finding_reconciled_by=NULL, underwriting_finding_reconcile_note='reviewed exception' WHERE id=crid;
  UPDATE checklist_items SET status='satisfied' WHERE application_id=aid AND template_id=tmpl;
  RAISE NOTICE 'PASS T2: reconciled finding allows credit sign-off';
  UPDATE checklist_items SET status='received' WHERE application_id=aid AND template_id=tmpl;

  -- TEST 3: un-reconcile, add a NEWER clean report => latest wins, sign-off SUCCEEDS.
  -- (Explicit later created_at: this whole block is ONE transaction, so now() is
  -- frozen at its start — in production each report is a separate request with a
  -- distinct wall-clock timestamp; the gate orders by created_at DESC to match
  -- staff-credit.js's "most recent report".)
  UPDATE credit_reports SET underwriting_finding_reconciled_at=NULL WHERE id=crid;
  INSERT INTO credit_reports (application_id, provider_id, status, underwriting_finding, created_at)
    VALUES (aid, 1, 'imported', NULL, now() + interval '1 minute');
  UPDATE checklist_items SET status='satisfied' WHERE application_id=aid AND template_id=tmpl;
  RAISE NOTICE 'PASS T3: latest clean report clears the gate (older finding ignored)';

  -- TEST 4: delete the clean report so the fatal one is latest again; a NON-credit
  -- condition still completes freely (the trigger only guards credit codes).
  DELETE FROM credit_reports WHERE application_id=aid AND underwriting_finding IS NULL;
  INSERT INTO checklist_items (scope,label,application_id,status) VALUES ('application','Some other doc',aid,'satisfied');
  RAISE NOTICE 'PASS T4: non-credit condition satisfied freely while a fatal finding exists';

  -- TEST 5: a jsonb-null / warning-severity finding does NOT block (only fatal).
  UPDATE checklist_items SET status='received' WHERE application_id=aid AND template_id=tmpl;
  UPDATE credit_reports SET underwriting_finding='{"severity":"warning"}'::jsonb WHERE id=crid;
  UPDATE checklist_items SET status='satisfied' WHERE application_id=aid AND template_id=tmpl;
  RAISE NOTICE 'PASS T5: a non-fatal finding never blocks';

  -- TEST 6: SAME created_at tiebreaker is DETERMINISTIC (id DESC). Two reports
  -- share a timestamp — a fatal one and a clean one. The gate must pick the same
  -- row every time (highest id), so the app layer and this trigger never disagree.
  -- Fatal report given the HIGHER id => it is "latest" => sign-off BLOCKED.
  UPDATE checklist_items SET status='received' WHERE application_id=aid AND template_id=tmpl;
  DELETE FROM credit_reports WHERE application_id=aid;
  INSERT INTO credit_reports (id, application_id, provider_id, status, underwriting_finding, created_at)
    VALUES ('00000000-0000-0000-0000-000000000001', aid, 1, 'imported', NULL, timestamptz '2020-01-01 00:00:00+00');
  INSERT INTO credit_reports (id, application_id, provider_id, status, underwriting_finding, created_at)
    VALUES ('00000000-0000-0000-0000-000000000002', aid, 1, 'imported',
            '{"severity":"fatal","verified":732,"claimed":699}'::jsonb, timestamptz '2020-01-01 00:00:00+00');
  blocked := false;
  BEGIN
    UPDATE checklist_items SET status='satisfied' WHERE application_id=aid AND template_id=tmpl;
  EXCEPTION WHEN check_violation THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL T6a: fatal report with higher id at same timestamp did NOT block'; END IF;
  -- Now give the CLEAN report the higher id => clean is "latest" => sign-off ALLOWED.
  DELETE FROM credit_reports WHERE application_id=aid;
  INSERT INTO credit_reports (id, application_id, provider_id, status, underwriting_finding, created_at)
    VALUES ('00000000-0000-0000-0000-000000000001', aid, 1, 'imported',
            '{"severity":"fatal","verified":732,"claimed":699}'::jsonb, timestamptz '2020-01-01 00:00:00+00');
  INSERT INTO credit_reports (id, application_id, provider_id, status, underwriting_finding, created_at)
    VALUES ('00000000-0000-0000-0000-000000000002', aid, 1, 'imported', NULL, timestamptz '2020-01-01 00:00:00+00');
  UPDATE checklist_items SET status='satisfied' WHERE application_id=aid AND template_id=tmpl;
  RAISE NOTICE 'PASS T6: same-timestamp tiebreaker is deterministic (id DESC) — fatal-higher blocks, clean-higher allows';

  -- TEST 7: a later FAILED / in_doubt re-pull must NOT mask an earlier imported
  -- report's fatal finding. The finding lives only on 'imported' rows; a failed
  -- order writes a newer 'in_doubt'/'error' row with a NULL finding. The gate
  -- reads only imported reports, so the earlier fatal finding still blocks.
  UPDATE checklist_items SET status='received' WHERE application_id=aid AND template_id=tmpl;
  DELETE FROM credit_reports WHERE application_id=aid;
  INSERT INTO credit_reports (id, application_id, provider_id, status, underwriting_finding, created_at)
    VALUES ('00000000-0000-0000-0000-0000000000a1', aid, 1, 'imported',
            '{"severity":"fatal","verified":732,"claimed":699}'::jsonb, timestamptz '2020-01-01 00:00:00+00');
  -- a NEWER in_doubt re-pull (no finding) — must NOT clear the gate
  INSERT INTO credit_reports (id, application_id, provider_id, status, underwriting_finding, created_at)
    VALUES ('00000000-0000-0000-0000-0000000000a2', aid, 1, 'in_doubt', NULL, timestamptz '2020-06-01 00:00:00+00');
  blocked := false;
  BEGIN
    UPDATE checklist_items SET status='satisfied' WHERE application_id=aid AND template_id=tmpl;
  EXCEPTION WHEN check_violation THEN blocked := true;
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL T7: a later in_doubt re-pull MASKED the imported fatal finding'; END IF;
  RAISE NOTICE 'PASS T7: a failed/in_doubt re-pull does not mask an earlier imported fatal finding';

  -- ==== db/170: the GENERALIZED findings[] wrapper (E2) ====================
  -- Reset to a clean received condition + a fresh report carrying a multi-finding
  -- wrapper (one fatal fraud alert + one warning high-risk score).
  DELETE FROM checklist_items WHERE application_id=aid;
  DELETE FROM credit_reports WHERE application_id=aid;
  INSERT INTO credit_reports (application_id, provider_id, status, underwriting_finding, created_at)
    VALUES (aid, 1, 'imported',
      '{"severity":"fatal","types":["fraud_alert","high_risk_score"],"message":"fraud",
        "findings":[{"type":"fraud_alert","severity":"fatal","reconciled":false},
                    {"type":"high_risk_score","severity":"warning","reconciled":false}]}'::jsonb,
      timestamptz '2021-01-01 00:00:00+00')
    RETURNING id INTO crid;
  INSERT INTO checklist_items (scope,label,application_id,template_id,status)
    VALUES ('application','Credit report',aid,tmpl,'received');

  -- T8: a fatal element in findings[] blocks completion.
  blocked := false;
  BEGIN UPDATE checklist_items SET status='satisfied' WHERE application_id=aid AND template_id=tmpl;
  EXCEPTION WHEN check_violation THEN blocked := true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL T8: a fatal element in findings[] did NOT block'; END IF;
  RAISE NOTICE 'PASS T8: a fatal element in the findings[] wrapper blocks completion';

  -- T9: per-finding reconcile of the ONLY fatal element => completion SUCCEEDS
  -- (the warning element never blocks). Recompute the top-level severity too.
  UPDATE credit_reports SET underwriting_finding =
    '{"severity":"warning","types":["fraud_alert","high_risk_score"],"message":"",
      "findings":[{"type":"fraud_alert","severity":"fatal","reconciled":true},
                  {"type":"high_risk_score","severity":"warning","reconciled":false}]}'::jsonb
    WHERE id=crid;
  UPDATE checklist_items SET status='satisfied' WHERE application_id=aid AND template_id=tmpl;
  RAISE NOTICE 'PASS T9: per-finding reconcile of the only fatal element opens the gate';
  UPDATE checklist_items SET status='received' WHERE application_id=aid AND template_id=tmpl;

  -- T10: a wrapper of only WARNING findings never blocks.
  UPDATE credit_reports SET underwriting_finding =
    '{"severity":"warning","types":["high_risk_score"],"message":"",
      "findings":[{"type":"high_risk_score","severity":"warning","reconciled":false}]}'::jsonb
    WHERE id=crid;
  UPDATE checklist_items SET status='satisfied' WHERE application_id=aid AND template_id=tmpl;
  RAISE NOTICE 'PASS T10: a warning-only findings[] wrapper never blocks';

  DELETE FROM checklist_items WHERE application_id=aid;
  DELETE FROM credit_reports WHERE application_id=aid;
  DELETE FROM applications WHERE id=aid;
  DELETE FROM borrowers WHERE id=bid;
  RAISE NOTICE 'ALL FINDING-GATE TRIGGER TESTS PASSED';
END $$;
