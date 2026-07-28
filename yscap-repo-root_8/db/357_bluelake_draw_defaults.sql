-- 357_bluelake_draw_defaults.sql
-- Idempotent. Owner-reported 2026-07-27: "Blue Lake should be defaulted to physical and to
-- TrustPoint and the fee should be $250 in default … maybe it's not backdated."
--
-- The fee-check alert on YSCAP258134727 ("fee lines totaling $250.00, but the agreed per-draw
-- fee for this program is $299.00") was OUR rule being wrong, not the administrator's fee.
-- Verified against TrustPoint's live record for that draw — its only fee line is
-- {"name":"Per Draw Fee","amount":250}. The Blue Lake rule had been switched to
-- draw_platform='trustpoint' but its inspection method + fee were never moved off the SYSTEM
-- DEFAULTS seeded in db/131 (inspection_method='mobile', fee_cents_virtual=29900), so
-- orchestrator.resolveInspection resolved the VIRTUAL $299 fee and every Blue Lake draw
-- reported a false mismatch.
--
-- Keying: rules are matched by NOTE-BUYER LABEL first (orchestrator.resolveRule tries
-- byLabel → byCp → global), and db/147 redefined uq_swrule as
-- (regexp_replace(lower(COALESCE(partner_label,'')),'[^a-z0-9]+','','g'), COALESCE(program,'')).
-- So the row must carry partner_label — an id-only row would collide with the global default
-- on the empty-label key. capital_partner_id 41 is the owner-confirmed Blue Lake id (db/151).
--
-- Only values still sitting at the untouched db/131 default are changed, so a deliberate
-- choice made in the Draw Rules screen always wins (never-guess doctrine).

-- 1) Ensure a Blue Lake rule exists at all (all programs).
INSERT INTO sitewire_inspection_rules
  (partner_label, capital_partner_id, program, draw_platform, inspection_method,
   allow_virtual, allow_physical, fee_cents_virtual, fee_cents_physical)
SELECT 'Blue Lake', 41::bigint, NULL::text, 'trustpoint', 'traditional',
       true, true, 29900::bigint, 25000::bigint
 WHERE NOT EXISTS (
   SELECT 1 FROM sitewire_inspection_rules
    WHERE regexp_replace(lower(COALESCE(partner_label, '')), '[^a-z0-9]+', '', 'g') = 'bluelake'
      AND program IS NULL);

-- 2) + 3) are a ONE-SHOT REPAIR, gated on a durable marker.
--
-- Every db/*.sql re-applies on EVERY boot, and a repair phrased as "put the value back where
-- it should be" is indistinguishable from "revert whatever the admin just chose". Statement 2
-- keys on the db/131 defaults (`mobile` / `sitewire` / 49900) — but those are also perfectly
-- legitimate values an admin may deliberately pick in the Draw Rules screen, and the next
-- deploy would silently undo them, forever. Statement 3 is worse: it clears fee_check_at on
-- every Blue Lake draw with no $299 line on EVERY boot, so the fee check re-ran on the whole
-- book at each deploy instead of once.
--
-- So both run exactly once per database. Statement 1 stays UNGATED on purpose: it is a plain
-- seed that only ever acts when no Blue Lake rule exists at all, so it can never overwrite a
-- choice, and it must still protect a freshly provisioned or restored database.
DO $$
DECLARE
  done      boolean;
  n_rule    int := 0;
  n_recheck int := 0;
BEGIN
  SELECT COALESCE((value->>'done')::boolean, false) INTO done
    FROM sync_runtime_state WHERE key = 'bluelake_draw_defaults';
  IF COALESCE(done, false) THEN
    RETURN;
  END IF;

  -- 2) Repair an existing Blue Lake rule, field by field, ONLY where it still carries the
  --    db/131 system default. A physical fee an admin actually typed is left alone.
  UPDATE sitewire_inspection_rules
     SET inspection_method = CASE WHEN inspection_method = 'mobile'   THEN 'traditional' ELSE inspection_method END,
         draw_platform     = CASE WHEN draw_platform     = 'sitewire' THEN 'trustpoint'  ELSE draw_platform     END,
         -- physical must be ALLOWED for the traditional method this sets; only forced on a row
         -- still at the untouched default, never re-enabled against a deliberate admin choice
         -- (that would contradict this file's own "a deliberate choice always wins" rule).
         allow_physical    = CASE WHEN inspection_method = 'mobile' THEN true ELSE allow_physical END,
         fee_cents_physical = CASE WHEN fee_cents_physical IS NULL
                                     OR fee_cents_physical = 49900 THEN 25000 ELSE fee_cents_physical END,
         updated_at = now()
   WHERE program IS NULL
     AND (regexp_replace(lower(COALESCE(partner_label, '')), '[^a-z0-9]+', '', 'g') = 'bluelake'
          OR capital_partner_id = 41)
     AND (inspection_method = 'mobile'
          OR draw_platform = 'sitewire'
          OR fee_cents_physical IS NULL
          OR fee_cents_physical = 49900);
  GET DIAGNOSTICS n_rule = ROW_COUNT;

  -- 3) BACKDATE the check itself. verifyPartnerFee runs once per draw and stamps fee_check_at,
  --    so every draw already checked against the wrong $299 would keep its stale verdict and
  --    never re-verify. Clear the stamp on administered draws whose fee lines do NOT contain a
  --    $299 line — i.e. exactly the draws that could only have been judged against the old
  --    default — so the next mirror pass re-checks them against the corrected $250 rule.
  --    A draw that genuinely carries a $299 fee line is untouched.
  UPDATE trustpoint_draws
     SET fee_check_at = NULL
   WHERE fee_check_at IS NOT NULL
     AND fees IS NOT NULL
     AND NOT (fees::text LIKE '%299%');
  GET DIAGNOSTICS n_recheck = ROW_COUNT;

  INSERT INTO sync_runtime_state (key, value, updated_at)
  VALUES ('bluelake_draw_defaults',
          jsonb_build_object('done', true, 'rules', n_rule, 'draws_rechecked', n_recheck, 'at', now()),
          now())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = now();

  RAISE NOTICE '357: Blue Lake draw defaults — repaired % rule(s), re-queued % draw(s) for a fee re-check', n_rule, n_recheck;
END $$;
