-- ============================================================================
-- db/627 — drop the phantom TrustPoint "releases" db/302 invents from a projection
--
-- WHAT THIS CHANGES, AND WHY. Owner-reported 2026-08-24 on YSCAP258134629
-- (117 Brook St, Barnegat NJ, draw #1): a draw the borrower had just submitted
-- for review — nothing inspected, nothing approved, nothing entered in
-- TrustPoint — announced itself to the team as "Released to you $6,200 · no
-- draw fee on this release" against "$70,200 Approved", printed "Released" on
-- the draw desk, and drew a PDF saying the same. Reproduced end to end against
-- a real Postgres: every one of those figures, to the cent.
--
-- THE FIELD AT THE BOTTOM OF IT. `trustpoint_draws.disbursed_cents` is NOT a
-- record of money that moved. TrustPoint pre-populates it AT SUBMISSION with
-- the projected net — requested minus the per-draw fee. On this draw that is
-- $6,450 - $250 = $6,200, which is exactly the figure that went out. The live
-- money mirror learned this on 2026-07-27 (file YSCAP258134754, where the same
-- field told a borrower "$49,750.00 is on its way" on an un-inspected draw) and
-- `src/trustpoint/mirror.js mirrorDisbursement` was fixed then to require the
-- wire DATE (`disbursed_at`) and a decided draw. **This migration was not**, and
-- it still encodes the disproven rule:
--
--     WHERE (t.disbursed_at IS NOT NULL OR COALESCE(t.disbursed_cents,0) > 0)
--
-- — so it writes `funded_status='released'` off the projection alone, with
-- `net_release_cents = disbursed_cents` and a hard-coded `fee_cents = 0` (which
-- is why the email said "no draw fee on this release"). db/302 replays on EVERY
-- boot, so it re-creates the row on every deploy: this is why it kept coming
-- back. db/184 then does its job correctly on the next boot and binds the
-- untied release to the file's one free draw — the borrower's real $70,200 one.
--
-- WHY A NEW FILE RATHER THAN A FIX TO db/302. Migrations are never edited here,
-- and db/302 replays regardless. Numbering this LAST makes it the final word on
-- every boot (the db/374-over-db/177 mechanism): 184 binds, 302 re-inserts, 623
-- removes. The row never survives a boot, and a re-run removes nothing new.
--
-- THE TEST IS THE LIVE RULE, RESTATED IN SQL, AND DELIBERATELY NARROW. A row is
-- removed only when ALL of these hold, so it can only ever be db/302's own work:
--   * it is db/302's row      — `source='trustpoint'` AND its exact backfill note;
--   * nobody typed it         — `created_by IS NULL`;
--   * it names no wire day    — `release_date IS NULL`;
--   * and the administrator recorded NO WIRE — `trustpoint_draws.disbursed_at
--     IS NULL`, which is the same field `mirrorDisbursement` requires, so a row
--     the LIVE mirror wrote (which cannot exist without it) is never touched.
-- A release whose TrustPoint draw has since been deleted is NOT judged and NOT
-- removed: money we cannot prove is phantom stays on the ledger where a human
-- can see it. Fail closed.
--
-- AUDITED, because the row is gone afterwards and this is the only record it was
-- ever there. One `draw_phantom_release_removed` row per deletion, carrying the
-- amount and the TrustPoint draw it came from.
--
-- BACKFILL. This IS the backfill — it reaches every file already carrying one of
-- these rows, not only new ones, and it re-reaches them on every boot for as
-- long as db/302 keeps re-inserting.
--
-- PRODUCT SEPARATION. RTL only. `draw_disbursements` and `trustpoint_draws` are
-- RTL tables; nothing here names an `lt_*` object.
-- ============================================================================

WITH phantom AS (
  SELECT dd.id, dd.application_id, dd.sitewire_draw_id, dd.trustpoint_draw_id,
         dd.net_release_cents, t.requested_cents
    FROM draw_disbursements dd
    JOIN trustpoint_draws t ON t.tp_draw_id = dd.trustpoint_draw_id
   WHERE dd.kind          = 'draw'
     AND dd.source        = 'trustpoint'
     AND dd.funded_status = 'released'
     AND dd.created_by    IS NULL
     AND dd.release_date  IS NULL
     AND dd.note LIKE 'Backfilled at phase-5 rollout%'
     AND t.disbursed_at   IS NULL          -- the administrator never recorded a wire
),
logged AS (
  INSERT INTO audit_log (actor_kind, action, entity_type, entity_id, detail)
  SELECT 'system', 'draw_phantom_release_removed', 'application', p.application_id,
         jsonb_build_object(
           'sitewire_draw_id',   p.sitewire_draw_id,
           'trustpoint_draw_id', p.trustpoint_draw_id,
           'net_release_cents',  p.net_release_cents,
           'tp_requested_cents', p.requested_cents,
           'why', 'db/302 recorded a release from trustpoint_draws.disbursed_cents, which TrustPoint pre-populates at submission with the projected net. No wire date was ever recorded, so no money moved.')
    FROM phantom p
  RETURNING 1
)
DELETE FROM draw_disbursements dd
 USING phantom p
 WHERE dd.id = p.id
   AND (SELECT count(*) FROM logged) >= 0;   -- forces `logged` to run with the delete
