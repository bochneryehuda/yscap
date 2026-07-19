-- Integration test for db/146 bracket-aware FICO reopen.
-- Requires the migrations applied. NOT in `npm test` (DB-free). Run:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test-fico-bracket-reopen.sql
-- Proves: a same-bracket FICO drift (700->718) leaves a cleared+signed
-- registration alone; a cross-bracket move (718->699) reopens Products &
-- Pricing (satisfied->received) and the signed term sheet (->outstanding).
DO $$
DECLARE bid uuid; aid uuid; tmpl uuid; pp_status text; ts_status text; is_stale boolean;
BEGIN
  -- fixture ---------------------------------------------------------------
  DELETE FROM borrowers WHERE email='bracket-test@example.com';
  INSERT INTO borrowers (first_name,last_name,email,fico) VALUES ('Bracket','Test','bracket-test@example.com',700) RETURNING id INTO bid;
  INSERT INTO applications (borrower_id) VALUES (bid) RETURNING id INTO aid;
  INSERT INTO product_registrations (application_id, program, inputs, quote, is_current, stale)
    VALUES (aid, 'rtl', '{"fico":"700"}'::jsonb, '{}'::jsonb, true, false);
  -- product_pricing condition, signed off (satisfied)
  INSERT INTO checklist_items (scope,label,application_id,tool_key,status,signed_off_at)
    VALUES ('application','Products & Pricing',aid,'product_pricing','satisfied',now());
  -- signed term sheet template + a satisfied item linked to it
  INSERT INTO checklist_templates (code,label,scope) VALUES ('rtl_cond_signedts','Signed Term Sheet','application')
    ON CONFLICT (code) DO UPDATE SET label=EXCLUDED.label RETURNING id INTO tmpl;
  IF tmpl IS NULL THEN SELECT id INTO tmpl FROM checklist_templates WHERE code='rtl_cond_signedts' LIMIT 1; END IF;
  INSERT INTO checklist_items (scope,label,application_id,template_id,status,signed_off_at)
    VALUES ('application','Signed Term Sheet',aid,tmpl,'satisfied',now());

  -- TEST 1: same-bracket drift 700 -> 718 (both 700-719) => NO reopen --------
  UPDATE borrowers SET fico=718 WHERE id=bid;
  SELECT stale INTO is_stale FROM product_registrations WHERE application_id=aid AND is_current;
  IF is_stale THEN RAISE EXCEPTION 'FAIL: same-bracket drift 700->718 marked registration stale'; END IF;
  SELECT status INTO pp_status FROM checklist_items WHERE application_id=aid AND tool_key='product_pricing';
  IF pp_status <> 'satisfied' THEN RAISE EXCEPTION 'FAIL: same-bracket drift reopened product_pricing (now %)', pp_status; END IF;
  SELECT status INTO ts_status FROM checklist_items WHERE application_id=aid AND template_id=tmpl;
  IF ts_status <> 'satisfied' THEN RAISE EXCEPTION 'FAIL: same-bracket drift reopened signed term sheet (now %)', ts_status; END IF;

  -- TEST 2: cross-bracket move 718 -> 699 (700-719 -> 680-699) => reopen ------
  UPDATE borrowers SET fico=699 WHERE id=bid;
  SELECT stale INTO is_stale FROM product_registrations WHERE application_id=aid AND is_current;
  IF NOT is_stale THEN RAISE EXCEPTION 'FAIL: cross-bracket move 718->699 did NOT mark registration stale'; END IF;
  SELECT status INTO pp_status FROM checklist_items WHERE application_id=aid AND tool_key='product_pricing';
  IF pp_status <> 'received' THEN RAISE EXCEPTION 'FAIL: cross-bracket move did NOT reopen product_pricing (now %)', pp_status; END IF;
  SELECT status INTO ts_status FROM checklist_items WHERE application_id=aid AND template_id=tmpl;
  IF ts_status <> 'outstanding' THEN RAISE EXCEPTION 'FAIL: cross-bracket move did NOT reopen signed term sheet (now %)', ts_status; END IF;

  RAISE NOTICE 'BRACKET REOPEN TESTS PASSED (same-bracket no-op; cross-bracket reopens pricing + term sheet)';

  -- cleanup ---------------------------------------------------------------
  DELETE FROM checklist_items WHERE application_id=aid;
  DELETE FROM product_registrations WHERE application_id=aid;
  DELETE FROM applications WHERE id=aid;
  DELETE FROM credit_fico_audit WHERE borrower_id=bid;
  DELETE FROM borrowers WHERE id=bid;
END $$;

-- Representative-aware: a co-borrower dropping BELOW an unchanged, higher
-- representative must NOT reopen; the representative itself crossing a bracket
-- MUST. Proves the pricing rule GREATEST(primary,co) governs the reopen, not the
-- individual borrower whose row changed.
DO $$
DECLARE pbid uuid; cbid uuid; aid uuid; is_stale boolean;
BEGIN
  DELETE FROM borrowers WHERE email IN ('rep-primary@example.com','rep-co@example.com');
  INSERT INTO borrowers (first_name,last_name,email,fico) VALUES ('Rep','Primary','rep-primary@example.com',725) RETURNING id INTO pbid;
  INSERT INTO borrowers (first_name,last_name,email,fico) VALUES ('Rep','Co','rep-co@example.com',700) RETURNING id INTO cbid;
  INSERT INTO applications (borrower_id, co_borrower_id) VALUES (pbid, cbid) RETURNING id INTO aid;
  -- Priced on representative GREATEST(725,700)=725 (bracket 720-739).
  INSERT INTO product_registrations (application_id, program, inputs, quote, is_current, stale)
    VALUES (aid, 'rtl', '{"fico":"725"}'::jsonb, '{}'::jsonb, true, false);

  -- co drops 700 -> 690 (co bracket 700-719 -> 680-699), representative stays
  -- 725 (720-739) => NO reopen.
  UPDATE borrowers SET fico=690 WHERE id=cbid;
  SELECT stale INTO is_stale FROM product_registrations WHERE application_id=aid AND is_current;
  IF is_stale THEN RAISE EXCEPTION 'FAIL: co-borrower drop below representative wrongly reopened'; END IF;

  -- co rises 690 -> 745 => representative becomes GREATEST(725,745)=745
  -- (740-759, different from priced 720-739) => reopen.
  UPDATE borrowers SET fico=745 WHERE id=cbid;
  SELECT stale INTO is_stale FROM product_registrations WHERE application_id=aid AND is_current;
  IF NOT is_stale THEN RAISE EXCEPTION 'FAIL: representative crossing a bracket did NOT reopen'; END IF;

  RAISE NOTICE 'REPRESENTATIVE-AWARE REOPEN TESTS PASSED (co below rep = no-op; rep crosses bracket = reopen)';

  DELETE FROM product_registrations WHERE application_id=aid;
  DELETE FROM applications WHERE id=aid;
  DELETE FROM credit_fico_audit WHERE borrower_id IN (pbid,cbid);
  DELETE FROM borrowers WHERE id IN (pbid,cbid);
END $$;
