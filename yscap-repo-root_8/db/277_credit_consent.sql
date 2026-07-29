-- 277 — Credit-report consent / FCRA permissible-purpose attestation.
--
-- Owner-directed 2026-07-22 (end-to-end audit): a LIVE credit pull obtains a
-- consumer report from the bureaus, so it must carry (and record) an explicit
-- permissible-purpose / borrower-consent attestation. Previously the "the
-- borrower authorized this credit pull" checkbox was enforced ONLY in the
-- browser and was never recorded — a direct API call could pull without it, and
-- the pull was not defensible on audit.
--
-- These columns capture who attested and when, so every live pull is traceable.
-- Go-forward by nature (an on-demand pull): existing rows correctly read
-- consent_attested=false (they predate the control); no backfill.

ALTER TABLE credit_reports ADD COLUMN IF NOT EXISTS consent_attested boolean NOT NULL DEFAULT false;
ALTER TABLE credit_reports ADD COLUMN IF NOT EXISTS consent_by       uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE credit_reports ADD COLUMN IF NOT EXISTS consent_at       timestamptz;
