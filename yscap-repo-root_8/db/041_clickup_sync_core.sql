-- ============================================================================
-- 041_clickup_sync_core.sql — columns for the ClickUp bidirectional sync
--
-- Additive, per the CLICKUP-BIDIRECTIONAL-SYNC-BLUEPRINT. Adds:
--   * applications: internal (ClickUp-mirror) status, sync bookkeeping, echo
--     shadow copy, underwriter link, appraised-value pulls, and the parsed
--     (encrypted) appraisal card fields.
--   * a new borrower-facing 'on_hold' status.
--   * borrowers: primary-housing status/payment.
--   * sync_queue: a 'dead' (dead-letter) state.
-- No behavior changes until the sync worker is wired; every column is nullable
-- or defaulted. Idempotent: safe to re-run on every boot.
-- ============================================================================

-- ---- applications: sync bookkeeping ---------------------------------------
ALTER TABLE applications ADD COLUMN IF NOT EXISTS internal_status         text;      -- exact ClickUp task status (mirror)
ALTER TABLE applications ADD COLUMN IF NOT EXISTS clickup_status_updated_at timestamptz;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS underwriter_id          uuid REFERENCES staff_users(id);
ALTER TABLE applications ADD COLUMN IF NOT EXISTS clickup_shadow          jsonb;     -- last synced value per field (echo suppression)
ALTER TABLE applications ADD COLUMN IF NOT EXISTS clickup_shadow_hash     text;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS clickup_last_synced_at  timestamptz;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS hot_poll_until          timestamptz;  -- fresh-duplicate high-frequency polling window
ALTER TABLE applications ADD COLUMN IF NOT EXISTS actual_appraised_value  numeric(14,2);
ALTER TABLE applications ADD COLUMN IF NOT EXISTS approx_appraised_value  numeric(14,2);

-- Per-file sync lifecycle state (Manual Review queue lives on 'manual_review').
ALTER TABLE applications ADD COLUMN IF NOT EXISTS sync_state              text NOT NULL DEFAULT 'unlinked';
ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_sync_state_check;
ALTER TABLE applications ADD  CONSTRAINT applications_sync_state_check
  CHECK (sync_state IN ('unlinked','pending','awaiting_address_change','linked','manual_review','descoped','dead'));

-- Appraisal credit-card fields, parsed from ClickUp's single-line field.
-- Number + CVV are encrypted at rest (same envelope as SSN); exp is low-risk text.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS card_number_encrypted   bytea;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS card_last4              char(4);
ALTER TABLE applications ADD COLUMN IF NOT EXISTS card_exp                text;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS card_cvv_encrypted      bytea;

CREATE INDEX IF NOT EXISTS idx_applications_sync_state ON applications(sync_state);
CREATE INDEX IF NOT EXISTS idx_applications_internal_status ON applications(internal_status);
CREATE INDEX IF NOT EXISTS idx_applications_hot_poll ON applications(hot_poll_until) WHERE hot_poll_until IS NOT NULL;

-- ---- new borrower-facing 'on_hold' status ---------------------------------
-- RE-RUN-SAFETY AMENDMENT (2026-07-17, #151): 'file_intake' added to THIS list
-- too. Migrations re-run on every boot; once db/123's backfill created
-- file_intake rows, re-adding the original (narrower) constraint here failed
-- validation on every boot ("violated by some row") and rolled this whole file
-- back each time. The list below must always equal db/123's — widen both
-- together. (Historical effect is unchanged: db/123 supersedes this constraint
-- on the same boot for any database that predates file_intake.)
ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_status_check;
ALTER TABLE applications ADD  CONSTRAINT applications_status_check
  CHECK (status IN ('file_intake','new','in_review','processing','underwriting','approved',
                    'clear_to_close','funded','on_hold','declined','withdrawn'));

-- ---- borrowers: primary housing -------------------------------------------
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS housing_status  text;             -- Rent / Own w/ mortgage / Own free & clear / ...
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS housing_payment numeric(14,2);

-- ---- sync_queue: dead-letter state ----------------------------------------
ALTER TABLE sync_queue DROP CONSTRAINT IF EXISTS sync_queue_status_check;
ALTER TABLE sync_queue ADD  CONSTRAINT sync_queue_status_check
  CHECK (status IN ('queued','processing','done','error','dead'));
