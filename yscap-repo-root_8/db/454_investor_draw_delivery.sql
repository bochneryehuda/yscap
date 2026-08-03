-- 454_investor_draw_delivery.sql
-- Idempotent. INVESTOR DELIVERY of a draw request (owner-directed 2026-08-03).
--
-- Once the borrower agrees with the inspector's findings — in the portal, or verbally / by email
-- with a coordinator recording it — the draw goes to the INVESTOR (note buyer), who either
-- reimburses us for a release we already made or releases the money themselves. This migration
-- adds the three things that requires:
--
--   1. WHO to email, per note buyer  (investor_delivery_contacts)
--   2. WHICH WAY this draw is funded (draw_findings.funding_mode + a per-file default)
--   3. A RECORD of every delivery     (draw_investor_deliveries)
--
-- plus the staff-recorded borrower agreement (accepted_via 'staff').

-- ---------------------------------------------------------------------------
-- 1. Per-note-buyer investor contacts.
-- Keyed on the SAME normalized note-buyer key form the rest of the stack uses
-- (field-registry.normNoteBuyer → lowercase, non-alphanumerics stripped; the key form
-- sitewire_partner_links.label_norm already stores). One row per person, so a buyer's
-- contact list is edited a person at a time and an inactive contact is kept for the record
-- rather than deleted.
CREATE TABLE IF NOT EXISTS investor_delivery_contacts (
  id            bigserial PRIMARY KEY,
  label_norm    text NOT NULL,                 -- normNoteBuyer(applications.lender)
  label         text NOT NULL,                 -- the human note-buyer name, e.g. 'Fidelis'
  email         text NOT NULL,
  name          text,                          -- optional person name
  role          text,                          -- optional free-text role, e.g. 'Draw requests'
  active        boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_contact_buyer_email
  ON investor_delivery_contacts (label_norm, lower(email));
CREATE INDEX IF NOT EXISTS idx_inv_contact_buyer
  ON investor_delivery_contacts (label_norm) WHERE active;

-- Owner-supplied seed (2026-08-03): the Fidelis draw-request team. ON CONFLICT DO NOTHING so a
-- later edit (a removed person, a corrected address) is never clobbered on the next boot — a
-- human decision always wins over the seed, exactly as db/151 does for the partner links.
INSERT INTO investor_delivery_contacts (label_norm, label, email, role) VALUES
  ('fidelis', 'Fidelis', 'jcarara@fidelis-investors.com',      'Draw delivery'),
  ('fidelis', 'Fidelis', 'cquintano@fidelis-investors.com',    'Draw delivery'),
  ('fidelis', 'Fidelis', 'drawrequest@fidelis-investors.com',  'Draw requests inbox')
ON CONFLICT (label_norm, lower(email)) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. HOW this draw is funded.
--
-- 'reimbursement'    — WE release the net to the borrower and the investor reimburses us the
--                      full approved amount; our draw fee simply stays with us, so the investor
--                      never sends it separately. This is the DEFAULT.
-- 'investor_direct'  — the INVESTOR releases the net to the borrower and sends our fee to us.
--
-- NULL on the finding = "use the file's default"; NULL on the file = the system default above.
-- Both live on OUR tables (never on the mirrored `sitewire_draws`), so a Sitewire reconcile can
-- never overwrite a coordinator's choice.
ALTER TABLE draw_findings           ADD COLUMN IF NOT EXISTS funding_mode text;
ALTER TABLE sitewire_property_links ADD COLUMN IF NOT EXISTS investor_funding_mode text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'draw_findings_funding_mode_chk') THEN
    ALTER TABLE draw_findings ADD CONSTRAINT draw_findings_funding_mode_chk
      CHECK (funding_mode IS NULL OR funding_mode IN ('reimbursement', 'investor_direct'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'swpl_investor_funding_mode_chk') THEN
    ALTER TABLE sitewire_property_links ADD CONSTRAINT swpl_investor_funding_mode_chk
      CHECK (investor_funding_mode IS NULL OR investor_funding_mode IN ('reimbursement', 'investor_direct'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. The borrower's agreement, recorded BY STAFF.
-- The borrower may authorize verbally or by email instead of clicking Accept in the portal
-- (owner-directed 2026-08-03). That is a real acceptance, so it flows through the SAME
-- draw_findings.status='accepted' transition — only `accepted_via` distinguishes it, and the
-- person who recorded it plus how the authorization arrived are stored so the file can answer
-- "who said the borrower agreed?" years later.
ALTER TABLE draw_findings ADD COLUMN IF NOT EXISTS accepted_by_staff_id uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE draw_findings ADD COLUMN IF NOT EXISTS accepted_note text;

DO $$ BEGIN
  -- widen accepted_via to allow 'staff'; the column is created by db/131 with a 2-value CHECK.
  ALTER TABLE draw_findings DROP CONSTRAINT IF EXISTS draw_findings_accepted_via_check;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'draw_findings_accepted_via_chk2') THEN
    ALTER TABLE draw_findings ADD CONSTRAINT draw_findings_accepted_via_chk2
      CHECK (accepted_via IS NULL OR accepted_via IN ('portal', 'email', 'staff'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. The delivery record. One row per SEND (a re-send is a new row — the investor genuinely
-- received two emails, and the history must show both). Money is integer cents, mirroring the
-- figures the report and the packet were built from, so the record can be reconciled against
-- what the investor actually received.
CREATE TABLE IF NOT EXISTS draw_investor_deliveries (
  id                     bigserial PRIMARY KEY,
  application_id         uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  sitewire_draw_id       bigint NOT NULL,
  funding_mode           text NOT NULL CHECK (funding_mode IN ('reimbursement', 'investor_direct')),
  note_buyer_label       text,
  note_buyer_key         text,
  requested_cents        bigint NOT NULL DEFAULT 0,
  approved_cents         bigint NOT NULL DEFAULT 0,
  fee_cents              bigint NOT NULL DEFAULT 0,
  retainage_held_cents   bigint NOT NULL DEFAULT 0,
  to_borrower_cents      bigint NOT NULL DEFAULT 0,   -- the net that reaches the borrower
  to_us_cents            bigint NOT NULL DEFAULT 0,   -- our fee (+ retainage we hold)
  investor_total_cents   bigint NOT NULL DEFAULT 0,   -- what we ask the investor to fund
  to_emails              jsonb NOT NULL DEFAULT '[]'::jsonb,
  cc_emails              jsonb NOT NULL DEFAULT '[]'::jsonb,
  attachments            jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{filename, what, bytes}]
  skipped                jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{what, reason}] — never silent
  status                 text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'error')),
  error                  text,
  sent_by                uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  sent_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inv_deliv_app  ON draw_investor_deliveries (application_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_inv_deliv_draw ON draw_investor_deliveries (sitewire_draw_id, sent_at DESC);
