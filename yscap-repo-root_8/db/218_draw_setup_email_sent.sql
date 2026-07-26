-- Draw-setup borrower welcome email (owner-directed 2026-07-21): a once-per-file stamp so the
-- "your construction draw is set up" email fires exactly once when the property first goes live in
-- Sitewire, never again on a re-push. Idempotent; additive.
ALTER TABLE sitewire_property_links ADD COLUMN IF NOT EXISTS setup_email_sent_at timestamptz;
