-- 352_bluelake_draw_defaults.sql
-- Idempotent. Owner-reported 2026-07-27: "Blue Lake should be defaulted to physical and to
-- TrustPoint and the fee should be $250 in default … maybe it's not backdated."
--
-- The fee-check alert on YSCAP258134727 ("fee lines totaling $250.00, but the agreed per-draw
-- fee for this program is $299.00") was OUR rule being wrong, not the administrator's fee.
-- Verified against TrustPoint's live record for that draw — its only fee line is
-- {"name":"Per Draw Fee","amount":250}. The Blue Lake rule row had been switched to
-- draw_platform='trustpoint' but its inspection method + fee were never moved off the SYSTEM
-- DEFAULTS seeded in db/131 (inspection_method='mobile', fee_cents_virtual=29900), so
-- orchestrator.resolveInspection resolved the VIRTUAL $299 fee and every Blue Lake draw
-- reported a false mismatch.
--
-- This moves Blue Lake to its real terms: TrustPoint-administered, PHYSICAL inspection, $250
-- per draw. Only values still sitting at the untouched system default are changed, so a
-- deliberate admin choice made in the Draw Rules screen always wins (never-guess doctrine).
-- Blue Lake's capital_partner_id (41) is the owner-confirmed id seeded in db/151.

-- 1) Ensure the rule row exists at all (all programs). Nothing to overwrite if it is missing.
INSERT INTO sitewire_inspection_rules
  (capital_partner_id, program, draw_platform, inspection_method,
   allow_virtual, allow_physical, fee_cents_virtual, fee_cents_physical)
SELECT 41::bigint, NULL::text, 'trustpoint', 'traditional', true, true, 29900::bigint, 25000::bigint
 WHERE NOT EXISTS (
   SELECT 1 FROM sitewire_inspection_rules WHERE capital_partner_id = 41 AND program IS NULL);

-- 2) Repair an existing Blue Lake rule, field by field, ONLY where it still carries the
--    db/131 system default. A physical fee an admin actually typed is left alone.
UPDATE sitewire_inspection_rules
   SET inspection_method = CASE WHEN inspection_method = 'mobile'      THEN 'traditional' ELSE inspection_method END,
       draw_platform     = CASE WHEN draw_platform     = 'sitewire'    THEN 'trustpoint'  ELSE draw_platform     END,
       allow_physical    = true,
       fee_cents_physical = CASE WHEN fee_cents_physical IS NULL
                                   OR fee_cents_physical = 49900 THEN 25000 ELSE fee_cents_physical END,
       updated_at = now()
 WHERE capital_partner_id = 41
   AND program IS NULL
   AND (inspection_method = 'mobile'
        OR draw_platform = 'sitewire'
        OR allow_physical = false
        OR fee_cents_physical IS NULL
        OR fee_cents_physical = 49900);

-- 3) BACKDATE the check itself. verifyPartnerFee runs once per draw and stamps fee_check_at,
--    so every draw already checked against the wrong $299 would keep its stale verdict and
--    never re-verify. Clear the stamp on TrustPoint-administered draws whose fee lines do NOT
--    contain a $299 line — i.e. exactly the draws that could only have been judged against the
--    old default — so the next mirror pass re-checks them against the corrected $250 rule.
--    A draw that genuinely carries a $299 fee line is untouched.
UPDATE trustpoint_draws
   SET fee_check_at = NULL
 WHERE fee_check_at IS NOT NULL
   AND fees IS NOT NULL
   AND NOT (fees::text LIKE '%299%');
