-- 224_vendor_merge.sql — vendor multi-email + manual merge (owner-directed
-- 2026-07-21). Idempotent.
--
-- Two people entering the SAME vendor used to create TWO service_contacts rows
-- with no linkage — the vendors page listed both, one with a slightly cleaner
-- name and the other with a phone number the first was missing, and neither
-- surfaced files linked to the other. Two additions here fix that structurally:
--
-- (1) `emails text[]` on service_contacts — a vendor can carry MULTIPLE email
--     addresses (a personal + a company inbox, a title company with a
--     rundown@ and a closing@ address, etc.). The legacy scalar `email` stays
--     as the PRIMARY / display email; the array holds the full set. Backfilled
--     from the existing scalar so no data is lost. The lightweight `phones
--     text[]` mirror is added for the same reason on the phone column.
--
-- (2) `merged_into_id` (self-FK, ON DELETE SET NULL) + `merged_at` — a merge
--     doesn't drop the loser vendor bytes: instead we RE-POINT every
--     application_service_contacts row to the survivor and stamp the merged
--     row so audits/links stay traceable. The survivor gets the loser's
--     emails/phones appended (dedup on lowercase / digit form). The listing
--     filters merged rows out by default.

ALTER TABLE service_contacts ADD COLUMN IF NOT EXISTS emails text[];
ALTER TABLE service_contacts ADD COLUMN IF NOT EXISTS phones text[];
ALTER TABLE service_contacts ADD COLUMN IF NOT EXISTS merged_into_id uuid;
ALTER TABLE service_contacts ADD COLUMN IF NOT EXISTS merged_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'service_contacts_merged_into_fkey'
  ) THEN
    ALTER TABLE service_contacts
      ADD CONSTRAINT service_contacts_merged_into_fkey
      FOREIGN KEY (merged_into_id) REFERENCES service_contacts(id) ON DELETE SET NULL;
  END IF;
END$$;

-- Backfill the primary email/phone into the array so existing vendors carry the
-- same value in both forms — new writes should keep them in sync (route helpers
-- do this; a stale row still displays correctly either way).
UPDATE service_contacts
   SET emails = ARRAY[email]
 WHERE emails IS NULL AND email IS NOT NULL AND email <> '';

UPDATE service_contacts
   SET phones = ARRAY[phone]
 WHERE phones IS NULL AND phone IS NOT NULL AND phone <> '';

CREATE INDEX IF NOT EXISTS idx_service_contacts_merged_into ON service_contacts(merged_into_id);
