-- 298_trustpoint_money_baseline.sql
-- Idempotent. Phase-5 audit hardening (previous AND future):
--
-- (1) GO-FORWARD BASELINE for the money mirror: any administered draw that was already
-- disbursed BEFORE the mirror went live gets a silent ledger row now, so a later
-- TrustPoint touch (an admin edit re-surfacing it in the poll window) can never
-- announce a weeks-old wire to the borrower as fresh news. Insert-only, conflict-safe,
-- re-runnable; the note marks it as history.
INSERT INTO draw_disbursements (application_id, sitewire_draw_id, trustpoint_draw_id, approved_cents, fee_cents,
    retainage_held_cents, net_release_cents, release_date, funded_status, kind, source, note)
SELECT t.application_id, t.sitewire_draw_id, t.tp_draw_id, COALESCE(t.approved_cents, 0), 0, 0,
       COALESCE(t.to_disburse_cents, NULLIF(t.disbursed_cents, 0), t.approved_cents, 0),
       CASE WHEN t.disbursed_at IS NOT NULL THEN (t.disbursed_at AT TIME ZONE 'America/New_York')::date ELSE NULL END,
       'released', 'draw', 'trustpoint',
       'Backfilled at phase-5 rollout — this draw was released before the money mirror went live.'
  FROM trustpoint_draws t
 WHERE (t.disbursed_at IS NOT NULL OR COALESCE(t.disbursed_cents, 0) > 0)
   AND NOT EXISTS (SELECT 1 FROM draw_disbursements dd WHERE dd.trustpoint_draw_id = t.tp_draw_id)
   AND NOT EXISTS (SELECT 1 FROM draw_disbursements dd2
                    WHERE t.sitewire_draw_id IS NOT NULL
                      AND dd2.sitewire_draw_id = t.sitewire_draw_id AND dd2.kind = 'draw')
ON CONFLICT DO NOTHING;

-- (2) One Sitewire draw belongs to at most ONE administered draw (audit-5 #3): the tie
-- candidate query now excludes already-claimed draws, and this index is the backstop
-- (a raced second tie fails 23505 inside the best-effort tie, harmlessly).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tpd_sw_draw ON trustpoint_draws (sitewire_draw_id)
  WHERE sitewire_draw_id IS NOT NULL;
