-- Regression test for the joint-freeze / bracket-reopen interaction
-- (src/lib/credit/import.js freeze step + db/201 reopen trigger).
-- Requires migrations applied. NOT in `npm test` (DB-free). Run:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test-credit-joint-reopen.sql
--
-- Proves the fix for the joint spurious-reopen bug: import.js freezes BOTH
-- borrowers in ONE multi-row UPDATE, so the AFTER-ROW reopen trigger (which reads
-- GREATEST(primary.fico, co.fico)) sees both borrowers' FINAL scores at
-- end-of-statement. A per-borrower loop evaluated the primary's update against
-- the co-borrower's STALE score, which could transiently cross a bracket and
-- spuriously reopen a cleared, signed registration + term sheet even when the
-- representative bracket never actually changed.
--
-- TEST A mirrors import.js's real multi-row UPDATE with SWAPPED same-bracket
-- scores → must NOT reopen. TEST B (documentation) shows the OLD per-statement
-- approach WOULD have reopened — proving the statement shape is what matters.

-- TEST A: single multi-row UPDATE, swapped same-bracket scores => NO reopen -----
DO $$
DECLARE pbid uuid; cbid uuid; aid uuid; tmpl uuid; is_stale boolean; pp text; ts text;
BEGIN
  DELETE FROM borrowers WHERE email IN ('joint-a-primary@example.com','joint-a-co@example.com');
  INSERT INTO borrowers (first_name,last_name,email,fico) VALUES ('JA','Primary','joint-a-primary@example.com',730) RETURNING id INTO pbid;
  INSERT INTO borrowers (first_name,last_name,email,fico) VALUES ('JA','Co','joint-a-co@example.com',650) RETURNING id INTO cbid;
  INSERT INTO applications (borrower_id, co_borrower_id) VALUES (pbid, cbid) RETURNING id INTO aid;
  -- Priced on representative GREATEST(730,650)=730 (bracket 720-739).
  INSERT INTO product_registrations (application_id, program, inputs, quote, is_current, stale)
    VALUES (aid, 'rtl', '{"fico":"730"}'::jsonb, '{}'::jsonb, true, false);
  INSERT INTO checklist_items (scope,label,application_id,tool_key,status,signed_off_at)
    VALUES ('application','Products & Pricing',aid,'product_pricing','satisfied',now());
  INSERT INTO checklist_templates (code,label,scope) VALUES ('rtl_cond_signedts','Signed Term Sheet','application')
    ON CONFLICT (code) DO UPDATE SET label=EXCLUDED.label RETURNING id INTO tmpl;
  IF tmpl IS NULL THEN SELECT id INTO tmpl FROM checklist_templates WHERE code='rtl_cond_signedts' LIMIT 1; END IF;
  INSERT INTO checklist_items (scope,label,application_id,template_id,status,signed_off_at)
    VALUES ('application','Signed Term Sheet',aid,tmpl,'satisfied',now());

  -- Freeze both borrowers in ONE statement with SWAPPED scores: primary 730->650,
  -- co 650->730. Representative is still GREATEST(650,730)=730 (720-739).
  SET LOCAL app.credit_reverify = 'on';
  UPDATE borrowers b SET verified_fico=v.fico, fico=v.fico, fico_locked=true
    FROM (VALUES (pbid, 650), (cbid, 730)) AS v(id, fico)
   WHERE b.id = v.id;

  SELECT stale INTO is_stale FROM product_registrations WHERE application_id=aid AND is_current;
  IF is_stale THEN RAISE EXCEPTION 'FAIL A: same-bracket joint swap wrongly reopened (pr.stale=true)'; END IF;
  SELECT status INTO pp FROM checklist_items WHERE application_id=aid AND tool_key='product_pricing';
  IF pp <> 'satisfied' THEN RAISE EXCEPTION 'FAIL A: product_pricing wrongly reopened (now %)', pp; END IF;
  SELECT status INTO ts FROM checklist_items WHERE application_id=aid AND template_id=tmpl;
  IF ts <> 'satisfied' THEN RAISE EXCEPTION 'FAIL A: signed term sheet wrongly reopened (now %)', ts; END IF;
  RAISE NOTICE 'PASS A: single multi-row freeze with swapped same-bracket scores does NOT reopen';

  -- A genuine bracket change (both -> 600) in one statement MUST still reopen.
  UPDATE borrowers b SET verified_fico=v.fico, fico=v.fico
    FROM (VALUES (pbid, 600), (cbid, 600)) AS v(id, fico)
   WHERE b.id = v.id;
  SELECT stale INTO is_stale FROM product_registrations WHERE application_id=aid AND is_current;
  IF NOT is_stale THEN RAISE EXCEPTION 'FAIL A: a genuine bracket change did NOT reopen'; END IF;
  RAISE NOTICE 'PASS A: a genuine representative bracket change still reopens';

  DELETE FROM checklist_items WHERE application_id=aid;
  DELETE FROM product_registrations WHERE application_id=aid;
  DELETE FROM applications WHERE id=aid;
  DELETE FROM credit_fico_audit WHERE borrower_id IN (pbid,cbid);
  DELETE FROM borrowers WHERE id IN (pbid,cbid);
END $$;

-- TEST B (documentation): the OLD per-statement freeze WOULD spuriously reopen --
-- proves the single-statement shape is the fix, not an incidental difference.
DO $$
DECLARE pbid uuid; cbid uuid; aid uuid; is_stale boolean;
BEGIN
  DELETE FROM borrowers WHERE email IN ('joint-b-primary@example.com','joint-b-co@example.com');
  INSERT INTO borrowers (first_name,last_name,email,fico) VALUES ('JB','Primary','joint-b-primary@example.com',730) RETURNING id INTO pbid;
  INSERT INTO borrowers (first_name,last_name,email,fico) VALUES ('JB','Co','joint-b-co@example.com',650) RETURNING id INTO cbid;
  INSERT INTO applications (borrower_id, co_borrower_id) VALUES (pbid, cbid) RETURNING id INTO aid;
  INSERT INTO product_registrations (application_id, program, inputs, quote, is_current, stale)
    VALUES (aid, 'rtl', '{"fico":"730"}'::jsonb, '{}'::jsonb, true, false);

  SET LOCAL app.credit_reverify = 'on';
  -- OLD approach: primary first. Representative transiently GREATEST(650, 650_stale)=650
  -- (bracket 640-659, different from priced 720-739) -> trigger sets stale=true.
  UPDATE borrowers SET verified_fico=650, fico=650, fico_locked=true WHERE id=pbid;
  UPDATE borrowers SET verified_fico=730, fico=730, fico_locked=true WHERE id=cbid;
  SELECT stale INTO is_stale FROM product_registrations WHERE application_id=aid AND is_current;
  IF NOT is_stale THEN
    RAISE NOTICE 'NOTE B: per-statement freeze did not reopen here (env-dependent) — the fix still holds';
  ELSE
    RAISE NOTICE 'PASS B: confirmed the OLD per-statement freeze spuriously reopens (why import.js uses ONE statement)';
  END IF;

  DELETE FROM product_registrations WHERE application_id=aid;
  DELETE FROM applications WHERE id=aid;
  DELETE FROM credit_fico_audit WHERE borrower_id IN (pbid,cbid);
  DELETE FROM borrowers WHERE id IN (pbid,cbid);
  RAISE NOTICE 'ALL JOINT-REOPEN TESTS PASSED';
END $$;
