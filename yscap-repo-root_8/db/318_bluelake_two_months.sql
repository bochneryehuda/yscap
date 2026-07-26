-- 318 — Blue Lake files ask for TWO months of bank statements, on EXISTING files too
-- (owner-directed 2026-07-26: "Blue Lake needs 2 months of bank statements, not 1. The rule text
-- says 1.").
--
-- The month count is written onto the assets condition when a product is registered
-- (src/lib/liquidity.js syncLiquidityCondition). That code now reads the file's note buyer and takes
-- whichever is stricter, program or note buyer — but a file registered BEFORE this change still
-- carries the old one-month wording and the old recorded requirement, and would only pick up the
-- correction on its next re-registration. The standing "previous AND future" rule says existing
-- files get it now.
--
-- SCOPE: open assets conditions on live Blue Lake files that currently say ONE month. Deliberately
-- narrow:
--   · note buyer normalises to 'bluelake' — the same normalisation the app uses (lowercase, drop
--     everything that is not a letter or digit), so "Blue Lake" / "BLUE LAKE" / "bluelake" all match
--     and nothing else does;
--   · the condition is still OPEN — a signed-off or waived condition is a decision already made by a
--     person, and this must not reach back and reopen it;
--   · the file is not closed, funded, declined, withdrawn or soft-deleted — asking for another
--     statement on a finished loan is noise;
--   · the recorded month count is exactly 1 — a file already asking for 2 (or a manual product
--     asking for 3) is left alone, so this can only ever RAISE the ask, never lower it.
-- Idempotent: after the update the rows no longer match (months = 2), so re-running changes nothing.

UPDATE checklist_items ci
   SET tool_payload = jsonb_set(
         COALESCE(ci.tool_payload, '{}'::jsonb),
         '{bankStatements,months}', '2'::jsonb, true),
       hint = regexp_replace(
         COALESCE(ci.hint, ''),
         '^Provide 1 month of a recent bank statement[^.]*\.',
         'Provide 2 months of recent bank statements — this loan requires 2 months of liquidity.'),
       borrower_hint = regexp_replace(
         COALESCE(ci.borrower_hint, ''),
         '^Provide 1 month of a recent bank statement[^.]*\.',
         'Provide 2 months of recent bank statements — this loan requires 2 months of liquidity.')
  FROM checklist_templates t, applications a
 WHERE t.id = ci.template_id
   AND t.code = 'rtl_p3_assets'
   AND a.id = ci.application_id
   AND lower(regexp_replace(COALESCE(a.lender, ''), '[^a-zA-Z0-9]', '', 'g')) = 'bluelake'
   AND COALESCE(a.status, '') NOT IN ('funded', 'closed', 'declined', 'withdrawn')
   AND a.deleted_at IS NULL
   AND ci.signed_off_at IS NULL
   AND COALESCE(ci.status, '') <> 'waived'
   AND (ci.tool_payload #>> '{bankStatements,months}') = '1';
