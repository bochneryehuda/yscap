-- 474_investor_delivery_manual_mode.sql
-- Idempotent. A THIRD investor funding/delivery mode: 'manual' (#11, owner-directed).
--
-- db/454 gave the investor-delivery step two modes — 'reimbursement' (WE release, the investor
-- reimburses us) and 'investor_direct' (the investor releases). Both send an email to the note
-- buyer. The MANUAL mode is the escape hatch for a delivery handled entirely OUTSIDE PILOT (a
-- phone call, the investor's own portal, an off-platform wire arrangement): PILOT composes and
-- sends NO email, it only RECORDS that the coordinator delivered the draw, so the "deliver to the
-- investor" reminders stop and the history shows it happened.
--
-- This widens the three funding_mode CHECK constraints db/454 created and adds a `note` column to
-- the delivery record so the coordinator can say how a manual delivery was handled.

-- 1. The per-draw and per-file funding-mode choices.
DO $$ BEGIN
  ALTER TABLE draw_findings DROP CONSTRAINT IF EXISTS draw_findings_funding_mode_chk;
  ALTER TABLE draw_findings ADD CONSTRAINT draw_findings_funding_mode_chk
    CHECK (funding_mode IS NULL OR funding_mode IN ('reimbursement', 'investor_direct', 'manual'));

  ALTER TABLE sitewire_property_links DROP CONSTRAINT IF EXISTS swpl_investor_funding_mode_chk;
  ALTER TABLE sitewire_property_links ADD CONSTRAINT swpl_investor_funding_mode_chk
    CHECK (investor_funding_mode IS NULL OR investor_funding_mode IN ('reimbursement', 'investor_direct', 'manual'));
END $$;

-- 2. The delivery record's mode. db/454 created this as an INLINE column CHECK, which Postgres
-- auto-names `<table>_<column>_check`; drop that (and any prior named form) and re-add a named,
-- widened constraint.
DO $$ BEGIN
  ALTER TABLE draw_investor_deliveries DROP CONSTRAINT IF EXISTS draw_investor_deliveries_funding_mode_check;
  ALTER TABLE draw_investor_deliveries DROP CONSTRAINT IF EXISTS draw_investor_deliveries_funding_mode_chk;
  ALTER TABLE draw_investor_deliveries ADD CONSTRAINT draw_investor_deliveries_funding_mode_chk
    CHECK (funding_mode IN ('reimbursement', 'investor_direct', 'manual'));
END $$;

-- 3. A free-text note on the delivery record — how a MANUAL delivery was handled (optional). NULL
-- on an emailed delivery. The `error` column stays reserved for a failed emailed send (status='error').
ALTER TABLE draw_investor_deliveries ADD COLUMN IF NOT EXISTS note text;
