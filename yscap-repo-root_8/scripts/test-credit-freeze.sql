-- Freeze-trigger tests for db/126_credit_report_reissue.sql
-- Requires a Postgres with the migrations applied (NOT in `npm test`, which is
-- DB-free). Run against a throwaway DB:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test-credit-freeze.sql
-- Verifies: once fico_locked, the frozen score / lineage / lock cannot change
-- from any path except the sanctioned re-import (GUC app.credit_reverify='on');
-- non-FICO fields stay editable; the audit table captures every change.
DO $$
DECLARE bid uuid; blocked boolean;
BEGIN
  INSERT INTO borrowers (first_name,last_name,email) VALUES ('Test','Freeze','freeze-test@example.com') RETURNING id INTO bid;
  UPDATE borrowers SET fico=700 WHERE id=bid;                    -- estimate editable pre-lock
  UPDATE borrowers SET verified_fico=732, fico=732, verified_fico_source='experian_fairisaac',
         verified_report_id='1202696', verified_imported_at=now(), fico_locked=true WHERE id=bid;  -- import + lock

  blocked:=false; BEGIN UPDATE borrowers SET fico=800 WHERE id=bid; EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL: locked fico editable'; END IF;
  blocked:=false; BEGIN UPDATE borrowers SET verified_fico=800 WHERE id=bid; EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL: locked verified_fico editable'; END IF;
  blocked:=false; BEGIN UPDATE borrowers SET fico_locked=false WHERE id=bid; EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL: unlock allowed'; END IF;
  blocked:=false; BEGIN UPDATE borrowers SET verified_report_id='HACK' WHERE id=bid; EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'FAIL: lineage editable'; END IF;

  UPDATE borrowers SET cell_phone='+15551234567' WHERE id=bid;  -- non-FICO field allowed while locked
  IF (SELECT fico FROM borrowers WHERE id=bid) <> 732 THEN RAISE EXCEPTION 'FAIL: fico changed'; END IF;

  PERFORM set_config('app.credit_reverify','on', true);          -- sanctioned re-import
  UPDATE borrowers SET verified_fico=740, fico=740, verified_report_id='1300000' WHERE id=bid;
  PERFORM set_config('app.credit_reverify','', true);
  IF (SELECT fico FROM borrowers WHERE id=bid) <> 740 THEN RAISE EXCEPTION 'FAIL: reverify not applied'; END IF;

  IF (SELECT count(*) FROM credit_fico_audit WHERE borrower_id=bid) < 3 THEN RAISE EXCEPTION 'FAIL: audit rows missing'; END IF;

  RAISE NOTICE 'ALL FREEZE TRIGGER TESTS PASSED (audit rows: %)', (SELECT count(*) FROM credit_fico_audit WHERE borrower_id=bid);
  DELETE FROM credit_fico_audit WHERE borrower_id=bid;
  DELETE FROM borrowers WHERE id=bid;
END $$;
