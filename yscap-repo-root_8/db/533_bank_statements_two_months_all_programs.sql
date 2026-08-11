-- ============================================================================
-- 533 — TWO MONTHS OF BANK STATEMENTS ON EVERY FILE (owner-directed 2026-08-11)
--
-- SUPERSEDES the old per-program / note-buyer / manual-stated month table (Gold 2,
-- Silver 2, Standard 1, manual = stated, note buyer could raise). The owner: "None
-- of our programs require three months. All of our programs require only two months
-- of bank statements, and a printout after the two statements may be used if the
-- money is not shown yet in the ending balance of the most recent statement."
--
-- src/lib/liquidity.js `bankStatementMonths` now always returns 2, and every
-- assets-condition hint states two months + the printout allowance. Registered
-- files are refreshed on this same boot by the JS backfill
-- `liquidity.backfillLiquidityConditions()` (server.js), which REGENERATES the full
-- hint from each file's stored quote — so a Standard file that said "1 month" and a
-- manual file that said "3 months" both become "2 months" with the printout line.
--
-- This migration handles what that backfill does NOT touch, and re-asserts it AFTER
-- db/070 (which resets the same rows to the OLD generic on every boot) — ordering is
-- the mechanism (the db/374 pattern):
--   (A) the rtl_p3_assets TEMPLATE default hint → the new generic wording;
--   (B) items on files with NO current registration → the new generic wording;
--   (C) belt-and-suspenders: cap the recorded bankStatements.months at 2 on every
--       assets item, so even a registered file with no stored quote (which the JS
--       backfill skips) never carries a 3 (or a stale 1) as its recorded count.
-- Borrower-facing wording — never a capital-partner name. Idempotent.
-- ============================================================================

-- (A) Template default → generic, two months + the printout allowance.
UPDATE checklist_templates
   SET hint = 'Provide 2 months of recent bank statements showing your liquid assets. If the funds are not yet reflected in the ending balance of the most recent statement, you may also provide a recent transaction printout showing the deposit in addition to the two statements.',
       borrower_hint = 'Provide 2 months of recent bank statements showing your liquid assets. If the funds are not yet reflected in the ending balance of the most recent statement, you may also provide a recent transaction printout showing the deposit in addition to the two statements.'
 WHERE code = 'rtl_p3_assets'
   AND (hint IS DISTINCT FROM 'Provide 2 months of recent bank statements showing your liquid assets. If the funds are not yet reflected in the ending balance of the most recent statement, you may also provide a recent transaction printout showing the deposit in addition to the two statements.'
        OR borrower_hint IS DISTINCT FROM 'Provide 2 months of recent bank statements showing your liquid assets. If the funds are not yet reflected in the ending balance of the most recent statement, you may also provide a recent transaction printout showing the deposit in addition to the two statements.');

-- (B) Items on files WITHOUT a current registration → the new generic wording.
--     Registered files are refreshed by the boot liquidity backfill (full hint from
--     the stored quote), so they are deliberately left to it here.
UPDATE checklist_items ci
   SET hint = 'Provide 2 months of recent bank statements showing your liquid assets. If the funds are not yet reflected in the ending balance of the most recent statement, you may also provide a recent transaction printout showing the deposit in addition to the two statements.',
       borrower_hint = 'Provide 2 months of recent bank statements showing your liquid assets. If the funds are not yet reflected in the ending balance of the most recent statement, you may also provide a recent transaction printout showing the deposit in addition to the two statements.',
       updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id
   AND t.code = 'rtl_p3_assets'
   AND NOT EXISTS (
     SELECT 1 FROM product_registrations pr
      WHERE pr.application_id = ci.application_id AND pr.is_current)
   AND ci.hint IS DISTINCT FROM 'Provide 2 months of recent bank statements showing your liquid assets. If the funds are not yet reflected in the ending balance of the most recent statement, you may also provide a recent transaction printout showing the deposit in addition to the two statements.';

-- (C) Cap the recorded month count at 2 on every assets item that carries one — so
--     the stored requirement (read by the cure engine and the completeness label)
--     can never be 3 (manual) or a stale 1 (Standard), even for a registered file
--     the JS backfill skips because it has no stored quote. Only rows whose count is
--     not already 2 are touched. Idempotent.
UPDATE checklist_items ci
   SET tool_payload = jsonb_set(COALESCE(ci.tool_payload, '{}'::jsonb), '{bankStatements,months}', '2'::jsonb, true),
       updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id
   AND t.code = 'rtl_p3_assets'
   AND ci.tool_payload ? 'bankStatements'
   AND (ci.tool_payload #> '{bankStatements,months}') IS DISTINCT FROM '2'::jsonb;
