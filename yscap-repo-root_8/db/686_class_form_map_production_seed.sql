-- 686 — Class Valuation product (form) defaults for the PRODUCTION organisation.
--
-- The Class mirror of db/481's AMC form defaults. `class_form_map` shipped EMPTY in
-- db/537 because nobody had the production product catalog; the catalog was read off
-- the live production API on 2026-09-02 (49 products, every id below is one of them),
-- and these rows key on the SAME dimensions the owner chose for AppraisalScope on
-- 2026-08-07 — RTL loan type × canonical property key — so a deal that auto-picks a
-- form on one desk auto-picks the equivalent form on the other.
--
-- HOW EACH AMC FORM WAS TRANSLATED (Class has no product literally named
-- "Completed Subject to (w/As Is Value)"):
--   • fix & flip needs an AS-IS value AND an after-repair value. Class's products
--     that deliver both are the "Homestyle Renovation" reports (1004 / 1073 / 1025
--     "Reno"), so those are seeded. CONFIRM WITH CLASS before the first fix & flip
--     order: if their renovation product carries Fannie Mae HomeStyle programme
--     rules or pricing the owner does not want, switch these three rows to the plain
--     URAR / Condo / Multi-Family products and carry the scope of work in the
--     order's `instructions` instead. Changing a row here needs no deploy.
--   • bridge / DSCR = no scope of work, rental exit → the "w/ Comparable Rent Schedule"
--     (1004+1007 / 1073+1007) products, exactly the AMC "w/ 1007" forms; 2-4 units use
--     the plain 1025 (it already carries the rent data), as on the AMC side.
--   • ground-up is DELIBERATELY NOT SEEDED, for the same reason as db/481: nobody has
--     named the form. The desk shows the full catalog and asks a human.
--
-- Ids are environment-specific; these are PRODUCTION's. The resolver
-- (src/class/order-service.js productRules) reads only rows for the environment the
-- service points at. Priority 10 = the one default per (loan_type, property_key), the
-- slot uq_class_form_map_default protects.
INSERT INTO class_form_map (loan_type, property_key, product_id, product_name, priority, environment, note)
VALUES
  -- Needs As-Is + ARV (has a scope of work)
  ('fix_and_flip', 'sfr',       '6398a1f8037fb9bf6c166a1e', 'Homestyle Renovation URAR (FNMA 1004)', 10, 'production',
   'Mirror of the AMC "1004 Completed Subject to (w/As Is Value)" default: single-family fix & flip needs As-Is plus ARV. Confirm the product with Class before the first order.'),
  ('fix_and_flip', 'condo',     '6398a1d2037fb9bf6c166a1a', 'Homestyle Renovation Condo (FNMA 1073)', 10, 'production',
   'Mirror of the AMC "1073 Condo Interior Completed Subject to" default: condo fix & flip that needs As-Is plus ARV.'),
  ('fix_and_flip', 'multi_2_4', '6398a1e6037fb9bf6c166a1c', 'Homestyle Renovation Multi-Family (FNMA 1025)', 10, 'production',
   'Mirror of the AMC "1025 Multifamily Completed Subject to" default: 2-4 units that need As-Is plus ARV.'),
  -- No scope of work, no ARV
  ('bridge', 'sfr',       '6398a3736568147f6f85771b', 'Single Family Investment w/Comparable Rent Sch (1004 and 1007)', 10, 'production',
   'Mirror of the AMC "1004 w/ 1007" default: standard single-family bridge, rental exit, no ARV.'),
  ('bridge', 'condo',     '6398a048037fb9bf6c166a0e', 'Condo Investment w/Comparable Rent Sch (1073 and 1007)', 10, 'production',
   'Mirror of the AMC "1073 w/ 1007" default: standard condo bridge, no ARV.'),
  ('bridge', 'multi_2_4', '6398a2da7c57ba14160def7c', 'Multi-Family Appraisal (FNMA 1025)', 10, 'production',
   'Mirror of the AMC "1025 Multi-Family (2-4 unit)" default.'),
  ('dscr',   'sfr',       '6398a3736568147f6f85771b', 'Single Family Investment w/Comparable Rent Sch (1004 and 1007)', 10, 'production',
   'Mirror of the AMC default: single-family DSCR, same form as a standard bridge.'),
  ('dscr',   'condo',     '6398a048037fb9bf6c166a0e', 'Condo Investment w/Comparable Rent Sch (1073 and 1007)', 10, 'production',
   'Mirror of the AMC default: condo DSCR.'),
  ('dscr',   'multi_2_4', '6398a2da7c57ba14160def7c', 'Multi-Family Appraisal (FNMA 1025)', 10, 'production',
   'Mirror of the AMC default: 2-4 unit DSCR.')
ON CONFLICT DO NOTHING;
