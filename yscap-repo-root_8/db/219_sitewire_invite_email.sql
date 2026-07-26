-- Per-file Sitewire borrower-invite email override (owner-directed 2026-07-21): Sitewire allows only ONE
-- email per property. The coordinator prefills the borrower's email but may change it (to a GC/partner)
-- before the push, and revoke/resend/replace it after. This stores the chosen invite email for the file;
-- the push + resend assign THIS email (falling back to the borrower's own email when unset). Idempotent.
ALTER TABLE sitewire_property_links ADD COLUMN IF NOT EXISTS invite_email text;
