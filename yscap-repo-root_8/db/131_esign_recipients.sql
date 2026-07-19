-- ============================================================================
-- 131_esign_recipients.sql — per-recipient signing status (staff dashboard +
--                            admin counter-signature)
--
-- One row per recipient on an esign envelope, so the staff DocuSign section can
-- show each signer's live status + timestamps (sent / viewed / signed) and "who
-- are we waiting on," and so the admin counter-signer (routing order 2 on the
-- term-sheet package) is modeled explicitly. Rows are seeded at send time and
-- updated by the HMAC-verified Connect webhook + Envelopes:get re-fetch.
--
-- Per docs/DOCUSIGN-WORKFORCE-BUILD-SPEC.md §3, §9. Additive; idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS esign_recipients (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_row_id    uuid NOT NULL REFERENCES esign_envelopes(id) ON DELETE CASCADE,
  role               text NOT NULL,                 -- borrower | co_borrower | admin
  routing_order      integer NOT NULL DEFAULT 1,    -- 1 = borrower(s) sign first; 2 = admin counter-sign
  is_countersigner   boolean NOT NULL DEFAULT false,-- true for the admin counter-signer (term-sheet package)
  recipient_id_ds    text,                          -- DocuSign recipientId within the envelope ("1","2"…)
  borrower_id        uuid REFERENCES borrowers(id) ON DELETE SET NULL,  -- which borrower (null for admin)
  name               text NOT NULL,
  email              text NOT NULL,
  embedded           boolean NOT NULL DEFAULT false,-- in-portal (clientUserId) vs email-only
  client_user_id     text,                          -- the clientUserId used for embedded signing (never a secret)
  status             text NOT NULL DEFAULT 'created'
                     CHECK (status IN ('created','sent','delivered','signed','declined','completed','autoresponded')),
  sent_at            timestamptz,
  delivered_at       timestamptz,                   -- "viewed/opened"
  signed_at          timestamptz,
  declined_at        timestamptz,
  decline_reason     text,
  last_event_at      timestamptz,                   -- out-of-order guard for recipient events
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE esign_recipients
    ADD CONSTRAINT chk_esign_recipient_role CHECK (role IN ('borrower','co_borrower','admin'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_esign_recipients_env ON esign_recipients(envelope_row_id);
-- one row per (envelope, DocuSign recipientId) so webhook updates upsert cleanly
CREATE UNIQUE INDEX IF NOT EXISTS uq_esign_recipient_ds
  ON esign_recipients(envelope_row_id, recipient_id_ds) WHERE recipient_id_ds IS NOT NULL;

-- Term-sheet package requires the admin counter-signature; the Iska does not.
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS countersign_required boolean NOT NULL DEFAULT false;
