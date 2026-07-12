-- ============================================================================
-- 070 - Program-aware bank statements + Gold 5% SOW contingency (owner-directed 2026-07-12)
--
-- (A) Bank-statement / assets condition (rtl_p3_assets):
--     · UNREGISTERED files show a GENERIC "assets & bank statements" ask — no
--       month count, and never a capital-partner name.
--     · Once a product is registered, src/lib/liquidity.js rewrites the hint with
--       the month count (Gold Standard = 2 months, Standard = 1 month). The boot
--       liquidity backfill refreshes already-registered files automatically.
--     This migration resets the TEMPLATE default and the hint on files that have
--     no current registration (removing any stale "TWO months" / note-buyer text).
--
-- (B) Gold Standard Program requires a >= 5% construction contingency on the
--     Scope of Work. For previous files already registered Gold whose SOW does
--     NOT carry it, REOPEN the rehab-budget condition (clear any sign-off) and
--     stamp a FATAL note — scoped to files still in underwriting so completed
--     (funded/cancelled) loans are left undisturbed. The runtime gate + trigger
--     enforce it for every file, previous and future, going forward.
-- ============================================================================

-- (A) Template default → generic, program-neutral, no capital-partner name.
UPDATE checklist_templates
   SET hint = 'Provide recent bank statements showing your liquid assets. The exact number of months required is set once your product is registered in Products & Pricing.',
       borrower_hint = 'Provide recent bank statements showing your liquid assets. The exact number of months required is set once your product is registered in Products & Pricing.'
 WHERE code = 'rtl_p3_assets';

-- (A) Items on files WITHOUT a current registration → generic hint (strip any
--     stale "two months" / note-buyer wording). Registered files are refreshed
--     by the boot liquidity backfill with the correct program month count.
UPDATE checklist_items ci
   SET hint = 'Provide recent bank statements showing your liquid assets. The exact number of months required is set once your product is registered in Products & Pricing.',
       borrower_hint = 'Provide recent bank statements showing your liquid assets. The exact number of months required is set once your product is registered in Products & Pricing.',
       updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id
   AND t.code = 'rtl_p3_assets'
   AND NOT EXISTS (
     SELECT 1 FROM product_registrations pr
      WHERE pr.application_id = ci.application_id AND pr.is_current);

-- (B) Reopen the rehab-budget condition on ACTIVE Gold files whose SOW lacks the
--     5% contingency. Idempotent: only touches currently-cleared conditions
--     (satisfied/received) that are Gold + short; a second run finds them 'issue'
--     and skips. "Short" = neither a pct-mode contingency >= 5 NOR a contingency
--     amount >= 5% of the construction subtotal.
UPDATE checklist_items ci
   SET status = 'issue', signed_off_at = NULL, signed_off_by = NULL,
       reviewed_at = NULL, reviewed_by = NULL,
       notes = CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%'
                    THEN '[auto] The Gold Standard Program requires at least a 5% contingency on the construction Scope of Work budget. Add a contingency of 5% or more (the builder auto-fills 5% for Gold files) before this condition can be signed off. Your work is saved — reopen the Scope of Work any time to add it.'
                    ELSE ci.notes END,
       updated_at = now()
  FROM applications a
 WHERE ci.application_id = a.id
   AND a.deleted_at IS NULL
   AND a.status NOT IN ('funded', 'cancelled', 'closed', 'declined', 'withdrawn')
   AND ci.tool_key = 'rehab_budget'
   AND ci.status IN ('satisfied', 'received')
   AND EXISTS (
     SELECT 1 FROM product_registrations pr
      WHERE pr.application_id = a.id AND pr.is_current AND pr.program ~* 'gold')
   AND NOT (
     -- pct-mode contingency of >= 5 satisfies by definition …
     ( (ci.tool_payload#>>'{state,cont,mode}') = 'pct'
       AND NULLIF(regexp_replace(COALESCE(ci.tool_payload#>>'{state,cont,value}',''), '[^0-9.]', '', 'g'), '')::numeric >= 5 )
     -- … or the contingency amount is >= 5% of the construction subtotal.
     OR ( NULLIF(regexp_replace(COALESCE(ci.tool_payload->>'subtotal',''), '[^0-9.]', '', 'g'), '') IS NOT NULL
          AND NULLIF(regexp_replace(ci.tool_payload->>'subtotal', '[^0-9.]', '', 'g'), '')::numeric > 0
          AND NULLIF(regexp_replace(COALESCE(ci.tool_payload->>'contingency',''), '[^0-9.]', '', 'g'), '') IS NOT NULL
          AND NULLIF(regexp_replace(ci.tool_payload->>'contingency', '[^0-9.]', '', 'g'), '')::numeric + 0.5
              >= 0.05 * NULLIF(regexp_replace(ci.tool_payload->>'subtotal', '[^0-9.]', '', 'g'), '')::numeric ) );
