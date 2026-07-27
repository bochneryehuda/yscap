-- USPS address verification (official USPS Addresses API v3 / Enhanced Addresses 3.3.1).
-- Idempotent + additive + NON-DESTRUCTIVE: nothing here overwrites a working address.
--
-- Two pieces:
--   1) usps_address_verifications — a reusable CACHE of every USPS lookup, keyed by
--      a hash of the normalized input. Because the free USPS tier is rate-limited
--      (60 lookups/hour), caching is what lets the live "verify as you type" path and
--      the previous-files backfill share results instead of each re-spending quota.
--   2) applications.usps_* stamp columns — so every file (previous AND future) can
--      carry its USPS-standardized subject address alongside the working one, without
--      the backfill ever silently rewriting property_address. A later, deliberate step
--      can adopt it; underwriting/pricing keep reading the existing field until then.

CREATE TABLE IF NOT EXISTS usps_address_verifications (
  address_hash  text PRIMARY KEY,          -- sha256 of the normalized input components
  input         jsonb NOT NULL,            -- { line1, unit, city, state, zip }
  standardized  jsonb,                     -- canonical address shape USPS returned
  dpv           jsonb,                     -- deliverability / additional USPS indicators
  status        text NOT NULL,             -- verified | corrected | unverified | error | not_configured
  verified_at   timestamptz NOT NULL DEFAULT now()
);

-- Let a stale cache row be re-checked later without a schema change.
CREATE INDEX IF NOT EXISTS usps_address_verifications_verified_at_idx
  ON usps_address_verifications (verified_at);

-- Per-file, non-destructive stamp of the USPS-correct subject address.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS usps_address     jsonb;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS usps_match       text;         -- verified | corrected | unverified
ALTER TABLE applications ADD COLUMN IF NOT EXISTS usps_verified_at timestamptz;

-- Backfill target discovery: find files not yet checked, cheaply.
CREATE INDEX IF NOT EXISTS applications_usps_verified_at_idx
  ON applications (usps_verified_at);
